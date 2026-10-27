// 공중·바닥 행동 타임라인 (v0.5c): npx tsx tools/airTrace.ts <시나리오> [간격초=0.1] [시작] [끝]
// out/<시나리오>/log.jsonl을 읽어 시각마다 자세, COM 높이·속도, 공중 신호(공중·착지 예측), 지면 접촉 바디, 활성 행동(가중치·단계)을 한 줄로 찍는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, stepS = '0.1', fromS = '0', toS = '1e9'] = process.argv.slice(2);
if (!name) { console.error('usage: npx tsx tools/airTrace.ts <scenario> [interval] [from] [to]'); process.exit(2); }
const lines = readFileSync(join('out', name, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const every = Number(stepS), from = Number(fromS), to = Number(toS);
let next = from;
const f2 = (x: number) => x.toFixed(2);
for (const s of lines) {
  if (s.time + 1e-6 < next || s.time > to) continue;
  next = s.time + every - 1e-6;
  const a = s.behavior?.air;
  const air = a ? `${a.airborne ? '공중' : a.contact ? '접촉' : '뜸'} ttg=${a.timeToGround === null ? '-' : f2(a.timeToGround)} vH=${f2(a.touchdownSpeedH)} low=${a.lowestBody ?? '-'}` : '';
  const g = [...new Set((s.contacts ?? []).map((c: { body: string }) => c.body))].join(',');
  const beh = (s.behavior?.active ?? []).filter((b: { weight: number }) => b.weight > 0.01).map((b: { name: string; weight: number; phase: string }) => `${b.name}${b.weight < 0.99 ? f2(b.weight) : ''}${b.phase ? `(${b.phase})` : ''}`).join(' ');
  const v = s.comVel;
  console.log(`${f2(s.time)} ${s.posture.padEnd(8)} h=${f2(s.com[1])} v=${f2(Math.hypot(v[0], v[2]))}/${f2(v[1])} z=${f2(s.com[2])} | ${air} | ${g} | ${beh}`);
}
