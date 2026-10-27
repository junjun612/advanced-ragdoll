// three.js 장면: 캐릭터 설정의 형상으로 바디 메시를 만들고 CharacterState를 읽어 배치한다.
// sim 상태를 읽기만 한다. Node 전용 API를 쓰지 않는다(브라우저 앱과 필름 페이지가 같이 쓴다).
import * as THREE from 'three';
import type { CameraKind, CharacterDef, CharacterStateLite, Vec3 } from './stateTypes';
import type { ShapeDef } from '../sim/character/characterDef';
import simCfg from '../../config/sim.json';
import { terrainDef, TERRAINS, type TerrainName } from '../sim/terrain';

/** 경사 지형 각(도). sim의 world.ts와 같은 config/sim.json 값 (원점을 지나고 +Z 쪽으로 올라감) */
export function terrainSlopeDeg(terrain: string | undefined): number {
  return (simCfg.terrain.slopeDeg as Record<string, number>)[terrain ?? 'flat'] ?? 0;
}

export interface FilmConfig {
  cellSize: number;
  columns: number;
  frameInterval: number;
  impactShowSec: number;
  headerHeight: number;
  font: string;
  camera: { fovDeg: number; targetHeight: number; elevation: number; distance: number; topHeight: number; followOffset: Vec3 };
  debug: {
    comRadius: number; capturePointRadius: number; grabTargetRadius: number;
    crossHalf: number; arrowLengthBase: number; arrowLengthPerDv: number;
    /** 균형 가상 힘 화살표 길이 (m/N, v0.3) */
    forceLengthPerN?: number;
    /** QP 접촉력 막대 길이 (m/N, v0.3) */
    contactLengthPerN?: number;
    /** 각운동량 화살표 길이 (m per kg·m²/s, v0.3) */
    angMomLengthPer?: number;
    /** 앱 관절 오차 표시 (jointErrorDraw.ts) */
    jointErrorRadius?: number; jointErrorMaxDeg?: number;
  };
  bodyColor: { strong: Vec3; weak: Vec3 };
}

interface BodyMesh {
  group: THREE.Group;
  material: THREE.MeshLambertMaterial;
}

export function shapeGeometry(s: ShapeDef): { geom: THREE.BufferGeometry; rot: THREE.Quaternion } {
  const rot = new THREE.Quaternion();
  switch (s.type) {
    case 'capsule':
      rot.set(s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]);
      // three CapsuleGeometry의 height는 가운데 원통 길이 = 2 × halfHeight, 축은 +Y
      return { geom: new THREE.CapsuleGeometry(s.radius, 2 * s.halfHeight, 6, 14), rot };
    case 'sphere':
      return { geom: new THREE.SphereGeometry(s.radius, 18, 12), rot };
    case 'box':
      return { geom: new THREE.BoxGeometry(2 * s.halfExtents[0], 2 * s.halfExtents[1], 2 * s.halfExtents[2]), rot };
  }
}

/** 바디의 근육 강도(0~1). 관절 이름 = 자식 바디 이름. 루트(관절 없음)는 전체 평균. 없으면 1. */
export function bodyStrength(state: CharacterStateLite, bodyName: string): number {
  const joints = state.joints;
  if (!joints) return 1;
  const j = joints[bodyName];
  if (j && typeof j.strength === 'number') return clamp01(j.strength);
  const vals = Object.values(joints).map((x) => x.strength).filter((x): x is number => typeof x === 'number');
  return vals.length ? clamp01(vals.reduce((a, b) => a + b, 0) / vals.length) : 1;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export class RagdollScene {
  readonly scene = new THREE.Scene();
  readonly bodies = new Map<string, BodyMesh>();
  /** 지면 메시·격자 (경사 지형이면 돌린다) */
  readonly groundGroup = new THREE.Group();
  /** (v0.8a) 지형 상자 (계단 단·모서리 받침·장애물): 면 + 모서리 선 */
  readonly terrainGroup = new THREE.Group();
  /** false면 근육 강도 색 대신 강한 색 하나로 칠한다 (앱 디버그 토글) */
  showStrength = true;
  private readonly strong: THREE.Color;
  private readonly weak: THREE.Color;

  constructor(def: CharacterDef, cfg: FilmConfig) {
    this.scene.background = new THREE.Color(0xf4f4f0);
    this.strong = new THREE.Color(...cfg.bodyColor.strong);
    this.weak = new THREE.Color(...cfg.bodyColor.weak);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 5, 3);
    this.scene.add(sun);

    // 지면: 옅은 바닥 + 0.5m 격자 (1m 선은 진하게). 경사 지형이면 setTerrain이 이 묶음을 X축으로 돌린다
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshLambertMaterial({ color: 0xe2e2da }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.groundGroup.add(ground);
    const fine = new THREE.GridHelper(60, 120, 0xc4c4ba, 0xc4c4ba);
    fine.position.y = 0.001;
    this.groundGroup.add(fine);
    const coarse = new THREE.GridHelper(60, 60, 0x9a9a90, 0x9a9a90);
    coarse.position.y = 0.002;
    this.groundGroup.add(coarse);
    this.scene.add(this.groundGroup);
    this.scene.add(this.terrainGroup);

    for (const body of def.bodies) {
      const material = new THREE.MeshLambertMaterial({ color: this.strong.clone() });
      const group = new THREE.Group();
      group.name = body.name;
      // 주 형상 + 추가 형상(복합 콜라이더)을 모두 그린다
      for (const part of [{ shape: body.shape, position: [0, 0, 0] as Vec3 }, ...(body.extraShapes ?? [])]) {
        const { geom, rot } = shapeGeometry(part.shape);
        const mesh = new THREE.Mesh(geom, material);
        mesh.quaternion.copy(rot);
        mesh.position.set(...part.position);
        group.add(mesh);
      }
      group.position.set(...body.restPosition);
      const r = body.restRotation;
      group.quaternion.set(r[0], r[1], r[2], r[3]);
      this.scene.add(group);
      this.bodies.set(body.name, { group, material });
    }
  }

  /** 지형 맞추기 (v0.3): 경사면은 원점을 지나고 +Z 쪽으로 올라가도록 지면 묶음을 X축으로 −각 돌린다 */
  setTerrain(terrain: string | undefined): void {
    this.groundGroup.rotation.x = (-terrainSlopeDeg(terrain) * Math.PI) / 180;
    // (v0.8a) 상자 지형: sim과 같은 정의(src/sim/terrain.ts)로 그린다. 디딤면은 바닥보다 조금 진하게, 모서리는 진한 선(계단 코가 보이게)
    for (const c of [...this.terrainGroup.children]) this.terrainGroup.remove(c);
    const name = (terrain ?? 'flat') as TerrainName;
    if (!(TERRAINS as readonly string[]).includes(name)) return;
    const color: Record<string, number> = { step: 0xcfcfc4, platform: 0xc8c8bc, obstacle: 0xb8865a };
    for (const b of terrainDef(name).boxes) {
      const geom = new THREE.BoxGeometry(2 * b.half[0], 2 * b.half[1], 2 * b.half[2]);
      const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: color[b.kind] ?? 0xcfcfc4 }));
      mesh.position.set(b.center[0], b.center[1], b.center[2]);
      this.terrainGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: 0x5a5a52 }));
      edges.position.copy(mesh.position);
      this.terrainGroup.add(edges);
    }
    // (v0.8b) 난간대·기둥(원기둥), 벽(상자) — sim과 같은 정의
    for (const p of terrainDef(name).props) {
      if (p.kind === 'wall') {
        const geom = new THREE.BoxGeometry(2 * p.half[0], 2 * p.half[1], 2 * p.half[2]);
        const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0xd9d3c3 }));
        mesh.position.set(p.center[0], p.center[1], p.center[2]);
        this.terrainGroup.add(mesh);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: 0x6a665a }));
        edges.position.copy(mesh.position);
        this.terrainGroup.add(edges);
        continue;
      }
      const a = new THREE.Vector3(...p.a), b = new THREE.Vector3(...p.b);
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, len, 16), new THREE.MeshLambertMaterial({ color: p.kind === 'rail' ? 0x7a6a58 : 0x8c8c90 }));
      mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      this.terrainGroup.add(mesh);
    }
  }

  /** 캡슐(바디 형상) 표시 토글. 숨겨도 applyState의 표시 판단은 그대로 둔다. */
  setCapsulesVisible(on: boolean): void {
    for (const b of this.bodies.values()) for (const m of b.group.children) m.visible = on;
  }

  /** 캡슐 불투명도 (1 = 불투명). FBX와 겹쳐 볼 때 낮춘다. */
  setCapsuleOpacity(opacity: number): void {
    for (const b of this.bodies.values()) {
      b.material.transparent = opacity < 1;
      b.material.opacity = opacity;
      b.material.depthWrite = opacity >= 1;
      b.material.needsUpdate = true;
    }
  }

  /** 상태를 읽어 바디 위치·회전·근육 강도 색을 맞춘다. 로그에 없는 바디는 숨긴다. */
  applyState(state: CharacterStateLite): void {
    for (const [name, b] of this.bodies) {
      const s = state.bodies[name];
      b.group.visible = !!s;
      if (!s) continue;
      b.group.position.set(s.pos[0], s.pos[1], s.pos[2]);
      b.group.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      b.material.color.copy(this.weak).lerp(this.strong, this.showStrength ? bodyStrength(state, name) : 1);
      // 핀 보조 세기 (v0.6): 주황으로 빛나게 (SPEC '핀 강도를 바디 테두리 색으로')
      const pw = Math.min(1, state.pin?.bodies?.[name] ?? 0);
      b.material.emissive.setRGB(0.95 * pw, 0.45 * pw, 0);
    }
  }
}

/** 카메라 라벨 (이미지 안 텍스트는 한글) */
export const CAMERA_LABEL: Record<CameraKind, string> = {
  side: '측면', front: '정면', top: '위', follow: '추적',
};

export function makeCamera(cfg: FilmConfig, aspect = 1): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(cfg.camera.fovDeg, aspect, 0.05, 100);
}

/**
 * 카메라 배치. side/front/follow는 COM을 수평으로만 따라가고 높이는 서 있는 1.8m 캐릭터에 맞춘 고정값.
 * side: +X 쪽에서 −X 방향으로 본다(화면 왼쪽이 캐릭터 정면 +Z). front: +Z에서 −Z로(얼굴을 본다). top: 위에서 아래로.
 */
export function placeCamera(camera: THREE.PerspectiveCamera, kind: CameraKind, com: Readonly<Vec3>, cfg: FilmConfig): void {
  const c = cfg.camera;
  // 높이는 고정값, 단 몸이 높이 뜨면(폭발·낙하) COM을 따라 올린다 (서 있을 때는 그대로)
  const tx = com[0], tz = com[2], ty = Math.max(c.targetHeight, com[1] - 0.1);
  camera.up.set(0, 1, 0);
  switch (kind) {
    case 'side':
      camera.position.set(tx + c.distance, ty + c.elevation, tz);
      break;
    case 'front':
      camera.position.set(tx, ty + c.elevation, tz + c.distance);
      break;
    case 'top':
      camera.position.set(tx, c.topHeight, tz);
      camera.up.set(0, 0, -1); // 화면 위 = −Z, 화면 오른쪽 = +X
      camera.lookAt(tx, 0, tz);
      camera.updateProjectionMatrix();
      return;
    case 'follow': {
      const o = c.followOffset;
      camera.position.set(tx + o[0], ty + o[1], tz + o[2]);
      break;
    }
  }
  camera.lookAt(tx, ty, tz);
  camera.updateProjectionMatrix();
}
