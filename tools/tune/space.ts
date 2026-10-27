// 튜닝 탐색 공간 (config/tuneSpace.json): 파라미터 ↔ CMA-ES 정규화 좌표 [0,1], 설정 덮어쓰기, 순서 제약.
// 경로 첫 마디 = 설정 파일 이름 (behaviors, stepping, reaction, balance, muscles, hitModel, animDriver).

export interface TuneParam {
  /** "<파일>.<키>.<키>…" 예: reaction.style.danger.d0 */
  path: string;
  lo: number;
  hi: number;
  /** primary = 학습형 추종기(D안) 뒤에도 살아남는 값(행동 타이밍·문턱, 스텝 전략 문턱, 반응 클립 선택·블렌드, 팔 묶음 조건). later = 추종기에 묶인 값(근육 게인, QP 가중치) */
  tier: 'primary' | 'later';
  int?: boolean;
  /** 로그 축으로 탐색 (게인·가중치) */
  log?: boolean;
  why?: string;
}

/** a < b − gap (정규화 전 실제 값) */
export interface TuneConstraint { lt: [string, string]; gap?: number }

export function encode(ps: TuneParam[], v: number[]): number[] {
  return ps.map((p, i) => (p.log ? Math.log(v[i]! / p.lo) / Math.log(p.hi / p.lo) : (v[i]! - p.lo) / (p.hi - p.lo)));
}

export function decode(ps: TuneParam[], u: number[]): number[] {
  return ps.map((p, i) => {
    const x = p.log ? p.lo * (p.hi / p.lo) ** u[i]! : p.lo + (p.hi - p.lo) * u[i]!;
    return p.int ? Math.round(x) : x;
  });
}

/** [0,1] 상자로 자르기 + 잘린 거리 제곱 (경계 페널티용) */
export function repair(u: number[]): { x: number[]; dist2: number } {
  let dist2 = 0;
  const x = u.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    dist2 += (v - c) ** 2;
    return c;
  });
  return { x, dist2 };
}

export function constraintViolation(vals: Record<string, number>, cs: TuneConstraint[]): number {
  let v = 0;
  for (const c of cs) {
    const a = vals[c.lt[0]], b = vals[c.lt[1]];
    if (a === undefined || b === undefined) continue;
    v += Math.max(0, a - (b - (c.gap ?? 0)));
  }
  return v;
}

/** cfgs[파일]을 깊은 복사한 뒤 경로마다 값을 넣는다. 없는 경로는 오타이므로 에러 */
export function applyOverrides<T extends Record<string, unknown>>(cfgs: T, ov: Record<string, number>): T {
  const out = JSON.parse(JSON.stringify(cfgs)) as T;
  for (const [path, val] of Object.entries(ov)) {
    const keys = path.split('.');
    let o = out as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      const nx = o[k];
      if (!nx || typeof nx !== 'object') throw new Error(`튜닝 경로 없음: ${path} (${k})`);
      o = nx as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (typeof o[last] !== 'number') throw new Error(`튜닝 경로가 숫자가 아님: ${path}`);
    o[last] = val;
  }
  return out;
}

/** 경로의 지금 값 (기본 설정 = x0) */
export function readPath(cfgs: Record<string, unknown>, path: string): number {
  let o: unknown = cfgs;
  for (const k of path.split('.')) o = (o as Record<string, unknown> | undefined)?.[k];
  if (typeof o !== 'number') throw new Error(`튜닝 경로가 숫자가 아님: ${path}`);
  return o;
}
