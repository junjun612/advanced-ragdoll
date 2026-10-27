// 애니 클립에서 어깨 스윙각(T-포즈 rest 방향 기준, Spine2 좌표계), 팔꿈치 굽힘, 팔과 몸통 축 사이 거리를 잰다.
// SPEC 6.3 어깨 콘 100도와 6.2 팔-몸통 자기 충돌이 애니 자세와 맞는지 확인용.
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadFbx, boneMap, CM } from './load';

const r2 = (x: number) => Math.round(x * 100) / 100;
const out: Record<string, unknown> = {};
for (const f of ['Warrior Idle', 'Unarmed Walk Forward', 'Unarmed Walk Back']) {
  const g = loadFbx(`assets/mixamo_anim/${f}.fbx`);
  const b = boneMap(g);
  const clip = g.animations.find((a) => a.name === 'mixamo.com')!;
  // rest 상태에서 Spine2 좌표계의 상완 방향
  const restDir: Record<string, THREE.Vector3> = {};
  const dirIn = (s: string) => {
    const a = new THREE.Vector3().setFromMatrixPosition(b.get(s + 'Arm')!.matrixWorld);
    const e = new THREE.Vector3().setFromMatrixPosition(b.get(s + 'ForeArm')!.matrixWorld);
    const q = new THREE.Quaternion(); b.get('Spine2')!.getWorldQuaternion(q);
    return e.sub(a).normalize().applyQuaternion(q.invert());
  };
  for (const s of ['Left', 'Right']) restDir[s] = dirIn(s);
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(clip).play();
  const st: Record<string, { swingMax: number; elbowMin: number; elbowMax: number; armTorsoMin: number }> = {};
  const n = Math.round(clip.duration * 30);
  for (let i = 0; i <= n; i++) {
    mixer.setTime(Math.min(i / 30, clip.duration - 1e-4));
    g.updateMatrixWorld(true);
    const hipsQ = new THREE.Quaternion(); b.get('Hips')!.getWorldQuaternion(hipsQ);
    const hipsP = new THREE.Vector3().setFromMatrixPosition(b.get('Hips')!.matrixWorld);
    for (const s of ['Left', 'Right']) {
      const e = (st[s] ??= { swingMax: 0, elbowMin: 999, elbowMax: 0, armTorsoMin: 9 });
      e.swingMax = Math.max(e.swingMax, THREE.MathUtils.radToDeg(dirIn(s).angleTo(restDir[s]!)));
      const P = (n2: string) => new THREE.Vector3().setFromMatrixPosition(b.get(s + n2)!.matrixWorld);
      const u = P('ForeArm').sub(P('Arm')), v = P('Hand').sub(P('ForeArm'));
      const flex = THREE.MathUtils.radToDeg(u.angleTo(v));
      e.elbowMin = Math.min(e.elbowMin, flex); e.elbowMax = Math.max(e.elbowMax, flex);
      // 팔꿈치·손목의 Hips 좌표계 수평 거리 (몸통 세로축까지), Hips 높이 근처(±0.2m)일 때만
      for (const k of ['ForeArm', 'Hand']) {
        const p = P(k).sub(hipsP).applyQuaternion(hipsQ.clone().invert()).multiplyScalar(CM);
        if (Math.abs(p.y) < 0.2) e.armTorsoMin = Math.min(e.armTorsoMin, Math.hypot(p.x, p.z));
      }
    }
  }
  out[f] = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { swingMax_deg: r2(v.swingMax), elbowFlex_deg: [r2(v.elbowMin), r2(v.elbowMax)], elbowOrWristToHipsAxisMin_m: r2(v.armTorsoMin) }]));
}
writeFileSync('spike/fbx/out/anim_arm_stats.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
