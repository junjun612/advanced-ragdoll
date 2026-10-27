// 16-body spike humanoid (~1.8 m, 75 kg). Body frames are world-aligned in the T-pose rest,
// body origin = joint to parent. Joint frames are identity on both sides, so the joint
// relative rotation is q_parent^-1 * q_child and the Rapier joint axes are X(left) Y(up) Z(front).
import type RAPIER from '@dimforge/rapier3d-compat';
import { type V3, type Q, type M3, m3zero, m3addTo, m3addParallel, m3mul, m3inv, m3trace, v3, sub, add, scale, len, dot, cross, qid, qconj, qmul, qrot, qrotInv, qaxis, qpos, axisAngles, RAD } from './math';

type R = typeof RAPIER;

export type Shape =
  | { type: 'capsule'; from: V3; to: V3; r: number }
  | { type: 'ball'; c: V3; r: number }
  | { type: 'box'; c: V3; half: V3 };

export type JointDef =
  | { type: 'sph'; limDeg: [[number, number], [number, number], [number, number]] } // AngX, AngY, AngZ
  | { type: 'hinge'; axis: V3; limDeg: [number, number] };

export type BodyDef = {
  name: string;
  parent: string | null;
  origin: V3;
  shape: Shape;
  massRatio: number;
  friction: number;
  joint?: JointDef;
  kpRatio: number;
};

const sideDefs = (s: 'Left' | 'Right'): BodyDef[] => {
  const k = s === 'Left' ? 1 : -1;
  const X = (x: number) => x * k;
  return [
    { name: `${s}Arm`, parent: 'Spine2', origin: v3(X(0.19), 1.42, 0), massRatio: 0.027, friction: 0.6, kpRatio: 0.4,
      shape: { type: 'capsule', from: v3(X(0.235), 1.42, 0), to: v3(X(0.425), 1.42, 0), r: 0.045 },
      joint: { type: 'sph', limDeg: [[-70, 70], [-100, 100], [-100, 100]] } }, // twist X, swing-cone approx Y/Z
    { name: `${s}ForeArm`, parent: `${s}Arm`, origin: v3(X(0.47), 1.42, 0), massRatio: 0.016, friction: 0.6, kpRatio: 0.3,
      shape: { type: 'capsule', from: v3(X(0.51), 1.42, 0), to: v3(X(0.68), 1.42, 0), r: 0.04 },
      // elbow flexes the forearm toward +Z (front): rotation about +Y is negative for left, positive for right
      joint: { type: 'hinge', axis: v3(0, k, 0), limDeg: [-145, 0] } },
    { name: `${s}Hand`, parent: `${s}ForeArm`, origin: v3(X(0.72), 1.42, 0), massRatio: 0.006, friction: 0.9, kpRatio: 0.2,
      shape: { type: 'capsule', from: v3(X(0.755), 1.42, 0), to: v3(X(0.845), 1.42, 0), r: 0.035 },
      joint: { type: 'sph', limDeg: [[-10, 10], [-30, 30], [-60, 60]] } },
    { name: `${s}UpLeg`, parent: 'Hips', origin: v3(X(0.1), 0.92, 0), massRatio: 0.142, friction: 0.6, kpRatio: 1.0,
      shape: { type: 'capsule', from: v3(X(0.1), 0.85, 0), to: v3(X(0.1), 0.57, 0), r: 0.07 },
      // hip flexion (leg forward) = negative X rotation
      joint: { type: 'sph', limDeg: [[-110, 20], [-35, 35], [-40, 40]] } },
    { name: `${s}Leg`, parent: `${s}UpLeg`, origin: v3(X(0.1), 0.5, 0), massRatio: 0.043, friction: 0.6, kpRatio: 1.0,
      shape: { type: 'capsule', from: v3(X(0.1), 0.45, 0), to: v3(X(0.1), 0.14, 0), r: 0.05 },
      // knee: shin goes back = +X rotation
      joint: { type: 'hinge', axis: v3(1, 0, 0), limDeg: [0, 140] } },
    { name: `${s}Foot`, parent: `${s}Leg`, origin: v3(X(0.1), 0.08, 0), massRatio: 0.014, friction: 1.0, kpRatio: 0.2,
      shape: { type: 'box', c: v3(X(0.1), 0.035, 0.05), half: v3(0.05, 0.035, 0.125) },
      joint: { type: 'sph', limDeg: [[-25, 40], [-5, 5], [-20, 20]] } },
  ];
};

export const BODY_DEFS: BodyDef[] = [
  { name: 'Hips', parent: null, origin: v3(0, 0.98, 0), massRatio: 0.112, friction: 0.6, kpRatio: 1.0,
    shape: { type: 'capsule', from: v3(-0.07, 0.98, 0), to: v3(0.07, 0.98, 0), r: 0.1 } },
  { name: 'Spine', parent: 'Hips', origin: v3(0, 1.06, 0), massRatio: 0.163, friction: 0.6, kpRatio: 1.0,
    shape: { type: 'capsule', from: v3(-0.06, 1.15, 0), to: v3(0.06, 1.15, 0), r: 0.1 },
    joint: { type: 'sph', limDeg: [[-20, 35], [-25, 25], [-25, 25]] } },
  { name: 'Spine2', parent: 'Spine', origin: v3(0, 1.25, 0), massRatio: 0.16, friction: 0.6, kpRatio: 1.0,
    shape: { type: 'capsule', from: v3(-0.07, 1.36, 0), to: v3(0.07, 1.36, 0), r: 0.11 },
    joint: { type: 'sph', limDeg: [[-20, 35], [-25, 25], [-25, 25]] } },
  { name: 'Head', parent: 'Spine2', origin: v3(0, 1.5, 0), massRatio: 0.069, friction: 0.6, kpRatio: 0.4,
    shape: { type: 'ball', c: v3(0, 1.66, 0), r: 0.11 },
    joint: { type: 'sph', limDeg: [[-40, 50], [-60, 60], [-35, 35]] } },
  ...sideDefs('Left'),
  ...sideDefs('Right'),
];
// Right elbow mirrored axis (0,-1,0): flexion toward +Z is then also negative about that axis.

export type JointMode = 'generic' | 'genericJD' | 'nolimits' | 'multibody' | 'custom';

export type BuildOpts = {
  mode: JointMode;
  totalMass?: number;
  offset?: V3;
  rot?: Q; // whole-character rotation about offset+hips
  fixedHips?: boolean;
  inertiaScale?: (name: string, mass: number) => number;
  contactsBetweenJointed?: boolean;
  collisionGroup?: number; // 16-bit membership/filter value combined
};

export type Body = { def: BodyDef; rb: RAPIER.RigidBody; col: RAPIER.Collider; idx: number; parentIdx: number };
export type Joint = {
  child: number;
  parent: number;
  def: JointDef;
  imp?: RAPIER.ImpulseJoint;
  mb?: RAPIER.MultibodyJoint;
  subtree: number[]; // indices of child + descendants
  rest: number[]; // all other bodies
};

export class Ragdoll {
  bodies: Body[] = [];
  joints: Joint[] = [];
  byName = new Map<string, Body>();
  constructor(public R: R, public world: RAPIER.World, public opts: BuildOpts) {
    const total = opts.totalMass ?? 75;
    const off = opts.offset ?? v3();
    const crot = opts.rot ?? qid();
    const pivot = v3(0, 0.98, 0);
    const xf = (p: V3) => add(add(qrot(crot, sub(p, pivot)), pivot), off);
    for (const def of BODY_DEFS) {
      const desc = (def.parent === null && opts.fixedHips ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
        .setTranslation(xf(def.origin).x, xf(def.origin).y, xf(def.origin).z)
        .setRotation(crot)
        .setCanSleep(false);
      const rb = world.createRigidBody(desc);
      const mass = def.massRatio * total;
      let cd: RAPIER.ColliderDesc;
      const s = def.shape;
      if (s.type === 'capsule') {
        const d = sub(s.to, s.from);
        const L = len(d);
        const mid = add(s.from, scale(d, 0.5));
        const lp = sub(mid, def.origin);
        // rotate local Y to d
        const y = v3(0, 1, 0);
        const ax = cross(y, d);
        const q = len(ax) < 1e-9 ? qid() : qaxis(ax, Math.acos(dot(y, d) / L));
        cd = R.ColliderDesc.capsule(L / 2, s.r).setTranslation(lp.x, lp.y, lp.z).setRotation(q);
      } else if (s.type === 'ball') {
        const lp = sub(s.c, def.origin);
        cd = R.ColliderDesc.ball(s.r).setTranslation(lp.x, lp.y, lp.z);
      } else {
        const lp = sub(s.c, def.origin);
        cd = R.ColliderDesc.cuboid(s.half.x, s.half.y, s.half.z).setTranslation(lp.x, lp.y, lp.z);
      }
      cd.setMass(mass).setFriction(def.friction).setRestitution(0);
      if (opts.collisionGroup !== undefined) cd.setCollisionGroups(opts.collisionGroup);
      const col = world.createCollider(cd, rb);
      const sc = opts.inertiaScale?.(def.name, mass) ?? 1;
      if (sc !== 1) {
        const I = rb.principalInertia();
        col.setMassProperties(mass, rb.localCom(), scale(I, sc), rb.principalInertiaLocalFrame());
        rb.recomputeMassPropertiesFromColliders(); // otherwise applied only at next step
      }
      const parentIdx = def.parent === null ? -1 : this.byName.get(def.parent)!.idx;
      const b: Body = { def, rb, col, idx: this.bodies.length, parentIdx };
      this.bodies.push(b);
      this.byName.set(def.name, b);
    }
    for (const b of this.bodies) {
      if (!b.def.joint || b.parentIdx < 0) continue;
      const p = this.bodies[b.parentIdx]!;
      const a1 = sub(b.def.origin, p.def.origin); // world-aligned rest frames -> local == world offset
      const a2 = v3();
      const jd = b.def.joint;
      let data: RAPIER.JointData;
      if (jd.type === 'hinge') data = R.JointData.revolute(a1, a2, jd.axis);
      else if (opts.mode === 'genericJD')
        data = R.JointData.generic(a1, a2, v3(1, 0, 0), R.JointAxesMask.LinX | R.JointAxesMask.LinY | R.JointAxesMask.LinZ);
      else data = R.JointData.spherical(a1, a2);
      const j: Joint = { child: b.idx, parent: p.idx, def: jd, subtree: [], rest: [] };
      if (opts.mode === 'multibody') {
        j.mb = world.createMultibodyJoint(data, p.rb, b.rb, true);
        j.mb.setContactsEnabled(!!opts.contactsBetweenJointed);
      } else {
        j.imp = world.createImpulseJoint(data, p.rb, b.rb, true);
        j.imp.setContactsEnabled(!!opts.contactsBetweenJointed);
        if (opts.mode === 'generic' || opts.mode === 'genericJD') this.applyLimits(j);
      }
      this.joints.push(j);
    }
    for (const j of this.joints) {
      j.subtree = this.descendants(j.child);
      j.rest = this.bodies.map((b) => b.idx).filter((i) => !j.subtree.includes(i));
    }
  }

  applyLimits(j: Joint) {
    const raw = this.world.impulseJoints.raw;
    const h = j.imp!.handle;
    if (j.def.type === 'hinge') {
      (j.imp as RAPIER.RevoluteImpulseJoint).setLimits(j.def.limDeg[0] * RAD, j.def.limDeg[1] * RAD);
    } else {
      const axes = [this.R.JointAxis.AngX, this.R.JointAxis.AngY, this.R.JointAxis.AngZ];
      j.def.limDeg.forEach((l, i) => raw.jointSetLimits(h, axes[i] as never, l[0] * RAD, l[1] * RAD));
    }
  }

  descendants(i: number): number[] {
    const out = [i];
    for (const b of this.bodies) if (b.parentIdx === i) out.push(...this.descendants(b.idx));
    return out;
  }

  relQ(j: Joint): Q {
    const qp = this.bodies[j.parent]!.rb.rotation();
    const qc = this.bodies[j.child]!.rb.rotation();
    return qmul(qconj(qp), qc);
  }
  /** relative angular velocity expressed in parent frame */
  relW(j: Joint): V3 {
    const p = this.bodies[j.parent]!.rb;
    const c = this.bodies[j.child]!.rb;
    return qrotInv(p.rotation(), sub(c.angvel(), p.angvel()));
  }
  relWWorld(j: Joint): V3 {
    return sub(this.bodies[j.child]!.rb.angvel(), this.bodies[j.parent]!.rb.angvel());
  }
  /** Joint coordinates (rad): sph -> Rapier-style per-axis [x,y,z]; hinge -> [angle, offAxisErr] */
  coords(j: Joint): number[] {
    const q = qpos(this.relQ(j));
    if (j.def.type === 'sph') return axisAngles(q);
    const a = j.def.axis;
    const s = q.x * a.x + q.y * a.y + q.z * a.z;
    const ang = 2 * Math.atan2(s, q.w);
    // off-axis residual: q * inv(rot about axis by ang)
    const res = qmul(q, qconj(qaxis(a, ang)));
    const off = 2 * Math.atan2(Math.hypot(res.x, res.y, res.z), Math.abs(res.w));
    return [ang, off];
  }
  /** limit violation in rad (max over axes) */
  violation(j: Joint): number {
    const c = this.coords(j);
    const lims = j.def.type === 'sph' ? j.def.limDeg : [j.def.limDeg];
    let v = 0;
    lims.forEach((l, i) => {
      const x = c[i]!;
      v = Math.max(v, l[0] * RAD - x, x - l[1] * RAD);
    });
    return Math.max(0, v);
  }
  /** anchor separation (m): joint position drift */
  anchorErr(j: Joint): number {
    const p = this.bodies[j.parent]!;
    const c = this.bodies[j.child]!;
    const a1 = sub(c.def.origin, p.def.origin);
    const wp = add(p.rb.translation(), qrot(p.rb.rotation(), a1));
    return len(sub(wp, c.rb.translation()));
  }
  subtreeMassCom(j: Joint): { m: number; c: V3 } {
    let m = 0;
    let c = v3();
    for (const i of j.subtree) {
      const rb = this.bodies[i]!.rb;
      m += rb.mass();
      c = add(c, scale(rb.worldCom(), rb.mass()));
    }
    return { m, c: scale(c, 1 / m) };
  }
  /** per-step body cache for inertia computations */
  cache: { m: number; c: V3; I: M3 }[] = [];
  refreshCache() {
    this.cache = this.bodies.map((b) => {
      // NOTE: rb.effectiveAngularInertia() returned garbage in 0.21.0 (see report) -> build R D R^T ourselves
      const D = b.rb.principalInertia();
      const q = qmul(b.rb.rotation(), b.rb.principalInertiaLocalFrame());
      const ex = qrot(q, v3(1, 0, 0)), ey = qrot(q, v3(0, 1, 0)), ez = qrot(q, v3(0, 0, 1));
      const I = m3zero();
      const cols = [ex, ey, ez], dv = [D.x, D.y, D.z];
      for (let k = 0; k < 3; k++) {
        const e = cols[k]!, E = [e.x, e.y, e.z];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) I[r * 3 + c]! += dv[k]! * E[r]! * E[c]!;
      }
      return { m: b.rb.mass(), c: b.rb.worldCom(), I };
    });
  }
  /** World inertia tensor about the joint point.
   *  'subtree': child + all descendants (slow mode, used for kd = 2*zeta*sqrt(kp*I)).
   *  'local'  : child body alone in series with parent body alone, Ic (Ic+Ip)^-1 Ip (fast mode; free ball
   *             joints do not transmit torque, so a joint torque mostly spins these two bodies), COM inertia
   *             only (lower bound). Parent side is infinite when it is the fixed Hips. Uses refreshCache(). */
  effTensor(j: Joint, kind: 'local' | 'subtree' = 'local'): M3 {
    const p = this.bodies[j.child]!.rb.translation();
    const side = (idx: number[], parallel: boolean) => {
      const T = m3zero();
      for (const i of idx) {
        const c = this.cache[i]!;
        m3addTo(T, c.I);
        if (parallel) m3addParallel(T, c.m, sub(c.c, p));
      }
      return T;
    };
    if (kind === 'subtree') return side(j.subtree, true);
    // 'local' lower bound: bodies' own COM inertia only. In a chain the joint point itself moves, so the
    // effective rotational inertia can drop to I_com (parallel-axis term not available).
    const Ic = side([j.child], false);
    if (this.opts.fixedHips && j.parent === 0) return Ic;
    const Ip = side([j.parent], false);
    const S = m3zero();
    m3addTo(S, Ic);
    m3addTo(S, Ip);
    return m3mul(m3mul(Ic, m3inv(S)), Ip);
  }
  /** scalar (trace/3) inertia at the current pose */
  effInertia(j: Joint, kind: 'local' | 'subtree' = 'local'): number {
    this.refreshCache();
    return m3trace(this.effTensor(j, kind)) / 3;
  }
  totalMass() {
    return this.bodies.reduce((s, b) => s + b.rb.mass(), 0);
  }
  com(): V3 {
    let c = v3();
    let m = 0;
    for (const b of this.bodies) {
      c = add(c, scale(b.rb.worldCom(), b.rb.mass()));
      m += b.rb.mass();
    }
    return scale(c, 1 / m);
  }
  /** push all state to array (pos, rot, linvel, angvel) */
  state(out: number[]) {
    for (const b of this.bodies) {
      const t = b.rb.translation(), q = b.rb.rotation(), v = b.rb.linvel(), w = b.rb.angvel();
      out.push(t.x, t.y, t.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z);
    }
  }
}
