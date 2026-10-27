// 스윙 진단 (v0.8a): 시나리오를 돌리며 스윙발 기준(QP 과제 p)과 실제 발 위치·접촉을 출력한다 (지형 디딤 디버깅).
// 사용법: npx tsx tools/swingTrace.ts <scenario> [--from 1.0] [--to 2.5] [--every 0.025] [--seed N --jitter] [--watch RightHand]
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';
import { World } from '../src/sim/api';
import { milestoneAtLeast } from '../src/sim/milestones';

const argv = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const sc0 = loadScenario(findScenario(argv[0]!));
const sc1 = argv.includes('--seed') ? { ...sc0, seed: opt('--seed', sc0.seed) } : sc0;
const sc = argv.includes('--jitter') ? jitterScenario(sc1, sc1.seed) : sc1;
const wi = argv.indexOf('--watch');
const watch = wi >= 0 ? argv[wi + 1]! : null;
const from = opt('--from', 1.0), to = opt('--to', 2.5), every = opt('--every', 0.025);
const inp = loadInputs(sc);
const world = await World.create({ seed: sc.seed, terrain: sc.terrain });
const ch = world.addCharacter(inp.character, inp.ragdoll, sc.spawn, { rootAssist: sc.assist?.root, balance: sc.balance, stepping: sc.stepping, getup: sc.getup ?? milestoneAtLeast(sc.milestone, '0.7') });
if (sc.clip) ch.playClip(sc.clip);
const events = [...sc.events].sort((a, b) => a.t - b.t);
let next = 0, print = from;
const f = (x: number) => x.toFixed(3);
while (world.time < to) {
  while (next < events.length && events[next]!.t <= world.time + 1e-6) {
    const e = events[next++]!;
    if (e.type === 'hit') ch.hit(e.hit);
    else if (e.type === 'setState') ch.setState(e.state);
    else if (e.type === 'trigger') ch.trigger(e.behavior, e.params);
  }
  world.step();
  if (world.time + 1e-9 < print) continue;
  print += every;
  if (watch) {
    const st = ch.getState();
    const b = st.bodies[watch as keyof typeof st.bodies];
    const cs = st.contacts.filter((c) => c.body === watch).map((c) => `n(${c.normal.map((x) => x.toFixed(2)).join(',')})`).join('');
    const j = st.joints[watch as keyof typeof st.joints];
    console.log(`${world.time.toFixed(3)} ${watch} w=${Math.hypot(...b.angVel).toFixed(1)} v=${Math.hypot(...b.linVel).toFixed(2)} str=${j?.strength.toFixed(2)} err=${j?.errorDeg.toFixed(0)} tq=${j?.torque.toFixed(0)} c=${cs} beh=${st.behaviors.map((x) => x.name).join(',')}`);
    continue;
  }
  const cmd = ch.balance.stepCmd;
  const sf = cmd?.swingFoot;
  const st = ch.getState();
  const fp = sf ? st.bodies[sf].pos : null;
  const cs = st.contacts.filter((c) => c.body === sf).map((c) => `(${f(c.point[1])}@z${c.point[2].toFixed(2)})`).join('');
  console.log(`${world.time.toFixed(3)} ${sf ?? '-'} ${cmd?.phase ?? '-'} ref=${cmd?.swing ? cmd.swing.p.map(f).join(',') : '-'} foot=${fp ? fp.map(f).join(',') : '-'} tgt=${st.stepping.target ? st.stepping.target.map(f).join(',') : '-'} s=${st.stepping.s.toFixed(2)} c=${cs}`);
}
world.free();
