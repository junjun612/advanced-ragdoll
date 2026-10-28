// 실험용 반응 클립 라이브러리 (armEval·toneDiag 공통, README 결정 160~ · clip-*)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * REACTLIB = 쉼표로 나눈 항목. 반응 클립을 주면 정적 라이브러리(src/sim/character/reactionClips.generated.ts) 대신 이것만 쓴다(api.ts).
 * - assets/kimodo/<폴더> 또는 <폴더>/<후보> (glob '*' 허용) → react_<폴더>_<후보> 이름의 애니 클립
 * - dir:<경로> → 그 폴더의 *.json 포즈 클립(이름 = 파일 이름, reactSelect write 형식)
 * 없으면 undefined (정적 라이브러리만).
 */
export function reactLib(): Record<string, never> | undefined {
  const spec = process.env.REACTLIB;
  if (!spec) return undefined;
  const out: Record<string, unknown> = {};
  const dirs = readdirSync('assets/kimodo');
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (item.startsWith('dir:')) {
      const base = item.slice(4);
      for (const f of readdirSync(base).filter((x) => x.endsWith('.json'))) {
        const name = f.replace(/\.json$/, '');
        out[name] = { ...JSON.parse(readFileSync(join(base, f), 'utf8')), name };
      }
      continue;
    }
    const [d0, c0] = item.split('/');
    const re = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const d of dirs.filter((x) => re(d0!).test(x))) {
      const base = join('assets/kimodo', d);
      for (const c of readdirSync(base).filter((x) => re(c0 ?? 'rp12_s*').test(x))) {
        const p = join(base, c, 'clip.json');
        if (!existsSync(p)) continue;
        const f = JSON.parse(readFileSync(p, 'utf8'));
        out[`react_${d}_${c}`] = { ...f, name: `react_${d}_${c}` };
      }
    }
  }
  return out as Record<string, never>;
}
