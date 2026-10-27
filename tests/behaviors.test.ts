// v0.5a 행동 프레임워크·피격 모델 (SPEC 12 v0.5a): Δv 보존, 상처 로컬 저장, 감지 지연·전환 블렌드, 팔 IK, 결정론.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { runScenario } from '../src/sim/runner';
import { forwardKinematics, jointDegToQuat, type JointTargets } from '../src/sim/character/pose';
import { armChain, handRotation, solveArm } from '../src/sim/character/behaviors/kinematics';
import { entryPoint } from '../src/sim/character/hitModel';
import { rotate } from '../src/sim/math/quat';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import behaviorsCfg from '../config/behaviors.json';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;

async function floating() {
  const w = await World.create({ seed: 1, gravity: [0, 0, 0] });
  const ch = w.addCharacter(character, ragdoll, { position: [0, 3, 0], yaw: 0 });
  w.step();
  return { w, ch };
}

describe('hitModel (v0.5a)', () => {
  for (const type of ['bullet', 'melee'] as const) {
    it(`${type}: COM Δv = magnitude (impulse split keeps the total)`, async () => {
      const { w, ch } = await floating();
      const v0 = ch.getState().comVel;
      const p = ch.getState().bodies.Spine2.pos;
      ch.hit({ type, body: 'Spine2', point: [p[0] - 0.08, p[1], p[2] + 0.3], direction: [0, 0, -1], magnitude: 0.5 });
      w.step();
      const v1 = ch.getState().comVel;
      expect(v1[2] - v0[2]).toBeCloseTo(-0.5, 3);
      expect(Math.abs(v1[0] - v0[0]) + Math.abs(v1[1] - v0[1])).toBeLessThan(1e-3);
      w.free();
    });
  }

  it('bullet stores the wound on the hit body surface in body-local coordinates and emits hitReacted', async () => {
    const { w, ch } = await floating();
    const p = ch.getState().bodies.Spine2.pos;
    ch.hit({ type: 'bullet', body: 'Spine2', point: [p[0], p[1], p[2] + 0.5], direction: [0, 0, -1], magnitude: 0.3 });
    w.step();
    const wd = ch.behaviors.wounds[0]!;
    expect(wd.body).toBe('Spine2');
    // 가로 캡슐(반지름 0.105) 앞면: 로컬 z ≈ 반지름, 법선 +Z
    expect(wd.local[2]).toBeCloseTo(0.105, 2);
    expect(wd.normalLocal[2]).toBeGreaterThan(0.99);
    expect(w.events.some((e) => e.type === 'hitReacted' && e.body === 'Spine2')).toBe(true);
    w.free();
  });

  it('entry point: ray through a sphere hits the near surface', () => {
    const e = entryPoint({ type: 'sphere', radius: 0.1 }, { pos: [0, 1, 0], rot: [0, 0, 0, 1] }, [0, 1, 0.5], [0, 0, -1], 1);
    expect(e.local[2]).toBeCloseTo(0.1, 6);
  });
});

describe('behavior blender (v0.5a)', () => {
  it('intentional behavior starts after the sensing delay and blends in over the transition time', async () => {
    const { w, ch } = await floating();
    const p = ch.getState().bodies.Spine2.pos;
    ch.hit({ type: 'bullet', body: 'Spine2', point: [p[0], p[1], p[2] + 0.5], direction: [0, 0, -1], magnitude: 0.3 });
    const weightAt = (name: string) => ch.getState().behaviors.find((b) => b.name === name)?.weight ?? 0;
    const delay = behaviorsCfg.reactionDelay, T = behaviorsCfg.transitionTime;
    w.step();
    expect(weightAt('HitReaction')).toBe(1); // 수동 반응(힘 빠짐)은 즉시
    expect(weightAt('HoldWound')).toBe(0);
    while (w.time < 1 / 120 + delay + T / 2) w.step();
    const mid = weightAt('HoldWound');
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    while (w.time < 1 / 120 + delay + T + 0.02) w.step();
    expect(weightAt('HoldWound')).toBeCloseTo(1, 6);
    w.free();
  });

  it('strength multiplier drops the hit joint (≈0.3) and recovers (hit_bullet_chest)', async () => {
    const sc = { ...(JSON.parse(readFileSync('scenarios/0.5a/hit_bullet_chest.json', 'utf8')) as Scenario), duration: 2.5 };
    const r = await runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });
    const states = r.log.trim().split('\n').map((l) => JSON.parse(l) as { time: number; joints: Record<string, { strength: number }> });
    const s2 = (a: number, b: number) => states.filter((s) => s.time >= a && s.time <= b).map((s) => s.joints.Spine2!.strength);
    expect(Math.min(...s2(1.0, 1.5))).toBeLessThan(0.4);
    expect(Math.min(...s2(2.2, 2.5))).toBeGreaterThan(0.99);
  }, 60_000);
});

describe('arm IK (v0.5a)', () => {
  it('palm reaches the target in forward kinematics (both hands, same and opposite side)', () => {
    const idx = (n: string) => character.bodies.findIndex((b) => b.name === n);
    const st = JSON.parse(readFileSync('config/poses/stand.json', 'utf8')).joints as Record<string, object>;
    const base: JointTargets = {};
    for (const [k, v] of Object.entries(st)) base[k as keyof JointTargets] = jointDegToQuat(v);
    const root = { pos: [0, 1, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number] };
    const fk0 = forwardKinematics(character, base, root);
    const s2 = fk0[idx('Spine2')]!, sp = fk0[idx('Spine')]!;
    for (const hand of ['LeftHand', 'RightHand'] as const) for (const off of [[0, 0, 0.17], [0.15, 0.15, 0.13], [-0.15, 0.1, 0.13]]) {
      const ch = armChain(character, hand);
      const P: [number, number, number] = [sp.pos[0] + off[0]!, sp.pos[1] + off[1]!, sp.pos[2] + off[2]!];
      const q = handRotation(ch, [0, 0, -1], [-ch.side, 0, 0]);
      const sol = solveArm(character, ch, s2.rot, s2.pos, P, q, [0, -0.028, 0], rotate(s2.rot, [0.7 * ch.side, -1, -0.4]));
      const fk = forwardKinematics(character, { ...base, ...sol.targets }, root);
      const h = fk[idx(hand)]!;
      const o = rotate(h.rot, [0, -0.028, 0]);
      expect(Math.hypot(h.pos[0] + o[0] - P[0], h.pos[1] + o[1] - P[1], h.pos[2] + o[2] - P[2])).toBeLessThan(0.04);
    }
  });
});

describe('v0.5a determinism', () => {
  it('shot_chest_stagger_clutch twice → byte-identical log', async () => {
    const sc = { ...(JSON.parse(readFileSync('scenarios/0.5a/shot_chest_stagger_clutch.json', 'utf8')) as Scenario), duration: 2.0 };
    const run = () => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });
    const a = await run(), b = await run();
    expect(b.log).toBe(a.log);
  }, 120_000);
});
