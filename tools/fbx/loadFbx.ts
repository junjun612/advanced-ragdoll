// Node용 Mixamo FBX 로더 (v0.0 FBX 스파이크 결론, docs/SPIKE-fbx.md 1장).
// - FBXLoader.parse(ArrayBuffer)를 쓴다. 텍스처 없는 Mixamo FBX는 DOM 셈이 필요 없다.
// - 본 이름에서 ':'가 빠져 'mixamorigHips'가 된다 → 접두어 'mixamorig'(콜론 있든 없든)를 뗀다.
// - 스킨 메시가 두 개면 공유 본이 같은 이름의 자식(로컬 항등)으로 복제된다 → 이름별로 처음 나온(바깥) 본만 쓴다.
// - 단위는 cm다 → 위치에 ×0.01을 곱해 미터로 돌려준다.
// three.js는 tools/에서만 쓴다. 결과는 sim 수학 타입(plain 배열)으로 넘긴다.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { Vec3 } from '../../src/sim/math/vec3';
import type { Quat } from '../../src/sim/math/quat';

export const CM_TO_M = 0.01;

export function stripMixamoPrefix(name: string): string {
  const m = /^mixamorig:?/.exec(name);
  return m ? name.slice(m[0].length) : name;
}

export function loadFbxGroup(path: string): THREE.Group {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const g = new FBXLoader().parse(ab, '');
  g.updateMatrixWorld(true);
  return g;
}

/** 접두어를 뗀 이름 → 처음 나온(바깥) 본. traverse 순서(깊이 우선)라서 복제 자식보다 원본이 먼저 나온다. */
export function boneMap(root: THREE.Object3D): Map<string, THREE.Bone> {
  const m = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      const n = stripMixamoPrefix(o.name);
      if (!m.has(n)) m.set(n, o as THREE.Bone);
    }
  });
  return m;
}

export interface SkeletonBone {
  name: string;
  /** 접두어 뗀 부모 본 이름. 루트면 null. 복제 본은 건너뛰고 원본 본의 부모를 쓴다. */
  parent: string | null;
  /** rest 월드 위치 (m) */
  worldPos: Vec3;
  /** rest 월드 회전 */
  worldRot: Quat;
}

export interface SkinVertex {
  /** rest(=bind) 스키닝 결과 월드 위치 (m) */
  pos: Vec3;
  /** (본 이름, 가중치) 최대 4개, 가중치 > 0만 */
  influences: [string, number][];
}

export interface FbxSkeletonData {
  source: string;
  /** 계층 순서(부모가 자식보다 먼저) */
  bones: SkeletonBone[];
  meshes: { name: string; vertices: SkinVertex[] }[];
}

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/** FBX에서 스켈레톤(중복 제거)과 선택적으로 스킨 정점을 읽는다. */
export function readFbxSkeleton(path: string, opts: { withSkin?: boolean } = {}): FbxSkeletonData {
  const g = loadFbxGroup(path);
  const map = boneMap(g);
  const bones: SkeletonBone[] = [];
  for (const [name, b] of map) {
    const p = new THREE.Vector3(), r = new THREE.Quaternion(), s = new THREE.Vector3();
    b.matrixWorld.decompose(p, r, s);
    let par: THREE.Object3D | null = b.parent;
    while (par && (par as THREE.Bone).isBone && stripMixamoPrefix(par.name) === name) par = par.parent;
    bones.push({
      name,
      parent: par && (par as THREE.Bone).isBone ? stripMixamoPrefix(par.name) : null,
      worldPos: v3(p.multiplyScalar(CM_TO_M)),
      worldRot: [r.x, r.y, r.z, r.w],
    });
  }
  const meshes: FbxSkeletonData['meshes'] = [];
  if (opts.withSkin) {
    const skinned: THREE.SkinnedMesh[] = [];
    g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
    for (const m of skinned) {
      m.skeleton.update();
      const si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!, pos = m.geometry.attributes.position!;
      const names = m.skeleton.bones.map((b) => stripMixamoPrefix(b.name));
      const vertices: SkinVertex[] = [];
      for (let i = 0; i < pos.count; i++) {
        const influences: [string, number][] = [];
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w > 0) influences.push([names[si.getComponent(i, k)]!, w]);
        }
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        m.applyBoneTransform(i, p);
        p.applyMatrix4(m.matrixWorld).multiplyScalar(CM_TO_M);
        vertices.push({ pos: v3(p), influences });
      }
      meshes.push({ name: m.name, vertices });
    }
  }
  return { source: path, bones, meshes };
}
