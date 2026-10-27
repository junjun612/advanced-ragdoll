// 브라우저 앱 진입점 (SPEC 14): 실시간 sim + 3D 뷰 + 재생·시나리오·대화형 입력·캐릭터 제어·표시·근육 튜닝·그래프.
// sim은 Node와 같은 src/sim 코드를 그대로 돈다(Rapier compat, 고정 1/120 누적 스텝).
// 시나리오는 러너와 같은 공용 재생 함수로 돌린다 → 같은 시드·같은 프레임 상태가 npm run sim 로그와 같다 (README 결정 app-1).
import appJson from '../../config/app.json';
import filmJson from '../../config/film.json';
import skinJson from '../../config/skin.json';
import hitScale from '../../config/hitScale.json';
import musclesJson from '../../config/muscles.json';
import ragdollJson from '../../config/ragdoll.json';
import type { FilmConfig } from '../render/scene';
import type { SkinConfig } from '../render/skin';
import {
  DEBUG_COLOR, LEGEND, POSTURE_LABEL, activeBehaviorText, activeImpacts, airText, balanceText, clutchText, fallText, getupText, grabText, impactLabel, reactionText, stepText, walkText,
} from '../render/debugDraw';
import { eventsFor } from '../render/others';
import type { CharacterDef, BodyName, MuscleConfig, RagdollConfig, Scenario, JointName, Vec3, CharacterState, TerrainName } from '../sim/api';
import { SimHost, REGION_LABEL, type AppConfig, type AppChar } from './simHost';
import { AppView, type DisplayMode, type InputMode, type DebugPart, type CharFrame } from './view';
import { LiveGraph } from './graph';
import { el, section, slider, buttons, segmented, checkbox } from './ui';

const cfg = appJson as unknown as AppConfig;
const filmCfg = filmJson as unknown as FilmConfig;
const skinCfg = skinJson as unknown as SkinConfig;
const HIT = hitScale as Record<'small' | 'medium' | 'large', number>;
const defaultMuscles = musclesJson as unknown as MuscleConfig;
const characterFiles = import.meta.glob<CharacterDef>('../../config/characters/*.json', { eager: true, import: 'default' });
const scenarioFiles = import.meta.glob<Scenario>('../../scenarios/*/*.json', { eager: true, import: 'default' });
// FBX는 Vite가 URL로 바꿔 준다 (빌드 시 dist에 복사되고 base 경로가 붙는다 — GitHub Pages 하위 경로에서도 동작)
const fbxUrls = import.meta.glob<string>('../../assets/fbx/*.fbx', { eager: true, query: '?url', import: 'default' });
/** 캐릭터 설정 이름 → 정의 (config/characters/<이름>.json) */
const DEFS: Record<string, CharacterDef> = Object.fromEntries(Object.entries(characterFiles).map(([p, d]) => [/([^/]+)\.json$/.exec(p)![1]!, d]));

/** 바디 한글 이름 (코드 식별자는 괄호에 그대로) */
const BODY_KO: Record<string, string> = {
  Hips: '골반', Spine: '허리', Spine2: '가슴', Head: '머리',
  LeftArm: '왼 위팔', LeftForeArm: '왼 아래팔', LeftHand: '왼손',
  RightArm: '오른 위팔', RightForeArm: '오른 아래팔', RightHand: '오른손',
  LeftUpLeg: '왼 허벅지', LeftLeg: '왼 정강이', LeftFoot: '왼발',
  RightUpLeg: '오른 허벅지', RightLeg: '오른 정강이', RightFoot: '오른발',
  LeftToeBase: '왼 발가락', RightToeBase: '오른 발가락',
};
const STATE_KO: Record<string, string> = { Active: '활성', Ragdoll: '랙돌', Animated: '애니', GettingUp: '일어서기' };
const STANCE_KO: Record<string, string> = { double: '양발', left: '왼발', right: '오른발', none: '없음' };
const HIT_KO: Record<string, string> = { small: '작게', medium: '중간', large: '크게' };
const TERRAIN_KO: Record<string, string> = { flat: '평지', slope10: '경사 10°', slope20: '경사 20°', stairs: '계단', ledge: '모서리(받침)', rail: '난간', wall: '벽', box_obstacle: '장애물 상자' };
const INPUT_KO: { value: InputMode; label: string; hint: string }[] = [
  { value: 'push', label: '밀기', hint: '바디를 클릭한 채 끌었다 놓으면 끈 방향으로 민다 (0.15초에 나눠 가함). 빈 곳을 끌면 카메라가 돈다.' },
  { value: 'bullet', label: '총탄', hint: '바디를 클릭하면 시선 방향으로 총탄을 맞는다 (맞은 점 = 클릭한 점).' },
  { value: 'melee', label: '근접', hint: '바디를 클릭하면 시선 방향(수평)으로 근접 타격을 받는다.' },
  { value: 'explosion', label: '폭발', hint: '바닥을 클릭하면 그 점에서 폭발 (세기 = 1m 거리 Δv, 거리에 반비례). 모든 캐릭터가 받는다.' },
  { value: 'throw', label: '프롭 던지기', hint: '클릭한 점으로 카메라 쪽에서 상자를 던진다.' },
  { value: 'look', label: '시선', hint: '클릭한 점을 고른 캐릭터가 바라본다.' },
  { value: 'place', label: '캐릭터 놓기', hint: '바닥을 클릭한 곳에 캐릭터를 하나 세운다 (첫 캐릭터를 바라봄).' },
];
const JOINT_GROUPS: [string, string[]][] = [['몸통·목', ['torso', 'neck']], ['왼팔', ['leftArm']], ['오른팔', ['rightArm']], ['왼다리', ['leftLeg']], ['오른다리', ['rightLeg']]];

const clone = <T,>(x: T): T => structuredClone(x);
const fmtDv = (dv: number) => {
  const name = (Object.keys(HIT) as (keyof typeof HIT)[]).find((k) => Math.abs(HIT[k] - dv) < 1e-9);
  return `Δv ${dv.toFixed(2)} m/s${name ? ` (${HIT_KO[name]})` : ''}`;
};
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const qmul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
const fmtV = (p: readonly number[]) => `(${p.map((x) => x.toFixed(2)).join(', ')})`;

/** 바디별 핀 세기 = 핀 보조와 애니 강제 중 큰 값 */
function pinBodies(s: CharacterState): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = { ...(s.pin?.bodies ?? {}) };
  const ao = s.animOverride;
  if (ao && ao.weight > 0) for (const [k, v] of Object.entries(ao.bodies)) out[k] = Math.max(out[k] ?? 0, v ?? 0);
  return out;
}

/** 캐릭터 한 명의 상태 글 (필름스트립 라벨 체계와 같은 한글 함수) */
function charLines(c: AppChar, s: CharacterState, events: readonly import("../render/stateTypes").FilmEvent[], multi: boolean): string[] {
  const lines: string[] = [];
  const nm = multi ? `${c.label} · ` : '';
  lines.push(`<b>${nm}${STATE_KO[s.state] ?? s.state}</b> · 자세 ${POSTURE_LABEL[s.posture] ?? s.posture} · 디딤 ${STANCE_KO[s.stance] ?? s.stance} · 높이 ${s.com[1].toFixed(2)}m`);
  const add = (cls: string, t: string) => { if (t) lines.push(`<span class="tag ${cls}">${esc(t)}</span>`); };
  add('beh', activeBehaviorText(s) ? `행동: ${activeBehaviorText(s)}` : '');
  add('bal', balanceText(s));
  add('step', stepText(s));
  add('react', reactionText(s));
  add('walk', walkText(s));
  add('fall', fallText(s));
  add('grab', grabText(s));
  const wall = s.behavior?.grab?.wall;
  add('grab', wall ? `벽 감지 ${(wall.dist * 100).toFixed(0)}cm` : '');
  add('air', airText(s));
  add('getup', getupText(s));
  add('wound', clutchText(s));
  const wn = s.behavior?.wounds?.length ?? 0;
  add('wound', wn ? `상처 ${wn}곳` : '');
  const g = s.behavior?.gaze;
  add('gaze', g ? `시선 → ${fmtV(g.target)} · 오차 ${g.errorDeg.toFixed(0)}°` : '');
  const hit = activeImpacts(events, s.time, filmCfg.impactShowSec)[0];
  add('impact', hit ? impactLabel(hit) : '');
  return lines;
}

async function main(): Promise<void> {
  const viewport = document.getElementById('viewport')!;
  const panel = document.getElementById('panel')!;
  const statusEl = document.getElementById('status')!;
  const charsEl = document.getElementById('chars')!;
  const pushInfoEl = document.getElementById('pushInfo')!;
  const assistEl = document.getElementById('assistWarn')!;
  const loading = document.getElementById('loading')!;
  const legendEl = document.getElementById('legend')!;
  document.title = `액티브 랙돌 ${cfg.version}`;
  document.getElementById('appTitle')!.textContent = `액티브 랙돌 ${cfg.version}`;

  const host = new SimHost(DEFS, ragdollJson as unknown as RagdollConfig, clone(defaultMuscles), cfg);
  await host.reset();
  const view = new AppView(viewport, DEFS[cfg.character]!, filmCfg, cfg);
  view.syncCharacters(host.chars.map((c) => c.def));
  const graph = new LiveGraph(
    document.getElementById('graph') as HTMLCanvasElement,
    [
      { label: 'COM 높이', unit: 'm', color: DEBUG_COLOR.com, max: cfg.graph.comHeightMax, digits: 3 },
      { label: '관절 오차 평균', unit: '°', color: '#c07000', max: cfg.graph.errorMaxDeg, digits: 2 },
      { label: '보조 힘 사용량', unit: 'N', color: DEBUG_COLOR.capture, max: cfg.graph.assistMaxN, digits: 1 },
    ],
    cfg.graph.windowSec, cfg.graph.sampleHz, filmCfg.font,
  );

  let playing = true;
  let speed = cfg.defaultSpeed;
  let pushDv = HIT[cfg.pushDefault];
  let strikeDv = cfg.bulletDv;
  let boomDv = cfg.explosionDv;
  let selected = 0;
  let note = '';
  let showText = true;

  // ── 재생 ──
  const sPlay = section(panel, '재생');
  const [playBtn] = buttons(sPlay, [
    { label: '일시정지', id: 'btnPlay', onClick: () => setPlaying(!playing), title: '단축키: 스페이스' },
    { label: '한 스텝', id: 'btnStep', onClick: () => { setPlaying(false); host.stepOnce(); }, title: '1/120초 한 스텝 (단축키: .)' },
    { label: '처음부터', id: 'btnReset', onClick: () => void doReset(), title: '처음 상태로 (단축키: R)' },
  ]);
  const setPlaying = (p: boolean) => {
    if (p && host.scenarioDone) return;
    playing = p;
    playBtn!.textContent = p ? '일시정지' : '재생';
  };
  const speedSeg = segmented(sPlay, cfg.speeds.map((s) => ({ label: `${s}배`, value: s })), speed, (v) => { speed = v; speedSlider.set(v); });
  const speedSlider = slider(sPlay, '속도', { min: 0.1, max: 1, step: 0.05, value: speed, fmt: (v) => `${v.toFixed(2)}배`, onInput: (v) => { speed = v; speedSeg.set(v); } });

  // ── 시나리오 ──
  const sScn = section(panel, '시나리오');
  const sel = el('select', { id: 'scenarioSelect' });
  sel.append(el('option', { value: '' }, '자유 실행 (기본 서기)'));
  const scenarios = Object.entries(scenarioFiles).map(([path, sc]) => ({ path, sc })).sort((a, b) => a.path.localeCompare(b.path));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const { path, sc } of scenarios) {
    let g = groups.get(sc.milestone);
    if (!g) { g = el('optgroup', { label: `v${sc.milestone}` }); groups.set(sc.milestone, g); sel.append(g); }
    g.append(el('option', { value: path }, `${sc.name}${sc.knownIssue ? ' (알려진 문제)' : ''}${sc.characters?.length ? ` · ${sc.characters.length + 1}명` : ''}`));
  }
  const terrainRow = el('label', { class: 'slider' }, el('span', { class: 'lbl' }, '지형'));
  const terrainSel = el('select', { id: 'terrainSelect' });
  for (const t of cfg.terrains) terrainSel.append(el('option', { value: t }, TERRAIN_KO[t] ?? t));
  terrainRow.append(terrainSel);
  const scnDesc = el('div', { class: 'hint', id: 'scenarioDesc' });
  const matchEl = el('div', { class: 'readout', id: 'matchInfo' });
  sScn.append(sel, terrainRow, scnDesc, matchEl);
  terrainSel.addEventListener('change', () => { host.terrain = terrainSel.value as TerrainName; void doReset(); });
  const selectScenario = (path: string) => {
    sel.value = path;
    host.scenario = scenarios.find((s) => s.path === path)?.sc ?? null;
    terrainRow.style.display = host.scenario ? 'none' : '';
    scnDesc.textContent = host.scenario ? (host.scenario.description ?? '') : '평지(또는 고른 지형)에 서 있는 캐릭터. 밀기·총탄·폭발·캐릭터 추가로 실험한다.';
    return doReset();
  };
  sel.addEventListener('change', () => void selectScenario(sel.value));

  // ── 입력 ──
  const sIn = section(panel, '입력');
  const inHint = el('div', { class: 'hint' });
  const inSeg = segmented<InputMode>(sIn, INPUT_KO.map((x) => ({ label: x.label, value: x.value })), 'push', (m) => setInput(m));
  sIn.append(inHint);
  const setInput = (m: InputMode) => {
    view.input = m;
    inSeg.set(m);
    inHint.textContent = INPUT_KO.find((x) => x.value === m)!.hint;
    pushBox.style.display = m === 'push' ? '' : 'none';
    strikeBox.style.display = m === 'bullet' || m === 'melee' ? '' : 'none';
    boomBox.style.display = m === 'explosion' ? '' : 'none';
  };
  const pushBox = el('div', { class: 'section-body' });
  const dvSlider = slider(pushBox, '밀기 세기', { min: 0.05, max: cfg.pushMaxDv, step: 0.05, value: pushDv, fmt: fmtDv, onInput: (v) => { pushDv = v; } });
  buttons(pushBox, (['small', 'medium', 'large'] as const).map((k) => ({
    label: `${HIT_KO[k]} ${HIT[k]}`, onClick: () => { pushDv = HIT[k]; dvSlider.set(pushDv); },
  })), 'btn-row presets');
  pushBox.append(el('div', { class: 'hint' }, '세기는 전신 질량중심 속도 변화 Δv(m/s), 충격량 J = 총질량 × Δv.'));
  const strikeBox = el('div', { class: 'section-body' });
  slider(strikeBox, '타격 세기', { min: 0.05, max: 1.5, step: 0.05, value: strikeDv, fmt: fmtDv, onInput: (v) => { strikeDv = v; } });
  const boomBox = el('div', { class: 'section-body' });
  slider(boomBox, '폭발 세기', { min: 0.5, max: 8, step: 0.1, value: boomDv, fmt: (v) => `1m에서 Δv ${v.toFixed(1)} m/s`, onInput: (v) => { boomDv = v; } });
  sIn.append(pushBox, strikeBox, boomBox);
  const lastInputEl = el('div', { class: 'readout', id: 'lastInput' }, '아직 입력 없음');
  sIn.append(lastInputEl);
  setInput('push');

  // ── 캐릭터 ──
  const sCh = section(panel, '캐릭터');
  const chRow = el('label', { class: 'slider' }, el('span', { class: 'lbl' }, '고른 캐릭터'));
  const chSel = el('select', { id: 'charSelect' });
  chRow.append(chSel);
  sCh.append(chRow);
  const refreshCharSel = () => {
    chSel.replaceChildren(...host.chars.map((c, i) => el('option', { value: String(i) }, `${c.label}${i === 0 ? ' (첫 캐릭터)' : ''}`)));
    selected = Math.min(selected, host.chars.length - 1);
    chSel.value = String(selected);
  };
  chSel.addEventListener('change', () => { selected = Number(chSel.value); });
  buttons(sCh, [
    { label: '걷기 시작', id: 'btnWalk', onClick: () => { host.walk(selected, true); note = `${host.chars[selected]!.label} 걷기 시작`; } },
    { label: '정지', id: 'btnStop', onClick: () => { host.walk(selected, false); note = `${host.chars[selected]!.label} 멈춤`; } },
    { label: '랙돌', onClick: () => { host.chars[selected]!.ch.setState('Ragdoll'); host.interacted = true; } },
    { label: '활성', onClick: () => { host.chars[selected]!.ch.setState('Active'); host.interacted = true; } },
    { label: '캐릭터 추가', id: 'btnAddChar', onClick: () => addCharAhead() },
  ]);
  sCh.append(el('h4', {}, '애니 강제 비율(핀)'));
  sCh.append(el('div', { class: 'hint' }, 'PuppetMaster 핀 가중치: 바디를 애니 레퍼런스(클립, 없으면 서기 포즈) 쪽으로 핀 힘으로 끈다. 0 = 물리 그대로, 1 = 거의 애니. 피격·넘어짐 중에도 건다 — 시연·비교용 보조 힘이다.'));
  const aoSlider = slider(sCh, '애니 강제', {
    min: 0, max: cfg.animOverride.max, step: cfg.animOverride.step, value: 0, fmt: (v) => `${Math.round(v * 100)}%`,
    title: '애니 강제 비율(핀)', onInput: (v) => host.setAnimOverride(v),
  });
  aoSlider.input.id = 'animOverride';

  function addCharAhead(): void {
    // 고른 캐릭터 정면(Hips 방향, rest 회전 뺌) distance m 앞에 첫 캐릭터를 보게 세운다
    const c = host.chars[selected]!;
    const s = c.ch.getState();
    const q = s.bodies.Hips!.rot, r = c.def.bodies[0]!.restRotation;
    const d = qmul(q, [-r[0], -r[1], -r[2], r[3]]);
    const fx = 2 * (d[0] * d[2] + d[3] * d[1]), fz = 1 - 2 * (d[0] * d[0] + d[1] * d[1]);
    const n = Math.hypot(fx, fz) || 1;
    const k = cfg.addCharacter.distance;
    placeChar([s.com[0] + (fx / n) * k, s.balance?.groundHeight ?? 0, s.com[2] + (fz / n) * k]);
  }
  function placeChar(pos: Vec3): void {
    const a = host.primary.ch.getState().com;
    const yaw = Math.atan2(a[0] - pos[0], a[2] - pos[2]);
    const c = host.addCharacter(pos, yaw);
    if (!c) { note = `캐릭터는 ${cfg.addCharacter.maxCharacters}명까지`; return; }
    view.syncCharacters(host.chars.map((x) => x.def));
    refreshCharSel();
    lastInputEl.textContent = `${host.time.toFixed(2)}초: 캐릭터 ${c.label} 추가 ${fmtV(pos)}`;
  }

  // ── 표시 ──
  const sView = section(panel, '표시');
  segmented<DisplayMode>(sView, [{ label: '캡슐', value: 'capsule' }, { label: 'FBX', value: 'fbx' }, { label: '둘 다', value: 'both' }], view.mode, (m) => view.setMode(m));
  const dbg = el('div', { class: 'checks' });
  sView.append(dbg);
  const chk = (label: string, part: DebugPart, on: boolean, sw?: string) => { view.setShow(part, on); checkbox(dbg, label, on, (v) => view.setShow(part, v), sw); };
  chk('질량중심', 'com', true, DEBUG_COLOR.com);
  chk('지지 다각형·캡처', 'support', true, DEBUG_COLOR.support);
  chk('균형 힘·CoP', 'balance', false, DEBUG_COLOR.force);
  chk('충격 화살표', 'impact', true, DEBUG_COLOR.impact);
  chk('근육 강도 색', 'strength', true, 'linear-gradient(90deg, rgb(199,214,240), rgb(46,82,158))');
  chk('핀 세기 색', 'pin', true, '#f07300');
  chk('관절 오차', 'jointError', false, 'linear-gradient(90deg, #20b040, #f0c000, #e02020)');
  chk('잡기·상처·시선 등', 'debug', true, DEBUG_COLOR.grab);
  chk('이름표', 'tags', true, '#2e52a0');
  checkbox(dbg, '상태 글', true, (v) => { showText = v; charsEl.style.display = v ? '' : 'none'; });
  checkbox(dbg, '범례', false, (v) => { legendEl.style.display = v ? '' : 'none'; });
  checkbox(dbg, '카메라 추적', true, (v) => { view.follow = v; view.resetFollow(); });
  sView.append(el('div', { class: 'hint' }, `핀 세기 색: 바디가 주황으로 빛날수록 핀(애니 쪽으로 끄는 보조 힘)이 세다. 관절 오차 색: 0° 초록 → ${filmCfg.debug.jointErrorMaxDeg ?? 20}° 이상 빨강.`));
  legendEl.replaceChildren(...LEGEND.map((l) => el('div', { class: 'leg' },
    el('span', { class: `sw ${l.kind}`, style: l.kind === 'gradient' ? `background:linear-gradient(90deg, rgb(46,82,158), rgb(199,214,240))` : `background:${l.color || '#202020'}` }), l.label)));
  legendEl.style.display = 'none';

  // ── 근육 튜닝 (첫 캐릭터) ──
  const sTune = section(panel, '근육 튜닝 (첫 캐릭터)', false);
  const tuneBody = el('div');
  sTune.append(tuneBody);
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', id: 'importFile' });
  sTune.append(fileInput);
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text()) as Partial<MuscleConfig>;
      if (typeof parsed.kpScale !== 'number' || !parsed.joints) throw new Error('kpScale·joints가 없음');
      const base = clone(defaultMuscles);
      const next: MuscleConfig = { ...base, ...parsed, joints: { ...base.joints, ...parsed.joints } } as MuscleConfig;
      host.applyMuscleConfig(next);
      buildTuning();
      note = `불러옴: ${f.name}`;
    } catch (err) {
      note = `불러오기 실패: ${(err as Error).message}`;
    }
  });

  let rootCheck: HTMLInputElement;
  let tuneSliders: { refresh(): void }[] = [];
  function buildTuning(): void {
    tuneBody.replaceChildren();
    tuneSliders = [];
    const mc = host.muscleCfg;
    const t = cfg.tuning;
    tuneBody.append(el('div', { class: 'hint' }, '시나리오에서 바꾸면 그 실행은 sim 로그와 달라진다 (위 일치 표시).'));
    rootCheck = checkbox(tuneBody, '루트 보조 (Hips를 세우는 명시적 보조, 사용량 기록)', host.rootAssist, (v) => host.setRootAssist(v));

    tuneBody.append(el('h4', {}, '영역 강도'));
    tuneBody.append(el('div', { class: 'hint' }, '관절 강도 = 그 관절이 속한 영역 값들의 곱. 0이면 힘이 빠진다.'));
    for (const [r, label] of REGION_LABEL) {
      slider(tuneBody, label, { min: 0, max: 1, step: 0.01, value: host.regionScale[r] ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => host.setRegionScale(r, v) });
    }

    tuneBody.append(el('h4', {}, '이득'));
    const ch = host.primary.ch;
    const initGains = new Map(ch.muscleGains().map((g) => [g.joint, g]));
    const gain = (j: JointName) => host.primary.ch.muscleGains().find((g) => g.joint === j)!;
    const kpLabel = () => tuneSliders.forEach((s) => s.refresh());
    slider(tuneBody, '전체 배율', {
      min: t.kpScaleMin, max: t.kpScaleMax, value: mc.kpScale, log: true, fmt: (v) => `${v.toFixed(0)} N·m/rad`,
      title: 'kpScale: 관절 kp = 전체 배율 × 관절 비율',
      onInput: (v) => { mc.kpScale = Math.round(v); host.applyMuscleConfig(); kpLabel(); },
    });
    slider(tuneBody, '감쇠비 ζ', {
      min: 0, max: t.zetaMax, step: 0.05, value: mc.zeta, fmt: (v) => v.toFixed(2), title: 'kd 자동 = 2·ζ·sqrt(kp·I)',
      onInput: (v) => { mc.zeta = v; host.applyMuscleConfig(); kpLabel(); },
    });
    buttons(tuneBody, [
      { label: 'JSON 내보내기', id: 'btnExport', onClick: () => exportJson() },
      { label: 'JSON 불러오기', id: 'btnImport', onClick: () => fileInput.click() },
      { label: 'kd 자동으로', onClick: () => { for (const j of Object.values(mc.joints)) delete j.kd; host.applyMuscleConfig(); buildTuning(); } },
      { label: '기본값', onClick: () => { host.applyMuscleConfig(clone(defaultMuscles)); host.musclesDirty = false; buildTuning(); } },
    ]);

    tuneBody.append(el('h4', {}, '관절별'));
    for (const [title, regions] of JOINT_GROUPS) {
      const joints = regions.flatMap((r) => mc.regions[r] ?? []);
      const grp = section(tuneBody, title, false);
      for (const j of joints) {
        const jc = mc.joints[j];
        const g0 = initGains.get(j);
        if (!jc || !g0) continue;
        grp.append(el('div', { class: 'joint-name' }, `${BODY_KO[j] ?? j} (${j})`));
        const rMax = Math.max(0.1, jc.kpRatio * t.gainRangeFactor);
        tuneSliders.push(slider(grp, 'kp', {
          min: 0, max: rMax, value: jc.kpRatio, fmt: (v) => `${(v * mc.kpScale).toFixed(0)} (×${v.toFixed(2)})`,
          onInput: (v) => { jc.kpRatio = v; host.applyMuscleConfig(); kpLabel(); },
        }));
        const kdS = slider(grp, 'kd', {
          min: 0, max: Math.max(1, g0.kd * t.gainRangeFactor), value: g0.kd,
          fmt: () => `${gain(j).kd.toFixed(1)}${jc.kd === undefined ? ' 자동' : ''}`,
          onInput: (v) => { jc.kd = v; host.applyMuscleConfig(); },
        });
        tuneSliders.push({ refresh: () => { if (jc.kd === undefined) kdS.set(gain(j).kd); else kdS.refresh(); } });
        slider(grp, '최대 토크', {
          min: 0, max: t.maxTorqueMax, step: 1, value: jc.maxTorque, fmt: (v) => `${v.toFixed(0)} N·m`,
          onInput: (v) => { jc.maxTorque = v; host.applyMuscleConfig(); },
        });
      }
    }
  }
  buildTuning();

  function exportJson(): void {
    const out = clone(host.muscleCfg);
    out.kpScale = Math.round(out.kpScale);
    for (const j of Object.values(out.joints)) {
      j.kpRatio = Math.round(j.kpRatio * 1e4) / 1e4;
      if (j.kd !== undefined) j.kd = Math.round(j.kd * 100) / 100;
    }
    const blob = new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'muscles.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    note = '내보냄: muscles.json';
  }

  // ── 입력 연결 ──
  view.onDrag = (d) => {
    if (!d) { pushInfoEl.style.display = 'none'; return; }
    const c = host.chars[d.ci]!;
    pushInfoEl.style.display = 'block';
    pushInfoEl.textContent = `밀기: ${host.chars.length > 1 ? `${c.label} ` : ''}${BODY_KO[d.body]} (${d.body}) · ${fmtDv(pushDv)} · 충격량 ${(c.def.totalMass * pushDv).toFixed(1)} N·s${d.px < cfg.pushMinDragPx ? ' — 끌어서 방향을 정하세요' : ''}`;
  };
  view.onPush = (ci, body, point, dir) => {
    const p = host.push(ci, body, point, dir, pushDv);
    lastInputEl.textContent = `${host.time.toFixed(2)}초: ${host.chars[ci]!.label} ${BODY_KO[body]} (${body}) 밀기 방향 ${fmtV(p.direction)} · ${fmtDv(p.dv)} · 충격량 ${p.impulse.toFixed(1)} N·s`;
  };
  view.onStrike = (kind, ci, body, point, dir) => {
    host.strike(ci, kind, body, point, dir, strikeDv);
    lastInputEl.textContent = `${host.time.toFixed(2)}초: ${host.chars[ci]!.label} ${BODY_KO[body]} (${body}) ${kind === 'bullet' ? '총탄' : '근접'} · ${fmtDv(strikeDv)}`;
  };
  view.onGround = (mode, point, from) => {
    if (mode === 'explosion') {
      host.explode(point, boomDv);
      view.showExplosion(point, performance.now());
      lastInputEl.textContent = `${host.time.toFixed(2)}초: 폭발 ${fmtV(point)} · 1m Δv ${boomDv.toFixed(1)} m/s`;
    } else if (mode === 'throw') {
      const d = [point[0] - from[0], point[1] - from[1], point[2] - from[2]];
      const n = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      const k = Math.min(cfg.throwProp.spawnDistance, n * 0.5) / n;
      // 카메라에서 목표 쪽으로 조금 나온 곳, 너무 높으면 낮춘다
      const start: Vec3 = [from[0] + d[0]! * k, Math.max(0.5, Math.min(2.0, from[1] + d[1]! * k)), from[2] + d[2]! * k];
      const pd = host.throwProp(start, [point[0], Math.max(point[1], 0.9), point[2]]);
      lastInputEl.textContent = `${host.time.toFixed(2)}초: 상자 던지기 ${pd.mass}kg · ${cfg.throwProp.speed} m/s → ${fmtV(point)}`;
    } else if (mode === 'look') {
      const c = host.chars[selected]!;
      const tgt: Vec3 = [point[0], Math.max(point[1], 0.2), point[2]];
      c.ch.lookAt(tgt);
      host.interacted = true;
      lastInputEl.textContent = `${host.time.toFixed(2)}초: ${c.label} 시선 → ${fmtV(tgt)}`;
    } else if (mode === 'place') placeChar([point[0], point[1], point[2]]);
  };

  async function doReset(): Promise<void> {
    await host.reset();
    graph.clear();
    view.syncCharacters(host.chars.map((c) => c.def));
    view.resetFollow();
    view.setTerrain(host.played?.terrain ?? host.terrain);
    const s0 = host.state(0);
    // 여러 캐릭터면 모두의 가운데를 본다
    const cs = host.chars.map((c) => c.ch.getState().com);
    const cx = cs.reduce((a, c) => a + c[0], 0) / cs.length, cz = cs.reduce((a, c) => a + c[2], 0) / cs.length;
    view.frameOn([cx, Math.max(0, s0.balance?.groundHeight ?? 0), cz], host.chars.length > 1 ? 1.35 : 1, host.played?.cameras?.[0]);
    refreshCharSel();
    rootCheck.checked = host.rootAssist;
    lastInputEl.textContent = '아직 입력 없음';
    note = host.scenario?.batch ? `묶음 시나리오: 러너의 첫 시드(${host.scenario.batch.seedStart}) 실행을 재생` : '';
    setPlaying(true);
  }
  view.setTerrain(host.terrain);
  refreshCharSel();
  selectScenario('').catch((e) => console.error(e));

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === '.') { setPlaying(false); host.stepOnce(); }
    else if (e.key === 'r' || e.key === 'R') void doReset();
  });

  // 테스트·콘솔용 훅
  (window as unknown as { ragdollApp: unknown }).ragdollApp = {
    host, view,
    selectScenario: (name: string) => selectScenario(scenarios.find((s) => s.sc.name === name)?.path ?? ''),
    setPlaying, setInput,
    setSpeed: (v: number) => { speed = v; speedSeg.set(v); speedSlider.set(v); },
    setAnimOverride: (v: number) => { aoSlider.set(v); host.setAnimOverride(v); },
    bodyScreen: (b: BodyName, ci = 0) => view.screenOf(host.state(ci).bodies[b]!.pos as Vec3),
    /** sim과 같은 프레임 비교용: 지금까지 돈 스텝 수만큼 실행하고 COM 목록 */
    runSteps: (n: number) => { for (let i = 0; i < n; i++) host.stepOnce(); return host.chars.map((c) => c.ch.getState().com); },
  };

  loading.textContent = 'FBX 불러오는 중…';
  const fbxUrl = fbxUrls['../../' + skinCfg.fbx] ?? encodeURI(import.meta.env.BASE_URL + skinCfg.fbx);
  view.loadSkin(fbxUrl, skinCfg)
    .then(() => { loading.style.display = 'none'; })
    .catch((err: Error) => { loading.textContent = `FBX 불러오기 실패: ${err.message}`; console.error(err); });

  let prev = performance.now();
  const frame = (now: number) => {
    const realDt = Math.min((now - prev) / 1000, cfg.maxFrameDt);
    prev = now;
    if (playing) host.advance(realDt * speed, () => performance.now());
    if (playing && host.scenarioDone) { setPlaying(false); note = '시나리오 끝'; }
    const multi = host.chars.length > 1;
    const states = host.chars.map((c) => c.ch.getState());
    const names = host.chars.map((c) => c.ch.name);
    const frames: CharFrame[] = host.chars.map((c, i) => ({
      state: states[i]!, label: c.label, pin: pinBodies(states[i]!),
      events: multi ? eventsFor(host.world.events, names[i]) : host.world.events,
    }));
    const props = host.world.props.length ? { meta: host.world.props.map((p) => p.meta), states: host.world.props.map((p) => p.state()) } : null;
    view.render(frames, props, host.time, now);
    const s = states[Math.min(selected, states.length - 1)]!;
    const errs = Object.values(s.joints).map((j) => j.errorDeg);
    const a = s.assist;
    graph.push(s.time, [s.com[1], errs.reduce((x, y) => x + y, 0) / errs.length, a.root + a.pin + a.getup + (a.animOverride ?? 0)]);
    graph.extra = ['', '', `누적 ${host.chars[selected]!.assistIntegral.toFixed(1)} N·s`];
    graph.draw();
    if (document.activeElement !== rootCheck) rootCheck.checked = host.rootAssist;

    // 상태 줄: 시간·재생·속도(실제 비율)·시나리오·sim 일치
    const sc = host.scenario;
    const perf = host.perf();
    const slow = playing && perf.ratio < cfg.perf.slowRatio;
    const boom = host.world.events.filter((e) => e.type === 'exploded');
    const dur = host.played?.duration;
    statusEl.innerHTML = [
      `<b>${host.time.toFixed(2)}초</b> · ${playing ? '재생 중' : '일시정지'} · ${speed.toFixed(2)}배${playing ? ` · 실제 <span class="${slow ? 'slow' : ''}">${(perf.ratio * speed).toFixed(2)}배</span> (${perf.msPerStep.toFixed(1)} ms/스텝${slow ? ', 느림' : ''})` : ''}`,
      sc ? `시나리오 <b>${esc(sc.name)}</b> (v${sc.milestone}) ${host.time.toFixed(1)} / ${(dur ?? sc.duration).toFixed(1)}초` : `자유 실행 · ${TERRAIN_KO[host.terrain] ?? host.terrain}`,
      boom.length ? `<span class="note">안전 검사 발동 (${boom.map((e) => `${e.char ?? ''} ${e.t.toFixed(2)}초`).join(', ')}) → 랙돌 상태</span>` : '',
      note ? `<span class="note">${esc(note)}</span>` : '',
    ].filter(Boolean).join('<br>');
    if (showText) {
      charsEl.innerHTML = host.chars.map((c, i) => {
        const st = states[i]!;
        const evs = frames[i]!.events;
        return `<div class="char" style="border-left-color:${view.chars[i]?.colors.css ?? '#333'}">${charLines(c, st, evs, multi).join('<br>')}</div>`;
      }).join('');
    }
    // sim 일치 표시
    if (sc) {
      const why = [host.musclesDirty ? '근육 튜닝' : '', host.interacted ? '대화형 입력' : '', host.animOverride > 0 ? '애니 강제' : ''].filter(Boolean);
      matchEl.innerHTML = host.faithful
        ? `<span class="ok">sim과 같은 입력</span> — 같은 시드 ${host.played!.seed}·러너 공용 재생 함수 (npm run sim -- ${esc(sc.name)}와 같은 호출). 브라우저 수학 함수가 Node와 마지막 자리에서 달라 넘어짐·충돌처럼 갈림이 큰 장면은 몇 cm 어긋날 수 있다 (결정 app-6)`
        : `<span class="warn">sim과 달라짐</span> (${why.join('·')}) — 처음부터 누르면 다시 같아진다`;
    } else matchEl.textContent = '자유 실행 (시나리오 아님)';
    // 애니 강제(보조 힘) 경고: 비율과 이번 프레임 핀 힘
    if (host.animOverride > 0) {
      const f = states.reduce((x, st) => x + (st.assist.animOverride ?? 0), 0);
      assistEl.style.display = 'block';
      assistEl.innerHTML = `보조 힘 사용 중 ${Math.round(host.animOverride * 100)}%<small>애니 강제 핀 힘 ${f.toFixed(0)} N${multi ? ` (${host.chars.length}명 합)` : ''} · 레퍼런스 ${states[0]!.animOverride?.source === 'clip' ? '애니 클립' : '서기 포즈'}</small>`;
    } else assistEl.style.display = 'none';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err: Error) => {
  console.error(err);
  const l = document.getElementById('loading');
  if (l) { l.style.display = 'block'; l.textContent = `오류: ${err.message}`; }
});
