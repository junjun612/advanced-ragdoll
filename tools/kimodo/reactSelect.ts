// 반응 클립 라이브러리 고르기·쓰기 (2026-10-27, README 결정 160~161).
// 사용법:
//   npx tsx tools/kimodo/reactSelect.ts rank                 칸(방향 × 세기)마다 시드별 지표·탈락 이유·전형성 순위 → out/react_lib/ranking.md
//   npx tsx tools/kimodo/reactSelect.ts write [--per 2]      칸마다 상위 per개 → assets/poses/reaction/*.json + src/sim/character/reactionClips.generated.ts
// 탈락: 몸통 최대 > maxTrunk°(넘어질 듯 숙임·젖힘), 팔 들림 p90 > maxElevP90°(팔을 크게 쳐듦), 끝 COM 속도 > maxEndSpeed(멈추지 않음), 기대 방향 위반.
// 전형성 = 칸 중앙값(팔 들림 평균·팔꿈치·팔 사용·몸통 최대)에서의 정규화 거리 + 0.1 × Kimodo 자동 점수. 사람다운 '보통' 반응을 고른다.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadDef } from './rig';
import { refStates } from './refSimilarity';
import { armStats, type ArmStats } from '../armMetrics';
import { REACT_DIRS, REACT_STR } from './reactLib';
import { toneStats } from '../toneDiag';

const argv0 = process.argv.slice(2);
const optS = (k: string, d: string) => { const i = argv0.indexOf(k); return i >= 0 ? argv0[i + 1]! : d; };
/** (결정 clip-*) --sets: 후보를 모을 프롬프트 묶음(reactLib REACT_SETS, '' = 원래), --maxTrunk·--maxNeck·--maxElevP90: 탈락 기준, --out: 쓸 폴더(기본 assets/poses/reaction, 아니면 .ts 생성 안 함) */
const SETS = optS('--sets', '').split(',');
const LIMITS = { maxTrunk: Number(optS('--maxTrunk', '35')), maxNeck: Number(optS('--maxNeck', '999')), maxElevP90: Number(optS('--maxElevP90', '55')), maxEndSpeed: 0.15 };
/** 팔 들림 p90이 25°를 넘는 10°마다 순위값 벌점 */
const ARM_PENALTY = 1.0;

interface Row { dir: string; str: string; set: string; neck: number; seed: number; path: string; arm: ArmStats; steps: number; endSpeed: number; total: number; expectPenalty: number; reject: string; typ: number }

function rows(): Row[] {
  const def = loadDef();
  const out: Row[] = [];
  for (const dir of Object.keys(REACT_DIRS)) for (const str of Object.keys(REACT_STR)) {
    const bin: Row[] = [];
    for (const set of SETS) {
    const base = join(ROOT, 'assets', 'kimodo', `react_${set ? set + '_' : ''}${dir}_${str}`);
    if (!existsSync(base)) continue;
    for (const c of readdirSync(base).filter((x) => x.startsWith('rp12_s')).sort()) {
      const p = join(base, c, 'clip.json');
      if (!existsSync(p)) continue;
      const clip = JSON.parse(readFileSync(p, 'utf8')) as { fps: number; info?: { pushFrame?: number } };
      const sc = JSON.parse(readFileSync(join(base, c, 'scores.json'), 'utf8')) as { total: number; terms: { expectPenalty?: number }; metrics: { steps?: number; endSpeed?: number } };
      const fr = refStates(p).map((x) => ({ t: x.time, rot: Object.fromEntries(Object.entries(x.bodies).map(([k, b]) => [k, b.rot])) }));
      const arm = armStats(def, fr, (clip.info?.pushFrame ?? 30) / clip.fps, 2.5);
      const endSpeed = sc.metrics.endSpeed ?? 0;
      const ep = sc.terms.expectPenalty ?? 0;
      const neck = toneStats(fr as never, (clip.info?.pushFrame ?? 30) / clip.fps, 2.5).g.neck!.peak;
      const reject = arm.trunkPeak > LIMITS.maxTrunk ? `몸통 ${arm.trunkPeak.toFixed(0)}°` : neck > LIMITS.maxNeck ? `목 ${neck.toFixed(0)}°` : arm.elevP90 > LIMITS.maxElevP90 ? `팔 p90 ${arm.elevP90.toFixed(0)}°` : endSpeed > LIMITS.maxEndSpeed ? `끝 속도 ${endSpeed.toFixed(2)}` : '';
      bin.push({ dir, str, set, neck, seed: Number(c.slice(6)), path: p, arm, steps: sc.metrics.steps ?? 0, endSpeed, total: sc.total, expectPenalty: ep, reject, typ: 0 });
    }
    }
    const med = (f: (r: Row) => number) => { const s = bin.map(f).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
    const keys: [(r: Row) => number, number][] = [[(r) => r.arm.elevMean, 8], [(r) => r.arm.elbowMean, 10], [(r) => r.arm.usage, 30], [(r) => r.arm.trunkPeak, 10]];
    const m = keys.map(([f]) => med(f));
    // + 팔 들림 벌점: 사람 클립 중에서도 팔이 몸 가까이 늘어진 쪽을 고른다 (사람 지시: 팔이 벌어져 계속 균형 잡는 듯한 모습이 어색함)
    for (const r of bin) r.typ = keys.reduce((s, [f, sc], i) => s + ((f(r) - m[i]!) / sc) ** 2, 0) + 0.1 * r.total + r.expectPenalty + ARM_PENALTY * Math.max(0, r.arm.elevP90 - 25) / 10;
    out.push(...bin);
  }
  return out;
}

function rank(): Row[] {
  const rs = rows();
  const lines = ['# 반응 클립 후보 순위 (tools/kimodo/reactSelect.ts)', '', `탈락: 몸통 최대 > ${LIMITS.maxTrunk}°, 목 > ${LIMITS.maxNeck}°, 팔 들림 p90 > ${LIMITS.maxElevP90}°, 끝 COM 속도 > ${LIMITS.maxEndSpeed} m/s. 순위 = 칸 중앙값에서의 거리(팔 들림·팔꿈치·팔 사용·몸통) + 0.1 × 자동 점수 + (팔 들림 p90 − 25°)/10 (팔이 몸 가까이 늘어진 클립 우선).`, '',
    '| 칸 | 묶음 | 시드 | 순위값 | 목 ° | 팔 들림 평균/p90 ° | 팔꿈치 ° | 팔 사용 °/s | 몸통 최대 ° | 걸음 | 끝 속도 | 자동 점수 | 탈락 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of [...rs].sort((a, b) => `${a.dir}${a.str}`.localeCompare(`${b.dir}${b.str}`) || (a.reject ? 1 : 0) - (b.reject ? 1 : 0) || a.typ - b.typ)) {
    lines.push(`| ${r.dir} ${r.str} | ${r.set || '원래'} | ${r.seed} | ${r.typ.toFixed(2)} | ${r.neck.toFixed(0)} | ${r.arm.elevMean.toFixed(0)}/${r.arm.elevP90.toFixed(0)} | ${r.arm.elbowMean.toFixed(0)} | ${r.arm.usage.toFixed(0)} | ${r.arm.trunkPeak.toFixed(0)} | ${r.steps} | ${r.endSpeed.toFixed(2)} | ${r.total.toFixed(2)} | ${r.reject} |`);
  }
  mkdirSync(join(ROOT, 'out', 'react_lib'), { recursive: true });
  writeFileSync(optS('--md', join(ROOT, 'out', 'react_lib', 'ranking.md')), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  return rs;
}

function write(per: number): void {
  const rs = rows();
  const outDir = optS('--out', '');
  const dir = outDir || join(ROOT, 'assets', 'poses', 'reaction');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const chosen: { name: string; file: string; r: Row }[] = [];
  const bins = new Map<string, Row[]>();
  for (const r of rs) { const k = `${r.dir}_${r.str}`; bins.set(k, [...(bins.get(k) ?? []), r]); }
  for (const [k, b] of [...bins.entries()].sort()) {
    const ok = b.filter((r) => !r.reject).sort((a, c) => a.typ - c.typ).slice(0, per);
    for (const r of ok) {
      const name = `react_${k}_${r.set ? r.set + '_' : ''}s${r.seed}`;
      const clip = JSON.parse(readFileSync(r.path, 'utf8')) as Record<string, unknown> & { info?: Record<string, unknown> };
      clip.name = name;
      clip.info = { ...(clip.info ?? {}), reactionFrom: 'stand', reactionDir: r.dir, reactionStrength: REACT_STR[r.str]!.dv, selected: `칸 ${k} ${r.set || '원래'} 순위값 ${r.typ.toFixed(2)} (팔 들림 ${r.arm.elevMean.toFixed(0)}°/${r.arm.elevP90.toFixed(0)}°, 몸통 ${r.arm.trunkPeak.toFixed(0)}°, ${r.steps}걸음)` };
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(clip));
      chosen.push({ name, file: `${name}.json`, r });
    }
    if (!ok.length) console.warn(`칸 ${k}: 통과 후보 없음`);
  }
  const ts = ['// 자동 생성 (npx tsx tools/kimodo/reactSelect.ts write). 고치지 말 것.',
    '// 반응 클립 라이브러리 (README 결정 160~161): assets/poses/reaction/*.json (sim은 파일 시스템을 쓰지 않으므로 정적 import). 이름 접두사 = config/reaction.json clipPrefix.',
    "import type { AnimClipFile } from './animDriver';",
    ...chosen.map((c, i) => `import c${i} from '../../../assets/poses/reaction/${c.file}';`),
    '',
    'export const REACTION_CLIPS: Readonly<Record<string, AnimClipFile>> = {',
    ...chosen.map((c, i) => `  ${c.name}: c${i} as unknown as AnimClipFile,`),
    '};', ''];
  if (!outDir) writeFileSync(join(ROOT, 'src', 'sim', 'character', 'reactionClips.generated.ts'), ts.join('\n'));
  console.log(`${chosen.length}개 → ${outDir || 'assets/poses/reaction/, src/sim/character/reactionClips.generated.ts'}`);
  for (const c of chosen) console.log(`  ${c.name}: ${c.r.typ.toFixed(2)} 목 ${c.r.neck.toFixed(0)} 팔 ${c.r.arm.elevMean.toFixed(0)}/${c.r.arm.elevP90.toFixed(0)} 몸통 ${c.r.arm.trunkPeak.toFixed(0)} 걸음 ${c.r.steps}`);
}

const argv = argv0;
if (argv[0] === 'write') { const i = argv.indexOf('--per'); write(i >= 0 ? Number(argv[i + 1]) : 2); } else rank();
