// (v0.8c 탐색용) 시나리오를 JSON 덮어쓰기로 바꿔 가며 돌리고 접촉·반응 이벤트 요약만 찍는다 (파일을 쓰지 않는다).
// 사용법: npx tsx tools/interactTry.ts <scenario> '<JSON 덮어쓰기 배열>'  예: '[{"characters.0.spawn.position":[0.4,0,2.2]}]'
import { readFileSync } from 'node:fs';
import { findScenario, loadScenario, loadInputs } from './simCommon';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import { INTERACTION } from '../src/sim/interaction';

let restore = (): void => {};

function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  const ks = path.split('.');
  let c = o as Record<string, unknown>;
  for (const k of ks.slice(0, -1)) c = c[k] as Record<string, unknown>;
  c[ks.at(-1)!] = v;
}

const base = loadScenario(findScenario(process.argv[2]!));
const arg = process.argv[3] ?? '[{}]';
const variants = JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg) as Record<string, unknown>[];
const show = new Set(['hit', 'walkHandover', 'walkResume', 'behaviorStart', 'step', 'exploded', 'getupStart', 'getupDone']);
for (const v of variants) {
  const sc = JSON.parse(JSON.stringify(base)) as Scenario;
  // 'cfg.<경로>' = config/interaction.json 값 바꾸기 (이 실행만)
  const saved = JSON.parse(JSON.stringify(INTERACTION)) as typeof INTERACTION;
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('cfg.')) setPath(INTERACTION as unknown as Record<string, unknown>, k.slice(4), x);
    else setPath(sc as unknown as Record<string, unknown>, k, x);
  }
  restore = () => Object.assign(INTERACTION, saved);
  const r = await runScenario(loadInputs(sc));
  const s = r.summary;
  const line = (n: string, x: typeof s) => `${n}: fell=${x.fell}${x.fell ? `@${x.fallTime?.toFixed(2)}` : ''} steps=${x.stepsTaken} pen=${(x.metrics.interPenetrationMax ?? 0).toFixed(4)} hits=${x.metrics.contactHits ?? 0}/${x.metrics.propHits ?? 0} maxDv=${Math.max(x.metrics.contactHitMaxDv ?? 0, x.metrics.propHitMaxDv ?? 0).toFixed(2)} walkEng=${(x.metrics.walkEngagedFrac ?? 0).toFixed(2)} dist=${(x.metrics.walkDistance ?? 0).toFixed(2)} expl=${x.exploded}`;
  console.log(`=== ${JSON.stringify(v)}  ${s.expectations.passed ? 'PASS' : 'FAIL ' + s.expectations.failures.join('; ')}`);
  console.log('  ' + line(r.meta.characters?.[0]?.name ?? 'A', s));
  for (const [n, o] of Object.entries(s.others ?? {})) console.log('  ' + line(n, o));
  restore();
  if (process.argv.includes('--events')) for (const e of r.meta.events) if (show.has(e.type)) console.log(`   ${e.t.toFixed(2)} ${e.char ?? ''} ${e.type} ${e.detail ?? ''} ${e.body ?? ''} ${e.dv?.toFixed(2) ?? ''}`);
}
