// Item 5: ms per step for 1 and 8 characters (all bodies dynamic, muscles on), Node.
import R from '@dimforge/rapier3d-compat';
import { writeFileSync, mkdirSync } from 'node:fs';
import { v3, qaxis } from './math';
import { makePrng } from './prng';
import { Ragdoll } from './ragdoll';
import { Muscles, resetTorques, aPoseTargets, type Method } from './muscles';

await R.init();
type Cfg = { n: number; muscles: Method | 'none'; dt: number; iters: number };

function bench(c: Cfg) {
  const world = new R.World(v3(0, -9.81, 0));
  world.timestep = c.dt;
  world.numSolverIterations = c.iters;
  world.createCollider(R.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0).setFriction(0.8));
  const rng = makePrng(11);
  const chars: { rd: Ragdoll; mus: Muscles | null }[] = [];
  for (let i = 0; i < c.n; i++) {
    const rd = new Ragdoll(R, world, {
      mode: 'generic', offset: v3((i % 4) * 2 - 3, 0.05, Math.floor(i / 4) * 2), rot: qaxis(v3(0, 1, 0), rng.range(-1, 1)),
    });
    const mus = c.muscles === 'none' ? null : new Muscles(rd, { method: c.muscles, kpScale: 300, gc: true, targets: aPoseTargets(rd), dt: c.dt });
    chars.push({ rd, mus });
  }
  const steps = Math.round(5 / c.dt), warm = Math.round(0.5 / c.dt);
  let tStep = 0, tCtrl = 0;
  const push = Math.round(2 / c.dt);
  for (let f = 0; f < warm + steps; f++) {
    const t0 = performance.now();
    for (const ch of chars) {
      if (f === push) ch.rd.byName.get('Spine2')!.rb.applyImpulse(v3(rng.range(-80, 80), 0, rng.range(-80, 80)), true);
      if (ch.mus) {
        resetTorques(ch.rd);
        ch.mus.apply();
      }
    }
    const t1 = performance.now();
    world.step();
    const t2 = performance.now();
    if (f >= warm) {
      tCtrl += t1 - t0;
      tStep += t2 - t1;
    }
  }
  world.free();
  return { step: tStep / steps, ctrl: tCtrl / steps };
}

const rows: Record<string, unknown>[] = [];
for (const dt of [1 / 120, 1 / 240])
  for (const iters of [4, 8])
    for (const muscles of ['none', 'B', 'C'] as const)
      for (const n of [1, 8]) {
        const reps = [0, 1, 2].map(() => bench({ n, muscles, dt, iters }));
        const med = (k: 'step' | 'ctrl') => reps.map((r) => r[k]).sort((a, b) => a - b)[1]!;
        const step = med('step'), ctrl = med('ctrl');
        const row = {
          dt: dt === 1 / 120 ? '1/120' : '1/240', iters, muscles: muscles === 'none' ? 'passive' : `${muscles}+gc`, chars: n,
          rapierMsPerStep: +step.toFixed(3), ctrlMsPerStep: +ctrl.toFixed(3), totalMsPerStep: +(step + ctrl).toFixed(3),
          msPerSimSecond: +((step + ctrl) / dt).toFixed(1),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
mkdirSync('spike/rapier/out', { recursive: true });
writeFileSync('spike/rapier/out/05-perf.json', JSON.stringify(rows, null, 1));
