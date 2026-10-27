// 혼돈 진단 (v0.4): 밀기 세기를 아주 조금(±eps) 바꾼 두 실행의 스텝 이벤트를 나란히 놓고 처음 갈라지는 곳(다른 발·다른 종류·시각 차 > 2프레임)을 찾는다.
// 사용법: npx tsx tools/stepDiverge.ts [--eps 0.002] [시나리오...]
import { findScenario, loadScenario, loadInputs } from './simCommon';
import { runScenario } from '../src/sim/runner';
import hitScale from '../config/hitScale.json';
import type { Scenario } from '../src/sim/scenario';
import bcfg from '../config/balance.json';
import scfg from '../config/stepping.json';

// 설정 덮어쓰기 SET="s.a.b=1;b.c=2" (stepEval과 같음)
const bc = JSON.parse(JSON.stringify(bcfg)), stc = JSON.parse(JSON.stringify(scfg));
for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
  const i = kv.indexOf('=');
  const path = kv.slice(0, i).split('.');
  let o: Record<string, unknown> = path[0] === 's' ? stc : bc;
  for (const p of path.slice(1, -1)) o = o[p] as Record<string, unknown>;
  o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
}

const argv = process.argv.slice(2);
const ei = argv.indexOf('--eps');
const eps = ei >= 0 ? Number(argv[ei + 1]) : 0.002;
const names = argv.filter((a, k) => !(k === ei || k === ei + 1));
const scale = (sc: Scenario, k: number): Scenario => ({
  ...sc,
  events: sc.events.map((e) => (e.type === 'hit' && e.hit?.type === 'push'
    ? { ...e, hit: { ...e.hit, magnitude: (typeof e.hit.magnitude === 'number' ? e.hit.magnitude : (hitScale as Record<string, number>)[e.hit.magnitude as string]!) * k } } : e)),
});
for (const n of names) {
  const sc = loadScenario(findScenario(n));
  const runs = await Promise.all([1 - eps, 1 + eps].map((k) => runScenario({ ...loadInputs(scale(sc, k)), characterOpts: { balanceConfig: bc, steppingConfig: stc } })));
  const ev = runs.map((r) => r.meta.events.filter((e) => e.type === 'stepStart' || e.type === 'step' || e.type === 'stagger'));
  let msg = '같음';
  for (let i = 0; i < Math.max(ev[0]!.length, ev[1]!.length); i++) {
    const a = ev[0]![i], b = ev[1]![i];
    if (!a || !b || a.type !== b.type || a.body !== b.body || Math.abs(a.t - b.t) > 2 / 120 + 1e-9 || a.detail?.split(' ')[1] !== b.detail?.split(' ')[1]) {
      msg = `#${i}: [${a ? `${a.t.toFixed(3)} ${a.type} ${a.detail}` : '-'}] vs [${b ? `${b.t.toFixed(3)} ${b.type} ${b.detail}` : '-'}]`;
      break;
    }
  }
  const out = runs.map((r) => `${r.summary.fell ? 'F' : r.summary.recoveredAfterHit !== null ? 'R' : 'S'}${r.summary.stepsTaken}`).join(' / ');
  console.log(`${n.padEnd(20)} ${out.padEnd(10)} ${msg}`);
}
