// 첫 걸음 동안 COM 가속 원인 추적 (결정 onset-*): 충격 뒤 0.5초를 1/60초마다
//   COM 수평 속도(밀린 방향 성분), 실제 수평 지면력(m·dv/dt, 밀린 방향 성분), QP 원하는 피드백 힘(virtualForce)·QP 접촉 합력(achievedForce),
//   COM 둘레 각운동량(밀린 방향 회전 성분), Spine2 기울기, 스텝 단계를 찍는다.
// 사용법: SET=... npx tsx tools/onsetTrace.ts <시나리오> [시드]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rotate, type Quat } from '../src/sim/math/quat';
import { cross, type Vec3 } from '../src/sim/math/vec3';

const [name, seedS] = process.argv.slice(2);
const seed = Number(seedS ?? '1');
const DEG = 180 / Math.PI;
function cfgs(): Record<string, unknown> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const poses: Record<string, unknown> = {};
  for (const f of readdirSync('config/poses')) if (f.endsWith('.json')) poses[f.replace(/\.json$/, '')] = rd(join('config/poses', f));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), r: rd('config/reaction.json'), p: poses };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c;
}
async function main(): Promise<void> {
  const { runScenario } = await import('../src/sim/runner');
  const { findScenario, loadScenario, loadInputs, jitterScenario } = await import('./simCommon');
  const c = cfgs() as Record<string, never>;
  const sc = jitterScenario({ ...loadScenario(findScenario(name!)), seed }, seed);
  const hit = sc.events.find((e) => e.type === 'hit')!;
  const t0 = hit.t;
  const d0 = (hit as { hit?: { direction?: number[] } }).hit?.direction ?? [1, 0, 0];
  const dn = Math.hypot(d0[0]!, d0[2]!) || 1;
  const dir: Vec3 = [d0[0]! / dn, 0, d0[2]! / dn];
  const axis = cross([0, 1, 0], dir); // 밀린 쪽으로 넘어지는 회전 축 (위 × 방향)
  let prevV: Vec3 | null = null, mass = 0, last = -1;
  console.log('t | 단계 | COM v | 지면력 실제 | 원하는 피드백 | QP 합력 | 각운동량(넘어짐+) | 몸통° | 고관절w');
  await runScenario({
    ...loadInputs(sc),
    characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, poses: c.p, reactionConfig: c.r },
    observe: {
      step: (w) => {
        const ch = w.characters[0]!;
        const t = w.time - t0;
        const com = ch.rd.com();
        if (!mass) mass = ch.rd.bodies.reduce((a, b) => a + b.rb.mass(), 0);
        const v = com.vel as Vec3;
        const F = prevV ? (v[0] - prevV[0]) * mass / w.dt * dir[0] + (v[2] - prevV[2]) * mass / w.dt * dir[2] : 0;
        prevV = [...v];
        if (t < -0.02 || t > 0.5) return;
        if (Math.floor(t * 60) === last) return;
        last = Math.floor(t * 60);
        const bs = ch.balance.state, ss = ch.stepping.state;
        const pd = (x: Vec3 | undefined) => (x ? x[0] * dir[0] + x[2] * dir[2] : NaN);
        const q = ch.rd.body('Spine2').rb.rotation();
        const tilt = Math.acos(Math.max(-1, Math.min(1, rotate([q.x, q.y, q.z, q.w] as Quat, [0, 1, 0])[1]))) * DEG;
        const L = bs.angularMomentum ? bs.angularMomentum[0] * axis[0] + bs.angularMomentum[1] * axis[1] + bs.angularMomentum[2] * axis[2] : NaN;
        console.log(`${t.toFixed(3)} | ${ss.state}/${ss.phase ?? '-'} | ${pd(v).toFixed(2)} | ${F.toFixed(0)} | ${pd(bs.virtualForce).toFixed(0)} | ${pd(bs.achievedForce).toFixed(0)} | ${L.toFixed(1)} | ${tilt.toFixed(0)} | ${bs.hipWeight.toFixed(2)}`);
      },
    },
  });
}
void main();
