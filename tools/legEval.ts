// 다리 총탄 평가 (결정 leg-1~): 허벅지·정강이·발 × 앞·옆·뒤 × small·medium × 서서·걸으며 맞는 변형을 근처 입력 시드 묶음으로 돌려
// 넘어짐·폭발·쥐기·꿇음·HoldWound 판단(mode)을 표로 보인다. 시드 홀수 = 왼다리, 짝수 = 오른다리.
// 사용법: npx tsx tools/legEval.ts [--sweep 4] [--jobs 8] [--only thigh_back] [--mags small,medium,app] [--out out/legEval]   (LEG=Right면 다리 고정)
//   --out을 주면 시드 1 실행의 로그를 <out>/<변형>/에 남긴다 (npm run film -- --dir로 필름 가능)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInputs, jitterScenario } from './simCommon';
import hitScale from '../config/hitScale.json';
import appCfg from '../config/app.json';
import type { Scenario } from '../src/sim/scenario';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const PARTS = { thigh: 'UpLeg', shin: 'Leg', foot: 'Foot' } as const;
const SIDES = ['front', 'side', 'back'] as const;
const MAGS = ['small', 'medium'] as const;
/** 앱 기본 총탄 세기 (config/app.json bulletDv) — --mags app로 */
const APP_DV = appCfg.bulletDv;
const MODES = ['stand', 'walk'] as const;

export function legVariant(name: string, seed: number): Scenario {
  const [part, side, mag, mode] = name.split('_') as [keyof typeof PARTS, typeof SIDES[number], typeof MAGS[number] | 'app', typeof MODES[number]];
  const L = process.env.LEG ?? (seed % 2 === 1 ? 'Left' : 'Right');
  // 앞: −Z로 날아와 앞에서 들어감, 뒤: +Z, 옆: 그 다리 바깥쪽에서 (왼다리 +X 쪽 → −X 방향)
  const dir: [number, number, number] = side === 'front' ? [0, 0, -1] : side === 'back' ? [0, 0, 1] : [L === 'Left' ? -1 : 1, 0, 0];
  const walk = mode === 'walk';
  const sc = {
    name: `leg_${name}`, milestone: '0.5a', description: `다리 총탄 변형 ${name} (${L})`, duration: walk ? 7 : 5, seed: 1, terrain: 'flat', character: 'xbot',
    spawn: { position: [0, 0, 0], yaw: 0, state: walk ? 'Animated' : 'Active', pose: walk ? 'kimodo_walk_forward' : 'stand' },
    clip: walk ? null : 'stand', assist: { root: false },
    events: [
      ...(walk ? [{ t: 0.3, type: 'setState', state: 'Active' }] : []),
      { t: walk ? 3 : 1, type: 'hit', hit: { type: 'bullet', body: `${L}${PARTS[part]}`, direction: dir, magnitude: mag === 'app' ? APP_DV : (hitScale as Record<string, number>)[mag] } },
    ],
    cameras: ['side', 'front'], reference: null, expect: { exploded: false, fell: false },
  } as unknown as Scenario;
  return jitterScenario({ ...sc, seed }, seed);
}

interface Row { v: string; seed: number; fell: boolean; exploded: boolean; first: string | null; kneeled: boolean; clutch: boolean; mode: string; trunk: number; fallT: number | null }

async function worker(v: string, seed: number): Promise<void> {
  const { runScenario } = await import('../src/sim/runner');
  const sc = legVariant(v, seed);
  // 설정 덮어쓰기 SET="h.InjuredLeg.strengthCap=0.7;m.bullet.pointShare=0.2" (h = behaviors.json, m = hitModel.json, s = stepping.json, b = balance.json)
  const rd = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
  const c: Record<string, Record<string, unknown>> = { h: rd('config/behaviors.json'), m: rd('config/hitModel.json'), s: rd('config/stepping.json'), b: rd('config/balance.json') };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).split('.');
    let o = c[path[0]!]!;
    for (const k of path.slice(1, -1)) o = o[k] as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  const r = await runScenario({ ...loadInputs(sc), characterOpts: { behaviorsConfig: c.h as never, hitModelConfig: c.m as never, steppingConfig: c.s as never, balanceConfig: c.b as never } });
  const s = r.summary;
  const out = opt('--out', '');
  if (out && seed === 1) {
    const d = join(out, sc.name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'log.jsonl'), r.log);
    writeFileSync(join(d, 'summary.json'), JSON.stringify(s, null, 1));
    writeFileSync(join(d, 'meta.json'), JSON.stringify(r.meta, null, 1));
  }
  // HoldWound 판단: 마지막으로 보인 info.mode (없으면 hand/failed)
  let mode = '-';
  for (const l of r.log.trim().split('\n')) {
    const fr = JSON.parse(l) as { behavior?: { active?: { name: string; info?: Record<string, unknown> }[] } };
    const hw = fr.behavior?.active?.find((b) => b.name === 'HoldWound');
    if (hw?.info) mode = String(hw.info.mode ?? (hw.info.failed ? 'fail' : hw.info.hand ? 'hold' : '-'));
  }
  const m = s.metrics as Record<string, number>;
  const row: Row = { v, seed, fell: s.fell, exploded: !!s.exploded, first: s.firstGroundContact ?? null, kneeled: !!s.kneeled, clutch: (m.clutchReachTime ?? 99) < 99, mode, trunk: m.trunkTiltMaxAfterHit ?? 0, fallT: s.fallTime ?? null };
  console.log(`ROW ${JSON.stringify(row)}`);
}

async function master(): Promise<void> {
  const N = Number(opt('--sweep', '4'));
  const J = Math.min(8, Number(opt('--jobs', '8')));
  const only = opt('--only', '');
  const mags = opt('--mags', MAGS.join(',')).split(',');
  const vs = Object.keys(PARTS).flatMap((p) => SIDES.flatMap((s) => mags.flatMap((m) => MODES.map((md) => `${p}_${s}_${m}_${md}`)))).filter((v) => !only || only.split(',').some((o) => v.includes(o)));
  const jobs = vs.flatMap((v) => Array.from({ length: N }, (_, k) => ({ v, seed: k + 1 })));
  const rows: Row[] = [];
  let next = 0;
  const run = (): Promise<void> => new Promise((res) => {
    const j = jobs[next++];
    if (!j) return res();
    const args = ['--import', 'tsx', 'tools/legEval.ts', '--worker', j.v, String(j.seed)];
    if (opt('--out', '')) args.push('--out', opt('--out', ''));
    const p = spawn(process.execPath, args, { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('ROW '));
      if (line) rows.push(JSON.parse(line.slice(4)) as Row);
      else { console.error(`실패 ${j.v} ${j.seed}: ${err.slice(-800)}`); rows.push({ v: j.v, seed: j.seed, fell: true, exploded: true, first: 'CRASH', kneeled: false, clutch: false, mode: 'crash', trunk: 0, fallT: null }); }
      void run().then(res);
    });
  });
  await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, run));
  let F = 0, E = 0, C = 0, K = 0;
  console.log(`변형                       넘어짐 폭발 쥐기 꿇음  시드별(F=넘어짐 E=폭발 K=꿇음 c=쥐기 / 판단 / 첫 접촉 / 몸통 최대°)`);
  for (const v of vs) {
    const rs = rows.filter((r) => r.v === v).sort((a, b) => a.seed - b.seed);
    const f = rs.filter((r) => r.fell).length, e = rs.filter((r) => r.exploded).length, c = rs.filter((r) => r.clutch).length, k = rs.filter((r) => r.kneeled).length;
    F += f; E += e; C += c; K += k;
    const cells = rs.map((r) => `${r.fell ? 'F' : '.'}${r.exploded ? 'E' : ''}${r.kneeled ? 'K' : ''}${r.clutch ? 'c' : ''}/${r.mode}/${r.first ?? '-'}/${r.trunk.toFixed(0)}`);
    console.log(`${v.padEnd(26)} ${String(f).padStart(3)}/${rs.length} ${String(e).padStart(3)} ${String(c).padStart(4)} ${String(k).padStart(4)}  ${cells.join('  ')}`);
  }
  console.log(`합계: 넘어짐 ${F}/${rows.length}, 폭발 ${E}, 쥐기 ${C}, 꿇음 ${K}`);
}

if (argv[0] === '--worker') await worker(argv[1]!, Number(argv[2]));
else await master();
