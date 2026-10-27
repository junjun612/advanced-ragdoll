// 목표 포즈와 목표 클립 (SPEC v0.2 "목표 포즈", 11.1). 형식과 규약은 docs/ALGORITHMS.md "목표 포즈".
// - 관절 목표는 관절 좌표계(X=flex, Y=twist, Z=side, docs/RAGDOLL_CONFIG.md 3장)의 회전 벡터(도)다. rest = 0.
//   단축 회전이면 그 축의 각과 같다. 내부 표현은 "정의 관절 좌표계 기준 상대 회전" 사원수 r_def (rest = 항등).
// - 클립은 키프레임을 slerp로 잇는다. 빠진 관절은 base 포즈 값, base도 없으면 rest.
import type { CharacterDef, BodyName } from './characterDef';
import { type Vec3, add, sub } from '../math/vec3';
import { type Quat, conjugate, fromRotationVector, identityQ, multiplyQ, rotate, slerp } from '../math/quat';

export type JointName = Exclude<BodyName, 'Hips'>;
export interface PoseJointDeg {
  flex?: number;
  twist?: number;
  side?: number;
}
export type PoseJointsDeg = Partial<Record<JointName, PoseJointDeg>>;

/** config/poses/<name>.json */
export interface PoseFile {
  name: string;
  /** 빠진 관절을 채울 포즈 이름 */
  base?: string;
  /** 정적 포즈 */
  joints?: PoseJointsDeg;
  /** 클립: 키프레임 간격 = 1/fps */
  fps?: number;
  loop?: boolean;
  frames?: { joints: PoseJointsDeg }[];
}

export type JointTargets = Partial<Record<JointName, Quat>>;

const RAD = Math.PI / 180;

export function jointDegToQuat(d: PoseJointDeg): Quat {
  return fromRotationVector([(d.flex ?? 0) * RAD, (d.twist ?? 0) * RAD, (d.side ?? 0) * RAD]);
}

function toTargets(j: PoseJointsDeg | undefined): JointTargets {
  const out: JointTargets = {};
  for (const [k, v] of Object.entries(j ?? {})) if (!k.startsWith('$') && v) out[k as JointName] = jointDegToQuat(v);
  return out;
}

/** 포즈·클립 하나. sample(t)는 정의 관절 좌표계 기준 상대 회전(빠진 관절 = base 또는 rest). */
export class PoseClip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  private readonly frames: JointTargets[];
  private readonly fps: number;
  private readonly base: JointTargets;

  constructor(file: PoseFile, library: Readonly<Record<string, PoseFile>>) {
    this.name = file.name;
    let base: JointTargets = {};
    if (file.base) {
      const b = library[file.base];
      if (!b) throw new Error(`pose '${file.name}': unknown base '${file.base}'`);
      base = new PoseClip(b, library).sample(0);
    }
    this.base = base;
    if (file.frames?.length) {
      if (!file.fps || file.fps <= 0) throw new Error(`pose '${file.name}': frames need fps > 0`);
      this.frames = file.frames.map((f) => ({ ...base, ...toTargets(f.joints) }));
      this.fps = file.fps;
      this.loop = file.loop ?? false;
      this.duration = this.loop ? this.frames.length / this.fps : (this.frames.length - 1) / this.fps;
    } else {
      this.frames = [{ ...base, ...toTargets(file.joints) }];
      this.fps = 1;
      this.loop = false;
      this.duration = 0;
    }
  }

  /** t초의 관절 목표. 루프면 마지막 프레임 → 첫 프레임도 보간한다. */
  sample(t: number): JointTargets {
    const n = this.frames.length;
    if (n === 1) return this.frames[0]!;
    let x = t * this.fps;
    if (this.loop) x = ((x % n) + n) % n;
    else x = Math.max(0, Math.min(n - 1, x));
    const i = Math.floor(x), f = x - i;
    const a = this.frames[i % n]!, b = this.frames[(i + 1) % n]!;
    if (f === 0) return a;
    const out: JointTargets = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<JointName>)
      out[k] = slerp(a[k] ?? identityQ(), b[k] ?? identityQ(), f);
    return out;
  }
}

export interface BodyTransform {
  pos: Vec3;
  rot: Quat;
}

/**
 * 순기구학: 관절 목표(정의 관절 좌표계 상대 회전)로 바디 월드 자세를 만든다. 루트(Hips)는 root 변환을 그대로 쓴다.
 * q_child = q_parent · frameInParent · r · frameInChild⁻¹,  p_child = (p_parent + q_parent·anchorInParent) − q_child·anchorInChild
 * (rest에서 frameInParent·frameInChild⁻¹ = restRot_parent⁻¹·restRot_child 이므로 r = 항등이면 rest 자세)
 */
export function forwardKinematics(def: CharacterDef, targets: JointTargets, root: BodyTransform): BodyTransform[] {
  const out: BodyTransform[] = [];
  const idx = new Map<BodyName, number>();
  def.bodies.forEach((b, i) => {
    idx.set(b.name, i);
    if (b.parent === null || !b.joint) {
      out.push({ pos: root.pos, rot: multiplyQ(root.rot, b.restRotation) });
      return;
    }
    const pi = idx.get(b.parent);
    if (pi === undefined) throw new Error(`body ${b.name} listed before its parent ${b.parent}`);
    const p = out[pi]!;
    const j = b.joint;
    const r = targets[b.name as JointName] ?? identityQ();
    const rot = multiplyQ(multiplyQ(p.rot, j.frameInParent), multiplyQ(r, conjugate(j.frameInChild)));
    const anchor = add(p.pos, rotate(p.rot, j.anchorInParent));
    out.push({ pos: sub(anchor, rotate(rot, j.anchorInChild)), rot });
  });
  return out;
}

/** 발 박스 꼭짓점 중 가장 낮은 y (발바닥 높이). 박스 발이 없으면 모든 바디 원점 중 최저. */
export function lowestFootY(def: CharacterDef, tf: readonly BodyTransform[]): number {
  let lo = Infinity;
  def.bodies.forEach((b, i) => {
    if (b.shape.type !== 'box') return;
    const h = b.shape.halfExtents;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const w = add(tf[i]!.pos, rotate(tf[i]!.rot, [sx * h[0], sy * h[1], sz * h[2]]));
      lo = Math.min(lo, w[1]);
    }
  });
  if (lo === Infinity) for (const t of tf) lo = Math.min(lo, t.pos[1]);
  return lo;
}
