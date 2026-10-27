// 일어서기 전신 QP (v0.7, docs/ALGORITHMS.md v0.7 '겟업 추종'). v0.3 전신 운동량 QP(wbqp.ts)를 '아무 바디나 바닥에 닿는' 겟업에 쓴다.
// - 접촉: 지금 지면에 닿은 모든 점(손·팔꿈치·무릎·엉덩이·발 …, 인지 contacts)에 마찰 피라미드 힘. 고정 등식은 없다(짚은 곳은 마찰로 버틴다).
// - 과제: ① 전신 COM(선 운동량) — 클립 COM을 '지지 기준'으로 옮긴 목표(지금 실제 접촉점 중심 + (클립 COM − 클립 접촉 중심)),
//          높이는 클립 COM 높이(지면 맞춤). 수평 자리를 클립 앵커가 아니라 실제로 짚은 곳 기준으로 잡아야 COM이 짚은 곳 위로 간다.
//   ② 각운동량 감쇠(낮게) ③ 골반·몸통(Spine2) 방향 PD → 클립 ④ 관절 자세 PD → 클립(관성화 포함) ⑤ 관절 제한 피하기 ⑥ 접촉 바디 미끄럼 감쇠(점 가속도 = −Kv·v).
// - 겟업 보조(Hips 높이·자세 모터)는 외부 렌치로 모델에 넣는다(예측 PD 값). 토크 = 역동역학(RNEA, 접촉력·중력·감쇠·보조 포함).
// - 근육: 모터 목표 = 클립 자세, 모터 kp·kd × motorScale, 토크에서 모터 PD 추정분을 뺀다(v0.3 'pose' 방식), 모터 목표 속도 = 계획 끝 속도.
import type { Ragdoll, RagdollJoint } from './ragdoll';
import type { CharacterDef } from './characterDef';
import type { Perception } from './perception';
import type { ContactPoint } from './contactQP';
import { footContactPoints, type BalanceCommand } from './balance';
import { FOOT_NAMES, type FootName } from './perception';
import type { AnimRef } from './animDriver';
import type { JointName, JointTargets, BodyTransform } from './pose';
import { solveWholeBodyQP } from '../dynamics/wbqp';
import { WholeBody, wrenchAt, ang, lin, add6, type V6 } from '../dynamics/wholeBody';
import { type Vec3, add, sub, scale, cross, dot, length } from '../math/vec3';
import { type Quat, conjugate, identityQ, multiplyQ, rotate, toRotationVector } from '../math/quat';

export interface GetupQPConfig {
  enabled: boolean;
  /** 두 발로만 딛고 있을 때(일어서는 막바지)만 QP, 그 전은 근육 PD + 보조 */
  feetPhaseOnly: boolean;
  com: { kpH: number; kdH: number; kpV: number; kdV: number; maxHAccel: number; supportTau: number };
  wLin: number;
  wAng: number;
  angularDamping: number;
  pelvis: { kp: number; kd: number; weight: number };
  torso: { kp: number; kd: number; weight: number };
  posture: { kp: number; kd: number; weight: number; weights: Partial<Record<string, number>> };
  limitAvoid: { marginDeg: number; kp: number; kd: number; weight: number };
  slip: { kv: number; weight: number };
  regularization: number;
  mu: number;
  regRho: number;
  smoothRho: number;
  /** 바디당 접촉점 최대 개수 */
  maxPointsPerBody: number;
  motorScale: number;
  /** 클립 바디가 '바닥에 닿음'으로 보는 최저점 높이 (m) */
  clipContactHeight: number;
  /** 디딘 발 (실제 접촉 + 클립 지지): 발바닥 꼭짓점(soleContactDist 안, copMargin 안쪽) 접촉 + 발 고정 등식(가속도 = −kv·v) */
  feet: { soleContactDist: number; copMargin: number; kv: number };
}

export interface GetupQPLog {
  comTarget: Vec3;
  comErr: number;
  supportShift: Vec3;
  nPoints: number;
  forceError: number;
  contactForces: { p: Vec3; f: Vec3 }[];
}

const RAD = Math.PI / 180;
const qv = (q: { x: number; y: number; z: number; w: number }): Quat => [q.x, q.y, q.z, q.w];

/** 바디 형상의 최저점 (캡슐 끝, 구, 상자 꼭짓점). 클립 접촉 판정용 */
export function bodyLowest(def: CharacterDef, i: number, tf: BodyTransform): Vec3 {
  const b = def.bodies[i]!;
  let best: Vec3 = tf.pos, by = Infinity;
  const parts = [{ shape: b.shape, position: [0, 0, 0] as Vec3 }, ...(b.extraShapes ?? []).map((e) => ({ shape: e.shape, position: e.position }))];
  for (const pt of parts) {
    const c = add(tf.pos, rotate(tf.rot, pt.position));
    const s = pt.shape;
    const cand: Vec3[] = [];
    if (s.type === 'sphere') cand.push([c[0], c[1] - s.radius, c[2]]);
    else if (s.type === 'capsule') { const ax = rotate(tf.rot, rotate(s.rotation, [0, s.halfHeight, 0])); cand.push([c[0] + ax[0], c[1] + ax[1] - s.radius, c[2] + ax[2]], [c[0] - ax[0], c[1] - ax[1] - s.radius, c[2] - ax[2]]); }
    else for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) cand.push(add(c, rotate(tf.rot, [sx * s.halfExtents[0], sy * s.halfExtents[1], sz * s.halfExtents[2]])));
    for (const p of cand) if (p[1] < by) { by = p[1]; best = p; }
  }
  return best;
}

export class GetupQP {
  readonly wb: WholeBody;
  private readonly joints = new Map<string, RagdollJoint>();
  private prevBeta: Map<string, number[]> | undefined;
  /** 지지 기준 수평 이동 (저역 통과) */
  private shift: Vec3 | null = null;
  log: GetupQPLog | null = null;

  constructor(readonly rd: Ragdoll, readonly def: CharacterDef, public cfg: GetupQPConfig, readonly gravity: Vec3) {
    this.wb = new WholeBody(rd);
    for (const j of rd.joints) this.joints.set(j.name, j);
  }

  reset(): void { this.prevBeta = undefined; this.shift = null; this.log = null; }

  /**
   * 한 스텝. ref = 클립 기준값(관성화 포함), root = 골반 목표(루트 관성화 적용), assist = 겟업 보조 예측 렌치(Hips 질량 중심에 거는 힘·토크).
   * 돌려주는 targets는 모터 목표(클립 자세), cmd는 근육 명령. 실패하면 null
   */
  update(t: number, dt: number, per: Perception, ref: AnimRef, root: BodyTransform, totalMass: number, assist: { f: Vec3; tau: Vec3 } | null): { targets: JointTargets; cmd: BalanceCommand } | null {
    const cfg = this.cfg, rd = this.rd, wb = this.wb;
    const wst = wb.state();
    const mm = wb.massAndMomentum(wst);
    const { com, vel } = rd.com();
    const lMom = lin(mm.momentum);
    const kG = sub(ang(mm.momentum), cross(com, lMom));
    // 접촉점: 바디마다 최대 maxPointsPerBody (가장 낮은 점부터)
    const byBody = new Map<string, { p: Vec3; n: Vec3 }[]>();
    for (const c of per.contacts) { const l = byBody.get(c.body) ?? []; l.push({ p: c.point, n: c.normal }); byBody.set(c.body, l); }
    const points: ContactPoint[] = [];
    const pointBody: number[] = [];
    // 디딘 발: 발바닥 꼭짓점 접촉 + 고정 등식 (v0.3 균형과 같은 방식 — 발이 모서리로만 닿아도 평평히 딛는 것으로 계획한다)
    const planted: FootName[] = FOOT_NAMES.filter((f) => per.feet[f].contact && ref.feet[f].stance);
    for (const f of planted) {
      const bi = wb.byName.get(f)!;
      for (const p of footContactPoints(per, f, cfg.feet.soleContactDist, cfg.feet.copMargin)) { points.push(p); pointBody.push(bi); }
    }
    for (const [body, l] of [...byBody.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const bi = wb.byName.get(body);
      if (bi === undefined || planted.includes(body as FootName)) continue;
      l.sort((a, b) => a.p[1] - b.p[1]).slice(0, cfg.maxPointsPerBody).forEach((c, k) => { points.push({ key: `${body}:${k}`, p: c.p, n: c.n }); pointBody.push(bi); });
    }
    if (!points.length) return null;
    // COM 목표: 클립 COM을 지지 기준으로 옮긴다. 클립에서 바닥에 닿은 바디(최저점 < clipContactHeight)와 실제로 닿은 바디의 공통 집합 중심을 맞춘다
    const gy = per.groundHeight ?? 0;
    const clipLow = ref.bodies.map((b, i) => bodyLowest(this.def, i, b));
    const both = [...byBody.keys()].map((n) => wb.byName.get(n)).filter((i): i is number => i !== undefined && clipLow[i]![1] - gy < cfg.clipContactHeight);
    let target: Vec3 | null = null;
    if (both.length) {
      let a: Vec3 = [0, 0, 0], c: Vec3 = [0, 0, 0];
      // 바디 원점끼리 맞춘다 (실제 접촉점과 클립 최저점은 같은 점이 아닐 수 있다)
      for (const i of both) {
        const tr = rd.bodies[i]!.rb.translation();
        a = add(a, [tr.x, tr.y, tr.z]);
        c = add(c, ref.bodies[i]!.pos);
      }
      target = scale(sub(a, c), 1 / both.length);
      target = [target[0], 0, target[2]];
    }
    if (!this.shift) this.shift = target ?? [0, 0, 0];
    else if (target) {
      const k = 1 - Math.exp(-dt / cfg.com.supportTau);
      this.shift = add(this.shift, scale(sub(target, this.shift), k));
    }
    const cT: Vec3 = add(ref.com, this.shift);
    const eC = sub(cT, com), eV = sub(ref.comVel, vel);
    let aH: Vec3 = [ref.comAcc[0] + cfg.com.kpH * eC[0] + cfg.com.kdH * eV[0], 0, ref.comAcc[2] + cfg.com.kpH * eC[2] + cfg.com.kdH * eV[2]];
    const ah = Math.hypot(aH[0], aH[2]);
    if (ah > cfg.com.maxHAccel) aH = scale(aH, cfg.com.maxHAccel / ah);
    const aV = ref.comAcc[1] + cfg.com.kpV * eC[1] + cfg.com.kdV * eV[1];
    const Fdes: Vec3 = sub(scale([aH[0], aV, aH[2]], totalMass), scale(this.gravity, totalMass));
    // 보조 렌치는 운동량 등식 우변(외부)에 들어가므로 원하는 접촉 합력에서 뺀다
    const FdesC = assist ? sub(Fdes, assist.f) : Fdes;
    const kdotDes = scale(kG, -cfg.angularDamping);

    const n = wb.n;
    const H = new Float64Array(n * n), gvec = new Float64Array(n);
    const addRow = (row: Float64Array, tgt: number, w: number) => {
      for (let i = 0; i < n; i++) {
        const ri = row[i]!;
        if (ri === 0) continue;
        gvec[i]! += w * ri * tgt;
        for (let j = 0; j < n; j++) if (row[j] !== 0) H[i * n + j]! += w * ri * row[j]!;
      }
    };
    for (let i = 0; i < n; i++) H[i * n + i]! += cfg.regularization;
    // 골반 방향 (기저 각가속도)
    {
      const rb = rd.body('Hips').rb, hq = qv(rb.rotation()), hw = rb.angvel();
      let qd = multiplyQ(root.rot, conjugate(hq));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const e = toRotationVector(qd);
      const wRef = ref.bodyAng[0]!;
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        row[r] = 1;
        addRow(row, cfg.pelvis.kp * e[r]! + cfg.pelvis.kd * (wRef[r]! - [hw.x, hw.y, hw.z][r]!), cfg.pelvis.weight);
      }
    }
    // 몸통 방향 (Spine2 각가속도 → 클립 Spine2)
    {
      const si = wb.byName.get('Spine2')!;
      const sj = wb.jacobian(wst, si);
      const rb = rd.bodies[si]!.rb, sq = qv(rb.rotation()), sw = rb.angvel();
      let qd = multiplyQ(ref.bodies[si]!.rot, conjugate(sq));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const e = toRotationVector(qd);
      const wRef = ref.bodyAng[si]!;
      for (let r = 0; r < 3; r++) {
        const row = new Float64Array(n);
        sj.dofs.forEach((d, k) => { row[d] = sj.cols[k]![r]!; });
        addRow(row, cfg.torso.kp * e[r]! + cfg.torso.kd * (wRef[r]! - [sw.x, sw.y, sw.z][r]!) - sj.a0[r]!, cfg.torso.weight);
      }
    }
    // 관절 자세 PD (기준 속도 포함)
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      const w = cfg.posture.weights[name] ?? cfg.posture.weight;
      if (w <= 0) continue;
      const j = this.joints.get(name)!;
      const qp = qv(rd.bodies[b.parent]!.rb.rotation()), qc = qv(rd.bodies[b.idx]!.rb.rotation());
      const rT = ref.joints[name] ?? identityQ();
      const qDes = multiplyQ(multiplyQ(qp, j.def.frameInParent), multiplyQ(rT, conjugate(j.def.frameInChild)));
      let qd = multiplyQ(qDes, conjugate(qc));
      if (qd[3] < 0) qd = [-qd[0], -qd[1], -qd[2], -qd[3]];
      const e = toRotationVector(qd);
      // 기준 상대 각속도 (부모 쪽 관절 좌표계 → 월드)
      const jv = ref.jointVel[name] ?? [0, 0, 0];
      const wRefW = rotate(multiplyQ(qp, j.def.frameInParent), jv);
      for (let k = 0; k < b.ndof; k++) {
        const d = b.dof0 + k;
        const axisW = ang(wst.S[d]!);
        const row = new Float64Array(n);
        row[d] = 1;
        addRow(row, cfg.posture.kp * dot(e, axisW) + cfg.posture.kd * (dot(wRefW, axisW) - wst.qd[d]!), w);
      }
    }
    // 관절 제한 피하기 (v0.4 balance와 같음)
    {
      const la = cfg.limitAvoid, m = la.marginDeg * RAD;
      for (const b of wb.bodies) {
        if (b.type === 'free') continue;
        const j = this.joints.get(rd.bodies[b.idx]!.name)!;
        const x3 = rd.coords(j);
        const frame = multiplyQ(qv(rd.bodies[j.parent]!.rb.rotation()), j.frameP);
        for (let k = 0; k < (b.type === 'hinge' ? 1 : 3); k++) {
          const lim = j.limits[k];
          if (!lim || lim[0] === lim[1]) continue;
          const mk = Math.min(m, (lim[1] - lim[0]) / 4);
          const x = x3[k]!;
          const axisW = b.type === 'hinge' ? null : rotate(frame, k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1]);
          const row = new Float64Array(n);
          let rate = 0;
          if (axisW) for (let i = 0; i < 3; i++) { row[b.dof0 + i] = axisW[i]!; rate += axisW[i]! * wst.qd[b.dof0 + i]!; }
          else { row[b.dof0] = 1; rate = wst.qd[b.dof0]!; }
          let tg: number | null = null;
          if (x < lim[0] + mk) tg = la.kp * (lim[0] + mk - x) - la.kd * Math.min(0, rate);
          else if (x > lim[1] - mk) tg = la.kp * (lim[1] - mk - x) - la.kd * Math.max(0, rate);
          if (tg !== null) addRow(row, tg, la.weight);
        }
      }
    }
    // 접촉 미끄럼 감쇠: 닿은 점의 수평 가속도 = −Kv·v (부드러운 과제)
    if (cfg.slip.weight > 0) {
      points.forEach((pt, k) => {
        const fj = wb.jacobian(wst, pointBody[k]!);
        const om = ang(fj.v);
        const vP = add(lin(fj.v), cross(om, pt.p));
        const aB = add(add(lin(fj.a0), cross(ang(fj.a0), pt.p)), cross(om, vP));
        for (const r of [0, 2]) {
          const row = new Float64Array(n);
          fj.dofs.forEach((d, i) => { const col = fj.cols[i]!; row[d] = lin(col)[r]! + cross(ang(col), pt.p)[r]!; });
          addRow(row, -cfg.slip.kv * vP[r]! - aB[r]!, cfg.slip.weight);
        }
      });
    }
    // 외부 렌치: 중력 + 바디 각감쇠 + 겟업 보조(예측)
    let Wg: V6 = [0, 0, 0, 0, 0, 0];
    const extW: V6[] = wb.bodies.map((b) => {
      const bs = wst.bodies[b.idx]!;
      let w6 = wrenchAt(bs.c, scale(this.gravity, bs.m));
      const d = rd.bodies[b.idx]!.rb.angularDamping();
      if (d > 0) {
        const de = d / (1 + dt * d), om = ang(bs.v), I = bs.Ic;
        w6 = add6(w6, [-(I[0]! * om[0] + I[1]! * om[1] + I[2]! * om[2]) * de, -(I[3]! * om[0] + I[4]! * om[1] + I[5]! * om[2]) * de, -(I[6]! * om[0] + I[7]! * om[1] + I[8]! * om[2]) * de, 0, 0, 0]);
      }
      if (assist && b.idx === 0) w6 = add6(add6(w6, wrenchAt(bs.c, assist.f)), [assist.tau[0], assist.tau[1], assist.tau[2], 0, 0, 0]);
      return w6;
    });
    for (const w6 of extW) Wg = add6(Wg, w6);
    const footRows: Float64Array[] = [], footRhs: number[] = [];
    for (const f of planted) {
      const fj = wb.jacobian(wst, wb.byName.get(f)!);
      for (let r = 0; r < 6; r++) {
        const row = new Float64Array(n);
        fj.dofs.forEach((dd, k) => { row[dd] = fj.cols[k]![r]!; });
        footRows.push(row);
        footRhs.push(-fj.a0[r]! - cfg.feet.kv * fj.v[r]!);
      }
    }
    const res = solveWholeBodyQP({
      n, H, g: gvec, A: mm.A, momentumRhs: Wg.map((x, r) => x - mm.hBias[r]!), footRows, footRhs, points, com, Fdes: FdesC, kdotDes,
      mu: cfg.mu, wLin: cfg.wLin, wAng: cfg.wAng, regRho: cfg.regRho, smoothRho: cfg.smoothRho, minNormal: 0, prevBeta: this.prevBeta,
    });
    if (!res) return null;
    this.prevBeta = res.beta;
    const fext: V6[] = extW.map((w6) => [...w6] as V6);
    res.forces.forEach((c, k) => { fext[pointBody[k]!] = add6(fext[pointBody[k]!]!, wrenchAt(c.p, c.f)); });
    const id = wb.inverseDynamics(wst, res.qdd, fext);
    const cmd: BalanceCommand = { torque: {}, gcScale: {}, motorScale: cfg.motorScale, subtractMotor: true, jointVel: {} };
    for (const b of wb.bodies) {
      if (b.type === 'free') continue;
      const name = rd.bodies[b.idx]!.name as JointName;
      cmd.torque[name] = id.torque[b.idx]!;
      cmd.gcScale[name] = 0;
      if (b.type === 'sph') cmd.jointVel![name] = [0, 1, 2].map((k) => wst.qd[b.dof0 + k]! + res.qdd[b.dof0 + k]! * dt) as Vec3;
      else cmd.jointVel![name] = scale(ang(wst.S[b.dof0]!), wst.qd[b.dof0]! + res.qdd[b.dof0]! * dt);
    }
    this.log = { comTarget: cT, comErr: length(eC), supportShift: this.shift, nPoints: points.length, forceError: length(sub(res.achieved[0], FdesC)), contactForces: res.forces.map((c) => ({ p: c.p, f: c.f })) };
    return { targets: ref.joints, cmd };
  }
}
