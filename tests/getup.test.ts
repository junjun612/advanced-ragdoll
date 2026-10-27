// v0.7 일어서기: 특징 벡터 yaw 불변·매칭, 루트 관성화, 무작위 쓰러짐 생성기 결정론, 판정 지연·게임 막기, 라이브러리 정합.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/sim/api';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import { matchFeature, poseFeature, rotateFeature, classifyFeature } from '../src/sim/character/getupFeatures';
import { RootBlend } from '../src/sim/character/getup';
import { randomFallScenario } from '../src/sim/getupScenarios';
import { GETUP_LIBRARY } from '../src/sim/character/getupClips.generated';
import { forwardKinematics, type BodyTransform } from '../src/sim/character/pose';
import { fromAxisAngle, multiplyQ, rotate } from '../src/sim/math/quat';
import type { Vec3 } from '../src/sim/math/vec3';
import getupCfg from '../config/getup.json';

const character = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const ragdoll = JSON.parse(readFileSync('config/ragdoll.json', 'utf8')) as RagdollConfig;
const W = { body: 1, axis: 0.5, pinned: 0.15 };

/** rest 자세를 엎드리게(배 아래) 눕힌 몸 */
function lyingPose(prone: boolean, yaw = 0): BodyTransform[] {
  const tilt = fromAxisAngle([1, 0, 0], prone ? Math.PI / 2 : -Math.PI / 2);
  const q = multiplyQ(fromAxisAngle([0, 1, 0], yaw), tilt);
  const tf = forwardKinematics(character, {}, { pos: [0, 0, 0], rot: [0, 0, 0, 1] });
  return tf.map((b) => ({ pos: [...rotate(q, b.pos)].map((x, i) => x + (i === 1 ? 0.13 : 0)) as Vec3, rot: multiplyQ(q, b.rot) }));
}

describe('getup features (v0.7)', () => {
  it('classifies prone / supine', () => {
    expect(classifyFeature(poseFeature(character, lyingPose(true)))).toBe('prone');
    expect(classifyFeature(poseFeature(character, lyingPose(false)))).toBe('supine');
  });
  it('matching is yaw invariant and recovers the yaw', () => {
    const a = poseFeature(character, lyingPose(true, 0.9));
    const c = poseFeature(character, lyingPose(true, -0.4));
    const m = matchFeature(a, c, W);
    expect(m.cost).toBeLessThan(1e-9);
    // R_y(ψ)·a ≈ c  →  ψ = −0.4 − 0.9
    expect(Math.abs(Math.atan2(Math.sin(m.yaw + 1.3), Math.cos(m.yaw + 1.3)))).toBeLessThan(1e-6);
    expect(matchFeature(rotateFeature(a, m.yaw), c, W).yaw).toBeCloseTo(0, 6);
  });
  it('prone vs supine costs more than same posture', () => {
    const p = poseFeature(character, lyingPose(true)), s = poseFeature(character, lyingPose(false));
    expect(matchFeature(p, s, W).cost).toBeGreaterThan(1);
  });
});

describe('root blend (inertialization)', () => {
  it('starts at the actual pose and decays to the clip', () => {
    const rb = new RootBlend();
    const clip = { pos: [0, 0.2, 0] as Vec3, rot: [0, 0, 0, 1] as [number, number, number, number] };
    rb.start(0, 0.3, { pos: [0.1, 0.1, 0], rot: fromAxisAngle([1, 0, 0], 0.4) }, clip);
    const a = rb.apply(0, clip);
    expect(a.pos[0]).toBeCloseTo(0.1, 6);
    expect(a.pos[1]).toBeCloseTo(0.1, 6);
    const b = rb.apply(0.6, clip);
    expect(Math.abs(b.pos[0])).toBeLessThan(1e-3);
  });
});

describe('random fall generator', () => {
  it('is deterministic per seed', () => {
    expect(JSON.stringify(randomFallScenario(1234))).toBe(JSON.stringify(randomFallScenario(1234)));
    expect(JSON.stringify(randomFallScenario(1234))).not.toBe(JSON.stringify(randomFallScenario(1235)));
  });
  it('weights can exclude kinds', () => {
    for (let s = 1; s < 60; s++) expect(randomFallScenario(s, { weights: { death: 0 } }).fallKind).not.toBe('death');
  });
});

describe('getup library', () => {
  it('every entry has its clip and a sane balance time', () => {
    for (const e of GETUP_LIBRARY.entries) {
      const c = GETUP_LIBRARY.clips[e.clip];
      expect(c, e.id).toBeTruthy();
      expect(e.feetTau).toBeLessThanOrEqual(e.balanceTau + 1e-9);
      expect(e.balanceTau).toBeLessThan((c!.frames.length - 1) / c!.fps + 1e-9);
      expect(e.successRate).toBeGreaterThan(0);
    }
  });
});

describe('getup detection', () => {
  it('starts only after lying settled for the delay, and the game can block it', async () => {
    for (const on of [true, false]) {
      const w = await World.create({ seed: 1 });
      const ch = w.addCharacter(character, ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', bodies: lyingPose(false) }, { rootAssist: false, getup: { probe: true } });
      if (!on) ch.setGetup(false);
      let t: number | null = null;
      for (let i = 0; i < 480 && t === null; i++) { w.step(); if (ch.getup.ready) t = ch.getup.ready.t; }
      if (on) {
        expect(t).not.toBeNull();
        expect(t!).toBeGreaterThanOrEqual(getupCfg.detect.delay);
      } else expect(t).toBeNull();
      w.free();
    }
  });
});
