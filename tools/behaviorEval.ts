// 행동·피격 평가 (v0.5a): 시나리오 × '근처 입력'(시드 2~N: 세기 ±5%, 방향 ±5°, 맞는 점 ±1cm)을 돌려 통과·넘어짐·걸음·움켜쥐기 지표를 표로.
// 설정 덮어쓰기 SET="h.HoldWound.reachTime=0.3;m.bullet.pointShare=0.2;s.maxSteps=3;b.wb.torso.kp=30" (h = behaviors.json, m = hitModel.json, s = stepping.json, b = balance.json)
// 사용법: npx tsx tools/behaviorEval.ts [--sweep 8] [--v05a] [시나리오...]
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';
import { runScenario } from '../src/sim/runner';
import hcfg from '../config/behaviors.json';
import mcfg from '../config/hitModel.json';
import scfg from '../config/stepping.json';
import bcfg from '../config/balance.json';

const cfgs: Record<string, Record<string, unknown>> = { h: JSON.parse(JSON.stringify(hcfg)), m: JSON.parse(JSON.stringify(mcfg)), s: JSON.parse(JSON.stringify(scfg)), b: JSON.parse(JSON.stringify(bcfg)) };
for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
  const i = kv.indexOf('=');
  const path = kv.slice(0, i).split('.');
  let o = cfgs[path[0]!]!;
  for (const p of path.slice(1, -1)) o = o[p] as Record<string, unknown>;
  o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
}
const argv = process.argv.slice(2);
const wi = argv.indexOf('--sweep');
const N = wi >= 0 ? Number(argv[wi + 1]) : 6;
const V05A = ['shot_chest_stagger_clutch', 'shot_shoulder_spin', 'hit_bullet_chest', 'hit_bullet_shoulder', 'hit_bullet_thigh', 'hit_bullet_head', 'hit_melee_side', 'hit_melee_back', 'injured_leg_push', 'look_at_threat'];
const names = argv.filter((a, k) => !(k === wi || k === wi + 1) && !a.startsWith('--'));
const list = argv.includes('--v05a') ? V05A : names.length ? names : ['shot_chest_stagger_clutch'];
let pass = 0, total = 0, falls = 0;
const f = (x: number | undefined, d = 2) => (x === undefined ? '-' : x.toFixed(d));
for (const n of list) {
  const cells: string[] = [];
  let rp = 0;
  for (let seed = 1; seed <= N; seed++) {
    const sc = jitterScenario({ ...loadScenario(findScenario(n)), seed }, seed);
    const r = await runScenario({ ...loadInputs(sc), characterOpts: { behaviorsConfig: cfgs.h as never, hitModelConfig: cfgs.m as never, steppingConfig: cfgs.s as never, balanceConfig: cfgs.b as never } });
    const s = r.summary, m = s.metrics;
    total++;
    if (s.fell) falls++;
    if (s.expectations.passed) { pass++; rp++; }
    if (argv.includes('--why') && !s.expectations.passed) console.log(`  ${n} seed ${seed}: ${s.expectations.failures.join('; ')}`);
    cells.push(`${s.expectations.passed ? 'P' : 'x'}${s.fell ? 'F' : ''}${s.exploded ? 'E' : ''}/${s.stepsTaken}/r${f(m.clutchReachTime)}/h${f(m.clutchHoldTime, 1)}/m${f(m.clutchMoveOnset)}`);
  }
  console.log(`${n.padEnd(26)} ${rp}/${N}  ${cells.join('  ')}`);
}
console.log(`pass ${pass}/${total} falls ${falls}  SET=${process.env.SET ?? ''}`);
