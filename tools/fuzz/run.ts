// 퍼징 실행 하나 (SPEC 12 v0.9): 생성기(gen.ts)의 시나리오를 runner로 돌리며 감지기(detect.ts)를 붙인다.
import { performance } from 'node:perf_hooks';
import { runScenario, type RunResult } from '../../src/sim/runner';
import { loadInputs } from '../simCommon';
import type { FuzzCase, FuzzTags } from './gen';
import { FuzzDetector, type Finding } from './detect';
export { FATAL, LAYER, type Finding, type FindingKind } from './detect';

export interface FuzzResult {
  seed: number;
  tags: FuzzTags;
  ms: number;
  simSeconds: number;
  findings: Finding[];
  fell: boolean;
  maxAngVel: number;
  maxAngBody: string;
  maxPenetration: number;
  /** (README 9f-11) 충돌 튐 목록 */
  snaps: { char: string; t: number; body: string; deg: number; detail: string }[];
}

/** 퍼징 실행 하나 (결과 + 재현용 RunResult) */
export async function runFuzzCase(fc: FuzzCase): Promise<{ result: FuzzResult; run: RunResult | null; detector: FuzzDetector | null }> {
  let det: FuzzDetector | null = null;
  const errors: Finding[] = [];
  const t0 = performance.now();
  let run: RunResult | null = null;
  try {
    run = await runScenario({
      ...loadInputs(fc.scenario),
      observe: { setup: (w) => { det = new FuzzDetector(w); }, step: (w) => det!.step(w) },
    });
    // 요약의 폭발 판정 (같은 기준 — 이벤트가 놓친 경우만 더한다)
    const d = det as FuzzDetector | null;
    if (d) [run.summary, ...Object.values(run.summary.others ?? {})].forEach((s, k) => {
      const nm = d.nameOf(k);
      if (s.exploded && !d.findings.some((f) => (f.kind === 'explosion' || f.kind === 'nan') && f.char === nm)) d.findings.push({ kind: 'explosion', char: nm, t: s.explodedTime ?? 0, detail: '요약 판정 (속도 기준)' });
    });
  } catch (e) {
    errors.push({ kind: 'error', char: '-', t: 0, detail: e instanceof Error ? `${e.message} @ ${(e.stack ?? '').split('\n').slice(1, 3).map((x) => x.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ')}` : String(e) });
  }
  const d = det as FuzzDetector | null;
  const findings = [...(d?.findings ?? []), ...errors].sort((a, b) => a.t - b.t);
  const result: FuzzResult = {
    seed: fc.seed, tags: fc.tags, ms: Math.round(performance.now() - t0), simSeconds: fc.scenario.duration, findings,
    fell: d?.fell ?? false, maxAngVel: Math.round((d?.maxAngVel ?? 0) * 100) / 100, maxAngBody: d?.maxAngBody ?? '', maxPenetration: Math.round((d?.maxPenetration ?? 0) * 10000) / 10000, snaps: d?.snaps ?? [],
  };
  return { result, run, detector: d };
}
