// 루트 보조 (SPEC v0.2, 원칙 6의 명시적 보조). Hips를 목표 회전으로 돌리는 가상 토크 + Hips 높이 스프링(수직 힘).
// 구현: 월드에 고정된 보이지 않는 앵커 바디(충돌체 없음, 스폰 때 Hips 자세)와 Hips를 축 잠금 없는 generic 관절로 잇고,
// 그 관절의 Rapier 모터(ForceBased)로 건다 — AngX/Y/Z 목표 0(앵커 회전), LinY 목표 0(앵커 높이). LinX·LinZ는 자유.
// 명시적 토크(addTorque)로 걸면 Hips 관성이 작아 감쇠 항이 매 스텝 부호가 바뀌며 진동했다(Hips yaw ±3.5 rad/s, docs/ALGORITHMS.md v0.2).
// 상한(허용 범위): 회전 축별 maxTorque, 높이 maxForceBodyWeight × 체중. 사용량 assist.root는 같은 PD 식으로 계산한 추정값이다
// (모터 출력은 읽을 수 없다, 근육과 같음). 앵커 바디·관절은 보조를 처음 켤 때 만든다(안 쓰는 시나리오의 핸들 순서 불변).
import type R from '@dimforge/rapier3d-compat';
import { R as Rapier } from '../world';
import type { Ragdoll } from './ragdoll';
import type { Vec3 } from '../math/vec3';
import { type Quat, conjugate, multiplyQ, rotate } from '../math/quat';
import { quatToCoords } from './muscles';

export interface RootAssistConfig {
  enabledByDefault: boolean;
  uprightKp: number;
  uprightKd: number;
  maxTorque: number;
  heightKp: number;
  heightKd: number;
  maxForceBodyWeight: number;
  usageLeverArm: number;
}

export interface AssistConfig {
  root: RootAssistConfig;
}

const ANG = [Rapier.JointAxis.AngX, Rapier.JointAxis.AngY, Rapier.JointAxis.AngZ];
const LIN_Y = Rapier.JointAxis.LinY;

export class RootAssist {
  private on = false;
  /** 이번 스텝 사용량 추정 (N, |F| + |τ|/lever) */
  usage = 0;
  force = 0;
  torque = 0;
  private readonly maxForce: number;
  private joint: R.ImpulseJoint | null = null;

  constructor(
    readonly rd: Ragdoll,
    readonly cfg: RootAssistConfig,
    /** 목표 Hips 회전(월드)과 위치 — 스폰 시점 값 */
    readonly targetRot: Quat,
    readonly targetPos: Vec3,
    gravityMag: number,
    enabled?: boolean,
  ) {
    this.maxForce = cfg.maxForceBodyWeight * rd.def.totalMass * gravityMag;
    this.enabled = enabled ?? cfg.enabledByDefault;
  }

  get enabled(): boolean {
    return this.on;
  }

  set enabled(v: boolean) {
    this.on = v;
    if (v && !this.joint) this.createJoint();
    if (!this.joint) return;
    const raw = this.rd.pw.world.impulseJoints.raw;
    const h = this.joint.handle;
    const c = this.cfg;
    for (const ax of ANG) {
      raw.jointConfigureMotor(h, ax as never, 0, 0, v ? c.uprightKp : 0, v ? c.uprightKd : 0);
      raw.jointSetMotorMaxForce(h, ax as never, v ? c.maxTorque : 0);
    }
    raw.jointConfigureMotor(h, LIN_Y as never, 0, 0, v ? c.heightKp : 0, v ? c.heightKd : 0);
    raw.jointSetMotorMaxForce(h, LIN_Y as never, v ? this.maxForce : 0);
  }

  private createJoint(): void {
    const world = this.rd.pw.world;
    const hips = this.rd.body('Hips').rb;
    const p = this.targetPos, q = this.targetRot;
    const anchor = world.createRigidBody(Rapier.RigidBodyDesc.fixed().setTranslation(p[0], p[1], p[2]).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }));
    // 축 잠금 없음(axesMask 0). 관절 좌표계는 양쪽 다 바디 로컬 항등 → 관절 좌표 0 = Hips가 앵커와 같은 회전·높이
    const data = Rapier.JointData.generic({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0 as R.JointAxesMask);
    const j = world.createImpulseJoint(data, anchor, hips, true);
    j.setContactsEnabled(false);
    const raw = world.impulseJoints.raw;
    for (const ax of [...ANG, LIN_Y]) raw.jointConfigureMotorModel(j.handle, ax as never, Rapier.MotorModel.ForceBased as never);
    this.joint = j;
  }

  /** Rapier 스텝 전에 부른다: 사용량 추정만 한다(힘은 관절 모터가 솔버 안에서 건다). */
  apply(): void {
    this.usage = this.force = this.torque = 0;
    if (!this.on) return;
    const rb = this.rd.body('Hips').rb;
    if (!rb.isDynamic()) return;
    const c = this.cfg;
    const q = rb.rotation(), w = rb.angvel(), p = rb.translation(), v = rb.linvel();
    // 앵커 좌표계로 쓴 상대 회전·각속도
    const qT = this.targetRot;
    const rel = multiplyQ(conjugate(qT), [q.x, q.y, q.z, q.w]);
    const cc = quatToCoords(rel);
    const wl = rotate(conjugate(qT), [w.x, w.y, w.z]);
    let tsq = 0;
    for (let i = 0; i < 3; i++) {
      const t = Math.max(-c.maxTorque, Math.min(c.maxTorque, -c.uprightKp * cc[i]! - c.uprightKd * wl[i]!));
      tsq += t * t;
    }
    const f = Math.max(-this.maxForce, Math.min(this.maxForce, c.heightKp * (this.targetPos[1] - p.y) - c.heightKd * v.y));
    this.force = Math.abs(f);
    this.torque = Math.sqrt(tsq);
    this.usage = this.force + this.torque / c.usageLeverArm;
  }
}
