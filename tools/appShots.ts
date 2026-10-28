// 앱 캡처 (CLAUDE.md 보고 형식: 스크린샷 위주). vite 개발 서버를 띄우고 Playwright Chromium으로 앱을 조작해 out/app/*.png를 만든다.
// 사용: npm run app:shots   (콘솔 오류가 있으면 실패 코드로 끝난다)
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright';

const OUT = 'out/app';
const PORT = 5199;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setSlider(page: Page, section: string, label: string, pos: number): Promise<void> {
  const ok = await page.evaluate(([sec, lbl, p]) => {
    const details = [...document.querySelectorAll('#panel details')].find((d) => d.querySelector('summary')?.textContent === sec);
    const row = [...(details?.querySelectorAll('label.slider') ?? [])].find((r) => r.querySelector('.lbl')?.textContent === lbl);
    const input = row?.querySelector('input');
    if (!input) return false;
    input.value = String(p);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, [section, label, pos] as const);
  if (!ok) throw new Error(`슬라이더 없음: ${section} / ${label}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
    // 개발 모드(?dev): 디버그 표시·근육 튜닝이 보이는 화면. 접힌 패널 섹션은 모두 펼친다
    await page.goto(`http://localhost:${PORT}/?dev`);
    await page.waitForFunction(() => 'ragdollApp' in window, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>('#panel > details').forEach((d) => { d.open = true; }));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')!).display === 'none', null, { timeout: 60_000 });
    await wait(2500);
    const shots: string[] = [];
    const shot = async (name: string) => {
      const p = `${OUT}/${name}.png`;
      await page.screenshot({ path: p });
      shots.push(p);
    };
    await shot('01_rest');

    // (2) 밀기: 중간 프리셋, 가슴(Spine2)을 잡고 화면 오른쪽으로 끈다
    await page.getByRole('button', { name: /^중간/ }).click();
    const [x, y] = await page.evaluate(() => (window as unknown as { ragdollApp: { bodyScreen(b: string): [number, number] } }).ragdollApp.bodyScreen('Spine2'));
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 12, y + i * 1);
    await shot('02a_drag');
    await page.mouse.up();
    await wait(120);
    await shot('02_push');
    await wait(900);
    await shot('02b_push_after');

    // (3) 튜닝: 리셋 후 전신 강도를 15%로 낮춰 처지게 한다 (관절 오차 표시 켬, 왼다리 관절 슬라이더 펼침)
    await page.click('#btnReset');
    await wait(1500);
    await page.getByText('관절 오차', { exact: true }).click();
    await setSlider(page, '근육 튜닝 (첫 캐릭터)', '전신', 0.15);
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('#panel details details')].find((e) => e.querySelector('summary')?.textContent === '왼다리') as HTMLDetailsElement | undefined;
      if (d) d.open = true;
      [...document.querySelectorAll('#panel h4')].find((e) => e.textContent === '영역 강도')?.scrollIntoView({ block: 'start' });
    });
    await wait(3000);
    await shot('03_tuning_sag');

    // FBX 표시
    await page.getByRole('button', { name: '둘 다' }).click();
    await wait(300);
    await shot('04_both');
    console.log(shots.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
  if (errors.length) {
    console.error(`콘솔 오류·경고 ${errors.length}건:\n${errors.join('\n')}`);
    process.exitCode = 1;
  } else console.log('콘솔 오류 없음');
}

main().catch((e) => { console.error(e); process.exit(1); });
