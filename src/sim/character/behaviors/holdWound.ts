// HoldWound (SPEC v0.5a 행동 목록, 대표 장면 세부 규칙): 가까운 손을 맞은 지점(맞은 바디 로컬에 고정)에 IK로 가져가 누른다.
// 손 고르기: 상처까지 팔이 닿고 덜 바쁜 손, 같은 쪽 우선, 몸통(가슴·배·머리)의 반대쪽이면 반대 손도 허용, 맞은 팔 자체는 못 씀.
// 손바닥이 상처를 향하게 손 방향도 목표에 넣고, 목표는 몸 표면에서 손바닥 두께 + palmClear만큼 띄운다.
// 팔은 2관절 IK 자세 목표 + 전신 QP 손 과제, 몸통은 상처 쪽으로 웅크린다.
import type { BodyName } from '../characterDef';
import type { JointName } from '../pose';
import type { Wound } from '../hitModel';
import { type Vec3, add, sub, scale, cross, dot, length } from '../../math/vec3';
import { type Quat, conjugate, fromAxisAngle, multiplyQ, rotate, slerp } from '../../math/quat';
import { Behavior, envelope, smoothstep, type BehaviorContext, type BehaviorOutput, type HandName, type HandTarget, type JointOut, HANDS } from './types';
import { armChain, bodyPose, degQ, handRotation, solveArm, type ArmChain } from './kinematics';

interface Region { spineFlex: number; spine2Flex: number; sideDeg: number; twistDeg: number; hipFlex: number; kneeFlex: number; headFlex: number }

export interface HoldWoundParams {
  woundId: number;
  hand?: 'auto' | HandName;
  duration: number;
  intensity: number;
  reachTime: number;
  reachSpeed?: number;
  relaxPer40Deg?: number;
  guardArm?: { local: Vec3; pole: Vec3 };
  maxWrapDeg?: number;
  crossBulge?: number;
  maxReachTime?: number;
  approachBulge?: number;
  palmLocal: Vec3;
  palmClear: number;
  maxReach: number;
  costSameSide: number;
  costOtherSide: number;
  costMidline: number;
  costBusy: number;
  midlineHalfWidth: number;
  preferRight: number;
  elbowPole: Vec3;
  task: HandTarget['task'];
  gazeWeight: number;
  regions: Record<string, Region>;
  bodyRegion: Partial<Record<BodyName, string>>;
  shoulderY: number;
  shoulderX: number;
  /** 웅크림을 더할지 (v0.5b: 이미 다른 상처를 쥐고 있으면 false) */
  crouch?: boolean;
  freeArm: { reflexScale: number; abductDeg: number; hold: number; release: number; loose: number; looseMotorScale: number; looseReg: number; parts?: string[] };
}

const ARM_OF: Record<HandName, BodyName[]> = { LeftHand: ['LeftArm', 'LeftForeArm', 'LeftHand'], RightHand: ['RightArm', 'RightForeArm', 'RightHand'] };
const TORSO = new Set<BodyName>(['Hips', 'Spine', 'Spine2', 'Head']);
const s2Now = (ctx: BehaviorContext) => bodyPose(ctx.rd, 'Spine2');
const minJerk = (x: number): { s: number; ds: number } => {
  const u = Math.max(0, Math.min(1, x));
  return { s: u * u * u * (10 - 15 * u + 6 * u * u), ds: x <= 0 || x >= 1 ? 0 : 30 * u * u * (1 - u) * (1 - u) };
};

export class HoldWound extends Behavior {
  readonly name = 'HoldWound';
  private readonly p: HoldWoundParams;
  hand: HandName | null = null;
  private chain: ArmChain | null = null;
  private wound: Wound | null = null;
  private region = 'chest';
  private startLocal: Vec3 = [0, 0, 0];
  private startRel: Quat = [0, 0, 0, 1];
  private targetLocal: Vec3 = [0, 0, 0];
  private sideSign = 0;
  private reachStart = 0;
  private reachT = 0.3;
  private frameBody: BodyName = 'Spine2';
  /** 로그: 손바닥 점(월드), 목표(월드), 상처(월드), 거리 */
  last: { palm: Vec3; target: Vec3; wound: Vec3; normal: Vec3; dist: number; ref: Vec3 } | null = null;
  failed = '';

  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as HoldWoundParams;
  }

  private palmWorld(ctx: BehaviorContext, h: HandName): Vec3 {
    const b = bodyPose(ctx.rd, h);
    return add(b.pos, rotate(b.rot, this.p.palmLocal));
  }

  /** 손 고르기 (SPEC 세부 규칙). 못 고르면 null */
  private choose(ctx: BehaviorContext, w: Wound, targetWorld: Vec3): HandName | null {
    const p = this.p;
    if (p.hand && p.hand !== 'auto') return p.hand;
    const hips = bodyPose(ctx.rd, 'Hips');
    const lat = rotate(hips.rot, [1, 0, 0]);
    const x = dot(sub(targetWorld, hips.pos), lat);
    const s2 = bodyPose(ctx.rd, 'Spine2');
    let best: { h: HandName; cost: number } | null = null;
    for (const h of HANDS) {
      if (ARM_OF[h].includes(w.body)) continue; // 맞은 팔 자체는 못 쥔다
      const ch = armChain(ctx.def, h);
      const side = ch.side;
      const region = p.bodyRegion[w.body] ?? 'chest';
      const sameSide = Math.abs(x) < p.midlineHalfWidth ? null : Math.sign(x) === side;
      // 다리 상처는 같은 쪽 손만 (서서 반대쪽 허벅지까지는 못 뻗는다)
      if (region === 'thigh' && sameSide === false) continue;
      // 팔이 닿는지: 어깨 → 목표 거리 (허벅지는 몸통을 굽힌 뒤라 거리 검사 대신 같은 쪽만)
      const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
      const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
      if (region !== 'thigh' && length(sub(targetWorld, S)) > p.maxReach * L) continue;
      // 몸통이 아닌 곳(팔)의 반대쪽은 반대 손만 가능하므로 그대로 허용
      let cost = sameSide === null ? p.costMidline : sameSide ? p.costSameSide : TORSO.has(w.body) || ARM_OF.LeftHand.includes(w.body) || ARM_OF.RightHand.includes(w.body) ? p.costOtherSide : Infinity;
      if (ctx.busyHands.has(h)) cost += p.costBusy;
      if (h === 'RightHand') cost -= p.preferRight;
      cost += 0.1 * length(sub(targetWorld, S));
      if (!best || cost < best.cost) best = { h, cost };
    }
    return best && Number.isFinite(best.cost) ? best.h : null;
  }

  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p;
    const t = ctx.t;
    if (t < this.startT) return { joints: {} };
    if (!this.wound) {
      this.wound = ctx.wounds.find((w) => w.id === p.woundId) ?? null;
      if (!this.wound) { this.failed = 'no wound'; this.stop(t); return { joints: {} }; }
      const w = this.wound;
      // 손바닥 점(palmLocal)은 손바닥 표면이라 상처 표면에서 palmClear만 띄운다 (손이 몸을 뚫지 않게)
      this.targetLocal = add(w.local, scale(w.normalLocal, p.palmClear));
      const b = bodyPose(ctx.rd, w.body);
      const targetWorld = add(b.pos, rotate(b.rot, this.targetLocal));
      this.hand = this.choose(ctx, w, targetWorld);
      if (!this.hand) { this.failed = 'no reachable hand'; this.stop(t); return { joints: {} }; }
      this.chain = armChain(ctx.def, this.hand);
      this.region = p.bodyRegion[w.body] ?? 'chest';
      // Spine2의 어깨 높이·옆이면 '어깨' 웅크림
      if (w.body === 'Spine2' && w.local[1] > p.shoulderY && Math.abs(w.local[0]) > p.shoulderX) this.region = 'shoulder';
      const hp = bodyPose(ctx.rd, this.hand);
      const palm = add(hp.pos, rotate(hp.rot, p.palmLocal));
      // 궤적 기준 바디: 팔 상처는 Spine2 (맞은 팔이 휘둘려도 손 궤적이 몸 뒤로 돌지 않게), 나머지는 맞은 바디
      this.frameBody = ARM_OF.LeftHand.includes(w.body) || ARM_OF.RightHand.includes(w.body) ? 'Spine2' : w.body;
      const f0 = bodyPose(ctx.rd, this.frameBody);
      this.startLocal = rotate(conjugate(f0.rot), sub(palm, f0.pos));
      this.startRel = multiplyQ(conjugate(f0.rot), hp.rot);
      const hips = bodyPose(ctx.rd, 'Hips');
      this.sideSign = Math.sign(dot(sub(targetWorld, hips.pos), rotate(hips.rot, [1, 0, 0]))) || 0;
      this.reachStart = t;
      this.reachT = Math.max(p.reachTime, Math.min(p.maxReachTime ?? 0.6, length(sub(targetWorld, palm)) / (p.reachSpeed ?? 2.4)));
    }
    // 크게 다쳐 무릎을 꿇을 정도면(피해 누적, v0.5b) 상처를 계속 누른다
    if (t - this.startT >= p.duration && !ctx.badlyHurt) this.stop(t);
    const w = this.wound;
    const ch = this.chain!;
    const hand = this.hand!;
    const b = bodyPose(ctx.rd, w.body);
    // 팔다리 상처: 손바닥은 팔다리를 감싸 쥔다 — 상처 법선이 쥐는 손 어깨 쪽에서 maxWrapDeg 넘게 돌아가 있으면(맞은 팔이 비틀려 상처가 뒤를 향함)
    // 같은 축 위치에서 어깨 쪽으로 돌린 표면 점을 쥔다 (상처에서 반지름 × 각 거리 안)
    let gripN = w.normalLocal;
    const shp = ctx.def.bodies.find((x) => x.name === w.body)!.shape;
    if (!TORSO.has(w.body) && shp.type === 'capsule') {
      const ax = rotate(shp.rotation, [0, 1, 0]);
      const h0 = Math.max(-shp.halfHeight, Math.min(shp.halfHeight, dot(w.local, ax)));
      const c = scale(ax, h0);
      // 쥐기 좋은 쪽 = 몸 앞 + 쥐는 손 어깨 쪽 조금 (어깨 쪽만 보면 몸통 속을 가리킨다)
      const S = add(s2Now(ctx).pos, rotate(s2Now(ctx).rot, ch.shoulderInSpine2));
      const cw = add(b.pos, rotate(b.rot, c));
      const toS = sub(S, cw);
      const fw = rotate(bodyPose(ctx.rd, 'Hips').rot, [0, 0, 1]);
      const pref = add(fw, scale([toS[0], 0, toS[2]], 0.3 / Math.max(0.05, Math.hypot(toS[0], toS[2]))));
      let dp = rotate(conjugate(b.rot), pref);
      dp = sub(dp, scale(ax, dot(dp, ax)));
      const dl = length(dp);
      if (dl > 1e-6) {
        dp = scale(dp, 1 / dl);
        const a = Math.acos(Math.max(-1, Math.min(1, dot(w.normalLocal, dp))));
        const maxW = ((p.maxWrapDeg ?? 70) * Math.PI) / 180;
        if (a > maxW) {
          // 법선을 팔다리 축 둘레로 dp 쪽으로 (a − maxW)만큼 돌린다 (선형 섞기는 거의 반대 방향일 때 엉뚱한 쪽이 나왔다)
          const sgn = dot(cross(w.normalLocal, dp), ax) >= 0 ? 1 : -1;
          gripN = rotate(fromAxisAngle(ax, sgn * (a - maxW)), w.normalLocal);
        }
      }
      this.targetLocal = add(add(c, scale(gripN, shp.radius)), scale(gripN, p.palmClear));
    }
    // 최소 저크 궤적 (맞은 바디 로컬): 시작 손바닥 → 목표, 가운데는 상처 법선 쪽으로 볼록(몸을 뚫고 지나가지 않게)
    // 뻗는 시간: 거리 / 평균 속도 (사람 빠른 뻗기 평균 2~2.5 m/s), [reachTime, maxReachTime]
    const T = this.reachT;
    const { s, ds } = minJerk((t - this.reachStart) / T);
    const bulge = p.approachBulge ?? 0.06;
    const fb = this.frameBody === w.body ? b : bodyPose(ctx.rd, this.frameBody);
    const n = rotate(b.rot, gripN);
    const tF = rotate(conjugate(fb.rot), sub(add(b.pos, rotate(b.rot, this.targetLocal)), fb.pos));
    const nF = rotate(conjugate(fb.rot), n);
    const d = sub(tF, this.startLocal);
    const bump = 4 * s * (1 - s), dbump = 4 - 8 * s;
    // 볼록: 상처 법선 쪽 bulge + 몸 앞쪽으로 옆 이동 거리 × crossBulge (반대편으로 건너가는 손이 배를 뚫고 지나가지 않게, 기준 바디 로컬 +Z = 앞)
    const fwdF = rotate(conjugate(fb.rot), rotate(bodyPose(ctx.rd, 'Hips').rot, [0, 0, 1]));
    const bv = add(scale(nF, bulge), scale(fwdF, (p.crossBulge ?? 0) * Math.abs(d[0])));
    const pl = add(add(this.startLocal, scale(d, s)), scale(bv, bump));
    const vl = scale(add(d, scale(bv, dbump)), ds / T);
    const palmRef = add(fb.pos, rotate(fb.rot, pl));
    const velRef = add(add(fb.vel, cross(fb.angVel, sub(palmRef, fb.pos))), rotate(fb.rot, vl));
    // 손 방향: 손바닥이 상처 안쪽(−법선)을 향하고, 손가락은 팔꿈치 → 손바닥 방향을 이어간다(손목이 덜 꺾인다)
    const s2 = s2Now(ctx);
    const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
    const targetW = add(b.pos, rotate(b.rot, this.targetLocal));
    const q0 = multiplyQ(fb.rot, this.startRel);
    const guess = solveArm(ctx.def, ch, s2.rot, s2.pos, targetW, q0, p.palmLocal, pole);
    const qFin = handRotation(ch, scale(n, -1), sub(targetW, guess.elbow));
    const qRef = slerp(q0, qFin, smoothstep(s * 1.15));
    const sol = solveArm(ctx.def, ch, s2.rot, s2.pos, palmRef, qRef, p.palmLocal, pole);
    // 웅크림: 부위별 각 × 강도, 손이 가는 동안 같이 커진다
    const r = p.regions[this.region] ?? p.regions.chest!;
    // 두 번째 이후 움켜쥐기(crouch false)는 손만 — 웅크림은 겹치지 않는다 (v0.5b)
    const k = p.crouch === false ? 0 : p.intensity * smoothstep(s * 1.3);
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const [jn, q] of Object.entries(sol.targets)) joints[jn as JointName] = { target: q, weight: 1 };
    // 맞은 팔은 몸에 붙여 감싼다(guardArm): 그 손을 배 앞(Spine 로컬 점)으로 — 팔이 뒤로 젖혀진 채면 상처가 반대 손에 닿지 않는다
    const hurt = HANDS.find((hn) => hn !== hand && ARM_OF[hn].includes(w.body));
    if (hurt && p.guardArm) {
      const gch = armChain(ctx.def, hurt);
      const sp = bodyPose(ctx.rd, 'Spine');
      const gp = add(sp.pos, rotate(sp.rot, [p.guardArm.local[0] * gch.side, p.guardArm.local[1], p.guardArm.local[2]]));
      const gpole = rotate(s2.rot, [p.guardArm.pole[0] * gch.side, p.guardArm.pole[1], p.guardArm.pole[2]]);
      const gq = handRotation(gch, rotate(sp.rot, [0, 0, -1]), rotate(sp.rot, [-gch.side, 0, 0]));
      const g = solveArm(ctx.def, gch, s2.rot, s2.pos, gp, gq, p.palmLocal, gpole);
      for (const [jn, q] of Object.entries(g.targets)) joints[jn as JointName] = { target: q, weight: smoothstep(s * 1.5) };
    }
    const tw = (hand === 'RightHand' ? 1 : -1) * r.twistDeg; // 쥐는 손 쪽 어깨가 앞으로
    const side = -this.sideSign * r.sideDeg; // 상처 쪽으로 옆 굽힘 (side+ = 오른쪽(−X)으로 굽힘)
    joints.Spine = { add: degQ(r.spineFlex * k, tw * 0.4 * k, side * 0.4 * k), weight: 1 };
    joints.Spine2 = { add: degQ(r.spine2Flex * k, tw * 0.6 * k, side * 0.6 * k), weight: 1 };
    joints.Head = { add: degQ(r.headFlex * k, 0, 0), weight: 1 };
    if (r.hipFlex > 0) { joints.LeftUpLeg = { add: degQ(r.hipFlex * k, 0, 0), weight: 1 }; joints.RightUpLeg = { add: degQ(r.hipFlex * k, 0, 0), weight: 1 }; }
    if (r.kneeFlex > 0) { joints.LeftLeg = { add: degQ(r.kneeFlex * k, 0, 0), weight: 1 }; joints.RightLeg = { add: degQ(r.kneeFlex * k, 0, 0), weight: 1 }; }
    const palmNow = this.palmWorld(ctx, hand);
    const woundW = add(b.pos, rotate(b.rot, w.local));
    this.last = { palm: palmNow, target: targetW, wound: woundW, normal: n, dist: length(sub(palmNow, targetW)), ref: palmRef };
    this.phase = s < 1 ? '손 뻗기' : '누르기';
    const hands: Partial<Record<HandName, HandTarget>> = {
      [hand]: { palm: palmRef, vel: velRef, rot: sol.qHand, angVel: b.angVel, palmLocal: p.palmLocal, weight: 1, task: p.task, woundId: w.id },
    };
    return {
      joints, hands,
      gaze: { target: woundW, weight: p.gazeWeight },
      tiltAllowDeg: (r.spineFlex + r.spine2Flex + r.hipFlex) * p.intensity,
      // 다른 팔은 비틀거리는 동안만 벌렸다가 내린다 (계속 벌리고 있으면 허수아비처럼 보였다)
      // 일부러 숙이는 만큼 스텝 문턱을 늦춘다 (몸통 굽힘 40°당 relaxPer40Deg m)
      stepping: { triggerRelax: (p.relaxPer40Deg ?? 0) * ((r.spineFlex + r.spine2Flex + r.hipFlex) * k) / 40 },
      freeArm: { reflexScale: p.freeArm.reflexScale, abductDeg: p.freeArm.abductDeg * envelope(t - this.startT, 0.1, p.freeArm.hold, p.freeArm.release), loose: p.freeArm.loose ?? 0, looseMotorScale: p.freeArm.looseMotorScale ?? 1, looseReg: p.freeArm.looseReg ?? 0, hands: HANDS.filter((h) => h !== hand), parts: p.freeArm.parts ?? ['Arm', 'ForeArm', 'Hand'] },
    };
  }

  override info(): Record<string, unknown> {
    return { hand: this.hand, region: this.region, woundId: this.p.woundId, failed: this.failed || undefined };
  }
}
