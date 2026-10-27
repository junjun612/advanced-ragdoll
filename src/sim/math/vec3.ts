// 3차원 벡터. 모든 함수는 순수 함수이고 새 배열을 돌려준다 (입력을 바꾸지 않는다).
export type Vec3 = [number, number, number];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const clone = (a: Readonly<Vec3>): Vec3 => [a[0], a[1], a[2]];
export const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const negate = (a: Readonly<Vec3>): Vec3 => [-a[0], -a[1], -a[2]];
/** a + b·s */
export const addScaled = (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const lengthSq = (a: Readonly<Vec3>): number => dot(a, a);
export const length = (a: Readonly<Vec3>): number => Math.sqrt(dot(a, a));
export const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => length(sub(a, b));
export const lerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 길이가 0에 가까우면 [0,0,0]을 돌려준다. */
export function normalize(a: Readonly<Vec3>): Vec3 {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
}

/** 두 벡터 사이 각(라디안, 0~π). */
export function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

/** a를 단위 축 n에 수직인 평면에 투영. */
export const projectOnPlane = (a: Readonly<Vec3>, n: Readonly<Vec3>): Vec3 => addScaled(a, n, -dot(a, n));

/** a에 수직인 임의의 단위 벡터. */
export function anyPerpendicular(a: Readonly<Vec3>): Vec3 {
  const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(a, other));
}

export const approxEqual = (a: Readonly<Vec3>, b: Readonly<Vec3>, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
