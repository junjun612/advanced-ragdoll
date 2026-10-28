// 작은 행동들 (SPEC v0.5a 행동 목록): InjuredLeg, Stagger, LookAt.
import type { FootName } from '../perception';
import type { JointName } from '../pose';
import type { Vec3 } from '../../math/vec3';
import { Behavior, type BehaviorContext, type BehaviorOutput, type JointOut } from './types';
import { bodyPose, degQ, gazeAngles } from './kinematics';

/** 다리 부상: 그 다리 strength 상한, 서 있을 때 성한 발로 체중, 다친 무릎 조금 굽힘, 스텝은 성한 다리 우선·다친 다리 짧게 */
export class InjuredLeg extends Behavior {
  readonly name = 'InjuredLeg';
  readonly foot: FootName;
  /** 맞은 다리 부위 (UpLeg·Leg·Foot) — 부위별 힘 상한 (결정 leg-4) */
  readonly part: string;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    const leg = String(params.leg ?? params.body ?? 'LeftUpLeg');
    this.foot = leg.startsWith('Right') ? 'RightFoot' : 'LeftFoot';
    this.part = leg.replace(/^(Left|Right)/, '');
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.params as { strengthCap: number; capByPart?: Record<string, [number, number, number]>; loadShift: number; kneeFlexDeg: number; swingPenalty: number; stepScale: number; duration?: number };
    if (p.duration !== undefined && ctx.t - this.hitT >= p.duration) this.stop(ctx.t);
    const L = this.foot === 'LeftFoot' ? 'Left' : 'Right';
    const joints: Partial<Record<JointName, JointOut>> = {};
    // 힘 상한: 상처 둘레 관절이 가장 약하다 (고관절·무릎·발목, capByPart[맞은 부위] — 발을 맞았는데 고관절까지 0.6이면 디딘 다리가 주저앉았다)
    const caps = p.capByPart?.[this.part] ?? [p.strengthCap, p.strengthCap, p.strengthCap];
    ([`${L}UpLeg`, `${L}Leg`, `${L}Foot`] as JointName[]).forEach((j, i) => { joints[j] = { weight: 1, capacity: caps[i]! }; });
    joints[`${L}Leg` as JointName] = { ...joints[`${L}Leg` as JointName]!, add: degQ(p.kneeFlexDeg, 0, 0) };
    // 서 있을 때 성한 발 쪽으로 COM 목표
    const other: FootName = this.foot === 'LeftFoot' ? 'RightFoot' : 'LeftFoot';
    // 골반 옆 방향 성분만 (발이 앞뒤로 벌어져 있을 때 COM 목표를 앞뒤로 옮기면 계속 내딛게 된다)
    const a = bodyPose(ctx.rd, this.foot).pos, b = bodyPose(ctx.rd, other).pos;
    const hq = bodyPose(ctx.rd, 'Hips').rot;
    const lx = 2 * (hq[0] * hq[1] + hq[3] * hq[2]), lz = 2 * (hq[0] * hq[2] - hq[3] * hq[1]); // 골반 로컬 +X의 월드 x·z
    const ln = Math.hypot(lx, lz) || 1;
    const along = ((b[0] - a[0]) * lx + (b[2] - a[2]) * lz) / ln;
    const comShift: [number, number] = [(lx / ln) * along * p.loadShift, (lz / ln) * along * p.loadShift];
    this.phase = '절뚝임';
    return { joints, comShift, stepping: { injuredFoot: this.foot, injuredPenalty: p.swingPenalty, injuredStepScale: p.stepScale } };
  }
  override info(): Record<string, unknown> { return { foot: this.foot, part: this.part }; }
}

/**
 * 비틀거림: 켜질 조건은 블렌더가 정한다(피격 뒤 window초 안 반응 스텝 시작, 또는 스텝 계층 stagger 이벤트).
 * 켜진 동안 스텝을 고르지 않게(시간·넘침·옆 지터), 상체 강성 낮춤, 최대 maxSteps 걸음. 스텝 계층이 서기로 돌아오면 꺼진다.
 */
export class Stagger extends Behavior {
  readonly name = 'Stagger';
  /** 아직 스텝이 시작되지 않은 대기 상태 (피격 뒤 window초까지) */
  armed = true;
  private sawBusy = false;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    if (params.immediate) this.armed = false;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.params as { window: number; maxSteps: number; trunkGainScale: number; irregular: { duration: number; overshoot: number; lateral: number } };
    if (this.armed) {
      if (ctx.stepping.busy) { this.armed = false; this.startT = ctx.t; }
      else if (ctx.t - this.hitT > p.window) { this.stop(ctx.t); this.stopT = ctx.t - 1; }
      this.phase = '대기';
      // 대기 중에도 스텝을 고르지 않게 미리 걸어 둔다(첫 스텝부터 비틀거림)
      return { joints: {}, stepping: { irregular: p.irregular, maxSteps: p.maxSteps } };
    }
    if (ctx.stepping.busy) this.sawBusy = true;
    else if (this.sawBusy) this.stop(ctx.t);
    this.phase = `${ctx.stepping.stepCount}걸음`;
    return { joints: {}, balanceMode: 'weak', trunkGainScale: p.trunkGainScale, stepping: { irregular: p.irregular, maxSteps: p.maxSteps } };
  }
  /** 대기 중에는 가중치를 0으로 보인다 */
  get pending(): boolean { return this.armed; }
}

/** 바라보기: 목(Head)과 상체 비틀기(Spine·Spine2)로 대상 쪽을 본다 (가중치 낮음) */
export class LookAt extends Behavior {
  readonly name = 'LookAt';
  target: Vec3 | null;
  private yaw = 0;
  private pitch = 0;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.target = (params.target as Vec3 | undefined) ?? null;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    if (!this.target) { this.stop(ctx.t); return { joints: {} }; }
    const p = this.params as { weight: number };
    this.phase = '';
    return { joints: {}, gaze: { target: this.target, weight: p.weight } };
  }
  /** 블렌더가 시선 해 적용 뒤 기록 (로그) */
  setAngles(yaw: number, pitch: number): void { this.yaw = yaw; this.pitch = pitch; }
  override info(): Record<string, unknown> { return { target: this.target, yaw: this.yaw, pitch: this.pitch }; }
}

/**
 * 시선 해: 대상 방향의 yaw·pitch(Spine2 기준)를 목과 상체에 나눈다. state = 저역 통과 상태(도).
 * 목 비틀기 ±(제한 − 여유), 굽힘 [−35, 45]로 자르고, 넘치는 yaw는 상체(Spine·Spine2 비틀기 합 ±40°)로.
 */
export function solveGaze(ctx: BehaviorContext, target: Vec3, cfg: { headShare: number; spineShare: number; maxYawDeg: number; maxPitchDeg: number; tau: number }, state: { yaw: number; pitch: number }): { joints: Partial<Record<JointName, JointOut>>; yaw: number; pitch: number } {
  const head = bodyPose(ctx.rd, 'Head'), s2 = bodyPose(ctx.rd, 'Spine2'), hips = bodyPose(ctx.rd, 'Hips');
  // yaw는 골반 기준(상체 비틀기와 목 비틀기가 더해진다), pitch는 Spine2 기준(목 굽힘만)
  const gy = gazeAngles(head.pos, hips.rot, target), gp = gazeAngles(head.pos, s2.rot, target);
  const DEG = 180 / Math.PI;
  const yawT = Math.max(-cfg.maxYawDeg, Math.min(cfg.maxYawDeg, gy.yaw * DEG));
  const pitchT = Math.max(-cfg.maxPitchDeg, Math.min(cfg.maxPitchDeg, gp.pitch * DEG));
  const k = cfg.tau > 0 ? 1 - Math.exp(-ctx.dt / cfg.tau) : 1;
  state.yaw += (yawT - state.yaw) * k;
  state.pitch += (pitchT - state.pitch) * k;
  let headYaw = state.yaw * cfg.headShare;
  let spineYaw = state.yaw * cfg.spineShare;
  const maxHead = 55;
  if (Math.abs(headYaw) > maxHead) { spineYaw += headYaw - Math.sign(headYaw) * maxHead; headYaw = Math.sign(headYaw) * maxHead; }
  spineYaw = Math.max(-40, Math.min(40, spineYaw));
  const headPitch = Math.max(-35, Math.min(45, state.pitch));
  return {
    joints: {
      Head: { target: degQ(headPitch, headYaw, 0), weight: 1 },
      Spine: { add: degQ(0, spineYaw * 0.4, 0), weight: 1 },
      Spine2: { add: degQ(0, spineYaw * 0.6, 0), weight: 1 },
    },
    yaw: state.yaw, pitch: state.pitch,
  };
}
