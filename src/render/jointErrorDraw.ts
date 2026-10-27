// 관절 오차 표시 (SPEC v0.2 로그·시각화 "관절별 오차 각도"). 관절점마다 구를 그리고 근육 목표와의 오차로 색·크기를 바꾼다.
// 관절점 = 자식 바디 위치 + 회전·anchorInChild. 상태를 읽기만 한다.
import * as THREE from 'three';
import type { CharacterDef, CharacterStateLite } from './stateTypes';
import type { FilmConfig } from './scene';

const OK = new THREE.Color('#20b040');
const MID = new THREE.Color('#f0c000');
const BAD = new THREE.Color('#e02020');

/** 오차 비율 0~1 → 초록 → 노랑 → 빨강 */
export function errorColor(ratio: number, out = new THREE.Color()): THREE.Color {
  const r = Math.min(1, Math.max(0, ratio));
  return r < 0.5 ? out.copy(OK).lerp(MID, r * 2) : out.copy(MID).lerp(BAD, (r - 0.5) * 2);
}

export class JointErrorDraw {
  readonly group = new THREE.Group();
  private readonly items: { body: string; anchor: THREE.Vector3; mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> }[] = [];
  private readonly radius: number;
  private readonly maxDeg: number;

  constructor(def: CharacterDef, cfg: FilmConfig) {
    this.radius = cfg.debug.jointErrorRadius ?? 0.025;
    this.maxDeg = cfg.debug.jointErrorMaxDeg ?? 20;
    const geom = new THREE.SphereGeometry(1, 12, 8);
    for (const b of def.bodies) {
      if (!b.joint) continue;
      const mat = new THREE.MeshBasicMaterial({ color: OK.clone(), depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 12;
      this.group.add(mesh);
      this.items.push({ body: b.name, anchor: new THREE.Vector3(...b.joint.anchorInChild), mesh });
    }
  }

  update(state: CharacterStateLite): void {
    const q = new THREE.Quaternion();
    for (const it of this.items) {
      const s = state.bodies[it.body];
      const err = state.joints?.[it.body]?.errorDeg;
      it.mesh.visible = !!s && typeof err === 'number';
      if (!s || typeof err !== 'number') continue;
      q.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      it.mesh.position.copy(it.anchor).applyQuaternion(q).add(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
      const ratio = err / this.maxDeg;
      it.mesh.scale.setScalar(this.radius * (1 + Math.min(1, ratio)));
      errorColor(ratio, it.mesh.material.color);
    }
  }
}
