// v0.2 근육: 중력 보상 식, 저역 통과, 영역 매핑, 목표 포즈 순기구학, 교차상관 지연, 실제 캐릭터에서 보상 토크 부호.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gravityCompTorque, lowPassAlpha, resolveRegion, quatToCoords, type MuscleConfig } from '../src/sim/character/muscles';
import { forwardKinematics, jointDegToQuat, lowestFootY, PoseClip } from '../src/sim/character/pose';
import { POSES } from '../src/sim/character/poseLibrary';
import { crossCorrelationLag } from '../src/sim/metrics/muscleMetrics';
import { World } from '../src/sim/api';
import { fromAxisAngle, angleBetweenQ, fromTo, multiplyQ, rotate } from '../src/sim/math/quat';
import { add, normalize } from '../src/sim/math/vec3';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import musclesJson from '../config/muscles.json';

const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const muscles = musclesJson as unknown as MuscleConfig;
const G: [number, number, number] = [0, -9.81, 0];

describe('gravity compensation τ = (c − p) × (−M·g)', () => {
  it('horizontal lever: 2 kg at 0.5 m along +X needs +Z torque of m·g·d', () => {
    const t = gravityCompTorque([0.5, 1, 0], 2, [0, 1, 0], G);
    expect(t[2]).toBeCloseTo(2 * 9.81 * 0.5, 9);
    expect(Math.abs(t[0]) + Math.abs(t[1])).toBeLessThan(1e-12);
  });
  it('mass directly below the joint needs no torque; lever along −Z gives +X torque', () => {
    expect(gravityCompTorque([0, 0.2, 0], 5, [0, 1, 0], G).every((x) => Math.abs(x) < 1e-12)).toBe(true);
    const t = gravityCompTorque([0, 1, -0.3], 1, [0, 1, 0], G);
    expect(t[0]).toBeCloseTo(-0.3 * 9.81 * -1, 9); // (0,0,−0.3)×(0,9.81,0) = (+2.943, 0, 0)
  });
  it('real character, Hips pinned: arm gravity torque is cancelled → arm holds the stand pose without motor stiffness', async () => {
    // kp 0 (모터 강성 없음), 감쇠·중력 보상만: 보상이 맞으면 팔이 처지지 않는다
    const cfg: MuscleConfig = { ...muscles, kpScale: 0 };
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(def, ragdoll, { position: [0, 0.3, 0], yaw: 0, state: 'Active', pose: 'stand', pin: ['Hips'] }, { muscles: cfg });
    for (let i = 0; i < 120; i++) w.step();
    const s = ch.getState();
    expect(s.joints.LeftArm.errorDeg).toBeLessThan(2);
    expect(s.joints.Spine.errorDeg).toBeLessThan(2);
    w.free();
    // 보상 없이(gravityComp 0, kp 0)는 처진다
    const cfg0: MuscleConfig = { ...cfg, joints: Object.fromEntries(Object.entries(cfg.joints).map(([k, v]) => [k, { ...v, gravityComp: 0 }])) as MuscleConfig['joints'] };
    const w2 = await World.create({ seed: 1 });
    const ch2 = w2.addCharacter(def, ragdoll, { position: [0, 0.3, 0], yaw: 0, state: 'Active', pose: 'stand', pin: ['Hips'] }, { muscles: cfg0 });
    for (let i = 0; i < 120; i++) w2.step();
    expect(ch2.getState().joints.LeftArm.errorDeg).toBeGreaterThan(5);
    w2.free();
  }, 30_000);
});

describe('strength low-pass', () => {
  it('alpha = 1 − exp(−dt/τ): reaches 63.2% after one time constant', () => {
    const dt = 1 / 120, tau = 0.03;
    let s = 1;
    const n = Math.round(tau / dt * 4); // 4τ 근처까지 스텝
    const a = lowPassAlpha(dt, tau);
    let after = NaN;
    for (let i = 1; i <= n; i++) {
      s += (0 - s) * a;
      if (Math.abs(i * dt - tau) < dt / 2 + 1e-12) after = s;
    }
    // τ = 3.6 스텝이라 정확히 τ에 샘플이 없다: 해석해와 비교
    expect(lowPassAlpha(dt, 0)).toBe(1);
    const k = Math.round(tau / dt);
    expect(after).toBeCloseTo(Math.exp(-(k * dt) / tau), 9);
  });
  it('setMuscleScale(all, 0): joint strength follows the 30 ms filter, not a step', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(def, ragdoll, { position: [0, 0.3, 0], yaw: 0, state: 'Active', pose: 'stand', pin: ['Hips'] });
    w.step();
    ch.setMuscleScale('all', 0);
    w.step();
    const s1 = ch.getState().joints.LeftLeg.strength;
    expect(s1).toBeCloseTo(Math.exp(-(1 / 120) / muscles.activationTime), 6);
    for (let i = 0; i < 60; i++) w.step();
    expect(ch.getState().joints.LeftLeg.strength).toBe(0);
    w.free();
  });
  it('recoverTime: scale ramps back to 1 linearly', async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(def, ragdoll, { position: [0, 0.3, 0], yaw: 0, state: 'Active', pose: 'stand', pin: ['Hips'] });
    ch.setMuscleScale('leftArm', 0.2, 1.0);
    for (let i = 0; i < 60; i++) w.step(); // 0.5 s: 명령 0.6, 필터 지연 30 ms
    const s = ch.getState().joints;
    expect(s.LeftArm.strength).toBeGreaterThan(0.5);
    expect(s.LeftArm.strength).toBeLessThan(0.62);
    expect(s.RightArm.strength).toBe(1);
    for (let i = 0; i < 90; i++) w.step();
    expect(ch.getState().joints.LeftForeArm.strength).toBeCloseTo(1, 4);
    w.free();
  });
});

describe('muscle regions', () => {
  const names = Object.keys(muscles.joints);
  it('regions map to the documented joints', () => {
    expect(resolveRegion(muscles.regions, 'leftArm', names)).toEqual(['LeftArm', 'LeftForeArm', 'LeftHand']);
    expect(resolveRegion(muscles.regions, 'neck', names)).toEqual(['Head']);
    expect(resolveRegion(muscles.regions, 'RightFoot', names)).toEqual(['RightFoot']);
    expect(() => resolveRegion(muscles.regions, 'tail', names)).toThrow();
  });
  it('upperBody ∪ lowerBody = all (disjoint), sides partition the limbs, every joint has a muscle entry', () => {
    const r = muscles.regions;
    const all = new Set(r.all);
    expect(all.size).toBe(15);
    expect(new Set(def.bodies.filter((b) => b.joint).map((b) => b.name))).toEqual(all);
    const up = new Set(r.upperBody), low = new Set(r.lowerBody);
    expect([...up].filter((x) => low.has(x))).toEqual([]);
    expect(new Set([...up, ...low])).toEqual(all);
    expect(new Set([...r.torso!, ...r.neck!, ...r.leftArm!, ...r.rightArm!])).toEqual(up);
    expect(new Set([...r.leftLeg!, ...r.rightLeg!])).toEqual(low);
    for (const j of all) expect(muscles.joints[j]).toBeDefined();
  });
  it('kp ratios follow SPEC v0.2 (legs/torso 1.0, neck 0.4, shoulder 0.4, elbow 0.3, wrist/ankle 0.2)', () => {
    const k = (n: keyof MuscleConfig['joints']) => muscles.joints[n].kpRatio;
    expect([k('Spine'), k('Spine2'), k('LeftUpLeg'), k('RightLeg')]).toEqual([1, 1, 1, 1]);
    expect([k('Head'), k('LeftArm'), k('RightArm'), k('LeftForeArm'), k('RightHand'), k('LeftFoot')]).toEqual([0.4, 0.4, 0.4, 0.3, 0.2, 0.2]);
  });
});

describe('target pose', () => {
  it('rest targets reproduce the rest pose (FK)', () => {
    const tf = forwardKinematics(def, {}, { pos: def.bodies[0]!.restPosition, rot: [0, 0, 0, 1] });
    def.bodies.forEach((b, i) => {
      expect(Math.hypot(...tf[i]!.pos.map((x, k) => x - b.restPosition[k]!))).toBeLessThan(2e-4);
      expect(angleBetweenQ(tf[i]!.rot, b.restRotation)).toBeLessThan(1e-4);
    });
    expect(Math.abs(lowestFootY(def, tf))).toBeLessThan(2e-3);
  });
  it('stand pose (leveled like spawn): feet flat, knees bent forward, hands lower than rest', () => {
    // v0.3: stand는 다리를 4° 앞으로 기울인 자세 → 스폰처럼 두 발 위 방향을 월드 위로 돌린 뒤 검사한다 (README 결정 45)
    let tf = forwardKinematics(def, new PoseClip(POSES.stand!, POSES).sample(0), { pos: def.bodies[0]!.restPosition, rot: [0, 0, 0, 1] });
    const idx = (n: string) => def.bodies.findIndex((b) => b.name === n);
    const up = add(rotate(tf[idx('LeftFoot')]!.rot, [0, 1, 0]), rotate(tf[idx('RightFoot')]!.rot, [0, 1, 0]));
    const fix = fromTo(normalize(up), [0, 1, 0]);
    tf = tf.map((t) => ({ pos: rotate(fix, t.pos), rot: multiplyQ(fix, t.rot) }));
    for (const f of ['LeftFoot', 'RightFoot']) expect(angleBetweenQ(tf[idx(f)]!.rot, [0, 0, 0, 1]) * 57.3).toBeLessThan(0.5);
    // 무릎(정강이 위 끝)이 고관절·발목을 잇는 선보다 앞(+Z): 무릎이 앞으로 굽음
    const jp = (n: string) => add(tf[idx(n)]!.pos, rotate(tf[idx(n)]!.rot, def.bodies[idx(n)]!.joint!.anchorInChild));
    const hip = jp('LeftUpLeg'), knee = jp('LeftLeg'), ankle = jp('LeftFoot');
    expect(knee[2]).toBeGreaterThan((hip[2] + ankle[2]) / 2);
    expect(tf[idx('LeftHand')]!.pos[1]).toBeLessThan(rotate(fix, def.bodies[idx('LeftHand')]!.restPosition)[1]);
    expect(Math.abs(tf[idx('LeftHand')]!.pos[0] + tf[idx('RightHand')]!.pos[0])).toBeLessThan(2e-3); // 좌우 대칭
  });
  it('rotation-vector degrees: single axis = that angle; Rapier coords of a single-axis rotation = the angle', () => {
    const q = jointDegToQuat({ flex: 30 });
    expect(angleBetweenQ(q, fromAxisAngle([1, 0, 0], (30 * Math.PI) / 180))).toBeLessThan(1e-12);
    expect((quatToCoords(q)[0] * 180) / Math.PI).toBeCloseTo(30, 9);
  });
  it('looping clip interpolates between keyframes and wraps', () => {
    const c = new PoseClip(POSES.wave!, POSES);
    expect(c.duration).toBeCloseTo(1, 9);
    const a = c.sample(0.25), b = c.sample(1.25);
    expect(angleBetweenQ(a.RightArm!, b.RightArm!)).toBeLessThan(1e-9);
    expect(c.sample(0).LeftArm).toEqual(new PoseClip(POSES.stand!, POSES).sample(0).LeftArm); // base = stand
  });
});

describe('tracking lag (cross-correlation)', () => {
  it('recovers a known delay of a sine', () => {
    const dt = 1 / 120, lagSteps = 7;
    const tgt: number[] = [], act: number[] = [];
    for (let i = 0; i < 600; i++) {
      tgt.push(30 * Math.sin(2 * Math.PI * i * dt));
      act.push(25 * Math.sin(2 * Math.PI * (i - lagSteps) * dt) + 3);
    }
    expect(crossCorrelationLag([{ tgt, act }], 60)).toBe(lagSteps);
  });
});

describe('v0.2 determinism', () => {
  it('strength_drop (muscles + root assist + collapse) twice → byte-identical log', async () => {
    const { runScenario } = await import('../src/sim/runner');
    const sc = { ...JSON.parse(readFileSync('scenarios/0.2/strength_drop.json', 'utf8')), duration: 3.0 };
    const run = () => runScenario({ scenario: sc, character: def, characterConfig: 'config/characters/xbot.json', ragdoll });
    const a = await run(), b = await run();
    expect(a.log.length).toBeGreaterThan(1000);
    expect(b.log).toBe(a.log);
  }, 60_000);
});

describe('Muscles.reconfigure (튜닝 UI)', () => {
  it('same config keeps gains; doubling kpScale doubles kp and scales auto kd by sqrt(2); explicit kd wins', async () => {
    const w = await World.create({ seed: 1 });
    const cfg: MuscleConfig = structuredClone(muscles);
    const ch = w.addCharacter(def, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { muscles: cfg });
    const g0 = ch.muscles.gains();
    ch.muscles.reconfigure(cfg);
    expect(ch.muscles.gains()).toEqual(g0);
    const c2: MuscleConfig = structuredClone(cfg);
    c2.kpScale *= 2;
    c2.joints.Head.kd = 3;
    c2.joints.LeftArm.maxTorque = 42;
    ch.muscles.reconfigure(c2);
    const g1 = new Map(ch.muscles.gains().map((g) => [g.joint, g]));
    for (const g of g0) {
      expect(g1.get(g.joint)!.kp).toBeCloseTo(g.kp * 2, 9);
      if (g.joint !== 'Head') expect(g1.get(g.joint)!.kd).toBeCloseTo(g.kd * Math.SQRT2, 9);
    }
    expect(g1.get('Head')!.kd).toBe(3);
    expect(g1.get('LeftArm')!.maxTorque).toBe(42);
    w.step();
    expect(Number.isFinite(ch.getState().com[1])).toBe(true);
    w.free();
  });
});
