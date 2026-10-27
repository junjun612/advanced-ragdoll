import { describe, it, expect } from 'vitest';
import {
  type Vec3, type Quat, add, length, normalize, distance, cross, dot, angleBetween,
  identityQ, multiplyQ, inverseQ, conjugate, rotate, fromAxisAngle, toAxisAngle, fromRotationVector, toRotationVector,
  fromTo, slerp, angleBetweenQ, swingTwist, twistAngle, normalizeQ,
  fromQuat, toQuat, mulVec3, multiply3, inverse3, transpose3, identity3, determinant3,
  convexHull, signedDistanceToPolygon, polygonArea, pointInConvexPolygon,
  twoBoneAngles, solveTwoBone,
} from '../src/sim/math';
import { Prng } from '../src/sim/prng';

const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, digits));
/** q와 -q는 같은 회전 */
const sameRot = (a: Quat, b: Quat) => expect(angleBetweenQ(a, b)).toBeLessThan(1e-6);

const rng = new Prng(1234);
const randUnitQuat = (): Quat => normalizeQ([rng.normal(), rng.normal(), rng.normal(), rng.normal()]);
const randVec = (): Vec3 => [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];

describe('vec3', () => {
  it('cross/dot/normalize basics', () => {
    close(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(length(normalize([3, 4, 12]))).toBeCloseTo(1, 12);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
    expect(angleBetween([1, 0, 0], [0, 0, 1])).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('quat', () => {
  it('rotate follows right-hand rule (90° about +X sends +Y to +Z)', () => {
    close(rotate(fromAxisAngle([1, 0, 0], Math.PI / 2), [0, 1, 0]), [0, 0, 1]);
    close(rotate(fromAxisAngle([0, 1, 0], Math.PI / 2), [0, 0, 1]), [1, 0, 0]);
  });
  it('multiplyQ composes right-to-left', () => {
    for (let i = 0; i < 50; i++) {
      const a = randUnitQuat(), b = randUnitQuat(), v = randVec();
      close(rotate(multiplyQ(a, b), v), rotate(a, rotate(b, v)));
    }
  });
  it('inverse/conjugate round trip', () => {
    for (let i = 0; i < 50; i++) {
      const q = randUnitQuat(), v = randVec();
      close(rotate(inverseQ(q), rotate(q, v)), v);
      sameRot(multiplyQ(q, conjugate(q)), identityQ());
    }
  });
  it('axis-angle round trip', () => {
    for (let i = 0; i < 50; i++) {
      const axis = normalize(randVec()), angle = rng.range(0.01, Math.PI - 0.01);
      const r = toAxisAngle(fromAxisAngle(axis, angle));
      expect(r.angle).toBeCloseTo(angle, 9);
      close(r.axis, axis);
      const q = randUnitQuat();
      sameRot(fromRotationVector(toRotationVector(q)), q);
    }
    expect(toAxisAngle(identityQ()).angle).toBe(0);
  });
  it('quat <-> mat3 round trip and agreement', () => {
    for (let i = 0; i < 50; i++) {
      const q = randUnitQuat(), v = randVec();
      const m = fromQuat(q);
      close(mulVec3(m, v), rotate(q, v));
      sameRot(toQuat(m), q);
      expect(determinant3(m)).toBeCloseTo(1, 9);
      close(multiply3(m, transpose3(m)), identity3());
      close(inverse3(m)!, transpose3(m));
    }
    // 180° 회전 (trace < 0 분기)
    for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]] as Vec3[]) {
      sameRot(toQuat(fromQuat(fromAxisAngle(ax, Math.PI))), fromAxisAngle(ax, Math.PI));
    }
  });
  it('fromTo maps a onto b, including opposite vectors', () => {
    for (let i = 0; i < 50; i++) {
      const a = normalize(randVec()), b = normalize(randVec());
      close(rotate(fromTo(a, b), a), b);
    }
    close(rotate(fromTo([0, 1, 0], [0, -1, 0]), [0, 1, 0]), [0, -1, 0]);
  });
  it('slerp: endpoints, midpoint, shortest path', () => {
    const a = fromAxisAngle([0, 0, 1], 0.2), b = fromAxisAngle([0, 0, 1], 1.4);
    sameRot(slerp(a, b, 0), a);
    sameRot(slerp(a, b, 1), b);
    sameRot(slerp(a, b, 0.5), fromAxisAngle([0, 0, 1], 0.8));
    const negB: Quat = [-b[0], -b[1], -b[2], -b[3]];
    sameRot(slerp(a, negB, 0.5), fromAxisAngle([0, 0, 1], 0.8));
  });
  it('swing-twist: q = swing*twist, twist about axis, swing perpendicular', () => {
    for (let i = 0; i < 100; i++) {
      const q = randUnitQuat(), axis = normalize(randVec());
      const { swing, twist } = swingTwist(q, axis);
      sameRot(multiplyQ(swing, twist), q);
      expect(length(cross([twist[0], twist[1], twist[2]], axis))).toBeLessThan(1e-9);
      expect(Math.abs(dot([swing[0], swing[1], swing[2]], axis))).toBeLessThan(1e-9);
    }
    // 알려진 분해: Y축 0.7 비틀기 뒤 X축 0.4 스윙
    const q = multiplyQ(fromAxisAngle([1, 0, 0], 0.4), fromAxisAngle([0, 1, 0], 0.7));
    expect(twistAngle(q, [0, 1, 0])).toBeCloseTo(0.7, 9);
    sameRot(swingTwist(q, [0, 1, 0]).swing, fromAxisAngle([1, 0, 0], 0.4));
    expect(twistAngle(fromAxisAngle([0, 1, 0], -1.2), [0, 1, 0])).toBeCloseTo(-1.2, 9);
  });
});

describe('geometry', () => {
  it('convex hull drops interior and collinear points, CCW', () => {
    const hull = convexHull([[0, 0], [2, 0], [1, 0], [2, 2], [0, 2], [1, 1], [0.5, 1.5], [0, 1]]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(4, 12);
    expect(convexHull([[1, 1], [1, 1]])).toEqual([[1, 1]]);
    expect(convexHull([])).toEqual([]);
  });
  it('hull contains all random points', () => {
    const pts = Array.from({ length: 200 }, (): [number, number] => [rng.normal(), rng.normal()]);
    const hull = convexHull(pts);
    for (const p of pts) expect(signedDistanceToPolygon(p, hull)).toBeLessThanOrEqual(1e-12);
  });
  it('signed distance: negative inside, positive outside', () => {
    const sq = convexHull([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(signedDistanceToPolygon([1, 1], sq)).toBeCloseTo(-1, 12);
    expect(signedDistanceToPolygon([1.5, 1], sq)).toBeCloseTo(-0.5, 12);
    expect(signedDistanceToPolygon([3, 1], sq)).toBeCloseTo(1, 12);
    expect(signedDistanceToPolygon([3, 3], sq)).toBeCloseTo(Math.SQRT2, 12);
    expect(signedDistanceToPolygon([2, 1], sq)).toBeCloseTo(0, 12);
    expect(pointInConvexPolygon([1, 1], sq)).toBe(true);
    // 선분·점 다각형 (한 발 접촉 등)
    expect(signedDistanceToPolygon([1, 1], [[0, 0], [2, 0]])).toBeCloseTo(1, 12);
    expect(signedDistanceToPolygon([3, 4], [[0, 0]])).toBeCloseTo(5, 12);
  });
});

describe('two-bone IK', () => {
  it('reaches reachable targets with correct link lengths', () => {
    const root: Vec3 = [0.15, 1.44, -0.05], l1 = 0.278, l2 = 0.336;
    for (let i = 0; i < 100; i++) {
      const dir = normalize(randVec()), d = rng.range(Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
      const target = add(root, [dir[0] * d, dir[1] * d, dir[2] * d]);
      const r = solveTwoBone(root, target, l1, l2, [0, 0, -1]);
      expect(r.reachable).toBe(true);
      expect(distance(r.end, target)).toBeLessThan(1e-9);
      expect(distance(root, r.mid)).toBeCloseTo(l1, 9);
      expect(distance(r.mid, r.end)).toBeCloseTo(l2, 9);
    }
  });
  it('bends toward pole and clamps unreachable targets', () => {
    const r = solveTwoBone([0, 0, 0], [0, -0.5, 0], 0.4, 0.4, [0, 0, 1]);
    expect(r.mid[2]).toBeGreaterThan(0);
    const far = solveTwoBone([0, 0, 0], [0, 0, 2], 0.4, 0.4, [0, 1, 0]);
    expect(far.reachable).toBe(false);
    close(far.end, [0, 0, 0.8]);
    expect(far.bend).toBeCloseTo(0, 6);
    // 코사인 법칙: 정삼각형이면 굽힘 120°
    expect(twoBoneAngles(1, 1, 1).bend).toBeCloseTo((2 * Math.PI) / 3, 12);
  });
});
