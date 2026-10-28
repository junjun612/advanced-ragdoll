// 진정 단계 타임라인 (README 결정 settle-1~): sim 로그(log.jsonl)를 0.033초마다 한 줄로 — 스텝 상태·걸음 수·DCM 여유·COM 속도·넘어짐 확실도·
// 반응 스타일 가중치·위험도·진정 상태·팔 들림(좌/우)·몸통 기울기.
// 사용법: npx tsx tools/settleTrace.ts <log.jsonl> [--every 2]
import { readFileSync } from 'node:fs';
import { armAngles } from './armMetrics';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { Quat } from '../src/sim/math/quat';

const argv = process.argv.slice(2);
const every = argv.includes('--every') ? Number(argv[argv.indexOf('--every') + 1]) : 1;
const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const lines = readFileSync(argv[0]!, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
lines.forEach((s, i) => {
  if (i % every) return;
  const rot = Object.fromEntries(Object.entries(s.bodies as Record<string, { rot: Quat }>).map(([k, b]) => [k, b.rot]));
  const a = armAngles(def, rot);
  const st = s.stepping ?? {}, b = s.balance ?? {}, r = s.reaction ?? {}, se = b.settle;
  const f = (x: number | undefined, d = 2) => (x === undefined || x === null ? '-' : x.toFixed(d));
  console.log(`${f(s.time)} ${String(st.state ?? '-').padEnd(6)} n${st.stepCount ?? 0} cpM ${f(b.cpMargin, 3)} v ${f(Math.hypot(s.comVel[0], s.comVel[2]))} fall ${f(s.behavior?.fall?.certainty ?? 0)} sw ${f(r.style?.w ?? 0)} dg ${f(b.armDanger ?? 0)} L ${a.elev.Left.toFixed(0)} R ${a.elev.Right.toFixed(0)} tr ${a.trunk.toFixed(0)}${se ? ` 진정 ${f(se.level)} ${se.phase}` : ''}`);
});
