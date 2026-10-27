// 애니메이션 드라이버 (SPEC 7.1의 5단계, v0.6 "애니메이션 통합"). 정의: docs/ALGORITHMS.md v0.6.
// - 클립(assets/poses, SPEC 11.1) 재생 → 관절 목표(정의 관절 좌표계 상대 회전) + 루트 궤적 + 발 접촉 단계.
// - 루프: 한 바퀴마다 loopRootDelta(yaw, pos)를 누적한다(루트 모션 kept). 클립 공간 → 월드 = 앵커 변환(yaw + 이동).
// - 전환: 크로스페이드 대신 관성화(inertialization): 전환 순간의 출력과 새 목표의 차이(관절 회전 벡터·각속도, 루트 위치·회전)를
//   임계 감쇠 스프링으로 0까지 줄인다 (Bollo 2016 / Holden 2023 'spring inertialization'). 새 목표는 처음부터 그대로 흐른다.
// - 위상 맞추기: 발 접촉 패턴 + 두 발 상대 위치 + 다리 관절 각 + 앞 속도로 클립에서 가장 가까운 시각을 찾는다 (외란 뒤 복귀).
// - 기준값(AnimRef): 바디 월드 자세·속도(중앙 차분), COM 위치·속도·가속도, 중심 각운동량, 발별 접촉·뒤꿈치/발끝·스윙 진행·착지 자세.
import type { CharacterDef } from './characterDef';
import { forwardKinematics, type BodyTransform, type JointName, type JointTargets } from './pose';
import { soleCorners, FOOT_NAMES, type FootName } from './perception';
import { type Vec3, add, sub, scale, cross, length } from '../math/vec3';
import { type Quat, conjugate, fromAxisAngle, fromRotationVector, identityQ, multiplyQ, normalizeQ, rotate, slerp, toRotationVector } from '../math/quat';

/** assets/poses/<clip>.json (SPEC 11.1, docs/KIMODO.md "포즈 클립 형식") */
export interface AnimClipFile {
  name: string;
  source?: string;
  fps: number;
  loop: boolean;
  rootMotion: 'kept' | 'removed';
  jointConvention?: string;
  frames: { root: { pos: Vec3; rot: Quat }; joints: Partial<Record<JointName, Quat>>; contacts: { LeftFoot?: boolean; RightFoot?: boolean } }[];
  loopRootDelta?: { pos: Vec3; yaw: number };
  info?: Record<string, unknown>;
}

/** 수평 변환: world = Ry(yaw)·p + pos */
export interface Xform { yaw: number; pos: Vec3 }
export const IDENTITY_X: Xform = { yaw: 0, pos: [0, 0, 0] };
const UP: Vec3 = [0, 1, 0];
export const yawQ = (yaw: number): Quat => fromAxisAngle(UP, yaw);
export const applyXP = (x: Xform, p: Readonly<Vec3>): Vec3 => add(rotate(yawQ(x.yaw), p), x.pos);
export const applyXR = (x: Xform, q: Readonly<Quat>): Quat => multiplyQ(yawQ(x.yaw), q);
/** a ∘ b (b 먼저) */
export const composeX = (a: Xform, b: Xform): Xform => ({ yaw: a.yaw + b.yaw, pos: applyXP(a, b.pos) });
export const inverseX = (a: Xform): Xform => ({ yaw: -a.yaw, pos: rotate(yawQ(-a.yaw), scale(a.pos, -1)) });
export const yawOfQ = (q: Readonly<Quat>): number => { const f = rotate(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); };

/** COM·각운동량 계산용 질량 모델 (Ragdoll 바디 값 그대로): 질량, 바디 로컬 질량 중심, 바디 로컬 관성(3×3 행 우선) */
export interface MassModel { mass: number[]; localCom: Vec3[]; inertia: number[][] }

export interface AnimDriverConfig {
  /** 관성화 기본 시간(초): 오프셋이 이 시간에 거의 0 (λ = 6.6 / 시간) */
  blendTime: number;
  /** 뒤꿈치·발끝 '닿음' 높이 (클립 FK 발바닥 꼭짓점, m) */
  soleDownHeight: number;
  /** 기준 속도·가속도 중앙 차분 간격(초) */
  diffDt: number;
  /** 위상 맞추기 비용 가중치 */
  phaseMatch: { contact: number; feet: number; joints: number; vel: number };
}

interface StanceInterval {
  /** 한 바퀴 안 시작 시각 [0, D), 끝(시작보다 크고 D를 넘을 수 있음 = 이음매 넘김) */
  t0: number;
  t1: number;
  /** 발이 가장 평평·낮은 프레임 시각과 그때 발 자세 (클립 0바퀴 공간) */
  plantT: number;
  plant: BodyTransform;
}

const DEG = 180 / Math.PI;

/** 클립 한 개 (미리 계산: FK, 접촉 구간, 착지 자세) */
export class AnimClip {
  readonly name: string;
  readonly fps: number;
  readonly n: number;
  readonly loop: boolean;
  readonly duration: number;
  readonly kept: boolean;
  readonly delta: Xform;
  readonly frames: { root: BodyTransform; joints: JointTargets; contact: [boolean, boolean] }[];
  readonly stances: Record<FootName, StanceInterval[]>;
  /** 프레임별 FK 바디 (클립 0바퀴 공간) */
  readonly fk: BodyTransform[][];
  private readonly cyc = new Map<number, Xform>();
  readonly footIdx: Record<FootName, number>;
  readonly footHalf: Vec3;

  constructor(file: AnimClipFile, readonly def: CharacterDef, soleDownHeight: number) {
    this.name = file.name;
    this.fps = file.fps;
    this.n = file.frames.length;
    this.loop = file.loop;
    this.duration = this.loop ? this.n / this.fps : (this.n - 1) / this.fps;
    this.kept = file.rootMotion === 'kept';
    this.delta = this.loop && this.kept && file.loopRootDelta ? { yaw: file.loopRootDelta.yaw, pos: [...file.loopRootDelta.pos] as Vec3 } : IDENTITY_X;
    // 사원수 반구 연속성 (보간이 짧은 길로 가도록)
    const prev: Partial<Record<string, Quat>> = {};
    this.frames = file.frames.map((f) => {
      const joints: JointTargets = {};
      for (const [k, q0] of Object.entries(f.joints)) {
        let q = normalizeQ(q0 as Quat);
        const p = prev[k];
        if (p && p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        prev[k] = q;
        joints[k as JointName] = q;
      }
      return { root: { pos: [...f.root.pos] as Vec3, rot: normalizeQ(f.root.rot) }, joints, contact: [!!f.contacts.LeftFoot, !!f.contacts.RightFoot] as [boolean, boolean] };
    });
    this.fk = this.frames.map((f) => forwardKinematics(def, f.joints, f.root));
    this.footIdx = { LeftFoot: def.bodies.findIndex((b) => b.name === 'LeftFoot'), RightFoot: def.bodies.findIndex((b) => b.name === 'RightFoot') };
    const fs = def.bodies[this.footIdx.LeftFoot]!.shape;
    this.footHalf = fs.type === 'box' ? [...fs.halfExtents] as Vec3 : [0.056, 0.062, 0.125];
    this.stances = { LeftFoot: this.findStances(0, soleDownHeight), RightFoot: this.findStances(1, soleDownHeight) };
  }

  /** 발 k(0 왼, 1 오)의 접촉 구간 (루프면 원형) */
  private findStances(k: 0 | 1, _down: number): StanceInterval[] {
    const n = this.n, dt = 1 / this.fps;
    const c = this.frames.map((f) => f.contact[k]);
    const out: StanceInterval[] = [];
    const fi = this.footIdx[k === 0 ? 'LeftFoot' : 'RightFoot'];
    const flatness = (i: number) => {
      const b = this.fk[i]![fi]!;
      const s = soleCorners(b.pos, b.rot as [number, number, number, number], this.footHalf);
      return Math.max(...s.map((p) => p[1])) - Math.min(...s.map((p) => p[1])) + Math.max(0, Math.min(...s.map((p) => p[1])));
    };
    const mk = (a: number, b: number): StanceInterval => {
      // a, b: 프레임 번호 (b 포함, 루프면 n을 넘을 수 있다)
      let best = a, bv = Infinity;
      for (let i = a; i <= b; i++) { const v = flatness(i % n); if (v < bv - 1e-9) { bv = v; best = i; } }
      const plantT = best * dt;
      const pf = this.fk[best % n]![fi]!;
      const plant = best >= n ? this.cycleBody(pf, 1) : pf;
      return { t0: a * dt, t1: (b + 1) * dt, plantT, plant };
    };
    if (!this.loop) {
      let i = 0;
      while (i < n) {
        if (!c[i]) { i++; continue; }
        let j = i;
        while (j + 1 < n && c[j + 1]) j++;
        out.push(mk(i, j));
        i = j + 1;
      }
      return out;
    }
    if (c.every((x) => x)) return [mk(0, n - 1)];
    // 원형: 접촉이 아닌 프레임에서 시작해 한 바퀴
    const s0 = c.findIndex((x) => !x);
    let i = 0;
    while (i < n) {
      const fidx = (s0 + i) % n;
      if (!c[fidx]) { i++; continue; }
      let j = i;
      while (j + 1 < n && c[(s0 + j + 1) % n]) j++;
      const a = (s0 + i) % n;
      out.push(mk(a, a + (j - i)));
      i = j + 1;
    }
    return out.sort((x, y) => x.t0 - y.t0);
  }

  /** k번째 바퀴 변환 (delta^k) */
  cycleX(k: number): Xform {
    if (k === 0 || (this.delta.yaw === 0 && this.delta.pos[0] === 0 && this.delta.pos[1] === 0 && this.delta.pos[2] === 0)) return IDENTITY_X;
    let x = this.cyc.get(k);
    if (x) return x;
    const step = k > 0 ? this.delta : inverseX(this.delta);
    x = IDENTITY_X;
    for (let i = 0; i < Math.abs(k); i++) x = composeX(step, x);
    this.cyc.set(k, x);
    return x;
  }

  private cycleBody(b: BodyTransform, k: number): BodyTransform {
    const x = this.cycleX(k);
    return { pos: applyXP(x, b.pos), rot: applyXR(x, b.rot) };
  }

  /** 시각 tau(초, 클립 시간)의 루트·관절 (클립 공간, 바퀴 누적 포함). 루프가 아니면 끝에서 멈춤 */
  poseAt(tau: number): { root: BodyTransform; joints: JointTargets } {
    const n = this.n;
    let i: number, f: number, ka = 0, kb = 0, ib: number;
    if (!this.loop) {
      const x = Math.max(0, Math.min(n - 1, tau * this.fps));
      i = Math.floor(x); f = x - i;
      if (i >= n - 1) { i = n - 1; f = 0; }
      ib = Math.min(n - 1, i + 1);
    } else {
      const D = this.duration;
      const k = Math.floor(tau / D);
      const u = tau - k * D;
      const x = u * this.fps;
      i = Math.min(n - 1, Math.floor(x)); f = x - i;
      ka = kb = k;
      ib = i + 1;
      if (ib >= n) { ib = 0; kb = k + 1; }
    }
    const A = this.frames[i]!, B = this.frames[ib]!;
    const xa = this.cycleX(ka), xb = this.cycleX(kb);
    const pa = applyXP(xa, A.root.pos), pb = applyXP(xb, B.root.pos);
    const ra = applyXR(xa, A.root.rot), rb = applyXR(xb, B.root.rot);
    const joints: JointTargets = {};
    if (f === 0) Object.assign(joints, A.joints);
    else for (const k of Object.keys(A.joints) as JointName[]) joints[k] = slerp(A.joints[k]!, B.joints[k] ?? A.joints[k]!, f);
    return { root: { pos: [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f], rot: slerp(ra, rb, f) }, joints };
  }

  /**
   * 디딤 순서 (DCM 계획용): tau에 지금 딛고 있는 발 중 가장 늦게 디딘 구간부터, 시작 시각 순으로 n개.
   * 구간마다 발, 시작(착지)·끝(떼기) 절대 클립 시간, 디딤 자세(클립 공간, 바퀴 누적 포함)
   */
  stepSequence(tau: number, n: number): { foot: FootName; start: number; end: number; plant: BodyTransform }[] {
    // 두 발이 늘 딛고 있는 클립(Idle)은 디딤 순서가 없다
    if (!FOOT_NAMES.some((f) => this.stances[f].some((s) => s.t1 - s.t0 < this.duration - 1e-6))) return [];
    const all: { foot: FootName; start: number; end: number; plant: BodyTransform }[] = [];
    const ks = this.loop ? (() => { const k = Math.floor(tau / this.duration); return [k - 1, k, k + 1, k + 2, k + 3]; })() : [0];
    for (const foot of FOOT_NAMES) for (const s of this.stances[foot]) for (const kk of ks) {
      const D = this.loop ? this.duration : 0;
      const start = kk * D + s.t0, end = this.loop ? kk * D + s.t1 : (s.t1 >= (this.n - 1) / this.fps ? Infinity : s.t1);
      if (end <= tau) continue;
      all.push({ foot, start, end, plant: this.loop ? this.cycleBody(s.plant, kk) : s.plant });
    }
    all.sort((a, b) => a.start - b.start);
    // 지금 딛고 있는 것 중 가장 늦게 디딘 것부터
    let i0 = 0;
    for (let i = 0; i < all.length; i++) if (all[i]!.start <= tau) i0 = i;
    return all.slice(i0, i0 + n);
  }

  /** 접촉 플래그 (가장 가까운 프레임) */
  contactAt(tau: number): [boolean, boolean] {
    const n = this.n;
    let i = Math.round(tau * this.fps);
    i = this.loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return this.frames[i]!.contact;
  }

  /**
   * 발 F의 시각 tau 접촉 구간 정보 (절대 클립 시간):
   * stance면 지금 구간 [tTd, tEnd)와 그 착지 자세, swing이면 직전 떼기 tLo와 다음 착지 tTd(+ 그 구간 끝 tEnd)와 착지 자세.
   */
  footPhase(foot: FootName, tau: number): { stance: boolean; tLo: number; tTd: number; tEnd: number; plant: BodyTransform } {
    const list = this.stances[foot];
    const fi = this.footIdx[foot];
    if (!list.length) {
      const b = this.poseAt(tau);
      const fk = forwardKinematics(this.def, b.joints, b.root)[fi]!;
      return { stance: false, tLo: -Infinity, tTd: Infinity, tEnd: Infinity, plant: fk };
    }
    if (!this.loop) {
      let prevEnd = -Infinity;
      for (const s of list) {
        if (tau >= s.t0 && tau < s.t1) return { stance: true, tLo: prevEnd, tTd: s.t0, tEnd: s.t1, plant: s.plant };
        if (tau < s.t0) return { stance: false, tLo: prevEnd, tTd: s.t0, tEnd: s.t1, plant: s.plant };
        prevEnd = s.t1;
      }
      const last = list[list.length - 1]!;
      // 끝난 뒤: 마지막 구간에 서 있는 것으로 (클립 끝에서 멈춤)
      return { stance: tau >= last.t0, tLo: prevEnd, tTd: last.t0, tEnd: Infinity, plant: last.plant };
    }
    const D = this.duration;
    const k = Math.floor(tau / D);
    // 후보: 바퀴 k−1, k, k+1의 구간들 (절대 시간)
    let lo = -Infinity, nextS: { a: number; b: number; s: StanceInterval; kk: number } | null = null;
    for (const kk of [k - 1, k, k + 1]) for (const s of list) {
      const a = kk * D + s.t0, b = kk * D + s.t1;
      if (tau >= a && tau < b) return { stance: true, tLo: -Infinity, tTd: a, tEnd: b, plant: this.cycleBody(s.plant, kk) };
      if (b <= tau && b > lo) lo = b;
      if (a > tau && (!nextS || a < nextS.a)) nextS = { a, b, s, kk };
    }
    return { stance: false, tLo: lo, tTd: nextS!.a, tEnd: nextS!.b, plant: this.cycleBody(nextS!.s.plant, nextS!.kk) };
  }
}

/** 관성화 (임계 감쇠 스프링): 오프셋 o(t) = (o0 + (v0 + λo0)t)e^{−λt}. 관절별 회전 벡터(부모 쪽 관절 좌표계) + 루트 위치·회전 */
export class Inertializer {
  private joints = new Map<string, { o: Vec3; v: Vec3 }>();
  private root: { p: Vec3; vp: Vec3; r: Vec3; vr: Vec3 } | null = null;
  private t0 = 0;
  private lambda = 0;
  active = false;

  start(t: number, blendTime: number, prev: { joints: JointTargets; vel: Partial<Record<JointName, Vec3>>; root?: BodyTransform; rootVel?: { lin: Vec3; ang: Vec3 } }, next: { joints: JointTargets; vel: Partial<Record<JointName, Vec3>>; root?: BodyTransform; rootVel?: { lin: Vec3; ang: Vec3 } }): void {
    // 지금 남아 있는 오프셋을 반영한 이전 출력에서 새로 시작한다 (prev는 이미 오프셋이 적용된 출력)
    this.joints.clear();
    this.lambda = blendTime > 0 ? 6.6 / blendTime : 0;
    this.t0 = t;
    this.active = blendTime > 0;
    if (!this.active) { this.root = null; return; }
    for (const k of Object.keys(next.joints) as JointName[]) {
      const qp = prev.joints[k], qn = next.joints[k];
      if (!qp || !qn) continue;
      const o = toRotationVector(multiplyQ(qp, conjugate(qn)));
      const v = sub(prev.vel[k] ?? [0, 0, 0], next.vel[k] ?? [0, 0, 0]);
      if (length(o) < 1e-7 && length(v) < 1e-6) continue;
      this.joints.set(k, { o, v });
    }
    if (prev.root && next.root) {
      this.root = {
        p: sub(prev.root.pos, next.root.pos), vp: sub(prev.rootVel?.lin ?? [0, 0, 0], next.rootVel?.lin ?? [0, 0, 0]),
        r: toRotationVector(multiplyQ(prev.root.rot, conjugate(next.root.rot))), vr: sub(prev.rootVel?.ang ?? [0, 0, 0], next.rootVel?.ang ?? [0, 0, 0]),
      };
    } else this.root = null;
  }

  private decay(t: number, o: Readonly<Vec3>, v: Readonly<Vec3>): Vec3 {
    const dt = Math.max(0, t - this.t0), l = this.lambda;
    const e = Math.exp(-l * dt);
    return [(o[0] + (v[0] + l * o[0]) * dt) * e, (o[1] + (v[1] + l * o[1]) * dt) * e, (o[2] + (v[2] + l * o[2]) * dt) * e];
  }

  /** 오프셋 크기(도, 관절 최대) — 로그 */
  magnitudeDeg(t: number): number {
    if (!this.active) return 0;
    let m = 0;
    for (const j of this.joints.values()) m = Math.max(m, length(this.decay(t, j.o, j.v)) * DEG);
    return m;
  }

  apply(t: number, joints: JointTargets): JointTargets {
    if (!this.active) return joints;
    if (t - this.t0 > 3 * 6.6 / Math.max(this.lambda, 1e-9)) { this.active = false; return joints; }
    const out: JointTargets = { ...joints };
    for (const [k, j] of this.joints) {
      const q = out[k as JointName];
      if (q) out[k as JointName] = multiplyQ(fromRotationVector(this.decay(t, j.o, j.v)), q);
    }
    return out;
  }

  applyRoot(t: number, root: BodyTransform): BodyTransform {
    if (!this.active || !this.root) return root;
    return { pos: add(root.pos, this.decay(t, this.root.p, this.root.vp)), rot: multiplyQ(fromRotationVector(this.decay(t, this.root.r, this.root.vr)), root.rot) };
  }
}

/** 발별 기준값 (월드) */
export interface FootRef {
  /** 클립 접촉 플래그 */
  stance: boolean;
  heelDown: boolean;
  toeDown: boolean;
  /** 클립 발바닥 뒤꿈치·발끝 높이 (m, 꼭짓점 최저) */
  heelH: number;
  toeH: number;
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  acc: Vec3;
  angVel: Vec3;
  /** 직전 떼기, 다음(또는 지금) 착지, 그 구간 끝 (절대 클립 시간) */
  tLo: number;
  tTd: number;
  tEnd: number;
  /** 스윙 진행 0~1 (stance면 1) */
  s: number;
  /** 다음(또는 지금) 디딤 자세 (월드, 클립에서 발이 가장 평평한 순간) */
  plant: BodyTransform;
}

/** 클립 기준값 (월드, 앵커 적용, 관성화 포함) */
export interface AnimRef {
  clip: string;
  tau: number;
  /** 한 바퀴 안 위상 0~1 */
  phase: number;
  joints: JointTargets;
  /** 관절 목표 상대 각속도 (부모 쪽 관절 좌표계, rad/s) */
  jointVel: Partial<Record<JointName, Vec3>>;
  bodies: BodyTransform[];
  bodyLin: Vec3[];
  bodyAng: Vec3[];
  com: Vec3;
  comVel: Vec3;
  comAcc: Vec3;
  /** COM 둘레 각운동량 (월드, kg·m²/s) */
  angMom: Vec3;
  feet: Record<FootName, FootRef>;
  /** 디딤 순서 (DCM 계획, 월드): 지금 딛고 있는 발(가장 늦게 디딘)부터 시작 시각 순 */
  steps: { foot: FootName; start: number; end: number; plant: BodyTransform }[];
  /** 관성화 오프셋 크기 (도) */
  blendDeg: number;
}

export interface PhaseQuery {
  /** 실제 발 접촉 */
  contact: Record<FootName, boolean>;
  /** 실제 발 위치 (월드) */
  footPos: Record<FootName, Vec3>;
  /** 실제 관절 상대 회전 (다리) */
  joints: JointTargets;
  /** 실제 COM 속도 (월드) */
  comVel: Vec3;
  /** 걷는 방향 yaw (클립 +Z를 월드로) */
  yaw: number;
}

const rotvecDiff = (a: Readonly<Quat>, b: Readonly<Quat>, h: number): Vec3 => scale(toRotationVector(multiplyQ(a, conjugate(b))), 1 / h);
const LEG_JOINTS: JointName[] = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];

/** 클립 재생기: 시간·속도·앵커·관성화. 균형(walk)·상태 머신이 기준값을 읽는다 */
export class AnimDriver {
  clip: AnimClip | null = null;
  tau = 0;
  rate = 1;
  anchor: Xform = IDENTITY_X;
  readonly inert = new Inertializer();
  private readonly clips = new Map<string, AnimClip>();
  private cache: { t: number; tau: number; anchorKey: string; ref: AnimRef } | null = null;
  /** 직전 출력 (관성화 시작점) */
  private last: { t: number; joints: JointTargets; vel: Partial<Record<JointName, Vec3>>; root: BodyTransform; rootVel: { lin: Vec3; ang: Vec3 } } | null = null;

  constructor(readonly def: CharacterDef, readonly mass: MassModel, public cfg: AnimDriverConfig, readonly library: Readonly<Record<string, AnimClipFile>>) {}

  has(name: string): boolean { return name in this.library; }

  getClip(name: string): AnimClip {
    let c = this.clips.get(name);
    if (!c) {
      const f = this.library[name];
      if (!f) throw new Error(`unknown anim clip '${name}' (known: ${Object.keys(this.library).join(', ')})`);
      c = new AnimClip({ ...f, name }, this.def, this.cfg.soleDownHeight);
      this.clips.set(name, c);
    }
    return c;
  }

  /**
   * 클립 재생 시작. anchor = 클립 공간 → 월드. blendTime > 0이고 이전 출력이 있으면 관성화한다.
   * startTime = 클립 시각(초).
   */
  play(name: string, t: number, opts: { anchor: Xform; startTime?: number; blendTime?: number }): void {
    const clip = this.getClip(name);
    const prev = this.last;
    this.clip = clip;
    this.tau = opts.startTime ?? 0;
    this.rate = 1;
    this.anchor = opts.anchor;
    this.cache = null;
    const bt = opts.blendTime ?? this.cfg.blendTime;
    if (prev && bt > 0) {
      const nx = this.rawRef(this.tau);
      this.inert.start(t, bt, prev, { joints: nx.joints, vel: nx.jointVel, root: nx.bodies[0]!, rootVel: { lin: nx.bodyLin[0]!, ang: nx.bodyAng[0]! } });
    } else this.inert.start(t, 0, { joints: {}, vel: {} }, { joints: {}, vel: {} });
  }

  /** 같은 클립 안에서 시각을 옮긴다 (위상 맞추기 복귀). 관성화로 이어 붙인다 */
  jump(t: number, tau: number, anchor: Xform, blendTime?: number): void {
    if (!this.clip) return;
    this.play(this.clip.name, t, { anchor, startTime: tau, blendTime });
  }

  stop(): void { this.clip = null; this.cache = null; }

  /**
   * 지금 몸의 실제 관절 자세·속도에서 클립 목표로 관성화를 다시 시작한다 (v0.6 걷기 추종을 넘길 때: 모터 목표가 클립 자세로
   * 갑자기 바뀌면 멀리 벗어난 팔이 한 스텝에 튀었다 — 오른팔 57 rad/s 폭발)
   */
  blendFromActual(t: number, joints: JointTargets, vel: Partial<Record<JointName, Vec3>>, blendTime: number): void {
    if (!this.clip) return;
    const nx = this.rawRef(this.tau);
    this.inert.start(t, blendTime, { joints, vel }, { joints: nx.joints, vel: nx.jointVel });
    this.cache = null;
  }

  advance(dt: number): void { if (this.clip) { this.tau += dt * this.rate; this.cache = null; } }

  /** 클립 공간 FK (관성화 없음) */
  private fkAt(tau: number): { joints: JointTargets; bodies: BodyTransform[] } {
    const p = this.clip!.poseAt(tau);
    return { joints: p.joints, bodies: forwardKinematics(this.def, p.joints, p.root) };
  }

  private comOf(bodies: readonly BodyTransform[]): Vec3 {
    let c: Vec3 = [0, 0, 0], m = 0;
    bodies.forEach((b, i) => { const mi = this.mass.mass[i]!; c = add(c, scale(add(b.pos, rotate(b.rot, this.mass.localCom[i]!)), mi)); m += mi; });
    return scale(c, 1 / m);
  }

  /** 관성화 없는 기준값 (월드) */
  private rawRef(tau: number): AnimRef {
    const clip = this.clip!;
    const h = this.cfg.diffDt;
    const X = this.anchor;
    const toW = (bs: BodyTransform[]) => bs.map((b) => ({ pos: applyXP(X, b.pos), rot: applyXR(X, b.rot) }));
    const s0 = this.fkAt(tau), sp = this.fkAt(tau + h), sm = this.fkAt(tau - h), sp2 = this.fkAt(tau + 2 * h), sm2 = this.fkAt(tau - 2 * h);
    const b0 = toW(s0.bodies), bp = toW(sp.bodies), bm = toW(sm.bodies), bp2 = toW(sp2.bodies), bm2 = toW(sm2.bodies);
    const r = this.rate;
    // 속도·가속도는 실제 시간 기준 (재생 속도 rate 곱)
    const bodyLin = b0.map((_, i) => scale(sub(bp[i]!.pos, bm[i]!.pos), r / (2 * h)));
    const bodyAng = b0.map((_, i) => scale(toRotationVector(multiplyQ(bp[i]!.rot, conjugate(bm[i]!.rot))), r / (2 * h)));
    const c0 = this.comOf(b0), cp = this.comOf(bp), cm = this.comOf(bm), cp2 = this.comOf(bp2), cm2 = this.comOf(bm2);
    const comVel = scale(sub(cp, cm), r / (2 * h));
    const comAcc = scale(add(sub(cp2, scale(c0, 2)), cm2), (r * r) / (4 * h * h));
    // 중심 각운동량 Σ m (c_i − c) × v_i + R I Rᵀ ω (점질량 + 바디 관성)
    let L: Vec3 = [0, 0, 0];
    b0.forEach((b, i) => {
      const ci = add(b.pos, rotate(b.rot, this.mass.localCom[i]!));
      const ciP = add(bp[i]!.pos, rotate(bp[i]!.rot, this.mass.localCom[i]!)), ciM = add(bm[i]!.pos, rotate(bm[i]!.rot, this.mass.localCom[i]!));
      const vi = scale(sub(ciP, ciM), r / (2 * h));
      L = add(L, scale(cross(sub(ci, c0), vi), this.mass.mass[i]!));
      const wl = rotate(conjugate(b.rot), bodyAng[i]!);
      const I = this.mass.inertia[i]!;
      const Iw: Vec3 = [I[0]! * wl[0] + I[1]! * wl[1] + I[2]! * wl[2], I[3]! * wl[0] + I[4]! * wl[1] + I[5]! * wl[2], I[6]! * wl[0] + I[7]! * wl[1] + I[8]! * wl[2]];
      L = add(L, rotate(b.rot, Iw));
    });
    const jointVel: Partial<Record<JointName, Vec3>> = {};
    for (const k of Object.keys(s0.joints) as JointName[]) jointVel[k] = scale(rotvecDiff(sp.joints[k]!, sm.joints[k]!, 2 * h), r);
    const feet = {} as Record<FootName, FootRef>;
    for (const f of FOOT_NAMES) {
      const i = clip.footIdx[f];
      const b = b0[i]!;
      const s = soleCorners(b.pos, b.rot as [number, number, number, number], clip.footHalf);
      const gy = X.pos[1];
      const heelH = Math.min(s[0]![1], s[1]![1]) - gy, toeH = Math.min(s[2]![1], s[3]![1]) - gy;
      const ph = clip.footPhase(f, tau);
      const plantW = { pos: applyXP(X, ph.plant.pos), rot: applyXR(X, ph.plant.rot) };
      const sw = ph.stance ? 1 : Number.isFinite(ph.tLo) && Number.isFinite(ph.tTd) ? Math.max(0, Math.min(1, (tau - ph.tLo) / Math.max(1e-6, ph.tTd - ph.tLo))) : 0;
      feet[f] = {
        stance: ph.stance, heelDown: heelH < this.cfg.soleDownHeight, toeDown: toeH < this.cfg.soleDownHeight, heelH, toeH,
        pos: b.pos, rot: b.rot, vel: bodyLin[i]!, acc: scale(add(sub(bp2[i]!.pos, scale(b.pos, 2)), bm2[i]!.pos), (r * r) / (4 * h * h)), angVel: bodyAng[i]!,
        tLo: ph.tLo, tTd: ph.tTd, tEnd: ph.tEnd, s: sw, plant: plantW,
      };
    }
    return {
      clip: clip.name, tau, phase: clip.loop ? (((tau % clip.duration) + clip.duration) % clip.duration) / clip.duration : Math.min(1, tau / Math.max(1e-6, clip.duration)),
      joints: s0.joints, jointVel, bodies: b0, bodyLin, bodyAng, com: c0, comVel, comAcc, angMom: L, feet, blendDeg: 0,
      steps: clip.stepSequence(tau, 6).map((st) => ({ ...st, plant: { pos: applyXP(X, st.plant.pos), rot: applyXR(X, st.plant.rot) } })),
    };
  }

  /** 지금 기준값 (시각 t의 출력 = 관성화 적용). 같은 t·tau·앵커면 캐시 */
  ref(t: number): AnimRef | null {
    if (!this.clip) return null;
    const ak = `${this.anchor.yaw}|${this.anchor.pos.join(',')}`;
    if (this.cache && this.cache.t === t && this.cache.tau === this.tau && this.cache.anchorKey === ak) return this.cache.ref;
    const raw = this.rawRef(this.tau);
    let ref = raw;
    if (this.inert.active) {
      const joints = this.inert.apply(t, raw.joints);
      const root = this.inert.applyRoot(t, raw.bodies[0]!);
      const bodies = forwardKinematics(this.def, joints, { pos: root.pos, rot: multiplyQ(root.rot, conjugate(this.def.bodies[0]!.restRotation)) });
      ref = { ...raw, joints, bodies, blendDeg: this.inert.magnitudeDeg(t) };
    }
    // 이전 출력과의 차분으로 출력 각속도를 기억 (다음 관성화 시작점)
    const vel: Partial<Record<JointName, Vec3>> = {};
    const lt = this.last;
    for (const k of Object.keys(ref.joints) as JointName[]) vel[k] = lt && t > lt.t && lt.joints[k] ? rotvecDiff(ref.joints[k]!, lt.joints[k]!, t - lt.t) : (raw.jointVel[k] ?? [0, 0, 0]);
    const root = ref.bodies[0]!;
    const rootVel = lt && t > lt.t ? { lin: scale(sub(root.pos, lt.root.pos), 1 / (t - lt.t)), ang: rotvecDiff(root.rot, lt.root.rot, t - lt.t) } : { lin: raw.bodyLin[0]!, ang: raw.bodyAng[0]! };
    this.last = { t, joints: ref.joints, vel, root, rootVel };
    this.cache = { t, tau: this.tau, anchorKey: ak, ref };
    return ref;
  }

  /** 키네마틱 재생용: tau의 바디 월드 자세 (관성화 적용, 시각 t 기준) */
  bodiesAt(t: number, tau: number): BodyTransform[] {
    const p = this.clip!.poseAt(tau);
    const joints = this.inert.apply(t, p.joints);
    const root0 = { pos: applyXP(this.anchor, p.root.pos), rot: applyXR(this.anchor, p.root.rot) };
    const root = this.inert.applyRoot(t, root0);
    return forwardKinematics(this.def, joints, root);
  }

  /** 클립 시각 tau의 클립 공간 발 위치 (앵커 정하기용) */
  clipFeet(tau: number): Record<FootName, BodyTransform> {
    const b = this.fkAt(tau).bodies;
    return { LeftFoot: b[this.clip!.footIdx.LeftFoot]!, RightFoot: b[this.clip!.footIdx.RightFoot]! };
  }

  /**
   * 위상 맞추기 (SPEC 11.3 '위상 정렬', v0.6 '가장 가까운 클립 위상으로 복귀'): 클립 프레임마다
   * 비용 = contact·(접촉 불일치 수) + feet·|두 발 상대 위치 차|² (걷는 방향 기준) + joints·Σ다리 관절 각 차² + vel·(앞 속도 차)²
   * 가장 작은 프레임 시각을 돌려준다.
   */
  matchPhase(name: string, q: PhaseQuery): { tau: number; cost: number } {
    const clip = this.getClip(name);
    const w = this.cfg.phaseMatch;
    const qInv = yawQ(-q.yaw);
    const rel = rotate(qInv, sub(q.footPos.LeftFoot, q.footPos.RightFoot));
    const vF = rotate(qInv, q.comVel)[2];
    let best = 0, bc = Infinity;
    const N = clip.loop ? clip.n : clip.n;
    for (let i = 0; i < N; i++) {
      const tau = i / clip.fps;
      const fk = clip.fk[i]!;
      const c = clip.frames[i]!.contact;
      let cost = w.contact * ((c[0] !== q.contact.LeftFoot ? 1 : 0) + (c[1] !== q.contact.RightFoot ? 1 : 0));
      // 클립 공간은 걷는 방향(정면) +Z 기준
      const cr = sub(fk[clip.footIdx.LeftFoot]!.pos, fk[clip.footIdx.RightFoot]!.pos);
      const d0 = rel[0] - cr[0], d2 = rel[2] - cr[2];
      cost += w.feet * (d0 * d0 + d2 * d2);
      for (const jn of LEG_JOINTS) {
        const a = clip.frames[i]!.joints[jn], b = q.joints[jn];
        if (a && b) { const ang = length(toRotationVector(multiplyQ(a, conjugate(b)))); cost += w.joints * ang * ang; }
      }
      // 앞 속도: 클립 COM 속도 (앞뒤 한 프레임 중앙 차분, 바퀴 누적 포함)
      const h = 1 / clip.fps;
      const pp = clip.poseAt(tau + h), pm = clip.poseAt(Math.max(clip.loop ? tau - h : 0, tau - h));
      const vc = (this.comOf(forwardKinematics(this.def, pp.joints, pp.root))[2] - this.comOf(forwardKinematics(this.def, pm.joints, pm.root))[2]) / (2 * h);
      cost += w.vel * (vF - vc) * (vF - vc);
      if (cost < bc - 1e-12) { bc = cost; best = tau; }
    }
    return { tau: best, cost: bc };
  }
}

/** Ragdoll 바디에서 질량 모델을 만든다 (Rapier 질량·로컬 질량 중심·주관성 × 주축 프레임) */
export function massModelOf(bodies: readonly { rb: { mass(): number; localCom(): { x: number; y: number; z: number }; principalInertia(): { x: number; y: number; z: number }; principalInertiaLocalFrame(): { x: number; y: number; z: number; w: number } } }[]): MassModel {
  const mass: number[] = [], localCom: Vec3[] = [], inertia: number[][] = [];
  for (const b of bodies) {
    mass.push(b.rb.mass());
    const lc = b.rb.localCom();
    localCom.push([lc.x, lc.y, lc.z]);
    const I = b.rb.principalInertia(), f = b.rb.principalInertiaLocalFrame();
    const q: Quat = [f.x, f.y, f.z, f.w];
    // R diag(I) Rᵀ
    const cols = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
    const d = [I.x, I.y, I.z];
    const M = new Array<number>(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) M[r * 3 + c]! += cols[k]![r]! * d[k]! * cols[k]![c]!;
    inertia.push(M);
  }
  return { mass, localCom, inertia };
}

export { identityQ };
