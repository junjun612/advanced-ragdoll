// 스텝 진단 (v0.4): 시나리오를 돌려 out/<name>/에 쓰고, 스텝 이벤트와 0.05초 간격 타임라인(상태, COM, DCM 이탈, 발 위치)을 출력한다.
// 사용법: npx tsx tools/stepTrace.ts <scenario> [--every 0.05] [--from 0.9] [--to 3] [--seed N [--jitter]]
import { findScenario, loadScenario, runAndWrite, jitterScenario } from './simCommon';
import type { CharacterState } from '../src/sim/types';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const name = argv[0]!;
const opt = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const every = opt('--every', 0.1), from = opt('--from', 0.9), to = opt('--to', 99);
const sc0 = loadScenario(findScenario(name));
const sc1 = argv.includes('--seed') ? { ...sc0, seed: opt('--seed', sc0.seed) } : sc0;
const sc = argv.includes('--jitter') ? jitterScenario(sc1, sc1.seed) : sc1;
const res = await runAndWrite(sc);
const s = res.summary;
console.log(`${sc.name} ${s.expectations.passed ? 'PASS' : 'FAIL'} steps=${s.stepsTaken} fell=${s.fell}@${s.fallTime} rec=${s.recoveredAfterHit} landErr=${s.metrics.landingErrorMean?.toFixed(3)} slide=${s.metrics.footSlide?.toFixed(3)} ms/step=${res.msPerStep.toFixed(3)}`);
for (const f of s.expectations.failures) console.log(`  x ${f}`);
for (const e of res.meta.events) if (e.type !== 'hit' || true) console.log(`  ev ${e.t.toFixed(3)} ${e.type} ${e.detail ?? ''} ${e.error !== undefined ? 'err=' + e.error.toFixed(3) : ''}`);
const states = readFileSync(`out/${name}/log.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CharacterState);
let next = from;
const f2 = (x: number) => x.toFixed(2);
for (const st of states) {
  if (st.time + 1e-6 < next || st.time > to) continue;
  next += every;
  const sp = st.stepping;
  const L = st.bodies.LeftFoot.pos, R = st.bodies.RightFoot.pos;
  console.log(`${f2(st.time)} ${sp.state.padEnd(6)} ${(sp.swingFoot ?? '-').padEnd(9)} ${(sp.phase ?? '-').padEnd(6)} s=${f2(sp.s)} n=${sp.stepCount} com=(${f2(st.com[0])},${f2(st.com[1])},${f2(st.com[2])}) v=(${f2(st.comVel[0])},${f2(st.comVel[2])}) cpOut=${(sp.cpOutside ?? 99).toFixed(3)} thr=${sp.threshold.toFixed(3)} tgt=${sp.target ? `(${f2(sp.target[0])},${f2(sp.target[2])})` : '-'} L=(${f2(L[0])},${f2(L[1])},${f2(L[2])}) R=(${f2(R[0])},${f2(R[1])},${f2(R[2])}) tilt=${Number(st.debug.spine2TiltDeg).toFixed(0)} ${st.posture}`);
}
