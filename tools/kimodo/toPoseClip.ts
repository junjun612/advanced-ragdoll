// Kimodo 응답(SOMA77) → 우리 16바디 포즈 클립 (SPEC 11.1, 11.3).
// 순서: SOMA FK → 바디 월드 회전(rest 보정, rig.ts) → 루트 매핑 → 경첩 투영 → 발 접촉 정리 → 발 고정 IK → 정면·원점 정규화.
// 루프 자르기·루트 모션 제거는 loop.ts. 저장 형식은 PoseClipFile.
import type { BodyName, CharacterDef } from '../../src/sim/character/characterDef';
import type { JointName } from '../../src/sim/types';
import { type Vec3, add, sub, scale, length } from '../../src/sim/math/vec3';
import { type Quat, multiplyQ, normalizeQ, fromAxisAngle, fromTo, rotate } from '../../src/sim/math/quat';
import { type KimodoResponse, Soma } from './soma';
import {
  type BodyFrame, type KimodoConfig, Rig, SIDES, type Side, hemisphere, headingOf, transformFrame, loadDef, loadKimodoConfig,
} from './rig';

/** assets/poses/<clip>.json (SPEC 11.1) */
export interface PoseClipFile {
  name: string;
  source: string;
  fps: number;
  loop: boolean;
  rootMotion: 'removed' | 'kept';
  /** 관절 값의 뜻: 관절 좌표계(frameInParent/frameInChild) 기준 상대 회전 [x,y,z,w], 우리 rest(A포즈) = 항등. src/sim/character/pose.ts forwardKinematics의 targets와 같다 */
  jointConvention: 'jointFrameRelRest';
  /** root = Hips 바디 원점의 월드 위치·회전 */
  frames: { root: { pos: Vec3; rot: Quat }; joints: Partial<Record<JointName, Quat>>; contacts: { LeftFoot: boolean; RightFoot: boolean } }[];
  /** 루프 + 루트 모션 kept: 한 바퀴 뒤 0프레임이 놓일 자리 = 0프레임을 yaw(라디안)만큼 Y축 회전한 뒤 pos만큼 옮긴 것 */
  loopRootDelta?: { pos: Vec3; yaw: number };
  /** 생성 정보와 품질 기록 (선택) */
  info?: Record<string, unknown>;
}

export interface FootContact { heel: boolean; toe: boolean }
export type Contacts = Record<Side, FootContact>[];

export interface RetargetResult {
  frames: BodyFrame[];
  /** 발 고정 전 (점수: 원래 미끄러짐) */
  rawFrames: BodyFrame[];
  contacts: Contacts;
  /** 우리 바디로 바꾼 뒤 손·발 위치와 스케일한 소스 위치 차이 (m), 프레임별 평균 */
  retargetErr: number[];
  /** SOMA FK와 응답 world_joint_positions 최대 차이 (m) */
  fkMaxErr: number;
  /** 발 고정 IK가 발목을 옮긴 양 (m), 프레임별 최대 */
  lockCorrection: number[];
  /** 제한 자르기(retarget.clampJoints, 손목)로 바뀐 각 (도), 프레임별 최대 */
  clampDeg: number[];
  /** 정규화 변환 (yaw, 이동) — 소스 좌표를 우리 클립 좌표로 */
  canonical: { yaw: number; off: Vec3 };
}

export interface RetargetOptions {
  footLock?: boolean;
  /** 0프레임을 원점·정면 +Z로 옮긴다 (기본 true) */
  canonicalize?: boolean;
}

/** Kimodo 6채널 → 발별 heel/toe, 짧은 깜빡임(minRun 미만 구간)을 이웃 값으로 메운다 */
export function contactsFromKimodo(res: KimodoResponse, minRun: number): Contacts {
  const T = res.root_positions.length;
  const fc = res.foot_contacts;
  const ch = (c: number): boolean[] => Array.from({ length: T }, (_, t) => !!fc?.[t]?.[c]);
  const six = (fc?.[0]?.length ?? 6) >= 6;
  const L = { heel: cleanFlicker(ch(0), minRun), toe: cleanFlicker(ch(1), minRun) };
  const R = { heel: cleanFlicker(ch(six ? 3 : 2), minRun), toe: cleanFlicker(ch(six ? 4 : 3), minRun) };
  return Array.from({ length: T }, (_, t) => ({
    Left: { heel: L.heel[t]!, toe: L.toe[t]! },
    Right: { heel: R.heel[t]!, toe: R.toe[t]! },
  }));
}

/** 길이 minRun 미만인 구간(양 끝 구간 제외)을 뒤집는다. 짧은 끊김 먼저 메우고, 그다음 짧은 접촉을 지운다 */
export function cleanFlicker(flags: readonly boolean[], minRun: number): boolean[] {
  const out = flags.slice();
  for (const target of [false, true]) {
    let i = 0;
    while (i < out.length) {
      let j = i;
      while (j + 1 < out.length && out[j + 1] === out[i]) j++;
      const interior = i > 0 && j < out.length - 1;
      if (out[i] === target && interior && j - i + 1 < minRun) for (let k = i; k <= j; k++) out[k] = !target;
      i = j + 1;
    }
  }
  return out;
}

export const footDown = (c: FootContact): boolean => c.heel || c.toe;

/**
 * Kimodo 라벨은 걷기에서 양발 지지 구간을 거의 안 찍고 1~3프레임 양발이 떨어진 것으로 나온다 (2026-10-26 확인).
 * 라벨이 없더라도 발 박스 아래 꼭짓점이 geomHeightM 안이고 수평 속도가 geomSpeed 미만이면 발가락 접촉으로 더한다.
 */
export function addGeometricContacts(rig: Rig, frames: BodyFrame[], contacts: Contacts, fps: number): void {
  const { geomHeightM, geomSpeed } = rig.cfg.contacts;
  for (const side of SIDES) {
    const i = rig.idx(`${side}Foot` as BodyName);
    const sh = rig.bodies[i]!.shape;
    if (sh.type !== 'box') continue;
    // 발 박스 아래 꼭짓점 4개 (발뒤꿈치·발끝 양쪽)
    const corners = frames.map((f) => {
      const p = rig.positions(f)[i]!;
      const out: Vec3[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(add(p, rotate(f.rot[i]!, [sx * sh.halfExtents[0], -sh.halfExtents[1], sz * sh.halfExtents[2]])));
      return out;
    });
    frames.forEach((_, t) => {
      const c = contacts[t]![side];
      if (c.heel || c.toe) return;
      const t0 = Math.max(0, t - 1), t1 = Math.min(frames.length - 1, t + 1);
      // 땅 가까이 있으면서 거의 멈춘 꼭짓점이 하나라도 있으면 접촉 (발끝을 축으로 구르는 순간 포함)
      const planted = corners[t]!.some((q, k) => {
        if (q[1] >= geomHeightM) return false;
        const a = corners[t0]![k]!, b = corners[t1]![k]!;
        return t1 > t0 && (Math.hypot(b[0] - a[0], b[2] - a[2]) * fps) / (t1 - t0) < geomSpeed;
      });
      if (planted) c.toe = true; // 뒤꿈치 고정(footLock)에는 쓰지 않는다: 발끝 구르기 중 발목은 움직인다
    });
  }
}

/** 구간 목록 [시작, 끝] (끝 포함) */
export function runsOf(flags: readonly boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let a = -1;
  flags.forEach((v, t) => {
    if (v && a < 0) a = t;
    if (!v && a >= 0) { out.push([a, t - 1]); a = -1; }
  });
  if (a >= 0) out.push([a, flags.length - 1]);
  return out;
}

export function retarget(rig: Rig, res: KimodoResponse, opts: RetargetOptions = {}): RetargetResult {
  const soma = rig.soma;
  const T = res.root_positions.length;
  let fkMaxErr = 0;
  const raw: BodyFrame[] = [];
  const retargetErr: number[] = [];
  const effSoma: Record<string, number> = {
    LeftHand: soma.idx('LeftHand'), RightHand: soma.idx('RightHand'), LeftFoot: soma.idx('LeftFoot'), RightFoot: soma.idx('RightFoot'),
  };
  for (let t = 0; t < T; t++) {
    const { G, P } = soma.fkFrame(res, t);
    const wp = res.world_joint_positions[t];
    if (wp) P.forEach((p, j) => { fkMaxErr = Math.max(fkMaxErr, length(sub(p, wp[j]!))); });
    let f = rig.fromSoma(G, P);
    if (rig.cfg.retarget.hingeProject) f = rig.projectHinges(f);
    raw.push(f);
    // 리타깃 오차: 손목·발목 관절 위치 vs 소스 점을 고관절 중점 기준 s배 한 위치
    const srcMid = scale(add(P[soma.idx('LeftLeg')]!, P[soma.idx('RightLeg')]!), 0.5);
    const ours = rig.endEffectors(f);
    const mid = rig.hipMid(f);
    let e = 0;
    for (const [k, j] of Object.entries(effSoma)) e += length(sub(ours[k]!, rig.mapPoint(P[j]!, srcMid, mid)));
    retargetErr.push(e / 4);
  }
  hemisphere(raw);

  const contacts = contactsFromKimodo(res, rig.cfg.contacts.minRunFrames);
  addGeometricContacts(rig, raw, contacts, res.fps);
  const useLock = opts.footLock ?? rig.cfg.footLock.enabled;
  const { frames: locked, correction } = useLock ? footLock(rig, raw, contacts) : { frames: raw.map(cloneFrame), correction: raw.map(() => 0) };

  const clampDeg: number[] = [];
  const clamped = groundClamp(rig, locked).map((f) => {
    const c = rig.clampJoints(f, rig.cfg.retarget.clampJoints);
    clampDeg.push(c.clampDeg);
    return c.frame;
  });
  let canonical = { yaw: 0, off: [0, 0, 0] as Vec3 };
  if (opts.canonicalize ?? true) canonical = canonicalTransform(rig, locked[0]!);
  const apply = (f: BodyFrame) => transformFrame(f, canonical.yaw, canonical.off);
  return {
    frames: clamped.map(apply), rawFrames: raw.map(apply), contacts, retargetErr, fkMaxErr, lockCorrection: correction, clampDeg, canonical,
  };
}

export const cloneFrame = (f: BodyFrame): BodyFrame => ({ hips: [...f.hips] as Vec3, rot: f.rot.map((q) => [...q] as Quat) });

/** 0프레임 고관절 중점 xz를 원점으로, Hips 정면을 +Z로 */
export function canonicalTransform(rig: Rig, f0: BodyFrame): { yaw: number; off: Vec3 } {
  const yaw = -headingOf(f0.rot[0]!);
  const m = rotate(fromAxisAngle([0, 1, 0], yaw), rig.hipMid(f0));
  return { yaw, off: [-m[0], 0, -m[2]] };
}

/**
 * 발 고정: 뒤꿈치 접촉 구간마다 발목 관절을 구간 평균 위치에 고정한다(무릎 경첩 각 + 허벅지 방향, 발 월드 회전 유지).
 * 발바닥이 snapMaxM 안이면 높이도 y=0에 붙인다. 구간 앞뒤 blendFrames는 원래 위치와 섞는다.
 */
export function footLock(rig: Rig, frames: BodyFrame[], contacts: Contacts): { frames: BodyFrame[]; correction: number[] } {
  const { blendFrames: B, snapMaxM } = rig.cfg.footLock;
  const out = frames.map(cloneFrame);
  const correction = frames.map(() => 0);
  for (const side of SIDES) {
    const iFoot = rig.idx(`${side}Foot` as BodyName);
    const runs = runsOf(contacts.map((c) => c[side].heel));
    const natural = frames.map((f) => rig.jointPositions(f)[iFoot]!);
    for (const [a, b] of runs) {
      let tgt: Vec3 = [0, 0, 0];
      let sole = 0;
      for (let t = a; t <= b; t++) { tgt = add(tgt, natural[t]!); sole += rig.soleY(frames[t]!, side); }
      tgt = scale(tgt, 1 / (b - a + 1));
      sole /= b - a + 1;
      if (Math.abs(sole) <= snapMaxM) tgt = [tgt[0], tgt[1] - sole, tgt[2]];
      for (let t = Math.max(0, a - B); t <= Math.min(frames.length - 1, b + B); t++) {
        const w = t < a ? 1 - (a - t) / (B + 1) : t > b ? 1 - (t - b) / (B + 1) : 1;
        const s = w * w * (3 - 2 * w);
        const want = add(natural[t]!, scale(sub(tgt, natural[t]!), s));
        out[t] = solveLeg(rig, out[t]!, side, want);
        correction[t] = Math.max(correction[t]!, length(sub(rig.jointPositions(out[t]!)[iFoot]!, natural[t]!)));
      }
    }
  }
  return { frames: out, correction };
}

/**
 * 지면 관통 정리: 발 박스 최저점이 y < 0이면 그만큼 발목을 올린다(다리 IK, 발 회전 유지).
 * Kimodo 발은 발가락 관절로 접히지만 우리 발은 한 덩어리 박스라, 발끝으로 구를 때 박스 앞 모서리가 바닥 아래로 들어간다.
 */
export function groundClamp(rig: Rig, frames: BodyFrame[]): BodyFrame[] {
  return frames.map((f0) => {
    let f = f0;
    for (const side of SIDES) {
      const y = rig.soleY(f, side);
      if (y >= 0) continue;
      const iFoot = rig.idx(`${side}Foot` as BodyName);
      const a = rig.jointPositions(f)[iFoot]!;
      f = solveLeg(rig, f, side, [a[0], a[1] - y, a[2]]);
    }
    return f;
  });
}

/** 다리 IK: 발목 관절을 want로. 무릎(경첩) 각을 이분법으로 거리에 맞추고 허벅지를 최소 회전으로 돌린다. 발 월드 회전은 유지 */
export function solveLeg(rig: Rig, f: BodyFrame, side: Side, want: Readonly<Vec3>): BodyFrame {
  const iUp = rig.idx(`${side}UpLeg` as BodyName), iKnee = rig.idx(`${side}Leg` as BodyName), iFoot = rig.idx(`${side}Foot` as BodyName);
  const kneeDef = rig.bodies[iKnee]!;
  const hip = rig.jointPositions(f)[iUp]!;
  const d = length(sub(want, hip));
  const ankleWith = (theta: number, upRot: Quat): { rot: Quat[]; ankle: Vec3 } => {
    const rot = f.rot.slice();
    rot[iUp] = upRot;
    rot[iKnee] = rig.childOf(upRot, fromAxisAngle([1, 0, 0], theta), kneeDef);
    const ff = { hips: f.hips, rot };
    return { rot, ankle: rig.jointPositions(ff)[iFoot]! };
  };
  const lim = (kneeDef.joint!.limitsDeg.flex ?? [0, 140]).map((x) => (x * Math.PI) / 180) as [number, number];
  const distAt = (th: number) => length(sub(ankleWith(th, f.rot[iUp]!).ankle, hip));
  let lo = lim[0], hi = lim[1];
  if (distAt(lo) <= d) hi = lo; // 다 펴도 닿지 않으면 편 채로
  else if (distAt(hi) >= d) lo = hi;
  for (let k = 0; k < 40 && hi - lo > 1e-6; k++) {
    const m = (lo + hi) / 2;
    if (distAt(m) > d) lo = m; else hi = m;
  }
  const theta = (lo + hi) / 2;
  const cur = ankleWith(theta, f.rot[iUp]!).ankle;
  const swing = fromTo(sub(cur, hip), sub(want, hip));
  const { rot } = ankleWith(theta, normalizeQ(multiplyQ(swing, f.rot[iUp]!)));
  return { hips: f.hips, rot };
}

/** 바디 프레임 → 클립 프레임 */
export function toClipFrames(rig: Rig, frames: BodyFrame[], contacts: Contacts): PoseClipFile['frames'] {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return frames.map((f, t) => {
    const joints = rig.jointRel(f);
    for (const k of Object.keys(joints) as JointName[]) joints[k] = joints[k]!.map(r6) as Quat;
    return {
      root: { pos: f.hips.map(r6) as Vec3, rot: f.rot[0]!.map(r6) as Quat },
      joints,
      contacts: { LeftFoot: footDown(contacts[t]!.Left), RightFoot: footDown(contacts[t]!.Right) },
    };
  });
}

/** 클립 프레임 → 바디 프레임 (FK) */
export function fromClipFrames(rig: Rig, clip: Pick<PoseClipFile, 'frames'>): BodyFrame[] {
  return clip.frames.map((fr) => {
    // root.rot은 Hips 바디 월드 회전 = rootRot · restRotation(Hips). xbot Hips rest = 항등이지만 일반식으로 되돌린다
    const hipsRest = rig.bodies[0]!.restRotation;
    const rootRot = multiplyQ(fr.root.rot, [-hipsRest[0], -hipsRest[1], -hipsRest[2], hipsRest[3]]);
    return rig.fromJointRel(fr.root.pos, rootRot, fr.joints);
  });
}

export function makeRig(res: Pick<KimodoResponse, 'skeleton'>, def?: CharacterDef, cfg?: KimodoConfig): Rig {
  return new Rig(def ?? loadDef(), new Soma(res.skeleton), cfg ?? loadKimodoConfig());
}
