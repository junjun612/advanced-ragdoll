// 일어서기 (SPEC 12 v0.7). 정의: docs/ALGORITHMS.md v0.7, 값은 config/getup.json.
// - GetupAssist: 겟업 보조(원칙 6의 명시적 보조, assist.getup). Hips 높이(수직 힘)와 Hips 자세(토크)를 클립 기준으로 끄는 관절 모터.
//   보이지 않는 키네마틱 앵커 바디 2개(자세용: 목표 회전, 높이용: 목표 높이·항등 회전)를 매 스텝 클립 기준으로 옮기고
//   generic 관절(축 잠금 없음)의 Rapier 모터로 건다 — 루트 보조(assist.ts)와 같은 이유(명시적 PD는 Hips 관성이 작아 떨림).
//   수평 위치는 끌지 않는다(몸은 손·무릎·발 접촉으로 움직인다). 앵커·관절은 처음 쓸 때 만든다(안 쓰는 시나리오의 핸들 순서 불변).
// - GetupLibrary: 라이브러리 항목(클립 + 첫 프레임 특징 + 성공률 + 균형 복귀 시각)과 포즈 매칭.
// - GetupController: 쓰러짐 판정 → 매칭 → 실행 단계(관성화 → 클립 추종 + 보조 → 균형 복귀 → Idle), 실패·피격 처리 상태.
//   물리·상태 전환 자체는 Character(api.ts)가 이 상태를 보고 한다.
import type R from '@dimforge/rapier3d-compat';
import { R as Rapier } from '../world';
import type { Ragdoll } from './ragdoll';
import type { CharacterDef } from './characterDef';
import type { AnimClipFile } from './animDriver';
import { forwardKinematics, type BodyTransform, type JointTargets } from './pose';
import { type Vec3, add, sub, scale, length } from '../math/vec3';
import { type Quat, conjugate, multiplyQ, normalizeQ, rotate, fromRotationVector, toRotationVector } from '../math/quat';
import { quatToCoords } from './muscles';
import { classifyFeature, matchFeature, poseFeature, type MatchWeights, type PoseFeature, type PostureClass } from './getupFeatures';
import type { GetupQPConfig } from './getupQP';

export interface GetupConfig {
  detect: { lyingComHeight: number; settleSpeed: number; delay: number; woundedDelay: number; retryDelay: number };
  match: MatchWeights & { successPenalty: number };
  exec: { blendTime: number; motorScale: number; balanceGrace: number; failHipsDrop: number; failHold: number; maxAttempts: number; handoverTiltDeg: number; handoverEarly: number; rate: number; armMotorScale: number };
  balance: { idleClip: string; idleBefore: number; settleSpeed: number; settleHold: number; idleBlend: number; minHipsFrac: number; handoverComHeight: number; settleMax: number; handoverDcmMargin: number; dcmWaitMax: number; idleAtHandover: boolean; balanceMinComHeight: number; braceGuardTime: number; braceGuardThreshold: number; handoverMaxSpeed: number; upComHeight: number };
  qp: GetupQPConfig;
  assist: { enabled: boolean; heightKp: number; heightKd: number; uprightKp: number; uprightKd: number; maxForceBodyWeight: number; maxTorque: number; rise: number; fallTime: number; usageLeverArm: number; freeYaw: boolean; endLevel: number; tailTime: number };
  /** (v0.8a) 평지 판정: COM 둘레 radius m 십자 5점 지면 높이 차 ≤ maxStep m (경사 지형은 늘 아님) — 라이브러리가 평지 클립이라 계단·경사 위에서는 일어서지 않는다 */
  terrain?: { radius: number; maxStep: number };
}

/** assets/library/getup.json 항목 (SPEC 12 v0.7 '인덱스(첫 프레임 특징 벡터, 클립 경로, 성공률)') */
export interface GetupEntry {
  id: string;
  /** 애니 클립 이름 (라이브러리 클립 맵의 키) */
  clip: string;
  /** 클립 파일 경로 (저장소 기준) */
  path: string;
  /** 대표 자세 이름 (클러스터) */
  rep: string;
  posture: PostureClass;
  /** 첫 프레임 특징 (클립 공간, 정규화) */
  feature: PoseFeature;
  /** 시뮬레이션 성공률 (0~1, 시험한 쓰러진 자세들) */
  successRate: number;
  /** 클립 시각(초): 두 발로 서서 발이 아닌 바디(무릎 포함)가 바닥에서 떨어지고 몸통이 선 뒤 — 보조가 이때까지 0으로 줄고, 이보다 balanceGrace 늦으면 실패 */
  balanceTau: number;
  /** 클립 시각(초): 두 발로 서서 발이 아닌 바디가 바닥에서 떨어진 첫 시각 — 이때부터 실제 몸이 두 발로 서고 몸통이 handoverTiltDeg 안이면 균형 복귀 */
  feetTau: number;
  /** 보험 클립 (엎드림·누움 기본 자세) */
  insurance?: boolean;
}

export interface GetupLibraryData {
  entries: GetupEntry[];
  clips: Readonly<Record<string, AnimClipFile>>;
}

export interface GetupLibraryItem extends GetupEntry {
  /** 클립 0프레임 FK (클립 공간) */
  frame0: BodyTransform[];
  feat: PoseFeature;
  duration: number;
  /** 클립 시각별 Hips 높이 (기준값 실패 판정은 ref로 한다; 여기는 서기 높이) */
  standHipsY: number;
}

export class GetupLibrary {
  readonly items: GetupLibraryItem[];
  constructor(data: GetupLibraryData, def: CharacterDef) {
    this.items = data.entries.filter((e) => data.clips[e.clip]).map((e) => {
      const c = data.clips[e.clip]!;
      const f0 = c.frames[0]!, fl = c.frames[c.frames.length - 1]!;
      const frame0 = forwardKinematics(def, f0.joints, { pos: f0.root.pos, rot: multiplyQ(f0.root.rot, conjugate(def.bodies[0]!.restRotation)) });
      return { ...e, frame0, feat: poseFeature(def, frame0), duration: (c.frames.length - 1) / c.fps, standHipsY: fl.root.pos[1] };
    });
  }

  /** 지금 자세 특징과 가장 맞는 항목 (exclude 클립 제외). yaw: R_y(yaw)·지금 ≈ 클립 */
  best(feat: PoseFeature, w: GetupConfig['match'], exclude: ReadonlySet<string>, only?: string): { item: GetupLibraryItem; yaw: number; cost: number } | null {
    let best: { item: GetupLibraryItem; yaw: number; cost: number } | null = null;
    for (const it of this.items) {
      if (exclude.has(it.clip) || (only && it.clip !== only && it.id !== only)) continue;
      const m = matchFeature(feat, it.feat, w);
      const cost = m.cost + w.successPenalty * (1 - it.successRate);
      if (!best || cost < best.cost - 1e-12) best = { item: it, yaw: m.yaw, cost };
    }
    return best;
  }
}

const ANG = [Rapier.JointAxis.AngX, Rapier.JointAxis.AngY, Rapier.JointAxis.AngZ];
const LIN_Y = Rapier.JointAxis.LinY;

/** 겟업 보조 (assist.getup) */
export class GetupAssist {
  usage = 0;
  force = 0;
  torque = 0;
  /** 이번 스텝 세기 0~1 */
  strength = 0;
  private rotAnchor: R.RigidBody | null = null;
  private hAnchor: R.RigidBody | null = null;
  private rotJ: R.ImpulseJoint | null = null;
  private hJ: R.ImpulseJoint | null = null;
  private target: { y: number; vy: number; rot: Quat } | null = null;
  private readonly weight: number;

  constructor(readonly rd: Ragdoll, public cfg: GetupConfig['assist'], gravityMag: number) {
    this.weight = rd.def.totalMass * gravityMag;
  }

  private create(): void {
    const world = this.rd.pw.world;
    const hips = this.rd.body('Hips').rb;
    const p = hips.translation(), q = hips.rotation();
    this.rotAnchor = world.createRigidBody(Rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z).setRotation(q));
    this.hAnchor = world.createRigidBody(Rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
    const data = () => Rapier.JointData.generic({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0 as R.JointAxesMask);
    this.rotJ = world.createImpulseJoint(data(), this.rotAnchor, hips, true);
    this.hJ = world.createImpulseJoint(data(), this.hAnchor, hips, true);
    this.rotJ.setContactsEnabled(false);
    this.hJ.setContactsEnabled(false);
    const raw = world.impulseJoints.raw;
    for (const ax of ANG) raw.jointConfigureMotorModel(this.rotJ.handle, ax as never, Rapier.MotorModel.ForceBased as never);
    raw.jointConfigureMotorModel(this.hJ.handle, LIN_Y as never, Rapier.MotorModel.ForceBased as never);
  }

  /**
   * 목표와 세기를 정한다 (Rapier 스텝 전). s = 0이면 모터를 끈다. 목표 Hips 높이 y(속도 vy), 목표 Hips 월드 회전 rot.
   */
  set(s: number, target: { y: number; vy: number; rot: Quat } | null): void {
    this.strength = this.cfg.enabled ? Math.max(0, Math.min(1, s)) : 0;
    if (target && this.cfg.freeYaw) {
      // 수직축 둘레 회전(yaw) 오차는 끌지 않는다: 오차 회전 r = q_실제·q_목표⁻¹의 twist(월드 Y)를 목표에 곱한다 — 기울기(눕기·서기)만 돕는다
      const q = this.rd.body('Hips').rb.rotation();
      const r = multiplyQ([q.x, q.y, q.z, q.w], conjugate(target.rot));
      const n = Math.hypot(r[1], r[3]);
      if (n > 1e-9) target = { ...target, rot: normalizeQ(multiplyQ([0, r[1] / n, 0, r[3] / n], target.rot)) };
    }
    this.target = target;
    if (this.strength <= 0 && !this.rotJ) return;
    if (!this.rotJ) this.create();
    const raw = this.rd.pw.world.impulseJoints.raw;
    const c = this.cfg, k = this.strength, on = k > 0 && !!target;
    const hips = this.rd.body('Hips').rb.translation();
    if (on) {
      this.rotAnchor!.setNextKinematicTranslation(hips);
      const q = target!.rot;
      this.rotAnchor!.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
      this.hAnchor!.setNextKinematicTranslation({ x: hips.x, y: target!.y, z: hips.z });
    }
    for (const ax of ANG) {
      raw.jointConfigureMotor(this.rotJ!.handle, ax as never, 0, 0, on ? c.uprightKp : 0, on ? c.uprightKd : 0);
      raw.jointSetMotorMaxForce(this.rotJ!.handle, ax as never, on ? k * c.maxTorque : 0);
    }
    // 앵커가 목표 높이로 움직이므로 관절 상대 목표는 위치·속도 모두 0
    raw.jointConfigureMotor(this.hJ!.handle, LIN_Y as never, 0, 0, on ? c.heightKp : 0, on ? c.heightKd : 0);
    raw.jointSetMotorMaxForce(this.hJ!.handle, LIN_Y as never, on ? k * c.maxForceBodyWeight * this.weight : 0);
  }

  /** 이번 스텝 보조 렌치 예측 (월드, Hips에): 모터와 같은 PD 식을 상한으로 자름. 겟업 QP가 외부 렌치로 안다 */
  predict(): { f: Vec3; tau: Vec3 } | null {
    if (this.strength <= 0 || !this.target) return null;
    const rb = this.rd.body('Hips').rb;
    const c = this.cfg, k = this.strength, T = this.target;
    const q = rb.rotation(), w = rb.angvel(), p = rb.translation(), v = rb.linvel();
    const cc = quatToCoords(multiplyQ(conjugate(T.rot), [q.x, q.y, q.z, q.w]));
    const wl = rotate(conjugate(T.rot), [w.x, w.y, w.z]);
    const tl: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) tl[i] = Math.max(-k * c.maxTorque, Math.min(k * c.maxTorque, -c.uprightKp * cc[i]! - c.uprightKd * wl[i]!));
    const fmax = k * c.maxForceBodyWeight * this.weight;
    const fy = Math.max(-fmax, Math.min(fmax, c.heightKp * (T.y - p.y) - c.heightKd * (v.y - T.vy)));
    return { f: [0, fy, 0], tau: rotate(T.rot, tl) };
  }

  /** 사용량 추정 (PD 식, 상한으로 자름) — 루트 보조와 같은 방식 */
  measure(): void {
    this.usage = this.force = this.torque = 0;
    if (this.strength <= 0 || !this.target) return;
    const rb = this.rd.body('Hips').rb;
    const c = this.cfg, k = this.strength, T = this.target;
    const q = rb.rotation(), w = rb.angvel(), p = rb.translation(), v = rb.linvel();
    const rel = multiplyQ(conjugate(T.rot), [q.x, q.y, q.z, q.w]);
    const cc = quatToCoords(rel);
    const wl = rotate(conjugate(T.rot), [w.x, w.y, w.z]);
    let tsq = 0;
    for (let i = 0; i < 3; i++) {
      const tq = Math.max(-k * c.maxTorque, Math.min(k * c.maxTorque, -c.uprightKp * cc[i]! - c.uprightKd * wl[i]!));
      tsq += tq * tq;
    }
    const fmax = k * c.maxForceBodyWeight * this.weight;
    const f = Math.max(-fmax, Math.min(fmax, c.heightKp * (T.y - p.y) - c.heightKd * (v.y - T.vy)));
    this.force = Math.abs(f);
    this.torque = Math.sqrt(tsq);
    this.usage = this.force + this.torque / c.usageLeverArm;
  }
}

export type GetupPhase = 'monitor' | 'rising' | 'balance';

/** 로그 (CharacterState.getup) */
export interface GetupLog {
  phase: GetupPhase;
  enabled: boolean;
  /** 누워 안정된 시간 (초, 판정 중) */
  settled: number;
  /** 이번 쓰러짐의 시도 번호 (1부터), 시도 상한 */
  attempt: number;
  maxAttempts: number;
  posture: PostureClass | null;
  clip: string | null;
  cost: number | null;
  tau: number | null;
  /** 진행 0~1 (balanceTau 기준) */
  progress: number | null;
  balanceTau: number | null;
  assist: { s: number; force: number; torque: number };
  /** 마지막 사건 (시작·실패·취소·완료) */
  last: string | null;
  /** 겟업 QP (일어서는 중만): COM 목표·오차, 지지 기준 이동, 접촉점 수, 접촉 합력 오차, 접촉력 */
  qp?: import('./getupQP').GetupQPLog | null;
}

/** 루트(Hips) 관성화 오프셋: 지금 Hips ↔ 클립 0프레임 Hips 차이를 임계 감쇠 스프링으로 줄인다 */
export class RootBlend {
  private p: Vec3 = [0, 0, 0];
  private r: Vec3 = [0, 0, 0];
  private t0 = 0;
  private lambda = 0;
  start(t: number, blendTime: number, actual: BodyTransform, clip: BodyTransform): void {
    this.t0 = t;
    this.lambda = blendTime > 0 ? 6.6 / blendTime : 0;
    this.p = sub(actual.pos, clip.pos);
    this.r = toRotationVector(normalizeQ(multiplyQ(actual.rot, conjugate(clip.rot))));
  }
  private k(t: number): number {
    if (this.lambda <= 0) return 0;
    const d = Math.max(0, t - this.t0);
    return (1 + this.lambda * d) * Math.exp(-this.lambda * d);
  }
  apply(t: number, b: BodyTransform): BodyTransform {
    const k = this.k(t);
    if (k < 1e-6) return b;
    return { pos: add(b.pos, scale(this.p, k)), rot: normalizeQ(multiplyQ(fromRotationVector(scale(this.r, k)), b.rot)) };
  }
  magnitude(t: number): number { return this.k(t) * length(this.p); }
}

/** 실행 중인 겟업 한 번 */
export interface GetupRun {
  item: GetupLibraryItem;
  t0: number;
  cost: number;
  yaw: number;
  posture: PostureClass;
  root: RootBlend;
  /** Hips가 기준보다 많이 낮은 채 지난 시간 */
  lowFor: number;
  /** 균형으로 넘긴 시각, 그때 보조 세기 */
  balanceT: number | null;
  assistAtBalance?: number;
  /** 균형 복귀 뒤 멈춰 선 시간 */
  stillFor?: number;
}

/** 쓰러짐 판정·시도 횟수·실행 상태 (Character가 구동) */
export class GetupController {
  enabled: boolean;
  phase: GetupPhase = 'monitor';
  run: GetupRun | null = null;
  /** 누워 안정된 시작 시각 */
  settledSince: number | null = null;
  /** 다음 시작이 가능한 시각 (실패 뒤 재시도 간격) */
  notBefore = -Infinity;
  /** 이번 쓰러짐에서 시도한 클립 */
  tried = new Set<string>();
  attempts = 0;
  last: string | null = null;
  /** 판정만 하고 시작하지 않는다 (라이브러리 만들기: 그 순간 자세를 모은다) */
  probe = false;
  /** 시험용: 이 클립(이름 또는 id)만 쓴다 */
  only: string | undefined;
  /** probe에서 판정된 순간 */
  ready: { t: number; transforms: BodyTransform[] } | null = null;

  constructor(readonly cfg: GetupConfig, readonly lib: GetupLibrary, enabled: boolean) {
    this.enabled = enabled;
  }

  /** 누워 안정됨 판정을 갱신하고, 시작할 때가 됐는지 */
  shouldStart(t: number, lying: boolean, comSpeed: number, wounded: boolean): boolean {
    const d = this.cfg.detect;
    if (!lying || comSpeed >= d.settleSpeed) { this.settledSince = null; return false; }
    this.settledSince ??= t;
    if (!this.enabled || t < this.notBefore || this.attempts >= this.cfg.exec.maxAttempts) return false;
    return t - this.settledSince >= (wounded ? d.woundedDelay : d.delay);
  }

  /** 단계별 보조 세기: 처음 rise초에 0→1, balanceTau 전 fallTime초 동안 1→endLevel, 균형으로 넘긴 뒤 tailTime초에 0 */
  assistStrength(t: number, tau: number): number {
    const r = this.run;
    if (!r) return 0;
    const a = this.cfg.assist;
    const sm = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
    // 균형으로 넘긴 뒤: 넘길 때 세기에서 tailTime초에 0으로 (균형 계층이 받는 동안 함께 줄인다)
    if (this.phase === 'balance') return r.balanceT === null ? 0 : (r.assistAtBalance ?? 0) * (1 - sm((t - r.balanceT) / a.tailTime));
    if (this.phase !== 'rising') return 0;
    return sm((t - r.t0) / a.rise) * (1 - (1 - a.endLevel) * sm((tau - (r.item.balanceTau - a.fallTime)) / a.fallTime));
  }

  /** 새 쓰러짐(일어선 뒤 또는 처음): 시도 기록을 지운다 */
  resetEpisode(): void {
    this.tried.clear();
    this.attempts = 0;
  }

  log(t: number, tau: number | null, assist: GetupAssist, posture: PostureClass | null): GetupLog {
    const r = this.run;
    return {
      phase: this.phase, enabled: this.enabled, settled: this.settledSince === null ? 0 : t - this.settledSince,
      attempt: this.attempts, maxAttempts: this.cfg.exec.maxAttempts, posture: r?.posture ?? posture,
      clip: r?.item.clip ?? null, cost: r?.cost ?? null, tau, progress: r && tau !== null ? Math.min(1, tau / Math.max(1e-6, r.item.balanceTau)) : null,
      balanceTau: r?.item.balanceTau ?? null, assist: { s: assist.strength, force: assist.force, torque: assist.torque }, last: this.last,
    };
  }
}

export { poseFeature, classifyFeature };
export type { JointTargets };
