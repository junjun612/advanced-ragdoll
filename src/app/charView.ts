// 앱 캐릭터 하나 그리기: 캡슐(캐릭터 색, 근육 강도 색), FBX 스킨(캐릭터 색), 디버그 표시, 관절 오차, 핀 세기 빛.
// 첫 캐릭터는 필름스트립과 같은 파랑(film.json bodyColor), 두 번째부터 render/others.ts otherColors (필름과 같은 색 체계).
// sim 상태를 읽기만 한다.
import * as THREE from 'three';
import { bodyStrength, shapeGeometry, type FilmConfig } from '../render/scene';
import { DebugDraw } from '../render/debugDraw';
import { JointErrorDraw } from '../render/jointErrorDraw';
import { FbxSkin, type SkinConfig } from '../render/skin';
import { displayState } from '../render/blend';
import { otherColors } from '../render/others';
import type { CharacterDef, CharacterStateLite, FilmEvent, Vec3 } from '../render/stateTypes';

/** 첫 캐릭터 이름표 색 (필름스트립 PRIMARY_CSS와 같음) */
export const PRIMARY_CSS = '#2e52a0';

export interface CharColors { strong: Vec3; weak: Vec3; skin?: Vec3; css: string }

export function charColors(cfg: FilmConfig, i: number): CharColors {
  return i === 0 ? { strong: cfg.bodyColor.strong, weak: cfg.bodyColor.weak, css: PRIMARY_CSS } : otherColors(cfg, i - 1);
}

/** 핀 세기 색 (주황, 필름 RagdollScene과 같은 빛) */
const PIN_GLOW: Vec3 = [0.95, 0.45, 0];

export class CharView {
  readonly group = new THREE.Group();
  /** 캡슐 묶음 (바디 이름 → 그룹). 피킹은 name으로 바디를 찾는다 */
  readonly bodies = new Map<string, { g: THREE.Group; m: THREE.MeshLambertMaterial }>();
  readonly debug: DebugDraw;
  readonly jointErr: JointErrorDraw;
  skin: FbxSkin | null = null;
  readonly colors: CharColors;
  private readonly strong: THREE.Color;
  private readonly weak: THREE.Color;
  showStrength = true;
  showPin = true;

  constructor(readonly def: CharacterDef, readonly index: number, cfg: FilmConfig) {
    this.colors = charColors(cfg, index);
    this.strong = new THREE.Color(...this.colors.strong);
    this.weak = new THREE.Color(...this.colors.weak);
    for (const body of def.bodies) {
      const m = new THREE.MeshLambertMaterial({ color: this.strong.clone() });
      const g = new THREE.Group();
      g.name = body.name;
      for (const part of [{ shape: body.shape, position: [0, 0, 0] as Vec3 }, ...(body.extraShapes ?? [])]) {
        const { geom, rot } = shapeGeometry(part.shape);
        const mesh = new THREE.Mesh(geom, m);
        mesh.quaternion.copy(rot);
        mesh.position.set(...part.position);
        g.add(mesh);
      }
      g.userData.charIndex = index;
      this.group.add(g);
      this.bodies.set(body.name, { g, m });
    }
    this.debug = new DebugDraw(cfg);
    this.jointErr = new JointErrorDraw(def, cfg);
    this.jointErr.group.visible = false;
    this.group.add(this.debug.group, this.jointErr.group);
  }

  /** FBX 스킨 입히기 (첫 캐릭터는 skin.json 색, 나머지는 캐릭터 색) */
  attachSkin(fbx: ArrayBuffer, skinCfg: SkinConfig): FbxSkin {
    const col = this.colors.skin;
    const sc: SkinConfig = col ? { ...skinCfg, color: { surface: col, joints: skinCfg.color?.joints ?? [0.22, 0.24, 0.3] } } : skinCfg;
    this.skin = new FbxSkin(fbx.slice(0), this.def, sc);
    this.group.add(this.skin.root);
    return this.skin;
  }

  setCapsules(visible: boolean, opacity: number): void {
    for (const b of this.bodies.values()) {
      for (const m of b.g.children) m.visible = visible;
      b.m.transparent = opacity < 1;
      b.m.opacity = opacity;
      b.m.depthWrite = opacity >= 1;
    }
  }

  /** 상태 반영. pinBodies = 바디별 핀 세기(핀 보조 + 애니 강제 중 큰 값) */
  apply(state: CharacterStateLite, events: readonly FilmEvent[], now: number, skinOn: boolean, pinBodies: Partial<Record<string, number>>): void {
    for (const [name, b] of this.bodies) {
      const s = state.bodies[name];
      b.g.visible = !!s;
      if (!s) continue;
      b.g.position.set(s.pos[0], s.pos[1], s.pos[2]);
      b.g.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      b.m.color.copy(this.weak).lerp(this.strong, this.showStrength ? bodyStrength(state, name) : 1);
      const pw = this.showPin ? Math.min(1, pinBodies[name] ?? 0) : 0;
      b.m.emissive.setRGB(PIN_GLOW[0] * pw, PIN_GLOW[1] * pw, PIN_GLOW[2] * pw);
    }
    if (this.skin) {
      this.skin.root.visible = skinOn && !!state.bodies.Hips;
      if (skinOn) this.skin.applyState(displayState(state));
    }
    this.debug.update(state, events, now);
    if (this.jointErr.group.visible) this.jointErr.update(state);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
  }
}
