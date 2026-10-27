// Item 4: determinism. Node x2 (same process + fresh worlds), then Chromium (Playwright + Vite dev server).
import R from '@dimforge/rapier3d-compat';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { runDet, DET_CONFIGS, type DetResult } from './det';

await R.init();
const cmp = (a: DetResult, b: DetResult) => {
  const firstRaw = a.rawHashes.findIndex((h, i) => h !== b.rawHashes[i]);
  const firstRound = a.roundHashes.findIndex((h, i) => h !== b.roundHashes[i]);
  const maxFinalDiff = Math.max(...a.last.map((x, i) => Math.abs(x - b.last[i]!)));
  return { rawEqual: a.rawAll === b.rawAll, roundEqual: a.roundAll === b.roundAll, firstRawDiffFrame: firstRaw, firstRoundDiffFrame: firstRound, maxFinalDiff };
};

const node1 = DET_CONFIGS.map((c) => runDet(R, c));
const node2 = DET_CONFIGS.map((c) => runDet(R, c));
const report: Record<string, unknown> = { rapier: R.version(), node: process.version };
report.nodeVsNode = Object.fromEntries(node1.map((r, i) => [r.name, cmp(r, node2[i]!)]));
console.log('node vs node', report.nodeVsNode);

const server = await createServer({ root: process.cwd(), logLevel: 'warn', server: { port: 5317, strictPort: false } });
await server.listen();
const url = server.resolvedUrls!.local[0]!;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${url}spike/rapier/browser/index.html`);
  await page.waitForFunction(() => window.__det !== undefined, null, { timeout: 120000 });
  const det = await page.evaluate(() => window.__det!);
  if ('error' in det) throw new Error(det.error);
  report.browser = { version: det.version, ua: det.ua };
  report.nodeVsBrowser = Object.fromEntries(node1.map((r, i) => [r.name, cmp(r, det.results[i]!)]));
  console.log('node vs browser', report.nodeVsBrowser);
  report.hashes = node1.map((r, i) => ({ name: r.name, nodeRaw: r.rawAll, nodeRound: r.roundAll, browserRaw: det.results[i]!.rawAll, browserRound: det.results[i]!.roundAll, hipsFinal: r.hipsFinal }));
} finally {
  await browser.close();
  await server.close();
}
mkdirSync('spike/rapier/out', { recursive: true });
writeFileSync('spike/rapier/out/04-determinism.json', JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.hashes));
