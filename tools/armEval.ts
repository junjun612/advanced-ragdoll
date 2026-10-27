// 반응 사람다움 평가 (2026-10-27): 시나리오 × 근처 입력을 병렬로 돌려 통과·넘어짐·걸음과 팔 자연스러움 지표(tools/armMetrics.ts)를 사람 분포와 나란히 보인다.
// 사용법:
//   npx tsx tools/armEval.ts [--sweep N] [--jobs J] [--window 2.5] [--set preset] 시나리오... | --v04 | --focus
//   npx tsx tools/armEval.ts --human push_back_hard,push_back_veryhard ...   (Kimodo 밀림 조사 RP 후보 분포)
// 설정 덮어쓰기 SET="b.wb.armReflex.maxDeg=0;s.arms.stepGain=0;h.freeArm.abductDeg=0;a.walk.x=1;p.stand.joints.LeftArm.side=-20"
//   b = balance.json, s = stepping.json, h = behaviors.json, m = hitModel.json, a = animDriver.json, p = poses (config/poses)
// 근처 입력: 시드 1 = 원래 시나리오, 2~N = 세기 ±5%·방향 ±5° (simCommon.jitterScenario)
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findScenario, loadScenario, loadInputs, jitterScenario, addRefSimilarity } from './simCommon';
import { armStats, logToArmFrames, type ArmStats } from './armMetrics';
import type { CharacterDef } from '../src/sim/character/characterDef';
import { rotate, conjugate, multiplyQ } from '../src/sim/math/quat';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const WINDOW = Number(opt('--window', '2.5'));
const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;

export const FOCUS = ['push_back_medium', 'push_left_medium', 'push_front_medium', 'push_right_medium', 'push_diag_medium', 'shot_chest_stagger_clutch'];
const V04 = ['push_front_medium', 'push_back_medium', 'push_left_medium', 'push_right_medium', 'push_diag_medium', 'push_front_small', 'push_back_small', 'push_twice', 'push_while_stepping', 'push_left_crossstep'];

function cfgs(): Record<string, unknown> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const poses: Record<string, unknown> = {};
  for (const f of readdirSync('config/poses')) if (f.endsWith('.json')) poses[f.replace(/\.json$/, '')] = rd(join('config/poses', f));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), m: rd('config/hitModel.json'), a: rd('config/animDriver.json'), r: rd('config/reaction.json'), p: poses };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c;
}

/**
 * REACTLIB = 실험용 반응 클립 라이브러리: 쉼표로 나눈 assets/kimodo/<폴더> 또는 <폴더>/<후보> (glob '*' 끝 허용) → react_<폴더>_<후보> 이름의 애니 클립.
 * 없으면 정적 라이브러리(src/sim/character/reactionClips.generated.ts)만.
 */
function reactLib(): Record<string, never> | undefined {
  const spec = process.env.REACTLIB;
  if (!spec) return undefined;
  const out: Record<string, unknown> = {};
  const dirs = readdirSync('assets/kimodo');
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [d0, c0] = item.split('/');
    const re = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const d of dirs.filter((x) => re(d0!).test(x))) {
      const base = join('assets/kimodo', d);
      for (const c of readdirSync(base).filter((x) => re(c0 ?? 'rp12_s*').test(x))) {
        const p = join(base, c, 'clip.json');
        if (!existsSync(p)) continue;
        const f = JSON.parse(readFileSync(p, 'utf8'));
        out[`react_${d}_${c}`] = { ...f, name: `react_${d}_${c}` };
      }
    }
  }
  return out as Record<string, never>;
}

interface Row { name: string; seed: number; passed: boolean; fell: boolean; steps: number; rec: number | null; land: number | null; arm: ArmStats; refArm: number | null; fails: string; exploded?: boolean; romFrac?: number; romMax?: number }

/** (README 결정 171·177) 사람 어깨 가동 범위 후보 값 — ROM=1이면 이 값으로 끝 저항을 켠다. 넘은 각은 켜든 끄든 같은 식으로 잰다 (ragdoll.ts applyShoulderRom) */
const ROM_CFG = { behindDownDeg: Number(process.env.ROM_DOWN ?? 60), behindHorizDeg: Number(process.env.ROM_HORIZ ?? 45), behindUpDeg: 10, crossDeg: 45, stiffness: 600, damping: 15, maxTorque: 600 };
function romExcessDeg(f: { bodies: Record<string, { rot: number[] }> }): number {
  const qS = f.bodies.Spine2!.rot as [number, number, number, number];
  const s2r = def.bodies.find((b) => b.name === 'Spine2')!.restRotation;
  const qD = multiplyQ(qS, conjugate(s2r));
  let ex = 0;
  for (const n of ['LeftArm', 'RightArm'] as const) {
    const b = def.bodies.find((x) => x.name === n)!, pd = def.bodies.find((x) => x.name === b.parent)!;
    const ax = rotate(conjugate(b.restRotation), rotate(multiplyQ(pd.restRotation, b.joint!.frameInParent), [0, 1, 0]));
    const l = rotate(conjugate(qD), rotate(f.bodies[n]!.rot as [number, number, number, number], ax));
    const sx = n === 'LeftArm' ? 1 : -1, ly = Math.max(-1, Math.min(1, l[1]!)), R = ROM_CFG;
    const bmax = ly < 0 ? R.behindHorizDeg + (R.behindDownDeg - R.behindHorizDeg) * -ly : R.behindHorizDeg + (R.behindUpDeg - R.behindHorizDeg) * ly;
    const D = 180 / Math.PI;
    ex = Math.max(ex, Math.asin(Math.max(-1, Math.min(1, -l[2]!))) * D - bmax, Math.asin(Math.max(-1, Math.min(1, -sx * l[0]!))) * D - R.crossDeg);
  }
  return Math.max(0, ex);
}

async function worker(name: string, seed: number): Promise<Row> {
  const { runScenario } = await import('../src/sim/runner');
  const c = cfgs() as Record<string, never>;
  let sc = jitterScenario({ ...loadScenario(findScenario(name)), seed }, seed);
  // PUSHDUR=초: duration이 없는 밀기에 duration을 준다 (실험용)
  if (process.env.PUSHDUR) sc = { ...sc, events: sc.events.map((e) => (e.type === 'hit' && e.hit?.type === 'push' && !e.hit.duration ? { ...e, hit: { ...e.hit, duration: Number(process.env.PUSHDUR) } } : e)) };
  const inp = loadInputs(sc);
  if (process.env.ROM === '1') inp.ragdoll = { ...inp.ragdoll, shoulderRom: ROM_CFG };
  const r = await runScenario({ ...inp, characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, hitModelConfig: c.m, animConfig: c.a, poses: c.p, reactionConfig: c.r, animClips: reactLib() } });
  if (process.env.OUTDIR) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const d = join(process.env.OUTDIR, `${name}${seed > 1 ? `__s${seed}` : ''}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'log.jsonl'), r.log);
    writeFileSync(join(d, 'summary.json'), JSON.stringify(r.summary, null, 1));
    writeFileSync(join(d, 'meta.json'), JSON.stringify(r.meta, null, 1));
  }
  if (seed === 1) await addRefSimilarity(sc, r);
  const hitT = sc.events.find((e) => e.type === 'hit')?.t ?? 0;
  const s = r.summary;
  return {
    name, seed, passed: s.expectations.passed, fell: s.fell, steps: s.stepsTaken ?? 0, rec: s.recoveredAfterHit ?? null,
    land: (s.metrics.landingErrorMean as number | undefined) ?? null, arm: armStats(def, logToArmFrames(r.log), hitT, WINDOW),
    refArm: typeof s.metrics.refArmRatio === 'number' ? s.metrics.refArmRatio : null, fails: s.expectations.failures.join('; '),
    exploded: !!s.exploded, ...(() => { const fr = r.log.trim().split('\n').map((x) => JSON.parse(x)); const e = fr.map(romExcessDeg); return { romFrac: e.filter((x) => x > 5).length / Math.max(1, e.length), romMax: Math.max(0, ...e) }; })(),
  };
}

async function human(dirs: string[]): Promise<void> {
  const { refStates } = await import('./kimodo/refSimilarity');
  for (const d of dirs) {
    const base = join('assets/kimodo', d);
    if (!existsSync(base)) { console.log(`${d}: 없음`); continue; }
    const st: ArmStats[] = [];
    for (const s of readdirSync(base).filter((x) => x.startsWith('rp12_s')).sort()) {
      const p = join(base, s, 'clip.json');
      if (!existsSync(p)) continue;
      const clip = JSON.parse(readFileSync(p, 'utf8')) as { fps: number; info?: { pushFrame?: number } };
      const t0 = (clip.info?.pushFrame ?? 30) / clip.fps;
      const fr = refStates(p).map((x) => ({ t: x.time, rot: Object.fromEntries(Object.entries(x.bodies).map(([k, b]) => [k, b.rot])) }));
      const a = armStats(def, fr, t0, WINDOW);
      st.push(a);
      console.log(`  ${d}/${s}: ${fmtArm(a)}`);
    }
    console.log(`${d} 중앙값 (n=${st.length}): ${fmtArm(medArm(st))}`);
  }
}

const med = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };
const medArm = (a: ArmStats[]): ArmStats => ({ elevMean: med(a.map((x) => x.elevMean)), elevP90: med(a.map((x) => x.elevP90)), outFrac: med(a.map((x) => x.outFrac)), elbowMean: med(a.map((x) => x.elbowMean)), usage: med(a.map((x) => x.usage)), trunkPeak: med(a.map((x) => x.trunkPeak)), lateOut: a.reduce((p, x) => p + x.lateOut, 0) / Math.max(1, a.length) });
const fmtArm = (a: ArmStats) => `팔 들림 평균 ${a.elevMean.toFixed(0)}° p90 ${a.elevP90.toFixed(0)}° (>40° ${(a.outFrac * 100).toFixed(0)}%, 1초 뒤 ${(a.lateOut * 100).toFixed(0)}%) 팔꿈치 ${a.elbowMean.toFixed(0)}° 팔 사용 ${a.usage.toFixed(0)}°/s 몸통 최대 ${a.trunkPeak.toFixed(0)}°`;

/** --variants <json>: [{name, set}] 마다 같은 묶음을 돌린다 (SET 환경변수를 바꿔서). 한 줄 요약 */
async function variants(): Promise<void> {
  const vs = JSON.parse(readFileSync(opt('--variants', ''), 'utf8')) as { name: string; set: string }[];
  for (const v of vs) {
    process.env.SET = v.set;
    console.log(`\n=== ${v.name}  (${v.set})`);
    await master();
  }
}

async function master(): Promise<void> {
  const N = Number(opt('--sweep', '1'));
  const J = Number(opt('--jobs', '24'));
  const skip = new Set(['--sweep', '--jobs', '--window', '--variants', '--seed0']);
  const names = argv.filter((a, k) => !a.startsWith('--') && !skip.has(argv[k - 1] ?? ''));
  const list = argv.includes('--v04') ? [...V04, ...names] : argv.includes('--focus') ? [...FOCUS, ...names] : names;
  const s0 = Number(opt('--seed0', '1'));
  const jobs = list.flatMap((n) => Array.from({ length: N }, (_, k) => ({ n, seed: k + s0 })));
  const rows: Row[] = [];
  let next = 0;
  const run = (): Promise<void> => new Promise((res) => {
    const j = jobs[next++];
    if (!j) return res();
    const p = spawn(process.execPath, ['--import', 'tsx', 'tools/armEval.ts', '--worker', j.n, String(j.seed), '--window', String(WINDOW)], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('ROW '));
      if (line) rows.push(JSON.parse(line.slice(4)) as Row);
      else console.error(`실패 ${j.n} ${j.seed}: ${err.slice(-500)}`);
      void run().then(res);
    });
  });
  await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, run));
  let P = 0, F = 0, T = 0;
  for (const n of list) {
    const rs = rows.filter((r) => r.name === n).sort((a, b) => a.seed - b.seed);
    const p = rs.filter((r) => r.passed).length, f = rs.filter((r) => r.fell).length;
    P += p; F += f; T += rs.length;
    const r1 = rs.find((r) => r.seed === 1);
    const cells = rs.map((r) => (r.fell ? 'F' : r.passed ? 'P' : 'x') + r.steps).join(' ');
    const land = rs.map((r) => r.land).filter((x): x is number => x !== null);
    console.log(`${n.padEnd(28)} 통과 ${p}/${rs.length} 넘어짐 ${f}  [${cells}]  착지 ${land.length ? (land.reduce((a, b) => a + b, 0) / land.length * 100).toFixed(1) : '-'}cm  팔/사람(시드1) ${r1?.refArm?.toFixed(2) ?? '-'}`);
    console.log(`  중앙값 ${fmtArm(medArm(rs.map((r) => r.arm)))}${r1 && !r1.passed ? `  | 시드1 실패: ${r1.fails}` : ''}`);
  }
  const all = medArm(rows.map((r) => r.arm));
  console.log(`합계 통과 ${P}/${T} 넘어짐 ${F} | 전체 중앙값 ${fmtArm(all)}`);
  const ex = rows.filter((r) => r.exploded).length;
  const rf = rows.reduce((a, r) => a + (r.romFrac ?? 0), 0) / Math.max(1, rows.length);
  console.log(`폭발 ${ex} | 어깨 사람 범위 5° 넘은 프레임 평균 ${(rf * 100).toFixed(1)}% (실행 중 ${rows.filter((r) => (r.romFrac ?? 0) > 0).length}/${rows.length}), 넘은 각 최대 ${Math.max(0, ...rows.map((r) => r.romMax ?? 0)).toFixed(0)}°`);
}

if (argv[0] === '--worker') {
  worker(argv[1]!, Number(argv[2])).then((r) => { process.stdout.write('ROW ' + JSON.stringify(r) + '\n'); }).catch((e) => { console.error(e); process.exit(1); });
} else if (argv.includes('--human')) {
  void human(opt('--human', '').split(','));
} else if (argv.includes('--variants')) {
  void variants();
} else {
  void master();
}
