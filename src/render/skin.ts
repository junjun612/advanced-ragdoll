// FBX 스킨 렌더 (SPEC 12장 v0.2 'FBX 스킨 렌더', 11.2 대표 본 매핑의 역방향).
// X Bot FBX를 ArrayBuffer로 받아 FBXLoader.parse로 읽고(브라우저·Node 공용, Node 전용 API 없음),
// sim 바디 상태로 스켈레톤을 움직인다.
//
// 규약
// - 바디 Δ회전 D_body = Q_body_world · inv(Rest_body_world). (Rest_body = xbot.json restRotation, A포즈)
// - 본 월드 회전 = D · RestA_bone_world. SPEC 11.2의 rest 보정 Q_body = Q_bone · inv(Rest_bone) · Rest_body를 뒤집은 식이다.
//   RestA_bone은 '랙돌 rest(A포즈)에서의 본 월드 변환'이다: X Bot 바인드(T포즈)에 소속 바디의 rest 회전을
//   어깨 피벗 중심으로 적용한 것(tools/ragdoll/build.ts의 A포즈 변환과 같다). 그래서 rest 상태 → A포즈 스켈레톤.
// - 대표 본: D = D_body, 위치 = 바디 위치 + D·(RestA_bone − restPosition) (형상 중심 ↔ 본 원점 차이 보정).
// - 흡수된 중간 본(config/skin.json absorbed): D = slerp(D_from, D_to, t), 위치는 부모 본에서 계층으로.
// - 나머지 본(손가락, 발가락, 끝 본): 부모 본의 D를 그대로 따른다(부모 기준 rest 유지).
// - FBX 단위 cm → 루트 그룹 scale 0.01.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { CharacterDef, CharacterStateLite, Vec3 } from './stateTypes';
import type { BodyDef, BodyName } from '../sim/character/characterDef';

export interface SkinConfig {
  /** FBX 경로 (프로젝트 루트 기준). 로딩은 호출자 몫이다(필름 도구는 파일을, 앱은 URL을 읽는다). */
  fbx: string;
  absorbed: Record<string, { from: BodyName; to: BodyName; t: number }>;
  /**
   * 비틀림 나누기 (v0.4 관절 변경, README 결정 72): 바디 X(대표 본)의 본이 자식 바디 child의 X 축(본 → 자식 본 방향) 둘레 비틀림 중 t만큼을 함께 돈다.
   * 전완 회내·회외는 물리에서 손목 관절 twist로 받지만(전완 캡슐은 축 대칭), 피부는 전완을 따라 꼬여야 사람처럼 보인다
   */
  twistShare?: Record<string, { child: BodyName; t: number }>;
  color?: { surface: Vec3; joints: Vec3 };
}

export const CM_TO_M = 0.01;

export function stripMixamoPrefix(name: string): string {
  const m = /^mixamorig:?/.exec(name);
  return m ? name.slice(m[0].length) : name;
}

interface BoneInfo {
  name: string;
  parent: string | null;
  /** 랙돌 rest(A포즈) 월드 위치(m)·회전 */
  restPos: THREE.Vector3;
  restRot: THREE.Quaternion;
  /** 대표 본이면 그 바디 */
  repOf: BodyDef | null;
}

export interface BonePose { pos: THREE.Vector3; rot: THREE.Quaternion }

const q = (a: readonly number[]): THREE.Quaternion => new THREE.Quaternion(a[0], a[1], a[2], a[3]);
const v = (a: readonly number[]): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]);

export class FbxSkin {
  /** 씬에 넣을 루트 (scale 0.01) */
  readonly root: THREE.Group;
  /** 원본(바깥) 본, 계층 순서 */
  readonly bones: BoneInfo[] = [];
  /** 마지막 applyState 결과 (본 이름 → 월드 위치·회전, m) */
  readonly pose = new Map<string, BonePose>();

  private readonly objByName = new Map<string, THREE.Bone>();
  private readonly allBones: THREE.Bone[] = [];
  private readonly restScale = new Map<THREE.Bone, THREE.Vector3>();
  private readonly bodies = new Map<string, BodyDef>();
  private readonly cfg: SkinConfig;

  constructor(fbx: ArrayBuffer, def: CharacterDef, cfg: SkinConfig) {
    this.cfg = cfg;
    this.root = new FBXLoader().parse(fbx, '');
    this.root.scale.setScalar(CM_TO_M);
    this.root.updateMatrixWorld(true);
    for (const b of def.bodies) this.bodies.set(b.name, b);

    // 원본 본(이름별 처음 나온 것)과 복제 본(같은 이름의 자식, 로컬 항등) — docs/SPIKE-fbx.md 1장
    this.root.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      const bone = o as THREE.Bone;
      this.allBones.push(bone);
      const s = new THREE.Vector3();
      bone.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      this.restScale.set(bone, s);
      const n = stripMixamoPrefix(bone.name);
      if (!this.objByName.has(n)) this.objByName.set(n, bone);
    });

    // 본 → 소속 바디 (sourceBones, 없으면 조상 본의 바디)
    const owner = new Map<string, BodyDef>();
    for (const b of def.bodies) for (const sb of b.sourceBones) owner.set(sb, b);
    const repOf = new Map<string, BodyDef>();
    for (const b of def.bodies) repOf.set(b.representativeBone, b);

    for (const [name, bone] of this.objByName) {
      let par: THREE.Object3D | null = bone.parent;
      while (par && (par as THREE.Bone).isBone && stripMixamoPrefix(par.name) === name) par = par.parent;
      const parent = par && (par as THREE.Bone).isBone ? stripMixamoPrefix(par.name) : null;
      if (!owner.has(name)) {
        const ob = parent ? owner.get(parent) : undefined;
        if (!ob) throw new Error(`skin: 본 ${name}의 소속 바디를 찾을 수 없음`);
        owner.set(name, ob);
      }
      const bindPos = new THREE.Vector3(), bindRot = new THREE.Quaternion();
      bone.matrixWorld.decompose(bindPos, bindRot, new THREE.Vector3());
      // A포즈 변환: 소속 바디 rest 회전을 그 회전 묶음의 꼭대기 관절(어깨) 중심으로 적용
      const body = owner.get(name)!;
      const R = q(body.restRotation);
      const pivot = this.rotationPivot(body);
      const restPos = bindPos.sub(pivot).applyQuaternion(R).add(pivot);
      const restRot = R.clone().multiply(bindRot);
      this.bones.push({ name, parent, restPos, restRot, repOf: repOf.get(name) ?? null });
    }
    for (const b of def.bodies) {
      if (!this.objByName.has(b.representativeBone)) throw new Error(`skin: 대표 본 ${b.representativeBone} 없음`);
    }
    for (const [name, a] of Object.entries(cfg.absorbed)) {
      if (!this.objByName.has(name)) throw new Error(`skin: 흡수 본 ${name} 없음`);
      if (!this.bodies.has(a.from) || !this.bodies.has(a.to)) throw new Error(`skin: 흡수 본 ${name}의 바디 이름 오류`);
    }

    this.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.frustumCulled = false; // 바운딩 구가 rest 기준이라 움직이면 잘못 잘린다
      const col = cfg.color ? (/joint/i.test(m.name) ? cfg.color.joints : cfg.color.surface) : null;
      if (col) m.material = new THREE.MeshLambertMaterial({ color: new THREE.Color(col[0], col[1], col[2]) });
    });
  }

  /** rest 회전이 같은 조상 바디 묶음의 꼭대기 관절 월드 위치. 회전이 항등이면 원점(무관). */
  private rotationPivot(body: BodyDef): THREE.Vector3 {
    const R = q(body.restRotation);
    let top = body;
    while (top.parent) {
      const p = this.bodies.get(top.parent)!;
      if (Math.abs(q(p.restRotation).dot(R)) < 1 - 1e-6) break; // JSON 반올림(6자리) 허용
      top = p;
    }
    if (!top.joint) return new THREE.Vector3();
    return v(top.joint.anchorInChild).applyQuaternion(q(top.restRotation)).add(v(top.restPosition));
  }

  /** 랙돌 rest(A포즈) 본 월드 변환 */
  restPose(name: string): BonePose | undefined {
    const b = this.bones.find((x) => x.name === name);
    return b && { pos: b.restPos.clone(), rot: b.restRot.clone() };
  }

  /** 바디 상태로 스켈레톤을 맞춘다. Hips가 없으면 숨긴다. */
  applyState(state: CharacterStateLite): void {
    if (!state.bodies.Hips) { this.root.visible = false; return; }
    this.root.visible = true;

    const D = new Map<string, THREE.Quaternion>();
    for (const [name, b] of this.bodies) {
      const s = state.bodies[name];
      D.set(name, s ? q(s.rot).multiply(q(b.restRotation).invert()) : new THREE.Quaternion());
    }
    const boneD = new Map<string, THREE.Quaternion>();
    this.pose.clear();
    for (const b of this.bones) {
      const abs = this.cfg.absorbed[b.name];
      let d: THREE.Quaternion;
      if (b.repOf) {
        d = D.get(b.repOf.name)!;
        const ts = this.cfg.twistShare?.[b.repOf.name];
        if (ts) {
          // 자식 바디의 상대 회전(월드) 중 이 본 축 둘레 비틀림을 t만큼 나눠 받는다
          const childBone = this.bones.find((x) => x.repOf?.name === ts.child);
          if (childBone) {
            const axis = childBone.restPos.clone().sub(b.restPos).normalize().applyQuaternion(d);
            const rel = D.get(ts.child)!.clone().multiply(d.clone().invert());
            const proj = axis.dot(new THREE.Vector3(rel.x, rel.y, rel.z));
            const tw = new THREE.Quaternion(axis.x * proj, axis.y * proj, axis.z * proj, rel.w);
            if (tw.lengthSq() > 1e-12) {
              tw.normalize();
              if (tw.w < 0) tw.set(-tw.x, -tw.y, -tw.z, -tw.w);
              d = new THREE.Quaternion().slerp(tw, ts.t).multiply(d);
            }
          }
        }
      }
      else if (abs) d = D.get(abs.from)!.clone().slerp(D.get(abs.to)!, abs.t);
      else d = b.parent ? boneD.get(b.parent)! : D.get('Hips')!;
      boneD.set(b.name, d);

      let pos: THREE.Vector3;
      const body = b.repOf;
      const bs = body ? state.bodies[body.name] : undefined;
      if (body && bs) {
        pos = b.restPos.clone().sub(v(body.restPosition)).applyQuaternion(d).add(v(bs.pos));
      } else {
        const pp = this.pose.get(b.parent!)!;
        const par = this.bones.find((x) => x.name === b.parent)!;
        pos = b.restPos.clone().sub(par.restPos).applyQuaternion(boneD.get(b.parent!)!).add(pp.pos);
      }
      this.pose.set(b.name, { pos, rot: d.clone().multiply(b.restRot) });
    }

    // 월드 목표 → three 로컬 변환. 복제 본은 로컬(항등)을 그대로 두고 월드만 따라간다.
    const world = new Map<THREE.Object3D, THREE.Matrix4>();
    const parentWorld = (o: THREE.Object3D): THREE.Matrix4 => {
      const p = o.parent!;
      return world.get(p) ?? p.matrixWorld;
    };
    const tmp = new THREE.Matrix4();
    for (const bone of this.allBones) {
      const n = stripMixamoPrefix(bone.name);
      const pw = parentWorld(bone);
      if (this.objByName.get(n) === bone) {
        const p = this.pose.get(n)!;
        const w = new THREE.Matrix4().compose(p.pos, p.rot, this.restScale.get(bone)!);
        tmp.copy(pw).invert().multiply(w);
        tmp.decompose(bone.position, bone.quaternion, bone.scale);
        world.set(bone, w);
      } else {
        bone.updateMatrix();
        world.set(bone, new THREE.Matrix4().multiplyMatrices(pw, bone.matrix));
      }
    }
    this.root.updateMatrixWorld(true);
  }
}
