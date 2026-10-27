// 밀림 레퍼런스 추가 4종 (docs/KIMODO.md 5장 방법 그대로: 중립 프롬프트 + 루트 경로로 밀림 + 밀림 직전 0.8·1.0초 전신 키프레임 고정).
//   push_diag_medium          앞-왼쪽 45°에서 밀림 (오른쪽 뒤로 15cm/0.4초)
//   push_twice                앞에서 두 번 (0.6초 간격, 각 12cm/0.4초)
//   push_side_during_step     서기 → 첫 걸음 스윙 중 왼쪽에서 밀림 (오른쪽으로 15cm/0.4초)
//   push_side_single_support  왼발로 서고 오른발을 든 자세에서 오른쪽에서 밀림 (디딤발 쪽 = 왼쪽으로 15cm/0.4초)
// 사용법: npx tsx tools/kimodo/pushExtra.ts <clip|all> [--seeds 1-6] [--no-render]
//         npx tsx tools/kimodo/pushExtra.ts --pose-check                      (외발 자세 FK 확인, 서버 없음)
//         npx tsx tools/kimodo/pushExtra.ts --pick <clip> <model>:<seed> --reason "..."   → assets/poses/kimodo_<clip>.json
// 출력: tools/kimodo/specs/push_extra/<clip>.json, assets/kimodo/<clip>/ (후보·ranking·reaction.json·compare_all.png)
// 외발 자세(stand_single_left)는 src 포즈 라이브러리에 없어서 여기서 POSES에 넣고 fromPose.ts로 키프레임을 만든다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, Rig, loadDef, loadKimodoConfig, readJson } from './rig';
import { POSES } from '../../src/sim/character/poseLibrary';
import type { PoseFile } from '../../src/sim/character/pose';
import { Soma } from './soma';
import { candidateDir } from './client';
import { runCandidates, candLabel, filmName, type ClipSpec } from './candidates';
import { clipToStates, filmClip, somaSkeleton } from './clipToLog';
import { fromPose, poseFileFrame } from './fromPose';
import { composeImages } from './compose';
import { reactionOf, type Reaction } from './pushStudy';
import { resample, toFrames } from './refSimilarity';
import type { PoseClipFile } from './toPoseClip';

/** 왼발 외발 서기: stand에서 오른 고관절·무릎을 굽혀 발을 들고, 왼다리를 안쪽으로 모아 골반 중점을 왼발 위로 */
const STAND_SINGLE_LEFT: PoseFile = {
  name: 'stand_single_left',
  base: 'stand',
  joints: {
    LeftUpLeg: { flex: 4, side: -6 },
    LeftLeg: { flex: 12 },
    LeftFoot: { flex: 8, side: 6 },
    RightUpLeg: { flex: 40, side: -4 },
    RightLeg: { flex: 70 },
    RightFoot: { flex: 20, side: 3.9 },
    Spine: { flex: 0, side: -3 },
  },
};
(POSES as Record<string, PoseFile>).stand_single_left = STAND_SINGLE_LEFT;

const S = Math.SQRT1_2;
/** out = 고른 클립 파일 이름 (프롬프트 변형도 같은 이름으로 낸다) */
interface Extra { spec: ClipSpec; dir: [number, number]; pushFrame: number; cameras: [string, string]; cellFrom: number; out?: string }
const base = { models: ['rp12'], seeds: [1, 2, 3, 4, 5, 6], rootMotion: 'kept' as const, weights: { startPoseDeg: 0, endPoseDeg: 1.0 }, top: 3 };
export const EXTRA: Record<string, Extra> = {
  push_diag_medium: {
    dir: [-S, -S], pushFrame: 30, cameras: ['side', 'front'], cellFrom: 8,
    spec: {
      ...base, clip: 'push_diag_medium', label: '앞-왼쪽 45°에서 살짝 세게 밀림 (15cm/0.4초)',
      text: 'a person standing still is suddenly pushed on the chest from the front-left, pushing them diagonally backward and to their right, and recovers their balance',
      holdStartFrames: [24, 30],
      rootPath: { points: [[0, 0], [0, 0], [-0.15 * S, -0.15 * S]], frames: [0, 30, 42] },
      duration_s: 4, startPose: 'stand', expect: { dir: [-S, -S], endStillSpeed: 0.3 }, filmCamera: 'side',
    },
  },
  push_twice: {
    dir: [0, -1], pushFrame: 30, cameras: ['side', 'front'], cellFrom: 8,
    spec: {
      ...base, clip: 'push_twice', label: '앞에서 두 번 밀림 (0.6초 간격, 각 12cm/0.4초)',
      text: 'a person standing still is suddenly pushed twice in quick succession on the chest from the front, pushing them backward, and recovers their balance',
      holdStartFrames: [24, 30],
      // 1차 30→42프레임 12cm, 0.2초 동안 2cm 더 밀려 감속, 2차 48→60프레임 12cm
      rootPath: { points: [[0, 0], [0, 0], [0, -0.12], [0, -0.14], [0, -0.26]], frames: [0, 30, 42, 48, 60] },
      duration_s: 4.5, startPose: 'stand', expect: { dir: [0, -1], endStillSpeed: 0.3 }, filmCamera: 'side',
    },
  },
  push_side_during_step: {
    dir: [-1, 0], pushFrame: 24, cameras: ['front', 'side'], cellFrom: 4,
    spec: {
      ...base, clip: 'push_side_during_step', label: '첫 걸음 스윙 중 왼쪽에서 밀림 (15cm/0.4초)',
      text: 'a person starts walking forward from standing, and during their first step is suddenly pushed on their left shoulder from the left side, pushing them to their right, and recovers their balance',
      // 걷기 시작 타이밍 (walk_forward RP 시드 1: 0.5초부터 Hips 전진, 첫 스윙 0.6~1.07초): 0.4초까지 제자리, 0.8초(스윙 중간) Hips +13cm 전진,
      // 0.8→1.2초 오른쪽으로 15cm (전진은 0.45m까지)
      rootPath: { points: [[0, 0], [0, 0], [0, 0.13], [-0.15, 0.45]], frames: [0, 12, 24, 36] },
      duration_s: 4, startPose: 'stand', expect: { dir: [-1, 0] }, filmCamera: 'front',
    },
  },
  push_side_single_support: {
    dir: [1, 0], pushFrame: 30, cameras: ['front', 'side'], cellFrom: 8,
    spec: {
      ...base, clip: 'push_side_single_support', label: '왼발 외발 서기에서 오른쪽에서 밀림 (디딤발 쪽으로 15cm/0.4초)',
      text: 'a person standing on their left leg with their right foot raised is suddenly pushed on their right shoulder from the right side, pushing them to their left, and recovers their balance',
      holdStartFrames: [24, 30],
      rootPath: { points: [[0, 0], [0, 0], [0.15, 0]], frames: [0, 30, 42] },
      duration_s: 4, startPose: 'stand_single_left', expect: { dir: [1, 0], endStillSpeed: 0.3 }, filmCamera: 'front',
    },
  },
  // 프롬프트 변형 (2026-10-26): 원래 프롬프트는 12시드 모두 밀린 뒤 오른쪽으로 돌아 계속 걸어가 버렸다(옆 3~5m)
  push_side_during_step_stop: {
    dir: [-1, 0], pushFrame: 24, cameras: ['front', 'side'], cellFrom: 4, out: 'push_side_during_step',
    spec: {
      ...base, clip: 'push_side_during_step_stop', label: '첫 걸음 스윙 중 왼쪽에서 밀림 → 옆걸음으로 버티고 멈춤 (15cm/0.4초)',
      text: 'a person starts walking forward from standing, and during their first step is suddenly pushed on their left shoulder from the left side, pushing them to their right, takes a quick step to the side to catch their balance, then stops and stands still',
      rootPath: { points: [[0, 0], [0, 0], [0, 0.13], [-0.15, 0.45]], frames: [0, 12, 24, 36] },
      duration_s: 4, startPose: 'stand', expect: { dir: [-1, 0], endStillSpeed: 0.3 }, filmCamera: 'front',
    },
  },
  // 프롬프트 변형: 원래 프롬프트는 12시드 모두 외발로 버티며 든 다리를 옆으로 뻗었다(걸음·교차 없음)
  push_side_single_support_step: {
    dir: [1, 0], pushFrame: 30, cameras: ['front', 'side'], cellFrom: 8, out: 'push_side_single_support',
    spec: {
      ...base, clip: 'push_side_single_support_step', label: '왼발 외발 서기에서 오른쪽에서 밀림 → 발 디뎌 버팀 (15cm/0.4초)',
      text: 'a person balancing on their left leg with their right foot raised is suddenly pushed on their right shoulder from the right side, pushing them to their left, quickly puts their right foot down across to catch themselves, and recovers their balance standing on both feet',
      holdStartFrames: [24, 30],
      rootPath: { points: [[0, 0], [0, 0], [0.15, 0]], frames: [0, 30, 42] },
      duration_s: 4, startPose: 'stand_single_left', expect: { dir: [1, 0], endStillSpeed: 0.3 }, filmCamera: 'front',
    },
  },
};

export interface Touchdown { foot: 'LeftFoot' | 'RightFoot'; t: number; movedCm: number | null; x: number; z: number; crossover: boolean }
export interface ExtraRow { model: string; seed: number; total: number; r: Reaction; touchdowns: Touchdown[]; steps: number; crossovers: number }

/** 밀림 0.3초 전부터의 발 착지 (이동 > 5cm 또는 들고 있던 발의 첫 착지 = 걸음). crossover = 착지 발이 반대 발 너머(좌우가 뒤바뀜) */
function touchdowns(rig: Rig, clip: PoseClipFile, on: number): Touchdown[] {
  const fr = resample(toFrames(clipToStates(rig, clip, 1)));
  const out: Touchdown[] = [];
  for (const side of ['LeftFoot', 'RightFoot'] as const) {
    const other = side === 'LeftFoot' ? 'RightFoot' : 'LeftFoot';
    let last: number[] | null = null;
    for (let i = 1; i < fr.length; i++) {
      const f = fr[i]!, down = f.feet[side], p = f.pos[side]!;
      if (down && !fr[i - 1]!.feet[side] && i >= on - 9) {
        const moved = last ? Math.hypot(p[0] - last[0]!, p[2] - last[2]!) * 100 : null;
        // 클립 좌표 +X = 왼쪽: 왼발은 오른발보다 +X에 있어야 정상
        const dx = p[0] - f.pos[other]![0];
        out.push({ foot: side, t: Math.round((f.t - fr[on]!.t) * 100) / 100, movedCm: moved === null ? null : Math.round(moved), x: p[0], z: p[2], crossover: side === 'LeftFoot' ? dx < 0 : dx > 0 });
      }
      if (down) last = p;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

async function run(name: string, seeds: number[] | null, render: boolean): Promise<void> {
  const ex = EXTRA[name]!;
  const cfg = loadKimodoConfig();
  const rig = new Rig(loadDef(), new Soma(somaSkeleton()), cfg);
  const spec = { ...ex.spec, ...(seeds ? { seeds } : {}) };
  const specDir = join(ROOT, 'tools', 'kimodo', 'specs', 'push_extra');
  mkdirSync(specDir, { recursive: true });
  const sp = join(specDir, `${name}.json`);
  // 스펙 파일에는 지금까지 쓴 시드 전부를 남긴다
  const prev = (() => { try { return readJson<ClipSpec>(sp).seeds; } catch { return []; } })();
  writeFileSync(sp, JSON.stringify({ ...spec, seeds: [...new Set([...prev, ...spec.seeds])].sort((a, b) => a - b) }, null, 2) + '\n');
  await runCandidates(sp, { render: false, variant: 'fbx' });
  const all = readJson<ClipSpec>(sp);
  const rows: ExtraRow[] = [];
  for (const seed of all.seeds) {
    const dir = candidateDir(name, 'rp12', seed);
    const clip = readJson<PoseClipFile>(join(dir, 'clip.json'));
    const r = reactionOf(rig, clip, ex.dir, ex.pushFrame);
    const td = touchdowns(rig, clip, ex.pushFrame).filter((t) => t.t >= 0);
    const steps = td.filter((t) => t.movedCm === null || t.movedCm > 5).length;
    rows.push({ model: 'rp12', seed, total: readJson<{ total: number }>(join(dir, 'scores.json')).total, r, touchdowns: td, steps, crossovers: td.filter((t) => t.crossover).length });
  }
  rows.sort((a, b) => a.total - b.total);
  const outDir = join(ROOT, 'assets', 'kimodo', name);
  writeFileSync(join(outDir, 'reaction.json'), JSON.stringify(rows, null, 2));
  for (const x of rows) {
    console.log(`${name} s${x.seed}: 점수 ${x.total.toFixed(2)} 걸음 ${x.steps} 교차 ${x.crossovers} Δv ${x.r.dvMS.toFixed(2)} 이동 ${x.r.peakDispCm.toFixed(0)}cm 방향 ${x.r.directionOk ? 'ok' : 'X'} 예측 ${x.r.preMoveCm.toFixed(1)}cm 넘어짐 ${x.r.fell} 몸통 ${x.r.trunkTiltDeg.toFixed(0)}° 회복 ${x.r.recoveryS?.toFixed(2) ?? '-'} 착지 ${x.touchdowns.map((t) => `${t.foot[0]}@${t.t}${t.crossover ? 'x' : ''}(${t.movedCm ?? '첫'})`).join(' ')}`);
  }
  if (!render) return;
  for (const cam of ex.cameras) {
    const items = [];
    for (const [i, x] of rows.entries()) {
      const c = { model: x.model, seed: x.seed };
      const clipPath = join(candidateDir(name, x.model, x.seed), 'clip.json');
      filmClip(clipPath, {
        name: filmName(name, c), filmArgs: ['--fbx', '--camera', ex.cameras[0], '--camera', ex.cameras[1]],
        title: `${spec.label} · ${candLabel(cfg, c)} · ${x.steps}걸음`,
      });
      const fr = Math.floor((readJson<PoseClipFile>(clipPath).frames.length - 1) / 30 / 0.1 + 1e-6) + 1;
      items.push({
        png: join(ROOT, 'out', filmName(name, c), cam === ex.cameras[0] ? 'film_fbx.png' : `film_fbx_${cam}.png`),
        label: `${i + 1}위 ${candLabel(cfg, c)}`,
        sub: `${x.steps}걸음${x.crossovers ? ` (교차 ${x.crossovers})` : ''} · Δv ${x.r.dvMS.toFixed(2)}m/s · COM 이동 ${x.r.peakDispCm.toFixed(0)}cm · 몸통 ${x.r.trunkTiltDeg.toFixed(0)}° · 회복 ${x.r.recoveryS?.toFixed(1) ?? '-'}초 · 예측 ${x.r.preMoveCm.toFixed(1)}cm · 점수 ${x.total.toFixed(2)}`,
        cells: Array.from({ length: 10 }, (_, j) => Math.min(fr - 1, ex.cellFrom + Math.round((j * (35 - ex.cellFrom)) / 9))),
      });
    }
    const out = join(outDir, `compare_all_${cam}.png`);
    await composeImages(items, out, {
      title: `${spec.label} (${name}) — RP-v1.2 후보 전부 (${cam === 'front' ? '정면' : '측면'})`, scale: 0.75,
      note: `칸: ${(ex.cellFrom / 10).toFixed(1)}~3.5초 10칸 (밀림 ${(ex.pushFrame / 30).toFixed(1)}초) · 자동 점수순 · 프롬프트: ${spec.text}`,
    });
    console.log(out);
  }
}

function pick(name: string, ms: string, reason: string): void {
  const [model, seed] = ms.split(':');
  const src = readJson<PoseClipFile>(join(candidateDir(name, model!, Number(seed)), 'clip.json'));
  const row = readJson<ExtraRow[]>(join(ROOT, 'assets', 'kimodo', name, 'reaction.json')).find((x) => x.model === model && x.seed === Number(seed));
  const out = EXTRA[name]!.out ?? name;
  src.name = `kimodo_${out}`;
  src.info = { ...src.info, pushFrame: EXTRA[name]!.pushFrame, reaction: row?.r, touchdowns: row?.touchdowns, chosen: { reason, date: new Date().toISOString().slice(0, 10) } };
  const dst = join(ROOT, 'assets', 'poses', `kimodo_${out}.json`);
  writeFileSync(dst, JSON.stringify(src));
  console.log(dst);
}

function poseCheck(): void {
  const rig = new Rig(loadDef(), new Soma(somaSkeleton()), loadKimodoConfig());
  const lib = POSES as Record<string, PoseFile>;
  for (const p of ['stand', 'stand_single_left']) {
    const r = fromPose(rig, poseFileFrame(rig, lib[p]!, lib));
    const s = rig.soma;
    const at = (n: string) => r.positions[s.idx(n)]!.map((v) => v.toFixed(3)).join(',');
    console.log(p, 'Hips', at('Hips'), 'LeftFoot', at('LeftFoot'), 'RightFoot', at('RightFoot'), 'LeftToeBase', at('LeftToeBase'), 'RightToeBase', at('RightToeBase'), 'Head', at('Head'));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--pose-check')) return poseCheck();
  if (argv[0] === '--pick') return pick(argv[1]!, argv[2]!, argv.includes('--reason') ? argv[argv.indexOf('--reason') + 1]! : '');
  const si = argv.indexOf('--seeds');
  const seeds = si >= 0 ? (() => { const [a, b] = argv[si + 1]!.split('-').map(Number); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i); })() : null;
  const names = argv[0] === 'all' ? Object.keys(EXTRA) : [argv[0]!];
  for (const n of names) {
    if (!EXTRA[n]) throw new Error(`모르는 클립 ${n}: ${Object.keys(EXTRA).join(', ')}`);
    await run(n, seeds, !argv.includes('--no-render'));
  }
}

if (process.argv[1]?.endsWith('pushExtra.ts')) main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
