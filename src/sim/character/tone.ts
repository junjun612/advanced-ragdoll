// 근긴장 (2026-10-28, README 결정 tone-1~): 관절 모터 강성·감쇠 배율. 숨은 힘 없음 — 관절 모터(근육) 안에서만, 상한은 그대로 s·maxTorque.
// - 공동수축(놀람·보호 수축): 피격(밀기·총탄·근접·접촉)을 받으면 latency초 뒤 rise·hold·fall 동안 몸통·목·어깨 등 근육의 강성·감쇠를 올린다.
//   세기 k = clamp((Δv − minDv)/(refDv − minDv), 0, 1). 사람은 갑자기 밀리거나 맞으면 반사적으로 몸통·목을 굳히고(놀람 반사·예상 못 한 외란의 공동수축,
//   표면 근전도 50~100 ms), 0.1~0.3초 뒤 풀며 자세 반응으로 넘어간다.
// - 신장 반사: 관절이 계획(근육 목표 속도)보다 빠르게 돌면(늘어나면) latency초 뒤 그 관절 강성·감쇠를 올리고 tau초로 내린다(짧은 지연 신장 반사 30~50 ms).
// 근육 계층은 이 배율을 모터 PD에만 곱하고 균형 계층의 '모터 추정분 빼기'에는 넣지 않는다 → 계획에서 벗어난 움직임에만 맞서는 추가 임피던스.
import type { JointName } from './pose';

export interface ToneConfig {
  enabled: boolean;
  /** 강성·감쇠 최대 배율 (레벨 1) */
  kpGain: number;
  kdGain: number;
  /** (결정 tone-3) 전신 QP 자세 과제에도 같은 레벨로: kp·kd·가중치 배율 (레벨 1). 없으면 모터만 */
  qp?: { kpGain: number; kdGain: number; wGain: number };
  coContraction: {
    enabled: boolean;
    latency: number; rise: number; hold: number; fall: number;
    minDv: number; refDv: number;
    /** 관절별 공동수축 가중치 (0~1, 없으면 0) */
    joints: Partial<Record<JointName, number>>;
    /** 피격 종류별 배율 (없으면 1) */
    typeScale?: Record<string, number>;
  };
  reflex: {
    enabled: boolean;
    latency: number;
    /** 신장 속도(°/s, 관절 상대 각속도 − 근육 목표 속도) 문턱과 레벨 기울기 (1/(°/s)) */
    thresholdDegS: number; gainPerDegS: number; max: number; tau: number;
    joints: Partial<Record<JointName, number>>;
  };
}

export interface ToneLog { co: number; reflexMax: number; reflexJoint: string | null; maxKd: number }

export class ToneController {
  /** 공동수축 일화: 시작 시각(피격) · 세기 */
  private episodes: { t0: number; k: number }[] = [];
  /** 관절별 신장 반사 레벨 · 지연 버퍼(°/s) */
  private reflex: Record<string, number> = {};
  private hist: Record<string, number[]> = {};
  co = 0;
  kp: Partial<Record<JointName, number>> = {};
  kd: Partial<Record<JointName, number>> = {};
  /** 관절별 레벨 L (0~1) */
  level: Partial<Record<JointName, number>> = {};
  log: ToneLog = { co: 0, reflexMax: 0, reflexJoint: null, maxKd: 1 };
  constructor(readonly cfg: ToneConfig) {}

  onHit(t: number, dv: number, type: string): void {
    const c = this.cfg.coContraction;
    if (!this.cfg.enabled || !c.enabled) return;
    const k = Math.max(0, Math.min(1, (dv - c.minDv) / Math.max(1e-6, c.refDv - c.minDv))) * (c.typeScale?.[type] ?? 1);
    if (k > 0) this.episodes.push({ t0: t, k });
  }

  /** 근긴장을 끈다 (넘어짐·누움·Ragdoll 등 근육 반사를 쓰지 않는 상태) */
  clear(): void { this.episodes = []; this.reflex = {}; this.hist = {}; }

  /**
   * 매 스텝 근육 적용 전에 부른다. stretch = 직전 스텝 관절별 신장 속도(°/s). on = 서 있는 반응 상태(아니면 배율 1).
   */
  update(t: number, dt: number, stretch: Partial<Record<JointName, number>>, on: boolean): void {
    const cfg = this.cfg;
    this.kp = {}; this.kd = {}; this.level = {};
    if (!cfg.enabled || !on) { this.co = 0; this.log = { co: 0, reflexMax: 0, reflexJoint: null, maxKd: 1 }; if (!on) this.clear(); return; }
    const c = cfg.coContraction;
    let co = 0;
    this.episodes = this.episodes.filter((e) => t - e.t0 < c.latency + c.rise + c.hold + c.fall + 1e-9);
    for (const e of this.episodes) {
      const tau = t - e.t0 - c.latency;
      if (tau < 0) continue;
      const env = tau < c.rise ? smooth(tau / c.rise) : tau < c.rise + c.hold ? 1 : 1 - smooth((tau - c.rise - c.hold) / c.fall);
      co = Math.max(co, e.k * env);
    }
    this.co = co;
    const r = cfg.reflex;
    const nLat = Math.max(0, Math.round(r.latency / dt));
    let rMax = 0, rJ: string | null = null, maxKd = 1;
    const decay = Math.exp(-dt / r.tau);
    const names = new Set<string>([...Object.keys(c.joints), ...Object.keys(r.joints)]);
    for (const jn of names) {
      let lv = 0;
      if (r.enabled && r.joints[jn as JointName]) {
        const h = (this.hist[jn] ??= []);
        h.push(stretch[jn as JointName] ?? 0);
        while (h.length > nLat + 1) h.shift();
        const sd = h.length > nLat ? h[0]! : 0;
        const goal = Math.min(r.max, Math.max(0, (sd - r.thresholdDegS) * r.gainPerDegS));
        this.reflex[jn] = Math.max(goal, (this.reflex[jn] ?? 0) * decay);
        if (this.reflex[jn]! < 1e-4) this.reflex[jn] = 0;
        lv = this.reflex[jn]! * r.joints[jn as JointName]!;
        if (lv > rMax) { rMax = lv; rJ = jn; }
      }
      lv = Math.max(lv, co * (c.enabled ? c.joints[jn as JointName] ?? 0 : 0));
      if (lv > 0) {
        this.level[jn as JointName] = lv;
        this.kp[jn as JointName] = 1 + (cfg.kpGain - 1) * lv;
        this.kd[jn as JointName] = 1 + (cfg.kdGain - 1) * lv;
        maxKd = Math.max(maxKd, this.kd[jn as JointName]!);
      }
    }
    this.log = { co: +co.toFixed(3), reflexMax: +rMax.toFixed(3), reflexJoint: rJ, maxKd: +maxKd.toFixed(2) };
  }
}

const smooth = (x: number): number => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
