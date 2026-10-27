// sim ↔ 관측 도구(로거·지표·렌더러) 사이의 계약 타입 (SPEC 7.3, 8.1, 8.2). 타입만 둔다.
// 렌더러는 이 파일을 `import type`으로만 읽는다.
import type { Vec3 } from './math/vec3';
import type { Quat } from './math/quat';
import type { Vec2 } from './math/geometry';
import type { BodyName } from './character/characterDef';
import type { BalanceState } from './character/balance';
import type { SteppingState } from './character/stepping';
import type { BehaviorLogState } from './character/behaviors/blender';
import type { WalkState } from './character/walk';
import type { PinState } from './character/pin';
import type { StatesLog } from './character/states';
import type { GetupLog } from './character/getup';
import type { ReactionLog } from './character/reaction';

export type { Vec3, Quat, Vec2, BodyName, BalanceState, SteppingState, BehaviorLogState };

export type StateName = 'Animated' | 'Active' | 'Ragdoll' | 'GettingUp';
export type Posture = 'standing' | 'kneeling' | 'down' | 'airborne';
export type Stance = 'double' | 'left' | 'right' | 'none';
/** 관절 이름 = 자식 바디 이름 (Hips 제외) */
export type JointName = Exclude<BodyName, 'Hips'>;

export interface BodyState {
  /** 형상 중심(= 바디 원점) 월드 위치 */
  pos: Vec3;
  /** [x, y, z, w] */
  rot: Quat;
  linVel: Vec3;
  angVel: Vec3;
}

export interface ContactState {
  body: BodyName;
  point: Vec3;
  normal: Vec3;
  /** 이 접촉점의 법선 충격량 (N·s, 직전 스텝) */
  impulse: number;
}

export interface JointState {
  /** 근육 목표와의 오차 각(도, 상대 회전 차이의 각). 근육이 꺼져 있으면 0 */
  errorDeg: number;
  /** 근육 토크 크기 추정값(N·m): PD 식(축별 클램프) + 중력 보상. 모터 실제 출력이 아니다 (README 결정 12) */
  torque: number;
  /** 추정 토크가 s·maxTorque에 걸렸는가 */
  saturated: boolean;
  /** 근육 강도 0~1 (저역 통과 후) */
  strength: number;
  /** 근육 목표의 Rapier 관절 좌표 [AngX, AngY, AngZ] (도). coordsDeg와 같은 좌표 (v0.2) */
  targetDeg: Vec3;
  /** 상대 각속도(자식 − 부모)를 부모 쪽 관절 좌표계로 쓴 값 (도/초) (v0.2, jitter 지표) */
  relAngVelDegS: Vec3;
  /** Rapier 관절 좌표 [AngX=flex, AngY=twist, AngZ=side] (도, 2·asin 쿼터니언 성분). 어깨는 콘 축 기준 */
  coordsDeg: Vec3;
  /** 제한을 넘은 양(도, 축 중 최대). 0이면 제한 안 */
  violationDeg: number;
  /** 가장 가까운 제한까지 부호 거리(도, 잠긴 축 제외): 음수 = 안쪽 여유, 양수 = 넘음 */
  limitMarginDeg: number;
  /** 가장 가까운 제한 쪽으로 향하는 상대 각속도(도/초, 잠긴 축 제외): 양수 = 제한 쪽으로 움직이는 중 (limitMarginDeg와 같은 축) */
  limitApproachDegS: number;
  /** (어깨만, README 결정 171) 사람 가동 범위를 넘은 각(도)과 건 끝 저항 토크(N·m) */
  rom?: { excessDeg: number; torque: number };
}

export interface CharacterState {
  time: number;
  state: StateName;
  bodies: Record<BodyName, BodyState>;
  com: Vec3;
  comVel: Vec3;
  /** 지면 접촉만 (자기 충돌은 debug.selfPenetration) */
  contacts: ContactState[];
  /** 발 접촉점의 볼록 껍질, [x, z] */
  supportPolygon: Vec2[];
  /** 선형 역진자 캡처 포인트 com_xz + v_xz·sqrt(h/g), [x, z] */
  capturePoint: Vec2;
  stance: Stance;
  posture: Posture;
  behaviors: { name: string; weight: number }[];
  joints: Record<JointName, JointState>;
  /** animOverride = (app-2) 애니 강제 비율 핀 사용량 (N), setAnimOverride를 쓴 캐릭터만 */
  assist: { root: number; getup: number; pin: number; animOverride?: number };
  /** (app-2) 애니 강제 비율 (setAnimOverride를 쓴 캐릭터만): 비율, 사용량(N), 레퍼런스 출처(clip = 애니 클립, pose = 서기 포즈), 바디별 핀 세기 */
  animOverride?: { weight: number; usage: number; source: 'clip' | 'pose' | ''; bodies: Partial<Record<string, number>> };
  /** 균형 계층 (v0.3): 전략, 여유, 가상 힘, CoP 등 (docs/ALGORITHMS.md v0.3) */
  balance: BalanceState;
  /** 스텝 계층 (v0.4): 상태, 착지 목표, 착지 기록 (docs/ALGORITHMS.md v0.4) */
  stepping: SteppingState;
  /** 행동 계층 (v0.5a): 활성 행동·가중치, 관절별 레이어, 강도 배율, 상처, 손 목표, 시선 (docs/ALGORITHMS.md v0.5a) */
  behavior: BehaviorLogState;
  /** (v0.6) 애니 클립 기준 자세 (월드, 앵커 적용, 관성화 포함): 고스트 비교·렌더 블렌드용. 클립이 없으면 null/없음 */
  anim?: { clip: string; tau: number; phase: number; rate: number; blendDeg: number; com: Vec3; bodies: Record<BodyName, { pos: Vec3; rot: Quat }>; feet: Record<'LeftFoot' | 'RightFoot', { stance: boolean; heelH: number; toeH: number }> } | null;
  /** (v0.6) 애니 추종 걷기 (docs/ALGORITHMS.md v0.6) */
  walk?: WalkState | null;
  /** (v0.6) 핀 보조 강도·사용량·바디별 세기 */
  pin?: PinState;
  /** (v0.6) 파워드 랙돌 상태 머신 */
  states?: StatesLog & { switchJump: { t: number; lin: number; ang: number; hit: boolean } | null };
  /** (v0.6) 렌더 블렌드: 표시 자세 = slerp(anim, 물리, w) (w < 1일 때만) */
  render?: { w: number } | null;
  /** (v0.7) 일어서기: 단계·시도·클립·진행·겟업 보조 (판정·시도가 있을 때만) */
  getup?: GetupLog;
  /**
   * (v0.8c) 다른 캐릭터·프롭 상호작용 (그런 월드에서만): 이 캐릭터 이름, 이번 스텝 상대별 접촉(받은 법선 충격량 N·s, 관통 깊이 m, 가중 접촉점),
   * 캐릭터 사이 최대 관통 깊이, 마지막 감지 피격, 돌아보는 상대
   */
  interaction?: {
    name: string;
    contacts: { source: string; kind: 'character' | 'prop'; J: Vec3; penetration: number; point: Vec3 | null }[];
    penetration: number;
    lastHit: { t: number; source: string; body: BodyName; dv: number; direction: Vec3 } | null;
    lookAt: string | null;
  };
  /** (2026-10-27) 반응 클립 추종: 고른 클립·시각·매칭 비용·끝난 이유 (반응 클립을 한 번이라도 고르려 했을 때만) */
  reaction?: ReactionLog;
  /** 스텝 목표 발자국 (xz, 필름스트립 하늘색) */
  stepTargets: Vec2[];
  /** (v0.8b) 잡기 대상 (잡은 앵커, 뻗는 중이면 손바닥 목표). 잡을 곳·벽이 있는 지형에서만 */
  grabTarget?: Vec3 | null;
  debug: Record<string, number | string>;
}

export interface SimEvent {
  t: number;
  /** 'hit' | 'exploded' | ... */
  type: string;
  body?: BodyName;
  point?: Vec3;
  direction?: Vec3;
  /** 전신 COM Δv (m/s) */
  dv?: number;
  /** 'step' 이벤트: 착지 오차 (m, v0.4) */
  error?: number;
  /** 'hitReacted' 이벤트: 반응 강도 0~1 (v0.5a, 사운드 연동) */
  strength?: number;
  detail?: string;
  /** (v0.8c) 여러 캐릭터 월드: 이벤트를 낸 캐릭터 이름 */
  char?: string;
  /** (v0.8c) 접촉 감지 피격의 상대 (캐릭터 이름 또는 'prop:<id>') */
  source?: string;
}

export interface Meta {
  scenario: string;
  milestone: string;
  characterId: string;
  characterConfig: string;
  logDt: number;
  duration: number;
  cameras: string[];
  events: SimEvent[];
  /** 지형 (v0.3, 렌더가 지면을 그린다) */
  terrain?: string;
  /** 관절별 근육 이득 (v0.2) */
  muscles?: { joint: JointName; kp: number; kd: number; maxTorque: number }[];
  /** (v0.8c) 여러 캐릭터: 이름·로그 파일(이 폴더 안)·캐릭터 정의. 첫 항목이 log.jsonl 캐릭터 */
  characters?: { name: string; log: string; characterId: string; characterConfig: string }[];
  /** (v0.8c) 프롭 형상·질량·생긴 시각, 프롭 로그 파일 */
  props?: { id: string; shape: { type: 'box'; halfExtents: Vec3 } | { type: 'sphere'; radius: number } | { type: 'capsule'; halfHeight: number; radius: number }; mass: number; color?: Vec3; t: number }[];
  propsLog?: string;
}

export interface Summary {
  scenario: string;
  milestone: string;
  duration: number;
  exploded: boolean;
  explodedTime: number | null;
  fell: boolean;
  fallTime: number | null;
  kneeled: boolean;
  kneelTime: number | null;
  /** 착지한 스텝 수 (v0.4: 'step' 이벤트, 모으는 스텝 포함) */
  stepsTaken: number | null;
  recoveredTime: number | null;
  /** 마지막 충격부터 recoveredTime까지 (초, v0.3). 충격이 없었으면 null. expect recoveredWithin은 이 값으로 판정한다 */
  recoveredAfterHit: number | null;
  /** 발을 뺀 바디 중 지면에 처음 닿은 바디 */
  firstGroundContact: BodyName | null;
  /** 시작~끝 COM 수평 이동의 단위 방향 [x, 0, z]. 이동이 1cm 미만이면 null */
  fallDirection: Vec3 | null;
  finalPosture: Posture;
  metrics: Record<string, number>;
  /** 지표에 딸린 문자열 정보 (예: jitterJoint) (v0.2) */
  info?: Record<string, string>;
  expectations: { passed: boolean; failures: string[] };
  /** (v0.8c) 여러 캐릭터 시나리오: 두 번째 이후 캐릭터의 요약 (이름 → 요약, 각자 expectations) */
  others?: Record<string, Summary>;
}
