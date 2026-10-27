// v0.3 균형 계층: NNLS, 접촉력 QP(마찰 원뿔, 렌치 재현, 결정론), 지연 버퍼, 지지 다각형 중심, v0.3 시나리오 결정론.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sampleDelayed } from '../src/sim/character/balance';
import { distributeContactForces, pyramidEdges, type ContactPoint, type QPConfig } from '../src/sim/character/contactQP';
import { nnlsNormal } from '../src/sim/math/nnls';
import { polygonCentroid } from '../src/sim/character/perception';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { Vec3 } from '../src/sim/math/vec3';

const UP: Vec3 = [0, 1, 0];
// 두 발(각 0.1 × 0.25 m), 발 간격 0.18 m
const feet: ContactPoint[] = [];
for (const [fx, name] of [[0.09, 'L'], [-0.09, 'R']] as const)
  for (const [dx, dz] of [[-0.05, -0.08], [0.05, -0.08], [0.05, 0.17], [-0.05, 0.17]] as const)
    feet.push({ key: `${name}:${feet.length}`, p: [fx + dx, 0, dz], n: UP });
const com: Vec3 = [0, 1, 0.04];
const cfg: QPConfig = { mu: 0.8, weights: [1, 1, 1, 0.05, 0.05, 0.05], regularization: 1e-4, smoothing: 0 };

describe('NNLS (Lawson–Hanson)', () => {
  it('matches the unconstrained solution when it is nonnegative, and clamps otherwise', () => {
    // A = I(2), b = [3, -2] → x = [3, 0]
    const r = nnlsNormal([1, 0, 0, 1], [3, -2], 2);
    expect(r.x[0]).toBeCloseTo(3, 9);
    expect(r.x[1]).toBe(0);
    expect(r.truncated).toBe(false);
    // A = [[1,1],[1,2]] (대칭 G = AᵀA), b = A·[1,2]
    const A = [[1, 1], [1, 2]];
    const xs = [1, 2];
    const b = A.map((row) => row[0]! * xs[0]! + row[1]! * xs[1]!);
    const G = [0, 0, 0, 0], h = [0, 0];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let r2 = 0; r2 < 2; r2++) G[i * 2 + j]! += A[r2]![i]! * A[r2]![j]!;
    for (let i = 0; i < 2; i++) for (let r2 = 0; r2 < 2; r2++) h[i]! += A[r2]![i]! * b[r2]!;
    const s = nnlsNormal(G, h, 2);
    expect(s.x[0]).toBeCloseTo(1, 9);
    expect(s.x[1]).toBeCloseTo(2, 9);
  });
});

describe('contact force QP', () => {
  it('reproduces a feasible wrench (standing weight + small push) and keeps every force in the friction cone', () => {
    const F: Vec3 = [20, 736, -40];
    const M: Vec3 = [5, 0, -3];
    const r = distributeContactForces(feet, com, F, M, cfg);
    expect(r.forceError).toBeLessThan(1);
    expect(r.momentError).toBeLessThan(1);
    for (const c of r.forces) {
      const fn = c.f[1];
      expect(fn).toBeGreaterThanOrEqual(-1e-9); // 단방향 (당기지 않음)
      expect(Math.hypot(c.f[0], c.f[2])).toBeLessThanOrEqual(cfg.mu * fn + 1e-6); // 마찰 원뿔 (피라미드가 내접)
    }
  });

  it('pyramid edges lie inside the cone', () => {
    for (const e of pyramidEdges([0, 1, 0], 0.8)) expect(Math.hypot(e[0], e[2]) / e[1]).toBeCloseTo(0.8, 9);
  });

  it('infeasible moment: force is kept (priority), moment error remains, CoP stays inside the feet', () => {
    // 몸 앞쪽으로 큰 감속 힘 → COM보다 훨씬 앞의 CoP가 필요 (발끝 0.17 넘음)
    const F: Vec3 = [0, 736, -300];
    const r = distributeContactForces(feet, com, F, [0, 0, 0], cfg);
    expect(r.forceError).toBeLessThan(15);
    expect(r.momentError).toBeGreaterThan(10);
    let w = 0, z = 0;
    for (const c of r.forces) { w += c.f[1]; z += c.f[1] * c.p[2]; }
    expect(z / w).toBeLessThanOrEqual(0.17 + 1e-9);
  });

  it('is deterministic and uses the previous solution for smoothing', () => {
    const F: Vec3 = [10, 700, 30];
    const a = distributeContactForces(feet, com, F, [0, 0, 0], { ...cfg, smoothing: 0.01 });
    const b = distributeContactForces(feet, com, F, [0, 0, 0], { ...cfg, smoothing: 0.01 });
    expect(JSON.stringify(b.forces)).toBe(JSON.stringify(a.forces));
    const c = distributeContactForces(feet, com, [10, 700, 60], [0, 0, 0], { ...cfg, smoothing: 1 }, a.beta);
    const d = distributeContactForces(feet, com, [10, 700, 60], [0, 0, 0], { ...cfg, smoothing: 0 });
    // 이전 해 쪽으로 끌려 새 목표(Fz 60)를 덜 따라간다
    expect(Math.abs(c.achieved[0][2] - 30)).toBeLessThan(Math.abs(d.achieved[0][2] - 30));
  });
});

describe('balance helpers', () => {
  it('sampleDelayed interpolates between buffered samples', () => {
    const s = (t: number, x: number) => ({ t, com: [x, 0, 0] as Vec3, vel: [0, 0, 0] as Vec3, rot: [0, 0, 0, 1] as [number, number, number, number], angVel: [0, 0, 0] as Vec3 });
    const buf = [s(0, 0), s(0.1, 1), s(0.2, 3)];
    expect(sampleDelayed(buf, -1).com[0]).toBe(0);
    expect(sampleDelayed(buf, 0.15).com[0]).toBeCloseTo(2, 9);
    expect(sampleDelayed(buf, 0.5).com[0]).toBe(3);
  });

  it('polygonCentroid of a rectangle is its center', () => {
    expect(polygonCentroid([[0, 0], [2, 0], [2, 1], [0, 1]])).toEqual([1, 0.5]);
    expect(polygonCentroid([[0, 0], [2, 0]])).toEqual([1, 0]);
    expect(polygonCentroid([])).toBeNull();
  });

  it('v0.3 scenario with balance is deterministic (byte-identical log)', async () => {
    const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
    const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
    const sc = { ...(JSON.parse(readFileSync('scenarios/0.3/push_front_light.json', 'utf8')) as Scenario), duration: 1.5 };
    const run = () => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });
    const a = await run();
    const b = await run();
    expect(a.log.length).toBeGreaterThan(1000);
    expect(b.log).toBe(a.log);
  }, 60_000);
});
