// 두 out 폴더의 log.jsonl·summary.json·meta.json(runs/ 포함)을 바이트 비교한다 (회귀 확인: 혼자인 캐릭터 시나리오가 그대로인지).
// 사용법: npx tsx tools/outCompare.ts <기준 out 폴더> [비교 out 폴더 = out]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const base = process.argv[2]!, cur = process.argv[3] ?? 'out';
const files: string[] = [];
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/^(log\.jsonl|summary\.json|meta\.json)$/.test(n)) files.push(relative(base, p));
  }
};
walk(base);
let diff = 0, missing = 0;
for (const f of files) {
  const c = join(cur, f);
  if (!existsSync(c)) { missing++; console.log(`없음 ${f}`); continue; }
  if (!readFileSync(join(base, f)).equals(readFileSync(c))) { diff++; console.log(`다름 ${f}`); }
}
console.log(`파일 ${files.length}개, 다름 ${diff}, 없음 ${missing}`);
process.exit(diff || missing ? 1 : 0);
