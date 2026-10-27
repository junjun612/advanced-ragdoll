// v0.5b 넘어짐 (SPEC 12 v0.5b): 사망 임계값 → Limp, 피해 누적 → 하체 힘 상한, push duration Δv 보존, 넘어짐 확실도, 결정론.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import hitModelCfg from '../config/hitModel.json';
import behaviorsCfg from '../config/behaviors.json';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const scenario = (p: string, duration?: number): Scenario => ({ ...(JSON.parse(readFileSync(p, 'utf8')) as Scenario), ...(duration ? { duration } : {}) });

async function standing() {
  const w = await World.create({ seed: 1 });
  const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { rootAssist: false });
  for (let i = 0; i < 60; i++) w.step();
  return { w, ch };
}

describe('hitModel death rule (v0.5b)', () => {
  it('Δv ≥ deathDv → only Limp, other behaviors stopped', async () => {
    const { w, ch } = await standing();
    const dv = hitModelCfg.deathDv as number;
    ch.hit({ type: 'bullet', body: 'Spine2', direction: [0, 0, -1], magnitude: dv + 0.1 });
    w.step();
    const names = ch.behaviors.list.map((b) => b.name);
    expect(names).toEqual(['Limp']);
    w.free();
  });
  it('below deathDv a bullet does not start Limp', async () => {
    const { w, ch } = await standing();
    ch.hit({ type: 'bullet', body: 'Spine2', direction: [0, 0, -1], magnitude: 0.4 });
    w.step();
    expect(ch.behaviors.list.some((b) => b.name === 'Limp')).toBe(false);
    w.free();
  });
});

describe('damage accumulation (v0.5b)', () => {
  it('each bullet lowers the lower-body cap by Δv × lowerPerDv[region]; below kneelBelow → Kneel (when settled)', async () => {
    const { w, ch } = await standing();
    const per = behaviorsCfg.damage.lowerPerDv.belly;
    for (let k = 1; k <= 3; k++) {
      ch.hit({ type: 'bullet', body: 'Spine', direction: [0, 0, -1], magnitude: 0.3 });
      w.step();
      expect(ch.behaviors.lowerCap).toBeCloseTo(1 - k * 0.3 * per, 6);
    }
    expect(ch.behaviors.lowerCap).toBeLessThan(behaviorsCfg.damage.kneelBelow);
    for (let i = 0; i < 240 && !ch.behaviors.list.some((b) => b.name === 'Kneel'); i++) w.step();
    expect(ch.behaviors.list.some((b) => b.name === 'Kneel')).toBe(true);
    w.free();
  }, 60_000);
});

describe('push duration (v0.5b)', () => {
  it('a push spread over 0.15 s still gives COM Δv = magnitude (no gravity)', async () => {
    const w = await World.create({ seed: 1, gravity: [0, 0, 0] });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 3, 0], yaw: 0 });
    w.step();
    const v0 = ch.getState().comVel;
    ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, 1], magnitude: 1.2, duration: 0.15 });
    w.step();
    expect(ch.getState().comVel[2] - v0[2]).toBeLessThan(0.1);
    for (let i = 0; i < 20; i++) w.step();
    expect(ch.getState().comVel[2] - v0[2]).toBeCloseTo(1.2, 3);
    w.free();
  });
});

describe('fall certainty (v0.5b)', () => {
  it('quiet standing → ~0; large push → brace with predicted hand landing ahead', async () => {
    const { w, ch } = await standing();
    expect(ch.behaviors.state.fall!.certainty).toBeLessThan(0.05);
    ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, 1], magnitude: 'large', duration: 0.15 });
    let maxC = 0;
    for (let i = 0; i < 60; i++) { w.step(); maxC = Math.max(maxC, ch.behaviors.state.fall!.certainty); }
    expect(maxC).toBeGreaterThan(behaviorsCfg.fall.threshold);
    const f = ch.behaviors.state.fall!;
    expect(f.kind).toBe('forward');
    expect(f.hands.LeftHand[2]).toBeGreaterThan(ch.getState().bodies.LeftFoot.pos[2]);
    expect(ch.behaviors.list.some((b) => b.name === 'BraceForFall')).toBe(true);
    w.free();
  }, 60_000);
});

describe('v0.5b determinism', () => {
  for (const p of ['scenarios/0.5b/push_front_large.json', 'scenarios/0.5b/kneel_trigger.json']) {
    it(`${p} twice → byte-identical log`, async () => {
      const sc = scenario(p, 2.5);
      const run = () => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });
      const a = await run(), b = await run();
      expect(b.log).toBe(a.log);
    }, 120_000);
  }
});
