// 핀 보조 (SPEC v0.6 '핀 보조', 원칙 6의 명시적 보조 — PuppetMaster pin weight와 같은 개념). 정의: docs/ALGORITHMS.md v0.6.
// 바디마다 애니 목표(질량 중심 위치·회전) 쪽으로 끄는 외력·토크:
//   F = s·w_b·m_b·(kp(x_anim − x) + kd(v_anim − v)),  τ = s·w_b·I_b·(kpRot·log(q_anim q⁻¹) + kdRot(ω_anim − ω))
// (가속도 수준 이득이라 가벼운 손도 같은 응답 — 명시적 힘이라 kd·dt ≪ 2로 안정). |F| ≤ maxForce, |τ| ≤ maxTorque (허용 범위).
// s = 전체 핀 강도(상태 머신이 정함): Animated↔Active 전환 블렌드, 애니 추종 걷기·Idle 중에만 > 0. 피격·외란이 오면 decayTime 안에 0으로,
// 반응 중에는 0, 클립 위상으로 돌아오면 returnTime에 걸쳐 다시 올린다. 사용량 assist.pin = Σ|F| + Σ|τ|/usageLeverArm (N).
import type { Ragdoll } from './ragdoll';
import type { BodyName } from './characterDef';
import type { AnimRef, MassModel } from './animDriver';
import { type Vec3, add, sub, scale, length } from '../math/vec3';
import { type Quat, conjugate, multiplyQ, rotate, toRotationVector } from '../math/quat';

export interface PinConfig {
  enabled: boolean;
  /** 'full' = 월드 위치로 끔(PuppetMaster), 'shape' = COM 기준 상대 위치만(전신 COM에 알짜 힘 없음) */
  mode: 'full' | 'shape';
  kp: number;
  kd: number;
  kpRot: number;
  kdRot: number;
  /** 바디별 핀 가중치 (없으면 defaultWeight) */
  weights: Partial<Record<BodyName, number>>;
  defaultWeight: number;
  /** 바디당 허용 상한 (가속도 수준: |F| ≤ m·maxAccel, |τ| ≤ I·maxAngAccel) */
  maxAccel: number;
  maxAngAccel: number;
  usageLeverArm: number;
  /** 피격·외란 뒤 0까지 (초) */
  decayTime: number;
  /** 클립 위상 복귀 뒤 다시 올리는 시간 (초) */
  returnTime: number;
  /** 애니 추종(걷기·Idle) 중 핀 강도 (0이면 전환 블렌드에서만 씀) */
  trackingStrength: number;
  /** 클립별 추종 중 핀 (강도·방식). 없으면 trackingStrength·mode */
  trackingByClip?: Record<string, { strength: number; mode: 'full' | 'shape' }>;
}

export interface PinState {
  /** 전체 핀 강도 0~1 */
  strength: number;
  /** 이번 스텝 사용량 (N) */
  usage: number;
  /** 바디별 핀 세기 (가중치 × 강도, 필름 테두리 색) */
  bodies: Partial<Record<BodyName, number>>;
  /** 강도가 0이 아닌 이유 ('blend' | 'tracking' | '') */
  reason: string;
}

export class PinAssist {
  strength = 0;
  usage = 0;
  reason = '';
  /** 바디별 외력·토크 (월드, 질량 중심) — 균형 QP가 외부 렌치로 안다 */
  wrench: { f: Vec3; tau: Vec3 }[] = [];
  private on = false;
  private modeNow: 'full' | 'shape' = 'shape';
  private refCom: Vec3 = [0, 0, 0];
  private refComVel: Vec3 = [0, 0, 0];
  private com: Vec3 = [0, 0, 0];
  private comVel: Vec3 = [0, 0, 0];

  constructor(readonly rd: Ragdoll, public cfg: PinConfig, readonly mass: MassModel) {}

  /** 목표 강도 쪽으로 강도를 움직인다: 내려갈 때는 decayTime, 올라갈 때는 returnTime (선형) */
  schedule(target: number, dt: number, immediate = false): void {
    const t = Math.max(0, Math.min(1, this.cfg.enabled ? target : 0));
    if (immediate) { this.strength = t; return; }
    if (t < this.strength) this.strength = Math.max(t, this.strength - dt / Math.max(1e-6, this.cfg.decayTime));
    else this.strength = Math.min(t, this.strength + dt / Math.max(1e-6, this.cfg.returnTime));
  }

  /** 힘 계산 (Rapier 스텝 전, 근육보다 먼저: 균형 QP가 렌치를 안다). ref가 없거나 강도 0이면 0 */
  compute(ref: AnimRef | null, modeOverride?: 'full' | 'shape'): void {
    this.modeNow = modeOverride ?? this.cfg.mode;
    const n = this.rd.bodies.length;
    this.wrench = Array.from({ length: n }, () => ({ f: [0, 0, 0] as Vec3, tau: [0, 0, 0] as Vec3 }));
    this.usage = 0;
    this.on = false;
    const s = this.strength;
    if (!ref || s <= 0) return;
    const c = this.cfg;
    if (this.modeNow === 'shape') {
      // 기준·실제 COM (질량 가중, 같은 질량 모델)
      let rc: Vec3 = [0, 0, 0], rv: Vec3 = [0, 0, 0], ac: Vec3 = [0, 0, 0], av: Vec3 = [0, 0, 0], M = 0;
      for (let i = 0; i < n; i++) {
        const m = this.mass.mass[i]!, tgt = ref.bodies[i]!, lc = this.mass.localCom[i]!;
        rc = add(rc, scale(add(tgt.pos, rotate(tgt.rot, lc)), m));
        rv = add(rv, scale(add(ref.bodyLin[i]!, crossV(ref.bodyAng[i]!, rotate(tgt.rot, lc))), m));
        const rb = this.rd.bodies[i]!.rb, wc = rb.worldCom(), lv = rb.linvel();
        ac = add(ac, scale([wc.x, wc.y, wc.z], m));
        av = add(av, scale([lv.x, lv.y, lv.z], m));
        M += m;
      }
      this.refCom = scale(rc, 1 / M); this.refComVel = scale(rv, 1 / M); this.com = scale(ac, 1 / M); this.comVel = scale(av, 1 / M);
    }
    for (let i = 0; i < n; i++) {
      const b = this.rd.bodies[i]!;
      if (!b.rb.isDynamic()) continue;
      const w = (c.weights[b.name] ?? c.defaultWeight) * s;
      if (w <= 0) continue;
      const m = this.mass.mass[i]!;
      const lc = this.mass.localCom[i]!;
      const tgt = ref.bodies[i]!;
      const xRef = add(tgt.pos, rotate(tgt.rot, lc));
      const wc = b.rb.worldCom(), lv = b.rb.linvel(), av = b.rb.angvel(), q = b.rb.rotation();
      const qb: Quat = [q.x, q.y, q.z, q.w];
      // 목표 점 속도 = 바디 속도 + ω × (COM 오프셋)
      const vRef = add(ref.bodyLin[i]!, crossV(ref.bodyAng[i]!, rotate(tgt.rot, lc)));
      // shape 모드: COM 기준 상대 위치·속도만 끈다 (Σ m·Δ = 0 → 전신 COM에 알짜 힘을 주지 않는다. COM·균형은 걷기 제어가 맡는다)
      const ex = this.modeNow === 'shape' ? sub(sub(xRef, this.refCom), sub([wc.x, wc.y, wc.z], this.com)) : sub(xRef, [wc.x, wc.y, wc.z]);
      const ev = this.modeNow === 'shape' ? sub(sub(vRef, this.refComVel), sub([lv.x, lv.y, lv.z], this.comVel)) : sub(vRef, [lv.x, lv.y, lv.z]);
      let f = scale(add(scale(ex, c.kp), scale(ev, c.kd)), w * m);
      const fl = length(f), fmax = w * m * c.maxAccel;
      if (fl > fmax) f = scale(f, fmax / fl);
      let qe = multiplyQ(tgt.rot, conjugate(qb));
      if (qe[3] < 0) qe = [-qe[0], -qe[1], -qe[2], -qe[3]];
      const alpha = add(scale(toRotationVector(qe), c.kpRot), scale(sub(ref.bodyAng[i]!, [av.x, av.y, av.z]), c.kdRot));
      // 월드 관성 R I Rᵀ α
      const al = rotate(conjugate(qb), alpha);
      const I = this.mass.inertia[i]!;
      let tau = rotate(qb, [I[0]! * al[0] + I[1]! * al[1] + I[2]! * al[2], I[3]! * al[0] + I[4]! * al[1] + I[5]! * al[2], I[6]! * al[0] + I[7]! * al[1] + I[8]! * al[2]]);
      tau = scale(tau, w);
      const tl = length(tau), tmax = w * ((I[0]! + I[4]! + I[8]!) / 3) * c.maxAngAccel;
      if (tl > tmax) tau = scale(tau, tmax / tl);
      this.wrench[i] = { f, tau };
      this.usage += length(f) + length(tau) / c.usageLeverArm;
      this.on = true;
    }
  }

  /** 계산한 힘을 건다 (근육 계층이 토크·힘을 지운 뒤에 부른다) */
  apply(): void {
    if (!this.on) return;
    this.rd.bodies.forEach((b, i) => {
      const w = this.wrench[i]!;
      if (!b.rb.isDynamic()) return;
      if (w.f[0] || w.f[1] || w.f[2]) { const c = b.rb.worldCom(); b.rb.addForceAtPoint({ x: w.f[0], y: w.f[1], z: w.f[2] }, c, true); }
      if (w.tau[0] || w.tau[1] || w.tau[2]) b.rb.addTorque({ x: w.tau[0], y: w.tau[1], z: w.tau[2] }, true);
    });
  }

  state(): PinState {
    const bodies: Partial<Record<BodyName, number>> = {};
    if (this.strength > 0) for (const b of this.rd.bodies) { const w = (this.cfg.weights[b.name] ?? this.cfg.defaultWeight) * this.strength; if (w > 0) bodies[b.name] = w; }
    return { strength: this.strength, usage: this.usage, bodies, reason: this.reason };
  }
}

const crossV = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
