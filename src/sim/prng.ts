// 시드가 있는 의사난수 생성기. 프로젝트의 유일한 무작위성 출처다 (Math.random 금지).
// 알고리즘: sfc32 (32비트 정수 연산만 써서 Node·브라우저 결과가 같다). 시드 확장은 splitmix32.

/** 문자열·숫자 라벨을 32비트 해시로 (FNV-1a). */
function hashLabel(label: string | number): number {
  const s = typeof label === 'number' ? `#${label}` : label;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) | 0;
  let z = state.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export class Prng {
  /** 생성 시 시드 (fork의 기준). */
  readonly seed: number;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const st = { s: this.seed };
    this.a = splitmix32(st);
    this.b = splitmix32(st);
    this.c = splitmix32(st);
    this.d = splitmix32(st) || 1;
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** 32비트 부호 없는 정수. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** [0, 1) 균등 분포. */
  float(): number {
    return this.nextUint32() / 4294967296;
  }

  /** [lo, hi) 균등 분포. */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** [lo, hi] 정수 균등 분포. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** 정규 분포 (Box-Muller). 호출마다 난수 2개를 쓰고 두 번째 값은 버린다 (상태 단순화). */
  normal(mean = 0, sd = 1): number {
    const u1 = 1 - this.float(); // (0, 1]
    const u2 = this.float();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * 하위 스트림. 부모 시드와 라벨만으로 정해지고 부모가 지금까지 난수를 얼마나 썼는지와 무관하다.
   * 그래서 시스템마다(예: "fuzz", "hit:3") 독립 스트림을 써도 호출 순서가 바뀌어 결과가 흔들리지 않는다.
   */
  fork(label: string | number): Prng {
    return new Prng((Math.imul(this.seed ^ 0x5bd1e995, 0x2c1b3c6d) ^ hashLabel(label)) >>> 0);
  }

  /** 현재 상태 복사 (같은 수열을 이어서 낸다). */
  clone(): Prng {
    const p = new Prng(this.seed);
    p.a = this.a; p.b = this.b; p.c = this.c; p.d = this.d;
    return p;
  }
}
