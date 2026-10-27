// 겟업 라이브러리 만들기 (SPEC 12 v0.7 '겟업 라이브러리 생성'). 사용법: npm run getup:build -- [단계…] [옵션]
//   단계(기본 전부): sample → cluster → generate → test → write
//   --samples N (기본 260)  --k K (대표 자세 수, 기본 30)  --seeds 1,2,3  --insuranceSeeds 1..6  --force-test
// 1. sample: 무작위 쓰러짐(src/sim/getupScenarios.ts: 밀기·골반 밀기·폭발·배 총탄·걷다 밀림·사망) N개를 돌리고, 겟업 판정이 시작을 정하는 순간
//    (누워 안정 + 지연, config/getup.json detect)의 자세를 모은다 (probe). → assets/library/getup_samples.json
// 2. cluster: 특징 벡터 비용(yaw 정렬, getupFeatures.ts)으로 k-medoids → 대표 자세 K개 + 보험(엎드림·누움 중심 자세). → getup_clusters.json
// 3. generate: 대표 자세마다 Kimodo(RP-v1.2) 시작 키프레임 = 그 자세(0프레임 오차 ≤ 2cm 확인), 끝 키프레임 = 서기 자세,
//    프롬프트 GETUP_TEXT, 시드별 생성(캐시) → 포즈 클립(지면 맞춤, 균형 복귀 시각). 보험 자세는 시드를 넉넉히.
// 4. test: 클립마다 대표 자세 + 가까운 구성원 자세(최대 3)에서 물리로 일어서 보고(그 클립만 씀) 성공률을 잰다.
// 5. write: 대표 자세에서 성공하고 성공률 ≥ minRate인 클립만 assets/poses/getup/<id>.json, 인덱스 assets/library/getup.json,
//    sim 정적 import src/sim/character/getupClips.generated.ts, assets/kimodo/INDEX.md 절을 쓴다.
// 서버: RP-v1.2(5310)를 켜 둔다(docs/KIMODO.md). 요청은 한 번에 하나.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../../src/sim/api';
import { randomFallScenario } from '../../src/sim/getupScenarios';
import { classifyFeature, matchFeature, poseFeature, POSTURE_KO, rotateFeature, type PoseFeature, type PostureClass } from '../../src/sim/character/getupFeatures';
import getupCfg from '../../config/getup.json';
import type { GetupConfig, GetupEntry } from '../../src/sim/character/getup';
import type { Scenario } from '../../src/sim/scenario';
import type { Vec3 } from '../../src/sim/math/vec3';
import type { Quat } from '../../src/sim/math/quat';
import { loadInputs } from '../simCommon';
import { ROOT, Rig, loadKimodoConfig } from './rig';
import { Soma } from './soma';
import { somaSkeleton } from './clipToLog';
import { GETUP_TEXT, generateGetup, type EndMode } from './getupLib';
import { libraryOf, tryGetup, type Pose } from '../getupTry';
import type { AnimClipFile } from '../../src/sim/character/animDriver';

const LIB = join(ROOT, 'assets', 'library');
const CLIPS = join(ROOT, 'assets', 'poses', 'getup');
const cfg = getupCfg as unknown as GetupConfig;
const W = { body: cfg.match.body, axis: cfg.match.axis, pinned: cfg.match.pinned };

interface Sample { id: string; seed: number; kind: string; t: number; posture: PostureClass; bodies: Pose }
interface Cluster { name: string; posture: PostureClass; medoid: string; members: string[]; insurance?: boolean }
interface Cand { id: string; rep: string; mode: EndMode; seed: number; clipName: string; balanceTau: number; feetTau: number; frame0ErrCm: number; groundShiftCm: number; insurance: boolean; tests?: { pose: string; ok: boolean; doneT: number | null; assist: number; steps: number; why?: string; v?: number | null }[]; successRate?: number }

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const stages = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
const want = (s: string) => !stages.length || stages.includes(s);
const NS = Number(opt('--samples', '260'));
const K = Number(opt('--k', '30'));
const SEEDS = opt('--seeds', '1,2,3').split(',').map(Number);
const INS_SEEDS = opt('--insuranceSeeds', '1,2,3,4,5,6').split(',').map(Number);
const MIN_RATE = Number(opt('--minRate', '0.5'));
/** 시험 설정 덮어쓰기 (--set qp.enabled=1,exec.rate=0.9): 변형 비교용. 주면 결과를 getup_candidates_<--variant>.json에만 쓴다 */
const SET = opt('--set', '');
const VARIANT = opt('--variant', '');
function testCfg(): GetupConfig | undefined {
  if (!SET) return undefined;
  const c = JSON.parse(JSON.stringify(getupCfg)) as Record<string, Record<string, unknown>>;
  for (const kv of SET.split(',')) { const [k, v] = kv.split('='); const path = k!.split('.'); let o: Record<string, unknown> = c; for (const x of path.slice(0, -1)) o = o[x] as Record<string, unknown>; o[path.at(-1)!] = v === 'true' ? true : v === 'false' ? false : Number(v); }
  return c as unknown as GetupConfig;
}
const rj = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

const def = loadInputs({ character: 'xbot' } as Scenario).character;
const feat = (b: Pose): PoseFeature => poseFeature(def, b);

/** 1. 쓰러진 자세 모으기 (겟업 판정 순간) */
async function sample(): Promise<Sample[]> {
  const out: Sample[] = [];
  const inp = loadInputs({ character: 'xbot' } as Scenario);
  for (let seed = 1; seed <= NS; seed++) {
    const sc = randomFallScenario(seed, { duration: 9 });
    const world = await World.create({ seed: sc.seed, terrain: sc.terrain });
    try {
      const ch = world.addCharacter(inp.character, inp.ragdoll, sc.spawn, { rootAssist: false, getup: { probe: true }, getupLibrary: { entries: [], clips: {} } });
      if (sc.clip) ch.playClip(sc.clip);
      const ev = [...sc.events];
      const steps = Math.round(sc.duration / world.dt);
      for (let i = 0; i < steps && !ch.getup.ready; i++) {
        while (ev.length && ev[0]!.t <= world.time + 1e-9) {
          const e = ev.shift()!;
          if (e.type === 'hit') ch.hit(e.hit);
          else if (e.type === 'setState') ch.setState(e.state);
          else if (e.type === 'trigger') ch.trigger(e.behavior, e.params);
        }
        world.step();
      }
      const r = ch.getup.ready;
      if (r) {
        const bodies = r.transforms.map((b) => ({ pos: b.pos.map(r5) as Vec3, rot: b.rot.map(r5) as Quat }));
        out.push({ id: `s${seed}`, seed, kind: sc.fallKind, t: Math.round(r.t * 1000) / 1000, posture: classifyFeature(feat(bodies)), bodies });
      }
      process.stdout.write(`\r표본 ${seed}/${NS}: 모음 ${out.length}`);
    } finally { world.free(); }
  }
  return out;
}

/** 2. k-medoids (결정론: 가장 먼 점 초기화) */
function cluster(samples: Sample[]): Cluster[] {
  const n = samples.length;
  const F = samples.map((s) => feat(s.bodies));
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const c = matchFeature(F[i]!, F[j]!, W).cost; D[i]![j] = c; D[j]![i] = c; }
  const k = Math.min(K, n);
  const med: number[] = [];
  // 시작: PAM BUILD — 전체 비용(각 점에서 가장 가까운 대표까지 합)을 가장 많이 줄이는 점을 하나씩 더한다 (밀도를 따라 고르게, 외톨이 대표를 덜 만든다)
  const near = new Float64Array(n).fill(Infinity);
  while (med.length < k) {
    let bi = -1, bg = -Infinity;
    for (let i = 0; i < n; i++) {
      if (med.includes(i)) continue;
      let g = 0;
      for (let j = 0; j < n; j++) g += Math.max(0, (near[j] === Infinity ? 1e3 : near[j]!) - D[i]![j]!);
      if (g > bg) { bg = g; bi = i; }
    }
    med.push(bi);
    for (let j = 0; j < n; j++) near[j] = Math.min(near[j]!, D[bi]![j]!);
  }
  const assign = () => samples.map((_, i) => med.reduce((b, m, mi) => (D[i]![m]! < D[i]![med[b]!]! ? mi : b), 0));
  for (let it = 0; it < 30; it++) {
    const a = assign();
    let changed = false;
    for (let c = 0; c < k; c++) {
      const mem = a.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
      if (!mem.length) continue;
      let bm = med[c]!, bc = Infinity;
      for (const i of mem) { const s = mem.reduce((acc, j) => acc + D[i]![j]!, 0); if (s < bc) { bc = s; bm = i; } }
      if (bm !== med[c]) { med[c] = bm; changed = true; }
    }
    if (!changed) break;
  }
  const a = assign();
  const cl: Cluster[] = med.map((m, c) => {
    const mem = a.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0).sort((x, y) => D[m]![x]! - D[m]![y]!);
    return { name: `c${String(c + 1).padStart(2, '0')}`, posture: samples[m]!.posture, medoid: samples[m]!.id, members: mem.map((i) => samples[i]!.id) };
  });
  // 보험: 엎드림·누움 각 분류의 중심 자세 (분류 안 비용 합 최소)
  for (const p of ['prone', 'supine'] as PostureClass[]) {
    const idx = samples.map((s, i) => (s.posture === p ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) { console.warn(`보험 ${p}: 표본 없음`); continue; }
    let bm = idx[0]!, bc = Infinity;
    for (const i of idx) { const s = idx.reduce((acc, j) => acc + D[i]![j]!, 0); if (s < bc) { bc = s; bm = i; } }
    const mem = [...idx].sort((x, y) => D[bm]![x]! - D[bm]![y]!);
    cl.push({ name: `ins_${p}`, posture: p, medoid: samples[bm]!.id, members: mem.map((i) => samples[i]!.id), insurance: true });
  }
  return cl;
}

/** 끝 방향: 자세에 맞는 쪽을 기본으로, --bothModes면 두 방향 다 (엎드림에서 발 쪽으로 서는 겟업도 있다) */
const modesFor = (c: Cluster): EndMode[] => (args.includes('--bothModes') ? (c.posture === 'prone' ? ['head', 'feet'] : ['feet', 'head']) : c.posture === 'prone' ? ['head'] : ['feet']);

/** 3. Kimodo 생성 */
async function generateAll(samples: Sample[], clusters: Cluster[]): Promise<Cand[]> {
  const rig = new Rig(def, new Soma(somaSkeleton()), loadKimodoConfig());
  const byId = new Map(samples.map((s) => [s.id, s]));
  const out: Cand[] = [];
  mkdirSync(join(LIB, 'candidates'), { recursive: true });
  for (const c of clusters) {
    const s = byId.get(c.medoid)!;
    // 보험은 두 끝 방향 모두, 시드 넉넉히. 일반 대표는 자세에 맞는 끝 방향
    const plan: [EndMode, number][] = c.insurance
      ? (['feet', 'head'] as EndMode[]).flatMap((m) => INS_SEEDS.map((sd): [EndMode, number] => [m, sd]))
      : modesFor(c).flatMap((m) => SEEDS.map((sd): [EndMode, number] => [m, sd]));
    for (const [mode, seed] of plan) {
      const id = `getup_${c.name}_${mode}_s${seed}`;
      const g = await generateGetup(rig, s.bodies, { name: `getup_${c.name}_${mode}`, seed, mode, durationS: 4, clipName: id });
      if (g.frame0ErrCm > 2) { console.warn(`${id}: 0프레임 오차 ${g.frame0ErrCm.toFixed(2)}cm > 2cm — 버림`); continue; }
      writeFileSync(join(LIB, 'candidates', `${id}.json`), JSON.stringify(g.clip));
      out.push({ id, rep: c.name, mode, seed, clipName: id, balanceTau: g.balanceTau, feetTau: g.clip.info?.getup ? (g.clip.info.getup as { feetTau: number }).feetTau : g.balanceTau, frame0ErrCm: g.frame0ErrCm, groundShiftCm: g.groundShiftCm, insurance: !!c.insurance });
      console.log(`생성 ${id}${g.cached ? ' (캐시)' : ''}: 0프레임 ${g.frame0ErrCm.toFixed(2)}cm, 균형 복귀 ${g.balanceTau.toFixed(2)}초, 지면 맞춤 ${g.groundShiftCm.toFixed(1)}cm`);
    }
  }
  return out;
}

/** 4. 물리 시험 (--jobs J: 자식 프로세스 J개로 나눠 돌린다, 결과는 같다) */
async function testAll(samples: Sample[], clusters: Cluster[], cands: Cand[], force: boolean): Promise<Cand[]> {
  const jobs = Number(opt('--jobs', '1'));
  const worker = args.includes('--worker') ? Number(opt('--worker', '0')) : -1;
  if (jobs > 1 && worker < 0) {
    const { spawn } = await import('node:child_process');
    mkdirSync(join(LIB, 'parts'), { recursive: true });
    await Promise.all(Array.from({ length: jobs }, (_, w) => new Promise<void>((res, rej) => {
      const p = spawn('npx', ['tsx', 'tools/kimodo/buildGetupLibrary.ts', 'test', '--worker', String(w), '--jobs', String(jobs), ...(force ? ['--force-test'] : []), '--testPoses', opt('--testPoses', '4'), ...(SET ? ['--set', SET] : [])], { cwd: ROOT, shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`worker ${w} exit ${c}`))));
    })));
    for (let w = 0; w < jobs; w++) {
      const part = rj<Record<string, Pick<Cand, 'tests' | 'successRate'>>>(join(LIB, 'parts', `test_${w}.json`));
      for (const c of cands) if (part[c.id]) Object.assign(c, part[c.id]);
    }
    writeFileSync(join(LIB, VARIANT ? `getup_candidates_${VARIANT}.json` : 'getup_candidates.json'), JSON.stringify(cands, null, 1));
    return cands;
  }
  const part: Record<string, Pick<Cand, 'tests' | 'successRate'>> = {};
  const byId = new Map(samples.map((s) => [s.id, s]));
  const nTest = Number(opt('--testPoses', '4'));
  for (const [i, cd] of cands.entries()) {
    if (worker >= 0 && i % jobs !== worker) continue;
    if (cd.tests && !force) { part[cd.id] = { tests: cd.tests, successRate: cd.successRate }; continue; }
    const c = clusters.find((x) => x.name === cd.rep)!;
    const file = rj<AnimClipFile & { info: { getup: { balanceTau: number; feetTau: number } } }>(join(LIB, 'candidates', `${cd.id}.json`));
    const lib = libraryOf(def, [{ file, balanceTau: file.info.getup.balanceTau, feetTau: file.info.getup.feetTau }]);
    cd.tests = [];
    for (const pid of c.members.slice(0, nTest)) {
      const r = await tryGetup({ name: `_gt_${cd.id}_${pid}`, pose: byId.get(pid)!.bodies, library: lib, duration: 10, write: false, cfg: testCfg() });
      cd.tests.push({ pose: pid, ok: r.done && r.standing && !r.exploded && r.fails === 0, doneT: r.doneT, assist: Math.round(r.assist), steps: r.steps, why: r.why, v: r.vAtBalance === null ? null : Math.round(r.vAtBalance * 100) / 100 });
    }
    cd.successRate = cd.tests.filter((x) => x.ok).length / cd.tests.length;
    console.log(`시험 ${i + 1}/${cands.length} ${cd.id}: ${cd.tests.map((x) => (x.ok ? 'O' : 'x')).join('')} 성공률 ${(cd.successRate * 100).toFixed(0)}% 보조 ${cd.tests.map((x) => x.assist).join('/')}`);
    part[cd.id] = { tests: cd.tests, successRate: cd.successRate };
    if (worker >= 0) writeFileSync(join(LIB, 'parts', `test_${worker}.json`), JSON.stringify(part));
    else writeFileSync(join(LIB, 'getup_candidates.json'), JSON.stringify(cands, null, 1));
  }
  if (worker >= 0) writeFileSync(join(LIB, 'parts', `test_${worker}.json`), JSON.stringify(part));
  return cands;
}

/** 5. 라이브러리 쓰기 */
function writeLibrary(samples: Sample[], clusters: Cluster[], cands: Cand[]): void {
  // 대표 자세마다 성공률 높은 순(같으면 보조 사용량 적은 순)으로 perRep개 (보험은 insPerRep개)
  const perRep = Number(opt('--perRep', '2')), insPerRep = Number(opt('--insPerRep', '4'));
  const meanAssist = (c: Cand) => { const ok = (c.tests ?? []).filter((x) => x.ok); return ok.length ? ok.reduce((a, x) => a + x.assist, 0) / ok.length : Infinity; };
  const keep = clusters.flatMap((cl) => cands
    .filter((c) => c.rep === cl.name && c.tests?.[0]?.ok && (c.successRate ?? 0) >= MIN_RATE)
    .sort((x, y) => (y.successRate ?? 0) - (x.successRate ?? 0) || meanAssist(x) - meanAssist(y) || (x.id < y.id ? -1 : 1))
    .slice(0, cl.insurance ? insPerRep : perRep));
  rmSync(CLIPS, { recursive: true, force: true });
  mkdirSync(CLIPS, { recursive: true });
  const byId = new Map(samples.map((s) => [s.id, s]));
  const entries: GetupEntry[] = keep.map((c) => {
    const file = rj<AnimClipFile>(join(LIB, 'candidates', `${c.id}.json`));
    file.info = { ...file.info, successRate: c.successRate, tests: c.tests };
    writeFileSync(join(CLIPS, `${c.id}.json`), JSON.stringify(file));
    const fk = libraryOf(def, [{ file, balanceTau: c.balanceTau }]).entries[0]!.feature;
    const r = (f: PoseFeature) => ({ up: f.up.map(r5) as Vec3, fwd: f.fwd.map(r5) as Vec3, rel: f.rel.map((v) => v.map(r5) as Vec3), pinned: f.pinned });
    return { id: c.id, clip: c.id, path: `assets/poses/getup/${c.id}.json`, rep: c.rep, posture: clusters.find((x) => x.name === c.rep)!.posture, feature: r(rotateFeature(fk, 0)), successRate: c.successRate!, balanceTau: c.balanceTau, feetTau: c.feetTau, ...(c.insurance ? { insurance: true } : {}) };
  });
  const index = {
    $comment: 'v0.7 겟업 라이브러리 인덱스 (npm run getup:build). feature = 클립 0프레임 특징(getupFeatures.ts), successRate = 대표 자세 + 가까운 구성원 자세 물리 시험 성공 비율, balanceTau/feetTau = 균형 복귀 시각(초)',
    text: GETUP_TEXT, model: 'Kimodo-SOMA-RP-v1.2', samples: samples.length, clusters: clusters.map((c) => ({ name: c.name, posture: c.posture, size: c.members.length, medoid: c.medoid, insurance: !!c.insurance, kept: keep.filter((k) => k.rep === c.name).length })),
    entries,
    reps: Object.fromEntries(clusters.map((c) => [c.name, byId.get(c.medoid)!.bodies])),
  };
  writeFileSync(join(LIB, 'getup.json'), JSON.stringify(index));
  // sim 정적 import
  const lines = [
    '// 자동 생성 (npm run getup:build, tools/kimodo/buildGetupLibrary.ts). 고치지 말 것.',
    '// 겟업 라이브러리: assets/library/getup.json 인덱스 + assets/poses/getup/*.json 클립 (sim은 파일 시스템을 쓰지 않으므로 정적 import).',
    "import type { AnimClipFile } from './animDriver';",
    "import type { GetupEntry, GetupLibraryData } from './getup';",
    "import index from '../../../assets/library/getup.json';",
    ...entries.map((e, i) => `import c${i} from '../../../${e.path}';`),
    '',
    'export const GETUP_LIBRARY: GetupLibraryData = {',
    '  entries: (index as unknown as { entries: GetupEntry[] }).entries,',
    '  clips: {',
    ...entries.map((e, i) => `    ${JSON.stringify(e.clip)}: c${i} as unknown as AnimClipFile,`),
    '  },',
    '};',
    '',
  ];
  writeFileSync(join(ROOT, 'src', 'sim', 'character', 'getupClips.generated.ts'), lines.join('\n'));
  // INDEX.md 절
  const idxPath = join(ROOT, 'assets', 'kimodo', 'INDEX.md');
  let md = existsSync(idxPath) ? readFileSync(idxPath, 'utf8') : '';
  const start = md.indexOf('<!-- getup-library -->');
  if (start >= 0) md = md.slice(0, start);
  const byRep = new Map<string, Cand[]>();
  for (const c of cands) byRep.set(c.rep, [...(byRep.get(c.rep) ?? []), c]);
  md += [
    '<!-- getup-library -->',
    '## 겟업 라이브러리 (v0.7, `npm run getup:build`)',
    '',
    `- 프롬프트 \`${GETUP_TEXT}\`, RP-v1.2, 4초. 0프레임 = 실제로 쓰러진 물리 자세(키프레임, 오차 ≤ 2cm), 끝 프레임 = 서기 자세(feet: 발 쪽을 보고 엉덩이~발 중간, head: 머리 쪽을 보고 엉덩이 자리; 대표마다 두 방향 × 시드 1~6, 보험도 같음). 끝 키프레임 없이 시작 키프레임만 주면 RP는 12/12 누운 채 끝났다.`,
    `- 표본 ${samples.length}개(무작위 쓰러짐 ${NS}회 중 판정된 것) → 대표 ${clusters.filter((c) => !c.insurance).length}개 + 보험 ${clusters.filter((c) => c.insurance).length}개. 생성 ${cands.length}개, 물리 시험 통과(대표 자세 성공 + 성공률 ≥ ${MIN_RATE * 100}%) 중 대표마다 성공률·보조 사용량 순 상위 ${perRep}개(보험 ${insPerRep}개) = ${keep.length}개.`,
    '',
    '| 대표 | 자세 | 구성원 | 후보 (성공률 · 남김) |',
    '|---|---|---|---|',
    ...clusters.map((c) => `| ${c.name} | ${POSTURE_KO[c.posture]} | ${c.members.length} | ${(byRep.get(c.name) ?? []).map((x) => `${x.mode} s${x.seed} ${((x.successRate ?? 0) * 100).toFixed(0)}%${keep.includes(x) ? ' ✓' : ''}`).join(', ')} |`),
    '',
  ].join('\n');
  writeFileSync(idxPath, md);
  console.log(`라이브러리: 클립 ${entries.length}개 → assets/library/getup.json`);
}

async function main(): Promise<void> {
  mkdirSync(LIB, { recursive: true });
  const sp = join(LIB, 'getup_samples.json'), cp = join(LIB, 'getup_clusters.json'), dp = join(LIB, 'getup_candidates.json');
  let samples: Sample[] = existsSync(sp) && !want('sample') ? rj(sp) : [];
  if (want('sample')) { samples = await sample(); writeFileSync(sp, JSON.stringify(samples)); }
  const cnt = (k: string) => samples.filter((s) => s.posture === k).length;
  console.log(`표본 ${samples.length}개: 누움 ${cnt('supine')}, 엎드림 ${cnt('prone')}, 옆 ${cnt('side')}, 앉음 ${cnt('sit')}`);
  let clusters: Cluster[] = existsSync(cp) && !want('cluster') ? rj(cp) : [];
  if (want('cluster')) { clusters = cluster(samples); writeFileSync(cp, JSON.stringify(clusters, null, 1)); }
  console.log(`대표 ${clusters.length}개: ${clusters.map((c) => `${c.name}(${POSTURE_KO[c.posture]} ${c.members.length})`).join(' ')}`);
  let cands: Cand[] = existsSync(dp) ? rj(dp) : [];
  if (want('generate')) {
    const prev = new Map(cands.map((c) => [c.id, c]));
    cands = (await generateAll(samples, clusters)).map((c) => (prev.get(c.id)?.tests && prev.get(c.id)!.balanceTau === c.balanceTau ? { ...c, tests: prev.get(c.id)!.tests, successRate: prev.get(c.id)!.successRate } : c));
    writeFileSync(dp, JSON.stringify(cands, null, 1));
  }
  if (want('test')) cands = await testAll(samples, clusters, cands, args.includes('--force-test'));
  if (args.includes('--worker')) return;
  if (want('write')) writeLibrary(samples, clusters, cands);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
