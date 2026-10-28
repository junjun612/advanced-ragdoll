// (README 결정 game-1) 게임 애니 복귀 시험: 클립(Animated) → 밀림 → 복귀 → 클립. 밀기 방향·세기·시드 묶음을 돌려 이벤트·지표를 본다.
// 사용법: npx tsx tools/returnTry.ts [--clip kimodo_walk_forward] [--seeds N] [--noret] [--quiet] [dir:dv ...]
//   예) npx tsx tools/returnTry.ts --seeds 4 side:0.25 back:0.4 front:0.3
//       npx tsx tools/returnTry.ts --clip kimodo_idle_relaxed front:0.3
import { runScenario } from '../src/sim/runner';
import { loadInputs, jitterScenario } from './simCommon';
import type { Scenario } from '../src/sim/scenario';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]!; argv.splice(i, 2); return v; };
const flag = (k: string) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const clip = opt('--clip', 'kimodo_walk_forward');
const nSeeds = Number(opt('--seeds', '1'));
const noRet = flag('--noret');
const quiet = flag('--quiet');
/** --activeAt T: T초에 Active로 바꿔 둔다 (Active로 걷던 캐릭터와 비교, 결정 land-5) */
const activeAt = Number(opt('--activeAt', 'NaN'));
/** --hitT 3.0,3.1,…: 피격 시각들 (걸음 위상을 고르게 덮기). 시드마다 모든 시각을 돈다 */
/** --activeLead X: 피격 X초 전에 Active로 (전환 직후 피격과 데워진 걷기 추종 비교) */
const activeLead = Number(opt('--activeLead', 'NaN'));
const hitTs = opt('--hitT', '3').split(',').map(Number);
const cases = (argv.length ? argv : ['side:0.25', 'back:0.4', 'front:0.3']).map((s) => { const [d, v] = s.split(':'); return { d: d!, dv: Number(v) }; });
const DIRS: Record<string, [number, number, number]> = { side: [1, 0, 0], left: [-1, 0, 0], back: [0, 0, 1], front: [0, 0, -1] };

for (const c of cases) {
  let falls = 0, rets = 0, wait = 0;
  for (let seed = 1; seed <= nSeeds; seed++) for (const hitT of hitTs) {
    const base = {
      name: 'return_try', milestone: '0.6', duration: 10, seed: 1, terrain: 'flat', character: 'xbot',
      spawn: { position: [0, 0, 0], yaw: 0, state: 'Animated', pose: clip }, clip: null,
      events: [
        ...(Number.isFinite(activeAt) ? [{ t: activeAt, type: 'setState', state: 'Active' }] : Number.isFinite(activeLead) ? [{ t: hitT - activeLead, type: 'setState', state: 'Active' }] : []),
        { t: hitT, type: 'hit', hit: { type: 'push', body: 'Spine2', direction: DIRS[c.d]!, magnitude: c.dv, duration: 0.15 } },
        ...(noRet ? [] : [{ t: hitT, type: 'returnToAnimation', clip }]),
      ],
      cameras: ['front'], expect: {},
    } as unknown as Scenario;
    const sc = jitterScenario(base, seed);
    const r = await runScenario(loadInputs(sc));
    const m = r.summary.metrics;
    if (r.summary.fell) falls++;
    const done = r.meta.events.find((e) => e.type === 'returnDone');
    if (done) { rets++; wait += done.t - 3; }
    if (quiet) continue;
    const ev = r.meta.events.filter((e) => /return|setState|walkHandover|walkResume|reactionStart/.test(e.type)).map((e) => `${e.t.toFixed(2)} ${e.type} ${e.detail ?? ''}`);
    console.log(`== ${c.d} ${c.dv} seed ${seed}: fell=${r.summary.fell} pinReact=${(m.pinDuringReaction ?? 0).toFixed(2)} jump=${(m.returnVelJump ?? 0).toFixed(2)} pop=${(m.returnPopAccel ?? 0).toFixed(0)}`);
    for (const l of ev) console.log('  ' + l);
  }
  const nRun = nSeeds * hitTs.length;
  console.log(`## ${clip} ${c.d} ${c.dv}: 넘어짐 ${falls}/${nRun}, 복귀 ${rets}/${nRun}, 피격→복귀 끝 평균 ${rets ? (wait / rets).toFixed(2) : '-'}초`);
}
