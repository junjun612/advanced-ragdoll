// v0.3 전신 동역학 모델·전신 QP: Rapier와 일치(충실도), 역동역학 일관성, KKT 등식·마찰 제약, 결정론.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { WholeBody, generalizedForces, type V6 } from '../src/sim/dynamics/wholeBody';
import { solveWholeBodyQP } from '../src/sim/dynamics/wbqp';
import { luFactor, luSolve } from '../src/sim/math/dense';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { Vec3 } from '../src/sim/math/vec3';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;

async function floating() {
  const rg: RagdollConfig = { ...ragdoll, defaultJointDamping: 0, bodies: {} };
  const w = await World.create({ seed: 1, gravity: [0, 0, 0] });
  const ch = w.addCharacter(character, rg, { position: [0, 2, 0], yaw: 0, state: 'Ragdoll', pose: 'stand' }, { rootAssist: false, balance: false });
  return { w, ch, wb: new WholeBody(ch.rd) };
}

describe('whole-body dynamics model', () => {
  it('43 DOF, symmetric positive-definite mass matrix, A_O = base rows of M', async () => {
    const { w, wb } = await floating();
    expect(wb.n).toBe(43);
    const st = wb.state();
    const { M, A } = wb.massAndMomentum(st);
    for (let i = 0; i < wb.n; i++) for (let j = 0; j < wb.n; j++) expect(M[i * wb.n + j]).toBeCloseTo(M[j * wb.n + i]!, 9);
    expect(luFactor(M, wb.n)).not.toBeNull();
    for (let r = 0; r < 6; r++) for (let j = 0; j < wb.n; j++) expect(A[r * wb.n + j]).toBeCloseTo(M[r * wb.n + j]!, 9);
    w.free();
  });

  it('matches Rapier: joint torques → predicted q̈ = M⁻¹(τ − h) vs next-step finite difference (< 2%)', async () => {
    const { w, ch, wb } = await floating();
    const tq: Record<string, Vec3> = { Spine: [2, 0, 0], LeftUpLeg: [0, 0, 1.5], RightForeArm: [0, 0.5, 0] };
    const st = wb.state();
    const { M } = wb.massAndMomentum(st);
    const tau = new Array<number>(wb.n).fill(0);
    for (const [name, T] of Object.entries(tq)) {
      const b = wb.bodies[wb.byName.get(name)!]!;
      for (let k = 0; k < b.ndof; k++) { const s = st.S[b.dof0 + k]!; tau[b.dof0 + k]! += s[0] * T[0] + s[1] * T[1] + s[2] * T[2]; }
    }
    const h = generalizedForces(wb, st, new Array(wb.n).fill(0), wb.bodies.map(() => [0, 0, 0, 0, 0, 0] as V6));
    const pred = luSolve(luFactor(M, wb.n)!, tau.map((t, i) => t - h[i]!));
    for (const [name, T] of Object.entries(tq)) {
      const j = ch.rd.joints.find((x) => x.name === name)!;
      ch.rd.body(name as never).rb.addTorque({ x: T[0], y: T[1], z: T[2] }, true);
      ch.rd.bodies[j.parent]!.rb.addTorque({ x: -T[0], y: -T[1], z: -T[2] }, true);
    }
    w.physics.stepPhysics();
    const st2 = wb.state();
    for (const i of [0, 3, wb.bodies[wb.byName.get('Spine')!]!.dof0]) {
      const fd = (st2.qd[i]! - st.qd[i]!) / w.dt;
      expect(Math.abs(fd - pred[i]!)).toBeLessThan(0.02 * Math.abs(pred[i]!) + 0.05);
    }
    w.free();
  });

  it('inverse dynamics of the forward-dynamics q̈ gives back the applied generalized forces', async () => {
    const { w, wb } = await floating();
    const st = wb.state();
    const { M } = wb.massAndMomentum(st);
    const tau = new Array<number>(wb.n).fill(0).map((_, i) => (i >= 6 ? Math.sin(i) : 0));
    const zero = wb.bodies.map(() => [0, 0, 0, 0, 0, 0] as V6);
    const h = generalizedForces(wb, st, new Array(wb.n).fill(0), zero);
    const qdd = Array.from(luSolve(luFactor(M, wb.n)!, tau.map((t, i) => t - h[i]!)));
    const back = generalizedForces(wb, st, qdd, zero);
    for (let i = 0; i < wb.n; i++) expect(back[i]).toBeCloseTo(tau[i]!, 6);
    w.free();
  });
});

describe('whole-body QP', () => {
  it('satisfies the momentum and foot equalities (KKT residual), friction pyramid, and is deterministic', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { rootAssist: false });
    ch.playClip('stand');
    for (let i = 0; i < 60; i++) w.step();
    const s = ch.getState();
    expect(s.balance.enabled).toBe(true);
    expect(s.balance.qpResidual).toBeLessThan(1e-6);
    expect(s.balance.wbBaseResidual).toBeLessThan(1e-6);
    for (const c of s.balance.contactForces) expect(Math.hypot(c.f[0], c.f[2])).toBeLessThanOrEqual(0.8 * c.f[1] + 1e-6);
    // 같은 입력 → 같은 해
    const wb = new WholeBody(ch.rd);
    const st = wb.state();
    const mm = wb.massAndMomentum(st);
    const n = wb.n;
    const H = new Float64Array(n * n);
    for (let i = 0; i < n; i++) H[i * n + i] = 1;
    const pts = s.balance.contactForces.map((c, i) => ({ key: `LeftFoot:${i}`, p: c.p, n: [0, 1, 0] as Vec3 }));
    const inp = { n, H, g: new Float64Array(n), A: mm.A, momentumRhs: [0, 0, 0, 0, -736, 0].map((x, r) => x - mm.hBias[r]!), footRows: [], footRhs: [], points: pts, com: s.com, Fdes: [0, 736, 0] as Vec3, kdotDes: [0, 0, 0] as Vec3, mu: 0.8, wLin: 1, wAng: 0.05, regRho: 1e-4, smoothRho: 0, minNormal: 0 };
    const a = solveWholeBodyQP(inp)!, b = solveWholeBodyQP(inp)!;
    expect(a.eqResidual).toBeLessThan(1e-6);
    expect(JSON.stringify(a.qdd)).toBe(JSON.stringify(b.qdd));
    expect(Math.abs(a.achieved[0][1] - 736)).toBeLessThan(5);
    w.free();
  });
});
