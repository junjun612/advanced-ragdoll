// (v0.8c) 여러 캐릭터·프롭 그리기: 두 번째 이후 캐릭터는 다른 색 캡슐(근육 강도 색 그대로), 프롭은 나무색 상자·구·캡슐.
// sim 상태를 읽기만 한다. 필름스트립·하이라이트 영상·앱이 같이 쓴다.
import * as THREE from 'three';
import { bodyStrength, shapeGeometry, type FilmConfig } from './scene';
import type { CharacterDef, CharacterStateLite, FilmEvent, PropMetaLite, PropStateLite, Vec3 } from './stateTypes';

/** 두 번째 이후 캐릭터 색 (강 → 약). 없으면 config/film.json otherColors 기본 */
export interface CharacterColors { strong: Vec3; weak: Vec3; skin?: Vec3; css: string }

export const DEFAULT_OTHER_COLORS: CharacterColors[] = [
  { strong: [0.72, 0.3, 0.1], weak: [0.97, 0.85, 0.74], skin: [0.78, 0.5, 0.36], css: '#b84c1a' },
  { strong: [0.15, 0.5, 0.25], weak: [0.8, 0.93, 0.82], skin: [0.45, 0.66, 0.5], css: '#26803f' },
];

export function otherColors(cfg: FilmConfig, i: number): CharacterColors {
  const list = (cfg as FilmConfig & { otherColors?: CharacterColors[] }).otherColors ?? DEFAULT_OTHER_COLORS;
  return list[i % list.length]!;
}

/** 다른 캐릭터 캡슐 묶음 (RagdollScene.applyState와 같은 규칙, 색만 다름) */
export class CharacterMeshes {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<string, { g: THREE.Group; m: THREE.MeshLambertMaterial }>();
  private readonly strong: THREE.Color;
  private readonly weak: THREE.Color;

  constructor(def: CharacterDef, colors: CharacterColors) {
    this.strong = new THREE.Color(...colors.strong);
    this.weak = new THREE.Color(...colors.weak);
    for (const body of def.bodies) {
      const m = new THREE.MeshLambertMaterial({ color: this.strong.clone() });
      const g = new THREE.Group();
      for (const part of [{ shape: body.shape, position: [0, 0, 0] as Vec3 }, ...(body.extraShapes ?? [])]) {
        const { geom, rot } = shapeGeometry(part.shape);
        const mesh = new THREE.Mesh(geom, m);
        mesh.quaternion.copy(rot);
        mesh.position.set(...part.position);
        g.add(mesh);
      }
      this.group.add(g);
      this.bodies.set(body.name, { g, m });
    }
  }

  setCapsulesVisible(on: boolean): void {
    for (const b of this.bodies.values()) for (const m of b.g.children) m.visible = on;
  }

  applyState(state: CharacterStateLite | null): void {
    this.group.visible = !!state;
    if (!state) return;
    for (const [name, b] of this.bodies) {
      const s = state.bodies[name];
      b.g.visible = !!s;
      if (!s) continue;
      b.g.position.set(s.pos[0], s.pos[1], s.pos[2]);
      b.g.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      b.m.color.copy(this.weak).lerp(this.strong, bodyStrength(state, name));
    }
  }
}

const PROP_COLOR: Vec3 = [0.7, 0.52, 0.3];

/** 프롭 메시 (meta.props 형상) */
export class PropMeshes {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Mesh>();

  constructor(props: readonly PropMetaLite[]) {
    for (const p of props) {
      const s = p.shape;
      const geom = s.type === 'box' ? new THREE.BoxGeometry(2 * s.halfExtents[0], 2 * s.halfExtents[1], 2 * s.halfExtents[2])
        : s.type === 'sphere' ? new THREE.SphereGeometry(s.radius, 18, 12) : new THREE.CapsuleGeometry(s.radius, 2 * s.halfHeight, 6, 14);
      const c = p.color ?? PROP_COLOR;
      const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]) }));
      if (s.type === 'box') {
        // 상자 모서리 선 (나무 상자처럼 보이게)
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: 0x5a3c1c }));
        mesh.add(edges);
      }
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.set(p.id, mesh);
    }
  }

  applyState(states: readonly PropStateLite[] | null | undefined): void {
    for (const m of this.meshes.values()) m.visible = false;
    for (const s of states ?? []) {
      const m = this.meshes.get(s.id);
      if (!m) continue;
      m.visible = true;
      m.position.set(s.pos[0], s.pos[1], s.pos[2]);
      m.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
    }
  }
}

/** 캐릭터 하나의 이벤트만 (여러 캐릭터 로그: char가 그 이름이거나 없는 것 — 월드 이벤트) */
export function eventsFor(events: readonly FilmEvent[] | undefined, name: string | undefined): FilmEvent[] {
  if (!events) return [];
  if (name === undefined) return [...events];
  return events.filter((e) => e.char === undefined || e.char === name);
}

/**
 * 여러 캐릭터 카메라: 모든 캐릭터 COM의 가운데를 보고, 화면 가로 방향으로 퍼진 폭이 화면에 들어오게 거리를 늘린다
 * (side: z 폭, front: x 폭, follow: 둘 중 큰 것). 돌려주는 값 = 기준 COM, 카메라 거리 배율
 */
export function groupFraming(states: readonly (CharacterStateLite | null)[], kind: string, cfg: FilmConfig, margin = 0.9, maxZoom = 2.2): { com: Vec3; distance: number } {
  const live = states.filter((s): s is CharacterStateLite => !!s);
  const com: Vec3 = [0, 0, 0];
  for (const s of live) { com[0] += s.com[0] / live.length; com[1] += s.com[1] / live.length; com[2] += s.com[2] / live.length; }
  let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of live) for (const b of Object.values(s.bodies)) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, b.pos[k]!); hi[k] = Math.max(hi[k]!, b.pos[k]!); }
  if (!live.length) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
  const wx = hi[0] - lo[0], wz = hi[2] - lo[2];
  const w = kind === 'side' ? wz : kind === 'front' ? wx : Math.hypot(wx, wz);
  const half = Math.tan((cfg.camera.fovDeg * Math.PI) / 360);
  const need = (w / 2 + margin) / half;
  // 너무 멀어지면(maxDistance 넘음) 첫 캐릭터를 따라간다
  if (need > cfg.camera.distance * maxZoom && live[0]) return { com: [...live[0].com] as Vec3, distance: cfg.camera.distance };
  return { com: [(lo[0] + hi[0]) / 2, com[1], (lo[2] + hi[2]) / 2], distance: Math.max(cfg.camera.distance, need) };
}

/** groupFraming 결과로 카메라 배치용 설정 (follow는 오프셋을 거리 배율만큼 늘린다) */
export function framedConfig(cfg: FilmConfig, distance: number): FilmConfig {
  const k = distance / cfg.camera.distance;
  const o = cfg.camera.followOffset;
  return { ...cfg, camera: { ...cfg.camera, distance, followOffset: [o[0] * k, o[1] * k, o[2] * k] } };
}
