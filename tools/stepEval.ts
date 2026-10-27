// 스텝 튜닝 평가 (v0.4): 시나리오 묶음 × 시드 여러 개를 돌려 넘어짐·회복·걸음 수를 집계한다. 설정 덮어쓰기 SET="s.a.b=1;b.c=2" (s = stepping.json, b = balance.json).
// 칸: P/x = 시나리오 기대값 통과/실패, F시각 = 넘어짐, R초 = 회복, S = 회복 못 함, /걸음/e착지 오차 cm/s발 미끄럼 cm.
// 사용법: npx tsx tools/stepEval.ts [--seeds 1,2,3 | --sweep 5] [--v04] [--first] [시나리오...]
import { findScenario, loadScenario, loadInputs, jitterScenario, addRefSimilarity } from './simCommon';
import { runScenario } from '../src/sim/runner';
import { checkExpect } from '../src/sim/scenario';
import bcfg from '../config/balance.json';
import scfg from '../config/stepping.json';

const bc = JSON.parse(JSON.stringify(bcfg)), stc = JSON.parse(JSON.stringify(scfg));
for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
  const i = kv.indexOf('=');
  const path = kv.slice(0, i).split('.');
  let o: Record<string, unknown> = path[0] === 's' ? stc : bc;
  for (const p of path.slice(1, -1)) o = o[p] as Record<string, unknown>;
  o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
}
const argv = process.argv.slice(2);
const si = argv.indexOf('--seeds');
// --sweep N = 시드 1..N, --jitter = 시드 2부터 밀기 세기 ±5%·방향 ±5° (시드 견고성 스윕), --v04 = v0.4 시나리오 전부, --first = 칸에 첫 스텝 발·시각도 표시
const wi = argv.indexOf('--sweep');
const seeds = wi >= 0 ? Array.from({ length: Number(argv[wi + 1]) }, (_, k) => k + 1) : si >= 0 ? argv[si + 1]!.split(',').map(Number) : [1, 2, 3];
const showFirst = argv.includes('--first');
const jitter = argv.includes('--jitter');
const withRef = argv.includes('--ref');
const armRatios: number[] = [];
const V04 = ['push_front_medium', 'push_back_medium', 'push_left_medium', 'push_right_medium', 'push_diag_medium', 'push_front_small', 'push_back_small', 'push_twice', 'push_while_stepping', 'push_left_crossstep'];
const names = argv.filter((a, k) => !(k === si || k === si + 1 || k === wi || k === wi + 1) && !a.startsWith('--'));
const list = argv.includes('--v04') ? [...V04, ...names] : names.length ? names : V04.slice(0, 7);
const landErr: number[] = [];
let score = 0, falls = 0, recs = 0, total = 0, passes = 0, withExpect = 0;
const rows: string[] = [];
for (const n of list) {
  const cells: string[] = [];
  let rowPass = 0, rowExp = 0;
  for (const seed of seeds) {
    // 'push:<방향>:<Δv>' = push_front_medium을 바탕으로 방향(front/back/left/right/fl/fr/bl/br)·세기만 바꾼 합성 시나리오 (튜닝 견고성 확인용)
    let sc = { ...loadScenario(findScenario(n.startsWith('push:') ? 'push_front_medium' : n)), seed };
    if (n.startsWith('push:')) {
      const [, d, m] = n.split(':');
      const D: Record<string, [number, number, number]> = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], fl: [0.7071, 0, 0.7071], fr: [-0.7071, 0, 0.7071], bl: [0.7071, 0, -0.7071], br: [-0.7071, 0, -0.7071] };
      sc = { ...sc, name: n, events: [{ t: 1.0, type: 'hit', hit: { type: 'push', body: 'Spine2', direction: D[d!]!, magnitude: Number(m) } }] };
    }
    if (jitter) sc = jitterScenario(sc, seed);
    const r = await runScenario({ ...loadInputs(sc), characterOpts: { balanceConfig: bc, steppingConfig: stc } });
    const s = r.summary;
    // --ref: 시드 1에서 사람 레퍼런스 팔 사용량 비율(refArmRatio, 1 = 사람과 같음)을 모은다
    if (withRef && seed === seeds[0] && sc.reference) { await addRefSimilarity(sc, r); const a = s.metrics.refArmRatio; if (typeof a === 'number') armRatios.push(a); }
    total++;
    if (s.fell) falls++;
    if (s.recoveredAfterHit !== null) recs++;
    // 점수: 안 넘어짐 10, 회복 5 (+ 빠를수록 최대 3), 걸음 수 2~3이면 2, 착지 오차 작으면 1
    let sc1 = 0;
    if (!s.fell && !s.exploded) sc1 += 10;
    if (s.recoveredAfterHit !== null) sc1 += 5 + Math.max(0, 3 - s.recoveredAfterHit);
    const st = s.stepsTaken ?? 0;
    if (!s.fell && st >= 1 && st <= 3) sc1 += 2;
    if ((s.metrics.landingErrorMean ?? 1) < 0.05) sc1 += 1;
    score += sc1;
    const fails = sc.expect && !n.startsWith('push:') ? checkExpect(sc.expect, s) : null;
    if (fails) { withExpect++; rowExp++; if (!fails.length) { passes++; rowPass++; } }
    for (const e of r.meta.events) if ((e.type === 'step' || e.type === 'footReplace') && typeof e.error === 'number') landErr.push(e.error);
    const f0 = r.meta.events.find((e) => e.type === 'stepStart');
    cells.push(`${fails ? (fails.length ? 'x' : 'P') : ''}${s.fell ? 'F' + (s.fallTime ?? 0).toFixed(1) : s.recoveredAfterHit !== null ? 'R' + s.recoveredAfterHit.toFixed(1) : 'S'}/${st}/e${Math.round((s.metrics.landingErrorMean ?? 0) * 100)}/s${Math.round((s.metrics.footSlide ?? 0) * 100)}${showFirst && f0 ? `/${(f0.body ?? '?')[0]}${f0.t.toFixed(2)}` : ''}`);
  }
  rows.push(`${n.padEnd(20)} ${rowExp ? `${rowPass}/${rowExp}`.padEnd(5) : ''} ${cells.join('  ')}`);
}
console.log(rows.join('\n'));
console.log(`score ${score.toFixed(1)}  pass ${passes}/${withExpect}  falls ${falls}/${total}  recovered ${recs}/${total}  landErr ${(landErr.reduce((a, b) => a + b, 0) / Math.max(1, landErr.length)).toFixed(3)} (n ${landErr.length})${armRatios.length ? `  arm×ref ${armRatios.map((a) => a.toFixed(1)).join(',')}` : ''}  SET=${process.env.SET ?? ''}`);
