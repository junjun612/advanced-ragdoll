// (README 결정 game-3) 반응 변주 예시: 서 있는 캐릭터를 같은 밀기로 세 번(1·5·9초) 민다. 변주 켬/끔을 out/variation_demo_on|off에 쓰고
// 피격마다 고른 반응 클립·첫 디딤 발·걸음 수를 낸다. 필름: npm run film -- variation_demo_on --camera side --from 0.9 --to 3 …
// 사용법: npx tsx tools/variationDemo.ts [dir=front] [dv=small] [seed=1]
import { runAndWrite } from './simCommon';
import type { Scenario } from '../src/sim/scenario';

const [dir = 'front', dv = 'small', seedS = '1'] = process.argv.slice(2);
const D: Record<string, number[]> = { front: [0, 0, -1], back: [0, 0, 1], side: [1, 0, 0], left: [-1, 0, 0] };
const T = [1, 5, 9];
for (const on of [true, false]) {
  const sc = {
    name: `variation_demo_${on ? 'on' : 'off'}`, milestone: '0.4', duration: 12.5, seed: Number(seedS), terrain: 'flat', character: 'xbot',
    spawn: { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, clip: null, variation: on,
    events: T.map((t) => ({ t, type: 'hit', hit: { type: 'push', body: 'Spine2', direction: D[dir], magnitude: Number.isNaN(Number(dv)) ? dv : Number(dv) } })),
    cameras: ['side'], expect: {},
  } as unknown as Scenario;
  const r = await runAndWrite(sc);
  console.log(`== 변주 ${on ? '켬' : '끔'} (넘어짐 ${r.summary.fell})`);
  for (const t of T) {
    const ev = r.meta.events.filter((e) => e.t >= t && e.t < t + 3.5);
    const react = ev.find((e) => e.type === 'reactionStart')?.detail?.split(' ')[1] ?? '-';
    const steps = ev.filter((e) => e.type === 'stepStart');
    console.log(`  ${t}초: 반응 클립 ${react} · 첫 디딤 ${steps[0]?.body ?? steps[0]?.detail ?? '-'} · 걸음 시작 ${steps.length}`);
  }
}
