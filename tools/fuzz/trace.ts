// 퍼징 실행 한 바디 스텝 추적 (원인 찾기용): npx tsx tools/fuzz/trace.ts <시드> <바디> [시작초] [끝초]
// 매 스텝: 바디 각속도(월드·부모 기준), 관절 목표·오차·토크, 지면·다른 접촉, 켜진 행동, 상태
import { runScenario } from '../../src/sim/runner';
import { loadInputs, jitterScenario, loadScenario, findScenario } from '../simCommon';
import { fuzzCase } from './gen';
import type { BodyName, JointName, Vec3 } from '../../src/sim/types';

const [seedS, body = 'LeftHand', fromS = '0', toS = '99', who = ''] = process.argv.slice(2);
// <시드> = 퍼징 시드, 또는 <시나리오 이름>@<근처 입력 시드> (jitterScenario)
const fc = /^\d+$/.test(seedS!) ? fuzzCase(Number(seedS)) : (() => {
  const [n, js] = seedS!.split('@');
  return { scenario: jitterScenario(loadScenario(findScenario(n!)), Number(js ?? 1)) };
})();
const from = Number(fromS), to = Number(toS);
const f = (v: number[], d = 1) => `[${v.map((x) => x.toFixed(d)).join(',')}]`;
console.log(fc.scenario.description);
let prevQ: number[] | null = null;
await runScenario({
  ...loadInputs(fc.scenario),
  observe: {
    step: (w) => {
      const ch = who ? w.character(who)! : w.characters[0]!;
      const s = ch.getState();
      if (s.time < from || s.time > to) return;
      const b = s.bodies[body as BodyName];
      const parent = ch.def.bodies.find((x) => x.name === body)?.parent as BodyName | undefined;
      const pw: Vec3 = parent ? s.bodies[parent].angVel : [0, 0, 0];
      const rel = [b.angVel[0] - pw[0], b.angVel[1] - pw[1], b.angVel[2] - pw[2]];
      const j = s.joints[body as JointName];
      const con = s.contacts.filter((c) => c.body === body || c.body === parent).map((c) => `${c.body}:${c.impulse.toFixed(2)}`).join(' ');
      const inter = s.interaction?.contacts.map((c) => `${c.source}`).join(' ') ?? '';
      // 자세 차분 각속도 (이번 스텝 실제로 돈 각 / dt)
      const pq = prevQ;
      prevQ = b.rot;
      const fd = pq ? (2 * Math.acos(Math.min(1, Math.abs(pq[0]! * b.rot[0] + pq[1]! * b.rot[1] + pq[2]! * b.rot[2] + pq[3]! * b.rot[3])))) / w.dt : 0;
      console.log(`${s.time.toFixed(4)} |w|=${Math.hypot(...b.angVel).toFixed(1)} fd=${fd.toFixed(1)} rel=${Math.hypot(...rel).toFixed(1)} v=${Math.hypot(...b.linVel).toFixed(2)} ${j ? `tgt=${f(j.targetDeg, 0)} cur=${f(j.coordsDeg, 0)} err=${j.errorDeg.toFixed(0)} tq=${j.torque.toFixed(1)} str=${j.strength.toFixed(2)} viol=${j.violationDeg.toFixed(1)}` : ''} ${s.state}/${s.posture} [${s.behaviors.filter((x) => x.weight > 0).map((x) => `${x.name}:${x.weight.toFixed(2)}`).join(',')}] c:${con} ${inter}`);
    },
  },
});
