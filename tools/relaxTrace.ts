// 넘어짐 뒤 이완 추적 (README 결정 relax-1~6): 시나리오 근처 입력 한 개(시드)를 돌려 몸통·머리 접촉, 충격 후 이완, 활성 행동, 강도·관절 속도를 시간순으로.
// 사용법: npx tsx tools/relaxTrace.ts <시나리오> <시드> [시작] [끝]
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';
import { runScenario } from '../src/sim/runner';
import type { CharacterState } from '../src/sim/types';

const [name, seedS, t0S, t1S] = process.argv.slice(2);
const seed = Number(seedS ?? 1), t0 = Number(t0S ?? 0), t1 = Number(t1S ?? 99);
const base = { ...loadScenario(findScenario(name!)), seed };
const sc = seed === 1 ? base : jitterScenario(base, seed);
const r = await runScenario(loadInputs(sc));
for (const s of r.log.trim().split(/\r?\n/).map((l) => JSON.parse(l) as CharacterState)) {
  if (s.time < t0 || s.time > t1) continue;
  const js = Object.values(s.joints);
  const st = js.reduce((a, v) => a + v.strength, 0) / js.length;
  const sp = js.reduce((a, v) => a + Math.hypot(...v.relAngVelDegS), 0) / js.length;
  const g = [...new Set(s.contacts.map((c) => c.body))].join(',');
  const beh = s.behavior.active.map((b) => `${b.name}:${b.weight.toFixed(2)}(${b.phase})`).join(' ');
  console.log(`${s.time.toFixed(2)} str ${st.toFixed(2)} spd ${sp.toFixed(0)} head ${Math.hypot(...s.bodies.Head.linVel).toFixed(2)} g ${g} | ${beh}`);
}
console.log(JSON.stringify({ first: r.summary.firstGroundContact, head: r.summary.metrics.headImpactSpeed, rigid: r.summary.metrics.postImpactRigidTime }));
