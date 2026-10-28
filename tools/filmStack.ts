// 필름스트립 여러 장을 한글 제목을 붙여 세로로 한 장에 붙인다 (보고용, README 결정 game-3).
// 사용법: npx tsx tools/filmStack.ts <출력.png> "<제목>=<그림.png>" ...
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const [out, ...items] = process.argv.slice(2);
const parts = items.map((s) => { const i = s.indexOf('='); return { label: s.slice(0, i), file: s.slice(i + 1) }; });
const html = `<html><body style="margin:0;background:#fff;font-family:'Malgun Gothic',sans-serif">${parts.map((x) => `<div style="font-size:26px;font-weight:bold;padding:8px 12px;background:#223;color:#fff">${x.label}</div><img style="display:block;width:2000px" src="data:image/png;base64,${readFileSync(x.file).toString('base64')}">`).join('')}</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 600 } });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(out!), fullPage: true });
await browser.close();
console.log(resolve(out!));
