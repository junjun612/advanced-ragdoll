import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadFbx, boneMap, strip, worldPos, CM } from './load';

const g = loadFbx('assets/fbx/X Bot.fbx');
const bones = boneMap(g);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const v = (a: THREE.Vector3) => [r4(a.x), r4(a.y), r4(a.z)];
const q = (a: THREE.Quaternion) => [r4(a.x), r4(a.y), r4(a.z), r4(a.w)];

// --- bind 행렬 (TransformLink) : inverse(boneInverse). 메시 bindMatrix는 항등임을 확인.
const meshes: THREE.SkinnedMesh[] = [];
g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
const bindWorld = new Map<string, THREE.Matrix4>();
for (const m of meshes) m.skeleton.bones.forEach((b, i) => {
  const n = strip(b.name);
  if (!bindWorld.has(n)) bindWorld.set(n, m.skeleton.boneInverses[i]!.clone().invert());
});

const out: any = { source: 'assets/fbx/X Bot.fbx', units: 'm (cm x0.01)', boneCount: bones.size,
  rootGroupScale: g.scale.toArray(), unitScaleFactor: g.userData.unitScaleFactor ?? null,
  meshes: meshes.map((m) => ({ name: m.name, vertices: m.geometry.attributes.position!.count, skinBones: m.skeleton.bones.length,
    bindMatrixIsIdentity: m.bindMatrix.equals(new THREE.Matrix4()) })), bones: {} as any };
let maxRestBindPos = 0, maxRestBindAng = 0;
for (const [n, b] of bones) {
  const p = new THREE.Vector3(), r = new THREE.Quaternion(), s = new THREE.Vector3();
  b.matrixWorld.decompose(p, r, s);
  const entry: any = {
    parent: b.parent && (b.parent as THREE.Bone).isBone ? strip(b.parent.name) : null,
    restLocal: { pos: v(b.position.clone().multiplyScalar(CM)), rot: q(b.quaternion), scale: v(b.scale) },
    restWorld: { pos: v(p.multiplyScalar(CM)), rot: q(r) },
  };
  const bw = bindWorld.get(n);
  if (bw) {
    const bp = new THREE.Vector3(), br = new THREE.Quaternion(), bs = new THREE.Vector3();
    bw.decompose(bp, br, bs); bp.multiplyScalar(CM);
    entry.bindWorld = { pos: v(bp), rot: q(br) };
    maxRestBindPos = Math.max(maxRestBindPos, bp.distanceTo(new THREE.Vector3(...entry.restWorld.pos)));
    maxRestBindAng = Math.max(maxRestBindAng, THREE.MathUtils.radToDeg(br.angleTo(r)));
  }
  out.bones[n] = entry;
}
out.restVsBind = { maxPosDiff_m: r4(maxRestBindPos), maxRotDiff_deg: r4(maxRestBindAng),
  note: 'restWorld = 씬 그래프의 Lcl 변환, bindWorld = 클러스터 TransformLink. HeadTop_End 등 클러스터 없는 본은 bindWorld 없음' };

// --- T-포즈 판정
const P = (n: string) => worldPos(bones.get(n)!);
const deg = (a: THREE.Vector3, b: THREE.Vector3) => THREE.MathUtils.radToDeg(a.angleTo(b));
const dir = (a: string, b: string) => P(b).sub(P(a)).normalize();
const tpose: any = {};
for (const s of ['Left', 'Right']) {
  const lat = new THREE.Vector3(s === 'Left' ? 1 : -1, 0, 0);
  tpose[s + 'UpperArm_vs_lateral_deg'] = r4(deg(dir(s + 'Arm', s + 'ForeArm'), lat));
  tpose[s + 'ForeArm_vs_lateral_deg'] = r4(deg(dir(s + 'ForeArm', s + 'Hand'), lat));
  tpose[s + 'UpperArm_elevation_deg'] = r4(THREE.MathUtils.radToDeg(Math.asin(dir(s + 'Arm', s + 'ForeArm').y)));
  tpose[s + 'Thigh_vs_down_deg'] = r4(deg(dir(s + 'UpLeg', s + 'Leg'), new THREE.Vector3(0, -1, 0)));
  tpose[s + 'Shin_vs_down_deg'] = r4(deg(dir(s + 'Leg', s + 'Foot'), new THREE.Vector3(0, -1, 0)));
}
tpose.Spine_vs_up_deg = r4(deg(dir('Hips', 'Neck'), new THREE.Vector3(0, 1, 0)));
tpose.facing = 'feet toes ' + v(dir('LeftFoot', 'LeftToeBase'));
out.tpose = tpose;

// X Bot에 들어 있는 1프레임 'mixamo.com' 클립이 rest와 같은지
const clip = g.animations.find((a) => a.name === 'mixamo.com');
if (clip) {
  let maxAng = 0, worst = '';
  for (const t of clip.tracks) if (t.name.endsWith('.quaternion')) {
    const b = bones.get(strip(t.name.split('.')[0]!))!;
    const qq = new THREE.Quaternion().fromArray(t.values as any, 0);
    const a = THREE.MathUtils.radToDeg(qq.angleTo(b.quaternion));
    if (a > maxAng) { maxAng = a; worst = t.name; }
  }
  out.embeddedClip = { name: clip.name, duration: clip.duration, tracks: clip.tracks.length, maxDiffFromRest_deg: r4(maxAng), worst };
}

// 치수
const dist = (a: string, b: string) => r4(P(a).distanceTo(P(b)));
out.dimensions = {
  hipsHeight: r4(P('Hips').y), headTop: r4(P('HeadTop_End').y),
  shoulderWidth_ArmToArm: dist('LeftArm', 'RightArm'), clavicle_ShoulderToArm: dist('LeftShoulder', 'LeftArm'),
  upperArm: dist('LeftArm', 'LeftForeArm'), foreArm: dist('LeftForeArm', 'LeftHand'), wristToMiddle1: dist('LeftHand', 'LeftHandMiddle1'),
  wristToMiddle4: dist('LeftHand', 'LeftHandMiddle4'),
  thigh: dist('LeftUpLeg', 'LeftLeg'), shin: dist('LeftLeg', 'LeftFoot'), hipWidth: dist('LeftUpLeg', 'RightUpLeg'),
  ankleHeight: r4(P('LeftFoot').y), footToToeBase: dist('LeftFoot', 'LeftToeBase'), footToToeEnd: dist('LeftFoot', 'LeftToe_End'),
};
writeFileSync('spike/fbx/out/xbot_skeleton.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ restVsBind: out.restVsBind, tpose, embedded: out.embeddedClip, dims: out.dimensions, meshes: out.meshes, usf: out.unitScaleFactor }, null, 1));
