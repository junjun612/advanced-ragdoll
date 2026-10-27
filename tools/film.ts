// 필름스트립 생성기 (SPEC 8.3, 13장).
// 사용법: npm run film -- <name> [--camera side|front|top|follow] [--camera ...] [--fbx|--both] [--out <dir>]
// --fbx: 캡슐 대신 X Bot FBX 스킨(config/skin.json). --both: 시각마다 위 캡슐 + 아래 FBX 두 칸(같은 카메라).
// out/<name>/{log.jsonl, meta.json, summary.json}을 읽어 out/<name>/film.png (카메라가 여럿이면 film_<camera>.png도) 를 쓴다.
// 렌더는 Playwright Chromium(헤드리스, SwiftShader WebGL)에서 src/render를 그대로 돌린다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { FilmInput, FilmVariant } from '../src/render/filmstrip';
import { otherColors } from '../src/render/others';
import type { PropFrameLite } from '../src/render/stateTypes';
import type { SkinConfig } from '../src/render/skin';
import type { FilmConfig } from '../src/render/scene';
import {
  CAMERA_KINDS, type CameraKind, type CharacterDef, type CharacterStateLite, type FilmMeta, type FilmSummary,
} from '../src/render/stateTypes';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Args { name: string; cameras: CameraKind[]; outDir: string | null; variant: FilmVariant; compare: string | null; from: number | null; to: number | null; interval: number | null; suffix: string }

function parseArgs(argv: string[]): Args {
  let name = '';
  const cameras: CameraKind[] = [];
  let outDir: string | null = null;
  let variant: FilmVariant = 'capsule';
  let compare: string | null = null;
  let from: number | null = null, to: number | null = null, interval: number | null = null, suffix = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--camera' || a.startsWith('--camera=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i] ?? '';
      for (const c of v.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!CAMERA_KINDS.includes(c as CameraKind)) throw new Error(`알 수 없는 카메라: ${c} (side|front|top|follow)`);
        if (!cameras.includes(c as CameraKind)) cameras.push(c as CameraKind);
      }
    } else if (a === '--fbx' || a === '--both') {
      variant = a === '--fbx' ? 'fbx' : 'both';
    } else if (a === '--compare') {
      compare = argv[++i] ?? null;
    } else if (a === '--from') {
      from = Number(argv[++i]);
    } else if (a === '--to') {
      to = Number(argv[++i]);
    } else if (a === '--interval') {
      interval = Number(argv[++i]);
    } else if (a === '--suffix') {
      suffix = argv[++i] ?? '';
    } else if (a === '--out') {
      outDir = argv[++i] ?? null;
    } else if (a.startsWith('--')) {
      throw new Error(`알 수 없는 옵션: ${a}`);
    } else if (!name) {
      name = a;
    }
  }
  if (!name) throw new Error('사용법: npm run film -- <name> [--camera side|front|top|follow] [--fbx|--both] [--compare <레퍼런스 클립 경로>]');
  return { name, cameras, outDir, variant, compare, from, to, interval, suffix };
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function loadCharacter(meta: FilmMeta & { characterConfig?: unknown }): CharacterDef {
  const cc = meta.characterConfig as unknown;
  if (cc && typeof cc === 'object' && 'bodies' in (cc as object)) return cc as CharacterDef;
  if (typeof cc === 'string') {
    const p = resolve(root, cc);
    if (existsSync(p)) return readJson<CharacterDef>(p);
  }
  return readJson<CharacterDef>(join(root, 'config', 'characters', `${meta.characterId ?? 'xbot'}.json`));
}

/** frameInterval 간격 시각마다 가장 가까운 로그 프레임을 고른다. */
function pickFrames(states: CharacterStateLite[], interval: number, duration: number, from = 0): { frames: CharacterStateLite[]; times: number[] } {
  const frames: CharacterStateLite[] = [], times: number[] = [];
  const n = Math.floor((duration - from) / interval + 1e-6);
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const t = Math.round((from + k * interval) * 1e6) / 1e6;
    while (j + 1 < states.length && Math.abs(states[j + 1]!.time - t) <= Math.abs(states[j]!.time - t)) j++;
    frames.push(states[j]!);
    times.push(t);
  }
  return { frames, times };
}

async function bundlePage(): Promise<string> {
  const res = await build({
    entryPoints: [join(root, 'tools', 'film', 'page.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, logLevel: 'error',
  });
  return res.outputFiles[0]!.text;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(root, 'out', args.name);
  const outDir = args.outDir ? resolve(args.outDir) : dir;
  const metaPath = join(dir, 'meta.json'), logPath = join(dir, 'log.jsonl');
  if (!existsSync(logPath)) throw new Error(`${logPath} 없음. 먼저 npm run sim -- ${args.name}`);

  const meta: FilmMeta = existsSync(metaPath) ? readJson<FilmMeta>(metaPath) : { scenario: args.name };
  meta.scenario ??= args.name;
  const summaryPath = join(dir, 'summary.json');
  const summary = existsSync(summaryPath) ? readJson<FilmSummary>(summaryPath) : null;
  const states = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CharacterStateLite);
  if (!states.length) throw new Error(`${logPath}가 비어 있음`);
  states.sort((a, b) => a.time - b.time);

  const cfg = readJson<FilmConfig>(join(root, 'config', 'film.json'));
  const def = loadCharacter(meta);
  const duration = args.to ?? meta.duration ?? states[states.length - 1]!.time;
  const { frames, times } = pickFrames(states, args.interval ?? cfg.frameInterval, duration, args.from ?? 0);
  if (args.interval) cfg.frameInterval = args.interval;
  // (v0.8c) 다른 캐릭터 로그·프롭 로그: 같은 시각 칸으로 맞춘다
  const near = <T extends { time: number }>(list: T[], t: number): T | null => {
    if (!list.length) return null;
    let b = list[0]!;
    for (const s of list) if (Math.abs(s.time - t) < Math.abs(b.time - t)) b = s;
    return b;
  };
  const others: NonNullable<FilmInput['others']> = [];
  for (const c of (meta.characters ?? []).slice(1)) {
    const lp = join(dir, c.log);
    if (!existsSync(lp)) throw new Error(`${lp} 없음`);
    const st = readFileSync(lp, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CharacterStateLite);
    const cdef = c.characterConfig && existsSync(resolve(root, c.characterConfig)) ? readJson<CharacterDef>(resolve(root, c.characterConfig)) : def;
    others.push({ name: c.name, def: cdef, frames: frames.map((f) => near(st, f.time)) });
  }
  let props: FilmInput['props'];
  if (meta.props?.length && meta.propsLog && existsSync(join(dir, meta.propsLog))) {
    const pf = readFileSync(join(dir, meta.propsLog), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as PropFrameLite);
    props = { meta: meta.props, frames: frames.map((f) => near(pf, f.time)?.props ?? null) };
  }
  const metaCams = (meta.cameras ?? []).filter((c): c is CameraKind => CAMERA_KINDS.includes(c as CameraKind));
  const cameras: CameraKind[] = args.cameras.length ? args.cameras : metaCams.length ? metaCams : ['side'];

  // --compare: 레퍼런스 클립을 우리 랙돌로 FK → 밀림 시작(수평 COM 가속도 피크)을 sim 충격 시각에 맞추고, 그 순간 COM 수평 위치를 맞춘다
  let cmp: FilmInput['compare'] | null = null;
  if (args.compare === 'anim') {
    // (v0.6) 애니 클립 기준 자세(로그 anim.bodies, 앵커 적용)를 고스트로 — 클립 추종 비교
    const clip = frames.find((f) => f.anim)?.anim?.clip ?? '?';
    cmp = { name: clip, label: `회색 = Kimodo 클립 기준 (${clip}, 앵커 = 디딘 발)`, frames: frames.map((f) => (f.anim ? { ...f, bodies: f.anim.bodies } : null)) };
  } else if (args.compare) {
    const { refStates, toFrames, resample, detectOnset } = await import('./kimodo/refSimilarity');
    const { resolveClipPath } = await import('./kimodo/clipToLog');
    const clipPath = resolveClipPath(args.compare);
    const ref = refStates(clipPath) as unknown as CharacterStateLite[];
    const fr = resample(toFrames(ref as never));
    // 밀림 시작: 클립에 경로 제약으로 밀린 프레임(info.pushFrame)이 있으면 그것, 없으면 수평 COM 가속도 피크 (refSimilarity와 같은 규칙)
    const pf = (JSON.parse(readFileSync(clipPath, 'utf8')) as { info?: { pushFrame?: number } }).info?.pushFrame;
    const onsetT = typeof pf === 'number' ? fr[Math.min(fr.length - 1, pf)]!.t : fr[detectOnset(fr)]!.t;
    const hitT = (meta.events ?? []).find((e) => e.type === 'hit')?.t ?? 0;
    const at = (list: CharacterStateLite[], t: number) => list.reduce((b, s) => (Math.abs(s.time - t) < Math.abs(b.time - t) ? s : b), list[0]!);
    const simHit = at(states, hitT), refOn = at(ref, onsetT);
    const dx = simHit.com[0] - refOn.com[0], dz = simHit.com[2] - refOn.com[2];
    const shift = (s: CharacterStateLite): CharacterStateLite => ({
      ...s,
      com: [s.com[0] + dx, s.com[1], s.com[2] + dz],
      bodies: Object.fromEntries(Object.entries(s.bodies).map(([k, b]) => [k, { ...b, pos: [b.pos[0] + dx, b.pos[1], b.pos[2] + dz] }])),
    });
    const tEnd = ref[ref.length - 1]!.time;
    cmp = { name: args.compare.replace(/^.*assets[\/]kimodo[\/]/, '').replace(/[\/]clip\.json$/, ''), frames: times.map((t) => { const rt = t - hitT + onsetT; return rt < 0 || rt > tEnd ? null : shift(at(ref, rt)); }) };
    console.log(`레퍼런스 ${args.compare}: 밀림 시작 ${onsetT.toFixed(2)}초 ↔ sim 충격 ${hitT.toFixed(2)}초`);
  }

  const script = await bundlePage();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.setContent('<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: script });
    // 한글 폰트가 캔버스에 쓰이기 전에 로드되도록 한다
    await page.evaluate(async (font) => { await document.fonts.load(`14px ${font}`, '가나다'); }, cfg.font);
    if (args.variant !== 'capsule') {
      const skinCfg = readJson<SkinConfig>(join(root, 'config', 'skin.json'));
      const b64 = readFileSync(resolve(root, skinCfg.fbx)).toString('base64');
      await page.evaluate(
        ([b, d, c]) => (globalThis as unknown as { loadSkin: (b: string, d: CharacterDef, c: SkinConfig) => void }).loadSkin(b, d, c),
        [b64, def, skinCfg] as const,
      );
      for (const [k, o] of others.entries()) {
        const col = otherColors(cfg, k).skin;
        const sc2: SkinConfig = col ? { ...skinCfg, color: { surface: col, joints: skinCfg.color?.joints ?? [0.22, 0.24, 0.3] } } : skinCfg;
        await page.evaluate(
          ([b, d, c]) => (globalThis as unknown as { loadSkin: (b: string, d: CharacterDef, c: SkinConfig, extra: boolean) => void }).loadSkin(b, d, c, true),
          [b64, o.def ?? def, sc2] as const,
        );
      }
    }

    const written: string[] = [];
    for (const [i, camera] of cameras.entries()) {
      const input: FilmInput = { def, cfg, meta, summary, frames, frameTimes: times, camera, variant: args.variant, compare: cmp ?? undefined,
        ...(others.length ? { others, primaryName: meta.characters?.[0]?.name } : {}), ...(props ? { props } : {}) };
      const dataUrl = await page.evaluate(
        (inp) => (globalThis as unknown as { renderFilm: (x: FilmInput) => string }).renderFilm(inp),
        input,
      );
      if (pageErrors.length) throw new Error(`페이지 오류:\n${pageErrors.join('\n')}`);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      // 캡슐 기본 출력(film.png)은 덮어쓰지 않도록 변형은 접미사를 붙인다: film_fbx.png, film_both_front.png
      const sfx = (args.variant === 'capsule' ? '' : `_${args.variant}`) + (cmp ? '_cmp' : '') + (args.suffix ? `_${args.suffix}` : '');
      const targets = cameras.length > 1 ? [join(outDir, `film${sfx}_${camera}.png`)] : [];
      if (i === 0) targets.unshift(join(outDir, `film${sfx}.png`));
      for (const t of targets) { writeFileSync(t, png); written.push(t); }
    }
    console.log(`프레임 ${frames.length}개 (${cfg.frameInterval}초 간격), 카메라 ${cameras.join(', ')}, 표시 ${args.variant}`);
    for (const w of written) console.log(w);
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
