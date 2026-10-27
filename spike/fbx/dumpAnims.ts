import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadFbx, boneMap, strip, CM } from './load';

const xbot = loadFbx('assets/fbx/X Bot.fbx');
const xb = boneMap(xbot);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const files = ['Warrior Idle', 'Unarmed Walk Forward', 'Unarmed Walk Back'];
const out: any[] = [];
for (const f of files) {
  const g = loadFbx(`assets/mixamo_anim/${f}.fbx`);
  const bones = boneMap(g);
  const clip = g.animations.find((a) => a.name === 'mixamo.com')!;
  const byName = new Map(clip.tracks.map((t) => [t.name, t]));
  const qt = byName.get('mixamorigHips.quaternion')!;
  const n = qt.times.length;
  const dts = Array.from(qt.times).slice(1).map((t, i) => t - qt.times[i]!);
  const pt = byName.get('mixamorigHips.position');
  const posTracks = clip.tracks.filter((t) => t.name.endsWith('.position')).map((t) => strip(t.name.split('.')[0]!));
  const trackBones = new Set(clip.tracks.map((t) => strip(t.name.split('.')[0]!)));
  const restSet = [...xb.keys()];
  // 리그 rest 오프셋 비교
  let maxOff = 0, maxRot = 0;
  for (const [nm, b] of bones) { const o = xb.get(nm); if (!o) continue;
    maxOff = Math.max(maxOff, b.position.distanceTo(o.position) * CM); maxRot = Math.max(maxRot, THREE.MathUtils.radToDeg(b.quaternion.angleTo(o.quaternion))); }
  const e: any = { file: `${f}.fbx`, clips: g.animations.map((a) => a.name), duration: r4(clip.duration), keys: n,
    fps: r4((n - 1) / (qt.times[n - 1]! - qt.times[0]!)), dtMinMax: [r4(Math.min(...dts)), r4(Math.max(...dts))],
    tracks: clip.tracks.length, positionTracks: posTracks, scaleTracks: clip.tracks.filter((t) => t.name.endsWith('.scale')).length,
    hasMesh: (() => { let m = false; g.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) m = true; }); return m; })(),
    boneSetEqualsXBot: bones.size === xb.size && restSet.every((k) => bones.has(k)),
    trackBonesMissing: restSet.filter((k) => !trackBones.has(k)),
    restOffsetMaxDiffVsXBot_m: r4(maxOff), restRotMaxDiffVsXBot_deg: r4(maxRot) };
  if (pt) {
    const v = pt.values, k = v.length / 3;
    const P = (i: number) => new THREE.Vector3(v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!).multiplyScalar(CM);
    const a = P(0), b = P(k - 1);
    let ymin = Infinity, ymax = -Infinity, xr = [Infinity, -Infinity], zr = [Infinity, -Infinity];
    for (let i = 0; i < k; i++) { const p = P(i); ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
      xr = [Math.min(xr[0]!, p.x), Math.max(xr[1]!, p.x)]; zr = [Math.min(zr[0]!, p.z), Math.max(zr[1]!, p.z)]; }
    e.hips = { keys: k, first: a.toArray().map(r4), last: b.toArray().map(r4), horizDisp_xz: [r4(b.x - a.x), r4(b.z - a.z)],
      horizDist: r4(Math.hypot(b.x - a.x, b.z - a.z)), avgSpeed_mps: r4(Math.hypot(b.x - a.x, b.z - a.z) / clip.duration),
      xRange: xr.map(r4), zRange: zr.map(r4), yRange: [r4(ymin), r4(ymax)], restHipsY: r4(xb.get('Hips')!.position.y * CM) };
    // Hips 요(yaw) 변화
    const q0 = new THREE.Quaternion().fromArray(qt.values as any, 0), q1 = new THREE.Quaternion().fromArray(qt.values as any, 4 * (n - 1));
    const f0 = new THREE.Vector3(0, 0, 1).applyQuaternion(q0), f1 = new THREE.Vector3(0, 0, 1).applyQuaternion(q1);
    e.hips.yawChange_deg = r4(THREE.MathUtils.radToDeg(Math.atan2(f1.x, f1.z) - Math.atan2(f0.x, f0.z)));
    e.loopPoseGap_deg = r4(Math.max(...clip.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => {
      const m = t.values.length / 4; return THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(t.values as any, 0).angleTo(new THREE.Quaternion().fromArray(t.values as any, 4 * (m - 1)))); })));
  }
  out.push(e);
}
writeFileSync('spike/fbx/out/anims.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
