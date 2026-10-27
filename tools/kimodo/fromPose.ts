// 우리 포즈 → Kimodo 전신 키프레임 (SPEC 11.3 "우리 포즈 → Kimodo 키프레임").
// 1. 캐릭터를 원점으로: 고관절 중점 XZ = (0,0), 정면 = +Z (변환은 돌려준다).
// 2. 바디 월드 회전 → SOMA 대표 관절 월드 회전 (rest 보정 역방향, rig.repWorld).
// 3. 흡수된 중간 관절에 나눠 준다: Spine1·Spine2 = Hips→Spine 상대 회전 절반씩(slerp), Neck1·Neck2 = Chest→Head 절반씩,
//    Shoulder = Chest와 같은 월드 회전, 손가락·발끝·눈·턱은 rest(로컬 항등).
// 4. 로컬 = inv(부모 월드)·월드 → axis-angle 77개.
// 5. 검증: 보낸 키프레임의 SOMA FK 관절 위치와 생성 결과 0프레임 world_joint_positions 차이 ≤ 2 cm (checkFrame0).
import { PoseClip, type PoseFile, forwardKinematics, lowestFootY } from '../../src/sim/character/pose';
import { type Vec3, sub, length, scale } from '../../src/sim/math/vec3';
import {
  type Quat, multiplyQ, conjugate, rotate, normalizeQ, identityQ, slerp, toRotationVector,
} from '../../src/sim/math/quat';
import { type BodyFrame, Rig, SOMA_REP, transformFrame } from './rig';
import { canonicalTransform } from './toPoseClip';
import type { KimodoResponse } from './soma';

export interface KimodoKeyframe {
  frame: number;
  root_position: Vec3;
  /** 77관절 axis-angle (라디안) */
  local_joints_rot: Vec3[];
}

/** config/poses의 포즈 → 바디 프레임 (rest Hips 자세에서 FK, 발바닥이 y=0에 닿게 내림) */
export function poseFileFrame(rig: Rig, pose: PoseFile, library: Record<string, PoseFile>): BodyFrame {
  const targets = new PoseClip(pose, library).sample(0);
  const hips = rig.bodies[0]!;
  const tf = forwardKinematics(rig.def, targets, { pos: hips.restPosition, rot: [0, 0, 0, 1] });
  const dy = lowestFootY(rig.def, tf);
  return { hips: [tf[0]!.pos[0], tf[0]!.pos[1] - dy, tf[0]!.pos[2]], rot: tf.map((t) => normalizeQ(t.rot)) };
}

/** 바디 프레임 → SOMA77 로컬 회전(xyzw)과 Hips 위치 */
export function frameToSoma(rig: Rig, f: BodyFrame): { local: Quat[]; root: Vec3 } {
  const s = rig.soma;
  const n = s.names.length;
  const G: (Quat | null)[] = new Array(n).fill(null);
  // 대표 관절
  rig.bodies.forEach((b, i) => {
    G[s.idx(SOMA_REP[b.name])] = rig.repWorld(f, i);
  });
  const g = (name: string) => G[s.idx(name)]!;
  // Spine1·Spine2: Hips→(Spine 바디 대표 = Spine2) 상대 회전을 절반씩
  const relSpine = multiplyQ(conjugate(g('Hips')), g('Spine2'));
  G[s.idx('Spine1')] = normalizeQ(multiplyQ(g('Hips'), slerp(identityQ(), relSpine, 0.5)));
  // Neck1·Neck2: Chest→Head 상대 회전을 절반씩, Head 로컬 = 항등
  const relNeck = multiplyQ(conjugate(g('Chest')), g('Head'));
  const half = slerp(identityQ(), relNeck, 0.5);
  G[s.idx('Neck1')] = normalizeQ(multiplyQ(g('Chest'), half));
  G[s.idx('Neck2')] = normalizeQ(multiplyQ(G[s.idx('Neck1')]!, half));
  for (const side of ['Left', 'Right']) G[s.idx(`${side}Shoulder`)] = g('Chest');
  // 나머지(손가락, 발끝, 눈, 턱, 끝점) = 부모와 같은 월드 회전 (로컬 항등)
  for (let j = 0; j < n; j++) if (!G[j]) G[j] = G[s.parents[j]!]!;
  const local = G.map((q, j) => {
    const p = s.parents[j]!;
    return normalizeQ(p < 0 ? q! : multiplyQ(conjugate(G[p]!), q!));
  });
  const srcMid = rig.unmapHipMid(rig.hipMid(f));
  const root = sub(srcMid, rotate(G[0]!, rig.somaHipMidRest));
  return { local, root };
}

export interface FromPoseResult {
  keyframe: KimodoKeyframe;
  /** 원점·정면 정규화 (클립에 역으로 적용하려면 transformFrame(f, -yaw, …)) */
  canonical: { yaw: number; off: Vec3 };
  /** 보낸 키프레임의 SOMA FK 관절 위치 (검증용) */
  positions: Vec3[];
  frame: BodyFrame;
}

/** 바디 프레임 → Kimodo 키프레임 (원점·정면 정규화 포함) */
export function fromPose(rig: Rig, f: BodyFrame, frameIndex = 0): FromPoseResult {
  const canonical = canonicalTransform(rig, f);
  const cf = transformFrame(f, canonical.yaw, canonical.off);
  const { local, root } = frameToSoma(rig, cf);
  const { P } = rig.soma.fk(local, root);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    keyframe: { frame: frameIndex, root_position: root.map(r6) as Vec3, local_joints_rot: local.map((q) => toRotationVector(q).map(r6) as Vec3) },
    canonical, positions: P, frame: cf,
  };
}

/**
 * 생성 결과 0프레임과 보낸 키프레임 비교. 단위 m.
 * 모델 입력 30관절에서 손가락 끝(ThumbEnd, MiddleEnd)은 뺀다: 우리 바디에 없는 손가락은 rest로 보내지만
 * Kimodo는 자기 손가락 자세를 채워서 3~6cm 다르다(2026-10-26 확인). 나머지 28관절은 0프레임에서 0.0cm.
 */
export function checkFrame0(rig: Rig, sent: Vec3[], res: KimodoResponse, frame = 0): { max: number; mean: number; worst: string } {
  const s = rig.soma;
  const names = (res.skeleton.model_input_skeleton?.joint_names ?? s.names).filter((n) => !/Hand(Thumb|Middle|Index|Ring|Pinky)/.test(n));
  const got = res.world_joint_positions[frame]!;
  let max = 0, sum = 0, worst = '';
  for (const n of names) {
    const j = s.idx(n);
    const e = length(sub(got[j]!, sent[j]!));
    sum += e;
    if (e > max) { max = e; worst = n; }
  }
  return { max, mean: sum / names.length, worst };
}

/** 키프레임 → 손으로 확인하기 쉬운 요약 (Hips 높이, 발 간격) */
export function keyframeSummary(rig: Rig, kf: KimodoKeyframe): { hipsY: number; footGap: number } {
  const local = kf.local_joints_rot.map((r) => {
    const a = length(r);
    return a < 1e-12 ? identityQ() : normalizeQ([...scale(r, Math.sin(a / 2) / a), Math.cos(a / 2)] as Quat);
  });
  const { P } = rig.soma.fk(local, kf.root_position);
  const s = rig.soma;
  return { hipsY: kf.root_position[1], footGap: length(sub(P[s.idx('LeftFoot')]!, P[s.idx('RightFoot')]!)) };
}

