// 해석적 2링크 IK (어깨-팔꿈치-손, 고관절-무릎-발목).
import { type Vec3, add, sub, scale, length, normalize, projectOnPlane, anyPerpendicular } from './vec3';

/**
 * 거리 d에 대해 두 링크(l1, l2)의 각을 코사인 법칙으로 구한다.
 * - rootAngle: 뿌리→목표 방향과 첫 링크 사이 각(라디안)
 * - bend: 가운데 관절 굽힘 각(0 = 완전히 펴짐, π = 완전히 접힘)
 * d는 [|l1-l2|, l1+l2] 범위로 잘라서 계산하고, 잘렸으면 reachable = false.
 */
export function twoBoneAngles(l1: number, l2: number, d: number): { rootAngle: number; bend: number; reachable: boolean; dClamped: number } {
  const lo = Math.abs(l1 - l2), hi = l1 + l2;
  const dc = Math.min(hi, Math.max(lo, d));
  const clampCos = (c: number) => Math.min(1, Math.max(-1, c));
  const rootAngle = dc > 0 ? Math.acos(clampCos((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc))) : 0;
  const inner = Math.acos(clampCos((l1 * l1 + l2 * l2 - dc * dc) / (2 * l1 * l2)));
  return { rootAngle, bend: Math.PI - inner, reachable: d >= lo - 1e-12 && d <= hi + 1e-12, dClamped: dc };
}

/**
 * 뿌리 위치, 목표, 링크 길이, 굽힘 방향 힌트(pole: 가운데 관절이 향할 방향, 월드)로 가운데 관절과 끝 위치를 구한다.
 * 목표에 닿지 않으면 목표 방향으로 최대한 뻗은(또는 접은) 끝 위치를 돌려준다.
 */
export function solveTwoBone(root: Readonly<Vec3>, target: Readonly<Vec3>, l1: number, l2: number, pole: Readonly<Vec3>): {
  mid: Vec3; end: Vec3; bend: number; reachable: boolean;
} {
  const toT = sub(target, root);
  const d = length(toT);
  const dir = d > 1e-12 ? scale(toT, 1 / d) : normalize(pole);
  let side = projectOnPlane(pole, dir);
  side = length(side) > 1e-9 ? normalize(side) : anyPerpendicular(dir);
  const { rootAngle, bend, reachable, dClamped } = twoBoneAngles(l1, l2, d);
  const mid = add(root, add(scale(dir, l1 * Math.cos(rootAngle)), scale(side, l1 * Math.sin(rootAngle))));
  const end = add(root, scale(dir, dClamped));
  return { mid, end, bend, reachable };
}
