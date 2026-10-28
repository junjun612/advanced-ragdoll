// (README 결정 pres-3) 호흡·시선 시계열 그림: npx tsx tools/presencePlot.ts <시나리오> [<비교 폴더>]
// out/<시나리오>/log.jsonl에서 Spine2 앞뒤 기울기(도), 호흡 파형 b, 호흡수(회/분), 머리 안정 각, 손 굽힘을 시간축으로 그려 out/<시나리오>/presence.png로 쓴다.
// 비교 폴더(예: out_base/<시나리오>)를 주면 그 Spine2 기울기를 회색으로 겹친다. 라벨은 한글.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

type Q = [number, number, number, number];
interface Row { time: number; bodies: Record<string, { rot: Q }>; breath?: { b: number; rate: number; arousal: number }; behavior?: { presence?: { stabDeg: number } }; fingers?: Record<string, { curl: number }>; events?: unknown }

const pitch = (q: Q): number => {
  const [x, y, z, w] = q;
  const uy = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  return (Math.atan2(uy[2]!, uy[1]!) * 180) / Math.PI;
};
const read = (dir: string): Row[] => readFileSync(join(dir, 'log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);

const [name, cmpDir] = process.argv.slice(2);
if (!name) throw new Error('사용법: npx tsx tools/presencePlot.ts <시나리오> [<비교 폴더>]');
const dir = resolve('out', name);
const rows = read(dir);
const cmp = cmpDir && existsSync(join(cmpDir, 'log.jsonl')) ? read(cmpDir) : null;
const W = 1200, PH = 150, L = 70, R = 20;
const T = rows[rows.length - 1]!.time;
const xs = (t: number) => L + ((W - L - R) * t) / T;
const panels: { title: string; series: { pts: [number, number][]; color: string }[] }[] = [
  { title: 'Spine2 앞뒤 기울기 (도, 회색 = 비교)', series: [...(cmp ? [{ pts: cmp.map((r) => [r.time, pitch(r.bodies.Spine2!.rot)] as [number, number]), color: '#aaa' }] : []), { pts: rows.map((r) => [r.time, pitch(r.bodies.Spine2!.rot)]), color: '#2e52a0' }] },
  { title: '호흡 파형 b (0 날숨 ~ 1 들숨)', series: [{ pts: rows.map((r) => [r.time, r.breath?.b ?? 0]), color: '#3c8a28' }] },
  { title: '호흡수 (회/분)', series: [{ pts: rows.map((r) => [r.time, (r.breath?.rate ?? 0) * 60]), color: '#c05000' }] },
  { title: '머리 안정: 목에서 되돌린 각 (도)', series: [{ pts: rows.map((r) => [r.time, r.behavior?.presence?.stabDeg ?? 0]), color: '#8030b0' }] },
  { title: '손가락 굽힘 (왼 파랑 · 오른 빨강, 0 편 손 ~ 1 주먹)', series: [{ pts: rows.map((r) => [r.time, r.fingers?.LeftHand?.curl ?? 0]), color: '#2e52a0' }, { pts: rows.map((r) => [r.time, r.fingers?.RightHand?.curl ?? 0]), color: '#c02020' }] },
];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${panels.length * (PH + 30) + 40}" font-family="Malgun Gothic, sans-serif"><rect width="100%" height="100%" fill="#fff"/>`;
svg += `<text x="10" y="22" font-size="18" font-weight="bold">${name} — 호흡·시선·손가락</text>`;
panels.forEach((p, i) => {
  const y0 = 40 + i * (PH + 30);
  const all = p.series.flatMap((s) => s.pts.map((q) => q[1]));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const ys = (v: number) => y0 + 20 + (PH - 20) * (1 - (v - lo) / (hi - lo));
  svg += `<text x="${L}" y="${y0 + 12}" font-size="13">${p.title}</text><rect x="${L}" y="${y0 + 20}" width="${W - L - R}" height="${PH - 20}" fill="none" stroke="#ccc"/>`;
  svg += `<text x="${L - 6}" y="${y0 + 26}" font-size="11" text-anchor="end">${hi.toFixed(1)}</text><text x="${L - 6}" y="${y0 + PH}" font-size="11" text-anchor="end">${lo.toFixed(1)}</text>`;
  for (const s of p.series) svg += `<polyline fill="none" stroke="${s.color}" stroke-width="1.5" points="${s.pts.map(([t, v]) => `${xs(t).toFixed(1)},${ys(v).toFixed(1)}`).join(' ')}"/>`;
  for (let t = 0; t <= T + 1e-9; t += 1) svg += `<text x="${xs(t)}" y="${y0 + PH + 13}" font-size="10" text-anchor="middle">${t}초</text>`;
});
svg += '</svg>';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: panels.length * (PH + 30) + 40 } });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${svg}</body></html>`);
const out = join(dir, 'presence.png');
writeFileSync(out, await page.screenshot({ fullPage: true }));
await browser.close();
console.log(out);
