// 필름스트립 합성 (SPEC 8.3): 프레임마다 256×256으로 렌더하고 2D 캔버스 격자에 붙인 뒤 한글 텍스트를 그린다.
// 브라우저 전용(DOM 캔버스 + WebGL). Node API를 쓰지 않으므로 앱에서 내보내기로도 쓸 수 있다.
import * as THREE from 'three';
import { RagdollScene, makeCamera, placeCamera, CAMERA_LABEL, type FilmConfig } from './scene';
import { DebugDraw, LEGEND, POSTURE_LABEL, activeBehaviorText, clutchText, fallText, airText, grabText, impactLabel, activeImpacts, balanceText, stepText, walkText, getupText, reactionText, DEBUG_COLOR } from './debugDraw';
import { displayState } from './blend';
import type { CameraKind, CharacterDef, CharacterStateLite, FilmMeta, FilmSummary } from './stateTypes';
import type { FbxSkin } from './skin';
import { GhostBodies, GHOST_COLOR } from './ghost';
import { CharacterMeshes, PropMeshes, eventsFor, framedConfig, groupFraming, otherColors } from './others';
import type { PropMetaLite, PropStateLite } from './stateTypes';

/** 캡슐만 / FBX만 / 둘 다(한 시각 칸 = 위 캡슐 256×256 + 아래 FBX 256×256) */
export type FilmVariant = 'capsule' | 'fbx' | 'both';
export const VARIANT_LABEL: Record<FilmVariant, string> = { capsule: '캡슐', fbx: 'FBX', both: '캡슐+FBX' };

export interface FilmInput {
  def: CharacterDef;
  cfg: FilmConfig;
  meta: FilmMeta;
  summary: FilmSummary | null;
  /** frameInterval 간격으로 고른 상태. frameTimes[i]가 칸에 표시할 시간 */
  frames: CharacterStateLite[];
  frameTimes: number[];
  camera: CameraKind;
  /** 기본 capsule. fbx·both는 renderFilmstrip에 skin을 넘겨야 한다 */
  variant?: FilmVariant;
  /** --compare: 칸마다 겹쳐 그릴 레퍼런스 상태(이미 충격 시점·위치 정렬됨, 없으면 null)와 이름 */
  compare?: { name: string; frames: (CharacterStateLite | null)[]; label?: string };
  /** (v0.8c) 두 번째 이후 캐릭터: 이름, 정의(없으면 def), 칸마다 상태. primaryName = 첫 캐릭터 이름 */
  others?: { name: string; def?: CharacterDef; frames: (CharacterStateLite | null)[] }[];
  primaryName?: string;
  /** (v0.8c) 프롭: 형상, 칸마다 상태 */
  props?: { meta: PropMetaLite[]; frames: (PropStateLite[] | null)[] };
  /** (pres-1) 확대 컷: 카메라가 이 바디(들의 가운데)를 distance m에서 본다 (손가락·얼굴 확인용). 칸에 손 포즈 라벨을 붙인다 */
  zoom?: { bodies: string[]; distance: number };
}

/** (pres-1) 손 포즈 한글 라벨 */
const HAND_POSE_KO: Record<string, string> = { rest: '편안', limp: '늘어짐', fist: '주먹', grip: '쥠', reach: '펴며 뻗기', clutch: '누름', open: '편 손', guard: '감쌈', spread: '벌림' };
/** (pres-2·3) 호흡·반응 지연·머리 안정 라벨: 숨이 가쁘거나(각성 ≥ 0.05) 머리 안정이 1° 넘게 걸릴 때(확대 컷은 늘) */
export function presenceText(s: CharacterStateLite, always = false): string {
  const br = s.breath, pr = s.behavior?.presence;
  const parts: string[] = [];
  if (br && br.k > 0.05 && (always || br.arousal >= 0.05)) parts.push(`숨 ${(br.rate * 60).toFixed(0)}회/분 ×${br.depth.toFixed(1)}${br.b > 0.5 ? ' 들숨' : ' 날숨'}`);
  if (pr && pr.stabK > 0.05 && (always || pr.stabDeg >= 1)) parts.push(`머리 안정 ${pr.stabDeg.toFixed(0)}°`);
  if (pr && always) parts.push(`반응 지연 ${(pr.delay * 1000).toFixed(0)}ms`);
  return parts.join(' · ');
}
export function fingerText(s: CharacterStateLite): string {
  const f = s.fingers;
  if (!f) return '';
  const one = (h: string, k: string) => { const x = f[h]; return x ? `${k} ${HAND_POSE_KO[x.pose] ?? x.pose} ${Math.round(x.curl * 100)}` : ''; };
  return `손: ${one('LeftHand', '왼')} · ${one('RightHand', '오른')}`;
}

const fmtSec = (t: number): string => `${(Math.round(t * 10) / 10).toFixed(1)}초`;

export function summaryLine(s: FilmSummary | null): string {
  if (!s) return '요약 없음 (summary.json 없음)';
  const fell = s.fell ? `예 (${fmtSec(s.fallTime ?? 0)})` : '아니오';
  const kneel = s.kneeled ? ` · 무릎 꿇음: 예 (${fmtSec(s.kneelTime ?? 0)})` : '';
  const first = s.firstGroundContact ?? '없음';
  const boom = s.exploded ? '예 (!)' : '아니오';
  const pass = s.expectations ? ` · 기대값: ${s.expectations.passed ? '통과' : `실패 ${s.expectations.failures.length}건`}` : '';
  const steps = s.stepsTaken != null ? ` · 걸음: ${s.stepsTaken}` : '';
  const rec = s.recoveredAfterHit != null ? ` · 회복: ${s.recoveredAfterHit.toFixed(1)}초` : '';
  return `넘어짐: ${fell}${kneel}${steps}${rec} · 첫 접촉 부위: ${first} · 폭발: ${boom}${pass}`;
}

function drawLegend(ctx: CanvasRenderingContext2D, x0: number, y: number, font: string, cfg: FilmConfig): void {
  ctx.font = `13px ${font}`;
  ctx.textBaseline = 'middle';
  let x = x0;
  for (const item of LEGEND) {
    ctx.save();
    switch (item.kind) {
      case 'dot':
        ctx.fillStyle = item.color;
        ctx.beginPath(); ctx.arc(x + 6, y, 5, 0, Math.PI * 2); ctx.fill();
        break;
      case 'cross':
        ctx.strokeStyle = item.color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x + 1, y - 5); ctx.lineTo(x + 11, y + 5); ctx.moveTo(x + 1, y + 5); ctx.lineTo(x + 11, y - 5); ctx.stroke();
        break;
      case 'line':
        ctx.strokeStyle = item.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14, y); ctx.stroke();
        break;
      case 'arrow':
        ctx.strokeStyle = ctx.fillStyle = item.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 9, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + 15, y); ctx.lineTo(x + 8, y - 5); ctx.lineTo(x + 8, y + 5); ctx.fill();
        break;
      case 'text':
        ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(x, y - 7, 14, 14);
        ctx.fillStyle = '#fff'; ctx.font = `bold 10px ${font}`; ctx.fillText('가', x + 2, y + 1);
        break;
      case 'gradient': {
        const g = ctx.createLinearGradient(x, 0, x + 30, 0);
        const c = (v: number[]): string => `rgb(${v.map((k) => Math.round(k * 255)).join(',')})`;
        g.addColorStop(0, c(cfg.bodyColor.strong)); g.addColorStop(1, c(cfg.bodyColor.weak));
        ctx.fillStyle = g; ctx.fillRect(x, y - 6, 30, 12);
        ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.strokeRect(x, y - 6, 30, 12);
        x += 16;
        break;
      }
      case 'foot':
        ctx.fillStyle = item.color; ctx.fillRect(x + 4, y - 7, 6, 14);
        break;
    }
    ctx.restore();
    ctx.fillStyle = '#202020';
    ctx.font = `13px ${font}`;
    const label = item.kind === 'gradient' ? `${item.label}(강→약)` : item.label;
    ctx.fillText(label, x + 19, y + 1);
    x += 19 + ctx.measureText(label).width + 16;
  }
}

function textBox(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'right', bg: string, fg: string): void {
  const w = ctx.measureText(text).width + 8;
  const bx = align === 'left' ? x : x - w;
  ctx.fillStyle = bg;
  ctx.fillRect(bx, y, w, 19);
  ctx.fillStyle = fg;
  ctx.fillText(text, bx + 4, y + 10);
}

/** 필름스트립 PNG를 data URL로 돌려준다. */
/** 머리 위 이름표 (화면 좌표로 투영) */
function nameTag(ctx: CanvasRenderingContext2D, cam: THREE.Camera, st: CharacterStateLite | null, name: string, color: string, x: number, y: number, cell: number, font: string): void {
  const h = st?.bodies.Head;
  if (!h) return;
  const v = new THREE.Vector3(h.pos[0], h.pos[1] + 0.22, h.pos[2]).project(cam);
  if (v.z > 1) return;
  const px = x + ((v.x + 1) / 2) * cell, py = y + ((1 - v.y) / 2) * cell;
  ctx.font = `bold 12px ${font}`;
  const w = ctx.measureText(name).width + 8;
  ctx.fillStyle = color;
  ctx.fillRect(px - w / 2, py - 9, w, 17);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, px - w / 2 + 4, py);
}

export function renderFilmstrip(input: FilmInput, skin?: FbxSkin, extraSkins: FbxSkin[] = []): string {
  const { def, cfg, meta, summary, frames, frameTimes, camera: kind } = input;
  const variant = input.variant ?? 'capsule';
  if (variant !== 'capsule' && !skin) throw new Error(`variant ${variant}: FBX 스킨이 없음`);
  const passes: ('capsule' | 'fbx')[] = variant === 'both' ? ['capsule', 'fbx'] : [variant];
  const cell = cfg.cellSize, cols = cfg.columns, header = cfg.headerHeight, font = cfg.font;
  const cellH = cell * passes.length;
  const rows = Math.max(1, Math.ceil(frames.length / cols));

  const out = document.createElement('canvas');
  out.width = cols * cell;
  out.height = header + rows * cellH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);

  // 머리말: 시나리오, 카메라, 범례, 요약
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#101010';
  ctx.font = `bold 18px ${font}`;
  const title = `${meta.scenario}`;
  ctx.fillText(title, 10, 16);
  const tw = ctx.measureText(title).width;
  ctx.font = `14px ${font}`;
  ctx.fillStyle = '#404040';
  const dur = meta.duration ?? frameTimes[frameTimes.length - 1] ?? 0;
  ctx.fillText(
    `마일스톤 ${meta.milestone ?? '?'} · 카메라: ${CAMERA_LABEL[kind]} · 길이 ${dur.toFixed(1)}초 · 칸 간격 ${cfg.frameInterval}초 · 캐릭터 ${meta.characterId ?? def.id} · 표시: ${VARIANT_LABEL[variant]}`,
    10 + tw + 14, 17,
  );
  drawLegend(ctx, 10, 42, font, cfg);
  if (input.compare) {
    ctx.font = `bold 13px ${font}`;
    ctx.fillStyle = GHOST_COLOR;
    ctx.fillRect(out.width - 330, 35, 16, 14);
    ctx.fillStyle = '#202020';
    ctx.fillText(input.compare.label ?? `회색 = 사람 레퍼런스 (${input.compare.name}, 충격 시점 정렬)`, out.width - 308, 43);
  }
  const others = input.others ?? [];
  const PRIMARY_CSS = '#2e52a0';
  if (others.length) {
    // (v0.8c) 캐릭터 색 범례
    ctx.font = `bold 13px ${font}`;
    let lx = out.width - 330;
    const items = [{ name: input.primaryName ?? 'A', css: PRIMARY_CSS }, ...others.map((o, i) => ({ name: o.name, css: otherColors(cfg, i).css }))];
    for (const it of items) {
      ctx.fillStyle = it.css;
      ctx.fillRect(lx, 35, 16, 14);
      ctx.fillStyle = '#202020';
      const lab = `캐릭터 ${it.name}`;
      ctx.fillText(lab, lx + 20, 43);
      lx += 28 + ctx.measureText(lab).width;
    }
  }
  ctx.font = `bold 14px ${font}`;
  ctx.fillStyle = summary?.exploded ? '#c00000' : '#103060';
  ctx.fillText(summaryLine(summary), 10, 68);

  // 3D 렌더
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(cell, cell, false);
  const world = new RagdollScene(def, cfg);
  world.setTerrain(meta.terrain);
  const debug = new DebugDraw(cfg);
  world.scene.add(debug.group);
  const cam = makeCamera(cfg, 1);
  if (skin) world.scene.add(skin.root);
  const ghost = input.compare ? new GhostBodies(def) : null;
  if (ghost) world.scene.add(ghost.group);
  // (v0.8c) 다른 캐릭터(다른 색 캡슐 + 디버그 표시 + FBX), 프롭
  const otherMeshes = others.map((o, i) => { const m = new CharacterMeshes(o.def ?? def, otherColors(cfg, i)); world.scene.add(m.group); return m; });
  const otherDebug = others.map(() => { const d = new DebugDraw(cfg); world.scene.add(d.group); return d; });
  for (const sk of extraSkins.slice(0, others.length)) world.scene.add(sk.root);
  const propMeshes = input.props ? new PropMeshes(input.props.meta) : null;
  if (propMeshes) world.scene.add(propMeshes.group);
  const primaryEvents = others.length ? eventsFor(meta.events, input.primaryName ?? 'A') : meta.events;

  frames.forEach((state, i) => {
    const t = frameTimes[i] ?? state.time;
    world.applyState(state);
    ghost?.applyState(input.compare!.frames[i] ?? null);
    skin?.applyState(displayState(state));
    debug.update(state, primaryEvents, t);
    if (input.zoom) debug.group.visible = false;
    const ost = others.map((o) => o.frames[i] ?? null);
    ost.forEach((st, k) => {
      otherMeshes[k]!.applyState(st);
      if (st) otherDebug[k]!.update(st, eventsFor(meta.events, others[k]!.name), t);
      otherDebug[k]!.group.visible = !!st;
      const sk = extraSkins[k];
      if (sk && st) sk.applyState(displayState(st));
    });
    propMeshes?.applyState(input.props!.frames[i]);
    if (input.zoom) {
      // (pres-1) 확대 컷: 바디 가운데를 그 방향에서 가까이
      const zs = input.zoom.bodies.map((n) => state.bodies[n]?.pos).filter((p): p is [number, number, number] => !!p);
      const c = zs.length ? zs.reduce((a, p) => [a[0] + p[0] / zs.length, a[1] + p[1] / zs.length, a[2] + p[2] / zs.length] as [number, number, number], [0, 0, 0] as [number, number, number]) : state.com;
      const o = kind === 'side' ? [1, 0.35, 0] : kind === 'front' ? [0, 0.35, 1] : kind === 'top' ? [0, 1, 0.001] : cfg.camera.followOffset;
      const on = Math.hypot(o[0]!, o[1]!, o[2]!);
      cam.up.set(0, 1, 0);
      cam.position.set(c[0] + (o[0]! / on) * input.zoom.distance, c[1] + (o[1]! / on) * input.zoom.distance, c[2] + (o[2]! / on) * input.zoom.distance);
      cam.lookAt(c[0], c[1], c[2]);
      cam.updateProjectionMatrix();
    } else if (others.length) {
      const fr = groupFraming([state, ...ost], kind, cfg);
      placeCamera(cam, kind, fr.com, framedConfig(cfg, fr.distance));
    } else placeCamera(cam, kind, state.com, cfg);

    const x = (i % cols) * cell, y = header + Math.floor(i / cols) * cellH;
    passes.forEach((p, k) => {
      world.setCapsulesVisible(p === 'capsule');
      if (skin) skin.root.visible = p === 'fbx' && !!state.bodies.Hips;
      otherMeshes.forEach((m) => m.setCapsulesVisible(p === 'capsule'));
      extraSkins.slice(0, others.length).forEach((sk, k) => { sk.root.visible = p === 'fbx' && !!ost[k]?.bodies.Hips; });
      renderer.render(world.scene, cam);
      ctx.drawImage(canvas, x, y + k * cell);
      if (variant !== 'capsule') {
        ctx.textBaseline = 'middle';
        ctx.font = `bold 12px ${font}`;
        textBox(ctx, VARIANT_LABEL[p], x + cell - 3, y + k * cell + cell - 22, 'right', p === 'fbx' ? 'rgba(40,40,48,0.8)' : 'rgba(46,82,158,0.85)', '#ffffff');
      }
      if (k > 0) {
        ctx.strokeStyle = '#d8d8d8';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + k * cell + 0.5); ctx.lineTo(x + cell, y + k * cell + 0.5); ctx.stroke();
      }
    });

    // 칸 텍스트: 왼쪽 위 시간, 오른쪽 위 자세, 왼쪽 아래 활성 행동, 충격 표시
    ctx.textBaseline = 'middle';
    ctx.font = `bold 13px ${font}`;
    textBox(ctx, cfg.frameInterval < 0.1 - 1e-9 ? `${t.toFixed(2)}초` : fmtSec(t), x + 3, y + 3, 'left', 'rgba(0,0,0,0.72)', '#ffffff');
    if (state.posture) {
      ctx.font = `12px ${font}`;
      textBox(ctx, POSTURE_LABEL[state.posture] ?? state.posture, x + cell - 3, y + 3, 'right', 'rgba(255,255,255,0.85)', '#303030');
    }
    const beh = activeBehaviorText(state);
    if (beh) {
      ctx.font = `12px ${font}`;
      textBox(ctx, `${others.length ? `${input.primaryName ?? 'A'} ` : ''}행동: ${beh}`, x + 3, y + cell - 22, 'left', others.length ? 'rgba(46,82,160,0.85)' : 'rgba(0,0,0,0.6)', '#ffffff');
    }
    const bal = balanceText(state);
    if (bal) {
      ctx.font = `12px ${font}`;
      const hip = state.balance?.strategy === 'hip';
      textBox(ctx, bal, x + 3, y + cell - (beh ? 44 : 22), 'left', hip ? 'rgba(192,32,144,0.85)' : 'rgba(200,100,0,0.85)', '#ffffff');
    }
    const stp = stepText(state);
    if (stp) {
      ctx.font = `bold 12px ${font}`;
      textBox(ctx, stp, x + 3, y + 24, 'left', 'rgba(26,58,138,0.88)', '#ffffff');
    }
    const le = state.stepping?.landings?.length ? state.stepping.landings[state.stepping.landings.length - 1] : undefined;
    if (le && t - le.t < 0.35) {
      ctx.font = `11px ${font}`;
      textBox(ctx, `착지 오차 ${(le.error * 100).toFixed(1)}cm`, x + 3, y + (stp ? 45 : 24), 'left', 'rgba(255,255,255,0.85)', '#1a3a8a');
    }
    const cl = clutchText(state);
    if (cl) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, cl, x + cell - 3, y + 45, 'right', 'rgba(224,0,192,0.85)', '#ffffff');
    }
    const ft = fallText(state);
    if (ft) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, ft, x + cell - 3, y + (cl ? 66 : 45), 'right', 'rgba(255,122,0,0.88)', '#ffffff');
    }
    const wt = walkText(state);
    if (wt) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, wt, x + cell - 3, y + cell - 44, 'right', 'rgba(20,110,60,0.88)', '#ffffff');
    }
    const at = airText(state);
    if (at) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, at, x + cell - 3, y + (cl ? 66 : 45) + (ft ? 21 : 0), 'right', 'rgba(0,150,180,0.9)', '#ffffff');
    }
    const grt = grabText(state);
    if (grt) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, grt, x + cell - 3, y + (cl ? 66 : 45) + (ft ? 21 : 0) + (at ? 21 : 0), 'right', 'rgba(144,48,192,0.9)', '#ffffff');
    }
    const gt = getupText(state);
    if (gt) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, gt, x + 3, y + (stp ? 45 : 24), 'left', 'rgba(110,40,170,0.9)', '#ffffff');
    }
    const rt = reactionText(state);
    if (rt) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, rt, x + 3, y + cell - (wt ? 65 : 44), 'left', 'rgba(180,90,20,0.9)', '#ffffff');
    }
    // (pres-2·3) 호흡(각성 있을 때)·반응 지연·머리 안정
    const pst = presenceText(state, !!input.zoom);
    if (pst) {
      ctx.font = `bold 11px ${font}`;
      textBox(ctx, pst, x + cell - 3, y + cell - (wt ? 66 : 44), 'right', 'rgba(60,110,40,0.9)', '#ffffff');
    }
    if (input.zoom) {
      const ftx = fingerText(state);
      if (ftx) {
        ctx.font = `bold 11px ${font}`;
        textBox(ctx, ftx, x + 3, y + cellH - 22, 'left', 'rgba(20,90,90,0.9)', '#ffffff');
      }
    }
    const hits = activeImpacts(primaryEvents, t, cfg.impactShowSec);
    if (hits.length) {
      ctx.font = `bold 12px ${font}`;
      const h = hits[0]!;
      textBox(ctx, (others.length ? `${input.primaryName ?? 'A'} ` : '') + impactLabel(h), x + cell - 3, y + 24, 'right', DEBUG_COLOR.impact, '#202020');
    }
    // (v0.8c) 다른 캐릭터: 이름표, 충격, 활성 행동 (그 캐릭터 색)
    if (others.length) {
      passes.forEach((_p, k) => {
        nameTag(ctx, cam, state, input.primaryName ?? 'A', PRIMARY_CSS, x, y + k * cell, cell, font);
        ost.forEach((st, j) => nameTag(ctx, cam, st, others[j]!.name, otherColors(cfg, j).css, x, y + k * cell, cell, font));
      });
      ost.forEach((st, j) => {
        if (!st) return;
        const css = otherColors(cfg, j).css;
        const oh = activeImpacts(eventsFor(meta.events, others[j]!.name), t, cfg.impactShowSec);
        if (oh.length) {
          ctx.font = `bold 12px ${font}`;
          textBox(ctx, `${others[j]!.name} ${impactLabel(oh[0]!)}`, x + cell - 3, y + 45 + j * 21, 'right', DEBUG_COLOR.impact, css);
        }
        const ob = activeBehaviorText(st);
        if (ob) {
          ctx.font = `12px ${font}`;
          textBox(ctx, `${others[j]!.name} 행동: ${ob}`, x + cell - 3, y + cell - 66 - j * 21, 'right', css, '#ffffff');
        }
      });
    }
    ctx.strokeStyle = '#b0b0b0';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cellH - 1);
  });

  renderer.dispose();
  return out.toDataURL('image/png');
}
