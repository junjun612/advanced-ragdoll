// 전신 운동량 QP (v0.3, README 결정 49). 변수 = 관절 가속도 q̈ (n) + 접촉 피라미드 계수 ρ ≥ 0.
//   min  Σ_t w_t‖T_t q̈ − r_t‖² + λ_q‖q̈‖²                     (과제: 몸통 방향, 골반, 자세 — 행렬 H, g로 받음)
//      + w_l‖Σf − F_des‖² + w_k‖Σ(p−c)×f − k̇_des‖²             (중심 운동량 변화율: 선은 높게, 각은 낮게)
//      + λ_ρ‖ρ‖² + λ_d‖ρ − ρ_prev‖²
//   s.t. A_O q̈ = W_c(ρ) + W_g − bias                          (부유 기저 = 운동량 등식)
//        J_foot q̈ = −a0_foot − K_v v_foot                       (지지발 고정)
//        ρ ≥ 0                                                   (단방향 + 마찰 피라미드)
// 풀이: 등식이 ρ에 선형이므로 KKT 행렬을 한 번 LU 분해해 q̈(ρ) = x0 + Xρ (ρ마다 최적 q̈)를 구하고,
// 과제 값 함수를 ρ의 2차식으로 바꿔 ρ만의 비음수 최소제곱(Lawson–Hanson)으로 푼다 → 등식·부등식을 정확히 만족하는 결합 QP의 해.
import { type Vec3, add, cross, scale, sub } from '../math/vec3';
import { nnlsNormal } from '../math/nnls';
import { luFactor, luSolve } from '../math/dense';
import { pyramidEdges, type ContactPoint } from '../character/contactQP';

export interface WBQPInput {
  n: number;
  /** 과제 2차형: q̈ᵀHq̈ − 2gᵀq̈ (정규화 포함) */
  H: Float64Array;
  g: Float64Array;
  /** 원점 운동량 행렬 (6×n), 우변 상수 W_g − bias */
  A: Float64Array;
  momentumRhs: number[];
  /** 지지발 등식 행과 우변 */
  footRows: Float64Array[];
  footRhs: number[];
  points: readonly ContactPoint[];
  com: Vec3;
  Fdes: Vec3;
  kdotDes: Vec3;
  mu: number;
  wLin: number;
  /** 선 운동량 축별 배율 [x, y, z] (없으면 1) — v0.4 스텝 중 수직을 낮춘다 */
  wLinAxes?: Vec3;
  wAng: number;
  regRho: number;
  smoothRho: number;
  minNormal: number;
  prevBeta?: Map<string, number[]>;
  /** 접촉점별 추가 힘 벌점 (v0.4 스텝 하중 빼기). 없으면 0 */
  pointPenalty?: readonly number[];
  /** 접촉점별 최소 법선력 (없으면 minNormal) */
  pointMinNormal?: readonly number[];
}

export interface WBQPResult {
  qdd: number[];
  forces: { key: string; p: Vec3; f: Vec3 }[];
  beta: Map<string, number[]>;
  achieved: [Vec3, Vec3];
  /** 등식 잔차 최대 |E q̈ − d| */
  eqResidual: number;
}

const EDGES = 4;

export function solveWholeBodyQP(inp: WBQPInput): WBQPResult | null {
  const { n, points } = inp;
  const nr = points.length * EDGES;
  // 접촉 열: 힘 e, 원점 렌치 (p × e, e), COM 둘레 모멘트 (p − c) × e
  const cols: { e: Vec3; wO: number[]; mG: Vec3 }[] = [];
  let F0: Vec3 = [0, 0, 0], M0: Vec3 = [0, 0, 0];
  const W0 = [0, 0, 0, 0, 0, 0];
  const minN = (i: number): number => inp.pointMinNormal?.[i] ?? inp.minNormal;
  for (const [ci, c] of points.entries()) {
    for (const e of pyramidEdges(c.n, inp.mu)) {
      const pe = cross(c.p, e);
      cols.push({ e, wO: [pe[0], pe[1], pe[2], e[0], e[1], e[2]], mG: cross(sub(c.p, inp.com), e) });
    }
    const f0 = scale(c.n, minN(ci));
    F0 = add(F0, f0);
    M0 = add(M0, cross(sub(c.p, inp.com), f0));
    const p0 = cross(c.p, f0);
    for (let r = 0; r < 3; r++) { W0[r]! += p0[r]!; W0[3 + r]! += f0[r]!; }
  }
  // KKT 행렬 K = [[H, Eᵀ], [E, 0]]
  const E = [...Array.from({ length: 6 }, (_, r) => inp.A.subarray(r * n, r * n + n)), ...inp.footRows];
  const m = E.length, N = n + m;
  const K = new Float64Array(N * N);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) K[i * N + j] = inp.H[i * n + j]!;
  E.forEach((row, k) => {
    for (let j = 0; j < n; j++) {
      K[(n + k) * N + j] = row[j]!;
      K[j * N + n + k] = row[j]!;
    }
  });
  const lu = luFactor(K, N);
  if (!lu) return null;
  // x0: ρ = 0 (최소 법선력만)일 때
  const rhs0 = new Float64Array(N);
  for (let i = 0; i < n; i++) rhs0[i] = inp.g[i]!;
  for (let r = 0; r < 6; r++) rhs0[n + r] = inp.momentumRhs[r]! + W0[r]!;
  inp.footRhs.forEach((v, k) => { rhs0[n + 6 + k] = v; });
  const x0 = luSolve(lu, rhs0).subarray(0, n);
  // X 열: ρ_k 한 단위가 운동량 등식 우변에 주는 변화. 우변이 운동량 6행에만 있으므로 X_k = Z·wO_k (Z = 단위 우변 6개의 해, n×6).
  // 접촉 열(점 × 4)마다 LU 풀기 대신 6번만 풀고, 2차형도 6×6 Q = ZᵀHZ로 줄인다 (v0.4 성능: 열 수 32~64 → 6)
  const Z: Float64Array[] = [];
  for (let r = 0; r < 6; r++) {
    const e = new Float64Array(N);
    e[n + r] = 1;
    Z.push(luSolve(lu, e).subarray(0, n));
  }
  const HZ = Z.map((z) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * n; for (let j = 0; j < n; j++) s += inp.H[o + j]! * z[j]!; y[i] = s; }
    return y;
  });
  const Q = new Float64Array(36);
  for (let r = 0; r < 6; r++) for (let c = r; c < 6; c++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Z[r]![i]! * HZ[c]![i]!;
    Q[r * 6 + c] = s; Q[c * 6 + r] = s;
  }
  const Hx0g = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += inp.H[i * n + j]! * x0[j]!; Hx0g[i] = s - inp.g[i]!; }
  const zg = [0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 6; r++) { let s = 0; for (let i = 0; i < n; i++) s += Z[r]![i]! * Hx0g[i]!; zg[r] = s; }
  // ρ의 2차형: G ρ − h
  const G = new Array<number>(nr * nr).fill(0), h = new Array<number>(nr).fill(0);
  const QW = cols.map((c) => { const y = [0, 0, 0, 0, 0, 0]; for (let r = 0; r < 6; r++) { let s = 0; for (let k = 0; k < 6; k++) s += Q[r * 6 + k]! * c.wO[k]!; y[r] = s; } return y; });
  const tL = sub(inp.Fdes, F0), tK = sub(inp.kdotDes, M0);
  const [wx, wy, wz] = inp.wLinAxes ?? [1, 1, 1];
  for (let a = 0; a < nr; a++) {
    const ca = cols[a]!;
    for (let b = a; b < nr; b++) {
      const cb = cols[b]!, qb = QW[b]!;
      let s = 0;
      for (let k = 0; k < 6; k++) s += ca.wO[k]! * qb[k]!;
      s += inp.wLin * (wx * ca.e[0] * cb.e[0] + wy * ca.e[1] * cb.e[1] + wz * ca.e[2] * cb.e[2]);
      s += inp.wAng * (ca.mG[0] * cb.mG[0] + ca.mG[1] * cb.mG[1] + ca.mG[2] * cb.mG[2]);
      G[a * nr + b] = s;
      G[b * nr + a] = s;
    }
    let s = 0;
    for (let k = 0; k < 6; k++) s -= ca.wO[k]! * zg[k]!;
    s += inp.wLin * (wx * ca.e[0] * tL[0] + wy * ca.e[1] * tL[1] + wz * ca.e[2] * tL[2]);
    s += inp.wAng * (ca.mG[0] * tK[0] + ca.mG[1] * tK[1] + ca.mG[2] * tK[2]);
    h[a] = s;
  }
  const prev = new Array<number>(nr).fill(0);
  points.forEach((c, i) => { const pb = inp.prevBeta?.get(c.key); for (let k = 0; k < EDGES; k++) prev[i * EDGES + k] = pb?.[k] ?? 0; });
  for (let a = 0; a < nr; a++) { G[a * nr + a]! += inp.regRho + inp.smoothRho + (inp.pointPenalty?.[Math.floor(a / EDGES)] ?? 0); h[a]! += inp.smoothRho * prev[a]!; }
  const { x: rho } = nnlsNormal(G, h, nr);

  const qdd = Array.from(x0);
  const wr = [0, 0, 0, 0, 0, 0];
  for (let a = 0; a < nr; a++) if (rho[a]! !== 0) for (let k = 0; k < 6; k++) wr[k]! += cols[a]!.wO[k]! * rho[a]!;
  for (let k = 0; k < 6; k++) if (wr[k]! !== 0) for (let i = 0; i < n; i++) qdd[i]! += Z[k]![i]! * wr[k]!;
  const forces: WBQPResult['forces'] = [];
  const beta = new Map<string, number[]>();
  let Fa: Vec3 = [0, 0, 0], Ma: Vec3 = [0, 0, 0];
  points.forEach((c, i) => {
    let f: Vec3 = scale(c.n, minN(i));
    const bs: number[] = [];
    for (let k = 0; k < EDGES; k++) { const j = i * EDGES + k; bs.push(rho[j]!); f = add(f, scale(cols[j]!.e, rho[j]!)); }
    beta.set(c.key, bs);
    forces.push({ key: c.key, p: c.p, f });
    Fa = add(Fa, f);
    Ma = add(Ma, cross(sub(c.p, inp.com), f));
  });
  // 등식 잔차 확인
  let eqRes = 0;
  const Wc = [0, 0, 0, 0, 0, 0];
  for (const fr of forces) { const pf = cross(fr.p, fr.f); for (let r = 0; r < 3; r++) { Wc[r]! += pf[r]!; Wc[3 + r]! += fr.f[r]!; } }
  E.forEach((row, k) => {
    let s = 0;
    for (let j = 0; j < n; j++) s += row[j]! * qdd[j]!;
    const dk = k < 6 ? inp.momentumRhs[k]! + Wc[k]! : inp.footRhs[k - 6]!;
    eqRes = Math.max(eqRes, Math.abs(s - dk));
  });
  return { qdd, forces, beta, achieved: [Fa, Ma], eqResidual: eqRes };
}
