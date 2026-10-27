// v0.9 자동 튜닝: CMA-ES 직접 구현 검사 (tools/tune/cmaes.ts)
import { describe, it, expect } from 'vitest';
import { CmaEs, eigenSym } from '../tools/tune/cmaes';
import { applyOverrides, decode, encode, repair, constraintViolation, type TuneParam } from '../tools/tune/space';

const run = (f: (x: number[]) => number, x0: number[], sigma: number, gens: number, seed = 7, lambda?: number) => {
  const es = new CmaEs(x0, sigma, { seed, lambda });
  let best = Infinity;
  for (let g = 0; g < gens; g++) {
    const xs = es.ask();
    const fs = xs.map(f);
    best = Math.min(best, ...fs);
    es.tell(xs, fs);
  }
  return { es, best };
};

describe('CMA-ES', () => {
  it('고유분해: A = V diag(d) Vᵀ, V 직교', () => {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
    const { values, vectors: V } = eigenSym(A);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let r = 0, o = 0;
      for (let k = 0; k < 3; k++) { r += V[i]![k]! * values[k]! * V[j]![k]!; o += V[k]![i]! * V[k]![j]!; }
      expect(r).toBeCloseTo(A[i]![j]!, 9);
      expect(o).toBeCloseTo(i === j ? 1 : 0, 9);
    }
  });

  it('구(sphere) 10차원을 1e-8 아래로', () => {
    const { best, es } = run((x) => x.reduce((a, v) => a + v * v, 0), Array(10).fill(3), 1, 400);
    expect(best).toBeLessThan(1e-8);
    expect(es.s.sigma).toBeLessThan(1e-3);
  });

  it('나쁜 조건의 타원체(조건수 1e6) — 공분산이 축 비율을 배운다', () => {
    const n = 6;
    const f = (x: number[]) => x.reduce((a, v, i) => a + 10 ** ((6 * i) / (n - 1)) * v * v, 0);
    const { best, es } = run(f, Array(n).fill(1), 0.5, 800);
    expect(best).toBeLessThan(1e-8);
    expect(es.condition()).toBeGreaterThan(1e4);
  });

  it('로젠브록 4차원 최소점(1,1,1,1)에 수렴', () => {
    const f = (x: number[]) => x.slice(0, -1).reduce((a, v, i) => a + 100 * (x[i + 1]! - v * v) ** 2 + (1 - v) ** 2, 0);
    const { es, best } = run(f, [0, 0, 0, 0], 0.5, 1500);
    expect(best).toBeLessThan(1e-6);
    for (const m of es.s.mean) expect(m).toBeCloseTo(1, 2);
  });

  it('같은 시드면 같은 표본 (결정론), 다른 시드면 다름', () => {
    const a = new CmaEs([0, 0, 0], 1, { seed: 42 }).ask();
    const b = new CmaEs([0, 0, 0], 1, { seed: 42 }).ask();
    const c = new CmaEs([0, 0, 0], 1, { seed: 43 }).ask();
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('상태 저장 → fromState로 이어 해도 같은 수열 (out/tune 이어 하기)', () => {
    const f = (x: number[]) => x.reduce((s, v) => s + (v - 0.3) ** 2, 0);
    const a = new CmaEs([1, 1, 1, 1], 0.4, { seed: 5 });
    for (let g = 0; g < 3; g++) { const xs = a.ask(); a.tell(xs, xs.map(f)); }
    const b = CmaEs.fromState(JSON.parse(JSON.stringify(a.s)));
    expect(b.ask()).toEqual(a.ask());
  });

  it('잡음 섞인 목적(시드 묶음 통계의 축소판)에서도 평균이 최소점 근처로', () => {
    // 잡음은 prng로 — 같은 x라도 평가마다 다른 값 (시나리오 시드 혼돈 흉내)
    let k = 0;
    const noise = (i: number) => Math.sin(i * 12.9898) * 0.05;
    const f = (x: number[]) => x.reduce((a, v) => a + (v - 0.6) ** 2, 0) + noise(k++);
    const { es } = run(f, [0.1, 0.1, 0.1], 0.3, 200);
    for (const m of es.s.mean) expect(Math.abs(m - 0.6)).toBeLessThan(0.15);
  });
});

describe('탐색 공간 (tools/tune/space.ts)', () => {
  const ps: TuneParam[] = [
    { path: 'reaction.delay', lo: 0.05, hi: 0.15, tier: 'primary' },
    { path: 'stepping.duration.min', lo: 0.15, hi: 0.3, tier: 'primary' },
    { path: 'stepping.maxSteps', lo: 2, hi: 5, tier: 'primary', int: true },
    { path: 'muscles.kpScale', lo: 400, hi: 1600, tier: 'later', log: true },
  ];
  it('정규화 ↔ 실제 값 왕복, 정수·로그 축', () => {
    const v = [0.08, 0.2, 3, 800];
    const u = encode(ps, v);
    expect(decode(ps, u)).toEqual([0.08, 0.2, 3, 800].map((x, i) => (i === 3 ? expect.closeTo(x, 6) : expect.closeTo(x, 9))));
    expect(u[3]).toBeCloseTo(0.5, 9);
    expect(decode(ps, [0, 0, 0.49, 1])[2]).toBe(3);
  });
  it('경계 수선은 [0,1]로 자르고 거리 제곱을 돌려준다', () => {
    const r = repair([-0.2, 0.5, 1.3]);
    expect(r.x).toEqual([0, 0.5, 1]);
    expect(r.dist2).toBeCloseTo(0.04 + 0.09, 12);
  });
  it('설정 덮어쓰기는 원본을 바꾸지 않고 경로가 없으면 에러', () => {
    const cfg = { reaction: { delay: 0.08 }, stepping: { duration: { min: 0.2 } } } as Record<string, unknown>;
    const out = applyOverrides(cfg, { 'reaction.delay': 0.1, 'stepping.duration.min': 0.25 });
    expect((out.reaction as { delay: number }).delay).toBe(0.1);
    expect((cfg.reaction as { delay: number }).delay).toBe(0.08);
    expect(() => applyOverrides(cfg, { 'reaction.nope': 1 })).toThrow();
  });
  it('순서 제약 위반량', () => {
    expect(constraintViolation({ a: 0.1, b: 0.2 }, [{ lt: ['a', 'b'], gap: 0.05 }])).toBeCloseTo(0, 12);
    expect(constraintViolation({ a: 0.18, b: 0.2 }, [{ lt: ['a', 'b'], gap: 0.05 }])).toBeCloseTo(0.03, 12);
  });
});
