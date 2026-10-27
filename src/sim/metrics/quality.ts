// 품질 지표 (SPEC 10, v0.3부터)와 균형 지표. 매 스텝 CharacterState만 읽는다. 정의: docs/ALGORITHMS.md v0.3.
// - comJerk / angJerk: COM 속도·Spine2 각속도를 jerkDt 간격으로 표본 → 두 번 차분 → RMS
// - footSlide: 연속한 두 스텝 모두 지면에 닿은 발의 수평 이동 합 (두 발 합, m). footDisplacementMax: 발의 시작 위치에서 수평 거리 최대
// - reactionLatency: 충격 시점부터 균형 가상 힘(피드백)이 충격 시점 값에서 reactionForce(N) 넘게 바뀐 첫 시각까지 (충격별 평균)
// - assistUsage.pin / .getup: 보조별 적분 (v0.3에는 0, 루트는 MuscleMetrics)
// - balance*: 균형이 켜진 스텝의 여유 최소, 고관절 전략 가중치 최대, 고관절 전략 시간, QP 렌치 추적 오차(힘·모멘트) 최대
// - lean*: Spine2 기울기 ≥ leanTiltDeg인 로그 프레임에서 Hips가 시작 위치보다 뒤(시작 Hips heading 기준)로 간 거리의 최소, 기울기 최대
import type { CharacterState, SimEvent, Vec3 } from '../types';
import { rotate } from '../math/quat';

export interface QualityJudge {
  jerkDt: number;
  reactionForce: number;
  leanTiltDeg: number;
}

const FEET = ['LeftFoot', 'RightFoot'] as const;

export class QualityMetrics {
  private prevT: number | null = null;
  private stepN = 0;
  private every = 0;
  private vPrev: { com: Vec3; ang: Vec3 } | null = null;
  private aPrev: { com: Vec3; ang: Vec3 } | null = null;
  private jerkSq = { com: 0, ang: 0, n: 0 };
  private footPrev: Partial<Record<(typeof FEET)[number], [number, number] | null>> = {};
  private footStart: Partial<Record<(typeof FEET)[number], [number, number]>> = {};
  private slide = 0;
  private slip = 0;
  private dispMax = 0;
  private assistPin = 0;
  private assistGetup = 0;
  private pendingHits: { t: number; f0: Vec3 | null }[] = [];
  private latencies: number[] = [];
  private lastF: Vec3 = [0, 0, 0];
  private marginMin = Infinity;
  private hipMax = 0;
  private hipTime = 0;
  private momErrMax = 0;
  private forceErrMax = 0;
  private hips0: Vec3 | null = null;
  private fwd0: Vec3 = [0, 0, 1];
  private leanBackMin = Infinity;
  private leanTiltMax = 0;

  constructor(readonly j: QualityJudge) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'hit') this.pendingHits.push({ t: e.t, f0: null });
  }

  onState(s: CharacterState, logFrame: boolean): void {
    const t = s.time;
    const dt = this.prevT === null ? 0 : t - this.prevT;
    this.prevT = t;

    // 저크 (jerkDt 간격 표본: 스텝 every개마다)
    if (this.every === 0 && dt > 0) this.every = Math.max(1, Math.round(this.j.jerkDt / dt));
    if (this.every > 0 && this.stepN % this.every === 0) {
      const T = this.every * dt;
      const v = { com: s.comVel, ang: s.bodies.Spine2.angVel };
      if (this.vPrev) {
        const a = { com: diff(v.com, this.vPrev.com, T), ang: diff(v.ang, this.vPrev.ang, T) };
        if (this.aPrev) {
          this.jerkSq.com += sq(diff(a.com, this.aPrev.com, T));
          this.jerkSq.ang += sq(diff(a.ang, this.aPrev.ang, T));
          this.jerkSq.n++;
        }
        this.aPrev = a;
      }
      this.vPrev = v;
    }
    this.stepN++;

    // 발 미끄러짐
    const ground = new Set(s.contacts.map((c) => c.body));
    for (const f of FEET) {
      const p: [number, number] = [s.bodies[f].pos[0], s.bodies[f].pos[2]];
      this.footStart[f] ??= p;
      const st = this.footStart[f]!;
      this.dispMax = Math.max(this.dispMax, Math.hypot(p[0] - st[0], p[1] - st[1]));
      const prev = this.footPrev[f];
      const on = ground.has(f);
      if (on && prev) {
        this.slide += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        // 접촉점 미끄러짐 (v0.4): 접촉점 평균에서 발 바디의 점 속도 수평 성분 × dt. 발끝 둘레로 도는 것(뒤꿈치 들기)은 미끄러짐이 아니다
        const cps = s.contacts.filter((c) => c.body === f);
        if (cps.length && dt > 0) {
          const pc: Vec3 = [0, 0, 0];
          for (const c of cps) for (let k = 0; k < 3; k++) pc[k]! += c.point[k]! / cps.length;
          const b = s.bodies[f];
          const r: Vec3 = [pc[0] - b.pos[0], pc[1] - b.pos[1], pc[2] - b.pos[2]];
          const w = b.angVel, v = b.linVel;
          const vx = v[0] + (w[1] * r[2] - w[2] * r[1]), vz = v[2] + (w[0] * r[1] - w[1] * r[0]);
          this.slip += Math.hypot(vx, vz) * dt;
        }
      }
      this.footPrev[f] = on ? p : null;
    }

    this.assistPin += s.assist.pin * dt;
    this.assistGetup += s.assist.getup * dt;

    // 반응 지연
    const b = s.balance;
    for (const h of this.pendingHits) {
      if (t < h.t - 1e-9) continue;
      h.f0 ??= this.lastF;
      const d = Math.hypot(b.virtualForce[0] - h.f0[0], b.virtualForce[1] - h.f0[1], b.virtualForce[2] - h.f0[2]);
      if (d > this.j.reactionForce) {
        this.latencies.push(t - h.t);
        h.t = Infinity; // 끝남 표시
      }
    }
    this.pendingHits = this.pendingHits.filter((h) => h.t !== Infinity);
    this.lastF = b.virtualForce;

    // 균형
    if (b.enabled) {
      this.marginMin = Math.min(this.marginMin, b.margin);
      this.hipMax = Math.max(this.hipMax, b.hipWeight);
      if (b.strategy === 'hip') this.hipTime += dt;
      this.momErrMax = Math.max(this.momErrMax, b.momentError);
      this.forceErrMax = Math.max(this.forceErrMax, b.forceError);
    }

    // 상체 숙이기 (로그 프레임)
    const hp = s.bodies.Hips.pos;
    if (!this.hips0) {
      this.hips0 = hp;
      const f = rotate(s.bodies.Hips.rot, [0, 0, 1]);
      const n = Math.hypot(f[0], f[2]) || 1;
      this.fwd0 = [f[0] / n, 0, f[2] / n];
    }
    const tilt = Number(s.debug.spine2TiltDeg);
    if (logFrame) {
      this.leanTiltMax = Math.max(this.leanTiltMax, tilt);
      if (tilt >= this.j.leanTiltDeg) {
        const back = -((hp[0] - this.hips0[0]) * this.fwd0[0] + (hp[2] - this.hips0[2]) * this.fwd0[2]);
        this.leanBackMin = Math.min(this.leanBackMin, back);
      }
    }
  }

  finish(): Record<string, number> {
    const n = Math.max(this.jerkSq.n, 1);
    const m: Record<string, number> = {
      comJerk: Math.sqrt(this.jerkSq.com / n),
      angJerk: Math.sqrt(this.jerkSq.ang / n),
      footSlide: this.slip,
      footSlideBody: this.slide,
      footDisplacementMax: this.dispMax,
      'assistUsage.pin': this.assistPin,
      'assistUsage.getup': this.assistGetup,
      leanTiltMaxDeg: this.leanTiltMax,
    };
    if (this.latencies.length) m.reactionLatency = this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    if (this.marginMin !== Infinity) {
      m.balanceMarginMin = this.marginMin;
      m.hipWeightMax = this.hipMax;
      m.hipStrategyTime = this.hipTime;
      m.momentErrorMax = this.momErrMax;
      m.forceErrorMax = this.forceErrMax;
    }
    if (this.leanBackMin !== Infinity) m.leanHipsBackMin = this.leanBackMin;
    return m;
  }
}

const diff = (a: Readonly<Vec3>, b: Readonly<Vec3>, T: number): Vec3 => [(a[0] - b[0]) / T, (a[1] - b[1]) / T, (a[2] - b[2]) / T];
const sq = (a: Readonly<Vec3>): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
