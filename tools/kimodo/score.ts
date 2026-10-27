// 후보 자동 점수 (SPEC 11.3 "후보 선별"). 낮을수록 좋다. 가중치·기준값은 config/kimodo.json score.terms.
// 발 미끄러짐(접촉 중 수평 이동), 지면 관통·부양, 관절 저크, 우리 랙돌 관절 제한 위반, 리타깃 오차(손·발),
// 루프 이음매 오차(위치·속도), 첫·끝 프레임과 기준 자세(stand) 거리, 물리 추종성(아직 없음 → null, 근육 추종 계층 연결 후 채운다).
// 프롬프트 기대 동작(이동 방향·거리·걸음 수)은 expect로 확인해 벌점(expectPenalty)으로 더한다.
import type { BodyName } from '../../src/sim/character/characterDef';
import { type Vec3, sub, length, add, scale } from '../../src/sim/math/vec3';
import { angleBetweenQ, rotate } from '../../src/sim/math/quat';
import { type BodyFrame, Rig, SIDES } from './rig';
import { type Contacts, footDown } from './toPoseClip';
import type { LoopWindow, RootXform, SeamMetrics } from './loop';

export interface ClipExpect {
  /** 이동 방향 [x, z] (정면 +Z 기준, 클립 좌표) */
  dir?: [number, number];
  minDistM?: number;
  maxDistM?: number;
  /** 평균 수평 속도 범위 (m/s) */
  minSpeed?: number;
  maxSpeed?: number;
  /** 걸음 수 (발을 5cm 넘게 옮겨 디딘 횟수) */
  minSteps?: number;
  maxSteps?: number;
  /** 고관절 중점 수평 흔들림 범위 (cm) — 제자리 클립의 체중 이동 */
  minHipSwayCm?: number;
  maxHipSwayCm?: number;
  /** 끝 0.3초 동안 고관절 속도 상한 (m/s) — 버티고 멈췄는가 */
  endStillSpeed?: number;
}

export interface ScoreInput {
  rig: Rig;
  fps: number;
  frames: BodyFrame[];
  contacts: Contacts;
  /** 발 고정 전 (같은 프레임 범위) */
  rawFrames: BodyFrame[];
  retargetErr: number[];
  lockCorrection: number[];
  clampDeg: number[];
  stand: BodyFrame;
  loop?: { window: LoopWindow; seam: SeamMetrics; delta: RootXform; rootMotion: 'kept' | 'removed' };
  expect?: ClipExpect;
  weights?: Record<string, number>;
}

export interface Scores {
  total: number;
  terms: Record<string, number>;
  metrics: Record<string, number | string | null>;
  expectFailures: string[];
}

const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

/** 뒤꿈치 접촉 중 발목 관절 수평 이동 합 (m) */
function footSlide(rig: Rig, frames: BodyFrame[], contacts: Contacts): number {
  let sum = 0;
  for (const side of SIDES) {
    const i = rig.idx(`${side}Foot` as BodyName);
    let prev: Vec3 | null = null;
    frames.forEach((f, t) => {
      const p = rig.jointPositions(f)[i]!;
      if (contacts[t]![side].heel && prev && contacts[t - 1]?.[side].heel) sum += Math.hypot(p[0] - prev[0], p[2] - prev[2]);
      prev = p;
    });
  }
  return sum;
}

/** 관절 r 사이 평균 각(도) + Hips 기울기 차이 (정면 회전은 뺀다) */
export function poseDistanceDeg(rig: Rig, a: BodyFrame, b: BodyFrame): number {
  const ra = rig.jointRel(a), rb = rig.jointRel(b);
  const angs = Object.keys(ra).map((k) => angleBetweenQ(ra[k as keyof typeof ra]!, rb[k as keyof typeof rb]!));
  const upA = rotate(a.rot[0]!, [0, 1, 0]), upB = rotate(b.rot[0]!, [0, 1, 0]);
  angs.push(Math.acos(Math.max(-1, Math.min(1, upA[0] * upB[0] + upA[1] * upB[1] + upA[2] * upB[2]))));
  return (mean(angs) * 180) / Math.PI;
}

export function scoreClip(inp: ScoreInput, terms: Record<string, { weight: number; scale: number }>): Scores {
  const { rig, fps, frames, contacts } = inp;
  const T = frames.length;
  const dur = T / fps;
  const m: Record<string, number | string | null> = {};

  m.footSlideRawCmPerS = (footSlide(rig, inp.rawFrames, contacts) * 100) / dur;
  m.footSlideCmPerS = (footSlide(rig, frames, contacts) * 100) / dur;
  m.footLockCorrectionCm = mean(inp.lockCorrection) * 100;
  m.footLockCorrectionMaxCm = Math.max(0, ...inp.lockCorrection) * 100;

  // 지면: 발 박스 최저점
  let pen = 0;
  const floats: number[] = [];
  frames.forEach((f, t) => {
    const pos = rig.positions(f);
    for (const side of SIDES) {
      const y = rig.soleY(f, side, pos);
      pen = Math.max(pen, -y);
      if (footDown(contacts[t]![side])) floats.push(Math.max(0, y));
    }
  });
  m.penetrationCm = Math.max(0, pen) * 100;
  m.floatCm = mean(floats) * 100;

  // 저크: 관절 위치 3차 차분 (m/s³), 관절 평균
  const X = frames.map((f) => rig.jointPositions(f));
  const jerk: number[] = [];
  for (let t = 3; t < T; t++) {
    let s = 0;
    for (let j = 0; j < X[t]!.length; j++) {
      const d = add(sub(X[t]![j]!, X[t - 3]![j]!), scale(sub(X[t - 2]![j]!, X[t - 1]![j]!), 3));
      s += length(d);
    }
    jerk.push((s / X[t]!.length) * fps ** 3);
  }
  m.jerkMean = mean(jerk);
  m.jerkP95 = pct(jerk, 0.95);

  // 관절 제한
  const viol: number[] = [];
  const worst: Record<string, number> = {};
  for (const f of frames) {
    const v = rig.limitViolationsDeg(f);
    let mx = 0;
    for (const [k, x] of Object.entries(v)) { mx = Math.max(mx, x); worst[k] = Math.max(worst[k] ?? 0, x); }
    viol.push(mx);
  }
  m.limitViolationDegMean = mean(viol);
  m.limitViolationDegMax = Math.max(0, ...viol);
  const w = Object.entries(worst).sort((a, b) => b[1] - a[1])[0];
  m.limitWorstJoint = w && w[1] > 0 ? `${w[0]} ${w[1].toFixed(1)}°` : '없음';
  m.handClampDegMean = mean(inp.clampDeg);

  m.retargetErrCm = mean(inp.retargetErr) * 100;

  if (inp.loop) {
    m.seamPosCm = inp.loop.window.posErr * 100;
    m.seamVelCmS = inp.loop.window.velErr * 100;
    m.seamAccelCm = inp.loop.seam.seamAccelCm;
    m.interiorAccelP95Cm = inp.loop.seam.interiorAccelP95Cm;
    m.loopFrames = T;
  }

  m.startPoseDeg = poseDistanceDeg(rig, frames[0]!, inp.stand);
  m.endPoseDeg = poseDistanceDeg(rig, frames[T - 1]!, inp.stand);
  m.trackability = null; // 물리 추종성: 근육 추종(애니 추종) 계층이 생기면 채운다 (SPEC 11.3)

  // 동작 요약
  const mid0 = rig.hipMid(frames[0]!);
  const midEnd = inp.loop?.rootMotion === 'kept'
    ? add(rotate([0, Math.sin(inp.loop.delta.yaw / 2), 0, Math.cos(inp.loop.delta.yaw / 2)], mid0), inp.loop.delta.pos)
    : rig.hipMid(frames[T - 1]!);
  const disp: Vec3 = [midEnd[0] - mid0[0], 0, midEnd[2] - mid0[2]];
  m.dispX = disp[0];
  m.dispZ = disp[2];
  m.distM = Math.hypot(disp[0], disp[2]);
  m.speed = (m.distM as number) / dur;
  // 걸음 = 발이 떨어졌다가 앞 접촉 위치에서 5cm 넘게 옮겨 다시 닿은 횟수 (제자리 들썩임·접촉 깜빡임 제외)
  let steps = 0;
  for (const side of SIDES) {
    const iF = rig.idx(`${side}Foot` as BodyName);
    let last: Vec3 | null = null;
    for (let t = 0; t < T; t++) {
      const down = footDown(contacts[t]![side]);
      const p = X[t]![iF]!;
      if (down && (t === 0 || !footDown(contacts[t - 1]![side]))) {
        if (last && Math.hypot(p[0] - last[0], p[2] - last[2]) > 0.05) steps++;
      }
      if (down) last = p;
    }
  }
  m.steps = steps;
  const mids = frames.map((f) => rig.hipMid(f));
  const mx = mean(mids.map((p) => p[0])), mz = mean(mids.map((p) => p[2]));
  m.hipSwayCm = Math.max(...mids.map((p) => Math.hypot(p[0] - mx, p[2] - mz))) * 100;
  const endN = Math.min(T - 1, Math.round(0.3 * fps));
  m.endSpeed = length(sub(mids[T - 1]!, mids[T - 1 - endN]!)) / (endN / fps);
  m.durationS = dur;

  // 기대 동작
  const fails: string[] = [];
  let penalty = 0;
  const e = inp.expect ?? {};
  const fail = (msg: string, amount: number) => { fails.push(msg); penalty += Math.min(1, Math.max(0.1, amount)); };
  if (e.dir) {
    const n = Math.hypot(e.dir[0], e.dir[1]);
    const along = (disp[0] * e.dir[0] + disp[2] * e.dir[1]) / n;
    const lateral = Math.abs(disp[0] * e.dir[1] - disp[2] * e.dir[0]) / n;
    m.alongM = along;
    m.lateralM = lateral;
    if (along <= 0) fail(`이동 방향이 반대 (기대 [${e.dir}], 이동 ${disp[0].toFixed(2)}, ${disp[2].toFixed(2)})`, 1);
    else if (lateral > Math.max(0.15, 0.5 * along)) fail(`옆으로 샘 (진행 ${along.toFixed(2)}m, 옆 ${lateral.toFixed(2)}m)`, lateral / Math.max(0.1, along));
  }
  const dist = m.distM as number;
  if (e.minDistM !== undefined && dist < e.minDistM) fail(`이동 거리 부족 ${dist.toFixed(2)} < ${e.minDistM}m`, 1 - dist / e.minDistM);
  if (e.maxDistM !== undefined && dist > e.maxDistM) fail(`이동 거리 초과 ${dist.toFixed(2)} > ${e.maxDistM}m`, dist / e.maxDistM - 1);
  const sp = m.speed as number;
  if (e.minSpeed !== undefined && sp < e.minSpeed) fail(`속도 부족 ${sp.toFixed(2)} < ${e.minSpeed}m/s`, 1 - sp / e.minSpeed);
  if (e.maxSpeed !== undefined && sp > e.maxSpeed) fail(`속도 초과 ${sp.toFixed(2)} > ${e.maxSpeed}m/s`, sp / e.maxSpeed - 1);
  if (e.minSteps !== undefined && steps < e.minSteps) fail(`걸음 수 부족 ${steps} < ${e.minSteps}`, 1);
  if (e.maxSteps !== undefined && steps > e.maxSteps) fail(`걸음 수 초과 ${steps} > ${e.maxSteps}`, (steps - e.maxSteps) / e.maxSteps);
  const sway = m.hipSwayCm as number;
  if (e.minHipSwayCm !== undefined && sway < e.minHipSwayCm) fail(`체중 이동 부족 ${sway.toFixed(1)} < ${e.minHipSwayCm}cm`, 1 - sway / e.minHipSwayCm);
  if (e.maxHipSwayCm !== undefined && sway > e.maxHipSwayCm) fail(`흔들림 과다 ${sway.toFixed(1)} > ${e.maxHipSwayCm}cm`, sway / e.maxHipSwayCm - 1);
  if (e.endStillSpeed !== undefined && (m.endSpeed as number) > e.endStillSpeed) fail(`끝에서 멈추지 않음 ${(m.endSpeed as number).toFixed(2)}m/s`, (m.endSpeed as number) / e.endStillSpeed - 1);
  m.expectPenalty = penalty;

  // 종합
  const out: Record<string, number> = {};
  let total = 0;
  for (const [k, t] of Object.entries(terms)) {
    const v = m[k];
    if (typeof v !== 'number') continue;
    const wgt = inp.weights?.[k] ?? t.weight;
    if (!wgt) continue;
    out[k] = (wgt * v) / t.scale;
    total += out[k]!;
  }
  return { total, terms: out, metrics: m, expectFailures: fails };
}
