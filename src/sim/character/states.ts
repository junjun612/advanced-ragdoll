// 파워드 랙돌 상태 머신 (SPEC 7.1의 3단계, v0.6 states.ts). 정의: docs/ALGORITHMS.md v0.6.
// | 상태      | 물리 바디                         | 근육            | 균형 |
// | Animated  | 키네마틱 (애니가 위치를 정함)      | (켜 둠, 목표=클립) | —   |
// | Active    | 동적                              | 애니 추종 + 행동 | on  |
// | Ragdoll   | 동적                              | 거의 0          | off |
// | GettingUp | 동적 (v0.7 스텁: Active처럼 동작)  | 겟업 클립 추종   | 겟업 보조 |
// 전환:
// - Animated → Active: 애니 이전·다음 자세 중앙 차분으로 바디별 선속도·각속도를 넘긴다(튐 없음). 전환 블렌드 동안 핀 강도 1 → 0,
//   표시 가중치(물리) 0 → 1 (렌더 블렌드: 표시 자세 = slerp(애니, 물리, w_bone)).
// - Active → Animated: 블렌드 동안 핀 강도 0 → 1로 물리를 애니 쪽으로 끈 뒤 키네마틱으로 바꾼다. 표시 가중치 1 → 0.
// - 피격으로 Animated → Active: 핀 없이(반응 중 핀 0) 바로, 표시 블렌드는 짧게(hitRenderBlend).
import type { StateName } from '../types';

export interface StatesConfig {
  /** Animated → Active 블렌드: 핀이 1에서 0(또는 추종 강도)까지 내려가는 시간, 표시 블렌드 시간 */
  toActive: { pinTime: number; renderTime: number };
  /** 피격으로 Animated → Active: 표시 블렌드 시간 (핀 없음) */
  hitRenderTime: number;
  /** Active → Animated: 핀을 올리는 시간 (끝나면 키네마틱) */
  toAnimated: { pinTime: number; renderTime: number };
}

export interface StateTransition { from: StateName; to: StateName; t0: number; pinTime: number; renderTime: number; hit: boolean }

export interface StatesLog {
  name: StateName;
  /** 진행 중 전환 (from→to, 경과 초) */
  transition: string | null;
  /** 전환 블렌드가 요구하는 핀 강도 0~1 */
  blendPin: number;
  /** 표시 가중치(물리) 0~1 */
  renderW: number;
}

export class PoweredStates {
  name: StateName;
  trans: StateTransition | null = null;
  /** 마지막 전환 (지표용) */
  lastSwitch: { t: number; from: StateName; to: StateName; hit: boolean } | null = null;

  constructor(initial: StateName, public cfg: StatesConfig) {
    this.name = initial;
  }

  /**
   * 상태 바꾸기 요청. 돌려주는 값은 Character가 할 일: 'kinematic' = 바디를 키네마틱으로, 'dynamic' = 동적으로 + 애니 속도 넘기기, null = 바디 그대로.
   * Active → Animated는 블렌드 뒤에 키네마틱이 된다(pendingKinematic).
   */
  request(to: StateName, t: number, opts: { hit?: boolean; hasAnim?: boolean } = {}): 'kinematic' | 'dynamic' | null {
    const from = this.name;
    if (to === from && !this.trans) return null;
    this.lastSwitch = { t, from, to, hit: !!opts.hit };
    if (to === 'Animated') {
      if (from === 'Animated') return null;
      if (opts.hasAnim && this.cfg.toAnimated.pinTime > 0 && from !== 'Ragdoll') {
        // 물리에서 애니로: 핀으로 끌어당긴 뒤 키네마틱 (상태 이름은 블렌드가 끝날 때 바뀐다)
        this.trans = { from, to, t0: t, pinTime: this.cfg.toAnimated.pinTime, renderTime: this.cfg.toAnimated.renderTime, hit: false };
        return null;
      }
      this.name = 'Animated';
      this.trans = null;
      return 'kinematic';
    }
    const wasAnim = from === 'Animated' || this.trans?.to === 'Animated';
    this.name = to;
    if (wasAnim && from === 'Animated' && opts.hasAnim) {
      this.trans = opts.hit
        ? { from, to, t0: t, pinTime: 0, renderTime: this.cfg.hitRenderTime, hit: true }
        : { from, to, t0: t, pinTime: this.cfg.toActive.pinTime, renderTime: this.cfg.toActive.renderTime, hit: false };
    } else this.trans = null;
    return from === 'Animated' ? 'dynamic' : null;
  }

  /** 매 스텝: 블렌드가 끝났는가 (Active → Animated는 끝날 때 키네마틱으로) */
  update(t: number): 'kinematic' | null {
    const tr = this.trans;
    if (!tr) return null;
    const el = t - tr.t0;
    if (tr.to === 'Animated') {
      if (el >= tr.pinTime) { this.name = 'Animated'; this.trans = null; return 'kinematic'; }
      return null;
    }
    if (el >= Math.max(tr.pinTime, tr.renderTime)) this.trans = null;
    return null;
  }

  /** 전환 블렌드가 요구하는 핀 강도 (0~1) */
  blendPin(t: number): number {
    const tr = this.trans;
    if (!tr || tr.pinTime <= 0) return 0;
    const k = Math.max(0, Math.min(1, (t - tr.t0) / tr.pinTime));
    const s = k * k * (3 - 2 * k);
    return tr.to === 'Animated' ? s : 1 - s;
  }

  /** 표시 가중치 (물리 쪽, 0~1). Animated = 0 */
  renderW(t: number): number {
    const tr = this.trans;
    if (!tr) return this.name === 'Animated' ? 0 : 1;
    const k = tr.renderTime > 0 ? Math.max(0, Math.min(1, (t - tr.t0) / tr.renderTime)) : 1;
    const s = k * k * (3 - 2 * k);
    return tr.to === 'Animated' ? 1 - s : s;
  }

  log(t: number): StatesLog {
    return { name: this.name, transition: this.trans ? `${this.trans.from}→${this.trans.to} ${(t - this.trans.t0).toFixed(2)}` : null, blendPin: this.blendPin(t), renderW: this.renderW(t) };
  }
}
