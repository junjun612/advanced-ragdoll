// 지형 행동 (SPEC v0.8a 행동 목록): StairStep(계단·경사 디딤), Tumble(계단·경사에서 굴러 내려감), Trip(걸려 넘어질 뻔함), Misstep(헛디딤).
// 정의: docs/ALGORITHMS.md v0.8a. 값: config/behaviors.json StairStep·Tumble·Trip·Misstep.
import type { JointName } from '../pose';
import type { FootName } from '../perception';
import { type Vec3, add, sub, scale, normalize } from '../../math/vec3';
import { rotate, slerp } from '../../math/quat';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut, type HandName, HANDS } from './types';
import { armChain, bodyPose, degQ, handRotation, relJoint, solveArm } from './kinematics';
import type { BodyName } from '../characterDef';
import { clampTarget, rateLimited } from './fall';
import { lieJoints, type LiePose } from './air';

const SIDES = [['Left', 1], ['Right', -1]] as const;
const j = (s: string, n: string) => `${s}${n}` as JointName;
const jt = (ctx: BehaviorContext, jn: JointName, flex: number, twist: number, side: number, weight: number, strength?: number): JointOut =>
  ({ target: clampTarget(ctx.def, jn, degQ(flex, twist, side)), weight, ...(strength !== undefined ? { strength } : {}) });

/** 지면 위 COM 높이·앞 지면 (지형 해석식, 평지 0) */
export function groundAt(ctx: Pick<BehaviorContext, 'rd'>, x: number, z: number): number {
  const pw = ctx.rd.pw;
  return pw.flat ? 0 : pw.groundHeightAt(x, z);
}

/** 내리막 판정: COM 아래 지면이 수평 방향 dir으로 probe m 앞 지면보다 min m 넘게 높은가 */
export function descendingAhead(ctx: Pick<BehaviorContext, 'rd'>, dir: Readonly<Vec3>, probe: number, min: number): boolean {
  const { com } = ctx.rd.com();
  const n = Math.hypot(dir[0], dir[2]);
  if (n < 1e-6) return false;
  return groundAt(ctx, com[0], com[2]) - groundAt(ctx, com[0] + (dir[0] / n) * probe, com[2] + (dir[2] / n) * probe) > min;
}

export interface StairStepParams {
  /** 시선: 다음 디딤 자리(스텝 목표, 없으면 몸 앞 lookAhead m 지면)를 내려다본다 — 가중치 */
  gazeWeight: number; lookAhead: number;
}

/**
 * 계단·경사 디딤 (StairStep): 평지가 아닌 곳에 서 있으면 켜진다(수동 지각 — 지형은 계속 보인다). 스텝 계층에 '지형 디딤'을 켜서(mods.terrainStep)
 * 착지 목표를 디딤면 안으로 맞추고(발판 검사), 높이 차를 스윙 궤적·다리 IK 목표에 넣고, 계단 코를 넘는 스윙 높이를 쓰게 한다.
 * 몸은 다음 디딤 자리를 내려다본다(사람은 계단을 내려갈 때 발 디딜 곳을 본다).
 */
export class StairStep extends Behavior {
  readonly name = 'StairStep';
  constructor(params: Record<string, unknown>, t0: number, hitT: number) { super(params, t0, hitT); }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.params as unknown as StairStepParams;
    const hips = bodyPose(ctx.rd, 'Hips');
    // 내딛는 동안만 디딤 자리를 본다 (서 있는 동안 계속 고개를 숙이면 몸이 앞으로 쏠려 경사에서 균형이 나빠졌다)
    if (!ctx.stepping.target) { this.phase = '지형'; return { joints: {}, stepping: { terrainStep: true } }; }
    let target: Vec3;
    if (ctx.stepping.target) target = ctx.stepping.target;
    else {
      const f = rotate(hips.rot, [0, 0, 1]);
      const n = Math.hypot(f[0], f[2]) || 1;
      const x = hips.pos[0] + (f[0] / n) * p.lookAhead, z = hips.pos[2] + (f[2] / n) * p.lookAhead;
      target = [x, groundAt(ctx, x, z), z];
    }
    this.phase = ctx.stepping.target ? '디딤 자리 보기' : '지형';
    return { joints: {}, gaze: { target, weight: p.gazeWeight }, stepping: { terrainStep: true } };
  }
}

export interface TumbleParams {
  /** 시작: COM 속도 ≥ startSpeed, 내리막(속도 방향 probe m 앞 지면이 min m 넘게 낮음), 발 아닌 바디가 닿음 */
  startSpeed: number; probe: number; min: number; /** 시작: COM이 그 아래 지면에서 이 높이(m) 안 */ maxComHeight: number;
  /** 웅크림 (도): 척추 굽힘(둘에 나눔)·턱 당김·고관절·무릎, 몸통 강도 */
  tuck: { spine: number; chin: number; hip: number; knee: number; strength: number };
  /** 머리 감싸는 손: 손바닥 점(Head 로컬, x는 그 손 쪽), 팔꿈치 힌트(Spine2 로컬), 강도 */
  guardLocal: Vec3; guardPole: Vec3; guardStrength: number;
  /** 버티는 손: 어깨에서 (내려가는 방향 forward + 아래 down + 옆 side) 쪽으로 팔 길이 × reach, 손바닥 아래, 강도 — 계단 면을 짚어 속도를 줄이려 함 */
  brace: { forward: number; down: number; side: number; reach: number; strength: number; contactStrength: number; clear: number; pole: Vec3 };
  /** 손 역할(감쌈 ↔ 버팀) 바꾸기: 어깨가 더 낮은 쪽이 버티는 손, switchHold초 안에는 다시 안 바꿈 */
  switchHold: number;
  /** 골반 각속도가 이 값(rad/s) 이상이면 버티는 손 없이 두 손으로 머리를 감싼다 */
  braceMaxAngVel: number;
  maxTargetRate: number; palmLocal: Vec3;
  /** 손목 강도 상한 */
  wristStrength: number;
  /** 끝: COM 속도 < endSpeed가 endHold초(또는 maxTime초) → releaseTime초에 누운 자세로 */
  endSpeed: number; endHold: number; maxTime: number; releaseTime: number;
  lie: LiePose;
}

/**
 * 계단·경사에서 굴러 내려감 (Tumble): 넘어져 몸이 계단·경사에 닿은 채 내리막으로 빠르게 움직이면 켜진다. 웅크리고(척추·고관절·무릎 굽힘, 턱 당김)
 * 위쪽 손으로 머리를 감싸고, 아래쪽(어깨가 지면에 가까운) 손은 내려가는 쪽 지면으로 뻗어 짚으며 속도를 줄이려 한다. 몸이 돌면 손 역할이 바뀐다.
 * 느려지면 웅크림을 풀고 눕는다. 균형·스텝 끔.
 */
export class Tumble extends Behavior {
  readonly name = 'Tumble';
  private readonly p: TumbleParams;
  braceHand: HandName | null = null;
  private switchT = -Infinity;
  private slowSince: number | null = null;
  endT: number | null = null;
  /** 머리 감싼 시간 비율 계산용: 감싸는 손바닥이 머리에서 0.15 m 안이었던 시간 */
  guardTime = 0;
  activeTime = 0;
  private readonly prevT = new Map<JointName, import('../../math/quat').Quat>();
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as TumbleParams;
  }
  get resting(): boolean { return this.endT !== null; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    const { vel } = ctx.rd.com();
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    if (this.endT === null && t >= this.startT) {
      this.slowSince = sp < p.endSpeed ? (this.slowSince ?? t) : null;
      if ((this.slowSince !== null && t - this.slowSince >= p.endHold) || t - this.startT >= p.maxTime) this.endT = t;
    }
    const rel = this.endT === null ? 0 : smoothstep((t - this.endT) / p.releaseTime);
    const w = 1 - rel;
    const joints: Partial<Record<JointName, JointOut>> = {};
    const T = p.tuck;
    for (const [s, sg] of SIDES) {
      joints[j(s, 'UpLeg')] = jt(ctx, j(s, 'UpLeg'), T.hip, 0, sg * 6, w, T.strength);
      joints[j(s, 'Leg')] = jt(ctx, j(s, 'Leg'), T.knee, 0, 0, w, T.strength);
      joints[j(s, 'Foot')] = { weight: 1, strength: T.strength };
    }
    joints.Spine = jt(ctx, 'Spine', T.spine * 0.5, 0, 0, w, T.strength);
    joints.Spine2 = jt(ctx, 'Spine2', T.spine * 0.5, 0, 0, w, T.strength);
    joints.Head = jt(ctx, 'Head', T.chin, 0, 0, w, T.strength);
    const s2 = bodyPose(ctx.rd, 'Spine2'), head = bodyPose(ctx.rd, 'Head');
    // 손 역할: 어깨가 더 낮은(지면 쪽) 손이 버팀
    const sh = HANDS.map((h) => add(s2.pos, rotate(s2.rot, armChain(def, h).shoulderInSpine2)));
    const lowHand: HandName = sh[0]![1] - groundAt(ctx, sh[0]![0], sh[0]![2]) <= sh[1]![1] - groundAt(ctx, sh[1]![0], sh[1]![2]) ? 'LeftHand' : 'RightHand';
    // 빨리 구르는 동안(골반 각속도 ≥ braceMaxAngVel)은 두 손 모두 머리를 감싼다 — 사람은 구를 때 팔을 몸에 붙이고, 미끄러질 때 팔을 벌려 짚는다.
    // (구르는 몸에서 팔을 뻗으면 계단 모서리에 걸린 팔이 채찍처럼 휘둘려 손이 50 rad/s를 넘었다)
    const wH = Math.hypot(...bodyPose(ctx.rd, 'Hips').angVel);
    const want: HandName | null = wH >= p.braceMaxAngVel ? null : lowHand;
    if (want !== this.braceHand && t - this.switchT >= p.switchHold) { this.braceHand = want; this.switchT = t; }
    const vh = Math.hypot(vel[0], vel[2]);
    const fwd: Vec3 = vh > 0.05 ? [vel[0] / vh, 0, vel[2] / vh] : normalize([rotate(s2.rot, [0, 0, 1])[0], 0, rotate(s2.rot, [0, 0, 1])[2]]);
    let guarded = false;
    for (const h of HANDS) {
      const ch = armChain(def, h);
      let palm: Vec3, q, pole: Vec3, strength: number;
      if (h === this.braceHand) {
        const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
        const lat = normalize(sub(S, s2.pos));
        const dir = normalize(add(add(scale(fwd, p.brace.forward), [0, -p.brace.down, 0]), scale(lat, p.brace.side)));
        palm = add(S, scale(dir, (ch.l1 + ch.l2) * p.brace.reach));
        // 손바닥 목표는 지면 위로 (지면 아래를 겨누면 손이 계단 모서리에 박혀 손목이 수십 rad/s로 돌았다)
        const gy = groundAt(ctx, palm[0], palm[2]) + p.brace.clear;
        if (palm[1] < gy) palm = [palm[0], gy, palm[2]];
        q = handRotation(ch, [0, -1, 0], add(fwd, [0, 0.3, 0]));
        pole = rotate(s2.rot, [p.brace.pole[0] * ch.side, p.brace.pole[1], p.brace.pole[2]]);
        // 짚은 손은 힘을 뺀다 (닿은 동안 contactStrength) — 내려가는 몸에 끌려가며 버티지 않고 미끄러진다
        strength = ctx.per.ground.has(h) ? p.brace.contactStrength : p.brace.strength;
      } else {
        palm = add(head.pos, rotate(head.rot, [p.guardLocal[0] * ch.side, p.guardLocal[1], p.guardLocal[2]]));
        q = handRotation(ch, normalize(sub(head.pos, palm)), rotate(head.rot, [0, 1, 0]));
        pole = rotate(s2.rot, [p.guardPole[0] * ch.side, p.guardPole[1], p.guardPole[2]]);
        strength = p.guardStrength;
        const hp = bodyPose(ctx.rd, h).pos;
        if (Math.hypot(hp[0] - head.pos[0], hp[1] - head.pos[1], hp[2] - head.pos[2]) < 0.2) guarded = true;
      }
      // 닿아 있는 손: 목표의 출발점을 지금 손목 자세로 (떨어지는 순간 목표가 지금 자세에서 이어지게 — 계단에 눌려 90° 넘게 비틀린 손을
      // 손목 근육이 한 번에 되돌리면 가벼운 손이 50 rad/s 넘게 돌았다)
      if (ctx.per.ground.has(h)) this.prevT.set(h as JointName, relJoint(def, h as JointName, bodyPose(ctx.rd, ch.fore as BodyName).rot, bodyPose(ctx.rd, h).rot));
      const sol = solveArm(def, ch, s2.rot, s2.pos, palm, q, p.palmLocal, pole);
      // 손목은 약하게 (wristStrength): 계단에 눌렸던 손이 떨어지는 순간 목표와 90° 넘게 어긋나 손목 근육이 가벼운 손을 50 rad/s 넘게 돌렸다
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def), weight: w, strength: jn === h ? Math.min(strength, p.wristStrength) : strength };
    }
    if (this.endT === null && t >= this.startT) { this.activeTime += ctx.dt; if (guarded) this.guardTime += ctx.dt; }
    if (rel > 0) {
      const lie = lieJoints(def, p.lie, 1, smoothstep(3 * rel));
      for (const [jn, jo] of Object.entries(lie)) {
        const cur = joints[jn as JointName];
        joints[jn as JointName] = cur?.target ? { target: slerp(cur.target, jo!.target!, rel), weight: cur.weight + (1 - cur.weight) * rel, strength: Math.min(cur.strength ?? 1, jo!.strength ?? 1) } : { ...jo!, weight: rel };
      }
    }
    this.phase = this.endT === null ? (this.braceHand ? `미끄러짐 · ${this.braceHand === 'LeftHand' ? '왼손' : '오른손'} 짚기` : '구름 · 머리 감싸기') : rel < 1 ? '풀기' : '누움';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
  override info(): Record<string, unknown> { return { braceHand: this.braceHand, endT: this.endT, guardTime: this.guardTime, activeTime: this.activeTime }; }
}

export interface TripParams {
  /** 걸린 다리: 고관절·무릎을 굽혀 장애물 위로 들어 올림 (도), 시간 */
  liftHip: number; liftKnee: number; liftTime: number;
  /** 팔: 앞·위로 내밂 (어깨 앞 올림·벌림·팔꿈치, 도), 강도 */
  armFlex: number; armAbduct: number; elbow: number; armStrength: number;
  /** 몸통: 앞으로 쏠리는 것을 막으려 척추를 젖힘 (도) */
  spineExtend: number;
  /** 끝: duration초 */
  duration: number;
}

/**
 * 걸림 (Trip): 걷는 중 스윙발이 장애물에 걸리면(접촉 법선이 수평에 가까움) 켜진다. 발이 멈춘 채 몸은 앞으로 쏠린다(수동, 물리).
 * 감지 지연 뒤: 두 팔을 앞·위로 내밀고, 몸통을 젖히고, 걸린 다리를 들어 장애물 위로 넘기려 한다(사람의 '올림 전략'). 내딛기는 스텝 계층(비틀거림)이,
 * 못 버티면 넘어짐 대비·손 짚기가 맡는다.
 */
export class Trip extends Behavior {
  readonly name = 'Trip';
  readonly foot: FootName;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.foot = (params.foot as FootName | undefined) ?? 'LeftFoot';
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.params as unknown as TripParams, t = ctx.t;
    if (t - this.hitT >= p.duration && this.stopT === null) this.stop(t);
    const tau = Math.max(0, t - this.startT);
    const lift = smoothstep(tau / (0.4 * p.liftTime)) * (1 - smoothstep((tau - 0.6 * p.liftTime) / (0.4 * p.liftTime)));
    const joints: Partial<Record<JointName, JointOut>> = {};
    const L = this.foot === 'LeftFoot' ? 'Left' : 'Right';
    if (lift > 0) {
      joints[j(L, 'UpLeg')] = { add: degQ(p.liftHip * lift, 0, 0), weight: 1 };
      joints[j(L, 'Leg')] = { add: degQ(p.liftKnee * lift, 0, 0), weight: 1 };
    }
    for (const [s, sg] of SIDES) {
      joints[j(s, 'Arm')] = jt(ctx, j(s, 'Arm'), p.armFlex, 0, sg * p.armAbduct, 1, p.armStrength);
      joints[j(s, 'ForeArm')] = jt(ctx, j(s, 'ForeArm'), p.elbow, 0, 0, 1, p.armStrength);
    }
    joints.Spine = { add: degQ(-p.spineExtend * 0.5, 0, 0), weight: 1 };
    joints.Spine2 = { add: degQ(-p.spineExtend * 0.5, 0, 0), weight: 1 };
    this.phase = lift > 0.05 ? '걸린 발 들기' : '팔 내밂';
    return { joints };
  }
  override info(): Record<string, unknown> { return { foot: this.foot }; }
}

export interface MisstepParams {
  /** 내딛던 다리(허공): 고관절·무릎 (도), 지지 다리: 무릎·발목(밀어냄) (도), 팔 놀람(앞 올림·벌림·팔꿈치) */
  swingHip: number; swingKnee: number; stanceKnee: number; stanceAnkle: number; /** 지지 다리 강도 (꺾이며 몸이 모서리 너머로 내려감) */ stanceStrength: number; armFlex: number; armAbduct: number; elbow: number;
  /** 최대 시간 (공중이 되면 끝 — 공중 행동이 맡는다) */
  duration: number;
}

/**
 * 헛디딤 (Misstep): 걷다가 내딛은 발 아래가 낭떠러지면(걷기 추종을 'void'로 넘김) 켜진다. 버틸 디딤이 없으니 균형·스텝을 끄고
 * 내딛던 다리는 아래로 뻗고 지지 다리는 힘이 빠져 꺾이며(제동하지 않음) 팔을 놀라 벌린다 → 걷던 운동량 그대로 몸이 모서리 너머로 떨어진다.
 * 몸이 공중에 뜨면 끝(공중 허우적·착지 준비가 맡는다).
 */
export class Misstep extends Behavior {
  readonly name = 'Misstep';
  readonly foot: FootName;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.foot = (params.foot as FootName | undefined) ?? 'RightFoot';
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.params as unknown as MisstepParams, t = ctx.t;
    if ((ctx.air?.airborne || t - this.hitT >= p.duration) && this.stopT === null) this.stop(t);
    const joints: Partial<Record<JointName, JointOut>> = {};
    const S = this.foot === 'LeftFoot' ? 'Left' : 'Right', O = S === 'Left' ? 'Right' : 'Left';
    joints[j(S, 'UpLeg')] = jt(ctx, j(S, 'UpLeg'), p.swingHip, 0, 0, 1);
    joints[j(S, 'Leg')] = jt(ctx, j(S, 'Leg'), p.swingKnee, 0, 0, 1);
    joints[j(O, 'Leg')] = jt(ctx, j(O, 'Leg'), p.stanceKnee, 0, 0, 1, p.stanceStrength);
    joints[j(O, 'Foot')] = jt(ctx, j(O, 'Foot'), p.stanceAnkle, 0, 0, 1, p.stanceStrength);
    joints[j(O, 'UpLeg')] = { weight: 1, strength: p.stanceStrength };
    const k = smoothstep((t - this.hitT - 0.08) / 0.2);
    for (const [s, sg] of SIDES) {
      joints[j(s, 'Arm')] = jt(ctx, j(s, 'Arm'), p.armFlex, 0, sg * p.armAbduct, k);
      joints[j(s, 'ForeArm')] = jt(ctx, j(s, 'ForeArm'), p.elbow, 0, 0, k);
    }
    this.phase = '헛디딤';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
  override info(): Record<string, unknown> { return { foot: this.foot }; }
}
