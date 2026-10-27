// v0.5c 공중·바닥 (SPEC 12 v0.5c): 폭발 Δv 정의(1m 기준, 거리 반비례), 공중 감지(고정 장치는 공중 아님), 시드 노이즈 결정론.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { Prng } from '../src/sim/prng';
import { SmoothNoise } from '../src/sim/character/behaviors/noise';
import { resolveHit } from '../src/sim/character/hitModel';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { Vec3 } from '../src/sim/math/vec3';
import hitModelCfg from '../config/hitModel.json';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;

async function standing() {
  const w = await World.create({ seed: 1 });
  const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { rootAssist: false });
  for (let i = 0; i < 60; i++) w.step();
  return { w, ch };
}

describe('explosion hit (v0.5c, SPEC 7.2)', () => {
  it('COM Δv = magnitude × refDist / distance (blast center → COM)', async () => {
    for (const center of [[0, 0.1, 1.5], [0, 1.0, 3.0]] as Vec3[]) {
      const { w, ch } = await standing();
      const s0 = ch.getState();
      const d = Math.hypot(s0.com[0] - center[0], s0.com[1] - center[1], s0.com[2] - center[2]);
      // 충격량 합 / 총질량 = 전신 COM Δv (접촉·중력이 섞이기 전, hitModel 결과로 본다)
      const r = resolveHit({ type: 'explosion', point: center, direction: [0, 0, 0] }, 6, ch.rd, ch.def.totalMass, ch.hitModel);
      const J = r.impulses.reduce((acc, im) => [acc[0] + im.J[0], acc[1] + im.J[1], acc[2] + im.J[2]] as Vec3, [0, 0, 0] as Vec3);
      expect(Math.hypot(...J) / ch.rd.totalMass()).toBeCloseTo((6 * hitModelCfg.explosion.refDist) / d, 4);
      expect(r.dv).toBeCloseTo((6 * hitModelCfg.explosion.refDist) / d, 4);
      ch.hit({ type: 'explosion', point: center, direction: [0, 0, 0], magnitude: 6 });
      w.step();
      const e = w.events.find((x) => x.type === 'hit')!;
      expect(e.detail).toBe('explosion');
      w.free();
    }
  });
  it('ground blast in front throws the body backward and up', async () => {
    const { w, ch } = await standing();
    ch.hit({ type: 'explosion', point: [0, 0.1, 1.5], direction: [0, 0, 0], magnitude: 8 });
    w.step();
    const v = ch.getState().comVel;
    expect(v[2]).toBeLessThan(-2);
    expect(v[1]).toBeGreaterThan(1);
    w.free();
  });
});

describe('air monitor (v0.5c)', () => {
  it('a pinned body is never airborne (no free fall)', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 0.5, 0], yaw: 0, state: 'Active', pose: 'stand', pin: ['Hips'] }, { rootAssist: false });
    for (let i = 0; i < 120; i++) w.step();
    expect(ch.behaviors.air.signal.airborne).toBe(false);
    expect(ch.behaviors.list.some((b) => b.name === 'Flail' || b.name === 'PrepareLanding')).toBe(false);
    w.free();
  });
  it('dropping from 1 m: airborne, predicted touchdown ≈ free-fall time, PrepareLanding without Flail', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 1.0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { rootAssist: false });
    for (let i = 0; i < 12; i++) w.step();
    const a = ch.behaviors.air.signal;
    expect(a.airborne).toBe(true);
    // 남은 낙하: 1m 중 0.1초 동안 약 5cm → √(2·0.95/g) − 0.1 ≈ 0.34초
    expect(a.timeToGround!).toBeGreaterThan(0.3);
    expect(a.timeToGround!).toBeLessThan(0.4);
    for (let i = 0; i < 30; i++) w.step();
    const names = ch.behaviors.list.map((b) => b.name);
    expect(names).toContain('PrepareLanding');
    expect(names).not.toContain('Flail');
    w.free();
  });
});

describe('smooth noise (v0.5c)', () => {
  it('same seed and channel → same values; channels differ; bounded', () => {
    const a = new SmoothNoise(new Prng(7), [0.6, 1.3]), b = new SmoothNoise(new Prng(7), [0.6, 1.3]);
    b.at('Other', 0.3); // 채널을 부르는 순서와 무관
    let diff = 0;
    for (let t = 0; t < 3; t += 0.05) {
      expect(a.at('LeftArmF', t)).toBe(b.at('LeftArmF', t));
      expect(Math.abs(a.at('LeftArmF', t))).toBeLessThanOrEqual(1);
      diff += Math.abs(a.at('LeftArmF', t) - a.at('RightArmF', t));
    }
    expect(diff).toBeGreaterThan(1);
  });
});
