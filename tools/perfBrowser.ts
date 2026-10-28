// (README 결정 game-4) 브라우저(Chromium, playwright) 1명당 비용: tools/perf/browserPage.ts를 묶어 캐릭터 1·2·4·8명 스텝당 ms를 잰다.
// 사용법: npx tsx tools/perfBrowser.ts [--counts 1,2,4,8] [--scenes stand,walk,anim] [--warm 1] [--measure 4] [--json out/perf_browser.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const counts = opt('--counts', '1,2,4,8').split(',').map(Number);
const scenes = opt('--scenes', 'stand,walk,anim').split(',');
const warm = Number(opt('--warm', '1')), measure = Number(opt('--measure', '4'));

const res = await build({ entryPoints: [join(root, 'tools', 'perf', 'browserPage.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'error' });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: res.outputFiles[0]!.text });
const ver = browser.version();
const rows: { scene: string; n: number; msPerStep: number; msPerChar: number; p95: number }[] = [];
console.log(`Chromium ${ver}`);
console.log('| 장면 | 인원 | ms/스텝 | ms/명 | p95 ms/스텝 | 실시간 여유 |');
console.log('|---|---|---|---|---|---|');
for (const scene of scenes) for (const n of counts) {
  const r = await page.evaluate(([s, k, a, b]) => window.runPerf(s as string, k as number, a as number, b as number), [scene, n, warm, measure] as const);
  rows.push({ scene, n, ...r });
  console.log(`| ${scene} | ${n} | ${r.msPerStep.toFixed(3)} | ${r.msPerChar.toFixed(3)} | ${r.p95.toFixed(3)} | ${(8.333 / r.msPerStep).toFixed(1)}× |`);
}
await browser.close();
const out = opt('--json', 'out/perf_browser.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), chromium: ver, rows }, null, 2));
