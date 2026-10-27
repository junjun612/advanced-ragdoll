// 스텝 진단 묶음 (v0.4 튜닝용): 여러 시나리오를 돌려 한 줄 요약. SET="s.trunk.wAng=0.1;b.wb.torso.kp=30" 로 설정 덮어쓰기 (s = stepping.json, b = balance.json)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { findScenario, loadScenario, loadInputs, OUT_DIR } from './simCommon';
import { runScenario } from '../src/sim/runner';
import { stringifyRounded } from '../src/sim/logger';
import bcfg from '../config/balance.json';
import scfg from '../config/stepping.json';

const bc = JSON.parse(JSON.stringify(bcfg)), stc = JSON.parse(JSON.stringify(scfg));
for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
  const [k, v] = kv.split('=');
  const path = k!.split('.');
  let o: Record<string, unknown> = path[0] === 's' ? stc : bc;
  for (const p of path.slice(1, -1)) o = o[p] as Record<string, unknown>;
  o[path.at(-1)!] = JSON.parse(v!);
}
const f = (x: number | undefined | null, d = 2) => (x === undefined || x === null ? '-' : x.toFixed(d));
for (const n of process.argv.slice(2)) {
  const sc = loadScenario(findScenario(n));
  const r = await runScenario({ ...loadInputs(sc), characterOpts: { balanceConfig: bc, steppingConfig: stc }, now: () => performance.now() });
  const dir = join(OUT_DIR, sc.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log.jsonl'), r.log);
  writeFileSync(join(dir, 'summary.json'), stringifyRounded(r.summary, 2) + '\n');
  writeFileSync(join(dir, 'meta.json'), stringifyRounded(r.meta, 2) + '\n');
  const s = r.summary, m = s.metrics;
  console.log(`${n.padEnd(22)} ${s.expectations.passed ? 'PASS' : 'FAIL'} fell=${s.fell ? f(s.fallTime) : 'no'} steps=${s.stepsTaken} rec=${f(s.recoveredAfterHit)} land=${f(m.landingErrorMean, 3)}/${f(m.landingErrorMax, 3)} slide=${f(m.footSlide, 3)} disp=${f(m.comDisplacement)} tilt=${f(m.leanTiltMaxDeg, 0)} ms=${r.msPerStep.toFixed(2)} ${s.expectations.failures.filter((x) => !x.startsWith('steps') && !x.startsWith('recov')).join('; ')}`);
}
