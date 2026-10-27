// v0.1 sim 코어 완료 기준 (SPEC 12장 v0.1): 결정론, 질량, 관절 제한, Δv 충격 단위.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { CharacterState } from '../src/sim/types';
import hitScale from '../config/hitScale.json';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const scenario = (name: string): Scenario => JSON.parse(readFileSync(`scenarios/0.1/${name}.json`, 'utf8')) as Scenario;
const run = (sc: Scenario) => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });

describe('sim core v0.1', () => {
  it('same scenario twice → byte-identical log.jsonl', async () => {
    const sc = { ...scenario('push_front'), duration: 2.0 };
    const a = await run(sc);
    const b = await run(sc);
    expect(a.log.length).toBeGreaterThan(1000);
    expect(b.log).toBe(a.log);
    expect(JSON.stringify(b.summary)).toBe(JSON.stringify(a.summary));
  }, 60_000);

  it('total mass of the built ragdoll is 75 ± 0.1 kg', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0 });
    expect(Math.abs(ch.totalMass() - 75)).toBeLessThan(0.1);
    expect(ch.rd.bodies).toHaveLength(16);
    expect(ch.rd.joints).toHaveLength(15);
    w.free();
  });

  it('rest pose is inside every joint limit and the spawn is at rest', async () => {
    const w = await World.create({ seed: 1, gravity: [0, 0, 0] });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 1, 0], yaw: 0.7 });
    w.step();
    const s = ch.getState();
    for (const j of Object.values(s.joints)) expect(j.violationDeg).toBeLessThan(0.01);
    // 앵커 반올림(1e-5 m)과 경계에 있는 팔꿈치·무릎 제한 때문에 mm/s 수준의 잔여 속도만 허용
    for (const b of Object.values(s.bodies)) expect(Math.hypot(...b.linVel) + Math.hypot(...b.angVel)).toBeLessThan(0.02);
    w.free();
  });

  it('drop_from_height: joint limits respected (p99 violation small), knees and elbows never bend backward', async () => {
    const res = await run(scenario('drop_from_height'));
    expect(res.summary.exploded).toBe(false);
    expect(res.summary.metrics.limitViolationP99Deg).toBeLessThan(5);
    const states = res.log.trim().split('\n').map((l) => JSON.parse(l) as CharacterState);
    let minKneeElbow = Infinity;
    for (const s of states) for (const n of ['LeftLeg', 'RightLeg', 'LeftForeArm', 'RightForeArm'] as const) minKneeElbow = Math.min(minKneeElbow, s.joints[n].coordsDeg[0]);
    expect(minKneeElbow).toBeGreaterThan(-5);
  }, 60_000);

  it('hit: Δv magnitude → COM velocity change ≈ dv right after the hit (gravity off, free floating)', async () => {
    const w = await World.create({ seed: 1, gravity: [0, 0, 0] });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 3, 0], yaw: 0 });
    w.step();
    const v0 = ch.getState().comVel;
    ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, 2], magnitude: 'large' });
    w.step();
    const v1 = ch.getState().comVel;
    const dv = hitScale.large;
    expect(v1[2] - v0[2]).toBeCloseTo(dv, 3);
    expect(Math.abs(v1[0] - v0[0]) + Math.abs(v1[1] - v0[1])).toBeLessThan(1e-3);
    // 지점을 준 경우(바디 중심에서 벗어난 점)도 COM Δv는 같다
    const p = ch.getState().bodies.Head.pos;
    ch.hit({ type: 'bullet', body: 'Head', point: [p[0] + 0.05, p[1], p[2]], direction: [1, 0, 0], magnitude: 0.4 });
    w.step();
    const v2 = ch.getState().comVel;
    expect(v2[0] - v1[0]).toBeCloseTo(0.4, 3);
    expect(w.events.filter((e) => e.type === 'hit')).toHaveLength(2);
    w.free();
  });
});
