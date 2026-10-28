// HoldWound (SPEC v0.5a 행동 목록, 대표 장면 세부 규칙): 가까운 손을 맞은 지점(맞은 바디 로컬에 고정)에 IK로 가져가 누른다.
// 손 고르기: 상처까지 팔이 닿고 덜 바쁜 손, 같은 쪽 우선, 몸통(가슴·배·머리)의 반대쪽이면 반대 손도 허용, 맞은 팔 자체는 못 씀.
// 손바닥이 상처를 향하게 손 방향도 목표에 넣고, 목표는 몸 표면에서 손바닥 두께 + palmClear만큼 띄운다.
// 팔은 2관절 IK 자세 목표 + 전신 QP 손 과제, 몸통은 상처 쪽으로 웅크린다.
// (결정 leg-2) 다리 상처는 도달 판단(legReach)을 먼저 한다: 몸통을 얼마나 숙여야 닿는지·상처가 뒤를 향하는지·넘어짐 확실도를 보고
// 'hold'(쥐기) / 'kneelWait'(무릎을 꿇은 뒤 다시 판단) / 'gesture'(상처 쪽으로 손을 뻗었다 거두며 바라보기)를 고른다.
import type { BodyName } from '../characterDef';
import type { JointName } from '../pose';
import type { Wound } from '../hitModel';
import { type Vec3, add, sub, scale, cross, dot, length, normalize } from '../../math/vec3';
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
  /**
   * (결정 leg-3) 팔 IK 목표(관절 자세)는 손바닥 목표를 어깨에서 팔 길이 × ikReachFrac 안으로 당겨 푼다. 다 편 팔은 팔꿈치 굽힘 평면이
   * 정해지지 않아(교차곱이 잡음) 위팔 목표가 프레임마다 ±90° 비틀기 사이로 뒤집혀 팔이 50 rad/s로 돌았다(폭발 판정).
   * 손바닥 자체(전신 QP 손 과제)는 원래 목표를 쫓으므로 모자란 거리는 몸통이 숙여 채운다. 다리 상처(legReach 부위)에만 건다.
   */
  ikReachFrac?: number;
  freeArm: { reflexScale: number; abductDeg: number; hold: number; release: number; loose: number; looseMotorScale: number; looseReg: number; parts?: string[] };
  /** (결정 leg-2) 다리 상처 도달 판단. 없으면 예전처럼 늘 쥔다 */
  legReach?: LegReachParams;
}

/** 다리 상처 도달 판단 (behaviors.json HoldWound.legReach) */
export interface LegReachParams {
  /** 판단을 하는 부위 (bodyRegion 값) */
  regions: string[];
  /** 서서 쥘 때 허용하는 몸통(고관절 축) 굽힘 (도) */
  standMaxBendDeg: number;
  /** 뒤를 향한 상처: 앞으로 숙여도 가까워지지 않으므로 이만큼 안에서 닿을 때만 (손을 등 뒤로) */
  backMaxBendDeg: number;
  /** 무릎을 꿇은 뒤 허용 굽힘 */
  kneelMaxBendDeg: number;
  /** 상처 법선·골반 앞 방향 내적이 이보다 작으면 '뒤' */
  backDot: number;
  /** 꿇은 뒤: 법선·위 내적이 이보다 작으면(바닥을 향함) 못 쥔다 */
  downDot: number;
  /** 판단 시 넘어짐 확실도가 이 이상이면 서서 쥐지 않는다 (균형 여유) */
  fallCertaintyMax: number;
  /** 서서 쥐거나 뻗는 동안 넘어짐 확실도가 이 이상이 되면 손을 거둔다 */
  abortCertainty: number;
  /** 꿇기를 기다리는 최대 시간 (초), 무릎이 닿은 뒤 자리 잡는 시간 (초) */
  kneelWaitMax: number; kneelSettle: number;
  /** 꿇음 판정: Spine2가 골반보다 이만큼(m) 넘게 위 (누운 몸의 정강이 접촉 제외) */
  kneelUprightDy: number;
  /**
   * 뻗었다 거두기: 손이 어깨 → 상처 방향으로 팔 길이 × reachFrac까지, 닿은 뒤 hold초 머문 뒤 거둔다.
   * 뻗어도 손바닥이 상처에 minMove m 넘게 가까워지지 않으면(발·정강이처럼 늘어뜨린 손 아래 멀리 있는 상처) 손은 그대로 두고 내려다보기만(look)
   */
  gesture: { reachFrac: number; hold: number; minMove: number };
}

export type HoldMode = 'hold' | 'kneelWait' | 'gesture' | 'look';

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
  /** (결정 leg-2) 다리 상처 판단: 쥐기·꿇은 뒤 쥐기 대기·뻗었다 거두기 */
  mode: HoldMode = 'hold';
  /** 손을 쓰는가 (꿇기 대기·내려다보기는 손을 쓰지 않는다 — 블렌더의 바쁜 손·팔 묶음 판단) */
  get usesHand(): boolean { return this.mode === 'hold' || this.mode === 'gesture'; }
  /** 판단 근거 (로그): 닿는 데 필요한 굽힘(도, 못 닿으면 999), 허용 굽힘, 상처 법선·앞 내적, 판단 때 넘어짐 확실도, 판단 이유 */
  reach: { needDeg: number; allowDeg: number; facing: number; certainty: number; why: string } | null = null;
  /** 상처를 뒤에서 쥔다 (허벅지 뒤가 숙이지 않고 닿을 때) */
  private gripBack = false;
  /** 감싸 쥐기 회전 방향 (처음 정한 것을 유지 — 상처가 쥐는 쪽 반대를 향하면 부호가 프레임마다 뒤집혀 팔이 튀었다, 결정 leg-3) */
  private wrapSign = 0;
  /** 뻗었다 거두기 목표 (맞은 바디 로컬) */
  private gestureLocal: Vec3 | null = null;
  private kneelDownT: number | null = null;
  /** IK 목표를 당긴 최대 거리 (m, 로그) */
  ikPulled = 0;

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
      // 다리 상처는 같은 쪽 손만 (서서 반대쪽 다리까지는 못 뻗는다)
      const leg = this.isLeg(region);
      if (leg && sameSide === false) continue;
      // 팔이 닿는지: 어깨 → 목표 거리 (다리는 몸통을 굽힌 뒤라 거리 검사 대신 같은 쪽만 — 닿는지는 planLeg가 본다)
      const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
      const L = ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand));
      if (!leg && length(sub(targetWorld, S)) > p.maxReach * L) continue;
      // 몸통이 아닌 곳(팔)의 반대쪽은 반대 손만 가능하므로 그대로 허용
      let cost = sameSide === null ? p.costMidline : sameSide ? p.costSameSide : TORSO.has(w.body) || ARM_OF.LeftHand.includes(w.body) || ARM_OF.RightHand.includes(w.body) ? p.costOtherSide : Infinity;
      if (ctx.busyHands.has(h)) cost += p.costBusy;
      if (h === 'RightHand') cost -= p.preferRight;
      cost += 0.1 * length(sub(targetWorld, S));
      if (!best || cost < best.cost) best = { h, cost };
    }
    return best && Number.isFinite(best.cost) ? best.h : null;
  }

  private isLeg(region: string): boolean {
    return region === 'thigh' || (this.p.legReach?.regions.includes(region) ?? false);
  }

  /**
   * (결정 leg-2) 다리 상처 도달 판단. 몸통을 골반 원점 둘레로 앞으로 θ 굽혔을 때 어깨 → 목표 거리가 maxReach × 팔 길이 안에 드는
   * 가장 작은 θ(2.5° 간격)를 needDeg로, 허용 굽힘(서서 / 뒤 상처 / 꿇은 뒤)과 견준다. 넘어짐 확실도가 높으면 서서 쥐지 않는다.
   */
  private planLeg(ctx: BehaviorContext, w: Wound, hand: HandName, kneeling: boolean): { mode: HoldMode; back: boolean } {
    const lr = this.p.legReach!;
    const ch = armChain(ctx.def, hand);
    const b = bodyPose(ctx.rd, w.body);
    const P = add(b.pos, rotate(b.rot, this.targetLocal));
    const n = rotate(b.rot, w.normalLocal);
    const hips = bodyPose(ctx.rd, 'Hips');
    const f3 = rotate(hips.rot, [0, 0, 1]);
    const fw = normalize([f3[0], 0, f3[2]]);
    const lat = rotate(hips.rot, [1, 0, 0]);
    const s2 = bodyPose(ctx.rd, 'Spine2');
    const S0 = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
    const L = (ch.l1 + ch.l2 + length(sub(this.p.palmLocal, ch.wristInHand))) * this.p.maxReach;
    let need = 999;
    for (let d = 0; d <= 90; d += 2.5) {
      const S = add(hips.pos, rotate(fromAxisAngle(lat, (d * Math.PI) / 180), sub(S0, hips.pos)));
      if (length(sub(P, S)) <= L) { need = d; break; }
    }
    const facing = dot(n, fw);
    const back = facing < lr.backDot;
    const cert = ctx.fall?.certainty ?? 0;
    const allow = kneeling ? lr.kneelMaxBendDeg : back ? lr.backMaxBendDeg : lr.standMaxBendDeg;
    let mode: HoldMode, why: string;
    if (kneeling && n[1] < lr.downDot) { mode = 'gesture'; why = '상처가 바닥을 향함'; }
    else if (need > allow) { mode = !kneeling && ctx.badlyHurt ? 'kneelWait' : 'gesture'; why = back ? '뒤 상처 — 숙여도 안 닿음' : '너무 많이 숙여야 함'; }
    else if (!kneeling && cert >= lr.fallCertaintyMax) { mode = ctx.badlyHurt ? 'kneelWait' : 'gesture'; why = '균형 여유 없음'; }
    else { mode = 'hold'; why = kneeling ? '꿇은 뒤 닿음' : '닿음'; }
    this.reach = { needDeg: need, allowDeg: allow, facing, certainty: cert, why };
    return { mode, back };
  }

  /**
   * 뻗었다 거두기 목표: 지금 어깨 → 상처 방향으로 팔 길이 × reachFrac (맞은 바디 로컬). 매 스텝 다시 잡는다 — 팔을 다 펴면
   * 2관절 IK의 팔꿈치 방향이 정해지지 않아 위팔 목표가 150° 뒤집히며 팔이 튀었다(폭발 판정)
   */
  private setGesture(ctx: BehaviorContext, w: Wound, hand: HandName, decide = false): void {
    const ch = armChain(ctx.def, hand);
    const b = bodyPose(ctx.rd, w.body);
    const P = add(b.pos, rotate(b.rot, add(w.local, scale(w.normalLocal, this.p.palmClear))));
    const s2 = bodyPose(ctx.rd, 'Spine2');
    const S = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
    const L = ch.l1 + ch.l2 + length(sub(this.p.palmLocal, ch.wristInHand));
    const d = sub(P, S), dl = length(d);
    const k = this.p.legReach!.gesture.reachFrac;
    const G = dl > L * k ? add(S, scale(d, (L * k) / dl)) : P;
    this.gestureLocal = rotate(conjugate(b.rot), sub(G, b.pos));
    // 처음 판단 때만: 뻗어도 상처에 minMove 넘게 가까워지지 않으면(늘어뜨린 손이 이미 가장 가까움) 뻗지 않고 내려다보기만
    if (decide && this.mode === 'gesture' && length(sub(this.palmWorld(ctx, hand), P)) - length(sub(G, P)) < this.p.legReach!.gesture.minMove && this.reach) {
      this.mode = 'look';
      this.reach.why += ' · 손이 이미 가장 가까움 → 내려다보기';
    }
  }

  /** 손 궤적 시작점을 지금 손바닥으로 다시 잡는다 (꿇은 뒤 쥐기 시작) */
  private restartReach(ctx: BehaviorContext, t: number): void {
    const hp = bodyPose(ctx.rd, this.hand!);
    const palm = add(hp.pos, rotate(hp.rot, this.p.palmLocal));
    const f0 = bodyPose(ctx.rd, this.frameBody);
    this.startLocal = rotate(conjugate(f0.rot), sub(palm, f0.pos));
    this.startRel = multiplyQ(conjugate(f0.rot), hp.rot);
    this.reachStart = t;
  }

  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p;
    const t = ctx.t;
    if (t < this.startT) return { joints: {} };
    // (v0.9 퍼징) 손을 못 고른 뒤 멈추는 동안에도 update가 불린다 — 상처는 찾았지만 팔 사슬이 없다
    if (this.failed) return { joints: {} };
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
      if (p.legReach && this.isLeg(this.region)) {
        const pl = this.planLeg(ctx, w, this.hand, false);
        this.mode = pl.mode;
        this.gripBack = pl.back;
        if (this.mode === 'gesture') this.setGesture(ctx, w, this.hand, true);
      }
    }
    const lr = p.legReach;
    // (결정 leg-2) 꿇기 대기: 무릎(정강이 바디)이 바닥에 닿고 kneelSettle초 뒤 다시 판단 — 닿으면 쥐고, 아니면 뻗었다 거두기
    if (this.mode === 'kneelWait' && lr) {
      // 무릎이 닿았고 상체가 서 있어야 꿇은 것 (쓰러져 누운 채 정강이가 닿은 것은 꿇음이 아니다)
      const upright = bodyPose(ctx.rd, 'Spine2').pos[1] - bodyPose(ctx.rd, 'Hips').pos[1] > lr.kneelUprightDy;
      const down = (ctx.per.ground.has('LeftLeg') || ctx.per.ground.has('RightLeg')) && upright;
      if (down) this.kneelDownT ??= t;
      if ((this.kneelDownT !== null && t - this.kneelDownT >= lr.kneelSettle) || t - this.startT >= lr.kneelWaitMax) {
        const pl = this.planLeg(ctx, this.wound, this.hand!, this.kneelDownT !== null);
        this.mode = pl.mode === 'kneelWait' ? 'gesture' : pl.mode;
        this.gripBack = pl.back;
        if (this.mode === 'gesture') this.setGesture(ctx, this.wound, this.hand!, true);
        this.restartReach(ctx, t);
      } else {
        // 기다리는 동안은 상처를 바라보기만 (손은 균형·꿇기에 맡긴다)
        const bw = bodyPose(ctx.rd, this.wound.body);
        this.phase = '꿇기 대기';
        this.last = null;
        return { joints: { Head: { add: degQ(p.regions.legLook?.headFlex ?? 0, 0, 0), weight: 1 } }, gaze: { target: add(bw.pos, rotate(bw.rot, this.wound.local)), weight: p.gazeWeight } };
      }
    }
    // (결정 leg-2) 서서 쥐거나 뻗는 동안 넘어질 듯하면 손을 거둔다 (쥐려다 균형을 잃지 않게)
    if (lr && this.isLeg(this.region) && this.kneelDownT === null && (ctx.fall?.certainty ?? 0) >= lr.abortCertainty && this.stopT === null) {
      if (this.reach) this.reach.why += ' → 넘어질 듯해 거둠';
      this.stop(t);
    }
    // 뻗었다 거두기·내려다보기: 손이 닿고(내려다보기는 같은 시간) hold초 뒤 끈다 (블렌더 전환 동안 손이 돌아간다)
    if ((this.mode === 'gesture' || this.mode === 'look') && lr && t - this.reachStart >= this.reachT + lr.gesture.hold) this.stop(t);
    // 크게 다쳐 무릎을 꿇을 정도면(피해 누적, v0.5b) 상처를 계속 누른다
    if (t - this.startT >= p.duration && !(ctx.badlyHurt && this.mode === 'hold')) this.stop(t);
    const w = this.wound;
    const ch = this.chain!;
    const hand = this.hand!;
    const b = bodyPose(ctx.rd, w.body);
    // 팔다리 상처: 손바닥은 팔다리를 감싸 쥔다 — 상처 법선이 쥐는 손 어깨 쪽에서 maxWrapDeg 넘게 돌아가 있으면(맞은 팔이 비틀려 상처가 뒤를 향함)
    // 같은 축 위치에서 어깨 쪽으로 돌린 표면 점을 쥔다 (상처에서 반지름 × 각 거리 안)
    let gripN = w.normalLocal;
    const shp = ctx.def.bodies.find((x) => x.name === w.body)!.shape;
    if (this.mode === 'gesture' && this.gestureLocal) {
      this.setGesture(ctx, w, hand);
      this.targetLocal = this.gestureLocal;
      const tl = sub(this.gestureLocal, w.local);
      gripN = length(tl) > 1e-6 ? normalize(tl) : w.normalLocal;
    } else if (!TORSO.has(w.body) && shp.type === 'capsule') {
      const ax = rotate(shp.rotation, [0, 1, 0]);
      const h0 = Math.max(-shp.halfHeight, Math.min(shp.halfHeight, dot(w.local, ax)));
      const c = scale(ax, h0);
      // 쥐기 좋은 쪽 = 몸 앞 + 쥐는 손 어깨 쪽 조금 (어깨 쪽만 보면 몸통 속을 가리킨다)
      const S = add(s2Now(ctx).pos, rotate(s2Now(ctx).rot, ch.shoulderInSpine2));
      const cw = add(b.pos, rotate(b.rot, c));
      const toS = sub(S, cw);
      // 뒤에서 쥘 때(gripBack)는 몸 뒤 + 어깨 쪽 (결정 leg-2)
      const fw = rotate(bodyPose(ctx.rd, 'Hips').rot, [0, 0, this.gripBack ? -1 : 1]);
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
          if (!this.wrapSign) this.wrapSign = dot(cross(w.normalLocal, dp), ax) >= 0 ? 1 : -1;
          const sgn = this.wrapSign;
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
    // 뻗었다 거두기는 손 방향을 처음 그대로 둔다 (손바닥을 상처로 돌리면 아래로 뻗은 팔에서 손목이 크게 비틀렸다)
    const qRef = this.mode === 'gesture' ? q0 : slerp(q0, qFin, smoothstep(s * 1.15));
    // (결정 leg-3) 다리 상처의 IK 목표는 팔 길이 × ikReachFrac 안으로 (다 편 팔의 팔꿈치 평면 뒤집힘 방지).
    // 몸통 상처에는 걸지 않는다 — 등 뒤 배 상처를 쥔 채 일어서기가 달라져 getup_random_x20 시드 1009가 실패했다
    let palmIk = palmRef;
    if (p.ikReachFrac && this.isLeg(this.region)) {
      const Sh = add(s2.pos, rotate(s2.rot, ch.shoulderInSpine2));
      const Lmax = (ch.l1 + ch.l2 + length(sub(p.palmLocal, ch.wristInHand))) * p.ikReachFrac;
      const dv = sub(palmRef, Sh), dl = length(dv);
      if (dl > Lmax) { palmIk = add(Sh, scale(dv, Lmax / dl)); this.ikPulled = Math.max(this.ikPulled, dl - Lmax); }
    }
    const sol = solveArm(ctx.def, ch, s2.rot, s2.pos, palmIk, qRef, p.palmLocal, pole);
    // 웅크림: 부위별 각 × 강도, 손이 가는 동안 같이 커진다
    // (결정 leg-2) 다리: 뒤에서 쥐면 숙이지 않는 thighBack, 꿇은 뒤면 kneelHold, 뻗었다 거두기는 legLook
    const rk = this.mode === 'gesture' || this.mode === 'look' ? 'legLook' : this.kneelDownT !== null ? 'kneelHold' : this.gripBack ? 'thighBack' : this.region;
    const r = p.regions[rk] ?? p.regions[this.region] ?? p.regions.chest!;
    // 두 번째 이후 움켜쥐기(crouch false)는 손만 — 웅크림은 겹치지 않는다 (v0.5b)
    const k = p.crouch === false ? 0 : p.intensity * smoothstep(s * 1.3);
    const joints: Partial<Record<JointName, JointOut>> = {};
    // 내려다보기(look)는 팔을 움직이지 않는다 — 웅크림·시선·쥐지 않는 팔 설정만 (팔 반사를 그대로 두면 정강이 앞 서서 넘어짐이 4 → 10/24로 늘었다)
    if (this.mode !== 'look') for (const [jn, q] of Object.entries(sol.targets)) joints[jn as JointName] = { target: q, weight: 1 };
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
    this.phase = this.mode === 'look' ? '상처 내려다보기' : this.mode === 'gesture' ? (s < 1 ? '상처 쪽으로 손 뻗기' : '손 거두기 전') : s < 1 ? '손 뻗기' : '누르기';
    const hands: Partial<Record<HandName, HandTarget>> = this.mode === 'look' ? {} : {
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
    return { hand: this.hand, region: this.region, woundId: this.p.woundId, failed: this.failed || undefined, mode: this.mode, ...(this.reach ? { reach: this.reach, gripBack: this.gripBack } : {}), ...(this.ikPulled > 0 ? { ikPulled: this.ikPulled } : {}) };
  }
}
