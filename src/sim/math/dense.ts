// 작은 밀집 선형계: LU 분해(부분 피벗) 한 번 + 여러 우변 풀기. 결정론적, 외부 의존 없음.

export interface LU {
  n: number;
  a: Float64Array;
  piv: Int32Array;
}

/** A (n×n 행 우선)의 LU 분해. 특이하면 null */
export function luFactor(A: ArrayLike<number>, n: number): LU | null {
  const a = Float64Array.from(A);
  const piv = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(a[c * n + c]!);
    for (let i = c + 1; i < n; i++) {
      const v = Math.abs(a[i * n + c]!);
      if (v > best) { best = v; p = i; }
    }
    if (best < 1e-12) return null;
    piv[c] = p;
    if (p !== c) for (let k = 0; k < n; k++) { const t = a[c * n + k]!; a[c * n + k] = a[p * n + k]!; a[p * n + k] = t; }
    const d = a[c * n + c]!;
    for (let i = c + 1; i < n; i++) {
      const f = (a[i * n + c]! /= d);
      if (f === 0) continue;
      for (let k = c + 1; k < n; k++) a[i * n + k]! -= f * a[c * n + k]!;
    }
  }
  return { n, a, piv };
}

/** LU로 A x = b 풀기 */
export function luSolve(lu: LU, b: ArrayLike<number>): Float64Array {
  const { n, a, piv } = lu;
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    const p = piv[c]!;
    if (p !== c) { const t = x[c]!; x[c] = x[p]!; x[p] = t; }
  }
  for (let i = 1; i < n; i++) {
    let s = x[i]!;
    for (let k = 0; k < i; k++) s -= a[i * n + k]! * x[k]!;
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let k = i + 1; k < n; k++) s -= a[i * n + k]! * x[k]!;
    x[i] = s / a[i * n + i]!;
  }
  return x;
}
