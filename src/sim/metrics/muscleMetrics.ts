// v0.2 근육 지표 (SPEC 10, v0.2 시나리오 기대값). 매 스텝 CharacterState만 읽는다. 정의: docs/ALGORITHMS.md v0.2.
// - jointErrorMaxDeg / jointErrorMeanDeg: strength ≥ errorMinStrength인 관절의 errorDeg 최대·평균
// - jitter: 빠른 반전 횟수/초 (관절별 축 합의 최대). 반전 = 상대 각속도 축 성분의 부호가 바뀌고 앞뒤 스텝 모두 |ω| > 임계,
//   그리고 같은 축의 직전 반전 뒤 jitterFastInterval 안 (= 5 Hz 이상 왕복). jitterAll = 간격 조건 없이 센 값(스파이크 정의)
// - saturation: 포화 관절이 하나라도 있는 스텝 비율. energy: ∫Σ|τ|² dt / (총질량 × 시간), τ = 추정 토크
// - trackErrorMeanDeg / trackLag: 목표가 움직이는 관절(축 목표 표준편차 > 기준)의 오차 평균, 다채널 교차상관 최대 지연
// - assistUsage(.root): 보조 사용량 시간 적분 (N·s), assistRootPeak: 순간 최대 (N)
// - collapse*: 첫 setMuscleScale 이후 무릎 굽힘 기준 도달 시각, Hips 하강 기준 도달 시각, 그 차이
import type { CharacterState, JointName, SimEvent } from '../types';

export interface MuscleJudge {
  errorMinStrength: number;
  jitterMinAngVelDegS: number;
  jitterFastInterval: number;
  trackWarmup: number;
  trackTargetMinStdDeg: number;
  trackMaxLag: number;
  collapseKneeFlexDeg: number;
  collapseHipsDrop: number;
}

interface Channel {
  joint: JointName;
  axis: number;
  tgt: number[];
  act: number[];
}

/**
 * 다채널 교차상관 지연: lag ∈ [0, maxLagSteps] 중 정규화 상관
 *   ρ(lag) = Σ_ch cov(tgt[t], act[t+lag]) / sqrt(Σ_ch var(tgt) · Σ_ch var(act))  (겹치는 구간에서 평균을 빼고 계산)
 * 가 최대인 lag (스텝 수). 채널을 합쳐서 하나의 지연을 구한다(진폭이 큰 채널이 더 큰 비중).
 */
export function crossCorrelationLag(chs: readonly { tgt: readonly number[]; act: readonly number[] }[], maxLagSteps: number): number {
  let best = -Infinity, bestLag = 0;
  for (let lag = 0; lag <= maxLagSteps; lag++) {
    let cov = 0, vt = 0, va = 0;
    for (const c of chs) {
      const n = Math.min(c.tgt.length, c.act.length) - lag;
      if (n < 2) continue;
      let mt = 0, ma = 0;
      for (let i = 0; i < n; i++) { mt += c.tgt[i]!; ma += c.act[i + lag]!; }
      mt /= n; ma /= n;
      for (let i = 0; i < n; i++) {
        const x = c.tgt[i]! - mt, y = c.act[i + lag]! - ma;
        cov += x * y; vt += x * x; va += y * y;
      }
    }
    const rho = vt > 0 && va > 0 ? cov / Math.sqrt(vt * va) : -Infinity;
    if (rho > best) { best = rho; bestLag = lag; }
  }
  return bestLag;
}

export class MuscleMetrics {
  private prevT: number | null = null;
  private steps = 0;
  private errMax = 0;
  private errSum = 0;
  private errN = 0;
  private satSteps = 0;
  private energy = 0;
  private time = 0;
  private assistRoot = 0;
  private assistAll = 0;
  private assistPeak = 0;
  private prevW = new Map<string, number>();
  private lastFlip = new Map<string, number>();
  private fast = new Map<JointName, number>();
  private all = new Map<JointName, number>();
  private chans = new Map<string, Channel>();
  private trackDt = 0;
  /** 추종 구간의 관절별 errorDeg 합 (finish에서 목표가 움직이는 관절만 고른다) */
  private trackErrSum = new Map<JointName, { sum: number; n: number }>();
  private collapsePending = false;
  private collapse: { t: number; hips: number; knee: number | null; drop: number | null } | null = null;

  constructor(readonly j: MuscleJudge, readonly totalMass: number) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'setMuscleScale' && !this.collapse) this.collapsePending = true;
  }

  onState(s: CharacterState): void {
    const t = s.time;
    const dt = this.prevT === null ? 0 : t - this.prevT;
    this.prevT = t;
    this.steps++;
    this.time += dt;
    let sat = false;
    const thr = this.j.jitterMinAngVelDegS;
    for (const name in s.joints) {
      const jn = name as JointName;
      const js = s.joints[jn];
      if (js.saturated) sat = true;
      if (js.strength >= this.j.errorMinStrength) {
        this.errMax = Math.max(this.errMax, js.errorDeg);
        this.errSum += js.errorDeg;
        this.errN++;
      }
      // 지터 (잠긴 축은 상대 각속도가 0 근처라 임계에 안 걸린다)
      const w = js.relAngVelDegS;
      if (!w) continue;
      for (let a = 0; a < 3; a++) {
        const key = `${jn}${a}`;
        const p = this.prevW.get(key);
        const c = w[a]!;
        if (p !== undefined && Math.abs(p) > thr && Math.abs(c) > thr && Math.sign(p) !== Math.sign(c)) {
          this.all.set(jn, (this.all.get(jn) ?? 0) + 1);
          const lf = this.lastFlip.get(key);
          if (lf !== undefined && t - lf <= this.j.jitterFastInterval + 1e-9) this.fast.set(jn, (this.fast.get(jn) ?? 0) + 1);
          this.lastFlip.set(key, t);
        }
        this.prevW.set(key, c);
        // 추종 채널
        if (t >= this.j.trackWarmup - 1e-9 && js.targetDeg) {
          let ch = this.chans.get(key);
          if (!ch) this.chans.set(key, (ch = { joint: jn, axis: a, tgt: [], act: [] }));
          ch.tgt.push(js.targetDeg[a]!);
          ch.act.push(js.coordsDeg[a]!);
        }
      }
    }
    if (t >= this.j.trackWarmup - 1e-9 && dt > 0) this.trackDt = dt;
    this.accumTrackErr(s);
    if (sat) this.satSteps++;
    const tsq = Number(s.debug.torqueSq ?? 0);
    this.energy += tsq * dt;
    const ar = s.assist.root;
    this.assistRoot += ar * dt;
    this.assistAll += (s.assist.root + s.assist.pin + s.assist.getup) * dt;
    this.assistPeak = Math.max(this.assistPeak, ar);
    // 강도 떨어뜨리기 이후 무릎·Hips
    if (this.collapsePending) {
      this.collapsePending = false;
      this.collapse = { t, hips: s.bodies.Hips.pos[1], knee: null, drop: null };
    }
    const c = this.collapse;
    if (c) {
      const knee = Math.max(s.joints.LeftLeg.coordsDeg[0], s.joints.RightLeg.coordsDeg[0]);
      if (c.knee === null && knee >= this.j.collapseKneeFlexDeg) c.knee = t;
      if (c.drop === null && s.bodies.Hips.pos[1] <= c.hips - this.j.collapseHipsDrop) c.drop = t;
    }
  }

  finish(): { metrics: Record<string, number>; info: Record<string, string> } {
    const T = Math.max(this.time, 1e-9);
    let jit = 0, jitJ = '', jitAll = 0, jitAllJ = '';
    for (const [k, v] of this.fast) if (v / T > jit) { jit = v / T; jitJ = k; }
    for (const [k, v] of this.all) if (v / T > jitAll) { jitAll = v / T; jitAllJ = k; }
    const m: Record<string, number> = {
      jointErrorMaxDeg: this.errMax,
      jointErrorMeanDeg: this.errN ? this.errSum / this.errN : 0,
      jitter: jit,
      jitterAll: jitAll,
      saturation: this.steps ? this.satSteps / this.steps : 0,
      energy: this.totalMass > 0 ? this.energy / (this.totalMass * T) : 0,
      assistUsage: this.assistAll,
      'assistUsage.root': this.assistRoot,
      assistRootPeak: this.assistPeak,
    };
    const info: Record<string, string> = { jitterJoint: jitJ, jitterAllJoint: jitAllJ };
    // 추종: 목표가 움직이는 채널만
    const sd = (x: number[]) => {
      const mu = x.reduce((a, b) => a + b, 0) / x.length;
      return Math.sqrt(x.reduce((a, b) => a + (b - mu) ** 2, 0) / x.length);
    };
    const moving = [...this.chans.values()].filter((c) => c.tgt.length > 1 && sd(c.tgt) > this.j.trackTargetMinStdDeg);
    if (moving.length && this.trackDt > 0) {
      const joints = new Set(moving.map((c) => c.joint));
      info.trackJoints = [...joints].join(',');
      m.trackLag = crossCorrelationLag(moving, Math.round(this.j.trackMaxLag / this.trackDt)) * this.trackDt;
      m.trackErrorMeanDeg = this.trackErr(joints);
    }
    const c = this.collapse;
    if (c) {
      m.collapseStartTime = c.t;
      if (c.knee !== null) {
        m.collapseKneeFlexTime = c.knee - c.t;
        // Hips가 기준만큼 내려가지 않았으면 끝 시각을 쓴다 (무릎이 먼저인 것은 그대로 참)
        m.collapseKneeLeadTime = (c.drop ?? c.t + T) - c.knee;
      }
      if (c.drop !== null) m.collapseHipsDropTime = c.drop - c.t;
    }
    return { metrics: m, info };
  }

  private trackErr(joints: Set<JointName>): number {
    let sum = 0, n = 0;
    for (const j of joints) {
      const e = this.trackErrSum.get(j);
      if (e) { sum += e.sum; n += e.n; }
    }
    return n ? sum / n : 0;
  }

  /** 추종 구간 관절 오차 누적 */
  private accumTrackErr(s: CharacterState): void {
    if (s.time < this.j.trackWarmup - 1e-9) return;
    for (const name in s.joints) {
      const jn = name as JointName;
      const e = this.trackErrSum.get(jn) ?? { sum: 0, n: 0 };
      e.sum += s.joints[jn].errorDeg;
      e.n++;
      this.trackErrSum.set(jn, e);
    }
  }
}
