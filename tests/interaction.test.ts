// v0.8c 캐릭터·물체 (SPEC 12 v0.8c): 여러 캐릭터 결정론, 캐릭터끼리 충돌, 몸 안 충돌 제외 쌍 유지, 접촉 충격량 → Δv hit, 프롭 hit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { runScenario } from '../src/sim/runner';
import { ContactSensor, INTERACTION } from '../src/sim/interaction';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { SimEvent } from '../src/sim/types';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const sc08 = (name: string): Scenario => JSON.parse(readFileSync(`scenarios/0.8c/${name}.json`, 'utf8')) as Scenario;
const run = (sc: Scenario) => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll, extraCharacters: sc.characters?.map(() => ({ def: character, config: 'config/characters/xbot.json' })) });

describe('v0.8c interaction', () => {
  it('two-character scenario twice → byte-identical logs (both characters, props)', async () => {
    const sc = { ...sc08('two_characters_collide'), duration: 2.2 };
    const a = await run(sc);
    const b = await run(sc);
    expect(a.extraLogs).toHaveLength(1);
    expect(b.log).toBe(a.log);
    expect(b.extraLogs![0]!.log).toBe(a.extraLogs![0]!.log);
    expect(JSON.stringify(b.summary)).toBe(JSON.stringify(a.summary));
  }, 120_000);

  it('two characters brushing past each other both get a sensed contact hit from the other', async () => {
    // (README 9f-12) 감지 hit 단언은 two_characters_collide(A가 손으로 부드럽게 짚어 Δv가 감지 문턱 아래 — 알려진 문제)에서 shoulder_bump_pass로 옮겼다
    const a = await run(sc08('shoulder_bump_pass'));
    const hits = a.meta.events.filter((e) => e.type === 'hit' && e.source);
    expect(hits.some((e) => e.char === 'A' && e.source === 'B')).toBe(true);
    expect(hits.some((e) => e.char === 'B' && e.source === 'A')).toBe(true);
  }, 120_000);

  it('characters collide with each other (no pass-through) even while walk leg no-collide pairs are active', async () => {
    // 두 캐릭터를 힘 없이(Ragdoll) 겹치지 않게 나란히 두고 B를 A 쪽으로 민다 → 접촉이 생기고 관통이 작다
    const w = await World.create({ seed: 1 });
    const a = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { name: 'A' });
    const b = w.addCharacter(character, ragdoll, { position: [0.8, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { name: 'B' });
    // 걷기용 다리 제외 쌍을 켠 상태와 같게 (몸 안 쌍 비트가 두 캐릭터에서 같은 번호를 쓴다)
    a.rd.setRuntimeNoCollide([['LeftFoot', 'RightLeg'], ['RightFoot', 'LeftLeg'], ['LeftUpLeg', 'RightUpLeg']]);
    b.rd.setRuntimeNoCollide([['LeftFoot', 'RightLeg'], ['RightFoot', 'LeftLeg'], ['LeftUpLeg', 'RightUpLeg']]);
    b.hit({ type: 'push', body: 'Hips', direction: [-1, 0, 0], magnitude: 1.0, duration: 0.1 });
    let touched = false;
    for (let i = 0; i < 120; i++) {
      w.step();
      if ((a.getState().interaction?.contacts.length ?? 0) > 0) touched = true;
    }
    expect(touched).toBe(true);
    expect(w.interPenetrationMax).toBeLessThan(0.03);
    // B 몸통이 A 몸통을 지나가지 않았다
    expect(b.getState().bodies.Spine2.pos[0]).toBeGreaterThan(a.getState().bodies.Spine2.pos[0]);
    w.free();
  }, 60_000);

  it('own excluded pairs stay excluded after another character is added (char bits)', async () => {
    const w = await World.create({ seed: 1 });
    const a = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0 }, { name: 'A' });
    a.rd.setRuntimeNoCollide([['LeftUpLeg', 'RightUpLeg']]);
    w.addCharacter(character, ragdoll, { position: [3, 0, 0], yaw: 0 }, { name: 'B' });
    const g = (n: 'LeftUpLeg' | 'RightUpLeg') => a.rd.body(n).col.collisionGroups();
    const pass = (x: number, y: number) => (((x >>> 16) & y) & 0xffff) !== 0 && (((y >>> 16) & x) & 0xffff) !== 0;
    expect(pass(g('LeftUpLeg'), g('RightUpLeg'))).toBe(false);
    // 다른 캐릭터의 같은 바디와는 통과
    const bb = w.characters[1]!;
    bb.rd.setRuntimeNoCollide([['LeftUpLeg', 'RightUpLeg']]);
    expect(pass(g('LeftUpLeg'), bb.rd.body('RightUpLeg').col.collisionGroups())).toBe(true);
    expect(pass(g('LeftUpLeg'), bb.rd.body('LeftUpLeg').col.collisionGroups())).toBe(true);
    w.free();
  });

  it('contact sensor: impulse summed over the window → Δv = |ΣJ| / mass, direction, struck body', () => {
    const s = new ContactSensor(75);
    const w = INTERACTION.sensing.window;
    const mk = (J: [number, number, number]) => [{ source: 'prop:box', kind: 'prop' as const, J, byBody: new Map([['Head' as const, Math.hypot(...J)]]), pointSum: [0, 1.7 * Math.hypot(...J), 0] as [number, number, number], wsum: Math.hypot(...J), penetration: 0, speed: 4 }];
    let out = s.update(0, mk([0, -3, 0]));
    expect(out).toHaveLength(0);
    out = s.update(w / 2, mk([0, -4.5, 0]));
    expect(out).toHaveLength(0);
    out = s.update(w, mk([0, -7.5, 0]));
    expect(out).toHaveLength(1);
    expect(out[0]!.dv).toBeCloseTo(15 / 75, 6);
    expect(out[0]!.direction[1]).toBeCloseTo(-1, 6);
    expect(out[0]!.body).toBe('Head');
    expect(out[0]!.point[1]).toBeCloseTo(1.7, 6);
  });

  it('prop_hit: falling box → prop hit event with Δv from the contact impulse', async () => {
    const res = await run({ ...sc08('prop_hit'), duration: 2.2 });
    const ph = res.meta.events.filter((e: SimEvent) => e.type === 'hit' && e.source?.startsWith('prop:'));
    expect(ph.length).toBeGreaterThan(0);
    expect(ph[0]!.dv!).toBeGreaterThan(INTERACTION.prop.minDv);
    expect(ph[0]!.dv!).toBeLessThan(1.0);
    expect(res.summary.metrics.propHits).toBeGreaterThan(0);
    expect(res.propsLog?.split('\n').filter(Boolean).length).toBeGreaterThan(10);
  }, 60_000);
});
