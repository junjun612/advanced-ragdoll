// 스텝 계층 (SPEC v0.4 "발 내딛기"). 정의: docs/ALGORITHMS.md v0.4, 설정: config/stepping.json.
// 균형 계층(전신 QP, balance.ts)이 매 스텝 부른다. 이 파일은 "언제·어느 발로·어디에·어떻게" 내딛는지만 정하고,
// 실행은 같은 QP의 과제·제약으로 한다(스윙발 = 궤적·방향 과제, 지지발 = 접촉 제약, 단일 지지 균형 = 같은 QP).
// 상태 머신: stand → step(L|R) → settle → stand. maxSteps 뒤에도 필요하면 Stagger(v0.5a) 훅 이벤트.
// 셋업 행동 LiftFoot(trigger)도 여기서: 한 발을 들고 유지 → 그 상태에서 밀리면 그 발로 바로 내딛는다(교차 스텝 포함).
import type { Ragdoll } from './ragdoll';
import type { CharacterDef } from './characterDef';
import type { JointName, JointTargets } from './pose';
import { type Perception, type FootName, FOOT_NAMES, castGround, polygonCentroid, probeFoothold, type Foothold, type FootholdConfig } from './perception';
import { type Vec3, add, sub, scale, cross, dot, length, normalize } from '../math/vec3';
import { type Quat, conjugate, fromAxisAngle, fromTo, multiplyQ, rotate } from '../math/quat';
import { fromColumns, toQuat } from '../math/mat3';
import { convexHull, signedDistanceToPolygon, closestPointOnSegment, pointInConvexPolygon, type Vec2 } from '../math/geometry';
import { solveTwoBone } from '../math/ik';
import type { Prng } from '../prng';
import type { StepMods } from './behaviors/types';

export interface SteppingConfig {
  enabledByDefault: boolean;
  stepTriggerMargin: number;
  stepTriggerJitter: number;
  retriggerMargin: number;
  retriggerMinTime: number;
  /** 착지 직후(retriggerMinTime 안)라도 DCM이 이만큼(m) 넘게 밖이면 바로 다음 스텝 */
  retriggerUrgent: number;
  slowRetrigger: { speed: number; margin: number };
  cmpOutside: number;
  startupGrace: number;
  replaceAfter: number;
  nearEdge: number;
  nearEdgeTime: number;
  countMinMove: number;
  offGrace: number;
  stepOvershoot: number;
  cmpUse: number;
  nominalWidth: number;
  landingWidthSteps: number[];
  landingMargin: number;
  maxStepLength: number;
  maxStep: { fwd: number; back: number };
  maxReach: number;
  /** (v0.8c, 결정 178) 다른 사람 발 중심에서 이 거리(m) 안에는 딛지 않는다 (없으면 끔) */
  otherFootClear?: number;
  minFootSpacing: number;
  crossMax: number;
  crossFwd: number;
  crossBulge: number;
  minUsefulMove: number;
  maxSlopeDeg: number;
  maxHeightDiff: number;
  replanUntil: number;
  duration: { min: number; max: number; refDist: number; swingSpeed: number };
  unloadTime: number;
  brakeTime: number;
  unloadPenalty: number;
  apex: { min: number; max: number };
  touchdownLoad: number;
  touchdownHold: number;
  touchdownMinS: number;
  touchdownNear: number;
  minRemaining: number;
  landDescentSpeed: number;
  swing: { kp: number; kd: number; weight: number; rotKp: number; rotKd: number; rotWeight: number; legPostureWeight: number; ikLookahead: number; ankleMarginDeg: number; hStart: number; hEnd: number; plateau?: { rise: number; fall: number } | null };
  simbicon: { cd: number; cv: number; maxDeg: number };
  legCost: { load: number; dir: number; cross: number; reach: number; clamp: number; bias: number; heavyLoad: number; heavyPenalty: number; sameFoot: number };
  settle: {
    stillSpeed: number; closeSagittal: number; closeWidthTol: number; shiftFraction: number; shiftTime: number; shiftLoad: number;
    closeDuration: number; closeApex: number; shiftTol: number; shiftMaxSpeed: number; standTime: number; maxClosing: number; comGoalTau: number; shiftKDcm: number; stepMode: boolean; freezeLegs: boolean; trunkGains: boolean; armPostureWeight: number; recenter: boolean; recenterSpeed: number; recenterFreeze?: boolean; placeSpeed: number; placeApex: number; placeMaxSpeed: number; torsoWeightScale?: number;
  };
  trunk: { torso: { kp: number; kd: number; weight: number }; pelvis: { kp: number; kd: number; weight: number }; wAng: number; wLin: number; wLinVertical: number; armAccelReg: number; handAccelReg?: number; yawKp: number; yawKd: number; yawWeight: number };
  motorPlanJoints: JointName[];
  trunkImmediate: boolean;
  maxTiltDeg: number;
  reHeightDrop: number;
  postureKd: { step: number; settle: number; settleUpper?: number };
  verticalCap: number;
  lunge: { maxDrop: number; dropPerMs: number; tau: number };
  toeOff: { marginDeg: number; heelLift: number };
  /** 스윙 중 원하는 CMP 식의 남은 시간 하한(초): 착지 직전 T → 0이면 p = (ξg − ξE)/(1 − E)가 튄다 */
  dcmGoalMinT: number;
  /** 고정 뒤 재계획: 스윙 진행 until 전, 새 목표가 jump m 넘게 바뀌면 (README 결정 73) */
  lateReplan?: { until: number; jump: number } | null;
  /** 교차 스텝을 다리 선택 후보에 넣을지 (기본 끔) */
  crossSteps: boolean;
  maxSteps: number;
  hardMaxSteps: number;
  /** (v0.6) 걷기에서 넘겨받은 뒤 이 시간(초) 동안 그때의 지지발로는 내딛지 않는다 */
  handoverHold: number;
  arms: { stepGain: number; abductDegPerMs: number; maxAbductDeg: number; reflexDeadband: number; returnTime: number };
  liftFoot: { height: number; forward: number; shiftTime: number; duration: number; downBack: number };
  /**
   * (v0.8a) 지형 디딤 (평지가 아닐 때만): 착지 목표를 디딜 수 있는 발판(probeFoothold)으로 옮긴다 — 넘어지는 방향을 따라 ±search m를 searchStep 간격으로
   * 가까운 것부터, 지지발 지면보다 maxRise 넘게 높거나 maxDrop 넘게 낮으면 안 됨. 스윙 높이는 경로 아래 지면(발 길이 창 최대) + clearance
   * (스윙 진행 clearFadeStart부터 0으로), 내려 딛는 스텝은 COM을 descendGain × 높이 차(≤ descendMax)만큼 낮춘다
   */
  terrain?: FootholdConfig & { maxRise: number; maxDrop: number; search: number; searchStep: number; clearance: number; clearFadeStart: number; profileSamples: number; descendGain: number; descendMax: number; centerSteps: number; heightTime: number; landDescentSpeed: number; toePitchMaxDeg: number; toePitchPerM: number; preferRange: number; downStart: number; maxClimbSlope: number; maxDropFromSwing?: number; backCost: number; edgeTol: number; minApex: number; cornerClear: number; voidDrop: number; voidShort: number; voidNotifyS: number };
}

export type StepStateName = 'stand' | 'step' | 'settle' | 'lift';
export type StepKind = 'reactive' | 'closing' | 'lift';

/** 균형 계층(QP)에 넘기는 이번 스텝 명령 */
export interface StepCommand {
  swingFoot: FootName | null;
  /** unload: 접촉은 있으나 힘을 벌함(하중 옮기기), swing: 접촉에서 뺌 + 궤적 과제 */
  phase: 'unload' | 'swing' | null;
  unloadPenalty: number;
  /** 스윙발 원점(박스 중심) 기준 원하는 가속도 = a + kp(p − x) + kd(v − ẋ), 방향 rot */
  swing?: { p: Vec3; v: Vec3; a: Vec3; rot: Quat; usePD: { h: boolean; v: boolean } };
  /** 착지 때 DCM 목표 (단일 지지 중 원하는 CMP를 정함) */
  dcmGoal?: { xi: Vec2; T: number };
  /** COM 목표 (xz) 덮어쓰기 (하중 옮기기) */
  comGoal?: Vec2;
  /** 스윙 다리 관절 목표 (2관절 IK) */
  legTargets?: JointTargets;
  /** 자세 과제에서 현재 자세를 목표로 둘 지지 다리 (발이 서기 포즈와 다른 곳에 있을 때 다리끼리 싸우지 않게) */
  freezeLegs: FootName[];
  /** 팔 반사 배율, 추가 벌림(도) */
  armGain: number;
  abductDeg: number;
  /** 하중 옮기기(모으기·들기 준비) 중: 골반 과제를 약하게 (체중 이동에는 골반이 기울어야 한다) */
  shifting?: boolean;
  /** step: 스텝·들기 진행 중 (몸통 강화·다리 계획 모터), settle: 착지 뒤 양발 지지 (v0.3 균형 + CMP 제한) */
  mode: 'step' | 'settle';
  /** COM 높이 낮추기 (m, 런지) */
  lungeDrop: number;
  /** 스텝 계층이 COM 목표 저역 통과·적분을 새로 시작하라고 알림 */
  resetComTarget: boolean;
}

export interface LandingRecord { foot: FootName; t: number; p: Vec2; target: Vec2; error: number; kind: StepKind }

/** 로그·시각화 (CharacterState.stepping) */
export interface SteppingState {
  enabled: boolean;
  state: StepStateName;
  swingFoot: FootName | null;
  phase: 'unload' | 'swing' | null;
  kind: StepKind | null;
  /** 이번 흔들림 구간에서 착지한 스텝 수 */
  stepCount: number;
  /** 착지 목표 (월드, 발 원점 바닥 높이) */
  target: Vec3 | null;
  /** 원하는 착지 때 DCM (xz) */
  xiGoal: Vec2 | null;
  /** 감지 DCM (xz)과 지지 다각형 밖 거리(+ = 밖, m) */
  cp: Vec2;
  cpOutside: number;
  /** 이번 흔들림 구간의 트리거 문턱 (margin + jitter) */
  threshold: number;
  /** 스윙 진행 0~1 */
  s: number;
  /** 스텝 시간 (초) */
  duration: number;
  crossing: boolean;
  simbiconDeg: number;
  /** 다리 비용 [왼발, 오른발] (선택 시점) */
  legCost: [number, number] | null;
  landings: LandingRecord[];
  lastLandingError: number | null;
  /** Stagger(v0.5a) 넘김이 일어났는가 (이번 구간) */
  staggerHandoff: boolean;
  /** (v0.8a, 지형 디딤일 때만) 착지 디딤면: 지지발 지면 대비 높이 차(m, + = 위), 발판 받침 비율, 디딜 곳 없는 헛디딤 */
  terrain?: { dh: number; supported: number; void: boolean };
}

export const emptySteppingState = (): SteppingState => ({
  enabled: false, state: 'stand', swingFoot: null, phase: null, kind: null, stepCount: 0, target: null, xiGoal: null,
  cp: [0, 0], cpOutside: 0, threshold: 0, s: 0, duration: 0, crossing: false, simbiconDeg: 0, legCost: null, landings: [], lastLandingError: null, staggerHandoff: false,
});

/** 스텝 계층이 매 스텝 받는 입력 (감지값은 균형 계층의 지연 + 예측 값) */
export interface StepContext {
  t: number;
  dt: number;
  com: Vec3;
  vel: Vec3;
  omega: number;
  per: Perception;
  heading: Quat;
  /** 균형이 켜졌는가 (꺼지면 스텝도 쉰다) */
  balanceOn: boolean;
}

/** 이벤트 (Character가 SimEvent로 내보낸다) */
export interface StepEvent { type: 'step' | 'stepStart' | 'stagger' | 'footReplace' | 'voidStep'; detail: string; foot?: FootName; error?: number }

interface Plan {
  target: Vec3;
  xiGoal: Vec2;
  /** 제한 전 원하는 착지점과 실제 목표의 거리 (m) */
  clampDist: number;
  crossing: boolean;
  dir: Vec2;
  /** (v0.8a) 착지 발판 검사 결과 (평지면 없음) */
  foothold?: Foothold | null;
  /** (v0.8a) 디딜 곳 없이 낭떠러지 쪽으로 내딛는 걸음 (헛디딤) */
  void?: boolean;
}

interface ActiveStep {
  foot: FootName;
  stance: FootName;
  kind: StepKind;
  t0: number;
  tLift: number;
  tLand: number;
  apex: number;
  start: Vec3;
  startGround: number;
  yaw: number;
  plan: Plan;
  frozen: boolean;
  /** 목표 고정(다시 계획 안 함): 2단 스텝의 '지지발 뒤에 내리기' */
  pinned?: boolean;
  allowCross: boolean;
  contactSince: number | null;
  /** closing: 하중 옮기기 끝 조건 */
  shiftUntil: number;
  /** 반응 스텝 제동 구간 끝 (이때까지는 하중 빼기 없이 v0.3 DCM 피드백) */
  brakeUntil?: number;
  /** lift: 유지 높이·끝 시각 */
  hold?: { p: Vec3; until: number };
  /** (v0.8a) 헛디딤 이벤트를 보냈는가 */
  voidSent?: boolean;
  /** (v0.8a) 스윙 경로 아래 지면 높이 (발 길이 창 최대, 수평 진행 0..1 표본). 시작·목표가 바뀌면 다시 잰다 */
  prof?: { key: string; g: number[] };
}

const UP: Vec3 = [0, 1, 0];
const RAD = Math.PI / 180;
const OTHER: Record<FootName, FootName> = { LeftFoot: 'RightFoot', RightFoot: 'LeftFoot' };
const LEGJ: Record<FootName, { hip: JointName; knee: JointName; ankle: JointName; side: 1 | -1 }> = {
  LeftFoot: { hip: 'LeftUpLeg', knee: 'LeftLeg', ankle: 'LeftFoot', side: 1 },
  RightFoot: { hip: 'RightUpLeg', knee: 'RightLeg', ankle: 'RightFoot', side: -1 },
};
const h2 = (v: Readonly<Vec3>): Vec2 => [v[0], v[2]];
const v3 = (p: Readonly<Vec2>, y = 0): Vec3 => [p[0], y, p[1]];
const sub2 = (a: Readonly<Vec2>, b: Readonly<Vec2>): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Readonly<Vec2>, b: Readonly<Vec2>): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sc2 = (a: Readonly<Vec2>, s: number): Vec2 => [a[0] * s, a[1] * s];
const dot2 = (a: Readonly<Vec2>, b: Readonly<Vec2>): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: Readonly<Vec2>): number => Math.hypot(a[0], a[1]);
const norm2 = (a: Readonly<Vec2>, fb: Vec2 = [0, 1]): Vec2 => { const l = len2(a); return l > 1e-9 ? [a[0] / l, a[1] / l] : fb; };
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const smooth = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** 다각형 안(경계 포함)에서 p에 가장 가까운 점 */
function closestInPolygon(p: Readonly<Vec2>, poly: readonly Vec2[]): Vec2 {
  if (poly.length >= 3 && pointInConvexPolygon(p, poly)) return [p[0], p[1]];
  let best: Vec2 = poly[0]!, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = closestPointOnSegment(p, poly[i]!, poly[(i + 1) % poly.length]!);
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

export class Stepping {
  enabled: boolean;
  state: SteppingState = emptySteppingState();
  /** 이번 스텝의 이벤트 (Character가 꺼내 간다) */
  events: StepEvent[] = [];
  private st: StepStateName = 'stand';
  private step: ActiveStep | null = null;
  private count = 0;
  private closings = 0;
  private threshold: number;
  private episodeArmed = true;
  private stillSince: number | null = null;
  private landT = -Infinity;
  private landings: LandingRecord[] = [];
  private stagger = false;
  private onSince: number | null = null;
  private nearEdgeSince: number | null = null;
  private lastGround: Partial<Record<FootName, Vec3>> = {};
  private airSince: Record<FootName, number | null> = { LeftFoot: null, RightFoot: null };
  private offSince: number | null = null;
  private recenterGoal: Vec2 | null = null;
  private handoverStance: { foot: FootName; until: number } | null = null;
  private liftReq: { foot: FootName; height: number; duration: number } | null = null;
  /** 행동 계층의 스텝 수정 (v0.5a: InjuredLeg 다친 발·Stagger 불규칙). Character가 매 스텝 넣는다 */
  mods: StepMods = {};
  /** 불규칙 스텝 지터용 시드 PRNG ('stagger' 하위 스트림, Character가 넣는다 — 스텝 스트림을 건드리지 않게 따로) */
  staggerRng: Prng | null = null;
  /** 이번 스텝의 불규칙 지터 (Stagger): 시간 배율, 넘침·옆 추가 (m) */
  private jit: { dur: number; over: number; lat: number } | null = null;
  /** (v0.8a) 이번 스텝의 인지 (지형 디딤에서 스윙발 출발 높이) */
  private lastPer: Perception | null = null;
  private readonly legBias: Record<FootName, number>;
  private readonly footHalf: Vec3;
  private readonly lThigh: number;
  private readonly lShin: number;
  private readonly ankleInFoot: Record<FootName, Vec3>;
  private readonly hipAnchor: Record<FootName, Vec3>;
  private readonly kneeInThigh: Record<FootName, Vec3>;
  private readonly ankleInShin: Record<FootName, Vec3>;
  private readonly kneeAxis: Record<FootName, Vec3>;

  constructor(readonly rd: Ragdoll, readonly def: CharacterDef, public cfg: SteppingConfig, readonly rng: Prng, enabled?: boolean) {
    this.enabled = enabled ?? cfg.enabledByDefault;
    const b = rng.float();
    // 개인 다리 선호 (시드마다): 한쪽 다리를 조금 더 먼저 내딛는다
    this.legBias = { LeftFoot: cfg.legCost.bias * (2 * b - 1), RightFoot: -cfg.legCost.bias * (2 * b - 1) };
    this.threshold = this.drawThreshold();
    const bd = (n: string) => def.bodies.find((x) => x.name === n)!;
    const fs = bd('LeftFoot').shape;
    this.footHalf = fs.type === 'box' ? [...fs.halfExtents] as Vec3 : [0.05, 0.06, 0.12];
    const mk = <T>(f: (L: (typeof LEGJ)[FootName]) => T): Record<FootName, T> => ({ LeftFoot: f(LEGJ.LeftFoot), RightFoot: f(LEGJ.RightFoot) });
    this.hipAnchor = mk((L) => bd(L.hip).joint!.anchorInChild as Vec3);
    this.kneeInThigh = mk((L) => bd(L.knee).joint!.anchorInParent as Vec3);
    this.ankleInShin = mk((L) => bd(L.ankle).joint!.anchorInParent as Vec3);
    this.ankleInFoot = mk((L) => bd(L.ankle).joint!.anchorInChild as Vec3);
    this.kneeAxis = mk((L) => normalize(bd(L.knee).joint!.axis as Vec3));
    this.lThigh = length(sub(this.kneeInThigh.LeftFoot, this.hipAnchor.LeftFoot));
    this.lShin = length(sub(this.ankleInShin.LeftFoot, bd('LeftLeg').joint!.anchorInChild as Vec3));
  }

  private drawThreshold(): number {
    return this.cfg.stepTriggerMargin + this.cfg.stepTriggerJitter * (2 * this.rng.float() - 1);
  }

  /** (v0.8a) 지형 디딤이 켜졌는가: StairStep 행동(mods.terrainStep)이 켜고, 설정 terrain이 있어야 한다 */
  get terrainOn(): boolean { return !!this.mods.terrainStep && !!this.cfg.terrain; }

  /** 스텝·정착·들기 중인가 (균형 켜짐 조건 완화용) */
  get busy(): boolean { return this.st !== 'stand'; }

  /**
   * 걷기 추종(v0.6)에서 넘겨받을 때: 시작 유예 없이 바로 반응 스텝을 할 수 있게 상태를 서기로 비운다
   * (걷는 동안은 이 계층이 돌지 않아 켜진 시각·발 기억이 낡았다)
   */
  handover(t: number, stanceFoot: FootName | null = null): void {
    // 막 디딘 지지발(걷기에서 넘겨받은 순간 체중을 받는 발)은 첫 반응 스텝으로 들지 않는다
    this.handoverStance = stanceFoot ? { foot: stanceFoot, until: t + this.cfg.handoverHold } : null;
    this.st = 'stand';
    this.step = null;
    this.count = 0;
    this.closings = 0;
    this.stagger = false;
    this.landings = [];
    this.onSince = t - this.cfg.startupGrace - 1;
    this.offSince = null;
    this.nearEdgeSince = null;
    this.stillSince = null;
    this.episodeArmed = true;
    this.airSince = { LeftFoot: null, RightFoot: null };
    this.lastGround = {};
  }

  /** 셋업 행동: 한 발 들기 (trigger LiftFoot) */
  liftFoot(foot: FootName, height?: number, duration?: number): void {
    this.liftReq = { foot, height: height ?? this.cfg.liftFoot.height, duration: duration ?? this.cfg.liftFoot.duration };
  }

  // ── 몸 상태 읽기 ──
  private bodyPos(name: string): Vec3 { const t = this.rd.body(name as never).rb.translation(); return [t.x, t.y, t.z]; }
  private bodyRot(name: string): Quat { const q = this.rd.body(name as never).rb.rotation(); return [q.x, q.y, q.z, q.w]; }
  private bodyVel(name: string): Vec3 { const v = this.rd.body(name as never).rb.linvel(); return [v.x, v.y, v.z]; }
  private hipPoint(f: FootName): Vec3 { return add(this.bodyPos(LEGJ[f].hip), rotate(this.bodyRot(LEGJ[f].hip), this.hipAnchor[f])); }
  private footCenter(per: Perception, f: FootName): Vec2 {
    const s = per.feet[f].sole;
    if (!s.length) return h2(this.bodyPos(f));
    return [s.reduce((a, c) => a + c[0], 0) / s.length, s.reduce((a, c) => a + c[2], 0) / s.length];
  }
  private footPoly(per: Perception, f: FootName): Vec2[] { return convexHull(per.feet[f].sole.map(h2)); }
  /** 발 원점을 목표 xz·yaw에 놓았을 때 바닥 꼭짓점 (xz) */
  private footprint(c: Readonly<Vec2>, yaw: number): Vec2[] {
    const q = fromAxisAngle(UP, yaw);
    const out: Vec2[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = rotate(q, [sx * this.footHalf[0], 0, sz * this.footHalf[2]]);
      out.push([c[0] + p[0], c[1] + p[2]]);
    }
    return out;
  }
  private yawOf(q: Readonly<Quat>): number { const f = rotate(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); }

  /**
   * 착지 목표 계획. swing = 내딛을 발, stance = 지지발, Tr = 착지까지 남은 시간.
   * ξ_td = p̄ + (ξ − p̄)e^{ωTr}, 목표 = ξ_td + overshoot·방향 + (넘어지는 방향에 수직인) 옆 간격, 제한·레이캐스트.
   */
  private plan(ctx: StepContext, swing: FootName, stance: FootName, Tr: number, allowCross: boolean, yaw: number, prev: Plan | null = null): Plan {
    const c = this.cfg;
    const per = ctx.per;
    const xi: Vec2 = [ctx.com[0] + ctx.vel[0] / ctx.omega, ctx.com[2] + ctx.vel[2] / ctx.omega];
    const S = this.footCenter(per, stance);
    const Ps = this.footPoly(per, stance);
    const edge = Ps.length >= 3 ? closestInPolygon(xi, Ps) : S;
    const pbar = add2(S, sc2(sub2(edge, S), c.cmpUse));
    const E = Math.exp(ctx.omega * Math.max(Tr, 0));
    const xiTd = add2(pbar, sc2(sub2(xi, pbar), E));
    const lat = h2(rotate(ctx.heading, [1, 0, 0])), fwd = h2(rotate(ctx.heading, [0, 0, 1]));
    const vh: Vec2 = [ctx.vel[0], ctx.vel[2]];
    const dir = norm2(len2(sub2(xiTd, pbar)) > 0.02 ? sub2(xiTd, pbar) : vh, fwd);
    const side = LEGJ[swing].side;
    // 넘어지는 방향에 수직인 옆 단위벡터 (스윙발 쪽)
    let perp: Vec2 = [-dir[1], dir[0]];
    if (dot2(perp, lat) * side < 0) perp = sc2(perp, -1);
    const perpW = Math.abs(dot2(perp, lat)); // 넘어지는 방향이 옆이면 0 → 옆 간격 없음
    const over = c.stepOvershoot + (this.jit?.over ?? 0);
    const base = add2(add2(xiTd, sc2(dir, over)), sc2([-dir[1], dir[0]], this.jit?.lat ?? 0));
    const xiGoalOf = (tgt: Vec2): Vec2 => sub2(tgt, sc2(dir, over));
    // 옆 간격 후보: 넓은 것부터, 착지 후 다각형 안 DCM 여유를 만족하는 첫 후보
    let best: Vec2 = base, bestMargin = -Infinity;
    for (const k of c.landingWidthSteps) {
      const cand = add2(base, sc2(perp, (k * c.nominalWidth * perpW) / 2));
      const hull = convexHull([...Ps, ...this.footprint(cand, yaw)]);
      const m = -signedDistanceToPolygon(xiGoalOf(cand), hull);
      if (m >= c.landingMargin) { best = cand; bestMargin = m; break; }
      if (m > bestMargin) { best = cand; bestMargin = m; }
    }
    const desired = best;
    let tgt: Vec2 = [desired[0], desired[1]];
    // 지지발 기준 좌표 (지지발 yaw — 몸 heading은 스텝 중 돌아 있을 수 있다): 옆 간격·교차
    const sYaw = this.yawOf(this.bodyRot(stance));
    const sLat: Vec2 = [Math.cos(sYaw), -Math.sin(sYaw)], sFwd: Vec2 = [Math.sin(sYaw), Math.cos(sYaw)];
    const rel = sub2(tgt, S);
    let rl = dot2(rel, sLat), rf = dot2(rel, sFwd);
    let crossing = false;
    if (side * rl < c.minFootSpacing) {
      if (allowCross && side * rl < 0) {
        crossing = true;
        rl = side * Math.max(-c.crossMax, side * rl);
        rf = Math.max(rf, c.crossFwd);
      } else rl = side * c.minFootSpacing;
    }
    tgt = add2(S, add2(sc2(sLat, rl), sc2(sFwd, rf)));
    // 보폭 제한 (지지발에서)
    const d = sub2(tgt, S);
    {
      // 방향별 보폭 한계 (지지발 기준 타원: 앞 maxStep.fwd, 뒤 maxStep.back, 옆 maxStepLength). 사람은 뒤로는 짧게, 옆으로는 넓게 딛는다
      const df = dot2(d, fwd), dl = dot2(d, lat);
      // 다친 다리(InjuredLeg)는 짧게 디딘다
      const inj = this.mods.injuredFoot === swing ? (this.mods.injuredStepScale ?? 1) : 1;
      const ff = (df >= 0 ? c.maxStep.fwd : c.maxStep.back) * inj;
      const e = Math.hypot(df / ff, dl / (c.maxStepLength * inj));
      if (e > 1) tgt = add2(S, sc2(d, 1 / e));
    }
    // 스윙 고관절에서 수평 도달 한계
    const hip = h2(this.hipPoint(swing));
    const dh = sub2(tgt, hip);
    if (len2(dh) > c.maxReach) tgt = add2(hip, sc2(dh, c.maxReach / len2(dh)));
    // 지지발과 겹치지 않게 (지지발 자신의 yaw 기준): 옆으로 minFootSpacing 안이고 앞뒤로 발 길이 안이면 겹침 →
    // 교차면 앞으로 crossFwd, 아니면 스윙발 쪽 옆으로 minFootSpacing. heading이 지지발 방향과 다를 때(몸이 돈 뒤) 발을 지지발 위에 겹쳐 놓아
    // 스윙발이 지지발에 얹혀 내려오지 못하던 문제
    {
      const sy = this.yawOf(this.bodyRot(stance));
      const sl: Vec2 = [Math.cos(sy), -Math.sin(sy)], sf: Vec2 = [Math.sin(sy), Math.cos(sy)];
      const d0 = sub2(tgt, S);
      let dl = dot2(d0, sl), df = dot2(d0, sf);
      if (Math.abs(dl) < c.minFootSpacing && Math.abs(df) < 2 * this.footHalf[2]) {
        if (crossing) df = Math.max(df, c.crossFwd);
        else dl = side * c.minFootSpacing;
        tgt = add2(S, add2(sc2(sl, dl), sc2(sf, df)));
      }
    }
    // (v0.8c, 결정 178) 다른 사람 발을 밟지 않게: 다른 사람 발 중심에서 otherFootClear m 안이면 지지발 쪽으로 걸음을 줄인다 (사람은 남의 발을 밟지 않고 짧게 딛는다).
    // 부딪힌 사람 발 바로 옆에 딛으면 발이 엉켜 붙은 채 떨어지지 못했다. 혼자인 월드는 사람이 없어 그대로
    if (c.otherFootClear) {
      const others = this.rd.pw.persons.filter((q) => q.bodies !== this.rd.bodies).flatMap((q) => q.bodies.filter((b) => b.name === 'LeftFoot' || b.name === 'RightFoot'));
      for (let k = 0; k < 10 && others.length; k++) {
        const near = others.some((b) => { const q = b.rb.translation(); return Math.hypot(q.x - tgt[0], q.z - tgt[1]) < c.otherFootClear!; });
        if (!near) break;
        tgt = add2(S, sc2(sub2(tgt, S), 0.85));
      }
    }
    // 레이캐스트: 지면 높이·법선. 못 디디면 목표를 지지발 쪽으로 줄여 다시
    const gStart = per.feet[stance].ground?.point[1] ?? 0;
    // (v0.8a) 평지가 아니면 발판 검사로 디딜 자리를 찾는다 (계단 디딤면 맞추기)
    if (this.terrainOn) {
      const fwd2 = h2(rotate(ctx.heading, [0, 0, 1])), lat2 = h2(rotate(ctx.heading, [1, 0, 0]));
      const r = this.terrainTarget(tgt, S, dir, yaw, gStart, swing, fwd2, lat2, prev?.foothold?.height ?? null);
      return { target: v3(r.xz, r.y), xiGoal: xiGoalOf(r.xz), clampDist: len2(sub2(desired, r.xz)), crossing, dir, foothold: r.fh, ...(r.void ? { void: true } : {}) };
    }
    let gy = gStart;
    for (let k = 0; k < 6; k++) {
      const g = castGround(this.rd.pw, [tgt[0], this.hipPoint(swing)[1], tgt[1]], 3);
      const okSlope = g && Math.acos(Math.max(-1, Math.min(1, g.normal[1]))) <= c.maxSlopeDeg * RAD;
      if (g && okSlope && Math.abs(g.point[1] - gStart) <= c.maxHeightDiff) { gy = g.point[1]; break; }
      tgt = add2(S, sc2(sub2(tgt, S), 0.8));
    }
    return { target: v3(tgt, gy), xiGoal: xiGoalOf(tgt), clampDist: len2(sub2(desired, tgt)), crossing, dir };
  }

  /**
   * (v0.8a) 지형 디딤 자리: 원하는 착지점 tgt에서 넘어지는 방향 dir을 따라 가까운 것부터(같은 거리면 앞쪽 먼저) 발판을 검사해
   * 디딜 수 있고(계단 모서리에 걸치지 않음) 높이 차가 범위 안이며 보폭 타원·고관절 도달 안인 첫 자리. 없으면 지지발 쪽으로 0.85배씩 줄여 다시.
   * 그래도 없으면(모서리 밖 허공 등) 원래 목표·지지발 지면 높이 (디딜 곳이 없다 — 넘어짐은 행동 계층이 맡는다)
   */
  private terrainTarget(tgt0: Vec2, S: Vec2, dir: Vec2, yaw: number, gStart: number, swing: FootName, fwd: Vec2, lat: Vec2, preferH: number | null = null): { xz: Vec2; y: number; fh: Foothold | null; void?: boolean } {
    const c = this.cfg, T = c.terrain!;
    const hip3 = this.hipPoint(swing);
    const hip = h2(hip3);
    const originY = hip3[1] + 0.3;
    const swingStartY = this.step?.foot === swing ? this.step.startGround : (this.lastPer?.feet[swing].ground?.point[1] ?? null);
    const inj = this.mods.injuredFoot === swing ? (this.mods.injuredStepScale ?? 1) : 1;
    const inside = (p: Vec2): boolean => {
      const d = sub2(p, S), df = dot2(d, fwd), dl = dot2(d, lat);
      const ff = (df >= 0 ? c.maxStep.fwd : c.maxStep.back) * inj;
      return Math.hypot(df / ff, dl / (c.maxStepLength * inj)) <= 1 + 1e-9 && len2(sub2(p, hip)) <= c.maxReach + 1e-9;
    };
    // 지지발 옆 간격 minFootSpacing 안은 안 됨 (평지 계획과 같은 규칙, 지지발 yaw 기준) — 붙여 디디면 스윙발이 지지 다리에 걸려 멈췄다
    const sy = this.yawOf(this.bodyRot(OTHER[swing]));
    const sl: Vec2 = [Math.cos(sy), -Math.sin(sy)], sf: Vec2 = [Math.sin(sy), Math.cos(sy)];
    const side = LEGJ[swing].side;
    const test = (p: Vec2): Foothold | null => {
      if (!inside(p)) return null;
      const d0 = sub2(p, S);
      if (side * dot2(d0, sl) < c.minFootSpacing - 1e-6) return null;
      const fh = probeFoothold(this.rd.pw, p, yaw, this.footHalf, originY, { ...T, maxSlopeDeg: c.maxSlopeDeg });
      if (!fh || !fh.steppable) return null;
      const dh = fh.height - gStart;
      if (dh > T.maxRise || dh < -T.maxDrop) return null;
      // 스윙발 자신의 출발 높이 기준으로도 (stepTo: 한 걸음에 한 단씩 — 비틀거리며 계단을 내려갈 때 사람은 두 발을 한 단에 모으며 내려간다)
      if (swingStartY !== null && T.maxDropFromSwing !== undefined && swingStartY - fh.height > T.maxDropFromSwing) return null;
      return fh;
    };
    const n = Math.round(T.search / T.searchStep);
    // 다시 계획할 때는 먼저 같은 디딤면(이전 목표 높이)에서 원하는 자리 preferRange m 안을 찾는다 — 두 단 사이에서 목표가 매 프레임 뒤집히면 스윙발이 갈피를 못 잡았다
    // 후보 순서: 원하는 자리에서 가까운 것부터, 뒤로(넘어지는 반대쪽) 줄이는 것은 backCost배 멀게 친다 — 포착점보다 짧은 걸음은 몸을 못 세운다
    const offs: number[] = [];
    for (let k = -n; k <= n; k++) offs.push(k * T.searchStep);
    const cost = (o: number) => (o < 0 ? -o * T.backCost : o);
    offs.sort((a, b) => cost(a) - cost(b) || b - a);
    for (const pass of preferH !== null ? [0, 1] : [1]) for (const o of offs) {
      const fh = test(add2(tgt0, sc2(dir, o)));
      if (!fh || (pass === 0 && (Math.abs(fh.height - preferH!) > T.levelTol || Math.abs(o) > T.preferRange))) continue;
      // 디딜 수 있는 구간(같은 디딤면)의 가운데로: 발판 경계에 딱 맞춘 목표는 착지 오차 몇 cm에 계단 코에 걸린다
      let lo = o, hi = o;
      const same = (x: number) => { const f = test(add2(tgt0, sc2(dir, x))); return f && Math.abs(f.height - fh.height) < T.levelTol ? f : null; };
      for (let i = 0; i < T.centerSteps && same(hi + T.searchStep); i++) hi += T.searchStep;
      for (let i = 0; i < T.centerSteps && same(lo - T.searchStep); i++) lo -= T.searchStep;
      const mid = Math.round((lo + hi) / 2 / T.searchStep) * T.searchStep;
      const p = add2(tgt0, sc2(dir, mid));
      return { xz: p, y: (same(mid) ?? fh).height, fh: same(mid) ?? fh };
    }
    // 원하는 자리 근처에 없으면(한 단 넘게 아래 등) 지지발 → 원하는 자리 선을 따라 먼 곳부터 searchStep 간격으로: 닿는 가장 먼 디딤면,
    // 그 디딤면 안에서는 선 방향 구간 가운데(뒤꿈치가 계단 코에서 떨어지게)
    // 선의 시작은 지지발 옆 서기 간격 자리 (지지발 중심에서 시작하면 옆 간격 규칙에 막혀 모두 떨어졌다)
    const B = add2(S, sc2(sl, side * c.nominalWidth));
    const D = sub2(tgt0, B), dl = len2(D);
    // 원하는 자리 아래가 낭떠러지(지지발보다 voidDrop m 넘게 낮음)이고 가장 먼 디딤면도 voidShort m 넘게 모자라면 허공으로 내딛는다:
    // 밀린 사람은 발밑을 보고 고르지 못하고 넘어지는 쪽으로 발을 내민다 — 제자리 발 고쳐 딛기로 버티면 발이 모서리에 붙은 채 몸만 앞으로 돌아 머리부터 떨어졌다
    const gVoid = castGround(this.rd.pw, [tgt0[0], originY, tgt0[1]], 8);
    const voidAhead = !!gVoid && gStart - gVoid.point[1] > T.voidDrop;
    if (dl > 1e-6) {
      const u = sc2(D, 1 / dl);
      for (let x = dl; x >= 0; x -= T.searchStep) {
        const fh = test(add2(B, sc2(u, x)));
        if (!fh) continue;
        let lo = x;
        for (let i = 0; i < 2 * T.centerSteps; i++) { const f2 = test(add2(B, sc2(u, lo - T.searchStep))); if (!f2 || Math.abs(f2.height - fh.height) > T.levelTol) break; lo -= T.searchStep; }
        const mid = Math.max(lo, x - T.centerSteps * T.searchStep, (lo + x) / 2);
        if (voidAhead && dl - mid > T.voidShort) break;
        const f3 = test(add2(B, sc2(u, mid))) ?? fh;
        return { xz: add2(B, sc2(u, mid)), y: f3.height, fh: f3 };
      }
    }
    // 디딜 곳이 없다 (모서리 밖 허공 등): 목표 아래 지면 높이 그대로 (넘어짐은 행동 계층이 맡는다)
    return { xz: tgt0, y: gVoid ? gVoid.point[1] : gStart, fh: null, void: voidAhead };
  }

  /** (v0.8a) 스윙 경로 아래 지면 높이 표본: 수평 진행 u = i/N 위치에서 발 길이 창(경로 방향 앞·가운데·뒤) 레이 최대 */
  private pathProfile(s: ActiveStep, target: Readonly<Vec3>): number[] {
    const T = this.cfg.terrain!;
    // 내려 딛는 스텝은 발끝을 내린 채(뒤꿈치가 들림) 내려간다 → 뒤꿈치 쪽 창을 줄인다 (발 길이 창 [−0.6L, L])
    const down = s.startGround - target[1] > T.levelTol;
    const key = `${s.start[0].toFixed(3)},${s.start[2].toFixed(3)}>${target[0].toFixed(3)},${target[2].toFixed(3)}${down ? 'd' : ''}`;
    if (s.prof && s.prof.key === key) return s.prof.g;
    const a = h2(s.start), b = h2(target);
    const d = norm2(sub2(b, a), [Math.sin(s.yaw), Math.cos(s.yaw)]);
    const L = this.footHalf[2];
    const oy = Math.max(s.start[1], target[1]) + 1.0;
    const g: number[] = [];
    for (let i = 0; i <= T.profileSamples; i++) {
      const p = add2(a, sc2(sub2(b, a), i / T.profileSamples));
      let m = -Infinity;
      for (const o of down ? [-L, 0, L] : [-L, 0, L]) {
        const r = castGround(this.rd.pw, [p[0] + d[0] * o, oy, p[1] + d[1] * o], 6);
        if (r) m = Math.max(m, r.point[1]);
      }
      g.push(Number.isFinite(m) ? m : target[1]);
    }
    s.prof = { key, g };
    return g;
  }

  /** 스윙 다리 선택 비용 (작을수록 좋음) */
  private legCost(ctx: StepContext, f: FootName, loadFrac: number, Tr: number): { cost: number; plan: Plan } {
    const c = this.cfg.legCost;
    const stance = OTHER[f];
    const yaw = this.yawOf(this.bodyRot(f));
    const lat = h2(rotate(ctx.heading, [1, 0, 0]));
    // 교차 안 하는 계획과 교차 계획을 둘 다 평가해 싼 쪽 (교차가 필요해도 옆으로 모으는 스텝이 나을 수 있다)
    let best: { cost: number; plan: Plan } | null = null;
    // 교차 스텝은 crossSteps가 켜졌을 때만 후보 (README 결정 68: 사람 레퍼런스 18개 후보에 교차 걸음이 없고, 교차 뒤 다리가 엉켜 푸는 걸음이 막힌다)
    for (const allowCross of this.cfg.crossSteps ? [false, true] : [false]) {
      const plan = this.plan(ctx, f, stance, Tr, allowCross, yaw);
      if (allowCross && !plan.crossing) continue;
      const dirSide = Math.max(0, dot2(plan.dir, sc2(lat, LEGJ[f].side)));
      const move = len2(sub2(h2(plan.target), this.footCenter(ctx.per, f)));
      // 거의 제자리인 스텝(발을 들었다 같은 자리에 놓음)은 지지만 잃는다 → 고르지 않는다
      const useless = move < this.cfg.minUsefulMove ? 10 : 0;
      // 하중을 거의 다 받은 발은 빨리 못 든다 (체중 이동에 0.3초 이상) → 크게 벌한다
      const heavy = loadFrac > c.heavyLoad ? c.heavyPenalty : 0;
      const injured = this.mods.injuredFoot === f ? (this.mods.injuredPenalty ?? 0) : 0;
      const cost = injured + useless + heavy + c.load * loadFrac + c.dir * (1 - dirSide) + c.cross * (plan.crossing ? 1 : 0) + c.reach * (move / this.cfg.maxStepLength) + c.clamp * plan.clampDist + this.legBias[f];
      if (!best || cost < best.cost) best = { cost, plan };
    }
    return best!;
  }

  /** (v0.8a) 지형: 높이 차 |dh| m를 오르내리는 데 더 드는 스윙 시간 (평지 0) */
  private heightTime(dh: number): number {
    return this.terrainOn ? this.cfg.terrain!.heightTime * Math.abs(dh) : 0;
  }

  private duration(dist: number): number {
    const d = this.cfg.duration;
    // 짧은 스텝은 min, 발이 refDist보다 멀리 가야 하면 swingSpeed(m/s)로 늘려 max까지 (발이 못 따라가 짧게 떨어지지 않게)
    const T = Math.min(d.max, d.min + Math.max(0, dist - d.refDist) / d.swingSpeed);
    return this.jit ? T * this.jit.dur : T;
  }

  /** Stagger 불규칙 지터 뽑기 (스텝마다). 불규칙이 꺼져 있으면 지터 없음 */
  private drawJitter(): void {
    const ir = this.mods.irregular;
    if (!ir || !this.staggerRng) { this.jit = null; return; }
    const u = () => 2 * this.staggerRng!.float() - 1;
    this.jit = { dur: 1 + ir.duration * u(), over: ir.overshoot * u(), lat: ir.lateral * u() };
  }

  private startStep(ctx: StepContext, foot: FootName, kind: StepKind, plan: Plan, airborne: boolean, ev: string): void {
    const c = this.cfg;
    const start = this.bodyPos(foot);
    const dist = len2(sub2(h2(plan.target), h2(start)));
    const T = kind === 'closing' ? c.settle.closeDuration : this.duration(dist) + this.heightTime(plan.target[1] - (ctx.per.feet[foot].ground?.point[1] ?? plan.target[1]));
    // 옆으로 넘어지는데 그쪽 발(하중이 실린 발)로 내딛을 때: 먼저 짧게 그 발 바깥쪽으로 CoP를 보내 COM을 늦춘 뒤(제동) 하중을 빼고 든다.
    // 바로 들면 CoP가 반대발로 넘어가 COM이 옆으로 가속된다 (lateral 0.8 m/s → 1.4 m/s)
    const lat = h2(rotate(ctx.heading, [1, 0, 0]));
    const sideF = Math.max(0, dot2(plan.dir, sc2(lat, LEGJ[foot].side)));
    const brake = airborne || kind !== 'reactive' ? 0 : c.brakeTime * clamp01((sideF - 0.6) / 0.4);
    const unload = airborne ? 0 : kind === 'closing' ? 0 : c.unloadTime + brake;
    const apex = kind === 'closing' ? c.settle.closeApex : c.apex.min + (c.apex.max - c.apex.min) * clamp01(dist / c.duration.refDist);
    this.step = {
      foot, stance: OTHER[foot], kind, t0: ctx.t, tLift: ctx.t + unload, tLand: ctx.t + unload + T, apex, start,
      startGround: ctx.per.feet[foot].ground?.point[1] ?? plan.target[1], yaw: this.yawOf(this.bodyRot(foot)), plan, frozen: false, allowCross: airborne, contactSince: null,
      shiftUntil: kind === 'closing' ? ctx.t + c.settle.shiftTime : ctx.t,
      brakeUntil: ctx.t + brake,
    };
    if (kind === 'closing') { this.step.tLift = Infinity; this.step.tLand = Infinity; }
    this.st = 'step';
    this.events.push({ type: 'stepStart', detail: `${foot} ${kind} ${ev}`, foot });
  }

  /** 매 스텝 한 번. 명령을 돌려준다(없으면 스텝 계층 쉼 = v0.3 균형 그대로). */
  update(ctx: StepContext): StepCommand | null {
    const c = this.cfg;
    const per = ctx.per;
    this.lastPer = per;
    const out = this.state = emptySteppingState();
    out.enabled = this.enabled;
    const xi: Vec2 = [ctx.com[0] + ctx.vel[0] / ctx.omega, ctx.com[2] + ctx.vel[2] / ctx.omega];
    out.cp = xi;
    const poly = per.supportPolygon;
    const cpOut = poly.length >= 3 ? signedDistanceToPolygon(xi, poly) : Infinity;
    out.cpOutside = cpOut;
    out.threshold = this.threshold;
    out.landings = this.landings.slice(-4);
    out.lastLandingError = this.landings.length ? this.landings[this.landings.length - 1]!.error : null;
    out.stepCount = this.count;
    out.staggerHandoff = this.stagger;
    if (ctx.balanceOn) { this.onSince ??= ctx.t; this.offSince = null; }
    else { this.onSince = null; this.offSince ??= ctx.t; }
    if (!this.enabled || !ctx.balanceOn) {
      // 균형이 꺼지면(넘어짐·Ragdoll) 스텝도 멈춘다. 잠깐(두 발이 함께 뜬 순간 등)은 상태를 유지한다
      if (this.st !== 'stand' && (!this.enabled || ctx.t - this.offSince! > c.offGrace)) { this.st = 'stand'; this.step = null; }
      out.state = 'stand';
      return null;
    }
    const contact = (f: FootName) => per.feet[f].contact;
    const loads = { LeftFoot: per.feet.LeftFoot.load, RightFoot: per.feet.RightFoot.load };
    const lsum = loads.LeftFoot + loads.RightFoot;
    const loadFrac = (f: FootName) => (lsum > 1e-6 ? loads[f] / lsum : 0.5);
    const speed = Math.hypot(ctx.vel[0], ctx.vel[2]);
    // 흔들림 구간: DCM이 다각형 안으로 돌아오면 다음 구간의 지터를 새로 뽑을 준비
    if (this.mods.newEpisode && this.st !== 'step' && this.count > 0) { this.count = 0; this.closings = 0; this.stagger = false; }
    if (cpOut < 0) this.episodeArmed = true;
    else if (this.episodeArmed && this.st === 'stand') { this.threshold = this.drawThreshold(); this.episodeArmed = false; out.threshold = this.threshold; }

    const chooseAndStart = (ev: string): boolean => {
      if (this.count >= Math.min(c.hardMaxSteps, this.mods.maxSteps ?? Infinity)) return false;
      this.drawJitter();
      if (this.count >= c.maxSteps && !this.stagger) {
        this.stagger = true;
        this.events.push({ type: 'stagger', detail: `steps=${this.count} cpOut=${cpOut.toFixed(3)}` });
      }
      const both = FOOT_NAMES.filter(contact);
      if (both.length === 0) return false;
      const cand = both.length === 2 ? FOOT_NAMES : FOOT_NAMES.filter((f) => !contact(f));
      if (!cand.length) return false;
      const Tr0 = c.unloadTime + this.duration(0.3);
      // 방금 착지한 발은 아직 하중을 받는 중: 하중 항은 '착지 직후 하중 이동이 끝났다'고 보고(지지발 = 방금 디딘 발), 같은 발을 바로 또 내딛는 것은 벌한다 (사람은 번갈아 딛는다)
      const lastFoot = this.st === 'settle' ? this.landings[this.landings.length - 1]?.foot : undefined;
      const costs = cand.map((f) => {
        const lf = lastFoot ? (f === lastFoot ? 1 : 0) : loadFrac(f);
        const r = this.legCost(ctx, f, lf, Tr0);
        const hs = this.handoverStance && ctx.t < this.handoverStance.until && this.handoverStance.foot === f ? 10 : 0;
        return { f, ...r, cost: r.cost + (f === lastFoot ? c.legCost.sameFoot : 0) + hs };
      });
      costs.sort((a, b) => a.cost - b.cost);
      const pick = costs[0]!;
      out.legCost = [costs.find((x) => x.f === 'LeftFoot')?.cost ?? NaN, costs.find((x) => x.f === 'RightFoot')?.cost ?? NaN];
      this.startStep(ctx, pick.f, "reactive", pick.plan, false, ev);
      this.step!.allowCross = pick.plan.crossing;
      return true;
    };

    // ── 상태 전이 ──
    if (this.liftReq && this.st === 'stand') {
      const f = this.liftReq.foot;
      const p0 = this.bodyPos(f);
      const fwd = rotate(ctx.heading, [0, 0, 1]);
      const hold = add(add(p0, [0, this.liftReq.height, 0]), scale(fwd, c.liftFoot.forward));
      this.step = {
        foot: f, stance: OTHER[f], kind: 'lift', t0: ctx.t, tLift: Infinity, tLand: Infinity, apex: this.liftReq.height, start: p0,
        startGround: per.feet[f].ground?.point[1] ?? 0, yaw: this.yawOf(this.bodyRot(f)),
        plan: { target: [p0[0], per.feet[f].ground?.point[1] ?? 0, p0[2]], xiGoal: h2(ctx.com), clampDist: 0, crossing: false, dir: [0, 1] },
        frozen: true, allowCross: false, contactSince: null, shiftUntil: ctx.t + c.liftFoot.shiftTime, hold: { p: hold, until: ctx.t + this.liftReq.duration },
      };
      this.st = 'lift';
      this.liftReq = null;
      this.events.push({ type: 'stepStart', detail: `${f} lift`, foot: f });
    }
    // 발 위치 기억 (서 있을 때 땅에 닿은 마지막 위치): 하중이 빠져 뜬 발을 다시 놓을 자리
    for (const f of FOOT_NAMES) if (contact(f)) this.lastGround[f] = this.bodyPos(f);
    // 제자리 버팀이 한계 근처에 오래 머물면(DCM이 다각형 가장자리 nearEdge m 안에 nearEdgeTime초) 내딛는다 — 사람은 버티다 몸이 기울어 고착되기 전에 한 발 내딛는다
    // 행동이 일부러 몸을 굽히는 동안(상처 움켜쥐기)은 그만큼 늦게 내딛는다 (mods.triggerRelax m) — 사람은 숙일 때 발끝까지 체중을 싣고 버틴다
    const relax = this.mods.triggerRelax ?? 0;
    if (this.st === 'stand' && cpOut > -c.nearEdge + relax) this.nearEdgeSince ??= ctx.t;
    else this.nearEdgeSince = null;
    const air = FOOT_NAMES.filter((f) => !contact(f));
    for (const f of FOOT_NAMES) this.airSince[f] = contact(f) ? null : (this.airSince[f] ?? ctx.t);
    if (this.st === 'stand') {
      const lingering = this.nearEdgeSince !== null && ctx.t - this.nearEdgeSince >= c.nearEdgeTime && speed > 0.02;
      if ((cpOut > this.threshold + relax || lingering) && ctx.t - (this.onSince ?? ctx.t) >= c.startupGrace) {
        this.count = 0; this.closings = 0; this.stagger = false; this.landings = [];
        chooseAndStart(`cpOut=${cpOut.toFixed(3)} thr=${this.threshold.toFixed(3)}`);
      } else if (air.length === 1 && ctx.t - this.airSince[air[0]!]! >= c.replaceAfter && this.lastGround[air[0]!]) {
        // 서 있는데 한 발이 떴다(하중이 빠져 들림): 스텝 계층이 그 발을 원래 자리에 다시 내려놓는다 (안 그러면 QP가 뜬 다리를 플라이휠로 휘두른다)
        const f = air[0]!;
        const g = this.lastGround[f]!;
        const gy = per.feet[OTHER[f]].ground?.point[1] ?? 0;
        this.startStep(ctx, f, 'closing', { target: [g[0], gy, g[2]], xiGoal: h2(ctx.com), clampDist: 0, crossing: false, dir: [0, 1] }, true, 'replace');
        this.step!.tLift = ctx.t; this.step!.tLand = ctx.t + c.settle.closeDuration; this.step!.apex = 0;
      }
    } else if (this.st === 'settle') {
      const tIn = ctx.t - this.landT;
      // 다음 스텝: 착지한 발이 튀어 아직 안 닿았으면 잠깐 기다린다 (그 발을 다시 드는 무의미한 스텝 방지)
      // 느리게 움직일 때(정착 막바지)는 더 많이 벗어나야 다시 내딛는다 — 제자리 종종걸음 방지 (사람은 거의 멈췄으면 발목·고관절로 버틴다)
      const reMargin = speed < c.slowRetrigger.speed ? c.slowRetrigger.margin : c.retriggerMargin;
      if (cpOut > reMargin && (tIn > c.retriggerMinTime || cpOut > c.retriggerUrgent) && (contact('LeftFoot') && contact('RightFoot') || tIn > 0.15)) {
        chooseAndStart(`settle cpOut=${cpOut.toFixed(3)}`);
      } else if (air.length === 1 && ctx.t - this.airSince[air[0]!]! >= c.replaceAfter && speed > c.settle.placeMaxSpeed) {
        // 몸이 아직 움직이는데(> placeMaxSpeed) 뒤쪽 발이 떴다: 서기 자리로 내려놓지 않고 그 발로 넘어지는 쪽에 반응 스텝 (스윙 중 다시 밀린 경우 등)
        const f = air[0]!;
        this.drawJitter();
        const plan = this.plan(ctx, f, OTHER[f], c.unloadTime + this.duration(0.3), false, this.yawOf(this.bodyRot(f)));
        this.startStep(ctx, f, 'reactive', plan, true, `airborne cpOut=${cpOut.toFixed(3)}`);
        this.step!.allowCross = false;
      } else if (air.length === 1 && ctx.t - this.airSince[air[0]!]! >= c.replaceAfter && cpOut <= reMargin) {
        // 정착 중 한 발이 떴다(디딘 뒤 뒤쪽 발이 끌려 들림): 다른 발 옆 서기 간격 자리로 내려놓는다 (안 그러면 뜬 다리를 QP가 휘두른다).
        // 교차 착지 뒤처럼 그 발이 다른 발 너머에 있으면 다시 건너가지 않고 지금 자리 아래로 내려놓는다.
        const f = air[0]!;
        const S = this.footCenter(per, OTHER[f]);
        const lat = h2(rotate(ctx.heading, [1, 0, 0]));
        const here = this.footCenter(per, f);
        const tgt = dot2(sub2(here, S), lat) * LEGJ[f].side < c.minFootSpacing ? here : add2(S, sc2(lat, LEGJ[f].side * c.nominalWidth));
        const gy = per.feet[OTHER[f]].ground?.point[1] ?? 0;
        this.startStep(ctx, f, 'closing', { target: v3(tgt, gy), xiGoal: h2(ctx.com), clampDist: 0, crossing: false, dir: [0, 1] }, true, 'place');
        // 멀리 옮겨야 하면(끌려간 뒤쪽 발) 발이 따라갈 수 있게 평균 placeSpeed m/s로 시간을 늘린다
        this.step!.tLift = ctx.t; this.step!.tLand = ctx.t + Math.max(c.settle.closeDuration, len2(sub2(tgt, here)) / c.settle.placeSpeed); this.step!.apex = c.settle.placeApex;
      } else if (speed < c.settle.stillSpeed && cpOut < 0) {
        this.stillSince ??= ctx.t;
        // 서기 자세와 먼 발 배치 → 뒤쪽(COM에서 먼) 발을 모으는 스텝
        const L = this.footCenter(per, 'LeftFoot'), R = this.footCenter(per, 'RightFoot');
        const lat = h2(rotate(ctx.heading, [1, 0, 0])), fwd = h2(rotate(ctx.heading, [0, 0, 1]));
        const d = sub2(L, R);
        const sag = Math.abs(dot2(d, fwd)), wid = dot2(d, lat);
        const needClose = sag > c.settle.closeSagittal || Math.abs(wid - c.nominalWidth) > c.settle.closeWidthTol;
        if (needClose && this.closings < c.settle.maxClosing && contact('LeftFoot') && contact('RightFoot')) {
          const cm = h2(ctx.com);
          const f: FootName = len2(sub2(L, cm)) > len2(sub2(R, cm)) ? 'LeftFoot' : 'RightFoot';
          const S = f === 'LeftFoot' ? R : L;
          const tgt = add2(S, sc2(lat, LEGJ[f].side * c.nominalWidth));
          const gy = per.feet[OTHER[f]].ground?.point[1] ?? 0;
          this.closings++;
          this.startStep(ctx, f, 'closing', { target: v3(tgt, gy), xiGoal: add2(S, sc2(lat, (LEGJ[f].side * c.nominalWidth) / 2)), clampDist: 0, crossing: false, dir: norm2(sub2(tgt, this.footCenter(per, f))) }, false, 'close');
        } else if (ctx.t - this.stillSince >= c.settle.standTime && (this.closings === 0 && !c.settle.recenter || len2(sub2(h2(ctx.com), polygonCentroid(poly) ?? h2(ctx.com))) < 0.02 && speed < 0.04 || tIn > 2.0)) {
          this.st = 'stand';
          this.count = 0;
          this.closings = 0;
          this.jit = null;
        }
      } else this.stillSince = null;
    }

    const cmd: StepCommand = { swingFoot: null, phase: null, unloadPenalty: 0, freezeLegs: [], armGain: 1, abductDeg: 0, resetComTarget: false, lungeDrop: 0, mode: this.st === 'settle' && !c.settle.stepMode ? 'settle' : 'step' };
    // 런지: 반응 스텝 중·직후(정착) COM 속도에 비례해 낮춘다
    if (this.st === 'step' && this.step?.kind === 'reactive' || this.st === 'settle' && this.count > 0) cmd.lungeDrop = Math.min(c.lunge.maxDrop, c.lunge.dropPerMs * speed);
    // (v0.8a) 아래로 내려 딛는 스텝: 지지 다리를 굽혀 COM을 낮춰야 스윙 다리가 아래 디딤면에 닿는다 (사람의 계단 내려가기)
    if (this.st === 'step' && this.step && this.terrainOn) {
      const gS = per.feet[this.step.stance].ground?.point[1];
      if (gS !== undefined) cmd.lungeDrop += Math.min(c.terrain!.descendMax, c.terrain!.descendGain * Math.max(0, gS - this.step.plan.target[1]));
    }
    if (this.st === 'settle') {
      cmd.freezeLegs = c.settle.freezeLegs ? [...FOOT_NAMES] : [];
      cmd.armGain = c.arms.stepGain;
      if ((this.closings > 0 || c.settle.recenter && cpOut < 0 && speed < c.settle.stillSpeed) && poly.length >= 3) {
        // 모으는 스텝 뒤: 두 발이 서기 간격이니 체중을 두 발 가운데로 되돌린다 (다리 고정 없이, 체중 이동 이득으로). 안 그러면 서기의 느린 COM 목표가 1초 넘게 끌며 옮긴다
        // 목표는 지금 COM에서 중심 쪽으로 recenterSpeed m/s 이하로 옮긴다 (한 번에 옮기면 0.1 m/s 넘는 쏠림이 1초 넘게 남는다 — 사람은 천천히 체중을 되돌린다)
        const cen = polygonCentroid(poly)!;
        const g0 = this.recenterGoal ?? h2(ctx.com);
        const d = sub2(cen, g0), dl = len2(d), mx = c.settle.recenterSpeed * ctx.dt;
        this.recenterGoal = dl > mx ? add2(g0, sc2(d, mx / dl)) : cen;
        cmd.comGoal = this.recenterGoal;
        if (!c.settle.recenterFreeze) cmd.freezeLegs = [];
        cmd.shifting = true;
      } else this.recenterGoal = null;
      this.fillState(out, null);
      return cmd;
    }
    if (this.st === 'stand' || !this.step) { this.fillState(out, null); return this.st === 'stand' ? null : cmd; }

    // ── 스텝 진행 ──
    const s = this.step;
    const lift = this.st === 'lift';
    // lift 중 밀림: 2단 스텝 (README 결정 68) — 든 발을 교차 없이 지지발 옆에 바로 내려 디디고(하중 받기), 다음 스텝에서 지지발을 넘어지는 쪽으로 옮긴다.
    // 사람 레퍼런스(push_side_single_support_step)도 교차 걸음 없이 이렇게 한다. 교차 스텝은 다리가 엉켜 푸는 걸음이 막혔다
    if (lift && ctx.t >= s.tLift && !contact(s.foot)) {
      const stancePoly = this.footPoly(per, s.stance);
      const cpS = signedDistanceToPolygon(xi, stancePoly);
      if (cpS > this.threshold + 0.03) {
        const Tr = this.duration(0.3);
        let plan = this.plan(ctx, s.foot, s.stance, Tr, false, s.yaw);
        // 지지발 쪽으로 넘어지면: 든 발을 지지발 바로 뒤(downBack m)에 내린다 — COM 아래 가까이 디뎌 하중을 받을 수 있게(옆 간격을 지키면 COM에서 멀어 지렛대가 된다).
        // 앞뒤로 떨어져 있어 다리가 엉키지 않는다 (사람 레퍼런스: 왼발 28cm 뒤에 오른발)
        const S0 = this.footCenter(per, s.stance);
        const sy = this.yawOf(this.bodyRot(s.stance));
        const sLat: Vec2 = [Math.cos(sy), -Math.sin(sy)], sFwd: Vec2 = [Math.sin(sy), Math.cos(sy)];
        const downBehind = dot2(sub2(xi, S0), sLat) * LEGJ[s.foot].side < 0;
        if (downBehind) {
          const tgt = add2(S0, sc2(sFwd, -c.liftFoot.downBack));
          const gy = per.feet[s.stance].ground?.point[1] ?? 0;
          plan = { target: v3(tgt, gy), xiGoal: tgt, clampDist: 0, crossing: false, dir: norm2(sub2(xi, S0)) };
        }
        this.count = 0; this.closings = 0; this.stagger = false; this.landings = [];
        this.startStep(ctx, s.foot, 'reactive', plan, true, `from lift cpOut=${cpS.toFixed(3)}`);
        this.step!.start = this.bodyPos(s.foot);
        this.step!.allowCross = false;
        if (downBehind) { this.step!.frozen = true; this.step!.pinned = true; } // 정한 자리(지지발 뒤)에 그대로 내린다
        return this.update({ ...ctx });
      }
    }
    // 하중 옮기기 (closing·lift): 스윙발 하중이 빠지면 떼기
    // 하중 옮기기 끝: 감지 DCM이 지지발 위(+ shiftTol)로 왔고 스윙발 하중이 빠졌을 때 (또는 시간 초과)
    const shifted = signedDistanceToPolygon(xi, this.footPoly(per, s.stance)) < c.settle.shiftTol && loadFrac(s.foot) < c.settle.shiftLoad && speed < c.settle.shiftMaxSpeed;
    if (s.kind === 'closing' && s.tLift === Infinity) {
      if (shifted) {
        s.tLift = ctx.t;
        s.tLand = ctx.t + c.settle.closeDuration;
        s.start = this.bodyPos(s.foot);
      } else if (ctx.t >= s.shiftUntil) {
        // 체중이 지지발로 다 못 옮겨졌다: 모으는 스텝은 꼭 필요한 스텝이 아니므로 들지 않고 그만둔다 (억지로 들면 DCM이 지지발 밖이라 넘어진다)
        this.step = null;
        this.st = 'settle';
        this.stillSince = null;
        const cmd2: StepCommand = { swingFoot: null, phase: null, unloadPenalty: 0, freezeLegs: c.settle.freezeLegs ? [...FOOT_NAMES] : [], armGain: c.arms.stepGain, abductDeg: 0, resetComTarget: true, lungeDrop: 0, mode: 'settle' };
        this.fillState(out, null);
        return cmd2;
      }
    }
    // lift: 하중이 빠졌거나(지지발 쪽 하중 비율) 시간이 넘으면 든다
    const liftReady = lift && (shifted || ctx.t >= s.shiftUntil);
    if (lift && liftReady && s.tLift === Infinity) { s.tLift = ctx.t; s.shiftUntil = ctx.t; s.start = this.bodyPos(s.foot); }
    const inUnload = ctx.t < s.tLift;
    const Tsw = s.tLand - s.tLift;
    const sProg = Number.isFinite(Tsw) && Tsw > 0 ? (ctx.t - s.tLift) / Tsw : 0;
    // (v0.8a) 헛디딤: 낭떠러지로 내딛는 스윙이 반을 넘으면(발이 모서리 너머) 행동 계층에 알린다 — 균형·스텝을 끄고 몸이 떨어지게
    if (s.plan.void && !s.voidSent && sProg >= c.terrain!.voidNotifyS) { this.events.push({ type: 'voidStep', detail: `${s.foot} s=${sProg.toFixed(2)}`, foot: s.foot }); s.voidSent = true; }
    // 매 프레임 다시 계획 (push_while_stepping), 착지 직전엔 고정
    if (s.kind === 'reactive' && !s.frozen) {
      const Tr = Math.max(s.tLand - ctx.t, c.minRemaining);
      s.plan = this.plan(ctx, s.foot, s.stance, Tr, s.allowCross, s.yaw, s.plan);
      // 목표가 멀어지면(DCM이 계속 커짐) 스텝 시간도 다시 정한다 — 처음 정한 짧은 시간으로는 발이 못 따라가 짧게 떨어진다
      if (Number.isFinite(s.tLift)) s.tLand = Math.max(s.tLand, s.tLift + this.duration(len2(sub2(h2(s.plan.target), h2(s.start)))) + this.heightTime(s.plan.target[1] - s.startGround));
      if (sProg >= c.replanUntil) s.frozen = true;
    } else if (s.kind === 'reactive' && s.frozen && !s.pinned && c.lateReplan && sProg < c.lateReplan.until) {
      // 고정 뒤라도 스윙 중 새로 밀려(감지 지연 뒤 알게 됨) 목표가 lateReplan.jump m 넘게 바뀌면 다시 계획한다 — 사람도 스윙 중 발을 옮겨 딛는다
      // (레퍼런스 push_side_during_step: 스윙 중 옆으로 밀리면 그 발을 옆으로 넓게 딛는다). 시간은 필요하면 늘린다
      const Tr = Math.max(s.tLand - ctx.t, c.minRemaining);
      const p2 = this.plan(ctx, s.foot, s.stance, Tr, s.allowCross, s.yaw, s.plan);
      if (len2(sub2(h2(p2.target), h2(s.plan.target))) > c.lateReplan.jump) {
        s.plan = p2;
        if (Number.isFinite(s.tLift)) s.tLand = Math.max(s.tLand, s.tLift + this.duration(len2(sub2(h2(s.plan.target), h2(s.start)))) + this.heightTime(s.plan.target[1] - s.startGround));
      }
    }
    // SIMBICON 피드백: 넘어지는 방향으로 스윙 고관절을 더 돌린다 → 발 목표가 고관절 둘레로 이동
    let target = s.plan.target;
    let simDeg = 0;
    // (v0.8a) 지형에서는 SIMBICON 목표 돌리기를 하지 않는다: 발판 검사로 맞춘 디딤 자리(계단 디딤면 가운데)를 몇 cm 옮겨 계단 코에 걸리게 했다
    if (s.kind === 'reactive' && !this.terrainOn) {
      const stAnk = this.bodyPos(s.stance);
      const dHor = dot2(sub2(h2(ctx.com), h2(stAnk)), s.plan.dir);
      const vHor = dot2([ctx.vel[0], ctx.vel[2]], s.plan.dir);
      const th = Math.max(-c.simbicon.maxDeg * RAD, Math.min(c.simbicon.maxDeg * RAD, c.simbicon.cd * dHor + c.simbicon.cv * vHor));
      simDeg = th / RAD;
      if (Math.abs(th) > 1e-6) {
        const hip = this.hipPoint(s.foot);
        const ax = normalize(cross(UP, v3(s.plan.dir)));
        const r = rotate(fromAxisAngle(ax, th), sub(target, hip));
        target = [hip[0] + r[0], target[1], hip[2] + r[2]];
      }
    }
    out.simbiconDeg = simDeg;

    // 착지 감지: 스윙 중 접촉 + 하중 (또는 접촉 유지)
    // 스윙 초반 접촉(발끝 끌림)은 착지가 아니다: 진행 touchdownMinS 이상이거나 목표 근처에서만
    const nearTarget = len2(sub2(h2(this.bodyPos(s.foot)), h2(target))) < c.touchdownNear;
    if (!inUnload && s.kind !== 'lift' && (sProg >= c.touchdownMinS || (sProg > 0.3 && nearTarget))) {
      // (v0.8a) 지형: 스윙 중 지나가는 계단 코에 스친 것은 착지가 아니다 — 목표 디딤면 높이(± 0.05 m)의 접촉점이 있어야 착지
      const onTarget = !this.terrainOn || per.contacts.some((k) => k.body === s.foot && Math.abs(k.point[1] - target[1]) < 0.05);
      if (contact(s.foot) && onTarget) {
        s.contactSince ??= ctx.t;
        if (loads[s.foot] >= c.touchdownLoad || ctx.t - s.contactSince >= c.touchdownHold) {
          const p = this.footCenter(per, s.foot);
          const err = len2(sub2(p, h2(target)));
          const rec: LandingRecord = { foot: s.foot, t: ctx.t, p, target: h2(target), error: err, kind: s.kind };
          this.landings.push(rec);
          if (s.kind === 'reactive') this.count++;
          // 걸음으로 셈: 실제로 발을 옮겨 놓은 것만 (들었다 제자리에 놓은 것은 셈하지 않음)
          const moved = len2(sub2(p, h2(s.start))) >= c.countMinMove;
          this.events.push({ type: moved ? 'step' : 'footReplace', detail: `${s.foot} ${s.kind} err=${err.toFixed(3)} moved=${len2(sub2(p, h2(s.start))).toFixed(3)}`, foot: s.foot, error: err });
          this.step = null;
          this.st = 'settle';
          this.landT = ctx.t;
          this.stillSince = null;
          cmd.resetComTarget = true;
          if (!c.settle.stepMode) cmd.mode = 'settle';
          else cmd.freezeLegs = [...FOOT_NAMES];
          this.fillState(out, null);
          out.landings = this.landings.slice(-4);
          out.lastLandingError = err;
          out.stepCount = this.count;
          return cmd;
        }
      } else s.contactSince = null;
    }
    // lift: 유지 시간이 끝나면 제자리에 내려놓기
    if (lift && s.hold && ctx.t >= s.hold.until) {
      s.kind = 'closing'; s.tLift = ctx.t; s.tLand = ctx.t + c.settle.closeDuration; s.start = this.bodyPos(s.foot); s.apex = 0.0;
      this.st = 'step';
    }

    cmd.swingFoot = s.foot;
    cmd.armGain = s.kind === 'reactive' ? c.arms.stepGain : 1;
    cmd.abductDeg = s.kind === 'reactive' ? Math.min(c.arms.maxAbductDeg, c.arms.abductDegPerMs * speed) : 0;
    cmd.freezeLegs = [s.stance];
    const stanceC = this.footCenter(per, s.stance);
    if (inUnload) {
      cmd.phase = 'unload';
      // 하중 빼는 동안 스윙발은 아직 땅에 있다: 두 다리 모두 지금 자세를 목표로 (서기 포즈로 당기면 디딘 다리가 몸을 민다)
      cmd.freezeLegs = [...FOOT_NAMES];
      const k = s.kind === 'reactive' ? 1 : smooth((ctx.t - s.t0) / Math.max(1e-3, c.settle.shiftTime * 0.7));
      // 반응 스텝만 하중을 벌해 뺀다. 모으기·들기는 COM을 지지발 위로 옮겨 하중이 저절로 빠지게(벌하면 CoP가 앞발에만 가 COM을 못 붙잡는다)
      const braking = s.kind === 'reactive' && ctx.t < (s.brakeUntil ?? 0);
      cmd.shifting = s.kind !== 'reactive';
      cmd.unloadPenalty = s.kind === 'reactive' && !braking ? c.unloadPenalty * Math.max(0.05, k) : 0;
      if (s.kind !== 'reactive') {
        const cen = this.footCenter(per, s.foot);
        // 두 발 가운데에서 지지발 쪽으로 shiftFraction만큼 (들기는 거의 지지발 위로)
        const mid = sc2(add2(cen, stanceC), 0.5);
        cmd.comGoal = add2(mid, sc2(sub2(stanceC, mid), s.kind === 'lift' ? 0.95 : c.settle.shiftFraction));
      } else if (!braking) {
        cmd.dcmGoal = { xi: s.plan.xiGoal, T: Math.max(s.tLand - ctx.t, c.minRemaining) };
      }
    } else {
      cmd.phase = 'swing';
      cmd.swing = this.swingRef(ctx, s, target, sProg, lift);
      cmd.legTargets = this.legIK(s.foot, add(cmd.swing.p, scale(cmd.swing.v, c.swing.ikLookahead)), cmd.swing.rot, ctx.heading);
      if (s.kind === 'reactive') cmd.dcmGoal = { xi: s.plan.xiGoal, T: Math.max(s.tLand - ctx.t, c.minRemaining) };
      else cmd.comGoal = s.kind === 'lift' ? stanceC : add2(stanceC, sc2(sub2(h2(target), stanceC), 0.5));
    }
    this.fillState(out, { s: Math.max(0, sProg), target, kind: s.kind, foot: s.foot, phase: cmd.phase, crossing: s.plan.crossing, xiGoal: s.plan.xiGoal, T: Number.isFinite(Tsw) ? Tsw : 0 });
    if (this.terrainOn) out.terrain = { dh: target[1] - (per.feet[s.stance].ground?.point[1] ?? target[1]), supported: s.plan.foothold?.supported ?? 0, void: !!s.plan.void };
    out.state = this.st;
    return cmd;
  }

  private fillState(out: SteppingState, a: { s: number; target: Vec3; kind: StepKind; foot: FootName; phase: 'unload' | 'swing' | null; crossing: boolean; xiGoal: Vec2; T: number } | null): void {
    out.state = this.st;
    out.stepCount = this.count;
    out.staggerHandoff = this.stagger;
    if (!a) return;
    out.swingFoot = a.foot; out.phase = a.phase; out.kind = a.kind; out.target = a.target; out.s = a.s; out.crossing = a.crossing; out.xiGoal = a.xiGoal; out.duration = a.T;
  }

  /** 스윙발 원점 기준 참조 (위치·속도·가속도, 방향) */
  private swingRef(ctx: StepContext, s: ActiveStep, target: Vec3, sProg: number, lift: boolean): NonNullable<StepCommand['swing']> {
    const c = this.cfg;
    const p = this.bodyPos(s.foot), v = this.bodyVel(s.foot);
    const half = this.footHalf[1];
    const gTgt = target[1];
    // 방향: 발바닥 = 지면 법선, yaw는 들 때 그대로
    const g = castGround(this.rd.pw, [target[0], p[1] + 0.5, target[2]], 3);
    const n = g ? g.normal : UP;
    let rot = multiplyQ(fromTo(UP, n), fromAxisAngle(UP, s.yaw));
    // (v0.8a) 내려 딛기: 발끝을 내린다(사람의 계단 내려가기 — 발끝으로 먼저 닿고 뒤꿈치를 내림). 스윙 0.2~0.5에 들어가 1.0~1.15에 평평하게
    if (this.terrainOn && s.kind !== 'lift') {
      const drop = s.startGround - gTgt;
      if (drop > c.terrain!.levelTol) {
        const sp = Math.max(0, (ctx.t - s.tLift) / Math.max(1e-3, s.tLand - s.tLift));
        // 발끝 내리기는 발이 위 디딤면 코를 넘어간 뒤(수평 진행 0.55~0.8)에 — 일찍 내리면 발끝이 위 디딤면에 끌렸다
        const uu = clamp01((sp - c.swing.hStart) / (1 - c.swing.hStart - c.swing.hEnd)), b2 = 3 * uu * uu - 2 * uu * uu * uu;
        const env = smooth((b2 - 0.55) / 0.25) * (1 - smooth((sp - 1.0) / 0.15));
        const th = Math.min(c.terrain!.toePitchMaxDeg, c.terrain!.toePitchPerM * drop) * RAD * env;
        if (th > 1e-4) rot = multiplyQ(fromTo(UP, n), multiplyQ(fromAxisAngle(UP, s.yaw), fromAxisAngle([1, 0, 0], th)));
      }
    }
    if (lift && s.hold) {
      // 들고 유지: 하중을 옮긴 뒤 hold 점까지 부드럽게
      const k = smooth((ctx.t - s.shiftUntil) / 0.3);
      const pd = add(s.start, scale(sub(s.hold.p, s.start), k));
      return { p: pd, v: [0, 0, 0], a: [0, 0, 0], rot, usePD: { h: true, v: true } };
    }
    const Tsw = Math.max(1e-3, s.tLand - s.tLift);
    const sc = Math.max(0, sProg);
    // 수평: 3차 베지어 (P0 = P1 = 시작, P2 = P3 = 목표) = 시작 + (목표 − 시작)(3u² − 2u³), 양 끝 속도 0.
    // u는 스윙 진행 s를 [hStart, 1 − hEnd]로 늘린 것: 발이 먼저 뜨고, 끝에서는 목표 위에 선 뒤 내려온다. 목표가 바뀌면(재계획) 곡선 끝이 따라간다
    const hs = c.swing.hStart, he = c.swing.hEnd;
    const u = clamp01((sc - hs) / (1 - hs - he));
    const du = sc > hs && sc < 1 - he ? 1 / ((1 - hs - he) * Tsw) : 0;
    const bz = 3 * u * u - 2 * u * u * u, dbz = (6 * u - 6 * u * u) * du, ddbz = (6 - 12 * u) * du * du;
    const ph: Vec3 = [s.start[0] + (target[0] - s.start[0]) * bz, 0, s.start[2] + (target[2] - s.start[2]) * bz];
    const vh: Vec3 = [(target[0] - s.start[0]) * dbz, 0, (target[2] - s.start[2]) * dbz];
    const ah: Vec3 = [(target[0] - s.start[0]) * ddbz, 0, (target[2] - s.start[2]) * ddbz];
    // 교차 스텝: 지지 다리와 부딪히지 않게 앞으로 돌아간다 (경로 가운데 앞쪽 혹 crossBulge·4u(1−u))
    // (계획이 교차가 아니어도 시작과 목표가 지지발의 서로 다른 옆에 있으면 경로가 지지 다리를 지나간다 → 같이 돌아간다)
    const sy = this.yawOf(this.bodyRot(s.stance));
    const sLat: Vec2 = [Math.cos(sy), -Math.sin(sy)];
    const sp = h2(this.bodyPos(s.stance));
    const passes = dot2(sub2(h2(s.start), sp), sLat) * dot2(sub2(h2(target), sp), sLat) < 0;
    if (s.plan.crossing || passes) {
      // 목표가 지지발 뒤면 뒤로 돌아간다 (2단 스텝의 '지지발 뒤에 내리기')
      const back = dot2(sub2(h2(target), sp), [Math.sin(sy), Math.cos(sy)]) < 0 ? -1 : 1;
      const fw: Vec3 = [back * Math.sin(sy), 0, back * Math.cos(sy)];
      const b = c.crossBulge, bb = 4 * u * (1 - u), dbb = (4 - 8 * u) * du, ddbb = -8 * du * du;
      for (const k of [0, 2] as const) { ph[k] += fw[k] * b * bb; vh[k] += fw[k] * b * dbb; ah[k] += fw[k] * b * ddbb; }
    }
    // 수직: 지면 사이 보간 + 높이 혹 apex·16s²(1−s)² (양 끝 속도 0) − 끝에서 살짝 눌러 접촉, s ≥ 1이면 일정 속도로 내려감
    let y: number, vy: number, ay: number;
    if (sc < 1) {
      const gl = s.startGround + (gTgt - s.startGround) * smooth(sc);
      // 높이 혹: 'plateau'면 빨리 들어(진행 rise) 유지하고 끝 fall 구간에서 내린다(발이 목표 위에 온 뒤 내려 일찍 닿지 않게), 아니면 대칭 16s²(1−s)²
      const pl = c.swing.plateau;
      let bump: number, dbump: number, ddbump: number;
      if (pl) {
        const hf = (x: number): number => s.apex * smooth(x / pl.rise) * smooth((1 - x) / pl.fall);
        const e = 1e-3;
        bump = hf(sc);
        dbump = (hf(Math.min(1, sc + e)) - hf(Math.max(0, sc - e))) / (Math.min(1, sc + e) - Math.max(0, sc - e)) / Tsw;
        ddbump = (hf(Math.min(1, sc + e)) - 2 * bump + hf(Math.max(0, sc - e))) / (e * e) / (Tsw * Tsw);
      } else {
        bump = 16 * s.apex * sc * sc * (1 - sc) * (1 - sc);
        dbump = (16 * s.apex * (2 * sc * (1 - sc) * (1 - sc) - 2 * sc * sc * (1 - sc))) / Tsw;
        ddbump = (16 * s.apex * (2 * (1 - sc) * (1 - sc) - 8 * sc * (1 - sc) + 2 * sc * sc)) / (Tsw * Tsw);
      }
      y = gl + half + bump - 0.008 * smooth(sc); vy = dbump; ay = ddbump;
      // (v0.8a) 지형: 발바닥이 경로 아래 지면(계단 코·장애물) + clearance보다 위에 있게 (수치 미분). 평지는 그대로
      if (this.terrainOn) {
        const T = c.terrain!, prof = this.pathProfile(s, target);
        const pathLen = Math.max(0.05, len2(sub2(h2(target), h2(s.start))));
        // 실제 발의 경로 진행 uAct: 발이 기준보다 뒤처지면(몸이 앞으로 쏠려 수평이 늦음) 그 자리의 요구 높이로 붙든다 — 기준 위치로만 높이를 정하면
        // 뒤처진 발이 먼저 내려가 위 디딤면 코에 걸렸다
        const pa = h2(p), pathD = sub2(h2(target), h2(s.start));
        const uAct = clamp01(dot2(sub2(pa, h2(s.start)), pathD) / Math.max(1e-6, dot2(pathD, pathD)));
        // clearance는 경로 아래 지면이 시작·목표 지면을 잇는 직선보다 튀어나온 곳(계단 코·장애물)에만 (평평한 경사면은 0): 직선 위 edgeTol m에서 다 줌
        const N = T.profileSamples;
        const clrAt = prof.map((g, i) => T.clearance * smooth((g - (prof[0]! + (prof[N]! - prof[0]!) * (i / N))) / T.edgeTol));
        const reqAt = (u: number, k: number): number => {
          let m = -Infinity;
          for (let i = 0; i <= N; i++) m = Math.max(m, prof[i]! + k * clrAt[i]! - T.maxClimbSlope * pathLen * Math.abs(u - i / N));
          return m;
        };
        let yAct = reqAt(uAct, 1) + half;
        // 지금 발 바닥 꼭짓점(실제 방향)이 그 아래 지면보다 cornerClear m 위에 있게 — 발이 기울어 뒤꿈치·발끝이 경사면·디딤면을 긁으면(접촉 마찰로 스윙이 멈춤)
        // 원점 높이만 맞춰서는 못 뗀다. 스윙 가운데(진행 0.1~0.8)에만
        {
          const sole = ctx.per.feet[s.foot].sole;
          const w = smooth((sc - 0.05) / 0.1) * (1 - smooth((sc - 0.7) / 0.15));
          if (w > 0) for (const cn of sole) {
            const g = castGround(this.rd.pw, [cn[0], cn[1] + 0.5, cn[2]], 1.5);
            if (g) yAct = Math.max(yAct, g.point[1] + (p[1] - cn[1]) + T.cornerClear * w);
          }
        }
        const yAt = (x: number): number => {
          const sx = clamp01(x);
          const uu = clamp01((sx - hs) / (1 - hs - he));
          const b2 = 3 * uu * uu - 2 * uu * uu * uu;
          // 요구 높이 = 표본마다 (지면 + 거리 비례로 내려가는 원뿔)의 최대 — 연속이고 기울기가 maxClimbSlope 이하 (계단 모서리에서 기준 높이가 한 스텝에 튀면
          // 수치 미분 속도가 수십 m/s가 되어 다리가 폭발했다)
          const gw = reqAt(b2, smooth(sx / 0.2));
          // 내려 딛기: 높이는 수평 진행의 뒤 절반에 내린다 (발이 디딤면 위에 온 뒤 내려가야 목표보다 짧게 떨어지지 않는다)
          const g2 = s.startGround + (gTgt - s.startGround) * (gTgt < s.startGround - T.levelTol ? smooth((b2 - T.downStart) / (1 - T.downStart)) : smooth(sx));
          // 지형에서는 스윙 높이를 minApex 이상으로 (경사면을 가로지르는 모으기·내려놓기 걸음의 낮은 높이로는 발 뒤꿈치가 오르막 쪽 지면을 긁었다)
          const ap = Math.max(s.apex, T.minApex);
          const bp = pl ? ap * smooth(sx / pl.rise) * smooth((1 - sx) / pl.fall) : 16 * ap * sx * sx * (1 - sx) * (1 - sx);
          const base = g2 + half + bp - 0.008 * smooth(sx);
          // clearance는 떼는 순간 0에서 들어오고(계단 높이로 한 번에 튀지 않게) clearFadeStart부터 0으로
          return Math.max(base, gw + half, sx > 0.2 ? yAct : -Infinity);
        };
        const e = 2e-3;
        const y0 = yAt(sc), yp = yAt(Math.min(1, sc + e)), ym = yAt(Math.max(0, sc - e));
        const de = Math.min(1, sc + e) - Math.max(0, sc - e);
        y = y0; vy = (yp - ym) / de / Tsw; ay = (yp - 2 * y0 + ym) / (e * e) / (Tsw * Tsw);
        ay = Math.max(-60, Math.min(60, ay));
      }
    } else {
      const ld = this.terrainOn ? c.terrain!.landDescentSpeed : c.landDescentSpeed;
      y = gTgt + half - 0.008 - ld * (ctx.t - s.tLand); vy = -ld; ay = 0;
    }
    return { p: [ph[0], y, ph[2]], v: [vh[0], vy, vh[2]], a: [ah[0], ay, ah[2]], rot, usePD: { h: true, v: true } };
  }

  /** 스윙 다리 2관절 IK: 고관절점은 지금, 발 원점 목표·방향 → 고관절·무릎·발목 관절 목표 */
  legIK(foot: FootName, footPos: Readonly<Vec3>, footRot: Readonly<Quat>, heading: Readonly<Quat>): JointTargets {
    const L = LEGJ[foot];
    const H = this.hipPoint(foot);
    const A = add(footPos, rotate(footRot, this.ankleInFoot[foot]));
    const fwd = rotate(heading, [0, 0, 1]);
    const { mid: K } = solveTwoBone(H, A, this.lThigh, this.lShin, fwd);
    const u = normalize(sub(K, H)), sdir = normalize(sub(A, K));
    // 무릎 축: heading 옆축을 허벅지·정강이 평면 법선 쪽으로 (굽힘 방향이 앞으로 가게)
    const aLat = rotate(heading, this.kneeAxis[foot]);
    let a = cross(u, sdir);
    if (length(a) < 1e-4) a = sub(aLat, scale(u, dot(aLat, u)));
    a = normalize(a);
    if (dot(a, aLat) < 0) a = scale(a, -1);
    const frameQ = (dLocal: Vec3, axLocal: Vec3, dW: Vec3, axW: Vec3): Quat => {
      const x0 = normalize(dLocal), y0 = normalize(sub(axLocal, scale(x0, dot(axLocal, x0)))), z0 = cross(x0, y0);
      const y1 = normalize(sub(axW, scale(dW, dot(axW, dW)))), z1 = cross(dW, y1);
      const Ml = fromColumns(x0, y0, z0), Mw = fromColumns(dW, y1, z1);
      // Q = Mw · Mlᵀ
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) { let s = 0; for (let k = 0; k < 3; k++) s += Mw[r * 3 + k]! * Ml[cc * 3 + k]!; m[r * 3 + cc] = s; }
      return toQuat(m as never);
    };
    const kneeAnchorChild = this.def.bodies.find((b) => b.name === L.knee)!.joint!.anchorInChild as Vec3;
    const qThigh = frameQ(sub(this.kneeInThigh[foot], this.hipAnchor[foot]), this.kneeAxis[foot], u, a);
    const qShin = frameQ(sub(this.ankleInShin[foot], kneeAnchorChild), this.kneeAxis[foot], sdir, a);
    const jd = (n: JointName) => this.def.bodies.find((b) => b.name === n)!.joint!;
    const rel = (qParent: Quat, n: JointName, qChild: Quat): Quat => multiplyQ(multiplyQ(conjugate(multiplyQ(qParent, jd(n).frameInParent)), qChild), jd(n).frameInChild);
    const qHips = this.bodyRot('Hips');
    return { [L.hip]: rel(qHips, L.hip, qThigh), [L.knee]: rel(qThigh, L.knee, qShin), [L.ankle]: rel(qShin, L.ankle, [...footRot] as Quat) };
  }
}
