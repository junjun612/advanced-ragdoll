// CMA-ES (μ/μ_w, λ) — 외부 의존 없는 직접 구현 (SPEC 12장 v0.9 자동 튜닝, README 결정 9t-1).
// 식은 Hansen, "The CMA Evolution Strategy: A Tutorial" (arXiv:1604.00772) 표 1 기본값을 그대로 쓴다.
// 표본은 prng.ts(Prng.normal)만 쓴다 — 같은 시드면 같은 수열(결정론, 이어 하기 가능).
// 최소화 문제. 경계·제약은 이 클래스 밖(tools/tune.ts)에서 수선 + 페널티로 다룬다.
import { Prng } from '../../src/sim/prng';

export interface CmaState {
  n: number; lambda: number; mu: number; weights: number[]; mueff: number;
  cc: number; cs: number; c1: number; cmu: number; damps: number; chiN: number;
  mean: number[]; sigma: number; C: number[][]; B: number[][]; D: number[]; pc: number[]; ps: number[];
  gen: number; evals: number; eigenGen: number;
  /** Prng 재생성용: 시드와 지금까지 뽑은 정규 표본 수 */
  seed: number; draws: number;
}

export interface CmaOptions { lambda?: number; seed?: number }

/** 대칭 행렬 고유분해 (순환 야코비). A = V diag(d) Vᵀ. V는 열이 고유벡터 */
export function eigenSym(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i]![j]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!, akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!, aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!, vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]!), vectors: v };
}

export class CmaEs {
  s: CmaState;
  private rng: Prng;

  constructor(x0: number[], sigma0: number, o: CmaOptions = {}) {
    const n = x0.length;
    if (n < 1) throw new Error('CMA-ES: 차원 0');
    const lambda = o.lambda ?? 4 + Math.floor(3 * Math.log(n));
    const mu = Math.floor(lambda / 2);
    const raw = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
    const sw = raw.reduce((a, b) => a + b, 0);
    const weights = raw.map((w) => w / sw);
    const mueff = 1 / weights.reduce((a, w) => a + w * w, 0);
    const cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
    const cs = (mueff + 2) / (n + mueff + 5);
    const c1 = 2 / ((n + 1.3) ** 2 + mueff);
    const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) ** 2 + mueff));
    const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
    const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    const I = () => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    const seed = o.seed ?? 1;
    this.s = {
      n, lambda, mu, weights, mueff, cc, cs, c1, cmu, damps, chiN,
      mean: [...x0], sigma: sigma0, C: I(), B: I(), D: Array(n).fill(1), pc: Array(n).fill(0), ps: Array(n).fill(0),
      gen: 0, evals: 0, eigenGen: 0, seed, draws: 0,
    };
    this.rng = new Prng(seed);
  }

  /** 저장한 상태에서 이어 하기 (난수 위치까지 같게) */
  static fromState(st: CmaState): CmaEs {
    const c = new CmaEs(st.mean, st.sigma, { lambda: st.lambda, seed: st.seed });
    c.s = JSON.parse(JSON.stringify(st)) as CmaState;
    for (let i = 0; i < st.draws; i++) c.rng.normal();
    return c;
  }

  private normal(): number { this.s.draws++; return this.rng.normal(); }

  /** 이번 세대 표본 λ개 */
  ask(): number[][] {
    const { n, lambda, mean, sigma, B, D } = this.s;
    const out: number[][] = [];
    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: n }, () => this.normal());
      const dz = z.map((zi, i) => D[i]! * zi);
      out.push(mean.map((m, i) => m + sigma * B[i]!.reduce((a, bij, j) => a + bij * dz[j]!, 0)));
    }
    return out;
  }

  /** 평가 결과로 평균·공분산·단계 크기를 갱신한다. xs는 ask()가 준 표본(순서 무관), fs는 같은 순서의 목적값 */
  tell(xs: number[][], fs: number[]): void {
    const st = this.s;
    const { n, mu, weights, mueff, cc, cs, c1, cmu, damps, chiN } = st;
    if (xs.length !== fs.length || xs.length < mu) throw new Error('CMA-ES: 표본 수가 맞지 않음');
    const idx = fs.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((p) => p[1]);
    const old = st.mean;
    const mean = Array(n).fill(0) as number[];
    for (let k = 0; k < mu; k++) for (let i = 0; i < n; i++) mean[i]! += weights[k]! * xs[idx[k]!]![i]!;
    const yw = mean.map((m, i) => (m - old[i]!) / st.sigma);
    // C^{-1/2} y_w = B D^{-1} Bᵀ y_w
    const bty = Array.from({ length: n }, (_, j) => st.B.reduce((a, row, i) => a + row[j]! * yw[i]!, 0) / st.D[j]!);
    const cinv = Array.from({ length: n }, (_, i) => st.B[i]!.reduce((a, bij, j) => a + bij * bty[j]!, 0));
    const ksc = Math.sqrt(cs * (2 - cs) * mueff);
    st.ps = st.ps.map((p, i) => (1 - cs) * p + ksc * cinv[i]!);
    const psn = Math.hypot(...st.ps);
    const hsig = psn / Math.sqrt(1 - (1 - cs) ** (2 * (st.gen + 1))) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const kcc = Math.sqrt(cc * (2 - cc) * mueff);
    st.pc = st.pc.map((p, i) => (1 - cc) * p + hsig * kcc * yw[i]!);
    const ys = Array.from({ length: mu }, (_, k) => xs[idx[k]!]!.map((x, i) => (x - old[i]!) / st.sigma));
    const dh = (1 - hsig) * cc * (2 - cc);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let rmu = 0;
        for (let k = 0; k < mu; k++) rmu += weights[k]! * ys[k]![i]! * ys[k]![j]!;
        const v = (1 - c1 - cmu) * st.C[i]![j]! + c1 * (st.pc[i]! * st.pc[j]! + dh * st.C[i]![j]!) + cmu * rmu;
        st.C[i]![j] = v;
        st.C[j]![i] = v;
      }
    }
    st.sigma *= Math.exp((cs / damps) * (psn / chiN - 1));
    st.mean = mean;
    st.gen++;
    st.evals += xs.length;
    // 고유분해는 O(n³)이라 Hansen 권고대로 가끔만 (n이 작으면 매 세대)
    if (st.evals - st.eigenGen > st.lambda / (c1 + cmu) / n / 10) {
      st.eigenGen = st.evals;
      const e = eigenSym(st.C);
      st.B = e.vectors;
      st.D = e.values.map((d) => Math.sqrt(Math.max(d, 1e-20)));
    }
  }

  /** 공분산 조건수 (진단용) */
  condition(): number {
    const d2 = this.s.D.map((d) => d * d);
    return Math.max(...d2) / Math.max(1e-300, Math.min(...d2));
  }
}
