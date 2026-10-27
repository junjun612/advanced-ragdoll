// 앱 확인 (README 결정 app-1): vite 개발 서버를 띄우고 Playwright Chromium으로 대표 시나리오를 앱에서 재생해
// ① 같은 프레임의 캐릭터별 COM이 npm run sim 로그(out/<시나리오>/log*.jsonl)와 같은지 보고 ② out/app_check/*.png를 찍는다.
// 애니 강제 비율(결정 app-2) 0 / 0.3 / 1.0 비교와 대화형 입력(폭발·프롭 던지기·캐릭터 추가·걷기)도 찍는다.
// 사용: npm run app:check   (먼저 npm run sim:all 또는 해당 시나리오 npm run sim. 콘솔 오류나 COM 불일치가 있으면 실패 코드)
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';

const OUT = 'out/app_check';
const PORT = 5198;
const DT = 1 / 120;
const LOG_EVERY = 4; // config/sim.json logHz 30 → 4스텝마다

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** [시나리오, 찍을 시각(초)] */
const SHOTS: [string, number][] = [
  ['push_left_medium', 1.6],
  ['rail_grab', 2.2],
  ['wall_lean', 2.0],
  ['two_characters_collide', 1.9],
  ['prop_hit', 1.4],
  ['stairs_tumble', 2.6],
  ['getup_supine', 5.0],
  ['explosion_near', 1.5],
  ['shot_while_walking_clutch', 2.0],
];

type App = {
  host: { time: number; chars: { label: string; ch: { getState(): { com: number[] } } }[]; world: { events: { type: string }[] }; scenarioDone: boolean; stepOnce(): void };
  selectScenario(n: string): Promise<void>;
  setPlaying(p: boolean): void;
  setInput(m: string): void;
  setAnimOverride(v: number): void;
  runSteps(n: number): number[][];
  view: { onGround: ((m: string, p: number[], from: number[]) => void) | null; setMode(m: string): void };
};

function logComs(name: string): Map<string, number[][]> {
  const dir = join('out', name);
  const out = new Map<string, number[][]>();
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { characters?: { name: string; log: string }[] };
  const files = meta.characters?.map((c) => ({ name: c.name, log: c.log })) ?? [{ name: 'A', log: 'log.jsonl' }];
  for (const f of files) {
    const lines = readFileSync(join(dir, f.log), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    out.set(f.name, lines.map((l) => (JSON.parse(l) as { com: number[] }).com));
  }
  return out;
}

async function stepTo(page: Page, name: string, t: number): Promise<number[][]> {
  await page.evaluate(async (n) => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario(n); a.setPlaying(false); }, name);
  const steps = Math.round(t / DT / LOG_EVERY) * LOG_EVERY;
  return page.evaluate((n) => (window as unknown as { ragdollApp: App }).ragdollApp.runSteps(n), steps);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors: string[] = [];
  const report: string[] = [];
  let mismatch = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
    await page.goto(`http://localhost:${PORT}/`, { timeout: 300_000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => 'ragdollApp' in window, null, { timeout: 400_000 });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')!).display === 'none', null, { timeout: 400_000 });
    const shot = async (file: string) => { await wait(700); await page.screenshot({ path: join(OUT, file) }); report.push(join(OUT, file)); };

    // ① 대표 시나리오: 같은 프레임 COM 비교 + 스크린샷
    const only = process.argv.slice(2);
    for (const [name, t] of SHOTS.filter(([n]) => !only.length || only.includes(n))) {
      const coms = await stepTo(page, name, t);
      const steps = Math.round(t / DT / LOG_EVERY) * LOG_EVERY;
      if (existsSync(join('out', name, 'meta.json'))) {
        const ref = logComs(name);
        const names = [...ref.keys()];
        coms.forEach((c, i) => {
          const r = ref.get(names[i]!)?.[steps / LOG_EVERY];
          const d = r ? Math.max(...c.map((x, k) => Math.abs(x - r[k]!))) : Infinity;
          const ok = d <= 1e-4;
          if (!ok) mismatch++;
          report.push(`  ${name} ${names[i]} ${(steps * DT).toFixed(3)}초 COM 앱 (${c.map((x) => x.toFixed(4)).join(', ')}) / sim (${r?.map((x) => x.toFixed(4)).join(', ')}) 차 ${d.toExponential(1)} ${ok ? '같음' : '다름!'}`);
        });
      } else report.push(`  ${name}: out/${name} 없음 (비교 건너뜀)`);
      await shot(`${name}.png`);
      // 끝까지 돌려 전체 COM 궤적·마지막 자세를 sim 로그와 비교 (브라우저 Math 함수가 Node와 1ULP 다를 수 있어 혼돈 장면은 갈린다 — 결정 app-6)
      if (existsSync(join('out', name, 'meta.json'))) {
        const ref = logComs(name), names = [...ref.keys()];
        const traj = await page.evaluate(() => {
          const a = (window as unknown as { ragdollApp: App }).ragdollApp;
          const h = a.host as unknown as { chars: { ch: { getState(): { com: number[]; posture: string } } }[]; playback: { step: number } | null; scenarioDone: boolean; stepOnce(): void };
          const out: number[][][] = h.chars.map(() => []);
          while (!h.scenarioDone) { h.stepOnce(); if (h.playback!.step % 4 === 0) h.chars.forEach((c, i) => out[i]!.push(c.ch.getState().com)); }
          return { out, posture: h.chars.map((c) => c.ch.getState().posture), start: h.playback!.step };
        });
        const postures = readFileSync(join('out', name, (JSON.parse(readFileSync(join('out', name, 'meta.json'), 'utf8')) as { characters?: { log: string }[] }).characters?.[0]?.log ?? 'log.jsonl'), 'utf8').trim().split('\n').slice(-1).map((l) => (JSON.parse(l) as { posture: string }).posture);
        traj.out.forEach((frames, i) => {
          const r = ref.get(names[i]!)!;
          const off = r.length - frames.length;
          let max = 0, onset = -1;
          frames.forEach((c, k) => { const d = Math.hypot(c[0]! - r[k + off]![0]!, c[1]! - r[k + off]![1]!, c[2]! - r[k + off]![2]!); if (d > 0.01 && onset < 0) onset = (k + off) * 4 * DT; max = Math.max(max, d); });
          report.push(`  ${name} ${names[i]} 끝까지: COM 최대 차 ${(max * 100).toFixed(2)}cm${onset >= 0 ? ` (1cm 넘은 시각 ${onset.toFixed(2)}초)` : ''} · 마지막 자세 앱 ${traj.posture[i]}${i === 0 ? ` / sim ${postures[0]}` : ''}`);
        });
      }
    }

    // ② 애니 강제 비율 0 / 0.3 / 1.0: push_left_medium 같은 밀기 (시나리오 이름을 주면 ①만)
    if (!only.length) {
    await page.getByRole('button', { name: '캡슐', exact: true }).click();
    for (const w of [0, 0.3, 1.0]) {
      await page.evaluate(async (v) => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; a.setAnimOverride(v); await a.selectScenario('push_left_medium'); a.setPlaying(false); }, w);
      const n = Math.round(1.6 / DT);
      await page.evaluate((k) => (window as unknown as { ragdollApp: App }).ragdollApp.runSteps(k), n);
      const boom = await page.evaluate(() => (window as unknown as { ragdollApp: App }).ragdollApp.host.world.events.filter((e) => e.type === 'exploded').length);
      report.push(`  애니 강제 ${w}: 폭발 ${boom}`);
      if (boom) mismatch++;
      await shot(`anim_override_${String(w).replace('.', '_')}.png`);
    }
    await page.evaluate(() => (window as unknown as { ragdollApp: App }).ragdollApp.setAnimOverride(0));
    await page.getByRole('button', { name: 'FBX', exact: true }).click();

    // ③ 대화형: 실제 마우스·버튼으로 하나씩 (자유 실행, 일시정지 상태에서 입력 → 스텝 진행 → 효과 확인)
    const ev = (): Promise<{ hits: string[]; props: number; chars: number; look: number; clip: string | null; state: string }> => page.evaluate(() => {
      const a = (window as unknown as { ragdollApp: App }).ragdollApp;
      const h = a.host as unknown as { world: { events: { type: string; detail?: string; char?: string }[]; props: unknown[] }; chars: { ch: { getState(): { anim?: { clip: string } | null; state: string } } }[] };
      const s0 = h.chars[0]!.ch.getState();
      return { hits: h.world.events.filter((e) => e.type === 'hit').map((e) => `${e.char ?? ''}:${e.detail ?? ''}`), props: h.world.props.length, chars: h.chars.length, look: h.world.events.filter((e) => e.type === 'lookAt').length, clip: s0.anim?.clip ?? null, state: s0.state };
    });
    const steps = (n: number) => page.evaluate((k) => (window as unknown as { ragdollApp: App }).ragdollApp.runSteps(k), n);
    const scr = (p: number[]) => page.evaluate((q) => (window as unknown as { ragdollApp: { view: { screenOf(p: number[]): [number, number] } } }).ragdollApp.view.screenOf(q), p);
    const body = (b: string, ci = 0) => page.evaluate(([bb, c]) => (window as unknown as { ragdollApp: { bodyScreen(b: string, c: number): [number, number] } }).ragdollApp.bodyScreen(bb, c), [b, ci] as const);
    /** 첫 캐릭터 발밑 기준 지면 점 (카메라 추적으로 화면이 움직여도 화면 안) */
    const nearA = async (dx: number, dz: number): Promise<number[]> => { const c = await page.evaluate(() => (window as unknown as { ragdollApp: { host: { chars: { ch: { getState(): { com: number[]; balance?: { groundHeight?: number } } } }[] } } }).ragdollApp.host.chars[0]!.ch.getState()); return [c.com[0]! + dx, c.balance?.groundHeight ?? 0, c.com[2]! + dz]; };
    const mode = (label: string) => page.getByRole('button', { name: label, exact: true }).click();
    const check = (what: string, ok: boolean, detail: string) => { report.push(`  [${ok ? '확인' : '실패'}] ${what}: ${detail}`); if (!ok) mismatch++; };
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario(''); a.setPlaying(false); a.runSteps(60); });
    // 밀기: 가슴을 끌어 오른쪽으로
    await mode('밀기');
    let e0 = await ev();
    { const [x, y] = await body('Spine2'); await page.mouse.move(x, y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 10, y); await page.mouse.up(); }
    await steps(60);
    let e1 = await ev();
    check('밀기 (드래그)', e1.hits.length === e0.hits.length + 1, e1.hits.slice(-1).join());
    await shot('input_push.png');
    // 총탄·근접: 바디 클릭
    for (const [label, file] of [['총탄', 'input_bullet.png'], ['근접', 'input_melee.png']] as const) {
      await mode(label);
      e0 = await ev();
      const [x, y] = await body('Spine2');
      await page.mouse.click(x, y);
      await steps(30);
      e1 = await ev();
      check(label, e1.hits.length === e0.hits.length + 1, e1.hits.slice(-1).join());
      await shot(file);
    }
    // 시선: 바닥 클릭
    await mode('시선');
    e0 = await ev();
    { const [x, y] = await scr(await nearA(0.8, 0.6)); await page.mouse.click(x, y); }
    await steps(60);
    e1 = await ev();
    check('시선', e1.look === e0.look + 1, `lookAt 이벤트 ${e1.look}개`);
    await shot('input_look.png');
    // 캐릭터 놓기: 바닥 클릭
    await mode('캐릭터 놓기');
    e0 = await ev();
    { const [x, y] = await scr(await nearA(0.9, 0.9)); await page.mouse.click(x, y); }
    await steps(60);
    e1 = await ev();
    check('캐릭터 놓기', e1.chars === e0.chars + 1, `${e1.chars}명`);
    await shot('input_place.png');
    // 캐릭터 추가 버튼 (고른 캐릭터 앞)
    await page.click('#btnAddChar');
    await steps(60);
    const e2 = await ev();
    check('캐릭터 추가 버튼', e2.chars === e1.chars + 1, `${e2.chars}명`);
    await shot('free_add_character.png');
    // 프롭 던지기: 첫 캐릭터 가슴 쪽 클릭
    await mode('프롭 던지기');
    e0 = await ev();
    { const [x, y] = await body('Spine2'); await page.mouse.click(x, y); }
    await steps(40);
    e1 = await ev();
    check('프롭 던지기', e1.props === e0.props + 1, `프롭 ${e1.props}개`);
    await shot('free_throw_prop.png');
    // 폭발: 바닥 클릭 (모든 캐릭터가 받음)
    await mode('폭발');
    e0 = await ev();
    { const [x, y] = await scr(await nearA(0.6, 0.4)); await page.mouse.click(x, y); }
    await steps(60);
    e1 = await ev();
    const boomHits = e1.hits.slice(e0.hits.length);
    check('폭발', boomHits.some((h) => h.endsWith(':explosion')), boomHits.join(' '));
    await shot('free_explosion.png');
    // 걷기 시작·정지
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario(''); a.setPlaying(false); a.runSteps(30); });
    await page.click('#btnWalk');
    await steps(300);
    e1 = await ev();
    check('걷기 시작', e1.clip === 'kimodo_walk_forward', `클립 ${e1.clip} · ${e1.state}`);
    await shot('free_walk.png');
    await page.click('#btnStop');
    await steps(240);
    e1 = await ev();
    check('정지', e1.clip === 'kimodo_idle_relaxed', `클립 ${e1.clip} · ${e1.state}`);
    await shot('free_walk_stop.png');
    await mode('밀기');
    // 실시간 재생 속도 (두 캐릭터)
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario('two_characters_collide'); a.setPlaying(true); });
    await wait(4000);
    report.push(`  실시간 재생 (two_characters_collide): ${await page.evaluate(() => document.getElementById('status')!.textContent!.split('·').slice(0, 4).join('·'))}`);
    await page.screenshot({ path: join(OUT, 'realtime_two_characters.png') });
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(report.join('\n'));
  if (errors.length) console.log(`콘솔 오류·경고 ${errors.length}개:\n${errors.join('\n')}`);
  else console.log('콘솔 오류 0개');
  console.log(mismatch ? `불일치 ${mismatch}건` : 'COM 모두 같음, 폭발 없음');
  process.exit(errors.length || mismatch ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
