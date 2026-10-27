// Item 2: joint-limit options (a) generic per-axis limits, (b) multibody, (c) custom limit torques.
import R from '@dimforge/rapier3d-compat';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DEG } from './math';
import { makeDropPush } from './scenario';
import type { JointMode } from './ragdoll';

await R.init();
type Row = Record<string, string | number>;
const rows: Row[] = [];

for (const dt of [1 / 120, 1 / 240]) {
  for (const iters of [4, 8]) {
    for (const variant of ['nolimits', 'generic', 'genericJD', 'generic+I3', 'multibody', 'custom'] as const) {
      const mode = variant.split('+')[0] as JointMode;
      const inertiaScale = variant.endsWith('+I3') ? (_n: string, m: number) => (m < 1.5 ? 3 : 1) : undefined;
      const seeds = [1, 2, 3];
      let maxV = 0, maxVJoint = '', sumV = 0, n = 0, over5 = 0, maxAnchor = 0, maxSpeed = 0, maxW = 0, ms = 0, nan = false;
      const perJointMax: Record<string, number> = {};
      const all: number[] = [];
      for (const seed of seeds) {
        const sc = makeDropPush(R, { mode, dt, iters, seed, inertiaScale });
        const t0 = performance.now();
        for (let f = 0; f < sc.frames; f++) {
          sc.step();
          for (const j of sc.rd.joints) {
            const v = sc.rd.violation(j) * DEG;
            if (!Number.isFinite(v)) nan = true;
            const nm = sc.rd.bodies[j.child]!.def.name;
            perJointMax[nm] = Math.max(perJointMax[nm] ?? 0, v);
            if (v > maxV) { maxV = v; maxVJoint = nm; }
            sumV += v; n++; all.push(v);
            if (v > 5) over5++;
            maxAnchor = Math.max(maxAnchor, sc.rd.anchorErr(j));
          }
          for (const b of sc.rd.bodies) {
            const lv = b.rb.linvel();
            maxSpeed = Math.max(maxSpeed, Math.hypot(lv.x, lv.y, lv.z));
            const av = b.rb.angvel();
            maxW = Math.max(maxW, Math.hypot(av.x, av.y, av.z));
          }
        }
        ms += (performance.now() - t0) / sc.frames;
        sc.world.free();
      }
      const row: Row = {
        dt: dt === 1 / 120 ? '1/120' : '1/240', iters, mode: variant,
        maxViolDeg: +maxV.toFixed(2), maxViolJoint: maxVJoint,
        p99ViolDeg: +all.sort((a, b) => a - b)[Math.floor(all.length * 0.99)]!.toFixed(2),
        p999ViolDeg: +all[Math.floor(all.length * 0.999)]!.toFixed(2),
        meanViolDeg: +(sumV / n).toFixed(3),
        pctFramesOver5deg: +((100 * over5) / n).toFixed(3),
        maxAnchorErrMm: +(maxAnchor * 1000).toFixed(2),
        maxBodySpeed: +maxSpeed.toFixed(2),
        maxAngVel: +maxW.toFixed(1),
        msPerStep: +(ms / seeds.length).toFixed(3),
        nan: nan ? 'YES' : 'no',
      };
      rows.push({ ...row, perJointMax: JSON.stringify(Object.fromEntries(Object.entries(perJointMax).map(([k, v]) => [k, +v.toFixed(1)]))) });
      console.log(JSON.stringify(row));
    }
  }
}
mkdirSync('spike/rapier/out', { recursive: true });
writeFileSync('spike/rapier/out/02-limits.json', JSON.stringify(rows, null, 1));
