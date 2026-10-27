// v0.8b 잡기·벽: 지형 정의(난간대·벽·잡을 모서리), 지형 물체는 지면이 아님, 잡을 곳·벽 탐지, 감지 지연선, 잡기 관절(힘 상한·미끄러짐).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { initRapier, PhysicsWorld } from '../src/sim/world';
import { terrainDef, terrainHeightAt, isFlatTerrain, closestOnSegment } from '../src/sim/terrain';
import { castGround, senseGrab, senseWall, DelayLine } from '../src/sim/character/perception';
import { World } from '../src/sim/api';
import { GrabJoint } from '../src/sim/character/behaviors/grab';
import behaviors from '../config/behaviors.json';
import simCfg from '../config/sim.json';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const gs = behaviors.grabSense;

describe('grab & wall (v0.8b)', () => {
  it('rail/wall terrains keep the flat floor; the ledge has a grabbable front edge', () => {
    for (const n of ['rail', 'wall'] as const) {
      const d = terrainDef(n);
      expect(isFlatTerrain(d)).toBe(true);
      expect(terrainHeightAt(d, 0.42, 0)).toBe(0);
    }
    expect(terrainDef('rail').grabs).toHaveLength(1);
    expect(terrainDef('wall').props.some((p) => p.kind === 'wall')).toBe(true);
    const e = terrainDef('ledge').grabs[0]!;
    expect(e.kind).toBe('edge');
    expect(e.a[1]).toBe(simCfg.terrain.ledge.height);
    expect(closestOnSegment([0, 0, 0], [2, 0, 0], [5, 1, 0])).toEqual([2, 0, 0]);
  });

  it('props are not ground: a downward ray over the rail/wall misses them and hits the floor', async () => {
    await initRapier();
    for (const n of ['rail', 'wall'] as const) {
      const pw = new PhysicsWorld({ terrain: n });
      expect(pw.flat).toBe(true);
      expect(pw.propColliders.length).toBeGreaterThan(0);
      const x = n === 'rail' ? simCfg.terrain.rail.x : 0, z = n === 'rail' ? 0 : simCfg.terrain.wall.z + 0.1;
      expect(castGround(pw, [x, 5, z], 10)!.point[1]).toBeCloseTo(0, 6);
      pw.free();
    }
  });

  it('senses the rail within arm reach and a wall straight ahead; nothing on flat ground', async () => {
    for (const [terrain, wantGrab, wantWall] of [['rail', true, false], ['wall', false, true], ['flat', false, false]] as const) {
      const w = await World.create({ seed: 1, terrain });
      const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { getup: false });
      const g = senseGrab(ch.rd, w.physics, gs, behaviors.Grab.palmLocal as [number, number, number], 0);
      expect(!!g.hands.LeftHand).toBe(wantGrab);
      expect(g.hands.RightHand).toBeUndefined(); // 오른손에서는 난간이 팔 길이 밖
      const wall = senseWall(ch.rd, w.physics, gs, [0, 0, 1], 0);
      expect(!!wall).toBe(wantWall);
      if (wall) { expect(wall.normal[2]).toBeLessThan(-0.9); expect(wall.dist).toBeGreaterThan(0.5); }
      w.free();
    }
  });

  it('delay line returns the value from delay seconds ago', () => {
    const d = new DelayLine<number>(0.08);
    for (let i = 0; i <= 24; i++) d.push(i / 120, i);
    expect(d.get(24 / 120)).toBe(14); // 0.2 − 0.08 = 0.1167 s → 14번째
    expect(new DelayLine<number>(0.1).get(0)).toBeNull();
  });

  it('grab joint holds the hand with a force-limited spring and reports slip/force', async () => {
    const w = await World.create({ seed: 1, terrain: 'flat' });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { getup: false });
    const rb = ch.rd.body('LeftHand').rb, t = rb.translation();
    const anchor: [number, number, number] = [t.x, t.y + 0.1, t.z];
    const j = new GrabJoint(ch.rd, 'LeftHand', [0, 0, 0], anchor, behaviors.Grab.joint);
    for (let i = 0; i < 60; i++) w.step();
    j.measure();
    expect(j.slip).toBeLessThan(0.05);
    expect(j.forceMag).toBeLessThanOrEqual(Math.sqrt(3) * behaviors.Grab.joint.maxForce + 1e-6);
    j.free();
    w.free();
  });
});
