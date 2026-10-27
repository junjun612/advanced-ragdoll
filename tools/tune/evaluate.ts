// 튜닝 평가 한 건: (시나리오, 근처 입력 시드, 충격 배율, 설정 덮어쓰기) → 통과·넘어짐·팔·몸통·착지·사람 레퍼런스 관절 RMS.
// 워커 스레드(tools/tune/worker.ts)와 본 스레드가 같이 쓴다. 기본 설정 파일은 읽기만 한다.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from '../../src/sim/runner';
import { stringifyRounded } from '../../src/sim/logger';
import type { CharacterDef } from '../../src/sim/character/characterDef';
import type { CharacterOpts } from '../../src/sim/api';
import type { Scenario } from '../../src/sim/scenario';
import { findScenario, loadScenario, loadInputs, jitterScenario } from '../simCommon';
import { armStats, logToArmFrames, type ArmStats, type ArmFrame } from '../armMetrics';
import { applyOverrides } from './space';
import hitScale from '../../config/hitScale.json';

export interface EvalJob {
  scenario: string;
  seed: number;
  /** 충격 크기 배율 (검증 세트 '다른 충격 크기') */
  mag: number;
  overrides: Record<string, number>;
  /** 반응 클립 레퍼런스 glob (assets/poses/reaction의 파일 이름, '*' 허용) */
  refs: string[];
  window: number;
  /** 로그·요약·메타를 여기에 쓴다 (필름용) */
  saveDir?: string;
  /** 후보 번호 등 호출자 표시 */
  tag?: string;
  /** 묶음 시나리오(getup_random_x20)의 무작위 쓰러짐 한 건 (simCommon.runBatch와 같은 시나리오) */
  batch?: { seed: number };
}

export interface HumanArm { elevP90: number; usage: number; trunkPeak: number; lateOut: number; n: number }

export interface EvalRow {
  tag?: string;
  scenario: string; seed: number; mag: number;
  passed: boolean; fell: boolean; mustStand: boolean; exploded: boolean;
  steps: number; land: number | null; arm: ArmStats;
  /** 사람 레퍼런스들과의 관절 RMS 최솟값 (도) */
  refRms: number | null;
  /** 사람 레퍼런스 팔·몸통 중앙값 */
  human: HumanArm | null;
  fails: string;
  ms: number;
  /** 묶음 시나리오 한 건: 넘어졌는지, 일어서기 성공(getupSuccess, 폭발 없음), 겟업 보조 */
  getup?: { fell: boolean; success: boolean; assist: number };
}

const CFG_FILES = { behaviors: 'behaviors', stepping: 'stepping', reaction: 'reaction', balance: 'balance', muscles: 'muscles', hitModel: 'hitModel', animDriver: 'animDriver' } as const;
type CfgKey = keyof typeof CFG_FILES;

let baseCfgs: Record<CfgKey, Record<string, unknown>> | null = null;
/** 기본 설정 (디스크에서 새로 읽음 — 모듈 JSON 객체를 건드리지 않는다) */
export function baseConfigs(): Record<CfgKey, Record<string, unknown>> {
  baseCfgs ??= Object.fromEntries(Object.entries(CFG_FILES).map(([k, f]) => [k, JSON.parse(readFileSync(`config/${f}.json`, 'utf8'))])) as Record<CfgKey, Record<string, unknown>>;
  return baseCfgs;
}

export function characterOptsFor(ov: Record<string, number>): CharacterOpts {
  const c = applyOverrides(baseConfigs(), ov);
  return {
    behaviorsConfig: c.behaviors as never, steppingConfig: c.stepping as never, reactionConfig: c.reaction as never,
    balanceConfig: c.balance as never, muscles: c.muscles as never, hitModelConfig: c.hitModel as never, animConfig: c.animDriver as never,
  };
}

/** 근처 입력 + 충격 배율 */
export function variantScenario(name: string, seed: number, mag: number): Scenario {
  const sc = jitterScenario({ ...loadScenario(findScenario(name)), seed }, seed);
  if (mag === 1) return sc;
  return {
    ...sc,
    events: sc.events.map((e) => {
      if (e.type !== 'hit' || !e.hit || e.hit.type === 'explosion') return e;
      const m = typeof e.hit.magnitude === 'number' ? e.hit.magnitude : (hitScale as Record<string, number>)[e.hit.magnitude as string]!;
      return { ...e, hit: { ...e.hit, magnitude: m * mag } };
    }),
  } as Scenario;
}

const def = (): CharacterDef => JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
let defCache: CharacterDef | null = null;

/** 레퍼런스 glob → 파일 경로 */
export function resolveRefs(globs: string[], scenarioRef: string | null | undefined): string[] {
  const dir = 'assets/poses/reaction';
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const out: string[] = [];
  for (const g of globs) {
    const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '(\\.json)?$');
    for (const f of files) if (re.test(f)) out.push(join(dir, f));
  }
  if (scenarioRef && existsSync(scenarioRef)) out.push(scenarioRef);
  return out;
}

interface RefCache { states: unknown[]; onset: number | undefined; arm: ArmStats }
const refCache = new Map<string, RefCache>();
async function refData(path: string, window: number): Promise<RefCache> {
  const hit = refCache.get(path);
  if (hit) return hit;
  const { refStates } = await import('../kimodo/refSimilarity');
  const clip = JSON.parse(readFileSync(path, 'utf8')) as { fps?: number; info?: { pushFrame?: number } };
  const states = refStates(path);
  const onset = typeof clip.info?.pushFrame === 'number' ? clip.info.pushFrame : undefined;
  const fr: ArmFrame[] = states.map((x) => ({ t: x.time, rot: Object.fromEntries(Object.entries(x.bodies).map(([k, b]) => [k, b.rot])) }));
  const t0 = (onset ?? 30) / (clip.fps ?? 30);
  defCache ??= def();
  const r = { states, onset, arm: armStats(defCache, fr, t0, window) };
  refCache.set(path, r);
  return r;
}

const med = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };

export async function humanArm(paths: string[], window: number): Promise<HumanArm | null> {
  if (!paths.length) return null;
  const a = await Promise.all(paths.map((p) => refData(p, window).then((r) => r.arm)));
  return { elevP90: med(a.map((x) => x.elevP90)), usage: med(a.map((x) => x.usage)), trunkPeak: med(a.map((x) => x.trunkPeak)), lateOut: med(a.map((x) => x.lateOut)), n: a.length };
}

export async function evalRun(job: EvalJob): Promise<EvalRow> {
  const t0 = performance.now();
  let sc: Scenario;
  if (job.batch) {
    const b = loadScenario(findScenario(job.scenario)).batch!;
    const { randomFallScenario } = await import('../../src/sim/getupScenarios');
    sc = randomFallScenario(job.batch.seed, { weights: b.weights as never, duration: b.duration, name: `${job.scenario}__${job.batch.seed}`, pushRange: b.pushRange });
  } else sc = variantScenario(job.scenario, job.seed, job.mag);
  const inp = loadInputs(sc);
  const r = await runScenario({ ...inp, characterOpts: characterOptsFor(job.overrides) });
  const s = r.summary;
  if (job.batch) {
    const m = s.metrics;
    return {
      tag: job.tag, scenario: job.scenario, seed: job.batch.seed, mag: 1, passed: s.expectations.passed, fell: s.fell, mustStand: false, exploded: !!s.exploded,
      steps: 0, land: null, arm: { elevMean: 0, elevP90: 0, outFrac: 0, elbowMean: 0, usage: 0, trunkPeak: 0, lateOut: 0 }, refRms: null, human: null, fails: '', ms: performance.now() - t0,
      getup: { fell: s.fell, success: m.getupSuccess === 1 && !s.exploded, assist: m['assistUsage.getup'] ?? 0 },
    };
  }
  defCache ??= def();
  const hitT = sc.events.find((e) => e.type === 'hit')?.t ?? 0;
  const arm = armStats(defCache, logToArmFrames(r.log), hitT, job.window);
  const refs = resolveRefs(job.refs, sc.reference);
  let refRms: number | null = null;
  if (refs.length && sc.events.some((e) => e.type === 'hit')) {
    const { compare } = await import('../kimodo/refSimilarity');
    const sim = r.log.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    for (const p of refs) {
      try {
        const d = await refData(p, job.window);
        const c = compare(sim, r.meta, d.states as never, { scenario: sc.name, clip: p, refOnsetFrame: d.onset });
        refRms = Math.min(refRms ?? Infinity, c.items.jointRms.deg);
      } catch { /* 레퍼런스 비교 실패는 건너뜀 */ }
    }
  }
  if (job.saveDir) {
    mkdirSync(job.saveDir, { recursive: true });
    writeFileSync(join(job.saveDir, 'log.jsonl'), r.log);
    for (const x of r.extraLogs ?? []) writeFileSync(join(job.saveDir, x.file), x.log);
    if (r.propsLog) writeFileSync(join(job.saveDir, r.meta.propsLog ?? 'props.jsonl'), r.propsLog);
    writeFileSync(join(job.saveDir, 'summary.json'), stringifyRounded(s, 2) + '\n');
    writeFileSync(join(job.saveDir, 'meta.json'), stringifyRounded(r.meta, 2) + '\n');
  }
  return {
    tag: job.tag, scenario: job.scenario, seed: job.seed, mag: job.mag,
    passed: s.expectations.passed, fell: s.fell, mustStand: sc.expect?.fell === false, exploded: !!s.exploded,
    steps: s.stepsTaken ?? 0, land: typeof s.metrics.landingErrorMean === 'number' ? s.metrics.landingErrorMean : null,
    arm, refRms, human: await humanArm(humanPaths(job.refs, sc.reference), job.window), fails: s.expectations.failures.join('; '), ms: performance.now() - t0,
  };
}

/**
 * 팔·몸통 사람 기대값에 쓸 레퍼런스: 반응 클립 라이브러리 칸이 있으면 그것만(밀림 시각 info.pushFrame이 정확),
 * 없으면 시나리오 reference 중 pushFrame이 적힌 것(예: 총탄 조사). 밀림 조사 클립(0.4초 끌기, 결정 160)은 관절 RMS에만 쓴다
 */
export function humanPaths(globs: string[], scenarioRef: string | null | undefined): string[] {
  const lib = resolveRefs(globs, null);
  if (lib.length) return lib;
  if (scenarioRef && existsSync(scenarioRef)) {
    const c = JSON.parse(readFileSync(scenarioRef, 'utf8')) as { info?: { pushFrame?: number } };
    if (typeof c.info?.pushFrame === 'number') return [scenarioRef];
  }
  return [];
}
