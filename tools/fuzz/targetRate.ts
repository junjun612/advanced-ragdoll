// 팔 근육 목표 변화 속도 조사 (퍼징 원인 찾기): 시나리오(기본 sim:all 전체)마다 팔 관절별 한 스텝 목표 변화 각속도(rad/s) 분포.
// muscles targetInertialize.joints에 든 관절의 원래 목표(관성화 전)를 읽는다.
// npx tsx tools/fuzz/targetRate.ts [시나리오 이름 ...] [--fuzz 시드,시드] [--over 30]
import { runScenario } from '../../src/sim/runner';
import { listScenarioFiles, loadScenario, loadInputs } from '../simCommon';
import { fuzzCase } from './gen';
import type { Scenario } from '../../src/sim/scenario';
import { angleBetweenQ, type Quat } from '../../src/sim/math/quat';

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const fuzzSeeds = val('--fuzz')?.split(',').map(Number) ?? [];
const over = Number(val('--over') ?? 30);
const names = args.filter((a, i) => !a.startsWith('--') && !['--fuzz', '--over'].includes(args[i - 1] ?? ''));
let scs: Scenario[] = fuzzSeeds.map((s) => fuzzCase(s).scenario);
if (!fuzzSeeds.length) scs = listScenarioFiles().map(loadScenario).filter((s) => !s.batch && (!names.length || names.includes(s.name)));
const all = new Map<string, number[]>();
for (const sc of scs) {
  const prev = new Map<string, Quat>();
  const hits: string[] = [];
  await runScenario({
    ...loadInputs(sc),
    observe: {
      step: (w) => {
        const ch = w.characters[0]!;
        // 관절 상대 각속도 (근육이 켜져 있을 때, rad/s)
        const st = ch.getState();
        for (const [jn, j] of Object.entries(st.joints)) {
          if (j.strength < 0.5) continue;
          const key = `속도 ${jn.replace(/^(Left|Right)/, '')}`;
          (all.get(key) ?? all.set(key, []).get(key)!).push(Math.hypot(...j.relAngVelDegS) * (Math.PI / 180));
        }
        for (const m of ch.muscles.joints) {
          const q = m.inert?.raw;
          if (!q) { prev.delete(m.name); continue; }
          const p = prev.get(m.name);
          if (p) {
            const r = angleBetweenQ(p, q) / w.dt;
            const key = m.name.replace(/^(Left|Right)/, '');
            (all.get(key) ?? all.set(key, []).get(key)!).push(r);
            if (r > over) hits.push(`${m.name} ${r.toFixed(0)}@${w.time.toFixed(3)}`);
          }
          prev.set(m.name, [...q] as Quat);
        }
      },
    },
  });
  console.log(`${sc.name}: ${hits.length} > ${over} rad/s ${hits.slice(0, 8).join(', ')}`);
}
console.log('\n관절 | p99 | p99.9 | 최대 | >20 | >30 | >40 rad/s (스텝 수)');
for (const [k, xs] of [...all].sort()) {
  xs.sort((a, b) => a - b);
  const p = (f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]!.toFixed(1);
  console.log(`${k} | ${p(0.99)} | ${p(0.999)} | ${xs.at(-1)!.toFixed(0)} | ${xs.filter((x) => x > 20).length} | ${xs.filter((x) => x > 30).length} | ${xs.filter((x) => x > 40).length}`);
}
