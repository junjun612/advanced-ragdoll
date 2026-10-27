// 후보 생성·점수·순위·비교 (SPEC 11.3 "후보 선별").
// 사용법: npm run kimodo:candidates -- <spec.json> [--no-render] [--variant fbx|both|capsule] [--only rp12:3,seed11:5]
//         npm run kimodo:candidates -- <spec.json> --select <model>:<seed> [--reason "..."]  → assets/poses/kimodo_<clip>.json
// 흐름: 모델 × 시드마다 생성(캐시) → 포즈 클립 변환 → (루프) 구간·크로스페이드 → 점수 → 순위표(ranking.json/md) →
//       상위 후보와 모델별 1위를 film:clip으로 렌더 → 한글 비교 이미지(compare_top.png, compare_models.png).
// 요청은 한 번에 하나씩 보낸다 (client.ts).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Vec3 } from '../../src/sim/math/vec3';
import { POSES } from '../../src/sim/character/poseLibrary';
import type { PoseFile } from '../../src/sim/character/pose';
import { ROOT, Rig, loadDef, loadKimodoConfig, readJson, transformFrame, yawQ, type BodyFrame, type KimodoConfig } from './rig';
import { rotate } from '../../src/sim/math/quat';
import { Soma, type KimodoResponse } from './soma';
import { candidateDir, generate, type GenerateRequest } from './client';
import { checkFrame0, fromPose, poseFileFrame, type FromPoseResult } from './fromPose';
import { canonicalTransform, footLock, groundClamp, retarget, toClipFrames, type Contacts, type PoseClipFile } from './toPoseClip';
import {
  IDENTITY_X, conjugateX, crossfadeLoop, findLoop, heelStrike, phaseShift, removeRootDrift, seamMetrics, type RootXform,
} from './loop';
import { scoreClip, type ClipExpect, type Scores } from './score';
import { filmClip, somaSkeleton } from './clipToLog';
import { composeImages } from './compose';

export interface ClipSpec {
  clip: string;
  /** 한글 이름 (이미지 라벨) */
  label: string;
  text: string;
  duration_s: number;
  models: string[];
  seeds: number[];
  /** 0프레임 키프레임으로 고정할 우리 포즈 (config/poses) */
  startPose?: string;
  loop?: { minLenS: number; maxLenS: number; fromS?: number; toS?: number; phaseAlign?: 'Left' | 'Right' };
  rootMotion: 'kept' | 'removed';
  expect?: ClipExpect;
  weights?: Record<string, number>;
  /** 비교 렌더 상위 개수 (기본 3) */
  top?: number;
  /** 필름 반복 횟수 (루프 이음매 확인용) */
  filmCycles?: number;
  /** 필름 카메라 (side|front|top|follow, 기본 side) */
  filmCamera?: string;
  /** 비교 이미지에 넣을 칸 수 (필름에서 고르게 뽑음, 기본 10) */
  compareCells?: number;
  diffusion_steps?: number;
  /** startPose를 이 프레임들에도 전신 키프레임으로 고정 (밀림 직전 정지 자세 고정 → 예측 반응 방지) */
  holdStartFrames?: number[];
  /** 루트 경로 제약 (Kimodo root_path, [x,z] m, 클립 시작 기준) — 밀림 크기를 위치 변화로 줄 때 */
  rootPath?: { points: [number, number][]; frames: number[] };
}

export interface Candidate {
  model: string;
  seed: number;
  dir: string;
  clipPath: string;
  scores: Scores;
  frame0?: { max: number; mean: number; worst: string };
  loop?: { a: number; b: number; lenS: number };
}

const fmt = (x: unknown, d = 2): string => (typeof x === 'number' ? x.toFixed(d) : String(x ?? '-'));

/** 응답 하나 → 포즈 클립 + 점수 (서버 없이도 돈다: 테스트·재처리) */
export function processResponse(
  rig: Rig, spec: ClipSpec, res: KimodoResponse, model: string, seed: number, start: FromPoseResult | null, stand: BodyFrame,
): { clip: PoseClipFile; scores: Scores; frame0?: Candidate['frame0']; loop?: Candidate['loop'] } {
  const fps = res.fps;
  const r = retarget(rig, res);
  let frames = r.frames, raw = r.rawFrames, contacts: Contacts = r.contacts;
  let retErr = r.retargetErr, lock = r.lockCorrection, clamp = r.clampDeg;
  let delta: RootXform | undefined;
  let loopInfo: Candidate['loop'];
  let loopScore: Parameters<typeof scoreClip>[0]['loop'];
  if (spec.loop) {
    const L = spec.loop;
    const k = rig.cfg.loop.crossfadeFrames;
    const win = findLoop(rig, frames, {
      minLen: Math.round(L.minLenS * fps), maxLen: Math.round(L.maxLenS * fps),
      from: Math.max(k, Math.round((L.fromS ?? 0) * fps)), to: L.toS !== undefined ? Math.round(L.toS * fps) : undefined,
      velWeight: rig.cfg.loop.velWeight, fps, absolute: spec.rootMotion === 'removed',
    });
    const cf = crossfadeLoop(rig, frames, contacts, win.a, win.b, k);
    frames = cf.frames; contacts = cf.contacts; delta = cf.delta;
    const sl = <T>(a: T[]) => a.slice(win.a, win.b);
    raw = sl(raw); retErr = sl(retErr); lock = sl(lock); clamp = sl(clamp);
    if (spec.rootMotion === 'removed') { frames = removeRootDrift(rig, frames, delta); delta = IDENTITY_X; }
    if (L.phaseAlign) {
      const s = heelStrike(contacts, L.phaseAlign);
      const rot = <T>(a: T[]) => [...a.slice(s), ...a.slice(0, s)];
      const ps = phaseShift(frames, contacts, s, delta);
      frames = ps.frames; contacts = ps.contacts; raw = phaseShift(raw, contacts, s, delta).frames; retErr = rot(retErr); lock = rot(lock); clamp = rot(clamp);
    }
    // 0프레임을 원점·정면 +Z로 (한 바퀴 이동도 같은 좌표로)
    const T0 = canonicalTransform(rig, frames[0]!);
    frames = frames.map((f) => transformFrame(f, T0.yaw, T0.off));
    raw = raw.map((f) => transformFrame(f, T0.yaw, T0.off));
    delta = conjugateX(delta, { yaw: T0.yaw, pos: T0.off });
    if (spec.rootMotion === 'kept') {
      // 방향 정규화 (SPEC 11.3 위상 정렬: "수평 이동과 방향을 정규화"): 한 바퀴 yaw 변화를 프레임마다 선형으로 빼고(자기 고관절 중점 기준),
      // 한 바퀴 이동이 정확히 ±Z(또는 ±X)를 향하게 클립 전체를 돌린다 → 반복 재생해도 원을 그리며 휘지 않는다
      const L = frames.length;
      frames = frames.map((f, i) => {
        const yaw = (-delta!.yaw * i) / L;
        const m = rig.hipMid(f);
        const mr = rotate(yawQ(yaw), m);
        return transformFrame(f, yaw, [m[0] - mr[0], 0, m[2] - mr[2]]);
      });
      const d = delta.pos;
      const ax = Math.abs(d[2]) >= Math.abs(d[0]) ? [0, Math.sign(d[2])] : [Math.sign(d[0]), 0];
      const th = Math.atan2(ax[0]!, ax[1]!) - Math.atan2(d[0], d[2]);
      frames = frames.map((f) => transformFrame(f, th, [0, 0, 0]));
      const len = Math.hypot(d[0], d[2]);
      delta = { yaw: 0, pos: [ax[0]! * len, 0, ax[1]! * len] };
      const T1 = canonicalTransform(rig, frames[0]!);
      frames = frames.map((f) => transformFrame(f, 0, T1.off));
    }
    // 루프 처리(크로스페이드·드리프트 제거·위상 이동) 뒤 발 고정을 한 번 더: 이음매 근처와 드리프트로 생긴 미끄러짐을 지운다
    if (rig.cfg.footLock.enabled) frames = groundClamp(rig, footLock(rig, frames, contacts).frames);
    const seam = seamMetrics(rig, frames, delta);
    loopInfo = { a: win.a, b: win.b, lenS: (win.b - win.a) / fps };
    loopScore = { window: win, seam, delta, rootMotion: spec.rootMotion };
  } else if (spec.rootMotion === 'removed') {
    // 비루프 제자리: 처음→끝 수평 이동을 선형으로 뺀다
    const m0 = rig.hipMid(frames[0]!), m1 = rig.hipMid(frames[frames.length - 1]!);
    frames = frames.map((f, i) => {
      const s = i / Math.max(1, frames.length - 1);
      return transformFrame(f, 0, [-(m1[0] - m0[0]) * s, 0, -(m1[2] - m0[2]) * s]);
    });
  }

  const scores = scoreClip({
    rig, fps, frames, contacts, rawFrames: raw, retargetErr: retErr, lockCorrection: lock, clampDeg: clamp, stand,
    loop: loopScore, expect: spec.expect, weights: spec.weights,
  }, rig.cfg.score.terms);
  const frame0 = start ? checkFrame0(rig, start.positions, res) : undefined;
  if (frame0) scores.metrics.frame0ErrCm = frame0.max * 100;

  const clip: PoseClipFile = {
    name: `kimodo_${spec.clip}`,
    source: `kimodo:${spec.clip}/${model}_s${seed}`,
    fps,
    loop: !!spec.loop,
    rootMotion: spec.rootMotion,
    jointConvention: 'jointFrameRelRest',
    frames: toClipFrames(rig, frames, contacts),
    ...(spec.loop && spec.rootMotion === 'kept' && delta ? { loopRootDelta: { pos: delta.pos.map((x) => Math.round(x * 1e6) / 1e6) as Vec3, yaw: Math.round(delta.yaw * 1e6) / 1e6 } } : {}),
    info: {
      model: res.model, seed, text: spec.text, kimodoId: res.id, retargetScale: rig.scale, loop: loopInfo ?? null,
      fkMaxErrM: r.fkMaxErr, total: scores.total,
      ...(spec.rootPath ? { pushFrame: spec.rootPath.frames[1], rootPath: spec.rootPath } : {}),
    },
  };
  return { clip, scores, frame0, loop: loopInfo };
}

function modelLabel(cfg: KimodoConfig, model: string): string {
  return cfg.servers[model]?.label ?? model;
}

export function candLabel(cfg: KimodoConfig, c: Pick<Candidate, 'model' | 'seed'>): string {
  return `${modelLabel(cfg, c.model)} 시드 ${c.seed}`;
}

export async function runCandidates(specPath: string, o: { render: boolean; variant: string; only?: string[] }): Promise<Candidate[]> {
  const spec = readJson<ClipSpec>(specPath);
  const cfg = loadKimodoConfig();
  const def = loadDef();
  const rig = new Rig(def, new Soma(somaSkeleton()), cfg);
  const library = POSES as Record<string, PoseFile>;
  const stand = poseFileFrame(rig, library.stand!, library);
  const start = spec.startPose ? fromPose(rig, poseFileFrame(rig, library[spec.startPose]!, library)) : null;
  const clipDir = join(ROOT, 'assets', 'kimodo', spec.clip);
  mkdirSync(clipDir, { recursive: true });
  copyFileSync(specPath, join(clipDir, 'spec.json'));

  const out: Candidate[] = [];
  for (const model of spec.models) {
    for (const seed of spec.seeds) {
      if (o.only && !o.only.includes(`${model}:${seed}`)) continue;
      const req: GenerateRequest = {
        text: spec.text, duration_s: spec.duration_s, seed,
        ...(spec.diffusion_steps ? { diffusion_steps: spec.diffusion_steps } : {}),
        constraints: {
          ...(start ? { keyframes: [start.keyframe, ...(spec.holdStartFrames ?? []).map((frame) => ({ ...start.keyframe, frame }))] } : {}),
          // 경로 점은 시작 키프레임 Hips xz 기준으로 옮겨 보낸다 (키프레임과 어긋나지 않게)
          ...(spec.rootPath ? {
            root_path: spec.rootPath.points.map(([x, z]): [number, number] => [
              Math.round((x + (start?.keyframe.root_position[0] ?? 0)) * 1e6) / 1e6, Math.round((z + (start?.keyframe.root_position[2] ?? 0)) * 1e6) / 1e6]),
            root_path_frames: spec.rootPath.frames,
          } : {}),
        },
      };
      const g = await generate(spec.clip, model, req);
      const p = processResponse(rig, spec, g.res, model, seed, start, stand);
      const clipPath = join(g.dir, 'clip.json');
      writeFileSync(clipPath, JSON.stringify(p.clip));
      writeFileSync(join(g.dir, 'scores.json'), JSON.stringify({ ...p.scores, frame0: p.frame0, loop: p.loop }, null, 2));
      out.push({ model, seed, dir: g.dir, clipPath, scores: p.scores, frame0: p.frame0, loop: p.loop });
      console.log(`${spec.clip} ${model} s${seed}: 점수 ${p.scores.total.toFixed(2)}${g.cached ? ' (캐시)' : ''}${p.scores.expectFailures.length ? ` 기대 실패: ${p.scores.expectFailures.join('; ')}` : ''}`);
    }
  }
  out.sort((a, b) => a.scores.total - b.scores.total);
  writeFileSync(join(clipDir, 'ranking.json'), JSON.stringify(out.map((c) => ({
    model: c.model, seed: c.seed, total: c.scores.total, terms: c.scores.terms, metrics: c.scores.metrics, expectFailures: c.scores.expectFailures, frame0: c.frame0, loop: c.loop,
  })), null, 2));
  writeFileSync(join(clipDir, 'ranking.md'), rankingMarkdown(spec, cfg, out));

  if (o.render) await renderComparisons(spec, cfg, out, o.variant);
  return out;
}

const METRIC_COLS: [string, string, number][] = [
  ['footSlideRawCmPerS', '미끄러짐 cm/s', 2], ['footLockCorrectionCm', '발고정 보정 cm', 2], ['penetrationCm', '관통 cm', 2], ['floatCm', '부양 cm', 2],
  ['jerkP95', '저크 p95', 0], ['limitViolationDegMean', '제한위반 °', 2], ['handClampDegMean', '손목 자름 °', 1], ['retargetErrCm', '리타깃 cm', 1],
  ['seamPosCm', '이음매 cm', 2], ['seamVelCmS', '이음매 속도 cm/s', 1], ['startPoseDeg', '시작-서기 °', 1], ['endPoseDeg', '끝-서기 °', 1],
  ['distM', '이동 m', 2], ['speed', '속도 m/s', 2], ['steps', '걸음', 0], ['hipSwayCm', '골반 흔들림 cm', 1], ['frame0ErrCm', '0프레임 cm', 2],
];

export function rankingMarkdown(spec: ClipSpec, cfg: KimodoConfig, cands: Candidate[]): string {
  const lines = [
    `# ${spec.clip} 후보 순위 (${spec.label})`,
    '',
    `- 프롬프트: \`${spec.text}\``,
    `- 길이 ${spec.duration_s}초, 시작 키프레임: ${spec.startPose ?? '없음'}, 루프: ${spec.loop ? `${spec.loop.minLenS}~${spec.loop.maxLenS}초` : '아님'}, 루트 모션: ${spec.rootMotion}`,
    `- 점수는 낮을수록 좋다 (config/kimodo.json score). 물리 추종성은 아직 없음(근육 추종 계층 이후).`,
    '',
    `| 순위 | 후보 | 점수 | ${METRIC_COLS.map((c) => c[1]).join(' | ')} | 기대 실패 |`,
    `|---|---|---|${METRIC_COLS.map(() => '---').join('|')}|---|`,
  ];
  cands.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${candLabel(cfg, c)} | ${c.scores.total.toFixed(2)} | ${METRIC_COLS.map(([k, , d]) => fmt(c.scores.metrics[k], d)).join(' | ')} | ${c.scores.expectFailures.join('; ') || '-'} |`);
  });
  return lines.join('\n') + '\n';
}

export const filmName = (clip: string, c: Pick<Candidate, 'model' | 'seed'>): string => `kimodo_${clip}_${c.model}_s${c.seed}`;

async function renderComparisons(spec: ClipSpec, cfg: KimodoConfig, ranked: Candidate[], variant: string): Promise<void> {
  const top = ranked.slice(0, spec.top ?? 3);
  const bestPer = spec.models.map((m) => ranked.find((c) => c.model === m)).filter((c): c is Candidate => !!c);
  const toRender = [...new Map([...top, ...bestPer].map((c) => [`${c.model}:${c.seed}`, c])).values()];
  const filmArgs = [...(variant === 'capsule' ? [] : [`--${variant}`]), '--camera', spec.filmCamera ?? 'side'];
  const sfx = variant === 'capsule' ? '' : `_${variant}`;
  const pngOf = (c: Candidate) => join(ROOT, 'out', filmName(spec.clip, c), `film${sfx}.png`);
  for (const c of toRender) {
    const rank = ranked.indexOf(c) + 1;
    filmClip(c.clipPath, {
      name: filmName(spec.clip, c), cycles: spec.filmCycles ?? 1, filmArgs,
      title: `${spec.label} · ${candLabel(cfg, c)} · ${rank}위 점수 ${c.scores.total.toFixed(2)}`,
    });
  }
  const clipDir = join(ROOT, 'assets', 'kimodo', spec.clip);
  const nCells = spec.compareCells ?? 10;
  const cellsOf = (c: Candidate): number[] => {
    const clip = readJson<PoseClipFile>(c.clipPath);
    const frames = clip.frames.length * (clip.loop ? spec.filmCycles ?? 1 : 1);
    const filmFrames = Math.floor((frames - 1) / clip.fps / 0.1 + 1e-6) + 1;
    return Array.from({ length: nCells }, (_, i) => Math.round((i * (filmFrames - 1)) / (nCells - 1)));
  };
  const cellRows = variant === 'both' ? 2 : 1;
  const sub = (c: Candidate) => {
    const m = c.scores.metrics;
    return `점수 ${c.scores.total.toFixed(2)} · 미끄러짐 ${fmt(m.footSlideRawCmPerS, 1)}cm/s · 저크 ${fmt(m.jerkP95, 0)} · 제한위반 ${fmt(m.limitViolationDegMean, 1)}°${m.seamPosCm !== undefined ? ` · 이음매 ${fmt(m.seamPosCm, 1)}cm` : ''}${c.scores.expectFailures.length ? ` · 기대 실패 ${c.scores.expectFailures.length}` : ''}`;
  };
  await composeImages(top.map((c, i) => ({ png: pngOf(c), label: `${i + 1}위 ${candLabel(cfg, c)}`, sub: sub(c), cells: cellsOf(c), cellRows })), join(clipDir, 'compare_top.png'), {
    title: `${spec.label} (${spec.clip}) — 자동 점수 상위 ${top.length}개`, scale: cfg.film.compareScale, note: `프롬프트: ${spec.text} · 칸 ${nCells}개를 고르게 뽑음`,
  });
  await composeImages(bestPer.map((c) => ({ png: pngOf(c), label: `${candLabel(cfg, c)} (${modelLabel(cfg, c.model)} 1위)`, sub: sub(c), cells: cellsOf(c), cellRows })), join(clipDir, 'compare_models.png'), {
    title: `${spec.label} (${spec.clip}) — 모델별 1위 비교`, scale: cfg.film.compareScale, note: `프롬프트: ${spec.text} · 칸 ${nCells}개를 고르게 뽑음`,
  });
  console.log(join(clipDir, 'compare_top.png'));
  console.log(join(clipDir, 'compare_models.png'));
}

/** 고른 후보 → assets/poses/kimodo_<clip>.json */
export function selectCandidate(spec: ClipSpec, model: string, seed: number, reason: string): string {
  const src = join(candidateDir(spec.clip, model, seed), 'clip.json');
  if (!existsSync(src)) throw new Error(`${src} 없음. 먼저 후보를 만든다`);
  const clip = readJson<PoseClipFile>(src);
  clip.info = { ...clip.info, chosen: { reason, date: new Date().toISOString().slice(0, 10) } };
  const dst = join(ROOT, 'assets', 'poses', `kimodo_${spec.clip}.json`);
  mkdirSync(join(ROOT, 'assets', 'poses'), { recursive: true });
  writeFileSync(dst, JSON.stringify(clip));
  return dst;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let specPath = '', select = '', reason = '', render = true, variant = 'fbx';
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--select') select = argv[++i] ?? '';
    else if (a === '--reason') reason = argv[++i] ?? '';
    else if (a === '--no-render') render = false;
    else if (a === '--variant') variant = argv[++i] ?? 'fbx';
    else if (a === '--only') only = (argv[++i] ?? '').split(',');
    else if (!specPath) specPath = a;
  }
  if (!specPath) throw new Error('사용법: npm run kimodo:candidates -- <spec.json> [--no-render] [--variant fbx|both|capsule] [--select model:seed]');
  const sp = existsSync(resolve(specPath)) ? resolve(specPath) : join(ROOT, 'tools', 'kimodo', 'specs', `${basename(specPath, '.json')}.json`);
  if (select) {
    const [model, seed] = select.split(':');
    console.log(selectCandidate(readJson<ClipSpec>(sp), model!, Number(seed), reason));
    return;
  }
  await runCandidates(sp, { render, variant, only });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
}
