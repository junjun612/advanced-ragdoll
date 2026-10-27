// SPEC 6.1 바디별(11.2 흡수 본 포함) 고가중치(>0.5) 정점의 본 축까지 거리 분포.
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadFbx, boneMap, strip, worldPos, CM } from './load';

const g = loadFbx('assets/fbx/X Bot.fbx');
const bones = boneMap(g);
const P = (n: string) => worldPos(bones.get(n)!);
const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) => [1, 2, 3, 4].map((i) => `Hand${f}${i}`));

type Body = { bones: string[]; axis: string[] };
const bodies: Record<string, Body> = {
  Hips: { bones: ['Hips'], axis: ['Hips', 'Spine'] },
  Spine: { bones: ['Spine', 'Spine1'], axis: ['Spine', 'Spine2'] },
  Spine2: { bones: ['Spine2', 'LeftShoulder', 'RightShoulder'], axis: ['Spine2', 'Neck'] },
  Head: { bones: ['Head', 'Neck', 'HeadTop_End'], axis: ['Neck', 'Head', 'HeadTop_End'] },
};
for (const s of ['Left', 'Right']) {
  bodies[s + 'Arm'] = { bones: [s + 'Arm'], axis: [s + 'Arm', s + 'ForeArm'] };
  bodies[s + 'ForeArm'] = { bones: [s + 'ForeArm'], axis: [s + 'ForeArm', s + 'Hand'] };
  bodies[s + 'Hand'] = { bones: [s + 'Hand', ...fingers.map((f) => s + f)], axis: [s + 'Hand', s + 'HandMiddle1', s + 'HandMiddle4'] };
  bodies[s + 'UpLeg'] = { bones: [s + 'UpLeg'], axis: [s + 'UpLeg', s + 'Leg'] };
  bodies[s + 'Leg'] = { bones: [s + 'Leg'], axis: [s + 'Leg', s + 'Foot'] };
  bodies[s + 'Foot'] = { bones: [s + 'Foot', s + 'ToeBase', s + 'Toe_End'], axis: [s + 'Foot', s + 'ToeBase', s + 'Toe_End'] };
}
const bone2body = new Map<string, string>();
for (const [b, d] of Object.entries(bodies)) for (const n of d.bones) bone2body.set(n, b);

// 정점 → 바디 가중치 합 > 0.5 이면 해당 바디에 배정. 위치는 rest(=bind) 스키닝 결과의 월드 좌표.
const pts: Record<string, Record<string, THREE.Vector3[]>> = {};
const meshes: THREE.SkinnedMesh[] = [];
g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
const unassigned: Record<string, number> = {};
for (const m of meshes) {
  m.skeleton.update();
  const si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!, pos = m.geometry.attributes.position!;
  const names = m.skeleton.bones.map((b) => strip(b.name));
  pts[m.name] = {};
  for (let i = 0; i < pos.count; i++) {
    const acc = new Map<string, number>();
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k); if (w <= 0) continue;
      const body = bone2body.get(names[si.getComponent(i, k)]!) ?? '?' + names[si.getComponent(i, k)];
      acc.set(body, (acc.get(body) ?? 0) + w);
    }
    let best = '', bw = 0;
    for (const [b, w] of acc) if (w > bw) { bw = w; best = b; }
    if (bw <= 0.5) continue;
    if (best.startsWith('?')) { unassigned[best] = (unassigned[best] ?? 0) + 1; continue; }
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    m.applyBoneTransform(i, p);
    p.applyMatrix4(m.matrixWorld).multiplyScalar(CM);
    (pts[m.name]![best] ??= []).push(p);
  }
}

function segDist(p: THREE.Vector3, poly: THREE.Vector3[]): { d: number; t: number } {
  // 폴리라인까지 최단 거리, t = 폴리라인 시작부터의 호 길이 비율(0~1, 범위 밖은 클램프 전 값)
  let best = { d: Infinity, t: 0 }, acc = 0;
  const total = poly.slice(1).reduce((s, q, i) => s + q.distanceTo(poly[i]!), 0);
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!, b = poly[i + 1]!, ab = b.clone().sub(a), L = ab.length();
    const tr = p.clone().sub(a).dot(ab) / (L * L), t = Math.min(1, Math.max(0, tr));
    const d = a.clone().addScaledVector(ab, t).distanceTo(p);
    if (d < best.d) best = { d, t: (acc + tr * L) / total };
    acc += L;
  }
  return best;
}
const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!; };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

const out: any = { method: '정점별로 바디 소속 본 가중치 합 > 0.5인 정점을 그 바디에 배정. 거리는 rest(=bind, T-포즈) 월드 좌표(m)에서 axis 폴리라인(본 머리 위치 연결)까지 최단 거리. surfaceOnly = Beta_Surface 메시만, combined = Beta_Surface + Beta_Joints.', bodies: {} };
for (const [b, d] of Object.entries(bodies)) {
  const poly = d.axis.map(P);
  const axisLen = poly.slice(1).reduce((s, q, i) => s + q.distanceTo(poly[i]!), 0);
  const res: any = { bones: d.bones, axis: d.axis, axisLength: r4(axisLen) };
  for (const [label, sets] of [['surfaceOnly', [pts.Beta_Surface?.[b] ?? []]], ['combined', [pts.Beta_Surface?.[b] ?? [], pts.Beta_Joints?.[b] ?? []]]] as const) {
    const all = sets.flat();
    if (!all.length) { res[label] = null; continue; }
    const ds = all.map((p) => segDist(p, poly));
    const dd = ds.map((x) => x.d), ts = ds.map((x) => x.t);
    const box = new THREE.Box3().setFromPoints(all);
    res[label] = { n: all.length, median: r4(pct(dd, 0.5)), p25: r4(pct(dd, 0.25)), p75: r4(pct(dd, 0.75)), p90: r4(pct(dd, 0.9)),
      axialRange_t: [r4(pct(ts, 0.02)), r4(pct(ts, 0.98))],
      aabbMin: box.min.toArray().map(r4), aabbMax: box.max.toArray().map(r4) };
  }
  out.bodies[b] = res;
}
// 머리: 구 반지름 후보 = 머리 정점의 (Head~HeadTop_End 중점)까지 거리 중앙값
{
  const c = P('Head').add(P('HeadTop_End')).multiplyScalar(0.5);
  const hp = pts.Beta_Surface!.Head!.filter((p) => p.y > P('Head').y);
  out.bodies.Head.sphere = { center: c.toArray().map(r4), medianDistAboveHeadBone: r4(pct(hp.map((p) => p.distanceTo(c)), 0.5)) };
}
// 발: 박스 치수 (Surface, 발 바디)
{
  const fp = pts.Beta_Surface!.LeftFoot!; const box = new THREE.Box3().setFromPoints(fp);
  out.bodies.LeftFoot.box = { length_z: r4(box.max.z - box.min.z), width_x: r4(box.max.x - box.min.x), height_y: r4(box.max.y - box.min.y), soleY: r4(box.min.y) };
}
out.unassignedBonesVertexCount = unassigned;
writeFileSync('spike/fbx/out/xbot_radii.json', JSON.stringify(out, null, 1));
for (const [b, r] of Object.entries<any>(out.bodies)) console.log(b.padEnd(13), 'len', r.axisLength, 'surf', r.surfaceOnly && [r.surfaceOnly.n, r.surfaceOnly.median, r.surfaceOnly.p75, r.surfaceOnly.axialRange_t], 'comb', r.combined && [r.combined.n, r.combined.median]);
console.log(out.bodies.Head.sphere, out.bodies.LeftFoot.box, unassigned);
