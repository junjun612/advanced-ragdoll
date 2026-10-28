// 넘어짐 뒤 이완 평가 (README 결정 relax-1~6): 시나리오 × 근처 입력(시드 1~N, jitterScenario)을 돌려 머리 첫 접촉·머리 충격 속도·폭발·
// 착지 후 경직 시간·충격 후 강도 최소·몸부림 시작을 표로 내고 JSON으로 저장한다. 고치기 전후 비교는 두 결과 JSON을 --compare로.
// 사용법: npx tsx tools/relaxEval.ts [--sweep 6] [--out out/relaxEval.json] [시나리오...]
//         npx tsx tools/relaxEval.ts --compare <전.json> <후.json>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';
import { runScenario } from '../src/sim/runner';

const DEFAULT = ['push_back_large', 'push_front_large', 'push_side_large', 'death_limp', 'explosion_near', 'stairs_tumble', 'getup_supine', 'getup_prone'];
type Row = { scenario: string; seed: number; passed: boolean; fell: boolean; exploded: boolean; first: string | null; headImpact: number | null; rigid: number | null; sMin: number | null; writhe: number | null; maxAngVel: number | null; failures: string[] };

const argv = process.argv.slice(2);
const ci = argv.indexOf('--compare');
if (ci >= 0) {
  const a = JSON.parse(readFileSync(argv[ci + 1]!, 'utf8')) as Row[];
  const b = JSON.parse(readFileSync(argv[ci + 2]!, 'utf8')) as Row[];
  const names = [...new Set(a.map((r) => r.scenario))];
  const agg = (rs: Row[]) => {
    const m = (f: (r: Row) => number | null) => { const v = rs.map(f).filter((x): x is number => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const mx = (f: (r: Row) => number | null) => { const v = rs.map(f).filter((x): x is number => x !== null); return v.length ? Math.max(...v) : null; };
    return { n: rs.length, pass: rs.filter((r) => r.passed).length, headFirst: rs.filter((r) => r.first === 'Head').length, expl: rs.filter((r) => r.exploded).length, head: m((r) => r.headImpact), headMax: mx((r) => r.headImpact), rigid: m((r) => r.rigid), rigidMax: mx((r) => r.rigid), sMin: m((r) => r.sMin), writhe: m((r) => r.writhe) };
  };
  const f = (x: number | null, d = 2) => (x === null ? '-' : x.toFixed(d));
  console.log('| 시나리오 | 통과 전→후 | 머리 첫 접촉 | 폭발 | 머리 충격 평균(최대) m/s | 경직 시간 평균(최대) s | 충격 후 강도 최소 | 몸부림 시작 s |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const n of names) {
    const x = agg(a.filter((r) => r.scenario === n)), y = agg(b.filter((r) => r.scenario === n));
    console.log(`| ${n} | ${x.pass}/${x.n} → ${y.pass}/${y.n} | ${x.headFirst} → ${y.headFirst} | ${x.expl} → ${y.expl} | ${f(x.head)}(${f(x.headMax)}) → ${f(y.head)}(${f(y.headMax)}) | ${f(x.rigid)}(${f(x.rigidMax)}) → ${f(y.rigid)}(${f(y.rigidMax)}) | ${f(x.sMin)} → ${f(y.sMin)} | ${f(x.writhe)} → ${f(y.writhe)} |`);
  }
  process.exit(0);
}
const wi = argv.indexOf('--sweep');
const N = wi >= 0 ? Number(argv[wi + 1]) : 6;
const oi = argv.indexOf('--out');
const outPath = oi >= 0 ? argv[oi + 1]! : 'out/relaxEval.json';
const skip = new Set([wi, wi + 1, oi, oi + 1].filter((k) => k >= 0));
const names = argv.filter((x, k) => !skip.has(k) && !x.startsWith('--'));
const list = names.length ? names : DEFAULT;
const rows: Row[] = [];
for (const n of list) {
  for (let seed = 1; seed <= N; seed++) {
    const base = { ...loadScenario(findScenario(n)), seed };
    const sc = seed === 1 ? base : jitterScenario(base, seed);
    const r = await runScenario(loadInputs(sc));
    const s = r.summary, m = s.metrics;
    const row: Row = { scenario: n, seed, passed: s.expectations.passed, fell: s.fell, exploded: s.exploded, first: s.firstGroundContact ?? null, headImpact: m.headImpactSpeed ?? null, rigid: m.postImpactRigidTime ?? null, sMin: m.postImpactStrengthMin ?? null, writhe: m.writheStart ?? null, maxAngVel: m.maxAngVel ?? null, failures: s.expectations.failures };
    rows.push(row);
    console.log(`${n} s${seed} ${row.passed ? 'P' : 'x'}${row.exploded ? 'E' : ''} first=${row.first} head=${row.headImpact?.toFixed(2) ?? '-'} rigid=${row.rigid?.toFixed(2) ?? '-'} sMin=${row.sMin?.toFixed(2) ?? '-'} writhe=${row.writhe?.toFixed(2) ?? '-'} ${row.failures.join('; ')}`);
  }
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(rows, null, 1));
