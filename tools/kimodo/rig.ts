// 우리 랙돌 쪽 공통 계산: SOMA77 ↔ 바디 매핑(SPEC 11.3), rest 보정, 루트 매핑, 바디 월드 자세 ↔ 관절 상대 회전, 관절 제한.
//
// 리타깃 식 (바디 b, SOMA 대표 관절 s):
//   W_b = G_s · C_b · B_b
//   G_s = SOMA 관절 월드 회전 (T-pose = 항등이므로 Rest_world_src = I)
//   B_b = 우리 바디의 바인드(T-pose) 월드 회전 = A포즈 팔 내림을 되돌린 restRotation (xbot은 모두 항등)
//   C_b = 'dir' 바디(팔·다리)는 우리 바인드 분절 방향 → SOMA rest 분절 방향 최소 회전, 나머지는 항등
// SPEC 식 Q_world_target = Q_world_src · inv(Rest_world_src) · Rest_world_target 에서 Rest_world_target = C_b·B_b 인 경우다.
// 포즈 클립 관절 값은 "우리 rest(A포즈) 기준" 관절 좌표계 상대 회전 r (src/sim/character/pose.ts forwardKinematics와 같은 정의):
//   W_child = W_parent · frameInParent · r · frameInChild⁻¹   (rest에서 r = 항등)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BodyDef, BodyName, CharacterDef } from '../../src/sim/character/characterDef';
import type { JointName } from '../../src/sim/types';
import { type Vec3, add, sub, scale, length, cross } from '../../src/sim/math/vec3';
import {
  type Quat, multiplyQ, conjugate, rotate, fromTo, fromAxisAngle, normalizeQ, identityQ, slerp, qdot,
} from '../../src/sim/math/quat';
import type { Soma } from './soma';

export const ROOT = join(import.meta.dirname, '..', '..');
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export interface KimodoConfig {
  servers: Record<string, { url: string; model: string; label: string }>;
  request: { fps: number; diffusion_steps: number; postprocess: boolean; bvh_standard_tpose: boolean; timeoutS: number; retries: number; retryDelayS: number };
  retarget: { sourceAnkleHeight: number; dirBodies: BodyName[]; hingeProject: boolean; clampJoints: BodyName[] };
  contacts: { minRunFrames: number; geomHeightM: number; geomSpeed: number };
  footLock: { enabled: boolean; blendFrames: number; snapMaxM: number };
  loop: { velWeight: number; crossfadeFrames: number };
  fromPose: { maxFrame0ErrorM: number };
  score: { terms: Record<string, { weight: number; scale: number }> };
  film: { compareScale: number };
}

export const loadKimodoConfig = (): KimodoConfig => readJson<KimodoConfig>(join(ROOT, 'config', 'kimodo.json'));
export const loadDef = (id = 'xbot'): CharacterDef => readJson<CharacterDef>(join(ROOT, 'config', 'characters', `${id}.json`));

/** SPEC 11.3 매핑 표: 바디 → SOMA77 대표 관절. SOMA LeftLeg = 허벅지, LeftShin = 정강이 (Mixamo와 엇갈림) */
export const SOMA_REP: Record<BodyName, string> = {
  Hips: 'Hips', Spine: 'Spine2', Spine2: 'Chest', Head: 'Head',
  LeftArm: 'LeftArm', LeftForeArm: 'LeftForeArm', LeftHand: 'LeftHand',
  RightArm: 'RightArm', RightForeArm: 'RightForeArm', RightHand: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftShin', LeftFoot: 'LeftFoot',
  RightUpLeg: 'RightLeg', RightLeg: 'RightShin', RightFoot: 'RightFoot',
  LeftToeBase: 'LeftToeBase', RightToeBase: 'RightToeBase',
};
/** 'dir' 바디의 분절 끝: [우리 자식 바디, SOMA 끝 관절] */
const DIR_END: Partial<Record<BodyName, [BodyName, string]>> = {
  LeftArm: ['LeftForeArm', 'LeftForeArm'], LeftForeArm: ['LeftHand', 'LeftHand'],
  RightArm: ['RightForeArm', 'RightForeArm'], RightForeArm: ['RightHand', 'RightHand'],
  LeftUpLeg: ['LeftLeg', 'LeftShin'], LeftLeg: ['LeftFoot', 'LeftFoot'],
  RightUpLeg: ['RightLeg', 'RightShin'], RightLeg: ['RightFoot', 'RightFoot'],
};

/** 바디마다 월드 회전 + Hips 바디 원점 위치. rot은 def.bodies 순서 */
export interface BodyFrame {
  hips: Vec3;
  rot: Quat[];
}

export const SIDES = ['Left', 'Right'] as const;
export type Side = (typeof SIDES)[number];

export class Rig {
  readonly def: CharacterDef;
  readonly bodies: BodyDef[];
  readonly index: Map<BodyName, number>;
  readonly parentIdx: number[];
  /** 바인드(T-pose) 월드 회전 */
  readonly bind: Quat[];
  /** rest 보정 C_b */
  readonly corr: Quat[];
  /** 관절 위치(자식 바디 쪽 anchor)의 rest 월드 위치. 루트는 바디 원점 */
  readonly restJoint: Vec3[];
  /** 루트 매핑 */
  readonly scale: number;
  readonly hipMidLocal: Vec3;
  readonly somaHipMidRest: Vec3;
  readonly standHipT: number;
  readonly standHipS: number;
  readonly ankleRestT: number;
  readonly legLenT: number;
  readonly legLenS: number;

  constructor(def: CharacterDef, readonly soma: Soma, readonly cfg: KimodoConfig) {
    this.def = def;
    this.bodies = def.bodies;
    this.index = new Map(def.bodies.map((b, i) => [b.name, i]));
    this.parentIdx = def.bodies.map((b) => (b.parent ? this.index.get(b.parent)! : -1));
    this.restJoint = def.bodies.map((b) => (b.joint ? add(b.restPosition, rotate(b.restRotation, b.joint.anchorInChild)) : b.restPosition));

    // 바인드 = A포즈 팔 내림(armDownDeg, 축 = 바인드 상완 방향 × 아래)을 되돌린 rest 회전
    const down = def.restPose.armDownDeg * Math.PI / 180;
    this.bind = def.bodies.map((b) => {
      const m = /^(Left|Right)(Arm|ForeArm|Hand)$/.exec(b.name);
      if (!m) return b.restRotation;
      const axis = cross(m[1] === 'Left' ? [1, 0, 0] : [-1, 0, 0], [0, -1, 0]);
      return normalizeQ(multiplyQ(conjugate(fromAxisAngle(axis, down)), b.restRotation));
    });

    this.corr = def.bodies.map((b, i) => {
      const end = DIR_END[b.name];
      if (!end || !cfg.retarget.dirBodies.includes(b.name)) return identityQ();
      const [childBody, somaEnd] = end;
      // 우리 바인드 분절 방향 (rest 월드 방향을 바디 로컬로 바꾼 뒤 바인드로 돌림)
      const dRestWorld = sub(this.restJoint[this.idx(childBody)]!, this.restJoint[i]!);
      const dBind = rotate(this.bind[i]!, rotate(conjugate(b.restRotation), dRestWorld));
      const dSoma = sub(soma.restPos[soma.idx(somaEnd)]!, soma.restPos[soma.idx(SOMA_REP[b.name])]!);
      return fromTo(dBind, dSoma);
    });

    // 루트: 다리 길이 비율로 스케일, 높이는 서 있는 고관절 높이끼리 맞춘다 (발목 높이 차이 흡수)
    const j = (n: BodyName) => this.restJoint[this.idx(n)]!;
    this.legLenT = length(sub(j('LeftUpLeg'), j('LeftLeg'))) + length(sub(j('LeftLeg'), j('LeftFoot')));
    const sp = (n: string) => soma.restPos[soma.idx(n)]!;
    this.legLenS = length(sub(sp('LeftLeg'), sp('LeftShin'))) + length(sub(sp('LeftShin'), sp('LeftFoot')));
    this.scale = this.legLenT / this.legLenS;
    const hipsDef = this.bodies[0]!;
    const up = (n: BodyName) => this.bodies[this.idx(n)]!.joint!.anchorInParent;
    this.hipMidLocal = scale(add(up('LeftUpLeg'), up('RightUpLeg')), 0.5);
    this.somaHipMidRest = scale(add(sp('LeftLeg'), sp('RightLeg')), 0.5);
    this.standHipT = add(hipsDef.restPosition, rotate(hipsDef.restRotation, this.hipMidLocal))[1];
    this.standHipS = this.somaHipMidRest[1] - sp('LeftFoot')[1] + cfg.retarget.sourceAnkleHeight;
    this.ankleRestT = j('LeftFoot')[1];
  }

  idx(n: BodyName): number {
    const i = this.index.get(n);
    if (i === undefined) throw new Error(`바디 없음: ${n}`);
    return i;
  }

  /** SOMA 월드 점 → 우리 월드 점 (소스 고관절 중점 기준으로 s배) */
  mapPoint(p: Readonly<Vec3>, srcHipMid: Readonly<Vec3>, ourHipMid: Readonly<Vec3>): Vec3 {
    return add(ourHipMid, scale(sub(p, srcHipMid), this.scale));
  }
  /** SOMA 고관절 중점(월드) → 우리 고관절 중점(월드) */
  mapHipMid(src: Readonly<Vec3>): Vec3 {
    return [src[0] * this.scale, this.standHipT + this.scale * (src[1] - this.standHipS), src[2] * this.scale];
  }
  unmapHipMid(ours: Readonly<Vec3>): Vec3 {
    return [ours[0] / this.scale, (ours[1] - this.standHipT) / this.scale + this.standHipS, ours[2] / this.scale];
  }

  /** SOMA FK 결과 → 우리 바디 프레임 (보정 전) */
  fromSoma(G: readonly Quat[], P: readonly Vec3[]): BodyFrame {
    const rot = this.bodies.map((b, i) => normalizeQ(multiplyQ(multiplyQ(G[this.soma.idx(SOMA_REP[b.name])]!, this.corr[i]!), this.bind[i]!)));
    const s = this.soma;
    const srcMid = scale(add(P[s.idx('LeftLeg')]!, P[s.idx('RightLeg')]!), 0.5);
    const mid = this.mapHipMid(srcMid);
    return { hips: sub(mid, rotate(rot[0]!, this.hipMidLocal)), rot };
  }

  /** 우리 바디 월드 회전 → SOMA 대표 관절 월드 회전 (fromSoma의 역) */
  repWorld(frame: BodyFrame, b: number): Quat {
    return normalizeQ(multiplyQ(multiplyQ(frame.rot[b]!, conjugate(this.bind[b]!)), conjugate(this.corr[b]!)));
  }

  hipMid(frame: BodyFrame): Vec3 {
    return add(frame.hips, rotate(frame.rot[0]!, this.hipMidLocal));
  }

  /** 바디 원점 월드 위치 (관절 사슬). 관절 위치는 jointPositions */
  positions(frame: BodyFrame): Vec3[] {
    const out: Vec3[] = [];
    this.bodies.forEach((b, i) => {
      const p = this.parentIdx[i]!;
      if (p < 0 || !b.joint) { out.push(frame.hips); return; }
      const anchor = add(out[p]!, rotate(frame.rot[p]!, b.joint.anchorInParent));
      out.push(sub(anchor, rotate(frame.rot[i]!, b.joint.anchorInChild)));
    });
    return out;
  }

  /** 관절(부모와 붙는 점) 월드 위치. 루트는 바디 원점 */
  jointPositions(frame: BodyFrame, pos = this.positions(frame)): Vec3[] {
    return this.bodies.map((b, i) => (b.joint ? add(pos[i]!, rotate(frame.rot[i]!, b.joint.anchorInChild)) : pos[i]!));
  }

  /** 손끝 쪽 대표점(손 캡슐 중심)과 발목 대신 쓸 수 있는 점 */
  endEffectors(frame: BodyFrame, pos = this.positions(frame)): Record<string, Vec3> {
    const jp = this.jointPositions(frame, pos);
    return {
      LeftHand: jp[this.idx('LeftHand')]!, RightHand: jp[this.idx('RightHand')]!,
      LeftFoot: jp[this.idx('LeftFoot')]!, RightFoot: jp[this.idx('RightFoot')]!,
    };
  }

  /** 발 박스 꼭짓점 중 가장 낮은 y */
  soleY(frame: BodyFrame, side: Side, pos = this.positions(frame)): number {
    const i = this.idx(`${side}Foot`);
    const s = this.bodies[i]!.shape;
    if (s.type !== 'box') return pos[i]![1];
    let lo = Infinity;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      lo = Math.min(lo, add(pos[i]!, rotate(frame.rot[i]!, [sx * s.halfExtents[0], sy * s.halfExtents[1], sz * s.halfExtents[2]]))[1]);
    }
    return lo;
  }

  /** 바디 월드 회전 → 관절 상대 회전 r (rest = 항등) */
  jointRel(frame: BodyFrame): Partial<Record<JointName, Quat>> {
    const out: Partial<Record<JointName, Quat>> = {};
    this.bodies.forEach((b, i) => {
      const p = this.parentIdx[i]!;
      if (p < 0 || !b.joint) return;
      out[b.name as JointName] = this.relOf(frame.rot[p]!, frame.rot[i]!, b);
    });
    return out;
  }

  relOf(wp: Readonly<Quat>, wc: Readonly<Quat>, b: BodyDef): Quat {
    const j = b.joint!;
    let r = normalizeQ(multiplyQ(multiplyQ(conjugate(j.frameInParent), conjugate(wp)), multiplyQ(wc, j.frameInChild)));
    if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
    return r;
  }

  childOf(wp: Readonly<Quat>, r: Readonly<Quat>, b: BodyDef): Quat {
    const j = b.joint!;
    return normalizeQ(multiplyQ(multiplyQ(wp, j.frameInParent), multiplyQ(r, conjugate(j.frameInChild))));
  }

  /** 관절 상대 회전 + 루트 → 바디 프레임 */
  fromJointRel(rootPos: Readonly<Vec3>, rootRot: Readonly<Quat>, joints: Partial<Record<JointName, Quat>>): BodyFrame {
    const rot: Quat[] = [];
    this.bodies.forEach((b, i) => {
      const p = this.parentIdx[i]!;
      if (p < 0 || !b.joint) { rot.push(normalizeQ(multiplyQ(rootRot, b.restRotation))); return; }
      rot.push(this.childOf(rot[p]!, joints[b.name as JointName] ?? identityQ(), b));
    });
    return { hips: [rootPos[0], rootPos[1], rootPos[2]], rot };
  }

  /** 경첩 관절(무릎·팔꿈치): flex(X) 축 회전만 남긴다. 자식의 자식은 월드 회전을 유지한다 */
  projectHinges(frame: BodyFrame): BodyFrame {
    const rot = frame.rot.slice();
    this.bodies.forEach((b, i) => {
      if (b.joint?.type !== 'hinge') return;
      const p = this.parentIdx[i]!;
      const r = this.relOf(rot[p]!, rot[i]!, b);
      // X축 twist 성분만 (swing-twist), 각은 [0, π]
      const t = normalizeQ([r[0], 0, 0, r[3]]);
      rot[i] = this.childOf(rot[p]!, t, b);
    });
    return { hips: frame.hips, rot };
  }

  /**
   * 축별 제한(flex·twist·side, 2·asin 성분) 안으로 자른다. 자식 바디들은 월드 회전을 유지한다.
   * 손목처럼 우리 랙돌이 표현할 수 없는 회전(전완 회내·회외는 팔꿈치 경첩에 없음)을 정리할 때 쓴다. 콘 관절은 다루지 않는다.
   */
  clampJoints(frame: BodyFrame, names: readonly BodyName[]): { frame: BodyFrame; clampDeg: number } {
    const rot = frame.rot.slice();
    let clampDeg = 0;
    for (const n of names) {
      const i = this.idx(n), b = this.bodies[i]!, p = this.parentIdx[i]!;
      const L = b.joint?.limitsDeg;
      if (!L || b.joint!.type !== 'spherical' || L.swingCone !== undefined) continue;
      const r = this.relOf(rot[p]!, rot[i]!, b);
      const lims = [L.flex, L.twist, L.side];
      const c = [r[0], r[1], r[2]].map((x, k) => {
        const l = lims[k];
        if (!l) return x;
        return Math.min(Math.sin((l[1] * Math.PI) / 360), Math.max(Math.sin((l[0] * Math.PI) / 360), x));
      });
      const w = Math.sqrt(Math.max(0, 1 - c[0]! ** 2 - c[1]! ** 2 - c[2]! ** 2));
      const q: Quat = normalizeQ([c[0]!, c[1]!, c[2]!, w]);
      clampDeg = Math.max(clampDeg, (2 * Math.acos(Math.min(1, Math.abs(qdot(q, r)))) * 180) / Math.PI);
      rot[i] = this.childOf(rot[p]!, q, b);
    }
    return { frame: { hips: frame.hips, rot }, clampDeg };
  }

  /** 관절 좌표 [flex, twist, side] (도) = 2·asin(성분), 어깨는 콘 축 기준 (sim ragdoll.ts jointCoords와 같은 정의) */
  jointCoordsDeg(frame: BodyFrame): Record<string, Vec3> {
    const out: Record<string, Vec3> = {};
    const a = (s: number) => (2 * Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI;
    this.bodies.forEach((b, i) => {
      const p = this.parentIdx[i]!;
      if (p < 0 || !b.joint) return;
      let frameP = b.joint.frameInParent;
      if (b.joint.limitsDeg.swingCone !== undefined && b.joint.coneAxisInParent) {
        const qP = this.bodies[p]!.restRotation;
        const twistW = rotate(multiplyQ(qP, frameP), [0, 1, 0]);
        const coneW = rotate(qP, b.joint.coneAxisInParent);
        frameP = multiplyQ(conjugate(qP), multiplyQ(fromTo(twistW, coneW), multiplyQ(qP, frameP)));
      }
      let r = multiplyQ(multiplyQ(conjugate(frameP), conjugate(frame.rot[p]!)), multiplyQ(frame.rot[i]!, b.joint.frameInChild));
      if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
      out[b.name] = [a(r[0]), a(r[1]), a(r[2])];
    });
    return out;
  }

  /** 관절별 제한 초과량(도, 축 중 최대). 경첩의 잠긴 축, 어깨 콘(X·Z 각각 ±콘)은 sim과 같은 방식 */
  limitViolationsDeg(frame: BodyFrame): Record<string, number> {
    const c = this.jointCoordsDeg(frame);
    const out: Record<string, number> = {};
    for (const b of this.bodies) {
      if (!b.joint) continue;
      const L = b.joint.limitsDeg;
      const lim: ([number, number] | undefined)[] = b.joint.type === 'hinge'
        ? [L.flex, [0, 0], [0, 0]]
        : L.swingCone !== undefined ? [[-L.swingCone, L.swingCone], L.twist, [-L.swingCone, L.swingCone]]
        : [L.flex, L.twist, L.side];
      let v = 0;
      const x = c[b.name]!;
      lim.forEach((l, k) => { if (l) v = Math.max(v, l[0] - x[k]!, x[k]! - l[1]); });
      out[b.name] = v;
    }
    return out;
  }
}

/** 이웃 프레임과 같은 반구로 맞춘다 (사원수 부호 뒤집힘 방지) */
export function hemisphere(frames: BodyFrame[]): void {
  for (let t = 1; t < frames.length; t++) {
    const a = frames[t - 1]!.rot, b = frames[t]!.rot;
    b.forEach((q, i) => { if (qdot(a[i]!, q) < 0) b[i] = [-q[0], -q[1], -q[2], -q[3]]; });
  }
}

/** Y축 회전각(정면 +Z 기준, 라디안): Hips 로컬 +Z가 수평면에서 가리키는 방향 */
export function headingOf(q: Readonly<Quat>): number {
  const f = rotate(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}
export const yawQ = (a: number): Quat => fromAxisAngle([0, 1, 0], a);

/** 프레임 전체를 Y축으로 yaw만큼 돌리고 off만큼 옮긴다 (원점 기준) */
export function transformFrame(f: BodyFrame, yaw: number, off: Readonly<Vec3>): BodyFrame {
  const q = yawQ(yaw);
  return { hips: add(rotate(q, f.hips), off), rot: f.rot.map((r) => normalizeQ(multiplyQ(q, r))) };
}

export function lerpFrame(a: BodyFrame, b: BodyFrame, w: number): BodyFrame {
  return {
    hips: add(a.hips, scale(sub(b.hips, a.hips), w)),
    rot: a.rot.map((q, i) => normalizeQ(slerp(q, b.rot[i]!, w))),
  };
}

