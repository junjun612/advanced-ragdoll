// 행동이 쓰는 운동학 도구: 팔 2관절 IK(손바닥 점·손 방향 → 어깨·팔꿈치·손목 관절 목표), 시선(머리·상체 비틀기 목표).
// 관절 목표 형식은 pose.ts의 정의 관절 좌표계 상대 회전 (rest = 항등).
import type { CharacterDef, BodyName, BodyDef } from '../characterDef';
import type { JointName, JointTargets } from '../pose';
import type { Ragdoll } from '../ragdoll';
import { solveTwoBone } from '../../math/ik';
import { fromColumns, toQuat } from '../../math/mat3';
import { type Vec3, add, sub, scale, cross, dot, length, normalize } from '../../math/vec3';
import { type Quat, conjugate, multiplyQ, rotate, fromRotationVector, normalizeQ } from '../../math/quat';
import type { HandName } from './types';

const RAD = Math.PI / 180;

export const bodyDef = (def: CharacterDef, n: BodyName): BodyDef => {
  const b = def.bodies.find((x) => x.name === n);
  if (!b) throw new Error(`no body ${n}`);
  return b;
};

export function bodyPose(rd: Ragdoll, n: BodyName): { pos: Vec3; rot: Quat; vel: Vec3; angVel: Vec3 } {
  const rb = rd.body(n).rb;
  const t = rb.translation(), q = rb.rotation(), v = rb.linvel(), w = rb.angvel();
  return { pos: [t.x, t.y, t.z], rot: [q.x, q.y, q.z, q.w], vel: [v.x, v.y, v.z], angVel: [w.x, w.y, w.z] };
}

/** 자식 월드 회전 qChild, 부모 월드 회전 qParent → 정의 관절 좌표계 상대 회전 */
export function relJoint(def: CharacterDef, joint: JointName, qParent: Readonly<Quat>, qChild: Readonly<Quat>): Quat {
  const j = bodyDef(def, joint).joint!;
  let r = multiplyQ(multiplyQ(conjugate(multiplyQ(qParent, j.frameInParent)), qChild), j.frameInChild);
  if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
  return r;
}

/** 관절 목표를 정의 관절 좌표계 축별 제한(2·asin 성분, margin 안쪽)으로 자른다. 스윙 콘(어깨)은 자르지 않는다 */
export function clampJoint(def: CharacterDef, joint: JointName, r: Readonly<Quat>, marginDeg = 2): Quat {
  const lim = bodyDef(def, joint).joint!.limitsDeg;
  if (lim.swingCone !== undefined) return [...r] as Quat;
  const q = r[3] < 0 ? [-r[0], -r[1], -r[2]] : [r[0], r[1], r[2]];
  const axes: ([number, number] | undefined)[] = [lim.flex, lim.twist, lim.side];
  const c = [0, 1, 2].map((k) => {
    const x = 2 * Math.asin(Math.max(-1, Math.min(1, q[k]!)));
    const l = axes[k];
    if (!l) return x;
    const m = Math.min(marginDeg, (l[1] - l[0]) / 4) * RAD;
    return Math.max(l[0] * RAD + m, Math.min(l[1] * RAD - m, x));
  });
  const s = c.map((x) => Math.sin(x / 2));
  const w = Math.sqrt(Math.max(0, 1 - s[0]! * s[0]! - s[1]! * s[1]! - s[2]! * s[2]!));
  return normalizeQ([s[0]!, s[1]!, s[2]!, w]);
}

/** 바디 로컬 기준벡터 두 개(방향 dl, 그에 수직 성분을 쓰는 축 al) → 월드(dw, aw)로 보내는 회전 */
export function frameMap(dl: Readonly<Vec3>, al: Readonly<Vec3>, dw: Readonly<Vec3>, aw: Readonly<Vec3>): Quat {
  const x0 = normalize(dl), y0 = normalize(sub(al, scale(x0, dot(al, x0)))), z0 = cross(x0, y0);
  const x1 = normalize(dw), y1 = normalize(sub(aw, scale(x1, dot(aw, x1)))), z1 = cross(x1, y1);
  const Ml = fromColumns(x0, y0, z0), Mw = fromColumns(x1, y1, z1);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number, number, number, number];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 3; k++) s += Mw[r * 3 + k]! * Ml[c * 3 + k]!; m[r * 3 + c] = s; }
  return toQuat(m);
}

export interface ArmChain {
  side: 1 | -1;
  arm: JointName;
  fore: JointName;
  hand: JointName;
  /** 상완·전완 길이, 손목 → 손바닥 점 거리 */
  l1: number;
  l2: number;
  /** 바디 로컬: 상완 방향(어깨 → 팔꿈치), 전완 방향(팔꿈치 → 손목), 팔꿈치 경첩 축(상완·전완 로컬), 손목(손 로컬), 손가락 방향(손 로컬) */
  dU: Vec3;
  dF: Vec3;
  axU: Vec3;
  axF: Vec3;
  wristInHand: Vec3;
  fingers: Vec3;
  shoulderInSpine2: Vec3;
}

export function armChain(def: CharacterDef, hand: HandName): ArmChain {
  const L = hand === 'LeftHand';
  const arm = (L ? 'LeftArm' : 'RightArm') as JointName, fore = (L ? 'LeftForeArm' : 'RightForeArm') as JointName, h = hand as JointName;
  const A = bodyDef(def, arm), F = bodyDef(def, fore), H = bodyDef(def, h);
  const dU = sub(F.joint!.anchorInParent, A.joint!.anchorInChild);
  const dF = sub(H.joint!.anchorInParent, F.joint!.anchorInChild);
  // 경첩 축: 부모(상완) 로컬 = joint.axis, 전완 로컬 = rest 회전으로 옮긴 같은 월드 축
  const axU = normalize(F.joint!.axis);
  const axF = normalize(rotate(conjugate(F.restRotation), rotate(A.restRotation, axU)));
  const wristInHand = H.joint!.anchorInChild;
  return {
    side: L ? 1 : -1, arm, fore, hand: h, l1: length(dU), l2: length(dF), dU, dF, axU, axF, wristInHand,
    fingers: normalize(scale(wristInHand, -1)), shoulderInSpine2: A.joint!.anchorInParent,
  };
}

/**
 * 팔 IK: 손바닥 점 palm(월드), 손 월드 회전 qHand, 손바닥 점(손 로컬) palmLocal, 팔꿈치 방향 힌트 pole(월드)
 * → 어깨·팔꿈치·손목 관절 목표. 부모(Spine2) 회전은 지금 값을 쓴다(피드백). 닿지 않으면 최대로 뻗은 자세.
 */
export function solveArm(def: CharacterDef, ch: ArmChain, qSpine2: Readonly<Quat>, pSpine2: Readonly<Vec3>, palm: Readonly<Vec3>, qHand: Readonly<Quat>, palmLocal: Readonly<Vec3>, pole: Readonly<Vec3>): {
  targets: JointTargets; shoulder: Vec3; elbow: Vec3; wrist: Vec3; reach: number; reachable: boolean; qUpper: Quat; qFore: Quat;
  /** 손목 제한 안으로 자른 손 월드 회전 (QP 손 방향 과제는 이것을 쓴다 — 제한 밖 방향을 쫓으면 손이 튄다) */
  qHand: Quat;
} {
  const S = add(pSpine2, rotate(qSpine2, ch.shoulderInSpine2));
  const W = sub(palm, rotate(qHand, sub(palmLocal, ch.wristInHand)));
  const sol = solveTwoBone(S, W, ch.l1, ch.l2, pole);
  const u = normalize(sub(sol.mid, S)), s = normalize(sub(sol.end, sol.mid));
  let a = cross(u, s);
  if (length(a) < 1e-4) {
    // 거의 편 팔: 팔꿈치 힌트로 굽힘 평면을 정한다 (u → 힌트 쪽으로 굽는 축)
    a = cross(u, normalize(sub(pole, scale(u, dot(pole, u)))));
    if (length(a) < 1e-6) a = cross(u, [0, 0, 1]);
  }
  a = normalize(a);
  const qU = frameMap(ch.dU, ch.axU, u, a);
  const qF = frameMap(ch.dF, ch.axF, s, a);
  const rh = clampJoint(def, ch.hand, relJoint(def, ch.hand, qF, qHand));
  const hj = bodyDef(def, ch.hand).joint!;
  const targets: JointTargets = {
    [ch.arm]: relJoint(def, ch.arm, qSpine2, qU),
    [ch.fore]: relJoint(def, ch.fore, qU, qF),
    [ch.hand]: rh,
  };
  const qH = normalizeQ(multiplyQ(multiplyQ(multiplyQ(qF, hj.frameInParent), rh), conjugate(hj.frameInChild)));
  return { targets, shoulder: S, elbow: sol.mid, wrist: W, reach: length(sub(W, S)), reachable: sol.reachable, qUpper: qU, qFore: qF, qHand: qH };
}

/**
 * 손 월드 회전: 손바닥(손 로컬 −Y)이 inward(월드, 상처 쪽)를 향하고, 손가락(손 로컬)이 fingerPref를 inward에 수직인 평면으로 투영한 방향.
 */
export function handRotation(ch: ArmChain, inward: Readonly<Vec3>, fingerPref: Readonly<Vec3>): Quat {
  const y = normalize(scale(inward, -1)); // 손 로컬 +Y = 손등 쪽 = 바깥
  let f = sub(fingerPref, scale(y, dot(fingerPref, y)));
  if (length(f) < 1e-6) f = sub([0, 1, 0], scale(y, y[1]));
  f = normalize(f);
  // 손 로컬 X축이 손가락 방향(왼손 +X, 오른손 −X)
  const x = ch.fingers[0] >= 0 ? f : scale(f, -1);
  const z = cross(x, y);
  return toQuat(fromColumns(x, y, z));
}

/** 시선: 머리 중심 head, Spine2 회전 qS2, 대상 target → 대상 방향의 yaw(왼쪽 +)·pitch(아래 +) (Spine2 기준, rad) */
export function gazeAngles(head: Readonly<Vec3>, qS2: Readonly<Quat>, target: Readonly<Vec3>): { yaw: number; pitch: number } {
  const d = normalize(rotate(conjugate(qS2), sub(target, head)));
  return { yaw: Math.atan2(d[0], d[2]), pitch: Math.asin(Math.max(-1, Math.min(1, -d[1]))) };
}

/** 관절 좌표계 회전 벡터(도) → 사원수 */
export const degQ = (flex: number, twist: number, side: number): Quat => fromRotationVector([flex * RAD, twist * RAD, side * RAD]);
