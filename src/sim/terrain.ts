// 지형 정의 (v0.3 경사, v0.8a 계단·모서리·상자 장애물, v0.8b 난간·벽·잡을 곳). 순수 데이터·함수 — Rapier(world.ts)와 three.js 렌더(scene.ts)가 같은 정의로 만든다.
// 좌표: Y 위, 정면 +Z. 값은 config/sim.json terrain. 정의: docs/ALGORITHMS.md v0.8a '지형', v0.8b '잡을 곳·벽'.
import simCfg from '../../config/sim.json';
import type { Vec3 } from './math/vec3';

export const TERRAINS = ['flat', 'slope10', 'slope20', 'stairs', 'ledge', 'rail', 'wall', 'box_obstacle'] as const;
export type TerrainName = (typeof TERRAINS)[number];

/** 축 정렬 상자 (윗면이 디딜 수 있는 면). kind는 렌더 색·로그용 */
export interface TerrainBox {
  center: Vec3;
  half: Vec3;
  kind: 'step' | 'platform' | 'obstacle';
}

/**
 * (v0.8b) 지면이 아닌 지형 물체 (난간대·기둥·벽). 접촉은 지면 인지(ground)와 따로 센다 — 벽에 어깨가 닿아도 '쓰러짐'이 아니다.
 * rail·post = 두 점 a–b를 잇는 둥근 막대(캡슐, 반지름 radius), wall = 축 정렬 상자
 */
export type TerrainProp =
  | { kind: 'rail' | 'post'; a: Vec3; b: Vec3; radius: number; grabbable: boolean }
  | { kind: 'wall'; center: Vec3; half: Vec3; grabbable: false };

/** (v0.8b) 잡을 곳 (잡기 인지 대상, grabbable 태그): 선분 a–b (난간대 축, 또는 받침 윗모서리). edge면 inward = 윗면 안쪽 수평 방향(손바닥을 올려놓는 쪽) */
export interface GrabFeature { kind: 'rail' | 'edge'; a: Vec3; b: Vec3; radius: number; inward: Vec3 | null }

export interface TerrainDef {
  name: TerrainName;
  /** 바닥 판(평지·경사)의 기울기(도). 판은 원점을 지나고 +Z 쪽으로 올라간다 (y = tan(각)·z) */
  slopeDeg: number;
  /** 바닥 판 위에 놓인 상자들 (계단 단·모서리 받침·장애물) */
  boxes: TerrainBox[];
  /** (v0.8b) 지면이 아닌 물체 (난간대·기둥·벽) */
  props: TerrainProp[];
  /** (v0.8b) 잡을 곳 */
  grabs: GrabFeature[];
}

interface StairsCfg { rise: number; run: number; count: number; halfWidth: number; topLength: number; bottom: number }
interface LedgeCfg { height: number; halfWidth: number; topLength: number; bottom: number }
interface ObstacleCfg { center: Vec3; halfExtents: Vec3 }
interface RailCfg { x: number; height: number; radius: number; z0: number; z1: number; posts: number[]; postRadius: number }
interface WallCfg { z: number; thickness: number; height: number; halfWidth: number }
interface TerrainCfg { slopeDeg: Record<string, number>; stairs?: StairsCfg; ledge?: LedgeCfg; boxObstacle?: ObstacleCfg; ledgeGrabEdge?: boolean; rail?: RailCfg; wall?: WallCfg }

const tcfg = simCfg.terrain as unknown as TerrainCfg;
const cache = new Map<string, TerrainDef>();

/**
 * 지형 정의. 평지·경사는 바닥 판만, 계단은 위 받침(z ≤ 0, 높이 count·rise) + 아래로 내려가는 단 count개(+Z 쪽),
 * 모서리(ledge)는 높이 height 받침(z ≤ 0)과 아래 바닥(y = 0), 상자 장애물은 바닥 위 상자 하나.
 * 계단 단 k(1..count−1)의 윗면 높이 = (count − k)·rise, 앞 끝 z = (k−1)·run (내려가는 높이 차 count번). 단 상자는 뒤쪽(받침 쪽, 더 높은 단 밑)으로 이어 붙여(겹침)
 * 디딤면에 상자 이음매가 생기지 않게 한다 (Rapier 내부 모서리 접촉 방지).
 * (v0.8b) 난간(rail): 평지 + 진행 방향(Z)을 따라 놓인 난간대(잡을 곳)와 끝 기둥. 벽(wall): 평지 + 정면 앞 벽. 모서리 받침의 앞 윗모서리는 잡을 곳.
 */
export function terrainDef(name: TerrainName = 'flat'): TerrainDef {
  const hit = cache.get(name);
  if (hit) return hit;
  const slope = tcfg.slopeDeg[name];
  const boxes: TerrainBox[] = [];
  const props: TerrainProp[] = [];
  const grabs: GrabFeature[] = [];
  if (name === 'stairs') {
    const s = tcfg.stairs!;
    const H = s.count * s.rise;
    // 위 받침: z ∈ [−topLength, 0], 윗면 H. 단 k: z ∈ [0, k·run] (뒤쪽 = 더 높은 단 밑으로 이어 붙임), 윗면 H − k·rise. z ≥ (count−1)·run은 바닥(0)
    boxes.push(box([-s.halfWidth, s.bottom, -s.topLength], [s.halfWidth, H, 0], 'platform'));
    for (let k = 1; k < s.count; k++) boxes.push(box([-s.halfWidth, s.bottom, 0], [s.halfWidth, H - k * s.rise, k * s.run], 'step'));
  } else if (name === 'ledge') {
    const l = tcfg.ledge!;
    boxes.push(box([-l.halfWidth, l.bottom, -l.topLength], [l.halfWidth, l.height, 0], 'platform'));
    // (v0.8b) 앞 윗모서리를 잡을 곳으로 (손바닥은 윗면 안쪽 −Z에 올린다)
    if (tcfg.ledgeGrabEdge) grabs.push({ kind: 'edge', a: [-l.halfWidth, l.height, 0], b: [l.halfWidth, l.height, 0], radius: 0, inward: [0, 0, -1] });
  } else if (name === 'rail') {
    const r = tcfg.rail!;
    const bar: TerrainProp = { kind: 'rail', a: [r.x, r.height, r.z0], b: [r.x, r.height, r.z1], radius: r.radius, grabbable: true };
    props.push(bar);
    grabs.push({ kind: 'rail', a: bar.a, b: bar.b, radius: r.radius, inward: null });
    for (const z of r.posts) props.push({ kind: 'post', a: [r.x, 0, z], b: [r.x, r.height, z], radius: r.postRadius, grabbable: false });
  } else if (name === 'wall') {
    const w = tcfg.wall!;
    props.push({ kind: 'wall', center: [0, w.height / 2, w.z + w.thickness / 2], half: [w.halfWidth, w.height / 2, w.thickness / 2], grabbable: false });
  } else if (name === 'box_obstacle') {
    const o = tcfg.boxObstacle!;
    boxes.push({ center: [...o.center] as Vec3, half: [...o.halfExtents] as Vec3, kind: 'obstacle' });
  } else if (name !== 'flat' && slope === undefined) {
    throw new Error(`terrain '${name}' is not implemented yet (v0.8b: flat, slope10, slope20, stairs, ledge, box_obstacle, rail, wall)`);
  }
  const def: TerrainDef = { name, slopeDeg: slope ?? 0, boxes, props, grabs };
  cache.set(name, def);
  return def;
}

/** 두 모서리 점(min, max)으로 상자 */
function box(min: Vec3, max: Vec3, kind: TerrainBox['kind']): TerrainBox {
  return { center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2], kind };
}

/** 바닥 판 높이 (경사면 y = tan(각)·z) */
export function baseHeightAt(def: TerrainDef, z: number): number {
  return def.slopeDeg ? Math.tan((def.slopeDeg * Math.PI) / 180) * z : 0;
}

/**
 * (x, z) 위 지면 높이 = 바닥 판과 그 점을 덮는 상자 윗면 중 가장 높은 것. 평지는 정확히 0. 난간·벽(props)은 지면이 아니다.
 * (레이캐스트 없이 쓰는 해석식: 자세 판정의 '지면 위 높이', 렌더. 인지(perception)는 레이캐스트를 쓴다)
 */
export function terrainHeightAt(def: TerrainDef, x: number, z: number): number {
  let h = baseHeightAt(def, z);
  for (const b of def.boxes) {
    if (Math.abs(x - b.center[0]) <= b.half[0] && Math.abs(z - b.center[2]) <= b.half[2]) h = Math.max(h, b.center[1] + b.half[1]);
  }
  return h;
}

/** 평지(상자 없음, 경사 0)인가 — 이전 마일스톤 경로를 그대로 두는 판단에 쓴다. (v0.8b) 난간·벽은 지면이 아니라 넣지 않는다(평지 + 난간 = 평지 경로) */
export function isFlatTerrain(def: TerrainDef): boolean {
  return def.slopeDeg === 0 && def.boxes.length === 0;
}

/** (v0.8b) 선분 a–b 위에서 점 p에 가장 가까운 점 */
export function closestOnSegment(a: Readonly<Vec3>, b: Readonly<Vec3>, p: Readonly<Vec3>): Vec3 {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const s = L2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / L2)) : 0;
  return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
}
