// 2차원 기하: 지지 다각형(볼록 껍질)과 다각형까지 부호 거리. 2D 좌표는 지면 평면 (x, z)를 [x, z]로 쓴다.
export type Vec2 = [number, number];

const cross2 = (o: Readonly<Vec2>, a: Readonly<Vec2>, b: Readonly<Vec2>): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * 볼록 껍질 (Andrew monotone chain). 결과는 반시계 방향(x→오른쪽, 두 번째 좌표→위 기준), 일직선 위 점은 뺀다.
 * 점이 0~2개이거나 모두 일직선이면 중복 없는 끝점만 돌려준다.
 */
export function convexHull(points: readonly Readonly<Vec2>[]): Vec2[] {
  const pts = points
    .map((p): Vec2 => [p[0], p[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1]![0] || p[1] !== arr[i - 1]![1]);
  if (pts.length <= 2) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross2(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 다각형 넓이 (반시계면 양수). */
export function polygonArea(poly: readonly Readonly<Vec2>[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** 점 p에서 선분 ab 위 가장 가까운 점. */
export function closestPointOnSegment(p: Readonly<Vec2>, a: Readonly<Vec2>, b: Readonly<Vec2>): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}

/** 볼록 다각형(반시계) 안에 있는지. 경계 포함. */
export function pointInConvexPolygon(p: Readonly<Vec2>, poly: readonly Readonly<Vec2>[]): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) if (cross2(poly[i]!, poly[(i + 1) % poly.length]!, p) < 0) return false;
  return true;
}

/**
 * 볼록 다각형(반시계)까지 부호 거리: 안쪽이면 음수(가장 가까운 변까지 거리의 음수), 바깥이면 양수.
 * 다각형이 점 1개나 선분(2개)이면 그 점·선분까지 거리(항상 양수 또는 0)다. 빈 다각형은 +Infinity.
 */
export function signedDistanceToPolygon(p: Readonly<Vec2>, poly: readonly Readonly<Vec2>[]): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return Math.hypot(p[0] - poly[0]![0], p[1] - poly[0]![1]);
  let best = Infinity;
  const n = poly.length === 2 ? 1 : poly.length;
  for (let i = 0; i < n; i++) {
    const c = closestPointOnSegment(p, poly[i]!, poly[(i + 1) % poly.length]!);
    best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1]));
  }
  return poly.length >= 3 && pointInConvexPolygon(p, poly) ? -best : best;
}
