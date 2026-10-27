// Node에서 FBXLoader.parse(ArrayBuffer)로 읽는다. DOM 셈(shim) 없이 동작한다 (Mixamo FBX에 텍스처가 없어서 TextureLoader 경로를 타지 않음).
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export const CM = 0.01;
export const PREFIX = 'mixamorig';

export function loadFbx(path: string): THREE.Group {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const g = new FBXLoader().parse(ab, '');
  g.updateMatrixWorld(true);
  return g;
}

/** FBXLoader는 여러 스킨에 공유된 본을 이름이 같은 자식 본(항등 로컬)으로 복제한다. 바깥(첫) 본만 쓴다. */
export function boneMap(g: THREE.Object3D): Map<string, THREE.Bone> {
  const m = new Map<string, THREE.Bone>();
  g.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      const n = o.name.startsWith(PREFIX) ? o.name.slice(PREFIX.length) : o.name;
      if (!m.has(n)) m.set(n, o as THREE.Bone);
    }
  });
  return m;
}

export const strip = (n: string) => (n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n);

export function worldPos(b: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).multiplyScalar(CM);
}
