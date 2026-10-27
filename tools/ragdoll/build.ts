// 스켈레톤·스킨 데이터 + config/genRagdoll.json → CharacterDef (SPEC 6.4). 순수 함수 (파일 입출력 없음).
// 계산 순서: 바인드(T-포즈) 월드에서 형상·관절 축을 모두 구한 뒤, 팔 사슬만 어깨를 중심으로 내려 A포즈를 만든다.
import type { FbxSkeletonData } from '../fbx/loadFbx';
import type { BodyDef, BodyName, CharacterDef, ExtraShapeDef, JointDef, JointLimitsDeg, ShapeDef } from '../../src/sim/character/characterDef';
import { type Vec3, add, sub, scale, dot, cross, normalize, length, negate } from '../../src/sim/math/vec3';
import { type Quat, identityQ, multiplyQ, inverseQ, rotate, fromAxisAngle, fromTo } from '../../src/sim/math/quat';
import { fromColumns, toQuat } from '../../src/sim/math/mat3';

type ShapeSpec =
  | { kind: 'torsoLateral'; centerBones: string[]; maxHalfWidth: number }
  | { kind: 'headSphere'; centerBones: string[]; aboveBone: string }
  | { kind: 'limbCapsule'; endAtTip?: boolean }
  | { kind: 'footBox' };

interface ExtraShapeSpec { kind: 'neckCapsule'; label: string; skinBones: string[]; baseBone: string }
interface BodySpec {
  name: string; parent: string | null; sourceBones: string[]; representativeBone: string; jointBone: string | null;
  massRatio: number; friction: number; segmentBones: [string, string]; joint?: string; shape: ShapeSpec; extraShapes?: ExtraShapeSpec[];
}
interface JointSpec {
  type: 'spherical' | 'hinge'; flexToward: Vec3; twistFrom: 'child' | 'parent'; cone?: 'bindSegment'; limitsDeg: JointLimitsDeg;
}
export interface GenConfig {
  id: string; skeleton: string; totalMass: number; restPose: { armDownDeg: number };
  skinWeightThreshold: number; torsoZPercentile: [number, number];
  bodies: BodySpec[]; joints: Record<string, JointSpec>;
}

const DEG = Math.PI / 180;
const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];

/** '{S}' 템플릿을 Left/Right로 펼친다. */
export function expandSides(specs: BodySpec[]): BodySpec[] {
  const out: BodySpec[] = [];
  for (const s of specs) {
    const json = JSON.stringify(s);
    if (!json.includes('{S}')) { out.push(s); continue; }
    for (const side of ['Left', 'Right']) out.push(JSON.parse(json.replaceAll('{S}', side)) as BodySpec);
  }
  return out;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / dot(ab, ab)));
  return length(sub(p, add(a, scale(ab, t))));
}

const round = (x: number, d: number) => { const f = 10 ** d; const r = Math.round(x * f) / f; return r === 0 ? 0 : r; };
const rv = (v: readonly number[], d = 5) => v.map((x) => round(x, d)) as Vec3;
const rq = (q: readonly number[]) => q.map((x) => round(x, 6)) as Quat;

/** 관절 좌표계 회전: X = flex, Y = twist, Z = X × Y. flex 축은 twist에 수직이 되도록 그람-슈미트로 맞춘다. */
function jointFrame(twist: Vec3, flexRaw: Vec3): { q: Quat; flex: Vec3; twist: Vec3; side: Vec3 } {
  const y = normalize(twist);
  const x = normalize(sub(flexRaw, scale(y, dot(flexRaw, y))));
  const z = cross(x, y);
  return { q: toQuat(fromColumns(x, y, z)), flex: x, twist: y, side: z };
}

export function buildCharacter(skel: FbxSkeletonData, cfg: GenConfig): CharacterDef {
  const specs = expandSides(cfg.bodies);
  const bonePos = new Map(skel.bones.map((b) => [b.name, b.worldPos] as const));
  const P = (n: string): Vec3 => {
    const p = bonePos.get(n);
    if (!p) throw new Error(`bone not found in skeleton: ${n}`);
    return p;
  };
  const byName = new Map(specs.map((s) => [s.name, s] as const));

  // --- 정점 → 바디 배정 (바디 소속 본 가중치 합이 가장 큰 바디, 그 합 > 임계값)
  const bone2body = new Map<string, string>();
  for (const s of specs) for (const b of s.sourceBones) bone2body.set(b, s.name);
  const verts = new Map<string, Vec3[]>(specs.map((s) => [s.name, []]));
  for (const m of skel.meshes) for (const v of m.vertices) {
    const acc = new Map<string, number>();
    for (const [bone, w] of v.influences) {
      const body = bone2body.get(bone);
      if (body) acc.set(body, (acc.get(body) ?? 0) + w);
    }
    let best = '', bw = 0;
    for (const [b, w] of acc) if (w > bw) { bw = w; best = b; }
    if (bw > cfg.skinWeightThreshold) verts.get(best)!.push(v.pos);
  }
  // 추가 형상의 반지름용 정점: skinBones 가중치 합이 임계값을 넘는 정점 (바디 배정과 무관)
  const skinVerts = (bones: string[]): Vec3[] => {
    const set = new Set(bones);
    const out: Vec3[] = [];
    for (const m of skel.meshes) for (const v of m.vertices) {
      let w = 0;
      for (const [bone, bw] of v.influences) if (set.has(bone)) w += bw;
      if (w > cfg.skinWeightThreshold) out.push(v.pos);
    }
    return out;
  };

  // --- A포즈 변환: 어깨 관절을 가진 바디와 그 자손은 어깨 중심으로 armDownDeg만큼 아래로 돈다
  const theta = cfg.restPose.armDownDeg * DEG;
  const pose = new Map<string, { pivot: Vec3; rot: Quat }>();
  const poseOf = (name: string): { pivot: Vec3; rot: Quat } => {
    const hit = pose.get(name);
    if (hit) return hit;
    const s = byName.get(name)!;
    let r: { pivot: Vec3; rot: Quat };
    if (s.joint === 'shoulder') {
      const dir = normalize(sub(P(s.segmentBones[1]), P(s.segmentBones[0])));
      r = { pivot: P(s.jointBone!), rot: fromAxisAngle(cross(dir, DOWN), theta) };
    } else r = s.parent ? poseOf(s.parent) : { pivot: [0, 0, 0], rot: identityQ() };
    pose.set(name, r);
    return r;
  };
  const applyPose = (name: string, p: Vec3): Vec3 => { const t = poseOf(name); return add(t.pivot, rotate(t.rot, sub(p, t.pivot))); };
  const segDir = (s: BodySpec): Vec3 => normalize(sub(P(s.segmentBones[1]), P(s.segmentBones[0])));

  // --- 바디별 형상과 중심 (바인드 월드)
  const built = new Map<string, { center: Vec3; shape: ShapeDef }>();
  for (const s of specs) {
    const vs = verts.get(s.name)!;
    if (vs.length === 0) throw new Error(`no skin vertices assigned to body ${s.name}`);
    let center: Vec3, shape: ShapeDef;
    const sh = s.shape;
    if (sh.kind === 'torsoLateral') {
      const cb = sh.centerBones.map(P);
      const c0 = scale(cb.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / cb.length);
      const zs = vs.map((v) => v[2]);
      const zlo = percentile(zs, cfg.torsoZPercentile[0]), zhi = percentile(zs, cfg.torsoZPercentile[1]);
      const radius = (zhi - zlo) / 2;
      const halfWidth = Math.min(percentile(vs.map((v) => Math.abs(v[0] - c0[0])), cfg.torsoZPercentile[1]), sh.maxHalfWidth);
      center = [c0[0], c0[1], (zlo + zhi) / 2];
      shape = { type: 'capsule', radius, halfHeight: Math.max(0, halfWidth - radius), rotation: fromTo(UP, [1, 0, 0]) };
    } else if (sh.kind === 'headSphere') {
      const cb = sh.centerBones.map(P);
      center = scale(cb.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / cb.length);
      const yMin = P(sh.aboveBone)[1];
      const ds = vs.filter((v) => v[1] > yMin).map((v) => length(sub(v, center)));
      shape = { type: 'sphere', radius: percentile(ds, 0.5) };
    } else if (sh.kind === 'limbCapsule') {
      const a = P(s.segmentBones[0]), b = P(s.segmentBones[1]);
      const radius = percentile(vs.map((v) => distToSegment(v, a, b)), 0.5);
      let dir = segDir(s);
      const len = length(sub(b, a));
      // 끝 바디(손)는 캡슐 끝이 손가락 끝을 넘지 않게 반지름만큼 줄인다. 중간 바디는 관절-관절.
      const segLen = sh.endAtTip ? Math.max(0, len - radius) : len;
      center = add(a, scale(dir, segLen / 2));
      if (dot(dir, UP) < 0) dir = negate(dir);
      shape = { type: 'capsule', radius, halfHeight: segLen / 2, rotation: fromTo(UP, dir) };
    } else {
      const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const v of vs) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, v[i]!); hi[i] = Math.max(hi[i]!, v[i]!); }
      center = scale(add(lo, hi), 0.5);
      shape = { type: 'box', halfExtents: scale(sub(hi, lo), 0.5) };
    }
    built.set(s.name, { center, shape });
  }

  // --- 월드 rest (A포즈) 위치·회전
  const restPos = new Map<string, Vec3>(), restRot = new Map<string, Quat>();
  for (const s of specs) {
    restPos.set(s.name, applyPose(s.name, built.get(s.name)!.center));
    restRot.set(s.name, poseOf(s.name).rot);
  }
  const toLocal = (body: string, pWorld: Vec3): Vec3 => rotate(inverseQ(restRot.get(body)!), sub(pWorld, restPos.get(body)!));

  // --- 관절
  const bodies: BodyDef[] = specs.map((s): BodyDef => {
    const b = built.get(s.name)!;
    let joint: JointDef | null = null;
    if (s.parent) {
      const js = cfg.joints[s.joint ?? ''];
      if (!js) throw new Error(`body ${s.name} has parent but no joint spec`);
      const parent = byName.get(s.parent)!;
      const childDir = segDir(s), parentDir = segDir(parent);
      const fr = jointFrame(js.twistFrom === 'child' ? childDir : parentDir, cross(childDir, js.flexToward));
      // 관절 좌표계는 자식에 붙어 있다고 보고 자식의 A포즈 회전을 적용한다 (rest 상대 회전 = 항등이 되게).
      const childRot = poseOf(s.name).rot;
      const jWorld = multiplyQ(childRot, fr.q);
      const anchorW = applyPose(s.name, P(s.jointBone!));
      const parentInv = inverseQ(restRot.get(s.parent)!);
      joint = {
        type: js.type,
        anchorInParent: rv(toLocal(s.parent, anchorW)),
        anchorInChild: rv(toLocal(s.name, anchorW)),
        frameInParent: rq(multiplyQ(parentInv, jWorld)),
        frameInChild: rq(multiplyQ(inverseQ(restRot.get(s.name)!), jWorld)),
        axis: rv(rotate(parentInv, rotate(childRot, fr.flex)), 6),
        axesWorld: { flex: rv(rotate(childRot, fr.flex), 6), twist: rv(rotate(childRot, fr.twist), 6), side: rv(rotate(childRot, fr.side), 6) },
        limitsDeg: structuredClone(js.limitsDeg),
      };
      // 스윙 콘 축 = 바인드(T-포즈) 상완 방향을 부모 로컬로 (스파이크 측정 기준 축)
      if (js.cone === 'bindSegment') joint.coneAxisInParent = rv(rotate(parentInv, childDir), 6);
    }
    // 추가 형상: 목 캡슐 = 관절 앵커(목 밑동)에서 머리 구 바닥까지. 반지름은 limbCapsule과 같은 방법(스킨 정점 → 분절 선분 거리 중앙값)
    const extraShapes: ExtraShapeDef[] = [];
    for (const ex of s.extraShapes ?? []) {
      const sph = b.shape;
      if (sph.type !== 'sphere') throw new Error(`${s.name}: neckCapsule needs a sphere main shape`);
      const a = applyPose(s.name, P(ex.baseBone));
      const bot: Vec3 = [b.center[0], b.center[1] - sph.radius, b.center[2]];
      const vs = skinVerts(ex.skinBones);
      if (vs.length === 0) throw new Error(`${s.name}: no skin vertices for extra shape ${ex.label}`);
      const radius = percentile(vs.map((v) => distToSegment(v, a, bot)), 0.5);
      const dir = normalize(sub(bot, a));
      extraShapes.push({
        label: ex.label,
        shape: { type: 'capsule', radius: round(radius, 4), halfHeight: round(length(sub(bot, a)) / 2, 4), rotation: rq(fromTo(UP, dir)) },
        position: rv(toLocal(s.name, scale(add(a, bot), 0.5))),
      });
    }
    let shape = b.shape;
    if (shape.type === 'capsule') shape = { ...shape, radius: round(shape.radius, 4), halfHeight: round(shape.halfHeight, 4), rotation: rq(shape.rotation) };
    else if (shape.type === 'sphere') shape = { ...shape, radius: round(shape.radius, 4) };
    else shape = { ...shape, halfExtents: rv(shape.halfExtents, 4) };
    return {
      name: s.name as BodyName,
      parent: s.parent as BodyName | null,
      sourceBones: s.sourceBones,
      representativeBone: s.representativeBone,
      jointBone: s.jointBone,
      shape,
      ...(extraShapes.length ? { extraShapes } : {}),
      massRatio: s.massRatio,
      inertiaScale: 1.0,
      restPosition: rv(restPos.get(s.name)!),
      restRotation: rq(restRot.get(s.name)!),
      joint,
      friction: s.friction,
    };
  });

  const height = Math.max(...skel.bones.map((b) => b.worldPos[1]));
  return {
    id: cfg.id,
    totalMass: cfg.totalMass,
    height: round(height, 3),
    skeleton: cfg.skeleton,
    restPose: { armDownDeg: cfg.restPose.armDownDeg },
    generator: { tool: 'tools/genRagdoll.ts', source: skel.source.replaceAll('\\', '/'), overrides: null },
    bodies,
  };
}
