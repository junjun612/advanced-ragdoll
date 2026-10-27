// 레퍼런스 유사도 (SPEC 10 refSimilarity): sim 로그와 Kimodo 레퍼런스 포즈 클립을 비교한다.
// 사용법: npm run ref:compare -- <scenario> <clip> [--hit <초>] [--json <경로>]
//   <scenario>: out/<scenario>/log.jsonl + meta.json (sim 결과),  <clip>: assets/poses/kimodo_<clip>.json 또는 경로
// 방법:
//   1. 둘 다 30fps로 맞춘다 (sim 로그는 시각 기준 선형 보간·가까운 프레임).
//   2. 충격 시점 정렬: sim = meta.events의 첫 'hit' t, 레퍼런스 = 수평 COM 가속도 피크(밀림 시작) 프레임.
//   3. 정규화: 충격 시점 COM 수평 위치를 원점으로, 그때 Hips 정면을 +Z로 돌린다.
//   4. 충격 0.3초 전부터 둘 중 짧은 쪽 끝까지 DTW (Sakoe–Chiba 띠 0.5초). 프레임 거리 = COM 거리(m) + rotWeight × 바디 방향 평균 각(rad).
//   5. 항목별: COM 궤적, 몸통(Spine2) 기울기 프로파일, 팔 사용량, 스텝 수, 회복 시간, 밀림 크기(Δv).
// 낮을수록 닮았다. src/sim은 읽기만 한다 (타입).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Meta } from '../../src/sim/types';
import { type Vec3, sub, length, add, scale } from '../../src/sim/math/vec3';
import { type Quat, rotate, multiplyQ, angleBetweenQ, normalizeQ, slerp } from '../../src/sim/math/quat';
import { ROOT, Rig, loadDef, loadKimodoConfig, readJson, headingOf, yawQ } from './rig';
import { Soma } from './soma';
import { clipToStates, resolveClipPath, somaSkeleton, type LogState } from './clipToLog';
import type { PoseClipFile } from './toPoseClip';

const FPS = 30;
const PRE_S = 0.3;
const BAND_S = 0.5;
const ROT_WEIGHT = 0.3; // 1 rad 방향 차이 = 0.3 m COM 차이
const ARM_BODIES = ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'];

/** 비교에 쓰는 최소 상태 */
export interface Frame { t: number; com: Vec3; rot: Record<string, Quat>; pos: Record<string, Vec3>; feet: { LeftFoot: boolean; RightFoot: boolean } }

export function toFrames(states: Pick<LogState, 'time' | 'com' | 'bodies' | 'contacts'>[]): Frame[] {
  return states.map((s) => ({
    t: s.time, com: s.com,
    rot: Object.fromEntries(Object.entries(s.bodies).map(([k, b]) => [k, b.rot])),
    pos: Object.fromEntries(Object.entries(s.bodies).map(([k, b]) => [k, b.pos])),
    feet: { LeftFoot: s.contacts.some((c) => c.body === 'LeftFoot'), RightFoot: s.contacts.some((c) => c.body === 'RightFoot') },
  }));
}

/** 30fps로 다시 뽑기 (위치 선형, 회전 slerp, 접촉은 가까운 쪽) */
export function resample(fr: Frame[], fps = FPS): Frame[] {
  const out: Frame[] = [];
  const t0 = fr[0]!.t, t1 = fr[fr.length - 1]!.t;
  let j = 0;
  for (let k = 0; t0 + k / fps <= t1 + 1e-9; k++) {
    const t = t0 + k / fps;
    while (j + 1 < fr.length && fr[j + 1]!.t <= t) j++;
    const a = fr[j]!, b = fr[Math.min(fr.length - 1, j + 1)]!;
    const w = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
    const lp = (x: Vec3, y: Vec3): Vec3 => add(x, scale(sub(y, x), w));
    out.push({
      t, com: lp(a.com, b.com),
      rot: Object.fromEntries(Object.keys(a.rot).map((n) => [n, normalizeQ(slerp(a.rot[n]!, b.rot[n] ?? a.rot[n]!, w))])),
      pos: Object.fromEntries(Object.keys(a.pos).map((n) => [n, lp(a.pos[n]!, b.pos[n] ?? a.pos[n]!)])),
      feet: w < 0.5 ? a.feet : b.feet,
    });
  }
  return out;
}

const hspeed = (fr: Frame[], i: number): number => {
  const a = fr[Math.max(0, i - 1)]!, b = fr[Math.min(fr.length - 1, i + 1)]!;
  return Math.hypot(b.com[0] - a.com[0], b.com[2] - a.com[2]) / Math.max(1e-9, b.t - a.t);
};

/** 밀림 시작 = 수평 COM 가속도(3프레임 평활) 피크. 첫 0.1초와 마지막 0.5초는 뺀다 */
export function detectOnset(fr: Frame[]): number {
  const v = fr.map((_, i) => {
    const a = fr[Math.max(0, i - 1)]!, b = fr[Math.min(fr.length - 1, i + 1)]!;
    return [(b.com[0] - a.com[0]) / Math.max(1e-9, b.t - a.t), (b.com[2] - a.com[2]) / Math.max(1e-9, b.t - a.t)] as const;
  });
  let best = 0, bi = 0;
  for (let i = 3; i < fr.length - Math.round(0.5 * FPS); i++) {
    const acc = Math.hypot(v[i + 1]![0] - v[i - 2]![0], v[i + 1]![1] - v[i - 2]![1]) / (3 / FPS);
    if (fr[i]!.t - fr[0]!.t < 0.1) continue;
    if (acc > best) { best = acc; bi = i - 1; }
  }
  return bi;
}

/** 충격 시점 기준 정규화: COM 수평 원점, Hips 정면 +Z */
export function normalize(fr: Frame[], onset: number): Frame[] {
  const o = fr[onset]!;
  const q = yawQ(-headingOf(o.rot.Hips!));
  const c: Vec3 = [o.com[0], 0, o.com[2]];
  const tf = (p: Vec3): Vec3 => rotate(q, sub(p, c));
  return fr.map((f) => ({
    t: f.t - o.t, com: tf(f.com), feet: f.feet,
    rot: Object.fromEntries(Object.entries(f.rot).map(([k, r]) => [k, normalizeQ(multiplyQ(q, r))])),
    pos: Object.fromEntries(Object.entries(f.pos).map(([k, p]) => [k, tf(p)])),
  }));
}

/** DTW (Sakoe–Chiba 띠). 경로 평균 비용과 경로 */
export function dtw(n: number, m: number, cost: (i: number, j: number) => number, band: number): { mean: number; path: [number, number][] } {
  const W = Math.max(band, Math.abs(n - m));
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  D[0]![0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - W); j <= Math.min(m, i + W); j++) {
      D[i]![j] = cost(i - 1, j - 1) + Math.min(D[i - 1]![j]!, D[i]![j - 1]!, D[i - 1]![j - 1]!);
    }
  }
  const path: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const c = [D[i - 1]![j - 1]!, D[i - 1]![j]!, D[i]![j - 1]!];
    const k = c.indexOf(Math.min(...c));
    if (k === 0) { i--; j--; } else if (k === 1) i--; else j--;
  }
  path.reverse();
  return { mean: D[n]![m]! / path.length, path };
}

const tiltDeg = (f: Frame): number => {
  const up = rotate(f.rot.Spine2!, [0, 1, 0]);
  return (Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180) / Math.PI;
};

/** 팔 사용량: Spine2 기준 팔 바디 상대 각속도 평균 (도/초) */
function armUsage(fr: Frame[]): number {
  let s = 0, n = 0;
  for (let i = 1; i < fr.length; i++) {
    for (const b of ARM_BODIES) {
      const ra = multiplyQ([-fr[i - 1]!.rot.Spine2![0], -fr[i - 1]!.rot.Spine2![1], -fr[i - 1]!.rot.Spine2![2], fr[i - 1]!.rot.Spine2![3]], fr[i - 1]!.rot[b]!);
      const rb = multiplyQ([-fr[i]!.rot.Spine2![0], -fr[i]!.rot.Spine2![1], -fr[i]!.rot.Spine2![2], fr[i]!.rot.Spine2![3]], fr[i]!.rot[b]!);
      s += (angleBetweenQ(ra, rb) * 180) / Math.PI / (fr[i]!.t - fr[i - 1]!.t);
      n++;
    }
  }
  return n ? s / n : 0;
}

/** 걸음: 발이 떨어졌다가 5cm 넘게 옮겨 다시 닿은 횟수 */
function steps(fr: Frame[]): number {
  let n = 0;
  for (const side of ['LeftFoot', 'RightFoot'] as const) {
    let last: Vec3 | null = null;
    fr.forEach((f, i) => {
      const down = f.feet[side];
      const p = f.pos[side]!;
      if (down && (i === 0 || !fr[i - 1]!.feet[side]) && last && Math.hypot(p[0] - last[0], p[2] - last[2]) > 0.05) n++;
      if (down) last = p;
    });
  }
  return n;
}

/** 회복 시간: 충격 뒤 COM 수평 속도가 0.1 m/s 아래로 0.3초 이어지기 시작한 시각 (초, 충격 기준). 못 찾으면 null */
function recoveryTime(fr: Frame[]): number | null {
  const need = Math.round(0.3 * FPS);
  let run = 0;
  for (let i = 0; i < fr.length; i++) {
    if (fr[i]!.t < 0.1) continue;
    run = hspeed(fr, i) < 0.1 ? run + 1 : 0;
    if (run >= need) return fr[i - need + 1]!.t;
  }
  return null;
}

/** 밀림 크기 Δv: 충격 뒤 1초 안 COM 수평 속도 최대 − 충격 직전 속도 (m/s) */
export function pushDv(fr: Frame[], onset: number): number {
  const v0 = hspeed(fr, Math.max(0, onset - 1));
  let mx = 0;
  for (let i = onset; i < Math.min(fr.length, onset + FPS); i++) mx = Math.max(mx, hspeed(fr, i));
  return mx - v0;
}

export interface RefSimilarity {
  scenario: string;
  clip: string;
  /** 종합: DTW 경로 평균 (COM m + 0.3 × 방향 rad) */
  refSimilarity: number;
  alignment: { simHitT: number; refOnsetT: number; windowS: number };
  items: {
    comTrajectory: { dtwMeanCm: number; simPeakDispCm: number; refPeakDispCm: number };
    bodyOrientation: { dtwMeanDeg: number };
    trunkTilt: { dtwMeanDeg: number; simPeakDeg: number; refPeakDeg: number };
    armUsage: { simDegS: number; refDegS: number; ratio: number };
    steps: { sim: number; ref: number };
    recoveryTime: { simS: number | null; refS: number | null };
    pushDv: { simMS: number; refMS: number };
    /** (2026-10-27) 관절 RMS: DTW 경로를 따라 바디마다 부모 기준 상대 회전 차이 각의 RMS (도, 루트 제외) */
    jointRms: { deg: number };
  };
}

export function compare(simStates: LogState[], meta: Pick<Meta, 'events'>, ref: LogState[], o: { scenario: string; clip: string; hitT?: number; refOnsetFrame?: number }): RefSimilarity {
  const S0 = resample(toFrames(simStates)), R0 = resample(toFrames(ref));
  const hitT = o.hitT ?? meta.events.find((e) => e.type === 'hit')?.t;
  if (hitT === undefined) throw new Error('sim 로그에 hit 이벤트가 없음 (--hit <초>로 준다)');
  const sOn = Math.max(0, S0.findIndex((f) => f.t >= hitT - 1e-9));
  const rOn = o.refOnsetFrame ?? detectOnset(R0);
  const S = normalize(S0, sOn), R = normalize(R0, rOn);
  const pre = Math.round(PRE_S * FPS);
  const sA = Math.max(0, sOn - pre), rA = Math.max(0, rOn - pre);
  const len = Math.min(S.length - sA, R.length - rA);
  const Sw = S.slice(sA, sA + len), Rw = R.slice(rA, rA + len);
  const bodies = Object.keys(Sw[0]!.rot).filter((k) => k in Rw[0]!.rot);
  const rotD = (i: number, j: number) => bodies.reduce((s, b) => s + angleBetweenQ(Sw[i]!.rot[b]!, Rw[j]!.rot[b]!), 0) / bodies.length;
  const comD = (i: number, j: number) => length(sub(Sw[i]!.com, Rw[j]!.com));
  const band = Math.round(BAND_S * FPS);
  const all = dtw(len, len, (i, j) => comD(i, j) + ROT_WEIGHT * rotD(i, j), band);
  const onPath = (f: (i: number, j: number) => number) => all.path.reduce((s, [i, j]) => s + f(i, j), 0) / all.path.length;
  const tiltS = Sw.map(tiltDeg), tiltR = Rw.map(tiltDeg);
  const tilt = dtw(len, len, (i, j) => Math.abs(tiltS[i]! - tiltR[j]!), band);
  const after = (fr: Frame[]) => fr.filter((f) => f.t >= 0);
  const peakDisp = (fr: Frame[]) => Math.max(...after(fr).map((f) => Math.hypot(f.com[0], f.com[2]))) * 100;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const rn = (x: number | null) => (x === null ? null : r3(x));
  const armS = armUsage(after(Sw)), armR = armUsage(after(Rw));
  const parents = Object.fromEntries(loadDef().bodies.filter((b) => b.parent).map((b) => [b.name, b.parent!]));
  const relB = Object.keys(parents).filter((b) => bodies.includes(b) && bodies.includes(parents[b]!));
  const rel = (f: Frame, b: string): Quat => { const p = f.rot[parents[b]!]!; return multiplyQ([-p[0], -p[1], -p[2], p[3]], f.rot[b]!); };
  let jsq = 0, jn = 0;
  for (const [i, j] of all.path) for (const b of relB) { const a = angleBetweenQ(rel(Sw[i]!, b), rel(Rw[j]!, b)); jsq += a * a; jn++; }
  return {
    scenario: o.scenario, clip: o.clip, refSimilarity: r3(all.mean),
    alignment: { simHitT: r3(hitT), refOnsetT: r3(R0[rOn]!.t), windowS: r3(len / FPS) },
    items: {
      comTrajectory: { dtwMeanCm: r3(onPath(comD) * 100), simPeakDispCm: r3(peakDisp(Sw)), refPeakDispCm: r3(peakDisp(Rw)) },
      bodyOrientation: { dtwMeanDeg: r3((onPath(rotD) * 180) / Math.PI) },
      trunkTilt: { dtwMeanDeg: r3(tilt.mean), simPeakDeg: r3(Math.max(...tiltS)), refPeakDeg: r3(Math.max(...tiltR)) },
      armUsage: { simDegS: r3(armS), refDegS: r3(armR), ratio: r3(armR > 0 ? armS / armR : 0) },
      steps: { sim: steps(after(Sw)), ref: steps(after(Rw)) },
      recoveryTime: { simS: rn(recoveryTime(after(Sw))), refS: rn(recoveryTime(after(Rw))) },
      pushDv: { simMS: r3(pushDv(S, sOn)), refMS: r3(pushDv(R, rOn)) },
      jointRms: { deg: r3(jn ? (Math.sqrt(jsq / jn) * 180) / Math.PI : 0) },
    },
  };
}

/** 레퍼런스 클립 → 로그 상태 (FK) */
export function refStates(clipPath: string): LogState[] {
  const clip = readJson<PoseClipFile>(clipPath);
  const rig = new Rig(loadDef(), new Soma(somaSkeleton()), loadKimodoConfig());
  return clipToStates(rig, clip, 1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const pos: string[] = [];
  let hitT: number | undefined, jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--hit') hitT = Number(argv[++i]);
    else if (a === '--json') jsonOut = argv[++i];
    else pos.push(a);
  }
  const [scenario, clipArg] = pos;
  if (!scenario || !clipArg) throw new Error('사용법: npm run ref:compare -- <scenario> <clip> [--hit <초>] [--json <경로>]');
  const dir = join(ROOT, 'out', scenario);
  const logPath = join(dir, 'log.jsonl');
  if (!existsSync(logPath)) throw new Error(`${logPath} 없음. 먼저 npm run sim -- ${scenario}`);
  const sim = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LogState);
  const meta = readJson<Meta>(join(dir, 'meta.json'));
  const clipPath = resolveClipPath(clipArg);
  const clip = readJson<PoseClipFile>(clipPath);
  const pf = clip.info?.pushFrame;
  const r = compare(sim, meta, refStates(clipPath), { scenario, clip: clipArg, hitT, refOnsetFrame: typeof pf === 'number' ? pf : undefined });
  const out = jsonOut ? resolve(jsonOut) : join(dir, `refSimilarity_${clipArg}.json`);
  writeFileSync(out, JSON.stringify(r, null, 2));
  const it = r.items;
  console.log(`refSimilarity ${scenario} ↔ ${clipArg}: ${r.refSimilarity} (낮을수록 닮음)`);
  console.log(`  정렬: sim 충격 ${r.alignment.simHitT}초 ↔ 레퍼런스 밀림 시작 ${r.alignment.refOnsetT}초, 비교 ${r.alignment.windowS}초`);
  console.log(`  COM 궤적 DTW ${it.comTrajectory.dtwMeanCm}cm (최대 이동 sim ${it.comTrajectory.simPeakDispCm} / ref ${it.comTrajectory.refPeakDispCm}cm)`);
  console.log(`  바디 방향 DTW ${it.bodyOrientation.dtwMeanDeg}°, 몸통 기울기 DTW ${it.trunkTilt.dtwMeanDeg}° (최대 sim ${it.trunkTilt.simPeakDeg} / ref ${it.trunkTilt.refPeakDeg}°)`);
  console.log(`  팔 사용량 sim ${it.armUsage.simDegS} / ref ${it.armUsage.refDegS}°/s, 걸음 sim ${it.steps.sim} / ref ${it.steps.ref}`);
  console.log(`  회복 시간 sim ${it.recoveryTime.simS} / ref ${it.recoveryTime.refS}초, Δv sim ${it.pushDv.simMS} / ref ${it.pushDv.refMS} m/s`);
  console.log(out);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
