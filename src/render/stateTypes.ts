// render가 읽는 상태 타입 (SPEC 7.3, 8.2). sim 계약 src/sim/types.ts보다 느슨하게(선택 필드) 받아 로그 버전 차이에 관대하다.
import type { Vec3 } from '../sim/math/vec3';
import type { Quat } from '../sim/math/quat';
import type { Vec2 } from '../sim/math/geometry';
import type { CharacterDef } from '../sim/character/characterDef';

export type { Vec3, Quat, Vec2, CharacterDef };

export type Posture = 'standing' | 'kneeling' | 'down' | 'airborne';

export interface BodyStateLite {
  pos: Vec3;
  rot: Quat;
  linVel?: Vec3;
  angVel?: Vec3;
}

export interface CharacterStateLite {
  time: number;
  state?: string;
  bodies: Record<string, BodyStateLite>;
  com: Vec3;
  comVel?: Vec3;
  contacts?: { body: string; point: Vec3; normal?: Vec3; impulse?: number }[];
  supportPolygon?: Vec2[];
  capturePoint?: Vec2;
  stance?: string;
  behaviors?: { name: string; weight: number }[];
  joints?: Record<string, { errorDeg?: number; torque?: number; saturated?: boolean; strength?: number; rom?: { excessDeg: number; torque: number } }>;
  posture?: Posture;
  assist?: { root: number; getup: number; pin: number };
  /** 일어서기 (v0.7) */
  getup?: { phase: string; attempt: number; maxAttempts: number; posture: string | null; clip: string | null; progress: number | null; settled: number; assist: { s: number; force: number; torque: number }; last: string | null };
  /** (2026-10-27) 반응 클립: 고른 클립·진행·끝난 이유 */
  reaction?: { phase: string; clip: string | null; tau: number; reason: string; style?: { clip: string; tau: number; rate: number; w: number; ourLandings: number; clipLandings: number[] } };
  debug?: Record<string, number | string>;
  /** (pres-1) 손가락 포즈: 손마다 포즈 이름·굽힘·벌림·엄지 (0~1) */
  fingers?: Record<string, { pose: string; curl: number; spread: number; thumb: number }>;
  /** (pres-3) 호흡 */
  breath?: { b: number; rate: number; depth: number; arousal: number; k: number };
  /** (결정 tone-1) 근긴장: 공동수축 레벨, 신장 반사 최대 레벨·관절, 감쇠 최대 배율 */
  tone?: { co: number; reflexMax: number; reflexJoint: string | null; maxKd: number };
  /** (결정 chest-2) 밀기 접촉 중: 이번 스텝 접촉 힘 N, 남은 접촉 시간 초 */
  push?: { force: number; left: number };
  /** 균형 계층 (v0.3) */
  balance?: {
    enabled: boolean;
    strategy: string;
    hipWeight: number;
    margin: number;
    cpMargin?: number;
    comTarget?: Vec3;
    virtualForce: Vec3;
    cop: Vec2 | null;
    groundHeight?: number | null;
    /** QP 접촉력 (v0.3) */
    contactForces?: { p: Vec3; f: Vec3 }[];
    flywheel?: number;
    /** 전신 제어 (v0.3): CMP(xz), COM 둘레 각운동량 */
    cmp?: Vec2 | null;
    angularMomentum?: Vec3;
    /** (README 결정 settle-1) 진정 단계: 진정 정도 0~1, 단계, 진입 시각, DCM 여유, 나온 이유 */
    settle?: { level: number; phase: string; since: number | null; margin: number; reason: string };
    /** (결정 land-3) 착지 받기 세기 */
    land?: number;
  };
  /** 스텝 계층 (v0.4): 상태, 스윙발, 착지 기록 */
  stepping?: {
    state: string;
    swingFoot: string | null;
    phase: string | null;
    kind: string | null;
    stepCount: number;
    target: Vec3 | null;
    landings?: { foot: string; t: number; p: Vec2; target: Vec2; error: number; kind?: string }[];
    lastLandingError?: number | null;
    staggerHandoff?: boolean;
    /** (v0.8a) 지형 디딤: 지지발 대비 높이 차, 받침 비율, 헛디딤 */
    terrain?: { dh: number; supported: number; void: boolean };
  };
  /** 행동 계층 (v0.5a): 활성 행동(한글 이름), 상처, 손 목표, 시선 */
  behavior?: {
    active: { name: string; ko?: string; weight: number; phase?: string; info?: Record<string, unknown> | null }[];
    wounds?: { point: Vec3; normal: Vec3 }[];
    hands?: { hand: string; target: Vec3 | null; ref: Vec3; palm: Vec3; woundDist: number | null; weight: number }[];
    gaze?: { target: Vec3; errorDeg: number } | null;
    /** (pres-2) 이번 의도 반응 지연(초), 머리 안정 각(도)·켜짐 */
    presence?: { delay: number; stabDeg: number; stabK: number };
    /** 넘어짐 신호 (v0.5b): 확실도, 방향 종류, 손이 닿을 때까지 예측 시간, 예측 손 착지점 */
    fall?: { certainty: number; kind: string; timeToImpact: number; hands: Record<string, Vec3> } | null;
    /** 공중 신호 (v0.5c): 공중 여부·시간, 착지 예측 시간·지점, 마지막 착지 */
    air?: { contact: boolean; airborne: boolean; airTime: number; timeToGround: number | null; touchdown: Vec3 | null; touchdownSpeedH: number; landing: { t: number; speedH: number; body: string } | null } | null;
    /** (v0.8b) 잡기·벽: 인지 후보, 벽 탐지, 손별 잡기 (단계·목표·앵커·힘·미끄러짐·손바닥) */
    grab?: { sense: { hand: string; point: Vec3; dist: number }[]; wall: { point: Vec3; normal: Vec3; dist: number } | null; hands: { hand: string; phase: string; kind: string; target: Vec3 | null; anchor: Vec3 | null; force: number; slip: number; palm: Vec3 }[] };
  };
  /** (v0.6) 애니 클립 기준 자세 (고스트 비교·렌더 블렌드) */
  anim?: { clip: string; tau: number; phase?: number; rate?: number; blendDeg?: number; com?: Vec3; bodies: Record<string, { pos: Vec3; rot: Quat }> } | null;
  /** (v0.6) 핀 보조 강도·바디별 세기 (필름: 바디 주황 테두리) */
  pin?: { strength: number; usage: number; bodies: Record<string, number>; reason?: string };
  /** (v0.6) 렌더 블렌드 (표시 = slerp(anim, 물리, w)) */
  render?: { w: number } | null;
  /** (v0.6) 애니 추종 걷기 */
  walk?: { engaged: boolean; clip: string; rate: number; feet: Record<string, { mode: string; contact: string; s: number; target: Vec3 | null }>; dcmError: Vec2; handover: string | null; phaseState?: boolean } | null;
  /** (v0.6) 상태 머신 */
  states?: { name: string; transition: string | null; blendPin: number; renderW: number } | null;
  /** (README 결정 game-1) 게임 애니 복귀 진행 */
  returnAnim?: { phase: string; clip: string; kinT: number | null; blendTime: number; pinTime: number; blockedBy: string };
  /** 이후 마일스톤 훅: 스텝 목표(xz), 잡기 대상(월드) */
  stepTargets?: Vec2[];
  grabTarget?: Vec3 | null;
  /** (v0.8c) 다른 캐릭터·프롭 접촉 */
  interaction?: { name: string; contacts: { source: string; kind: string; J: Vec3; penetration: number; point: Vec3 | null }[]; penetration: number; lastHit: { t: number; source: string; body: string; dv: number; direction: Vec3 } | null; lookAt: string | null };
}

/** (v0.8c) 프롭 형상 (meta.props) */
export interface PropMetaLite {
  id: string;
  shape: { type: 'box'; halfExtents: Vec3 } | { type: 'sphere'; radius: number } | { type: 'capsule'; halfHeight: number; radius: number };
  mass?: number;
  color?: Vec3;
  t?: number;
}
/** (v0.8c) 프롭 상태 (props.jsonl 한 줄의 props 항목) */
export interface PropStateLite { id: string; pos: Vec3; rot: Quat; linVel?: Vec3; angVel?: Vec3 }
export interface PropFrameLite { time: number; props: PropStateLite[] }

export interface FilmEvent {
  t: number;
  type: string;
  body?: string;
  point?: Vec3;
  direction?: Vec3;
  dv?: number;
  /** 피격 종류 등 (hit: 'push' | 'bullet' | 'melee' | 'explosion') */
  detail?: string;
  /** (v0.8c) 이벤트를 낸 캐릭터 이름 (여러 캐릭터 로그) */
  char?: string;
  /** (v0.8c) 접촉 감지 피격의 상대 */
  source?: string;
}

export interface FilmMeta {
  scenario: string;
  milestone?: string;
  characterId?: string;
  characterConfig?: string;
  logDt?: number;
  duration?: number;
  cameras?: string[];
  events?: FilmEvent[];
  /** 지형 이름 (v0.3). 없으면 flat */
  terrain?: string;
  /** (v0.8c) 여러 캐릭터 (첫 항목 = log.jsonl) */
  characters?: { name: string; log: string; characterId?: string; characterConfig?: string }[];
  /** (v0.8c) 프롭 형상과 로그 파일 */
  props?: PropMetaLite[];
  propsLog?: string;
}

export interface FilmSummary {
  scenario?: string;
  duration?: number;
  exploded?: boolean;
  fell?: boolean;
  fallTime?: number | null;
  kneeled?: boolean;
  kneelTime?: number | null;
  firstGroundContact?: string | null;
  stepsTaken?: number | null;
  recoveredAfterHit?: number | null;
  expectations?: { passed: boolean; failures: string[] };
}

export type CameraKind = 'side' | 'front' | 'top' | 'follow';
export const CAMERA_KINDS: readonly CameraKind[] = ['side', 'front', 'top', 'follow'];

// sim 계약(src/sim/types.ts)이 render 읽기 타입에 들어맞는지 컴파일 시점에 확인한다.
import type { CharacterState, Meta, Summary } from '../sim/types';
type Assert<T extends true> = T;
export type _StateCompat = Assert<CharacterState extends CharacterStateLite ? true : false>;
export type _MetaCompat = Assert<Meta extends FilmMeta ? true : false>;
export type _SummaryCompat = Assert<Summary extends FilmSummary ? true : false>;
