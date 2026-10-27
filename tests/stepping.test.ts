// v0.4 스텝 계층: 결정론, 스윙 다리 IK, 착지 계획(앞 밀림 → 앞으로, 보폭 제한), 스텝 수 세기·착지 기록, LiftFoot 셋업.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { CharacterState } from '../src/sim/types';
import { forwardKinematics } from '../src/sim/character/pose';
import { rotate, multiplyQ, conjugate } from '../src/sim/math/quat';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const scenario = (name: string): Scenario => JSON.parse(readFileSync(`scenarios/0.4/${name}.json`, 'utf8')) as Scenario;
const run = (sc: Scenario) => runScenario({ scenario: sc, character, characterConfig: 'config/characters/xbot.json', ragdoll });

describe('stepping v0.4', () => {
  it('push_front_medium is deterministic (byte-identical log, same step events)', async () => {
    const sc = { ...scenario('push_front_medium'), duration: 2.0 };
    const a = await run(sc);
    const b = await run(sc);
    expect(a.log.length).toBeGreaterThan(1000);
    expect(b.log).toBe(a.log);
    expect(JSON.stringify(b.meta.events)).toBe(JSON.stringify(a.meta.events));
  }, 120_000);

  it('a medium forward push triggers a forward step that lands near its target', async () => {
    const r = await run({ ...scenario('push_front_medium'), duration: 2.0 });
    const steps = r.meta.events.filter((e) => e.type === 'step');
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(r.summary.stepsTaken).toBe(steps.length);
    const states = r.log.trim().split('\n').map((l) => JSON.parse(l) as CharacterState);
    const first = states.find((s) => s.time > steps[0]!.t - 1e-6)!;
    const land = first.stepping.landings[0]!;
    expect(land.p[1]).toBeGreaterThan(0.3); // 앞(+Z)으로 30cm 넘게
    expect(land.error).toBeLessThan(0.05);
    expect(r.summary.fell).toBe(false);
  }, 120_000);

  it('no step for a light push (balance alone), steps for small/medium only after the sensing delay', async () => {
    const light = await run({ ...(JSON.parse(readFileSync('scenarios/0.3/push_front_light.json', 'utf8')) as Scenario), stepping: true, duration: 3 });
    expect(light.summary.stepsTaken).toBe(0);
    const med = await run({ ...scenario('push_front_medium'), duration: 1.6 });
    const start = med.meta.events.find((e) => e.type === 'stepStart')!;
    // 감지 지연(0.08초) 전에는 내딛지 않는다 (지연 버퍼 샘플 시각이 스텝 끝 기준이라 한 프레임 1/120초 여유)
    expect(start.t - 1.0).toBeGreaterThanOrEqual(0.08 - 1 / 120 - 1e-6);
  }, 120_000);

  it('swing-leg IK: forward kinematics of the IK targets puts the foot at the requested point', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { stepping: true });
    const st = ch.stepping;
    const foot = st.rd.body('RightFoot').rb.translation();
    const fq = st.rd.body('RightFoot').rb.rotation();
    const footRot: [number, number, number, number] = [fq.x, fq.y, fq.z, fq.w];
    const goal: [number, number, number] = [foot.x, foot.y + 0.08, foot.z + 0.15];
    const tg = st.legIK('RightFoot', goal, footRot, [0, 0, 0, 1]);
    // 루트(Hips)는 지금 자세 그대로: FK는 Hips 월드 회전 = root.rot · restRotation
    const hips = st.rd.body('Hips').rb;
    const ht = hips.translation(), hq = hips.rotation();
    const hipsDef = character.bodies.find((b) => b.name === 'Hips')!;
    const rootRot = multiplyQ([hq.x, hq.y, hq.z, hq.w], conjugate(hipsDef.restRotation as [number, number, number, number]));
    const fk = forwardKinematics(character, { ...tg }, { pos: [ht.x, ht.y, ht.z], rot: rootRot });
    const i = character.bodies.findIndex((b) => b.name === 'RightFoot');
    const p = fk[i]!.pos;
    expect(Math.hypot(p[0] - goal[0], p[1] - goal[1], p[2] - goal[2])).toBeLessThan(0.03);
    // 발 방향도 요청대로 (발 위축 일치)
    const up = rotate(fk[i]!.rot, [0, 1, 0]), upGoal = rotate(footRot, [0, 1, 0]);
    expect(up[0] * upGoal[0] + up[1] * upGoal[1] + up[2] * upGoal[2]).toBeGreaterThan(0.99);
    w.free();
  });

  it('LiftFoot lifts the requested foot and keeps balance on the other', async () => {
    const sc: Scenario = { ...scenario('push_left_crossstep'), events: [{ t: 0.3, type: 'trigger', behavior: 'LiftFoot', params: { foot: 'RightFoot', height: 0.1, duration: 3 } }], duration: 2.0 };
    const r = await run(sc);
    const states = r.log.trim().split('\n').map((l) => JSON.parse(l) as CharacterState);
    const last = states[states.length - 1]!;
    expect(last.stepping.state).toBe('lift');
    expect(last.bodies.RightFoot.pos[1] - last.bodies.LeftFoot.pos[1]).toBeGreaterThan(0.05);
    expect(r.summary.fell).toBe(false);
    expect(last.contacts.some((c) => c.body === 'RightFoot')).toBe(false);
  }, 120_000);
});
