// 단위 사원수 [x, y, z, w]. 회전 합성은 multiplyQ(a, b) = "b를 먼저, 그다음 a" (rotate(multiplyQ(a,b), v) = rotate(a, rotate(b, v))).
import { type Vec3, cross, dot, length, normalize, anyPerpendicular } from './vec3';

export type Quat = [number, number, number, number];

export const identityQ = (): Quat => [0, 0, 0, 1];
export const quat = (x: number, y: number, z: number, w: number): Quat => [x, y, z, w];

export function multiplyQ(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const conjugate = (q: Readonly<Quat>): Quat => [-q[0], -q[1], -q[2], q[3]];
export const qdot = (a: Readonly<Quat>, b: Readonly<Quat>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export function normalizeQ(q: Readonly<Quat>): Quat {
  const l = Math.sqrt(qdot(q, q));
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : identityQ();
}

/** 단위 사원수가 아니어도 동작하는 역원. */
export function inverseQ(q: Readonly<Quat>): Quat {
  const n = qdot(q, q);
  return n > 1e-12 ? [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n] : identityQ();
}

/** v를 q로 회전. */
export function rotate(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  // v' = v + 2w(u×v) + 2u×(u×v), u = q.xyz
  const u: Vec3 = [q[0], q[1], q[2]], w = q[3];
  const t = cross(u, v);
  const t2: Vec3 = [2 * t[0], 2 * t[1], 2 * t[2]];
  const c = cross(u, t2);
  return [v[0] + w * t2[0] + c[0], v[1] + w * t2[1] + c[1], v[2] + w * t2[2] + c[2]];
}

/** 축(정규화 안 돼 있어도 됨)과 각(라디안) → 사원수. 오른손 법칙. */
export function fromAxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const n = normalize(axis), s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

/** 사원수 → 축과 각. 각은 [0, π]로 정규화한다 (w < 0이면 부호를 뒤집는다). 각이 0이면 축은 +X. */
export function toAxisAngle(q: Readonly<Quat>): { axis: Vec3; angle: number } {
  let [x, y, z, w] = normalizeQ(q);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-12) return { axis: [1, 0, 0], angle: 0 };
  return { axis: [x / s, y / s, z / s], angle: 2 * Math.atan2(s, w) };
}

/** 회전 벡터(축 × 각) ↔ 사원수 */
export function toRotationVector(q: Readonly<Quat>): Vec3 {
  const { axis, angle } = toAxisAngle(q);
  return [axis[0] * angle, axis[1] * angle, axis[2] * angle];
}
export function fromRotationVector(r: Readonly<Vec3>): Quat {
  const a = length(r);
  return a < 1e-12 ? identityQ() : fromAxisAngle(r, a);
}

/** 단위 벡터 a를 b로 돌리는 최소 회전. */
export function fromTo(a: Readonly<Vec3>, b: Readonly<Vec3>): Quat {
  const na = normalize(a), nb = normalize(b);
  const d = dot(na, nb);
  if (d < -1 + 1e-12) return fromAxisAngle(anyPerpendicular(na), Math.PI);
  const c = cross(na, nb);
  return normalizeQ([c[0], c[1], c[2], 1 + d]);
}

/** 두 회전 사이 각(라디안, 0~π). */
export function angleBetweenQ(a: Readonly<Quat>, b: Readonly<Quat>): number {
  const d = Math.min(1, Math.abs(qdot(normalizeQ(a), normalizeQ(b))));
  return 2 * Math.acos(d);
}

/** 구면 선형 보간. 짧은 경로를 쓴다. */
export function slerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let bb: Quat = [b[0], b[1], b[2], b[3]];
  let d = qdot(a, b);
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    return normalizeQ([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/**
 * 스윙-트위스트 분해: q = swing · twist.
 * twist는 단위 축 `axis` 둘레 회전, swing은 axis에 수직인 축 둘레 회전이다.
 * q가 axis에 수직인 축으로 180° 돌린 경우(특이점) twist = 항등.
 */
export function swingTwist(q: Readonly<Quat>, axis: Readonly<Vec3>): { swing: Quat; twist: Quat } {
  const n = normalize(axis);
  const p = q[0] * n[0] + q[1] * n[1] + q[2] * n[2];
  let twist: Quat = [n[0] * p, n[1] * p, n[2] * p, q[3]];
  const tl = Math.sqrt(qdot(twist, twist));
  twist = tl < 1e-12 ? identityQ() : [twist[0] / tl, twist[1] / tl, twist[2] / tl, twist[3] / tl];
  const swing = multiplyQ(q, conjugate(twist));
  return { swing, twist };
}

/** 트위스트 각(라디안, -π~π), axis 기준 오른손 법칙. */
export function twistAngle(q: Readonly<Quat>, axis: Readonly<Vec3>): number {
  const { twist } = swingTwist(q, axis);
  const n = normalize(axis);
  const s = twist[0] * n[0] + twist[1] * n[1] + twist[2] * n[2];
  let a = 2 * Math.atan2(s, twist[3]);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
