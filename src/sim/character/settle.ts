// 진정 단계 (README 결정 settle-1~, docs/ALGORITHMS.md '진정 단계', 값 config/settle.json).
// 밀리거나 맞은 뒤 '이제 버텼다'를 판단하는 단계. 버틴 뒤에도 작은 흔들림마다 팔 반사·QP 팔 각운동량·상체 굽힘을 크게 쓰던 것을
// (어기영차 팔 흔들기) 멈추고 팔을 늘어뜨린 채 발목·고관절로 마지막 흔들림을 받는다. 사람은 버티고 나면 팔을 내리고 몸을 세운다.
//
// 경계 (결정 164): 진정 판단과 관절 목표(팔 → 서기 자세 팔, 척추·머리 → 서기 자세)는 레퍼런스 생성 쪽, 추종기 쪽은 힌트(SettleRef)만 읽는다:
// 팔 반사·팔 벌림 배율, 팔 자세 과제 가중치·감쇠, 팔 각운동량 비용 배율. 숨은 힘은 없다(핀 0, 보조 없음).
import type { JointName } from '../types';
import { type Quat, slerp as slerpQ } from '../math/quat';
import type { JointTargets } from './pose';

export interface SettleConfig {
  enabled: boolean;
  /** 마지막 충격 뒤 이 시간(초) 안에서만 진정 단계를 쓴다 (충격 없는 서기·걷기는 그대로) */
  armedFor: number;
  /** 충격 뒤 최소 대기(초): 감지 지연 + 첫 반응이 시작되기 전에는 들어가지 않는다 */
  minAfterHit: number;
  /** 들어가기: 감지 DCM이 지지 다각형 안 margin m 넘게, 넘어짐 확실도 < fall, COM 수평 속도 < speed, 반응 걸음 중 아님 — 이 상태가 time초 이어지면 */
  enter: { margin: number; fall: number; speed: number; time: number };
  /** 나오기(즉시): DCM 여유 < margin, 넘어짐 확실도 > fall, COM 수평 속도 > speed, 반응 걸음 시작, 새 충격 */
  exit: { margin: number; fall: number; speed: number };
  /** 진정 정도(level) 오르는 시간(초, smoothstep), 나올 때 내리는 시간(초) */
  rise: number;
  release: number;
  /** 척추·머리를 서기 자세로 세우는 시간(초) — 팔보다 천천히 */
  spineRise: number;
  /** 서기 자세로 되돌릴 관절 */
  armJoints: JointName[];
  spineJoints: JointName[];
  /** 추종기 힌트 (level = 1일 때) */
  tracker: { reflexScale: number; abductScale: number; armWeight: number; armKd: number; armMomScale: number };
  /** level이 1이 되고 hold초 지나면 반응 상체 스타일을 놓는다(나오기 blendOut) — 이후는 서기(Idle) 자세 */
  endStyleHold: number;
}

/** 추종기 힌트 (Balance.settleRef). 숨은 힘 없음 — 자세 과제 가중치·감쇠와 반사 배율만 */
export interface SettleRef {
  level: number;
  reflexScale: number;
  abductScale: number;
  armWeight: number;
  armKd: number;
  armMomScale: number;
}

/** 로그 (balance.settle): 진정 정도, 단계, 진입 시각, 지금 DCM 여유, 나온 이유 */
export interface SettleLog {
  level: number;
  phase: 'wait' | 'enter' | 'settled' | 'release';
  since: number | null;
  margin: number;
  reason: string;
}

export interface SettleInput {
  t: number;
  dt: number;
  /** 이번 스텝에 충격(피격·밀기·접촉 피격)이 들어왔나 */
  hitNow: boolean;
  /** Active·균형 켜짐·걷기 추종 아님·일어서기 아님·넘어짐/바닥 행동 없음 */
  eligible: boolean;
  /** 감지 DCM의 지지 다각형 안 여유 (m, 밖이면 음수) — 직전 스텝 균형 계층 값 */
  cpMargin: number;
  /** 넘어짐 확실도 — 직전 스텝 FallMonitor 값 */
  fall: number;
  /** COM 수평 속도 (m/s) */
  speed: number;
  /** 스텝 계층이 반응 걸음(reactive·lift) 중 */
  reactiveStep: boolean;
}

const smooth = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };

export class SettleController {
  /** 0 = 꺼짐, 1 = 완전히 진정 */
  level = 0;
  private lastHitT: number | null = null;
  private okSince: number | null = null;
  private since: number | null = null;
  /** 오르기 진행 (0~1, smoothstep 전), 척추 진행 */
  private u = 0;
  private uSpine = 0;
  private fullSince: number | null = null;
  log: SettleLog | null = null;

  constructor(readonly cfg: SettleConfig) {}

  update(inp: SettleInput): void {
    const c = this.cfg;
    if (!c.enabled) return;
    const { t, dt } = inp;
    if (inp.hitNow) { this.lastHitT = t; this.release(t, 'hit', false); }
    const armed = this.lastHitT !== null && t - this.lastHitT <= c.armedFor && t - this.lastHitT >= c.minAfterHit;
    if (!armed && this.level === 0 && this.u === 0) { if (this.log && this.lastHitT !== null && t - this.lastHitT > c.armedFor) this.log = null; return; }
    const on = this.since !== null;
    const bad = !inp.eligible || inp.reactiveStep || inp.cpMargin < c.exit.margin || inp.fall > c.exit.fall || inp.speed > c.exit.speed;
    if (on && bad) this.release(t, !inp.eligible ? 'ineligible' : inp.reactiveStep ? 'step' : inp.fall > c.exit.fall ? 'fall' : inp.speed > c.exit.speed ? 'speed' : 'margin', false);
    if (this.since === null) {
      const good = armed && inp.eligible && !inp.reactiveStep && inp.cpMargin >= c.enter.margin && inp.fall < c.enter.fall && inp.speed < c.enter.speed;
      this.okSince = good ? this.okSince ?? t : null;
      if (good && t - this.okSince! >= c.enter.time - 1e-9) this.since = t;
    }
    if (this.since !== null) {
      this.u = Math.min(1, this.u + dt / Math.max(1e-3, c.rise));
      this.uSpine = Math.min(1, this.uSpine + dt / Math.max(1e-3, c.spineRise));
    } else {
      this.u = Math.max(0, this.u - dt / Math.max(1e-3, c.release));
      this.uSpine = Math.max(0, this.uSpine - dt / Math.max(1e-3, c.release));
    }
    this.level = smooth(this.u);
    this.fullSince = this.level >= 1 - 1e-9 ? this.fullSince ?? t : null;
    const phase: SettleLog['phase'] = this.since !== null ? (this.level >= 1 - 1e-9 ? 'settled' : 'enter') : this.level > 0 ? 'release' : 'wait';
    this.log = { level: this.level, phase, since: this.since, margin: inp.cpMargin, reason: this.log?.reason ?? '' };
  }

  private release(t: number, why: string, now: boolean): void {
    if (this.since !== null || this.level > 0) this.log = { ...(this.log ?? { level: this.level, phase: 'release', since: this.since, margin: 0 }), reason: `${why} ${t.toFixed(2)}` };
    this.since = null;
    this.okSince = null;
    this.fullSince = null;
    if (now) { this.u = 0; this.uSpine = 0; this.level = 0; }
  }

  /** 반응 상체 스타일을 놓을 때인가 (level 1이 endStyleHold초) */
  styleDone(t: number): boolean { return this.fullSince !== null && t - this.fullSince >= this.cfg.endStyleHold - 1e-9; }

  /** 레퍼런스: 팔 → 서기(Idle) 자세 팔(level), 척추·머리 → 서기 자세(척추 진행) */
  apply(targets: JointTargets | null, idle: JointTargets | null): JointTargets | null {
    if (!targets || !idle || this.level <= 0) return targets;
    const out: JointTargets = { ...targets };
    const ls = smooth(this.uSpine);
    for (const j of this.cfg.armJoints) { const a = targets[j], b = idle[j]; if (a && b) out[j] = slerpQ(a as Quat, b as Quat, this.level); }
    for (const j of this.cfg.spineJoints) { const a = targets[j], b = idle[j]; if (a && b) out[j] = slerpQ(a as Quat, b as Quat, ls); }
    return out;
  }

  /** 추종기 힌트 (level > 0일 때) */
  ref(): SettleRef | null {
    if (!this.cfg.enabled || this.level <= 0) return null;
    const k = this.cfg.tracker;
    return { level: this.level, reflexScale: k.reflexScale, abductScale: k.abductScale, armWeight: k.armWeight, armKd: k.armKd, armMomScale: k.armMomScale };
  }
}
