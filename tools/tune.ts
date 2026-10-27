// v0.9 자동 튜닝 (SPEC 12장, README 결정 9t-1~). CMA-ES(tools/tune/cmaes.ts, 직접 구현) + worker_threads 병렬 평가.
// 사용법:
//   npx tsx tools/tune.ts targets                         현재 수치 + 사람 레퍼런스 → config/qualityTargets.json
//   npx tsx tools/tune.ts run <run> [--gens 12] [--tier primary|later|all] [--workers N] [--resume]
//                                                         학습(세대마다 다른 근처 입력 시드) → 검증(다른 시드·다른 충격 크기·학습에 없는 시나리오)
//                                                         → config/tuned/<run>.json (기본 설정은 바꾸지 않는다)
//   npx tsx tools/tune.ts validate <run>                  검증 단계만 다시
//   npx tsx tools/tune.ts check <run>                     튜닝 값으로 sim:all 시나리오 전체(시드 1) → out/tune/<run>/after/<시나리오>/, 기본값 out/<시나리오>와 비교
//   npx tsx tools/tune.ts report <run> [--films a,b,c]    지표 표 + 이전·이후 필름스트립 → out/tune/<run>/report.md
// 진행 상황·최고 기록: out/tune/<run>/{progress.jsonl, candidates.jsonl, state.json, best.json, validation.json}
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CmaEs, type CmaState } from './tune/cmaes';
import { decode, encode, repair, constraintViolation, readPath, type TuneParam, type TuneConstraint } from './tune/space';
import { baseConfigs, humanArm, resolveRefs, type EvalJob, type EvalRow } from './tune/evaluate';
import { listScenarioFiles, loadScenario } from './simCommon';
import { checkExpect, type Scenario } from '../src/sim/scenario';
import type { Summary } from '../src/sim/types';

interface Space {
  params: TuneParam[]; constraints: TuneConstraint[];
  objective: Record<string, number>;
  train: { scenarios: string[]; seedsPerGen: number; seedBase: number };
  validation: { seeds: number; seedBase: number; magScale: number[]; holdout: string[]; holdoutSeeds: number };
  refs: Record<string, string[]>;
  cma: { sigma0: number; seed: number };
  workersFraction: number; validateTop: number;
}
interface Targets { metrics: Record<string, { target: number; gate?: number | null; human?: number | null; current?: number | null }> }

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const space = JSON.parse(readFileSync('config/tuneSpace.json', 'utf8')) as Space;
const W = space.objective;
// 시험용 축소 (--seeds 학습 시드 수, --vseeds 검증 시드 수, --top 검증 후보 수)
if (argv.includes('--seeds')) space.train.seedsPerGen = Number(opt('--seeds', '4'));
if (argv.includes('--vseeds')) { space.validation.seeds = Number(opt('--vseeds', '6')); space.validation.holdoutSeeds = space.validation.seeds; }
if (argv.includes('--top')) space.validateTop = Number(opt('--top', '5'));

// ───────────────────────── 워커 풀 ─────────────────────────
class Pool {
  private ws: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { id: number; job: EvalJob; res: (r: EvalRow) => void; rej: (e: Error) => void }[] = [];
  private pending = new Map<number, { res: (r: EvalRow) => void; rej: (e: Error) => void }>();
  private nextId = 0;
  done = 0;
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tune/worker.ts', import.meta.url));
      w.on('message', (m: { id: number; row?: EvalRow; error?: string }) => {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        this.done++;
        if (m.error) p.rej(new Error(m.error)); else p.res(m.row!);
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => { console.error('워커 오류', e); });
      this.ws.push(w);
      this.idle.push(w);
    }
  }
  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!, q = this.queue.shift()!;
      this.pending.set(q.id, { res: q.res, rej: q.rej });
      w.postMessage({ id: q.id, job: q.job });
    }
  }
  run(job: EvalJob): Promise<EvalRow> {
    return new Promise((res, rej) => { this.queue.push({ id: this.nextId++, job, res, rej }); this.pump(); });
  }
  /** 실패한 실행은 넘어짐·실패로 취급(폭발과 같은 큰 비용) — 튜닝이 멈추지 않게 */
  async all(jobs: EvalJob[], label: string): Promise<EvalRow[]> {
    const t0 = Date.now();
    let k = 0;
    const tick = setInterval(() => process.stdout.write(`\r  ${label}: ${k}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)}초)   `), 5000);
    const out = await Promise.all(jobs.map((j) => this.run(j).then((r) => { k++; return r; }, (e: Error) => {
      k++;
      console.error(`\n실행 실패 ${j.scenario} 시드 ${j.seed}: ${e.message.split('\n')[0]}`);
      return failRow(j);
    })));
    clearInterval(tick);
    process.stdout.write(`\r  ${label}: ${jobs.length}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)}초)   \n`);
    return out;
  }
  async close(): Promise<void> { await Promise.all(this.ws.map((w) => w.terminate())); }
}

const failRow = (j: EvalJob): EvalRow => ({
  tag: j.tag, scenario: j.scenario, seed: j.seed, mag: j.mag, passed: false, fell: true, mustStand: true, exploded: true, steps: 0, land: null,
  arm: { elevMean: 0, elevP90: 0, outFrac: 0, elbowMean: 0, usage: 0, trunkPeak: 0, lateOut: 0 }, refRms: null, human: null, fails: 'crash', ms: 0,
});

const workers = () => Number(opt('--workers', String(Math.max(1, Math.floor(availableParallelism() * space.workersFraction)))));

// ───────────────────────── 목적 함수 ─────────────────────────
let targets: Targets | null = null;
const loadTargets = (): Targets => {
  if (!existsSync('config/qualityTargets.json')) throw new Error('config/qualityTargets.json 없음 — 먼저 npx tsx tools/tune.ts targets');
  return (targets ??= JSON.parse(readFileSync('config/qualityTargets.json', 'utf8')) as Targets);
};
const lnr = (x: number, h: number) => Math.log(Math.max(x, 1e-3) / Math.max(h, 1e-3));

/** 실행 하나의 비용과 항목별 분해 (tuneSpace.json objective 설명 참고) */
export function rowCost(r: EvalRow): { cost: number; parts: Record<string, number> } {
  const T = loadTargets().metrics;
  const h = r.human;
  const p: Record<string, number> = {
    fail: r.passed ? 0 : W.fail!,
    fall: r.fell && r.mustStand ? W.fall! : 0,
    explode: r.exploded ? W.explode! : 0,
    armElev: W.armElev! * Math.max(0, lnr(r.arm.elevP90, h?.elevP90 ?? T.armElevP90!.target)),
    armLate: W.armLate! * Math.max(0, r.arm.lateOut - (h?.lateOut ?? T.armLateOut!.target)),
    armUsage: W.armUsage! * (h ? Math.abs(lnr(r.arm.usage, h.usage)) : Math.max(0, lnr(r.arm.usage, T.armUsage!.target))),
    trunk: W.trunk! * (h ? Math.abs(lnr(r.arm.trunkPeak, h.trunkPeak)) : Math.max(0, lnr(r.arm.trunkPeak, T.trunkPeak!.target))),
    landing: r.land === null ? 0 : (W.landing! * r.land) / W.landingNorm!,
    ref: r.refRms === null ? 0 : (W.ref! * r.refRms) / W.refNorm!,
  };
  return { cost: Object.values(p).reduce((a, b) => a + b, 0), parts: p };
}

export interface Agg { n: number; cost: number; pass: number; fall: number; explode: number; elevP90: number; lateOut: number; usage: number; trunk: number; land: number | null; refRms: number | null; parts: Record<string, number> }
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const median = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };
export function aggregate(rows: EvalRow[], withCost = true): Agg {
  const cs = withCost ? rows.map(rowCost) : rows.map(() => ({ cost: NaN, parts: {} as Record<string, number> }));
  const parts: Record<string, number> = {};
  for (const c of cs) for (const [k, v] of Object.entries(c.parts)) parts[k] = (parts[k] ?? 0) + v / rows.length;
  const must = rows.filter((r) => r.mustStand);
  const lands = rows.map((r) => r.land).filter((x): x is number => x !== null);
  const refs = rows.map((r) => r.refRms).filter((x): x is number => x !== null);
  const ok = rows.filter((r) => !r.fell); // 팔·몸통은 넘어지지 않은 실행만 (넘어짐은 따로)
  return {
    n: rows.length, cost: mean(cs.map((c) => c.cost)), pass: rows.filter((r) => r.passed).length / rows.length,
    fall: must.length ? must.filter((r) => r.fell).length / must.length : 0, explode: rows.filter((r) => r.exploded).length,
    elevP90: median(ok.map((r) => r.arm.elevP90)), lateOut: mean(ok.map((r) => r.arm.lateOut)), usage: median(ok.map((r) => r.arm.usage)), trunk: median(ok.map((r) => r.arm.trunkPeak)),
    land: lands.length ? mean(lands) : null, refRms: refs.length ? mean(refs) : null, parts,
  };
}

// ───────────────────────── 탐색 공간 ─────────────────────────
const tier = (): TuneParam['tier'][] => { const t = opt('--tier', 'primary'); return t === 'all' ? ['primary', 'later'] : [t as TuneParam['tier']]; };
const activeParams = (tiers: string[]) => space.params.filter((p) => tiers.includes(p.tier));
const x0Values = (ps: TuneParam[]) => ps.map((p) => readPath(baseConfigs(), p.path));

function overridesOf(ps: TuneParam[], vals: number[]): Record<string, number> {
  return Object.fromEntries(ps.map((p, i) => [p.path, Number(vals[i]!.toPrecision(5))]));
}

// ───────────────────────── 평가 세트 ─────────────────────────
const job = (scenario: string, seed: number, mag: number, overrides: Record<string, number>, tag: string, saveDir?: string): EvalJob =>
  ({ scenario, seed, mag, overrides, refs: space.refs[scenario] ?? [], window: W.window!, tag, ...(saveDir ? { saveDir } : {}) });

const trainSeeds = (gen: number) => Array.from({ length: space.train.seedsPerGen }, (_, k) => space.train.seedBase + gen * space.train.seedsPerGen + k);
function validationJobs(ov: Record<string, number>, tag: string): EvalJob[] {
  const v = space.validation, out: EvalJob[] = [];
  for (const s of space.train.scenarios) for (const m of v.magScale) for (let k = 0; k < v.seeds; k++) out.push(job(s, v.seedBase + k, m, ov, `${tag}|train-mag`));
  for (const s of v.holdout) for (let k = 0; k < v.holdoutSeeds; k++) out.push(job(s, v.seedBase + k, 1, ov, `${tag}|holdout`));
  return out;
}

// ───────────────────────── run ─────────────────────────
interface Cand { gen: number; k: number; label: string; u: number[]; vals: number[]; f: number; base: number; delta: number; agg: Agg | null }

async function run(name: string): Promise<void> {
  const dir = join('out/tune', name);
  mkdirSync(dir, { recursive: true });
  loadTargets();
  const tiers = tier();
  const ps = activeParams(tiers);
  const gens = Number(opt('--gens', '12'));
  const x0 = x0Values(ps), u0 = encode(ps, x0);
  let es: CmaEs;
  let cands: Cand[] = [];
  const stPath = join(dir, 'state.json');
  if (argv.includes('--resume') && existsSync(stPath)) {
    const st = JSON.parse(readFileSync(stPath, 'utf8')) as { cma: CmaState; cands: Cand[]; tiers: string[] };
    es = CmaEs.fromState(st.cma);
    cands = st.cands;
    console.log(`이어 하기: 세대 ${es.s.gen}부터`);
  } else {
    es = new CmaEs(u0, space.cma.sigma0, { seed: space.cma.seed });
    writeFileSync(join(dir, 'progress.jsonl'), '');
    writeFileSync(join(dir, 'candidates.jsonl'), '');
  }
  writeFileSync(join(dir, 'space.json'), JSON.stringify({ tiers, params: ps, x0: overridesOf(ps, x0), objective: W, train: space.train }, null, 1));
  const nW = workers();
  console.log(`튜닝 ${name}: 파라미터 ${ps.length}개(${tiers.join('+')}), λ=${es.s.lambda}, 세대 ${gens}, 학습 ${space.train.scenarios.length}시나리오 × 시드 ${space.train.seedsPerGen}, 워커 ${nW}`);
  const pool = new Pool(nW);
  try {
    while (es.s.gen < gens) {
      const g = es.s.gen;
      const xs = es.ask();
      // 세대마다: λ 표본 + 지금 평균 + 기본값 (같은 시드 = 공통 난수, 기본값 대비 차로 세대 사이 비교)
      const pts = [...xs.map((u, k) => ({ u, label: `g${g}c${k}` })), { u: es.s.mean, label: `g${g}mean` }, { u: u0, label: `g${g}base` }];
      const evals = pts.map((pt) => {
        const r = repair(pt.u);
        const vals = decode(ps, r.x);
        const viol = constraintViolation(Object.fromEntries(ps.map((p, i) => [p.path, vals[i]!])), space.constraints);
        return { ...pt, r, vals, viol };
      });
      const jobs: EvalJob[] = [];
      for (const e of evals) {
        if (e.viol > 0) continue;
        for (const s of space.train.scenarios) for (const seed of trainSeeds(g)) jobs.push(job(s, seed, 1, overridesOf(ps, e.vals), e.label));
      }
      const rows = await pool.all(jobs, `세대 ${g}`);
      const byTag = new Map<string, EvalRow[]>();
      for (const r of rows) byTag.set(r.tag!, [...(byTag.get(r.tag!) ?? []), r]);
      const fOf = (e: (typeof evals)[number]) => {
        if (e.viol > 0) return { f: W.infeasible! + W.constraintPenalty! * e.viol + W.boundPenalty! * e.r.dist2, agg: null };
        const agg = aggregate(byTag.get(e.label)!);
        return { f: agg.cost + W.boundPenalty! * e.r.dist2, agg };
      };
      const res = evals.map((e) => ({ e, ...fOf(e) }));
      const base = res.at(-1)!.f, meanR = res.at(-2)!;
      es.tell(xs, res.slice(0, xs.length).map((r) => r.f));
      const newC = res.slice(0, xs.length + 1).map((r, k) => ({ gen: g, k, label: r.e.label, u: r.e.u, vals: r.e.vals, f: r.f, base, delta: r.f - base, agg: r.agg }));
      cands.push(...newC);
      for (const c of newC) appendFileSync(join(dir, 'candidates.jsonl'), JSON.stringify({ ...c, overrides: overridesOf(ps, c.vals) }) + '\n');
      const fs = res.slice(0, xs.length).map((r) => r.f);
      const prog = {
        gen: g, sigma: es.s.sigma, cond: es.condition(), seeds: trainSeeds(g), base, mean: meanR.f, best: Math.min(...fs), median: median(fs),
        bestDelta: Math.min(...fs) - base, meanDelta: meanR.f - base, baseAgg: res.at(-1)!.agg, meanAgg: meanR.agg, runs: rows.length, crashes: rows.filter((r) => r.fails === 'crash').length, exploded: rows.filter((r) => r.exploded && r.fails !== 'crash').length, time: new Date().toISOString(),
      };
      appendFileSync(join(dir, 'progress.jsonl'), JSON.stringify(prog) + '\n');
      const best = [...cands].sort((a, b) => a.delta - b.delta)[0]!;
      writeFileSync(join(dir, 'best.json'), JSON.stringify({ label: best.label, delta: best.delta, f: best.f, overrides: overridesOf(ps, best.vals), agg: best.agg }, null, 1));
      writeFileSync(stPath, JSON.stringify({ cma: es.s, cands, tiers }));
      console.log(`세대 ${g}: 기본 ${base.toFixed(3)} 평균점 ${meanR.f.toFixed(3)} (${(meanR.f - base >= 0 ? '+' : '') + (meanR.f - base).toFixed(3)}) 최고 ${prog.best.toFixed(3)} (${prog.bestDelta.toFixed(3)}) 중앙 ${prog.median.toFixed(3)} σ ${es.s.sigma.toFixed(3)} | 기본 넘어짐 ${(res.at(-1)!.agg!.fall * 100).toFixed(0)}% 평균점 넘어짐 ${((meanR.agg?.fall ?? NaN) * 100).toFixed(0)}%`);
    }
    await validate(name, pool);
  } finally {
    await pool.close();
  }
}

// ───────────────────────── validate ─────────────────────────
async function validate(name: string, pool0?: Pool): Promise<void> {
  const dir = join('out/tune', name);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { cma: CmaState; cands: Cand[]; tiers: string[] };
  const ps = activeParams(st.tiers);
  const x0 = x0Values(ps);
  // 검증 후보: 기본값, 마지막 평균점, 기본 대비 학습 개선(delta)이 큰 후보 상위 K (같은 세대 공통 시드 비교라 세대 사이에도 견줄 수 있다)
  const lastMean = decode(ps, repair(st.cma.mean).x);
  // 한 세대 기본값이 운 나쁘게 높으면 그 세대 후보 모두 delta가 좋아 보이므로(시드 혼돈) 세대마다 최대 2개
  const perGen = new Map<number, number>();
  const top = [...st.cands].filter((c) => c.agg).sort((a, b) => a.delta - b.delta).filter((c) => { const n = perGen.get(c.gen) ?? 0; if (n >= 2) return false; perGen.set(c.gen, n + 1); return true; }).slice(0, space.validateTop);
  const list0 = [{ label: 'base', vals: x0 }, { label: `final-mean(g${st.cma.gen})`, vals: lastMean }, ...top.map((c) => ({ label: c.label, vals: c.vals }))];
  const key = (v: number[]) => JSON.stringify(Object.values(overridesOf(ps, v)));
  const list = list0.filter((c, i) => list0.findIndex((d) => key(d.vals) === key(c.vals)) === i); // 같은 값(예: 0세대 평균점 = 기본값)은 한 번만
  const pool = pool0 ?? new Pool(workers());
  const res: VRes[] = [];
  try {
    for (const c of list) {
      const rows = await pool.all(validationJobs(overridesOf(ps, c.vals), c.label), `검증 ${c.label}`);
      const per: Record<string, Agg> = {};
      for (const s of [...new Set(rows.map((r) => r.scenario))]) per[s] = aggregate(rows.filter((r) => r.scenario === s));
      const agg = aggregate(rows);
      res.push({ label: c.label, vals: c.vals, trainDelta: st.cands.find((x) => x.label === c.label)?.delta ?? null, agg, aggTrainMag: aggregate(rows.filter((r) => r.tag!.endsWith('train-mag'))), aggHoldout: aggregate(rows.filter((r) => r.tag!.endsWith('holdout'))), perScenario: per, costs: rows.map((r) => rowCost(r).cost) });
      console.log(`검증 ${c.label}: 비용 ${agg.cost.toFixed(3)} 통과 ${(agg.pass * 100).toFixed(1)}% 넘어짐 ${(agg.fall * 100).toFixed(1)}% 폭발 ${agg.explode}`);
    }
  } finally {
    if (!pool0) await pool.close();
  }
  finalize(name, st, ps, res);
}

type VRes = { label: string; vals: number[]; trainDelta: number | null; agg: Agg; aggTrainMag: Agg; aggHoldout: Agg; perScenario: Record<string, Agg>; costs: number[]; paired?: { diff: number; se: number }; ok?: boolean; why?: string };

/** 검증 결과 → 고르기 → validation.json, config/tuned/<run>.json (select 명령은 시뮬 없이 이것만 다시) */
function finalize(name: string, st: { cma: CmaState; tiers: string[] }, ps: TuneParam[], res: VRes[]): void {
  const dir = join('out/tune', name);
  // 고르기 (README 결정 9t-6): 검증 비용이 가장 낮은 후보 중 ① 학습에 없는 시나리오(holdout) 비용도 기본 이하 ② 넘어짐률이 기본 + gate 여유(qualityTargets fallRate, 2%p) 이하
  // ③ 기본과의 짝지은 차(같은 시나리오·시드·크기)가 표준오차의 1배 넘게 좋음 — 를 모두 만족하는 것. 없으면 기본값(바꾸지 않음)
  const base = res[0]!;
  const fallGate = (loadTargets().metrics.fallRate?.gate ?? 1) - (loadTargets().metrics.fallRate?.current ?? 0);
  for (const r of res.slice(1)) {
    const d = r.costs.map((c, i) => c - base.costs[i]!);
    const m = mean(d), se = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, d.length - 1) / d.length);
    r.paired = { diff: m, se };
    const why = [r.aggHoldout.cost > base.aggHoldout.cost ? `holdout 비용 ${r.aggHoldout.cost.toFixed(2)} > 기본 ${base.aggHoldout.cost.toFixed(2)}` : '', r.agg.fall > base.agg.fall + fallGate ? `넘어짐 ${(r.agg.fall * 100).toFixed(1)}% > 기본 + ${(fallGate * 100).toFixed(0)}%p` : '', -m <= se ? `짝지은 차 ${m.toFixed(3)} ± ${se.toFixed(3)} (1 SE 안)` : ''].filter(Boolean);
    r.ok = why.length === 0;
    r.why = why.join('; ');
    console.log(`  ${r.label}: 짝지은 차 ${m.toFixed(3)} ± ${se.toFixed(3)} ${r.ok ? '채택 가능' : '탈락 — ' + r.why}`);
  }
  const chosen = [base, ...res.slice(1).filter((r) => r.ok)].sort((a, b) => a.agg.cost - b.agg.cost)[0]!;
  writeFileSync(join(dir, 'validation.json'), JSON.stringify({ chosen: chosen.label, results: res.map((r) => ({ ...r, overrides: overridesOf(ps, r.vals) })) }, null, 1));
  mkdirSync('config/tuned', { recursive: true });
  const ov = overridesOf(ps, chosen.vals), b0 = overridesOf(ps, base.vals);
  const changed = Object.fromEntries(Object.entries(ov).filter(([k, v]) => Math.abs(v - b0[k]!) > 1e-9).map(([k, v]) => [k, { from: b0[k], to: v }]));
  const runner = res.filter((r) => r !== chosen && r !== base).sort((x, y) => x.agg.cost - y.agg.cost)[0];
  const pick = (a: Agg) => ({ cost: r3(a.cost), pass: r3(a.pass), fall: r3(a.fall), explode: a.explode, armElevP90: r3(a.elevP90), armLateOut: r3(a.lateOut), armUsage: r3(a.usage), trunkPeak: r3(a.trunk), landing: a.land === null ? null : r3(a.land), refJointRms: a.refRms === null ? null : r3(a.refRms), n: a.n });
  const out = {
    $comment: `v0.9 자동 튜닝 결과 (tools/tune.ts run ${name}). 기본 설정에는 반영하지 않았다 — 반영은 리드가 out/tune/${name}/report.md 필름스트립을 보고 정한다. 적용: overrides의 경로(첫 마디 = config 파일)에 값을 넣는다.`,
    run: name, date: new Date().toISOString().slice(0, 10), tiers: st.tiers, generations: st.cma.gen, evaluations: st.cma.evals,
    chosen: chosen.label, chosenIsBase: chosen.label === 'base',
    overrides: ov, changed,
    $runnerUp: '고르지 않은 후보 중 검증 비용이 가장 낮은 것 — 탈락 이유(why)와 함께. 필름 비교(check --which runnerUp)용',
    runnerUp: runner ? { label: runner.label, why: runner.why, paired: runner.paired, overrides: overridesOf(ps, runner.vals), changed: Object.fromEntries(Object.entries(overridesOf(ps, runner.vals)).filter(([k, v]) => Math.abs(v - b0[k]!) > 1e-9).map(([k, v]) => [k, { from: b0[k], to: v }])), validation: pick(runner.agg), validationHoldout: pick(runner.aggHoldout), validationTrainMag: pick(runner.aggTrainMag) } : null,
    validation: { base: pick(base.agg), chosen: pick(chosen.agg), baseHoldout: pick(base.aggHoldout), chosenHoldout: pick(chosen.aggHoldout), baseTrainMag: pick(base.aggTrainMag), chosenTrainMag: pick(chosen.aggTrainMag) },
  };
  writeFileSync(join('config/tuned', `${name}.json`), JSON.stringify(out, null, 1) + '\n');
  console.log(`고름: ${chosen.label} (검증 비용 ${chosen.agg.cost.toFixed(3)} vs 기본 ${base.agg.cost.toFixed(3)}) → config/tuned/${name}.json`);
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ───────────────────────── check (sim:all 시나리오 전체, 시드 1) ─────────────────────────
async function check(name: string): Promise<void> {
  const tuned = JSON.parse(readFileSync(join('config/tuned', `${name}.json`), 'utf8')) as { overrides: Record<string, number>; runnerUp: { overrides: Record<string, number> } | null };
  const which = opt('--which', 'after'); // after = 고른 값, runnerUp = 탈락한 최저 비용 후보, before = 기본값
  const ov = which === 'after' ? tuned.overrides : which === 'runnerUp' ? tuned.runnerUp!.overrides : {};
  const dir = join('out/tune', name, which);
  const all = listScenarioFiles().map((f) => loadScenario(f));
  const pool = new Pool(workers());
  const rows: { name: string; passed: boolean; fails: string; known: boolean }[] = [];
  try {
    const normal = all.filter((s) => !s.batch);
    const r1 = await pool.all(normal.map((s) => job(s.name, 1, 1, ov, s.name, join(dir, s.name))), `시나리오 ${which}`);
    for (const [i, r] of r1.entries()) rows.push({ name: r.scenario, passed: r.passed, fails: r.fails, known: !!normal[i]!.knownIssue });
    for (const sc of all.filter((s) => s.batch)) rows.push({ name: sc.name, ...(await batchCheck(sc, ov, pool)), known: !!sc.knownIssue });
  } finally {
    await pool.close();
  }
  // 기본값(out/<시나리오>/summary.json, npm run sim:all)과 비교
  const lines: string[] = [];
  let pass = 0, reg = 0, fixed = 0;
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const bp = join('out', r.name, 'summary.json');
    const b = existsSync(bp) ? (JSON.parse(readFileSync(bp, 'utf8')) as Summary).expectations.passed : null;
    if (r.passed) pass++;
    if (b === true && !r.passed) { reg++; lines.push(`회귀 ${r.name}: ${r.fails}`); }
    if (b === false && r.passed) { fixed++; lines.push(`새 통과 ${r.name}`); }
  }
  const summary = { which, pass, total: rows.length, regressions: reg, newlyPassing: fixed, rows };
  writeFileSync(join('out/tune', name, `check_${which}.json`), JSON.stringify(summary, null, 1));
  console.log(lines.join('\n'));
  console.log(`${which}: ${pass}/${rows.length} 통과, 기본(sim:all) 대비 회귀 ${reg}, 새 통과 ${fixed}`);
}

/** getup_random_x20 같은 묶음 시나리오: 시드마다 무작위 쓰러짐 → 넘어진 것 count개 성공률 (simCommon.runBatch와 같은 판정) */
async function batchCheck(sc: Scenario, ov: Record<string, number>, pool: Pool): Promise<{ passed: boolean; fails: string }> {
  const b = sc.batch!;
  const rows = await pool.all(Array.from({ length: b.maxTries }, (_, k) => ({ ...job(sc.name, b.seedStart + k, 1, ov, sc.name), batch: { seed: b.seedStart + k } })), `묶음 ${sc.name}`);
  const fell = rows.filter((r) => r.getup?.fell).slice(0, b.count);
  const s = {
    exploded: fell.some((r) => r.exploded), fell: true,
    metrics: { getupRuns: fell.length, getupSuccessCount: fell.filter((r) => r.getup!.success).length, 'assistUsage.getup': mean(fell.map((r) => r.getup!.assist)) },
  } as unknown as Summary;
  const f = checkExpect(sc.expect, s);
  return { passed: f.length === 0, fails: f.join('; ') };
}

// ───────────────────────── targets ─────────────────────────
async function makeTargets(): Promise<void> {
  // ① 사람: 반응 클립 라이브러리 48개(칸마다 고른 RP-v1.2), 밀림 조사 RP medium 24개
  const libRefs = resolveRefs(['react_*'], null);
  const study = ['front', 'back', 'left', 'right'].flatMap((d) => Array.from({ length: 6 }, (_, k) => `assets/kimodo/push_${d}_medium/rp12_s${k + 1}/clip.json`)).filter((p) => existsSync(p));
  const win = W.window!;
  const perClip = async (ps: string[]) => Promise.all(ps.map(async (p) => ({ p, a: (await humanArm([p], win))! })));
  const lib = await perClip(libRefs), st = await perClip(study);
  const hm = (xs: { a: { elevP90: number; usage: number; trunkPeak: number; lateOut: number } }[], k: 'elevP90' | 'usage' | 'trunkPeak' | 'lateOut') => median(xs.map((x) => x.a[k]));
  const hp90 = (xs: { a: { elevP90: number; usage: number; trunkPeak: number; lateOut: number } }[], k: 'elevP90' | 'usage' | 'trunkPeak' | 'lateOut') => { const s = xs.map((x) => x.a[k]).sort((a, b) => a - b); return s[Math.floor(0.9 * (s.length - 1))]!; };
  // ② 현재: 기본 설정, 학습 시나리오 + 검증 holdout × 시드 5001~ (근처 입력), 충격 배율 1
  const pool = new Pool(workers());
  let rows: EvalRow[];
  try {
    const v = space.validation;
    const jobs = [...space.train.scenarios, ...v.holdout].flatMap((s) => Array.from({ length: v.seeds }, (_, k) => job(s, v.seedBase + k, 1, {}, 'base')));
    rows = await pool.all(jobs, '현재 수치');
  } finally {
    await pool.close();
  }
  const ok = rows.filter((r) => !r.fell);
  const train = rows.filter((r) => space.train.scenarios.includes(r.scenario));
  // ③ SPEC 10 지표 현재값: npm run sim:all 결과(out/*/summary.json) 중앙값·최댓값
  const spec10 = ['energy', 'comJerk', 'angJerk', 'footSlide', 'limitHits', 'saturation', 'selfPenetration', 'jitter', 'reactionLatency', 'refSimilarity', 'refJointRmsDeg'];
  const sums = listScenarioFiles().map((f) => loadScenario(f).name).map((n) => join('out', n, 'summary.json')).filter(existsSync).map((p) => JSON.parse(readFileSync(p, 'utf8')) as Summary);
  const specCur = Object.fromEntries(spec10.map((k) => { const xs = sums.map((s) => s.metrics[k]).filter((x): x is number => typeof x === 'number'); return [k, { median: r3(median(xs)), p90: r3([...xs].sort((a, b) => a - b)[Math.floor(0.9 * (xs.length - 1))] ?? NaN), max: r3(Math.max(...xs)), n: xs.length }]; }));
  const cur = aggregate(rows, false), curTrain = aggregate(train, false);
  // 사람끼리 관절 RMS: 반응 클립 라이브러리 같은 칸(방향·세기)의 두 클립을 서로 비교 — 관절 RMS 목표의 바닥(0이 아님)
  const { compare, refStates } = await import('./kimodo/refSimilarity');
  const cells = new Map<string, string[]>();
  for (const p of libRefs) { const c = p.replace(/^.*react_(\w+_s\d\d)_s\d+\.json$/, '$1'); cells.set(c, [...(cells.get(c) ?? []), p]); }
  const pair: number[] = [];
  for (const ps of cells.values()) {
    if (ps.length < 2) continue;
    const ca = JSON.parse(readFileSync(ps[0]!, 'utf8')) as { fps: number; info: { pushFrame: number } };
    const cb = JSON.parse(readFileSync(ps[1]!, 'utf8')) as { info: { pushFrame: number } };
    const r = compare(refStates(ps[0]!), { events: [{ type: 'hit', t: ca.info.pushFrame / ca.fps }] } as never, refStates(ps[1]!), { scenario: 'pair', clip: ps[1]!, refOnsetFrame: cb.info.pushFrame });
    pair.push(r.items.jointRms.deg);
  }
  const H = { elevP90: hm(lib, 'elevP90'), usage: hm(lib, 'usage'), trunk: hm(lib, 'trunkPeak'), late: hm(lib, 'lateOut') };
  const out = {
    $comment: '품질 지표 기준 (SPEC 10 마지막 문단, v0.9). tools/tune.ts targets로 만든다. human = Kimodo 사람 레퍼런스(반응 클립 라이브러리 48개 중앙값, 괄호 밖 밀림 조사 RP medium 24개), current = 기본 설정의 근처 입력 통계(학습 11시나리오 + 검증 holdout 12시나리오 × 시드 6, 넘어진 실행 제외), target = v1.0 목표(사람 값에 여유 — 아래 rule), gate = 회귀 문턱(지금보다 나빠지면 안 되는 선). tune.ts 목적 함수는 시나리오별 사람 값(tuneSpace.json refs)을 먼저 쓰고, 레퍼런스가 없는 시나리오만 target을 쓴다. v1.0 기준값은 튜닝을 마친 뒤 이 파일을 다시 만들어 확정한다(README 결정 9t-5).',
    generated: new Date().toISOString().slice(0, 10),
    window: win,
    metrics: {
      armElevP90: { unit: 'deg', dir: 'lower', def: '충격 뒤 2.5초 창, 프레임마다 두 팔 중 큰 위팔 들림(몸통 아래 축 기준)의 90백분위 (tools/armMetrics.ts)', human: r3(H.elevP90), humanPushStudy: r3(hm(st, 'elevP90')), humanP90: r3(hp90(lib, 'elevP90')), current: r3(cur.elevP90), currentTrain: r3(curTrain.elevP90), target: r3(H.elevP90 * 1.15), gate: r3(cur.elevP90 * 1.05), rule: 'target = 사람 중앙값 × 1.15, gate = 현재 × 1.05' },
      armLateOut: { unit: 'frac', dir: 'lower', def: '충격 1초 뒤 ~ 창 끝, 팔 들림 > 40° 프레임 비율 (회복 뒤 팔이 들린 채 남음)', human: r3(H.late), humanPushStudy: r3(hm(st, 'lateOut')), current: r3(cur.lateOut), currentTrain: r3(curTrain.lateOut), target: r3(Math.max(0.05, H.late + 0.05)), gate: r3(cur.lateOut + 0.03), rule: 'target = 사람 + 0.05 (최소 0.05), gate = 현재 + 0.03' },
      armUsage: { unit: 'deg/s', dir: 'near-human', def: 'Spine2 기준 팔 바디 상대 각속도 평균 (refSimilarity armUsage와 같음)', human: r3(H.usage), humanPushStudy: r3(hm(st, 'usage')), humanP90: r3(hp90(lib, 'usage')), current: r3(cur.usage), currentTrain: r3(curTrain.usage), target: r3(H.usage * 1.3), gate: r3(cur.usage * 1.05), rule: '사람보다 적어도 뻣뻣해 보이므로 목적 함수는 |ln(sim/사람)|. target = 사람 × 1.3 (상한), gate = 현재 × 1.05' },
      trunkPeak: { unit: 'deg', dir: 'near-human', def: '창 안 Spine2 기울기 최대', human: r3(H.trunk), humanPushStudy: r3(hm(st, 'trunkPeak')), humanP90: r3(hp90(lib, 'trunkPeak')), current: r3(cur.trunk), currentTrain: r3(curTrain.trunk), target: r3(H.trunk * 1.3), gate: r3(cur.trunk * 1.05), rule: 'target = 사람 × 1.3, gate = 현재 × 1.05 (뒤 밀림 46° vs 사람 18°가 가장 큰 차이 — README 내일_이야기할것)' },
      landingError: { unit: 'm', dir: 'lower', def: '착지 오차 평균 (summary landingErrorMean)', human: null, current: cur.land === null ? null : r3(cur.land), currentTrain: curTrain.land === null ? null : r3(curTrain.land), target: 0.05, gate: cur.land === null ? 0.05 : r3(Math.max(0.05, cur.land * 1.1)), rule: 'v0.4 기대값(≤ 0.05, 결정 63) — 사람 레퍼런스에 착지 목표가 없음' },
      fallRate: { unit: 'frac', dir: 'lower', def: '넘어지면 안 되는(expect.fell=false) 근처 입력 실행 중 넘어진 비율', human: 0, current: r3(cur.fall), currentTrain: r3(curTrain.fall), target: 0.05, gate: r3(cur.fall + 0.02), rule: '사람 레퍼런스(밀림 조사 medium)는 넘어지지 않음. target 0.05는 v0.4 근처 입력 1/80·결정 165 12~15%에서 D안까지의 중간 목표, gate = 현재 + 2%p' },
      passRate: { unit: 'frac', dir: 'higher', def: '근처 입력 실행 중 expect 통과 비율', human: null, current: r3(cur.pass), currentTrain: r3(curTrain.pass), target: 0.9, gate: r3(cur.pass - 0.02), rule: 'gate = 현재 − 2%p' },
      refJointRms: { unit: 'deg', dir: 'lower', def: '사람 레퍼런스(반응 클립 칸·시나리오 reference) 대비 관절 RMS의 최솟값 (refSimilarity jointRms, DTW 정렬)', human: r3(median(pair)), humanPairs: pair.length, current: cur.refRms === null ? null : r3(cur.refRms), currentTrain: curTrain.refRms === null ? null : r3(curTrain.refRms), target: cur.refRms === null ? null : r3(Math.max(median(pair) * 1.25, cur.refRms * 0.85)), gate: cur.refRms === null ? null : r3(cur.refRms * 1.05), rule: 'human = 같은 칸 사람 클립 두 개끼리의 관절 RMS 중앙값(사람끼리도 0이 아님). target = max(사람끼리 × 1.25, 현재 × 0.85), gate = 현재 × 1.05' },
    },
    spec10SimAll: { $comment: 'SPEC 10 지표의 현재값 (npm run sim:all 시드 1, 시나리오별 값의 중앙값·90백분위·최댓값). v1.0 기준값은 튜닝 반영 뒤 이 값에 여유를 더해 정한다', ...specCur },
    humanClips: { reactionLibrary: lib.length, pushStudyMedium: st.length },
  };
  writeFileSync('config/qualityTargets.json', JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out.metrics, null, 1));
}

// ───────────────────────── report ─────────────────────────
async function report(name: string): Promise<void> {
  const dir = join('out/tune', name);
  const tuned = JSON.parse(readFileSync(join('config/tuned', `${name}.json`), 'utf8')) as { chosen: string; chosenIsBase: boolean; changed: Record<string, { from: number; to: number }>; generations: number; evaluations: number; tiers: string[]; runnerUp: { label: string; why: string; paired: { diff: number; se: number }; changed: Record<string, { from: number; to: number }> } | null };
  // 고른 값이 기본값이면 비교 대상 = 탈락한 최저 비용 후보(runnerUp)
  const which = tuned.chosenIsBase && tuned.runnerUp ? 'runnerUp' : 'after';
  const whichLabel = which === 'runnerUp' ? `탈락 후보 ${tuned.runnerUp!.label}` : `고른 값 ${tuned.chosen}`;
  const prog = readFileSync(join(dir, 'progress.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { gen: number; base: number; mean: number; best: number; median: number; sigma: number; baseAgg: Agg; meanAgg: Agg | null });
  const val = JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8')) as { chosen: string; results: { label: string; trainDelta: number | null; agg: Agg; aggTrainMag: Agg; aggHoldout: Agg; perScenario: Record<string, Agg> }[] };
  const ca = existsSync(join(dir, `check_${which}.json`)) ? (JSON.parse(readFileSync(join(dir, `check_${which}.json`), 'utf8')) as { pass: number; total: number; regressions: number; newlyPassing: number; rows: { name: string; passed: boolean; fails: string }[] }) : null;
  const f2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(d));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const row = (l: string, a: Agg) => `| ${l} | ${f2(a.cost, 3)} | ${pct(a.pass)} | ${pct(a.fall)} | ${a.explode} | ${f2(a.elevP90, 0)}° | ${pct(a.lateOut)} | ${f2(a.usage, 0)}°/s | ${f2(a.trunk, 0)}° | ${a.land === null ? '-' : (a.land * 100).toFixed(1) + 'cm'} | ${f2(a.refRms, 1)}° | ${a.n} |`;
  const H = '| 후보 | 비용 | 통과 | 넘어짐 | 폭발 | 팔 들림 p90 | 늦은 팔 들림 | 팔 사용 | 몸통 최대 | 착지 오차 | 관절 RMS | 실행 |\n|---|---|---|---|---|---|---|---|---|---|---|---|';
  const base = val.results[0]!, chosen = val.results.find((r) => r.label === val.chosen)!;
  const T = loadTargets().metrics;
  const L: string[] = [];
  L.push(`# 자동 튜닝 리포트 — ${name}`, '');
  L.push(`CMA-ES ${tuned.generations}세대, 평가 후보 ${tuned.evaluations}개(+ 세대마다 평균점·기본값), 대상 ${tuned.tiers.join('+')}. 고른 값: **${val.chosen}** (${tuned.chosenIsBase ? '채택 조건 — holdout 비용 ≤ 기본, 넘어짐 ≤ 기본 + 2%p, 짝지은 개선 > 1 SE — 을 만족한 후보 없음' : '채택 조건을 만족한 후보 중 검증 비용 최소'}). **기본 설정에는 반영하지 않았다** — \`config/tuned/${name}.json\`.`, '');
  L.push('## 목적 함수 추이 (학습 세트, 세대마다 다른 근처 입력 시드 — 같은 세대 안에서만 견줄 수 있어 기본값 대비 차를 함께 적음)', '');
  L.push('| 세대 | 기본값 | 평균점 | 평균점−기본 | 최고 표본 | 최고−기본 | 중앙 표본 | σ | 기본 넘어짐 | 평균점 넘어짐 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const p of prog) L.push(`| ${p.gen} | ${f2(p.base, 3)} | ${f2(p.mean, 3)} | ${f2(p.mean - p.base, 3)} | ${f2(p.best, 3)} | ${f2(p.best - p.base, 3)} | ${f2(p.median, 3)} | ${f2(p.sigma, 3)} | ${pct(p.baseAgg.fall)} | ${p.meanAgg ? pct(p.meanAgg.fall) : '-'} |`);
  L.push('', '## 검증 (다른 시드 5001~, 충격 ×0.85·×1.15 + 학습에 없는 시나리오)', '', H);
  for (const r of val.results) L.push(row(`${r.label}${r.label === val.chosen ? ' ✓' : ''}`, r.agg));
  L.push('', '### 기본 vs 고른 값 — 나눠 보기', '', H);
  L.push(row('기본 · 학습 시나리오 다른 크기', base.aggTrainMag), row(`${chosen.label} · 학습 시나리오 다른 크기`, chosen.aggTrainMag), row('기본 · 학습에 없는 시나리오', base.aggHoldout), row(`${chosen.label} · 학습에 없는 시나리오`, chosen.aggHoldout));
  L.push('', '### 시나리오별 (검증, 기본 → 고른 값)', '', '| 시나리오 | 비용 | 통과 | 넘어짐 | 팔 들림 p90 | 팔 사용 | 몸통 최대 | 관절 RMS |', '|---|---|---|---|---|---|---|---|');
  for (const s of Object.keys(base.perScenario)) {
    const a = base.perScenario[s]!, b = chosen.perScenario[s]!;
    L.push(`| ${s} | ${f2(a.cost)} → ${f2(b.cost)} | ${pct(a.pass)} → ${pct(b.pass)} | ${pct(a.fall)} → ${pct(b.fall)} | ${f2(a.elevP90, 0)} → ${f2(b.elevP90, 0)}° | ${f2(a.usage, 0)} → ${f2(b.usage, 0)} | ${f2(a.trunk, 0)} → ${f2(b.trunk, 0)}° | ${f2(a.refRms, 1)} → ${f2(b.refRms, 1)}° |`);
  }
  L.push('', `사람 기준(config/qualityTargets.json): 팔 들림 p90 ${T.armElevP90?.human}°, 늦은 팔 들림 ${T.armLateOut?.human}, 팔 사용 ${T.armUsage?.human}°/s, 몸통 최대 ${T.trunkPeak?.human}°.`, '');
  const chg = which === 'runnerUp' ? tuned.runnerUp!.changed : tuned.changed;
  if (which === 'runnerUp') L.push(`## 고른 값 = 기본값 (바꾸지 않음). 아래는 ${whichLabel}: 검증 짝지은 차 ${tuned.runnerUp!.paired.diff.toFixed(3)} ± ${tuned.runnerUp!.paired.se.toFixed(3)}, 탈락 이유: ${tuned.runnerUp!.why}`, '');
  L.push(`## 바뀐 값 (${whichLabel})`, '', '| 경로 | 기본 | 후보 |', '|---|---|---|');
  for (const [k, v] of Object.entries(chg)) L.push(`| \`${k}\` | ${v.from} | ${v.to} |`);
  if (ca) {
    L.push('', `## sim:all 시나리오 전체 (시드 1, ${whichLabel}): ${ca.pass}/${ca.total} 통과, 기본 대비 회귀 ${ca.regressions}, 새 통과 ${ca.newlyPassing}`, '');
    for (const r of ca.rows.filter((x) => !x.passed)) L.push(`- 실패 ${r.name}: ${r.fails}`);
  }
  const films = opt('--films', 'push_back_medium,push_left_medium,push_front_medium,push_diag_medium,shot_chest_stagger_clutch').split(',').filter(Boolean);
  L.push('', `## 이전·이후 필름스트립 (시드 1, 위 = 기본값, 아래 = ${whichLabel})`, '');
  for (const f of films) {
    const png = await filmPair(name, f, which, whichLabel);
    if (png) L.push(`### ${f}`, '', `![${f}](${png.replace(/^out\/tune\/[^/]+\//, '')})`, '');
  }
  writeFileSync(join(dir, 'report.md'), L.join('\n') + '\n');
  console.log(`→ ${join(dir, 'report.md')}`);
}

/** 기본(out/<f>) · 튜닝(out/tune/<run>/after/<f>) 필름을 각각 그린 뒤 위아래로 붙인다 (Playwright 캔버스, 라벨 한글) */
async function filmPair(name: string, f: string, which: string, label: string): Promise<string | null> {
  const afterName = `tune/${name}/${which}/${f}`;
  if (!existsSync(join('out', f, 'log.jsonl')) || !existsSync(join('out', afterName, 'log.jsonl'))) { console.warn(`필름 건너뜀 ${f} (로그 없음)`); return null; }
  const sc = loadScenario(listScenarioFiles().find((p) => loadScenario(p).name === f)!);
  const cam = sc.cameras?.[0] ?? 'side';
  const outDir = join('out/tune', name, 'films');
  mkdirSync(outDir, { recursive: true });
  for (const [n, sfx] of [[f, 'before'], [afterName, 'after']] as const) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'tools/film.ts', n, '--camera', cam, '--both', '--from', '0.8', '--to', '4.0', '--interval', '0.2', '--out', outDir, '--suffix', `${f}_${sfx}`], { stdio: 'inherit' });
    if (r.status !== 0) { console.warn(`필름 실패 ${n}`); return null; }
  }
  const { readdirSync } = await import('node:fs');
  const pick = (sfx: string) => readdirSync(outDir).filter((x) => x.endsWith('.png') && x.includes(`_${f}_${sfx}`)).map((x) => join(outDir, x)).sort()[0];
  const a = pick('before'), b = pick('after');
  if (!a || !b) return null;
  const dst = join(outDir, `compare_${f}.png`);
  const { chromium } = await import('playwright');
  const br = await chromium.launch();
  try {
    const pg = await br.newPage();
    const uri = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
    await pg.setContent(`<html><body style="margin:0;background:#fff;font-family:'Malgun Gothic','Noto Sans KR',sans-serif">
      <div id="c" style="display:inline-block"><div style="font:bold 22px sans-serif;padding:6px 10px;font-family:inherit">${f} — 위: 기본 설정 · 아래: ${label} (${name})</div>
      <div style="font:16px sans-serif;padding:2px 10px;color:#333;font-family:inherit">기본</div><img src="${uri(a)}"><div style="font:16px sans-serif;padding:2px 10px;color:#a33;font-family:inherit">${label}</div><img src="${uri(b)}"></div></body></html>`);
    await pg.waitForLoadState('load');
    await (await pg.$('#c'))!.screenshot({ path: dst });
  } finally {
    await br.close();
  }
  return dst.replace(/\\/g, '/');
}

// ───────────────────────── main ─────────────────────────
const cmd = argv[0];
const nm = argv[1] ?? '';
const main = async () => {
  if (cmd === 'targets') return makeTargets();
  if (!nm) throw new Error('사용법: npx tsx tools/tune.ts run|validate|check|report <run>');
  if (cmd === 'run') return run(nm);
  if (cmd === 'validate') return validate(nm);
  if (cmd === 'select') {
    const st = JSON.parse(readFileSync(join('out/tune', nm, 'state.json'), 'utf8')) as { cma: CmaState; tiers: string[] };
    return finalize(nm, st, activeParams(st.tiers), (JSON.parse(readFileSync(join('out/tune', nm, 'validation.json'), 'utf8')) as { results: VRes[] }).results);
  }
  if (cmd === 'check') return check(nm);
  if (cmd === 'report') return report(nm);
  throw new Error(`알 수 없는 명령 ${cmd}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
