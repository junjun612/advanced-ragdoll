// npm run sim -- <scenario name>  →  out/<name>/log.jsonl, summary.json, meta.json
import { findScenario, loadScenario, runAndWrite } from './simCommon';

const name = process.argv[2];
if (!name) {
  console.error('usage: npm run sim -- <scenario name>');
  process.exit(2);
}
const sc = loadScenario(findScenario(name));
const res = await runAndWrite(sc);
const s = res.summary;
console.log(`${sc.name} (v${sc.milestone}) ${s.expectations.passed ? 'PASS' : 'FAIL'}  ${res.msPerStep.toFixed(3)} ms/step`);
const { expectations: _e, ...rest } = s;
console.log(JSON.stringify(rest, null, 1));
for (const f of s.expectations.failures) console.log(`  x ${f}`);
process.exit(s.expectations.passed ? 0 : 1);
