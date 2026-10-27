// CLAUDE.md "반드시 지킬 것" 중 기계적으로 검사할 수 있는 규칙.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|js|mjs)$/.test(n) ? [p] : [];
  });
}

describe('project rules', () => {
  it('no Math.random calls in src/, tools/, tests/', () => {
    const call = new RegExp('Math' + String.raw`\.random\s*\(`); // 이 파일 자체가 걸리지 않게 나눠 쓴다
    const offenders = ['src', 'tools', 'tests'].flatMap(files).filter((f) => call.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('src/sim does not import three.js or touch DOM/window', () => {
    const offenders = files('src/sim').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /from\s+['"]three(\/|['"])/.test(s) || /\b(window|document)\./.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
