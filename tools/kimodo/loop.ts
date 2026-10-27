// 루프 클립 만들기 (SPEC 11.3 "블렌딩·전환 품질" 루프·위상 정렬).
// 1. findLoop: 길게 생성한 클립에서 자세·속도 차이가 가장 작은 구간 [a, b)를 찾는다 (b = 루프가 돌아갈 다음 프레임).
// 2. crossfadeLoop: 끝 k프레임을 "a 앞의 k프레임을 한 바퀴 이동(delta)만큼 옮긴 것"으로 섞어서 b → a 이음매를 매끄럽게 한다.
// 3. 루트 모션: kept면 delta(한 바퀴 이동)를 클립에 남기고, removed면 선형 드리프트를 빼서 제자리로 만든다.
// 4. phaseShift: 걷기는 왼발 뒤꿈치 착지 프레임이 0프레임이 되게 돌린다 (루프라 자유롭게 돌릴 수 있다).
import { type Vec3, add, sub, scale, length } from '../../src/sim/math/vec3';
import { rotate } from '../../src/sim/math/quat';
import { type BodyFrame, Rig, headingOf, lerpFrame, transformFrame, yawQ } from './rig';
import type { Contacts } from './toPoseClip';

/** 루트 변환 p → R(yaw)·p + pos (Y축 회전 + 이동) */
export interface RootXform { yaw: number; pos: Vec3 }
export const IDENTITY_X: RootXform = { yaw: 0, pos: [0, 0, 0] };
export const applyX = (x: RootXform, f: BodyFrame): BodyFrame => transformFrame(f, x.yaw, x.pos);

/** fa를 fb 쪽으로 옮기는 수평 루트 변환 (yaw = 정면 차이, 이동 = 고관절 중점 xz 차이) */
export function relXform(rig: Rig, fa: BodyFrame, fb: BodyFrame): RootXform {
  let yaw = headingOf(fb.rot[0]!) - headingOf(fa.rot[0]!);
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  const ma = rotate(yawQ(yaw), rig.hipMid(fa)), mb = rig.hipMid(fb);
  return { yaw, pos: [mb[0] - ma[0], 0, mb[2] - ma[2]] };
}

/** 루트 기준 특징: 관절 위치 - 고관절 중점, 정면 기준 좌표 (16×3) + 고관절 높이 */
export function features(rig: Rig, f: BodyFrame): number[] {
  const q = yawQ(-headingOf(f.rot[0]!));
  const mid = rig.hipMid(f);
  const out: number[] = [];
  for (const p of rig.jointPositions(f)) out.push(...rotate(q, sub(p, mid)));
  out.push(mid[1]);
  return out;
}

/** 루트 속도 (정면 기준, m/프레임) */
function rootVel(rig: Rig, a: BodyFrame, b: BodyFrame): Vec3 {
  return rotate(yawQ(-headingOf(a.rot[0]!)), sub(rig.hipMid(b), rig.hipMid(a)));
}

const meanDist3 = (x: number[], y: number[]): number => {
  let s = 0, n = 0;
  for (let i = 0; i + 2 < x.length; i += 3) { s += Math.hypot(x[i]! - y[i]!, x[i + 1]! - y[i + 1]!, x[i + 2]! - y[i + 2]!); n++; }
  return s / Math.max(1, n);
};

export interface LoopWindow {
  a: number;
  b: number;
  cost: number;
  /** 이음매 자세 차이 (m, 관절 평균) */
  posErr: number;
  /** 이음매 속도 차이 (m/s, 관절 평균 + 루트) */
  velErr: number;
}

export interface FindLoopOptions {
  minLen: number;
  maxLen: number;
  /** 탐색 범위 (프레임). a ≥ from, b ≤ to */
  from?: number;
  to?: number;
  velWeight: number;
  fps: number;
  /** 제자리 루프(rootMotion removed): 두 발과 고관절 중점의 절대 수평 위치 차이도 비용에 넣는다 (드리프트를 빼면 디딘 발이 미끄러지므로) */
  absolute?: boolean;
}

export function findLoop(rig: Rig, frames: BodyFrame[], o: FindLoopOptions): LoopWindow {
  const n = frames.length;
  const F = frames.map((f) => features(rig, f));
  const vel = (t: number): number[] => F[t + 1]!.map((x, i) => (x - F[t]![i]!) * o.fps);
  const rv = (t: number): Vec3 => scale(rootVel(rig, frames[t]!, frames[t + 1]!), o.fps);
  const from = Math.max(0, o.from ?? 0), to = Math.min(n - 2, o.to ?? n - 2);
  const iL = rig.idx('LeftFoot'), iR = rig.idx('RightFoot');
  const abs = frames.map((f) => { const j = rig.jointPositions(f); const m = rig.hipMid(f); return [j[iL]!, j[iR]!, m] as const; });
  const absErr = (a: number, b: number) => abs[a]!.reduce((s, p, k) => s + Math.hypot(p[0] - abs[b]![k]![0], p[2] - abs[b]![k]![2]), 0) / 3;
  let best: LoopWindow | null = null;
  for (let a = from; a <= to - o.minLen; a++) {
    const va = vel(a), ra = rv(a);
    for (let b = a + o.minLen; b <= Math.min(to, a + o.maxLen); b++) {
      const posErr = meanDist3(F[a]!, F[b]!) + Math.abs(F[a]![F[a]!.length - 1]! - F[b]![F[b]!.length - 1]!) + (o.absolute ? absErr(a, b) : 0);
      const velErr = meanDist3(va, vel(b)) + length(sub(ra, rv(b)));
      const cost = posErr + o.velWeight * velErr;
      if (!best || cost < best.cost) best = { a, b, cost, posErr, velErr };
    }
  }
  if (!best) throw new Error(`루프 구간 없음 (프레임 ${n}, 길이 ${o.minLen}~${o.maxLen}, 범위 ${from}~${to})`);
  return best;
}

/**
 * [a, b) 구간을 잘라 이음매를 섞는다. 끝 k프레임(b-k..b-1)을 delta·frame(a-k..a-1)로 smoothstep 가중치로 섞으면
 * 마지막 프레임 다음에 delta·frame(a) (= 다음 바퀴의 0프레임)가 자연스럽게 이어진다. a < k면 k를 줄인다.
 */
export function crossfadeLoop(rig: Rig, frames: BodyFrame[], contacts: Contacts, a: number, b: number, k: number): {
  frames: BodyFrame[]; contacts: Contacts; delta: RootXform;
} {
  const delta = relXform(rig, frames[a]!, frames[b]!);
  const kk = Math.min(k, a, b - a - 1);
  const out = frames.slice(a, b).map((f) => ({ hips: [...f.hips] as Vec3, rot: f.rot.slice() }));
  const L = out.length;
  for (let i = 0; i < kk; i++) {
    const w0 = (i + 1) / kk;
    const w = w0 * w0 * (3 - 2 * w0);
    const t = L - kk + i;
    out[t] = lerpFrame(out[t]!, applyX(delta, frames[a - kk + i]!), w);
  }
  return { frames: out, contacts: contacts.slice(a, b), delta };
}

/** 한 바퀴 이동(delta)을 선형으로 빼서 제자리 루프로 만든다. 회전 중심 = 0프레임 고관절 중점 */
export function removeRootDrift(rig: Rig, frames: BodyFrame[], delta: RootXform): BodyFrame[] {
  const L = frames.length;
  const c = rig.hipMid(frames[0]!);
  const next = rig.hipMid(applyX(delta, frames[0]!));
  const drift: Vec3 = [next[0] - c[0], 0, next[2] - c[2]];
  return frames.map((f, i) => {
    const s = i / L;
    const yaw = -delta.yaw * s;
    const q = yawQ(yaw);
    // p → R(yaw)(p − c) + c − s·drift
    const off = sub(add(c, scale(drift, -s)), rotate(q, c));
    return transformFrame(f, yaw, off);
  });
}

/** 0프레임을 s로 돌린다. 앞부분은 delta만큼 옮겨 뒤에 붙인다 */
export function phaseShift(frames: BodyFrame[], contacts: Contacts, s: number, delta: RootXform): { frames: BodyFrame[]; contacts: Contacts } {
  if (s <= 0) return { frames, contacts };
  return {
    frames: [...frames.slice(s), ...frames.slice(0, s).map((f) => applyX(delta, f))],
    contacts: [...contacts.slice(s), ...contacts.slice(0, s)],
  };
}

/** 루프 안에서 side 발이 처음 땅에 닿는(뒤꿈치 false→true) 프레임. 없으면 0 */
export function heelStrike(contacts: Contacts, side: 'Left' | 'Right'): number {
  const L = contacts.length;
  for (let t = 0; t < L; t++) {
    const prev = contacts[(t - 1 + L) % L]![side].heel, cur = contacts[t]![side].heel;
    if (cur && !prev) return t;
  }
  return 0;
}

/** 정규화 변환 T를 적용했을 때 루트 변환 M의 새 표현 T∘M∘T⁻¹ (yaw끼리는 교환) */
export function conjugateX(m: RootXform, t: RootXform): RootXform {
  const rt = rotate(yawQ(t.yaw), m.pos);
  const rmo = rotate(yawQ(m.yaw), t.pos);
  return { yaw: m.yaw, pos: [rt[0] + t.pos[0] - rmo[0], 0, rt[2] + t.pos[2] - rmo[2]] };
}

export interface SeamMetrics {
  /** 이음매 가속도 (관절 위치 2차 차분, cm/프레임², 관절 평균) */
  seamAccelCm: number;
  /** 루프 안쪽 2차 차분 95백분위 (같은 단위) */
  interiorAccelP95Cm: number;
  interiorAccelMaxCm: number;
}

/** 마지막 프레임 → delta·0프레임 이음매의 매끄러움 */
export function seamMetrics(rig: Rig, frames: BodyFrame[], delta: RootXform): SeamMetrics {
  const L = frames.length;
  const X = frames.map((f) => rig.jointPositions(f));
  const wrap = (t: number): Vec3[] => (t < L ? X[t]! : rig.jointPositions(applyX(delta, frames[t - L]!)));
  const acc = (t: number): number => {
    const a = wrap(t - 1), b = wrap(t), c = wrap(t + 1);
    let s = 0;
    for (let j = 0; j < b.length; j++) s += length(add(sub(c[j]!, scale(b[j]!, 2)), a[j]!));
    return (s / b.length) * 100;
  };
  const inner: number[] = [];
  for (let t = 1; t < L - 2; t++) inner.push(acc(t));
  inner.sort((p, q) => p - q);
  const seam = Math.max(acc(L - 1), acc(L));
  return {
    seamAccelCm: seam,
    interiorAccelP95Cm: inner[Math.floor(inner.length * 0.95)] ?? 0,
    interiorAccelMaxCm: inner[inner.length - 1] ?? 0,
  };
}

