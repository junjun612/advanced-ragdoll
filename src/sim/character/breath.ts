// 호흡·미세 움직임 (README 결정 pres-3): 서 있는 몸의 관절 목표(서기 포즈 클립)에 작은 변조를 얹는다 — 숨은 힘 없음.
// - 호흡: 들숨(짧음)·날숨(김) 비대칭 파형 b ∈ [0, 1]로 척추를 펴고(가슴이 올라감) 머리는 반대로 숙여 시선을 지키고, 어깨(팔)를 조금 든다.
// - 각성(숨 고르기): 맞거나 반응 걸음을 디디면 올라가고 tau초로 내려간다. 각성만큼 호흡이 빠르고 깊다 → 진정되며 느려진다.
// - 느린 무게 이동·자세 흔들림: 시드 부드러운 노이즈(0.05~0.15 Hz)로 척추 옆굽힘·비틀기와 고개를 아주 조금.
// 캐릭터마다 기본 호흡수를 prng로 조금 다르게 한다(같은 장면의 여러 사람이 맞춰 숨쉬지 않게).
import type { Prng } from '../prng';
import type { JointName, JointTargets } from './pose';
import { multiplyQ, identityQ } from '../math/quat';
import { degQ } from './behaviors/kinematics';
import { SmoothNoise } from './behaviors/noise';

export interface BreathConfig {
  enabled: boolean;
  /** 쉴 때 호흡수 (Hz)와 캐릭터별 흔들기 ± (Hz) */
  rateHz: number;
  rateJitter: number;
  /** 들숨 비율 (한 주기 중) */
  inhaleFrac: number;
  /** 관절별 [flex, twist, side] 도 (b = 1, 깊이 1일 때) */
  joints: Partial<Record<JointName, [number, number, number]>>;
  arousal: { perDv: number; perStep: number; tau: number; max: number; rateAdd: number; depthAdd: number };
  sway: { band: [number, number]; joints: Partial<Record<JointName, [number, number, number]>> };
  /** 서 있음 판정: 골반 높이(지면 기준) ≥ minHipsH, 켜고 끄는 시간 상수 (초) */
  minHipsH: number;
  /** 지면 경사(골반 아래) 이보다 가파르면 끈다 (도) */
  maxSlopeDeg: number;
  fadeTau: number;
  /** 의도 반응 중(행동 계층이 바쁘거나 반응 걸음) 켜짐 정도 — 반응을 마치고 서면 1 (숨 고르기가 보이는 때) */
  reactK: number;
}

export interface BreathLog { b: number; rate: number; depth: number; arousal: number; k: number }

export class BreathController {
  private phase: number;
  private readonly rate0: number;
  private readonly noise: SmoothNoise;
  arousal = 0;
  k = 0;
  b = 0;
  constructor(readonly cfg: BreathConfig, rng: Prng) {
    this.rate0 = cfg.rateHz + rng.range(-cfg.rateJitter, cfg.rateJitter);
    this.phase = rng.float();
    this.noise = new SmoothNoise(rng.fork('sway'), cfg.sway.band, 2);
  }
  get rate(): number { return this.rate0 + this.cfg.arousal.rateAdd * this.arousal; }
  get depth(): number { return 1 + this.cfg.arousal.depthAdd * this.arousal; }
  onHit(dv: number): void { this.arousal = Math.min(this.cfg.arousal.max, this.arousal + dv * this.cfg.arousal.perDv); }
  onStep(): void { this.arousal = Math.min(this.cfg.arousal.max, this.arousal + this.cfg.arousal.perStep); }

  /** 스텝마다: 위상·각성·켜짐 정도를 진행 */
  update(dt: number, standing: boolean, reacting = false): void {
    const c = this.cfg;
    this.arousal *= Math.exp(-dt / c.arousal.tau);
    this.phase = (this.phase + this.rate * dt) % 1;
    const f = this.phase, fi = c.inhaleFrac;
    const ss = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
    this.b = f < fi ? ss(f / fi) : 1 - ss((f - fi) / (1 - fi));
    this.k += ((standing ? (reacting ? c.reactK : 1) : 0) - this.k) * (1 - Math.exp(-dt / c.fadeTau));
  }

  /** 서기 목표 위에 호흡·흔들림 변조를 곱한다 (k가 0이면 그대로) */
  apply(t: number, targets: JointTargets | null): JointTargets | null {
    if (!targets || this.k < 1e-4) return targets;
    const c = this.cfg, out: JointTargets = { ...targets };
    const amp = this.k * this.depth * (this.b - 0.5);
    const add = (jn: JointName, d: [number, number, number]) => { out[jn] = multiplyQ(degQ(d[0], d[1], d[2]), out[jn] ?? identityQ()); };
    for (const [jn, d] of Object.entries(c.joints) as [JointName, [number, number, number]][]) add(jn, [d[0] * amp, d[1] * amp, d[2] * amp]);
    for (const [jn, d] of Object.entries(c.sway.joints) as [JointName, [number, number, number]][]) {
      const n = (i: number) => this.k * this.noise.at(`${jn}${i}`, t);
      add(jn, [d[0] * n(0), d[1] * n(1), d[2] * n(2)]);
    }
    return out;
  }

  log(): BreathLog {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { b: r(this.b), rate: r(this.rate), depth: r(this.depth), arousal: r(this.arousal), k: r(this.k) };
  }
}
