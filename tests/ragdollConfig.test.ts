// config/characters/xbot.json 검증 (SPEC 6, 12장 v0.1 완료 기준).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CharacterDef, BodyDef } from '../src/sim/character/characterDef';
import { type Vec3, add, sub, distance, normalize, dot } from '../src/sim/math/vec3';
import { type Quat, rotate, multiplyQ, angleBetweenQ, fromAxisAngle } from '../src/sim/math/quat';
import { readFbxSkeleton, type FbxSkeletonData } from '../tools/fbx/loadFbx';
import { buildCharacter, type GenConfig } from '../tools/ragdoll/build';
import { applyOverrides, deepMerge } from '../tools/ragdoll/merge';

const FBX = 'assets/fbx/X Bot.fbx';
const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const byName = new Map(def.bodies.map((b) => [b.name, b] as const));
const body = (n: string): BodyDef => byName.get(n as BodyDef['name'])!;
const toWorld = (b: BodyDef, local: Vec3): Vec3 => add(b.restPosition, rotate(b.restRotation, local));
const sides = ['Left', 'Right'] as const;

let skel: FbxSkeletonData;
beforeAll(() => { skel = readFbxSkeleton(FBX, { withSkin: true }); }, 120_000);

describe('xbot.json structure', () => {
  it('16 bodies with Mixamo names, no clavicle', () => {
    const names = ['Hips', 'Spine', 'Spine2', 'Head', ...sides.flatMap((s) => ['Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot'].map((p) => s + p))];
    expect(def.bodies.map((b) => b.name).sort()).toEqual(names.sort());
    expect(byName.has('LeftShoulder' as never)).toBe(false);
  });

  it('parent graph is a tree rooted at Hips (SPEC 6.1)', () => {
    const roots = def.bodies.filter((b) => b.parent === null);
    expect(roots.map((b) => b.name)).toEqual(['Hips']);
    for (const b of def.bodies) {
      const seen = new Set<string>();
      let cur: BodyDef | undefined = b;
      while (cur && cur.parent) {
        expect(seen.has(cur.name)).toBe(false);
        seen.add(cur.name);
        cur = byName.get(cur.parent);
        expect(cur).toBeDefined();
      }
      expect(cur!.name).toBe('Hips');
      expect(b.joint === null).toBe(b.parent === null);
    }
    const expectedParent: Record<string, string> = { Spine: 'Hips', Spine2: 'Spine', Head: 'Spine2' };
    for (const s of sides) Object.assign(expectedParent, {
      [s + 'Arm']: 'Spine2', [s + 'ForeArm']: s + 'Arm', [s + 'Hand']: s + 'ForeArm',
      [s + 'UpLeg']: 'Hips', [s + 'Leg']: s + 'UpLeg', [s + 'Foot']: s + 'Leg',
    });
    for (const [c, p] of Object.entries(expectedParent)) expect(body(c).parent).toBe(p);
  });

  it('total mass 75 ± 0.1 kg and ratios per SPEC 6.1', () => {
    const sum = def.bodies.reduce((s, b) => s + b.massRatio * def.totalMass, 0);
    expect(def.totalMass).toBe(75);
    expect(Math.abs(sum - 75)).toBeLessThanOrEqual(0.1);
    const ratio: Record<string, number> = { Hips: 0.112, Spine: 0.163, Spine2: 0.16, Head: 0.069, Arm: 0.027, ForeArm: 0.016, Hand: 0.006, UpLeg: 0.142, Leg: 0.043, Foot: 0.014 };
    for (const b of def.bodies) expect(b.massRatio).toBeCloseTo(ratio[b.name.replace(/^(Left|Right)/, '')]!, 6);
  });

  it('joint limits match SPEC 6.3', () => {
    const spec: Record<string, object> = {
      Spine: { flex: [-20, 35], side: [-25, 25], twist: [-25, 25] },
      Spine2: { flex: [-20, 35], side: [-25, 25], twist: [-25, 25] },
      Head: { flex: [-40, 50], side: [-35, 35], twist: [-60, 60] },
      Arm: { swingCone: 100, twist: [-70, 70] },
      ForeArm: { flex: [0, 145] },
      // 손목 twist ±90 = 전완 회내·회외 ±80 (SPEC 6.3 2026-10-26) + 손목 ±10. 물리는 회내·회외를 손목 관절 twist로 받는다 (README 결정 72)
      Hand: { flex: [-60, 60], side: [-30, 30], twist: [-90, 90] },
      UpLeg: { flex: [-20, 110], side: [-40, 40], twist: [-35, 35] },
      Leg: { flex: [0, 140] },
      Foot: { flex: [-40, 25], side: [-20, 20], twist: [-15, 15] },
    };
    for (const b of def.bodies) {
      if (!b.joint) continue;
      expect(b.joint.limitsDeg).toEqual(spec[b.name.replace(/^(Left|Right)/, '')]);
      const hinge = /ForeArm|Leg$/.test(b.name) && !/UpLeg/.test(b.name);
      expect(b.joint.type).toBe(hinge ? 'hinge' : 'spherical');
    }
  });

  it('shapes: capsule limbs/torso, sphere head, flat-soled ~0.25 m box feet, friction', () => {
    for (const b of def.bodies) {
      const t = b.name === 'Head' ? 'sphere' : /Foot$/.test(b.name) ? 'box' : 'capsule';
      expect(b.shape.type).toBe(t);
      expect(b.friction).toBe(/Foot$/.test(b.name) ? 1.0 : /Hand$/.test(b.name) ? 0.9 : 0.6);
    }
    for (const s of sides) {
      const f = body(s + 'Foot');
      if (f.shape.type !== 'box') throw new Error('foot not box');
      expect(f.restRotation).toEqual([0, 0, 0, 1]);
      expect(f.shape.halfExtents[2] * 2).toBeGreaterThan(0.22);
      expect(f.shape.halfExtents[2] * 2).toBeLessThan(0.28);
      expect(Math.abs(f.restPosition[1] - f.shape.halfExtents[1])).toBeLessThan(0.005); // 발바닥 y ≈ 0
    }
    // Hips 반폭 ≤ 0.14 (팔 여유, docs/RAGDOLL_CONFIG.md)
    const h = body('Hips').shape;
    if (h.type !== 'capsule') throw new Error('hips not capsule');
    expect(h.radius + h.halfHeight).toBeLessThanOrEqual(0.1401);
  });
});

describe('xbot.json joints vs X Bot skeleton', () => {
  /** SPEC 11.2 + 관절 위치 본: 관절은 자식 바디가 시작하는 본에 있다. */
  const jointBone = (n: string) => ({ Spine: 'Spine', Spine2: 'Spine2', Head: 'Neck' } as Record<string, string>)[n] ?? n;

  /** 바인드 T-포즈 본 위치에 A포즈(팔 사슬을 어깨 중심 Z축 회전)를 독립적으로 적용 */
  function posedBone(name: string): Vec3 {
    const p = skel.bones.find((b) => b.name === name)!.worldPos;
    for (const s of sides) {
      if (!name.startsWith(s + 'Arm') && !name.startsWith(s + 'ForeArm') && !name.startsWith(s + 'Hand')) continue;
      const pivot = skel.bones.find((b) => b.name === s + 'Arm')!.worldPos;
      const phi = ((s === 'Left' ? -1 : 1) * def.restPose.armDownDeg * Math.PI) / 180;
      const dx = p[0] - pivot[0], dy = p[1] - pivot[1];
      return [pivot[0] + dx * Math.cos(phi) - dy * Math.sin(phi), pivot[1] + dx * Math.sin(phi) + dy * Math.cos(phi), p[2]];
    }
    return p;
  }

  it('every joint anchor is within 1 cm of the X Bot bone (both parent and child side)', () => {
    for (const b of def.bodies) {
      if (!b.joint) continue;
      const expected = posedBone(jointBone(b.name));
      const fromChild = toWorld(b, b.joint.anchorInChild);
      const fromParent = toWorld(body(b.parent!), b.joint.anchorInParent);
      expect(distance(fromChild, expected), b.name).toBeLessThan(0.01);
      expect(distance(fromParent, expected), b.name).toBeLessThan(0.01);
      expect(distance(fromParent, fromChild), b.name).toBeLessThan(1e-4);
    }
  });

  it('A-pose: arms hang armDownDeg below horizontal, legs/torso unrotated', () => {
    for (const s of sides) {
      const dir = normalize(sub(posedBone(s + 'ForeArm'), posedBone(s + 'Arm')));
      expect((Math.asin(-dir[1]) * 180) / Math.PI).toBeCloseTo(def.restPose.armDownDeg, 1);
    }
    for (const n of ['Hips', 'Spine', 'Spine2', 'Head', 'LeftUpLeg', 'RightLeg']) expect(body(n).restRotation).toEqual([0, 0, 0, 1]);
  });

  it('joint frames coincide at rest (relative rest rotation = identity)', () => {
    for (const b of def.bodies) {
      if (!b.joint) continue;
      const wp = multiplyQ(body(b.parent!).restRotation, b.joint.frameInParent);
      const wc = multiplyQ(b.restRotation, b.joint.frameInChild);
      expect(angleBetweenQ(wp, wc), b.name).toBeLessThan(1e-4);
      // 관절 좌표계 X = flex 축 (월드)
      const x = rotate(wc, [1, 0, 0]);
      expect(dot(x, b.joint.axesWorld.flex), b.name).toBeGreaterThan(0.9999);
    }
  });

  it('positive flex bends the anatomically correct way (knee back, elbow forward, hip forward, ...)', () => {
    // 자식 분절 방향을 +flex(30°)만큼 돌렸을 때 움직여야 하는 방향
    const cases: [string, string, string, Vec3][] = [
      ['Spine', 'Spine', 'Spine2', [0, 0, 1]], ['Head', 'Neck', 'HeadTop_End', [0, 0, 1]],
      ['LeftUpLeg', 'LeftUpLeg', 'LeftLeg', [0, 0, 1]], ['RightUpLeg', 'RightUpLeg', 'RightLeg', [0, 0, 1]],
      ['LeftLeg', 'LeftLeg', 'LeftFoot', [0, 0, -1]], ['RightLeg', 'RightLeg', 'RightFoot', [0, 0, -1]],
      ['LeftForeArm', 'LeftForeArm', 'LeftHand', [0, 0, 1]], ['RightForeArm', 'RightForeArm', 'RightHand', [0, 0, 1]],
      ['LeftFoot', 'LeftFoot', 'LeftToe_End', [0, 1, 0]], ['RightFoot', 'RightFoot', 'RightToe_End', [0, 1, 0]],
    ];
    for (const [n, a, c, want] of cases) {
      const seg = normalize(sub(posedBone(c), posedBone(a)));
      const q: Quat = fromAxisAngle(body(n).joint!.axesWorld.flex, (30 * Math.PI) / 180);
      const moved = sub(rotate(q, seg), seg);
      expect(dot(moved, want), n).toBeGreaterThan(0.1);
    }
  });

  it('shoulder swing-cone axis = bind-pose arm direction (lateral) and contains the A-pose rest', () => {
    for (const s of sides) {
      const j = body(s + 'Arm').joint!;
      expect(j.coneAxisInParent![0]).toBeCloseTo(s === 'Left' ? 1 : -1, 4);
      expect(def.restPose.armDownDeg).toBeLessThan(j.limitsDeg.swingCone!);
    }
  });

  it('committed xbot.json is up to date with the generator', () => {
    const cfg = JSON.parse(readFileSync('config/genRagdoll.json', 'utf8')) as GenConfig;
    const ovPath = 'config/characters/xbot.overrides.json';
    const regenerated = applyOverrides(buildCharacter(skel, cfg), JSON.parse(readFileSync(ovPath, 'utf8')), ovPath);
    expect(JSON.parse(JSON.stringify(regenerated))).toEqual(def);
  });
});

describe('overrides merge', () => {
  it('deep-merges by body name; arrays replace; $comment ignored; unknown body throws', () => {
    const merged = applyOverrides(def, { $comment: 'x', bodies: { Hips: { shape: { radius: 0.12 } as never, friction: 0.7 } } }, 'ov.json');
    const h = merged.bodies.find((b) => b.name === 'Hips')!;
    expect(h.shape.type).toBe('capsule');
    expect((h.shape as { radius: number }).radius).toBe(0.12);
    expect((h.shape as { halfHeight: number }).halfHeight).toBe((body('Hips').shape as { halfHeight: number }).halfHeight);
    expect(h.friction).toBe(0.7);
    expect('$comment' in merged).toBe(false);
    expect(merged.generator.overrides).toBe('ov.json');
    expect(body('Hips').friction).toBe(0.6); // 원본 불변
    expect(deepMerge({ a: [1, 2, 3], b: { c: 1 } }, { a: [9] })).toEqual({ a: [9], b: { c: 1 } });
    expect(() => applyOverrides(def, { bodies: { LeftShoulder: {} } }, null)).toThrow();
  });
});
