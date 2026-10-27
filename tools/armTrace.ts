// 팔 추적 (2026-10-27 진단): out/<시나리오>/log.jsonl에서 0.1초마다 팔 들림(위팔-몸통 아래축 각)·팔꿈치·몸통 기울기·스텝 상태·행동을 보인다.
// 사용법: npx tsx tools/armTrace.ts <시나리오 또는 out 경로> [--from 0.9] [--to 4]
import { readFileSync, existsSync } from 'node:fs';
import { armAngles } from './armMetrics';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { Quat } from '../src/sim/math/quat';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const p = existsSync(`${argv[0]}/log.jsonl`) ? `${argv[0]}/log.jsonl` : `out/${argv[0]}/log.jsonl`;
const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const from = Number(opt('--from', '0.9')), to = Number(opt('--to', '4'));
let last = -1;
for (const s of lines) {
  if (s.time < from - 1e-6 || s.time > to + 1e-6 || s.time - last < Number(opt('--dt', '0.1')) - 0.001) continue;
  last = s.time;
  const rot = Object.fromEntries(Object.entries(s.bodies as Record<string, { rot: Quat }>).map(([k, b]) => [k, b.rot]));
  const a = armAngles(def, rot);
  const st = s.stepping ? `${s.stepping.state ?? ''}${s.stepping.kind ? '/' + s.stepping.kind : ''}` : '-';
  const beh = (s.behaviors ?? []).map((b: { name: string; weight: number }) => `${b.name}${b.weight.toFixed(1)}`).join(',');
  const c = (j: string) => (s.joints[j]?.coordsDeg as number[]).map((x) => x.toFixed(0)).join('/');
  const r = s.reaction ? ` 반응 ${s.reaction.phase} ${(s.reaction.clip ?? '').replace('react_', '')} τ${(s.reaction.tau ?? 0).toFixed(2)} ${s.reaction.reason}` : '';
  const w = s.walk ? ` | 걷기 e(${s.walk.dcmError.map((x: number) => x.toFixed(2)).join(',')}) L:${s.walk.feet.LeftFoot.mode.slice(0,3)}${s.walk.feet.LeftFoot.s.toFixed(1)} R:${s.walk.feet.RightFoot.mode.slice(0,3)}${s.walk.feet.RightFoot.s.toFixed(1)} rate ${s.walk.rate.toFixed(2)}` : '';
  console.log(`${s.time.toFixed(2)} 들림 L${a.elev.Left.toFixed(0).padStart(3)} R${a.elev.Right.toFixed(0).padStart(3)} 팔꿈치 L${a.elbow.Left.toFixed(0).padStart(3)} R${a.elbow.Right.toFixed(0).padStart(3)} 몸통 ${a.trunk.toFixed(0).padStart(2)}° | LArm ${c('LeftArm')} RArm ${c('RightArm')} | ${st} ${s.balance?.strategy ?? ''} ${beh}${r}${w}`);
}
