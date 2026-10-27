// 걷기 추종 평가 (v0.6): npx tsx tools/walkEval.ts [시나리오...] [SET="walk.wLin=5;walk.torso.weight=100"]
// CLIP=이름=경로: 클립 바꿔 끼우기. OUT=1: 로그를 out/<시나리오>__v<n>/에 저장. VAR=n: 넘기는 시각을 0.13초씩 늦춘 변형 n개. config/animDriver.json 값을 덮어써서(SET, ;로 여러 개, 여러 SET은 | 로 나눠 각각) 시나리오를 돌리고 핵심 지표를 표로 찍는다. 파일은 쓰지 않는다.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { stringifyRounded } from '../src/sim/logger';
import { runScenario } from '../src/sim/runner';
import { findScenario, loadScenario, loadInputs } from './simCommon';
import type { AnimConfig } from '../src/sim/api';

const args = process.argv.slice(2);
const names = args.filter((a) => !a.includes('='));
const sets = (process.env.SET ?? '').split('|');
const base = JSON.parse(readFileSync('config/animDriver.json', 'utf8')) as AnimConfig;
const scen = names.length ? names : ['walk_forward_track', 'walk_back_track'];
const setPath = (o: Record<string, unknown>, path: string, v: unknown) => {
  const ks = path.split('.');
  let c = o;
  for (const k of ks.slice(0, -1)) c = c[k] as Record<string, unknown>;
  c[ks[ks.length - 1]!] = v;
};
for (const set of sets) {
  const cfg = JSON.parse(JSON.stringify(base)) as AnimConfig;
  for (const kv of set.split(';').filter((x) => x.trim())) {
    const [k, v] = kv.split('=');
    setPath(cfg as unknown as Record<string, unknown>, k!.trim(), JSON.parse(v!));
  }
  const row: string[] = [set || '(기본)'];
  const variants = Number(process.env.VAR ?? 1);
  for (const n of scen) for (let vi = 0; vi < variants; vi++) {
    const sc = loadScenario(findScenario(n));
    // 변형: 넘기는 시각(setState)을 0.13초씩 늦춰 다른 위상에서 시작 (견고성)
    if (vi) sc.events = sc.events.map((e) => (e.type === 'setState' ? { ...e, t: e.t + 0.13 * vi } : e));
    // CLIP=<클립 이름>=<경로>: 그 이름의 클립을 파일로 바꿔 끼운다 (Kimodo 후보 물리 추종성 평가)
    const animClips = process.env.CLIP ? Object.fromEntries(process.env.CLIP.split(',').map((kv) => { const [k, p] = kv.split('='); return [k!, JSON.parse(readFileSync(p!, 'utf8'))]; })) : undefined;
    const r = await runScenario({ ...loadInputs(sc), characterOpts: { animConfig: cfg, animClips } });
    const m = r.summary.metrics;
    if (process.env.OUT) {
      // CLIP=이름=경로: 클립 바꿔 끼우기. OUT=1: out/<시나리오>__v<변형>/ 에 로그 저장 (walkTrace·film으로 보기)
      const d = `out/${n}__v${vi}`;
      mkdirSync(d, { recursive: true });
      writeFileSync(`${d}/log.jsonl`, r.log);
      writeFileSync(`${d}/meta.json`, stringifyRounded({ ...r.meta, scenario: `${n}__v${vi}` }, 2));
      writeFileSync(`${d}/summary.json`, stringifyRounded(r.summary, 2));
    }
    row.push(`${n}#${vi}: ${r.summary.expectations.passed ? 'PASS' : 'FAIL'} eng ${(m.walkEngagedFrac ?? 0).toFixed(2)} dist ${(m.walkDistance ?? 0).toFixed(1)} pose ${(m.clipPoseErrDeg ?? 0).toFixed(1)}° com ${(m.clipComErrCm ?? 0).toFixed(1)}cm slip ${(m.walkFootSlidePerStep ?? 0).toFixed(3)} land ${(m.walkLandingErrorMean ?? 0).toFixed(3)} pin ${(m['assistUsage.pin'] ?? 0).toFixed(0)}`);
  }
  console.log(row.join('\n   '));
}
