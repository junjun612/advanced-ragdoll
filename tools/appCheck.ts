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
    await page.waitForFunction(() => 'ragdollApp' in window, null, { timeout: 120_000 });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')!).display === 'none', null, { timeout: 120_000 });
    const shot = async (file: string) => { await wait(700); await page.screenshot({ path: join(OUT, file) }); report.push(join(OUT, file)); };

    // ① 대표 시나리오: 같은 프레임 COM 비교 + 스크린샷
    for (const [name, t] of SHOTS) {
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
    }

    // ② 애니 강제 비율 0 / 0.3 / 1.0: push_left_medium 같은 밀기
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

    // ③ 대화형: 자유 실행에 캐릭터 추가 → 폭발, 프롭 던지기, 걷기
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario(''); a.setPlaying(false); a.runSteps(60); });
    await page.click('#btnAddChar');
    await page.evaluate(() => (window as unknown as { ragdollApp: App }).ragdollApp.runSteps(60));
    await shot('free_add_character.png');
    await page.evaluate(() => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; a.view.onGround!('throw', [0, 1.0, 0], [2.6, 1.45, 3.2]); a.runSteps(40); });
    await shot('free_throw_prop.png');
    await page.evaluate(() => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; a.view.onGround!('explosion', [0.8, 0, 0.6], [2.6, 1.45, 3.2]); a.runSteps(60); });
    await shot('free_explosion.png');
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario(''); a.setPlaying(false); a.runSteps(30); });
    await page.click('#btnWalk');
    await page.evaluate(() => (window as unknown as { ragdollApp: App }).ragdollApp.runSteps(240));
    await shot('free_walk.png');
    // 실시간 재생 속도 (두 캐릭터)
    await page.evaluate(async () => { const a = (window as unknown as { ragdollApp: App }).ragdollApp; await a.selectScenario('two_characters_collide'); a.setPlaying(true); });
    await wait(4000);
    report.push(`  실시간 재생 (two_characters_collide): ${await page.evaluate(() => document.getElementById('status')!.textContent!.split('·').slice(0, 4).join('·'))}`);
    await page.screenshot({ path: join(OUT, 'realtime_two_characters.png') });
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
