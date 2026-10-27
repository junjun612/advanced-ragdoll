import { describe, it, expect } from 'vitest';
import { Prng } from '../src/sim/prng';

const draw = (p: Prng, n: number) => Array.from({ length: n }, () => p.nextUint32());

describe('prng', () => {
  it('same seed -> identical sequence; different seed -> different', () => {
    expect(draw(new Prng(42), 1000)).toEqual(draw(new Prng(42), 1000));
    expect(draw(new Prng(42), 10)).not.toEqual(draw(new Prng(43), 10));
  });
  it('outputs are uint32', () => {
    expect(draw(new Prng(1), 100).every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32)).toBe(true);
  });
  it('float/range/int/normal stay in range with sane statistics', () => {
    const p = new Prng(7);
    let sum = 0, sumSq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const f = p.float();
      expect(f >= 0 && f < 1).toBe(true);
      const r = p.range(-3, 5);
      expect(r >= -3 && r < 5).toBe(true);
      expect([2, 3, 4]).toContain(p.int(2, 4));
      const g = p.normal(1, 2);
      sum += g; sumSq += g * g;
    }
    const mean = sum / n, sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean - 1)).toBeLessThan(0.05);
    expect(Math.abs(sd - 2)).toBeLessThan(0.05);
  });
  it('fork depends only on seed + label, not on parent consumption', () => {
    const a = new Prng(99), b = new Prng(99);
    draw(b, 17);
    expect(draw(a.fork('hits'), 20)).toEqual(draw(b.fork('hits'), 20));
    expect(draw(a.fork('hits'), 5)).not.toEqual(draw(a.fork('fuzz'), 5));
    expect(draw(a.fork(1), 5)).not.toEqual(draw(a.fork('1'), 5));
    expect(draw(a.fork('hits'), 5)).not.toEqual(draw(new Prng(99), 5));
  });
  it('clone continues the same sequence', () => {
    const p = new Prng(5);
    draw(p, 9);
    const c = p.clone();
    expect(draw(c, 10)).toEqual(draw(p, 10));
  });
});
