// 넘어짐 (SPEC v0.5b 행동 목록): 넘어짐 확실도(FallMonitor) → BraceForFall(손 착지 예측·두 팔 뻗기·무릎 굽힘),
// ProtectHead(뒤·옆: 턱 당기기·팔로 머리 감싸기), CatchFall(손이 닿으면 팔꿈치를 굽혀 흡수하고 팔 힘을 서서히 뺌).
// 정의: docs/ALGORITHMS.md v0.5b. 값: config/behaviors.json fall·BraceForFall·ProtectHead·CatchFall.
import type { JointName } from '../pose';
import type { Ragdoll } from '../ragdoll';
import type { Perception, FootName } from '../perception';
import { FOOT_NAMES, isFootBody } from '../perception';
import { type Vec3, add, sub, scale, dot, length, normalize } from '../../math/vec3';
import { type Quat, angleBetweenQ, normalizeQ, rotate, slerp } from '../../math/quat';
import type { CharacterDef } from '../characterDef';
import { convexHull, signedDistanceToPolygon, type Vec2 } from '../../math/geometry';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type HandName, type JointOut, HANDS } from './types';
import { armChain, bodyDef, bodyPose, clampJoint, degQ, handRotation, solveArm } from './kinematics';

const DEG = 180 / Math.PI;
export type FallKind = 'forward' | 'backward' | 'left' | 'right';
export const FALL_KIND_KO: Record<FallKind, string> = { forward: '앞', backward: '뒤', left: '왼쪽', right: '오른쪽' };

export interface FallConfig {
  /** DCM이 두 발 기준 바닥(발 박스 바닥 꼭짓점 볼록 껍질) 밖으로 나간 거리(m): dcmStart에서 0, dcmFull에서 1 */
  dcmStart: number; dcmFull: number;
  /** (2026-10-27) 스윙 중이면 그 발 바닥을 착지 목표 자리로 옮겨 바닥을 잡는다 (곧 디딜 발; 걸음을 내딛는 중에 넘어짐 대비로 균형을 꺼 버리지 않게 — 시도 뒤 꺼 둠, README 결정 166) */
  useSwingTarget?: boolean;
  /** 몸통(Spine2) 기울기(도, 행동의 의도 숙임 tiltAllow를 뺀 값): tiltStart에서 0, tiltFull에서 1 */
  tiltStart: number; tiltFull: number;
  /** 기울기 항 문: DCM 바닥 밖 거리 tiltGate[0] → [1] m에서 0 → 1 */
  tiltGate: [number, number];
  /** COM 하강(m, 처음 서 있던 높이 기준)과 하강 속도(m/s): drop ≥ dropStart이고 하강 속도 ≥ dropVel일 때 dropStart → dropFull */
  dropStart: number; dropFull: number; dropVel: number;
  /** 확실도 저역 통과: 오를 때 attack초, 내릴 때 release초 */
  attack: number; release: number;
  /** 이 확실도를 넘으면 BraceForFall */
  threshold: number;
  /** 넘어지는 방향 분류: 골반 앞 방향과 이 각(도) 안이면 앞, 180 − 이 각 밖이면 뒤, 나머지는 옆 */
  kindDeg: number;
  /** 손이 닿는 시점: 어깨 높이가 이 값(m, 팔 길이 × 약 0.9)이 될 때. 손 착지점은 그때 어깨 투영 + 넘어지는 방향 handForward */
  handReach: number; handForward: number;
  /** 예측 상한 (초) */
  maxPredict: number;
  /**
   * (v0.8a) 내리막 지형(넘어지는 방향 descendProbe m 앞 지면이 발 지면보다 descendMin m 넘게 낮음)에서 스텝 계층이 내딛는 중이면
   * DCM 항 문턱을 descendDcmRelax m 늦춘다 — 계단을 뛰어 내려가며 받는 비틀거림을 넘어짐으로 보지 않게 (평지 값 그대로면 첫 걸음 직후 대비가 균형을 껐다)
   */
  descendProbe?: number; descendMin?: number; descendDcmRelax?: number;
}

/** 넘어짐 신호 (로그 behavior.fall) */
export interface FallSignal {
  /** 확실도 0~1 (저역 통과) */
  certainty: number;
  raw: number;
  terms: { dcm: number; tilt: number; drop: number };
  /** DCM의 두 발 바닥 밖 거리 (m, 안이면 음수) */
  dcmOut: number;
  tiltDeg: number;
  comHeight: number;
  /** 넘어지는 방향 (수평 단위) */
  dir: Vec3;
  kind: FallKind;
  /** 손이 닿을 때까지 예측 시간 (초) */
  timeToImpact: number;
  /** 넘어질 때 도는 축 점 (두 발 바닥 중 넘어지는 방향 끝) */
  pivot: Vec3;
  /** 예측 손 착지점 (월드) */
  hands: Record<HandName, Vec3>;
}

/**
 * 넘어짐 확실도: 균형·스텝으로 못 막는 넘어짐을 세 신호의 최대로 본다 —
 * ① DCM(포착점)이 두 발 바닥에서 한 걸음으로도 못 닿을 만큼 밖, ② 몸통이 의도하지 않게 크게 기욺, ③ COM이 빠르게 내려앉는 중.
 * 방향 = 바닥 중심 → DCM. 시간 = 넘어지는 쪽 바닥 끝(pivot) 둘레 역진자 θ̈ = (g/L)sinθ를 어깨 높이가 handReach가 될 때까지 적분.
 */
export class FallMonitor {
  standH: number | null = null;
  private c = 0;
  signal: FallSignal | null = null;
  constructor(public cfg: FallConfig, readonly g: number) {}

  /** (v0.7) 일어서서 균형으로 넘길 때: 누운 동안 쌓인 확실도와 서 있던 높이를 지운다 (일어서는 동작은 넘어짐이 아니다) */
  reset(): void { this.c = 0; this.standH = null; }

  update(rd: Ragdoll, per: Perception, dt: number, tiltAllowDeg: number, kneeling = false, stepping = false, swing: { foot: FootName; target: readonly number[] } | null = null): FallSignal {
    const cfg = this.cfg;
    const { com, vel } = rd.com();
    // 두 발 기준 바닥 (접촉과 무관: 스윙 중인 발도 곧 디딘다)
    const pts: Vec2[] = [];
    let gh = 0, nG = 0;
    for (const f of FOOT_NAMES) {
      // 스윙 발: 착지 목표 자리 (설정 시)
      const sw = cfg.useSwingTarget && swing?.foot === f ? (() => { const p = rd.body(f).rb.translation(); return [swing.target[0]! - p.x, swing.target[2]! - p.z] as const; })() : null;
      for (const c of per.feet[f].sole) pts.push(sw ? [c[0] + sw[0], c[2] + sw[1]] : [c[0], c[2]]);
      const g = per.feet[f].ground;
      if (g) { gh += g.point[1]; nG++; }
    }
    gh = per.groundHeight ?? (nG ? gh / nG : 0);
    const base = convexHull(pts);
    const h = Math.max(0.05, com[1] - gh);
    // 서 있던 높이: 두 발이 닿아 있을 때 처음 잰다 (v0.5c: 공중에서 시작하면 낙하 높이를 '주저앉음'으로 세지 않게)
    if (this.standH === null && per.feet.LeftFoot.contact && per.feet.RightFoot.contact) this.standH = h;
    const standH = this.standH ?? h;
    const om = Math.sqrt(this.g / h);
    const xi: Vec2 = [com[0] + vel[0] / om, com[2] + vel[2] / om];
    const dcmOut = signedDistanceToPolygon(xi, base);
    const s2 = bodyPose(rd, 'Spine2'), hips = bodyPose(rd, 'Hips');
    const tilt = Math.acos(Math.max(-1, Math.min(1, rotate(s2.rot, [0, 1, 0])[1]))) * DEG;
    const lin = (x: number, a: number, b: number) => smoothstep((x - a) / Math.max(1e-6, b - a));
    // (v0.8a) 내리막에서 내딛는 중이면 DCM 문턱을 늦춘다 (평지는 그대로)
    let relax = 0;
    if (stepping && !rd.pw.flat && cfg.descendDcmRelax) {
      const vh = Math.hypot(vel[0], vel[2]);
      if (vh > 1e-3) {
        const ahead = rd.pw.groundHeightAt(com[0] + (vel[0] / vh) * cfg.descendProbe!, com[2] + (vel[2] / vh) * cfg.descendProbe!);
        if (gh - ahead > cfg.descendMin!) relax = cfg.descendDcmRelax;
      }
    }
    const tDcm = lin(dcmOut, cfg.dcmStart + relax, cfg.dcmFull + relax);
    // 기울기는 DCM이 바닥 가장자리 근처(tiltGate) 밖일 때만 센다 — 발 위에서 몸통만 크게 휘청이는 것(정착 중 흔들림)은 넘어짐이 아니다
    const tTilt = lin(tilt - tiltAllowDeg, cfg.tiltStart, cfg.tiltFull) * lin(dcmOut, cfg.tiltGate[0], cfg.tiltGate[1]);
    const drop = standH - h;
    const tDrop = -vel[1] >= cfg.dropVel ? lin(drop, cfg.dropStart, cfg.dropFull) : 0;
    // 일부러 무릎을 꿇는 동안은 몸통 기울기만 센다 (몸을 낮추고 COM이 발 앞 무릎 위로 가는 것은 넘어짐이 아니다; 꿇은 채 쓰러지면 몸통이 기운다)
    const raw = kneeling ? tTilt : Math.max(tDcm, tTilt, tDrop);
    const tau = raw > this.c ? cfg.attack : cfg.release;
    this.c += (raw - this.c) * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
    // 방향: 바닥 중심 → DCM (거의 같으면 COM 수평 속도, 그것도 없으면 골반 앞)
    const cen = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length] as Vec2, [0, 0] as Vec2);
    let d: Vec3 = [xi[0] - cen[0], 0, xi[1] - cen[1]];
    if (length(d) < 0.03) d = [vel[0], 0, vel[2]];
    const fwd = rotate(hips.rot, [0, 0, 1]);
    if (length(d) < 1e-3) d = [fwd[0], 0, fwd[2]];
    const dir = normalize(d);
    const fh = normalize([fwd[0], 0, fwd[2]]);
    const lh: Vec3 = [fh[2], 0, -fh[0]]; // 골반 왼쪽 (+X 로컬)
    const ca = Math.cos((cfg.kindDeg * Math.PI) / 180);
    const kf = dot(dir, fh);
    const kind: FallKind = kf >= ca ? 'forward' : kf <= -ca ? 'backward' : dot(dir, lh) > 0 ? 'left' : 'right';
    // 축 점: 바닥 꼭짓점 중 넘어지는 방향으로 가장 먼 것의 방향 성분 (옆 성분은 COM 쪽)
    let far = -Infinity;
    for (const p of base) far = Math.max(far, p[0] * dir[0] + p[1] * dir[2]);
    const comAlong = com[0] * dir[0] + com[2] * dir[2];
    const pivot: Vec3 = [com[0] + dir[0] * (far - comAlong), gh, com[2] + dir[2] * (far - comAlong)];
    // 역진자 (넘어지는 방향 평면): θ = 축 점에서 COM까지 선이 수직과 이루는 각
    const dC = comAlong - far, L = Math.hypot(dC, h);
    let th = Math.atan2(dC, h);
    let thd = ((vel[0] * dir[0] + vel[2] * dir[2]) * h - vel[1] * dC) / (L * L);
    const sh = HANDS.map((hn) => { const ch = armChain(rd.def, hn); return add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2)); });
    const shM = scale(add(sh[0]!, sh[1]!), 0.5);
    const dS = shM[0] * dir[0] + shM[2] * dir[2] - far, hS = shM[1] - gh;
    const Ls = Math.hypot(dS, hS), phi = Math.atan2(dS, hS) - th;
    const step = 1 / 120;
    let T = 0;
    while (T < cfg.maxPredict && Ls * Math.cos(th + phi) > cfg.handReach) {
      thd += (this.g / L) * Math.sin(th) * step;
      th += thd * step;
      T += step;
      if (th + phi > Math.PI / 2) break;
    }
    const reachOut = Ls * Math.sin(Math.min(Math.PI / 2, th + phi)) + cfg.handForward;
    const hands = {} as Record<HandName, Vec3>;
    HANDS.forEach((hn, i) => {
      const s = sh[i]!;
      const latOff = sub([s[0], 0, s[2]], scale(dir, s[0] * dir[0] + s[2] * dir[2]));
      const p = add(latOff, scale(dir, far + reachOut));
      hands[hn] = [p[0], gh, p[2]];
    });
    this.signal = { certainty: this.c, raw, terms: { dcm: tDcm, tilt: tTilt, drop: tDrop }, dcmOut, tiltDeg: tilt, comHeight: h, dir, kind, timeToImpact: T, pivot, hands };
    return this.signal;
  }
}

/**
 * IK 관절 목표 변화 속도 제한: 이전 목표에서 최대 maxRate rad/s만큼만 따라간다.
 * 넘어지며 몸이 크게 돌 때 2관절 IK 해가 팔꿈치 평면·어깨 비틀기를 뒤집으면(±180°) 팔이 한 스텝에 휙 돌아 폭발 판정이 났다
 */
export function rateLimited(prev: Map<JointName, Quat>, jn: JointName, q0: Quat, maxRate: number, dt: number, def?: CharacterDef, clampMid = false): Quat {
  const p = prev.get(jn);
  // 관절 제한 안으로 먼저 자른다 (제한 밖 목표 — 예: 손목 비틀기 ±123° — 는 좌표 표현이 ±180°에서 뒤집혀 손이 한 스텝에 튀었다)
  const q = def ? clampTarget(def, jn, q0) : q0;
  let out = q;
  if (p) {
    const ang = angleBetweenQ(p, q);
    const mx = maxRate * dt;
    // (relax-7) 사이 값도 제한 안으로: 비틀기가 ±180° 근처에서 뒤집힌 목표로 가는 짧은 길이 제한 밖을 지나면 모터 좌표가 반대편으로 튀어 손이 휙 돌았다(getup_interrupted). 넘어짐 대비·머리 보호만 켬(clampMid) — 잡기에 켜면 팔 힘을 뺀 손이 난간대를 놓지 않았다(api.test rail_grab)
    if (ang > mx) out = def && clampMid ? clampTarget(def, jn, slerp(p, q, mx / ang)) : slerp(p, q, mx / ang);
  }
  prev.set(jn, out);
  return out;
}

/** 관절 목표를 제한 안으로: 축별 제한 관절은 clampJoint, 어깨(스윙 콘)는 비틀기 성분만 */
export function clampTarget(def: CharacterDef, jn: JointName, r: Readonly<Quat>): Quat {
  const lim = bodyDef(def, jn).joint!.limitsDeg;
  if (lim.swingCone === undefined) return clampJoint(def, jn, r);
  const q = r[3] < 0 ? [-r[0], -r[1], -r[2]] : [r[0], r[1], r[2]];
  const tw = lim.twist;
  if (!tw) return [...r] as Quat;
  const x = 2 * Math.asin(Math.max(-1, Math.min(1, q[1]!)));
  const RAD = Math.PI / 180;
  const c = Math.max((tw[0] + 2) * RAD, Math.min((tw[1] - 2) * RAD, x));
  const s1 = Math.sin(c / 2);
  const w = Math.sqrt(Math.max(0, 1 - q[0]! * q[0]! - s1 * s1 - q[2]! * q[2]!));
  return normalizeQ([q[0]!, s1, q[2]!, w]);
}

const LEGS = { hip: ['LeftUpLeg', 'RightUpLeg'], knee: ['LeftLeg', 'RightLeg'], ankle: ['LeftFoot', 'RightFoot'] } as const;
const ARM_JOINTS: Record<HandName, JointName[]> = { LeftHand: ['LeftArm', 'LeftForeArm', 'LeftHand'], RightHand: ['RightArm', 'RightForeArm', 'RightHand'] };
const NON_FOOT_GROUND = (ctx: BehaviorContext) => [...ctx.per.ground].some((b) => !isFootBody(b));

interface KindPose { kneeFlex: number; hipFlex: number; spineFlex: number; headFlex: number; ankleFlex: number; /** 이 방향의 다리 강도 (없으면 legStrength) */ legStrength?: number }
export interface BraceParams {
  /** 넘어지는 방향별 자세 (도): 무릎·고관절 굽힘(낙하 높이 줄이기), 척추·머리 굽힘 */
  poses: Record<FallKind, KindPose>;
  /** 강도 배율: 다리(무릎이 꺾이도록 낮춤), 팔, 몸통 */
  legStrength: number; armStrength: number; trunkStrength: number;
  /** 어깨 → 손바닥 목표 거리 = 팔 길이 × reach (팔꿈치를 살짝 굽힌 채 뻗음) */
  reach: number;
  /** 팔꿈치 방향 힌트 (Spine2 로컬, x는 팔 쪽 +) */
  elbowPole: Vec3;
  /** IK 관절 목표 변화 최대 속도 (rad/s) */
  maxTargetRate: number;
  /** 팔 뻗는 방향의 최대 각속도 (rad/s) */
  aimSpeed: number;
  /** 손 착지점 갱신 시정수 (초) */
  landTau: number;
  /** 쥐고 있는 손(HoldWound)은 뻗지 않는다 */
  keepClutch: boolean;
  /** 착지 뒤: COM 속도 < restSpeed가 restHold초면 '누움' — 지금 자세를 목표로 restStrength까지 restTime초에 힘을 뺀다 */
  restSpeed: number; restHold: number; restStrength: number; restTime: number; restDelay: number;
  /** 착지 뒤 다리 대비 자세를 풀고 힘을 restStrength로 내리는 시간 (초) */
  legRelax: number;
  palmLocal: Vec3;
  /**
   * (relax-4) 뒤로 넘어질 때 두 팔을 뒤·옆으로 벌려 바닥을 짚는다(없으면 예전처럼 팔 없음 — ProtectHead가 머리를 감쌈).
   * 뻗는 방향 = 넘어지는 방향에서 그 팔 쪽으로 spreadDeg, 아래로 downDeg. 예측 착지까지 lead초 남았을 때부터(ProtectHead가 팔을 놓는 때와 같음)
   */
  backward?: { spreadDeg: number; downDeg: number; lead: number; minTime?: number; armStrength?: number; handWeight?: number };
  /** (relax-5) 두 발이 다 떨어지면(공중) 다리 대비 자세 가중치·강도를 이 값으로 tau초에 — 다리를 굽힌 채 허공에 굳게 들지 않게 */
  air?: { legWeight: number; legStrength: number; tau: number };
  /** (relax-3) 이 바디가 닿으면 몸통 착지 = 대비 끝 (블렌더가 Lie로 넘김) */
  landBodies?: string[];
}

/**
 * 넘어짐 대비: 손 착지점(FallMonitor 예측, 저역 통과)을 향해 두 팔을 IK로 뻗고(손바닥은 아래, 손가락은 넘어지는 방향),
 * 무릎·고관절을 굽혀 낙하 높이를 줄인다. 균형·스텝은 끈다(넘어짐이 확실하므로). 뒤로 넘어지면 팔은 ProtectHead가, 옆이면 넘어지는 쪽 팔만 뻗는다.
 */
export class BraceForFall extends Behavior {
  readonly name = 'BraceForFall';
  private readonly p: BraceParams;
  kind: FallKind | null = null;
  dir: Vec3 = [0, 0, 1];
  land: Partial<Record<HandName, Vec3>> = {};
  private aim: Partial<Record<HandName, Vec3>> = {};
  private readonly prevT = new Map<JointName, Quat>();
  arms: HandName[] = [];
  landedT: number | null = null;
  private stillSince: number | null = null;
  restT: number | null = null;
  /** (relax-3) 몸통 착지 시각 (landBodies 중 하나가 처음 닿음) */
  trunkT: number | null = null;
  /** (relax-5) 공중 다리 풀림 정도 0~1 (저역 통과) */
  private airK = 0;
  /** (relax-4) 뒤로 넘어질 때 팔을 뻗기 시작한 시각 */
  private armT: number | null = null;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as BraceParams;
  }

  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    const f = ctx.fall;
    if (!this.kind && f) {
      this.kind = f.kind;
      this.dir = f.dir;
      // 앞이면 두 손, 옆이면 넘어지는 쪽 손. 뒤: backward 설정이 있으면 두 손을 뒤·옆으로(바닥 짚기), 없으면 팔 없음(ProtectHead가 머리를 감싼다)
      this.arms = this.kind === 'forward' ? [...HANDS] : this.kind === 'left' ? ['LeftHand'] : this.kind === 'right' ? ['RightHand'] : p.backward ? [...HANDS] : [];
      if (p.keepClutch) this.arms = this.arms.filter((h) => !ctx.busyHands.has(h));
    }
    if (this.trunkT === null && p.landBodies && t >= this.startT && p.landBodies.some((b) => ctx.per.ground.has(b as never))) this.trunkT = t;
    const kind = this.kind ?? 'forward';
    const ks = p.poses[kind];
    // 손 착지점 따라가기 (넘어지는 동안 예측이 바뀌면 천천히)
    if (f && this.landedT === null) {
      const k = 1 - Math.exp(-ctx.dt / Math.max(1e-3, p.landTau));
      for (const h of HANDS) { const c = this.land[h]; this.land[h] = c ? add(c, scale(sub(f.hands[h], c), k)) : f.hands[h]; }
    }
    if (this.landedT === null && t >= this.startT && NON_FOOT_GROUND(ctx)) this.landedT = t;
    // 누움: 착지 뒤 restDelay초가 지나거나 몸이 멈추면, 대비 자세를 풀고(기본 자세 목표) 힘을 restStrength까지 뺀다 — 다리를 든 채 굳어 있지 않게
    if (this.landedT !== null && this.restT === null) {
      const sp = length(ctx.rd.com().vel);
      if (sp < p.restSpeed) { this.stillSince ??= t; if (t - this.stillSince >= p.restHold) this.restT = t; } else this.stillSince = null;
      // (relax-3) 손으로 짚고 버티는 중이면(손 접촉) 시간으로 넘기지 않는다 — 몸통이 닿거나 멈출 때까지 짚은 팔을 유지 (시간으로 넘기면 짚은 팔이 풀려 얼굴이 떨어졌다)
      const handsDown = !!p.landBodies && (ctx.per.ground.has('LeftHand') || ctx.per.ground.has('RightHand'));
      if (t - this.landedT >= p.restDelay && !handsDown) this.restT = t;
    }
    const joints: Partial<Record<JointName, JointOut>> = {};
    // (relax-3) 몸통으로 착지했거나 누움 조건이 되면 대비를 끝낸다: 블렌더가 이 행동을 끄고 Lie(착지 자세 → 누운 자세, 강도는 지금 값에서 내림)로 넘긴다.
    // 끝나며 빠지는 동안 목표·강도를 내지 않는다 — 예전에는 서기 포즈 목표(기본 자세)를 강도 1부터 붙들어 팔을 몸통 옆에 붙인 판자처럼 누워 굳었다
    if (this.restT !== null || this.trunkT !== null) {
      this.phase = '착지 (대비 끝)';
      return { joints, balanceMode: 'off', stepAllowed: false };
    }
    // 착지하면 다리는 바로 풀어 준다(legRelax초) — 굽힌 다리를 붙든 채 뒤로 구르면 다리가 허공으로 솟았다
    const lr = this.landedT === null ? 0 : smoothstep((t - this.landedT) / p.legRelax);
    // (relax-5) 두 발이 다 떨어지면(공중) 다리 대비 자세를 풀어 준다 — 주저앉는 자세(고관절·무릎 굽힘)는 발로 바닥을 딛고 있을 때 COM을 낮추는 것이다.
    // 발이 뜬 뒤에도 같은 강도로 붙들면 굽힌 다리를 허공에 든 채 굳었다
    if (p.air) {
      const feet = ctx.per.feet.LeftFoot.contact || ctx.per.feet.RightFoot.contact;
      this.airK += ((feet ? 0 : 1) - this.airK) * (1 - Math.exp(-ctx.dt / Math.max(1e-3, p.air.tau)));
    }
    const ls0 = ks.legStrength ?? p.legStrength;
    const aw = p.air ? 1 + (p.air.legWeight - 1) * this.airK : 1, lsA = p.air ? ls0 + (p.air.legStrength - ls0) * this.airK : ls0;
    const lw = aw * (1 - lr), ls = lsA + (p.restStrength - lsA) * lr;
    for (const j of LEGS.knee) joints[j] = { add: degQ(ks.kneeFlex, 0, 0), weight: lw, strength: ls };
    for (const j of LEGS.hip) joints[j] = { add: degQ(ks.hipFlex, 0, 0), weight: lw, strength: ls };
    for (const j of LEGS.ankle) joints[j] = { add: degQ(ks.ankleFlex, 0, 0), weight: lw, strength: ls };
    joints.Spine = { add: degQ(ks.spineFlex * 0.5, 0, 0), weight: 1, strength: p.trunkStrength };
    joints.Spine2 = { add: degQ(ks.spineFlex * 0.5, 0, 0), weight: 1, strength: p.trunkStrength };
    joints.Head = { add: degQ(ks.headFlex, 0, 0), weight: 1, strength: p.trunkStrength };
    // 팔: 어깨 → 착지점 방향으로 팔 길이 × reach
    const s2 = bodyPose(ctx.rd, 'Spine2');
    // 착지한 뒤에는 팔 IK를 더 풀지 않고 마지막 목표를 유지한다(CatchFall이 팔꿈치를 굽힌다) — 누운 채 착지점을 계속 겨누면 IK 해가 뒤집혀 손목이 튀었다
    if (this.landedT !== null) {
      for (const h of this.arms) for (const jn of ARM_JOINTS[h]) { const q = this.prevT.get(jn); if (q) joints[jn] = { target: q, ...this.armOut(kind, jn) }; }
    } else for (const h of this.arms) {
      const ch = armChain(ctx.def, h);
      const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
      const lp = this.land[h] ?? add(S, this.dir);
      // (relax-4) 뒤로 넘어짐: 예측 착지 lead초 전부터(그 전에는 ProtectHead가 손을 머리 쪽으로 반쯤 올린다) 넘어지는 방향에서 그 팔 쪽으로 벌리고 아래로 —
      // 사람은 뒤로 넘어질 때 팔을 뒤·옆으로 뻗어 바닥을 짚는다(손목 골절이 많은 이유, FOOSH)
      let want: Vec3;
      if (kind === 'backward' && p.backward) {
        const B = p.backward;
        if (this.armT === null && ((t >= this.startT + (B.minTime ?? 0) && (!f || f.timeToImpact <= B.lead)) || NON_FOOT_GROUND(ctx))) this.armT = t;
        if (this.armT === null) continue;
        const sd = rotate(s2.rot, [ch.side, 0, 0]);
        const lat = normalize(sub([sd[0], 0, sd[2]], scale(this.dir, sd[0] * this.dir[0] + sd[2] * this.dir[2])));
        const sp = (B.spreadDeg * Math.PI) / 180, dn = (B.downDeg * Math.PI) / 180;
        const hz = normalize(add(scale(this.dir, Math.cos(sp)), scale(lat, Math.sin(sp))));
        want = normalize(add(scale(hz, Math.cos(dn)), [0, -Math.sin(dn), 0]));
      } else want = normalize(sub(lp, S));
      // 뻗는 방향은 각속도 aimSpeed rad/s 이하로 따라간다 (몸이 돌며 착지점이 어깨 아래로 지나갈 때 팔이 휙 뒤집히지 않게)
      const prev = this.aim[h];
      let aim = want;
      if (prev) {
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(prev, want))));
        const mx = p.aimSpeed * ctx.dt;
        if (ang > mx) { const k = mx / ang; aim = normalize(add(scale(prev, 1 - k), scale(want, k))); }
      }
      this.aim[h] = aim;
      // 손바닥은 아래(바닥)로, 손가락은 넘어지는 방향 — 손목을 젖혀 짚는 자세
      const q = handRotation(ch, [0, -1, 0], add(this.dir, [0, 0.3, 0]));
      // 손목 점을 어깨에서 (상완 + 전완) × reach에 둔다 — 팔꿈치 굽힘이 일정해 IK가 완전히 편 특이 자세(팔꿈치 평면 뒤집힘)로 가지 않는다
      const W = add(S, scale(aim, (ch.l1 + ch.l2) * p.reach));
      const palm = add(W, rotate(q, sub(p.palmLocal, ch.wristInHand)));
      const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
      const sol = solveArm(ctx.def, ch, s2.rot, s2.pos, palm, q, p.palmLocal, pole);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, ctx.def, true), ...this.armOut(kind, jn as JointName) };
    }
    this.phase = this.landedT === null ? `${FALL_KIND_KO[kind]}으로 넘어짐 대비` : '착지';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }

  override info(): Record<string, unknown> {
    return { kind: this.kind, arms: this.arms, land: this.land, landedT: this.landedT, restT: this.restT, trunkT: this.trunkT, armT: this.armT, airLeg: this.airK };
  }

  /**
   * 팔 관절 가중치·강도. (relax-4) 뒤로 짚는 팔은 강도 backward.armStrength, 손목은 가중치 backward.handWeight — 몸이 비틀린 채 뒤로 넘어질 때
   * 손바닥을 바닥으로 돌리는 손목 목표를 강하게 따르면 손이 45 rad/s로 휙 돌아 폭발 판정이 났다(getup_random_x20 시드 1002·1016)
   */
  private armOut(kind: FallKind, jn: JointName): { weight: number; strength: number } {
    const B = this.p.backward;
    if (kind !== 'backward' || !B) return { weight: 1, strength: this.p.armStrength };
    return { weight: /Hand$/.test(jn) ? (B.handWeight ?? 1) : 1, strength: B.armStrength ?? this.p.armStrength };
  }

  /** (relax-3) 대비가 끝났는가 (몸통 착지 또는 누움 조건) — 블렌더가 끄고 Lie로 넘긴다 */
  get ended(): boolean { return this.restT !== null || this.trunkT !== null; }

  /** 누움 단계인가 (블렌더가 ProtectHead·CatchFall을 끈다) */
  get resting(): boolean {
    return this.restT !== null;
  }
}

export interface ProtectHeadParams {
  chinTuckDeg: number; headSideDeg: number; spineFlexDeg: number;
  /** 감싸는 손바닥 점 (Head 바디 로컬, x는 그 손 쪽 +) */
  guardLocal: Vec3;
  elbowPole: Vec3;
  armStrength: number;
  palmLocal: Vec3;
  maxTargetRate: number;
  /**
   * (relax-2) 반쯤 감싸기: 팔 목표 가중치(1 = 손바닥을 머리에 붙임). 놓기: 몸통 착지(landBodies) 또는 뒤로 넘어질 때 예측 착지 releaseLead초 전
   * (그때부터 BraceForFall이 팔을 뒤·옆으로 뻗는다)부터 releaseTime초에 팔을 놓는다. 턱 당기기는 착지 뒤 chinHold초 유지하고 chinRelease초에 풀며 끝
   */
  guardWeight?: number; releaseLead?: number; minGuard?: number; releaseTime?: number; chinHold?: number; chinRelease?: number; landBodies?: string[];
}

/** 머리 보호: 턱을 당기고(목 굽힘), 옆으로 넘어지면 머리를 위쪽으로 기울이고, 손(hands)을 머리 옆·앞으로 가져가 감싼다 */
export class ProtectHead extends Behavior {
  readonly name = 'ProtectHead';
  private readonly p: ProtectHeadParams;
  readonly hands: HandName[];
  readonly kind: FallKind;
  private readonly prevT = new Map<JointName, Quat>();
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as ProtectHeadParams;
    this.hands = (params.hands as HandName[] | undefined) ?? [...HANDS];
    this.kind = (params.kind as FallKind | undefined) ?? 'backward';
  }
  /** (relax-2) 몸통 착지 시각, 팔을 놓기 시작한 시각 */
  landT: number | null = null;
  releaseT: number | null = null;
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    const joints: Partial<Record<JointName, JointOut>> = {};
    if (this.landT === null && t >= this.startT && p.landBodies?.some((b) => ctx.per.ground.has(b as never))) this.landT = t;
    if (this.releaseT === null && t >= this.startT && (this.landT !== null || (this.kind === 'backward' && p.releaseLead !== undefined && t >= this.startT + (p.minGuard ?? 0) && ctx.fall && ctx.fall.timeToImpact <= p.releaseLead))) this.releaseT = t;
    const armW = (p.guardWeight ?? 1) * (this.releaseT === null ? 1 : 1 - smoothstep((t - this.releaseT) / (p.releaseTime ?? 0.15)));
    const chinW = this.landT === null ? 1 : 1 - smoothstep((t - this.landT - (p.chinHold ?? 0)) / (p.chinRelease ?? 0.3));
    if (this.landT !== null && chinW <= 0 && this.stopT === null) this.stop(t);
    // 옆으로 넘어지면 머리를 위쪽(넘어지는 반대)으로: side+ = 오른쪽(−X)으로 굽힘 → 왼쪽으로 넘어지면 +
    const side = this.kind === 'left' ? p.headSideDeg : this.kind === 'right' ? -p.headSideDeg : 0;
    joints.Head = { add: degQ(p.chinTuckDeg, 0, side), weight: chinW };
    joints.Spine = { add: degQ(p.spineFlexDeg * 0.5, 0, 0), weight: chinW };
    joints.Spine2 = { add: degQ(p.spineFlexDeg * 0.5, 0, 0), weight: chinW };
    this.phase = this.landT !== null ? '턱 당기기 (착지)' : this.hands.length ? (this.releaseT !== null ? '팔 놓기' : '머리 반쯤 감싸기') : '턱 당기기';
    if (armW <= 1e-4) return { joints };
    const s2 = bodyPose(ctx.rd, 'Spine2'), head = bodyPose(ctx.rd, 'Head');
    for (const h of this.hands) {
      const ch = armChain(ctx.def, h);
      const palm = add(head.pos, rotate(head.rot, [p.guardLocal[0] * ch.side, p.guardLocal[1], p.guardLocal[2]]));
      const inward = normalize(sub(head.pos, palm));
      const q = handRotation(ch, inward, rotate(head.rot, [0, 1, 0]));
      const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
      const sol = solveArm(ctx.def, ch, s2.rot, s2.pos, palm, q, p.palmLocal, pole);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, ctx.def, true), weight: armW, strength: 1 + (p.armStrength - 1) * (armW / (p.guardWeight ?? 1)) };
    }
    return { joints };
  }
  override info(): Record<string, unknown> { return { hands: this.hands, kind: this.kind, landT: this.landT, releaseT: this.releaseT }; }
}

export interface CatchFallParams {
  /** 팔꿈치를 더 굽히는 각(도)과 시간(초) — 충격 흡수 */
  elbowFlexDeg: number; absorbTime: number;
  /** 팔 강도: 닿은 뒤 fadeDelay초부터 fadeTime초에 걸쳐 minStrength까지 */
  fadeDelay: number; fadeTime: number; minStrength: number;
  /** 손목: 손바닥이 바닥에 평평하도록 젖힘 (도) */
  wristDeg: number;
}

/** 손 짚기: 손이 지면에 닿으면(손마다) 팔꿈치를 굽혀 충격을 흡수하고 팔 힘을 서서히 뺀다 */
export class CatchFall extends Behavior {
  readonly name = 'CatchFall';
  private readonly p: CatchFallParams;
  readonly touch: Partial<Record<HandName, number>> = {};
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as CatchFallParams;
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const h of HANDS) {
      if (this.touch[h] === undefined && ctx.per.ground.has(h)) this.touch[h] = t;
      const t0 = this.touch[h];
      if (t0 === undefined) continue;
      const tau = t - t0;
      const bend = smoothstep(tau / p.absorbTime);
      const s = 1 - (1 - p.minStrength) * smoothstep((tau - p.fadeDelay) / p.fadeTime);
      const [arm, fore, hand] = ARM_JOINTS[h] as [JointName, JointName, JointName];
      joints[fore] = { add: degQ(p.elbowFlexDeg * bend, 0, 0), weight: 1, strength: s };
      joints[arm] = { weight: 1, strength: s };
      joints[hand] = { weight: 1, strength: s };
    }
    const n = Object.keys(this.touch).length;
    this.phase = n ? `손 짚기 ${n}` : '대기';
    return { joints };
  }
  override info(): Record<string, unknown> { return { touch: this.touch }; }
}

