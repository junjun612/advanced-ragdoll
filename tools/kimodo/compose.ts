// 필름스트립 여러 장을 한 장으로 (한글 라벨). 렌더는 Playwright Chromium 캔버스 (film.ts와 같은 방식).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ROOT, readJson } from './rig';

/**
 * png = film.ts 필름스트립. cells를 주면 그 칸 번호만 잘라 한 줄로 붙인다 (칸 배치는 config/film.json: 머리말 headerHeight,
 * 칸 cellSize, 한 줄 columns개, 칸 높이 = cellSize × cellRows(--both면 2)).
 */
export interface ComposeItem { png: string; label: string; sub?: string; cells?: number[]; cellRows?: number }

export async function composeImages(items: ComposeItem[], out: string, o: { title: string; scale: number; note?: string }): Promise<void> {
  const film = readJson<{ font: string; cellSize: number; columns: number; headerHeight: number }>(join(ROOT, 'config', 'film.json'));
  const font = film.font;
  const data = items.map((it) => ({ ...it, url: `data:image/png;base64,${readFileSync(it.png).toString('base64')}` }));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>');
    // tsx(esbuild keepNames)가 함수 안 화살표 함수에 __name(...)을 넣는다. 페이지에는 없으므로 항등 함수로 둔다
    await page.evaluate('globalThis.__name = (f) => f');
    await page.evaluate(async (f) => { await document.fonts.load(`14px ${f}`, '가나다'); }, font);
    const url = await page.evaluate(async ({ data, title, scale, note, font, film }) => {
      const imgs = await Promise.all(data.map((d) => new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = d.url;
      })));
      const labelH = 44, titleH = note ? 64 : 44, gap = 10;
      const cs = film.cellSize;
      const size = (i: number): [number, number] => {
        const d = data[i]!, im = imgs[i]!;
        return d.cells ? [Math.round(d.cells.length * cs * scale), Math.round(cs * (d.cellRows ?? 1) * scale)] : [Math.round(im.width * scale), Math.round(im.height * scale)];
      };
      const W = Math.max(...imgs.map((_, i) => size(i)[0]));
      const H = titleH + imgs.reduce((s, _, i) => s + labelH + size(i)[1] + gap, 0);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#101010'; ctx.font = `bold 22px ${font}`; ctx.fillText(title, 12, 22);
      if (note) { ctx.fillStyle = '#404040'; ctx.font = `15px ${font}`; ctx.fillText(note, 12, 50); }
      let y = titleH;
      imgs.forEach((im, i) => {
        const d = data[i]!;
        ctx.fillStyle = i === 0 ? '#1d3f8a' : '#3a3a3a';
        ctx.fillRect(0, y, W, labelH - 4);
        ctx.fillStyle = '#ffffff'; ctx.font = `bold 20px ${font}`;
        ctx.fillText(d.label, 12, y + (labelH - 4) / 2);
        if (d.sub) {
          const lw = ctx.measureText(d.label).width;
          ctx.font = `15px ${font}`; ctx.fillText(d.sub, 12 + lw + 18, y + (labelH - 4) / 2);
        }
        y += labelH;
        const [w, h] = size(i);
        if (d.cells) {
          const ch = cs * (d.cellRows ?? 1);
          d.cells.forEach((k, j) => {
            const sx = (k % film.columns) * cs, sy = film.headerHeight + Math.floor(k / film.columns) * ch;
            ctx.drawImage(im, sx, sy, cs, ch, Math.round(j * cs * scale), y, Math.round(cs * scale), Math.round(ch * scale));
          });
        } else ctx.drawImage(im, 0, y, w, h);
        y += h + gap;
      });
      return c.toDataURL('image/png');
    }, { data, title: o.title, scale: o.scale, note: o.note, font, film });
    writeFileSync(out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  } finally {
    await browser.close();
  }
}
