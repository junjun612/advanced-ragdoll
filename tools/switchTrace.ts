// (결정 land-5, game-1c) 키네마틱 걷기 → Active 전환 직후 걷기 추종 과도 응답: 전환 뒤 1.5초를 0.05초마다
//   DCM 오차(|ξ − ξ_ref|, 옆 성분), COM 속도 차(실제 − 클립), 재생 속도, 발 상태를 찍는다. 피격 없이 전환만.
// 사용법: npx tsx tools/switchTrace.ts [전환 시각=3.0] [--clip kimodo_walk_forward]
import { runScenario } from '../src/sim/runner';
import { loadInputs, jitterScenario } from './simCommon';
import type { Scenario } from '../src/sim/scenario';

const argv = process.argv.slice(2);
const tSw = Number(argv[0] ?? '3.0');
/** 둘째 인자: 피격 시각 (옆 Δv 0.25, 없으면 피격 없음). 출력 기준 시각은 피격 시각 */
const tHit = argv[1] !== undefined ? Number(argv[1]) : null;
const t0 = tHit ?? tSw;
const clip = 'kimodo_walk_forward';
const base = {
  name: 'switch_trace', milestone: '0.6', duration: t0 + 1.6, seed: 1, terrain: 'flat', character: 'xbot',
  spawn: { position: [0, 0, 0], yaw: 0, state: 'Animated', pose: clip }, clip: null,
  events: [
    ...(tSw < (tHit ?? Infinity) ? [{ t: tSw, type: 'setState', state: 'Active' }] : []),
    ...(tHit !== null ? [{ t: tHit, type: 'hit', hit: { type: 'push', body: 'Spine2', direction: [1, 0, 0], magnitude: 0.25, duration: 0.15 } }] : []),
  ],
  cameras: ['front'], expect: {},
} as unknown as Scenario;
let last = -1;
await runScenario({
  ...loadInputs(jitterScenario(base, 1)),
  observe: {
    step: (w) => {
      const ch = w.characters[0]!;
      const t = w.time - t0;
      if (t < 0 || t > 1.5 || Math.floor(t * 20) === last) return;
      last = Math.floor(t * 20);
      const ws = ch.walk.state;
      const v = ch.rd.com().vel;
      console.log(`${t.toFixed(2)} eng=${ws.engaged} dcmErr=[${ws.dcmError.map((x) => x.toFixed(3)).join(',')}] |e|=${Math.hypot(...ws.dcmError).toFixed(3)} rate=${ws.rate.toFixed(2)} feet=${ws.feet.LeftFoot.mode}/${ws.feet.RightFoot.mode} d=${ws.feet.LeftFoot.delta.map((x) => x.toFixed(2))}|${ws.feet.RightFoot.delta.map((x) => x.toFixed(2))} s=${ws.feet.LeftFoot.s.toFixed(2)}/${ws.feet.RightFoot.s.toFixed(2)} vx=${v[0].toFixed(2)} vz=${v[2].toFixed(2)}`);
    },
  },
});
