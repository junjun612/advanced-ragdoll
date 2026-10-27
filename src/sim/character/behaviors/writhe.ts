// 바닥 몸부림 (SPEC v0.5c Writhe): 쓰러져 누운 채 일정 시간이 지나면 약하고 느린 시드 노이즈 목표로 아파서 몸부림친다 —
// 무릎을 끌어올리고, 상처가 있으면 손으로 누르고(없으면 배를 감쌈), 머리를 천천히 움직인다. 강도는 아주 낮다.
// 정의: docs/ALGORITHMS.md v0.5c. 값: config/behaviors.json Writhe.
import type { JointName } from '../pose';
import type { BodyName } from '../characterDef';
import { type Vec3, add, scale, sub, length, normalize } from '../../math/vec3';
import { type Quat, rotate, slerp } from '../../math/quat';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut, type HandName, HANDS } from './types';
import { armChain, bodyPose, degQ, handRotation, relJoint, solveArm } from './kinematics';
import { clampTarget, rateLimited } from './fall';
import { lieJoints, type LiePose } from './air';
import { SmoothNoise } from './noise';
import { surfaceAt } from '../hitModel';

export interface WritheParams {
  /** 노이즈 주파수 범위 (Hz) — 아주 느리게 */
  band: [number, number];
  /** 몸부림 자세로 들어가는 시간 (초) */
  rise: number;
  /** 다리: 고관절 굽힘(무릎을 끌어올림)·진폭, 벌림·진폭, 무릎 굽힘·진폭, 발목 */
  leg: { hip: number; hipAmp: number; side: number; sideAmp: number; knee: number; kneeAmp: number; ankle: number; strength: number };
  /** 몸통·머리: 척추 굽힘·진폭, 옆·비틀기 진폭, 머리 굽힘·진폭, 머리 비틀기·옆 진폭 */
  trunk: { spine: number; spineAmp: number; sideAmp: number; twistAmp: number; head: number; headAmp: number; headTwistAmp: number; headSideAmp: number; strength: number };
  /** 손: 손바닥을 상처(없으면 배: Spine 앞 표면, 손마다 옆으로 bellyX)에 palmClear 띄워 두고 노이즈로 handWander m 움직임 */
  hand: { headElbowPole: Vec3; bellyX: number; bellyY: number; palmClear: number; wander: number; strength: number; maxTargetRate: number; palmLocal: Vec3; elbowPole: Vec3 };
  /** 판정 (※ SPEC 9.2 ground_writhe): Writhe 동안 관절 평균 각속도(°/s)가 이 범위 안 — Kimodo lie_writhe_pain 분포 */
  jointSpeedRange: [number, number];
  lie: LiePose;
}

/** 몸부림: 균형·스텝 끔, 아주 약한 강도로 느린 노이즈 목표 */
export class Writhe extends Behavior {
  readonly name = 'Writhe';
  private readonly p: WritheParams;
  private noise: SmoothNoise | null = null;
  private readonly prevT = new Map<JointName, Quat>();
  /** 시작할 때 실제 관절 자세 (정의 관절 좌표계 상대 회전) */
  private start: Partial<Record<JointName, Quat>> | null = null;
  /** 손이 누르는 곳: 바디와 바디 로컬 표면 점·법선 */
  private holds: Partial<Record<HandName, { body: BodyName; local: Vec3; normal: Vec3; fingers?: Vec3; pole?: Vec3 }>> | null = null;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as WritheParams;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    this.noise ??= new SmoothNoise(ctx.rng.fork(`Writhe@${this.hitT.toFixed(4)}`), p.band, 2);
    const tau = Math.max(0, t - this.startT);
    const k = smoothstep(tau / p.rise);
    const n = (c: string) => this.noise!.at(c, tau);
    const joints: Partial<Record<JointName, JointOut>> = {};
    // 시작할 때의 실제 관절 자세에서 몸부림 자세로 k만큼 (가중치 1: 아래 누움 행동을 끈 뒤에도 서기 포즈로 돌아가지 않게),
    // 강도는 누운 자세 강도에서. 누운 자세 목표로 바로 바꾸면 엎드려 웅크린 몸이 펴지며 COM이 0.9 m/s로 움직였다
    const lie = lieJoints(def, p.lie, 1, 1);
    if (!this.start) {
      this.start = {};
      for (const b of def.bodies) if (b.joint && b.parent) this.start[b.name as JointName] = relJoint(def, b.name as JointName, bodyPose(ctx.rd, b.parent).rot, bodyPose(ctx.rd, b.name).rot);
    }
    const st = this.start;
    const jt = (jn: JointName, flex: number, twist: number, side: number, s: number): JointOut => {
      const l = lie[jn]!;
      return { target: slerp(st[jn] ?? l.target!, clampTarget(def, jn, degQ(flex, twist, side)), k), weight: 1, strength: l.strength! + (s - l.strength!) * k };
    };
    const L = p.leg, T = p.trunk;
    for (const [s, sg] of [['Left', 1], ['Right', -1]] as const) {
      joints[`${s}UpLeg` as JointName] = jt(`${s}UpLeg` as JointName, L.hip + L.hipAmp * n(`${s}Hip`), 0, sg * (L.side + L.sideAmp * n(`${s}HipS`)), L.strength);
      joints[`${s}Leg` as JointName] = jt(`${s}Leg` as JointName, L.knee + L.kneeAmp * n(`${s}Knee`), 0, 0, L.strength);
      joints[`${s}Foot` as JointName] = jt(`${s}Foot` as JointName, L.ankle, 0, 0, L.strength);
    }
    for (const sp of ['Spine', 'Spine2'] as JointName[]) joints[sp] = jt(sp, 0.5 * (T.spine + T.spineAmp * n(`${sp}F`)), 0.5 * T.twistAmp * n(`${sp}T`), 0.5 * T.sideAmp * n(`${sp}S`), T.strength);
    joints.Head = jt('Head', T.head + T.headAmp * n('HeadF'), T.headTwistAmp * n('HeadT'), T.headSideAmp * n('HeadS'), T.strength);
    // 손: 상처(가까운 손 + 다른 손은 그 옆) 또는 배를 감싼다
    this.holds ??= this.pickHolds(ctx);
    const s2 = bodyPose(ctx.rd, 'Spine2');
    const H = p.hand;
    for (const h of HANDS) {
      const hd = this.holds[h];
      if (!hd) continue;
      const ch = armChain(def, h);
      const bp = bodyPose(ctx.rd, hd.body);
      const nrm = normalize(rotate(bp.rot, hd.normal));
      const wander: Vec3 = [H.wander * n(`${h}X`), H.wander * n(`${h}Y`), 0];
      const palm = add(add(add(bp.pos, rotate(bp.rot, hd.local)), scale(nrm, H.palmClear)), rotate(bp.rot, wander));
      const q = handRotation(ch, scale(nrm, -1), rotate(bp.rot, hd.fingers ?? [-ch.side, -0.4, 0]));
      const ep = hd.pole ?? H.elbowPole;
      const pole = rotate(s2.rot, [ep[0] * ch.side, ep[1], ep[2]]);
      const sol = solveArm(def, ch, s2.rot, s2.pos, palm, q, H.palmLocal, pole);
      for (const [jn, tq] of Object.entries(sol.targets)) {
        const l = lie[jn as JointName]!;
        joints[jn as JointName] = { target: slerp(st[jn as JointName] ?? l.target!, rateLimited(this.prevT, jn as JointName, tq, H.maxTargetRate, ctx.dt, def), k), weight: 1, strength: l.strength! + (H.strength - l.strength!) * k };
      }
    }
    this.phase = k < 1 ? '몸부림 시작' : '몸부림';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }

  /** 상처가 있으면 가까운 손이 상처, 다른 손은 그 옆(같은 바디, 6cm 옆)을, 없으면 두 손이 배(Spine 앞 표면) 양쪽을 누른다 */
  private pickHolds(ctx: BehaviorContext): Partial<Record<HandName, { body: BodyName; local: Vec3; normal: Vec3; fingers?: Vec3; pole?: Vec3 }>> {
    const H = this.p.hand;
    const out: Partial<Record<HandName, { body: BodyName; local: Vec3; normal: Vec3; fingers?: Vec3; pole?: Vec3 }>> = {};
    const w = ctx.wounds.length ? ctx.wounds[ctx.wounds.length - 1]! : null;
    const torso = (b: BodyName) => b === 'Hips' || b === 'Spine' || b === 'Spine2';
    if (w && torso(w.body)) {
      const bp = bodyPose(ctx.rd, w.body);
      const wp = add(bp.pos, rotate(bp.rot, w.local));
      const dist = (h: HandName) => length(sub(bodyPose(ctx.rd, h).pos, wp));
      const near: HandName = dist('LeftHand') <= dist('RightHand') ? 'LeftHand' : 'RightHand';
      const other: HandName = near === 'LeftHand' ? 'RightHand' : 'LeftHand';
      out[near] = { body: w.body, local: w.local, normal: w.normalLocal };
      const shape = ctx.rd.body(w.body).def.shape;
      const side = near === 'LeftHand' ? -1 : 1;
      // 다른 손은 상처 옆 (그 손 쪽으로 7cm, 같은 바디 표면)
      const sn = surfaceAt(shape, add(add(w.local, scale(w.normalLocal, 0.05)), [side * 0.07, 0, 0]));
      out[other] = { body: w.body, local: sn.point, normal: sn.normal };
      return out;
    }
    // 엎드려 있으면(가슴이 아래) 배를 쥘 수 없다 — 두 손으로 머리 옆을 감싼다 (폭발·넘어짐 뒤 머리를 감싸 쥔 모습)
    const chest = rotate(bodyPose(ctx.rd, 'Spine2').rot, [0, 0, 1]);
    if (chest[1] < -0.5) {
      const hs = ctx.rd.body('Head').def.shape;
      for (const h of HANDS) {
        const x = h === 'LeftHand' ? 1 : -1;
        const sp = surfaceAt(hs, [x * 0.3, 0.03, 0.03]);
        out[h] = { body: 'Head', local: sp.point, normal: sp.normal, fingers: [0, 1, 0], pole: this.p.hand.headElbowPole };
      }
      return out;
    }
    const shape = ctx.rd.body('Spine').def.shape;
    for (const h of HANDS) {
      const x = (h === 'LeftHand' ? 1 : -1) * H.bellyX;
      // Spine 바디 로컬 앞(+Z) 멀리 점에서 가장 가까운 표면 = 배 앞
      const s = surfaceAt(shape, [x, H.bellyY, 0.4]);
      out[h] = { body: 'Spine', local: s.point, normal: s.normal };
    }
    return out;
  }
  override info(): Record<string, unknown> { return { holds: this.holds ? Object.fromEntries(Object.entries(this.holds).map(([h, v]) => [h, v!.body])) : null }; }
}
