// 걷기 추종 타임라인 (v0.6): npx tsx tools/walkTrace.ts <시나리오> [간격초=0.1] [시작] [끝]
// 발 모드: S 지지, D 착지 대기, U 떼기, W 스윙 + 접촉 방식 f 평평/t 발끝/h 뒤꿈치/n 없음 + 스윙 진행.
// out/<시나리오>/log.jsonl을 읽어 시각마다 상태·걷기 모드(발별)·클립 시각·재생 속도·COM vs 클립 COM·DCM 오차·핀·이벤트를 찍는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, iv = '0.1', a = '0', b = '1e9'] = process.argv.slice(2);
if (!name) { console.error('usage: npx tsx tools/walkTrace.ts <scenario> [interval] [from] [to]'); process.exit(2); }
const dir = join('out', name);
const lines = readFileSync(join(dir, 'log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const step = Number(iv), t0 = Number(a), t1 = Number(b);
let next = t0;
const f2 = (x: number | undefined | null, d = 2) => (x === undefined || x === null ? '-' : x.toFixed(d));
const evs = (meta.events ?? []) as { t: number; type: string; detail?: string; body?: string }[];
let ei = 0;
for (const s of lines) {
  while (ei < evs.length && evs[ei]!.t <= s.time + 1e-9) {
    const e = evs[ei++]!;
    if (e.t >= t0 && e.t <= t1) console.log(`   ** ${e.t.toFixed(3)} ${e.type} ${e.body ?? ''} ${e.detail ?? ''}`);
  }
  if (s.time + 1e-9 < next || s.time > t1) continue;
  next = s.time + step - 1e-9;
  const w = s.walk;
  const MC: Record<string, string> = { stance: 'S', landing: 'D', liftoff: 'U', swing: 'W' };
  const fm = (f: string) => (w ? `${MC[w.feet[f].mode] ?? '?'}${w.feet[f].contact[0]}${f2(w.feet[f].s, 1)}` : '');
  const cr = s.anim?.com;
  const de = w?.dcmError;
  console.log(
    `${f2(s.time)} ${s.state?.padEnd(8)} ${w ? (w.engaged ? 'W' : 'w') : '-'} L:${fm('LeftFoot')} R:${fm('RightFoot')} tau=${f2(s.anim?.tau)} r=${f2(s.anim?.rate)} ` +
    `com=(${f2(s.com[0])},${f2(s.com[1])},${f2(s.com[2])}) v=(${f2(s.comVel[0])},${f2(s.comVel[2])}) ref=(${f2(cr?.[0])},${f2(cr?.[1])},${f2(cr?.[2])}) ` +
    `e=(${f2(de?.[0])},${f2(de?.[1])}) pin=${f2(s.pin?.strength)}/${f2(s.assist?.pin, 0)} st=${s.stepping?.state ?? ''} tilt=${f2(s.debug?.spine2TiltDeg, 0)} ${w?.handover ?? ''}`,
  );
}
