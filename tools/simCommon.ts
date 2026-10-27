// sim / sim:all 공통: 시나리오 찾기, 실행, out/<scenario>/ 에 쓰기.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runScenario, type RunResult } from '../src/sim/runner';
import { checkExpect } from '../src/sim/scenario';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import { stringifyRounded } from '../src/sim/logger';
import { Prng } from '../src/sim/prng';
import hitScale from '../config/hitScale.json';

export const SCENARIO_DIR = 'scenarios';
export const OUT_DIR = 'out';

export function listScenarioFiles(dir = SCENARIO_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? listScenarioFiles(p) : n.endsWith('.json') ? [p] : [];
    });
}

export const loadScenario = (file: string): Scenario => JSON.parse(readFileSync(file, 'utf8')) as Scenario;

export function findScenario(name: string): string {
  const hit = listScenarioFiles().filter((f) => loadScenario(f).name === name);
  if (hit.length !== 1) throw new Error(hit.length ? `scenario '${name}' is ambiguous: ${hit.join(', ')}` : `scenario '${name}' not found under ${SCENARIO_DIR}/`);
  return hit[0]!;
}

export function loadInputs(sc: Scenario) {
  const characterConfig = `config/characters/${sc.character}.json`;
  const character = JSON.parse(readFileSync(characterConfig, 'utf8')) as CharacterDef;
  const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
  // (v0.8c) 두 번째 이후 캐릭터 정의
  const extraCharacters = sc.characters?.map((c) => {
    const config = `config/characters/${c.character ?? sc.character}.json`;
    return { def: JSON.parse(readFileSync(config, 'utf8')) as CharacterDef, config };
  });
  return { scenario: sc, character, characterConfig, ragdoll, ...(extraCharacters ? { extraCharacters } : {}) };
}

/**
 * 사람 레퍼런스 유사도 (SPEC 10 refSimilarity, 보조 지표): 시나리오에 reference(Kimodo 포즈 클립)가 있으면 계산해 summary.metrics에 ref*로 넣는다.
 * 통과 관문이 아니다(리드 지시) — 보고서·필름 비교용. 레퍼런스 도구(tools/kimodo/refSimilarity)를 읽기만 한다.
 */
export async function addRefSimilarity(sc: Scenario, res: RunResult): Promise<void> {
  if (!sc.reference || !existsSync(sc.reference)) return;
  try {
    const { compare, refStates } = await import('./kimodo/refSimilarity');
    const clip = JSON.parse(readFileSync(sc.reference, 'utf8')) as { info?: { pushFrame?: number } };
    const sim = res.log.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const r = compare(sim, res.meta, refStates(sc.reference), { scenario: sc.name, clip: sc.reference, refOnsetFrame: typeof clip.info?.pushFrame === 'number' ? clip.info.pushFrame : undefined });
    const it = r.items;
    Object.assign(res.summary.metrics, {
      refSimilarity: r.refSimilarity,
      refComDtwCm: it.comTrajectory.dtwMeanCm,
      refComPeakCm: it.comTrajectory.refPeakDispCm,
      simComPeakCm: it.comTrajectory.simPeakDispCm,
      refTrunkTiltDtwDeg: it.trunkTilt.dtwMeanDeg,
      refTrunkPeakDeg: it.trunkTilt.refPeakDeg,
      simTrunkPeakDeg: it.trunkTilt.simPeakDeg,
      refArmRatio: it.armUsage.ratio,
      refJointRmsDeg: it.jointRms.deg,
      refSteps: it.steps.ref,
      simRefSteps: it.steps.sim,
      ...(it.recoveryTime.refS !== null ? { refRecoveryS: it.recoveryTime.refS } : {}),
      ...(it.recoveryTime.simS !== null ? { simRefRecoveryS: it.recoveryTime.simS } : {}),
    });
  } catch (e) {
    console.warn(`refSimilarity ${sc.name}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * (v0.7) 묶음 시나리오 (getup_random_x20): 무작위 쓰러짐을 차례로 돌려 넘어진 것 count개를 모은다. 요약 = 집계 + 실행별 결과(runs.json).
 * 성공 = 일어서서 Idle로 돌아왔고(getupSuccess) 폭발 없음.
 */
async function runBatch(sc: Scenario): Promise<RunResult> {
  const b = sc.batch!;
  const { randomFallScenario } = await import('../src/sim/getupScenarios');
  const dir = join(OUT_DIR, sc.name);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const runs: { seed: number; kind: string; fell: boolean; success: boolean; exploded: boolean; starts: number; fails: number; standTime: number | null; doneTime: number | null; assist: number; assistPeakBW: number; postSteps: number; hand: number; knee: number }[] = [];
  let first: RunResult | null = null;
  let ms = 0, nRun = 0;
  for (let seed = b.seedStart; seed < b.seedStart + b.maxTries && runs.filter((r) => r.fell).length < b.count; seed++) {
    const fs = randomFallScenario(seed, { weights: b.weights as never, duration: b.duration, name: `${sc.name}__${seed}`, pushRange: b.pushRange });
    const res = await runScenario({ ...loadInputs(fs), now: () => performance.now() });
    ms += res.msPerStep; nRun++;
    const s = res.summary, m = s.metrics;
    const r = { seed, kind: fs.fallKind, fell: s.fell, success: m.getupSuccess === 1 && !s.exploded, exploded: s.exploded, starts: m.getupStarts ?? 0, fails: (m.getupFails ?? 0) + (m.getupGiveUp ?? 0), standTime: m.getupStandTime ?? null, doneTime: m.getupDoneTime ?? null, assist: m['assistUsage.getup'] ?? 0, assistPeakBW: m.getupAssistPeakBW ?? 0, postSteps: m.getupPostSteps ?? 0, hand: m.getupHandContact ?? 0, knee: m.getupKneeContact ?? 0 };
    runs.push(r);
    if (s.fell) {
      const rd = join(dir, 'runs', String(seed));
      mkdirSync(rd, { recursive: true });
      writeFileSync(join(rd, 'log.jsonl'), res.log);
      writeFileSync(join(rd, 'summary.json'), stringifyRounded(s, 2) + '\n');
      writeFileSync(join(rd, 'meta.json'), stringifyRounded(res.meta, 2) + '\n');
      first ??= res;
    }
    console.log(`  ${sc.name} 시드 ${seed} (${fs.fallKind}): ${!s.fell ? '안 넘어짐(건너뜀)' : r.success ? `성공 ${r.doneTime?.toFixed(2)}초` : '실패'} 시도 ${r.starts}`);
  }
  const fell = runs.filter((r) => r.fell);
  const ok = fell.filter((r) => r.success);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
  const base = first!;
  const summary = {
    ...base.summary, scenario: sc.name, milestone: sc.milestone, duration: sc.duration,
    exploded: fell.some((r) => r.exploded), fell: true,
    metrics: {
      getupRuns: fell.length, getupSuccessCount: ok.length, getupSuccessRate: fell.length ? ok.length / fell.length : 0,
      getupStandTimeMean: mean(ok.map((r) => r.standTime ?? 0)), getupDoneTimeMean: mean(ok.map((r) => r.doneTime ?? 0)),
      'assistUsage.getup': mean(fell.map((r) => r.assist)), 'assistUsage.getupMax': Math.max(0, ...fell.map((r) => r.assist)),
      getupAssistPeakBW: Math.max(0, ...fell.map((r) => r.assistPeakBW)), getupAttemptsMean: mean(fell.map((r) => r.starts)),
      getupPostStepsMean: mean(ok.map((r) => r.postSteps)), getupHandContactFrac: mean(ok.map((r) => r.hand)), getupKneeContactFrac: mean(ok.map((r) => r.knee)),
      assistUsage: mean(fell.map((r) => r.assist)),
    },
  } as RunResult['summary'];
  const failures = checkExpect(sc.expect, summary);
  summary.expectations = { passed: failures.length === 0, failures };
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs, null, 1));
  writeFileSync(join(dir, 'summary.json'), stringifyRounded(summary, 2) + '\n');
  return { log: base.log, summary, meta: { ...base.meta, scenario: sc.name }, msPerStep: ms / Math.max(1, nRun) };
}

export async function runAndWrite(sc: Scenario): Promise<RunResult> {
  if (sc.batch) return runBatch(sc);
  const res = await runScenario({ ...loadInputs(sc), now: () => performance.now() });
  await addRefSimilarity(sc, res);
  const dir = join(OUT_DIR, sc.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log.jsonl'), res.log);
  for (const x of res.extraLogs ?? []) writeFileSync(join(dir, x.file), x.log);
  if (res.propsLog) writeFileSync(join(dir, res.meta.propsLog ?? 'props.jsonl'), res.propsLog);
  writeFileSync(join(dir, 'summary.json'), stringifyRounded(res.summary, 2) + '\n');
  writeFileSync(join(dir, 'meta.json'), stringifyRounded(res.meta, 2) + '\n');
  return res;
}

/**
 * 견고성 평가용 '근처' 시나리오 (v0.4 시드 스윕 --jitter): 시드 2부터 모든 밀기의 세기 ×(1 ± 5%)·수평 방향 ±5°를 시드로 뽑는다.
 * 시드 1은 원래 시나리오 그대로(시드는 트리거 지터·다리 선호만 바꿔 결과가 거의 두 갈래뿐이라, 입력 근처에서도 되는지 본다).
 */
export function jitterScenario(sc: Scenario, seed: number): Scenario {
  if (seed <= 1) return sc;
  const rng = new Prng(seed * 7919);
  return {
    ...sc,
    seed,
    events: sc.events.map((e) => {
      if (e.type !== 'hit' || !e.hit) return e;
      const mag = typeof e.hit.magnitude === 'number' ? e.hit.magnitude : (hitScale as Record<string, number>)[e.hit.magnitude as string]!;
      const a = ((2 * rng.float() - 1) * 5 * Math.PI) / 180, k = 1 + (2 * rng.float() - 1) * 0.05;
      const [dx, dy, dz] = e.hit.direction;
      // v0.5a: 총탄·근접 타격도 같은 지터 + 맞는 점 ±1cm (밀기는 v0.4와 같은 난수 순서)
      const pt = e.hit.type !== 'push' && e.hit.point ? e.hit.point.map((x) => x + (2 * rng.float() - 1) * 0.01) as [number, number, number] : e.hit.point;
      return { ...e, hit: { ...e.hit, ...(pt ? { point: pt } : {}), magnitude: mag * k, direction: [dx * Math.cos(a) + dz * Math.sin(a), dy, -dx * Math.sin(a) + dz * Math.cos(a)] as [number, number, number] } };
    }),
  } as Scenario;
}
