// 충격 시각 민감도 (2026-10-27, README 결정 163): 시나리오의 모든 충격 시각을 물리 스텝 k개(−K..K)만큼 옮겨 돌리고 결과의 흩어짐을 본다.
// 사람 반응은 충격 시각이 몇 ms 달라도 비슷해야 한다 — 결과가 크게 갈리면(넘어짐↔버팀, 걸음 수) 제어가 혼돈적이다.
// 사용법: npx tsx tools/shiftVariance.ts [--k 6] [--jobs 24] 시나리오...   (SET은 armEval과 같은 형식: b, s, h, m, a, r 접두사)
// 출력: 시나리오마다 넘어짐 수, 걸음 수 평균·표준편차, COM 최종 이동 표준편차(cm), 몸통 최대 기울기 평균·표준편차, 회복 시각 표준편차
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findScenario, loadScenario, loadInputs } from './simCommon';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };

function cfgs(): Record<string, never> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), m: rd('config/hitModel.json'), a: rd('config/animDriver.json'), r: rd('config/reaction.json') };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c as Record<string, never>;
}

interface Out { name: string; k: number; fell: boolean; steps: number; disp: number; tilt: number; rec: number | null }

async function worker(name: string, k: number): Promise<Out> {
  const { runScenario } = await import('../src/sim/runner');
  const simCfg = JSON.parse(readFileSync('config/sim.json', 'utf8')) as { stepHz: number };
  const c = cfgs() as Record<string, never> & { b: never; s: never; h: never; m: never; a: never; r: never };
  const sc0 = loadScenario(findScenario(name));
  const dt = 1 / simCfg.stepHz;
  const sc = { ...sc0, events: sc0.events.map((e) => (e.type === 'hit' ? { ...e, t: e.t + k * dt } : e)) };
  const r = await runScenario({ ...loadInputs(sc), characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, hitModelConfig: c.m, animConfig: c.a, reactionConfig: c.r } });
  const s = r.summary;
  return { name, k, fell: s.fell, steps: s.stepsTaken ?? 0, disp: (s.metrics.comDisplacement as number) ?? 0, tilt: (s.metrics.trunkTiltMaxAfterHit as number) ?? 0, rec: s.recoveredAfterHit ?? null };
}

async function master(): Promise<void> {
  const K = Number(opt('--k', '6')), J = Number(opt('--jobs', '24'));
  const names = argv.filter((a, i) => !a.startsWith('--') && !['--k', '--jobs'].includes(argv[i - 1] ?? ''));
  const jobs = names.flatMap((n) => Array.from({ length: 2 * K + 1 }, (_, i) => ({ n, k: i - K })));
  const rows: Out[] = [];
  let next = 0;
  const run = (): Promise<void> => new Promise((res) => {
    const j = jobs[next++];
    if (!j) return res();
    const p = spawn(process.execPath, ['--import', 'tsx', 'tools/shiftVariance.ts', '--worker', j.n, String(j.k)], { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const l = out.split('\n').find((x) => x.startsWith('ROW ')); if (l) rows.push(JSON.parse(l.slice(4)) as Out); void run().then(res); });
  });
  await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, run));
  const ms = (x: number[]) => { const m = x.reduce((a, b) => a + b, 0) / Math.max(1, x.length); return [m, Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length))] as const; };
  console.log(`| 시나리오 | 시각 이동 (스텝) | 넘어짐 | 걸음 평균±표준편차 | COM 이동 표준편차 cm | 몸통 최대 평균±표준편차 ° | 회복 시각 표준편차 s |`);
  console.log('|---|---|---|---|---|---|---|');
  for (const n of names) {
    const rs = rows.filter((r) => r.name === n).sort((a, b) => a.k - b.k);
    const [sm, ss] = ms(rs.map((r) => r.steps)), [, ds] = ms(rs.map((r) => r.disp)), [tm, ts] = ms(rs.map((r) => r.tilt));
    const rec = rs.map((r) => r.rec).filter((x): x is number => x !== null);
    const [, rsd] = ms(rec);
    console.log(`| ${n} | ±${K} (${rs.length}회) | ${rs.filter((r) => r.fell).length} | ${sm.toFixed(1)}±${ss.toFixed(1)} | ${(ds * 100).toFixed(1)} | ${tm.toFixed(0)}±${ts.toFixed(0)} | ${rec.length ? rsd.toFixed(2) : '-'} (회복 ${rec.length}/${rs.length}) |`);
  }
}

if (argv[0] === '--worker') worker(argv[1]!, Number(argv[2])).then((r) => process.stdout.write('ROW ' + JSON.stringify(r) + '\n')).catch((e) => { console.error(e); process.exit(1); });
else void master();
