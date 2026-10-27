// 무작위 쓰러짐 시나리오 (v0.7): 겟업 라이브러리 수집(tools/kimodo/buildGetupLibrary.ts)과 getup_random_x20이 같은 생성기를 쓴다.
// 시드 하나 → 쓰러지는 사건 하나(밀기·골반 밀기·폭발·배 총탄 3발·걷다가 밀림·사망). 방향은 스폰 yaw를 무작위로 돌려 정한다.
// 무작위성은 시드 PRNG만 쓴다 (결정론).
import { Prng } from './prng';
import type { Scenario, ScenarioEvent } from './scenario';
import type { Vec3 } from './math/vec3';

export type FallKind = 'push' | 'pushHips' | 'explosion' | 'shots' | 'walkPush' | 'death';
export const FALL_KINDS: FallKind[] = ['push', 'pushHips', 'explosion', 'shots', 'walkPush', 'death'];
/** 기본 비율 (라이브러리 수집) */
export const FALL_WEIGHTS: Record<FallKind, number> = { push: 0.4, pushHips: 0.1, explosion: 0.15, shots: 0.1, walkPush: 0.17, death: 0.08 };

const rotY = (v: Readonly<Vec3>, a: number): Vec3 => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];

/**
 * 시드 → 쓰러짐 시나리오. kinds·weights로 고를 종류를 좁힌다(getup_random_x20은 사망 제외: 죽은 사람은 일어서지 않는다).
 * 넘어지지 않을 수도 있다(호출자가 넘어진 것만 쓴다).
 */
export function randomFallScenario(seed: number, o: { weights?: Partial<Record<FallKind, number>>; duration?: number; milestone?: string; name?: string; pushRange?: [number, number] } = {}): Scenario & { fallKind: FallKind } {
  const rng = new Prng(seed * 7919 + 101);
  const w = { ...FALL_WEIGHTS, ...(o.weights ?? {}) };
  const total = FALL_KINDS.reduce((a, k) => a + (w[k] ?? 0), 0);
  let x = rng.float() * total;
  let kind: FallKind = 'push';
  for (const k of FALL_KINDS) { x -= w[k] ?? 0; if (x <= 0) { kind = k; break; } }
  const yaw = (rng.float() * 2 - 1) * Math.PI;
  const u = (a: number, b: number) => a + (b - a) * rng.float();
  const t0 = u(0.8, 1.2);
  const events: ScenarioEvent[] = [];
  let spawn: Scenario['spawn'] = { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' };
  let clip: string | null = 'stand';
  const dirAt = (a: number): Vec3 => [Math.sin(a), 0, Math.cos(a)];
  if (kind === 'push' || kind === 'pushHips') {
    const a = rng.float() * 2 * Math.PI;
    events.push({ t: t0, type: 'hit', hit: { type: 'push', body: kind === 'push' ? 'Spine2' : 'Hips', direction: dirAt(a), magnitude: Math.round(u(...(o.pushRange ?? [1.3, 2.2])) * 100) / 100, duration: 0.15 } });
  } else if (kind === 'explosion') {
    const a = rng.float() * 2 * Math.PI, d = u(1.2, 2.0);
    const p = dirAt(a);
    events.push({ t: t0, type: 'hit', hit: { type: 'explosion', point: [p[0] * d, 0.1, p[2] * d], direction: [0, 0, 0], magnitude: Math.round(u(6, 9) * 10) / 10 } });
  } else if (kind === 'shots') {
    // 배 총탄 3발 (shot_belly_clutch_kneel과 같은 점, 몸 앞에서 뒤로) — 스폰 yaw로 방향을 돌린다
    spawn = { ...spawn, yaw };
    const pts: Vec3[] = [[-0.06, 1.18, 0.4], [-0.03, 1.16, 0.4], [-0.08, 1.2, 0.4]];
    pts.forEach((p, i) => events.push({ t: t0 + 0.5 * i, type: 'hit', hit: { type: 'bullet', body: 'Spine', point: rotY(p, yaw), direction: rotY([0, 0, -1], yaw), magnitude: Math.round(u(0.3, 0.4) * 100) / 100 } }));
  } else if (kind === 'walkPush') {
    spawn = { position: [0, 0, 0], yaw, state: 'Animated', pose: 'kimodo_walk_forward' };
    clip = null;
    events.push({ t: 0.3, type: 'setState', state: 'Active' });
    const a = yaw + (rng.float() * 2 - 1) * Math.PI;
    events.push({ t: u(1.5, 2.5), type: 'hit', hit: { type: 'push', body: 'Spine2', direction: dirAt(a), magnitude: Math.round(u(1.0, 1.8) * 100) / 100, duration: 0.15 } });
  } else {
    spawn = { ...spawn, yaw };
    events.push({ t: t0, type: 'trigger', behavior: 'Limp', params: { cause: 'death' } });
  }
  events.sort((a, b) => a.t - b.t);
  return {
    name: o.name ?? `fall_${seed}`, milestone: o.milestone ?? '0.7', duration: o.duration ?? 8, seed, terrain: 'flat', character: 'xbot',
    spawn, clip, assist: { root: false }, events, cameras: ['side', 'front'], expect: {}, fallKind: kind,
    description: `무작위 쓰러짐 시드 ${seed}: ${kind}`,
  };
}
