// 레퍼런스 겹쳐 그리기 (SPEC 8.3 --compare): 사람 레퍼런스(Kimodo 클립을 우리 랙돌로 FK한 상태)를 반투명 회색 몸으로 그린다.
import * as THREE from 'three';
import { shapeGeometry } from './scene';
import type { CharacterDef, CharacterStateLite, Vec3 } from './stateTypes';

export const GHOST_COLOR = '#8a8a8a';

export class GhostBodies {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<string, THREE.Group>();

  constructor(def: CharacterDef, opacity = 0.35) {
    const mat = new THREE.MeshLambertMaterial({ color: GHOST_COLOR, transparent: true, opacity, depthWrite: false });
    for (const body of def.bodies) {
      const g = new THREE.Group();
      for (const part of [{ shape: body.shape, position: [0, 0, 0] as Vec3 }, ...(body.extraShapes ?? [])]) {
        const { geom, rot } = shapeGeometry(part.shape);
        const m = new THREE.Mesh(geom, mat);
        m.quaternion.copy(rot);
        m.position.set(...part.position);
        m.renderOrder = 5;
        g.add(m);
      }
      this.group.add(g);
      this.bodies.set(body.name, g);
    }
  }

  applyState(state: CharacterStateLite | null): void {
    this.group.visible = !!state;
    if (!state) return;
    for (const [name, g] of this.bodies) {
      const s = state.bodies[name];
      g.visible = !!s;
      if (!s) continue;
      g.position.set(s.pos[0], s.pos[1], s.pos[2]);
      g.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
    }
  }
}
