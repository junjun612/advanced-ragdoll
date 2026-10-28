// 진정 단계 전후 비교 (README 결정 settle-2): armEval --json 결과 두 개(같은 시나리오·시드)를 짝지어 비교한다.
// 사용법: npx tsx tools/settleCompare.ts <전.json> <후.json> [--md out.md]
// 지표: 팔 들림 p90·팔 사용·lateOut·몸통 최대·정착 시간·걸음 수(둘 다 넘어지지 않은 짝의 평균, 짝지은 차 ± 표준오차), 넘어짐률(McNemar 정확 검정, 양측 p),
// 통과율. 사람 값은 config/qualityTargets.json human.
import { readFileSync, writeFileSync } from 'node:fs';

interface Row { name: string; seed: number; passed: boolean; fell: boolean; steps: number; exploded?: boolean; settleTime?: number | null; settleFrac?: number; reactive?: number; closing?: number; stepLens?: number[]; stepEnd?: number | null; drag?: number; arm: { elevP90: number; usage: number; lateOut: number; trunkPeak: number } }
const argv = process.argv.slice(2);
const A = JSON.parse(readFileSync(argv[0]!, 'utf8')) as Row[];
const B = JSON.parse(readFileSync(argv[1]!, 'utf8')) as Row[];
const q = JSON.parse(readFileSync('config/qualityTargets.json', 'utf8')) as { metrics: Record<string, { human: number | null }> };
const key = (r: Row) => `${r.name}#${r.seed}`;
const bm = new Map(B.map((r) => [key(r), r]));
const pairs = A.filter((r) => bm.has(key(r))).map((a) => [a, bm.get(key(a))!] as const);

const M: { id: string; ko: string; get: (r: Row) => number | null | undefined; human?: number | null; d: number }[] = [
  { id: 'armElevP90', ko: '팔 들림 p90 (°)', get: (r) => r.arm.elevP90, human: q.metrics.armElevP90?.human, d: 1 },
  { id: 'armUsage', ko: '팔 사용 (°/s)', get: (r) => r.arm.usage, human: q.metrics.armUsage?.human, d: 1 },
  { id: 'armLateOut', ko: 'lateOut', get: (r) => r.arm.lateOut, human: q.metrics.armLateOut?.human, d: 3 },
  { id: 'trunkPeak', ko: '몸통 최대 (°)', get: (r) => r.arm.trunkPeak, human: q.metrics.trunkPeak?.human, d: 1 },
  { id: 'settleTime', ko: '정착 시간 (초)', get: (r) => r.settleTime, d: 2 },
  { id: 'steps', ko: '걸음 수', get: (r) => r.steps, d: 2 },
  { id: 'reactive', ko: '반응 걸음 수', get: (r) => r.reactive, d: 2 },
  { id: 'closing', ko: '모으기 걸음 수', get: (r) => r.closing, d: 2 },
  { id: 'stepLen', ko: '걸음당 보폭 (m)', get: (r) => (r.stepLens?.length ? r.stepLens.reduce((a, b) => a + b, 0) / r.stepLens.length : null), d: 3 },
  { id: 'firstLen', ko: '첫 걸음 보폭 (m)', get: (r) => r.stepLens?.[0] ?? null, d: 3 },
  { id: 'stepEnd', ko: '마지막 걸음 시각 (초)', get: (r) => r.stepEnd, d: 2 },
  { id: 'drag', ko: '마지막 걸음 뒤 발 끌림 (m)', get: (r) => r.drag, d: 3 },
];

function stats(ps: (readonly [Row, Row])[]) {
  const ok = ps.filter(([a, b]) => !a.fell && !b.fell);
  const out: Record<string, { a: number; b: number; d: number; se: number; n: number }> = {};
  for (const m of M) {
    const xs = ok.map(([a, b]) => [m.get(a), m.get(b)] as const).filter((x): x is readonly [number, number] => typeof x[0] === 'number' && typeof x[1] === 'number');
    const n = xs.length;
    const ma = xs.reduce((s, x) => s + x[0], 0) / Math.max(1, n), mb = xs.reduce((s, x) => s + x[1], 0) / Math.max(1, n);
    const ds = xs.map((x) => x[1] - x[0]);
    const md = ds.reduce((s, x) => s + x, 0) / Math.max(1, n);
    const sd = Math.sqrt(ds.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
    out[m.id] = { a: ma, b: mb, d: md, se: sd / Math.sqrt(Math.max(1, n)), n };
  }
  const fa = ps.filter(([a]) => a.fell).length, fb = ps.filter(([, b]) => b.fell).length;
  const b01 = ps.filter(([a, b]) => !a.fell && b.fell).length, b10 = ps.filter(([a, b]) => a.fell && !b.fell).length;
  // McNemar 정확 검정 (양측): 어긋난 짝 중 한쪽이 k 이하일 이항 확률 × 2
  const nd = b01 + b10, k = Math.min(b01, b10);
  let p = 0;
  for (let i = 0; i <= k; i++) { let c = 1; for (let j = 0; j < i; j++) c = (c * (nd - j)) / (j + 1); p += c / 2 ** nd; }
  const pa = ps.filter(([a]) => a.passed).length, pb = ps.filter(([, b]) => b.passed).length;
  return { out, n: ps.length, fa, fb, b01, b10, p: Math.min(1, 2 * p), pa, pb, xa: ps.filter(([a]) => a.exploded).length, xb: ps.filter(([, b]) => b.exploded).length };
}

const lines: string[] = [];
const all = stats(pairs);
lines.push(`### 전체 (짝 ${all.n}개, 지표는 둘 다 넘어지지 않은 ${all.out.armElevP90!.n}짝)`, '', '| 지표 | 사람 | 전 | 후 | 차 (± 표준오차) |', '|---|---|---|---|---|');
for (const m of M) { const s = all.out[m.id]!; lines.push(`| ${m.ko} | ${m.human != null ? m.human.toFixed(m.d) : '—'} | ${s.a.toFixed(m.d)} | ${s.b.toFixed(m.d)} | ${s.d >= 0 ? '+' : ''}${s.d.toFixed(m.d)} ± ${s.se.toFixed(m.d)} |`); }
lines.push(`| 넘어짐률 | 0 | ${(all.fa / all.n * 100).toFixed(1)}% (${all.fa}) | ${(all.fb / all.n * 100).toFixed(1)}% (${all.fb}) | 새로 넘어짐 ${all.b01} · 새로 버팀 ${all.b10} (McNemar p = ${all.p.toFixed(2)}) |`);
lines.push(`| 통과율 | — | ${(all.pa / all.n * 100).toFixed(1)}% | ${(all.pb / all.n * 100).toFixed(1)}% | ${all.pb - all.pa >= 0 ? '+' : ''}${all.pb - all.pa} |`);
lines.push(`| 폭발 | — | ${all.xa} | ${all.xb} | |`, '');
{
  const ok = pairs.filter(([a, b]) => !a.fell && !b.fell);
  const hist = (rs: Row[]) => { const h: Record<number, number> = {}; for (const r of rs) h[r.steps] = (h[r.steps] ?? 0) + 1; return Object.keys(h).map(Number).sort((x, y) => x - y).map((k) => `${k}:${h[k]}`).join(' '); };
  lines.push(`걸음 수 분포 (둘 다 버틴 짝) 전 ${hist(ok.map(([a]) => a))} / 후 ${hist(ok.map(([, b]) => b))}`, '');
}
lines.push('### 시나리오별', '', '| 시나리오 | 넘어짐 전→후 | 통과 전→후 | 팔 p90 | 팔 사용 | lateOut | 몸통 최대 | 정착 시간 | 걸음 | 보폭 | 끌림 |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const n of [...new Set(pairs.map(([a]) => a.name))]) {
  const s = stats(pairs.filter(([a]) => a.name === n));
  const c = (id: string, d: number) => { const x = s.out[id]!; return `${x.a.toFixed(d)} → ${x.b.toFixed(d)}`; };
  lines.push(`| ${n} | ${s.fa} → ${s.fb} / ${s.n} | ${s.pa} → ${s.pb} | ${c('armElevP90', 0)} | ${c('armUsage', 0)} | ${c('armLateOut', 2)} | ${c('trunkPeak', 0)} | ${c('settleTime', 2)} | ${c('steps', 1)} | ${c('stepLen', 2)} | ${c('drag', 3)} |`);
}
const md = lines.join('\n');
console.log(md);
if (argv.includes('--md')) writeFileSync(argv[argv.indexOf('--md') + 1]!, md + '\n');
