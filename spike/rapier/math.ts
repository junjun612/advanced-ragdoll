// Tiny vec/quat helpers for the spike (plain objects, Rapier-compatible shape).
export type V3 = { x: number; y: number; z: number };
export type Q = { x: number; y: number; z: number; w: number };

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a: V3) => Math.sqrt(dot(a, a));

export const qid = (): Q => ({ x: 0, y: 0, z: 0, w: 1 });
export const qconj = (q: Q): Q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const qmul = (a: Q, b: Q): Q => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
export const qaxis = (axis: V3, ang: number): Q => {
  const s = Math.sin(ang / 2);
  const n = len(axis);
  return { x: (axis.x / n) * s, y: (axis.y / n) * s, z: (axis.z / n) * s, w: Math.cos(ang / 2) };
};
export const qnorm = (q: Q): Q => {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
};
/** shortest-path (w >= 0) */
export const qpos = (q: Q): Q => (q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q);
export const qrot = (q: Q, v: V3): V3 => {
  // v' = q v q*
  const t = scale(cross(q, v), 2);
  return add(add(v, scale(t, q.w)), cross(q, t));
};
export const qrotInv = (q: Q, v: V3) => qrot(qconj(q), v);
/** rotation vector (axis * angle) of q, shortest path */
export const qlog = (qin: Q): V3 => {
  const q = qpos(qin);
  const s = Math.hypot(q.x, q.y, q.z);
  if (s < 1e-9) return v3(2 * q.x, 2 * q.y, 2 * q.z);
  const ang = 2 * Math.atan2(s, q.w);
  return v3((q.x / s) * ang, (q.y / s) * ang, (q.z / s) * ang);
};
export const qangle = (q: Q) => len(qlog(q));
/** Rapier-style per-axis joint coordinate: 2*asin(q_i) with w>=0 */
export const axisAngles = (qin: Q): [number, number, number] => {
  const q = qpos(qin);
  const f = (s: number) => 2 * Math.asin(Math.max(-1, Math.min(1, s)));
  return [f(q.x), f(q.y), f(q.z)];
};
export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

// 3x3 matrices (row-major number[9])
export type M3 = number[];
export const m3zero = (): M3 => [0, 0, 0, 0, 0, 0, 0, 0, 0];
export const m3addTo = (a: M3, b: M3, s = 1) => {
  for (let i = 0; i < 9; i++) a[i]! += b[i]! * s;
};
/** add point-mass parallel-axis term m(|d|^2 E - d d^T) */
export const m3addParallel = (a: M3, m: number, d: V3) => {
  const dd = dot(d, d);
  const D = [d.x, d.y, d.z];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) a[r * 3 + c]! += m * ((r === c ? dd : 0) - D[r]! * D[c]!);
};
export const m3inv = (m: M3): M3 => {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
};
export const m3mul = (a: M3, b: M3): M3 => {
  const o = m3zero();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};
export const m3v = (m: M3, v: V3): V3 => v3(m[0]! * v.x + m[1]! * v.y + m[2]! * v.z, m[3]! * v.x + m[4]! * v.y + m[5]! * v.z, m[6]! * v.x + m[7]! * v.y + m[8]! * v.z);
export const m3trace = (m: M3) => m[0]! + m[4]! + m[8]!;
