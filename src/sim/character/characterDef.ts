// config/characters/<id>.json 스키마 (SPEC 6.4). 규약은 docs/RAGDOLL_CONFIG.md.
// 이 파일은 타입만 정의한다. Rapier 바디·관절 생성은 ragdoll.ts 몫이다.
import type { Vec3 } from '../math/vec3';
import type { Quat } from '../math/quat';

export type BodyName =
  | 'Hips' | 'Spine' | 'Spine2' | 'Head'
  | 'LeftArm' | 'LeftForeArm' | 'LeftHand' | 'RightArm' | 'RightForeArm' | 'RightHand'
  | 'LeftUpLeg' | 'LeftLeg' | 'LeftFoot' | 'RightUpLeg' | 'RightLeg' | 'RightFoot'
  /** (v0.8a 발가락 바디 실험용, 기본 캐릭터에는 없음) */
  | 'LeftToeBase' | 'RightToeBase';

/**
 * 형상은 바디 원점(= restPosition, 형상 중심)에 놓인다.
 * capsule: 축은 형상 로컬 +Y, `rotation`(바디 로컬 기준)으로 돌린다. halfHeight는 반구 중심 사이 거리의 절반.
 */
export type ShapeDef =
  | { type: 'capsule'; radius: number; halfHeight: number; rotation: Quat }
  | { type: 'sphere'; radius: number }
  | { type: 'box'; halfExtents: Vec3 };

/** 바디에 붙는 추가 콜라이더 (복합 형상). 위치는 바디 로컬(바디 원점 기준), 회전은 형상 자체의 rotation. 질량은 바디 massRatio를 부피 비례로 나눈다. */
export interface ExtraShapeDef {
  /** 용도 표시 (예: 'neck') */
  label: string;
  shape: ShapeDef;
  position: Vec3;
}

/** 관절 각 제한(도). 축 이름은 관절 좌표계 기준: flex = X, twist = Y, side = Z. */
export interface JointLimitsDeg {
  flex?: [number, number];
  side?: [number, number];
  twist?: [number, number];
  /** 스윙 콘 반각. 콘 축은 JointDef.coneAxisInParent */
  swingCone?: number;
}

export interface JointDef {
  type: 'spherical' | 'hinge';
  /** 관절 위치. 부모·자식 바디 로컬 좌표 (rest에서 같은 월드 점) */
  anchorInParent: Vec3;
  anchorInChild: Vec3;
  /** 관절 좌표계(X=flex, Y=twist, Z=side)의 바디 로컬 회전. rest에서 두 값의 월드 회전이 같다 → rest 상대 회전 = 항등. */
  frameInParent: Quat;
  frameInChild: Quat;
  /** 경첩 축 = flex 축, 부모 바디 로컬 (SPEC 6.4 예시의 axis) */
  axis: Vec3;
  /** 참고용: rest 월드 기준 관절 축 */
  axesWorld: { flex: Vec3; twist: Vec3; side: Vec3 };
  /** 스윙 콘 축(부모 바디 로컬). swingCone이 있을 때만 */
  coneAxisInParent?: Vec3;
  limitsDeg: JointLimitsDeg;
}

export interface BodyDef {
  name: BodyName;
  parent: BodyName | null;
  /** 이 바디가 흡수하는 원본 본 (SPEC 11.2) */
  sourceBones: string[];
  /** 포즈 추출용 대표 본 (SPEC 11.2) */
  representativeBone: string;
  /** 관절 위치를 정한 본 (부모와의 관절이 이 본의 rest 월드 위치에 있다). 루트는 null */
  jointBone: string | null;
  shape: ShapeDef;
  /** 추가 콜라이더 (없으면 생략). 주 형상과 한 바디에 붙는다 */
  extraShapes?: ExtraShapeDef[];
  massRatio: number;
  inertiaScale: number;
  /** 월드 rest 자세(팔 내린 A포즈) 위치 = 형상 중심 */
  restPosition: Vec3;
  restRotation: Quat;
  joint: JointDef | null;
  friction: number;
}

export interface CharacterDef {
  id: string;
  totalMass: number;
  height: number;
  skeleton: string;
  restPose: { armDownDeg: number };
  generator: { tool: string; source: string; overrides: string | null };
  bodies: BodyDef[];
}
