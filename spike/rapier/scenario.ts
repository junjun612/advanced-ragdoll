// Shared seeded "drop + push" scenario (Node and browser). No node imports here.
import type RAPIER from '@dimforge/rapier3d-compat';
import { v3, qaxis, scale } from './math';
import { makePrng } from './prng';
import { Ragdoll, type JointMode } from './ragdoll';
import { Muscles, LimitTorques, resetTorques, aPoseTargets, type Method } from './muscles';

export type ScenarioOpts = {
  mode: JointMode;
  dt?: number;
  iters?: number;
  seed?: number;
  seconds?: number;
  muscles?: Method | null;
  kpScale?: number;
  dropHeight?: number;
  limitAlpha?: number;
  inertiaScale?: (name: string, mass: number) => number;
};

export function makeDropPush(R: typeof RAPIER, o: ScenarioOpts) {
  const dt = o.dt ?? 1 / 120;
  const world = new R.World(v3(0, -9.81, 0));
  world.timestep = dt;
  world.numSolverIterations = o.iters ?? 4;
  world.createCollider(R.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0).setFriction(0.8));
  const rng = makePrng(o.seed ?? 1);
  const axis = v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
  const rd = new Ragdoll(R, world, { mode: o.mode, offset: v3(0, o.dropHeight ?? 1.0, 0), rot: qaxis(axis, rng.range(-0.6, 0.6)), inertiaScale: o.inertiaScale });
  for (const b of rd.bodies) b.rb.setAngvel(v3(rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)), true);
  const dir = () => {
    const a = rng.range(0, 2 * Math.PI);
    return v3(Math.cos(a), rng.range(0, 0.3), Math.sin(a));
  };
  // impulses in N*s
  const pushes = [
    { t: 1.5, body: 'Head', imp: scale(dir(), 60) },
    { t: 2.5, body: 'LeftHand', imp: scale(dir(), 6) },
    { t: 3.0, body: 'RightFoot', imp: scale(dir(), 10) },
    { t: 3.5, body: 'Spine2', imp: scale(dir(), 150) },
  ].map((p) => ({ ...p, frame: Math.round(p.t / dt) }));
  const limiter = o.mode === 'custom' ? new LimitTorques(rd, dt, o.limitAlpha ?? 0.3) : null;
  const muscles = o.muscles
    ? new Muscles(rd, { method: o.muscles, kpScale: o.kpScale ?? 300, gc: true, targets: aPoseTargets(rd), dt })
    : null;
  const frames = Math.round((o.seconds ?? 5) / dt);
  let frame = 0;
  const step = () => {
    for (const p of pushes) if (p.frame === frame) rd.byName.get(p.body)!.rb.applyImpulse(p.imp, true);
    if (limiter || muscles) resetTorques(rd);
    limiter?.apply();
    muscles?.apply();
    world.step();
    frame++;
  };
  return { world, rd, step, frames, dt, pushes };
}
