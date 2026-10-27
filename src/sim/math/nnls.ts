// 비음수 최소제곱 (NNLS, Lawson–Hanson 1974): min ‖A x − b‖² s.t. x ≥ 0.
// 정규방정식 G = AᵀA, h = Aᵀb를 받아 푼다(작은 문제용, 열 수 ≲ 100). 외부 의존 없음, 같은 입력이면 같은 결과(결정론).
// 부분 문제 G_PP z = h_P는 가우스 소거(부분 피벗)로 푼다. 정규화 행을 A에 넣어 두면 G가 양의 정부호라 안정적이다.

export interface NnlsResult {
  x: number[];
  /** 바깥 반복 횟수 */
  iterations: number;
  /** 최대 반복에 걸려 끝났는가 */
  truncated: boolean;
}

/** 작은 대칭 선형계 M z = r (n×n, 행 우선 평면 배열). 특이하면 null */
export function solveDense(M: number[], r: number[], n: number): number[] | null {
  const a = M.slice(), b = r.slice();
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(a[c * n + c]!);
    for (let i = c + 1; i < n; i++) {
      const v = Math.abs(a[i * n + c]!);
      if (v > best) { best = v; p = i; }
    }
    if (best < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = a[c * n + k]!; a[c * n + k] = a[p * n + k]!; a[p * n + k] = t; }
      const t = b[c]!; b[c] = b[p]!; b[p] = t;
    }
    const d = a[c * n + c]!;
    for (let i = c + 1; i < n; i++) {
      const f = a[i * n + c]! / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[i * n + k]! -= f * a[c * n + k]!;
      b[i]! -= f * b[c]!;
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < n; k++) s -= a[i * n + k]! * z[k]!;
    z[i] = s / a[i * n + i]!;
  }
  return z;
}

/**
 * Lawson–Hanson NNLS. G (n×n, 행 우선) = AᵀA, h = Aᵀb.
 * tol: 쌍대 변수(기울기) w = h − G x의 양수 판정 기준.
 */
export function nnlsNormal(G: readonly number[], h: readonly number[], n: number, tol = 1e-9, maxIter = 3 * n + 10): NnlsResult {
  const x = new Array<number>(n).fill(0);
  const inP = new Array<boolean>(n).fill(false);
  const grad = (): number[] => {
    const w = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = h[i]!;
      for (let k = 0; k < n; k++) s -= G[i * n + k]! * x[k]!;
      w[i] = s;
    }
    return w;
  };
  const solveP = (): number[] | null => {
    const P: number[] = [];
    for (let i = 0; i < n; i++) if (inP[i]) P.push(i);
    const m = P.length;
    const M = new Array<number>(m * m), r = new Array<number>(m);
    for (let a = 0; a < m; a++) {
      r[a] = h[P[a]!]!;
      for (let b = 0; b < m; b++) M[a * m + b] = G[P[a]! * n + P[b]!]!;
    }
    const zP = solveDense(M, r, m);
    if (!zP) return null;
    const z = new Array<number>(n).fill(0);
    P.forEach((i, a) => { z[i] = zP[a]!; });
    return z;
  };
  let it = 0;
  for (; it < maxIter; it++) {
    const w = grad();
    let t = -1, best = tol;
    for (let i = 0; i < n; i++) if (!inP[i] && w[i]! > best) { best = w[i]!; t = i; }
    if (t < 0) return { x, iterations: it, truncated: false };
    inP[t] = true;
    let z = solveP();
    if (!z) { inP[t] = false; return { x, iterations: it, truncated: true }; }
    // 안쪽 반복: 음수가 된 변수를 빼면서 x를 z 쪽으로 옮긴다
    for (let inner = 0; inner < 3 * n; inner++) {
      let neg = false;
      for (let i = 0; i < n; i++) if (inP[i] && z[i]! <= 0) { neg = true; break; }
      if (!neg) break;
      let alpha = Infinity;
      for (let i = 0; i < n; i++) if (inP[i] && z[i]! <= 0) alpha = Math.min(alpha, x[i]! / (x[i]! - z[i]!));
      for (let i = 0; i < n; i++) if (inP[i]) {
        x[i] = x[i]! + alpha * (z[i]! - x[i]!);
        if (x[i]! <= 1e-12) { x[i] = 0; inP[i] = false; }
      }
      const z2 = solveP();
      if (!z2) return { x, iterations: it, truncated: true };
      z = z2;
    }
    for (let i = 0; i < n; i++) x[i] = inP[i] ? Math.max(0, z[i]!) : 0;
  }
  return { x, iterations: it, truncated: true };
}
