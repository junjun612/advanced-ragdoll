// 근육 계층 (SPEC 7.1의 7단계, v0.2). v0.0 결론 B: Rapier 관절 모터(ForceBased, raw 축별 위치 목표) + 중력 보상 피드포워드.
// - 모터: stiffness = s·kp, damping = s·kd + 수동 마찰, maxForce = s·maxTorque + 수동 마찰 × passiveVelCap (축별 상자 클램프)
// - 중력 보상: τ_gc = s·gc·(c_sub − p_j) × (−M_sub·g), |τ_gc| ≤ s·maxTorque. 자식 +τ, 부모 −τ (addTorque는 남으므로 매 스텝 reset)
// - 로그의 torque·saturated는 실제 모터 토크가 아니라 PD 식 추정값이다 (모터 출력은 읽을 수 없음, docs/SPIKE-rapier.md).
// - strength s: 관절별 0~1. 명령값(영역 배율 × 피로 상한, Ragdoll 상태면 0)을 1차 저역 통과(activationTime)로 따라간다.
// 정의 전체: docs/ALGORITHMS.md v0.2.
import { R } from '../world';
import type { Ragdoll, RagdollJoint } from './ragdoll';
import type { CharacterDef } from './characterDef';
import type { JointName, JointTargets } from './pose';
import type { BalanceCommand } from './balance';
import { type Vec3, add, cross, length, scale, sub } from '../math/vec3';
import { type Quat, conjugate, identityQ, multiplyQ, rotate, angleBetweenQ } from '../math/quat';

export interface MuscleJointConfig {
  kpRatio: number;
  maxTorque: number;
  gravityComp: number;
  /** 주면 2·zeta·sqrt(kp·I) 대신 이 값 */
  kd?: number;
}

export interface MuscleConfig {
  kpScale: number;
  zeta: number;
  joints: Record<JointName, MuscleJointConfig>;
  activationTime: number;
  passiveVelCap: number;
  regions: Record<string, JointName[]>;
  fatigue: { enabled: boolean; drainPerSecAtMax: number; recoverPerSec: number; minCap: number };
}

/** 관절별 근육 출력 (로그 joints[]) */
export interface MuscleJointOut {
  errorDeg: number;
  /** 추정 토크 크기 (N·m): 축별 클램프한 PD + 중력 보상 */
  torque: number;
  saturated: boolean;
  strength: number;
  /** 목표의 Rapier 관절 좌표 (rad) */
  targetCoords: Vec3;
}

/** 중력 보상 토크 τ = (c − p) × (−M·g). g는 중력 가속도 벡터(예: [0, −9.81, 0]). */
export function gravityCompTorque(subCom: Readonly<Vec3>, subMass: number, jointPos: Readonly<Vec3>, gravity: Readonly<Vec3>): Vec3 {
  return cross(sub(subCom, jointPos), scale(gravity, -subMass));
}

/** 1차 저역 통과 한 스텝의 계수 α (x += α·(목표 − x)). tau ≤ 0이면 즉시(1). */
export const lowPassAlpha = (dt: number, tau: number): number => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);

/** 영역 이름(또는 관절 이름) → 관절 목록 */
export function resolveRegion(regions: Readonly<Record<string, readonly JointName[]>>, region: string, jointNames: readonly string[]): JointName[] {
  const r = regions[region];
  if (r) return [...r];
  if (jointNames.includes(region)) return [region as JointName];
  throw new Error(`unknown muscle region '${region}' (known: ${Object.keys(regions).join(', ')})`);
}

/** 관절 좌표계 사원수 → Rapier 관절 좌표 (2·asin 성분, w ≥ 0) */
export function quatToCoords(r: Readonly<Quat>): Vec3 {
  const q = r[3] < 0 ? [-r[0], -r[1], -r[2]] : [r[0], r[1], r[2]];
  const a = (s: number) => 2 * Math.asin(Math.max(-1, Math.min(1, s)));
  return [a(q[0]!), a(q[1]!), a(q[2]!)];
}

/** rest 자세에서 관절점 기준 서브트리 관성의 trace/3 (kg·m²). trace는 회전에 불변이라 바디 주관성 합 + 평행축 항 2m|r|²로 구한다. */
export function subtreeInertiaAtRest(def: CharacterDef, rd: Ragdoll, j: RagdollJoint): number {
  const parent = def.bodies[j.parent]!;
  const anchor = add(parent.restPosition, rotate(parent.restRotation, j.def.anchorInParent));
  let tr = 0;
  for (const i of rd.subtree(j.child)) {
    const b = rd.bodies[i]!, bd = def.bodies[i]!;
    const I = b.rb.principalInertia(), m = b.rb.mass();
    const lc = b.rb.localCom();
    const c = add(bd.restPosition, rotate(bd.restRotation, [lc.x, lc.y, lc.z]));
    const r = sub(c, anchor);
    tr += I.x + I.y + I.z + 2 * m * (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  }
  return tr / 3;
}

interface MJ {
  j: RagdollJoint;
  name: JointName;
  hinge: boolean;
  kp: number;
  kd: number;
  maxTorque: number;
  gc: number;
  /** rest 서브트리 관성 trace/3 (kd 자동 계산용) */
  inertia: number;
  passive: number;
  /** 정의 관절 좌표계 → Rapier 관절 좌표계 (어깨는 콘 축으로 돌린 frameP): r_rapier = conv · r_def */
  conv: Quat;
  /** 명령 배율과 회복 램프 */
  cmd: number;
  recover: { from: number; t0: number; dur: number } | null;
  /** 피로 상한 (v0.5) */
  cap: number;
  /** 힘 상한 배율 (행동 계층, v0.5a) */
  capMul: number;
  /** 저역 통과한 strength */
  s: number;
  out: MuscleJointOut;
}

const AXES = [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ];

export class Muscles {
  readonly joints: MJ[] = [];
  private readonly byName = new Map<string, MJ>();
  private motorsOn = false;
  /** 직전 스텝 Σ|τ|² (energy 지표용, N²·m²) */
  torqueSq = 0;

  constructor(
    readonly rd: Ragdoll,
    public cfg: MuscleConfig,
    passiveDamping: (j: RagdollJoint) => number,
    readonly gravity: Vec3,
    active: boolean,
  ) {
    for (const j of rd.joints) {
      const jc = cfg.joints[j.name];
      if (!jc) throw new Error(`muscles.json: no entry for joint ${j.name}`);
      const kp = cfg.kpScale * jc.kpRatio;
      const I = subtreeInertiaAtRest(rd.def, rd, j);
      const mj: MJ = {
        j,
        name: j.name,
        hinge: j.def.type === 'hinge',
        kp,
        kd: jc.kd ?? 2 * cfg.zeta * Math.sqrt(kp * I),
        maxTorque: jc.maxTorque,
        gc: jc.gravityComp,
        inertia: I,
        passive: passiveDamping(j),
        conv: multiplyQ(conjugate(j.frameP), j.def.frameInParent),
        cmd: 1,
        recover: null,
        cap: 1,
        capMul: 1,
        s: active ? 1 : 0,
        out: { errorDeg: 0, torque: 0, saturated: false, strength: active ? 1 : 0, targetCoords: [0, 0, 0] },
      };
      this.joints.push(mj);
      this.byName.set(j.name, mj);
    }
  }

  /** 관절별 kp·kd·maxTorque (meta 기록용) */
  gains(): { joint: JointName; kp: number; kd: number; maxTorque: number }[] {
    return this.joints.map((m) => ({ joint: m.name, kp: m.kp, kd: m.kd, maxTorque: m.maxTorque }));
  }

  /**
   * 설정을 런타임에 바꾼다 (튜닝 UI). 생성자와 같은 식으로 kp·kd·maxTorque·중력 보상 배율을 다시 계산하고,
   * 다음 apply부터 모터에 반영된다. strength·영역 배율·피로 상태는 그대로 둔다.
   */
  reconfigure(cfg: MuscleConfig): void {
    for (const m of this.joints) {
      const jc = cfg.joints[m.name];
      if (!jc) throw new Error(`muscles config: no entry for joint ${m.name}`);
      m.kp = cfg.kpScale * jc.kpRatio;
      m.kd = jc.kd ?? 2 * cfg.zeta * Math.sqrt(m.kp * m.inertia);
      m.maxTorque = jc.maxTorque;
      m.gc = jc.gravityComp;
    }
    this.cfg = cfg;
  }

  out(name: JointName): MuscleJointOut {
    return this.byName.get(name)!.out;
  }

  /** 영역 배율 설정 (SPEC 7.2). recoverTime을 주면 그 시간 동안 1로 선형 회복한다. */
  setScale(region: string, scaleV: number, t: number, recoverTime?: number): JointName[] {
    const names = resolveRegion(this.cfg.regions, region, this.joints.map((m) => m.name));
    const s = Math.max(0, Math.min(1, scaleV));
    for (const n of names) {
      const m = this.byName.get(n)!;
      m.cmd = s;
      m.recover = recoverTime && recoverTime > 0 ? { from: s, t0: t, dur: recoverTime } : null;
    }
    return names;
  }

  /** 관절의 지금 명령 배율 (setScale·회복 반영, 행동 강도 배율 제외) */
  commandedScale(name: JointName, t: number): number { return this.commanded(this.byName.get(name)!, t); }

  private commanded(m: MJ, t: number): number {
    if (!m.recover) return m.cmd;
    const k = (t - m.recover.t0) / m.recover.dur;
    if (k >= 1) {
      m.recover = null;
      m.cmd = 1;
      return 1;
    }
    return m.recover.from + (1 - m.recover.from) * Math.max(0, k);
  }

  /**
   * 매 스텝 Rapier 스텝 직전에 부른다. 토크·힘은 다음 스텝까지 남으므로(v0.0) 먼저 지운다.
   * active = 근육을 쓰는 상태(Ragdoll이 아님). targets = 정의 관절 좌표계 목표(없는 관절은 rest).
   * bal = 균형 계층 명령 (v0.3): 관절 토크 쌍(× strength)을 중력 보상과 합쳐 같은 경로로 걸고, 지지 다리의 서브트리 중력 보상 배율을 바꾼다.
   */
  apply(dt: number, t: number, active: boolean, targets: JointTargets | null, bal: BalanceCommand | null = null, strengthMul: Partial<Record<JointName, number>> | null = null, capacityMul: Partial<Record<JointName, number>> | null = null): void {
    this.rd.resetTorques();
    // (README 결정 171) 어깨 가동 범위 끝 저항 — 근육 상태와 무관한 관절의 수동 성질
    this.rd.applyShoulderRom();
    const alpha = lowPassAlpha(dt, this.cfg.activationTime);
    let any = false;
    for (const m of this.joints) {
      // 행동 계층의 강도 배율 (v0.5a: HitReaction 힘 빠짐, InjuredLeg 상한)
      const goal = active ? Math.max(0, Math.min(1, this.commanded(m, t) * m.cap * (strengthMul?.[m.name] ?? 1))) : 0;
      m.s += (goal - m.s) * alpha;
      if (Math.abs(goal - m.s) < 1e-6) m.s = goal;
      // 힘 상한 배율 (v0.5a InjuredLeg): 최대 토크만 줄인다(명령 토크는 상한까지 그대로). 로그 strength = s × 상한 배율
      m.capMul = Math.max(0, Math.min(1, capacityMul?.[m.name] ?? 1));
      m.out.strength = m.s * m.capMul;
      if (m.s > 0) any = true;
    }
    if (!this.motorsOn && !any) return; // 한 번도 켜지지 않았으면 v0.1과 같은 수동 관절 그대로
    const raw = this.rd.pw.world.impulseJoints.raw;
    if (!this.motorsOn) {
      for (const m of this.joints)
        for (let i = 0; i < (m.hinge ? 1 : 3); i++) raw.jointConfigureMotorModel(m.j.imp.handle, AXES[i] as never, R.MotorModel.ForceBased as never);
      this.motorsOn = true;
    }

    // 서브트리 질량·질량 중심 (자식이 부모 뒤에 온다 → 역순 누적)
    const n = this.rd.bodies.length;
    const mass = new Array<number>(n), mc = new Array<Vec3>(n);
    for (let i = 0; i < n; i++) {
      const rb = this.rd.bodies[i]!.rb;
      const bm = this.rd.massOf(i), c = rb.worldCom();
      mass[i] = bm;
      mc[i] = [c.x * bm, c.y * bm, c.z * bm];
    }
    for (let i = n - 1; i > 0; i--) {
      const p = this.rd.bodies[i]!.parentIdx;
      mass[p]! += mass[i]!;
      mc[p] = add(mc[p]!, mc[i]!);
    }

    let tsq = 0;
    const ms = bal?.motorScale ?? 1;
    for (const m of this.joints) {
      const j = m.j, s = m.s;
      const pb = this.rd.bodies[j.parent]!.rb, cb = this.rd.bodies[j.child]!.rb;
      const qpR = pb.rotation(), qcR = cb.rotation();
      const qp: Quat = [qpR.x, qpR.y, qpR.z, qpR.w], qc: Quat = [qcR.x, qcR.y, qcR.z, qcR.w];
      // 목표 (Rapier 관절 좌표)
      const rTgt = multiplyQ(m.conv, targets?.[m.name] ?? identityQ());
      let tc = quatToCoords(rTgt);
      m.out.targetCoords = tc;
      // 모터
      const h = j.imp.handle;
      const nAx = m.hinge ? 1 : 3;
      const maxF = s * m.capMul * m.maxTorque + m.passive * this.cfg.passiveVelCap;
      const frame = multiplyQ(qp, j.frameP);
      // 목표 속도 (v0.4): 균형 계층이 계획한 이번 스텝 끝 상대 각속도(관절 좌표 축). 없으면 0 (v0.3까지)
      const msJ = bal?.motorScaleJ?.[m.name] ?? ms;
      const jv = bal?.jointVel?.[m.name];
      const vt: Vec3 = jv ? rotate(conjugate(frame), jv) : [0, 0, 0];
      // 'plan' (v0.4, 결정 55): 모터 목표 = QP 계획의 이번 스텝 끝 상태 → 계획대로면 모터 힘 ≈ 0, 벗어나면 암시적 PD로 되돌림(근육 임피던스)
      const planJ = !!bal?.motorPlan?.[m.name];
      const cc0 = planJ && jv ? quatToCoords(multiplyQ(conjugate(frame), multiplyQ(qc, j.frameC))) : null;
      if (cc0) {
        const ap0 = pb.angvel(), ac0 = cb.angvel();
        const w0 = rotate(conjugate(frame), [ac0.x - ap0.x, ac0.y - ap0.y, ac0.z - ap0.z]);
        tc = [0, 1, 2].map((i) => cc0[i]! + 0.5 * (w0[i]! + vt[i]!) * dt) as Vec3;
      }
      for (let i = 0; i < nAx; i++) {
        raw.jointConfigureMotor(h, AXES[i] as never, tc[i]!, vt[i]!, s * m.kp * msJ, s * m.kd * msJ + m.passive);
        raw.jointSetMotorMaxForce(h, AXES[i] as never, maxF);
      }
      // 추정 토크 (PD 식, 축별 클램프)
      const rCur = multiplyQ(conjugate(frame), multiplyQ(qc, j.frameC));
      const cc = quatToCoords(rCur);
      m.out.errorDeg = (angleBetweenQ(rTgt, rCur) * 180) / Math.PI;
      const ap = pb.angvel(), ac = cb.angvel();
      const w = rotate(conjugate(frame), [ac.x - ap.x, ac.y - ap.y, ac.z - ap.z]);
      const lim = s * m.capMul * m.maxTorque;
      let sat = false;
      const tj: Vec3 = [0, 0, 0];
      for (let i = 0; i < nAx; i++) {
        let v = s * msJ * (m.kp * (tc[i]! - cc[i]!) + m.kd * (vt[i]! - w[i]!));
        if (Math.abs(v) > lim) { v = Math.sign(v) * lim; sat = true; }
        tj[i] = v;
      }
      // 중력 보상 (+ 균형 토크): 둘을 더해 |τ| ≤ s·maxTorque로 자르고 자식 +τ, 부모 −τ
      let tgc: Vec3 = [0, 0, 0];
      const gc = m.gc * (bal?.gcScale[m.name] ?? 1);
      if (gc !== 0 && s > 0) {
        const ci = j.child;
        const subCom = scale(mc[ci]!, 1 / mass[ci]!);
        const ct = cb.translation();
        const pj = add([ct.x, ct.y, ct.z], rotate(qc, j.def.anchorInChild));
        tgc = scale(gravityCompTorque(subCom, mass[ci]!, pj, this.gravity), s * gc);
      }
      let tb = bal?.torque[m.name];
      if (tb && s > 0) {
        // 경첩은 잠긴 축 성분이 관절 구속에 흡수되므로 flex 축 성분만 남긴다 (상한을 헛되이 쓰지 않게)
        if (m.hinge) {
          const ax = rotate(frame, [1, 0, 0]);
          tb = scale(ax, tb[0] * ax[0] + tb[1] * ax[1] + tb[2] * ax[2]);
        }
        tgc = add(tgc, scale(tb, s));
        // 전신 제어 토크는 "모터 + 추가 토크 = 역동역학 토크"가 되도록 모터 PD 추정분을 뺄 수 있다 (모델과 실제를 맞춤)
        if (bal?.subtractMotor && !planJ) tgc = add(tgc, scale(rotate(frame, tj), -(1 - (bal.looseJ?.[m.name] ?? 0))));
      }
      if (s > 0 && (tgc[0] !== 0 || tgc[1] !== 0 || tgc[2] !== 0)) {
        const mag = length(tgc);
        if (mag > lim) { tgc = scale(tgc, lim / mag); sat = true; }
        cb.addTorque({ x: tgc[0], y: tgc[1], z: tgc[2] }, true);
        pb.addTorque({ x: -tgc[0], y: -tgc[1], z: -tgc[2] }, true);
      }
      const tau = length(add(rotate(frame, tj), tgc));
      m.out.torque = tau;
      m.out.saturated = s > 0 && sat;
      tsq += tau * tau;
      // 피로 (v0.5에서 켠다): 상한을 토크 사용률에 따라 내리고 쉬면 올린다
      const f = this.cfg.fatigue;
      if (f.enabled && m.maxTorque > 0) {
        const u = Math.min(1, tau / m.maxTorque);
        m.cap = Math.max(f.minCap, Math.min(1, m.cap + (f.recoverPerSec * (1 - u) - f.drainPerSecAtMax * u) * dt));
      }
    }
    this.torqueSq = tsq;
  }
}
