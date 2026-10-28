// 캐릭터 설정(SPEC 6.4) → Rapier 바디·콜라이더·관절. 규약은 docs/RAGDOLL_CONFIG.md, 방식은 docs/SPIKE.md(v0.0 결론).
// - 관절: 구형 = JointData.spherical + raw jointSetLimits(AngX/Y/Z), 경첩 = revolute (+ 같은 raw 제한).
//   관절 좌표계(X=flex, Y=twist, Z=side)는 setLocalFrame1/2로 건다. Rapier 제한 좌표는 2·asin(상대 쿼터니언 성분).
// - 어깨 스윙 콘: 부모 쪽 관절 좌표계를 콘 축(T-포즈 상완 방향)으로 돌려서 0점을 콘 축에 두고,
//   flex·side 두 축을 ±콘 반각 상자로 근사한다(스파이크와 같은 방식). rest A포즈는 side 축으로 콘 안쪽에 있다.
// - 인접 바디 충돌 끔, 나머지 자기 충돌 켬, 반발 0, 마찰은 바디 설정값.
import type R from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../world';
import { R as Rapier } from '../world';
import type { BodyDef, BodyName, CharacterDef, JointDef, ShapeDef } from './characterDef';
import { type Vec3, add, scale } from '../math/vec3';
import { type Quat, conjugate, fromAxisAngle, fromTo, multiplyQ, rotate } from '../math/quat';

export interface RagdollBodyConfig {
  angularDamping?: number;
  linearDamping?: number;
  inertiaScale?: number;
  /** 부모와 잇는 관절의 수동 점성 마찰 (N·m·s/rad). Rapier 모터(ForceBased, stiffness 0, 목표 속도 0)로 건다 → 솔버 안에서 암시적으로 풀린다 */
  jointDamping?: number;
}

export interface RagdollConfig {
  restitution: number;
  defaultLinearDamping: number;
  defaultAngularDamping: number;
  /** 관절 수동 점성 마찰 기본값 (N·m·s/rad). 바디별 jointDamping이 덮어쓴다 */
  defaultJointDamping: number;
  /** 연속 충돌 검출 (shape-cast + 서브스텝). 빠른 낙하 착지에서 관통 → 튕김 방지 */
  ccd: boolean;
  /** soft-CCD 예측 거리(m). 0이면 끔 */
  softCcdPrediction: number;
  bodies: Partial<Record<BodyName, RagdollBodyConfig>>;
  /** 서로 충돌하지 않을 바디 쌍 (v0.4: 허벅지끼리 — 교차 스텝에서 캡슐이 실제 허벅지보다 굵고 단단해 다리가 서로 막힌다, README 결정 57) */
  noCollidePairs?: [BodyName, BodyName][];
  /** 어깨 가동 범위 (사람 ROM, 수동 조직 끝 저항). 없으면 끔. 정의 docs/ALGORITHMS.md '어깨 가동 범위' */
  shoulderRom?: ShoulderRomConfig;
}

/**
 * 어깨 가동 범위 (README 결정 171): X Bot 어깨(스윙 콘 100° + 비틀기 ±70°, Rapier 축별 2·asin 상자)는 비틀기와 섞여 팔이 몸통 뒤 어느 방향으로도
 * 가는(폄 150° 넘음) 사실상 무제한이라, 사람 문헌값(폄 50~60°, 수평 벌림 뒤로 약 45°, 굽힘 끝 약 10° 뒤, 수평 모음 앞 넘어 약 45°)을 넘는 만큼
 * 수동 조직(관절낭·인대) 끝 저항 토크를 몸 안 짝 토크(Spine2 ↔ 위팔)로 건다. 바깥 힘이 아니라 관절의 일부다.
 */
export interface ShoulderRomConfig {
  /** 몸통 관상면 뒤로 갈 수 있는 팔 각(도): 팔이 아래일 때(폄), 수평일 때(수평 벌림), 위일 때(굽힘 끝). 그 사이는 팔 높이로 선형 */
  behindDownDeg: number; behindHorizDeg: number; behindUpDeg: number;
  /** 시상면 넘어 반대쪽으로 갈 수 있는 팔 각(도) (수평 모음 135° = 앞 넘어 45°) */
  crossDeg: number;
  /** 넘은 각에 대한 강성(N·m/rad), 들어가는 쪽 각속도 감쇠(N·m·s/rad), 토크 상한(N·m) */
  stiffness: number; damping: number; maxTorque: number;
  /** (결정 rom-2) 감쇠를 넘은 각 0 → rampDeg에서 0 → 1로 키운다 (없으면 경계에서 바로 전부). 사람 연조직 저항은 끝에 가까워질수록 커진다 — 경계에서 감쇠가 계단처럼 켜지면 빠른 팔 흔들기(뒤로 걷기)에 한 스텝 300 N·m가 몸통을 쳤다 */
  dampRampDeg?: number;
  /** (결정 rom-3) 강성도 넘은 각 0 → stiffRampDeg에서 0 → k로 키운다(스프링 = k·e²/(2·e0), 그 뒤 k·(e − e0/2)): 경계 근처 작은 넘침은 저항이 작고 깊어질수록 커진다 */
  stiffRampDeg?: number;
}

/** 어깨 범위 상태 (로그): 넘은 각(도, 뒤·반대쪽 중 큰 것)과 건 토크(N·m) */
export interface ShoulderRomState { excessDeg: number; torque: number }

export interface Spawn {
  position: Vec3;
  /** Y축 회전(라디안) */
  yaw: number;
  /** 바디별 월드 자세 (def.bodies 순서). 주면 position·yaw 대신 이 값으로 만든다 (목표 포즈로 스폰, pose.ts) */
  transforms?: { pos: Vec3; rot: Quat }[];
  /** 고정(Fixed) 바디로 만들 바디 (테스트 고정: hold_pose_pinned 등). 보조 힘이 아니라 시험 장치다 */
  pin?: BodyName[];
  /**
   * (v0.8c) 여러 캐릭터 월드에서 이 캐릭터의 충돌 그룹 비트 (0 = 혼자, 기존 그대로). 충돌 제외 쌍(설정·실행 중)에 든 바디는 소속에 이 비트를 더하고
   * 필터에서 이 비트를 뺀다 → 자기 몸 안의 제외 쌍은 그대로 막히고, 다른 캐릭터의 같은 비트 바디와는 계속 충돌한다 (README 결정, interaction.ts)
   */
  charBit?: number;
}

export interface RagdollBody {
  name: BodyName;
  def: BodyDef;
  idx: number;
  parentIdx: number;
  rb: R.RigidBody;
  /** 주 콜라이더 (= cols[0]) */
  col: R.Collider;
  /** 주 콜라이더 + 추가 콜라이더 (복합 형상) */
  cols: R.Collider[];
}

/** [lo, hi] (rad) 축별 제한. null = 제한 없음 */
export type AxisLimits = [[number, number] | null, [number, number] | null, [number, number] | null];

export interface RagdollJoint {
  name: Exclude<BodyName, 'Hips'>;
  def: JointDef;
  parent: number;
  child: number;
  imp: R.ImpulseJoint;
  /** 실제로 Rapier에 건 관절 좌표계 (바디 로컬). 어깨는 콘 축으로 돌린 값 */
  frameP: Quat;
  frameC: Quat;
  /** Rapier 축 순서 [AngX, AngY, AngZ] = [flex(콘), twist, side(콘)] */
  limits: AxisLimits;
}

const RAD = Math.PI / 180;
const vx = (a: Readonly<Vec3>) => ({ x: a[0], y: a[1], z: a[2] });
const qx = (q: Readonly<Quat>) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
function shapeVolume(s: ShapeDef): number {
  if (s.type === 'sphere') return (4 / 3) * Math.PI * s.radius ** 3;
  if (s.type === 'capsule') return Math.PI * s.radius ** 2 * 2 * s.halfHeight + (4 / 3) * Math.PI * s.radius ** 3;
  return 8 * s.halfExtents[0] * s.halfExtents[1] * s.halfExtents[2];
}
const deg2 = (r: [number, number] | undefined): [number, number] | null => (r ? [r[0] * RAD, r[1] * RAD] : null);

/** 관절 상대 회전 → Rapier 관절 좌표 [AngX, AngY, AngZ] (rad). w ≥ 0으로 맞춘 뒤 2·asin(성분). */
export function jointCoords(qParent: Readonly<Quat>, qChild: Readonly<Quat>, frameP: Readonly<Quat>, frameC: Readonly<Quat>): Vec3 {
  let r = multiplyQ(multiplyQ(conjugate(frameP), conjugate(qParent)), multiplyQ(qChild, frameC));
  if (r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
  const a = (s: number) => 2 * Math.asin(Math.max(-1, Math.min(1, s)));
  return [a(r[0]), a(r[1]), a(r[2])];
}

/** 제한을 넘은 양 (rad, 축 중 최대, 0 이상). 경첩의 잠긴 축([0,0])도 포함 */
export function limitViolation(coords: Readonly<Vec3>, limits: AxisLimits): number {
  return Math.max(0, limitSigned(coords, limits, false));
}

/** 가장 가까운 제한까지 부호 거리 (rad): 음수 = 안쪽 여유, 양수 = 넘음. freeOnly면 잠긴 축([0,0])은 뺀다 */
export function limitSigned(coords: Readonly<Vec3>, limits: AxisLimits, freeOnly: boolean): number {
  let v = -Infinity;
  for (let i = 0; i < 3; i++) {
    const l = limits[i];
    if (!l || (freeOnly && l[0] === l[1])) continue;
    v = Math.max(v, l[0] - coords[i]!, coords[i]! - l[1]);
  }
  return v;
}

/** 가장 가까운 제한 쪽으로 향하는 각속도 (rad/s, 잠긴 축 제외). wRel = 관절 좌표계(부모 쪽)로 쓴 상대 각속도. 작은 각에서 좌표 변화율 ≈ 성분. */
export function limitApproachRate(coords: Readonly<Vec3>, limits: AxisLimits, wRel: Readonly<Vec3>): number {
  let best = -Infinity, rate = 0;
  for (let i = 0; i < 3; i++) {
    const l = limits[i];
    if (!l || l[0] === l[1]) continue;
    const lo = l[0] - coords[i]!, hi = coords[i]! - l[1];
    if (lo > best) { best = lo; rate = -wRel[i]!; }
    if (hi > best) { best = hi; rate = wRel[i]!; }
  }
  return best === -Infinity ? 0 : rate;
}

export class Ragdoll {
  readonly bodies: RagdollBody[] = [];
  readonly joints: RagdollJoint[] = [];
  readonly byName = new Map<BodyName, RagdollBody>();
  /** 인접(관절로 이어진) 바디 쌍 "a|b" (idx 작은 쪽 먼저) */
  readonly adjacent = new Set<string>();
  /** 바디 질량 (설정값, kg). 고정 바디도 같은 값 */
  private readonly masses: number[] = [];

  /** (v0.8c) 캐릭터 충돌 비트 (Spawn.charBit, 0 = 혼자) */
  charBit: number;

  constructor(readonly pw: PhysicsWorld, readonly def: CharacterDef, readonly cfg: RagdollConfig, spawn: Spawn) {
    const world = pw.world;
    this.charBit = spawn.charBit ?? 0;
    const qYaw = fromAxisAngle([0, 1, 0], spawn.yaw);
    for (const bd of def.bodies) {
      const bc = cfg.bodies[bd.name] ?? {};
      const tf = spawn.transforms?.[this.bodies.length];
      const pos = tf ? tf.pos : add(spawn.position, rotate(qYaw, bd.restPosition));
      const rot = tf ? tf.rot : multiplyQ(qYaw, bd.restRotation);
      const rb = world.createRigidBody(
        Rapier.RigidBodyDesc.dynamic()
          .setTranslation(pos[0], pos[1], pos[2])
          .setRotation(qx(rot))
          .setLinearDamping(bc.linearDamping ?? cfg.defaultLinearDamping)
          .setAngularDamping(bc.angularDamping ?? cfg.defaultAngularDamping)
          .setCcdEnabled(cfg.ccd)
          .setSoftCcdPrediction(cfg.softCcdPrediction)
          .setCanSleep(false),
      );
      const mass = bd.massRatio * def.totalMass;
      // 복합 형상: 바디 질량을 콜라이더 부피 비례로 나눈다 (겹침은 무시)
      const parts = [{ s: bd.shape, pos: [0, 0, 0] as Vec3 }, ...(bd.extraShapes ?? []).map((e) => ({ s: e.shape, pos: e.position }))];
      const vols = parts.map((p) => shapeVolume(p.s));
      const volSum = vols.reduce((a, b) => a + b, 0);
      const cols = parts.map((p, i) => {
        const s = p.s;
        const cd =
          s.type === 'capsule'
            ? Rapier.ColliderDesc.capsule(s.halfHeight, s.radius).setRotation(qx(s.rotation))
            : s.type === 'sphere'
              ? Rapier.ColliderDesc.ball(s.radius)
              : Rapier.ColliderDesc.cuboid(s.halfExtents[0], s.halfExtents[1], s.halfExtents[2]);
        cd.setTranslation(p.pos[0], p.pos[1], p.pos[2]).setMass((mass * vols[i]!) / volSum).setFriction(bd.friction).setRestitution(cfg.restitution);
        return world.createCollider(cd, rb);
      });
      const col = cols[0]!;
      const inertiaScale = bd.inertiaScale * (bc.inertiaScale ?? 1);
      if (inertiaScale !== 1) {
        if (cols.length > 1) throw new Error(`${bd.name}: inertiaScale with compound shape is not supported`);
        // 스파이크와 같은 방식: 형상 관성을 읽어 배율을 곱해 다시 건다. 바로 반영하려면 recompute (v0.0 함정 메모).
        rb.recomputeMassPropertiesFromColliders();
        const I = rb.principalInertia();
        col.setMassProperties(mass, rb.localCom(), { x: I.x * inertiaScale, y: I.y * inertiaScale, z: I.z * inertiaScale }, rb.principalInertiaLocalFrame());
        rb.recomputeMassPropertiesFromColliders();
      }
      if (spawn.pin?.includes(bd.name)) rb.setBodyType(Rapier.RigidBodyType.Fixed, false);
      this.masses.push(mass);
      const parentIdx = bd.parent === null ? -1 : this.body(bd.parent).idx;
      const b: RagdollBody = { name: bd.name, def: bd, idx: this.bodies.length, parentIdx, rb, col, cols };
      this.bodies.push(b);
      this.byName.set(bd.name, b);
    }
    this.applyConfigNoCollide();
    const raw = world.impulseJoints.raw;
    const axes = [Rapier.JointAxis.AngX, Rapier.JointAxis.AngY, Rapier.JointAxis.AngZ];
    for (const b of this.bodies) {
      const jd = b.def.joint;
      if (!jd || b.parentIdx < 0) continue;
      const p = this.bodies[b.parentIdx]!;
      const data =
        jd.type === 'hinge'
          ? Rapier.JointData.revolute(vx(jd.anchorInParent), vx(jd.anchorInChild), vx(jd.axis))
          : Rapier.JointData.spherical(vx(jd.anchorInParent), vx(jd.anchorInChild));
      const imp = world.createImpulseJoint(data, p.rb, b.rb, true);
      imp.setContactsEnabled(false);
      const frameC = jd.frameInChild;
      let frameP = jd.frameInParent;
      const L = jd.limitsDeg;
      let limits: AxisLimits;
      if (jd.type === 'hinge') {
        // 경첩: AngY·AngZ는 잠김(위반 측정용으로 [0,0]).
        limits = [deg2(L.flex), [0, 0], [0, 0]];
      } else if (L.swingCone !== undefined) {
        if (!jd.coneAxisInParent) throw new Error(`${b.name}: swingCone without coneAxisInParent`);
        const qP = p.def.restRotation;
        const twistW = rotate(multiplyQ(qP, frameP), [0, 1, 0]);
        const coneW = rotate(qP, jd.coneAxisInParent);
        frameP = multiplyQ(conjugate(qP), multiplyQ(fromTo(twistW, coneW), multiplyQ(qP, frameP)));
        const c: [number, number] = [-L.swingCone * RAD, L.swingCone * RAD];
        limits = [c, deg2(L.twist), c];
      } else {
        limits = [deg2(L.flex), deg2(L.twist), deg2(L.side)];
      }
      imp.setLocalFrame1(vx(jd.anchorInParent), qx(frameP));
      imp.setLocalFrame2(vx(jd.anchorInChild), qx(frameC));
      limits.forEach((l, i) => {
        if (jd.type === 'hinge' && i > 0) return; // 잠긴 축
        if (l) raw.jointSetLimits(imp.handle, axes[i] as never, l[0], l[1]);
      });
      const jdamp = cfg.bodies[b.name]?.jointDamping ?? cfg.defaultJointDamping;
      if (jdamp > 0) {
        for (let i = 0; i < (jd.type === 'hinge' ? 1 : 3); i++) {
          raw.jointConfigureMotorModel(imp.handle, axes[i] as never, Rapier.MotorModel.ForceBased as never);
          raw.jointConfigureMotor(imp.handle, axes[i] as never, 0, 0, 0, jdamp);
        }
      }
      this.joints.push({ name: b.name as RagdollJoint['name'], def: jd, parent: p.idx, child: b.idx, imp, frameP, frameC, limits });
      this.adjacent.add(`${Math.min(p.idx, b.idx)}|${Math.max(p.idx, b.idx)}`);
    }
  }

  /**
   * 실행 중 충돌 제외 쌍 바꾸기 (v0.6 걷기: 스윙발이 지지 다리 정강이를 스치는 충돌 끄기). null이면 되돌린다(모두 충돌).
   * 쌍에 든 바디마다 고유 비트를 소속으로, 짝 비트를 뺀 것을 필터로 둔다. 설정 noCollidePairs를 쓰는 캐릭터에서는 쓰지 않는다
   */
  setRuntimeNoCollide(pairs: readonly (readonly [BodyName, BodyName])[] | null): void {
    if (this.cfg.noCollidePairs?.length) return;
    const all = 0xffffffff;
    const touched = new Set<BodyName>(this.runtimeNoCollide);
    for (const n of touched) for (const c of this.body(n).cols) c.setCollisionGroups(all);
    this.runtimeNoCollide = [];
    this.runtimePairs = pairs && pairs.length ? pairs : null;
    if (!pairs || !pairs.length) return;
    const bit = new Map<BodyName, number>();
    for (const [a, b] of pairs) for (const n of [a, b]) if (!bit.has(n)) bit.set(n, 1 << bit.size);
    for (const [n, bn] of bit) {
      let partners = 0;
      for (const [a, b] of pairs) { if (a === n) partners |= bit.get(b)!; if (b === n) partners |= bit.get(a)!; }
      for (const c of this.body(n).cols) c.setCollisionGroups((((bn | this.charBit) & 0xffff) << 16) | (0xffff & ~(partners | this.charBit)));
      this.runtimeNoCollide.push(n);
    }
  }
  private runtimeNoCollide: BodyName[] = [];
  private runtimePairs: readonly (readonly [BodyName, BodyName])[] | null = null;

  /** 충돌 제외 쌍(설정): 쌍마다 비트 둘(a, b). a는 소속 a·필터 ~b, b는 소속 b·필터 ~a. 나머지 콜라이더(지면 포함)는 기본(전부) */
  private applyConfigNoCollide(): void {
    (this.cfg.noCollidePairs ?? []).forEach(([na, nb], k) => {
      const ba = 1 << (2 * k + 1), bb = 1 << (2 * k + 2);
      const set = (n: BodyName, mem: number, notBit: number) => {
        for (const c of this.body(n).cols) c.setCollisionGroups((((mem | this.charBit) & 0xffff) << 16) | (0xffff & ~(notBit | this.charBit)));
      };
      set(na, ba, bb);
      set(nb, bb, ba);
    });
  }

  /** (v0.8c) 캐릭터 충돌 비트 바꾸기 (World가 두 번째 캐릭터를 넣을 때 앞 캐릭터에도 준다): 제외 쌍 그룹을 다시 건다 */
  setCharBit(bit: number): void {
    if (bit === this.charBit) return;
    this.charBit = bit;
    this.applyConfigNoCollide();
    if (this.runtimePairs) this.setRuntimeNoCollide(this.runtimePairs);
  }

  body(name: BodyName): RagdollBody {
    const b = this.byName.get(name);
    if (!b) throw new Error(`unknown body ${name}`);
    return b;
  }

  totalMass(): number {
    return this.bodies.reduce((s, b) => s + b.rb.mass(), 0);
  }

  /** 관절 좌표 [AngX, AngY, AngZ] (rad) */
  coords(j: RagdollJoint): Vec3 {
    const qp = this.bodies[j.parent]!.rb.rotation();
    const qc = this.bodies[j.child]!.rb.rotation();
    return jointCoords([qp.x, qp.y, qp.z, qp.w], [qc.x, qc.y, qc.z, qc.w], j.frameP, j.frameC);
  }

  /** 관절의 가장 가까운 제한 쪽 상대 각속도 (rad/s). 양수 = 제한 쪽으로 움직임 */
  limitApproachRate(j: RagdollJoint, coords: Readonly<Vec3>): number {
    return limitApproachRate(coords, j.limits, this.relAngVel(j));
  }

  /** 상대 각속도(자식 − 부모, rad/s)를 부모 쪽 관절 좌표계로 쓴 값 */
  relAngVel(j: RagdollJoint): Vec3 {
    const p = this.bodies[j.parent]!.rb, c = this.bodies[j.child]!.rb;
    const qp = p.rotation(), ap = p.angvel(), ac = c.angvel();
    const frame = multiplyQ([qp.x, qp.y, qp.z, qp.w], j.frameP);
    return rotate(conjugate(frame), [ac.x - ap.x, ac.y - ap.y, ac.z - ap.z]);
  }

  com(): { com: Vec3; vel: Vec3 } {
    let c: Vec3 = [0, 0, 0];
    let vl: Vec3 = [0, 0, 0];
    let m = 0;
    for (const b of this.bodies) {
      const bm = b.rb.mass();
      const wc = b.rb.worldCom();
      const lv = b.rb.linvel();
      c = add(c, scale([wc.x, wc.y, wc.z], bm));
      vl = add(vl, scale([lv.x, lv.y, lv.z], bm));
      m += bm;
    }
    return { com: scale(c, 1 / m), vel: scale(vl, 1 / m) };
  }

  /** 사용자 토크·힘을 지운다 (addTorque·addForce는 다음 스텝까지 남는다, v0.0) */
  /** 어깨 범위 상태 (마지막 applyShoulderRom) */
  readonly shoulderRom: Partial<Record<'LeftArm' | 'RightArm', ShoulderRomState>> = {};
  private armAxisLocal: Partial<Record<'LeftArm' | 'RightArm', Vec3>> = {};

  /**
   * 어깨 가동 범위 끝 저항 (README 결정 171, cfg.shoulderRom). 매 물리 스텝 토크를 지운 뒤 근육보다 먼저 건다 (근육이 꺼진 늘어짐에서도 관절은 관절이다).
   * 팔 방향 d를 몸통(Spine2, rest 기준 x 왼쪽·y 위·z 앞) 좌표로 보고, 관상면 뒤 각 β가 팔 높이별 한계를 넘거나 시상면 넘어 반대쪽 각이 crossDeg를 넘으면
   * 넘은 만큼 앞쪽·제 쪽으로 돌리는 토크 τ = k·e − c·(들어가는 각속도)를 위팔에 +τ, Spine2에 −τ.
   */
  applyShoulderRom(): void {
    const rc = this.cfg.shoulderRom;
    if (!rc) return;
    const s2 = this.body('Spine2');
    const q2r = s2.rb.rotation();
    const qD = multiplyQ([q2r.x, q2r.y, q2r.z, q2r.w], conjugate(s2.def.restRotation));
    const w2r = s2.rb.angvel();
    const RAD = Math.PI / 180;
    for (const name of ['LeftArm', 'RightArm'] as const) {
      const b = this.body(name);
      let ax = this.armAxisLocal[name];
      if (!ax) {
        const jd = b.def.joint!, pd = this.bodies[b.parentIdx]!.def;
        const restDir = rotate(multiplyQ(pd.restRotation, jd.frameInParent), [0, 1, 0]);
        ax = rotate(conjugate(b.def.restRotation), restDir);
        this.armAxisLocal[name] = ax;
      }
      const qa = b.rb.rotation();
      const dW = rotate([qa.x, qa.y, qa.z, qa.w], ax);
      const l = rotate(conjugate(qD), dW);
      const sx = name === 'LeftArm' ? 1 : -1;
      const ly = Math.max(-1, Math.min(1, l[1]!));
      const behindMax = (ly < 0 ? rc.behindHorizDeg + (rc.behindDownDeg - rc.behindHorizDeg) * -ly : rc.behindHorizDeg + (rc.behindUpDeg - rc.behindHorizDeg) * ly) * RAD;
      const behind = Math.asin(Math.max(-1, Math.min(1, -l[2]!)));
      const cross = Math.asin(Math.max(-1, Math.min(1, -sx * l[0]!)));
      const eB = behind - behindMax, eC = cross - rc.crossDeg * RAD;
      const wa = b.rb.angvel();
      const wRel: Vec3 = [wa.x - w2r.x, wa.y - w2r.y, wa.z - w2r.z];
      let tq: Vec3 = [0, 0, 0];
      let excess = 0;
      // 돌릴 쪽: 몸통 앞(z) / 제 쪽(x·sx). 축 = d × 그 방향 (d를 그쪽으로 돌리는 회전축)
      for (const [e, dirL] of [[eB, [0, 0, 1]], [eC, [sx, 0, 0]]] as [number, Vec3][]) {
        if (e <= 0) continue;
        excess = Math.max(excess, e);
        const dirW = rotate(qD, dirL);
        const c = [dW[1]! * dirW[2]! - dW[2]! * dirW[1]!, dW[2]! * dirW[0]! - dW[0]! * dirW[2]!, dW[0]! * dirW[1]! - dW[1]! * dirW[0]!] as Vec3;
        const n = Math.hypot(c[0], c[1], c[2]);
        if (n < 1e-6) continue;
        const axis: Vec3 = [c[0] / n, c[1] / n, c[2] / n];
        const into = -(wRel[0] * axis[0] + wRel[1] * axis[1] + wRel[2] * axis[2]); // 한계 쪽으로 들어가는 각속도
        const ramp = rc.dampRampDeg ? Math.min(1, e / (rc.dampRampDeg * RAD)) : 1;
        const e0 = (rc.stiffRampDeg ?? 0) * RAD;
        const spring = e0 > 0 ? (e < e0 ? (e * e) / (2 * e0) : e - e0 / 2) : e;
        const mag = Math.min(rc.maxTorque, rc.stiffness * spring + ramp * rc.damping * Math.max(0, into));
        tq = add(tq, scale(axis, mag));
      }
      const tm = Math.hypot(tq[0], tq[1], tq[2]);
      this.shoulderRom[name] = { excessDeg: excess / RAD, torque: tm };
      if (tm > 0) {
        b.rb.addTorque({ x: tq[0], y: tq[1], z: tq[2] }, true);
        s2.rb.addTorque({ x: -tq[0], y: -tq[1], z: -tq[2] }, true);
      }
    }
  }

  resetTorques(): void {
    for (const b of this.bodies) {
      b.rb.resetTorques(false);
      b.rb.resetForces(false);
    }
  }

  /** 바디 질량(kg). 동적 바디는 Rapier 값, 고정 바디는 설정값 */
  massOf(i: number): number {
    const rb = this.bodies[i]!.rb;
    return rb.isDynamic() ? rb.mass() : this.masses[i]!;
  }

  /** 바디 i와 그 자손의 인덱스 (i 포함) */
  subtree(i: number): number[] {
    const out = [i];
    for (const b of this.bodies) if (b.idx > i && out.includes(b.parentIdx)) out.push(b.idx);
    return out;
  }
}
