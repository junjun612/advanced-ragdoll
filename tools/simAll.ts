// npm run sim:all [-- --milestone X]
// 현재 마일스톤(기본: scenarios/ 아래 가장 뒤 마일스톤) 이하의 시나리오를 모두 돌리고 out/report.md를 쓴다 (SPEC 8.4).
// 직전 보고서는 out/report.prev.md로 옮기고, 그 안의 데이터 블록과 비교해 ↑↓를 붙인다.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareMilestones, milestoneAtLeast } from '../src/sim/milestones';
import simCfg from '../config/sim.json';
import { listScenarioFiles, loadScenario, runAndWrite, OUT_DIR } from './simCommon';
import type { Summary } from '../src/sim/types';

const argi = process.argv.indexOf('--milestone');
const all = listScenarioFiles().map((f) => loadScenario(f));
const latest = all.map((sc) => sc.milestone).sort(compareMilestones).at(-1) ?? '0.1';
const current = argi >= 0 ? process.argv[argi + 1]! : ((simCfg as { currentMilestone?: string }).currentMilestone ?? latest);
const todo = all
  .filter((sc) => milestoneAtLeast(current, sc.milestone))
  .sort((a, b) => compareMilestones(a.milestone, b.milestone) || a.name.localeCompare(b.name));

type Row = { name: string; milestone: string; passed: boolean; s: Summary; ms: number; knownIssue?: string };
const rows: Row[] = [];
for (const sc of todo) {
  const res = await runAndWrite(sc);
  const s = res.summary;
  rows.push({ name: sc.name, milestone: sc.milestone, passed: s.expectations.passed, s, ms: res.msPerStep, knownIssue: sc.knownIssue });
  const tag = s.expectations.passed ? 'PASS' : sc.knownIssue ? 'KNOWN' : 'FAIL';
  console.log(`${tag}  ${sc.name}  ${s.expectations.failures.join('; ')}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const reportPath = join(OUT_DIR, 'report.md');
const prevPath = join(OUT_DIR, 'report.prev.md');
type Key = Record<string, number | null>;
let prev: Record<string, Key> = {};
if (existsSync(reportPath)) {
  renameSync(reportPath, prevPath);
  const m = /<!-- data (.*) -->/.exec(readFileSync(prevPath, 'utf8'));
  if (m) prev = JSON.parse(m[1]!) as Record<string, Key>;
}

const keyNums = (s: Summary): Key => ({
  fallTime: s.fallTime,
  maxAngVel: s.metrics.maxAngVel ?? null,
  limitP99: s.metrics.limitViolationP99Deg ?? null,
  limitMax: s.metrics.limitViolationMaxDeg ?? null,
  limitHits: s.metrics.limitHits ?? null,
  selfPen: s.metrics.selfPenetration ?? null,
  errMax: s.metrics.jointErrorMaxDeg ?? null,
  errMean: s.metrics.jointErrorMeanDeg ?? null,
  jitter: s.metrics.jitter ?? null,
  saturation: s.metrics.saturation ?? null,
  energy: s.metrics.energy ?? null,
  trackErr: s.metrics.trackErrorMeanDeg ?? null,
  trackLag: s.metrics.trackLag ?? null,
  assistRoot: s.metrics['assistUsage.root'] ?? null,
  kneeLead: s.metrics.collapseKneeLeadTime ?? null,
  recAfterHit: s.recoveredAfterHit ?? null,
  marginMin: s.metrics.balanceMarginMin ?? null,
  hipMax: s.metrics.hipWeightMax ?? null,
  comJerk: s.metrics.comJerk ?? null,
  angJerk: s.metrics.angJerk ?? null,
  footSlide: s.metrics.footSlide ?? null,
  footDisp: s.metrics.footDisplacementMax ?? null,
  latency: s.metrics.reactionLatency ?? null,
  leanBack: s.metrics.leanHipsBackMin ?? null,
});
const fmt = (x: number | null | undefined, d: number) => (x === null || x === undefined ? '—' : x.toFixed(d));
const cell = (name: string, k: string, cur: number | null | undefined, d = 2) => {
  const p = prev[name]?.[k];
  if (p === undefined || p === null || cur === null || cur === undefined) return fmt(cur, d);
  const diff = cur - p;
  if (Math.abs(diff) < 0.5 * 10 ** -d) return fmt(cur, d);
  return `${fmt(cur, d)} ${diff > 0 ? '↑' : '↓'}${fmt(Math.abs(diff), d)}`;
};

const data: Record<string, Key> = {};
const passed = rows.filter((r) => r.passed).length;
// 회귀 = knownIssue가 없는데 실패한 시나리오. 알려진 문제는 숨기지 않고 따로 보인다(통과 수에는 그대로 실패로 센다)
const regressions = rows.filter((r) => !r.passed && !r.knownIssue);
const known = rows.filter((r) => r.knownIssue);
const lines: string[] = [
  `# 시나리오 보고서 (현재 마일스톤 v${current})`,
  '',
  `통과 ${passed}/${rows.length} · 회귀(알려진 문제 아닌 실패) ${regressions.length} · 알려진 문제 ${known.length}개 중 실패 ${known.filter((r) => !r.passed).length}. ↑↓는 직전 실행(report.prev.md) 대비 변화.`,
  '',
  '| 시나리오 | 마일스톤 | 결과 | 폭발 | 넘어짐(시각 s) | 첫 지면 접촉 | 최종 자세 | 최대 각속도 rad/s | 제한 위반 p99° | 제한 위반 최대° | 제한 닿은 프레임 | 자기 관통 m | ms/스텝 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  const k = keyNums(r.s);
  data[r.name] = k;
  const fell = r.s.fell ? `예 (${cell(r.name, 'fallTime', k.fallTime)})` : '아니오';
  lines.push(
    `| ${r.name} | ${r.milestone} | ${r.passed ? '통과' : r.knownIssue ? '실패 (알려진 문제)' : '**실패**'} | ${r.s.exploded ? '예' : '아니오'} | ${fell} | ${r.s.firstGroundContact ?? '—'} | ${r.s.finalPosture} | ${cell(r.name, 'maxAngVel', k.maxAngVel, 1)} | ${cell(r.name, 'limitP99', k.limitP99)} | ${cell(r.name, 'limitMax', k.limitMax, 1)} | ${cell(r.name, 'limitHits', k.limitHits, 0)} | ${cell(r.name, 'selfPen', k.selfPen, 3)} | ${r.ms.toFixed(3)} |`,
  );
}
// v0.2 근육 지표 (근육을 쓰는 시나리오만: 오차가 계산된 경우)
const mus = rows.filter((r) => (r.s.metrics.jointErrorMeanDeg ?? 0) > 0);
if (mus.length) {
  lines.push(
    '',
    '### 근육 지표 (v0.2~, docs/ALGORITHMS.md)',
    '',
    '| 시나리오 | 관절 오차 최대° | 관절 오차 평균° | jitter /s | 포화 비율 | energy | 추종 오차° | 추종 지연 s | 루트 보조 N·s | 무릎 30° 선행 s |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of mus) {
    const k = data[r.name]!;
    lines.push(
      `| ${r.name} | ${cell(r.name, 'errMax', k.errMax)} | ${cell(r.name, 'errMean', k.errMean)} | ${cell(r.name, 'jitter', k.jitter, 1)} | ${cell(r.name, 'saturation', k.saturation, 3)} | ${cell(r.name, 'energy', k.energy, 1)} | ${cell(r.name, 'trackErr', k.trackErr)} | ${cell(r.name, 'trackLag', k.trackLag, 3)} | ${cell(r.name, 'assistRoot', k.assistRoot, 0)} | ${cell(r.name, 'kneeLead', k.kneeLead, 3)} |`,
    );
  }
}
// v0.3 균형·품질 지표 (균형이 켜진 적 있는 시나리오)
const bal = rows.filter((r) => r.s.metrics.balanceMarginMin !== undefined);
if (bal.length) {
  lines.push(
    '',
    '### 균형·품질 지표 (v0.3~, docs/ALGORITHMS.md v0.3)',
    '',
    '| 시나리오 | 회복(충격 후 s) | 최소 여유 m | 고관절 가중치 최대 | comJerk | angJerk | 발 미끄러짐 m | 발 이동 최대 m | 반응 지연 s | 숙일 때 Hips 뒤로 m | energy | jitter /s |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of bal) {
    const k = data[r.name]!;
    lines.push(
      `| ${r.name} | ${cell(r.name, 'recAfterHit', k.recAfterHit)} | ${cell(r.name, 'marginMin', k.marginMin, 3)} | ${cell(r.name, 'hipMax', k.hipMax)} | ${cell(r.name, 'comJerk', k.comJerk, 1)} | ${cell(r.name, 'angJerk', k.angJerk, 0)} | ${cell(r.name, 'footSlide', k.footSlide, 3)} | ${cell(r.name, 'footDisp', k.footDisp, 3)} | ${cell(r.name, 'latency', k.latency, 3)} | ${cell(r.name, 'leanBack', k.leanBack, 3)} | ${cell(r.name, 'energy', k.energy, 1)} | ${cell(r.name, 'jitter', k.jitter, 1)} |`,
    );
  }
}
// v0.4 스텝·레퍼런스 지표 (스텝 계층이 있는 시나리오)
const stp = rows.filter((r) => r.milestone !== '0.1' && r.s.stepsTaken !== null && (r.s.stepsTaken > 0 || r.s.metrics.refSimilarity !== undefined));
if (stp.length) {
  const f = (x: number | undefined, d = 2) => (x === undefined ? '—' : x.toFixed(d));
  lines.push(
    '',
    '### 스텝·사람 레퍼런스 (v0.4~, refSimilarity는 보조 지표 — 통과 관문 아님)',
    '',
    '| 시나리오 | 걸음 sim/ref | 회복 s | 착지 오차 평균/최대 m | 발 미끄러짐 m | COM 최대 이동 sim/ref cm | 몸통 기울기 최대 sim/ref ° | 팔 사용 비 | refSimilarity |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of stp) {
    const m = r.s.metrics;
    lines.push(
      `| ${r.name} | ${r.s.stepsTaken}/${m.refSteps ?? '—'} | ${f(r.s.recoveredAfterHit ?? undefined)} | ${f(m.landingErrorMean, 3)}/${f(m.landingErrorMax, 3)} | ${f(m.footSlide, 3)} | ${f(m.simComPeakCm, 0)}/${f(m.refComPeakCm, 0)} | ${f(m.simTrunkPeakDeg, 0)}/${f(m.refTrunkPeakDeg, 0)} | ${f(m.refArmRatio)} | ${f(m.refSimilarity, 3)} |`,
    );
  }
}
if (regressions.length) {
  lines.push('', '## 실패 사유 (회귀)', '');
  for (const r of regressions) for (const x of r.s.expectations.failures) lines.push(`- ${r.name}: ${x}`);
}
if (known.length) {
  lines.push('', '## 알려진 문제', '', '회귀로 세지 않는다. 시나리오 `knownIssue` 필드 = README 결정 번호와 한 줄.', '', '| 시나리오 | 결과 | 알려진 문제 | 실패 사유 |', '|---|---|---|---|');
  for (const r of known) lines.push(`| ${r.name} | ${r.passed ? '통과 (해결됐는지 확인)' : '실패'} | ${r.knownIssue} | ${r.s.expectations.failures.join('; ') || '—'} |`);
}
lines.push('', `<!-- data ${JSON.stringify(data)} -->`, '');
writeFileSync(reportPath, lines.join('\n'));
console.log(`\n${passed}/${rows.length} passed, regressions ${regressions.length}, known issues ${known.filter((r) => !r.passed).length}/${known.length} failing -> ${reportPath}`);
process.exit(regressions.length ? 1 : 0);
