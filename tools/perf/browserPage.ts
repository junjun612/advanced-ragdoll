// (README 결정 game-4) 브라우저 1명당 비용 측정 페이지 (tools/perfBrowser.ts가 esbuild로 묶어 Chromium에서 돈다). 앱과 같은 src/sim/api.ts.
import { World, type CharacterDef, type RagdollConfig } from '../../src/sim/api';
import xbot from '../../config/characters/xbot.json';
import ragdoll from '../../config/ragdoll.json';

declare global { interface Window { runPerf: (scene: string, n: number, warm: number, measure: number) => Promise<{ msPerStep: number; msPerChar: number; p95: number }> } }

window.runPerf = async (scene, n, warm, measure) => {
  const w = await World.create({ seed: 1 });
  const chars = Array.from({ length: n }, (_, i) => {
    const pos: [number, number, number] = [i * 2.5, 0, 0];
    const spawn = scene === 'stand' ? { position: pos, yaw: 0, state: 'Active' as const, pose: 'stand' } : { position: pos, yaw: 0, state: 'Animated' as const, pose: 'kimodo_walk_forward' };
    return w.addCharacter(xbot as unknown as CharacterDef, ragdoll as unknown as RagdollConfig, spawn, n > 1 ? { name: `C${i}` } : {});
  });
  const per: number[] = [];
  const total = Math.round((warm + measure) * 120);
  for (let k = 0; k < total; k++) {
    if (scene === 'walk' && k === 36) for (const c of chars) c.setState('Active');
    if (scene === 'stand' && k === 120) for (const c of chars) c.hit({ type: 'push', body: 'Spine2', direction: [0, 0, -1], magnitude: 'small' });
    const a = performance.now();
    w.step();
    const b = performance.now();
    if (k / 120 >= warm) per.push(b - a);
  }
  w.free();
  const s = [...per].sort((x, y) => x - y);
  const mean = per.reduce((x, y) => x + y, 0) / per.length;
  return { msPerStep: mean, msPerChar: mean / n, p95: s[Math.floor(s.length * 0.95)]! };
};
