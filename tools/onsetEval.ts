// 첫 걸음 시각 분해 (2026-10-28, 결정 onset-*): 밀림 → 스텝 결정 → 이륙 → 착지 시각과 그 사이 몸통 기울기·고관절 전략.
// 사용법:
//   npx tsx tools/onsetEval.ts human [--kimodo <assets/kimodo>] [--json out.json]      사람: 반응 클립 라이브러리 + 밀림 조사 RP medium·hard
//   npx tsx tools/onsetEval.ts run [--sweep N] [--seed0 S] [--jobs 3] [--json out.json] 시나리오...   (SET은 armEval과 같음, REACTLIB 지원)
//   npx tsx tools/onsetEval.ts table <a.json> [<b.json>]
// 정의 (t = 충격 뒤 초):
//   decide = 스텝 계층이 처음 스텝(state 'step')에 들어간 시각 (sim만), lift = 디딤 발 하나가 처음 땅에서 떨어진 시각(sim: 스윙 단계 시작, 사람: 클립 발 접촉 끝),
//   land = 그 발이 5cm 넘게 옮겨 다시 닿은 시각, trunkAtLand = 착지까지 Spine2 기울기 최대(°), trunkPeak = 충격 뒤 2.5초 최대,
//   hipW = 착지까지 고관절 전략 가중치 평균(sim), comPeak = 착지까지 COM 수평 속도 최대 / 충격 직후 속도(배)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Quat, rotate } from '../src/sim/math/quat';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const DEG = 180 / Math.PI;
const tiltOf = (q: Quat) => Math.acos(Math.max(-1, Math.min(1, rotate(q, [0, 1, 0])[1]))) * DEG;

export interface OnsetRow { set: string; id: string; seed?: number; decide: number | null; lift: number | null; land: number | null; trunkAtLand: number; trunkPeak: number; hipW?: number; comGain?: number; passed?: boolean; fell?: boolean; steps?: number }

async function human(): Promise<void> {
  const { refStates } = await import('./kimodo/refSimilarity');
  const kim = opt('--kimodo', 'C:/Users/junjun612/Documents/advanced-ragdoll/assets/kimodo');
  const items: { set: string; id: string; p: string }[] = readdirSync('assets/poses/reaction').filter((f) => f.endsWith('.json')).map((f) => ({ set: 'lib', id: f.replace(/\.json$/, ''), p: join('assets/poses/reaction', f) }));
  for (const st of ['medium', 'hard']) for (const d of ['front', 'back', 'left', 'right']) for (let k = 1; k <= 6; k++) items.push({ set: `study_${st}`, id: `push_${d}_${st}_s${k}`, p: join(kim, `push_${d}_${st}/rp12_s${k}/clip.json`) });
  const rows: OnsetRow[] = [];
  for (const it of items) {
    if (!existsSync(it.p)) continue;
    const clip = JSON.parse(readFileSync(it.p, 'utf8')) as { fps: number; frames: { contacts: Record<string, boolean> }[]; info?: { pushFrame?: number } };
    const t0 = (clip.info?.pushFrame ?? 30) / clip.fps;
    const states = refStates(it.p);
    const i0 = Math.round(t0 * clip.fps);
    let lift: number | null = null, land: number | null = null, foot = -1, liftPos: number[] | null = null;
    for (let i = i0; i < clip.frames.length; i++) {
      const fc = clip.frames[i]!.contacts, pc = clip.frames[i - 1]!.contacts;
      const c = [fc.LeftFoot, fc.RightFoot], cp = [pc.LeftFoot, pc.RightFoot];
      if (foot < 0) {
        for (const f of [0, 1]) if (!c[f] && cp[f]) { foot = f; lift = (i - i0) / clip.fps; const b = states[i - 1]!.bodies[f ? 'RightFoot' : 'LeftFoot']!; liftPos = [b.pos[0], b.pos[2]]; break; }
      } else if (c[foot]) {
        const b = states[i]!.bodies[foot ? 'RightFoot' : 'LeftFoot']!;
        if (Math.hypot(b.pos[0] - liftPos![0]!, b.pos[2] - liftPos![1]!) > 0.05) { land = (i - i0) / clip.fps; break; }
      }
    }
    const tl = states.filter((s) => s.time >= t0 && s.time <= t0 + 2.5).map((s) => ({ t: s.time - t0, a: tiltOf(s.bodies.Spine2!.rot as Quat) }));
    const base = tiltOf(states[i0]!.bodies.Spine2!.rot as Quat);
    rows.push({ set: it.set, id: it.id, decide: null, lift, land, trunkAtLand: Math.max(0, ...tl.filter((x) => land === null || x.t <= land + 1e-6).map((x) => x.a - base)), trunkPeak: Math.max(0, ...tl.map((x) => x.a - base)) });
  }
  writeFileSync(opt('--json', 'onset_human.json'), JSON.stringify(rows));
  summarize(rows, (r) => r.set);
}

function cfgs(): Record<string, unknown> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const poses: Record<string, unknown> = {};
  for (const f of readdirSync('config/poses')) if (f.endsWith('.json')) poses[f.replace(/\.json$/, '')] = rd(join('config/poses', f));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), m: rd('config/hitModel.json'), a: rd('config/animDriver.json'), r: rd('config/reaction.json'), settle: rd('config/settle.json'), mu: rd('config/muscles.json'), p: poses };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c;
}

async function worker(name: string, seed: number): Promise<OnsetRow> {
  const { runScenario } = await import('../src/sim/runner');
  const { findScenario, loadScenario, loadInputs, jitterScenario } = await import('./simCommon');
  const { reactLib } = await import('./reactLibEnv');
  const c = cfgs() as Record<string, never>;
  const sc = jitterScenario({ ...loadScenario(findScenario(name)), seed }, seed);
  const t0 = sc.events.find((e) => e.type === 'hit')?.t ?? 1;
  let decide: number | null = null, lift: number | null = null, land: number | null = null, v0 = 0, vMax = 0, hw = 0, hn = 0, trunkAtLand = 0, trunkPeak = 0, base: number | null = null;
  const r = await runScenario({
    ...loadInputs(sc),
    characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, hitModelConfig: c.m, animConfig: c.a, poses: c.p, reactionConfig: c.r, settleConfig: c.settle, muscles: c.mu, animClips: reactLib() },
    observe: {
      step: (w) => {
        const ch = w.characters[0]!;
        const t = w.time - t0;
        const q = ch.rd.body('Spine2').rb.rotation();
        const a = tiltOf([q.x, q.y, q.z, q.w]);
        if (t < 0) { base = a; return; }
        if (t > 2.5) return;
        const d = a - (base ?? 0);
        trunkPeak = Math.max(trunkPeak, d);
        const ss = ch.stepping.state;
        const v = ch.rd.com().vel, vh = Math.hypot(v[0], v[2]);
        if (t <= 0.03) v0 = Math.max(v0, vh);
        if (land === null) {
          trunkAtLand = Math.max(trunkAtLand, d);
          vMax = Math.max(vMax, vh);
          hw += ch.balance.state.hipWeight ?? 0; hn++;
          if (decide === null && ss.state === 'step') decide = t;
          if (lift === null && ss.state === 'step' && ss.phase === 'swing') lift = t;
          if (lift !== null && (ss.state !== 'step' || ss.phase !== 'swing')) land = t;
        }
      },
    },
  });
  const s = r.summary;
  return { set: name, id: `${name}#${seed}`, seed, decide, lift, land, trunkAtLand, trunkPeak, hipW: hn ? hw / hn : 0, comGain: v0 > 1e-3 ? vMax / v0 : 0, passed: s.expectations.passed, fell: s.fell, steps: s.stepsTaken ?? 0 };
}

async function master(): Promise<void> {
  const N = Number(opt('--sweep', '1')), J = Math.min(3, Number(opt('--jobs', '3'))), s0 = Number(opt('--seed0', '1'));
  const skip = new Set(['--sweep', '--jobs', '--seed0', '--json']);
  const names = argv.slice(1).filter((a, k) => !a.startsWith('--') && !skip.has(argv[k] ?? ''));
  const jobs = names.flatMap((n) => Array.from({ length: N }, (_, k) => ({ n, seed: k + s0 })));
  const rows: OnsetRow[] = [];
  let next = 0;
  const run = (): Promise<void> => new Promise((res) => {
    const j = jobs[next++];
    if (!j) return res();
    const p = spawn(process.execPath, ['--import', 'tsx', 'tools/onsetEval.ts', '--worker', j.n, String(j.seed)], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('ROW '));
      if (line) rows.push(JSON.parse(line.slice(4)) as OnsetRow); else console.error(`실패 ${j.n} ${j.seed}: ${err.slice(-600)}`);
      void run().then(res);
    });
  });
  await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, run));
  rows.sort((a, b) => a.set.localeCompare(b.set) || (a.seed ?? 0) - (b.seed ?? 0));
  writeFileSync(opt('--json', 'onset.json'), JSON.stringify(rows));
  summarize(rows, (r) => r.set);
}

const med = (a: number[]) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const q = (a: number[], p: number) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : NaN; };
function summarize(rows: OnsetRow[], key: (r: OnsetRow) => string): void {
  console.log('| 묶음 | n | 결정 | 이륙 (p25~p75) | 착지 (p25~p75) | 착지까지 몸통° | 몸통 최대° | 고관절 w | COM 증가 | 통과 | 넘어짐 |\n|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of [...new Set(rows.map(key))]) {
    const g = rows.filter((r) => key(r) === k);
    const f = (sel: (r: OnsetRow) => number | null | undefined) => g.map((r) => sel(r) ?? NaN);
    const fm = (a: number[], d = 2) => med(a).toFixed(d);
    console.log(`| ${k} | ${g.length} | ${fm(f((r) => r.decide))} | ${fm(f((r) => r.lift))} (${q(f((r) => r.lift), 0.25).toFixed(2)}~${q(f((r) => r.lift), 0.75).toFixed(2)}) | ${fm(f((r) => r.land))} (${q(f((r) => r.land), 0.25).toFixed(2)}~${q(f((r) => r.land), 0.75).toFixed(2)}) | ${fm(f((r) => r.trunkAtLand), 0)} | ${fm(f((r) => r.trunkPeak), 0)} | ${fm(f((r) => r.hipW))} | ${fm(f((r) => r.comGain))} | ${g.filter((r) => r.passed).length} | ${g.filter((r) => r.fell).length} |`);
  }
}

if (argv[0] === '--worker') worker(argv[1]!, Number(argv[2])).then((r) => process.stdout.write('ROW ' + JSON.stringify(r) + '\n')).catch((e) => { console.error(e); process.exit(1); });
else if (argv[0] === 'human') void human();
else if (argv[0] === 'run') void master();
else if (argv[0] === 'table') { const A = JSON.parse(readFileSync(argv[1]!, 'utf8')) as OnsetRow[]; const B = argv[2] ? (JSON.parse(readFileSync(argv[2], 'utf8')) as OnsetRow[]) : []; summarize([...A.map((r) => ({ ...r, set: 'A ' + r.set })), ...B.map((r) => ({ ...r, set: 'B ' + r.set }))], (r) => r.set); }
else console.log('사용법: tools/onsetEval.ts human|run|table');
