// 반응 클립 추종 (2026-10-27, SPEC 17 '레퍼런스 모션 매칭'을 범위로 당김, README 결정 159~). 정의: docs/ALGORITHMS.md '반응 클립 추종'.
// 밀림·피격을 감지하면(감지 지연 뒤) Kimodo 반응 클립 라이브러리에서 지금 몸 상태(발 기준 COM 위치·속도, 두 발 배치, 발 접촉, 다리 관절)와
// 가장 비슷한 클립·시각을 고르고(상태 매칭 = 시간 맞춤), 그 클립을 v0.6 애니 추종 QP(walk.ts)로 따라간다 — 걸음·몸통·팔 모양이 사람 클립에서 나온다.
// 힘은 근육·전신 QP뿐(핀 보조 0, CLAUDE.md). 몸이 클립에서 크게 벗어나면 walk.ts 넘김 규칙대로 v0.4 균형·스텝 계층으로 넘기고,
// 클립이 끝나 가면 서기 균형으로 돌아온다(관절 목표는 관성화).
import type { CharacterDef } from './characterDef';
import type { AnimDriver, AnimClip, MassModel, Xform } from './animDriver';
import type { FootName } from './perception';
import type { JointName, JointTargets } from './pose';
import type { WalkConfig } from './walk';
import { type Vec3, add, scale, sub } from '../math/vec3';
import { type Quat, conjugate, multiplyQ, rotate, toRotationVector, fromAxisAngle } from '../math/quat';

export interface ReactionConfig {
  enabled: boolean;
  /** 감지 지연 (초): 충격 뒤 이만큼 지나서 클립을 고른다 (사람의 반응 시작, 균형 감지 지연과 같은 값) */
  delay: number;
  /** 반응 클립을 쓰는 충격 종류와 COM Δv 범위 (m/s). 범위 밖은 v0.4 균형·스텝 계층 그대로 */
  hitTypes: string[];
  minDv: number;
  /** 맞은 바디가 이 중 하나일 때만 (몸통 밀림·타격 반응 클립이라 다리·팔 총탄에는 쓰지 않는다) */
  hitBodies?: string[];
  /** 이 행동이 켜져 있으면 반응 클립을 쓰지 않는다 (넘어짐 대비·무릎 꿇기 등은 그 행동이, 다친 다리는 v0.5a 절뚝임이 맡는다 — 클립은 성한 사람의 반응) */
  blockBehaviors: string[];
  /** 반응 중 다시 맞으면: switch = 새 클립으로 이어 붙임, release = 스타일을 풀고 스텝 계층·팔 균형에 맡김 */
  rehit?: 'switch' | 'release';
  /** (병합, README 결정 168) 다른 캐릭터·프롭과 접촉 피격이 오면 상체 스타일을 놓는다 (나오기 시간 style.releaseTime ?? blendOut). 클립은 빈 공간에서 밀린 사람이다 */
  releaseOnContact?: boolean;
  maxDv: number;
  /** 라이브러리 = 애니 클립 중 이 접두사로 시작하는 것 */
  clipPrefix: string;
  /** 매칭 창: 클립 밀림 시각(pushTau) 기준 [before, after]초 */
  search: { before: number; after: number };
  /** 매칭 비용 가중치: COM 속도 차 (m/s)², 발 기준 COM 위치 차 m², 두 발 상대 위치 차 m², 발 접촉 불일치 수, 다리 관절 각 차 rad² */
  cost: { vel: number; com: number; feet: number; contact: number; legs: number; peak: number };
  /** 비용이 이보다 크면 반응 클립을 쓰지 않는다 (맞는 클립 없음) */
  maxCost: number;
  /** 관절 목표 관성화 (지금 자세 → 클립, 초) */
  blendTime: number;
  /** 클립 끝 endBefore초 전부터 COM 수평 속도 < endSpeed이면 서기 균형으로 돌아온다. 클립이 끝나면 무조건 */
  endBefore: number;
  endSpeed: number;
  /** 서기로 돌아올 때 관절 목표 관성화 (초) */
  returnBlend: number;
  /** 걸음으로 셀 최소 발 이동 (m, v0.4 countMinMove와 같은 뜻) */
  countMinMove: number;
  /** 반응 추종 중 walk.json 값 덮어쓰기 (깊은 병합) */
  walk: Record<string, unknown>;
  /** 언제 클립을 고를지: delay = 충격 + delay초, landing = 스텝 계층의 첫 반응 착지 뒤 */
  startOn?: 'delay' | 'landing';
  /** 걷는 중에도 반응 클립을 쓸지 (걷기 밀림 클립이 있을 때) */
  whileWalking: boolean;
  /**
   * track = 클립 전체를 애니 추종 QP로 따름(걸음도 클립). style = 다리·COM은 v0.4 균형·스텝 계층이 정하고, 클립의 상체(척추·머리·팔) 관절 목표를
   * 우리 걸음에 맞춰 시간을 늘이고 줄여(time-warp) 목표 포즈로 쓴다 (README 결정 160)
   */
  mode?: 'track' | 'style';
  style?: StyleConfig;
}

export interface StyleConfig {
  /** 클립에서 가져올 관절 */
  joints: JointName[];
  /** 클립 고르기: dir·(1 − cos 방향 차) + dv·(dvPeak/dvScale − 충격 뒤 COM 속도 최대)² */
  cost: { dir: number; dv: number; dvScale: number };
  /** 클립 가중치 들어가기·나오기 (초, smoothstep) */
  blendIn: number;
  blendOut: number;
  /** 재생 속도 범위·저역 통과 (초): 클립의 k번째 착지가 우리 k번째 착지(예측)에 오게 */
  rate: { min: number; max: number; tau: number; settle: number };
  /** 스텝 계층이 서기로 돌아오고 이 시간이 지나면(또는 클립 끝) 나온다 */
  holdAfterStand: number;
  /** 스타일 중 균형 QP 팔 자세 가중치 (위팔, 전완·손), 팔 반사·벌림 배율 */
  armWeight: number;
  foreArmWeight: number;
  reflexScale: number;
  abductScale: number;
  /** 걸음 문: 스텝 계층이 반응 걸음 중이면 스타일 가중치 × inStep (down초), 아니면 1로 (up초). 첫 걸음·다시 밀린 걸음은 v0.4 그대로 */
  stepGate?: { inStep: number; down: number; up: number };
  /** 다시 맞아 풀 때 나오기 시간 (초, rehit release) */
  releaseTime?: number;
  /** 스타일 중 팔 각운동량 비용 가중치 배율 */
  armMomScale?: number;
  /** 스타일 중 몸통(Spine2) 방향 과제 가중치 배율 */
  trunkWeightScale?: number;
  /** 위험도: 감지 DCM이 지지 다각형 밖 d0 → d1 m에서 0 → 1 (smoothstep), 내릴 때 tau초. 위험도만큼 팔 묶음을 풀어 균형에 쓴다 */
  danger?: { d0: number; d1: number; tau: number; v0?: number; v1?: number };
  /** 착지로 셀 클립 발 이동 (m) */
  landingMinMove: number;
}

/**
 * 레퍼런스 → 추종기 경계 (README 결정 164, SPEC 17 경계 원칙). 레퍼런스 생성(반응 클립 선택·시간 늘이기·행동 편집)은 관절 목표 흐름(targets)과 이것만 낸다.
 * 추종기(지금은 전신 QP + 근육, 나중에 학습 정책일 수 있음)는 이것을 읽어 관절별 추종 세기를 정한다. 위험할 때 풀지(release)는 추종기 쪽 판단이다.
 */
export interface TrackingRef {
  /** 어디서 온 레퍼런스인가 (로그) */
  source: string;
  /** 레퍼런스 가중치 0~1 (들어가기·나오기·걸음 문) */
  w: number;
  /** 관절별 추종 세기 (자세 과제 가중치, w = 1일 때) */
  jointWeight: Partial<Record<JointName, number>>;
  /** 관절별 레퍼런스 가중치 배율 0~1 (없으면 1): 행동이 팔을 쓰는 동안 그 팔의 묶음을 푼다 (README 결정 167) */
  jointScale?: Partial<Record<JointName, number>>;
  /** 추종기 힌트 (w = 1일 때 배율): 팔 반사, 스텝 팔 벌림·쥐지 않는 팔 벌림, 몸통 방향 과제 가중치, 팔 각운동량 비용 */
  reflexScale: number;
  abductScale: number;
  trunkWeightScale: number;
  armMomScale: number;
  /** 추종기 쪽 풀기: 위험도(DCM 이탈·COM 속도)만큼 관절 추종 세기를 푼다 */
  release: StyleConfig['danger'] | null;
}

/** 상체 스타일 → 추종 레퍼런스 (팔 관절 추종 세기: 위팔 armWeight, 전완·손 foreArmWeight) */
export function styleTrackingRef(sc: StyleConfig, clip: string, w: number, armScale?: Readonly<Record<'Left' | 'Right', number>>): TrackingRef {
  const jw: Partial<Record<JointName, number>> = {};
  const js: Partial<Record<JointName, number>> = {};
  for (const side of ['Left', 'Right'] as const) {
    jw[(side + 'Arm') as JointName] = sc.armWeight;
    jw[(side + 'ForeArm') as JointName] = sc.foreArmWeight;
    jw[(side + 'Hand') as JointName] = sc.foreArmWeight;
    if (armScale && armScale[side] < 1) for (const p of ['Arm', 'ForeArm', 'Hand']) js[(side + p) as JointName] = armScale[side];
  }
  return { source: 'reaction:' + clip, w, jointWeight: jw, ...(Object.keys(js).length ? { jointScale: js } : {}), reflexScale: sc.reflexScale, abductScale: sc.abductScale, trunkWeightScale: sc.trunkWeightScale ?? 1, armMomScale: sc.armMomScale ?? 1, release: sc.danger ?? null };
}

/** 스타일 진행 상태 (로그) */
export interface StyleLog { clip: string; tau: number; rate: number; w: number; ourLandings: number; clipLandings: number[]; dirCos: number; /** 팔 묶음 배율 (행동이 팔을 쓸 때만 기록) */ armK?: Record<'Left' | 'Right', number> }

export interface ReactionMeta {
  name: string;
  /** 클립 밀림 시각 (초) */
  pushTau: number;
  /** 밀림 뒤 1초 안 COM 수평 속도 최대 (m/s) */
  dvPeak: number;
  /** 밀린 방향 (클립 공간 xz, 단위): 밀림 뒤 0.5초 COM 이동 방향 */
  dir: [number, number];
  /** 'stand' = 서서 밀림, 'walk' = 걷다가 밀림 */
  from: 'stand' | 'walk';
}

/** 클립 프레임별 매칭 특징 (클립 공간) */
interface ClipFeat { com: Vec3[]; comVel: Vec3[]; mid: Vec3[]; yaw: number[]; feet: Vec3[]; contact: [boolean, boolean][] }

export interface ReactionQuery {
  com: Vec3; comVel: Vec3; feet: Record<FootName, Vec3>; contact: Record<FootName, boolean>; pelvisYaw: number; joints: JointTargets; walking: boolean;
  /** 충격 뒤 COM 수평 속도 최대 (m/s) — 클립 밀림 세기(dvPeak)와 비교 */
  peakSpeed: number;
}

export interface ReactionMatch { clip: string; tau: number; cost: number; anchor: Xform; terms: { vel: number; com: number; feet: number; contact: number; legs: number; peak: number }; clipVel: Vec3 }

/** 로그·시각화 (CharacterState.reaction) */
export interface ReactionLog {
  phase: 'wait' | 'track' | 'done';
  clip: string | null;
  tau: number;
  startT: number;
  cost: number;
  /** 고를 때 측정 COM 속도 / 클립 COM 속도 (월드 xz) */
  vel: [number, number] | null;
  clipVel: [number, number] | null;
  /** 끝난 이유: end(클립 끝) / handover(크게 벗어나 균형·스텝으로) / hit(새 충격) / none(맞는 클립 없음) */
  reason: string;
  candidates: number;
  /** style 모드 진행 */
  style?: StyleLog;
}

const LEG_JOINTS: JointName[] = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const yawOf = (q: Readonly<Quat>): number => { const f = rotate(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); };
const rotY = (yaw: number, v: Readonly<Vec3>): Vec3 => rotate(fromAxisAngle([0, 1, 0], yaw), v);

/** 깊은 병합 (설정 덮어쓰기) */
export function mergeDeep<T>(base: T, over: Record<string, unknown>): T {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? mergeDeep(out[k], v as Record<string, unknown>) : v;
  }
  return out as T;
}

export class ReactionLibrary {
  readonly meta: ReactionMeta[] = [];
  private readonly feat = new Map<string, ClipFeat>();

  constructor(readonly anim: AnimDriver, readonly def: CharacterDef, readonly mass: MassModel, names: readonly string[]) {
    for (const name of names) {
      const clip = anim.getClip(name);
      const f = this.features(clip);
      this.feat.set(name, f);
      const info = (anim.library[name]?.info ?? {}) as { pushFrame?: number; reactionFrom?: string };
      const pushTau = (info.pushFrame ?? 30) / clip.fps;
      const i0 = Math.round(pushTau * clip.fps);
      let peak = 0;
      for (let i = i0; i < Math.min(clip.n, i0 + clip.fps); i++) peak = Math.max(peak, Math.hypot(f.comVel[i]![0], f.comVel[i]![2]));
      const i1 = Math.min(clip.n - 1, i0 + Math.round(0.5 * clip.fps));
      const d = sub(f.com[i1]!, f.com[i0]!), dl = Math.hypot(d[0], d[2]) || 1;
      this.meta.push({ name, pushTau, dvPeak: peak, dir: [d[0] / dl, d[2] / dl], from: info.reactionFrom === 'walk' ? 'walk' : 'stand' });
    }
  }

  private features(clip: AnimClip): ClipFeat {
    const com = clip.fk.map((bs) => {
      let c: Vec3 = [0, 0, 0], m = 0;
      bs.forEach((b, i) => { const mi = this.mass.mass[i]!; c = add(c, scale(add(b.pos, rotate(b.rot, this.mass.localCom[i]!)), mi)); m += mi; });
      return scale(c, 1 / m);
    });
    const n = clip.n;
    const comVel = com.map((_, i) => scale(sub(com[Math.min(n - 1, i + 1)]!, com[Math.max(0, i - 1)]!), clip.fps / Math.max(1, Math.min(n - 1, i + 1) - Math.max(0, i - 1))));
    const L = clip.footIdx.LeftFoot, R = clip.footIdx.RightFoot;
    const mid = clip.fk.map((bs) => scale(add(bs[L]!.pos, bs[R]!.pos), 0.5));
    const feet = clip.fk.map((bs) => sub(bs[L]!.pos, bs[R]!.pos));
    const yaw = clip.fk.map((bs) => yawOf(multiplyQ(bs[0]!.rot, conjugate(this.def.bodies[0]!.restRotation))));
    return { com, comVel, mid, yaw, feet, contact: clip.frames.map((f) => f.contact) };
  }

  /**
   * style 모드 클립 고르기: 밀린 방향(충격 뒤 COM 속도 방향, 골반 yaw 기준)과 세기(충격 뒤 COM 속도 최대)가 가장 가까운 클립.
   * 같으면 이름 순(결정론)
   */
  chooseStyle(velW: Readonly<Vec3>, peakSpeed: number, pelvisYaw: number, walking: boolean, c: StyleConfig): { meta: ReactionMeta; cost: number; dirCos: number } | null {
    const vl = rotY(-pelvisYaw, velW);
    const n = Math.hypot(vl[0], vl[2]);
    if (n < 1e-6) return null;
    const d: [number, number] = [vl[0] / n, vl[2] / n];
    let best: { meta: ReactionMeta; cost: number; dirCos: number } | null = null;
    for (const m of this.meta) {
      if ((m.from === 'walk') !== walking) continue;
      // 클립 방향은 클립 0프레임 골반 정면(+Z) 기준 (Kimodo 클립은 stand 키프레임으로 정면 +Z에서 시작)
      const cos = d[0] * m.dir[0] + d[1] * m.dir[1];
      const cost = c.cost.dir * (1 - cos) + c.cost.dv * (m.dvPeak * c.cost.dvScale - peakSpeed) ** 2;
      if (!best || cost < best.cost - 1e-12) best = { meta: m, cost, dirCos: cos };
    }
    return best;
  }

  /** 클립 착지 시각들 (밀림 뒤, 발이 minMove 넘게 옮겨진 디딤만, 시간 순) */
  landings(name: string, minMove: number): number[] {
    const clip = this.anim.getClip(name);
    const m = this.meta.find((x) => x.name === name)!;
    const out: number[] = [];
    for (const f of ['LeftFoot', 'RightFoot'] as const) {
      const st = clip.stances[f];
      for (let i = 1; i < st.length; i++) {
        const a = st[i - 1]!.plant.pos, b = st[i]!.plant.pos;
        if (st[i]!.t0 > m.pushTau + 0.03 && Math.hypot(b[0] - a[0], b[2] - a[2]) > minMove) out.push(st[i]!.t0);
      }
    }
    return out.sort((x, y) => x - y);
  }

  /** 지금 상태와 가장 비슷한 (클립, 시각). 클립 공간과 월드를 '두 발 중점 + 골반 yaw' 기준으로 맞춰 비교한다 */
  match(q: ReactionQuery, cfg: ReactionConfig): ReactionMatch | null {
    const w = cfg.cost;
    const mid = scale(add(q.feet.LeftFoot, q.feet.RightFoot), 0.5);
    const toLocal = (v: Readonly<Vec3>) => rotY(-q.pelvisYaw, v);
    const cA = toLocal(sub(q.com, mid)), vA = toLocal(q.comVel), fA = toLocal(sub(q.feet.LeftFoot, q.feet.RightFoot));
    let best: ReactionMatch | null = null;
    for (const m of this.meta) {
      if ((m.from === 'walk') !== q.walking) continue;
      const clip = this.anim.getClip(m.name);
      const f = this.feat.get(m.name)!;
      const pk = w.peak * (m.dvPeak - q.peakSpeed) ** 2;
      const i0 = Math.max(1, Math.round((m.pushTau + cfg.search.before) * clip.fps));
      const i1 = Math.min(clip.n - 2, Math.round((m.pushTau + cfg.search.after) * clip.fps));
      for (let i = i0; i <= i1; i++) {
        const cl = (v: Readonly<Vec3>) => rotY(-f.yaw[i]!, v);
        const cC = cl(sub(f.com[i]!, f.mid[i]!)), vC = cl(f.comVel[i]!), fC = cl(f.feet[i]!);
        const dv2 = (vA[0] - vC[0]) ** 2 + (vA[2] - vC[2]) ** 2;
        const dc2 = (cA[0] - cC[0]) ** 2 + (cA[2] - cC[2]) ** 2;
        const df2 = (fA[0] - fC[0]) ** 2 + (fA[2] - fC[2]) ** 2;
        const ct = f.contact[i]!;
        const dn = (ct[0] !== q.contact.LeftFoot ? 1 : 0) + (ct[1] !== q.contact.RightFoot ? 1 : 0);
        let dj = 0;
        for (const jn of LEG_JOINTS) {
          const a = clip.frames[i]!.joints[jn], b = q.joints[jn];
          if (a && b) { const r = toRotationVector(multiplyQ(a, conjugate(b))); dj += r[0] * r[0] + r[1] * r[1] + r[2] * r[2]; }
        }
        const terms = { vel: w.vel * dv2, com: w.com * dc2, feet: w.feet * df2, contact: w.contact * dn, legs: w.legs * dj, peak: pk };
        const cost = terms.vel + terms.com + terms.feet + terms.contact + terms.legs + terms.peak;
        if (!best || cost < best.cost - 1e-12) {
          const yaw = q.pelvisYaw - f.yaw[i]!;
          const rm = rotY(yaw, f.mid[i]!);
          best = { clip: m.name, tau: i / clip.fps, cost, terms, anchor: { yaw, pos: [mid[0] - rm[0], 0, mid[2] - rm[2]] }, clipVel: rotY(yaw, f.comVel[i]!) };
        }
      }
    }
    return best;
  }
}

/** 반응 추종 상태 (Character가 쓴다) */
export class ReactionController {
  log: ReactionLog = { phase: 'done', clip: null, tau: 0, startT: 0, cost: 0, vel: null, clipVel: null, reason: '', candidates: 0 };
  /** 클립을 고를 시각 (충격 + delay) */
  pendingT: number | null = null;
  active = false;
  /** 이 반응이 끝나면 돌아갈 곳 */
  returnTo: { kind: 'stand' } | { kind: 'clip'; name: string } = { kind: 'stand' };
  /** 걸음 세기: 발이 마지막으로 디딘 자리 */
  lastPlant: Record<FootName, Vec3 | null> = { LeftFoot: null, RightFoot: null };
  landingsSeen = 0;
  /** 충격 뒤 (클립을 고를 때까지) COM 수평 속도 최대 */
  peakSpeed = 0;
  /** startOn landing: 첫 착지를 기다리는 중 */
  waitLanding = false;
  /** 마지막 충격 시각 */
  hitT: number | null = null;
  /** style 모드 진행: 클립, 클립 시각, 재생 속도, 가중치, 시작·나오기 시각, 클립 착지 시각들, 우리 착지 수, 서기로 돌아온 시각 */
  style: { clip: string; tau: number; rate: number; w: number; startT: number; outT: number | null; landings: number[]; ours: number; standSince: number | null; dirCos: number; gate: number; from: JointTargets | null; fromT: number; outDur?: number; /** 팔 묶음 배율 (행동이 그 팔을 쓰면 0으로, README 결정 167) */ armK: Record<'Left' | 'Right', number> } | null = null;
  /** 직전 스텝의 스타일 출력 (다시 맞아 클립이 바뀔 때 이어 붙이기) */
  lastOut: JointTargets | null = null;
  /** 반응 추종 중 walk 설정 (기본 + 덮어쓰기) */
  readonly walkCfg: WalkConfig;

  constructor(readonly cfg: ReactionConfig, public lib: ReactionLibrary | null, baseWalk: WalkConfig) {
    this.walkCfg = mergeDeep(baseWalk, cfg.walk ?? {});
  }
}
