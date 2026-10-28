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
/** 아이콘 (24×24 선 그림, currentColor) */
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  push: svg('<path d="M4 12h12"/><path d="M12 6l6 6-6 6"/><path d="M20 5v14"/>'),
  bullet: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  melee: svg('<path d="M12 3l2 5 5-2-2 5 5 1-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-1-2-5 5 2z"/>'),
  explosion: svg('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/>'),
  throw: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
  look: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  place: svg('<circle cx="10" cy="6" r="3"/><path d="M10 10v6M6 21l4-5 4 5M5 13h10"/><path d="M19 8v6M16 11h6"/>'),
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: svg('<path d="M7 4v16M17 4v16" stroke-width="3.5"/>'),
  step: svg('<path d="M5 4l10 8-10 8z" fill="currentColor"/><path d="M19 4v16" stroke-width="2.5"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/>'),
};
const INPUT_KO: { value: InputMode; label: string; hint: string; icon: string }[] = [
  { value: 'push', label: '밀기', icon: ICON.push, hint: '캐릭터를 클릭한 채 끌었다 놓으면 끈 방향으로 밀어요. 빈 곳을 끌면 카메라가 돌아요.' },
  { value: 'bullet', label: '총탄', icon: ICON.bullet, hint: '캐릭터를 클릭하면 그 자리에 총탄을 맞아요.' },
  { value: 'melee', label: '근접', icon: ICON.melee, hint: '캐릭터를 클릭하면 보는 방향으로 근접 타격을 받아요.' },
  { value: 'explosion', label: '폭발', icon: ICON.explosion, hint: '바닥을 클릭하면 그 자리에서 터져요. 가까울수록 세게, 모든 캐릭터가 받아요.' },
  { value: 'throw', label: '프롭 던지기', icon: ICON.throw, hint: '클릭한 곳으로 카메라 쪽에서 상자를 던져요.' },
  { value: 'look', label: '시선', icon: ICON.look, hint: '클릭한 곳을 고른 캐릭터가 바라봐요.' },
  { value: 'place', label: '캐릭터 놓기', icon: ICON.place, hint: '바닥을 클릭한 곳에 캐릭터를 하나 더 세워요 (최대 4명).' },
];
/** 보기 모드 / 개발 모드의 기본 표시 */
const SHOW_PRESET: Record<'view' | 'dev', Record<DebugPart, boolean>> = {
  // (사람 지시) 보기 모드도 3D 디버그 요소는 개발 모드와 같이 그린다 — 두 모드의 차이는 패널·상태 글뿐
  view: { com: true, support: true, balance: false, impact: true, strength: true, pin: true, jointError: false, debug: true, tags: true },
  dev: { com: true, support: true, balance: false, impact: true, strength: true, pin: true, jointError: false, debug: true, tags: true },
};
/** 보기 모드 상태 글에 남기는 꼬리표 (지금 무엇을 하는지만, 수치 위주 꼬리표는 개발 모드) */
const VIEW_TAGS = new Set(['beh', 'fall', 'getup', 'wound', 'impact', 'grab', 'air']);
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* 저장 안 돼도 동작 */ } },
};
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
function charLines(c: AppChar, s: CharacterState, events: readonly import("../render/stateTypes").FilmEvent[], multi: boolean, detail: boolean): string[] {
  const lines: string[] = [];
  const nm = multi ? `${c.label} · ` : '';
  // 상태·디딤·COM 높이 같은 세부 값은 패널 '개발 지표'에 둔다
  lines.push(`<b>${nm}${POSTURE_LABEL[s.posture] ?? s.posture}</b>`);
  const add = (cls: string, t: string) => { if (t && (detail || VIEW_TAGS.has(cls))) lines.push(`<span class="tag ${cls}">${esc(t)}</span>`); };
  // 보기 모드는 행동 이름만 (가중치 숫자 뺌)
  const beh = activeBehaviorText(s);
  add('beh', beh ? (detail ? `행동: ${beh}` : beh.replace(/\s*\d+(\.\d+)?/g, '')) : '');
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
  add('clutch', clutchText(s));
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
  const loadingText = document.getElementById('loadingText')!;
  const legendEl = document.getElementById('legend')!;
  const dock = document.getElementById('dock')!;
  const coach = document.getElementById('coach')!;
  document.title = `액티브 랙돌 ${cfg.version}`;
  document.getElementById('appTitle')!.append(' ', el('span', { class: 'ver' }, cfg.version));

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
  /** 개발 모드: 디버그 표시·근육 튜닝·그래프·sim 일치. 주소에 ?dev가 있거나 지난번에 켰으면 켠다 */
  let dev = new URLSearchParams(location.search).has('dev') || store.get('ragdoll.dev') === '1';

  // ── 모드 (보기 / 개발) ──
  const modeSeg = segmented<'view' | 'dev'>(document.getElementById('modeRow')!, [
    { label: '보기', value: 'view', title: '깔끔한 화면: 캐릭터와 반응만' },
    { label: '개발', value: 'dev', title: '질량중심·지지 다각형·근육 강도 색, 그래프, 근육 튜닝, sim 일치 표시' },
  ], dev ? 'dev' : 'view', (m) => setDev(m === 'dev'), 'seg mode-seg');

  // ── 개발 지표 (개발 모드만): COM 높이·관절 오차·보조 힘 그래프와 실행 속도 ──
  const sDev = section(panel, '개발 지표');
  sDev.parentElement!.classList.add('dev-only');
  const perfEl = el('div', { class: 'readout', id: 'perfInfo' });
  sDev.append(document.getElementById('graphBox')!, perfEl);

  // ── 아래 도구 막대: 재생 + 입력 도구 ──
  const dockPlay = el('div', { class: 'dock-group' });
  const playBtn = el('button', { id: 'btnPlay', class: 'icon-btn', title: '재생·일시정지 (스페이스)' });
  const playIco = el('span', { class: 'ico', 'aria-hidden': 'true' });
  const playTxt = el('span', { class: 'txt' }, '일시정지');
  playBtn.append(playIco, playTxt);
  playBtn.addEventListener('click', () => setPlaying(!playing));
  dockPlay.append(playBtn);
  buttons(dockPlay, [
    { label: '한 스텝', id: 'btnStep', icon: ICON.step, onClick: () => { setPlaying(false); host.stepOnce(); }, title: '1/120초 한 스텝 (.)' },
    { label: '처음부터', id: 'btnReset', icon: ICON.reset, onClick: () => void doReset(), title: '처음 상태로 (R)' },
  ], 'btn-row icon-row');
  const speedSeg = segmented(dockPlay, cfg.speeds.map((s) => ({ label: `${s}배`, value: s, title: `재생 속도 ${s}배` })), speed, (v) => { speed = v; }, 'seg speed-seg');
  const dockTools = el('div', { class: 'dock-group tools' });
  const dockHint = el('div', { class: 'dock-hint' });
  dock.append(dockHint, el('div', { class: 'dock-bar' }, dockPlay, dockTools));
  // 카메라는 왼쪽 3D 화면(#viewport) 기준이고, 그 안에서 아래 도구 막대가 가린 만큼 빼고 가운데에 맞춘다
  new ResizeObserver(() => view.setInsets({ bottom: dock.offsetHeight + 14 })).observe(dock);
  const setPlaying = (p: boolean) => {
    if (p && host.scenarioDone) return;
    playing = p;
    playTxt.textContent = p ? '일시정지' : '재생';
    playIco.innerHTML = p ? ICON.pause : ICON.play;
    playBtn.classList.toggle('paused', !p);
  };
  setPlaying(true);

  // ── 장면 ──
  const sScn = section(panel, '장면');
  const showcase = el('div', { class: 'chips', id: 'showcase' });
  sScn.append(el('div', { class: 'sub-h' }, '추천 장면'), showcase);
  const showcaseBtns = new Map<string, HTMLButtonElement>();
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
  const matchEl = el('div', { class: 'readout dev-only', id: 'matchInfo' });
  sScn.append(el('div', { class: 'sub-h' }, '모든 시나리오'), sel, terrainRow, scnDesc, matchEl);
  const freeBtn = el('button', { class: 'chip' }, '자유 실행');
  freeBtn.title = '평지에 서 있는 캐릭터로 직접 실험';
  freeBtn.addEventListener('click', () => void selectScenario(''));
  showcase.append(freeBtn);
  showcaseBtns.set('', freeBtn);
  for (const it of cfg.showcase) {
    const found = scenarios.find((s) => s.sc.name === it.scenario);
    if (!found) continue;
    const b = el('button', { class: 'chip' }, it.label);
    b.title = found.sc.description ?? it.scenario;
    b.addEventListener('click', () => void selectScenario(found.path));
    showcase.append(b);
    showcaseBtns.set(found.path, b);
  }
  terrainSel.addEventListener('change', () => { host.terrain = terrainSel.value as TerrainName; void doReset(); });
  /** 지금 시나리오의 보이는 이름 (추천 장면이면 그 글) */
  const scenarioTitle = () => {
    const sc = host.scenario;
    if (!sc) return '';
    return cfg.showcase.find((x) => x.scenario === sc.name)?.label ?? sc.name;
  };
  const selectScenario = (path: string) => {
    sel.value = path;
    host.scenario = scenarios.find((s) => s.path === path)?.sc ?? null;
    terrainRow.style.display = host.scenario ? 'none' : '';
    scnDesc.textContent = host.scenario ? (host.scenario.description ?? '') : '평지(또는 고른 지형)에 서 있는 캐릭터예요. 아래 도구로 밀고, 쏘고, 터뜨려 보세요.';
    for (const [p, b] of showcaseBtns) b.classList.toggle('on', p === path);
    return doReset();
  };
  sel.addEventListener('change', () => void selectScenario(sel.value));

  // ── 입력 ──
  const sIn = section(panel, '입력 세기');
  const inSeg = segmented<InputMode>(dockTools, INPUT_KO.map((x, i) => ({ label: x.label, value: x.value, icon: x.icon, title: `${x.hint} (${i + 1})` })), 'push', (m) => setInput(m), 'seg tool-seg');
  const setInput = (m: InputMode) => {
    view.input = m;
    inSeg.set(m);
    dockHint.textContent = INPUT_KO.find((x) => x.value === m)!.hint;
    pushBox.style.display = m === 'push' ? '' : 'none';
    strikeBox.style.display = m === 'bullet' || m === 'melee' ? '' : 'none';
    boomBox.style.display = m === 'explosion' ? '' : 'none';
    otherBox.style.display = m === 'look' || m === 'place' || m === 'throw' ? '' : 'none';
    otherBox.textContent = m === 'throw' ? `상자 ${cfg.throwProp.mass}kg을 ${cfg.throwProp.speed} m/s로 던져요.` : '시선·캐릭터 놓기는 세기가 없어요.';
  };
  const pushBox = el('div', { class: 'section-body' });
  const dvSlider = slider(pushBox, '밀기 세기', { min: 0.05, max: cfg.pushMaxDv, step: 0.05, value: pushDv, fmt: fmtDv, onInput: (v) => { pushDv = v; } });
  buttons(pushBox, (['small', 'medium', 'large'] as const).map((k) => ({
    label: `${HIT_KO[k]} ${HIT[k]}`, onClick: () => { pushDv = HIT[k]; dvSlider.set(pushDv); },
  })), 'btn-row presets');
  pushBox.append(el('div', { class: 'hint dev-only' }, '세기는 전신 질량중심 속도 변화 Δv(m/s), 충격량 J = 총질량 × Δv.'));
  const otherBox = el('div', { class: 'hint' }, '시선·캐릭터 놓기는 세기가 없어요.');
  const strikeBox = el('div', { class: 'section-body' });
  slider(strikeBox, '타격 세기', { min: 0.05, max: 1.5, step: 0.05, value: strikeDv, fmt: fmtDv, onInput: (v) => { strikeDv = v; } });
  const boomBox = el('div', { class: 'section-body' });
  slider(boomBox, '폭발 세기', { min: 0.5, max: 8, step: 0.1, value: boomDv, fmt: (v) => `1m에서 Δv ${v.toFixed(1)} m/s`, onInput: (v) => { boomDv = v; } });
  sIn.append(pushBox, strikeBox, boomBox, otherBox);
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
    { label: '애니로 복귀', id: 'btnReturn', title: '반응이 끝나면(복귀 가능 시점) 걷기 애니(키네마틱)로 관성화해 돌려받는다 — 게임이 맞은 캐릭터를 다시 애니로 움직이는 흐름', onClick: () => { const ok = host.returnToAnim(selected, 'recovered'); note = `${host.chars[selected]!.label} ${ok ? '반응 끝나면 애니로 복귀' : '복귀 불가(사망·폭발)'}`; } },
    { label: '지금 애니로', id: 'btnReturnNow', title: '반응 중이어도 바로 애니로 관성화 (핀 없이)', onClick: () => { const ok = host.returnToAnim(selected, 'now'); note = `${host.chars[selected]!.label} ${ok ? '지금 애니로 복귀' : '복귀 불가'}`; } },
  ]);
  sCh.append(el('h4', { class: 'dev-only' }, '애니 강제 비율(핀)'));
  sCh.append(el('div', { class: 'hint dev-only' }, 'PuppetMaster 핀 가중치: 바디를 애니 레퍼런스(클립, 없으면 서기 포즈) 쪽으로 핀 힘으로 끈다. 0 = 물리 그대로, 1 = 거의 애니. 피격·넘어짐 중에도 건다 — 시연·비교용 보조 힘이다.'));
  const aoSlider = slider(sCh, '애니 강제', {
    min: 0, max: cfg.animOverride.max, step: cfg.animOverride.step, value: 0, fmt: (v) => `${Math.round(v * 100)}%`,
    title: '애니 강제 비율(핀)', onInput: (v) => host.setAnimOverride(v),
  });
  aoSlider.input.id = 'animOverride';
  aoSlider.row.classList.add('dev-only');

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
  const sView = section(panel, '표시', false);
  segmented<DisplayMode>(sView, [{ label: '캡슐', value: 'capsule' }, { label: 'FBX', value: 'fbx' }, { label: '둘 다', value: 'both' }], view.mode, (m) => view.setMode(m));
  // FPS 표시 (그리기 제한은 config/app.json fps.cap, 물리는 1/120초 고정)
  const fpsCap = cfg.fps.cap;
  const fpsBadge = document.getElementById('fpsBadge')!;
  let showFps = store.get('ragdoll.showFps') !== '0';
  const dbg = el('div', { class: 'checks' });
  sView.append(dbg);
  checkbox(dbg, 'FPS 표시', showFps, (v) => { showFps = v; store.set('ragdoll.showFps', v ? '1' : '0'); fpsBadge.style.display = v ? '' : 'none'; });
  fpsBadge.style.display = showFps ? '' : 'none';
  const showChecks = new Map<DebugPart, HTMLInputElement>();
  const chk = (label: string, part: DebugPart, sw?: string) => {
    const on = SHOW_PRESET[dev ? 'dev' : 'view'][part];
    view.setShow(part, on);
    showChecks.set(part, checkbox(dbg, label, on, (v) => view.setShow(part, v), sw));
  };
  chk('질량중심', 'com', DEBUG_COLOR.com);
  chk('지지 다각형·캡처', 'support', DEBUG_COLOR.support);
  chk('균형 힘·CoP', 'balance', DEBUG_COLOR.force);
  chk('충격 화살표', 'impact', DEBUG_COLOR.impact);
  chk('근육 강도 색', 'strength', 'linear-gradient(90deg, rgb(199,214,240), rgb(46,82,158))');
  chk('핀 세기 색', 'pin', '#f07300');
  chk('관절 오차', 'jointError', 'linear-gradient(90deg, #20b040, #f0c000, #e02020)');
  chk('잡기·상처·시선 등', 'debug', DEBUG_COLOR.grab);
  chk('이름표', 'tags', '#2e52a0');
  checkbox(dbg, '상태 글', true, (v) => { showText = v; charsEl.style.display = v ? '' : 'none'; });
  checkbox(dbg, '범례', false, (v) => { legendEl.style.display = v ? '' : 'none'; });
  checkbox(dbg, '카메라 추적', true, (v) => { view.follow = v; view.resetFollow(); });
  sView.append(el('div', { class: 'hint' }, `핀 세기 색: 바디가 주황으로 빛날수록 핀(애니 쪽으로 끄는 보조 힘)이 세다. 관절 오차 색: 0° 초록 → ${filmCfg.debug.jointErrorMaxDeg ?? 20}° 이상 빨강.`));
  /** 모드를 바꾸면 그 모드의 기본 표시로 맞춘다 (개별 체크는 그 뒤 자유) */
  function setDev(on: boolean): void {
    dev = on;
    store.set('ragdoll.dev', on ? '1' : '0');
    document.body.classList.toggle('dev', on);
    modeSeg.set(on ? 'dev' : 'view');
    const preset = SHOW_PRESET[on ? 'dev' : 'view'];
    for (const [part, input] of showChecks) { input.checked = preset[part]; view.setShow(part, preset[part]); }
  }
  document.body.classList.toggle('dev', dev);
  legendEl.replaceChildren(...LEGEND.map((l) => el('div', { class: 'leg' },
    el('span', { class: `sw ${l.kind}`, style: l.kind === 'gradient' ? `background:linear-gradient(90deg, rgb(46,82,158), rgb(199,214,240))` : `background:${l.color || '#202020'}` }), l.label)));
  legendEl.style.display = 'none';

  // ── 근육 튜닝 (첫 캐릭터) ──
  const sTune = section(panel, '근육 튜닝 (첫 캐릭터)', false);
  sTune.parentElement!.classList.add('dev-only');
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
  // 첫 방문 안내: 첫 입력을 하면 사라지고 다시 보이지 않는다
  if (store.get('ragdoll.coached') !== '1') {
    coach.innerHTML = '<b>캐릭터 가슴을 클릭한 채 옆으로 끌었다 놓아 보세요</b><span>아래 막대에서 총탄·폭발 같은 다른 도구도 고를 수 있어요</span>';
    coach.classList.add('show');
  }
  const coached = () => { if (coach.classList.contains('show')) { coach.classList.remove('show'); store.set('ragdoll.coached', '1'); } };
  view.onDrag = (d) => {
    if (!d) { pushInfoEl.style.display = 'none'; return; }
    const c = host.chars[d.ci]!;
    pushInfoEl.style.display = 'block';
    pushInfoEl.textContent = `밀기: ${host.chars.length > 1 ? `${c.label} ` : ''}${BODY_KO[d.body]} (${d.body}) · ${fmtDv(pushDv)} · 충격량 ${(c.def.totalMass * pushDv).toFixed(1)} N·s${d.px < cfg.pushMinDragPx ? ' — 끌어서 방향을 정하세요' : ''}`;
  };
  view.onPush = (ci, body, point, dir) => {
    coached();
    const p = host.push(ci, body, point, dir, pushDv);
    lastInputEl.textContent = `${host.time.toFixed(2)}초: ${host.chars[ci]!.label} ${BODY_KO[body]} (${body}) 밀기 방향 ${fmtV(p.direction)} · ${fmtDv(p.dv)} · 충격량 ${p.impulse.toFixed(1)} N·s`;
  };
  view.onStrike = (kind, ci, body, point, dir) => {
    coached();
    host.strike(ci, kind, body, point, dir, strikeDv);
    lastInputEl.textContent = `${host.time.toFixed(2)}초: ${host.chars[ci]!.label} ${BODY_KO[body]} (${body}) ${kind === 'bullet' ? '총탄' : '근접'} · ${fmtDv(strikeDv)}`;
  };
  view.onGround = (mode, point, from) => {
    coached();
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

  // 페이지 확대 막기: Ctrl/⌘ + 휠·+/−/0, 사파리 제스처(핀치), 두 손가락 터치 이동. 글자·이미지 끌기 막기
  window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
  });
  for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === '.') { setPlaying(false); host.stepOnce(); }
    else if (e.key === 'r' || e.key === 'R') void doReset();
    else if (/^[1-9]$/.test(e.key) && INPUT_KO[Number(e.key) - 1]) setInput(INPUT_KO[Number(e.key) - 1]!.value);
  });

  // 테스트·콘솔용 훅
  (window as unknown as { ragdollApp: unknown }).ragdollApp = {
    host, view,
    selectScenario: (name: string) => selectScenario(scenarios.find((s) => s.sc.name === name)?.path ?? ''),
    setPlaying, setInput,
    setSpeed: (v: number) => { speed = v; speedSeg.set(v); },
    setDev,
    setAnimOverride: (v: number) => { aoSlider.set(v); host.setAnimOverride(v); },
    bodyScreen: (b: BodyName, ci = 0) => view.screenOf(host.state(ci).bodies[b]!.pos as Vec3),
    /** sim과 같은 프레임 비교용: 지금까지 돈 스텝 수만큼 실행하고 COM 목록 */
    runSteps: (n: number) => { for (let i = 0; i < n; i++) host.stepOnce(); return host.chars.map((c) => c.ch.getState().com); },
  };

  loadingText.textContent = '캐릭터 모델 불러오는 중… (그동안은 캡슐로 보여요)';
  loading.classList.add('corner');
  const fbxUrl = fbxUrls['../../' + skinCfg.fbx] ?? encodeURI(import.meta.env.BASE_URL + skinCfg.fbx);
  view.loadSkin(fbxUrl, skinCfg)
    .then(() => { loading.style.display = 'none'; })
    .catch((err: Error) => { loading.classList.add('error'); loadingText.textContent = `캐릭터 모델 불러오기 실패: ${err.message} (캡슐로 계속)`; console.error(err); });

  let prev = performance.now();
  // FPS: sampleSec마다 그린 프레임 수 평균
  let fpsCount = 0, fpsT0 = prev;
  let nextDraw = prev;
  const frame = (now: number) => {
    // 프레임 제한: 예정 시각(nextDraw)보다 반 간격 넘게 이르면 건너뛴다. 예정 시각을 간격만큼 누적해 144Hz 모니터에서도 평균 cap을 맞추고,
    // 반 간격 여유로 60Hz 모니터의 rAF 시각 흔들림에 프레임을 버리지 않는다. 많이 밀렸으면 지금부터 다시 센다
    if (fpsCap > 0) {
      const interval = 1000 / fpsCap;
      if (now < nextDraw - interval / 2) { requestAnimationFrame(frame); return; }
      nextDraw = now - nextDraw > interval ? now + interval : nextDraw + interval;
    }
    fpsCount++;
    if (now - fpsT0 >= cfg.fps.sampleSec * 1000) {
      const fps = (fpsCount * 1000) / (now - fpsT0);
      fpsBadge.textContent = `${fps.toFixed(0)} FPS${fpsCap ? ` / ${fpsCap}` : ''}`;
      fpsBadge.classList.toggle('low', fps < (fpsCap || 60) * 0.8);
      fpsCount = 0; fpsT0 = now;
    }
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
    const total = sc ? (dur ?? sc.duration) : 0;
    if (dev) {
      const st0 = states[Math.min(selected, states.length - 1)]!;
      perfEl.innerHTML = `실행 ${playing ? `실제 ${(perf.ratio * speed).toFixed(2)}배 · ${perf.msPerStep.toFixed(1)} ms/스텝` : '일시정지'}<br>`
        + `${host.chars[selected]!.label}: ${STATE_KO[st0.state] ?? st0.state} · 디딤 ${STANCE_KO[st0.stance] ?? st0.stance} · COM 높이 ${st0.com[1].toFixed(2)}m`
        + (sc ? `<br>시나리오 ${esc(sc.name)} (v${sc.milestone}) · ${host.time.toFixed(2)} / ${total.toFixed(1)}초` : '');
    }
    // 한 줄: 장면 이름 · 시간 (속도·일시정지·느림은 평소와 다를 때만). 개발 모드는 시나리오 원래 이름과 ms/스텝을 붙인다
    const scName = sc ? (dev ? sc.name : scenarioTitle()) : `자유 실행${host.terrain === 'flat' && !dev ? '' : ` · ${TERRAIN_KO[host.terrain] ?? host.terrain}`}`;
    if (!dev) {
      // 보기 모드: 알약 하나 — 장면 · 시간 · 지금 하는 일(첫 행동 이름, 없으면 자세; 여러 명이면 생략) + 진행 막대
      const s0 = states[0]!;
      const now = multi ? '' : (activeBehaviorText(s0).split('·')[0] ?? '').replace(/\s*\d+(\.\d+)?/g, '').trim() || (POSTURE_LABEL[s0.posture] ?? s0.posture);
      statusEl.innerHTML = `<b>${esc(scName)}</b> <span class="dim">${host.time.toFixed(1)}초${playing ? '' : ' · 일시정지'}${speed !== 1 ? ` · ${speed}배` : ''}</span>`
        + (now ? ` <span class="now">${esc(now)}</span>` : '')
        + (sc ? `<span class="bar"><i style="width:${Math.min(100, (host.time / Math.max(1e-6, total)) * 100).toFixed(1)}%"></i></span>` : '');
    } else statusEl.innerHTML = [
      `<b>${esc(scName)}</b> · ${host.time.toFixed(dev ? 2 : 1)}초${speed !== 1 ? ` · ${speed}배` : ''}${playing ? '' : ' · 일시정지'}`
        + `${slow ? ` · <span class="slow">느림 ${(perf.ratio * speed).toFixed(2)}배</span>` : ''}`,
      sc ? `<span class="bar"><i style="width:${Math.min(100, (host.time / Math.max(1e-6, total)) * 100).toFixed(1)}%"></i></span>` : '',
      boom.length ? `<span class="note">안전 검사 발동 (${boom.map((e) => `${e.char ?? ''} ${e.t.toFixed(2)}초`).join(', ')}) → 랙돌 상태</span>` : '',
      note ? `<span class="note">${esc(note)}</span>` : '',
    ].filter(Boolean).join('<br>');
    // 캐릭터별 꼬리표 상자는 개발 모드만 (보기 모드는 위 알약 한 줄로 충분)
    charsEl.style.display = showText && dev ? '' : 'none';
    if (showText && dev) {
      charsEl.innerHTML = host.chars.map((c, i) => {
        const st = states[i]!;
        const evs = frames[i]!.events;
        return `<div class="char" style="border-left-color:${view.chars[i]?.colors.css ?? '#333'}">${charLines(c, st, evs, multi, dev).join(' ')}</div>`;
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
