// 쓰러진 자세 특징 벡터와 포즈 매칭 (SPEC 12 v0.7 '자세 분류와 포즈 매칭'). 정의: docs/ALGORITHMS.md v0.7.
// - 특징: Hips 위쪽 축(로컬 +Y = 척추 방향)과 앞쪽 축(로컬 +Z = 배 방향)의 월드 방향, Hips 기준 각 바디의 상대 위치(월드 축, 회전 안 함),
//   팔다리(전완·정강이)가 몸통 아래에 깔렸는지(0/1).
// - 비교: 수평 회전(yaw)만 다른 같은 자세는 같은 자세다. 비용 = min_ψ Σ w_b |R_y(ψ)·a_b − c_b|² + w_axis(|Rψ·up_a − up_c|² + |Rψ·fwd_a − fwd_c|²)
//   + w_pin·Σ|pin_a − pin_c|. ψ는 닫힌 식(Procrustes, Y축 회전)으로 구한다.
// - 분류(로그·필름 표시): 앞쪽 축 y > 0.5 → 누움(supine), < −0.5 → 엎드림(prone), 그 밖 옆(side). 위쪽 축 y > 0.6이면 앉음(sit).
import type { CharacterDef, BodyName } from './characterDef';
import type { BodyTransform } from './pose';
import { type Vec3, sub } from '../math/vec3';
import { rotate } from '../math/quat';

export type PostureClass = 'supine' | 'prone' | 'side' | 'sit';

export interface PoseFeature {
  /** Hips 로컬 +Y(척추 쪽) 월드 방향 */
  up: Vec3;
  /** Hips 로컬 +Z(배 쪽) 월드 방향 */
  fwd: Vec3;
  /** 바디 원점 − Hips 원점 (월드 축, def.bodies 순서) */
  rel: Vec3[];
  /** 몸통 아래에 깔림: [LeftForeArm, RightForeArm, LeftLeg, RightLeg] */
  pinned: number[];
}

export interface MatchWeights { body: number; axis: number; pinned: number }

export const PIN_BODIES: BodyName[] = ['LeftForeArm', 'RightForeArm', 'LeftLeg', 'RightLeg'];

export function classifyFeature(f: PoseFeature): PostureClass {
  if (f.up[1] > 0.6) return 'sit';
  return f.fwd[1] > 0.5 ? 'supine' : f.fwd[1] < -0.5 ? 'prone' : 'side';
}

export const POSTURE_KO: Record<PostureClass, string> = { supine: '누움', prone: '엎드림', side: '옆', sit: '앉음' };

/** 바디 월드 자세(def.bodies 순서) → 특징 */
export function poseFeature(def: CharacterDef, tf: readonly BodyTransform[]): PoseFeature {
  const hi = 0;
  const h = tf[hi]!;
  const up = rotate(h.rot, [0, 1, 0]), fwd = rotate(h.rot, [0, 0, 1]);
  const rel = tf.map((b) => sub(b.pos, h.pos));
  const idx = (n: BodyName) => def.bodies.findIndex((b) => b.name === n);
  const a = tf[idx('Hips')]!.pos, b = tf[idx('Spine2')]!.pos;
  const pinned = PIN_BODIES.map((n) => {
    const p = tf[idx(n)]!.pos;
    // 몸통 선분(Hips→Spine2)의 수평 최근접점
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const L2 = dx * dx + dz * dz;
    const s = L2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / L2)) : 0;
    const q: Vec3 = [a[0] + dx * s, a[1] + (b[1] - a[1]) * s, a[2] + dz * s];
    const hd = Math.hypot(p[0] - q[0], p[2] - q[2]);
    return hd < 0.14 && p[1] < q[1] - 0.03 ? 1 : 0;
  });
  return { up, fwd, rel, pinned };
}

const rotY = (v: Readonly<Vec3>, c: number, s: number): Vec3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];

/**
 * a(지금 자세)를 c(클립 첫 프레임)에 맞추는 Y축 회전 ψ와 비용.
 * ψ: R_y(ψ)·a ≈ c (x' = x cosψ + z sinψ, z' = −x sinψ + z cosψ)
 */
export function matchFeature(a: PoseFeature, c: PoseFeature, w: MatchWeights): { yaw: number; cost: number } {
  let C = 0, S = 0;
  const acc = (p: Readonly<Vec3>, q: Readonly<Vec3>, k: number) => { C += k * (p[0] * q[0] + p[2] * q[2]); S += k * (p[2] * q[0] - p[0] * q[2]); };
  a.rel.forEach((p, i) => acc(p, c.rel[i]!, w.body));
  acc(a.up, c.up, w.axis);
  acc(a.fwd, c.fwd, w.axis);
  const yaw = Math.atan2(S, C);
  const co = Math.cos(yaw), si = Math.sin(yaw);
  let cost = 0;
  const d2 = (p: Readonly<Vec3>, q: Readonly<Vec3>) => { const r = rotY(p, co, si); return (r[0] - q[0]) ** 2 + (r[1] - q[1]) ** 2 + (r[2] - q[2]) ** 2; };
  a.rel.forEach((p, i) => { cost += w.body * d2(p, c.rel[i]!); });
  cost += w.axis * (d2(a.up, c.up) + d2(a.fwd, c.fwd));
  a.pinned.forEach((x, i) => { cost += w.pinned * Math.abs(x - (c.pinned[i] ?? 0)); });
  return { yaw, cost };
}

/** 특징을 Y축으로 ψ 돌린 것 (정규화 저장용) */
export function rotateFeature(f: PoseFeature, yaw: number): PoseFeature {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { up: rotY(f.up, c, s), fwd: rotY(f.fwd, c, s), rel: f.rel.map((p) => rotY(p, c, s)), pinned: [...f.pinned] };
}
