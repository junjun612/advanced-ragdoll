// 접촉력 분배 QP (v0.3, README 결정 40). 원하는 COM 렌치 [F; τ_c]를 지지발 바닥 꼭짓점 접촉력으로 나눈다.
// - 접촉점 i의 힘 f_i = Σ_k β_ik e_ik, β ≥ 0. e_ik = 마찰 피라미드 모서리 (n + μ·t_k 정규화, 4면 = 원뿔에 내접)
//   → 단방향(밀기만)과 마찰 제약이 β ≥ 0 하나로 표현된다. CoP는 꼭짓점 힘의 볼록 결합이라 발 안에 있다.
// - 목적: ‖W(Aβ − w)‖² + λ‖β‖² + λ_d‖β − β_prev‖². A의 열 = [e; (p − c) × e].
//   이 셋을 한 최소제곱으로 쌓아 비음수 최소제곱(NNLS, Lawson–Hanson)으로 푼다 → 외부 의존 없이 결정론적.
// 정의: docs/ALGORITHMS.md v0.3 "접촉력 QP".
import { type Vec3, add, cross, normalize, scale, sub } from '../math/vec3';
import { nnlsNormal } from '../math/nnls';

export interface ContactPoint {
  /** 이전 프레임 해와 짝지을 키 (예: 'LeftFoot:2') */
  key: string;
  p: Vec3;
  /** 지면 법선 (위쪽) */
  n: Vec3;
}

export interface QPConfig {
  mu: number;
  /** 렌치 행 가중치 [Fx, Fy, Fz, Mx, My, Mz] (√ 아닌 제곱 가중치) */
  weights: [number, number, number, number, number, number];
  /** 힘 크기 정규화 λ (N⁻²·N² 단위 무차원 비) */
  regularization: number;
  /** 이전 프레임 차이 정규화 λ_d */
  smoothing: number;
  /** 접촉점마다 최소 법선력 (N). 양발 지지에서 한 발이 완전히 빠져 끌리지 않게 (없으면 0) */
  minNormal?: number;
}

export interface QPResult {
  /** 접촉점별 힘 (월드, N) */
  forces: { key: string; p: Vec3; f: Vec3 }[];
  /** 실제로 만든 렌치 [F; τ_c] */
  achieved: [Vec3, Vec3];
  /** 렌치 추적 오차 |F − F_des| (N), |τ − τ_des| (N·m) */
  forceError: number;
  momentError: number;
  /** 가중 잔차 √(Σ w (Aβ − w)²) */
  residual: number;
  /** 다음 프레임 smoothing용 β (키 → 모서리 4개) */
  beta: Map<string, number[]>;
}

const EDGES = 4;

/** 마찰 피라미드 모서리 (내접 4면): n + μ·(±t1 | ±t2) 정규화 */
export function pyramidEdges(n: Readonly<Vec3>, mu: number): Vec3[] {
  const nn = normalize(n);
  const a: Vec3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const t1 = normalize(cross(nn, a)), t2 = cross(nn, t1);
  return [t1, scale(t1, -1), t2, scale(t2, -1)].map((t) => normalize(add(nn, scale(t, mu))));
}

/**
 * 접촉력 분배. com = 렌치 기준점(COM), F = 원하는 접촉 합력(중력 보상 포함, N), M = 원하는 COM 둘레 모멘트(N·m).
 * prevBeta가 있으면 같은 키의 β와의 차이를 smoothing으로 벌한다.
 */
export function distributeContactForces(points: readonly ContactPoint[], com: Readonly<Vec3>, F: Readonly<Vec3>, M: Readonly<Vec3>, cfg: QPConfig, prevBeta?: Map<string, number[]>): QPResult {
  const n = points.length * EDGES;
  const cols: { e: Vec3; m: Vec3 }[] = [];
  for (const c of points) for (const e of pyramidEdges(c.n, cfg.mu)) cols.push({ e, m: cross(sub(c.p, com), e) });
  // 최소 법선력: f_i = fmin·n_i + Σβe. 고정 부분의 렌치를 목표에서 빼고 결과에 다시 더한다
  const fmin = cfg.minNormal ?? 0;
  let F0: Vec3 = [0, 0, 0], M0: Vec3 = [0, 0, 0];
  for (const c of points) { const f0 = scale(c.n, fmin); F0 = add(F0, f0); M0 = add(M0, cross(sub(c.p, com), f0)); }
  const target = [F[0] - F0[0], F[1] - F0[1], F[2] - F0[2], M[0] - M0[0], M[1] - M0[1], M[2] - M0[2]];
  const W = cfg.weights;
  const row = (j: number, r: number): number => (r < 3 ? cols[j]!.e[r]! : cols[j]!.m[r - 3]!);
  // 정규방정식 G = AᵀWA + (λ + λ_d)I,  h = AᵀW w + λ_d β_prev
  const G = new Array<number>(n * n).fill(0), h = new Array<number>(n).fill(0);
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      let s = 0;
      for (let r = 0; r < 6; r++) s += W[r]! * row(a, r) * row(b, r);
      G[a * n + b] = s;
      G[b * n + a] = s;
    }
    let s = 0;
    for (let r = 0; r < 6; r++) s += W[r]! * row(a, r) * target[r]!;
    h[a] = s;
  }
  const prev = new Array<number>(n).fill(0);
  points.forEach((c, i) => {
    const pb = prevBeta?.get(c.key);
    for (let k = 0; k < EDGES; k++) prev[i * EDGES + k] = pb?.[k] ?? 0;
  });
  for (let a = 0; a < n; a++) {
    G[a * n + a]! += cfg.regularization + cfg.smoothing;
    h[a]! += cfg.smoothing * prev[a]!;
  }
  const { x } = nnlsNormal(G, h, n);

  const forces: QPResult['forces'] = [];
  const beta = new Map<string, number[]>();
  let Fa: Vec3 = [0, 0, 0], Ma: Vec3 = [0, 0, 0];
  points.forEach((c, i) => {
    let f: Vec3 = scale(c.n, fmin);
    const bs: number[] = [];
    for (let k = 0; k < EDGES; k++) {
      const j = i * EDGES + k;
      bs.push(x[j]!);
      f = add(f, scale(cols[j]!.e, x[j]!));
    }
    beta.set(c.key, bs);
    forces.push({ key: c.key, p: c.p, f });
    Fa = add(Fa, f);
    Ma = add(Ma, cross(sub(c.p, com), f));
  });
  const ach = [...Fa, ...Ma];
  const goal = [F[0], F[1], F[2], M[0], M[1], M[2]];
  let res = 0;
  for (let r = 0; r < 6; r++) res += W[r]! * (ach[r]! - goal[r]!) ** 2;
  return {
    forces,
    achieved: [Fa, Ma],
    forceError: Math.hypot(Fa[0] - F[0], Fa[1] - F[1], Fa[2] - F[2]),
    momentError: Math.hypot(Ma[0] - M[0], Ma[1] - M[1], Ma[2] - M[2]),
    residual: Math.sqrt(res),
    beta,
  };
}
