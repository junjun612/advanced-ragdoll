// 하이라이트 페이지 진입점 (브라우저에서 실행). tools/reel.ts가 esbuild로 묶어 Playwright Chromium에 넣는다.
// 프레임 하나를 FBX 스킨으로 그리고 한글 제목·행동 라벨을 덧그려 PNG data URL로 돌려준다.
import * as THREE from 'three';
import { RagdollScene, makeCamera, placeCamera, type FilmConfig } from '../../src/render/scene';
import { FbxSkin, type SkinConfig } from '../../src/render/skin';
import { displayState } from '../../src/render/blend';
import { POSTURE_LABEL, getupText } from '../../src/render/debugDraw';
import type { CameraKind, CharacterDef, CharacterStateLite, PropMetaLite, PropStateLite } from '../../src/render/stateTypes';
import { PropMeshes, framedConfig, groupFraming, otherColors } from '../../src/render/others';

export interface ReelFrame {
  state: CharacterStateLite;
  camera: CameraKind;
  /** 카메라가 따라갈 (부드럽게 한) COM */
  camCom: [number, number, number];
  terrain?: string;
  tag: string;
  caption: string;
  t: number;
  /** 0~1: 장면 시작 제목 카드 불투명도 */
  titleAlpha: number;
  impact: string;
  index: number;
  total: number;
  /** (v0.8c) 다른 캐릭터 (이름, 상태), 첫 캐릭터 이름 */
  others?: { name: string; state: CharacterStateLite | null }[];
  primaryName?: string;
  /** (v0.8c) 프롭 형상(장면 키가 바뀌면 다시 만든다)·상태 */
  sceneKey?: string;
  propsMeta?: PropMetaLite[];
  props?: PropStateLite[] | null;
}

let skin: FbxSkin | undefined;
let world: RagdollScene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let cam: THREE.PerspectiveCamera | undefined;
let cfg: FilmConfig | undefined;
let terrainNow: string | undefined = '\u0000';
let W = 0, H = 0;
let fbxBytes: ArrayBuffer | undefined;
let defG: CharacterDef | undefined;
let skinCfgG: SkinConfig | undefined;
const extraSkins: FbxSkin[] = [];
let propMeshes: PropMeshes | null = null;
let sceneKeyNow: string | undefined;

/** 머리 위 이름표 */
function tag(ctx: CanvasRenderingContext2D, st: CharacterStateLite | null | undefined, name: string, color: string, font: string): void {
  const h = st?.bodies.Head;
  if (!h || !cam) return;
  const v = new THREE.Vector3(h.pos[0], h.pos[1] + 0.25, h.pos[2]).project(cam);
  if (v.z > 1) return;
  const px = ((v.x + 1) / 2) * W, py = ((1 - v.y) / 2) * H;
  ctx.font = `bold 13px ${font}`;
  const w = ctx.measureText(name).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(px - w / 2, py - 10, w, 19);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, px - w / 2 + 5, py);
}

function box(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg: string, font: string, align: 'left' | 'right' = 'left'): void {
  ctx.font = font;
  const w = ctx.measureText(text).width + 12;
  const bx = align === 'left' ? x : x - w;
  ctx.fillStyle = bg;
  ctx.fillRect(bx, y, w, 22);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 6, y + 11.5);
}

const g = globalThis as unknown as {
  initReel: (fbxB64: string, def: CharacterDef, skinCfg: SkinConfig, film: FilmConfig, w: number, h: number) => void;
  renderReelFrame: (f: ReelFrame) => string;
};

g.initReel = (b64, def, skinCfg, film, w, h) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  skin = new FbxSkin(bytes.buffer, def, skinCfg);
  fbxBytes = bytes.buffer; defG = def; skinCfgG = skinCfg;
  cfg = film; W = w; H = h;
  world = new RagdollScene(def, film);
  world.setCapsulesVisible(false);
  world.scene.add(skin.root);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  cam = makeCamera(film, w / h);
};

g.renderReelFrame = (f) => {
  const font = cfg!.font;
  if (f.terrain !== terrainNow) { world!.setTerrain(f.terrain); terrainNow = f.terrain; }
  world!.applyState(f.state);
  world!.setCapsulesVisible(false);
  skin!.applyState(displayState(f.state));
  skin!.root.visible = !!f.state.bodies.Hips;
  // (v0.8c) 다른 캐릭터 FBX(색만 다름)·프롭
  const others = f.others ?? [];
  while (extraSkins.length < others.length) {
    const col = otherColors(cfg!, extraSkins.length).skin;
    const sc = col ? { ...skinCfgG!, color: { surface: col, joints: skinCfgG!.color?.joints ?? [0.22, 0.24, 0.3] } } : skinCfgG!;
    const sk = new FbxSkin(fbxBytes!.slice(0), defG!, sc);
    world!.scene.add(sk.root);
    extraSkins.push(sk);
  }
  extraSkins.forEach((sk, i) => {
    const st = others[i]?.state;
    sk.root.visible = !!st?.bodies.Hips;
    if (st) sk.applyState(displayState(st));
  });
  if (f.sceneKey !== sceneKeyNow) {
    sceneKeyNow = f.sceneKey;
    if (propMeshes) world!.scene.remove(propMeshes.group);
    propMeshes = f.propsMeta?.length ? new PropMeshes(f.propsMeta) : null;
    if (propMeshes) world!.scene.add(propMeshes.group);
  }
  propMeshes?.applyState(f.props);
  if (others.length) {
    const fr = groupFraming([{ ...f.state, com: f.camCom }, ...others.map((o) => o.state)], f.camera, cfg!);
    placeCamera(cam!, f.camera, fr.com, framedConfig(cfg!, fr.distance));
  } else placeCamera(cam!, f.camera, f.camCom, cfg!);
  renderer!.render(world!.scene, cam!);

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(renderer!.domElement, 0, 0);

  // 위: 마일스톤 태그 + 설명
  ctx.fillStyle = 'rgba(16,24,40,0.82)';
  ctx.fillRect(0, 0, W, 34);
  box(ctx, f.tag, 8, 6, 'rgba(46,82,158,1)', '#ffffff', `bold 13px ${font}`);
  ctx.font = `bold 15px ${font}`;
  const tagW = (() => { ctx.font = `bold 13px ${font}`; return ctx.measureText(f.tag).width + 12; })();
  ctx.font = `bold 15px ${font}`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(f.caption, 8 + tagW + 10, 17.5);

  // 아래: 시간, 자세, 행동
  box(ctx, `${f.t.toFixed(2)}초`, 8, H - 30, 'rgba(0,0,0,0.7)', '#ffffff', `bold 12px ${font}`);
  if (f.state.posture) box(ctx, POSTURE_LABEL[f.state.posture] ?? f.state.posture, W - 8, 42, 'rgba(255,255,255,0.88)', '#303030', `12px ${font}`, 'right');
  const src = f.state.behavior?.active ?? f.state.behaviors ?? [];
  const beh = src.filter((b) => b.weight > 0.2).sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map((b) => ('ko' in b && b.ko) || b.name).join(' · ');
  const gu = getupText(f.state).split(' · ')[0] ?? '';
  const line = [beh, gu].filter(Boolean).join(' · ');
  if (line) box(ctx, `${f.others?.length ? `${f.primaryName ?? 'A'} ` : ''}행동: ${line}`, 78, H - 30, f.others?.length ? '#2e52a0' : 'rgba(110,40,170,0.88)', '#ffffff', `bold 12px ${font}`);
  if (f.impact) box(ctx, f.impact, W - 8, 68, 'rgba(255,200,0,0.95)', '#202020', `bold 13px ${font}`, 'right');
  if (others.length) {
    tag(ctx, f.state, f.primaryName ?? 'A', '#2e52a0', font);
    others.forEach((o, i) => {
      tag(ctx, o.state, o.name, otherColors(cfg!, i).css, font);
      const ob = (o.state?.behavior?.active ?? []).filter((b) => b.weight > 0.2).sort((a, b) => b.weight - a.weight).slice(0, 3).map((b) => b.ko || b.name).join(' · ');
      if (ob) box(ctx, `${o.name} 행동: ${ob}`, 78, H - 56 - i * 26, otherColors(cfg!, i).css, '#ffffff', `bold 12px ${font}`);
    });
  }
  box(ctx, `${f.index}/${f.total}`, W - 8, H - 30, 'rgba(0,0,0,0.45)', '#ffffff', `11px ${font}`, 'right');

  // 장면 시작 제목 카드
  if (f.titleAlpha > 0.01) {
    ctx.globalAlpha = f.titleAlpha;
    ctx.fillStyle = 'rgba(16,24,40,0.78)';
    ctx.fillRect(0, H / 2 - 44, W, 88);
    ctx.fillStyle = '#9fc0ff';
    ctx.font = `bold 16px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText(f.tag, W / 2, H / 2 - 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 20px ${font}`;
    ctx.fillText(f.caption, W / 2, H / 2 + 14);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
  return out.toDataURL('image/png');
};
