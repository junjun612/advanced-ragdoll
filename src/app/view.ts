// 앱 3D 뷰: 장면(지면·지형·난간·벽)과 캐릭터 여럿(캡슐·FBX·디버그 표시), 프롭, 궤도·추적 카메라, 이름표,
// 마우스 입력(바디 끌어 밀기, 바디 클릭 총탄·근접, 바닥 클릭 폭발·프롭 던지기·시선·캐릭터 놓기)을 맡는다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RagdollScene, type FilmConfig } from '../render/scene';
import { PropMeshes } from '../render/others';
import type { SkinConfig } from '../render/skin';
import type { CharacterDef, CharacterStateLite, FilmEvent, PropMetaLite, PropStateLite, Vec3 } from '../render/stateTypes';
import type { BodyName } from '../sim/api';
import type { AppConfig } from './simHost';
import { CharView } from './charView';

export type DisplayMode = 'capsule' | 'fbx' | 'both';
export type InputMode = 'push' | 'bullet' | 'melee' | 'explosion' | 'throw' | 'look' | 'place';
export type DebugPart = 'com' | 'support' | 'balance' | 'impact' | 'strength' | 'pin' | 'jointError' | 'debug' | 'tags';

export interface DragState {
  ci: number;
  body: BodyName;
  /** 잡은 지점(월드) */
  point: Vec3;
  /** 현재 드래그 끝(월드, 잡은 지점을 지나는 화면 평면 위) */
  end: Vec3;
  /** 화면상 드래그 길이(px) */
  px: number;
}

/** 캐릭터 하나 그릴 거리 */
export interface CharFrame {
  state: CharacterStateLite;
  events: readonly FilmEvent[];
  label: string;
  /** 바디별 핀 세기 (핀 보조 + 애니 강제) */
  pin: Partial<Record<string, number>>;
}

export class AppView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly rs: RagdollScene;
  readonly chars: CharView[] = [];
  mode: DisplayMode = 'fbx';
  input: InputMode = 'push';
  follow = false;
  drag: DragState | null = null;
  /** 드래그를 놓았을 때 (밀기). 짧은 드래그는 부르지 않는다 */
  onPush: ((ci: number, body: BodyName, point: Vec3, dir: Vec3) => void) | null = null;
  /** 드래그 중 갱신 (표시용) */
  onDrag: ((d: DragState | null) => void) | null = null;
  /** 바디 클릭 (총탄·근접): 방향 = 시선 광선 */
  onStrike: ((kind: 'bullet' | 'melee', ci: number, body: BodyName, point: Vec3, dir: Vec3) => void) | null = null;
  /** 바닥(또는 아무 곳) 클릭: 폭발·프롭 던지기·시선·캐릭터 놓기. from = 카메라 위치 */
  onGround: ((mode: InputMode, point: Vec3, from: Vec3) => void) | null = null;

  private fbx: ArrayBuffer | null = null;
  private skinCfg: SkinConfig | null = null;
  private props: PropMeshes | null = null;
  private propKey = '';
  private readonly raycaster = new THREE.Raycaster();
  private readonly arrow: THREE.ArrowHelper;
  private readonly flash: THREE.Mesh;
  private flashT = -1;
  private dragPlane = new THREE.Plane();
  private dragStartPx: [number, number] = [0, 0];
  private downPx: [number, number] | null = null;
  private lastCenter: Vec3 | null = null;
  private readonly tagLayer: HTMLElement;
  private readonly tags: HTMLElement[] = [];
  private show: Record<DebugPart, boolean> = { com: true, support: true, balance: false, impact: true, strength: true, pin: true, jointError: false, debug: true, tags: true };

  constructor(readonly host: HTMLElement, def: CharacterDef, readonly filmCfg: FilmConfig, readonly cfg: AppConfig) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.prepend(this.renderer.domElement);
    this.rs = new RagdollScene(def, filmCfg);
    // 장면의 기본 캐릭터 메시는 쓰지 않는다 (캐릭터는 CharView가 그린다)
    for (const b of this.rs.bodies.values()) b.group.visible = false;
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.3, 0xf0a000, 0.1, 0.06);
    this.arrow.visible = false;
    this.arrow.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) { m.depthTest = false; o.renderOrder = 20; }
    });
    this.rs.scene.add(this.arrow);
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xff8a20, transparent: true, opacity: 0.5, depthWrite: false }));
    this.flash.visible = false;
    this.rs.scene.add(this.flash);

    const c = cfg.camera;
    this.camera = new THREE.PerspectiveCamera(c.fovDeg, 1, 0.05, 200);
    this.camera.position.set(...c.position);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...c.target);
    this.controls.enableDamping = true;
    this.controls.update();

    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'tag-layer';
    host.append(this.tagLayer);

    const el = this.renderer.domElement;
    // 캡처 단계: OrbitControls(버블 단계)보다 먼저 바디를 잡았는지 본다
    el.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', () => this.endDrag());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  /** FBX를 한 번 받아 둔다 (캐릭터마다 스킨을 만든다) */
  async loadSkin(url: string, skinCfg: SkinConfig): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FBX 불러오기 실패: ${res.status} ${url}`);
    this.fbx = await res.arrayBuffer();
    this.skinCfg = skinCfg;
    for (const cv of this.chars) if (!cv.skin) cv.attachSkin(this.fbx, skinCfg);
    this.applyMode();
  }

  get skinReady(): boolean {
    return !!this.fbx;
  }

  /** 월드가 바뀌면(리셋) 캐릭터 뷰를 맞춘다. defs = 캐릭터 정의 순서 */
  syncCharacters(defs: readonly CharacterDef[]): void {
    while (this.chars.length > defs.length || this.chars.some((cv, i) => defs[i] && cv.def !== defs[i])) {
      const cv = this.chars.pop()!;
      this.rs.scene.remove(cv.group);
      cv.dispose();
    }
    for (let i = this.chars.length; i < defs.length; i++) {
      const cv = new CharView(defs[i]!, i, this.filmCfg);
      if (this.fbx && this.skinCfg) cv.attachSkin(this.fbx, this.skinCfg);
      this.rs.scene.add(cv.group);
      this.chars.push(cv);
    }
    this.applyMode();
    this.applyShow();
  }

  setMode(m: DisplayMode): void {
    this.mode = m;
    this.applyMode();
  }

  private applyMode(): void {
    // FBX가 아직 없으면 캡슐로 보인다
    const skin = this.mode !== 'capsule' && !!this.fbx;
    for (const cv of this.chars) cv.setCapsules(this.mode !== 'fbx' || !skin, this.mode === 'both' ? 0.45 : 1);
  }

  setShow(part: DebugPart, on: boolean): void {
    this.show[part] = on;
    this.applyShow();
  }

  private applyShow(): void {
    const s = this.show;
    for (const cv of this.chars) {
      cv.debug.setPartVisible('com', s.com);
      cv.debug.setPartVisible('support', s.support);
      cv.debug.setPartVisible('capture', s.support);
      cv.debug.setPartVisible('balance', s.balance);
      cv.debug.setPartVisible('impact', s.impact);
      cv.debug.group.visible = s.debug;
      cv.showStrength = s.strength;
      cv.showPin = s.pin;
      cv.jointErr.group.visible = s.jointError;
    }
    this.tagLayer.style.display = s.tags ? '' : 'none';
  }

  setTerrain(terrain: string | undefined): void {
    this.rs.setTerrain(terrain);
  }

  /** 시뮬레이션 리셋 뒤 카메라 추적 기준을 지운다 */
  resetFollow(): void {
    this.lastCenter = null;
  }

  /** 폭발 표시 (반지름 r, 0.4초에 걸쳐 사라짐) */
  showExplosion(p: Vec3, now: number): void {
    this.flash.position.set(p[0], p[1], p[2]);
    this.flashT = now;
  }

  render(frames: readonly CharFrame[], props: { meta: PropMetaLite[]; states: PropStateLite[] } | null, now: number, wallNow: number): void {
    const skinOn = this.mode !== 'capsule' && !!this.fbx;
    frames.forEach((f, i) => this.chars[i]?.apply(f.state, f.events, now, skinOn, f.pin));
    // 프롭: 개수가 바뀌면 메시를 다시 만든다
    const key = props ? props.meta.map((m) => m.id).join(',') : '';
    if (key !== this.propKey) {
      if (this.props) { this.rs.scene.remove(this.props.group); }
      this.props = props && props.meta.length ? new PropMeshes(props.meta) : null;
      if (this.props) this.rs.scene.add(this.props.group);
      this.propKey = key;
    }
    this.props?.applyState(props?.states);
    // 폭발 빛
    const ft = (wallNow - this.flashT) / 400;
    this.flash.visible = this.flashT >= 0 && ft >= 0 && ft < 1;
    if (this.flash.visible) {
      this.flash.scale.setScalar(0.15 + 0.6 * ft);
      (this.flash.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - ft);
    }
    // 추적: 캐릭터 COM 가운데의 수평 이동만큼 카메라와 목표를 같이 옮긴다
    if (frames.length) {
      const cx = frames.reduce((a, f) => a + f.state.com[0], 0) / frames.length;
      const cz = frames.reduce((a, f) => a + f.state.com[2], 0) / frames.length;
      if (this.follow && this.lastCenter) {
        const dx = cx - this.lastCenter[0], dz = cz - this.lastCenter[2];
        this.camera.position.x += dx; this.camera.position.z += dz;
        this.controls.target.x += dx; this.controls.target.z += dz;
      }
      this.lastCenter = [cx, 0, cz];
    }
    this.controls.update();
    this.renderer.render(this.rs.scene, this.camera);
    this.updateTags(frames);
  }

  /** 머리 위 이름표 (캐릭터 색) */
  private updateTags(frames: readonly CharFrame[]): void {
    while (this.tags.length < frames.length) {
      const d = document.createElement('div');
      d.className = 'name-tag';
      this.tagLayer.append(d);
      this.tags.push(d);
    }
    const r = this.renderer.domElement.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
    this.tags.forEach((d, i) => {
      const f = frames[i];
      const h = f?.state.bodies.Head;
      if (!f || !h) { d.style.display = 'none'; return; }
      const v = new THREE.Vector3(h.pos[0], h.pos[1] + 0.25, h.pos[2]).project(this.camera);
      if (v.z > 1) { d.style.display = 'none'; return; }
      d.style.display = '';
      d.textContent = f.label;
      d.style.background = this.chars[i]?.colors.css ?? '#333';
      d.style.left = `${r.left - hr.left + ((v.x + 1) / 2) * r.width}px`;
      d.style.top = `${r.top - hr.top + ((1 - v.y) / 2) * r.height}px`;
    });
  }

  /** 월드 점의 화면 좌표(CSS px, 페이지 기준). 테스트·콘솔용 */
  screenOf(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  /** 카메라를 점 쪽으로 (시나리오 시작) */
  frameOn(center: Vec3, distanceScale = 1): void {
    const c = this.cfg.camera;
    const off = new THREE.Vector3(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]).multiplyScalar(distanceScale);
    this.controls.target.set(center[0], c.target[1] + Math.max(0, center[1]), center[2]);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** 포인터 아래 바디 (캡슐 형상으로 판정, 숨김 상태여도 판정한다) */
  private pick(e: PointerEvent): { ci: number; body: BodyName; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const groups = this.chars.flatMap((cv) => [...cv.bodies.values()].filter((b) => b.g.visible).map((b) => b.g));
    const hit = this.raycaster.intersectObjects(groups, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.charIndex === undefined) o = o.parent;
    return o ? { ci: o.userData.charIndex as number, body: o.name as BodyName, point: hit.point.clone() } : null;
  }

  /** 포인터 아래 지면·지형 점 (없으면 y=0 평면) */
  private pickGround(e: PointerEvent): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects([this.rs.terrainGroup, this.rs.groundGroup], true).find((h) => (h.object as THREE.Mesh).isMesh);
    if (hit) return hit.point.clone();
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const bodyMode = this.input === 'push' || this.input === 'bullet' || this.input === 'melee';
    if (!bodyMode) { this.downPx = [e.clientX, e.clientY]; return; }
    const p = this.pick(e);
    if (!p) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (this.input !== 'push') {
      const dir = this.raycaster.ray.direction.clone();
      if (this.input === 'melee') { dir.y = 0; dir.normalize(); }
      this.onStrike?.(this.input as 'bullet' | 'melee', p.ci, p.body, [p.point.x, p.point.y, p.point.z], [dir.x, dir.y, dir.z]);
      return;
    }
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    this.dragPlane.setFromNormalAndCoplanarPoint(n, p.point);
    this.dragStartPx = [e.clientX, e.clientY];
    const pt: Vec3 = [p.point.x, p.point.y, p.point.z];
    this.drag = { ci: p.ci, body: p.body, point: pt, end: [...pt], px: 0 };
    this.onDrag?.(this.drag);
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) {
      const bodyMode = this.input === 'push' || this.input === 'bullet' || this.input === 'melee';
      this.renderer.domElement.style.cursor = bodyMode ? (this.pick(e) ? (this.input === 'push' ? 'grab' : 'crosshair') : '') : 'crosshair';
      return;
    }
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const end = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, end)) return;
    this.drag.end = [end.x, end.y, end.z];
    this.drag.px = Math.hypot(e.clientX - this.dragStartPx[0], e.clientY - this.dragStartPx[1]);
    const start = new THREE.Vector3(...this.drag.point);
    const d = end.clone().sub(start);
    const len = d.length();
    this.arrow.visible = len > 1e-4;
    if (this.arrow.visible) {
      this.arrow.position.copy(start);
      this.arrow.setDirection(d.normalize());
      this.arrow.setLength(Math.max(len, 0.12), Math.min(0.1, len * 0.4 + 0.04), 0.06);
    }
    this.renderer.domElement.style.cursor = 'grabbing';
    this.onDrag?.(this.drag);
  }

  private onUp(e: PointerEvent): void {
    if (this.downPx) {
      // 바닥 클릭 (궤도 회전 드래그와 구별: 거의 안 움직였을 때만)
      const moved = Math.hypot(e.clientX - this.downPx[0], e.clientY - this.downPx[1]);
      this.downPx = null;
      if (moved < this.cfg.pushMinDragPx) {
        const g = this.pickGround(e);
        if (g) this.onGround?.(this.input, [g.x, g.y, g.z], [this.camera.position.x, this.camera.position.y, this.camera.position.z]);
      }
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    this.endDrag();
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (d.px < this.cfg.pushMinDragPx) return;
    const dir: Vec3 = [d.end[0] - d.point[0], d.end[1] - d.point[1], d.end[2] - d.point[2]];
    if (Math.hypot(...dir) < 1e-6) return;
    this.onPush?.(d.ci, d.body, d.point, dir);
  }

  private endDrag(): void {
    this.drag = null;
    this.arrow.visible = false;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    this.onDrag?.(null);
  }
}
