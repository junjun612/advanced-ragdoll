// 앱 UI 캡처 (보기·개발 모드, 휴대폰 폭). vite 개발 서버를 띄우고 Playwright Chromium으로 out/app/ui_*.png를 만든다.
// 사용: npx tsx tools/appUiShots.ts   (콘솔 오류가 있으면 실패 코드로 끝난다)
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';

const OUT = 'out/app';
const PORT = 5198;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type App = { selectScenario(n: string): Promise<void>; setPlaying(p: boolean): void; runSteps(n: number): unknown; setDev(on: boolean): void };
const app = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
  const x = (window as unknown as { ragdollApp: App }).ragdollApp as unknown as Record<string, (...v: unknown[]) => unknown>;
  return x[f as string]!(...(a as unknown[]));
}, [fn, args] as const);

async function scene(page: Page, name: string, steps: number): Promise<void> {
  await app(page, 'selectScenario', name);
  await app(page, 'setPlaying', false);
  await app(page, 'runSteps', steps);
  await wait(400);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors: string[] = [];
  const shots: string[] = [];
  try {
    // 접는 아이폰 펼침: 유출 안쪽 화면 2713×1920px을 3배 배율로 본 값 (공식 값 아님)
    const VIEWS = [
      ['desktop', { width: 1440, height: 900 }, 1],
      ['mobile', { width: 390, height: 844 }, 2],
      ['fold_portrait', { width: 640, height: 904 }, 2],
      ['fold_landscape', { width: 904, height: 640 }, 2],
    ] as const;
    for (const [tag, vp, scale] of VIEWS) {
      const page = await browser.newPage({ viewport: vp, deviceScaleFactor: scale, hasTouch: tag !== 'desktop' });
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${m.type()}] ${m.text()}`); });
      await page.goto(`http://localhost:${PORT}/`, { timeout: 300_000, waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => 'ragdollApp' in window, null, { timeout: 120_000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')!).display === 'none', null, { timeout: 120_000 });
      await wait(1500);
      const shot = async (name: string, full = false) => { const p = `${OUT}/ui_${tag}_${name}.png`; await page.screenshot({ path: p, fullPage: full }); shots.push(p); };
      await shot('01_first');
      await scene(page, 'shot_chest_stagger_clutch', 240);
      await shot('02_view_shot', tag === 'mobile' || tag === 'fold_portrait');
      if (tag === 'desktop') {
        await app(page, 'setDev', true);
        await wait(300);
        await shot('03_dev_shot');
        await app(page, 'setDev', false);
      }
      await page.close();
    }
    console.log(shots.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors.length) {
    console.error(`콘솔 오류 ${errors.length}건:\n${errors.join('\n')}`);
    process.exitCode = 1;
  } else console.log('콘솔 오류 없음');
}

main().catch((e) => { console.error(e); process.exit(1); });
