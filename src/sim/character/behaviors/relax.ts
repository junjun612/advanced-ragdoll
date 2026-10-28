// 충격 후 이완 (ImpactRelax)·누움 (Lie) — README 결정 relax-1~. 값: config/behaviors.json ImpactRelax·relaxStart·Lie.
// - ImpactRelax: 몸통·엉덩이·머리가 바닥에 세게 닿은 순간(수동 반응, 즉시) 전신 근육 강도 배율을 dropTime초에 부위별 수준(팔다리 limb,
//   몸통 trunk, 목 neck)까지 떨어뜨려 hold초 유지하고 recover초에 1로 되돌린다. 목표는 내지 않는다(강도 배율만) — 위·아래 행동
//   (누움·몸부림·구르기)의 강도에 곱해지므로, 회복은 그다음 행동의 강도로 자연히 이어진다. 깊이는 충돌 속도에 비례(minSpeed → fullSpeed).
// - Lie: 넘어짐 대비(BraceForFall)가 몸통으로 착지하면 대비를 끝내고 이 행동이 몸을 받는다. 착지 순간의 실제 관절 자세에서 누운 자세(lie)로
//   restTime초에 옮기고, 강도는 착지 직전 강도에서 누운 자세 강도로 내린다(서기 포즈 목표·강도 1로 되돌아가 판자처럼 굳던 문제, 결정 relax-3).
import type { JointName } from '../pose';
import type { CharacterDef } from '../characterDef';
import { type Quat, slerp } from '../../math/quat';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut } from './types';
import { bodyPose, relJoint } from './kinematics';
import { lieJoints, type LiePose } from './air';

export interface ImpactRelaxParams {
  /** 부위별 최저 강도 배율: 팔다리, 몸통(Spine·Spine2), 목(Head 관절) */
  limb: number; trunk: number; neck: number;
  /** 떨어뜨리는 시간, 최저 유지(떨어뜨린 뒤), 회복 시간 (초) */
  dropTime: number; hold: number; recover: number;
  /** 깊이: 충돌 속도(m/s) minSpeed에서 0, fullSpeed에서 1 */
  minSpeed: number; fullSpeed: number;
}

const LIMB = /Arm|Hand|Leg|Foot|Toe/;
/** 관절 부위: 팔다리 / 목 / 몸통 */
export function relaxRegion(jn: string): 'limb' | 'neck' | 'trunk' {
  return LIMB.test(jn) ? 'limb' : jn === 'Head' || jn === 'Neck' ? 'neck' : 'trunk';
}

/** 충격 후 이완: 강도 배율만 (즉시). 같은 행동이 있으면 블렌더가 retrigger로 다시 떨어뜨린다 */
export class ImpactRelax extends Behavior {
  readonly name = 'ImpactRelax';
  private readonly p: ImpactRelaxParams;
  /** 충격 시각·바디·충돌 속도·깊이 */
  impactT: number;
  body: string;
  speed: number;
  depth: number;
  /** 이번 스텝 팔다리 배율 (로그·필름 "충격 후 이완 0.4") */
  mul = 1;
  /** 다시 떨어뜨릴 때 시작 배율 (지금 값에서 이어짐) */
  private from = 1;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as ImpactRelaxParams;
    this.impactT = t0;
    this.body = String(params.body ?? '');
    this.speed = Number(params.speed ?? 0);
    this.depth = ImpactRelax.depthOf(this.p, this.speed);
  }
  static depthOf(p: ImpactRelaxParams, speed: number): number { return smoothstep((speed - p.minSpeed) / Math.max(1e-6, p.fullSpeed - p.minSpeed)); }
  override get immediate(): boolean { return true; }
  /** 회복 중에 더 센 충격(두 번째 바닥 충돌)이 오면 다시 떨어뜨린다 */
  retrigger(t: number, body: string, speed: number): void {
    const d = ImpactRelax.depthOf(this.p, speed);
    if (d <= 1e-6) return;
    this.from = this.envelopeAt(t);
    this.impactT = t; this.body = body; this.speed = speed; this.depth = Math.max(d, this.depth * this.from);
  }
  /** 0(그대로) ~ 1(최저) 이완 정도 */
  private envelopeAt(t: number): number {
    const p = this.p, tau = t - this.impactT;
    if (tau < 0) return 0;
    const fromE = this.from;
    if (tau < p.dropTime) return fromE + (1 - fromE) * smoothstep(tau / p.dropTime);
    if (tau < p.dropTime + p.hold) return 1;
    return 1 - smoothstep((tau - p.dropTime - p.hold) / p.recover);
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    const e = this.envelopeAt(t) * this.depth;
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const b of ctx.def.bodies) {
      if (!b.joint) continue;
      const r = relaxRegion(b.name);
      const lv = r === 'limb' ? p.limb : r === 'neck' ? p.neck : p.trunk;
      joints[b.name as JointName] = { weight: 1, strength: 1 - (1 - lv) * e };
    }
    this.mul = 1 - (1 - p.limb) * e;
    // 필름스트립·앱 표시 "충격 후 이완 0.4" (팔다리 강도 배율)
    this.phase = this.mul.toFixed(1);
    if (t - this.impactT >= p.dropTime + p.hold + p.recover && this.stopT === null) this.stop(t);
    return { joints };
  }
  override info(): Record<string, unknown> { return { impactT: this.impactT, body: this.body, speed: this.speed, depth: this.depth, mul: this.mul }; }
}

export interface LieParams {
  /** 착지 자세 → 누운 자세로 옮기는 시간, 강도를 내리는 시간 (초) */
  restTime: number; strengthTime: number;
  /** 몸통이 닿지 않은 채(손·무릎으로 버티던 몸이 멈춤) 넘겨받으면 강도를 이 시간(초)에 천천히 — 짚은 팔이 한꺼번에 풀려 얼굴이 바닥에 떨어지지 않게 */
  supportedStrengthTime: number;
  supported?: boolean;
  /** 목 강도·자세를 넘겨받은 그대로 두는 시간 (초) */
  neckHold: number;
  lie: LiePose;
}

/**
 * 누움 (넘어짐 대비가 몸통으로 착지한 뒤): 착지 순간 실제 관절 자세(relJoint)에서 누운 자세로, 강도는 착지 직전 행동 강도 배율(lastStrength)에서
 * 누운 자세 강도로. 균형·스텝 끔. 몸부림(Writhe)·일어서기가 이어받는다.
 */
export class Lie extends Behavior {
  readonly name = 'Lie';
  private readonly p: LieParams;
  private start: Partial<Record<JointName, Quat>> | null = null;
  private s0: Partial<Record<JointName, number>> = {};
  /** 팔 강도를 내리기 시작한 시각 (몸통 착지로 넘겨받으면 시작 시각, 짚고 버티다 넘겨받으면 몸통이 닿은 시각) */
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as LieParams;
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, def: CharacterDef = ctx.def;
    if (!this.start) {
      this.start = {};
      for (const b of def.bodies) if (b.joint && b.parent) {
        const jn = b.name as JointName;
        this.start[jn] = relJoint(def, jn, bodyPose(ctx.rd, b.parent).rot, bodyPose(ctx.rd, b.name).rot);
        this.s0[jn] = Math.min(1, ctx.lastStrength?.[jn] ?? 1);
      }
    }
    const tau = Math.max(0, ctx.t - this.startT);
    const k = smoothstep(tau / p.restTime), ks = smoothstep(tau / (p.supported ? p.supportedStrengthTime : p.strengthTime));
    // 목: neckHold초 동안 넘겨받은 강도를 유지하고 그 뒤 strengthTime초에 — 엎드린 몸이 목 힘부터 빼면 얼굴이 가슴보다 먼저 바닥에 떨어졌다
    const kn = smoothstep((tau - p.neckHold) / p.strengthTime);
    const lie = lieJoints(def, p.lie, 1, 1);
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const [jn, l] of Object.entries(lie) as [JointName, JointOut][]) {
      const st = this.start[jn];
      const s0 = this.s0[jn] ?? 1;
      const kk = jn === 'Head' ? Math.min(ks, kn) : ks;
      joints[jn] = { target: st ? slerp(st, l.target!, jn === 'Head' ? Math.min(k, kn) : k) : l.target!, weight: 1, strength: s0 + (l.strength! - s0) * kk };
    }
    this.phase = k < 1 ? '눕는 중' : '누움';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
}
