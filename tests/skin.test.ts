// FBX 스킨 (src/render/skin.ts): 랙돌 rest 상태 → 스켈레톤이 바인드 포즈(팔만 A포즈로 내린 것)로 돌아오는지.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { CharacterStateLite } from '../src/render/stateTypes';
import { FbxSkin, stripMixamoPrefix, type SkinConfig } from '../src/render/skin';

const def = JSON.parse(readFileSync('config/characters/xbot.json', 'utf8')) as CharacterDef;
const cfg = JSON.parse(readFileSync('config/skin.json', 'utf8')) as SkinConfig;
const DEG = Math.PI / 180;
/** 두 회전 사이 각(도). Quaternion.angleTo(acos)는 0° 근처 정밀도가 나빠(1e-6 → 0.1°) atan2로 잰다. */
const angDeg = (a: THREE.Quaternion, b: THREE.Quaternion): number => {
  const d = a.clone().invert().multiply(b);
  return (2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w))) / DEG;
};

const restState = (): CharacterStateLite => ({
  time: 0,
  com: [0, 1, 0],
  bodies: Object.fromEntries(def.bodies.map((b) => [b.name, { pos: b.restPosition, rot: b.restRotation }])),
});

/** 바인드(T포즈) 본 월드 (m) */
function bindPose(skin: FbxSkin): Map<string, { pos: THREE.Vector3; rot: THREE.Quaternion }> {
  const out = new Map<string, { pos: THREE.Vector3; rot: THREE.Quaternion }>();
  skin.root.updateMatrixWorld(true);
  skin.root.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const n = stripMixamoPrefix(o.name);
    if (out.has(n)) return;
    const pos = new THREE.Vector3(), rot = new THREE.Quaternion();
    o.matrixWorld.decompose(pos, rot, new THREE.Vector3());
    out.set(n, { pos, rot });
  });
  return out;
}

let skin: FbxSkin;
let bind: Map<string, { pos: THREE.Vector3; rot: THREE.Quaternion }>;
beforeAll(() => {
  const buf = readFileSync(cfg.fbx);
  skin = new FbxSkin(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, def, cfg);
  bind = bindPose(skin); // applyState 전 = FBX 바인드
}, 120_000);

const isArmChain = (n: string): boolean => /^(Left|Right)(Arm|ForeArm|Hand)/.test(n);

describe('FbxSkin rest pose', () => {
  it('rest state → every bone at its A-pose rest transform (three scene graph)', () => {
    skin.applyState(restState());
    const now = bindPose(skin);
    expect(now.size).toBe(65);
    for (const b of skin.bones) {
      const r = skin.restPose(b.name)!, w = now.get(b.name)!;
      expect(w.pos.distanceTo(r.pos), b.name).toBeLessThan(1e-4);
      expect(angDeg(w.rot, r.rot), b.name).toBeLessThan(0.01);
    }
  });

  it('rest state → torso/legs/head exactly at bind; arms = bind rotated down by armDownDeg about the shoulder', () => {
    skin.applyState(restState());
    const now = bindPose(skin);
    for (const [n, w] of now) {
      const b = bind.get(n)!;
      if (!isArmChain(n)) {
        expect(w.pos.distanceTo(b.pos), n).toBeLessThan(1e-4);
        expect(angDeg(w.rot, b.rot), n).toBeLessThan(0.01);
      } else {
        // 회전 차이 = armDownDeg, 어깨(Arm 본)는 그대로
        expect(Math.abs(angDeg(w.rot, b.rot) - def.restPose.armDownDeg), n).toBeLessThan(0.01);
      }
    }
    for (const s of ['Left', 'Right']) {
      expect(now.get(`${s}Arm`)!.pos.distanceTo(bind.get(`${s}Arm`)!.pos)).toBeLessThan(1e-4);
      // 전완 방향이 수평 아래 60°
      const d = now.get(`${s}Hand`)!.pos.clone().sub(now.get(`${s}ForeArm`)!.pos).normalize();
      expect(Math.asin(-d.y) / DEG).toBeCloseTo(def.restPose.armDownDeg, 1);
    }
  });

  it('rigid translation + yaw of all bodies moves the skeleton rigidly', () => {
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const off = new THREE.Vector3(0.3, -0.2, 1.1);
    const st = restState();
    for (const b of def.bodies) {
      const p = new THREE.Vector3(...b.restPosition).applyQuaternion(rot).add(off);
      const r = rot.clone().multiply(new THREE.Quaternion(...b.restRotation));
      st.bodies[b.name] = { pos: [p.x, p.y, p.z], rot: [r.x, r.y, r.z, r.w] };
    }
    skin.applyState(st);
    const now = bindPose(skin);
    for (const b of skin.bones) {
      const r = skin.restPose(b.name)!;
      const ep = r.pos.clone().applyQuaternion(rot).add(off), er = rot.clone().multiply(r.rot);
      expect(now.get(b.name)!.pos.distanceTo(ep), b.name).toBeLessThan(1e-4);
      expect(angDeg(now.get(b.name)!.rot, er), b.name).toBeLessThan(0.01);
    }
  });
});
