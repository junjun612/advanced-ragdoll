// 쇄골 바디 판단: Spine2에 강체로 붙은 어깨(LeftArm 위치)에서 해석적 2링크 IK + 어깨 스윙 콘 + 팔꿈치 0~145° + 몸통 관통 검사.
// 왼손 기준 (좌우 대칭). 좌표: Y 위, +Z 정면, +X 왼쪽, 미터.
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadFbx, boneMap, strip, worldPos, CM } from './load';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const D = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const g = loadFbx('assets/fbx/X Bot.fbx');
const bones = boneMap(g);
const P = (n: string) => worldPos(bones.get(n)!);
const S0 = P('LeftArm'), SC = P('LeftShoulder'), E0 = P('LeftForeArm'), W0 = P('LeftHand'), M1 = P('LeftHandMiddle1');
const HIP = P('Hips');
const L1 = S0.distanceTo(E0), FA = E0.distanceTo(W0);
const PALM = 0.55 * W0.distanceTo(M1); // 손목 -> 손바닥 중심 (손목 -> 중지 MCP의 55%)
const L2 = FA + PALM;
const ELBOW_MAX = 145, SWING = 100;
const rMax = L1 + L2, rMin = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(D(180 - ELBOW_MAX)));

// --- 메시 정점 (Beta_Surface + Beta_Joints; 허리·목 등은 Joints 메시에만 있음), 최대 가중치 본으로 분류
const meshes: THREE.SkinnedMesh[] = [];
g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
const armLike = (n: string) => /Arm|Hand/.test(n);
const verts: { p: THREE.Vector3; bone: string }[] = [];
for (const mesh of meshes) {
  const pos = mesh.geometry.attributes.position!, si = mesh.geometry.attributes.skinIndex!, sw = mesh.geometry.attributes.skinWeight!;
  const names = mesh.skeleton.bones.map((b) => strip(b.name));
  for (let i = 0; i < pos.count; i++) {
    let bi = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > bw) { bw = sw.getComponent(i, k); bi = si.getComponent(i, k); }
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, p);
    p.applyMatrix4(mesh.matrixWorld).multiplyScalar(CM);
    verts.push({ p, bone: names[bi]! });
  }
}
const bodyVerts = verts.filter((v) => !armLike(v.bone));
// 몸통 단면 (2cm 슬라이스): |x| < 어깨 관절 x 인 몸통 본 정점으로 x 반폭, z 범위
const torsoBones = new Set(['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder', 'Neck']);
const slices = new Map<number, { a: number; z0: number; z1: number }>();
for (const v of verts) if (torsoBones.has(v.bone) && Math.abs(v.p.x) < S0.x) {
  const k = Math.round(v.p.y / 0.02);
  const s = slices.get(k) ?? { a: 0, z0: Infinity, z1: -Infinity };
  s.a = Math.max(s.a, Math.abs(v.p.x)); s.z0 = Math.min(s.z0, v.p.z); s.z1 = Math.max(s.z1, v.p.z);
  slices.set(k, s);
}
const torsoYmin = HIP.y - 0.15, torsoYmax = P('Neck').y;
/** 몸통 좌표계(기울기 이전)의 점이 몸통 타원 기둥 안(+margin)에 있는가 */
function inTorso(p: THREE.Vector3, margin: number) {
  if (p.y < torsoYmin || p.y > torsoYmax) return false;
  const s = slices.get(Math.round(p.y / 0.02)); if (!s) return false;
  const a = s.a + margin, b = (s.z1 - s.z0) / 2 + margin, zc = (s.z0 + s.z1) / 2;
  return (p.x / a) ** 2 + ((p.z - zc) / b) ** 2 < 1;
}

// --- 표면 위 상처 지점: dir 방향(수평)에서 쏜 광선에 가장 먼저 닿는 정점 + 3cm
function surfacePoint(x: number, y: number, dir: THREE.Vector3, filter: (b: string) => boolean = () => true) {
  const d = dir.clone().normalize(); const o = V(x, y, 0);
  let best: THREE.Vector3 | null = null, bt = -Infinity;
  for (const v of bodyVerts) {
    if (!filter(v.bone)) continue;
    const rel = v.p.clone().sub(o); const t = rel.dot(d); const perp = rel.clone().addScaledVector(d, -t).length();
    if (perp < 0.02 && t > bt) { bt = t; best = v.p; }
  }
  return best!.clone().addScaledVector(d, 0.03);
}
const chestY = S0.y - 0.15, bellyY = HIP.y + 0.07;
const thighMid = P('LeftUpLeg').lerp(P('LeftLeg'), 0.4), thighUp = P('LeftUpLeg').lerp(P('LeftLeg'), 0.2);
const fwd = V(0, 0, 1);
const wounds: Record<string, THREE.Vector3> = {
  sameChest: surfacePoint(0.09, chestY, fwd),
  oppChest: surfacePoint(-0.09, chestY, fwd),
  sameBelly: surfacePoint(0.07, bellyY, fwd),
  oppBelly: surfacePoint(-0.07, bellyY, fwd),
  oppShoulderFront: surfacePoint(-(S0.x - 0.01), S0.y - 0.04, fwd),
  sameThighUpper: surfacePoint(thighUp.x, thighUp.y, fwd, (b) => b.includes('LeftUpLeg')),
  sameThighFront: surfacePoint(thighMid.x, thighMid.y, fwd, (b) => b.includes('LeftUpLeg')),
  sameThighOuter: surfacePoint(thighMid.x, thighMid.y, V(1, 0, 0), (b) => b.includes('LeftUpLeg')),
  oppFlank: surfacePoint(0, bellyY + 0.08, V(-1, 0, 0.3)),
};

// --- 자세: 상체(어깨, 콘 축, 몸통)를 Hips 중심으로 기울임 + 쇄골 회전
const CONES: Record<string, THREE.Vector3> = {
  lateral: V(1, 0, 0), // T-포즈 rest 방향이 콘 축 (SPEC 6.3 문자 그대로)
  tilted: V(0.5, -0.5, 0.707).normalize(), // 앞 45도, 아래 30도 쪽으로 기울인 콘 축
};
type Pose = { lean: THREE.Quaternion; clav: THREE.Quaternion };
const I = new THREE.Quaternion();
const pose0: Pose = { lean: I, clav: I };
function shoulderOf(p: Pose) {
  const s = S0.clone().sub(SC).applyQuaternion(p.clav).add(SC); // 쇄골 회전
  return s.sub(HIP).applyQuaternion(p.lean).add(HIP); // 몸통 기울기
}
const toTorsoFrame = (p: THREE.Vector3, ps: Pose) => p.clone().sub(HIP).applyQuaternion(ps.lean.clone().invert()).add(HIP);

type Sol = { d: number; inRange: boolean; minSwing: number; ok: boolean; elbow: number };
/** 목표점 T에 손바닥 중심이 닿는 해 검색. checkBody=false: 콘만, true: 콘 + 몸통 비관통. minSwing = 필요한 최소 스윙각 */
// 몸통 관통 검사 여유: strict = 상완 0.04 / 전완 0.035 (전완 손쪽 15%만 면제),
// relaxed = 상완 0.03 / 전완 0.02 (전완 손쪽 40% 면제: 손목을 굽혀 손바닥을 붙이고 전완이 가슴에 얹히는 자세 허용)
type Margins = { up: number; fore: number; foreT: number } | null;
const STRICT: Margins = { up: 0.04, fore: 0.035, foreT: 0.85 }, RELAXED: Margins = { up: 0.03, fore: 0.02, foreT: 0.6 };
function solve(T: THREE.Vector3, ps: Pose, cone: THREE.Vector3, checkBody: Margins): Sol {
  const S = shoulderOf(ps);
  const axis = cone.clone().applyQuaternion(ps.clav).applyQuaternion(ps.lean);
  const w = T.clone().sub(S); const d = w.length(); w.normalize();
  const res: Sol = { d: r3(d), inRange: d <= rMax && d >= rMin, minSwing: Infinity, ok: false, elbow: 0 };
  if (!res.inRange) return res;
  const alpha = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  res.elbow = r3(180 - R2D(Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1))));
  const n1 = new THREE.Vector3().crossVectors(w, Math.abs(w.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0)).normalize();
  const n2 = new THREE.Vector3().crossVectors(w, n1);
  for (let k = 0; k < 360; k += 2) { // 팔꿈치 스위블
    const ph = D(k);
    const radial = n1.clone().multiplyScalar(Math.cos(ph)).addScaledVector(n2, Math.sin(ph));
    const u = w.clone().multiplyScalar(Math.cos(alpha)).addScaledVector(radial, Math.sin(alpha));
    const sw = R2D(u.angleTo(axis));
    if (checkBody) {
      const E = S.clone().addScaledVector(u, L1); let hit = false;
      for (let t = 0.25; t <= 1.0001 && !hit; t += 0.125) hit = inTorso(toTorsoFrame(S.clone().lerp(E, t), ps), checkBody.up);
      for (let t = 0; t <= checkBody.foreT + 1e-6 && !hit; t += 0.05) hit = inTorso(toTorsoFrame(E.clone().lerp(T, t), ps), checkBody.fore);
      if (hit) continue;
    }
    res.minSwing = Math.min(res.minSwing, sw);
  }
  res.ok = res.minSwing <= SWING; res.minSwing = r3(res.minSwing);
  return res;
}
const qAxis = (ax: THREE.Vector3, deg: number) => new THREE.Quaternion().setFromAxisAngle(ax, D(deg));
// 쇄골(왼쪽): elevation(+ = 어깨 올림) = +Z축 회전, protraction(+ = 어깨 앞으로) = -Y축 회전. SC 피벗 = LeftShoulder 본 머리.
const clavPoses: { el: number; pr: number; q: THREE.Quaternion }[] = [];
for (let el = -20; el <= 20; el += 5) for (let pr = -20; pr <= 20; pr += 5)
  clavPoses.push({ el, pr, q: qAxis(V(0, 0, 1), el).multiply(qAxis(V(0, -1, 0), pr)) });
function withClav(T: THREE.Vector3, lean: THREE.Quaternion, cone: THREE.Vector3) {
  let best: { el: number; pr: number; cost: number; d: number; swing: number } | null = null;
  for (const c of clavPoses) {
    const r = solve(T, { lean, clav: c.q }, cone, RELAXED);
    const cost = Math.hypot(c.el, c.pr);
    if (r.ok && (!best || cost < best.cost)) best = { el: c.el, pr: c.pr, cost: r3(cost), d: r.d, swing: r.minSwing };
  }
  return best;
}

const out: any = {
  arm: { shoulder: S0.toArray().map(r3), SC: SC.toArray().map(r3), clavicleLen: r3(S0.distanceTo(SC)), L1: r3(L1), foreArm: r3(FA), palmOffset: r3(PALM), L2eff: r3(L2),
    rMin: r3(rMin), rMax: r3(rMax), maxShoulderShiftByClavicle20deg: r3(2 * S0.distanceTo(SC) * Math.sin(D(10))), chestY: r3(chestY), bellyY: r3(bellyY) },
  cones: Object.fromEntries(Object.entries(CONES).map(([k, v]) => [k, v.toArray().map(r3)])), swingLimit: SWING, elbowMax: ELBOW_MAX, wounds: {}, rails: {},
};
for (const [name, T] of Object.entries(wounds)) {
  const e: any = { target: T.toArray().map(r3) };
  for (const [cn, cv] of Object.entries(CONES))
    e[cn] = { coneOnly: solve(T, pose0, cv, null), strict: solve(T, pose0, cv, STRICT), relaxed: solve(T, pose0, cv, RELAXED), clavicle: withClav(T, I, cv) };
  if (name.includes('Thigh')) { // 다리 목표: 상체를 앞으로 20도 숙였을 때 (웅크림). 몸통 목표는 몸과 함께 움직이므로 무관
    const lean = qAxis(V(1, 0, 0), 20);
    e.lean20 = { relaxed: solve(T, { lean, clav: I }, CONES.lateral!, RELAXED), clavicle: withClav(T, lean, CONES.lateral!) };
    // 필요한 최소 앞숙임(Hips 중심, 2.5도 간격): 거리만 / 콘+relaxed
    const minLean = (fn: (q: THREE.Quaternion) => boolean) => { for (let l = 0; l <= 60; l += 2.5) if (fn(qAxis(V(1, 0, 0), l))) return l; return null; };
    e.minLean = { distOnly: minLean((q) => solve(T, { lean: q, clav: I }, CONES.lateral!, null).inRange),
      coneRelaxed: minLean((q) => solve(T, { lean: q, clav: I }, CONES.lateral!, RELAXED).ok),
      coneRelaxedClav: minLean((q) => !!withClav(T, q, CONES.lateral!)) };
  }
  out.wounds[name] = e;
}

// --- 난간: 높이 y, 옆(x=d, z 자유) / 앞(z=d, x 자유). 도달 가능한 최대 d. 거리는 몸 중심선(x=0 또는 z=0)부터.
function railReach(kind: 'side' | 'front', leanDeg: number, cone: THREE.Vector3, useClav: boolean, y: number) {
  const lean = kind === 'side' ? qAxis(V(0, 0, -1), leanDeg) : qAxis(V(1, 0, 0), leanDeg);
  let maxD = 0;
  for (let d = 0.2; d <= 0.9001; d += 0.01) {
    let ok = false;
    for (let s = -0.4; s <= 0.6001 && !ok; s += 0.02) {
      const T = kind === 'side' ? V(d, y, s) : V(s, y, d);
      if (inTorso(toTorsoFrame(T, { lean, clav: I }), 0.03)) continue;
      ok = useClav ? !!withClav(T, lean, cone) : solve(T, { lean, clav: I }, cone, RELAXED).ok;
    }
    if (ok) maxD = d; else if (maxD > 0) break;
  }
  return r3(maxD);
}
for (const y of [HIP.y, 0.9]) for (const kind of ['side', 'front'] as const) for (const lean of [0, 20]) for (const [cn, cv] of Object.entries(CONES)) {
  out.rails[`${kind}_y${y.toFixed(2)}_lean${lean}_${cn}`] = { noClav: railReach(kind, lean, cv, false, y), clav20: railReach(kind, lean, cv, true, y) };
}
writeFileSync('spike/fbx/out/reach.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.arm));
for (const [n, e] of Object.entries<any>(out.wounds)) for (const cn of Object.keys(CONES))
  console.log(n.padEnd(17), cn.padEnd(8), 'T', e.target.join(','), 'd', e[cn].coneOnly.d, 'inRange', e[cn].coneOnly.inRange, 'elbow', e[cn].coneOnly.elbow,
    'swing', e[cn].coneOnly.minSwing, e[cn].coneOnly.ok, '| strict', e[cn].strict.minSwing, '| relaxed', e[cn].relaxed.minSwing, e[cn].relaxed.ok, '| clav', JSON.stringify(e[cn].clavicle), e.lean20 && cn === 'lateral' ? 'lean20 ' + JSON.stringify(e.lean20) + ' minLean ' + JSON.stringify(e.minLean) : '');
for (const [k, v] of Object.entries(out.rails)) console.log(k.padEnd(32), JSON.stringify(v));
