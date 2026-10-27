// 하이라이트 영상 생성기. config/reel.json의 장면들을 로그 프레임 하나도 빼지 않고 FBX로 다시 그려 GIF·MP4로 묶는다.
// 사용법: npx tsx tools/reel.ts [--out out/reel] [--config config/reel.json]   (각 장면은 먼저 npm run sim -- <scenario>)
//         npx tsx tools/reel.ts --hstack <왼쪽 out 폴더> <오른쪽 out 폴더> --out <폴더>   (두 영상 프레임을 나란히 → 비교 GIF·MP4, 프레임 수가 같아야 함)
// 장면 dir: 로그 폴더(기본 out/<scenario>) — 이전·이후 비교 영상용
// 프레임 PNG는 out/reel/frames/, 결과는 out/reel/highlights.gif, highlights.mp4. 인코딩은 ffmpeg(PATH)를 쓴다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { FilmConfig } from '../src/render/scene';
import type { SkinConfig } from '../src/render/skin';
import type { CameraKind, CharacterDef, CharacterStateLite, FilmMeta, PropFrameLite } from '../src/render/stateTypes';
import type { ReelFrame } from './reel/page';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

interface Scene { scenario: string; from: number; to: number; camera: CameraKind; tag: string; caption: string; dir?: string }
interface ReelConfig { width: number; height: number; fps: number; titleSec: number; smoothCamera: number; scenes: Scene[] }

const IMPACT_KO: Record<string, string> = { push: '밀기', bullet: '총탄', melee: '타격', explosion: '폭발' };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--out');
  const outDir = resolve(root, oi >= 0 ? argv[oi + 1]! : 'out/reel');
  const framesDir = join(outDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  // --config <경로>: 다른 장면 목록 (예: config/reel_08c.json)
  const ci = argv.indexOf('--config');
  const hi = argv.indexOf('--hstack');
  if (hi >= 0) {
    const a = resolve(root, argv[hi + 1]!, 'frames', '%05d.png'), b = resolve(root, argv[hi + 2]!, 'frames', '%05d.png');
    mkdirSync(outDir, { recursive: true });
    const fps = readJson<ReelConfig>(join(root, 'config', 'reel.json')).fps;
    const gif2 = join(outDir, 'compare.gif'), mp42 = join(outDir, 'compare.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', a, '-framerate', String(fps), '-i', b, '-filter_complex', '[0][1]hstack=inputs=2,split[x][y];[x]palettegen=max_colors=160:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif2]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', a, '-framerate', String(fps), '-i', b, '-filter_complex', '[0][1]hstack=inputs=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp42]);
    console.log(gif2);
    console.log(mp42);
    return;
  }
  const rc = readJson<ReelConfig>(ci >= 0 ? resolve(root, argv[ci + 1]!) : join(root, 'config', 'reel.json'));
  const film = readJson<FilmConfig>(join(root, 'config', 'film.json'));
  const skinCfg = readJson<SkinConfig>(join(root, 'config', 'skin.json'));
  const def = readJson<CharacterDef>(join(root, 'config', 'characters', 'xbot.json'));

  // 장면별 프레임 목록: 로그 프레임을 fps 간격으로 (30Hz 로그 + fps 30이면 전부)
  const frames: ReelFrame[] = [];
  for (const sc of rc.scenes) {
    const dir = sc.dir ? resolve(root, sc.dir) : join(root, 'out', sc.scenario);
    const logPath = join(dir, 'log.jsonl');
    if (!existsSync(logPath)) throw new Error(`${logPath} 없음. 먼저 npm run sim -- ${sc.scenario}`);
    const meta = readJson<FilmMeta>(join(dir, 'meta.json'));
    const states = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CharacterStateLite)
      .sort((a, b) => a.time - b.time);
    // (v0.8c) 다른 캐릭터·프롭 로그
    const readLog = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
    const otherLogs = (meta.characters ?? []).slice(1).map((c) => ({ name: c.name, states: readLog<CharacterStateLite>(join(dir, c.log)) }));
    const propFrames = meta.propsLog && existsSync(join(dir, meta.propsLog)) ? readLog<PropFrameLite>(join(dir, meta.propsLog)) : [];
    const nearest = <T extends { time: number }>(list: T[], t: number): T | null => list.length ? list.reduce((b, x) => (Math.abs(x.time - t) < Math.abs(b.time - t) ? x : b), list[0]!) : null;
    const primary = meta.characters?.[0]?.name;
    const hits = (meta.events ?? []).filter((e) => e.type === 'hit' && (!primary || !e.char || e.char === primary)) as { t: number; detail?: string; type: string }[];
    let camCom: [number, number, number] | null = null;
    let j = 0;
    const n = Math.floor((sc.to - sc.from) * rc.fps + 1e-6);
    for (let k = 0; k <= n; k++) {
      const t = sc.from + k / rc.fps;
      while (j + 1 < states.length && Math.abs(states[j + 1]!.time - t) <= Math.abs(states[j]!.time - t)) j++;
      const s = states[j]!;
      const c = s.com as [number, number, number];
      camCom = camCom ? [camCom[0] + (c[0] - camCom[0]) * rc.smoothCamera, camCom[1] + (c[1] - camCom[1]) * rc.smoothCamera, camCom[2] + (c[2] - camCom[2]) * rc.smoothCamera] : [...c];
      const hit = hits.find((h) => t >= h.t && t - h.t < film.impactShowSec + 0.2);
      const el = t - sc.from;
      const titleAlpha = rc.titleSec <= 0 ? 0 : el < rc.titleSec ? 1 : el < rc.titleSec + 0.4 ? 1 - (el - rc.titleSec) / 0.4 : 0;
      frames.push({
        state: s, camera: sc.camera, camCom: [...camCom], terrain: meta.terrain, tag: sc.tag, caption: sc.caption, t: s.time,
        titleAlpha, impact: hit ? `충격! ${IMPACT_KO[hit.detail ?? ''] ?? ''}`.trim() : '', index: 0, total: 0,
        ...(otherLogs.length ? { others: otherLogs.map((o) => ({ name: o.name, state: nearest(o.states, s.time) })), primaryName: primary } : {}),
        ...(meta.props?.length ? { sceneKey: `${sc.scenario}@${sc.from}`, propsMeta: meta.props, props: nearest(propFrames, s.time)?.props ?? null } : { sceneKey: `${sc.scenario}@${sc.from}` }),
      });
    }
  }
  frames.forEach((f, i) => { f.index = i + 1; f.total = frames.length; });

  const script = (await build({
    entryPoints: [join(root, 'tools', 'reel', 'page.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'error',
  })).outputFiles[0]!.text;
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: script });
    await page.evaluate(async (font) => { await document.fonts.load(`14px ${font}`, '가나다'); }, film.font);
    const b64 = readFileSync(resolve(root, skinCfg.fbx)).toString('base64');
    await page.evaluate(([b, d, s, f, w, h]) => (globalThis as unknown as { initReel: (...a: unknown[]) => void }).initReel(b, d, s, f, w, h),
      [b64, def, skinCfg, film, rc.width, rc.height] as const);
    for (const [i, f] of frames.entries()) {
      const url = await page.evaluate((x) => (globalThis as unknown as { renderReelFrame: (x: ReelFrame) => string }).renderReelFrame(x), f);
      if (errs.length) throw new Error(`페이지 오류:\n${errs.join('\n')}`);
      writeFileSync(join(framesDir, `${String(i).padStart(5, '0')}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      if (i % 100 === 0) console.log(`프레임 ${i}/${frames.length}`);
    }
  } finally {
    await browser.close();
  }

  const pattern = join(framesDir, '%05d.png');
  const gif = join(outDir, 'highlights.gif'), mp4 = join(outDir, 'highlights.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(rc.fps), '-i', pattern,
    '-vf', 'split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(rc.fps), '-i', pattern,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
  console.log(`프레임 ${frames.length}개 (${(frames.length / rc.fps).toFixed(1)}초, ${rc.fps}fps)`);
  console.log(gif);
  console.log(mp4);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
