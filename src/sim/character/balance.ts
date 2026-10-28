// 균형 계층 (SPEC 7.1의 6단계, v0.3: 스텝 없이 버티기). 정의: docs/ALGORITHMS.md v0.3.
// 1. 감지(지연 delay): COM, COM 속도, Spine2 회전·각속도
// 2. 원하는 COM 렌치: 수평 힘 = 발산 성분(DCM) 피드백, 수직 힘 = 중력 + 높이 PD, COM 둘레 모멘트 = 몸통(Spine2) 월드 방향 PD
// 3. 접촉력 QP(contactQP.ts): 지지발 바닥 꼭짓점 × 마찰 피라미드에 렌치를 분배(NNLS). 힘을 모멘트보다 우선(가중치) →
//    발 안에서 만들 수 없는 만큼은 모멘트 오차로 남는다
// 4. 접촉력 → 지지 다리 관절 토크 τ_j = Σ (p_i − p_j) × f_i (발목·무릎·고관절, 자코비안 전치). 모멘트 오차는 고관절을 통해 몸통으로 간다
// 5. 전략 블렌드: 모멘트 오차가 클수록(렌치를 다 못 만들수록) 고관절 전략 가중치 ↑ → 몸통을 그 방향으로 굽히는 것을 허용하고 팔을 같은 회전으로 뻗는다
// 출력: 근육 계층 명령(관절 토크 쌍, 지지 다리 서브트리 중력 보상 끄기)과 목표 포즈 수정(팔, 지지발 지면 맞춤).
// 토크 결합(모터 위 관절 토크 쌍) 이유: README 결정 33. QP: 결정 40.
import type { Ragdoll, RagdollJoint } from './ragdoll';
import type { CharacterDef } from './characterDef';
import { forwardKinematics, type JointName, type JointTargets } from './pose';
import { type Perception, type FootName, FOOT_NAMES, TOE_OF, polygonCentroid } from './perception';
import { type ContactPoint, type QPConfig } from './contactQP';
import { type Vec3, add, sub, scale, cross, dot, length, normalize } from '../math/vec3';
import { type Quat, conjugate, fromAxisAngle, fromRotationVector, fromTo, identityQ, multiplyQ, normalizeQ, rotate, toRotationVector } from '../math/quat';
import { signedDistanceToPolygon, type Vec2 } from '../math/geometry';
import { solveDense } from '../math/nnls';
import { solveWholeBodyQP } from '../dynamics/wbqp';
import { WholeBody, wrenchAt, ang, lin, add6, scale6, type V6 } from '../dynamics/wholeBody';
import { type Stepping, type StepCommand } from './stepping';
import { convexHull } from '../math/geometry';
import type { FreeArm, HandName, HandTarget } from './behaviors/types';
import type { WalkController } from './walk';
import type { AnimDriver, AnimRef } from './animDriver';
import type { TrackingRef } from './reaction';
import type { SettleRef, SettleLog } from './settle';

/** 애니 추종 걷기 입력 (v0.6): 클립 기준값, 재생기, 핀 보조 렌치 */
export interface LocoInput { ref: AnimRef; anim: AnimDriver; pinWrench: { f: Vec3; tau: Vec3 }[] | null }

/** 행동 계층(v0.5a)이 균형 계층에 주는 것: 손 과제, COM 낮추기·옮기기, 균형 끄는 기울기 여유, 몸통 강성, 균형 모드, 스텝 허용 */
export interface BalanceBehaviorInput {
  hands: Partial<Record<HandName, HandTarget>>;
  comDrop: number;
  comShift: Vec2 | null;
  tiltAllowDeg: number;
  trunkGainScale: number;
  balanceMode: 'on' | 'weak' | 'off';
  stepAllowed: boolean;
  /** 균형을 끄는 COM 높이 기준 덮어쓰기 (v0.5b Kneel) */
  minComHeight?: number | null;
  /** 손 과제가 없는 팔(쥐지 않는 팔)의 반사 배율·옆 벌림(도) */
  freeArm: FreeArm | null;
}

/**
 * 등식 제약 가중 최소제곱: min xᵀHx − 2gᵀx s.t. E x = d. KKT [[H, Eᵀ], [E, 0]] [x; λ] = [g; d]를 가우스 소거(부분 피벗)로 푼다.
 * 결정론적, 외부 의존 없음. 특이하면 null.
 */
export function solveEqualityQP(H: Float64Array, g: Float64Array, E: readonly Float64Array[], d: readonly number[], n: number): number[] | null {
  const m = E.length, N = n + m;
  const K = new Array<number>(N * N).fill(0), r = new Array<number>(N).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) K[i * N + j] = H[i * n + j]!;
    r[i] = g[i]!;
  }
  E.forEach((row, k) => {
    for (let j = 0; j < n; j++) {
      K[(n + k) * N + j] = row[j]!;
      K[j * N + n + k] = row[j]!;
    }
    r[n + k] = d[k]!;
  });
  const x = solveDense(K, r, N);
  return x ? x.slice(0, n) : null;
}

export interface BalanceConfig {
  enabledByDefault: boolean;
  delay: number;
  /** 지연 예측 보상 켬 (결정 46) */
  predict: boolean;
  /** 예측에 QP 계획 힘 대신 측정 지면력 사용 (v0.4, 결정 56) */
  predictMeasured: boolean;
  com: { kiH: number; integralLimit: number; kDcm: number; kpV: number; kdV: number; maxHorizontalForce: number; targetOffset: [number, number]; targetTau: number; heightOffset: number; /** (v0.8a) 지형에서 높이 기준 지면이 따라가는 최대 속도 (m/s) */ groundRate?: number };
  qp: Omit<QPConfig, 'weights'> & { copMargin: number };
  loadTau: number;
  enable: { maxTiltDeg: number; minComHeight: number };
  /** 전신 운동량 제어 (결정 49) */
  wb: {
    angularDamping: number;
    wLin: number;
    wAng: number;
    hipMomentRef: number;
    labelAttack: number;
    labelRelease: number;
    regularization: number;
    footKv: number;
    motorScale: number;
    subtractMotor: boolean;
    torso: { kp: number; kd: number; weight: number };
    pelvis: { kp: number; kd: number; weight: number };
    posture: { kp: number; kd: number; weight: number; weights: Partial<Record<JointName, number>> };
    limitAvoid: { marginDeg: number; kp: number; kd: number; weight: number };
    armReflex: { degPerMs: number; maxDeg: number; tau: number };
    /** 팔 각운동량 사용 비용 (2026-10-27): 가중치, 감쇠 kd (1/s) */
    armMomentum?: { weight: number; kd: number };
    /** 모터 목표 속도 = QP가 계획한 끝 속도 (v0.4, README 결정 55) */
    motorVelocityTarget: boolean;
    /** 'plan': 모터 목표(위치·속도) = QP가 계획한 이번 스텝 끝 상태, 모터 추정분 빼기 없음. 'pose': v0.3 방식 */
    motorMode: 'pose' | 'plan';
    variation: { amount: number };
  };
  perception: { soleContactDist: number; rayLength: number };
}

/** 근육 계층에 넘기는 명령. torque는 근육 규약(자식 +τ, 부모 −τ, 월드), strength를 곱하기 전 값 */
export interface BalanceCommand {
  torque: Partial<Record<JointName, Vec3>>;
  /** 관절별 (서브트리) 중력 보상 배율. 지지 다리는 접촉력 방식으로 바꾸므로 0 */
  gcScale: Partial<Record<JointName, number>>;
  /** 모터(자세 PD) kp·kd 배율 (전신 제어 중 근육을 느슨하게) */
  motorScale?: number;
  /** 관절별 모터 배율 (느슨한 팔, v0.5b). 없으면 motorScale */
  motorScaleJ?: Partial<Record<JointName, number>>;
  /** 관절별 느슨함 (모터 추정분 빼기를 (1 − loose)배로) */
  looseJ?: Partial<Record<JointName, number>>;
  /** 균형 토크에서 모터 PD 추정분을 뺀다 (모터 + 추가 = 역동역학 토크) */
  subtractMotor?: boolean;
  /** 관절별 이번 스텝 끝 목표 상대 각속도 (월드, rad/s; v0.4). 모터 감쇠가 계획된 움직임에 맞서지 않게 모터 목표 속도로 쓴다 */
  jointVel?: Partial<Record<JointName, Vec3>>;
  /** 모터 목표를 계획 궤적으로 둘 관절 (motorMode 'plan' 또는 스텝 중 다리) */
  motorPlan?: Partial<Record<JointName, boolean>>;
}

/** 로그·시각화 (CharacterState.balance) */
export interface BalanceState {
  enabled: boolean;
  strategy: 'ankle' | 'hip' | 'off';
  /** 고관절 전략 가중치 0~1 */
  hipWeight: number;
  /** COM 투영(감지값) → 지지 다각형 경계 부호 거리, 안쪽 + (m) */
  margin: number;
  /** 캡처 포인트(= DCM, 감지값) 여유, 안쪽 + (m) */
  cpMargin: number;
  comTarget: Vec3;
  comSensed: Vec3;
  /** 원하는 COM 힘의 피드백 부분 (N, 중력 제외) */
  virtualForce: Vec3;
  /** 원하는 COM 둘레 모멘트 = 몸통 PD (N·m) */
  torsoTorque: Vec3;
  /** QP가 만든 접촉 합력·모멘트 */
  achievedForce: Vec3;
  achievedMoment: Vec3;
  /** 렌치 추적 오차 (N, N·m), 가중 잔차 */
  forceError: number;
  momentError: number;
  qpResidual: number;
  /** 접촉점별 QP 힘 (월드 점, N) */
  contactForces: { p: Vec3; f: Vec3 }[];
  /** 왼발 하중 비율 (측정, 0~1) */
  loadLeft: number;
  /** 플라이휠 고관절 토크 크기 (N·m, 결정 47; 전신 제어에서는 0) */
  flywheel: number;
  /** 중심 운동량: 선(kg·m/s), COM 둘레 각(kg·m²/s) */
  linearMomentum: Vec3;
  angularMomentum: Vec3;
  /** 1단계 접촉력의 CMP (xz) */
  cmp: Vec2 | null;
  /** 2단계 역동역학 기저 잔차 |f_base| (N, 0이어야 함), 몸통 가속도 과제 오차 (rad/s²) */
  wbBaseResidual: number;
  wbTorsoError: number;
  /** 고관절 전략 굽힘 축 (월드, 단위 또는 0) */
  hipAxis: Vec3;
  cop: Vec2 | null;
  /** (2026-10-27) 반응 상체 스타일: 팔 묶음 세기(스타일 가중치 × (1 − 위험도)), 위험도 */
  armStyleW?: number;
  /** 팔 관절 움직임의 COM 둘레 각운동량 (kg·m²/s)과 전신 대비 비율 */
  armMom?: Vec3;
  armMomShare?: number;
  armDanger?: number;
  /** (결정 settle-1) 진정 단계: 진정 정도·단계·진입 시각·DCM 여유·나온 이유 (충격 뒤에만) */
  settle?: SettleLog;
  groundHeight: number | null;
  groundNormal: Vec3 | null;
}

interface Sample {
  t: number;
  com: Vec3;
  vel: Vec3;
  rot: Quat;
  angVel: Vec3;
}

const RAD = Math.PI / 180;
const UP: Vec3 = [0, 1, 0];
const LEG: Record<FootName, { hip: JointName; knee: JointName; ankle: JointName; arm: JointName; side: 1 | -1 }> = {
  LeftFoot: { hip: 'LeftUpLeg', knee: 'LeftLeg', ankle: 'LeftFoot', arm: 'LeftArm', side: 1 },
  RightFoot: { hip: 'RightUpLeg', knee: 'RightLeg', ankle: 'RightFoot', arm: 'RightArm', side: -1 },
};

const smoothstep = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const horiz = (v: Readonly<Vec3>): Vec3 => [v[0], 0, v[2]];

export const emptyBalanceState = (): BalanceState => ({
  enabled: false, strategy: 'off', hipWeight: 0, margin: 0, cpMargin: 0, comTarget: [0, 0, 0], comSensed: [0, 0, 0],
  virtualForce: [0, 0, 0], torsoTorque: [0, 0, 0], achievedForce: [0, 0, 0], achievedMoment: [0, 0, 0],
  forceError: 0, momentError: 0, qpResidual: 0, contactForces: [], flywheel: 0, linearMomentum: [0, 0, 0], angularMomentum: [0, 0, 0], cmp: null, wbBaseResidual: 0, wbTorsoError: 0, loadLeft: 0.5, hipAxis: [0, 0, 0],
  cop: null, groundHeight: null, groundNormal: null,
});

/** 지연 버퍼에서 시각 t의 값을 선형 보간 (회전은 nlerp). 버퍼보다 이르면 가장 오래된 값 */
export function sampleDelayed(buf: readonly Sample[], t: number): Sample {
  if (!buf.length) throw new Error('empty delay buffer');
  if (t <= buf[0]!.t) return buf[0]!;
  for (let i = buf.length - 1; i > 0; i--) {
    const a = buf[i - 1]!, b = buf[i]!;
    if (t >= a.t) {
      if (t >= b.t) return b;
      const k = (t - a.t) / (b.t - a.t);
      const lerp = (x: Readonly<Vec3>, y: Readonly<Vec3>): Vec3 => [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
      const s = a.rot[0] * b.rot[0] + a.rot[1] * b.rot[1] + a.rot[2] * b.rot[2] + a.rot[3] * b.rot[3] < 0 ? -1 : 1;
      const rot = normalizeQ([0, 1, 2, 3].map((i2) => a.rot[i2]! + (s * b.rot[i2]! - a.rot[i2]!) * k) as Quat);
      return { t, com: lerp(a.com, b.com), vel: lerp(a.vel, b.vel), rot, angVel: lerp(a.angVel, b.angVel) };
    }
  }
  return buf[buf.length - 1]!;
}

/** 지지발 접촉점: 지면 평면에서 soleContactDist 안인 바닥 꼭짓점을 발 중심 쪽으로 copMargin만큼 당긴 점. 없으면 실제 접촉점 */
export function footContactPoints(per: Perception, f: FootName, soleContactDist: number, copMargin: number): ContactPoint[] {
  const fp = per.feet[f];
  const g = fp.ground;
  const n: Vec3 = g ? g.normal : UP;
  const out: ContactPoint[] = [];
  if (g && fp.sole.length) {
    const center = scale(fp.sole.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / fp.sole.length);
    fp.sole.forEach((c, i) => {
      if (dot(sub(c, g.point), g.normal) >= soleContactDist) return;
      if (fp.soleSupported && !fp.soleSupported[i]) return; // (v0.8a) 계단 코 밖 허공의 꼭짓점
      const d = sub(center, c);
      const l = length(d);
      out.push({ key: `${f}:${i}`, p: l > 2 * copMargin ? add(c, scale(d, copMargin / l)) : center, n });
    });
  }
  if (!out.length) per.contacts.filter((c) => c.body === f).forEach((c, i) => out.push({ key: `${f}:c${i}`, p: c.point, n: g ? g.normal : c.normal }));
  // (v0.8a 발가락 바디 실험) 그 발의 발가락 접촉점도 지지점으로 (힘은 발 바디에 — 발가락 관절이 전달한다고 근사). 기본 캐릭터에는 발가락이 없다
  per.contacts.filter((c) => TOE_OF[c.body] === f).forEach((c, i) => out.push({ key: `${f}:t${i}`, p: c.point, n: g ? g.normal : c.normal }));
  return out;
}

/**
 * 팔 관절 자유도(Arm·ForeArm·Hand, include가 참인 바디)의 COM 둘레 각운동량 행: h_arm = Σ_j (A_ang − [c]×A_lin)[:, j] q̇_j.
 * 원점 운동량 행렬 A의 열 j는 그 관절 아래 바디들의 운동량이라 팔 관절 열만 모으면 팔이 몸통에 대해 움직여 만든 운동량이다
 */
export function armMomentumCols(wb: WholeBody, rd: Ragdoll, A: Float64Array, c: Readonly<Vec3>, n: number, include: (body: string) => boolean): { rows: Float64Array[]; h: (qd: ArrayLike<number>) => Vec3 } {
  const rows = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (const b of wb.bodies) {
    const nm = rd.bodies[b.idx]!.name;
    if (b.type === 'free' || !/Arm|Hand/.test(nm) || !include(nm)) continue;
    for (let k = 0; k < b.ndof; k++) {
      const j = b.dof0 + k;
      const aw: Vec3 = [A[j]!, A[n + j]!, A[2 * n + j]!], al: Vec3 = [A[3 * n + j]!, A[4 * n + j]!, A[5 * n + j]!];
      const g = sub(aw, cross(c, al));
      for (let r = 0; r < 3; r++) rows[r]![j] = g[r]!;
    }
  }
  const h = (qd: ArrayLike<number>): Vec3 => { const o: Vec3 = [0, 0, 0]; for (let r = 0; r < 3; r++) for (let j = 0; j < n; j++) if (rows[r]![j]) o[r] = o[r]! + rows[r]![j]! * qd[j]!; return o; };
  return { rows, h };
}

export class Balance {
  enabled: boolean;
  state: BalanceState = emptyBalanceState();
  /** 개인차 노이즈 훅 (결정 52): 캐릭터마다(시드마다) 반응 이득에 곱하는 배율. 기본 설정 amount 0이면 모두 1 */
  variation = { armReflex: 1, dcm: 1 };
  /** 시드 PRNG로 개인차를 뽑는다 (u: [0,1) 난수) */
  applyVariation(u: () => number): void {
    const a = this.cfg.wb.variation.amount;
    if (a <= 0) return;
    this.variation = { armReflex: 1 + a * (2 * u() - 1), dcm: 1 + a * 0.5 * (2 * u() - 1) };
  }
  /** 서기 포즈 관절 목표 (몸통·골반 목표의 뿌리 계산용, Character가 넣는다) */
  standTargets: JointTargets | null = null;
  /** (2026-10-27) 레퍼런스(반응 클립 등)의 관절별 추종 세기·추종 힌트 (Character가 매 스텝 넣는다, README 결정 164). null이면 그대로 */
  trackRef: TrackingRef | null = null;
  /** 진정 단계 힌트 (README 결정 settle-1): 레퍼런스 쪽(api.ts SettleController)이 매 스텝 넣는다. null = 진정 아님 */
  settleRef: SettleRef | null = null;
  /** (결정 tone-3) 근긴장 힌트: 관절별 레벨 L(0~1) → 자세 과제 kp·kd·가중치 × (1 + (gain − 1)·L). 없으면 그대로 */
  toneRef: { level: Partial<Record<JointName, number>>; kpGain: number; kdGain: number; wGain: number } | null = null;
  /** 진정 단계 로그 (balance.settle로 기록만) */
  settleLog: SettleLog | null = null;
  /** 스텝 계층 (v0.4, Character가 넣는다). 없으면 v0.3 그대로 */
  stepping: Stepping | null = null;
  /** 이번 스텝의 스텝 명령 (로그·디버그) */
  stepCmd: StepCommand | null = null;
  /** 애니 추종 걷기 (v0.6, Character가 넣는다). loco 입력이 있고 engaged면 v0.4 경로 대신 이것을 쓴다 */
  walk: WalkController | null = null;
  private buf: Sample[] = [];
  private comTargetXZ: Vec2 | null = null;
  private heightTarget = 0;
  private standHeight: number | null = null;
  /** (v0.8a) 지형에서 COM 높이 기준 지면 (속도 제한) */
  private ghSmooth: number | null = null;
  /** (v0.7) 서기 COM 높이를 아직 모르면 정한다 (쓰러진 자세로 스폰해 일어선 몸: 균형을 처음 켜는 순간이 웅크린 높이라 그대로 굳지 않게) */
  ensureStandHeight(h: number): void { this.standHeight ??= h; }
  /** (v0.7) 균형을 끄는 COM 높이 기준 덮어쓰기 (일어서는 막바지: 웅크린 채로 균형을 넘겨받는다). null이면 설정값 */
  minComHeightOverride: number | null = null;
  private lunge = 0;
  private wasOn = false;
  private wHip = 0;
  private armRot: Vec3 = [0, 0, 0];
  /** 반응 상체 스타일 위험도 0~1 (README 결정 160) */
  private armDanger = 0;
  private cmdBuf: { t: number; a: Vec3 }[] = [];
  /** 스텝 계층이 마지막으로 명령을 낸 시각 (스텝 뒤 팔 반사 데드밴드, v0.4) */
  private stepBusyT = -Infinity;
  /** 측정 지면력 예측 (v0.4, 결정 56): 직전 스텝의 총 선운동량, 이번 스텝 직전 가해진 외부 충격량(밀기 — 발바닥이 못 느끼는 힘) */
  private prevMom: Vec3 | null = null;
  private extImpulse: Vec3 = [0, 0, 0];
  /** Character가 밀기 충격량을 알린다 (예측에서 빼서 지면 반력만 남기려고) */
  noteExternalImpulse(J: Readonly<Vec3>): void { this.extImpulse = add(this.extImpulse, J); }
  private dtLast = 0;
  private comInt: Vec3 = [0, 0, 0];
  private hipAxis: Vec3 = [0, 0, 0];
  private onSince = 0;
  private prevBeta: Map<string, number[]> | undefined;
  private loads: Record<FootName, number> = { LeftFoot: 0, RightFoot: 0 };
  private readonly heading: Quat;
  private readonly spine2Idx: number;
  private readonly jointsByName = new Map<string, RagdollJoint>();
  private readonly wb: WholeBody;

  constructor(
    readonly rd: Ragdoll,
    readonly def: CharacterDef,
    public cfg: BalanceConfig,
    yaw: number,
    readonly gravity: Vec3,
    enabled?: boolean,
  ) {
    this.enabled = enabled ?? cfg.enabledByDefault;
    this.heading = fromAxisAngle(UP, yaw);
    this.spine2Idx = def.bodies.findIndex((b) => b.name === 'Spine2');
    for (const j of rd.joints) this.jointsByName.set(j.name, j);
    this.wb = new WholeBody(rd);
  }

  /** 지연 구간 (t − delay, t)의 명령 가속도를 적분해 지금 COM·속도를, 감지 각속도로 지금 Spine2 회전을 예측한다 */
  private predict(d: Sample, t: number): Sample {
    while (this.cmdBuf.length && this.cmdBuf[0]!.t < t - this.cfg.delay - 1e-9) this.cmdBuf.shift();
    let c = d.com, v = d.vel, tPrev = d.t;
    for (const k of this.cmdBuf) {
      const h = k.t + this.dtLast - tPrev;
      if (h <= 0) continue;
      v = add(v, scale(k.a, h));
      c = add(c, scale(v, h));
      tPrev += h;
    }
    const rot = multiplyQ(fromRotationVector(scale(d.angVel, this.cfg.delay)), d.rot);
    return { t, com: c, vel: v, rot, angVel: d.angVel };
  }

  /** 지지발(없으면 두 발) 앞 방향 수평 평균의 yaw 회전. 평균이 0이면 스폰 yaw */
  private feetHeading(per: Perception): Quat {
    let fx = 0, fz = 0;
    const feet = FOOT_NAMES.filter((f) => per.feet[f].contact);
    for (const f of feet.length ? feet : FOOT_NAMES) {
      const q = this.rd.body(f).rb.rotation();
      const v = rotate([q.x, q.y, q.z, q.w], [0, 0, 1]);
      const n = Math.hypot(v[0], v[2]);
      if (n > 1e-6) { fx += v[0] / n; fz += v[2] / n; }
    }
    if (Math.hypot(fx, fz) < 1e-6) return this.heading;
    return fromAxisAngle(UP, Math.atan2(fx, fz));
  }

  /** 관절점 월드 위치 */
  private jointPos(name: JointName): Vec3 {
    const j = this.jointsByName.get(name)!;
    const cb = this.rd.bodies[j.child]!.rb;
    const t = cb.translation(), q = cb.rotation();
    return add([t.x, t.y, t.z], rotate([q.x, q.y, q.z, q.w], j.def.anchorInChild));
  }

  /**
   * 한 스텝 (Rapier 스텝 전). targets를 바꿔서 돌려주고(팔·지지발), 근육 명령을 만든다.
   * active = 상태가 Active, totalMass = 총질량.
   */
  update(t: number, dt: number, active: boolean, per: Perception, targetsIn: JointTargets | null, totalMass: number, beh: BalanceBehaviorInput | null = null, loco: LocoInput | null = null): { targets: JointTargets | null; cmd: BalanceCommand | null } {
    const cfg = this.cfg;
    const rd = this.rd;
    this.dtLast = dt;
    // 감지 (현재값을 버퍼에 넣고 지연된 값을 꺼낸다)
    const { com, vel } = rd.com();
    // 측정 지면력 (발바닥 압력·근육 힘 감각, 지연 거의 없음): 직전 스텝 선운동량 변화 − 중력 − 외부 밀기 → 직전 스텝 명령 가속도를 측정값으로 바꾼다
    // (v0.6) 걷기 추종 중에는 측정 지면력 예측을 쓴다 (walk.predictMeasured): 착지 충격이 계획과 크게 달라 계획 힘 적분이 틀렸다
    if ((cfg.predictMeasured || (!!loco && !!this.walk?.engaged && this.walk.cfg.predictMeasured)) && this.prevMom && this.cmdBuf.length && dt > 0) {
      const mom = scale(vel, totalMass);
      const fGround = sub(scale(sub(sub(mom, this.prevMom), this.extImpulse), 1 / dt), scale(this.gravity, totalMass));
      this.cmdBuf[this.cmdBuf.length - 1]!.a = add(scale(fGround, 1 / totalMass), this.gravity);
    }
    this.prevMom = scale(vel, totalMass);
    this.extImpulse = [0, 0, 0];
    const s2 = rd.body('Spine2').rb;
    const q = s2.rotation(), w = s2.angvel();
    this.buf.push({ t, com, vel, rot: [q.x, q.y, q.z, q.w], angVel: [w.x, w.y, w.z] });
    while (this.buf.length > 2 && this.buf[1]!.t <= t - cfg.delay - 1e-9) this.buf.shift();
    const delayed = sampleDelayed(this.buf, t - cfg.delay);
    // 지연 예측 보상 (결정 46): 지연된 감지값에서 지금 상태를 예측한다. 내 명령의 사본(efference copy) = 지연 구간 동안 QP가 만든
    // 접촉 합력으로 낸 COM 가속도(+ 중력)를 적분하고, 몸통 회전은 감지 각속도로 적분한다(스미스 예측기). 외부 충격은 감지 전까지 모른다
    const sensed = cfg.predict ? this.predict(delayed, t) : delayed;

    // 측정 하중 (로그용)
    const a = cfg.loadTau > 0 ? 1 - Math.exp(-dt / cfg.loadTau) : 1;
    for (const f of FOOT_NAMES) this.loads[f] += (per.feet[f].load - this.loads[f]) * a;
    const lsum = this.loads.LeftFoot + this.loads.RightFoot;
    let stanceFeet = FOOT_NAMES.filter((f) => per.feet[f].contact);

    let poly = per.supportPolygon;
    const g = Math.hypot(...this.gravity);
    const st = this.state = emptyBalanceState();
    st.cop = per.cop;
    st.groundHeight = per.groundHeight;
    st.groundNormal = per.groundNormal;
    st.comSensed = sensed.com;
    st.loadLeft = lsum > 1e-6 ? this.loads.LeftFoot / lsum : 0.5;
    if (this.settleLog) st.settle = this.settleLog;
    st.margin = -signedDistanceToPolygon([sensed.com[0], sensed.com[2]], poly);
    // (v0.8a) 지형: COM 높이 기준 지면(닿은 발 평균)을 groundRate m/s 이하로만 따라간다 — 스윙발이 계단·상자 위에 닿는 순간 기준이 한 스텝에
    // 튀면 높이 피드백이 몸을 위로 밀어 두 발이 떴다(걸림·계단에서 몸이 뛰어오름). 평지는 그대로
    let ghRef = per.groundHeight ?? 0;
    if (!rd.pw.flat && cfg.com.groundRate) {
      this.ghSmooth ??= ghRef;
      const mx = cfg.com.groundRate * dt;
      this.ghSmooth += Math.max(-mx, Math.min(mx, ghRef - this.ghSmooth));
      ghRef = this.ghSmooth;
    }
    const h = Math.max(sensed.com[1] - ghRef, 1e-3);
    const omega = Math.sqrt(g / h);
    const dcm: Vec3 = [sensed.com[0] + sensed.vel[0] / omega, 0, sensed.com[2] + sensed.vel[2] / omega];
    st.cpMargin = -signedDistanceToPolygon([dcm[0], dcm[2]], poly);
    // v0.6 애니 추종 걷기: 클립 기준값으로 전신 QP (walk.ts). 넘길 수 없으면(큰 외란) 아래 v0.4 경로(균형·스텝)
    if (loco && this.walk?.engaged && this.enabled && active) {
      const r = this.walk.update({ t, dt, per, com: sensed.com, vel: sensed.vel, comNow: com, totalMass, gravity: this.gravity, targetsIn, beh, ref: loco.ref, anim: loco.anim, pinWrench: loco.pinWrench, st, helpers: this });
      if (r) {
        this.cmdBuf.push({ t, a: add(scale(r.achievedForce, 1 / totalMass), this.gravity) });
        this.wasOn = false;
        this.prevBeta = undefined;
        this.stepCmd = null;
        return { targets: r.targets, cmd: r.cmd };
      }
    }

    const tilt = Math.acos(Math.max(-1, Math.min(1, rotate(sensed.rot, UP)[1]))) / RAD;
    // 스텝 중에는 몸통이 더 기울어도 균형을 유지한다 (사람: 세게 밀리면 몸통 30°+ 기울인 채 내딛는다)
    // 행동이 일부러 몸통을 굽히면(상처 움켜쥐기 등) 그만큼 더 기울어도 균형을 유지한다 (v0.5a)
    const maxTilt = (this.stepping?.busy ? this.stepping.cfg.maxTiltDeg : cfg.enable.maxTiltDeg) + (beh?.tiltAllowDeg ?? 0);
    let on = this.enabled && active && beh?.balanceMode !== 'off' && stanceFeet.length > 0 && poly.length >= 3 && tilt < maxTilt && h > (beh?.minComHeight ?? this.minComHeightOverride ?? cfg.enable.minComHeight);
    // 스텝 계층 (v0.4): 같은 감지값으로 상태 머신·착지 계획 → 이번 스텝 명령 (행동이 스텝을 막으면 쉼)
    const sc = this.stepping && beh?.stepAllowed !== false ? this.stepping.update({ t, dt, com: sensed.com, vel: sensed.vel, omega, per, heading: this.feetHeading(per), balanceOn: on }) : null;
    this.stepCmd = sc;
    if (on && sc?.phase === 'swing' && sc.swingFoot) {
      stanceFeet = stanceFeet.filter((f) => f !== sc.swingFoot);
      poly = convexHull(stanceFeet.flatMap((f) => per.feet[f].support));
      on = stanceFeet.length > 0 && poly.length >= 3;
    }
    if (sc?.resetComTarget) { this.comInt = [0, 0, 0]; this.comTargetXZ = [sensed.com[0], sensed.com[2]]; }
    if (!on) {
      this.cmdBuf.push({ t, a: [...this.gravity] as Vec3 });
      this.wasOn = false;
      this.wHip = 0;
      this.prevBeta = undefined;
      return { targets: targetsIn, cmd: null };
    }
    st.enabled = true;

    // COM 목표: 켤 때 현재 COM 투영에서 시작해 (다각형 중심 + 오프셋)으로 저역 통과. 높이 = 켤 때 지면 위 높이
    const centroid = polygonCentroid(poly)!;
    const heading = this.feetHeading(per);
    const lat = rotate(heading, [1, 0, 0]), fwd = rotate(heading, [0, 0, 1]);
    const off = add(scale(lat, cfg.com.targetOffset[0]), scale(fwd, cfg.com.targetOffset[1]));
    // 서 있을 때 행동의 COM 목표 이동 (InjuredLeg: 성한 발 쪽으로)
    const bs = beh?.comShift ?? [0, 0];
    // 정착 막바지 되돌리기(recenter, mode settle)에도 같은 이동을 더한다 (다친 다리로 끝까지 체중을 싣지 않게)
    const goal: Vec2 = sc?.comGoal ? (sc.mode === 'settle' ? [sc.comGoal[0] + bs[0], sc.comGoal[1] + bs[1]] : [sc.comGoal[0], sc.comGoal[1]]) : [centroid[0] + off[0] + bs[0], centroid[1] + off[2] + bs[1]];
    if (!this.wasOn || !this.comTargetXZ) {
      this.onSince = t;
      this.comInt = [0, 0, 0];
      this.comTargetXZ = [com[0], com[2]];
      // 높이 목표: 처음 켤 때의 서기 높이를 기억해 다시 켤 때도 쓴다 (스텝 중 잠깐 꺼졌다 켜질 때 낮아진 높이를 목표로 굳히지 않게, v0.4)
      const hNow = com[1] - ghRef;
      this.standHeight ??= hNow;
      this.heightTarget = Math.max(hNow, this.standHeight - (this.stepping?.cfg.reHeightDrop ?? 0)) + cfg.com.heightOffset;
    } else if (t - this.onSince < cfg.delay + dt / 2) {
      // 켠 뒤 delay가 지나면(양발 접촉·지연 버퍼가 찬 뒤) 목표를 다각형 중심으로 바로 옮긴다
      this.comTargetXZ = goal;
    } else {
      const tau = (sc?.comGoal || sc?.mode === 'settle') && this.stepping ? this.stepping.cfg.settle.comGoalTau : cfg.com.targetTau;
      const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
      this.comTargetXZ = [this.comTargetXZ[0] + (goal[0] - this.comTargetXZ[0]) * k, this.comTargetXZ[1] + (goal[1] - this.comTargetXZ[1]) * k];
    }
    this.wasOn = true;
    // 스텝 중 COM 높이를 조금 낮춘다(런지): 다리를 굽혀야 발이 멀리 닿는다
    this.lunge += ((sc?.lungeDrop ?? 0) - this.lunge) * (1 - Math.exp(-dt / (this.stepping?.cfg.lunge.tau ?? 0.15)));
    // 행동의 COM 낮추기 (HitReaction: 맞은 순간 무릎이 꺾이며 움찔 주저앉음)
    const cT: Vec3 = [this.comTargetXZ[0], ghRef + this.heightTarget - this.lunge - (beh?.comDrop ?? 0), this.comTargetXZ[1]];
    st.comTarget = cT;

    // 원하는 COM 힘: 수평 = DCM 피드백. ξ̇ = ω(ξ − p)를 ξ̇ = −k(ξ − ξ_t)로 → p = ξ + (k/ω)(ξ − ξ_t), F = Mω²(c − p)
    // 스텝 계층이 하중을 옮기라고(comGoal) 하면 DCM 이득을 높여 빠르게 (사람의 의도적 체중 이동 0.3~0.5초)
    const kd = ((sc?.comGoal && this.stepping ? this.stepping.cfg.settle.shiftKDcm : cfg.com.kDcm) * this.variation.dcm) / omega;
    const pDes: Vec3 = [dcm[0] + kd * (dcm[0] - cT[0]), 0, dcm[2] + kd * (dcm[2] - cT[2])];
    if (sc?.dcmGoal) {
      // 단일 지지 스텝 중: 착지 때 DCM이 목표(착지점 바로 뒤)에 오도록 원하는 CMP를 정한다. ξ(T) = p + (ξ − p)e^{ωT} → p = (ξ_g − ξe^{ωT}) / (1 − e^{ωT}).
      // QP가 지지발 안(+ 각운동량)으로 자른다
      const E = Math.exp(omega * Math.max(sc.dcmGoal.T, this.stepping?.cfg.dcmGoalMinT ?? 0.1));
      pDes[0] = (sc.dcmGoal.xi[0] - dcm[0] * E) / (1 - E);
      pDes[2] = (sc.dcmGoal.xi[1] - dcm[2] * E) / (1 - E);
    }
    if (sc && this.stepping) {
      // 스텝 중에는 지지 다각형 밖으로 cmpOutside m 넘는 CMP를 요구하지 않는다: 못 만드는 수평력을 몸통 각운동량(고관절 전략)으로
      // 억지로 만들면 몸통이 50° 넘게 접힌다. 사람은 이때 몸통을 접는 대신 발을 내딛는다
      const pp: Vec2 = [pDes[0], pDes[2]];
      const d = signedDistanceToPolygon(pp, poly);
      const lim2 = this.stepping.cfg.cmpOutside;
      if (d > lim2) {
        let best: Vec2 = poly[0]!, bd = Infinity;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
          const ex = b[0] - a[0], ez = b[1] - a[1];
          const l2 = ex * ex + ez * ez;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((pp[0] - a[0]) * ex + (pp[1] - a[1]) * ez) / l2)) : 0;
          const q: Vec2 = [a[0] + ex * u, a[1] + ez * u];
          const dd = Math.hypot(pp[0] - q[0], pp[1] - q[1]);
          if (dd < bd) { bd = dd; best = q; }
        }
        const k = lim2 / d;
        pDes[0] = best[0] + (pp[0] - best[0]) * k;
        pDes[2] = best[1] + (pp[1] - best[1]) * k;
      }
    }
    let fh: Vec3 = scale([sensed.com[0] - pDes[0], 0, sensed.com[2] - pDes[2]], totalMass * omega * omega);
    // 느린 적분: 근육 포즈가 정하는 자연 자세와 COM 목표가 달라 생기는 정상 상태 오차를 없앤다 (사람의 느린 자세 조정). 스텝 중에는 쉰다
    const lim = cfg.com.integralLimit;
    if (sc && !sc.comGoal) this.comInt = [0, 0, 0];
    else this.comInt = [Math.max(-lim, Math.min(lim, this.comInt[0] + (cT[0] - sensed.com[0]) * dt)), 0, Math.max(-lim, Math.min(lim, this.comInt[2] + (cT[2] - sensed.com[2]) * dt))];
    fh = add(fh, scale(this.comInt, cfg.com.kiH));
    const fhm = length(fh);
    if (fhm > cfg.com.maxHorizontalForce) fh = scale(fh, cfg.com.maxHorizontalForce / fhm);
    let fy = cfg.com.kpV * (cT[1] - sensed.com[1]) - cfg.com.kdV * sensed.vel[1];
    // 스텝 중 수직 피드백 제한: 다리를 크게 벌린 채 COM 높이를 억지로 되찾으면 몸이 튀어 오른다(두 발이 다 뜸)
    if (sc && this.stepping) { const cap = this.stepping.cfg.verticalCap * totalMass * g; fy = Math.max(-cap, Math.min(cap, fy)); }
    const fFb: Vec3 = [fh[0], fy, fh[2]];
    st.virtualForce = fFb;
    const Fdes = add(fFb, scale(this.gravity, -totalMass));

    const settled = t - this.onSince >= cfg.delay - 1e-9;

    // ── 전신 운동량 제어 (결정 49) ──
    const wb = this.wb;
    const wst = wb.state();
    const mm = wb.massAndMomentum(wst);
    const lMom = lin(mm.momentum);
    const kG = sub(ang(mm.momentum), cross(com, lMom)); // COM 둘레 각운동량
    st.linearMomentum = lMom;
    st.angularMomentum = kG;

    const kdotDes = horiz(scale(kG, -cfg.wb.angularDamping));
    st.torsoTorque = kdotDes;
    const points: ContactPoint[] = [];
    // 발끝 지지 (v0.4, 뒤꿈치 들기): 스텝 중 지지 발목이 배굴 제한 가까이 가거나 뒤꿈치가 이미 떴으면 발끝 꼭짓점만 접촉으로 두고
    // 발은 발끝 선 둘레로 돌 수 있게 한다(사람의 뒤꿈치 들기). 안 그러면 QP는 발을 평평하게 고정했다고 믿는데 실제로는 발목 제한에 막혀 어긋난다
    const toeFeet = new Set<FootName>();
    // 정착 중에는 뒤꿈치를 내린다(발끝 지지 없음 → 발목 '평평' 목표가 뒤꿈치를 내림). 안 그러면 뒤쪽 발이 발끝으로 선 채 남아 미끄러진다
    if (sc && this.stepping && sc.mode === 'step') {
      const tm = this.stepping.cfg.toeOff;
      for (const f of stanceFeet) {
        const j = this.jointsByName.get(LEG[f].ankle)!;
        const lim = j.limits[0];
        const flex = rd.coords(j)[0]!;
        const sole = per.feet[f].sole, g = per.feet[f].ground;
        const hgt = (i: number) => (g && sole[i] ? dot(sub(sole[i]!, g.point), g.normal) : 0);
        const heelUp = Math.min(hgt(0), hgt(1)) > tm.heelLift && Math.max(hgt(2), hgt(3)) < cfg.perception.soleContactDist;
        if ((lim && flex > lim[1] - tm.marginDeg * RAD) || heelUp) toeFeet.add(f);
      }
    }
    for (const f of stanceFeet) {
      let pts = footContactPoints(per, f, cfg.perception.soleContactDist, cfg.qp.copMargin);
      if (toeFeet.has(f)) {
        const toe = pts.filter((p) => p.key === `${f}:2` || p.key === `${f}:3`);
        if (toe.length === 2) pts = toe;
        else toeFeet.delete(f);
      }
      points.push(...pts);
    }

    // 2단계 전신 가속도: min Σ w‖T q̈ − r‖² + λ‖q̈‖²  s.t. 운동량 등식 A_O q̈ = W_ext − bias,  지지발 가속도 = −Kv·v
    const n = wb.n;
    const H = new Float64Array(n * n), gvec = new Float64Array(n);
    const addRow = (row: Float64Array | number[], target: number, w: number) => {
      for (let i = 0; i < n; i++) {
        const ri = row[i]!;
        if (ri === 0) continue;
        gvec[i]! += w * ri * target;
        for (let j = 0; j < n; j++) if (row[j] !== 0) H[i * n + j]! += w * ri * row[j]!;
      }
    };
    for (let i = 0; i < n; i++) H[i * n + i]! += cfg.wb.regularization;
    // 스텝 중: 팔·머리 가속도 정규화 (QP가 팔을 플라이휠처럼 수백 rad/s²로 휘두르지 않게)
    if (sc?.mode === 'step' && this.stepping) {
      const ar = this.stepping.cfg.trunk.armAccelReg;
      for (const b of wb.bodies) {
        const nm = rd.bodies[b.idx]!.name;
        if (!/Arm|Hand|Head/.test(nm)) continue;
        // 손 과제(상처 움켜쥐기)가 걸린 팔은 정규화하지 않는다 (v0.5a)
        const busy = this.handBusy(beh, nm) > 0.05;
        if (busy && !/Hand/.test(nm)) continue;
        // 손목은 회내·회외(twist ±90)까지 열려 관성이 아주 작은 축이 생겼다 → 손은 따로 강하게 (손을 균형에 쓰지 않는다, README 결정 72).
        // 손 과제가 걸린 손은 과제의 handReg (손을 뻗는 동안 손목이 따라가야 한다)
        const hn = nm.startsWith('Left') ? 'LeftHand' : 'RightHand';
        const r = /Hand/.test(nm) ? (busy ? beh!.hands[hn]!.task.handReg ?? ar : Math.max(ar, this.stepping.cfg.trunk.handAccelReg ?? ar)) : ar;
        for (let k = 0; k < b.ndof; k++) H[(b.dof0 + k) * n + b.dof0 + k]! += r;
      }
    }
    // 느슨한 팔 (v0.5b): QP가 쥐지 않는 팔을 플라이휠로 계획하지 않게 가속도 정규화 (그 팔은 QP 토크 대신 모터 + 중력 보상으로 수동으로 흔들린다)
    for (const b of wb.bodies) {
      const lo = this.looseOf(beh, rd.bodies[b.idx]!.name);
      if (lo > 0) for (let k = 0; k < b.ndof; k++) H[(b.dof0 + k) * n + b.dof0 + k]! += lo * beh!.freeArm!.looseReg;
    }
    // 몸통(Spine2) 월드 방향 PD 가속도 (예측 감지값)
    // 몸통·골반 목표의 뿌리: 목표 포즈가 고관절을 서기보다 더 굽히면(상체를 고관절에서 숙임) 허벅지는 서기 방향 그대로 두고 골반을 그만큼 기울인다
    let root = heading;
    if (this.standTargets) {
      const fkP = forwardKinematics(this.def, targetsIn ?? {}, { pos: [0, 0, 0], rot: heading });
      const fkS = forwardKinematics(this.def, this.standTargets, { pos: [0, 0, 0], rot: heading });
      const dl = (n: string) => { const i = this.def.bodies.findIndex((b) => b.name === n); return multiplyQ(fkS[i]!.rot, conjugate(fkP[i]!.rot)); };
      let a = dl('LeftUpLeg');
      const b = dl('RightUpLeg');
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) a = [-a[0], -a[1], -a[2], -a[3]];
      root = multiplyQ(normalizeQ([a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]), heading);
    }
    const fk = forwardKinematics(this.def, targetsIn ?? {}, { pos: [0, 0, 0], rot: root });
    const qT = fk[this.spine2Idx]!.rot;
    // 스텝 중 (v0.4): 몸통·골반을 더 단단히 → 넘어지는 각운동량을 몸통을 접는 대신 스윙 다리·팔이 받는다 (사람 레퍼런스 몸통 기울기 범위)
    const tr = sc && this.stepping && (sc.mode === 'step' || this.stepping.cfg.settle.trunkGains) ? this.stepping.cfg.trunk : null;
    // 몸통 방향 감지: 기본은 지연 + 예측. 스텝 중 trunkImmediate면 지금 값 (README 결정 56)
    const imm = !!sc && !!this.stepping?.cfg.trunkImmediate;
    const s2now = rd.body('Spine2').rb, s2q0 = s2now.rotation(), s2w0 = s2now.angvel();
    const trunkRot: Quat = imm ? [s2q0.x, s2q0.y, s2q0.z, s2q0.w] : sensed.rot;
    const trunkW: Vec3 = imm ? [s2w0.x, s2w0.y, s2w0.z] : sensed.angVel;
    let qe = multiplyQ(qT, conjugate(trunkRot));
    if (qe[3] < 0) qe = [-qe[0], -qe[1], -qe[2], -qe[3]];
    const torsoG0 = tr ? tr.torso : cfg.wb.torso, pelvisG = tr ? (sc?.shifting ? cfg.wb.pelvis : tr.pelvis) : cfg.wb.pelvis;
    // 행동의 몸통 강성 배율 (Stagger: 상체 강성 낮춤, v0.5a)
    const ts = beh?.trunkGainScale ?? 1;
    // 반응 상체 스타일: 팔을 클립 모양에 묶는 대신 몸통이 각운동량을 더 받게 몸통 과제 가중치를 trunkWeightScale배로 (README 결정 160)
    const tws = this.trackRef ? 1 + this.trackRef.w * (this.trackRef.trunkWeightScale - 1) : 1;
    // (결정 tone-5, 실험) 정착 중 몸통 과제 가중치 배율 — 몸통 세우기가 COM 힘 과제를 이겨 COM을 가장자리로 미는 것(step-2)을 줄이는 실험. 없으면 1
    const tsw = sc?.mode === 'settle' && !sc.shifting ? this.stepping?.cfg.settle.torsoWeightScale ?? 1 : 1;
    const torsoG = ts !== 1 || tws !== 1 || tsw !== 1 ? { kp: torsoG0.kp * ts, kd: torsoG0.kd * Math.sqrt(ts), weight: torsoG0.weight * tws * tsw } : torsoG0;
    const alphaDes = sub(scale(toRotationVector(qe), torsoG.kp), scale(trunkW, torsoG.kd));
    const s2j = wb.jacobian(wst, this.spine2Idx);
    for (let r = 0; r < 3; r++) {
      if (r === 1) continue; // yaw 제외 (관절 모터·자세 과제가 잡음)
      const row = new Float64Array(n);
      s2j.dofs.forEach((d, k) => { row[d] = s2j.cols[k]![r]!; });
      addRow(row, alphaDes[r]! - s2j.a0[r]!, torsoG.weight);
    }
    // 스텝 중 몸통 비틀림(yaw) 억제: Spine2 yaw를 골반 yaw에 맞춘다 (상대 비틀림 → 0). 서기에서는 뺀다(결정 42의 지연 yaw 진동)
    if (tr && tr.yawWeight > 0) {
      const hq = rd.body('Hips').rb.rotation(), hw = rd.body('Hips').rb.angvel();
      const yawOf = (q: Quat) => { const f = rotate(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); };
      // 목표 포즈가 몸통을 일부러 비틀면(행동: 피격 비틀림·움켜쥐기·바라보기) 그 비틀림(Spine·Spine2 twist 목표 합)을 목표로 (v0.5a)
      const twT = (q?: Quat) => (q ? 2 * Math.asin(Math.max(-1, Math.min(1, q[3] < 0 ? -q[1] : q[1]))) : 0);
      const intended = beh ? twT(targetsIn?.Spine) + twT(targetsIn?.Spine2) : 0;
      let dy = yawOf([hq.x, hq.y, hq.z, hq.w]) + intended - yawOf(trunkRot);
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const row = new Float64Array(n);
      s2j.dofs.forEach((d, k) => { row[d] = s2j.cols[k]![1]!; });
      addRow(row, tr.yawKp * dy - tr.yawKd * (trunkW[1] - hw.y) - s2j.a0[1]!, tr.yawWeight);
    }
    // 팔 반사 (결정 52): 감지한 COM 수평 속도 v에 비례해 팔을 축 ŷ × v̂ 둘레로 휘두른다(몸이 넘어가려는 회전과 같은 방향 →
    // 각운동량을 받는다; 앞으로 밀리면 팔이 뒤로, 옆이면 반대쪽 팔이 바깥으로). 저역 통과로 부드럽게. 사람 레퍼런스의 팔 사용량에 맞춘 값
    const vh = horiz(sensed.vel);
    const vl = length(vh);
    const armGain = sc?.armGain ?? 1;
    // 스텝이 끝나 서기로 돌아온 뒤 arms.returnTime초 동안은 느린 COM 표류(< reflexDeadband m/s)에 팔이 반응하지 않는다 — 회복이 끝나 가는데 팔이 들린 채 남는 것을 막는다 (리드 지시)
    if (sc) this.stepBusyT = t;
    const afterStep = this.stepping && !sc && t - this.stepBusyT < this.stepping.cfg.arms.returnTime;
    const vArm = afterStep ? Math.max(0, vl - this.stepping!.cfg.arms.reflexDeadband) : vl;
    // 반응 상체 스타일 중에는 팔 반사를 reflexScale배로 (팔 모양은 사람 클립이 정한다, README 결정 160)
    const asy = this.trackRef;
    // 위험도(감지 DCM이 지지 다각형 밖으로 나간 정도, 오를 때 즉시·내릴 때 dangerTau): 정말 넘어질 듯할 때만 팔을 균형에 풀어 준다 (사람: 큰 팔 휘두름은 넘어질 때만)
    if (asy?.release) {
      const dz = asy.release;
      // DCM 이탈 + (설정 시) COM 수평 속도: 아직 빠르게 움직이는 동안(정착 중 되돌리기)에도 팔을 균형에 쓸 수 있게
      const dg = Math.max(smoothstep((-st.cpMargin - dz.d0) / Math.max(1e-3, dz.d1 - dz.d0)), dz.v1 ? smoothstep((vl - (dz.v0 ?? 0)) / Math.max(1e-3, dz.v1 - (dz.v0 ?? 0))) : 0);
      this.armDanger = dg > this.armDanger ? dg : this.armDanger + (dg - this.armDanger) * (1 - Math.exp(-dt / dz.tau));
    } else this.armDanger = 0;
    const asw = asy ? asy.w * (1 - this.armDanger) : 0;
    st.armStyleW = asw;
    st.armDanger = this.armDanger;
    // 진정 단계 (결정 settle-1): 버틴 뒤에는 작은 흔들림에 팔을 휘두르지 않는다 — 팔 반사·팔 벌림을 진정 정도만큼 끈다
    const sr = this.settleRef;
    const styleK = (asy ? 1 + asw * (asy.reflexScale - 1) : 1) * (sr ? 1 + sr.level * (sr.reflexScale - 1) : 1);
    const goalA = Math.min(cfg.wb.armReflex.maxDeg * armGain, cfg.wb.armReflex.degPerMs * this.variation.armReflex * armGain * vArm) * RAD * styleK;
    const kA = 1 - Math.exp(-dt / cfg.wb.armReflex.tau);
    const axisGoal: Vec3 = vl > 1e-4 ? scale(cross(UP, scale(vh, 1 / vl)), goalA) : [0, 0, 0];
    this.armRot = add(this.armRot, scale(sub(axisGoal, this.armRot), kA));
    let postureTargets: JointTargets = { ...(targetsIn ?? {}) };
    // 스텝 (v0.4): 스윙 다리 = IK 목표, 지지 다리(발이 서기 포즈와 다른 곳) = 지금 자세 (다리끼리 싸우지 않게, 자세 과제는 감쇠만)
    const legW: Partial<Record<JointName, number>> = {};
    if (sc) {
      for (const f of sc.freezeLegs) {
        for (const jn of [LEG[f].hip, LEG[f].knee, LEG[f].ankle]) postureTargets[jn] = this.currentRel(jn);
        // 닿아 있는 발은 발목만 '발바닥 평평' 목표 (지금 자세로 굳히면 모서리로 착지한 발이 기운 채 남아 미끄러진다; 뒤꿈치 든 발 제외)
        if (stanceFeet.includes(f) && !toeFeet.has(f)) { const fa = this.flatAnkle(f, per); if (fa) postureTargets[LEG[f].ankle] = fa; }
      }
      if (sc.legTargets && sc.swingFoot) {
        Object.assign(postureTargets, sc.legTargets);
        for (const jn of [LEG[sc.swingFoot].hip, LEG[sc.swingFoot].knee, LEG[sc.swingFoot].ankle]) legW[jn] = this.stepping!.cfg.swing.legPostureWeight;
      }
    }
    // 스텝 중 팔 벌리기 (사람 레퍼런스: 내딛는 동안 팔이 몸에서 떨어진다)
    const abK = (asy ? 1 + asw * (asy.abductScale - 1) : 1) * (sr ? 1 + sr.level * (sr.abductScale - 1) : 1);
    if (sc && sc.abductDeg * abK > 0.1) {
      const s2q = rd.body('Spine2').rb.rotation();
      for (const f of FOOT_NAMES) this.preRotate(postureTargets, LEG[f].arm, [s2q.x, s2q.y, s2q.z, s2q.w], fromAxisAngle(fwd, LEG[f].side * sc.abductDeg * abK * RAD * (1 - this.handBusy(beh, LEG[f].arm))));
    }
    // 쥐지 않는 팔 옆으로 벌리기 (v0.5a, 상처 움켜쥐는 동안 균형용)
    // (반응 상체 스타일 중에는 쥐지 않는 팔 벌림도 abductScale배 — 팔은 클립 모양)
    if (beh?.freeArm && beh.freeArm.abductDeg * abK > 0.1) {
      const s2q = rd.body('Spine2').rb.rotation();
      for (const f of FOOT_NAMES) if (this.handBusy(beh, LEG[f].arm) < 0.05) this.preRotate(postureTargets, LEG[f].arm, [s2q.x, s2q.y, s2q.z, s2q.w], fromAxisAngle(fwd, LEG[f].side * beh.freeArm.abductDeg * abK * RAD));
    }
    const armAng = length(this.armRot);
    if (armAng > 1e-4) {
      postureTargets = { ...postureTargets };
      const ax = scale(this.armRot, 1 / armAng);
      const fallDir = normalize(cross(ax, UP));
      const s2q = rd.body('Spine2').rb.rotation();
      for (const f of FOOT_NAMES) {
        const L = LEG[f];
        // 손 과제가 걸린 팔은 반사에서 뺀다 (다른 팔은 균형을 잡으려 벌어짐 — SPEC 대표 장면)
        const fa = beh?.freeArm && this.handBusy(beh, L.arm) < 0.05 ? beh.freeArm.reflexScale : 1;
        const armW = (1 - Math.max(0, dot(fallDir, scale(lat, L.side)))) * (1 - this.handBusy(beh, L.arm)) * fa;
        if (armW > 0) this.preRotate(postureTargets, L.arm, [s2q.x, s2q.y, s2q.z, s2q.w], fromAxisAngle(ax, armAng * armW));
      }
    }
    // 자세 유지 (목표 포즈, 관절별 가중치) — 가속도 수준 PD
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      let w = legW[name] ?? cfg.wb.posture.weights[name] ?? cfg.wb.posture.weight;
      // 정착 중: 팔을 기본 자세로 돌려놓는다 (사람: 버틴 뒤 팔이 내려온다. 리드 지시)
      if (sc?.mode === 'settle' && /Arm|Hand/.test(name)) w = Math.max(w, this.stepping!.cfg.settle.armPostureWeight);
      // 반응 상체 스타일: 팔이 사람 클립 팔 모양을 따른다 (QP가 팔을 각운동량 플라이휠로 쓰지 않게, 손 과제가 걸린 팔 제외)
      const jw = asy?.jointWeight[name];
      if (jw !== undefined && (!/Arm|Hand/.test(name) || this.handBusy(beh, name) < 0.05)) w = Math.max(w, w + asw * (asy!.jointScale?.[name] ?? 1) * (jw - w));
      // 진정 단계: 팔을 서기 자세에 붙들고(가중치 armWeight) 감쇠를 키운다(armKd) — 손 과제가 걸린 팔 제외
      const settleArm = !!sr && /Arm|Hand/.test(name) && this.handBusy(beh, name) < 0.05;
      if (settleArm) w = Math.max(w, w + sr!.level * (sr!.armWeight - w));
      const tL = this.toneRef?.level[name] ?? 0;
      if (tL > 0) w *= 1 + (this.toneRef!.wGain - 1) * tL;
      if (w <= 0) continue;
      const j = this.jointsByName.get(name)!;
      const pq = rd.bodies[b.parent]!.rb.rotation(), cq = rd.bodies[b.idx]!.rb.rotation();
      const qp_: Quat = [pq.x, pq.y, pq.z, pq.w], qc: Quat = [cq.x, cq.y, cq.z, cq.w];
      const rT = postureTargets[name] ?? identityQ();
      const qDes = multiplyQ(multiplyQ(qp_, j.def.frameInParent), multiplyQ(rT, conjugate(j.def.frameInChild)));
      let qd = multiplyQ(qDes, conjugate(qc));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const e = toRotationVector(qd);
      for (let k = 0; k < b.ndof; k++) {
        const d = b.dof0 + k;
        const axisW = ang(wst.S[d]!);
        const row = new Float64Array(n);
        row[d] = 1;
        // (결정 tone-4) 정착·체중 이동 중 감쇠: 다리는 settle(체중 이동을 막지 않게), 몸통·목·팔은 settleUpper(없으면 settle) — kp 100에 kd 10이면 감쇠비 0.5라 상체가 출렁였다
        const pk = this.stepping?.cfg.postureKd;
        const kd0 = sc && pk ? (sc.mode === 'settle' || sc.shifting ? (/Leg|Foot/.test(name) ? pk.settle : pk.settleUpper ?? pk.settle) : pk.step) : cfg.wb.posture.kd;
        const kdP = settleArm ? kd0 + sr!.level * (sr!.armKd - kd0) : kd0;
        addRow(row, cfg.wb.posture.kp * (tL > 0 ? 1 + (this.toneRef!.kpGain - 1) * tL : 1) * dot(e, axisW) - kdP * (tL > 0 ? 1 + (this.toneRef!.kdGain - 1) * tL : 1) * wst.qd[d]!, w);
      }
    }
    // 관절 제한 피하기 (v0.4): QP는 관절 제한을 모른다. 무릎이 0°(완전히 폄)나 발목이 제한(비틀기 ±5° 등)에 닿으면 QP가 더 가려는 가속도를 내고
    // 실제로는 막혀 모델과 실제가 어긋난다(스윙발이 명령의 1/3만 움직임). 축 좌표가 제한 marginDeg 안으로 들어가면 되돌리는 가속도 과제
    {
      const la = cfg.wb.limitAvoid;
      const m = la.marginDeg * RAD;
      for (const b of wb.bodies) {
        if (b.type === 'free') continue;
        const j = this.jointsByName.get(rd.bodies[b.idx]!.name)!;
        const x3 = rd.coords(j);
        const pq = rd.bodies[j.parent]!.rb.rotation();
        const frame = multiplyQ([pq.x, pq.y, pq.z, pq.w], j.frameP);
        for (let k = 0; k < (b.type === 'hinge' ? 1 : 3); k++) {
          const lim = j.limits[k];
          if (!lim || lim[0] === lim[1]) continue;
          if (k === 0 && toeFeet.size && FOOT_NAMES.some((f) => toeFeet.has(f) && LEG[f].ankle === j.name)) continue; // 발끝 지지: 발목 배굴은 발이 돌아 해결
          const mk = Math.min(m, (lim[1] - lim[0]) / 4);
          const x = x3[k]!;
          const axisW = b.type === 'hinge' ? null : rotate(frame, k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1]);
          const row = new Float64Array(n);
          let rate = 0;
          if (axisW) for (let i = 0; i < 3; i++) { row[b.dof0 + i] = axisW[i]!; rate += axisW[i]! * wst.qd[b.dof0 + i]!; }
          else { row[b.dof0] = 1; rate = wst.qd[b.dof0]!; }
          let target: number | null = null;
          if (x < lim[0] + mk) target = la.kp * (lim[0] + mk - x) - la.kd * Math.min(0, rate);
          else if (x > lim[1] - mk) target = la.kp * (lim[1] - mk - x) - la.kd * Math.max(0, rate);
          if (target !== null) addRow(row, target, la.weight);
        }
      }
    }
    // 골반 방향 (기저 각가속도, heading 직립)
    {
      const hq = rd.body('Hips').rb.rotation(), hw = rd.body('Hips').rb.angvel();
      const hDes = multiplyQ(root, this.def.bodies[0]!.restRotation);
      let qd = multiplyQ(hDes, conjugate([hq.x, hq.y, hq.z, hq.w]));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const e = toRotationVector(qd);
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        row[r] = 1;
        addRow(row, pelvisG.kp * e[r]! - pelvisG.kd * [hw.x, hw.y, hw.z][r]!, pelvisG.weight);
      }
    }
    // 스윙발 과제 (v0.4): 발 원점 점 가속도 = a_ref + kp(p_ref − p) + kd(v_ref − v) (수평은 베지어 재계획 가속도), 방향 PD
    if (sc?.phase === 'swing' && sc.swing && sc.swingFoot) {
      const scfg = this.stepping!.cfg.swing;
      const fj = wb.jacobian(wst, wb.byName.get(sc.swingFoot)!);
      const frb = rd.body(sc.swingFoot).rb;
      const ft = frb.translation(), fq = frb.rotation(), fw = frb.angvel();
      const p: Vec3 = [ft.x, ft.y, ft.z];
      const om = ang(fj.v);
      const vp = add(lin(fj.v), cross(om, p));
      const ab = add(add(lin(fj.a0), cross(ang(fj.a0), p)), cross(om, vp));
      const r = sc.swing;
      for (let k = 0; k < 3; k++) {
        const pd = (k === 1 ? r.usePD.v : r.usePD.h) ? scfg.kp * (r.p[k]! - p[k]!) + scfg.kd * (r.v[k]! - vp[k]!) : 0;
        const row = new Float64Array(n);
        fj.dofs.forEach((d, i) => { const col = fj.cols[i]!; row[d] = lin(col)[k]! + cross(ang(col), p)[k]!; });
        addRow(row, r.a[k]! + pd - ab[k]!, scfg.weight);
      }
      // 방향: 발바닥 기울기(목표 법선)만 맞추고 yaw는 놓아 둔다 — yaw까지 잡으면 발목 비틀기 제한(±5°)과 싸워 모델과 실제가 어긋난다
      const upNow = rotate([fq.x, fq.y, fq.z, fq.w], UP), upDes = rotate(this.clampToLimits(LEG[sc.swingFoot].ankle, r.rot, this.stepping!.cfg.swing.ankleMarginDeg * RAD), UP);
      const tiltErr = toRotationVector(fromTo(upNow, upDes));
      const wv: Vec3 = [fw.x, fw.y, fw.z];
      const alpha = sub(scale(tiltErr, scfg.rotKp), scale(sub(wv, scale(upNow, dot(wv, upNow) * 0.8)), scfg.rotKd));
      for (let k = 0; k < 3; k++) {
        const row = new Float64Array(n);
        fj.dofs.forEach((d, i) => { row[d] = fj.cols[i]![k]!; });
        addRow(row, alpha[k]! - fj.a0[k]!, scfg.rotWeight);
      }
    }
    // 손 과제 (v0.5a, 상처 움켜쥐기): 손바닥 점 가속도 = kp(p_ref − p) + kd(v_ref − v), 손 방향 PD (기준 각속도 = 맞은 바디 각속도). 가중치 × 행동 가중치
    for (const hn of ['LeftHand', 'RightHand'] as const) {
      const ht = beh?.hands[hn];
      if (!ht || ht.weight < 1e-3) continue;
      const hj = wb.jacobian(wst, wb.byName.get(hn)!);
      const hrb = rd.body(hn).rb;
      const ht0 = hrb.translation(), hq0 = hrb.rotation(), hw0 = hrb.angvel();
      const hq: Quat = [hq0.x, hq0.y, hq0.z, hq0.w];
      const p = add([ht0.x, ht0.y, ht0.z], rotate(hq, ht.palmLocal));
      const om = ang(hj.v);
      const vp = add(lin(hj.v), cross(om, p));
      const ab = add(add(lin(hj.a0), cross(ang(hj.a0), p)), cross(om, vp));
      const k = ht.task;
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        hj.dofs.forEach((d, i) => { const col = hj.cols[i]!; row[d] = lin(col)[r]! + cross(ang(col), p)[r]!; });
        addRow(row, k.kp * (ht.palm[r]! - p[r]!) + k.kd * (ht.vel[r]! - vp[r]!) - ab[r]!, k.weight * ht.weight);
      }
      let qe = multiplyQ(ht.rot, conjugate(hq));
      if (qe[3] < 0) qe = [-qe[0], -qe[1], -qe[2], -qe[3]];
      const alpha = sub(scale(toRotationVector(qe), k.rotKp), scale(sub([hw0.x, hw0.y, hw0.z], ht.angVel), k.rotKd));
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        hj.dofs.forEach((d, i) => { row[d] = hj.cols[i]![r]!; });
        addRow(row, alpha[r]! - hj.a0[r]!, k.rotWeight * ht.weight);
      }
    }
    // (2026-10-27) 팔 각운동량 사용 비용: 팔 관절 움직임이 만드는 COM 둘레 각운동량 h_arm = A_G,arm q̇_arm을 −kd·h_arm 쪽으로 (팔을 플라이휠로 쓰지 않게, README 결정 163).
    // 손 과제가 걸린 팔은 뺀다. 로그: armMomShare = |h_arm| / |k_G|
    {
      const am = cfg.wb.armMomentum;
      const cols = armMomentumCols(wb, rd, mm.A, com, n, (nm) => this.handBusy(beh, nm) < 0.05);
      const hArm = cols.h(wst.qd);
      st.armMomShare = length(hArm) / Math.max(1e-6, length(kG));
      st.armMom = hArm;
      const wAm = (am?.weight ?? 0) * (this.trackRef ? 1 + this.trackRef.w * (this.trackRef.armMomScale - 1) : 1) * (this.settleRef ? 1 + this.settleRef.level * (this.settleRef.armMomScale - 1) : 1);
      if (wAm > 0) for (let r = 0; r < 3; r++) addRow(cols.rows[r]!, -am!.kd * hArm[r]!, wAm);
    }
    // 등식 우변: 운동량 (W_g − bias, 접촉 렌치는 QP 안에서), 지지발 (6 × 발)
    let Wg: V6 = [0, 0, 0, 0, 0, 0];
    // 외부 렌치: 중력 + Rapier 바디 각감쇠(손·발·전완, ragdoll.json)를 같은 모델로 (v0.4: 안 넣으면 스윙발 방향 가속도가 어긋남)
    const extW: V6[] = wb.bodies.map((b) => {
      const bs = wst.bodies[b.idx]!;
      let w6 = wrenchAt(bs.c, scale(this.gravity, bs.m));
      const d = rd.bodies[b.idx]!.rb.angularDamping();
      if (d > 0) {
        const de = d / (1 + dt * d), om = ang(bs.v), I = bs.Ic;
        const t: Vec3 = [-(I[0]! * om[0] + I[1]! * om[1] + I[2]! * om[2]) * de, -(I[3]! * om[0] + I[4]! * om[1] + I[5]! * om[2]) * de, -(I[6]! * om[0] + I[7]! * om[1] + I[8]! * om[2]) * de];
        w6 = add6(w6, [t[0], t[1], t[2], 0, 0, 0]);
      }
      return w6;
    });
    for (const w6 of extW) Wg = add6(Wg, w6);
    const footRows: Float64Array[] = [], footRhs: number[] = [];
    for (const f of stanceFeet) {
      const fj = wb.jacobian(wst, wb.byName.get(f)!);
      if (toeFeet.has(f)) {
        // 발끝 두 점 A, B의 점 가속도 = −Kv·v (A 3행 + B는 AB에 수직인 2행) → 발끝 선 둘레 회전만 자유
        const tp = points.filter((p) => p.key.startsWith(`${f}:`)).map((p) => p.p);
        const A = tp[0]!, B = tp[1]!;
        const ab = normalize(sub(B, A));
        const e1 = normalize(cross(ab, Math.abs(ab[1]) < 0.9 ? UP : [1, 0, 0]));
        const e2 = cross(ab, e1);
        const om = ang(fj.v);
        const ptRows = (P: Vec3, dirs: Vec3[]) => {
          const vP = add(lin(fj.v), cross(om, P));
          const aB = add(add(lin(fj.a0), cross(ang(fj.a0), P)), cross(om, vP));
          for (const dvec of dirs) {
            const row = new Float64Array(n);
            fj.dofs.forEach((dd, k) => { const col = fj.cols[k]!; row[dd] = dot(add(lin(col), cross(ang(col), P)), dvec); });
            footRows.push(row);
            footRhs.push(dot(sub(scale(vP, -cfg.wb.footKv), aB), dvec));
          }
        };
        ptRows(A, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
        ptRows(B, [e1, e2]);
        continue;
      }
      for (let r = 0; r < 6; r++) {
        const row = new Float64Array(n);
        fj.dofs.forEach((dd, k) => { row[dd] = fj.cols[k]![r]!; });
        footRows.push(row);
        footRhs.push(-fj.a0[r]! - cfg.wb.footKv * fj.v[r]!);
      }
    }
    // 하중 빼기 (스텝 시작): 스윙발 접촉점은 최소 법선력 0 + 힘을 벌함 → 지지발로 하중이 옮겨 간다
    const unloadKey = sc?.phase === 'unload' && sc.swingFoot ? `${sc.swingFoot}:` : null;
    const ptPenalty = points.map((pt) => (unloadKey && pt.key.startsWith(unloadKey) ? sc!.unloadPenalty : 0));
    const ptMinN = points.map((pt) => (unloadKey && pt.key.startsWith(unloadKey) ? 0 : cfg.qp.minNormal ?? 0));
    const res = solveWholeBodyQP({
      n, H, g: gvec, A: mm.A, momentumRhs: Wg.map((x, r) => x - mm.hBias[r]!), footRows, footRhs, points, com, Fdes, kdotDes,
      mu: cfg.qp.mu, wLin: tr ? tr.wLin : cfg.wb.wLin, wAng: tr ? tr.wAng : cfg.wb.wAng, regRho: cfg.qp.regularization, smoothRho: cfg.qp.smoothing, minNormal: cfg.qp.minNormal ?? 0, prevBeta: this.prevBeta,
      pointPenalty: ptPenalty, pointMinNormal: ptMinN,
      wLinAxes: tr && sc?.phase === 'swing' ? [1, tr.wLinVertical, 1] : undefined,
    });
    if (!res) return { targets: targetsIn, cmd: null };
    this.prevBeta = res.beta;
    const qdd = res.qdd;
    st.achievedForce = res.achieved[0];
    st.achievedMoment = res.achieved[1];
    st.forceError = length(sub(res.achieved[0], Fdes));
    st.momentError = length(sub(horiz(res.achieved[1]), kdotDes));
    st.qpResidual = res.eqResidual;
    st.contactForces = res.forces.map((c) => ({ p: c.p, f: c.f }));
    this.cmdBuf.push({ t, a: add(scale(res.achieved[0], 1 / totalMass), this.gravity) });
    const Fa = res.achieved[0];
    const gh = per.groundHeight ?? 0;
    st.cmp = Fa[1] > 1e-6 ? [com[0] - (Fa[0] * (com[1] - gh)) / Fa[1], com[2] - (Fa[2] * (com[1] - gh)) / Fa[1]] : null;
    const wRaw = settled ? smoothstep(st.momentError / cfg.wb.hipMomentRef) : 0;
    const tauW = wRaw > this.wHip ? cfg.wb.labelAttack : cfg.wb.labelRelease;
    this.wHip += (wRaw - this.wHip) * (tauW > 0 ? 1 - Math.exp(-dt / tauW) : 1);
    st.hipWeight = this.wHip;
    st.strategy = this.wHip < 0.5 ? 'ankle' : 'hip';
    const fext: V6[] = extW.map((w6) => [...w6] as V6);
    for (const c of res.forces) {
      const bi = wb.byName.get(c.key.split(':')[0]!)!;
      fext[bi] = add6(fext[bi]!, wrenchAt(c.p, c.f));
    }
    const id = wb.inverseDynamics(wst, qdd, fext);
    st.wbBaseResidual = Math.hypot(...id.baseResidual);
    st.wbTorsoError = length(sub(alphaDes, ang(wb.jacobian(wst, this.spine2Idx).cols.reduce((acc, col, k) => add6(acc, scale6(col, qdd[s2j.dofs[k]!]!)), s2j.a0))));

    // 'plan' 모터는 스텝 중에만 (서기 = v0.3 그대로; 결정 55)
    const motorPlan: Partial<Record<JointName, boolean>> = {};
    if (cfg.wb.motorMode === 'plan') for (const j of rd.joints) motorPlan[j.name] = true;
    else if (sc?.mode === 'step' && this.stepping) for (const jn of this.stepping.cfg.motorPlanJoints) motorPlan[jn] = true;
    const cmd: BalanceCommand = { torque: {}, gcScale: {}, motorScale: cfg.wb.motorScale, subtractMotor: cfg.wb.subtractMotor, motorPlan };
    if (cfg.wb.motorVelocityTarget || Object.keys(motorPlan).length) cmd.jointVel = {};
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      cmd.torque[name] = id.torque[b.idx]!;
      cmd.gcScale[name] = 0;
      const lo = this.looseOf(beh, name);
      if (lo > 0) {
        // 느슨한 팔: QP 토크를 (1 − loose)만, 중력 보상을 loose만큼, 모터는 looseMotorScale (계획 모터·추정분 빼기 없음)
        cmd.torque[name] = scale(id.torque[b.idx]!, 1 - lo);
        cmd.gcScale[name] = lo;
        (cmd.looseJ ??= {})[name] = lo;
        (cmd.motorScaleJ ??= {})[name] = cfg.wb.motorScale + (beh!.freeArm!.looseMotorScale - cfg.wb.motorScale) * lo;
        delete motorPlan[name];
      }
      if (cmd.jointVel) {
        // 끝 속도 = 지금 + q̈·dt (구형: 월드 축 3, 경첩: 축 스칼라)
        if (b.type === 'sph') cmd.jointVel[name] = [0, 1, 2].map((k) => wst.qd[b.dof0 + k]! + qdd[b.dof0 + k]! * dt) as Vec3;
        else cmd.jointVel[name] = scale(ang(wst.S[b.dof0]!), wst.qd[b.dof0]! + qdd[b.dof0]! * dt);
        // 느슨한 팔: 모터 감쇠가 계획 속도가 아니라 정지 쪽으로 (수동 팔이 출렁이지 않게)
        if (lo > 0) cmd.jointVel[name] = scale(cmd.jointVel[name]!, 1 - lo);
      }
    }

    // 지지발 목표 = 지금 정강이 기준으로 발바닥이 지면 법선에 평평 (발목 모터가 토크와 싸우지 않게)
    let targets: JointTargets | null = targetsIn;
    const edit = (): JointTargets => (targets === targetsIn ? (targets = { ...(targetsIn ?? {}) }) : targets!);
    // 스텝: 근육 모터 목표도 자세 과제와 같게 (스윙 다리 IK, 지지 다리 지금 자세)
    if (sc) {
      for (const f of sc.freezeLegs) for (const jn of [LEG[f].hip, LEG[f].knee]) edit()[jn] = postureTargets[jn]!;
      if (sc.legTargets) Object.assign(edit(), sc.legTargets);
    }
    for (const f of stanceFeet) {
      const fa = this.flatAnkle(f, per);
      if (fa) edit()[LEG[f].ankle] = fa;
    }
    return { targets, cmd };
  }

  /** 쥐지 않는 팔의 느슨함 0~1 (v0.5b): 그 팔 체인(Arm·ForeArm·Hand)이고 손 과제가 없을 때 freeArm.loose */
  looseOf(beh: BalanceBehaviorInput | null, body: string): number {
    if (!beh?.freeArm || beh.freeArm.loose <= 0 || !/Arm|Hand/.test(body)) return 0;
    const hn: HandName = body.startsWith('Left') ? 'LeftHand' : 'RightHand';
    if (!beh.freeArm.parts.includes(body.replace(/^(Left|Right)/, ''))) return 0;
    return beh.freeArm.hands.includes(hn) && this.handBusy(beh, body) < 0.05 ? Math.min(1, beh.freeArm.loose) : 0;
  }

  /** 이 바디(팔·손 체인)에 걸린 손 과제 가중치 0~1 (v0.5a) */
  handBusy(beh: BalanceBehaviorInput | null, body: string): number {
    if (!beh) return 0;
    const hn: HandName | null = body.startsWith('Left') ? 'LeftHand' : body.startsWith('Right') ? 'RightHand' : null;
    return hn && /Arm|Hand/.test(body) ? Math.min(1, beh.hands[hn]?.weight ?? 0) : 0;
  }

  /** 발바닥이 지면 법선에 평평해지는 발목 관절 목표 (지금 정강이 기준). 지면 없으면 null */
  flatAnkle(f: FootName, per: Perception): Quat | null {
    const gnd = per.feet[f].ground;
    if (!gnd) return null;
    const fq = this.rd.body(f).rb.rotation(), sq = this.rd.body(LEG[f].knee).rb.rotation();
    const qf: Quat = [fq.x, fq.y, fq.z, fq.w];
    const qDes = multiplyQ(fromTo(rotate(qf, UP), gnd.normal), qf);
    const j = this.jointsByName.get(LEG[f].ankle)!;
    return multiplyQ(multiplyQ(conjugate(multiplyQ([sq.x, sq.y, sq.z, sq.w], j.def.frameInParent)), qDes), j.def.frameInChild);
  }

  /** 자식 바디의 원하는 월드 회전을 관절 제한(축별, margin 안쪽)으로 자른 월드 회전. 부모는 지금 회전 */
  clampToLimits(jn: JointName, qChildDes: Readonly<Quat>, margin: number): Quat {
    const j = this.jointsByName.get(jn)!;
    const pq = this.rd.bodies[j.parent]!.rb.rotation();
    const qp: Quat = [pq.x, pq.y, pq.z, pq.w];
    const fr = multiplyQ(qp, j.frameP);
    let r = multiplyQ(conjugate(fr), multiplyQ([...qChildDes] as Quat, j.frameC));
    if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
    const c = [0, 1, 2].map((k) => {
      const x = 2 * Math.asin(Math.max(-1, Math.min(1, r[k]!)));
      const l = j.limits[k];
      if (!l) return x;
      const m = Math.min(margin, (l[1] - l[0]) / 4);
      return Math.max(l[0] + m, Math.min(l[1] - m, x));
    });
    const sx = Math.sin(c[0]! / 2), sy = Math.sin(c[1]! / 2), sz = Math.sin(c[2]! / 2);
    const w = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy - sz * sz));
    return normalizeQ(multiplyQ(multiplyQ(fr, [sx, sy, sz, w]), conjugate(j.frameC)));
  }

  /** 지금 관절 상대 회전 (정의 관절 좌표계, 목표 형식) */
  private currentRel(jn: JointName): Quat {
    const j = this.jointsByName.get(jn)!;
    const pq = this.rd.bodies[j.parent]!.rb.rotation(), cq = this.rd.bodies[j.child]!.rb.rotation();
    return multiplyQ(multiplyQ(conjugate(multiplyQ([pq.x, pq.y, pq.z, pq.w], j.def.frameInParent)), [cq.x, cq.y, cq.z, cq.w]), j.def.frameInChild);
  }

  /** 관절 목표에 월드 회전 Δ를 자식 쪽에 먼저 적용: r' = (conj(q_p·F_P) Δ (q_p·F_P)) · r */
  private preRotate(targets: JointTargets, jn: JointName, qParent: Readonly<Quat>, delta: Readonly<Quat>): void {
    const j = this.jointsByName.get(jn)!;
    const fr = multiplyQ(qParent, j.def.frameInParent);
    const dl = multiplyQ(multiplyQ(conjugate(fr), delta), fr);
    targets[jn] = multiplyQ(dl, targets[jn] ?? identityQ());
  }
}
