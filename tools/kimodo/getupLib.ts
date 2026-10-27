// 겟업 라이브러리 도구 공통 (SPEC 12 v0.7): 쓰러진 자세 → Kimodo 요청(시작 키프레임 + 끝 서기 키프레임) → 포즈 클립 → 지면 맞춤·균형 복귀 시각.
// buildGetupLibrary.ts와 시험 도구가 쓴다.
import type { CharacterDef } from '../../src/sim/character/characterDef';
import { forwardKinematics, type BodyTransform, type PoseFile } from '../../src/sim/character/pose';
import { POSES } from '../../src/sim/character/poseLibrary';
import { type Vec3, add } from '../../src/sim/math/vec3';
import { type Quat, conjugate, multiplyQ, rotate, toRotationVector } from '../../src/sim/math/quat';
import { classifyFeature, poseFeature, type PostureClass } from '../../src/sim/character/getupFeatures';
import type { AnimClipFile } from '../../src/sim/character/animDriver';
import { Rig, transformFrame, type BodyFrame } from './rig';
import { generate, type GenerateRequest } from './client';
import { checkFrame0, fromPose, frameToSoma, poseFileFrame, type KimodoKeyframe } from './fromPose';
import { processResponse, type ClipSpec } from './candidates';
import type { PoseClipFile } from './toPoseClip';

export const GETUP_TEXT = 'a person gets up from the ground and stands still';

/** 바디 월드 자세 → BodyFrame (fromPose 입력) */
export const frameOf = (tf: readonly { pos: Vec3; rot: Quat }[]): BodyFrame => ({ hips: [...tf[0]!.pos] as Vec3, rot: tf.map((b) => [...b.rot] as Quat) });

/** 바디 형상의 가장 낮은 점 y (캡슐 양 끝 − 반지름, 구, 상자 꼭짓점; 추가 형상 포함). skip = 뺄 바디 이름 */
export function shapeMinY(def: CharacterDef, tf: readonly BodyTransform[], skip?: (name: string) => boolean): number {
  let lo = Infinity;
  def.bodies.forEach((b, i) => {
    if (skip?.(b.name)) return;
    const parts = [{ shape: b.shape, position: [0, 0, 0] as Vec3 }, ...(b.extraShapes ?? []).map((e) => ({ shape: e.shape, position: e.position }))];
    for (const pt of parts) {
      const c = add(tf[i]!.pos, rotate(tf[i]!.rot, pt.position));
      const s = pt.shape;
      if (s.type === 'sphere') lo = Math.min(lo, c[1] - s.radius);
      else if (s.type === 'capsule') {
        const ax = rotate(tf[i]!.rot, rotate(s.rotation, [0, s.halfHeight, 0]));
        lo = Math.min(lo, c[1] - Math.abs(ax[1]) - s.radius);
      } else {
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) lo = Math.min(lo, add(c, rotate(tf[i]!.rot, [sx * s.halfExtents[0], sy * s.halfExtents[1], sz * s.halfExtents[2]]))[1]);
      }
    }
  });
  return lo;
}

export function clipFK(def: CharacterDef, clip: Pick<AnimClipFile, 'frames'>): BodyTransform[][] {
  const hr = def.bodies[0]!.restRotation;
  return clip.frames.map((f) => forwardKinematics(def, f.joints, { pos: f.root.pos, rot: multiplyQ(f.root.rot, conjugate(hr)) }));
}

/**
 * 지면 맞춤: 겟업은 늘 무언가가 바닥에 닿아 있다(비행 없음). 프레임마다 우리 형상의 최저점이 y = 0이 되게 루트 높이를 옮긴다(5프레임 이동 평균).
 * 리타깃 높이 매핑(서기 기준)이 누운 자세에서 몸을 조금 띄우거나 묻는 것을 지워, 겟업 보조의 Hips 높이 목표가 몸을 띄우지 않게 한다.
 */
export function groundAlign(def: CharacterDef, clip: PoseClipFile): { maxShiftCm: number } {
  const fk = clipFK(def, clip);
  // 몸통(Hips·Spine·Spine2·Head)이 바닥을 뚫으면 그만큼 올리고, 몸 전체가 떠 있으면 내린다. 팔다리만 뚫는 것은 두어서
  // (Kimodo는 구르며 팔·다리를 바닥 아래 13cm까지 넣는다) 물리에서 그 팔다리가 바닥을 밀게 한다 — 몸 전체를 올리면 Hips 목표가 떠서 보조가 몸을 띄운다
  const TORSO = new Set(['Hips', 'Spine', 'Spine2', 'Head']);
  const raw = fk.map((tf) => { const tm = shapeMinY(def, tf, (n) => !TORSO.has(n)); return tm < 0 ? tm : Math.max(0, shapeMinY(def, tf)); });
  const n = raw.length;
  let maxShift = 0;
  const sm = raw.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) { s += raw[k]!; c++; } return s / c; });
  clip.frames.forEach((f, i) => {
    // 0프레임은 실제 물리 자세 그대로 (보낸 키프레임) — 앞 10프레임에 걸쳐 맞춤을 들인다
    const w = Math.min(1, i / 10);
    const d = sm[i]! * w;
    maxShift = Math.max(maxShift, Math.abs(d));
    f.root.pos = [f.root.pos[0], Math.round((f.root.pos[1] - d) * 1e6) / 1e6, f.root.pos[2]];
  });
  return { maxShiftCm: maxShift * 100 };
}

/**
 * 균형 복귀 시각: 이 프레임부터 끝까지 두 발이 접촉(클립 플래그)이고 발이 아닌 바디가 모두 clear m 위에 있는 첫 프레임.
 * 없으면 끝 프레임
 */
export function balanceTauOf(def: CharacterDef, clip: PoseClipFile, clear = 0.08, kneeClear = 0.2, maxTiltDeg = 35): number {
  const fk = clipFK(def, clip);
  const ix = (n: string) => def.bodies.findIndex((b) => b.name === n);
  // 정강이 캡슐 아래 끝은 서 있어도 발목 근처(3~4cm)라 무릎 점(정강이 관절)으로 본다
  const knee = (tf: BodyTransform[], n: string) => { const b = def.bodies[ix(n)]!; return add(tf[ix(n)]!.pos, rotate(tf[ix(n)]!.rot, b.joint!.anchorInChild))[1]; };
  const ok = clip.frames.map((f, i) => !!f.contacts.LeftFoot && !!f.contacts.RightFoot
    && shapeMinY(def, fk[i]!, (n) => /Foot$|^(Left|Right)Leg$/.test(n)) > clear && knee(fk[i]!, 'LeftLeg') > kneeClear && knee(fk[i]!, 'RightLeg') > kneeClear
    // 몸통이 어느 정도 선 뒤(Spine2 기울기 < maxTiltDeg): 애니 추종 QP(걷기 추종)는 몸통 50° 넘게 숙이면 스텝 계층에 넘긴다
    && Math.acos(Math.max(-1, Math.min(1, rotate(fk[i]![ix('Spine2')]!.rot, [0, 1, 0])[1]))) * 180 / Math.PI < maxTiltDeg);
  let k = ok.length - 1;
  while (k > 0 && ok[k - 1]) k--;
  return k / clip.fps;
}

/**
 * 관절 목표 튐 없애기: 한 프레임(1/30초)에 maxDegPerFrame 넘게 바뀌는 관절은 앞 프레임 값을 유지한다.
 * 손목 비틀기(±90°)가 제한 자르기(clampJoints)에서 −90 ↔ +90으로 뒤집히면 목표가 180° 튀어 손이 60 rad/s로 돌았다(폭발 판정)
 */
export function removeJointFlips(clip: PoseClipFile, maxDegPerFrame = 35): number {
  let fixed = 0;
  const lim = Math.cos((maxDegPerFrame * Math.PI) / 360);
  for (let i = 1; i < clip.frames.length; i++) {
    const a = clip.frames[i - 1]!.joints, b = clip.frames[i]!.joints;
    for (const k of Object.keys(b) as (keyof typeof b)[]) {
      const p = a[k], q = b[k];
      if (!p || !q) continue;
      const d = Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]);
      if (d < lim) { b[k] = [...p] as Quat; fixed++; }
    }
  }
  return fixed;
}

export type EndMode = 'feet' | 'head';

/** 끝 서기 키프레임: 서기 포즈를 정면 yaw로 돌려 놓는다 (시작 키프레임과 같은 정규화 공간) */
export function endKeyframe(rig: Rig, startFrameCanonical: BodyFrame, mode: EndMode, frame: number): { kf: KimodoKeyframe; yaw: number; at: [number, number] } {
  const def = rig.def;
  const P = rig.positions(startFrameCanonical);
  const ix = (n: string) => def.bodies.findIndex((b) => b.name === n);
  const feet: [number, number] = [(P[ix('LeftFoot')]![0] + P[ix('RightFoot')]![0]) / 2, (P[ix('LeftFoot')]![2] + P[ix('RightFoot')]![2]) / 2];
  const head = P[ix('Head')]!;
  const hip = rig.hipMid(startFrameCanonical);
  // 누움·옆: 발 쪽을 보고 엉덩이와 발 사이에 선다. 엎드림: 머리 쪽을 보고 엉덩이 자리에 선다
  const dir = mode === 'head' ? [head[0] - hip[0], head[2] - hip[2]] : [feet[0] - hip[0], feet[1] - hip[2]];
  const yaw = Math.atan2(dir[0]!, dir[1]!);
  const at: [number, number] = mode === 'head' ? [hip[0], hip[2]] : [(hip[0] + feet[0]) / 2, (hip[2] + feet[1]) / 2];
  const lib = POSES as Record<string, PoseFile>;
  const stand = poseFileFrame(rig, lib.stand!, lib);
  const sm = rig.hipMid(stand);
  const sw = transformFrame(transformFrame(stand, 0, [-sm[0], 0, -sm[2]]), yaw, [at[0], 0, at[1]]);
  const so = frameToSoma(rig, sw);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { kf: { frame, root_position: so.root.map(r6) as Vec3, local_joints_rot: so.local.map((q) => toRotationVector(q).map(r6) as Vec3) }, yaw, at };
}

export interface GetupGen {
  clip: PoseClipFile;
  frame0ErrCm: number;
  balanceTau: number;
  feetTau: number;
  groundShiftCm: number;
  posture: PostureClass;
  dir: string;
  cached: boolean;
}

/** 쓰러진 자세 하나 → Kimodo 겟업 클립 (생성은 캐시, 요청은 한 번에 하나) */
export async function generateGetup(rig: Rig, tf: readonly { pos: Vec3; rot: Quat }[], o: { name: string; seed: number; mode: EndMode; durationS: number; text?: string; model?: string; clipName: string }): Promise<GetupGen> {
  const def = rig.def;
  const start = fromPose(rig, frameOf(tf));
  const N = Math.round(o.durationS * 30);
  const end = endKeyframe(rig, start.frame, o.mode, N - 1);
  const text = o.text ?? GETUP_TEXT;
  const model = o.model ?? 'rp12';
  const req: GenerateRequest = { text, num_frames: N, seed: o.seed, constraints: { keyframes: [start.keyframe, end.kf] } };
  const g = await generate(o.name, model, req, { log: () => {} });
  const lib = POSES as Record<string, PoseFile>;
  const stand = poseFileFrame(rig, lib.stand!, lib);
  const spec: ClipSpec = { clip: o.name, label: '겟업', text, duration_s: o.durationS, models: [model], seeds: [o.seed], rootMotion: 'kept' };
  const p = processResponse(rig, spec, g.res, model, o.seed, start, stand);
  const clip = p.clip;
  clip.name = o.clipName;
  const flips = removeJointFlips(clip);
  const gs = groundAlign(def, clip);
  const balanceTau = balanceTauOf(def, clip);
  const feetTau = Math.min(balanceTau, balanceTauOf(def, clip, 0.08, 0.2, 180));
  const f0 = checkFrame0(rig, start.positions, g.res);
  const feat = poseFeature(def, clipFK(def, clip)[0]!);
  clip.info = { ...clip.info, getup: { mode: o.mode, endYaw: end.yaw, endAt: end.at, balanceTau, feetTau, groundShiftCm: gs.maxShiftCm, frame0ErrCm: f0.max * 100, jointFlipsFixed: flips } };
  return { clip, frame0ErrCm: f0.max * 100, balanceTau, feetTau, groundShiftCm: gs.maxShiftCm, posture: classifyFeature(feat), dir: g.dir, cached: g.cached };
}
