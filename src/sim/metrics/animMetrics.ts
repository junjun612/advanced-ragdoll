// v0.6 애니메이션 통합 지표 (docs/ALGORITHMS.md v0.6 '지표'). 로그 상태(anim·walk·pin·states)를 읽기만 한다.
// - 핀: pinUsageTracking(추종 중 적분, N·s), pinUsageBlend(전환 블렌드), pinPeak(N), pinDuringReaction(반응 중 적분 — 0이어야 함)
// - 추종: walkEngagedFrac(애니 클립이 있는 Active 스텝 중 걷기 추종 비율), walkHandovers/walkResumes, walkDistance(m), walkSpeed(m/s)
//   clipComErrCm(COM 수평 vs 클립 COM), clipPoseErrDeg(바디 방향 vs 클립, 평균), clipShapeErrCm(COM 기준 바디 위치 vs 클립)
// - 발: walkLandingErrorMean(착지점 vs 목표 = 클립 디딤 + 디딤 수정), walkSteps, walkFootSlidePerStep(지지발 접촉점 미끄러짐 m/걸음, 추종 중),
//   walkScuffTime(스윙·떼기 중인 발이 지면 접촉 거리 안에 있던 시간 합, 초 — 발끝 끌림)
// - 전환: switchVelJumpLin/Ang(Animated → Active 넘긴 속도와 직전 키네마틱 속도 차이 최대), switchPopAccel(전환 뒤 0.1초 안 바디 선가속도 최대,
//   피격 전환이면 충격 스텝 제외 — 관절이 튀는지)
// - 클립 이음매: animTargetSpeedMax / animTargetSpeedP99 (클립 기준 자세의 Hips 상대 바디 각속도, °/s), animSeamSpeedRatio = 루프 이음매 근처(위상 3% 안)
//   최대 / 전체 중앙값 — 이음매 튐이면 크다
import type { CharacterState, SimEvent, Vec3, Quat } from '../types';

const DEG = 180 / Math.PI;
const relAngle = (a: Readonly<Quat>, b: Readonly<Quat>): number => {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(d);
};
const mulQ = (a: Readonly<Quat>, b: Readonly<Quat>): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conjQ = (q: Readonly<Quat>): Quat => [-q[0], -q[1], -q[2], q[3]];

export class AnimMetrics {
  private any = false;
  private pinTrack = 0; private pinBlend = 0; private pinPeak = 0; private pinReact = 0;
  private activeAnim = 0; private engaged = 0;
  private handovers = 0; private resumes = 0;
  private walkStart: { t: number; com: Vec3 } | null = null;
  private walkLast: { t: number; com: Vec3 } | null = null;
  private engagedTime = 0;
  private comErr = 0; private poseErr = 0; private shapeErr = 0; private nErr = 0;
  private landKey = new Set<string>();
  private landErr: number[] = [];
  private slip = 0;
  private scuff = 0;
  private lastHit = -Infinity;
  private switchJ: { t: number; lin: number; ang: number; hit: boolean } | null = null;
  private popMax = 0;
  private prevVel: Record<string, Vec3> | null = null;
  private prevAnim: { t: number; rel: Record<string, Quat> } | null = null;
  private animSpeeds: number[] = [];
  private seamSpeeds: number[] = [];

  constructor(readonly reactHold: number) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'walkHandover') this.handovers++;
    if (e.type === 'walkResume') this.resumes++;
    if (e.type === 'hit') this.lastHit = e.t;
  }

  onState(s: CharacterState, dt: number, logFrame: boolean): void {
    if (!s.anim && !s.pin && !s.states) { this.prevVel = null; return; }
    this.any = true;
    const t = s.time;
    const pin = s.pin;
    const usage = s.assist.pin;
    if (pin && usage > 0) {
      if (pin.reason === 'blend') this.pinBlend += usage * dt; else this.pinTrack += usage * dt;
      this.pinPeak = Math.max(this.pinPeak, usage);
    }
    const reacting = t - this.lastHit < this.reactHold || s.behaviors.some((b) => b.name !== 'LookAt' && b.weight > 0.01) || (!!s.walk && !s.walk.engaged);
    if (reacting) this.pinReact += usage * dt;
    // 전환
    const sj = s.states?.switchJump;
    if (sj && (!this.switchJ || sj.t !== this.switchJ.t)) { this.switchJ = sj; this.popMax = 0; }
    const vel: Record<string, Vec3> = {};
    for (const [n, b] of Object.entries(s.bodies)) vel[n] = b.linVel;
    if (this.switchJ && this.prevVel && t > this.switchJ.t + dt * 1.5 && t <= this.switchJ.t + 0.1 + 1e-9 && !(this.switchJ.hit && t - this.lastHit < 2 * dt)) {
      for (const [n, v] of Object.entries(vel)) {
        const p = this.prevVel[n];
        if (p) this.popMax = Math.max(this.popMax, Math.hypot(v[0] - p[0], v[1] - p[1], v[2] - p[2]) / dt);
      }
    }
    this.prevVel = vel;
    // 클립 기준 자세 각속도 (이음매)
    if (s.anim && logFrame) {
      const hq = s.anim.bodies.Hips.rot;
      const rel: Record<string, Quat> = {};
      for (const [n, b] of Object.entries(s.anim.bodies)) rel[n] = mulQ(conjQ(hq), b.rot);
      if (this.prevAnim && t > this.prevAnim.t) {
        let m = 0;
        for (const [n, q] of Object.entries(rel)) { const p = this.prevAnim.rel[n]; if (p) m = Math.max(m, relAngle(p, q) * DEG / (t - this.prevAnim.t)); }
        this.animSpeeds.push(m);
        if (s.anim.phase < 0.03 || s.anim.phase > 0.97) this.seamSpeeds.push(m);
      }
      this.prevAnim = { t, rel };
    }
    // 걷기 추종
    if (s.state === 'Active' && s.anim && s.walk) {
      this.activeAnim++;
      if (s.walk.engaged) {
        this.engaged++;
        this.engagedTime += dt;
        this.walkStart ??= { t, com: s.com };
        this.walkLast = { t, com: s.com };
        if (logFrame) {
          const a = s.anim;
          this.comErr += Math.hypot(s.com[0] - a.com[0], s.com[2] - a.com[2]);
          let pe = 0, se = 0, k = 0;
          for (const [n, b] of Object.entries(s.bodies)) {
            const r = a.bodies[n as keyof typeof a.bodies];
            if (!r) continue;
            pe += relAngle(b.rot, r.rot);
            se += Math.hypot(b.pos[0] - s.com[0] - (r.pos[0] - a.com[0]), b.pos[1] - s.com[1] - (r.pos[1] - a.com[1]), b.pos[2] - s.com[2] - (r.pos[2] - a.com[2]));
            k++;
          }
          if (k) { this.poseErr += pe / k; this.shapeErr += se / k; this.nErr++; }
        }
        for (const l of s.walk.landings) {
          const key = `${l.foot}@${l.t.toFixed(4)}`;
          if (!this.landKey.has(key)) { this.landKey.add(key); this.landErr.push(l.error); }
        }
        // 접촉점 미끄러짐 (quality.ts footSlide와 같은 정의, 추종 중만)
        for (const f of ['LeftFoot', 'RightFoot'] as const) {
          const cps = s.contacts.filter((c) => c.body === f);
          if (!cps.length) continue;
          // 지지발만 (스윙발이 바닥 1cm 안을 지나가는 것은 미끄러짐이 아니라 발끝 여유 부족 — walkScuffTime)
          if (s.walk.feet[f]?.mode !== 'stance') { this.scuff += dt; continue; }
          const pc: Vec3 = [0, 0, 0];
          for (const c of cps) for (let i = 0; i < 3; i++) pc[i]! += c.point[i]! / cps.length;
          const b = s.bodies[f];
          const r: Vec3 = [pc[0] - b.pos[0], pc[1] - b.pos[1], pc[2] - b.pos[2]];
          const w = b.angVel, v = b.linVel;
          this.slip += Math.hypot(v[0] + (w[1] * r[2] - w[2] * r[1]), v[2] + (w[0] * r[1] - w[1] * r[0])) * dt;
        }
      }
    }
  }

  finish(): Record<string, number> {
    if (!this.any) return {};
    const m: Record<string, number> = {
      pinUsageTracking: this.pinTrack,
      pinUsageBlend: this.pinBlend,
      pinPeak: this.pinPeak,
      pinDuringReaction: this.pinReact,
    };
    if (this.activeAnim) {
      m.walkEngagedFrac = this.engaged / this.activeAnim;
      m.walkHandovers = this.handovers;
      m.walkResumes = this.resumes;
    }
    if (this.walkStart && this.walkLast) {
      const d = Math.hypot(this.walkLast.com[0] - this.walkStart.com[0], this.walkLast.com[2] - this.walkStart.com[2]);
      m.walkDistance = d;
      m.walkSpeed = this.walkLast.t > this.walkStart.t ? d / (this.walkLast.t - this.walkStart.t) : 0;
    }
    if (this.nErr) {
      m.clipComErrCm = (100 * this.comErr) / this.nErr;
      m.clipPoseErrDeg = (DEG * this.poseErr) / this.nErr;
      m.clipShapeErrCm = (100 * this.shapeErr) / this.nErr;
    }
    if (this.landErr.length) {
      m.walkSteps = this.landErr.length;
      m.walkLandingErrorMean = this.landErr.reduce((a, b) => a + b, 0) / this.landErr.length;
      m.walkFootSlidePerStep = this.slip / this.landErr.length;
      m.walkScuffTime = this.scuff;
    }
    if (this.switchJ) {
      m.switchVelJumpLin = this.switchJ.lin;
      m.switchVelJumpAng = this.switchJ.ang;
      m.switchPopAccel = this.popMax;
    }
    if (this.animSpeeds.length) {
      const v = [...this.animSpeeds].sort((a, b) => a - b);
      m.animTargetSpeedMax = v[v.length - 1]!;
      m.animTargetSpeedP99 = v[Math.min(v.length - 1, Math.floor(0.99 * v.length))]!;
      const med = v[v.length >> 1]!;
      if (this.seamSpeeds.length && med > 1e-6) m.animSeamSpeedRatio = Math.max(...this.seamSpeeds) / med;
    }
    return m;
  }
}
