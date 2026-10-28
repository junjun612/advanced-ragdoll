// (README 결정 pres-*) 인간다움 실험 지표 비교: npx tsx tools/presenceEval.ts <변형: base|np|nd|ng|nf|ns|nb|nr 쉼표 묶음> <시드 수 N> <시나리오 ...> [--metrics a,b,...]
// 근처 입력(jitterScenario 시드 1..N)으로 돌려 시나리오마다 통과 수·넘어짐 수와 지표 평균(± 표준오차)을 낸다. 변형 플래그는 tools/fuzz/nearInput.ts와 같다.
import presenceCfg from '../config/presence.json';
import { runScenario } from '../src/sim/runner';
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';

const args = process.argv.slice(2);
const mi = args.indexOf('--metrics');
const metrics = mi >= 0 ? args.splice(mi, 2)[1]!.split(',') : [];
const [v, nS, ...names] = args;
const flags = new Set(v!.split(','));
const pc = presenceCfg as unknown as { reaction: { enabled: boolean }; gaze: { glance: { enabled: boolean }; fallWeight: number; stabilize: { enabled: boolean } }; breath: { enabled: boolean } };
const np = flags.has('np');
if (np || flags.has('nd')) pc.reaction.enabled = false;
if (np || flags.has('ng')) pc.gaze.glance.enabled = false;
if (np || flags.has('nf')) pc.gaze.fallWeight = 0;
if (np || flags.has('ns')) pc.gaze.stabilize.enabled = false;
if (np || flags.has('nb')) pc.breath.enabled = false;
for (const n of names) {
  const sc0 = loadScenario(findScenario(n));
  let pass = 0, fell = 0;
  const vals: Record<string, number[]> = {};
  for (let seed = 1; seed <= Number(nS); seed++) {
    const inp = loadInputs(jitterScenario(sc0, seed));
    if (flags.has('nr')) delete (inp.ragdoll as { shoulderRom?: unknown }).shoulderRom; // nr: 어깨 끝 저항 끔 (결정 merge2-*)
    const s = (await runScenario({ ...inp })).summary;
    if (s.expectations.passed) pass++;
    if (s.fell) fell++;
    for (const m of metrics) { const x = s.metrics[m]; if (typeof x === 'number' && Number.isFinite(x)) (vals[m] ??= []).push(x); }
  }
  const st = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); return `${m.toFixed(3)}±${(sd / Math.sqrt(a.length)).toFixed(3)}`; };
  console.log(`${v} ${n}: 통과 ${pass}/${nS} 넘어짐 ${fell} ${metrics.map((m) => `${m} ${vals[m]?.length ? st(vals[m]!) : '-'}`).join(' ')}`);
}
