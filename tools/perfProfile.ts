// (README 결정 game-4) CPU 프로파일 요약: node --cpu-prof로 만든 .cpuprofile에서 함수별 자기 시간(샘플) 상위 N개.
// 사용법: npx tsx tools/perfProfile.ts <파일.cpuprofile> [N=15]
import { readFileSync } from 'node:fs';

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }
const [file, nArg] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file!, 'utf8')) as { nodes: Node[]; samples: number[]; startTime: number; endTime: number };
const self = new Map<string, number>();
let total = 0;
for (const n of prof.nodes) {
  const h = n.hitCount ?? 0;
  total += h;
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(src|node_modules)\//, '$1/')}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + h);
}
// 파일(모듈)별 합도 낸다 (어느 계층이 비싼가)
const byFile = new Map<string, number>();
for (const [k, v] of self) { const m = / (\S+):\d+$/.exec(k); const f = m ? m[1]! : '?'; byFile.set(f, (byFile.get(f) ?? 0) + v); }
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log(`샘플 ${total}`);
console.log('\n| 함수 (자기 시간) | % |\n|---|---|');
for (const [k, v] of top(self, Number(nArg ?? 15))) console.log(`| ${k} | ${((100 * v) / total).toFixed(1)} |`);
console.log('\n| 파일 | % |\n|---|---|');
for (const [k, v] of top(byFile, 12)) console.log(`| ${k} | ${((100 * v) / total).toFixed(1)} |`);
