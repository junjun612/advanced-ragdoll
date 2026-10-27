// 직렬화 시나리오 검사 공통 (tests/snapshot*.test.ts, 두 파일로 나눠 vitest가 병렬로 돈다).
// 시나리오 중간에서 저장 → JSON 문자열 → 복원 → 이어 돌린 결과가 끊지 않고 돌린 결과와 바이트 단위로 같아야 한다
// (로그·요약·메타·다른 캐릭터 로그·프롭 로그). 저장해도 원래 실행은 바뀌지 않아야 한다.
import { it, expect } from 'vitest';
import { runScenario, resumeScenario, type RunCheckpoint, type RunResult } from '../src/sim/runner';
import { findScenario, loadInputs, loadScenario } from '../tools/simCommon';

/** 바이트 비교할 출력 (msPerStep은 시계라 뺀다) */
const outputs = (r: RunResult) => ({ log: r.log, summary: JSON.stringify(r.summary), meta: JSON.stringify(r.meta), extra: JSON.stringify(r.extraLogs ?? null), props: r.propsLog ?? null });

/** name: 시나리오, fracs: 체크포인트 (시나리오 길이 비율 — 피격 직후·반응 중·끝 무렵) */
export function resumeCase(name: string, fracs: number[]): void {
  it(`${name}: save mid-run → JSON → load → continue is byte-identical`, async () => {
    const sc = loadScenario(findScenario(name));
    const inp = loadInputs(sc);
    const plain = outputs(await runScenario(inp));
    const total = Math.round(sc.duration * 120);
    const at = fracs.map((f) => Math.round(total * f));
    const cps: string[] = [];
    const withSaves = outputs(await runScenario(inp, { checkpointAt: at, onCheckpoint: (cp) => cps.push(JSON.stringify(cp)) }));
    // 저장은 읽기만 한다
    expect(withSaves).toEqual(plain);
    expect(cps).toHaveLength(at.length);
    for (const txt of cps) {
      const cp = JSON.parse(txt) as RunCheckpoint;
      const resumed = outputs(await resumeScenario(inp, cp));
      expect(resumed.log, `${name} resumed at step ${cp.step}`).toBe(plain.log);
      expect(resumed).toEqual(plain);
    }
  }, 600_000);
}
