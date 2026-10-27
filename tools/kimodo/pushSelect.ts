// 밀림 레퍼런스 선택: 같은 크기의 밀림(기본 '살짝 세게' 15cm/0.4초)에서 "제자리 버팀"과 "한두 걸음 내딛어 버팀" 후보를 나란히 본다.
// 사용법: npx tsx tools/kimodo/pushSelect.ts [--strength medium]               → 방향마다 비교 이미지 (assets/kimodo/push_study/select_<dir>.png)
//         npx tsx tools/kimodo/pushSelect.ts --pick <dir> <hold|step> <model>:<seed> --reason "..."  → assets/poses/kimodo_push_{hold,recover}_<dir>.json
// 후보 = pushStudy summary.json에서 방향 맞음 + 걸음 수 조건(제자리 0, 내딛기 1~2), 자동 점수순 상위 3.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadKimodoConfig, readJson } from './rig';
import { candidateDir } from './client';
import { candLabel, filmName } from './candidates';
import { filmClip } from './clipToLog';
import { composeImages } from './compose';
import { DIRS, STRENGTHS, type Reaction } from './pushStudy';
import type { PoseClipFile } from './toPoseClip';

interface Row { dir: keyof typeof DIRS; strength: keyof typeof STRENGTHS; model: string; seed: number; total: number; r: Reaction }

const cfg = loadKimodoConfig();
const rows = readJson<Row[]>(join(ROOT, 'assets', 'kimodo', 'push_study', 'summary.json'));
const argv = process.argv.slice(2);
const forced = argv.includes('--strength') ? (argv[argv.indexOf('--strength') + 1] as keyof typeof STRENGTHS) : null;
/** 방향마다 제자리·내딛기 후보가 둘 다 있는 세기 (보통 10cm 우선, 없으면 살짝 세게 15cm, 가볍게 6cm) */
function strengthFor(dir: keyof typeof DIRS): keyof typeof STRENGTHS {
  if (forced) return forced;
  for (const st of ['mild', 'medium', 'light'] as const) {
    const ok = rows.filter((x) => x.dir === dir && x.strength === st && x.r.directionOk && !x.r.anticipatory && !x.r.fell);
    if (ok.some((x) => x.r.steps === 0) && ok.some((x) => x.r.steps >= 1 && x.r.steps <= 2)) return st;
  }
  return 'mild';
}

const kind = { hold: { kor: '제자리 버팀', ok: (r: Reaction) => r.steps === 0 && !r.fell && !r.anticipatory, out: 'push_hold' }, step: { kor: '한두 걸음 내딛어 버팀', ok: (r: Reaction) => r.steps >= 1 && r.steps <= 2 && !r.fell && !r.anticipatory, out: 'push_recover' } };

function pick(dir: keyof typeof DIRS, k: keyof typeof kind): Row[] {
  const strength = strengthFor(dir);
  return rows.filter((x) => x.dir === dir && x.strength === strength && x.r.directionOk && kind[k].ok(x.r)).sort((a, b) => a.total - b.total);
}

async function compare(): Promise<void> {
  for (const dir of Object.keys(DIRS) as (keyof typeof DIRS)[]) {
    const strength = strengthFor(dir);
    const clip = `push_${dir}_${strength}`;
    const items = [];
    for (const k of ['hold', 'step'] as const) {
      for (const [i, x] of pick(dir, k).slice(0, 3).entries()) {
        const c = { model: x.model, seed: x.seed };
        const png = join(ROOT, 'out', filmName(clip, c), 'film_fbx.png');
        if (!existsSync(png.replace('film_fbx.png', 'film_fbx_front.png'))) {
          filmClip(join(candidateDir(clip, x.model, x.seed), 'clip.json'), {
            name: filmName(clip, c), filmArgs: ['--fbx', '--camera', DIRS[dir].camera, '--camera', DIRS[dir].camera === 'side' ? 'front' : 'side'],
            title: `${DIRS[dir].kor} ${STRENGTHS[strength].kor} 밀림 · ${candLabel(cfg, c)} · ${x.r.steps === 0 ? '제자리' : `${x.r.steps}걸음`}`,
          });
        }
        items.push({
          png, label: `${kind[k].kor} ${i + 1} · ${candLabel(cfg, c)}`,
          sub: `${x.r.steps}걸음 · Δv ${x.r.dvMS.toFixed(2)}m/s · COM 이동 ${x.r.peakDispCm.toFixed(0)}cm · 몸통 ${x.r.trunkTiltDeg.toFixed(0)}° · 팔 ${x.r.armDegS.toFixed(0)}°/s · 회복 ${x.r.recoveryS?.toFixed(1) ?? '-'}초 · 점수 ${x.total.toFixed(2)}`,
          // 밀림(1.0초) 전후 0.8~3.5초를 10칸
          cells: Array.from({ length: 10 }, (_, j) => 8 + Math.round((j * 27) / 9)),
        });
      }
    }
    const out = join(ROOT, 'assets', 'kimodo', 'push_study', `select_${dir}.png`);
    await composeImages(items, out, {
      title: `${DIRS[dir].kor} ${STRENGTHS[strength].kor} 밀림 (Hips ${Math.round(STRENGTHS[strength].dispM * 100)}cm/0.4초) — 제자리 vs 내딛기 후보`,
      scale: 0.75, note: '칸: 0.8~3.5초 (밀림 1.0초) · 위 = 제자리 후보, 아래 = 한두 걸음 후보 · 자동 점수순 · 같은 밀림 크기',
    });
    console.log(out);
  }
}

function select(dir: keyof typeof DIRS, k: keyof typeof kind, ms: string, reason: string): void {
  const [model, seed] = ms.split(':');
  const strength = strengthFor(dir);
  const clip = `push_${dir}_${strength}`;
  const src = readJson<PoseClipFile>(join(candidateDir(clip, model!, Number(seed)), 'clip.json'));
  const row = rows.find((x) => x.dir === dir && x.strength === strength && x.model === model && x.seed === Number(seed));
  const name = `kimodo_${kind[k].out}_${dir}`;
  src.name = name;
  src.info = { ...src.info, reaction: row?.r, chosen: { reason, strength, date: new Date().toISOString().slice(0, 10) } };
  mkdirSync(join(ROOT, 'assets', 'poses'), { recursive: true });
  const dst = join(ROOT, 'assets', 'poses', `${name}.json`);
  writeFileSync(dst, JSON.stringify(src));
  console.log(dst);
}

if (argv.includes('--pick')) {
  const i = argv.indexOf('--pick');
  const reason = argv.includes('--reason') ? argv[argv.indexOf('--reason') + 1]! : '';
  select(argv[i + 1] as keyof typeof DIRS, argv[i + 2] as keyof typeof kind, argv[i + 3]!, reason);
} else {
  compare().catch((e: unknown) => { console.error(e); process.exit(1); });
}
