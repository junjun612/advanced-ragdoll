// Muscle candidates (A explicit PD, B Rapier joint motors, C stable-PD approx) + custom limit torques (2c).
import R from '@dimforge/rapier3d-compat';
import { type V3, type Q, m3inv, m3v, m3addTo, m3zero, v3, add, sub, scale, cross, dot, qmul, qconj, qrot, qlog, qpos, axisAngles, RAD } from './math';
import type { Ragdoll, Joint } from './ragdoll';

export type Method = 'A' | 'B' | 'Bacc' | 'C';
export type MuscleCfg = {
  method: Method;
  kpScale: number; // N*m/rad for ratio 1.0 joints
  zeta?: number;
  kdInertia?: 'subtree' | 'local'; // inertia used in kd = 2*zeta*sqrt(kp*I)
  gc?: boolean;
  targets: Q[]; // per joint (same order as rd.joints), relative rotation parent->child
  dt: number;
};

const G = v3(0, -9.81, 0);

export class Muscles {
  kp: number[] = [];
  kd: number[] = [];
  I: number[] = [];
  constructor(public rd: Ragdoll, public cfg: MuscleCfg) {
    const z = cfg.zeta ?? 1;
    for (const j of rd.joints) {
      const I = rd.effInertia(j, cfg.kdInertia ?? 'subtree');
      const kp = cfg.kpScale * rd.bodies[j.child]!.def.kpRatio;
      this.I.push(I);
      this.kp.push(kp);
      this.kd.push(2 * z * Math.sqrt(kp * I));
    }
    if (cfg.method === 'B' || cfg.method === 'Bacc') this.setupMotors();
  }

  setupMotors() {
    const raw = this.rd.world.impulseJoints.raw;
    const acc = this.cfg.method === 'Bacc';
    const model = acc ? R.MotorModel.AccelerationBased : R.MotorModel.ForceBased;
    this.rd.joints.forEach((j, k) => {
      const h = j.imp!.handle;
      const kp = acc ? this.kp[k]! / this.I[k]! : this.kp[k]!;
      const kd = acc ? this.kd[k]! / this.I[k]! : this.kd[k]!;
      const qt = qpos(this.cfg.targets[k]!);
      if (j.def.type === 'hinge') {
        const a = j.def.axis;
        const ang = 2 * Math.atan2(qt.x * a.x + qt.y * a.y + qt.z * a.z, qt.w);
        const rj = j.imp as R.RevoluteImpulseJoint;
        rj.configureMotorModel(model);
        rj.configureMotorPosition(ang, kp, kd);
      } else {
        // spherical: per-axis targets in Rapier's 2*asin(q_i) coordinates (raw API only, see report)
        const t = axisAngles(qt);
        [3, 4, 5].forEach((ax, i) => {
          raw.jointConfigureMotorModel(h, ax as never, model as never);
          raw.jointConfigureMotorPosition(h, ax as never, t[i]!, kp, kd);
        });
      }
    });
  }

  gravityComp(j: Joint): V3 {
    const { m, c } = this.rd.subtreeMassCom(j);
    const p = this.rd.bodies[j.child]!.rb.translation();
    return cross(sub(c, p), scale(G, -m));
  }

  /** call once per step before world.step(); assumes torques were reset */
  apply(log?: { tau: number }) {
    const { method, dt } = this.cfg;
    if (method === 'C') this.rd.refreshCache();
    this.rd.joints.forEach((j, k) => {
      let tau = v3();
      if (method === 'A' || method === 'C') {
        const qp = this.rd.bodies[j.parent]!.rb.rotation();
        const qrel = qmul(qconj(qp), this.rd.bodies[j.child]!.rb.rotation());
        const e = qrot(qp, qlog(qmul(this.cfg.targets[k]!, qconj(qrel))));
        const w = this.rd.relWWorld(j);
        const kp = this.kp[k]!, kd = this.kd[k]!;
        if (method === 'A') tau = sub(scale(e, kp), scale(w, kd));
        else {
          // Stable PD (Tan 2011) per-joint approximation: position predicted at t+dt, damping implicit
          // with the joint's effective inertia tensor T:  tau = (T + dt*kd*E)^-1 T (kp(e - dt w) - kd w)
          const num = sub(scale(sub(e, scale(w, dt)), kp), scale(w, kd));
          const T = this.rd.effTensor(j);
          const M = m3zero();
          m3addTo(M, T);
          M[0]! += dt * kd; M[4]! += dt * kd; M[8]! += dt * kd;
          tau = m3v(m3inv(M), m3v(T, num));
        }
      }
      if (this.cfg.gc) tau = add(tau, this.gravityComp(j));
      if (tau.x === 0 && tau.y === 0 && tau.z === 0) return;
      this.rd.bodies[j.child]!.rb.addTorque(tau, true);
      this.rd.bodies[j.parent]!.rb.addTorque(scale(tau, -1), true);
      if (log) log.tau = Math.max(log.tau, Math.hypot(tau.x, tau.y, tau.z));
    });
  }
}

/** (c) custom limit torques: spring-damper (implicit damping) when a joint coordinate leaves its range */
export class LimitTorques {
  constructor(public rd: Ragdoll, public dt: number, public alpha = 0.3) {}
  apply() {
    const dt = this.dt;
    this.rd.refreshCache();
    this.rd.joints.forEach((j) => {
      const T = this.rd.effTensor(j);
      const c = this.rd.coords(j);
      const qp = this.rd.bodies[j.parent]!.rb.rotation();
      const wl = this.rd.relW(j); // parent frame
      let tl = v3();
      const axes: V3[] = j.def.type === 'sph' ? [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)] : [j.def.axis];
      const lims = j.def.type === 'sph' ? j.def.limDeg : [j.def.limDeg];
      axes.forEach((ax, i) => {
        const x = c[i]!, lo = lims[i]![0] * RAD, hi = lims[i]![1] * RAD;
        const ex = x < lo ? lo - x : x > hi ? hi - x : 0;
        if (ex === 0) return;
        const aw = qrot(qp, ax);
        const I = dot(aw, m3v(T, aw)); // per-axis effective inertia
        const kl = (this.alpha * I) / (dt * dt);
        const dl = 2 * Math.sqrt(kl * I);
        const wa = dot(wl, ax);
        const t = (kl * (ex - dt * wa) - dl * wa) / (1 + (dt * dl) / I);
        tl = add(tl, scale(ax, t));
      });
      if (tl.x === 0 && tl.y === 0 && tl.z === 0) return;
      const tw = qrot(qp, tl);
      this.rd.bodies[j.child]!.rb.addTorque(tw, true);
      this.rd.bodies[j.parent]!.rb.addTorque(scale(tw, -1), true);
    });
  }
}

export function resetTorques(rd: Ragdoll) {
  for (const b of rd.bodies) b.rb.resetTorques(false);
}

/** A-pose-ish target (relative rotations) for the spike ragdoll */
export function aPoseTargets(rd: Ragdoll): Q[] {
  const ax = (x: number, y: number, z: number, deg: number): Q => {
    const n = Math.hypot(x, y, z), s = Math.sin((deg * RAD) / 2);
    return { x: (x / n) * s, y: (y / n) * s, z: (z / n) * s, w: Math.cos((deg * RAD) / 2) };
  };
  const id: Q = { x: 0, y: 0, z: 0, w: 1 };
  const t: Record<string, Q> = {
    Spine: ax(1, 0, 0, 5),
    LeftArm: ax(0, 0, 1, -45), RightArm: ax(0, 0, 1, 45),
    LeftForeArm: ax(0, 1, 0, -20), RightForeArm: ax(0, -1, 0, -20),
    LeftUpLeg: ax(1, 0, 0, -8), RightUpLeg: ax(1, 0, 0, -8),
    LeftLeg: ax(1, 0, 0, 12), RightLeg: ax(1, 0, 0, 12),
    LeftFoot: ax(1, 0, 0, -4), RightFoot: ax(1, 0, 0, -4),
    LeftHand: ax(0, 0, 1, -10), RightHand: ax(0, 0, 1, 10),
  };
  return rd.joints.map((j) => t[rd.bodies[j.child]!.def.name] ?? id);
}
