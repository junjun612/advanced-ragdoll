// 애니메이션 추종 걷기 (SPEC v0.6 '애니메이션 추종 걷기'). 정의: docs/ALGORITHMS.md v0.6.
// 전신 운동량 QP(v0.3, wbqp.ts)를 클립 기준값으로 돌린다 — 핀 없이 걷는 것이 목표다:
// - 접촉 일정: 클립 발 접촉 + 실제 접촉. 지지발 = 접촉 제약(평평 6행 / 발끝·뒤꿈치 선 둘레 회전 5행, 실제 발바닥 꼭짓점으로 판정,
//   클립이 뒤꿈치를 드는 구간이면 발끝 지지로 바꿔 뒤꿈치 들기를 허용) + 클립 발 방향 과제(구르기). 스윙발 = 클립 발 궤적·방향 과제.
// - COM: DCM 추종 ξ = c + v/ω, 원하는 CMP p = p_ref + (1 + kXi/ω)(ξ − ξ_ref) (p_ref = 클립 CMP), 지지 다각형 + cmpOutside로 자름
//   → 수평 힘 Mω²(c − p). 수직 = 클립 COM 높이 PD + 피드포워드. 각운동량 = 클립 각운동량 쪽으로 감쇠(낮은 가중치).
// - 발 디딤 수정(SIMBICON·캡처 포인트 방식): 스윙 중 착지 때 DCM 오차 예측 e_td를 착지점에 더한다(지지발 CoP가 이미 고치는 몫 제외).
// - 기준 좌표: 디딘 발이 평평해지면 앵커를 그 발에 맞춘다(클립 디딤 자세 ↔ 실제 발) — 오차가 쌓이지 않고 기준이 지지발 상대가 된다.
// - 위상: 실제 착지가 클립 착지보다 이르거나 늦으면 재생 속도로 천천히 맞추고(phase.corrTime), 클립이 착지했는데 발이 아직 떠 있으면 늦춘다.
// - 몸통·골반 = 클립(행동이 바꾼 목표 포함) 방향 PD + 피드포워드 각속도, 관절 자세 = 클립 목표 + 피드포워드 관절 속도.
// - 모터: 모든 관절 'plan'(QP 계획의 이번 스텝 끝 자세·속도, README 결정 55). 토크 = 역동역학.
// - 큰 외란(DCM 오차 > handover.dcmError 등)이면 걷기 추종을 놓고 v0.4 균형·스텝 계층(비틀거림)에 넘긴다(Character가 다시 붙인다).
import type { Ragdoll, RagdollJoint } from './ragdoll';
import type { CharacterDef } from './characterDef';
import { forwardKinematics, type JointName, type JointTargets } from './pose';
import { type Perception, type FootName, FOOT_NAMES } from './perception';
import type { ContactPoint } from './contactQP';
import type { AnimDriver, AnimRef } from './animDriver';
import type { BalanceBehaviorInput, BalanceCommand, BalanceState } from './balance';
import type { HandName } from './behaviors/types';
import { type Vec3, add, sub, scale, cross, dot, length, normalize } from '../math/vec3';
import { type Quat, conjugate, fromAxisAngle, fromTo, identityQ, multiplyQ, rotate, toRotationVector } from '../math/quat';
import { convexHull, signedDistanceToPolygon, closestPointOnSegment, pointInConvexPolygon, type Vec2 } from '../math/geometry';
import { solveWholeBodyQP } from '../dynamics/wbqp';
import { WholeBody, wrenchAt, ang, lin, add6, type V6 } from '../dynamics/wholeBody';

export interface WalkConfig {
  enabled: boolean;
  /** 지연 예측에 측정 지면력을 쓴다 (README 결정 56과 같은 방식) */
  predictMeasured: boolean;
  /** 걷기 추종 중 충돌을 끌 바디 쌍 (스윙발 ↔ 반대 다리) */
  legNoCollide: [string, string][];
  /** 피격·밀기 뒤 legNoCollideReactHold초 동안 추가로 끌 쌍 (교차 디딤에서 정강이·허벅지 엇갈림) */
  legNoCollideReact: [string, string][];
  legNoCollideReactHold: number;
  com: { kXi: number; kpV: number; kdV: number; cmpOutside: number; maxHorizontalForce: number; dcmPlan: boolean; dcmPlanLateralOnly: boolean; cmpOffset: number };
  angMom: { damping: number };
  wLin: number;
  /** 수평 선운동량 행 배율 (수직 = 1) */
  wLinH: number;
  /** 큰 DCM 오차에서 수평 힘 가중치 배율 (오차 e0 → e1 m에서 1 → wLinHScale) */
  react: { e0: number; e1: number; wLinHScale: number };
  wAng: number;
  regularization: number;
  footKv: number;
  mu: number;
  minNormal: number;
  copMargin: number;
  regRho: number;
  smoothRho: number;
  torso: { kp: number; kd: number; weight: number };
  pelvis: { kp: number; kd: number; weight: number };
  posture: { kp: number; kd: number; stanceLeg: number; swingLeg: number; spine: number; arms: number; head: number };
  armAccelReg: number;
  handAccelReg: number;
  swing: { kp: number; kd: number; weight: number; rotKp: number; rotKd: number; rotWeight: number; clearance: number; landDescentSpeed: number; earlyLandS: number; earlyLandDist: number; earlyLiftoff: number; liftoffLift: number; liftoffSpeed: number; landBlendStart: number; landSlope: number; landSlopeMax: number };
  stanceFoot: { rotKp: number; rotKd: number; rotWeight: number; settleGain: number; settleKp: number; heelUpH: number; soleContactDist: number };
  footPlacement: { gain: number; gainLat: number; maxFwd: number; maxBack: number; maxLat: number; minWidth: number; freezeS: number; lateUntil: number; lateJump: number; crossFwd: number; crossMax: number; expCapT: number; pathKeep: [number, number] };
  phase: { baseRate?: number; mode: 'touchdown' | 'state'; kState: number; corrTime: number; minRate: number; maxRate: number; waitRate: number; maxWait: number; syncWindow: number; rateTau: number; reachS: number; reachDist: number; reachRate: number; boostS: number; boostE0: number; boostGain: number; boostMax: number; lagE0: number; lagGain: number; boostAnyClip?: boolean };
  limitAvoid: { marginDeg: number; kp: number; kd: number; weight: number };
  handover: { dcmError: number; dcmErrorHard: number; deferSwingS: number; maxTiltDeg: number; minComHeight: number; noContactTime: number; /** (v0.8a) 스윙 뒤쪽 발 아래 지면이 지지 지면보다 이만큼(m) 넘게 낮으면(낭떠러지) 넘김 */ voidDrop?: number; /** (v0.8a) 스윙발 접촉 법선의 세로 성분이 이 값보다 작으면(장애물 옆면에 걸림) 넘김 */ tripNormalY?: number };
  motorScale: number;
}

export type FootMode = 'stance' | 'landing' | 'liftoff' | 'swing';
export type ContactMode = 'flat' | 'toe' | 'heel' | 'none';

/** 로그·시각화 (CharacterState.walk) */
export interface WalkState {
  engaged: boolean;
  clip: string;
  tau: number;
  phase: number;
  rate: number;
  feet: Record<FootName, { mode: FootMode; contact: ContactMode; s: number; delta: Vec2; target: Vec3 | null; swingAcc?: { des: number[]; plan: number[]; pd: Vec3 } }>;
  /** DCM 오차 ξ − ξ_ref (xz, m) */
  dcmError: Vec2;
  /** 기준 DCM (xz) */
  xiRef: Vec2;
  /** 원하는 CMP (자르기 전/후) */
  cmpDes: Vec2;
  cmpUsed: Vec2;
  /** 클립 COM (월드) */
  comRef: Vec3;
  landings: { foot: FootName; t: number; p: Vec2; target: Vec2; error: number; phaseErr: number }[];
  /** 마지막 넘김 이유 */
  handover: string | null;
  anchor: { yaw: number; pos: Vec3 };
}

const RAD = Math.PI / 180;
const UP: Vec3 = [0, 1, 0];
const OTHER: Record<FootName, FootName> = { LeftFoot: 'RightFoot', RightFoot: 'LeftFoot' };
const LEG: Record<FootName, { hip: JointName; knee: JointName; ankle: JointName; side: 1 | -1 }> = {
  LeftFoot: { hip: 'LeftUpLeg', knee: 'LeftLeg', ankle: 'LeftFoot', side: 1 },
  RightFoot: { hip: 'RightUpLeg', knee: 'RightLeg', ankle: 'RightFoot', side: -1 },
};
const smoothstep = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const dsmooth = (x: number): number => (x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x));

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

/** 다각형 밖 lim 넘는 점을 경계 + lim 안으로 */
function clipToPolygon(p: Readonly<Vec2>, poly: readonly Vec2[], lim: number): Vec2 {
  if (poly.length < 3) return poly.length ? closestInPolygon(p, poly) : [p[0], p[1]];
  const d = signedDistanceToPolygon(p, poly);
  if (d <= lim) return [p[0], p[1]];
  const q = closestInPolygon(p, poly);
  const k = lim / d;
  return [q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k];
}

/** 균형 계층이 넘기는 공용 도구 (Balance 메서드) */
export interface BalanceHelpers {
  flatAnkle(f: FootName, per: Perception): Quat | null;
  clampToLimits(jn: JointName, qChildDes: Readonly<Quat>, margin: number): Quat;
  looseOf(beh: BalanceBehaviorInput | null, body: string): number;
  handBusy(beh: BalanceBehaviorInput | null, body: string): number;
}

export interface WalkContext {
  t: number;
  dt: number;
  per: Perception;
  /** 감지(지연 + 예측) COM·속도 */
  com: Vec3;
  vel: Vec3;
  /** 지금(지연 없는) COM */
  comNow: Vec3;
  totalMass: number;
  gravity: Vec3;
  targetsIn: JointTargets | null;
  beh: BalanceBehaviorInput | null;
  ref: AnimRef;
  anim: AnimDriver;
  /** 핀 보조 렌치 (바디별, 월드, 질량 중심) — QP가 외부 렌치로 안다 */
  pinWrench: { f: Vec3; tau: Vec3 }[] | null;
  st: BalanceState;
  helpers: BalanceHelpers;
}

export class WalkController {
  engaged = true;
  state: WalkState;
  private readonly wb: WholeBody;
  private readonly jointsByName = new Map<string, RagdollJoint>();
  private prevMode: Record<FootName, FootMode | null> = { LeftFoot: null, RightFoot: null };
  /** (v0.8a) 넘김 원인이 된 발 (헛디딤·걸림) */
  handoverFoot: FootName | null = null;
  private delta: Record<FootName, Vec2> = { LeftFoot: [0, 0], RightFoot: [0, 0] };
  /** 이번 지지 구간에 앵커를 맞췄는가 */
  private anchored: Record<FootName, boolean> = { LeftFoot: true, RightFoot: true };
  private landingSince: Record<FootName, number | null> = { LeftFoot: null, RightFoot: null };
  private phaseDebt = 0;
  /** 스윙발 수평 추종 오차 (직전 스텝, m) */
  private swingErr: Record<FootName, number> = { LeftFoot: 0, RightFoot: 0 };
  private rate = 1;
  /** 이번 스윙에서 실제로 떠 있었는가 (착지 이벤트 판정: 키네마틱에서 넘어온 첫 접촉은 착지가 아니다) */
  private swung: Record<FootName, boolean> = { LeftFoot: false, RightFoot: false };
  /** 접촉이 하나도 없던 시작 (키네마틱에서 막 넘어오면 한두 스텝 접촉이 비어 있다) */
  private noContactSince: number | null = null;
  private prevBeta: Map<string, number[]> | undefined;
  private landings: WalkState['landings'] = [];
  private readonly spine2Idx: number;

  constructor(readonly rd: Ragdoll, readonly def: CharacterDef, public cfg: WalkConfig) {
    this.wb = new WholeBody(rd);
    for (const j of rd.joints) this.jointsByName.set(j.name, j);
    this.spine2Idx = def.bodies.findIndex((b) => b.name === 'Spine2');
    this.state = this.emptyState();
  }

  private emptyState(): WalkState {
    const f = () => ({ mode: 'stance' as FootMode, contact: 'none' as ContactMode, s: 1, delta: [0, 0] as Vec2, target: null });
    return { engaged: this.engaged, clip: '', tau: 0, phase: 0, rate: 1, feet: { LeftFoot: f(), RightFoot: f() }, dcmError: [0, 0], xiRef: [0, 0], cmpDes: [0, 0], cmpUsed: [0, 0], comRef: [0, 0, 0], landings: [], handover: null, anchor: { yaw: 0, pos: [0, 0, 0] } };
  }

  /** 다시 붙일 때 (위상 맞춘 뒤) 상태를 비운다 */
  reset(): void {
    this.prevMode = { LeftFoot: null, RightFoot: null };
    this.delta = { LeftFoot: [0, 0], RightFoot: [0, 0] };
    this.anchored = { LeftFoot: true, RightFoot: true };
    this.landingSince = { LeftFoot: null, RightFoot: null };
    this.phaseDebt = 0;
    this.rate = 1;
    this.prevBeta = undefined;
    this.noContactSince = null;
    this.swung = { LeftFoot: false, RightFoot: false };
  }

  private bodyPos(name: string): Vec3 { const t = this.rd.body(name as never).rb.translation(); return [t.x, t.y, t.z]; }
  private bodyRot(name: string): Quat { const q = this.rd.body(name as never).rb.rotation(); return [q.x, q.y, q.z, q.w]; }

  /** 발바닥 꼭짓점 높이 (지면 기준) */
  private soleHeights(per: Perception, f: FootName): number[] {
    const fp = per.feet[f], g = fp.ground;
    return fp.sole.map((c) => (g ? dot(sub(c, g.point), g.normal) : c[1]));
  }

  /**
   * 한 스텝. 걷기 추종을 계속할 수 없으면(큰 외란 등) engaged = false로 두고 null — 균형 계층이 v0.4 경로로 넘어간다.
   */
  update(ctx: WalkContext): { targets: JointTargets | null; cmd: BalanceCommand; achievedForce: Vec3 } | null {
    const cfg = this.cfg, rd = this.rd, ref = ctx.ref, per = ctx.per, beh = ctx.beh;
    const st = ctx.st;
    const ws = this.state = this.emptyState();
    ws.clip = ref.clip; ws.tau = ref.tau; ws.phase = ref.phase; ws.rate = ctx.anim.rate;
    ws.anchor = { yaw: ctx.anim.anchor.yaw, pos: [...ctx.anim.anchor.pos] as Vec3 };
    ws.landings = this.landings.slice(-6);
    ws.comRef = ref.com;
    const M = ctx.totalMass;
    const g = length(ctx.gravity);
    const gh = per.groundHeight ?? ctx.anim.anchor.pos[1];
    const hRef = Math.max(0.3, ref.com[1] - gh);
    const omega = Math.sqrt(g / hRef);

    // ── 넘김 조건 (큰 외란·자세 무너짐) ──
    const s2q = this.bodyRot('Spine2');
    const tilt = Math.acos(Math.max(-1, Math.min(1, rotate(s2q, UP)[1]))) / RAD;
    const xi: Vec2 = [ctx.com[0] + ctx.vel[0] / omega, ctx.com[2] + ctx.vel[2] / omega];
    // 기준 DCM과 CMP: 클립 디딤 순서로 DCM을 거꾸로 계획한다(Englsberger식, 디딤마다 CMP = 디딘 발 중심 + cmpOffset).
    // Kimodo COM은 동역학적으로 맞지 않아(옆 COM 가속도가 우리 발 밖 CMP를 요구) 그대로 따르면 옆으로 넘어갔다.
    // 디딤이 하나뿐인 클립(Idle)은 클립 COM·속도·가속도(CMP)를 그대로 쓴다
    let xiRef: Vec2, pRef: Vec2;
    const seq = ref.steps;
    if (cfg.com.dcmPlan && seq.length >= 3 && Number.isFinite(seq[1]!.start)) {
      const hd = ctx.anim.anchor.yaw;
      const off: Vec2 = [Math.sin(hd) * cfg.com.cmpOffset, Math.cos(hd) * cfg.com.cmpOffset];
      const r = seq.map((q) => [q.plant.pos[0] + off[0], q.plant.pos[2] + off[1]] as Vec2);
      const rate = Math.max(0.2, ctx.anim.rate);
      let xe: Vec2 = r[r.length - 1]!;
      for (let k = r.length - 2; k >= 1; k--) {
        const Tk = Math.max(0.05, (seq[k + 1]!.start - seq[k]!.start) / rate);
        const E = Math.exp(-omega * Tk);
        xe = [r[k]![0] + E * (xe[0] - r[k]![0]), r[k]![1] + E * (xe[1] - r[k]![1])];
      }
      const E0 = Math.exp(-omega * Math.max(0, (seq[1]!.start - ref.tau) / rate));
      xiRef = [r[0]![0] + E0 * (xe[0] - r[0]![0]), r[0]![1] + E0 * (xe[1] - r[0]![1])];
      pRef = r[0]!;
      if (cfg.com.dcmPlanLateralOnly) {
        // 옆 성분만 계획을 쓰고 앞뒤는 클립 COM (앞뒤 클립 COM은 우리 발로 따라갈 수 있었다)
        const xc: Vec2 = [ref.com[0] + ref.comVel[0] / omega, ref.com[2] + ref.comVel[2] / omega];
        const pc: Vec2 = [ref.com[0] - ref.comAcc[0] / (omega * omega), ref.com[2] - ref.comAcc[2] / (omega * omega)];
        const fw: Vec2 = [Math.sin(hd), Math.cos(hd)];
        const mix = (a: Vec2, b: Vec2): Vec2 => { const d = (b[0] - a[0]) * fw[0] + (b[1] - a[1]) * fw[1]; return [a[0] + d * fw[0], a[1] + d * fw[1]]; };
        xiRef = mix(xiRef, xc);
        pRef = mix(pRef, pc);
      }
    } else {
      xiRef = [ref.com[0] + ref.comVel[0] / omega, ref.com[2] + ref.comVel[2] / omega];
      pRef = [ref.com[0] - ref.comAcc[0] / (omega * omega), ref.com[2] - ref.comAcc[2] / (omega * omega)];
    }
    ws.xiRef = xiRef;
    const e: Vec2 = [xi[0] - xiRef[0], xi[1] - xiRef[1]];
    ws.dcmError = e;
    const anyContact = FOOT_NAMES.some((f) => per.feet[f].contact);
    if (anyContact) this.noContactSince = null;
    let why: string | null = null;
    // (v0.8a) 헛디딤: 스윙 뒤쪽(s ≥ deferSwingS)이거나 착지 대기인 발 아래가 낭떠러지면 클립을 놓는다 (클립은 평지라 발을 허공의 디딤 높이에 붙들었다)
    const voidFoot = this.rd.pw.flat || cfg.handover.voidDrop === undefined ? undefined : FOOT_NAMES.find((f) => {
      const g = per.feet[f].ground;
      return !per.feet[f].contact && (this.prevMode[f] === 'swing' || this.prevMode[f] === 'landing') && ref.feet[f].s >= cfg.handover.deferSwingS && (!g || g.point[1] < gh - cfg.handover.voidDrop!);
    });
    // (v0.8a) 걸림: 스윙 중인 발이 옆면(법선이 수평에 가까움)에 닿음 — 장애물에 발끝이 걸렸다
    const tripFoot = this.rd.pw.flat || cfg.handover.tripNormalY === undefined ? undefined : FOOT_NAMES.find((f) => this.prevMode[f] === 'swing' && per.contacts.some((c) => c.body === f && Math.abs(c.normal[1]) < cfg.handover.tripNormalY!));
    this.handoverFoot = voidFoot ?? tripFoot ?? null;
    if (beh?.balanceMode === 'off') why = 'balanceOff';
    else if (voidFoot) why = 'void';
    else if (tripFoot) why = 'trip';
    else if (!anyContact && ctx.t - (this.noContactSince ??= ctx.t) > cfg.handover.noContactTime) why = 'noContact';
    else if (tilt > cfg.handover.maxTiltDeg + (beh?.tiltAllowDeg ?? 0)) why = `tilt ${tilt.toFixed(0)}`;
    else if (ctx.com[1] - gh < cfg.handover.minComHeight) why = 'low';
    else if (Math.hypot(e[0], e[1]) > cfg.handover.dcmError) {
      // 스윙발이 스윙 뒤쪽(s ≥ deferSwingS)이면 그 발이 디딜 때까지 넘기지 않는다 (dcmErrorHard 전까지): 교차 디딤 막바지에 넘기면
      // 스텝 계층이 교차를 모르고 발을 반대쪽으로 되돌려 넘어졌다 (walk_push_side)
      const em = Math.hypot(e[0], e[1]);
      const landingSoon = FOOT_NAMES.some((f) => (this.prevMode[f] === 'swing' || this.prevMode[f] === 'landing') && ref.feet[f].s >= cfg.handover.deferSwingS);
      if (!landingSoon || em > cfg.handover.dcmErrorHard) why = `dcm ${em.toFixed(2)}`;
    }
    if (why) {
      this.engaged = false;
      ws.engaged = false;
      ws.handover = why;
      return null;
    }

    // ── 발 상태 ──
    const mode = {} as Record<FootName, FootMode>;
    for (const f of FOOT_NAMES) {
      const cs = ref.feet[f].stance, ac = per.feet[f].contact;
      // 이른 착지: 스윙 막바지(s ≥ earlyLandS)에 착지점 earlyLandDist 안에서 닿으면 지지로 (스윙 중간에 발끝이 쓸린 것은 착지가 아니다)
      const near = Math.hypot(this.bodyPos(f)[0] - ref.feet[f].plant.pos[0] - this.delta[f][0], this.bodyPos(f)[2] - ref.feet[f].plant.pos[2] - this.delta[f][1]) < cfg.swing.earlyLandDist;
      // 지지 구간인데 닿지 않음: 스윙하던 발이면 착지 대기(landing), 지지하던 발이 떼기 직전에 일찍 떴으면(earlyLiftoff초 안) 그냥 떼기
      const early = !this.swung[f] && ref.feet[f].tEnd - ref.tau < cfg.swing.earlyLiftoff;
      mode[f] = cs ? (ac ? 'stance' : early ? 'liftoff' : 'landing') : ac ? (this.prevMode[f] !== 'liftoff' && this.prevMode[f] !== null && ref.feet[f].s >= cfg.swing.earlyLandS && (near || this.prevMode[f] === 'stance') ? 'stance' : 'liftoff') : 'swing';
    }
    // 마지막 지지를 떼지 않는다: 지지발이 하나도 없는데 닿은 발이 있으면 그 발로 버틴다 (다른 발 착지가 늦음)
    if (!FOOT_NAMES.some((f) => mode[f] === 'stance')) for (const f of FOOT_NAMES) if (per.feet[f].contact && this.prevMode[f] === 'stance') mode[f] = 'stance';
    // 착지 이벤트: 위상 맞추기·착지 기록
    for (const f of FOOT_NAMES) {
      const pm = this.prevMode[f];
      // 실제 스윙 = 클립이 스윙 구간이고 발이 떠 있음 (떼기 직전 일찍 떴다가 다시 닿는 것은 같은 지지)
      if (mode[f] === 'swing' && !ref.feet[f].stance) this.swung[f] = true;
      if (mode[f] === 'stance' && this.swung[f]) {
        this.swung[f] = false;
        const fr = ref.feet[f];
        // 클립 착지 시각: 클립이 아직 스윙이면 다음 착지, 이미 지지면 지금 구간 시작
        const tTd = fr.tTd;
        const pe = Number.isFinite(tTd) ? tTd - ref.tau : 0;
        // 클립 착지와 가까울 때만 맞춘다 (멀면 다른 발 주기와 엇갈린 것 — 무시)
        if (Math.abs(pe) <= cfg.phase.syncWindow) this.phaseDebt = pe;
        const p = this.bodyPos(f);
        const tgt = add(fr.plant.pos, [this.delta[f][0], 0, this.delta[f][1]]);
        const err = Math.hypot(p[0] - tgt[0], p[2] - tgt[2]);
        this.landings.push({ foot: f, t: ctx.t, p: [p[0], p[2]], target: [tgt[0], tgt[2]], error: err, phaseErr: pe });
        if (this.landings.length > 40) this.landings.shift();
        this.anchored[f] = false;
      }
      // 새 스윙 시작(지지 → 떼기·스윙)에서만 디딤 수정을 비운다 (스윙 중 발끝이 쓸려 떼기↔스윙을 오가도 유지)
      if ((mode[f] === 'swing' || mode[f] === 'liftoff') && pm === 'stance') this.delta[f] = [0, 0];
      this.landingSince[f] = mode[f] === 'landing' ? (this.landingSince[f] ?? ctx.t) : null;
    }
    // 위상: 착지 오차를 corrTime에 걸쳐 재생 속도로 갚는다. 클립은 착지했는데 발이 아직 떠 있으면 늦춘다(maxWait까지)
    let rate = 1;
    if (cfg.phase.mode === 'state') {
      // 상태 기반 위상(시간 늘리기): 몸이 기준보다 걷는 방향으로 앞서면(DCM 오차) 클립을 빨리, 뒤처지면 느리게 — 기준이 몸의 진행을 따라간다
      const hy = ctx.anim.anchor.yaw;
      const vF = ref.comVel[0] * Math.sin(hy) + ref.comVel[2] * Math.cos(hy);
      const eF = e[0] * Math.sin(hy) + e[1] * Math.cos(hy);
      if (Math.abs(vF) > 0.2) rate = 1 + cfg.phase.kState * eF * Math.sign(vF) / Math.max(0.3, Math.abs(vF) / ctx.anim.rate);
      rate = Math.max(cfg.phase.minRate, Math.min(cfg.phase.maxRate, rate));
    } else {
      const adj = Math.max(cfg.phase.minRate - 1, Math.min(cfg.phase.maxRate - 1, this.phaseDebt / cfg.phase.corrTime));
      rate += adj;
      this.phaseDebt -= adj * ctx.dt;
    }
    // 스윙하던 발이 클립 착지 뒤에도 떠 있으면 기다린다 (다른 발이 지지 중일 때만, maxWait까지)
    if (FOOT_NAMES.some((f) => mode[f] === 'landing' && this.swung[f] && mode[OTHER[f]] === 'stance' && ctx.t - (this.landingSince[f] ?? ctx.t) < cfg.phase.maxWait)) rate = Math.min(rate, cfg.phase.waitRate);
    // 큰 DCM 오차(외란)에서 다음 걸음을 서두른다: 스윙발이 스윙 앞쪽(s < boostS)이거나 두 발이 다 딛고 있으면 재생 속도를 올린다
    {
      // 오차를 클립 진행 방향 성분(앞 +)과 옆 성분으로 나눈다: 뒤처짐(앞 성분 −)은 서두르면 오히려 커진다 — 대신 클립을 늦춘다(lag)
      const cv = Math.hypot(ref.comVel[0], ref.comVel[2]);
      const dir: Vec2 = cv > 0.2 ? [ref.comVel[0] / cv, ref.comVel[2] / cv] : [Math.sin(ctx.anim.anchor.yaw), Math.cos(ctx.anim.anchor.yaw)];
      const eF = e[0] * dir[0] + e[1] * dir[1], eL = -e[0] * dir[1] + e[1] * dir[0];
      const em = Math.hypot(eL, Math.max(0, eF));
      if (cv > 0.2 && -eF > cfg.phase.lagE0) rate = Math.max(cfg.phase.minRate, Math.min(rate, 1 - cfg.phase.lagGain * (-eF - cfg.phase.lagE0)));
      const early = FOOT_NAMES.every((f) => mode[f] === 'stance' || ref.feet[f].s < cfg.phase.boostS);
      // (걷기 시작 클립 등 루프가 아닌 클립에서는 서두르지 않는다: 시작 전 무게 옮기기를 건너뛰어 첫 스윙에 옆으로 넘어졌다)
      if (early && em > cfg.phase.boostE0 && (ctx.anim.clip?.loop || cfg.phase.boostAnyClip)) rate = Math.max(rate, Math.min(cfg.phase.boostMax, 1 + cfg.phase.boostGain * (em - cfg.phase.boostE0)));
    }
    // 스윙 막바지에 발이 목표(디딤 + 수정)에서 아직 멀면 클립을 늦춰 발이 닿을 시간을 준다 (스윙 중 밀려 착지점이 크게 바뀐 경우)
    for (const f of FOOT_NAMES) {
      if (mode[f] !== 'swing' || ref.feet[f].s < cfg.phase.reachS) continue;
      if (this.swingErr[f] > cfg.phase.reachDist) rate = Math.min(rate, cfg.phase.reachRate);
    }
    rate *= cfg.phase.baseRate ?? 1;
    // 재생 속도는 부드럽게 (속도가 갑자기 바뀌면 기준 COM 속도가 튀어 DCM 오차가 튄다)
    this.rate += (rate - this.rate) * (1 - Math.exp(-ctx.dt / cfg.phase.rateTau));
    ctx.anim.rate = this.rate;
    ws.rate = this.rate;

    // 지지발 접촉 방식 (실제 꼭짓점 + 클립 뒤꿈치 들기)
    const sd = cfg.stanceFoot.soleContactDist;
    const cmode = {} as Record<FootName, ContactMode>;
    for (const f of FOOT_NAMES) {
      if (mode[f] !== 'stance') { cmode[f] = 'none'; continue; }
      const h = this.soleHeights(per, f);
      const heel = h[0]! < sd && h[1]! < sd, toe = h[2]! < sd && h[3]! < sd;
      const clipHeelUp = ref.feet[f].heelH > cfg.stanceFoot.heelUpH && ref.feet[f].toeDown;
      cmode[f] = heel && toe ? (clipHeelUp ? 'toe' : 'flat') : toe ? 'toe' : heel ? 'heel' : 'flat';
      // 앵커: 디딘 발이 처음 평평해지면 그 발에 맞춘다 (xz만, 클립 디딤 자세 ↔ 실제)
      if (!this.anchored[f] && cmode[f] === 'flat') {
        this.anchored[f] = true;
        // 앵커를 옮기는 양 = 실제 − 클립 디딤 − (일부러 옮긴 디딤 수정 Δ × pathKeep). 옆 Δ까지 앵커로 흡수하면 기준이 발을 따라
        // 옆으로 밀려 COM 옆 오차가 고쳐지지 않고 비스듬히 걸어간다(경로 이탈). 앞뒤 Δ는 속도·위상 차이라 흡수한다
        const p = this.bodyPos(f), pl = ref.feet[f].plant.pos;
        const a = ctx.anim.anchor;
        const d = this.delta[f], hy = a.yaw;
        const fw: Vec2 = [Math.sin(hy), Math.cos(hy)], lt: Vec2 = [Math.cos(hy), -Math.sin(hy)];
        const dF = (d[0] * fw[0] + d[1] * fw[1]) * cfg.footPlacement.pathKeep[1], dL = (d[0] * lt[0] + d[1] * lt[1]) * cfg.footPlacement.pathKeep[0];
        const keep: Vec2 = [dF * fw[0] + dL * lt[0], dF * fw[1] + dL * lt[1]];
        ctx.anim.anchor = { yaw: a.yaw, pos: [a.pos[0] + (p[0] - pl[0]) - keep[0], a.pos[1], a.pos[2] + (p[2] - pl[2]) - keep[1]] };
      }
    }
    const stanceFeet = FOOT_NAMES.filter((f) => mode[f] === 'stance');

    // ── 접촉점·지지 다각형 ──
    const points: ContactPoint[] = [];
    const polyPts: Vec2[] = [];
    for (const f of stanceFeet) {
      const fp = per.feet[f], gnd = fp.ground;
      const n: Vec3 = gnd ? gnd.normal : UP;
      const center = scale(fp.sole.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / Math.max(1, fp.sole.length));
      const idx = cmode[f] === 'toe' ? [2, 3] : cmode[f] === 'heel' ? [0, 1] : [0, 1, 2, 3];
      for (const i of idx) {
        const c = fp.sole[i];
        if (!c) continue;
        const d = sub(center, c), l = length(d);
        const p = cmode[f] === 'flat' && l > 2 * cfg.copMargin ? add(c, scale(d, cfg.copMargin / l)) : c;
        points.push({ key: `${f}:${i}`, p, n });
        polyPts.push([p[0], p[2]]);
      }
    }
    const poly = convexHull(polyPts);

    // ── COM: DCM 추종 ──
    const k1 = 1 + cfg.com.kXi / omega;
    const pDes: Vec2 = [pRef[0] + k1 * e[0], pRef[1] + k1 * e[1]];
    const pUsed = clipToPolygon(pDes, poly, cfg.com.cmpOutside);
    ws.cmpDes = pDes;
    ws.cmpUsed = pUsed;
    // 힘은 지금(지연 없는) COM 기준: p가 지지 다각형 안이면 발 CoP만으로 만들 수 있다 (감지 COM을 쓰면 몸통·팔 각운동량으로 메우려 한다)
    let fh: Vec3 = scale([ctx.comNow[0] - pUsed[0], 0, ctx.comNow[2] - pUsed[1]], M * omega * omega);
    const fhm = length(fh);
    if (fhm > cfg.com.maxHorizontalForce) fh = scale(fh, cfg.com.maxHorizontalForce / fhm);
    const fy = M * (ref.comAcc[1] + cfg.com.kpV * (ref.com[1] - ctx.com[1]) + cfg.com.kdV * (ref.comVel[1] - ctx.vel[1]));
    const Fdes = add([fh[0], fy, fh[2]], scale(ctx.gravity, -M));
    st.enabled = true;
    st.strategy = 'ankle';
    st.comTarget = ref.com;
    st.comSensed = ctx.com;
    st.virtualForce = [fh[0], fy, fh[2]];
    st.margin = poly.length >= 3 ? -signedDistanceToPolygon([ctx.com[0], ctx.com[2]], poly) : 0;
    st.cpMargin = poly.length >= 3 ? -signedDistanceToPolygon(xi, poly) : 0;

    // ── 발 디딤 수정 (스윙발) ──
    const heading = ctx.anim.anchor.yaw;
    const fwd: Vec2 = [Math.sin(heading), Math.cos(heading)], lat: Vec2 = [Math.cos(heading), -Math.sin(heading)];
    for (const f of FOOT_NAMES) {
      if (mode[f] !== 'swing' && mode[f] !== 'liftoff' && mode[f] !== 'landing') continue;
      const fr = ref.feet[f];
      const sNow = mode[f] === 'landing' ? 1 : fr.s;
      if (sNow < cfg.footPlacement.lateUntil) {
        const T = Math.max(0, Math.min(cfg.footPlacement.expCapT, (fr.tTd - ref.tau) / Math.max(0.2, ctx.anim.rate)));
        // 착지 때 DCM 오차 예측: 지금 오차를 남은 시간만큼 역진자로 키운다 (지지발 CoP가 고치는 몫은 gain < 1로 둔다 —
        // 클립 CMP(가속도 차분)로 그 몫을 빼면 클립 CMP가 우리 발 상자 밖으로 나가는 구간에서 잡음이 커 착지점이 튀었다)
        const E = Math.exp(omega * T);
        const etd: Vec2 = [e[0] * E, e[1] * E];
        const fp = cfg.footPlacement;
        let df = (etd[0] * fwd[0] + etd[1] * fwd[1]) * fp.gain, dl = (etd[0] * lat[0] + etd[1] * lat[1]) * fp.gainLat;
        df = Math.max(-fp.maxBack, Math.min(fp.maxFwd, df));
        dl = Math.max(-fp.maxLat, Math.min(fp.maxLat, dl));
        // 교차 금지: 착지점이 지지발보다 스윙발 쪽으로 minWidth 이상
        const other = OTHER[f];
        if (mode[other] === 'stance') {
          const so = this.bodyPos(other);
          const land: Vec2 = [fr.plant.pos[0] + df * fwd[0] + dl * lat[0], fr.plant.pos[2] + df * fwd[1] + dl * lat[1]];
          const side = LEG[f].side;
          const w0 = ((land[0] - so[0]) * lat[0] + (land[1] - so[2]) * lat[1]) * side;
          // 착지점이 지지발보다 앞뒤로 crossFwd 넘게 떨어져 있으면(걷는 중) crossMax만큼 건너 디뎌도 된다 (옆에서 지지발 쪽으로 밀렸을 때의 교차 걸음)
          const fsep = Math.abs((land[0] - so[0]) * fwd[0] + (land[1] - so[2]) * fwd[1]);
          const minW = fsep > fp.crossFwd ? -fp.crossMax : fp.minWidth;
          if (w0 < minW) dl += (minW - w0) * side;
        }
        const nd: Vec2 = [df * fwd[0] + dl * lat[0], df * fwd[1] + dl * lat[1]];
        // freezeS 뒤에는 고정, 단 lateUntil 전까지 새 목표가 lateJump m 넘게 바뀌면(스윙 중 밀림) 다시 정한다 (v0.4 결정 73 lateReplan과 같은 생각)
        if (sNow < fp.freezeS || Math.hypot(nd[0] - this.delta[f][0], nd[1] - this.delta[f][1]) > fp.lateJump) this.delta[f] = nd;
      }
      ws.feet[f].delta = this.delta[f];
    }

    // ── 전신 QP ──
    const wb = this.wb;
    const wst = wb.state();
    const mm = wb.massAndMomentum(wst);
    const n = wb.n;
    const H = new Float64Array(n * n), gvec = new Float64Array(n);
    const addRow = (row: Float64Array, target: number, w: number) => {
      for (let i = 0; i < n; i++) {
        const ri = row[i]!;
        if (ri === 0) continue;
        gvec[i]! += w * ri * target;
        for (let j = 0; j < n; j++) if (row[j] !== 0) H[i * n + j]! += w * ri * row[j]!;
      }
    };
    for (let i = 0; i < n; i++) H[i * n + i]! += cfg.regularization;
    // 팔·손·머리 가속도 정규화 (QP가 팔을 플라이휠로 휘두르지 않게; 손 과제가 걸린 팔 제외)
    for (const b of wb.bodies) {
      const nm = rd.bodies[b.idx]!.name;
      if (!/Arm|Hand/.test(nm)) continue;
      const busy = ctx.helpers.handBusy(beh, nm) > 0.05;
      if (busy && !/Hand/.test(nm)) continue;
      const hn = nm.startsWith('Left') ? 'LeftHand' : 'RightHand';
      const r = /Hand/.test(nm) ? (busy ? beh!.hands[hn as HandName]!.task.handReg ?? cfg.handAccelReg : cfg.handAccelReg) : cfg.armAccelReg;
      for (let k = 0; k < b.ndof; k++) H[(b.dof0 + k) * n + b.dof0 + k]! += r;
    }
    for (const b of wb.bodies) {
      const lo = ctx.helpers.looseOf(beh, rd.bodies[b.idx]!.name);
      if (lo > 0) for (let k = 0; k < b.ndof; k++) H[(b.dof0 + k) * n + b.dof0 + k]! += lo * beh!.freeArm!.looseReg;
    }
    const targets: JointTargets = { ...(ctx.targetsIn ?? ref.joints) };
    // 골반 (클립 Hips 월드 방향) + 몸통 (클립 골반 기준 FK한 목표의 Spine2 — 행동이 바꾼 척추 목표 포함)
    const hipsRef = ref.bodies[0]!.rot;
    {
      const hq = this.bodyRot('Hips'), hw0 = rd.body('Hips').rb.angvel();
      let qd = multiplyQ(hipsRef, conjugate(hq));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const eR = toRotationVector(qd);
      const wRef = ref.bodyAng[0]!;
      const hw: Vec3 = [hw0.x, hw0.y, hw0.z];
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        row[r] = 1;
        addRow(row, cfg.pelvis.kp * eR[r]! + cfg.pelvis.kd * (wRef[r]! - hw[r]!), cfg.pelvis.weight);
      }
    }
    const fkT = forwardKinematics(this.def, targets, { pos: [0, 0, 0], rot: multiplyQ(hipsRef, conjugate(this.def.bodies[0]!.restRotation)) });
    const qT = fkT[this.spine2Idx]!.rot;
    const s2rb = rd.body('Spine2').rb, s2w0 = s2rb.angvel();
    let qe = multiplyQ(qT, conjugate(s2q));
    if (qe[3] < 0) qe = [-qe[0], -qe[1], -qe[2], -qe[3]];
    const ts = beh?.trunkGainScale ?? 1;
    const tkp = cfg.torso.kp * ts, tkd = cfg.torso.kd * Math.sqrt(ts);
    const alphaDes = add(scale(toRotationVector(qe), tkp), scale(sub(ref.bodyAng[this.spine2Idx]!, [s2w0.x, s2w0.y, s2w0.z]), tkd));
    const s2j = wb.jacobian(wst, this.spine2Idx);
    for (let r = 0; r < 3; r++) {
      const row = new Float64Array(n);
      s2j.dofs.forEach((d, k) => { row[d] = s2j.cols[k]![r]!; });
      addRow(row, alphaDes[r]! - s2j.a0[r]!, cfg.torso.weight);
    }
    // 관절 자세 (클립 + 행동 목표, 피드포워드 관절 속도)
    const legW = (f: FootName) => (mode[f] === 'stance' ? cfg.posture.stanceLeg : cfg.posture.swingLeg);
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      const w = /UpLeg|Leg$|Foot/.test(name) ? legW(name.startsWith('Left') ? 'LeftFoot' : 'RightFoot') : /Spine/.test(name) ? cfg.posture.spine : /Head/.test(name) ? cfg.posture.head : cfg.posture.arms;
      if (w <= 0) continue;
      const j = this.jointsByName.get(name)!;
      const pq = this.rd.bodies[b.parent]!.rb.rotation(), cq = this.rd.bodies[b.idx]!.rb.rotation();
      const qp_: Quat = [pq.x, pq.y, pq.z, pq.w], qc: Quat = [cq.x, cq.y, cq.z, cq.w];
      const rT = targets[name] ?? identityQ();
      const frameP = multiplyQ(qp_, j.def.frameInParent);
      const qDes = multiplyQ(frameP, multiplyQ(rT, conjugate(j.def.frameInChild)));
      let qd = multiplyQ(qDes, conjugate(qc));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const eJ = toRotationVector(qd);
      const wRelRef = ref.jointVel[name] ? rotate(frameP, ref.jointVel[name]!) : ([0, 0, 0] as Vec3);
      for (let k = 0; k < b.ndof; k++) {
        const d = b.dof0 + k;
        const axisW = ang(wst.S[d]!);
        const row = new Float64Array(n);
        row[d] = 1;
        addRow(row, cfg.posture.kp * dot(eJ, axisW) + cfg.posture.kd * (dot(wRelRef, axisW) - wst.qd[d]!), w);
      }
    }
    // 관절 제한 피하기 (v0.4와 같은 과제)
    {
      const la = cfg.limitAvoid;
      const m = la.marginDeg * RAD;
      const toeFeet = new Set(FOOT_NAMES.filter((f) => cmode[f] === 'toe'));
      for (const b of wb.bodies) {
        if (b.type === 'free') continue;
        const j = this.jointsByName.get(rd.bodies[b.idx]!.name)!;
        const x3 = rd.coords(j);
        const pq = rd.bodies[j.parent]!.rb.rotation();
        const frame = multiplyQ([pq.x, pq.y, pq.z, pq.w], j.frameP);
        for (let k = 0; k < (b.type === 'hinge' ? 1 : 3); k++) {
          const lim = j.limits[k];
          if (!lim || lim[0] === lim[1]) continue;
          if (k === 0 && FOOT_NAMES.some((f) => toeFeet.has(f) && LEG[f].ankle === j.name)) continue;
          const mk = Math.min(m, (lim[1] - lim[0]) / 4);
          const x = x3[k]!;
          const axisW = b.type === 'hinge' ? null : rotate(frame, k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1]);
          const row = new Float64Array(n);
          let rate2 = 0;
          if (axisW) for (let i = 0; i < 3; i++) { row[b.dof0 + i] = axisW[i]!; rate2 += axisW[i]! * wst.qd[b.dof0 + i]!; }
          else { row[b.dof0] = 1; rate2 = wst.qd[b.dof0]!; }
          let target: number | null = null;
          if (x < lim[0] + mk) target = la.kp * (lim[0] + mk - x) - la.kd * Math.min(0, rate2);
          else if (x > lim[1] - mk) target = la.kp * (lim[1] - mk - x) - la.kd * Math.max(0, rate2);
          if (target !== null) addRow(row, target, la.weight);
        }
      }
    }
    // 발 과제: 스윙발 위치·방향, 지지발(발끝·뒤꿈치 지지) 방향
    const swingDbg: { f: FootName; rows: { row: Float64Array; target: number }[]; pd: Vec3; vd: Vec3 }[] = [];
    for (const f of FOOT_NAMES) {
      const fr = ref.feet[f];
      const fj = wb.jacobian(wst, wb.byName.get(f)!);
      const frb = rd.body(f).rb;
      const ft = frb.translation(), fq0 = frb.rotation(), fw0 = frb.angvel();
      const fq: Quat = [fq0.x, fq0.y, fq0.z, fq0.w];
      const fw: Vec3 = [fw0.x, fw0.y, fw0.z];
      const p: Vec3 = [ft.x, ft.y, ft.z];
      const om = ang(fj.v);
      const vp = add(lin(fj.v), cross(om, p));
      const ab = add(add(lin(fj.a0), cross(ang(fj.a0), p)), cross(om, vp));
      const rotTask = (qDes: Quat, wDes: Vec3, kp: number, kd: number, weight: number) => {
        let q2 = multiplyQ(qDes, conjugate(fq));
        if (q2[3] < 0) q2 = [-q2[0], -q2[1], -q2[2], -q2[3]];
        const alpha = add(scale(toRotationVector(q2), kp), scale(sub(wDes, fw), kd));
        for (let k = 0; k < 3; k++) {
          const row = new Float64Array(n);
          fj.dofs.forEach((d, i) => { row[d] = fj.cols[i]![k]!; });
          addRow(row, alpha[k]! - fj.a0[k]!, weight);
        }
      };
      if (mode[f] === 'stance') {
        if (cmode[f] === 'toe' || cmode[f] === 'heel') {
          // 클립 발이 평평한데(뒤꿈치가 닿음) 실제는 발끝·뒤꿈치로만 섰다 = 착지 직후 발 내리기: 세게 (발끝만으로는 CMP를 발 뒤로 못 둬 제동을 못 한다)
          const settle = cmode[f] === 'toe' ? fr.heelH < cfg.stanceFoot.heelUpH : fr.toeH < cfg.stanceFoot.heelUpH;
          const k = settle ? cfg.stanceFoot.settleGain : 1;
          rotTask(fr.rot, fr.angVel, cfg.stanceFoot.rotKp * (settle ? cfg.stanceFoot.settleKp : 1), cfg.stanceFoot.rotKd * (settle ? Math.sqrt(cfg.stanceFoot.settleKp) : 1), cfg.stanceFoot.rotWeight * k);
        }
        continue;
      }
      // 스윙: 클립 발 궤적 + 디딤 수정(진행에 따라 섞음) + 발끝 여유(가운데 볼록)
      const sw = cfg.swing;
      const d = this.delta[f];
      let pd: Vec3, vd: Vec3, ad: Vec3;
      if (mode[f] === 'landing') {
        // 착지 대기: 클립 디딤 자리(+ 디딤 수정)로, 아래로 landDescentSpeed
        pd = [fr.plant.pos[0] + d[0], fr.plant.pos[1] - 0.01, fr.plant.pos[2] + d[1]];
        vd = [0, -sw.landDescentSpeed, 0];
        ad = [0, 0, 0];
      } else {
        const s = fr.s;
        const b = smoothstep(s), db = dsmooth(s);
        const sdot = Number.isFinite(fr.tTd - fr.tLo) && fr.tTd > fr.tLo ? ctx.anim.rate / (fr.tTd - fr.tLo) : 0;
        const bump = sw.clearance * Math.sin(Math.PI * Math.max(0, Math.min(1, s)));
        const dbump = sw.clearance * Math.PI * Math.cos(Math.PI * Math.max(0, Math.min(1, s))) * sdot;
        pd = [fr.pos[0] + d[0] * b, fr.pos[1] + bump, fr.pos[2] + d[1] * b];
        vd = [fr.vel[0] + d[0] * db * sdot, fr.vel[1] + dbump, fr.vel[2] + d[1] * db * sdot];
        ad = fr.acc;
        // 스윙 막바지: 수평은 디딤 자리(+ Δ)로 모으고 수평 속도는 0으로 — 클립 발이 닿은 뒤에도 미끄러지며 자리를 잡는 구간(뒤로 걷기 발끝 착지)을
        // 물리 발은 마찰로 못 따라가 짧게 디디고 착지 충격으로 몸이 멈췄다
        const we = smoothstep((s - sw.landBlendStart) / Math.max(1e-3, 1 - sw.landBlendStart));
        if (we > 0) {
          pd = [pd[0] + (fr.plant.pos[0] + d[0] - pd[0]) * we, pd[1], pd[2] + (fr.plant.pos[2] + d[1] - pd[2]) * we];
          vd = [vd[0] * (1 - we), vd[1], vd[2] * (1 - we)];
          ad = [ad[0] * (1 - we), ad[1], ad[2] * (1 - we)];
        }
        // 디딤 자리에서 수평으로 멀면 그만큼 높게 (클립 발이 자리에 닿기 전에 바닥에 내려와 미끄러지는 구간에서 일찍 디디지 않게)
        const dh = Math.hypot(p[0] - fr.plant.pos[0] - d[0], p[2] - fr.plant.pos[2] - d[1]);
        const yMin = fr.plant.pos[1] + Math.min(sw.landSlopeMax, sw.landSlope * dh);
        if (pd[1] < yMin) { pd = [pd[0], yMin, pd[2]]; vd = [vd[0], Math.max(0, vd[1]), vd[2]]; }
        // 떼기(클립은 스윙인데 아직 닿음): 바닥에 끌리지 않게 먼저 들어 올린다
        if (mode[f] === 'liftoff') { pd = [pd[0], Math.max(pd[1], p[1] + sw.liftoffLift), pd[2]]; vd = [vd[0], Math.max(vd[1], sw.liftoffSpeed), vd[2]]; }
      }
      ws.feet[f].target = add(fr.plant.pos, [d[0], 0, d[1]]);
      const swingRows: { row: Float64Array; target: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const row = new Float64Array(n);
        fj.dofs.forEach((dd, i) => { const col = fj.cols[i]!; row[dd] = lin(col)[k]! + cross(ang(col), p)[k]!; });
        const target = ad[k]! + sw.kp * (pd[k]! - p[k]!) + sw.kd * (vd[k]! - vp[k]!) - ab[k]!;
        addRow(row, target, sw.weight);
        swingRows.push({ row, target });
      }
      swingDbg.push({ f, rows: swingRows, pd, vd });
      this.swingErr[f] = Math.hypot(pd[0] - p[0], pd[2] - p[2]);
      const qDes = ctx.helpers.clampToLimits(LEG[f].ankle, mode[f] === 'landing' ? fr.plant.rot : fr.rot, 3 * RAD);
      rotTask(qDes, mode[f] === 'landing' ? [0, 0, 0] : fr.angVel, sw.rotKp, sw.rotKd, sw.rotWeight);
    }
    // 손 과제 (v0.5a, 상처 움켜쥐기)
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
      let q2 = multiplyQ(ht.rot, conjugate(hq));
      if (q2[3] < 0) q2 = [-q2[0], -q2[1], -q2[2], -q2[3]];
      const alpha = sub(scale(toRotationVector(q2), k.rotKp), scale(sub([hw0.x, hw0.y, hw0.z], ht.angVel), k.rotKd));
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        hj.dofs.forEach((d, i) => { row[d] = hj.cols[i]![r]!; });
        addRow(row, alpha[r]! - hj.a0[r]!, k.rotWeight * ht.weight);
      }
    }

    // 외부 렌치: 중력 + 바디 각감쇠 + 핀 보조
    let Wg: V6 = [0, 0, 0, 0, 0, 0];
    const extW: V6[] = wb.bodies.map((b) => {
      const bs = wst.bodies[b.idx]!;
      let w6 = wrenchAt(bs.c, scale(ctx.gravity, bs.m));
      const dmp = rd.bodies[b.idx]!.rb.angularDamping();
      if (dmp > 0) {
        const de = dmp / (1 + ctx.dt * dmp), om = ang(bs.v), I = bs.Ic;
        const t: Vec3 = [-(I[0]! * om[0] + I[1]! * om[1] + I[2]! * om[2]) * de, -(I[3]! * om[0] + I[4]! * om[1] + I[5]! * om[2]) * de, -(I[6]! * om[0] + I[7]! * om[1] + I[8]! * om[2]) * de];
        w6 = add6(w6, [t[0], t[1], t[2], 0, 0, 0]);
      }
      const pw = ctx.pinWrench?.[b.idx];
      if (pw && (pw.f[0] || pw.f[1] || pw.f[2] || pw.tau[0] || pw.tau[1] || pw.tau[2])) w6 = add6(add6(w6, wrenchAt(bs.c, pw.f)), [pw.tau[0], pw.tau[1], pw.tau[2], 0, 0, 0]);
      return w6;
    });
    for (const w6 of extW) Wg = add6(Wg, w6);
    // 지지발 제약
    const footRows: Float64Array[] = [], footRhs: number[] = [];
    for (const f of stanceFeet) {
      const fj = wb.jacobian(wst, wb.byName.get(f)!);
      if (cmode[f] === 'toe' || cmode[f] === 'heel') {
        const tp = points.filter((p) => p.key.startsWith(`${f}:`)).map((p) => p.p);
        if (tp.length === 2) {
          const A = tp[0]!, B = tp[1]!;
          const abv = normalize(sub(B, A));
          const e1 = normalize(cross(abv, Math.abs(abv[1]) < 0.9 ? UP : [1, 0, 0]));
          const e2 = cross(abv, e1);
          const om = ang(fj.v);
          const ptRows = (P: Vec3, dirs: Vec3[]) => {
            const vP = add(lin(fj.v), cross(om, P));
            const aB = add(add(lin(fj.a0), cross(ang(fj.a0), P)), cross(om, vP));
            for (const dvec of dirs) {
              const row = new Float64Array(n);
              fj.dofs.forEach((dd, k) => { const col = fj.cols[k]!; row[dd] = dot(add(lin(col), cross(ang(col), P)), dvec); });
              footRows.push(row);
              footRhs.push(dot(sub(scale(vP, -cfg.footKv), aB), dvec));
            }
          };
          ptRows(A, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
          ptRows(B, [e1, e2]);
          continue;
        }
      }
      for (let r = 0; r < 6; r++) {
        const row = new Float64Array(n);
        fj.dofs.forEach((dd, k) => { row[dd] = fj.cols[k]![r]!; });
        footRows.push(row);
        footRhs.push(-fj.a0[r]! - cfg.footKv * fj.v[r]!);
      }
    }
    // 각운동량: 클립 각운동량 쪽으로 감쇠
    const lMom = lin(mm.momentum);
    const kG = sub(ang(mm.momentum), cross(ctx.comNow, lMom));
    st.linearMomentum = lMom;
    st.angularMomentum = kG;
    const kdotDes = scale(sub(ref.angMom, kG), cfg.angMom.damping);
    st.torsoTorque = kdotDes;
    // 큰 DCM 오차(외란)에서는 수평 힘 가중치를 낮춘다: 발 안에서 못 만드는 수평 힘을 몸통을 꺾어(고관절 전략) 만들지 않고 발 디딤으로 해결 (v0.4 cmpOutside와 같은 생각)
    const eMag = Math.hypot(e[0], e[1]);
    const wLinH = cfg.wLinH * (1 - (1 - cfg.react.wLinHScale) * smoothstep((eMag - cfg.react.e0) / Math.max(1e-3, cfg.react.e1 - cfg.react.e0)));
    const res = solveWholeBodyQP({
      n, H, g: gvec, A: mm.A, momentumRhs: Wg.map((x, r) => x - mm.hBias[r]!), footRows, footRhs, points, com: ctx.comNow, Fdes, kdotDes,
      mu: cfg.mu, wLin: cfg.wLin, wAng: cfg.wAng, wLinAxes: [wLinH, 1, wLinH], regRho: cfg.regRho, smoothRho: cfg.smoothRho, minNormal: cfg.minNormal, prevBeta: this.prevBeta,
    });
    if (!res) { this.engaged = false; ws.engaged = false; ws.handover = 'qp'; return null; }
    this.prevBeta = res.beta;
    const qdd = res.qdd;
    st.achievedForce = res.achieved[0];
    st.achievedMoment = res.achieved[1];
    st.forceError = length(sub(res.achieved[0], Fdes));
    st.momentError = length(sub(res.achieved[1], kdotDes));
    st.qpResidual = res.eqResidual;
    st.contactForces = res.forces.map((c) => ({ p: c.p, f: c.f }));
    const Fa = res.achieved[0];
    st.cmp = Fa[1] > 1e-6 ? [ctx.comNow[0] - (Fa[0] * (ctx.comNow[1] - gh)) / Fa[1], ctx.comNow[2] - (Fa[2] * (ctx.comNow[1] - gh)) / Fa[1]] : null;
    const fext: V6[] = extW.map((w6) => [...w6] as V6);
    for (const c of res.forces) {
      const bi = wb.byName.get(c.key.split(':')[0]!)!;
      fext[bi] = add6(fext[bi]!, wrenchAt(c.p, c.f));
    }
    const id = wb.inverseDynamics(wst, qdd, fext);
    // 로그: 스윙발 원하는 가속도 vs QP 계획 가속도 (m/s²), 목표 위치
    for (const sd of swingDbg) {
      const des = sd.rows.map((r) => r.target), plan = sd.rows.map((r) => { let x = 0; for (let i = 0; i < n; i++) if (r.row[i]) x += r.row[i]! * qdd[i]!; return x; });
      ws.feet[sd.f].swingAcc = { des, plan, pd: sd.pd };
    }
    st.wbBaseResidual = Math.hypot(...id.baseResidual);

    const motorPlan: Partial<Record<JointName, boolean>> = {};
    for (const j of rd.joints) motorPlan[j.name] = true;
    const cmd: BalanceCommand = { torque: {}, gcScale: {}, motorScale: cfg.motorScale, subtractMotor: false, motorPlan, jointVel: {} };
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      cmd.torque[name] = id.torque[b.idx]!;
      cmd.gcScale[name] = 0;
      const lo = ctx.helpers.looseOf(beh, name);
      if (lo > 0) {
        cmd.torque[name] = scale(id.torque[b.idx]!, 1 - lo);
        cmd.gcScale[name] = lo;
        (cmd.looseJ ??= {})[name] = lo;
        (cmd.motorScaleJ ??= {})[name] = cfg.motorScale + (beh!.freeArm!.looseMotorScale - cfg.motorScale) * lo;
        delete motorPlan[name];
      }
      if (b.type === 'sph') cmd.jointVel![name] = [0, 1, 2].map((k) => wst.qd[b.dof0 + k]! + qdd[b.dof0 + k]! * ctx.dt) as Vec3;
      else cmd.jointVel![name] = scale(ang(wst.S[b.dof0]!), wst.qd[b.dof0]! + qdd[b.dof0]! * ctx.dt);
      if (lo > 0) cmd.jointVel![name] = scale(cmd.jointVel![name]!, 1 - lo);
    }
    // 로그
    for (const f of FOOT_NAMES) { ws.feet[f].mode = mode[f]; ws.feet[f].contact = cmode[f]; ws.feet[f].s = ref.feet[f].s; }
    this.prevMode = { ...mode };
    ws.engaged = true;
    return { targets, cmd, achievedForce: res.achieved[0] };
  }
}

export { fromAxisAngle, fromTo };
