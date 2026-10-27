// 잡기·벽 (SPEC v0.8b 행동 목록): Grab(잡을 곳으로 손 뻗기 → 손과 대상 사이 구형 관절), HangOnLedge(모서리에 매달림),
// BraceAgainstWall(벽 쪽으로 넘어질 때 손·어깨로 짚음). 인지는 perception.ts senseGrab·senseWall (감지 지연 DelayLine).
// 정의: docs/ALGORITHMS.md v0.8b. 값: config/behaviors.json grabSense·Grab·HangOnLedge·BraceAgainstWall.
import type R from '@dimforge/rapier3d-compat';
import { R as Rapier } from '../../world';
import type { JointName } from '../pose';
import type { Ragdoll } from '../ragdoll';
import type { BodyName } from '../characterDef';
import type { GrabFeature } from '../../terrain';
import { closestOnSegment } from '../../terrain';
import { type Vec3, add, sub, scale, dot, cross, length, normalize } from '../../math/vec3';
import { type Quat, rotate, conjugate, multiplyQ, normalizeQ } from '../../math/quat';
import type { CharacterDef } from '../characterDef';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut, type HandName, type HandTarget, HANDS } from './types';
import { armChain, bodyDef, bodyPose, degQ, handRotation, solveArm, type ArmChain } from './kinematics';
import { clampTarget, rateLimited } from './fall';
import type { WallSense } from '../perception';

const UP: Vec3 = [0, 1, 0];
const minJerk = (x: number): number => { const u = Math.max(0, Math.min(1, x)); return u * u * u * (10 - 15 * u + 6 * u * u); };
const minJerkD = (x: number): number => (x <= 0 || x >= 1 ? 0 : 30 * x * x * (1 - x) * (1 - x));
const HAND_KO: Record<HandName, string> = { LeftHand: '왼손', RightHand: '오른손' };
const ARM_JOINTS: Record<HandName, [JointName, JointName, JointName]> = { LeftHand: ['LeftArm', 'LeftForeArm', 'LeftHand'], RightHand: ['RightArm', 'RightForeArm', 'RightHand'] };

/** 손바닥 점 (월드)·속도 */
function palmOf(rd: Ragdoll, h: HandName, palmLocal: Readonly<Vec3>): { p: Vec3; v: Vec3 } {
  const b = bodyPose(rd, h);
  const r = rotate(b.rot, palmLocal as Vec3);
  return { p: add(b.pos, r), v: add(b.vel, cross(b.angVel, r)) };
}

function shoulderOf(rd: Ragdoll, ch: ArmChain): { S: Vec3; s2: ReturnType<typeof bodyPose> } {
  const s2 = bodyPose(rd, 'Spine2');
  return { S: add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2)), s2 };
}

/**
 * 팔 IK + 손목 제한: 원하는 손 방향 q가 전완에서 손목 중립(관절 rest)보다 maxWristDeg 넘게 돌아가 있으면 그만큼만 돌린 방향으로 다시 푼다.
 * (손목 비틀기 제한 근처를 겨누면 관절 좌표가 ±180°에서 뒤집혀 가벼운 손이 한 스텝에 50 rad/s 넘게 돌았다 — 사람도 손목을 끝까지 꺾어 잡지 않는다)
 */
function armIK(def: CharacterDef, ch: ArmChain, s2: { pos: Vec3; rot: Quat }, palm: Vec3, q: Quat, palmLocal: Vec3, pole: Vec3, maxWristDeg: number): ReturnType<typeof solveArm> {
  let sol = solveArm(def, ch, s2.rot, s2.pos, palm, q, palmLocal, pole);
  const hj = bodyDef(def, ch.hand).joint!;
  const qN = normalizeQ(multiplyQ(multiplyQ(sol.qFore, hj.frameInParent), conjugate(hj.frameInChild)));
  let r = multiplyQ(conjugate(qN), q);
  if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
  const ang = 2 * Math.acos(Math.min(1, r[3]));
  const mx = (maxWristDeg * Math.PI) / 180;
  if (ang > mx) {
    const k = Math.sin(mx / 2) / Math.max(1e-9, Math.sin(ang / 2));
    const rl = normalizeQ([r[0] * k, r[1] * k, r[2] * k, Math.cos(mx / 2)]);
    sol = solveArm(def, ch, s2.rot, s2.pos, palm, normalizeQ(multiplyQ(qN, rl)), palmLocal, pole);
  }
  return sol;
}

// ── 잡기 관절 ──

export interface GrabJointConfig {
  /** 손바닥 점을 고정 앵커에 묶는 구형 관절: 세 직선 축 모터(힘 기반 위치 모터) 강성·감쇠·축별 최대 힘(N) = 손아귀 힘. 회전은 자유 */
  kp: number; kd: number; maxForce: number;
}

/**
 * 잡기 관절 (SPEC 'Grab: 손과 대상 사이에 관절(구형)'): 잡은 순간의 손바닥 점에 고정 강체(앵커)를 두고 손 바디와 일반 관절로 잇는다.
 * 회전 3축은 자유(구형), 직선 3축은 힘 상한이 있는 위치 모터 — 손아귀 힘(maxForce)을 넘는 당김은 손이 미끄러진다(slip). 숨은 힘이 아니라
 * 손에만 걸리는 접촉 구속이고, 몸은 팔 관절(근육)을 거쳐서만 끌린다. 힘은 모터 PD 식으로 추정해 로그에 남긴다.
 */
export class GrabJoint {
  private readonly anchorBody: R.RigidBody;
  private readonly joint: R.ImpulseJoint;
  /** 지난 물리 스텝 뒤 추정 힘 (N, 앵커 → 손), 미끄러짐 (m, 손바닥 점 − 앵커) */
  force: Vec3 = [0, 0, 0];
  forceMag = 0;
  slip = 0;
  constructor(readonly rd: Ragdoll, readonly hand: HandName, readonly palmLocal: Vec3, readonly anchor: Vec3, readonly cfg: GrabJointConfig) {
    const world = rd.pw.world;
    this.anchorBody = world.createRigidBody(Rapier.RigidBodyDesc.fixed().setTranslation(anchor[0], anchor[1], anchor[2]));
    const data = Rapier.JointData.generic({ x: 0, y: 0, z: 0 }, { x: palmLocal[0], y: palmLocal[1], z: palmLocal[2] }, { x: 1, y: 0, z: 0 }, 0 as R.JointAxesMask);
    this.joint = world.createImpulseJoint(data, this.anchorBody, rd.body(hand).rb, true);
    this.joint.setContactsEnabled(false);
    const raw = world.impulseJoints.raw;
    for (const ax of [0, 1, 2]) {
      raw.jointConfigureMotorModel(this.joint.handle, ax as never, Rapier.MotorModel.ForceBased as never);
      raw.jointConfigureMotor(this.joint.handle, ax as never, 0, 0, cfg.kp, cfg.kd);
      raw.jointSetMotorMaxForce(this.joint.handle, ax as never, cfg.maxForce);
    }
  }
  /** 힘·미끄러짐 추정 (모터 PD 식, 축별 상한) — 루트·겟업 보조 사용량과 같은 방식 */
  measure(): void {
    const { p, v } = palmOf(this.rd, this.hand, this.palmLocal);
    const e = sub(this.anchor, p);
    this.slip = length(e);
    const f: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) f[i] = Math.max(-this.cfg.maxForce, Math.min(this.cfg.maxForce, this.cfg.kp * e[i]! - this.cfg.kd * v[i]!));
    this.force = f;
    this.forceMag = length(f);
  }
  free(): void {
    const world = this.rd.pw.world;
    world.removeImpulseJoint(this.joint, true);
    world.removeRigidBody(this.anchorBody);
  }
}

// ── 잡기 ──

export interface GrabParams {
  hand: HandName; feature: number;
  /** 뻗기: 평균 속도(m/s)로 시간을 정하고 [reachTimeMin, reachTimeMax]로 자름. giveUp초 안에 못 잡으면 포기 */
  reachSpeed: number; reachTimeMin: number; reachTimeMax: number; giveUp: number;
  /** 손바닥 목표: 난간대는 축에서 (반지름 + palmClear), 위쪽으로 railTopBias만큼 기울인 쪽(위에서 감아쥠). 모서리는 윗면 안쪽 edgeInset m, palmClear 위 */
  palmClear: number; railTopBias: number; edgeInset: number;
  /** 잡는 조건: 손바닥-목표 거리 < gripDist (잡을 곳에 닿았으면 × touchScale) 이고 손바닥 속도 < gripSpeed (m/s) */
  gripDist: number; touchScale: number; gripSpeed: number;
  joint: GrabJointConfig;
  /** 팔 강도 (뻗기·잡음), 손목 강도 상한 */
  reachStrength: number; holdStrength: number; wristStrength: number;
  /** 잡은 뒤 어깨-손바닥 목표 거리 = 팔 길이 × holdReach[종류] (작을수록 팔꿈치를 굽혀 몸을 끌어당긴다 — 팔 근육으로만) */
  holdReach: { rail: number; edge: number };
  /** 놓기: 추정 힘 > releaseForce가 releaseForceHold초 / 미끄러짐 > releaseSlip / 그 팔 강도 배율(다른 행동) < releaseStrength */
  releaseForce: number; releaseForceHold: number; releaseSlip: number; releaseStrength: number;
  /** 난간: 몸이 버텨 내면(스텝 없음, 넘어짐 확실도 < recoverCertainty, COM 수평 속도 < recoverSpeed가 recoverHold초) 잡은 지 minHold초 뒤 스스로 놓는다 */
  recoverCertainty: number; recoverSpeed: number; recoverHold: number; minHold: number;
  elbowPole: Vec3; maxTargetRate: number; palmLocal: Vec3;
  /** 손목: 전완 중립에서 손 방향을 이 각(도) 넘게 돌리지 않는다 */
  maxWristDeg: number;
  /** 시선: 뻗는 동안 잡을 곳을 본다 (가중치) */
  gazeWeight: number;
  /** 궤적 볼록 (m, 잡을 곳 바깥 법선 쪽), 잡기 판정은 궤적 진행 minReachFrac 뒤부터, 모서리 윗면 띠 너비 edgeBand (m) */
  approach: number; edgeBand: number;
  /** 잡기 전 점 도착 판정 거리(m)·최대 기다림(초), 내려앉기 시간(초), 내려앉으며 잡을 곳 안쪽으로 누르는 거리(m) */
  preTol: number; preWait: number; placeTime: number; palmPress: number; approachIn: number;
  /** 난간대 쥔 손가락을 몸 앞쪽 난간 방향으로 기울이는 비율 (0 = 난간대에 수직) */
  fingerForward: number;
  /** 잡을 점: 몸이 움직이는 쪽으로 leadTime초 앞 어깨에 가장 가까운 점(월드 고정), 어깨 거리가 팔 길이 × relatch를 넘으면 다시 정함 */
  leadTime: number; relatch: number;
  /** 몸 전체로 뻗기 (모서리가 팔 길이 × start보다 멀고 어깨 아래): range m 더 멀수록 고관절·무릎·발목·척추 굽힘(도)을 강도 strength로 */
  crouch: { start: number; range: number; hip: number; knee: number; ankle: number; spine: number; strength: number };
  /** 전신 QP 손 과제 이득 (HoldWound.task와 같은 형식) */
  task: HandTarget['task'];
}

export type GrabPhase = 'reach' | 'hold' | 'released' | 'failed';
const PHASE_KO: Record<GrabPhase, string> = { reach: '뻗기', hold: '잡음', released: '놓음', failed: '못 잡음' };

/**
 * 잡기 (SPEC v0.8b Grab): 잡을 곳(인지 후보, 감지 지연 뒤)으로 손바닥을 최소 저크 궤적(Spine2 기준 시작점 → 목표)으로 IK 뻗기.
 * 손바닥이 충분히 가깝고(gripDist) 느리면(gripSpeed) 그 점에 잡기 관절(GrabJoint)을 만든다. 잡은 뒤에는 팔 IK 목표 = 앵커 쪽 어깨-손 거리
 * holdReach(팔꿈치 굽힘) — 몸을 끄는 힘은 팔 근육으로만. 힘이 손아귀를 넘거나(releaseForce·releaseSlip) 팔 힘이 빠지면(releaseStrength) 놓는다.
 * 난간은 몸이 버텨 내면 스스로 놓는다.
 */
export class Grab extends Behavior {
  readonly name = 'Grab';
  readonly hand: HandName;
  readonly feature: number;
  private readonly p: GrabParams;
  grabPhase: GrabPhase = 'reach';
  joint: GrabJoint | null = null;
  kind: GrabFeature['kind'] = 'rail';
  target: Vec3 | null = null;
  /** 뻗는 궤적 기준점 (로그) */
  ref: Vec3 | null = null;
  anchor: Vec3 | null = null;
  gripT: number | null = null;
  releaseT: number | null = null;
  releaseWhy = '';
  slipMax = 0;
  forceMax = 0;
  private startLocal: Vec3 | null = null;
  private placeT: number | null = null;
  private aimP: Vec3 | null = null;
  /** 주저앉으며 뻗기 정도 0~1 (뻗는 동안 줄지 않음) */
  crouchK = 0;
  private placeFrom: Vec3 | null = null;
  private reachStart = 0;
  private reachT = 0.3;
  private overSince: number | null = null;
  private stableSince: number | null = null;
  private qGrip: Quat | null = null;
  private readonly prevT = new Map<JointName, Quat>();
  private lastJoints: Partial<Record<JointName, JointOut>> = {};
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as GrabParams;
    this.hand = this.p.hand;
    this.feature = this.p.feature;
  }
  get holding(): boolean { return this.grabPhase === 'hold'; }

  /** 잡을 곳 위 손바닥 목표 (지금 어깨 기준 가장 가까운 점), 손바닥이 향할 쪽(inward), 손가락 방향 */
  private gripPose(g: GrabFeature, S: Vec3, fwd: Vec3 = [0, 0, 1], aim: Vec3 | null = null): { palm: Vec3; inward: Vec3; fingers: Vec3; n: Vec3 } {
    const p = this.p;
    const P = aim ?? closestOnSegment(g.a, g.b, S);
    if (g.kind === 'edge') {
      const inw = g.inward ?? [0, 0, -1];
      return { palm: add(add(P, scale(inw, p.edgeInset)), [0, p.palmClear, 0]), inward: [0, -1, 0], fingers: inw, n: UP };
    }
    const u = normalize(sub(g.b, g.a));
    const toS = sub(S, P);
    const perp = sub(toS, scale(u, dot(toS, u)));
    let n = add(normalize(perp), [0, p.railTopBias, 0]);
    n = normalize(sub(n, scale(u, dot(n, u))));
    // 손가락: 난간대를 위에서 감아 넘어가는 쪽(어깨 반대편)과 몸 앞쪽 난간 방향 사이 (계단 난간을 쥔 손처럼 손가락이 앞·바깥을 향함)
    let f = cross(u, n);
    if (dot(f, perp) > 0) f = scale(f, -1);
    const along = dot(u, fwd) >= 0 ? u : scale(u, -1);
    f = normalize(add(f, scale(along, this.p.fingerForward)));
    return { palm: add(P, scale(n, g.radius + p.palmClear)), inward: scale(n, -1), fingers: f, n };
  }

  /** 손바닥 점에서 잡을 곳 표면까지 거리 (난간대: 축 거리 − 반지름, 모서리: 윗면 띠(모서리에서 안쪽 edgeBand m)까지) */
  private surfaceDist(g: GrabFeature, palm: Vec3): number {
    const P = closestOnSegment(g.a, g.b, palm);
    if (g.kind === 'rail') return length(sub(palm, P)) - g.radius;
    const inw = g.inward ?? [0, 0, -1];
    const k = Math.max(0, Math.min(this.p.edgeBand, dot(sub(palm, P), inw)));
    return length(sub(palm, add(P, scale(inw, k))));
  }

  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    const g = ctx.rd.pw.terrainDef.grabs[this.feature];
    const ch = armChain(def, this.hand);
    const { S, s2 } = shoulderOf(ctx.rd, ch);
    const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
    const joints: Partial<Record<JointName, JointOut>> = {};
    if (!g) { this.grabPhase = 'failed'; this.stop(t); return { joints }; }
    this.kind = g.kind;
    // 끄기 요청(늘어짐·겟업 등)이면 놓는다
    if (this.stopT !== null && this.joint) this.release(t, this.releaseWhy || 'stop');
    if (this.grabPhase === 'released' || this.grabPhase === 'failed') {
      this.phase = PHASE_KO[this.grabPhase];
      return { joints: this.lastJoints };
    }
    const palm = palmOf(ctx.rd, this.hand, p.palmLocal);
    if (this.startLocal === null) {
      this.startLocal = rotate(conjugate(s2.rot), sub(palm.p, s2.pos));
      this.reachStart = t;
      const gp0 = this.gripPose(g, S);
      this.reachT = Math.max(p.reachTimeMin, Math.min(p.reachTimeMax, length(sub(gp0.palm, palm.p)) / p.reachSpeed));
    }
    let gaze: { target: Vec3; weight: number } | null = null;
    let hands: BehaviorOutput['hands'] | undefined;
    if (this.grabPhase === 'reach') {
      // 잡을 점은 처음에 한 번 정해 월드에 고정한다 (몸이 움직이는 쪽으로 leadTime초 앞 어깨에 가장 가까운 점) — 매 스텝 어깨에 가장 가까운 점을
      // 쫓으면 앞으로 밀린 몸과 함께 목표가 달아나 손이 끝내 닿지 않았다. 팔이 닿지 않게 되면(어깨 거리 > 팔 길이 × relatch) 다시 정한다
      const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
      if (!this.aimP || length(sub(this.aimP, S)) > p.relatch * L) {
        const v = ctx.rd.com().vel;
        this.aimP = closestOnSegment(g.a, g.b, add(S, [v[0] * p.leadTime, 0, v[2] * p.leadTime]));
      }
      const gp = this.gripPose(g, S, rotate(s2.rot, [0, 0, 1]), this.aimP);
      this.target = gp.palm;
      // 두 단계: ① 잡을 곳 바깥 법선(위·몸 쪽) approach m 앞 '잡기 전 점'으로 최소 저크(Spine2에 붙은 시작점 → 그 점, reachT초),
      // 손바닥이 그 점 preTol 안에 들거나 preWait초 지나면 ② 지금 손바닥에서 목표로 내려앉기(placeTime초). 손이 잡을 곳 위로 와서 감아쥔다
      // (시작점 → 목표 직선·볼록 궤적은 팔이 늦게 따라가 모서리를 잘라, 손이 난간대 밑에 걸렸다)
      // 잡기 전 점: 목표에서 바깥 법선으로 approach + 몸 쪽 수평으로 approachIn (손이 난간대 안쪽·모서리 바깥쪽으로 비켜 올라간다)
      const Pf = closestOnSegment(g.a, g.b, S);
      const bs = normalize([S[0] - Pf[0], 0, S[2] - Pf[2]]);
      const pre = add(add(gp.palm, scale(gp.n, p.approach)), scale(bs, p.approachIn));
      if (this.placeT === null) {
        const x = (t - this.reachStart) / this.reachT;
        // 잡기 전 점 근처에 일찍 왔으면(궤적 60% 뒤) 바로 내려앉는다 — 몸이 계속 움직이는 동안 공중에서 기다리면 잡을 곳이 멀어졌다
        if ((x >= 0.6 && length(sub(palm.p, pre)) < p.preTol) || t - this.reachStart >= this.reachT + p.preWait) { this.placeT = t; this.placeFrom = palm.p; }
      }
      let ref: Vec3, vref: Vec3;
      if (this.placeT === null) {
        const x = (t - this.reachStart) / this.reachT;
        const s = minJerk(x), ds = minJerkD(x) / this.reachT;
        const start = add(s2.pos, rotate(s2.rot, this.startLocal));
        const startV = add(s2.vel, cross(s2.angVel, sub(start, s2.pos)));
        ref = add(start, scale(sub(pre, start), s));
        vref = add(scale(startV, 1 - s), scale(sub(pre, start), ds));
      } else {
        const x = (t - this.placeT) / p.placeTime;
        const s = minJerk(x), ds = minJerkD(x) / p.placeTime;
        const from = this.placeFrom!;
        // 목표 너머로 조금 눌러 붙인다 (palmPress m, 잡을 곳 안쪽)
        const goal = sub(gp.palm, scale(gp.n, p.palmPress * s));
        ref = add(from, scale(sub(goal, from), s));
        vref = scale(sub(goal, from), ds);
      }
      this.ref = ref;
      // 손 방향: 잡기 전 점까지는 손가락을 몸 앞쪽(난간대 방향)으로 둔다 — 처음부터 쥐는 방향(바깥)으로 돌리면 손 캡슐이 난간대 밑에 걸렸다
      const fw = rotate(s2.rot, [0, 0, 1]);
      const fPre = normalize(sub(fw, scale(gp.inward, dot(fw, gp.inward))));
      const q = handRotation(ch, gp.inward, this.placeT === null ? fPre : gp.fingers);
      const sol = armIK(def, ch, s2, ref, q, p.palmLocal, pole, p.maxWristDeg);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def), weight: 1, strength: jn === this.hand ? Math.min(p.reachStrength, p.wristStrength) : p.reachStrength };
      gaze = { target: gp.palm, weight: p.gazeWeight };
      // 균형 계층 전신 QP 손 과제 (균형이 켜져 있을 때 손바닥이 궤적을 정확히 따라가게)
      hands = { [this.hand]: { palm: ref, vel: vref, rot: sol.qHand, angVel: [0, 0, 0], palmLocal: p.palmLocal, weight: 1, task: p.task, woundId: null } };
      // 잡는 조건: 손바닥이 잡을 곳 표면에 가깝고(gripDist, 잡을 곳에 닿았으면 × touchScale) 느림
      const d = this.surfaceDist(g, palm.p), v = length(palm.v);
      const touching = ctx.per.grabTouch.has(this.hand);
      // 손바닥이 잡을 곳 바깥(위)쪽에 있어야 한다 (난간대 밑·받침 옆면에 닿은 손은 잡은 것이 아니다)
      const above = dot(sub(palm.p, closestOnSegment(g.a, g.b, palm.p)), gp.n) > 0;
      // 내려앉는 중이거나, 잡기 전 점으로 가는 길 절반을 지나 손이 이미 잡을 곳 위에 닿았으면 잡는다
      const late = this.placeT !== null || (t - this.reachStart) / this.reachT >= 0.5;
      if (late && above && v < p.gripSpeed && (d < p.gripDist || (touching && d < p.gripDist * p.touchScale))) {
        this.anchor = palm.p;
        this.joint = new GrabJoint(ctx.rd, this.hand, p.palmLocal, palm.p, p.joint);
        this.grabPhase = 'hold';
        this.gripT = t;
        this.qGrip = sol.qHand;
      } else if (t - this.reachStart > p.giveUp) {
        this.grabPhase = 'failed';
        this.releaseWhy = 'giveUp';
        this.stop(t);
      }
      this.phase = `${HAND_KO[this.hand]} ${PHASE_KO[this.grabPhase]}`;
    }
    if (this.grabPhase === 'hold' && this.joint) {
      const J = this.joint;
      J.measure();
      this.slipMax = Math.max(this.slipMax, J.slip);
      this.forceMax = Math.max(this.forceMax, J.forceMag);
      // 팔 자세: 앵커 쪽으로 어깨-손 거리 holdReach × 팔 길이 (지금보다 멀게는 두지 않는다) — 팔꿈치를 굽혀 몸을 끌어당기는 근육 토크
      const A = J.anchor;
      const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
      const dS = length(sub(A, S));
      // 몸이 버텨 내면(넘어짐 확실도·COM 속도 작음) 끌어당기지 않고 지금 거리로 붙든다 (계속 끌면 균형 계층과 싸워 몸이 난간 쪽으로 계속 걸었다)
      const vC = ctx.rd.com().vel;
      const calm = (ctx.fall?.certainty ?? 0) < p.recoverCertainty && Math.hypot(vC[0], vC[2]) < p.recoverSpeed;
      const want = calm && g.kind === 'rail' ? dS : Math.min(dS, L * p.holdReach[g.kind]);
      const aim = add(S, scale(normalize(sub(A, S)), want));
      const sol = armIK(def, ch, s2, aim, this.qGrip ?? bodyPose(ctx.rd, this.hand).rot, p.palmLocal, pole, p.maxWristDeg);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def), weight: 1, strength: jn === this.hand ? Math.min(p.holdStrength, p.wristStrength) : p.holdStrength };
      // 놓기
      this.overSince = J.forceMag > p.releaseForce ? (this.overSince ?? t) : null;
      const armS = ctx.lastStrength?.[ARM_JOINTS[this.hand][0]] ?? 1;
      if (this.overSince !== null && t - this.overSince >= p.releaseForceHold) this.release(t, 'force');
      else if (J.slip > p.releaseSlip) this.release(t, 'slip');
      else if (armS < p.releaseStrength) this.release(t, 'weak');
      else if (g.kind === 'rail') {
        const { vel } = ctx.rd.com();
        const stable = ctx.stepping.state !== 'step' && (ctx.fall?.certainty ?? 0) < p.recoverCertainty && Math.hypot(vel[0], vel[2]) < p.recoverSpeed && ctx.per.feet.LeftFoot.contact && ctx.per.feet.RightFoot.contact;
        this.stableSince = stable ? (this.stableSince ?? t) : null;
        if (this.stableSince !== null && t - this.stableSince >= p.recoverHold && t - this.gripT! >= p.minHold) this.release(t, 'recovered');
      }
      this.phase = this.grabPhase === 'hold' ? `${HAND_KO[this.hand]} 잡음` : `${HAND_KO[this.hand]} 놓음`;
    }
    this.lastJoints = {};
    for (const [jn, jo] of Object.entries(joints)) if (jo?.target) this.lastJoints[jn as JointName] = { target: jo.target, weight: 1 };
    // 몸 전체로 뻗기 (모서리): 잡을 곳이 팔 길이보다 멀고 어깨보다 아래면 무릎·고관절을 굽히고 몸통을 숙여 어깨를 내린다 (뒤로 떨어지는 사람은 주저앉으며 손을 뻗는다)
    if (this.grabPhase === 'reach' && g.kind === 'edge' && this.aimP && this.aimP[1] < S[1]) {
      const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
      const k = smoothstep((length(sub(this.aimP, S)) - L * p.crouch.start) / p.crouch.range);
      this.crouchK = Math.max(this.crouchK, k);
      const c = p.crouch, ck = this.crouchK;
      // 절대 목표(add 아님, README 결정 172): 두 손이 각자 Grab이라 add를 쓰면 굽힘이 두 번 곱해져 무릎·고관절 목표가 180°를 넘어 뒤집혔다
      // (무릎 목표 −176°·고관절 −165° → 가벼운 정강이가 튀어 올라 발이 받침에서 떴다)
      if (ck > 0) for (const sd of ['Left', 'Right'] as const) {
        const jn = (n: string) => `${sd}${n}` as JointName;
        joints[jn('UpLeg')] = { target: clampTarget(def, jn('UpLeg'), degQ(c.hip * ck, 0, 0)), weight: 1, strength: c.strength };
        joints[jn('Leg')] = { target: clampTarget(def, jn('Leg'), degQ(c.knee * ck, 0, 0)), weight: 1, strength: c.strength };
        joints[jn('Foot')] = { target: clampTarget(def, jn('Foot'), degQ(c.ankle * ck, 0, 0)), weight: 1, strength: c.strength };
      }
      if (ck > 0) { joints.Spine = { target: clampTarget(def, 'Spine', degQ(c.spine * 0.5 * ck, 0, 0)), weight: 1 }; joints.Spine2 = { target: clampTarget(def, 'Spine2', degQ(c.spine * 0.5 * ck, 0, 0)), weight: 1 }; }
    }
    return { joints, ...(gaze ? { gaze } : {}), ...(hands ? { hands } : {}), ...(this.crouchK > 0 && this.grabPhase === 'reach' ? { balanceMode: 'off' as const, stepAllowed: false } : {}) };
  }

  release(t: number, why: string): void {
    if (this.joint) { this.joint.free(); this.joint = null; }
    if (this.grabPhase === 'hold') { this.grabPhase = 'released'; this.releaseT = t; this.releaseWhy = why; }
    this.stop(t);
  }

  override dispose(): void { if (this.joint) { this.joint.free(); this.joint = null; } }

  override info(): Record<string, unknown> {
    return { hand: this.hand, kind: this.kind, grabPhase: this.grabPhase, target: this.target, anchor: this.anchor, force: this.joint?.forceMag ?? 0, slip: this.joint?.slip ?? 0, slipMax: this.slipMax, forceMax: this.forceMax, gripT: this.gripT, releaseT: this.releaseT, releaseWhy: this.releaseWhy || undefined };
  }
}

// ── 매달리기 ──

export interface HangParams {
  /** 다리: 벽(받침 옆면)이 엉덩이 앞 wallProbe m 안이면 짚음(brace), 아니면 늘어뜨림(dangle). 각(도)·강도 */
  wallProbe: number;
  brace: { hip: number; knee: number; ankle: number; strength: number };
  dangle: { hip: number; knee: number; ankle: number; strength: number };
  /** 몸통·머리: 척추 굽힘, 머리 젖힘(−: 위를 봄), 강도 */
  spineFlex: number; headFlex: number; trunkStrength: number;
  /** 다리 자세 바꾸기 시간 (초) */
  legBlend: number;
  gazeWeight: number;
}

/**
 * 매달리기 (SPEC v0.8b HangOnLedge): 모서리를 잡은 손이 있고 발이 지면에 닿지 않으면 켜진다. 균형·스텝은 끄고, 다리는 받침 옆면(벽)이
 * 가까우면 무릎·고관절을 굽혀 발로 벽을 짚고, 아니면 힘을 빼고 늘어뜨린다. 머리는 잡은 손을 올려다본다. 팔은 Grab이 맡는다.
 */
export class HangOnLedge extends Behavior {
  readonly name = 'HangOnLedge';
  private readonly p: HangParams;
  braced = false;
  private braceK = 0;
  braceTime = 0;
  activeTime = 0;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as HangParams;
  }
  /** 블렌더가 매 스텝 알려 주는 잡은 점들 (없으면 끝) */
  anchors: Vec3[] = [];
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    if (!this.anchors.length && this.stopT === null) this.stop(t);
    const hips = bodyPose(ctx.rd, 'Hips');
    const joints: Partial<Record<JointName, JointOut>> = {};
    // 벽 탐지: 엉덩이에서 잡은 점 쪽 수평으로 짧은 레이 (지면 콜라이더 = 받침 옆면)
    let wall = false;
    if (this.anchors.length) {
      const a = this.anchors.reduce((s, x) => add(s, scale(x, 1 / this.anchors.length)), [0, 0, 0] as Vec3);
      const d = [a[0] - hips.pos[0], 0, a[2] - hips.pos[2]] as Vec3;
      const n = Math.hypot(d[0], d[2]);
      if (n > 1e-4) {
        const ray = new Rapier.Ray({ x: hips.pos[0], y: hips.pos[1], z: hips.pos[2] }, { x: d[0] / n, y: 0, z: d[2] / n });
        for (const c of ctx.rd.pw.groundColliders) { const h = c.castRay(ray, p.wallProbe, true); if (h >= 0) { wall = true; break; } }
      } else wall = true;
    }
    this.braced = wall;
    const k = 1 - Math.exp(-ctx.dt / Math.max(1e-3, p.legBlend));
    this.braceK += ((wall ? 1 : 0) - this.braceK) * k;
    const B = p.brace, D = p.dangle, b = this.braceK;
    const mix = (x: number, y: number) => x * b + y * (1 - b);
    for (const s of ['Left', 'Right'] as const) {
      const jn = (n: string) => `${s}${n}` as JointName;
      joints[jn('UpLeg')] = { target: clampTarget(ctx.def, jn('UpLeg'), degQ(mix(B.hip, D.hip), 0, 0)), weight: 1, strength: mix(B.strength, D.strength) };
      joints[jn('Leg')] = { target: clampTarget(ctx.def, jn('Leg'), degQ(mix(B.knee, D.knee), 0, 0)), weight: 1, strength: mix(B.strength, D.strength) };
      joints[jn('Foot')] = { target: clampTarget(ctx.def, jn('Foot'), degQ(mix(B.ankle, D.ankle), 0, 0)), weight: 1, strength: mix(B.strength, D.strength) };
    }
    joints.Spine = { add: degQ(p.spineFlex * 0.5, 0, 0), weight: 1, strength: p.trunkStrength };
    joints.Spine2 = { add: degQ(p.spineFlex * 0.5, 0, 0), weight: 1, strength: p.trunkStrength };
    joints.Head = { add: degQ(p.headFlex, 0, 0), weight: 1, strength: p.trunkStrength };
    if (t >= this.startT && this.stopT === null) { this.activeTime += ctx.dt; if (wall) this.braceTime += ctx.dt; }
    this.phase = wall ? '매달림 · 발로 벽 짚기' : '매달림 · 다리 늘어뜨림';
    const gz = this.anchors.length ? this.anchors.reduce((s, x) => add(s, scale(x, 1 / this.anchors.length)), [0, 0, 0] as Vec3) : null;
    return { joints, balanceMode: 'off', stepAllowed: false, ...(gz ? { gaze: { target: gz, weight: p.gazeWeight } } : {}) };
  }
  override info(): Record<string, unknown> { return { braced: this.braced, braceTime: this.braceTime, activeTime: this.activeTime }; }
}

// ── 벽 짚기 ──

export interface WallBraceParams {
  wall: WallSense;
  /** 뻗기 시간: 거리 / reachSpeed, [reachTimeMin, reachTimeMax] */
  reachSpeed: number; reachTimeMin: number; reachTimeMax: number;
  /** 손바닥 목표: 어깨를 벽에 수직으로 내린 점에서 아래 palmDown m, 바깥(그 손 쪽) palmSpread m, 벽에서 palmClear m 앞 */
  palmDown: number; palmSpread: number; palmClear: number;
  /** 벽이 몸 옆(벽 법선과 골반 옆 방향 |내적| ≥ sideDot)이면 벽 쪽 손 하나만. 어깨가 벽에서 shoulderDist m 안이면 어깨로 짚음 */
  sideDot: number; shoulderDist: number;
  /** 어깨 짚기: 그 팔을 가슴 앞으로 접음 (Spine2 로컬 손바닥 점), 몸통을 벽 쪽으로 옆 굽힘(도) */
  tuckLocal: Vec3; tuckPole: Vec3; leanSide: number;
  /** 강도: 뻗기, 닿은 뒤 흡수(absorbTime초 동안 팔꿈치 absorbFlex도 더 굽히며 absorbStrength), 버팀, 손목 상한 */
  reachStrength: number; absorbFlex: number; absorbTime: number; absorbStrength: number; holdStrength: number; wristStrength: number;
  /** 밀어내기: 닿은 뒤 COM 속도 < pushSpeed가 pushDelay초면 pushTime초에 걸쳐 어깨-손 거리를 팔 길이 × pushReach로 (몸을 벽에서 떼어 발 위로) */
  pushSpeed: number; pushDelay: number; pushTime: number; pushReach: number;
  /** 끝: 밀어낸 뒤 스텝 없음 + 넘어짐 확실도 < endCertainty가 endHold초, 또는 maxTime초 */
  endCertainty: number; endHold: number; maxTime: number;
  elbowPole: Vec3; maxTargetRate: number; palmLocal: Vec3; gazeWeight: number; maxWristDeg: number;
  /** (v0.8c, 결정 174) 짚을 곳이 다른 사람일 때 덮어쓰는 값 (손바닥 높이·벌림·앞 간격, 어깨 받기 거리, 밀어내기 팔 길이 배율) */
  person?: Partial<Pick<WallBraceParams, 'palmDown' | 'palmSpread' | 'palmClear' | 'shoulderDist' | 'pushReach' | 'pushDelay' | 'absorbStrength' | 'holdStrength' | 'reachSpeed' | 'reachTimeMin' | 'reachTimeMax'>>;
  /** (사람 짚기만) 닿기 전 전신 QP 손 과제 이득 (HoldWound.task 형식). 없으면 관절 목표만 */
  task?: HandTarget['task'];
  /** (사람 짚기만) 손바닥 목표를 맞은 점 좌우 이 거리(m) 안으로 */
  personHalfWidth?: number;
  /** (사람 짚기만, 결정 178) 밀어내기 동안 COM 목표를 상대에게서 떼는 거리 (m) */
  stepBack?: number;
  /** (사람 짚기만) 밀어낸 뒤 엉덩이와 짚은 점 수평 거리가 이보다 가까우면 한 걸음 물러난다 (m) */
  personalSpace?: number;
}

/**
 * 벽 짚기 (SPEC v0.8b BraceAgainstWall): 넘어지는 방향 레이(감지 지연)에 벽이 있으면 켜진다. 벽이 앞이면 두 손, 옆이면 벽 쪽 손을
 * 어깨 높이 조금 아래 벽면으로 최소 저크로 뻗는다(손바닥은 벽, 손가락은 위). 손이 벽에 닿으면 팔꿈치를 더 굽히며 힘을 빼 충격을 받고(흡수),
 * 버틴 뒤 몸이 멈추면 팔을 펴서 몸을 발 위로 밀어낸다. 어깨가 이미 벽에 붙을 만큼 가까운 옆 벽이면 팔을 접고 어깨로 받는다.
 */
export class BraceAgainstWall extends Behavior {
  readonly name = 'BraceAgainstWall';
  private readonly p: WallBraceParams;
  readonly wall: WallSense;
  mode: 'hands' | 'shoulder' = 'hands';
  hands: HandName[] = [];
  contactT: Partial<Record<HandName, number>> = {};
  shoulderContactT: number | null = null;
  firstContact: { t: number; body: string; speed: number } | null = null;
  private targets: Partial<Record<HandName, Vec3>> = {};
  private startLocal: Partial<Record<HandName, Vec3>> = {};
  private reachStart = 0;
  private reachT = 0.25;
  private holdDist: Partial<Record<HandName, number>> = {};
  private stillSince: number | null = null;
  /** (v0.8c) 사람을 짚은 손: 닿은 점을 상대 바디 로컬로 (상대가 움직이면 따라간다) */
  private targetsLocal: Partial<Record<HandName, { rb: R.RigidBody; p: Vec3 }>> = {};
  pushT: number | null = null;
  /** (결정 178) 사람을 밀어낸 뒤 한 걸음 물러나기 단계 (로그) */
  backPhase: 'none' | 'want' | 'stepping' | 'done' = 'none';
  private endSince: number | null = null;
  private readonly prevT = new Map<JointName, Quat>();
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    const base = params as unknown as WallBraceParams;
    this.wall = base.wall;
    // 다른 사람을 짚으면 사람용 값으로 덮는다
    this.p = this.wall.person && base.person ? { ...base, ...base.person } : base;
  }

  /** (v0.8c) 짚을 사람의 모든 콜라이더 (손 접촉 판정용) */
  private personCols(ctx: BehaviorContext): R.Collider[] {
    const pn = this.wall.person;
    if (!pn) return [];
    return ctx.rd.pw.persons.find((x) => x.name === pn.name)?.bodies.flatMap((b) => b.cols) ?? [];
  }

  /** (v0.8c) 이 바디가 짚을 사람에 닿았나 (Rapier 접촉 쌍, 접촉 거리 1cm 안). 닿았으면 접촉 점과 맞은 상대 강체 */
  private touchPerson(ctx: BehaviorContext, body: BodyName, cols: R.Collider[]): { point: Vec3; rb: R.RigidBody } | null {
    const w = ctx.rd.pw.world;
    for (const bc of ctx.rd.body(body).cols) for (const oc of cols) {
      let out: { point: Vec3; rb: R.RigidBody } | null = null;
      w.contactPair(bc, oc, (m, flipped) => {
        for (let i = 0; i < m.numContacts() && !out; i++) {
          if (m.contactDist(i) > 0.01) continue;
          const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
          if (!lp) continue;
          const ct = bc.translation(), cr = bc.rotation();
          const q = rotate([cr.x, cr.y, cr.z, cr.w], [lp.x, lp.y, lp.z]);
          out = { point: [ct.x + q[0], ct.y + q[1], ct.z + q[2]], rb: oc.parent()! };
        }
      });
      if (out) return out;
    }
    return null;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    // 다른 사람이면 맞은 바디를 따라 점·법선을 매 스텝 다시 (상대도 밀려 움직인다)
    const pn = this.wall.person;
    let nW = this.wall.normal, W = this.wall.point;
    if (pn) {
      const bt = pn.rb.translation(), bq = pn.rb.rotation(), q: Quat = [bq.x, bq.y, bq.z, bq.w];
      W = add([bt.x, bt.y, bt.z], rotate(q, pn.localPoint));
      nW = rotate(q, pn.localNormal);
    }
    const n = normalize([nW[0], 0, nW[2]]);
    const pCols = pn ? this.personCols(ctx) : [];
    let hands: BehaviorOutput['hands'] | undefined;
    const s2 = bodyPose(ctx.rd, 'Spine2'), hips = bodyPose(ctx.rd, 'Hips');
    const joints: Partial<Record<JointName, JointOut>> = {};
    if (t < this.startT) return { joints };
    if (!this.hands.length) {
      // 손 고르기: 벽이 옆이면 벽 쪽 손 하나, 앞이면 두 손. 어깨가 벽에 아주 가까운 옆 벽이면 어깨로
      const lat = rotate(hips.rot, [1, 0, 0]);
      // 사람은 둥근 몸이라 맞은 점 법선이 비스듬하다 — 넘어지는 방향으로 옆인지 본다
      const side = pn ? dot(normalize([this.wall.dir[0], 0, this.wall.dir[2]]), lat) : dot(scale(n, -1), lat);
      if (Math.abs(side) >= p.sideDot) {
        const h: HandName = side > 0 ? 'LeftHand' : 'RightHand';
        const S = add(s2.pos, rotate(s2.rot, armChain(def, h).shoulderInSpine2));
        this.hands = [h];
        if (dot(sub(S, W), n) <= p.shoulderDist) this.mode = 'shoulder';
      } else this.hands = [...HANDS];
      this.reachStart = t;
      let far = 0;
      for (const h of this.hands) {
        const ch = armChain(def, h);
        const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
        const pm = palmOf(ctx.rd, h, p.palmLocal).p;
        this.startLocal[h] = rotate(conjugate(s2.rot), sub(pm, s2.pos));
        far = Math.max(far, length(sub(this.palmTarget(S, s2.pos, ch, n, W), pm)));
      }
      this.reachT = Math.max(p.reachTimeMin, Math.min(p.reachTimeMax, far / p.reachSpeed));
    }
    const s = minJerk((t - this.reachStart) / this.reachT);
    const { vel } = ctx.rd.com();
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    const anyContact = Object.keys(this.contactT).length > 0 || this.shoulderContactT !== null;
    // 밀어내기 시작: 닿은 뒤 몸이 멈추면
    if (anyContact && this.pushT === null) {
      this.stillSince = sp < p.pushSpeed ? (this.stillSince ?? t) : null;
      if (this.stillSince !== null && t - this.stillSince >= p.pushDelay) this.pushT = t;
    }
    const push = this.pushT === null ? 0 : smoothstep((t - this.pushT) / p.pushTime);
    if (this.mode === 'shoulder') {
      const h = this.hands[0]!;
      const ch = armChain(def, h);
      const sh = ch.side; // 왼쪽 +1
      const shTouch = (b: BodyName) => (pn ? !!this.touchPerson(ctx, b, pCols) : ctx.per.propTouch.has(b));
      if (this.shoulderContactT === null && (shTouch('Spine2') || shTouch(ch.arm))) {
        this.shoulderContactT = t;
        this.firstContact ??= { t, body: shTouch('Spine2') ? 'Spine2' : ch.arm, speed: Math.hypot(vel[0], vel[2]) };
      }
      const palm = add(s2.pos, rotate(s2.rot, [p.tuckLocal[0] * sh, p.tuckLocal[1], p.tuckLocal[2]]));
      const q = handRotation(ch, rotate(s2.rot, [0, 0, -1]), rotate(s2.rot, [-sh, 0.3, 0]));
      const pole = rotate(s2.rot, [p.tuckPole[0] * sh, p.tuckPole[1], p.tuckPole[2]]);
      const sol = armIK(def, ch, s2, palm, q, p.palmLocal, pole, p.maxWristDeg);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def), weight: smoothstep(s * 1.2), strength: p.holdStrength };
      // 몸통을 벽 쪽으로 기울여 어깨로 받는다 (side+ = 오른쪽(−X)으로 굽힘 → 왼쪽 벽이면 −)
      const k = smoothstep(s) * (1 - push);
      joints.Spine = { add: degQ(0, 0, -sh * p.leanSide * 0.4 * k), weight: 1 };
      joints.Spine2 = { add: degQ(0, 0, -sh * p.leanSide * 0.6 * k), weight: 1 };
      this.phase = this.shoulderContactT === null ? '어깨로 벽 받기' : push > 0 ? '벽에서 몸 떼기' : '어깨로 벽 짚음';
    } else {
      for (const h of this.hands) {
        const ch = armChain(def, h);
        const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
        const pm = palmOf(ctx.rd, h, p.palmLocal);
        const pt = pn ? this.touchPerson(ctx, h, pCols) : null;
        const touching = pn ? !!pt : ctx.per.props.some((c) => c.body === h && c.kind === 'wall');
        if (this.contactT[h] === undefined && touching) {
          this.contactT[h] = t;
          this.targets[h] = pm.p;
          if (pt) { const r = pt.rb.translation(), rq = pt.rb.rotation(); this.targetsLocal[h] = { rb: pt.rb, p: rotate([-rq.x, -rq.y, -rq.z, rq.w], sub(pm.p, [r.x, r.y, r.z])) }; }
          this.holdDist[h] = length(sub(pm.p, S));
          this.firstContact ??= { t, body: h, speed: length(pm.v) };
        }
        const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
        const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
        const q = handRotation(ch, scale(n, -1), add(UP, scale(sub(S, s2.pos), 0.5)));
        let aim: Vec3, strength: number, flexAdd = 0;
        const c0 = this.contactT[h];
        if (c0 === undefined) {
          const tgt = this.palmTarget(S, s2.pos, ch, n, W);
          this.targets[h] = tgt;
          const start = add(s2.pos, rotate(s2.rot, this.startLocal[h]!));
          aim = add(start, scale(sub(tgt, start), s));
          strength = p.reachStrength;
        } else {
          // 닿은 손: 그 점을 버팀점으로. 흡수(팔꿈치 굽힘·힘 뺌) → 버팀 → 밀어내기(팔 폄). 사람이면 상대 바디에 붙은 점
          const tl = this.targetsLocal[h];
          if (tl) { const r = tl.rb.translation(), rq = tl.rb.rotation(); this.targets[h] = add([r.x, r.y, r.z], rotate([rq.x, rq.y, rq.z, rq.w], tl.p)); }
          const A = this.targets[h]!;
          const tau = t - c0;
          const ab = smoothstep(tau / p.absorbTime);
          flexAdd = p.absorbFlex * ab * (1 - push);
          strength = p.absorbStrength + (p.holdStrength - p.absorbStrength) * smoothstep((tau - p.absorbTime) / p.absorbTime);
          const d0 = this.holdDist[h]!;
          const want = d0 + (Math.max(d0, L * p.pushReach) - d0) * push;
          aim = add(S, scale(normalize(sub(A, S)), want));
        }
        const sol = armIK(def, ch, s2, aim, q, p.palmLocal, pole, p.maxWristDeg);
        for (const [jn, tq] of Object.entries(sol.targets)) {
          const r = rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def);
          joints[jn as JointName] = { target: r, weight: 1, strength: jn === h ? Math.min(strength, p.wristStrength) : strength };
        }
        if (flexAdd > 0) joints[ch.fore] = { ...joints[ch.fore]!, target: clampTarget(def, ch.fore, mulFlex(joints[ch.fore]!.target!, flexAdd)) };
        // (v0.8c, 결정 174) 사람을 짚을 때는 닿기 전까지 전신 QP 손 과제로 뻗는다 (Grab과 같은 예외): 비틀거리는 동안 QP가 팔을 각운동량 자원·반사로 써서
        // 관절 목표만으로는 손이 머리보다 늦게 나가 머리가 먼저 상대 가슴에 닿았다
        if (pn && p.task && c0 === undefined) (hands ??= {})[h] = { palm: aim, vel: [0, 0, 0], rot: sol.qHand, angVel: [0, 0, 0], palmLocal: p.palmLocal, weight: 1, task: p.task, woundId: null };
      }
      const nC = Object.keys(this.contactT).length;
      this.phase = nC === 0 ? '벽 쪽으로 손 뻗기' : push > 0 ? '벽 밀어내기' : `벽 짚음 (${this.hands.map((h) => HAND_KO[h]).join('·')})`;
    }
    // (결정 178) 사람을 밀어낸 뒤 아직 가까우면(엉덩이 ~ 짚은 점 수평 거리 < personalSpace) 한 걸음 물러난다: COM 목표를 상대에게서 stepBack m 떼어
    // 스텝 계층이 한 걸음 딛게 하고, 그 걸음이 끝나면 그친다. 팔만 펴고 끝내면 0.4m 거리에 서서 늘어뜨린 손이 상대 엉덩이에 닿아 있었다
    if (pn && p.stepBack) {
      const dH = Math.hypot(hips.pos[0] - W[0], hips.pos[2] - W[2]);
      if (this.backPhase === 'none' && push >= 1 && dH < (p.personalSpace ?? 0)) this.backPhase = 'want';
      else if (this.backPhase === 'want' && ctx.stepping.state === 'step') this.backPhase = 'stepping';
      else if (this.backPhase === 'stepping' && ctx.stepping.state !== 'step') this.backPhase = 'done';
    }
    // 끝: 밀어낸 뒤 버티면, 또는 maxTime
    if (this.stopT === null) {
      const ok = this.pushT !== null && push >= 1 && ctx.stepping.state !== 'step' && (ctx.fall?.certainty ?? 0) < p.endCertainty && this.backPhase !== 'want' && this.backPhase !== 'stepping';
      this.endSince = ok ? (this.endSince ?? t) : null;
      if ((this.endSince !== null && t - this.endSince >= p.endHold) || t - this.startT >= p.maxTime) this.stop(t);
    }
    // (결정 178) 사람을 밀어낼 때는 COM 목표를 상대에게서 stepBack m 떼어 놓는다 — 밀어낸 사람은 한 걸음 물러나 제 자리를 찾는다.
    // 팔만 펴면 발이 상대 발에 붙은 채 0.4m 거리로 기대 섰다. 목표가 지지 다각형 밖이면 스텝 계층이 한 걸음 디딘다
    const back = this.backPhase === 'want' || this.backPhase === 'stepping' ? scale(n, p.stepBack!) : null;
    return { joints, gaze: { target: [W[0], s2.pos[1], W[2]], weight: p.gazeWeight * (1 - push) }, ...(hands ? { hands } : {}), ...(back ? { comShift: [back[0], back[2]] as [number, number], stepping: { newEpisode: true } } : {}) };
  }

  /** 손바닥 목표: 어깨를 벽면에 수직으로 내린 점 + 아래 palmDown + 바깥 palmSpread, 벽에서 palmClear 앞 */
  private palmTarget(S: Vec3, chest: Vec3, ch: ArmChain, n: Vec3, W: Vec3): Vec3 {
    const p = this.p;
    const onWall = sub(S, scale(n, dot(sub(S, W), n)));
    const tang = normalize(cross(n, UP));
    const outward = Math.sign(dot(sub(S, chest), tang)) || ch.side;
    let q = add(add(add(onWall, scale(n, p.palmClear)), [0, -p.palmDown, 0]), scale(tang, outward * p.palmSpread));
    // (v0.8c) 사람은 벽처럼 넓지 않다: 손바닥을 맞은 점 좌우 personHalfWidth m 안으로 (밖이면 상대 몸 옆 허공을 짚으려다 팔이 상대 팔에 눌려 꺾였다)
    if (this.wall.person && p.personHalfWidth !== undefined) {
      const off = dot(sub(q, W), tang), c = Math.max(-p.personHalfWidth, Math.min(p.personHalfWidth, off));
      q = add(q, scale(tang, c - off));
    }
    return q;
  }

  override info(): Record<string, unknown> {
    return { mode: this.mode, hands: this.hands, contactT: this.contactT, shoulderContactT: this.shoulderContactT, firstContact: this.firstContact, pushT: this.pushT, backPhase: this.backPhase, targets: this.targets, wall: { point: this.wall.point, normal: this.wall.normal, dist: this.wall.dist, ...(this.wall.person ? { person: `${this.wall.person.name}:${this.wall.person.body}` } : {}) } };
  }
}

/** 팔꿈치(경첩) 목표에 굽힘을 더한다 (도) */
function mulFlex(q: Quat, deg: number): Quat {
  return multiplyQ(degQ(deg, 0, 0), q);
}

export type { BodyName };
