// 레퍼런스 생성 ↔ 추종기 경계 (README 결정 164, 9a-3, docs/RESEARCH_APPROACHES.md D안).
// 한 스텝은 두 쪽으로 나뉜다 (SPEC 7.1의 4~7단계):
//   레퍼런스 생성 = 애니 클립·포즈 클립 → 반응 클립 상체 스타일 → 행동 계층 편집(블렌드). 결과 = ReferenceFrame.
//   추종기       = 균형·스텝(전신 운동량 QP) + 근육 PD. ReferenceFrame과 몸 상태를 읽어 관절 토크·모터 목표(TrackerCommand)를 낸다.
// 지금 추종기는 'wholeBodyQP' 하나이고 api.ts 안에서 직접 부른다(구조는 바꾸지 않았다). 1.0 뒤 학습형 추종기(DReCon·SuperTrack류)로
// 바꿀 때 갈아 끼울 자리가 Tracker 인터페이스다: 같은 ReferenceFrame을 받아 같은 TrackerCommand를 내면 레퍼런스 쪽 코드는 그대로 쓴다.
// Character.reference()로 매 스텝 레퍼런스를 읽을 수 있다 — 학습 데이터(레퍼런스, 상태) 쌍을 모으는 데 쓴다.
import type { JointTargets } from './character/pose';
import type { TrackingRef } from './character/reaction';
import type { SettleRef } from './character/settle';
import type { HandName, HandTarget } from './character/behaviors/types';
import type { BalanceCommand } from './character/balance';
import type { CharacterState, JointName } from './types';

export type { TrackingRef };

/** 한 스텝의 레퍼런스: 레퍼런스 생성 계층이 추종기에 넘기는 것 전부 (Character.reference()) */
export interface ReferenceFrame {
  /** 시뮬레이션 시각 (s, 이 스텝 시작) */
  t: number;
  /**
   * 관절 목표 (관절별 부모 기준 사원수): 클립 → 반응 스타일 → 행동 블렌드까지 끝난 것, 추종기(균형·스텝)가 하체를 고치기 전.
   * null = 목표 없음 (Ragdoll, 클립 없음)
   */
  joints: JointTargets | null;
  /** 관절별 추종 세기·추종 힌트 (반응 클립 상체 스타일 중에만, 결정 164). 위험할 때 풀기(release)는 추종기 판단이다 */
  tracking: TrackingRef | null;
  /** 진정 단계 힌트 (README 결정 settle-1, 진정 정도 > 0일 때만): 팔 반사·벌림 배율, 팔 자세 과제 가중치·감쇠, 팔 각운동량 비용 배율 */
  settle?: SettleRef;
  /** 전신 애니 추종 중인 클립 (걷기·Idle·겟업·반응 track 모드): 이름·클립 시각(s). 추종기는 클립의 COM·발 접촉도 읽는다 */
  clip: { name: string; tau: number } | null;
  /** 행동 계층 출력 (지금 추종기가 직접 읽는 것). 행동이 없으면 null */
  behavior: {
    /** 켜진 행동 이름 (가중치 > 0) */
    active: string[];
    /** 관절별 근육 강도 배율 (행동이 힘을 빼거나 더함) */
    strengthMul: Partial<Record<JointName, number>>;
    /** 균형 모드: on / weak(약하게) / off(넘어짐·누움) */
    balanceMode: 'on' | 'weak' | 'off';
    /**
     * 손 과제 (손바닥 목표 점·방향). 결정 164의 남은 예외: HoldWound·Grab·BraceAgainstWall 손은 QP 손 과제로 따른다.
     * 학습형 추종기는 이것을 손 목표 조건으로 받거나, 레퍼런스 생성 쪽 IK로 관절 목표에 녹여야 한다
     */
    hands: Partial<Record<HandName, HandTarget>>;
  } | null;
}

/** 추종기 출력: 근육 계층에 넘기는 것 (지금 = 균형 계층 결과) */
export interface TrackerCommand {
  /** 모터(자세 PD) 목표 관절 자세. 균형·스텝이 하체를 고친 뒤 */
  targets: JointTargets | null;
  /** 관절 토크·중력 보상·모터 배율 (지금 QP 출력 형식) */
  cmd: BalanceCommand | null;
}

/**
 * 추종기 인터페이스 (1.0 뒤 교체 지점). 지금 구현은 'wholeBodyQP'(src/sim/character/balance.ts + stepping.ts + muscles.ts)이고
 * 이 인터페이스로 감싸 부르지는 않는다 — 경계와 데이터 형식을 먼저 고정해 둔 것이다 (결정 9a-3).
 */
export interface Tracker {
  readonly kind: string;
  /** 레퍼런스와 지금 몸 상태로 이번 스텝 명령을 낸다 (dt 고정 1/120 s) */
  track(ref: ReferenceFrame, state: CharacterState, dt: number): TrackerCommand;
}

/** 지금 쓰는 추종기 이름 */
export const CURRENT_TRACKER = 'wholeBodyQP';
