// 앱 시나리오 재생 = 러너 (README 결정 app-1): 앱 SimHost로 시나리오를 돌린 상태를 러너와 같은 로거로 적으면 log.jsonl과 바이트 동일해야 한다.
// 애니 강제 비율 (결정 app-2): 기본 0이면 로그에 흔적이 없고, 1이어도 폭발하지 않는다.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from '../src/sim/runner';
import { FrameLogger } from '../src/sim/logger';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { MuscleConfig } from '../src/sim/character/muscles';
import { SimHost, type AppConfig } from '../src/app/simHost';
import simCfg from '../config/sim.json';
import appCfg from '../config/app.json';

const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const muscles = JSON.parse(readFileSync('config/muscles.json', 'utf8')) as MuscleConfig;
const defs: Record<string, CharacterDef> = Object.fromEntries(readdirSync('config/characters').filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join('config/characters', f), 'utf8')) as CharacterDef]));
const findScenario = (name: string): Scenario => {
  for (const d of readdirSync('scenarios')) for (const f of readdirSync(join('scenarios', d))) {
    const sc = JSON.parse(readFileSync(join('scenarios', d, f), 'utf8')) as Scenario;
    if (sc.name === name) return sc;
  }
  throw new Error(name);
};
const inputs = (sc: Scenario) => ({
  scenario: sc, character: defs[sc.character]!, characterConfig: `config/characters/${sc.character}.json`, ragdoll,
  ...(sc.characters ? { extraCharacters: sc.characters.map((c) => ({ def: defs[c.character ?? sc.character]!, config: `config/characters/${c.character ?? sc.character}.json` })) } : {}),
});

/** 앱 SimHost로 끝까지 돌려 캐릭터마다 러너와 같은 로거로 적는다 */
async function appLogs(sc: Scenario): Promise<string[]> {
  const host = new SimHost(defs, ragdoll, structuredClone(muscles), appCfg as unknown as AppConfig);
  host.scenario = sc;
  await host.reset();
  const every = Math.max(1, Math.round(1 / simCfg.logHz / host.world.dt));
  const loggers = host.chars.map(() => new FrameLogger(every));
  host.chars.forEach((c, i) => loggers[i]!.log(c.ch.getState()));
  let step = 0;
  while (!host.scenarioDone) {
    host.stepOnce();
    step++;
    host.chars.forEach((c, i) => { if (loggers[i]!.isLogStep(step)) loggers[i]!.log(c.ch.getState()); });
  }
  host.world.free();
  return loggers.map((l) => l.text());
}

describe('app playback = runner (decision app-1)', () => {
  for (const [name, dur] of [['two_characters_collide', 2.5], ['prop_hit', 2.0], ['push_left_medium', 2.0], ['rail_grab', 1.5]] as const) {
    it(`${name}: same log bytes for every character`, async () => {
      const sc = { ...findScenario(name), duration: dur };
      const res = await runScenario(inputs(sc));
      const app = await appLogs(sc);
      expect(app[0]).toBe(res.log);
      (res.extraLogs ?? []).forEach((x, i) => expect(app[i + 1]).toBe(x.log));
      expect(app.length).toBe(1 + (res.extraLogs?.length ?? 0));
    }, 180_000);
  }
});

describe('anim override (decision app-2)', () => {
  it('weight 1 pulls toward the reference without exploding; usage is logged only when used', async () => {
    const sc = { ...findScenario('push_left_medium'), duration: 2.5 };
    const host = new SimHost(defs, ragdoll, structuredClone(muscles), appCfg as unknown as AppConfig);
    host.scenario = sc;
    await host.reset();
    expect(host.state().assist.animOverride).toBeUndefined();
    expect(host.state().animOverride).toBeUndefined();
    host.setAnimOverride(1);
    let maxW = 0, maxUse = 0;
    while (!host.scenarioDone) {
      host.stepOnce();
      const s = host.state();
      for (const b of Object.values(s.bodies)) maxW = Math.max(maxW, Math.hypot(...b.angVel));
      maxUse = Math.max(maxUse, s.assist.animOverride ?? 0);
    }
    const s = host.state();
    expect(host.world.events.some((e) => e.type === 'exploded')).toBe(false);
    expect(s.animOverride?.weight).toBe(1);
    expect(maxUse).toBeGreaterThan(0);
    expect(maxW).toBeLessThan(30);
    expect(s.posture).toBe('standing');
    host.world.free();
  }, 120_000);
});
