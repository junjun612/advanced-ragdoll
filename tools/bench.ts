// npm run bench (SPEC 15, v0.4~): 캐릭터 1명 전 계층 활성 물리 스텝당 시간(ms)을 잰다.
// 시나리오 묶음을 repeat번 돌려 스텝당 평균·중앙값·p95를 내고, out/bench.json에 쓴다. 직전 결과(out/bench.prev.json)보다 20% 넘게 느려지면 경고한다.
// 사용법: npm run bench [-- --repeat 3] [시나리오...]
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { findScenario, loadScenario, loadInputs, OUT_DIR } from './simCommon';
import { runScenario } from '../src/sim/runner';

const argv = process.argv.slice(2);
const ri = argv.indexOf('--repeat');
const repeat = ri >= 0 ? Number(argv[ri + 1]) : 3;
const names = argv.filter((a, k) => !(k === ri || k === ri + 1));
const list = names.length ? names : ['stand_still', 'push_front_light', 'push_front_medium', 'push_left_medium'];

interface Row { name: string; steps: number; msMean: number; msMedian: number; msMin: number; msP95: number }
const rows: Row[] = [];
for (const n of list) {
  const sc = loadScenario(findScenario(n));
  const per: number[] = [];
  let steps = 0;
  for (let k = 0; k < repeat + 1; k++) {
    const r = await runScenario({ ...loadInputs(sc), now: () => performance.now() });
    steps = Math.round(sc.duration * 120);
    if (k > 0) per.push(r.msPerStep); // 첫 실행은 JIT 예열로 버린다
  }
  const s = [...per].sort((a, b) => a - b);
  rows.push({ name: n, steps, msMean: per.reduce((a, b) => a + b, 0) / per.length, msMedian: s[Math.floor(s.length / 2)]!, msMin: s[0]!, msP95: s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! });
}
mkdirSync(OUT_DIR, { recursive: true });
const path = join(OUT_DIR, 'bench.json'), prevPath = join(OUT_DIR, 'bench.prev.json');
let prev: Record<string, number> = {};
if (existsSync(path)) {
  renameSync(path, prevPath);
  prev = Object.fromEntries((JSON.parse(readFileSync(prevPath, 'utf8')).rows as Row[]).map((r) => [r.name, r.msMean]));
}
writeFileSync(path, JSON.stringify({ date: new Date().toISOString(), repeat, rows }, null, 2));
console.log('| 시나리오 | 스텝 | ms/스텝 평균 | 중앙값 | 최소 | 직전 대비 |');
console.log('|---|---|---|---|---|---|');
let warn = false;
for (const r of rows) {
  const p = prev[r.name];
  const d = p ? (r.msMean - p) / p : null;
  if (d !== null && d > 0.2) warn = true;
  console.log(`| ${r.name} | ${r.steps} | ${r.msMean.toFixed(3)} | ${r.msMedian.toFixed(3)} | ${r.msMin.toFixed(3)} | ${d === null ? '—' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}%`} |`);
}
if (warn) console.log('\n경고: 직전보다 20% 넘게 느려진 시나리오가 있다 (SPEC 15: 보고 대상).');
