// 클립 COM 수평 속도·발 접촉 프로파일 (2026-10-27 진단): npx tsx tools/kimodo/clipProfile.ts <clip.json>... [--from 0.9] [--to 2.5]
import { refStates } from './refSimilarity';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const from = Number(opt('--from', '0.9')), to = Number(opt('--to', '2.5'));
for (const p of argv.filter((a, k) => !a.startsWith('--') && !argv[k - 1]?.startsWith('--'))) {
  const st = refStates(p);
  const row: string[] = [];
  for (let i = Math.max(1, Math.round(from * 30)); i < Math.min(st.length - 1, Math.round(to * 30)); i += 2) {
    const a = st[i - 1]!, b = st[i + 1]!;
    const v = Math.hypot(b.com[0] - a.com[0], b.com[2] - a.com[2]) * 15;
    const L = st[i]!.contacts.some((x) => x.body === 'LeftFoot') ? 'L' : '_', R = st[i]!.contacts.some((x) => x.body === 'RightFoot') ? 'R' : '_';
    row.push(`${(i / 30).toFixed(2)}:${v.toFixed(2)}${L}${R}`);
  }
  console.log(p.replace(/.*kimodo[\\/]/, '').replace(/[\\/]clip\.json$/, ''), row.join(' '));
}
