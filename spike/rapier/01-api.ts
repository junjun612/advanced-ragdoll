// Item 1: runtime probes of the Rapier API surface we rely on.
import R from '@dimforge/rapier3d-compat';
import { writeFileSync, mkdirSync } from 'node:fs';
import { v3, qaxis, qmul, qconj, axisAngles, qangle, DEG, RAD } from './math';
import { Ragdoll } from './ragdoll';

await R.init();
const out: Record<string, unknown> = { version: R.version() };
const log = (k: string, v: unknown) => {
  out[k] = v;
  console.log(k, JSON.stringify(v));
};

// --- pendulum helper: fixed parent + 1 kg box child, zero gravity
function pendulum(kind: 'sph' | 'rev' | 'generic' | 'mb-sph' | 'mb-rev', g = 0) {
  const world = new R.World(v3(0, g, 0));
  world.timestep = 1 / 120;
  const p = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 1, 0));
  world.createCollider(R.ColliderDesc.ball(0.05), p);
  const c = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setCanSleep(false));
  world.createCollider(R.ColliderDesc.cuboid(0.05, 0.2, 0.05).setTranslation(0, -0.25, 0).setMass(1), c);
  const a1 = v3(), a2 = v3();
  let data: R.JointData;
  if (kind === 'sph' || kind === 'mb-sph') data = R.JointData.spherical(a1, a2);
  else if (kind === 'generic') data = R.JointData.generic(a1, a2, v3(1, 0, 0), R.JointAxesMask.LinX | R.JointAxesMask.LinY | R.JointAxesMask.LinZ);
  else data = R.JointData.revolute(a1, a2, v3(1, 0, 0));
  const j = kind.startsWith('mb') ? world.createMultibodyJoint(data, p, c, true) : world.createImpulseJoint(data, p, c, true);
  return { world, p, c, j };
}
const rel = (p: R.RigidBody, c: R.RigidBody) => qmul(qconj(p.rotation()), c.rotation());

// 1. joint classes produced
{
  const kinds = ['sph', 'rev', 'generic', 'mb-sph', 'mb-rev'] as const;
  log('jointClasses', Object.fromEntries(kinds.map((k) => {
    const { j } = pendulum(k);
    const proto = Object.getPrototypeOf(j);
    return [k, { cls: proto.constructor.name, type: (j as R.ImpulseJoint).type?.(), methods: Object.getOwnPropertyNames(proto) }];
  })));
}

// 2. per-axis limits via raw API on spherical / generic impulse joints; read-back; multibody read-back
for (const k of ['sph', 'generic'] as const) {
  const { world, j } = pendulum(k);
  const raw = world.impulseJoints.raw;
  raw.jointSetLimits(j.handle, R.JointAxis.AngX as never, -0.3, 0.6);
  raw.jointSetLimits(j.handle, R.JointAxis.AngZ as never, -0.2, 0.2);
  log(`limitsReadback_${k}`, {
    AngX: [raw.jointLimitsEnabled(j.handle, R.JointAxis.AngX as never), raw.jointLimitsMin(j.handle, R.JointAxis.AngX as never), raw.jointLimitsMax(j.handle, R.JointAxis.AngX as never)],
    AngY: [raw.jointLimitsEnabled(j.handle, R.JointAxis.AngY as never)],
    AngZ: [raw.jointLimitsEnabled(j.handle, R.JointAxis.AngZ as never), raw.jointLimitsMin(j.handle, R.JointAxis.AngZ as never), raw.jointLimitsMax(j.handle, R.JointAxis.AngZ as never)],
  });
}
for (const k of ['mb-sph', 'mb-rev'] as const) {
  const { world, j } = pendulum(k);
  const raw = world.multibodyJoints.raw;
  log(`multibodyLimitsEnabled_${k}`, [3, 4, 5].map((a) => raw.jointLimitsEnabled(j.handle, a as never)));
}
// JointData.limits only consumed for prismatic? set limits on revolute JointData for multibody and check
{
  const world = new R.World(v3(0, 0, 0));
  const p = world.createRigidBody(R.RigidBodyDesc.fixed());
  const c = world.createRigidBody(R.RigidBodyDesc.dynamic());
  world.createCollider(R.ColliderDesc.ball(0.1), c);
  const d = R.JointData.revolute(v3(), v3(), v3(1, 0, 0));
  d.limitsEnabled = true;
  d.limits = [-0.5, 0.5];
  const j = world.createMultibodyJoint(d, p, c, true);
  log('multibodyRevoluteJointDataLimits', world.multibodyJoints.raw.jointLimitsEnabled(j.handle, 3 as never));
}

// 3. limits actually enforced? spin child with angvel and measure max per-axis angle
for (const k of ['sph', 'generic'] as const) {
  const { world, p, c, j } = pendulum(k);
  const raw = world.impulseJoints.raw;
  raw.jointSetLimits(j.handle, R.JointAxis.AngX as never, -30 * RAD, 30 * RAD);
  raw.jointSetLimits(j.handle, R.JointAxis.AngY as never, -10 * RAD, 10 * RAD);
  raw.jointSetLimits(j.handle, R.JointAxis.AngZ as never, -45 * RAD, 45 * RAD);
  c.setAngvel(v3(6, 3, -8), true);
  const mx = [0, 0, 0];
  for (let i = 0; i < 240; i++) {
    world.step();
    axisAngles(rel(p, c)).forEach((a, ii) => (mx[ii] = Math.max(mx[ii]!, Math.abs(a) * DEG)));
  }
  log(`limitEnforced_${k}_maxAbsDeg(lim 30/10/45)`, mx.map((x) => +x.toFixed(2)));
}

// 4. motor semantics: spherical per-axis position motor, both models
for (const model of [R.MotorModel.AccelerationBased, R.MotorModel.ForceBased]) {
  for (const tgt of [[30, 0, 0], [0, 0, 60], [30, 0, 45], [80, 0, 0]] as const) {
    const { world, p, c, j } = pendulum('sph');
    // JointData.spherical() yields JointType.Generic (6) -> GenericImpulseJoint wrapper without motor
    // methods; the per-axis motor exists only on the raw set.
    const raw = world.impulseJoints.raw;
    [3, 4, 5].forEach((ax, i) => {
      raw.jointConfigureMotorModel(j.handle, ax as never, model as never);
      raw.jointConfigureMotorPosition(j.handle, ax as never, tgt[i]! * RAD, 200, 2 * Math.sqrt(200 * 0.1));
    });
    for (let i = 0; i < 600; i++) world.step();
    const q = rel(p, c);
    log(`sphMotor_${model === 0 ? 'Accel' : 'Force'}_target${tgt.join(',')}`, {
      axisAngles2asin: axisAngles(q).map((a) => +(a * DEG).toFixed(2)),
      totalDeg: +(qangle(q) * DEG).toFixed(2),
    });
  }
}
{
  const { world, p, c, j } = pendulum('rev');
  const rj = j as R.RevoluteImpulseJoint;
  rj.configureMotorModel(R.MotorModel.ForceBased);
  rj.configureMotorPosition(50 * RAD, 50, 5);
  for (let i = 0; i < 600; i++) world.step();
  log('revMotor_target50', +(qangle(rel(p, c)) * DEG).toFixed(2));
}
// motor + limit on the same spherical axis
{
  const { world, p, c, j } = pendulum('sph');
  const raw = world.impulseJoints.raw;
  raw.jointSetLimits(j.handle, 3 as never, -20 * RAD, 20 * RAD);
  raw.jointConfigureMotorModel(j.handle, 3 as never, R.MotorModel.ForceBased as never);
  raw.jointConfigureMotorPosition(j.handle, 3 as never, 60 * RAD, 50, 5);
  for (let i = 0; i < 600; i++) world.step();
  log('sphMotorTarget60_withLimit20', +(axisAngles(rel(p, c))[0] * DEG).toFixed(2));
}

// 5. addTorque persistence across steps
{
  const world = new R.World(v3(0, 0, 0));
  world.timestep = 1 / 120;
  const b = world.createRigidBody(R.RigidBodyDesc.dynamic());
  world.createCollider(R.ColliderDesc.ball(0.1).setMass(1), b);
  b.addTorque(v3(0, 1, 0), true);
  world.step();
  const w1 = b.angvel().y;
  world.step();
  const w2 = b.angvel().y;
  b.resetTorques(true);
  world.step();
  const w3 = b.angvel().y;
  b.applyTorqueImpulse(v3(0, 0.01, 0), true);
  world.step();
  const w4 = b.angvel().y;
  log('addTorquePersistence', { w1, w2, w3_afterReset: w3, w4_afterTorqueImpulse: w4, inertia: b.principalInertia().y });
}

// 6. mass / inertia per body
{
  const world = new R.World(v3(0, -9.81, 0));
  const rd = new Ragdoll(R, world, { mode: 'generic', inertiaScale: (n) => (n.endsWith('Hand') ? 4 : 1) });
  const lh = rd.byName.get('LeftHand')!.rb, rh = rd.byName.get('RightHand')!.rb;
  log('mass', {
    total: +rd.totalMass().toFixed(4),
    perBody: Object.fromEntries(rd.bodies.map((b) => [b.def.name, +b.rb.mass().toFixed(3)])),
    leftHandInertia_x4: lh.principalInertia(),
    rightHandInertia_x1: rh.principalInertia(),
    contactsEnabledDefault: (() => {
      const w2 = new R.World(v3());
      const a = w2.createRigidBody(R.RigidBodyDesc.dynamic()), b = w2.createRigidBody(R.RigidBodyDesc.dynamic());
      return w2.createImpulseJoint(R.JointData.spherical(v3(), v3()), a, b, true).contactsEnabled();
    })(),
  });
  // 7. integration params
  log('integration', {
    dt: world.timestep, numSolverIterations: world.numSolverIterations, numInternalPgsIterations: world.numInternalPgsIterations,
  });
}

// 8. collision groups, contact force events, raycast
{
  const world = new R.World(v3(0, -9.81, 0));
  world.timestep = 1 / 120;
  const ground = world.createCollider(R.ColliderDesc.cuboid(5, 0.1, 5).setTranslation(0, -0.1, 0));
  const eq = new R.EventQueue(true);
  const box = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0));
  world.createCollider(
    R.ColliderDesc.cuboid(0.1, 0.1, 0.1).setMass(2).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS | R.ActiveEvents.COLLISION_EVENTS).setContactForceEventThreshold(0),
    box,
  );
  // ghost box in group 2 that does not collide with group 1 ground... ground default 0xffff_ffff, ghost filter excludes bit 0
  const ghost = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(1, 0.5, 0));
  world.createCollider(R.ColliderDesc.cuboid(0.1, 0.1, 0.1).setCollisionGroups((0x0002 << 16) | 0x0002), ghost);
  ground.setCollisionGroups((0x0001 << 16) | 0xffff);
  let forceEvents = 0, lastForce = 0, collStarts = 0;
  for (let i = 0; i < 240; i++) {
    world.step(eq);
    eq.drainContactForceEvents((e) => {
      forceEvents++;
      lastForce = e.totalForceMagnitude();
    });
    eq.drainCollisionEvents((_a, _b, s) => s && collStarts++);
  }
  const hit = world.castRay(new R.Ray(v3(0, 2, 0), v3(0, -1, 0)), 10, true);
  const hit2 = world.castRay(new R.Ray(v3(0, 2, 0), v3(0, -1, 0)), 10, true, undefined, undefined, undefined, box);
  log('eventsAndQueries', {
    forceEvents, lastForceN: +lastForce.toFixed(3), expectedMg: 2 * 9.81, collStarts,
    ghostY_fellThroughGround: +ghost.translation().y.toFixed(2),
    rayToi: hit?.timeOfImpact, rayHitIsBox: hit?.collider.handle !== ground.handle, rayExcludingBoxToi: hit2?.timeOfImpact,
  });
}
mkdirSync('spike/rapier/out', { recursive: true });
writeFileSync('spike/rapier/out/01-api.json', JSON.stringify(out, null, 1));
