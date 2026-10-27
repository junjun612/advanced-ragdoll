// 무릎 꿇기·축 늘어짐 (SPEC v0.5b 행동 목록): Kneel(피해 누적 또는 trigger — 상체를 세운 채 무릎을 꿇고 버팀),
// Limp(사망·기절 — 전 관절 strength → 약 0.05, 하체부터 약해져 무릎부터 무너짐). 정의: docs/ALGORITHMS.md v0.5b.
import type { JointName } from '../pose';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut } from './types';
import { bodyPose, degQ } from './kinematics';
import { type Vec3, add, scale, sub } from '../../math/vec3';
import { rotate } from '../../math/quat';

/** 무릎 꿇기 단계 자세 (관절 좌표계 도): 무릎·고관절·발목 굽힘, 몸통 앞 기울기(척추 둘에 나눔), 다리 강도, 균형 계층 켬 여부 */
interface KneelStage { time: number; knee: number; hip: number; ankle: number; spine: number; legStrength: number; balance: boolean; kneeStrength?: number; ankleStrength?: number; /** 균형 단계 COM 목표를 다각형 중심 → 발끝 선 쪽으로 이 비율만큼 */ comToToe?: number }

export interface KneelParams {
  /**
   * 단계 (차례로, 단계마다 time초에 앞 단계 자세 → 이 단계 자세 smoothstep): squat(균형 계층이 COM을 발 위에 두고 COM 높이 목표를 낮추며
   * 쪼그려 앉음, 뒤꿈치 평평) → drop(균형 끔: 뒤꿈치를 들며 무릎을 앞으로 내려 바닥에 댐) → rise(허벅지·상체를 세움 — 엉덩이가 무릎보다 살짝 뒤라 정강이·발끝 위에 COM)
   */
  stages: KneelStage[];
  /** 쪼그리는 동안 균형 COM 높이 목표를 낮추는 양 (m) */
  comDrop: number;
  /** 내려가는 동안 균형을 끄는 COM 높이 기준 (m, 무릎이 닿을 때까지 균형 유지), 내려가기 최대 시간 (초) */
  minComHeight: number; maxDescend: number;
  hipSide: number;
  headDeg: number;
  /**
   * 꿇은 자세 균형 (균형 계층이 꺼진 단계): COM 수평 위치를 무릎 → 발끝 사이 frac 지점에 두도록, 앞으로 쏠리면(e m, 속도 v)
   * 무릎을 δ = kp·e + kd·v 도 더 굽히고(허벅지가 정강이 위에서 뒤로) 고관절을 δ 펴서 상체는 세운 채 엉덩이를 뒤로 (|δ| ≤ maxDeg)
   */
  kneelBalance: { frac: number; kp: number; kd: number; maxDeg: number };
}

const STAND = { knee: 15, hip: 4, ankle: 11, spine: 0 };
const STAGE_KO = ['몸 숙임', '무릎 내림', '무릎 닿음', '몸 세움'];

/**
 * 무릎 꿇기: 단계(squat → drop → rise) 관절 목표. 균형 계층은 balance 단계(발로 서 있는 동안)만 켜 둔다.
 * 피해 누적(하체 힘 상한)이 더 떨어지면 블렌더가 Limp로 넘긴다.
 */
export class Kneel extends Behavior {
  readonly name = 'Kneel';
  private readonly p: KneelParams;
  /** 꿇은 자세 균형 오차 (m, 로그) */
  balanceErr = 0;
  kneeAdj = 0;
  private kneeDownT: number | null = null;
  private kneeContactT: number | null = null;
  private atKnee: { knee: number; hip: number; ankle: number; spine: number } | null = null;
  override info(): Record<string, unknown> { return { balanceErr: this.balanceErr, kneeAdjDeg: this.kneeAdj }; }
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as KneelParams;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p;
    // 첫 단계(내려가기)는 무릎이 바닥에 닿을 때까지(최대 maxDescend초), 그 뒤 단계는 닿은 순간 자세에서 시간으로
    const tau0 = Math.max(0, ctx.t - this.startT);
    if (this.kneeDownT === null && tau0 > 0.1 && (ctx.per.ground.has('LeftLeg') || ctx.per.ground.has('RightLeg') || tau0 >= p.maxDescend)) this.kneeDownT = ctx.t;
    let prev: { knee: number; hip: number; ankle: number; spine: number } = STAND;
    const last = p.stages.length - 1;
    let idx = last, k = 1;
    if (this.kneeDownT === null) {
      idx = 0;
      k = smoothstep(tau0 / p.stages[0]!.time);
    } else {
      prev = this.atKnee ?? p.stages[0]!;
      let tau = ctx.t - this.kneeDownT;
      for (let i = 1; i < p.stages.length; i++) {
        const s = p.stages[i]!;
        if (tau < s.time) { idx = i; k = smoothstep(tau / s.time); break; }
        tau -= s.time;
        if (i < last) prev = s;
      }
    }
    const st = p.stages[idx]!;
    const mix = (a: number, b: number) => a + (b - a) * k;
    const knee = mix(prev.knee, st.knee), hip = mix(prev.hip, st.hip), ankle = mix(prev.ankle, st.ankle), spine = mix(prev.spine, st.spine);
    if (this.kneeDownT === null) this.atKnee = { knee, hip, ankle, spine };
    const ls = st.legStrength;
    // 꿇은 자세 균형 (균형 계층이 꺼진 단계)
    let dK = 0;
    if (!st.balance) {
      const kb = p.kneelBalance;
      const kneeOf = (shin: 'LeftLeg' | 'RightLeg'): Vec3 => {
        const a = ctx.def.bodies.find((b) => b.name === shin)!.joint!.anchorInChild;
        const bp = bodyPose(ctx.rd, shin);
        return add(bp.pos, rotate(bp.rot, a));
      };
      const kn = scale(add(kneeOf('LeftLeg'), kneeOf('RightLeg')), 0.5);
      const sole = [...ctx.per.feet.LeftFoot.sole.slice(2, 4), ...ctx.per.feet.RightFoot.sole.slice(2, 4)];
      const toe = scale(sole.reduce((a, c) => add(a, c), [0, 0, 0] as Vec3), 1 / Math.max(1, sole.length));
      const hf = bodyPose(ctx.rd, 'Hips');
      const f0 = rotate(hf.rot, [0, 0, 1]);
      const fl = Math.hypot(f0[0], f0[2]) || 1;
      const fwd: Vec3 = [f0[0] / fl, 0, f0[2] / fl];
      const b = add(kn, scale(sub(toe, kn), kb.frac));
      const { com, vel } = ctx.rd.com();
      const e = (com[0] - b[0]) * fwd[0] + (com[2] - b[2]) * fwd[2];
      const v = vel[0] * fwd[0] + vel[2] * fwd[2];
      // 무릎이 바닥에 닿은 뒤부터 (그 전에는 COM이 무릎 뒤라 무릎을 펴서 일어서 버린다)
      if (this.kneeContactT === null && (ctx.per.ground.has('LeftLeg') || ctx.per.ground.has('RightLeg'))) this.kneeContactT = ctx.t;
      const g = this.kneeContactT === null ? 0 : smoothstep((ctx.t - this.kneeContactT) / 0.1);
      dK = Math.max(-kb.maxDeg, Math.min(kb.maxDeg, kb.kp * e + kb.kd * v)) * g;
      this.balanceErr = e;
    }
    const joints: Partial<Record<JointName, JointOut>> = {
      LeftUpLeg: { target: degQ(hip - dK, 0, p.hipSide), weight: 1, strength: ls },
      RightUpLeg: { target: degQ(hip - dK, 0, -p.hipSide), weight: 1, strength: ls },
      LeftLeg: { target: degQ(knee + dK, 0, 0), weight: 1, strength: st.kneeStrength ?? ls },
      RightLeg: { target: degQ(knee + dK, 0, 0), weight: 1, strength: st.kneeStrength ?? ls },
      LeftFoot: { target: degQ(ankle, 0, 0), weight: 1, strength: st.ankleStrength ?? ls },
      RightFoot: { target: degQ(ankle, 0, 0), weight: 1, strength: st.ankleStrength ?? ls },
      // 몸통은 덮어쓴다 (레이어가 HoldWound 위: 상처를 쥔 웅크림 위에 숙임을 더하면 앞으로 고꾸라졌다 — 팔은 그대로 상처를 쥔다)
      Spine: { target: degQ(spine * 0.5, 0, 0), weight: 1 },
      Spine2: { target: degQ(spine * 0.5, 0, 0), weight: 1 },
      Head: { add: degQ(p.headDeg, 0, 0), weight: 1 },
    };
    this.phase = idx === last && k >= 1 ? '무릎 꿇음' : STAGE_KO[idx] ?? `단계 ${idx}`;
    const comDrop = st.balance ? p.comDrop * (idx === 0 ? k : 1) : p.comDrop;
    this.kneeAdj = dK;
    // 발끝 지지 단계: COM 목표를 지지 다각형 중심에서 발끝 선(앞 바닥 꼭짓점 평균)으로 옮긴다
    let comShift: [number, number] | undefined;
    if (st.balance && (st.comToToe ?? 0) > 0) {
      const sp = ctx.per.supportPolygon;
      const toes = [...ctx.per.feet.LeftFoot.sole.slice(2, 4), ...ctx.per.feet.RightFoot.sole.slice(2, 4)];
      if (sp.length) {
        const c = sp.reduce((a, q) => [a[0] + q[0] / sp.length, a[1] + q[1] / sp.length] as [number, number], [0, 0] as [number, number]);
        const tx = toes.reduce((a, q) => a + q[0], 0) / toes.length, tz = toes.reduce((a, q) => a + q[2], 0) / toes.length;
        const kk = (idx === 0 ? k : 1) * (st.comToToe ?? 0);
        comShift = [(tx - c[0]) * kk, (tz - c[1]) * kk];
      }
    }
    return { joints, comDrop, comShift, ...(st.balance ? { minComHeight: p.minComHeight } : {}), stepAllowed: false, tiltAllowDeg: 40, ...(st.balance ? {} : { balanceMode: 'off' as const }) };
  }
}

export interface LimpParams {
  /** 최종 강도 (전 관절) */
  floor: number;
  /** 다리: legTime초에 floor로 (먼저), 몸통·팔·목: upperDelay초 뒤 upperTime초에 floor로 */
  legTime: number; upperDelay: number; upperTime: number;
  /** 무릎부터 꺾이도록 무릎 목표를 더 굽힘 (도) */
  kneeFlexDeg: number;
  /** 고개·상체가 앞으로 처짐 (도): 목·척추(둘에 나눔)·고관절 굽힘 — 무릎이 꺾이며 엉덩이가 뒤로 빠질 때 상체가 뒤로 넘어가지 않고 앞으로 고꾸라지게 */
  slump: { headDeg: number; spineDeg: number; hipDeg: number };
  cause?: string;
}

const LEG_J: JointName[] = ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];

/** 축 늘어짐 (사망·기절): 균형·스텝 끔, 하체부터 strength → floor, 무릎을 굽힌 목표로 무릎부터 무너지게 */
export class Limp extends Behavior {
  readonly name = 'Limp';
  private readonly p: LimpParams;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as LimpParams;
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p;
    const tau = Math.max(0, ctx.t - this.startT);
    const sLeg = 1 - (1 - p.floor) * smoothstep(tau / p.legTime);
    const sUp = 1 - (1 - p.floor) * smoothstep((tau - p.upperDelay) / p.upperTime);
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const b of ctx.def.bodies) {
      if (!b.joint) continue;
      const jn = b.name as JointName;
      joints[jn] = { weight: 1, strength: LEG_J.includes(jn) ? sLeg : sUp };
    }
    const kl = smoothstep(tau / p.legTime);
    for (const k of ['LeftLeg', 'RightLeg'] as JointName[]) joints[k] = { ...joints[k]!, add: degQ(p.kneeFlexDeg * kl, 0, 0) };
    for (const k of ['LeftUpLeg', 'RightUpLeg'] as JointName[]) joints[k] = { ...joints[k]!, add: degQ(p.slump.hipDeg * kl, 0, 0) };
    joints.Spine = { ...joints.Spine!, add: degQ(p.slump.spineDeg * 0.5 * kl, 0, 0) };
    joints.Spine2 = { ...joints.Spine2!, add: degQ(p.slump.spineDeg * 0.5 * kl, 0, 0) };
    joints.Head = { ...joints.Head!, add: degQ(p.slump.headDeg * kl, 0, 0) };
    this.phase = sUp > p.floor + 0.01 ? '힘 빠짐' : '늘어짐';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
  override info(): Record<string, unknown> { return { cause: this.p.cause ?? null }; }
}
