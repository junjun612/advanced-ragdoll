// Item 3: muscle candidates with Hips fixed, holding an A-pose target (start from T-pose rest).
import R from '@dimforge/rapier3d-compat';
import { writeFileSync, mkdirSync } from 'node:fs';
import { v3, qmul, qconj, qangle, DEG } from './math';
import { Ragdoll } from './ragdoll';
import { Muscles, resetTorques, aPoseTargets, type Method } from './muscles';

await R.init();

type Variant = { name: string; method: Method; gc: boolean; kdInertia?: 'subtree' | 'local' };
const VARIANTS: Variant[] = [
  { name: 'A', method: 'A', gc: false },
  { name: 'A+gc', method: 'A', gc: true },
  { name: 'A+gc kdLocal', method: 'A', gc: true, kdInertia: 'local' },
  { name: 'B', method: 'B', gc: false },
  { name: 'B+gc', method: 'B', gc: true },
  { name: 'Bacc+gc', method: 'Bacc', gc: true },
  { name: 'C+gc', method: 'C', gc: true },
];
const KPS = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
const JITTER_W = 0.1; // rad/s threshold
const OSC_LIMIT = 5; // sign changes / s => "oscillating"

export function runHold(o: { v: Variant; kp: number; dt: number; iscale: boolean; seconds?: number; iters?: number; kdInertia?: 'subtree' | 'local'; zeta?: number }) {
  const world = new R.World(v3(0, -9.81, 0));
  world.timestep = o.dt;
  world.numSolverIterations = o.iters ?? 4;
  const rd = new Ragdoll(R, world, {
    mode: 'generic', fixedHips: true, offset: v3(0, 0.3, 0),
    inertiaScale: o.iscale ? (_n, m) => (m < 1.5 ? 3 : 1) : undefined,
  });
  const targets = aPoseTargets(rd);
  const mus = new Muscles(rd, { method: o.v.method, kpScale: o.kp, gc: o.v.gc, targets, dt: o.dt, kdInertia: o.kdInertia ?? o.v.kdInertia, zeta: o.zeta });
  const frames = Math.round((o.seconds ?? 4) / o.dt);
  const jStart = Math.round(2 / o.dt), eStart = frames - Math.round(1 / o.dt);
  const nJ = rd.joints.length;
  const prevW: number[] = new Array(nJ * 3).fill(0);
  const flips: number[] = new Array(nJ).fill(0);
  const errSum: number[] = new Array(nJ).fill(0);
  let diverged = false, t = 0, maxTau = 0, maxViol = 0;
  for (let f = 0; f < frames; f++) {
    const t0 = performance.now();
    resetTorques(rd);
    const lg = { tau: 0 };
    mus.apply(lg);
    world.step();
    t += performance.now() - t0;
    maxTau = Math.max(maxTau, lg.tau);
    for (let k = 0; k < nJ; k++) {
      const j = rd.joints[k]!;
      const w = rd.relW(j);
      const ws = [w.x, w.y, w.z];
      if (!ws.every(Number.isFinite) || Math.hypot(w.x, w.y, w.z) > 200) diverged = true;
      if (f >= jStart) {
        for (let a = 0; a < 3; a++) {
          const p = prevW[k * 3 + a]!, c = ws[a]!;
          if (Math.abs(p) > JITTER_W && Math.abs(c) > JITTER_W && Math.sign(p) !== Math.sign(c)) flips[k]!++;
        }
        maxViol = Math.max(maxViol, rd.violation(j) * DEG);
      }
      for (let a = 0; a < 3; a++) prevW[k * 3 + a] = ws[a]!;
      if (f >= eStart) errSum[k]! += qangle(qmul(qconj(targets[k]!), rd.relQ(j))) * DEG;
    }
    if (diverged) break;
  }
  const jit = flips.map((x) => x / ((frames - jStart) * o.dt));
  const err = errSum.map((x) => x / (frames - eStart));
  let jMax = 0, jName = '', eMax = 0, eName = '';
  jit.forEach((x, k) => { if (x > jMax) { jMax = x; jName = rd.bodies[rd.joints[k]!.child]!.def.name; } });
  err.forEach((x, k) => { if (x > eMax) { eMax = x; eName = rd.bodies[rd.joints[k]!.child]!.def.name; } });
  const res = {
    variant: o.v.name, kp: o.kp, dt: o.dt === 1 / 120 ? '1/120' : '1/240', inertia: o.iscale ? 'x3(<1.5kg)' : 'x1',
    diverged,
    jitterMax: +jMax.toFixed(2), jitterJoint: jName, jitterSum: +jit.reduce((a, b) => a + b, 0).toFixed(1),
    errMeanDeg: +(err.reduce((a, b) => a + b, 0) / nJ).toFixed(2), errMaxDeg: +eMax.toFixed(2), errJoint: eName,
    maxViolDeg: +maxViol.toFixed(2), maxTau: +maxTau.toFixed(1),
    msPerStep: +(t / frames).toFixed(4),
    perJointErr: Object.fromEntries(err.map((x, k) => [rd.bodies[rd.joints[k]!.child]!.def.name, +x.toFixed(2)])),
  };
  world.free();
  return res;
}

if (process.argv[1]?.endsWith('03-muscles.ts')) {
  const rows: ReturnType<typeof runHold>[] = [];
  for (const dt of [1 / 120, 1 / 240])
    for (const iscale of [false, true])
      for (const v of VARIANTS)
        for (const kp of KPS) {
          if (v.method === 'A' && kp > 1600) continue;
          const r = runHold({ v, kp, dt, iscale });
          rows.push(r);
          const { perJointErr: _p, ...short } = r;
          console.log(JSON.stringify(short));
        }
  mkdirSync('spike/rapier/out', { recursive: true });
  writeFileSync('spike/rapier/out/03-muscles.json', JSON.stringify(rows, null, 1));
  // summary: per variant/dt/inertia -> onset kp, best stable error
  const summary: Record<string, unknown>[] = [];
  for (const dt of ['1/120', '1/240'])
    for (const ins of ['x1', 'x3(<1.5kg)'])
      for (const v of VARIANTS) {
        const rs = rows.filter((r) => r.dt === dt && r.inertia === ins && r.variant === v.name);
        const bad = rs.find((r) => r.diverged || r.jitterMax >= OSC_LIMIT);
        const stable = rs.filter((r) => !r.diverged && r.jitterMax < OSC_LIMIT && (!bad || r.kp < bad.kp));
        const best = stable[stable.length - 1];
        const at = (kp: number) => rs.find((r) => r.kp === kp);
        summary.push({
          dt, inertia: ins, variant: v.name,
          onsetKp: bad ? bad.kp : `>${rs[rs.length - 1]?.kp}`, onsetJoint: bad ? (bad.diverged ? 'DIVERGED' : bad.jitterJoint) : '',
          maxStableKp: best?.kp ?? '-', errAtMaxStable: best ? `${best.errMeanDeg}/${best.errMaxDeg}(${best.errJoint})` : '-',
          errAt400: at(400) ? `${at(400)!.errMeanDeg}/${at(400)!.errMaxDeg}` : '-',
          errAt1600: at(1600) ? `${at(1600)!.errMeanDeg}/${at(1600)!.errMaxDeg}` : '-',
          msPerStep: +(rs.reduce((a, r) => a + r.msPerStep, 0) / rs.length).toFixed(4),
        });
      }
  console.table(summary);
  writeFileSync('spike/rapier/out/03-muscles-summary.json', JSON.stringify(summary, null, 1));
}
