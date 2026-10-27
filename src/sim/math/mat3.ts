// 3×3 행렬, 행 우선(row-major) 9개 숫자: [m00, m01, m02, m10, ...]. 열 벡터 규약: v' = M·v.
import type { Vec3 } from './vec3';
import type { Quat } from './quat';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const identity3 = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 열 벡터 세 개로 행렬을 만든다 (예: 좌표계 축 X, Y, Z). */
export const fromColumns = (x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): Mat3 => [
  x[0], y[0], z[0],
  x[1], y[1], z[1],
  x[2], y[2], z[2],
];

export const column = (m: Readonly<Mat3>, i: 0 | 1 | 2): Vec3 => [m[i], m[3 + i]!, m[6 + i]!];

export function multiply3(a: Readonly<Mat3>, b: Readonly<Mat3>): Mat3 {
  const r = new Array<number>(9) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
}

export const mulVec3 = (m: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const transpose3 = (m: Readonly<Mat3>): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export const determinant3 = (m: Readonly<Mat3>): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** 특이 행렬이면 null. */
export function inverse3(m: Readonly<Mat3>): Mat3 | null {
  const d = determinant3(m);
  if (Math.abs(d) < 1e-15) return null;
  const i = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * i, (m[2] * m[7] - m[1] * m[8]) * i, (m[1] * m[5] - m[2] * m[4]) * i,
    (m[5] * m[6] - m[3] * m[8]) * i, (m[0] * m[8] - m[2] * m[6]) * i, (m[2] * m[3] - m[0] * m[5]) * i,
    (m[3] * m[7] - m[4] * m[6]) * i, (m[1] * m[6] - m[0] * m[7]) * i, (m[0] * m[4] - m[1] * m[3]) * i,
  ];
}

/** 단위 사원수 → 회전 행렬. */
export function fromQuat(q: Readonly<Quat>): Mat3 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/** 회전 행렬 → 단위 사원수 (Shepperd 방법). w ≥ 0으로 정규화한다. */
export function toQuat(m: Readonly<Mat3>): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  const sg = q[3] < 0 ? -1 : 1;
  return [(q[0] / l) * sg, (q[1] / l) * sg, (q[2] / l) * sg, (q[3] / l) * sg];
}
