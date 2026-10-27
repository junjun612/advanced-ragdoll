// 이전·이후 비교표 (2026-10-27): 두 out 폴더의 같은 시나리오 로그·요약에서 팔 자연스러움·몸통·걸음·넘어짐·착지 오차·사람 레퍼런스 팔 비율을 나란히.
// 사용법: npx tsx tools/armCompare.ts <이전 out 폴더> <이후 out 폴더> 시나리오...
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { armStats, logToArmFrames } from './armMetrics';
import type { CharacterDef } from '../src/sim/character/characterDef';

const [a, b, ...names] = process.argv.slice(2);
const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const row = (dir: string, n: string) => {
  const d = join(dir, n);
  if (!existsSync(join(d, 'log.jsonl'))) return null;
  const s = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8'));
  const m = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8'));
  const hitT = (m.events as { type: string; t: number }[]).find((e) => e.type === 'hit')?.t ?? 0;
  const arm = armStats(def, logToArmFrames(readFileSync(join(d, 'log.jsonl'), 'utf8')), hitT, 2.5);
  return { pass: s.expectations.passed, fell: s.fell, steps: s.stepsTaken, land: s.metrics.landingErrorMean, ref: s.metrics.refArmRatio, trunkRef: s.metrics.refTrunkPeakDeg, arm };
};
const f = (x: number | undefined | null, d = 0) => (typeof x === 'number' ? x.toFixed(d) : '-');
console.log('| 시나리오 | 통과 | 넘어짐 | 걸음 | 착지 오차 cm | 팔/사람 | 팔 들림 p90 ° | 40° 넘는 비율 (1초 뒤) | 팔꿈치 ° | 몸통 최대 ° (사람) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const n of names) {
  const x = row(a!, n), y = row(b!, n);
  if (!x || !y) { console.log(`| ${n} | 로그 없음 |`); continue; }
  const c = (p: unknown, q: unknown) => `${p} → ${q}`;
  console.log(`| ${n} | ${c(x.pass ? '통과' : '실패', y.pass ? '통과' : '실패')} | ${c(x.fell ? '예' : '아니오', y.fell ? '예' : '아니오')} | ${c(x.steps, y.steps)} | ${c(f((x.land ?? NaN) * 100, 1), f((y.land ?? NaN) * 100, 1))} | ${c(f(x.ref, 2), f(y.ref, 2))} | ${c(f(x.arm.elevP90), f(y.arm.elevP90))} | ${c(`${f(x.arm.outFrac * 100)}% (${f(x.arm.lateOut * 100)}%)`, `${f(y.arm.outFrac * 100)}% (${f(y.arm.lateOut * 100)}%)`)} | ${c(f(x.arm.elbowMean), f(y.arm.elbowMean))} | ${c(f(x.arm.trunkPeak), f(y.arm.trunkPeak))} (${f(x.trunkRef)}) |`);
}
