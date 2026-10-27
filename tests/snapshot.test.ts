// v0.9 직렬화 (SPEC 12 v0.9, docs/API.md 6장, README 결정 9a-2). 시나리오 이어 돌리기 검사 절반은 snapshotScenes.test.ts.
// 덮는 기능: 스텝·반응 클립(v0.4), 행동·상처(v0.5a), 무릎 꿇기(v0.5b), 공중·구르기(v0.5c), 걷기 추종·핀(v0.6) + World.save/load 직접 사용.
import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/api';
import { staticFingerprint, type WorldSnapshot } from '../src/sim/snapshot';
import { runScenario } from '../src/sim/runner';
import { findScenario, loadInputs, loadScenario } from '../tools/simCommon';
import { resumeCase } from './snapshotCases';

describe('serialization (v0.9) — scenarios 1/2', () => {
  resumeCase('push_front_medium', [0.12, 0.33, 0.6]);
  resumeCase('hit_bullet_chest', [0.15, 0.4]);
  resumeCase('shot_belly_clutch_kneel', [0.25, 0.55]);
  resumeCase('explosion_near', [0.08, 0.3]);
  resumeCase('walk_push_side', [0.2, 0.45]);
});

describe('serialization (v0.9) — API', () => {
  it('simulation does not modify static data (clip libraries, config modules)', async () => {
    const before = staticFingerprint(true);
    await runScenario(loadInputs(loadScenario(findScenario('push_front_medium'))));
    expect(staticFingerprint(true)).toEqual(before);
  }, 120_000);

  it('World.save / World.load: a loaded world keeps running identically', async () => {
    const sc = loadScenario(findScenario('hit_bullet_chest'));
    const inp = loadInputs(sc);
    const a = await World.create({ seed: sc.seed });
    const ch = a.addCharacter(inp.character, inp.ragdoll, sc.spawn, {});
    if (sc.clip) ch.playClip(sc.clip);
    for (let i = 0; i < 60; i++) a.step();
    ch.hit({ type: 'bullet', body: 'Spine2', direction: [0, 0, -1], magnitude: 'small' });
    for (let i = 0; i < 30; i++) a.step();
    const snap = JSON.parse(JSON.stringify(a.save())) as WorldSnapshot;
    expect(snap.steps).toBe(90);
    const b = await World.load(snap);
    expect(b.time).toBe(a.time);
    expect(b.characters).toHaveLength(1);
    for (let i = 0; i < 240; i++) {
      a.step();
      b.step();
    }
    expect(JSON.stringify(b.characters[0]!.getState())).toBe(JSON.stringify(a.characters[0]!.getState()));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    a.free();
    b.free();
  }, 120_000);

  it('rejects snapshots from another format version or build', async () => {
    const w = await World.create({ seed: 1 });
    const s = w.save();
    await expect(World.load({ ...s, version: 999 })).rejects.toThrow(/version/);
    await expect(World.load({ ...s, statics: { count: 1, hash: 'x' } })).rejects.toThrow(/static data/);
    w.free();
  });
});
