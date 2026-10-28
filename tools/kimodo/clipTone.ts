// 반응 클립 후보의 몸통·골반·척추·목 흔들림과 팔 지표 (결정 clip-*): toneDiag와 같은 정의로 클립 묶음을 한 줄씩 잰다.
// 사용법: npx tsx tools/kimodo/clipTone.ts <assets/kimodo 폴더 glob>... [--json out.json]
//   예) npx tsx tools/kimodo/clipTone.ts react_upright_* react_shove_back_s08
// 열: 몸통 기울기·골반·척추·목 최대(°)/반전 수, 팔 들림 평균/p90, 팔 사용 °/s, 걸음, 끝 속도
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadDef } from './rig';
import { refStates } from './refSimilarity';
import { toneStats } from '../toneDiag';
import { armStats } from '../armMetrics';

const argv = process.argv.slice(2);
const ji = argv.indexOf('--json');
const pats = argv.filter((a, i) => !a.startsWith('--') && (ji < 0 || i !== ji + 1));
const re = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const def = loadDef();
const kim = join(ROOT, 'assets', 'kimodo');
const rows: Record<string, unknown>[] = [];
console.log('| 클립 | 후보 | 몸통 | 골반 | 척추 | 목 | 팔 들림 평균/p90 | 팔 사용 | 걸음 | 끝 속도 |\n|---|---|---|---|---|---|---|---|---|---|');
for (const d of readdirSync(kim).filter((x) => !x.includes('.') && pats.some((p) => re(p).test(x))).sort()) {
  for (const c of readdirSync(join(kim, d)).filter((x) => x.startsWith('rp12_s')).sort()) {
    const p = join(kim, d, c, 'clip.json');
    if (!existsSync(p)) continue;
    const clip = JSON.parse(readFileSync(p, 'utf8')) as { fps: number; info?: { pushFrame?: number } };
    const sc = JSON.parse(readFileSync(join(kim, d, c, 'scores.json'), 'utf8')) as { total: number; metrics: { steps?: number; endSpeed?: number } };
    const st = refStates(p);
    const t0 = (clip.info?.pushFrame ?? 30) / clip.fps;
    const fr = st.map((x) => ({ t: x.time, rot: Object.fromEntries(Object.entries(x.bodies).map(([k, b]) => [k, b.rot])) }));
    const g = toneStats(fr as never, t0, 2.5).g;
    const arm = armStats(def, fr as never, t0, 2.5);
    const f = (k: string) => `${g[k]!.peak.toFixed(0)}/${g[k]!.osc}`;
    console.log(`| ${d} | ${c} | ${f('trunk')} | ${f('pelvis')} | ${f('spine')} | ${f('neck')} | ${arm.elevMean.toFixed(0)}/${arm.elevP90.toFixed(0)} | ${arm.usage.toFixed(0)} | ${sc.metrics.steps ?? '-'} | ${(sc.metrics.endSpeed ?? 0).toFixed(2)} |`);
    rows.push({ clip: d, cand: c, g, arm, steps: sc.metrics.steps, endSpeed: sc.metrics.endSpeed, total: sc.total });
  }
}
if (ji >= 0) writeFileSync(argv[ji + 1]!, JSON.stringify(rows));
