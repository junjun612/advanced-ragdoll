// 흐느적거림 진단 (2026-10-28, README 결정 tone-1~): 관절 묶음별 흔들림(최대 벗어남·오버슈트·진동 반전 수·정착 시간·상대 각속도),
// 근육 목표-실제 오차, 강도 배율 시계열을 sim(120 Hz 관측 훅)과 사람 레퍼런스(Kimodo 반응 클립·밀림 조사, 30 Hz)에 같은 정의로 잰다.
// 사용법:
//   npx tsx tools/toneDiag.ts run [--sweep N] [--seed0 S] [--jobs 3] [--window 2.5] [--json out.json] 시나리오...   (SET은 armEval과 같고 mu = muscles.json)
//   npx tsx tools/toneDiag.ts human [--kimodo <assets/kimodo 경로>] [--json human.json]
//   npx tsx tools/toneDiag.ts table <sim.json> [<sim2.json>] [--human human.json]       (묶음별 중앙값 표, 두 개면 짝지은 차)
//   npx tsx tools/toneDiag.ts plot <sim.json> --human human.json [--cmp <sim2.json>] --out <png>
// 정의 (창 = 충격 시각 t0 ~ t0 + window):
//   묶음 = (자식 바디, 부모 바디) 상대 회전. trunk = Spine2 월드 회전. 기준 = t0 직전 프레임. d(t) = 기준 대비 상대 회전 벡터(자식 좌표, 도)
//   peak = max|d|, speed = 상대 각속도 평균(°/s), osc = d를 주성분 축에 투영한 x(t)의 반전 수(극값에서 hystDeg 넘게 되돌아오면 1),
//   overshoot = 가장 큰 벗어남 P 뒤 반대 부호로 넘어간 최대 크기 / |P|, settle = 상대 각속도가 settleDegS를 넘은 마지막 시각 − t0 (초)
//   (sim만) err = 근육 목표-실제 오차(muscles out.errorDeg) 평균·최대, str = 강도(out.strength) 최소·평균
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Quat, multiplyQ, conjugate, toRotationVector, angleBetweenQ, rotate, swingTwist } from '../src/sim/math/quat';
import { type Vec3, dot, length } from '../src/sim/math/vec3';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const WINDOW = Number(opt('--window', '2.5'));
const DEG = 180 / Math.PI;
const HYST = 3, SETTLE_DEGS = 30;

/** 묶음: 이름 → [자식, 부모] 쌍들 (양쪽이면 둘, 값은 평균) */
export const GROUPS: Record<string, [string, string | null][]> = {
  trunk: [['Spine2', null]],
  pelvis: [['Hips', null]],
  spine: [['Spine2', 'Hips']],
  neck: [['Head', 'Spine2']],
  shoulder: [['LeftArm', 'Spine2'], ['RightArm', 'Spine2']],
  elbow: [['LeftForeArm', 'LeftArm'], ['RightForeArm', 'RightArm']],
  wrist: [['LeftHand', 'LeftForeArm'], ['RightHand', 'RightForeArm']],
  hip: [['LeftUpLeg', 'Hips'], ['RightUpLeg', 'Hips']],
  knee: [['LeftLeg', 'LeftUpLeg'], ['RightLeg', 'RightUpLeg']],
};
export const KO: Record<string, string> = { trunk: '몸통 기울기', pelvis: '골반 기울기', spine: '척추 굽힘', neck: '목', shoulder: '어깨', elbow: '팔꿈치', wrist: '손목', hip: '고관절', knee: '무릎' };
/** 근육 관절 묶음 (오차·강도) */
const MGROUPS: Record<string, string[]> = { torso: ['Spine', 'Spine2'], neck: ['Head'], shoulder: ['LeftArm', 'RightArm'], elbow: ['LeftForeArm', 'RightForeArm'], wrist: ['LeftHand', 'RightHand'], leg: ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'], ankle: ['LeftFoot', 'RightFoot'] };
export const MKO: Record<string, string> = { torso: '몸통', neck: '목', shoulder: '어깨', elbow: '팔꿈치', wrist: '손목', leg: '다리', ankle: '발목' };

export interface Frame { t: number; rot: Record<string, Quat> }
export interface GStat { peak: number; speed: number; osc: number; overshoot: number; settle: number }

/** 몸통·척추·목은 세로축(바디 y, rest 항등) 비틀기를 뺀 굽힘만 본다 — 돌아보기(pres-3)·움찔 비틀기는 흔들림이 아니다 */
const NO_TWIST = new Set(['Spine2', 'Head', 'Hips']);
const relOf = (f: Frame, c: string, p: string | null): Quat => (p ? multiplyQ(conjugate(f.rot[p]!), f.rot[c]!) : f.rot[c]!);
const bend = (q: Quat, c: string): Quat => (NO_TWIST.has(c) ? swingTwist(q, [0, 1, 0]).swing : q);

/** 한 쌍의 흔들림 지표 */
function pairStat(fr: Frame[], c: string, p: string | null, t0: number, win: number): GStat & { series: [number, number][] } {
  const i0 = Math.max(0, fr.findIndex((f) => f.t >= t0 - 1e-9) - 1);
  const base = relOf(fr[i0]!, c, p);
  const w = fr.filter((f) => f.t >= t0 - 1e-9 && f.t <= t0 + win + 1e-9);
  const d: Vec3[] = w.map((f) => { let q = bend(multiplyQ(conjugate(base), relOf(f, c, p)), c); if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]; return toRotationVector(q).map((x) => x * DEG) as Vec3; });
  // 주성분 축 (거듭제곱법)
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of d) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b]! += v[a]! * v[b]!;
  let u: Vec3 = [1, 0.5, 0.25];
  for (let k = 0; k < 30; k++) { const n: Vec3 = [0, 1, 2].map((a) => C[a * 3]! * u[0] + C[a * 3 + 1]! * u[1] + C[a * 3 + 2]! * u[2]) as Vec3; const l = length(n); if (l < 1e-9) break; u = n.map((x) => x / l) as Vec3; }
  const x = d.map((v) => dot(v, u));
  // 반전 수 (히스테리시스)
  // 처음 hystDeg 넘게 움직인 방향을 정한 뒤, 극값에서 hystDeg 넘게 되돌아올 때마다 1 (밀렸다 돌아옴 = 1, 반대로 넘어갔다 돌아옴 = 2 …)
  let osc = 0, dir = 0, ext = x[0] ?? 0, hi = ext, lo = ext;
  for (const v of x) {
    if (dir === 0) { hi = Math.max(hi, v); lo = Math.min(lo, v); if (hi - lo > HYST) { dir = v === hi ? 1 : -1; ext = v; } continue; }
    if (dir > 0) { if (v > ext) ext = v; else if (v < ext - HYST) { osc++; dir = -1; ext = v; } }
    else if (v < ext) ext = v; else if (v > ext + HYST) { osc++; dir = 1; ext = v; }
  }
  let ip = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > Math.abs(x[ip]!)) ip = i;
  const P = x[ip] ?? 0, sg = Math.sign(P) || 1;
  let over = 0;
  for (let i = ip; i < x.length; i++) over = Math.max(over, -sg * x[i]!);
  let sp = 0, settle = 0;
  for (let i = 1; i < w.length; i++) {
    const a = bend(multiplyQ(conjugate(base), relOf(w[i - 1]!, c, p)), c), b = bend(multiplyQ(conjugate(base), relOf(w[i]!, c, p)), c);
    const v = (angleBetweenQ(a, b) * DEG) / Math.max(1e-9, w[i]!.t - w[i - 1]!.t);
    sp += v;
    if (v > SETTLE_DEGS) settle = w[i]!.t - t0;
  }
  return { peak: Math.max(0, ...d.map((v) => length(v))), speed: w.length > 1 ? sp / (w.length - 1) : 0, osc, overshoot: Math.abs(P) > 2 ? over / Math.abs(P) : 0, settle, series: w.map((f, i) => [f.t - t0, length(d[i]!)]) };
}

/** (결정 chest-1) 초반 꺾임: 묶음 벗어남(기준 = 충격 직전)의 0.1초 값과 0~0.3초 최대 (몸통·골반·척추) */
export type Early = Record<'trunk' | 'pelvis' | 'spine', { at10: number; max30: number }>;
export function earlyOf(series: Record<string, [number, number][]>): Early {
  const e = {} as Early;
  for (const k of ['trunk', 'pelvis', 'spine'] as const) {
    const s = series[k]!;
    const at = s.reduce((b, p) => (Math.abs(p[0] - 0.1) < Math.abs(b[0] - 0.1) ? p : b), s[0]!);
    e[k] = { at10: at[1], max30: Math.max(0, ...s.filter((p) => p[0] <= 0.3 + 1e-9).map((p) => p[1])) };
  }
  return e;
}

export function toneStats(fr: Frame[], t0: number, win = WINDOW): { g: Record<string, GStat>; series: Record<string, [number, number][]>; trunkSigned: [number, number][] } {
  const g: Record<string, GStat> = {}, series: Record<string, [number, number][]> = {};
  for (const [k, pairs] of Object.entries(GROUPS)) {
    const st = pairs.map(([c, p]) => pairStat(fr, c, p, t0, win));
    const m = (f: (s: GStat) => number) => st.reduce((a, s) => a + f(s), 0) / st.length;
    g[k] = { peak: m((s) => s.peak), speed: m((s) => s.speed), osc: m((s) => s.osc), overshoot: m((s) => s.overshoot), settle: Math.max(...st.map((s) => s.settle)) };
    series[k] = st[0]!.series.map(([t], i) => [t, st.reduce((a, s) => a + (s.series[i]?.[1] ?? 0), 0) / st.length]);
  }
  // 몸통 기울기 (Spine2 위 축의 수직에서 벗어난 각, 도) — armMetrics trunkPeak와 같은 정의
  const trunkSigned = fr.filter((f) => f.t >= t0 - 0.5 && f.t <= t0 + win + 1e-9).map((f) => { const up = rotate(f.rot.Spine2!, [0, 1, 0]); return [f.t - t0, Math.acos(Math.max(-1, Math.min(1, up[1]))) * DEG] as [number, number]; });
  return { g, series, trunkSigned };
}

export interface Row {
  name: string; seed: number; passed: boolean; fell: boolean; steps: number; t0: number; fails: string;
  g: Record<string, GStat>; trunkPeak: number;
  early?: Early;
  err: Record<string, { mean: number; peak: number }>; str: Record<string, { min: number; mean: number }>;
  /** 30 Hz 시계열 (t − t0): 강도 묶음 평균, 몸통 기울기, 목·손목·팔꿈치 벗어남 */
  ts: { t: number[]; str: Record<string, number[]>; trunk: number[]; neck: number[]; wrist: number[]; elbow: number[]; err: Record<string, number[]>; tone?: Record<string, number[]>; spine?: number[]; pelvis?: number[]; hip?: number[] };
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

async function worker(name: string, seed: number): Promise<Row> {
  const { runScenario } = await import('../src/sim/runner');
  const { findScenario, loadScenario, loadInputs, jitterScenario } = await import('./simCommon');
  const c = cfgs() as Record<string, never>;
  let sc = jitterScenario({ ...loadScenario(findScenario(name)), seed }, seed);
  // PUSHDUR=초: duration이 없는 밀기에 접촉 시간을 준다 (진단 실험, armEval과 같음)
  if (process.env.PUSHDUR) sc = { ...sc, events: sc.events.map((e) => (e.type === 'hit' && e.hit?.type === 'push' && !e.hit.duration ? { ...e, hit: { ...e.hit, duration: Number(process.env.PUSHDUR) } } : e)) };
  const hitTs = sc.events.filter((e) => e.type === 'hit').map((e) => e.t);
  // 충격이 없는 시나리오(걷기·서기)는 1초부터 창
  const t0 = hitTs.length ? hitTs[0]! : 1;
  const fr: Frame[] = [];
  const mtr: { t: number; s: Record<string, number>; e: Record<string, number>; tone: Record<string, number> }[] = [];
  const r = await runScenario({
    ...loadInputs(sc),
    characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, hitModelConfig: c.m, animConfig: c.a, poses: c.p, reactionConfig: c.r, settleConfig: c.settle, muscles: c.mu, animClips: (await import('./reactLibEnv')).reactLib() },
    observe: {
      step: (w) => {
        const ch = w.characters[0]!;
        const t = w.time;
        if (t < t0 - 0.6 || t > t0 + WINDOW + 0.05) return;
        fr.push({ t, rot: Object.fromEntries(ch.rd.bodies.map((b) => { const q = b.rb.rotation(); return [b.name, [q.x, q.y, q.z, q.w] as Quat]; })) });
        const s: Record<string, number> = {}, e: Record<string, number> = {}, tone: Record<string, number> = {};
        for (const m of ch.muscles.joints) { s[m.name] = m.out.strength; e[m.name] = m.out.errorDeg; tone[m.name] = (m.out as { tone?: number }).tone ?? 1; }
        mtr.push({ t, s, e, tone });
      },
    },
  });
  if (process.env.OUTDIR) {
    // OUTDIR=폴더: 필름용 로그 (film.ts --compare log:<폴더>/<이름>)
    const { mkdirSync } = await import('node:fs');
    const d = join(process.env.OUTDIR, `${name}${seed > 1 ? `__s${seed}` : ''}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'log.jsonl'), r.log); writeFileSync(join(d, 'summary.json'), JSON.stringify(r.summary, null, 1)); writeFileSync(join(d, 'meta.json'), JSON.stringify(r.meta, null, 1));
  }
  const s = r.summary;
  const st = toneStats(fr, t0);
  const win = mtr.filter((m) => m.t >= t0 - 1e-9 && m.t <= t0 + WINDOW + 1e-9);
  const avg = (m: Record<string, number>, js: string[]) => js.reduce((a, j) => a + (m[j] ?? 0), 0) / js.length;
  const err: Row['err'] = {}, str: Row['str'] = {};
  for (const [k, js] of Object.entries(MGROUPS)) {
    const es = win.map((m) => avg(m.e, js)), ss = win.map((m) => avg(m.s, js));
    err[k] = { mean: es.reduce((a, b) => a + b, 0) / Math.max(1, es.length), peak: Math.max(0, ...es) };
    str[k] = { min: Math.min(...ss), mean: ss.reduce((a, b) => a + b, 0) / Math.max(1, ss.length) };
  }
  // 30 Hz 시계열 (t0 − 0.5 ~ t0 + window)
  const ts: Row['ts'] = { t: [], str: {}, trunk: [], neck: [], wrist: [], elbow: [], err: {}, tone: {}, spine: [], pelvis: [], hip: [] };
  const sAt = (arr: [number, number][], tt: number) => { let best = arr[0]; for (const p of arr) if (Math.abs(p[0] - tt) < Math.abs(best![0] - tt)) best = p; return best?.[1] ?? 0; };
  for (let tt = -0.5; tt <= WINDOW + 1e-9; tt += 1 / 30) {
    const m = mtr.reduce((b, x) => (Math.abs(x.t - t0 - tt) < Math.abs(b.t - t0 - tt) ? x : b), mtr[0]!);
    ts.t.push(+tt.toFixed(3));
    for (const [k, js] of Object.entries(MGROUPS)) { (ts.str[k] ??= []).push(+avg(m.s, js).toFixed(3)); (ts.err[k] ??= []).push(+avg(m.e, js).toFixed(1)); (ts.tone![k] ??= []).push(+avg(m.tone, js).toFixed(3)); }
    ts.trunk.push(+sAt(st.trunkSigned, tt).toFixed(2));
    ts.neck.push(+sAt(st.series.neck!, tt).toFixed(2));
    ts.wrist.push(+sAt(st.series.wrist!, tt).toFixed(2));
    ts.elbow.push(+sAt(st.series.elbow!, tt).toFixed(2));
    ts.spine!.push(+sAt(st.series.spine!, tt).toFixed(2)); ts.pelvis!.push(+sAt(st.series.pelvis!, tt).toFixed(2)); ts.hip!.push(+sAt(st.series.hip!, tt).toFixed(2));
  }
  return { name, seed, passed: s.expectations.passed, fell: s.fell, steps: s.stepsTaken ?? 0, t0, fails: s.expectations.failures.join('; '), g: st.g, trunkPeak: st.g.trunk!.peak, early: earlyOf(st.series), err, str, ts };
}

/** 사람 레퍼런스: 반응 클립 라이브러리(assets/poses/reaction 48개) + 밀림 조사 RP medium(4방향 × 6) */
async function human(): Promise<void> {
  const { refStates } = await import('./kimodo/refSimilarity');
  const kim = opt('--kimodo', 'C:/Users/junjun612/Documents/advanced-ragdoll/assets/kimodo');
  const lib = readdirSync('assets/poses/reaction').filter((f) => f.endsWith('.json')).map((f) => ({ set: 'lib', id: f.replace(/\.json$/, ''), p: join('assets/poses/reaction', f) }));
  const study = ['front', 'back', 'left', 'right'].flatMap((d) => Array.from({ length: 6 }, (_, k) => ({ set: `study_${d}`, id: `push_${d}_medium_s${k + 1}`, p: join(kim, `push_${d}_medium/rp12_s${k + 1}/clip.json`) }))).filter((x) => existsSync(x.p));
  const out: { set: string; id: string; g: Record<string, GStat>; trunkPeak: number; early: Early; ts: { t: number[]; trunk: number[]; neck: number[]; wrist: number[]; elbow: number[] } }[] = [];
  for (const c of [...lib, ...study]) {
    const clip = JSON.parse(readFileSync(c.p, 'utf8')) as { fps?: number; info?: { pushFrame?: number } };
    const t0 = (clip.info?.pushFrame ?? 30) / (clip.fps ?? 30);
    const fr: Frame[] = refStates(c.p).map((x) => ({ t: x.time, rot: Object.fromEntries(Object.entries(x.bodies).map(([k, b]) => [k, b.rot as Quat])) }));
    const st = toneStats(fr, t0);
    const sAt = (arr: [number, number][], tt: number) => { let best = arr[0]; for (const p of arr) if (Math.abs(p[0] - tt) < Math.abs(best![0] - tt)) best = p; return best?.[1] ?? 0; };
    const ts = { t: [] as number[], trunk: [] as number[], neck: [] as number[], wrist: [] as number[], elbow: [] as number[] };
    for (let tt = -0.5; tt <= WINDOW + 1e-9; tt += 1 / 30) { ts.t.push(+tt.toFixed(3)); ts.trunk.push(+sAt(st.trunkSigned, tt).toFixed(2)); ts.neck.push(+sAt(st.series.neck!, tt).toFixed(2)); ts.wrist.push(+sAt(st.series.wrist!, tt).toFixed(2)); ts.elbow.push(+sAt(st.series.elbow!, tt).toFixed(2)); }
    out.push({ set: c.set, id: c.id, g: st.g, trunkPeak: st.g.trunk!.peak, early: earlyOf(st.series), ts });
  }
  writeFileSync(opt('--json', 'human_tone.json'), JSON.stringify(out));
  console.log(`사람 클립 ${out.length}개 (라이브러리 ${lib.length}, 밀림 조사 ${study.length})`);
}

const med = (x: number[]) => { const s = x.filter((v) => Number.isFinite(v)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };
const STATS: (keyof GStat)[] = ['peak', 'speed', 'osc', 'overshoot', 'settle'];

function table(): void {
  const A = JSON.parse(readFileSync(argv[1]!, 'utf8')) as Row[];
  const B = argv[2] && !argv[2].startsWith('--') ? (JSON.parse(readFileSync(argv[2], 'utf8')) as Row[]) : null;
  const H = argv.includes('--human') ? (JSON.parse(readFileSync(opt('--human', ''), 'utf8')) as { set: string; g: Record<string, GStat> }[]) : null;
  const ok = (rs: Row[]) => rs.filter((r) => !r.fell);
  console.log(`실행 ${A.length} (넘어짐 ${A.filter((r) => r.fell).length})${B ? ` vs ${B.length} (넘어짐 ${B.filter((r) => r.fell).length})` : ''} — 안 넘어진 실행 중앙값${H ? ', 사람 = 라이브러리 중앙값 / 밀림 조사 중앙값' : ''}`);
  console.log(`| 묶음 | ${STATS.map((s) => `${s}${B ? ' 전→후' : ''}`).join(' | ')} |`);
  for (const k of Object.keys(GROUPS)) {
    const cell = (s: keyof GStat) => {
      const a = med(ok(A).map((r) => r.g[k]![s]));
      const b = B ? med(ok(B).map((r) => r.g[k]![s])) : null;
      const h = H ? `${med(H.filter((x) => x.set === 'lib').map((x) => x.g[k]![s])).toFixed(1)}/${med(H.filter((x) => x.set.startsWith('study')).map((x) => x.g[k]![s])).toFixed(1)}` : '';
      return `${a.toFixed(s === 'overshoot' ? 2 : 1)}${b !== null ? `→${b.toFixed(s === 'overshoot' ? 2 : 1)}` : ''}${h ? ` (사람 ${h})` : ''}`;
    };
    console.log(`| ${KO[k]} | ${STATS.map(cell).join(' | ')} |`);
  }
  // (결정 chest-1) 초반 꺾임 (0.1초 값 / 0~0.3초 최대)
  if (A.some((r) => r.early)) {
    const He = H as unknown as { set: string; early?: Early }[] | null;
    console.log('\n| 초반 꺾임 | 0.1초 | 0~0.3초 최대 |');
    for (const k of ['trunk', 'pelvis', 'spine'] as const) {
      const cell = (q: 'at10' | 'max30') => { const a = med(ok(A).filter((r) => r.early).map((r) => r.early![k][q])); const b = B ? med(ok(B).filter((r) => r.early).map((r) => r.early![k][q])) : null; const h = He ? med(He.filter((x) => x.early).map((x) => x.early![k][q])) : null; return `${a.toFixed(1)}${b !== null ? `→${b.toFixed(1)}` : ''}${h !== null && Number.isFinite(h) ? ` (사람 ${h.toFixed(1)})` : ''}`; };
      console.log(`| ${KO[k]} | ${cell('at10')} | ${cell('max30')} |`);
    }
  }
  console.log('\n| 근육 묶음 | 오차 평균° | 오차 최대° | 강도 최소 | 강도 평균 |');
  for (const k of Object.keys(MGROUPS)) {
    const f = (rs: Row[], g: (r: Row) => number) => med(ok(rs).map(g)).toFixed(2);
    console.log(`| ${MKO[k]} | ${f(A, (r) => r.err[k]!.mean)}${B ? `→${f(B, (r) => r.err[k]!.mean)}` : ''} | ${f(A, (r) => r.err[k]!.peak)}${B ? `→${f(B, (r) => r.err[k]!.peak)}` : ''} | ${f(A, (r) => r.str[k]!.min)}${B ? `→${f(B, (r) => r.str[k]!.min)}` : ''} | ${f(A, (r) => r.str[k]!.mean)}${B ? `→${f(B, (r) => r.str[k]!.mean)}` : ''} |`);
  }
  // 시나리오별 몸통 최대·목·손목
  console.log('\n| 시나리오 | n | 넘어짐 | 몸통 최대° | 몸통 반전 | 몸통 오버슈트 | 목 최대° | 목 반전 | 손목 속도°/s | 팔꿈치 반전 |');
  for (const n of [...new Set(A.map((r) => r.name))]) {
    const a = A.filter((r) => r.name === n), b = B?.filter((r) => r.name === n);
    const f = (rs: Row[] | undefined, g: (r: Row) => number, d = 1) => (rs ? med(ok(rs).map(g)).toFixed(d) : '');
    const c = (g: (r: Row) => number, d = 1) => `${f(a, g, d)}${b ? `→${f(b, g, d)}` : ''}`;
    console.log(`| ${n} | ${a.length} | ${a.filter((r) => r.fell).length}${b ? `→${b.filter((r) => r.fell).length}` : ''} | ${c((r) => r.trunkPeak)} | ${c((r) => r.g.trunk!.osc)} | ${c((r) => r.g.trunk!.overshoot, 2)} | ${c((r) => r.g.neck!.peak)} | ${c((r) => r.g.neck!.osc)} | ${c((r) => r.g.wrist!.speed, 0)} | ${c((r) => r.g.elbow!.osc)} |`);
  }
}

async function plot(): Promise<void> {
  const { chromium } = await import('playwright');
  const A = JSON.parse(readFileSync(argv[1]!, 'utf8')) as Row[];
  const B = argv.includes('--cmp') ? (JSON.parse(readFileSync(opt('--cmp', ''), 'utf8')) as Row[]) : null;
  const H = JSON.parse(readFileSync(opt('--human', 'human_tone.json'), 'utf8')) as { set: string; id: string; g: Record<string, GStat>; ts: { t: number[]; trunk: number[]; neck: number[]; wrist: number[]; elbow: number[] } }[];
  const scen = opt('--scenes', [...new Set(A.map((r) => r.name))].slice(0, 4).join(',')).split(',');
  const studyOf: Record<string, string> = { push_front_medium: 'study_front', push_back_medium: 'study_back', push_left_medium: 'study_left', push_right_medium: 'study_right' };
  const W = 1500, PW = 340, PH = 170, L = 50;
  const cols = 4;
  const panels: { title: string; series: { t: number[]; v: number[]; color: string; w?: number; dash?: boolean }[]; yLabel: string }[] = [];
  const colors: Record<string, string> = { torso: '#2e52a0', neck: '#8030b0', shoulder: '#c05000', elbow: '#d08000', wrist: '#c02020', leg: '#3c8a28', ankle: '#888' };
  for (const n of scen) {
    const a = A.filter((r) => r.name === n && !r.fell), b = B?.filter((r) => r.name === n && !r.fell) ?? [];
    const r1 = a[0];
    if (!r1) continue;
    // 1) 강도 시계열 (시드 1 또는 첫 실행)
    panels.push({ title: `${n} — 근육 강도 (묶음 평균${B ? ', 점선 = 전' : ''})`, yLabel: '강도', series: [...(b[0] ? Object.entries(b[0].ts.str).map(([k, v]) => ({ t: b[0]!.ts.t, v, color: colors[k]!, dash: true, w: 1 })) : []), ...Object.entries(r1.ts.str).map(([k, v]) => ({ t: r1.ts.t, v, color: colors[k]!, w: 2 }))] });
    // 2) 몸통 기울기: sim 시드들(파랑) vs 사람(초록)
    const hs = H.filter((h) => h.set === (studyOf[n] ?? 'lib'));
    panels.push({ title: `${n} — 몸통 기울기° (파랑 sim${B ? '·주황 후' : ''}, 초록 사람)`, yLabel: '도', series: [...hs.map((h) => ({ t: h.ts.t, v: h.ts.trunk, color: '#3c8a2866', w: 1 })), ...(B ? a.map((r) => ({ t: r.ts.t, v: r.ts.trunk, color: '#2e52a055', w: 1 })) : a.map((r) => ({ t: r.ts.t, v: r.ts.trunk, color: '#2e52a088', w: 1 }))), ...b.map((r) => ({ t: r.ts.t, v: r.ts.trunk, color: '#c0500088', w: 1 }))] });
    // 3) 목 벗어남
    panels.push({ title: `${n} — 목(머리↔가슴) 벗어남°`, yLabel: '도', series: [...hs.map((h) => ({ t: h.ts.t, v: h.ts.neck, color: '#3c8a2866', w: 1 })), ...a.map((r) => ({ t: r.ts.t, v: r.ts.neck, color: '#2e52a088', w: 1 })), ...b.map((r) => ({ t: r.ts.t, v: r.ts.neck, color: '#c0500088', w: 1 }))] });
    // 4) 손목 벗어남
    panels.push({ title: `${n} — 손목(손↔전완) 벗어남°`, yLabel: '도', series: [...hs.map((h) => ({ t: h.ts.t, v: h.ts.wrist, color: '#3c8a2866', w: 1 })), ...a.map((r) => ({ t: r.ts.t, v: r.ts.wrist, color: '#2e52a088', w: 1 })), ...b.map((r) => ({ t: r.ts.t, v: r.ts.wrist, color: '#c0500088', w: 1 }))] });
  }
  const rows = Math.ceil(panels.length / cols);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${rows * (PH + 40) + 80}" font-family="Malgun Gothic, sans-serif"><rect width="100%" height="100%" fill="#fff"/>`;
  svg += `<text x="10" y="24" font-size="18" font-weight="bold">${opt('--title', '흐느적거림 진단: 강도·몸통·목·손목 (가로축 = 충격 뒤 초)')}</text>`;
  svg += `<text x="10" y="46" font-size="12">강도 색: ${Object.entries(colors).map(([k, c]) => `<tspan fill="${c}">■ ${MKO[k]}</tspan>`).join('  ')}</text>`;
  panels.forEach((p, i) => {
    const x0 = 10 + (i % cols) * (PW + 30), y0 = 60 + Math.floor(i / cols) * (PH + 40);
    const all = p.series.flatMap((s) => s.v);
    let lo = Math.min(0, ...all), hi = Math.max(...all);
    if (hi - lo < 1e-6) hi = lo + 1;
    const T0 = -0.5, T1 = WINDOW;
    const xs = (t: number) => x0 + L + ((PW - L) * (t - T0)) / (T1 - T0);
    const ys = (v: number) => y0 + 20 + (PH - 20) * (1 - (v - lo) / (hi - lo));
    svg += `<text x="${x0}" y="${y0 + 12}" font-size="12">${p.title}</text><rect x="${x0 + L}" y="${y0 + 20}" width="${PW - L}" height="${PH - 20}" fill="none" stroke="#ccc"/>`;
    svg += `<text x="${x0 + L - 4}" y="${y0 + 28}" font-size="10" text-anchor="end">${hi.toFixed(hi < 2 ? 2 : 0)}</text><text x="${x0 + L - 4}" y="${y0 + PH}" font-size="10" text-anchor="end">${lo.toFixed(lo > -2 && lo !== 0 ? 2 : 0)}</text>`;
    svg += `<line x1="${xs(0)}" y1="${y0 + 20}" x2="${xs(0)}" y2="${y0 + PH}" stroke="#e66" stroke-dasharray="3,3"/>`;
    for (let t = 0; t <= T1 + 1e-9; t += 0.5) svg += `<text x="${xs(t)}" y="${y0 + PH + 13}" font-size="10" text-anchor="middle">${t}</text>`;
    for (const s of p.series) svg += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.w ?? 1.5}" ${s.dash ? 'stroke-dasharray="4,3"' : ''} points="${s.t.map((t, k) => `${xs(t).toFixed(1)},${ys(s.v[k]!).toFixed(1)}`).join(' ')}"/>`;
  });
  svg += '</svg>';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: rows * (PH + 40) + 80 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: opt('--out', 'tone.png'), fullPage: true });
  await browser.close();
  console.log(`그림 ${opt('--out', 'tone.png')}`);
}

/** 묶음별 sim/사람 비교 막대 (안 넘어진 밀기·총탄 실행 중앙값 vs 사람 라이브러리·밀림 조사 중앙값): npx tsx tools/toneDiag.ts bars <sim.json> --human h.json --out x.png */
async function bars(): Promise<void> {
  const { chromium } = await import('playwright');
  const A = (JSON.parse(readFileSync(argv[1]!, 'utf8')) as Row[]).filter((r) => !r.fell && !/walk|stand_still/.test(r.name));
  const H = JSON.parse(readFileSync(opt('--human', ''), 'utf8')) as { set: string; g: Record<string, GStat> }[];
  const metrics: [keyof GStat, string][] = [['peak', '최대 벗어남 (°)'], ['speed', '상대 각속도 평균 (°/s)'], ['osc', '반전 수 (흔들림)'], ['settle', '정착 시간 (초)']];
  const groups = Object.keys(GROUPS);
  const W = 1500, PH = 230, L = 60;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${metrics.length * (PH + 40) + 80}" font-family="Malgun Gothic, sans-serif"><rect width="100%" height="100%" fill="#fff"/>`;
  svg += `<text x="10" y="26" font-size="19" font-weight="bold">${opt('--title', '흐느적거림 진단: 관절 묶음별 sim vs 사람 (밀기·총탄, 넘어지지 않은 실행 중앙값)')}</text>`;
  svg += `<text x="10" y="50" font-size="13"><tspan fill="#2e52a0">■ sim (n=${A.length})</tspan>  <tspan fill="#3c8a28">■ 사람 반응 클립 라이브러리 (48)</tspan>  <tspan fill="#9bc48a">■ 사람 밀림 조사 medium (24)</tspan>  · 막대 위 숫자 = sim ÷ 라이브러리</text>`;
  metrics.forEach(([k, title], mi) => {
    const y0 = 70 + mi * (PH + 40);
    const vals = groups.map((g) => [med(A.map((r) => r.g[g]![k])), med(H.filter((h) => h.set === 'lib').map((h) => h.g[g]![k])), med(H.filter((h) => h.set.startsWith('study')).map((h) => h.g[g]![k]))]);
    const hi = Math.max(...vals.flat()) * 1.15;
    svg += `<text x="${L}" y="${y0 + 14}" font-size="14" font-weight="bold">${title}</text><line x1="${L}" y1="${y0 + PH}" x2="${W - 20}" y2="${y0 + PH}" stroke="#999"/>`;
    const gw = (W - L - 40) / groups.length;
    groups.forEach((g, gi) => {
      const x = L + gi * gw + 10, bw = (gw - 30) / 3;
      vals[gi]!.forEach((v, j) => {
        const h = ((PH - 30) * v) / hi;
        svg += `<rect x="${x + j * bw}" y="${y0 + PH - h}" width="${bw - 3}" height="${h}" fill="${['#2e52a0', '#3c8a28', '#9bc48a'][j]}"/>`;
        svg += `<text x="${x + j * bw + bw / 2}" y="${y0 + PH - h - 3}" font-size="10" text-anchor="middle">${v.toFixed(k === 'osc' || k === 'settle' ? 1 : 0)}</text>`;
      });
      const ratio = vals[gi]![0]! / Math.max(1e-6, vals[gi]![1]!);
      svg += `<text x="${x + 1.5 * bw}" y="${y0 + 32}" font-size="13" text-anchor="middle" font-weight="bold" fill="${ratio > 1.5 ? '#c02020' : ratio < 0.67 ? '#c05000' : '#333'}">×${ratio.toFixed(1)}</text>`;
      svg += `<text x="${x + 1.5 * bw}" y="${y0 + PH + 16}" font-size="13" text-anchor="middle">${KO[g]}</text>`;
    });
  });
  svg += '</svg>';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: metrics.length * (PH + 40) + 80 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: opt('--out', 'tone_bars.png'), fullPage: true });
  await browser.close();
  console.log(`그림 ${opt('--out', 'tone_bars.png')}`);
}

async function master(): Promise<void> {
  const N = Number(opt('--sweep', '1'));
  const J = Math.min(3, Number(opt('--jobs', '3')));
  const s0 = Number(opt('--seed0', '1'));
  const skip = new Set(['--sweep', '--jobs', '--window', '--seed0', '--json']);
  const names = argv.slice(1).filter((a, k) => !a.startsWith('--') && !skip.has(argv[k] ?? ''));
  const jobs = names.flatMap((n) => Array.from({ length: N }, (_, k) => ({ n, seed: k + s0 })));
  const rows: Row[] = [];
  let next = 0, done = 0;
  const run = (): Promise<void> => new Promise((res) => {
    const j = jobs[next++];
    if (!j) return res();
    const p = spawn(process.execPath, ['--import', 'tsx', 'tools/toneDiag.ts', '--worker', j.n, String(j.seed), '--window', String(WINDOW)], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('ROW '));
      if (line) rows.push(JSON.parse(line.slice(4)) as Row);
      else console.error(`실패 ${j.n} ${j.seed}: ${err.slice(-800)}`);
      if (++done % 12 === 0) console.error(`  ${done}/${jobs.length}`);
      void run().then(res);
    });
  });
  await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, run));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.seed - b.seed);
  writeFileSync(opt('--json', 'tone.json'), JSON.stringify(rows));
  console.log(`${rows.length}개 실행 → ${opt('--json', 'tone.json')} (통과 ${rows.filter((r) => r.passed).length}, 넘어짐 ${rows.filter((r) => r.fell).length})`);
}

if (argv[0] === '--worker') worker(argv[1]!, Number(argv[2])).then((r) => process.stdout.write('ROW ' + JSON.stringify(r) + '\n')).catch((e) => { console.error(e); process.exit(1); });
else if (argv[0] === 'human') void human();
else if (argv[0] === 'table') table();
else if (argv[0] === 'plot') void plot();
else if (argv[0] === 'bars') void bars();
else if (argv[0] === 'run') void master();
else if (process.argv[1]?.endsWith('toneDiag.ts')) console.log('사용법: tools/toneDiag.ts run|human|table|plot (파일 머리 주석)');
