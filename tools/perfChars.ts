// (README 결정 game-4) 1명당 비용: 캐릭터 1·2·4·8명 월드에서 스텝당 ms (Node). 장면 = stand(서 있음, 1초 뒤 모두 small 밀기) | walk(걷기 클립 Active 추종) | anim(키네마틱 Animated 걷기).
// 캐릭터는 2.5 m 간격 줄(서로 닿지 않음). 앞 warm초는 JIT 예열로 버리고 measure초를 잰다. --prof면 node --cpu-prof로 다시 돌려 자기 시간 상위 함수를 낸다.
// 사용법: npx tsx tools/perfChars.ts [--counts 1,2,4,8] [--scenes stand,walk,anim] [--warm 1] [--measure 4] [--json out/perf_chars.json]
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../src/sim/api';
import { findScenario, loadInputs, loadScenario } from './simCommon';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const counts = opt('--counts', '1,2,4,8').split(',').map(Number);
const scenes = opt('--scenes', 'stand,walk,anim').split(',');
const warm = Number(opt('--warm', '1')), measure = Number(opt('--measure', '4'));
const inp = loadInputs(loadScenario(findScenario('push_front_small')));

export async function measureScene(scene: string, n: number): Promise<{ msPerStep: number; msPerChar: number; p95: number }> {
  const w = await World.create({ seed: 1 });
  const chars = Array.from({ length: n }, (_, i) => {
    const pos: [number, number, number] = [i * 2.5, 0, 0];
    const spawn = scene === 'stand' ? { position: pos, yaw: 0, state: 'Active' as const, pose: 'stand' } : { position: pos, yaw: 0, state: 'Animated' as const, pose: 'kimodo_walk_forward' };
    return w.addCharacter(inp.character, inp.ragdoll, spawn, n > 1 ? { name: `C${i}` } : {});
  });
  const per: number[] = [];
  const total = Math.round((warm + measure) * 120);
  for (let k = 0; k < total; k++) {
    const t = k / 120;
    if (scene === 'walk' && k === 36) for (const c of chars) c.setState('Active');
    if (scene === 'stand' && k === 120) for (const c of chars) c.hit({ type: 'push', body: 'Spine2', direction: [0, 0, -1], magnitude: 'small' });
    const a = performance.now();
    w.step();
    const b = performance.now();
    if (t >= warm) per.push(b - a);
  }
  w.free();
  const s = [...per].sort((x, y) => x - y);
  const mean = per.reduce((x, y) => x + y, 0) / per.length;
  return { msPerStep: mean, msPerChar: mean / n, p95: s[Math.floor(s.length * 0.95)]! };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/perfChars.ts');
if (isMain) {
  const rows: { scene: string; n: number; msPerStep: number; msPerChar: number; p95: number }[] = [];
  console.log('| 장면 | 인원 | ms/스텝 | ms/명 | p95 ms/스텝 | 실시간 여유 (8.33ms 예산 대비) |');
  console.log('|---|---|---|---|---|---|');
  for (const scene of scenes) for (const n of counts) {
    const r = await measureScene(scene, n);
    rows.push({ scene, n, ...r });
    console.log(`| ${scene} | ${n} | ${r.msPerStep.toFixed(3)} | ${r.msPerChar.toFixed(3)} | ${r.p95.toFixed(3)} | ${(8.333 / r.msPerStep).toFixed(1)}× |`);
  }
  const out = opt('--json', 'out/perf_chars.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, rows }, null, 2));
}
