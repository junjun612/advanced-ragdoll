// 걷기 발 미끄러짐 분해 (v0.6): npx tsx tools/walkSlip.ts <시나리오> — 추종 중 발 접촉점 미끄러짐(m)을 발 모드/접촉 방식별로 합한다
import { readFileSync } from 'node:fs';
const name = process.argv[2];
if (!name) { console.error('usage: npx tsx tools/walkSlip.ts <scenario>'); process.exit(2); }
const L = readFileSync(`out/${name}/log.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const acc: Record<string, [number, number]> = {};
let prev: number | null = null;
for (const s of L) {
  const dt = prev === null ? 0 : s.time - prev; prev = s.time;
  if (!s.walk?.engaged) continue;
  for (const f of ['LeftFoot', 'RightFoot']) {
    const cps = s.contacts.filter((c: { body: string }) => c.body === f);
    if (!cps.length) continue;
    const pc = [0, 0, 0];
    for (const c of cps) for (let i = 0; i < 3; i++) pc[i]! += c.point[i] / cps.length;
    const b = s.bodies[f], r = [pc[0]! - b.pos[0], pc[1]! - b.pos[1], pc[2]! - b.pos[2]], w = b.angVel, v = b.linVel;
    const sp = Math.hypot(v[0] + (w[1] * r[2]! - w[2] * r[1]!), v[2] + (w[0] * r[1]! - w[1] * r[0]!));
    const k = `${s.walk.feet[f].mode}/${s.walk.feet[f].contact}`;
    acc[k] ??= [0, 0]; acc[k][0] += sp * dt; acc[k][1]++;
  }
}
for (const [k, [d, n]] of Object.entries(acc)) console.log(`${k.padEnd(16)} ${d.toFixed(3)} m  (${n} 프레임, 평균 ${(d / Math.max(1e-9, n * (1 / 30))).toFixed(3)} m/s)`);
