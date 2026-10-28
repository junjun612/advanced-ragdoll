// 퍼징 (SPEC 12 v0.9): npm run fuzz -- --runs 10000 [--start 1] [--workers N] [--label 이름]
//   무작위 실행(tools/fuzz/gen.ts)을 worker_threads로 병렬 실행하고 감지(tools/fuzz/run.ts) 결과를 out/fuzz/에 남긴다.
//   out/fuzz/results.jsonl (실행별), out/fuzz/cases/<시드>.json (발견한 실행: 시나리오·태그·발견·재현 명령), out/fuzz/report.md (한글 요약),
//   out/fuzz/history.json (회차별 추이).
// 재현: npm run fuzz -- --replay <시드>  → out/fuzz/<시드>/{log.jsonl, meta.json, summary.json} + 감지 결과, 이어서 npm run film -- fuzz/<시드>
// 다시 돌리기: npm run fuzz -- --seeds 12,345  /  --failed (직전 results.jsonl에서 발견이 있던 시드만)
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fuzzCase } from './fuzz/gen';
import { runFuzzCase, FATAL, LAYER, type FuzzResult, type FindingKind } from './fuzz/run';
import { stringifyRounded } from '../src/sim/logger';
import fuzzCfg from '../config/fuzz.json';
import simCfg from '../config/sim.json';

const OUT = join('out', 'fuzz');
const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const KIND_KO: Record<FindingKind, string> = {
  explosion: '폭발', nan: 'NaN', penetration: '관통(접촉 깊이)', tunnel: '관통(지형 빠져나감)', error: '오류',
  stuckBehavior: '갇힘: 같은 행동 오래', stuckGettingUp: '갇힘: 일어서기 오래', getupFailLoop: '갇힘: 겟업 실패 반복', lyingStuck: '갇힘: 누운 채 시도 없음', oscillation: '갇힘: 진동',
};
const KINDS = Object.keys(KIND_KO) as FindingKind[];
const repro = (seed: number) => `npm run fuzz -- --replay ${seed}`;

async function replay(seed: number): Promise<void> {
  const fc = fuzzCase(seed);
  const { result, run } = await runFuzzCase(fc);
  const dir = join(OUT, String(seed));
  mkdirSync(dir, { recursive: true });
  if (run) {
    writeFileSync(join(dir, 'log.jsonl'), run.log);
    for (const x of run.extraLogs ?? []) writeFileSync(join(dir, x.file), x.log);
    if (run.propsLog) writeFileSync(join(dir, run.meta.propsLog ?? 'props.jsonl'), run.propsLog);
    writeFileSync(join(dir, 'summary.json'), stringifyRounded(run.summary, 2) + '\n');
    writeFileSync(join(dir, 'meta.json'), stringifyRounded(run.meta, 2) + '\n');
  }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(fc.scenario, null, 1));
  writeFileSync(join(dir, 'fuzz.json'), JSON.stringify(result, null, 1));
  console.log(fc.scenario.description);
  console.log(`최대 각속도 ${result.maxAngVel} rad/s (${result.maxAngBody}), 최대 접촉 깊이 ${(result.maxPenetration * 100).toFixed(2)}cm, 넘어짐 ${result.fell}`);
  for (const f of result.findings) console.log(`  ${KIND_KO[f.kind]}  ${f.char} t=${f.t.toFixed(3)}  ${f.detail}  ${f.ctx ?? ''}`);
  if (!result.findings.length) console.log('  발견 없음');
  console.log(`필름: npm run film -- fuzz/${seed}`);
}

function gitHead(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() + (execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim() ? '+수정' : ''); } catch { return '?'; }
}

async function runMany(seeds: number[], workers: number, label: string): Promise<void> {
  mkdirSync(join(OUT, 'cases'), { recursive: true });
  const resultsPath = join(OUT, 'results.jsonl');
  rmSync(resultsPath, { force: true });
  const results: FuzzResult[] = [];
  const t0 = Date.now();
  let next = 0, done = 0, lastPrint = 0;
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
  const onResult = (r: FuzzResult) => {
    results.push(r);
    appendFileSync(resultsPath, JSON.stringify(r) + '\n');
    done++;
    for (const k of new Set(r.findings.map((f) => f.kind))) counts[k]++;
    if (r.findings.length) {
      const fc = fuzzCase(r.seed);
      writeFileSync(join(OUT, 'cases', `${r.seed}.json`), JSON.stringify({ seed: r.seed, generatorVersion: fuzzCfg.generatorVersion, repro: repro(r.seed), film: `npm run film -- fuzz/${r.seed}`, tags: r.tags, findings: r.findings, maxAngVel: r.maxAngVel, maxAngBody: r.maxAngBody, scenario: fc.scenario }, null, 1));
      const fatal = r.findings.filter((f) => FATAL.includes(f.kind));
      for (const f of fatal) console.log(`  ! 시드 ${r.seed} ${KIND_KO[f.kind]} ${f.char} t=${f.t.toFixed(2)} ${f.detail} | ${f.ctx ?? ''}`);
    }
    const now = Date.now();
    if (now - lastPrint > 5000 || done === seeds.length) {
      lastPrint = now;
      const el = (now - t0) / 1000, eta = (el / done) * (seeds.length - done);
      console.log(`[${done}/${seeds.length} ${((100 * done) / seeds.length).toFixed(1)}%] ${el.toFixed(0)}초, 남은 ${eta.toFixed(0)}초 | 폭발 ${counts.explosion} NaN ${counts.nan} 관통 ${counts.penetration + counts.tunnel} 갇힘 ${counts.stuckBehavior + counts.stuckGettingUp + counts.getupFailLoop + counts.lyingStuck + counts.oscillation} 오류 ${counts.error}`);
    }
  };
  await new Promise<void>((resolve, reject) => {
    let alive = workers;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./fuzz/worker.ts', import.meta.url));
      const feed = () => w.postMessage(next < seeds.length ? seeds[next++]! : null);
      w.on('message', (m: FuzzResult | 'ready') => { if (m !== 'ready') onResult(m); feed(); });
      w.on('error', reject);
      w.on('exit', () => { if (--alive === 0) resolve(); });
    }
  });
  results.sort((a, b) => a.seed - b.seed);
  writeReport(results, { label, workers, seconds: (Date.now() - t0) / 1000, head: gitHead() });
}

interface RunInfo { label: string; workers: number; seconds: number; head: string }

function writeReport(rs: FuzzResult[], info: RunInfo): void {
  const has = (r: FuzzResult, k: FindingKind) => r.findings.some((f) => f.kind === k);
  const n = (k: FindingKind) => rs.filter((r) => has(r, k)).length;
  const histPath = join(OUT, 'history.json');
  const hist: { date: string; label: string; head: string; gen: number; runs: number; seeds: string; counts: Record<string, number> }[] = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : [];
  const seedsStr = rs.length ? `${rs[0]!.seed}~${rs.at(-1)!.seed}` : '-';
  hist.push({ date: new Date().toISOString().slice(0, 16).replace('T', ' '), label: info.label, head: info.head, gen: fuzzCfg.generatorVersion, runs: rs.length, seeds: seedsStr, counts: Object.fromEntries(KINDS.map((k) => [k, n(k)])) });
  writeFileSync(histPath, JSON.stringify(hist, null, 1));

  const L: string[] = [];
  const simS = rs.reduce((a, r) => a + r.simSeconds, 0);
  L.push(`# 퍼징 보고서 (v0.9)`, '');
  L.push(`- 회차: ${info.label} · 커밋 ${info.head} · 생성기 v${fuzzCfg.generatorVersion} · 시드 ${seedsStr} · 실행 ${rs.length}회 (시뮬레이션 ${(simS / 3600).toFixed(1)}시간 분량)`);
  L.push(`- 걸린 시간 ${(info.seconds / 60).toFixed(1)}분, worker_threads ${info.workers}개`);
  L.push(`- 재현: \`npm run fuzz -- --replay <시드>\` → \`npm run film -- fuzz/<시드>\`. 발견한 실행의 시나리오·설정 JSON은 \`out/fuzz/cases/<시드>.json\``, '');
  L.push('## 결과', '', '| 감지 | 층 | 실행 수 | 비율 |', '|---|---|---|---|');
  for (const k of KINDS) L.push(`| ${KIND_KO[k]} | ${LAYER[k] === 'physics' ? '물리' : '행동·제어기'} | ${n(k)} | ${((100 * n(k)) / Math.max(1, rs.length)).toFixed(2)}% |`);
  L.push('', `넘어진 실행 ${rs.filter((r) => r.fell).length}회. 최대 각속도 p50 ${pct(rs.map((r) => r.maxAngVel), 0.5)}, p99 ${pct(rs.map((r) => r.maxAngVel), 0.99)}, 최대 ${Math.max(0, ...rs.map((r) => r.maxAngVel)).toFixed(1)} rad/s (폭발 기준 50). 40 rad/s 넘은 실행(아슬아슬) ${rs.filter((r) => r.maxAngVel > 40).length}회: ${topCounts(rs.filter((r) => r.maxAngVel > 40).map((r) => r.maxAngBody.replace(/^[^:]*:/, '')))}`);
  L.push(`최대 접촉 깊이 p99 ${(Number(pct(rs.map((r) => r.maxPenetration), 0.99)) * 100).toFixed(2)}cm, 최대 ${(Math.max(0, ...rs.map((r) => r.maxPenetration)) * 100).toFixed(2)}cm`, '');
  L.push('## 추이 (회차별 발견 실행 수)', '', `| 날짜 | 회차 | 커밋 | 실행 | 폭발 | NaN | 관통 | 갇힘 | 오류 |`, '|---|---|---|---|---|---|---|---|---|');
  for (const h of hist) {
    const c = h.counts;
    L.push(`| ${h.date} | ${h.label} | ${h.head} | ${h.runs} | ${c.explosion} | ${c.nan} | ${(c.penetration ?? 0) + (c.tunnel ?? 0)} | ${(c.stuckBehavior ?? 0) + (c.stuckGettingUp ?? 0) + (c.getupFailLoop ?? 0) + (c.lyingStuck ?? 0) + (c.oscillation ?? 0)} | ${c.error} |`);
  }
  L.push('', '## 분류별', '');
  for (const [title, key] of [['지형', (r: FuzzResult) => r.tags.terrain], ['시작 상태', (r: FuzzResult) => r.tags.start], ['두 번째 캐릭터', (r: FuzzResult) => r.tags.second ?? '없음'], ['프롭', (r: FuzzResult) => (r.tags.props ? '있음' : '없음')]] as const) {
    L.push(`| ${title} | 실행 | 폭발·NaN | 관통 | 갇힘 |`, '|---|---|---|---|---|');
    const groups = new Map<string, FuzzResult[]>();
    for (const r of rs) { const g = key(r); groups.set(g, [...(groups.get(g) ?? []), r]); }
    for (const [g, xs] of [...groups].sort()) {
      const c = (ks: FindingKind[]) => xs.filter((r) => ks.some((k) => has(r, k))).length;
      L.push(`| ${g} | ${xs.length} | ${c(['explosion', 'nan'])} | ${c(['penetration', 'tunnel'])} | ${c(['stuckBehavior', 'stuckGettingUp', 'getupFailLoop', 'lyingStuck', 'oscillation'])} |`);
    }
    L.push('');
  }
  const list = (title: string, ks: FindingKind[], max: number) => {
    const xs = rs.flatMap((r) => r.findings.filter((f) => ks.includes(f.kind)).map((f) => ({ r, f })));
    L.push(`## ${title} (${xs.length}건)`, '');
    if (!xs.length) { L.push('없음', ''); return; }
    L.push('| 시드 | 종류 | 캐릭터 | 시각 | 상세 | 그때 상태·행동 | 실행 | 재현 |', '|---|---|---|---|---|---|---|---|');
    for (const { r, f } of xs.slice(0, max)) L.push(`| ${r.seed} | ${KIND_KO[f.kind]} | ${f.char} | ${f.t.toFixed(2)} | ${f.detail} | ${f.ctx ?? ''} | ${r.tags.terrain}·${r.tags.start}·${r.tags.hitTypes.join('/') || '피격 없음'}${r.tags.second ? `·B ${r.tags.second}` : ''}${r.tags.props ? `·프롭 ${r.tags.props}` : ''}${r.tags.extras.length ? `·${r.tags.extras.join('/')}` : ''} | \`${repro(r.seed)}\` |`);
    if (xs.length > max) L.push(`| … ${xs.length - max}건 더 (results.jsonl) | | | | | | | |`);
    L.push('');
  };
  // (README 9f-11) 충돌 튐: 폭발이 아닌 1~2스텝 속도 초과. 숨기지 않고 따로 센다
  const snaps = rs.flatMap((r) => (r.snaps ?? []).map((s) => ({ r, s })));
  const vis = snaps.filter((x) => x.s.deg > simCfg.safety.snapVisibleDeg).sort((a, b) => b.s.deg - a.s.deg);
  L.push(`## 충돌 튐 (collisionSnap, 폭발 아님 — 1~${simCfg.safety.explodeSteps - 1}스텝 속도 초과, 에너지 증가 없음)`, '');
  L.push(`${snaps.length}건 (실행 ${rs.filter((r) => r.snaps?.length).length}회). 렌더 한 프레임(${simCfg.safety.snapWindowSteps}스텝)에 보이는 부모 기준 회전각 p50 ${pct(snaps.map((x) => x.s.deg), 0.5)}°, p90 ${pct(snaps.map((x) => x.s.deg), 0.9)}°, 최대 ${Math.max(0, ...snaps.map((x) => x.s.deg)).toFixed(1)}°. 바디: ${topCounts(snaps.map((x) => x.s.body))}. 지형: ${topCounts(snaps.map((x) => x.r.tags.terrain))}`, '');
  L.push(`### ${simCfg.safety.snapVisibleDeg}° 넘게 튀어 보이는 것 (${vis.length}건)`, '');
  if (vis.length) {
    L.push('| 시드 | 캐릭터 | 시각 | 바디 | 보이는 회전 | 상세 | 실행 | 재현 |', '|---|---|---|---|---|---|---|---|');
    for (const { r, s } of vis.slice(0, 100)) L.push(`| ${r.seed} | ${s.char} | ${s.t.toFixed(2)} | ${s.body} | ${s.deg.toFixed(1)}° | ${s.detail} | ${r.tags.terrain}·${r.tags.start} | \`${repro(r.seed)}\` |`);
  } else L.push('없음');
  L.push('');
  list('물리 계층: 폭발·NaN·오류 (고친다)', ['explosion', 'nan', 'error'], 200);
  list('물리 계층: 관통 (고친다)', ['penetration', 'tunnel'], 100);
  // 갇힘: 종류·상세 첫 낱말로 묶음
  const stuck = rs.flatMap((r) => r.findings.filter((f) => !FATAL.includes(f.kind)).map((f) => ({ r, f })));
  L.push(`## 행동·제어기 계층 갇힘 묶음 — 원인 분류·재현 시드만, 고치지 않음 (README 9f-6) (${stuck.length}건)`, '', '| 종류 | 무엇 | 건수 | 지형 | 예시 시드 |', '|---|---|---|---|---|');
  const g = new Map<string, typeof stuck>();
  for (const x of stuck) { const k = `${KIND_KO[x.f.kind]}|${x.f.detail.split(' ')[0]}`; g.set(k, [...(g.get(k) ?? []), x]); }
  for (const [k, xs] of [...g].sort((a, b) => b[1].length - a[1].length)) {
    const [kind, what] = k.split('|');
    L.push(`| ${kind} | ${what} | ${xs.length} | ${topCounts(xs.map((x) => x.r.tags.terrain))} | ${xs.slice(0, 5).map((x) => x.r.seed).join(', ')} |`);
  }
  L.push('');
  writeFileSync(join(OUT, 'report.md'), L.join('\n'));
  console.log(`\n실행 ${rs.length}회: ${KINDS.map((k) => `${KIND_KO[k]} ${n(k)}`).join(', ')} → ${join(OUT, 'report.md')}`);
}

function pct(xs: number[], p: number): string {
  if (!xs.length) return '-';
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(2);
}
function topCounts(xs: string[]): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
}

const rp = opt('--replay');
if (rp) await replay(Number(rp));
else {
  const workers = Number(opt('--workers') ?? Math.max(1, Math.min(8, availableParallelism() - 4)));
  let seeds: number[];
  if (opt('--seeds')) seeds = opt('--seeds')!.split(',').map(Number);
  else if (opt('--seeds-file')) seeds = readFileSync(opt('--seeds-file')!, 'utf8').split(/[\s,]+/).filter(Boolean).map(Number);
  else if (argv.includes('--failed')) {
    const prev = readFileSync(join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FuzzResult);
    const kinds = (opt('--kinds') ?? FATAL.join(',')).split(',');
    seeds = prev.filter((r) => r.findings.some((f) => kinds.includes(f.kind))).map((r) => r.seed);
  } else {
    const start = Number(opt('--start') ?? 1), runs = Number(opt('--runs') ?? 100);
    seeds = Array.from({ length: runs }, (_, i) => start + i);
  }
  await runMany(seeds, Math.min(workers, seeds.length), opt('--label') ?? `${seeds.length}회`);
}
