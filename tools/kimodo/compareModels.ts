// 모델 비교표: 클립마다 모델별 1위·평균 점수와 주요 지표 평균 (docs/KIMODO_COMPARE.md에 붙여 넣는 마크다운).
// 사용법: npx tsx tools/kimodo/compareModels.ts idle_relaxed walk_forward ...
import { join } from 'node:path';
import { ROOT, loadKimodoConfig, readJson } from './rig';

interface Row { model: string; seed: number; total: number; metrics: Record<string, number | string | null>; expectFailures: string[] }

const cfg = loadKimodoConfig();
const clips = process.argv.slice(2);
const cols: [string, string, number][] = [
  ['footSlideRawCmPerS', '미끄러짐 cm/s', 2], ['jerkP95', '저크 p95', 0], ['limitViolationDegMean', '제한위반 °', 2],
  ['handClampDegMean', '손목 자름 °', 1], ['retargetErrCm', '리타깃 cm', 1], ['seamPosCm', '이음매 cm', 2], ['endPoseDeg', '끝-서기 °', 1],
];
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const lines = [
  `| 클립 | 모델 | 1위 (시드) | 1위 점수 | 평균 점수 | 기대 위반 후보 | ${cols.map((c) => `${c[1]} (평균)`).join(' | ')} |`,
  `|---|---|---|---|---|---|${cols.map(() => '---').join('|')}|`,
];
for (const clip of clips) {
  const rows = readJson<Row[]>(join(ROOT, 'assets', 'kimodo', clip, 'ranking.json'));
  for (const model of Object.keys(cfg.servers)) {
    const r = rows.filter((x) => x.model === model);
    if (!r.length) continue;
    const best = r[0]!;
    const fails = r.filter((x) => x.expectFailures.length).length;
    lines.push(`| ${clip} | ${cfg.servers[model]!.label} | 시드 ${best.seed} | ${best.total.toFixed(2)} | ${mean(r.map((x) => x.total)).toFixed(2)} | ${fails}/${r.length} | ${cols.map(([k, , d]) => f(mean(r.map((x) => x.metrics[k]).filter((v): v is number => typeof v === 'number')), d)).join(' | ')} |`);
  }
}
console.log(lines.join('\n'));
