// 시드 부드러운 노이즈 (v0.5c Flail·Writhe): 채널마다 PRNG로 뽑은 주파수·위상의 사인 몇 개를 더해 [-1, 1] 근처 값을 낸다.
// 한 채널 안에서도 주파수가 둘 이상이라 주기가 반복되지 않고, 채널(관절·좌우)마다 주파수가 달라 좌우가 맞춰 움직이지 않는다
// (같은 주파수로 좌우가 맞으면 춤처럼 보인다). 무작위성은 prng.ts만 쓴다.
import type { Prng } from '../../prng';

export class SmoothNoise {
  private readonly ch = new Map<string, { f: number[]; p: number[]; a: number[] }>();
  /** band = [최저, 최고] 주파수 (Hz), parts = 채널당 사인 개수 */
  constructor(private readonly rng: Prng, readonly band: [number, number], readonly parts = 2) {}

  /** 채널 name의 시각 t 값 (대략 [-1, 1]) */
  at(name: string, t: number): number {
    let c = this.ch.get(name);
    if (!c) {
      // 채널마다 독립 하위 스트림 — 채널을 처음 부르는 순서가 바뀌어도 값이 같다
      const r = this.rng.fork(name);
      const f: number[] = [], p: number[] = [], a: number[] = [];
      for (let i = 0; i < this.parts; i++) {
        f.push(r.range(this.band[0], this.band[1]));
        p.push(r.range(0, 2 * Math.PI));
        a.push(i === 0 ? 1 : r.range(0.3, 0.6));
      }
      const s = a.reduce((x, y) => x + y, 0);
      c = { f, p, a: a.map((x) => x / s) };
      this.ch.set(name, c);
    }
    let v = 0;
    for (let i = 0; i < c.f.length; i++) v += c.a[i]! * Math.sin(2 * Math.PI * c.f[i]! * t + c.p[i]!);
    // 사인 합의 진폭이 작아지는 구간이 많아 1.4배 (대략 [-1, 1])
    return Math.max(-1, Math.min(1, 1.4 * v));
  }
}
