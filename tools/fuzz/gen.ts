// 퍼징 실행 생성기 (SPEC 12 v0.9): 시드 하나 → 보통 시나리오 하나(지형·시작 상태·피격·두 번째 캐릭터·프롭).
// 무작위성은 prng.ts만 쓴다. 같은 시드·같은 generatorVersion(config/fuzz.json)이면 같은 시나리오가 나온다.
// 만든 시나리오는 그대로 JSON으로 남겨 sim·film으로 다시 돌릴 수 있다.
// (README 9f-6) 1.0 이후 학습형 추종기의 무작위 초기 상태 생성에도 쓴다: fuzzCase(시드, 설정)는 보통 Scenario를 돌려주고 runner에 의존하지 않는다.
// 설정(config/fuzz.json)을 바꾼 사본을 넘겨 분포(지형·시작 상태·피격)를 좁히거나 넓힌다. 감지기는 detect.ts(FuzzDetector).
import { readFileSync } from 'node:fs';
import { Prng } from '../../src/sim/prng';
import { terrainDef, terrainHeightAt, type TerrainName } from '../../src/sim/terrain';
import { fromAxisAngle, multiplyQ, rotate } from '../../src/sim/math/quat';
import type { Scenario, ScenarioEvent, ExtraCharacter } from '../../src/sim/scenario';
import type { SpawnOpts, HitInfo } from '../../src/sim/api';
import type { PropDef } from '../../src/sim/interaction';
import type { BodyName, Vec3 } from '../../src/sim/types';
import simCfg from '../../config/sim.json';
import fuzzCfg from '../../config/fuzz.json';
import hitModelCfg from '../../config/hitModel.json';
import xbot from '../../config/characters/xbot.json';

/** 바디 질량 비율 (첫 캐릭터 xbot) — 맞은 바디 속도 변화 상한(maxLocalDv)에 쓴다 */
const MASS_RATIO = Object.fromEntries(xbot.bodies.map((b) => [b.name, b.massRatio])) as Record<string, number>;

export type FuzzCfg = typeof fuzzCfg;
export type StartKind = keyof FuzzCfg['starts'];

interface Sample { id: string; posture: 'supine' | 'prone' | 'side'; bodies: { pos: Vec3; rot: [number, number, number, number] }[] }
let samples: Sample[] | null = null;
const lyingSamples = (): Sample[] => (samples ??= JSON.parse(readFileSync('assets/library/getup_samples.json', 'utf8')) as Sample[]);

const BODIES: BodyName[] = ['Hips', 'Spine', 'Spine2', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const REGIONS = ['all', 'upperBody', 'lowerBody', 'torso', 'neck', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

/** 퍼징 실행의 태그 (보고서 분류용) */
export interface FuzzTags {
  terrain: TerrainName;
  start: StartKind;
  hits: number;
  hitTypes: string[];
  second: StartKind | null;
  props: number;
  extras: string[];
}

export interface FuzzCase { seed: number; scenario: Scenario; tags: FuzzTags }

function pickWeighted<K extends string>(rng: Prng, w: Record<K, number>): K {
  const ks = Object.keys(w) as K[];
  const total = ks.reduce((a, k) => a + w[k], 0);
  let x = rng.float() * total;
  for (const k of ks) { x -= w[k]; if (x <= 0) return k; }
  return ks[ks.length - 1]!;
}
const u = (rng: Prng, r: readonly number[]) => r[0]! + (r[1]! - r[0]!) * rng.float();
const pick = <T>(rng: Prng, xs: readonly T[]): T => xs[Math.floor(rng.float() * xs.length) % xs.length]!;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const r3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];
const unitDir = (rng: Prng, vert: readonly number[]): Vec3 => {
  const a = rng.float() * 2 * Math.PI, y = u(rng, vert);
  const h = Math.sqrt(Math.max(0, 1 - y * y));
  return r3([Math.sin(a) * h, y, Math.cos(a) * h]);
};

/** 사람 위치·방향 (지형별 자리) */
interface Place { pos: Vec3; yaw: number; pose?: string; levelFeet?: boolean }

const T = simCfg.terrain;
/** 이 점 주변(반지름 r)이 디딜 수 있는 평평한 곳인가 (지면 높이가 같은가) */
function flatAround(t: TerrainName, x: number, z: number, r: number): boolean {
  const d = terrainDef(t);
  const h0 = terrainHeightAt(d, x, z);
  for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) if (Math.abs(terrainHeightAt(d, x + dx, z + dz) - h0) > 1e-6) return false;
  return true;
}
/** 점이 지형 물체(벽·난간·장애물 상자) 안이나 margin 안에 있는가 (지면 판·계단·받침 윗면은 제외) */
function insideObstacle(t: TerrainName, p: Readonly<Vec3>, margin: number): boolean {
  const d = terrainDef(t);
  for (const pr of d.props) {
    if (pr.kind === 'wall') {
      if (Math.abs(p[0] - pr.center[0]) < pr.half[0] + margin && Math.abs(p[1] - pr.center[1]) < pr.half[1] + margin && Math.abs(p[2] - pr.center[2]) < pr.half[2] + margin) return true;
    } else {
      // 막대: 수평 거리(난간대는 Z축, 기둥은 Y축) — 간단히 선분 거리
      const ab: Vec3 = [pr.b[0] - pr.a[0], pr.b[1] - pr.a[1], pr.b[2] - pr.a[2]];
      const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
      const s = Math.max(0, Math.min(1, ((p[0] - pr.a[0]) * ab[0] + (p[1] - pr.a[1]) * ab[1] + (p[2] - pr.a[2]) * ab[2]) / L2));
      const c = [pr.a[0] + ab[0] * s, pr.a[1] + ab[1] * s, pr.a[2] + ab[2] * s];
      if (Math.hypot(p[0] - c[0]!, p[1] - c[1]!, p[2] - c[2]!) < pr.radius + margin) return true;
    }
  }
  for (const b of d.boxes) if (b.kind === 'obstacle' && Math.abs(p[0] - b.center[0]) < b.half[0] + margin && Math.abs(p[2] - b.center[2]) < b.half[2] + margin && p[1] < b.center[1] + b.half[1] + margin) return true;
  return false;
}

/** 서기·걷기 시작 자리 (지형별). 경사는 경사 서기 포즈 */
function standPlace(rng: Prng, t: TerrainName, walking: boolean): Place {
  const yawAny = () => (rng.float() * 2 - 1) * Math.PI;
  const yawNear = (c: number, w: number) => c + (rng.float() * 2 - 1) * w;
  switch (t) {
    case 'slope10': return { pos: [0, -0.012, 0], yaw: 0, pose: 'stand_slope10', levelFeet: false };
    case 'slope20': return { pos: [0, -0.04, 0], yaw: Math.PI, pose: 'stand_slope20_down', levelFeet: false };
    case 'stairs': {
      const s = T.stairs, H = s.count * s.rise;
      const k = rng.float();
      if (walking) return k < 0.6 ? { pos: [u(rng, [-0.5, 0.5]), H, u(rng, [-2.0, -0.6])], yaw: yawNear(0, 0.3) } : { pos: [u(rng, [-0.5, 0.5]), 0, u(rng, [3.6, 4.5])], yaw: yawNear(Math.PI, 0.3) };
      if (k < 0.45) return { pos: [u(rng, [-0.5, 0.5]), H, u(rng, [-1.0, -0.3])], yaw: rng.float() < 0.6 ? yawNear(0, 0.5) : yawAny() };
      if (k < 0.75) return { pos: [u(rng, [-0.5, 0.5]), 0, u(rng, [3.0, 4.0])], yaw: yawAny() };
      // 중간 단 (디딤 가운데)
      const st = 1 + Math.floor(rng.float() * (s.count - 1));
      return { pos: [u(rng, [-0.5, 0.5]), H - st * s.rise, (st - 0.5) * s.run], yaw: rng.float() < 0.5 ? yawNear(0, 0.3) : yawNear(Math.PI, 0.3) };
    }
    case 'ledge': {
      const l = T.ledge;
      if (walking) return { pos: [u(rng, [-0.5, 0.5]), l.height, u(rng, [-2.5, -1.0])], yaw: yawNear(0, 0.5) };
      return rng.float() < 0.65 ? { pos: [u(rng, [-0.5, 0.5]), l.height, u(rng, [-1.5, -0.13])], yaw: yawAny() } : { pos: [u(rng, [-0.5, 0.5]), 0, u(rng, [0.4, 2.0])], yaw: yawAny() };
    }
    case 'rail': return walking ? { pos: [u(rng, [-0.35, -0.1]), 0, u(rng, [-2.5, -1.0])], yaw: yawNear(0, 0.25) } : { pos: [u(rng, [-0.3, 0.15]), 0, u(rng, [-2, 2])], yaw: yawAny() };
    case 'wall': return walking ? { pos: [u(rng, [-0.8, 0.8]), 0, u(rng, [-3.0, -1.2])], yaw: yawNear(0, 0.4) } : { pos: [u(rng, [-0.8, 0.8]), 0, u(rng, [-0.6, 0.45])], yaw: yawAny() };
    case 'box_obstacle': {
      if (walking) return { pos: [u(rng, [-0.4, 0.4]), 0, u(rng, [-1.0, 1.2])], yaw: yawNear(0, 0.3) };
      return rng.float() < 0.5 ? { pos: [u(rng, [-0.4, 0.4]), 0, u(rng, [2.1, 2.6])], yaw: yawAny() } : { pos: [u(rng, [-0.4, 0.4]), 0, u(rng, [3.4, 4.0])], yaw: yawAny() };
    }
    default: return { pos: [0, 0, 0], yaw: yawAny() };
  }
}

/** 누운 자세 바디(월드): 표본을 Hips 기준 yaw로 돌려 (x, z)에 놓고, 경사면이면 지면과 함께 기울인다 */
function lyingBodies(rng: Prng, t: TerrainName, x: number, z: number, yaw: number, s: Sample): { pos: Vec3; rot: [number, number, number, number] }[] {
  const h = s.bodies[0]!.pos;
  const qy = fromAxisAngle([0, 1, 0], yaw);
  const ground = terrainHeightAt(terrainDef(t), x, z);
  const slope = terrainDef(t).slopeDeg;
  // 경사: y = tan(θ)·z 판 = 평지를 X축 둘레로 −θ 돌린 것 (+Z가 위로)
  const qs = slope ? fromAxisAngle([1, 0, 0], (-slope * Math.PI) / 180) : null;
  void rng;
  return s.bodies.map((b) => {
    let p = rotate(qy, [b.pos[0] - h[0], b.pos[1], b.pos[2] - h[2]]);
    let q = multiplyQ(qy, b.rot);
    if (qs) { p = rotate(qs, p); q = multiplyQ(qs, q); }
    return { pos: r3([p[0] + x, p[1] + ground + 0.01, p[2] + z]).map((v, i) => (i === 1 ? round(v, 4) : v)) as Vec3, rot: q.map((v) => round(v, 5)) as [number, number, number, number] };
  });
}

/** 누운 자리 (평평한 곳, 바디가 지형 물체 밖) — 실패하면 null */
function lyingPlace(rng: Prng, t: TerrainName, s: Sample): { pos: Vec3; rot: [number, number, number, number] }[] | null {
  for (let i = 0; i < 20; i++) {
    let x = u(rng, [-0.6, 0.6]), z = u(rng, [-1, 1]);
    if (t === 'stairs') z = rng.float() < 0.5 ? u(rng, [-2.2, -1.0]) : u(rng, [4.0, 5.0]);
    else if (t === 'ledge') z = rng.float() < 0.6 ? u(rng, [-2.0, -0.9]) : u(rng, [1.0, 2.5]);
    else if (t === 'wall') z = u(rng, [-2.5, -0.2]);
    else if (t === 'rail') x = u(rng, [-1.2, -0.1]);
    else if (t === 'box_obstacle') z = rng.float() < 0.5 ? u(rng, [0.2, 1.6]) : u(rng, [4.2, 5.2]);
    const yaw = (rng.float() * 2 - 1) * Math.PI;
    const bodies = lyingBodies(rng, t, x, z, yaw, s);
    const slope = terrainDef(t).slopeDeg !== 0;
    const ok = bodies.every((b) => !insideObstacle(t, b.pos, 0.15) && (slope || flatAround(t, b.pos[0], b.pos[2], 0.15)));
    if (ok) return bodies;
  }
  return null;
}

/** 피격 하나 (시각 t, 대상 위치 c = 대략 몸 중심) */
function makeHit(rng: Prng, cfg: FuzzCfg, c: Readonly<Vec3>, lying: boolean): HitInfo {
  const type = pickWeighted(rng, cfg.hitTypes);
  const body = pick(rng, BODIES);
  if (type === 'explosion') {
    const e = cfg.explosion;
    const a = rng.float() * 2 * Math.PI, d = u(rng, e.distance);
    return { type, point: r3([c[0] + Math.sin(a) * d, c[1] + u(rng, e.height) - (lying ? 0 : 0), c[2] + Math.cos(a) * d]), direction: [0, 0, 0], magnitude: round(u(rng, e.magnitude), 2) };
  }
  // 맞은 바디 속도 변화 상한: 몫 × Δv / 질량 비율 ≤ maxLocalDv
  const cap = (dv: number, share: number, instant: boolean) => round(Math.min(dv, ((instant ? cfg.maxLocalDvInstant : cfg.maxLocalDv) * (MASS_RATIO[body] ?? 1)) / share), 3);
  if (type === 'push') {
    const p = cfg.push;
    const dur = pick(rng, p.durations);
    return { type, body, direction: unitDir(rng, p.vertical), magnitude: cap(u(rng, p.dv), 1, !dur), ...(dur ? { duration: dur } : {}) };
  }
  const k = type === 'bullet' ? cfg.bullet : cfg.melee;
  const dv = u(rng, k.dv);
  return { type, body, direction: unitDir(rng, k.vertical), magnitude: type === 'melee' ? cap(dv, hitModelCfg.melee.selfShare, true) : round(dv, 2) };
}

/** 시드 → 퍼징 실행 */
export function fuzzCase(seed: number, cfg: FuzzCfg = fuzzCfg): FuzzCase {
  const rng = new Prng(Math.imul(seed, 2654435761) ^ (cfg.generatorVersion * 7919));
  const terrain = pickWeighted(rng, cfg.terrains) as TerrainName;
  let start = pickWeighted(rng, cfg.starts);
  if (start === 'walk' && !cfg.walkTerrains.includes(terrain)) start = 'stand';
  if (start === 'idle' && terrain.startsWith('slope')) start = 'stand';
  const duration = round(u(rng, cfg.duration), 2);
  const events: ScenarioEvent[] = [];
  const extras: string[] = [];
  const lying = start === 'lying' || start === 'gettingUp';
  let spawn: SpawnOpts;
  let clip: string | null = 'stand';
  let center: Vec3;
  let lyingSpawn: { pos: Vec3 }[] | null = null;
  if (lying) {
    const s = pick(rng, lyingSamples());
    const bodies = lyingPlace(rng, terrain, s);
    if (bodies) {
      spawn = { position: [0, 0, 0], yaw: 0, state: 'Active', bodies };
      center = bodies[0]!.pos;
      lyingSpawn = bodies;
      extras.push(`lying:${s.posture}`);
    } else {
      start = 'stand';
    }
  }
  if (!lyingSpawn) {
    const pl = standPlace(rng, terrain, start === 'walk');
    if (start === 'walk') { spawn = { position: r3(pl.pos), yaw: round(pl.yaw, 4), state: 'Animated', pose: 'kimodo_walk_forward' }; clip = null; events.push({ t: 0.3, type: 'setState', state: 'Active' }); }
    else if (start === 'idle') { spawn = { position: r3(pl.pos), yaw: round(pl.yaw, 4), state: 'Active', pose: 'kimodo_idle_relaxed' }; clip = null; }
    else if (start === 'ragdoll') {
      // 근육 없는 T자 rest 자세(팔 너비 약 1.7m)로 떨어진다 — 벽·난간·장애물에서 팔 길이만큼 떨어진 자리로 (손이 벽 속에서 시작했다)
      const p0: Vec3 = [pl.pos[0], pl.pos[1] + u(rng, [0.3, 1.5]), pl.pos[2]];
      if (insideObstacle(terrain, [p0[0], p0[1] + 1.3, p0[2]], 0.95) || insideObstacle(terrain, [p0[0], p0[1] + 0.5, p0[2]], 0.95)) {
        if (terrain === 'wall') p0[2] = -1.5; else if (terrain === 'rail') p0[0] = -1.2; else if (terrain === 'box_obstacle') p0[2] = 1.0;
      }
      spawn = { position: r3(p0), yaw: round(pl.yaw, 4), state: 'Ragdoll' }; clip = null;
    }
    else spawn = { position: r3(pl.pos), yaw: round(pl.yaw, 4), state: 'Active', pose: pl.pose ?? 'stand', ...(pl.levelFeet === false ? { levelFeet: false } : {}) };
    center = [pl.pos[0], pl.pos[1] + 1.0, pl.pos[2]];
  }
  // 피격 (연속 피격 포함)
  const nHit = Math.floor(u(rng, [cfg.hitCount[0]!, cfg.hitCount[1]! + 1]));
  let t = start === 'gettingUp' ? u(rng, cfg.getupWindow) : u(rng, cfg.firstHit);
  const hitTypes: string[] = [];
  for (let i = 0; i < nHit && t < duration - 1; i++) {
    const h = makeHit(rng, cfg, center!, lying);
    hitTypes.push(h.type);
    events.push({ t: round(t, 3), type: 'hit', hit: h });
    t += rng.float() < cfg.burstProb ? u(rng, cfg.burstGap) : start === 'gettingUp' ? u(rng, [0.3, 1.5]) : u(rng, cfg.hitGap);
  }
  const tAny = () => round(u(rng, [0.5, Math.max(0.6, duration - 2)]), 3);
  if (rng.float() < cfg.deathProb) { events.push({ t: tAny(), type: 'trigger', behavior: 'Limp', params: { cause: 'death' } }); extras.push('death'); }
  if (rng.float() < cfg.kneelProb) { events.push({ t: tAny(), type: 'trigger', behavior: 'Kneel' }); extras.push('kneel'); }
  if (rng.float() < cfg.injuredLegProb) { events.push({ t: tAny(), type: 'trigger', behavior: 'InjuredLeg', params: { leg: rng.float() < 0.5 ? 'LeftUpLeg' : 'RightUpLeg' } }); extras.push('injuredLeg'); }
  if (rng.float() < cfg.muscleDropProb) {
    const t0 = tAny();
    events.push({ t: t0, type: 'setMuscleScale', region: pick(rng, REGIONS), scale: round(u(rng, [0, 0.6]), 2), recoverTime: round(u(rng, [0.5, 4]), 2) });
    extras.push('muscleDrop');
  }
  // 두 번째 캐릭터 (평평한 곳, 첫 사람과 떨어진 자리)
  let characters: ExtraCharacter[] | undefined;
  let second: StartKind | null = null;
  if (rng.float() < cfg.secondCharProb && !terrain.startsWith('slope')) {
    for (let i = 0; i < 12 && !characters; i++) {
      const a = rng.float() * 2 * Math.PI, d = u(rng, cfg.secondCharDist);
      const x = center![0] + Math.sin(a) * d, z = center![2] + Math.cos(a) * d;
      if (!flatAround(terrain, x, z, 0.35)) continue;
      const y = terrainHeightAt(terrainDef(terrain), x, z);
      if (insideObstacle(terrain, [x, y + 0.9, z], 0.35) || insideObstacle(terrain, [x, y + 0.1, z], 0.35)) continue;
      if (lyingSpawn && lyingSpawn.some((b) => Math.hypot(b.pos[0] - x, b.pos[2] - z) < 0.8)) continue;
      // 첫 사람 쪽을 대략 보거나(마주 걷기·부딪힘) 아무 쪽
      const toward = Math.atan2(center![0] - x, center![2] - z);
      const yaw = round(rng.float() < 0.6 ? toward + (rng.float() * 2 - 1) * 0.5 : (rng.float() * 2 - 1) * Math.PI, 4);
      const kind: StartKind = rng.float() < 0.4 ? 'walk' : rng.float() < 0.5 ? 'idle' : 'stand';
      // 걷기: Animated(키네마틱)로 0.3초 걷는 동안 지형·첫 사람과 겹치면 Active로 바뀌는 순간 몸이 이미 박혀 있다 — 앞 0.6m 길이 비어 있어야 한다
      if (kind === 'walk') {
        const ax = x + Math.sin(yaw) * 0.6, az = z + Math.cos(yaw) * 0.6;
        const aStart: Vec3 = start === 'walk' ? [center![0] + Math.sin(spawn!.yaw) * 0.6, 0, center![2] + Math.cos(spawn!.yaw) * 0.6] : center!;
        if (!flatAround(terrain, ax, az, 0.3) || insideObstacle(terrain, [ax, y + 0.9, az], 0.35) || Math.hypot(ax - aStart[0], az - aStart[2]) < 0.7 || Math.hypot(ax - center![0], az - center![2]) < 0.7) continue;
      }
      const sp: SpawnOpts = kind === 'walk' ? { position: r3([x, y, z]), yaw, state: 'Animated', pose: 'kimodo_walk_forward' } : { position: r3([x, y, z]), yaw, state: 'Active', pose: kind === 'idle' ? 'kimodo_idle_relaxed' : 'stand' };
      characters = [{ name: 'B', spawn: sp, clip: kind === 'stand' ? 'stand' : null }];
      second = kind;
      if (kind === 'walk') events.push({ t: 0.3, char: 'B', type: 'setState', state: 'Active' });
      if (rng.float() < cfg.secondCharHitProb) {
        const h = makeHit(rng, cfg, [x, y + 1, z], false);
        events.push({ t: tAny(), char: 'B', type: 'hit', hit: h });
        hitTypes.push(`B:${h.type}`);
      }
    }
  }
  // 프롭 (떨어뜨리기·던지기)
  let nProp = 0;
  if (rng.float() < cfg.propProb) {
    const n = Math.floor(u(rng, [cfg.propCount[0]!, cfg.propCount[1]! + 1]));
    const P = cfg.prop;
    for (let i = 0; i < n; i++) {
      const sz = u(rng, P.size);
      const k = rng.float();
      const shape: PropDef['shape'] = k < 0.5 ? { type: 'box', halfExtents: r3([sz, sz * u(rng, [0.5, 1.2]), sz * u(rng, [0.5, 1.2])]) } : k < 0.75 ? { type: 'sphere', radius: round(sz) } : { type: 'capsule', halfHeight: round(sz * u(rng, [0.5, 2])), radius: round(sz * 0.6) };
      const q = [rng.float() - 0.5, rng.float() - 0.5, rng.float() - 0.5, rng.float() - 0.5];
      const qn = Math.hypot(...q) || 1;
      const rot = q.map((v) => round(v / qn, 4)) as [number, number, number, number];
      const mass = round(u(rng, P.mass), 2);
      const top = center![1] + 1.0;
      let def: PropDef;
      if (rng.float() < P.throwProb) {
        // 던지기: 2~3m 떨어진 곳에서 몸 쪽으로
        const a = rng.float() * 2 * Math.PI, d = u(rng, [2, 3]);
        const from: Vec3 = [center![0] + Math.sin(a) * d, center![1] + u(rng, [0.2, 0.8]), center![2] + Math.cos(a) * d];
        const aim: Vec3 = [center![0] + u(rng, [-0.3, 0.3]), center![1] + u(rng, [-0.6, 0.4]), center![2] + u(rng, [-0.3, 0.3])];
        const dir = [aim[0] - from[0], aim[1] - from[1], aim[2] - from[2]];
        const L = Math.hypot(...dir), sp = u(rng, P.throwSpeed);
        // 떨어짐을 대략 보정 (비행 시간 L/sp 동안 g)
        const tf = L / sp;
        def = { id: `p${i}`, shape, mass, position: r3(from), rotation: rot, linVel: r3([(dir[0]! / L) * sp, (dir[1]! / L) * sp + 0.5 * 9.81 * tf, (dir[2]! / L) * sp]), angVel: r3([u(rng, [-5, 5]), u(rng, [-5, 5]), u(rng, [-5, 5])]) };
      } else {
        def = { id: `p${i}`, shape, mass, position: r3([center![0] + u(rng, [-0.4, 0.4]), top + u(rng, P.dropHeight), center![2] + u(rng, [-0.4, 0.4])]), rotation: rot, angVel: r3([u(rng, [-1, 1]), u(rng, [-1, 1]), u(rng, [-1, 1])]) };
      }
      // 지형(받침·계단·벽·장애물) 속이나 바로 붙은 자리에 만들지 않는다 (던지는 출발점이 모서리 받침 안에 들어가 프롭이 1m 넘게 박혀 시작했다)
      const pp = def.position;
      const tFire = tAny();
      if (terrainHeightAt(terrainDef(terrain), pp[0], pp[2]) > pp[1] - 2 * sz - 0.05 || insideObstacle(terrain, pp, 2 * sz + 0.05)) continue;
      events.push({ t: tFire, type: 'spawnProp', prop: def });
      nProp++;
    }
  }
  events.sort((a, b) => a.t - b.t);
  const tags: FuzzTags = { terrain, start, hits: hitTypes.length, hitTypes, second, props: nProp, extras };
  const scenario: Scenario = {
    name: `fuzz/${seed}`, milestone: '0.9', duration, seed, terrain, character: 'xbot',
    spawn: spawn!, clip, assist: { root: false }, events,
    ...(characters ? { characters, primaryName: 'A' } : {}),
    cameras: ['side', 'follow'], expect: {},
    description: `퍼징 시드 ${seed} (생성기 v${cfg.generatorVersion}): ${terrain}, 시작 ${start}, 피격 ${hitTypes.join('·') || '없음'}${second ? `, 두 번째 캐릭터 ${second}` : ''}${nProp ? `, 프롭 ${nProp}` : ''}${extras.length ? `, ${extras.join('·')}` : ''}`,
  };
  return { seed, scenario, tags };
}
