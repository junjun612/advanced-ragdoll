// 행동 계층 공통 타입 (SPEC v0.5 '행동 프레임워크'). 정의: docs/ALGORITHMS.md v0.5a.
import type { Ragdoll } from '../ragdoll';
import type { CharacterDef, BodyName } from '../characterDef';
import type { JointName, JointTargets } from '../pose';
import type { FootName, Perception } from '../perception';
import type { Wound } from '../hitModel';
import type { Vec3 } from '../../math/vec3';
import type { Quat } from '../../math/quat';
import type { Vec2 } from '../../math/geometry';
import type { Prng } from '../../prng';
import type { FallSignal } from './fall';
import type { AirSignal } from './air';

export type HandName = 'LeftHand' | 'RightHand';
export const HANDS: readonly HandName[] = ['LeftHand', 'RightHand'];

/** 관절 하나에 대한 행동 출력. target = 덮어쓸 목표(정의 관절 좌표계 상대 회전), add = 아래 레이어 결과 앞에 곱할 회전, strength = 강도 배율 */
export interface JointOut {
  target?: Quat;
  add?: Quat;
  /** 이 관절에서의 가중치 (행동 가중치와 곱해진다) */
  weight: number;
  strength?: number;
  /** 힘 상한 배율 (최대 토크만 줄임, 명령 토크는 그대로 — InjuredLeg) */
  capacity?: number;
}

/** 손 IK 목표 (전신 QP 손 과제): 손바닥 점(손 바디 원점 + palmLocal)의 월드 위치·속도, 손 월드 회전, 기준 각속도 */
export interface HandTarget {
  palm: Vec3;
  vel: Vec3;
  rot: Quat;
  angVel: Vec3;
  /** 손바닥 점 (손 바디 로컬) */
  palmLocal: Vec3;
  weight: number;
  /** 과제 이득 (behaviors.json HoldWound.task) */
  task: { kp: number; kd: number; weight: number; rotKp: number; rotKd: number; rotWeight: number; handReg?: number };
  woundId: number | null;
}

/**
 * 쥐지 않는 팔 (v0.5a 반사·벌림, v0.5b 느슨함): loose(0~1)만큼 그 팔(어깨·팔꿈치·손목)을 전신 QP 토크에서 빼고
 * 근육 모터(kp × looseMotorScale) + 중력 보상만으로 둔다 — 몸이 흔들리면 팔이 수동으로 흔들렸다가 rest로 돌아온다.
 * QP는 그 팔 가속도를 looseReg로 정규화해 팔을 플라이휠로 계획하지 않는다
 */
export interface FreeArm { reflexScale: number; abductDeg: number; loose: number; looseMotorScale: number; looseReg: number; /** 느슨하게 둘 손 (쥐는 손 제외) */ hands: HandName[]; /** 느슨하게 둘 팔 마디 (Arm·ForeArm·Hand 중) */ parts: string[] }

/** 스텝 계층 수정 (InjuredLeg, Stagger) */
export interface StepMods {
  injuredFoot?: FootName | null;
  injuredPenalty?: number;
  injuredStepScale?: number;
  maxSteps?: number | null;
  irregular?: { duration: number; overshoot: number; lateral: number } | null;
  /** 서 있을 때 스텝 문턱을 늦추는 양 (m, 일부러 몸을 굽히는 행동) */
  triggerRelax?: number;
  /** (v0.8a StairStep) 지형 디딤: 발판 검사로 착지 목표를 디딤면에 맞추고, 높이 차를 스윙·IK에 반영 */
  terrainStep?: boolean;
  /** (v0.8c, 결정 178) 일부러 딛는 걸음(밀어낸 뒤 물러나기): 서 있는 동안 걸음 수를 새로 센다 — 앞 흔들림의 걸음 수에 더해져 비틀거림(maxSteps)으로 넘어가지 않게 */
  newEpisode?: boolean;
}

export interface BehaviorOutput {
  joints: Partial<Record<JointName, JointOut>>;
  hands?: Partial<Record<HandName, HandTarget>>;
  /** 시선 목표 (월드)와 그 가중치 */
  gaze?: { target: Vec3; weight: number } | null;
  /** 균형 모드: on(기본) / weak(몸통 과제 이득 낮춤) / off */
  balanceMode?: 'on' | 'weak' | 'off';
  /** 스텝 허용 (false면 이번 스텝 계층 쉼) */
  stepAllowed?: boolean;
  /** 균형을 끄는 COM 높이 기준 덮어쓰기 (m, v0.5b Kneel: 무릎이 닿을 때까지 균형 유지) */
  minComHeight?: number;
  /** COM 높이 목표 낮추기 (m) */
  comDrop?: number;
  /** 서 있을 때 COM 목표 이동 (xz, m) */
  comShift?: Vec2;
  /** 몸통을 일부러 굽히는 만큼 균형을 끄는 기울기 기준을 늘림 (도) */
  tiltAllowDeg?: number;
  /** 쥐지 않는 팔의 반사 배율·벌림·느슨함 (HoldWound) */
  freeArm?: FreeArm;
  /** 몸통 과제 이득 배율 (상체 강성) */
  trunkGainScale?: number;
  stepping?: StepMods;
}

/** 행동이 매 스텝 읽는 것 (지금 몸 상태는 rd에서 직접) */
export interface BehaviorContext {
  t: number;
  dt: number;
  rd: Ragdoll;
  def: CharacterDef;
  per: Perception;
  /** 이 행동 아래 레이어까지 합친 관절 목표 (클립·서기 포즈 포함) */
  base: JointTargets;
  /** 바디 이름 → 인덱스 */
  bodyIdx: (n: BodyName) => number;
  wounds: readonly Wound[];
  /** 지금 다른 행동이 쥐고 있는 손 (덜 바쁜 손 고르기) */
  busyHands: ReadonlySet<HandName>;
  /** 스텝 계층 상태 (Stagger) */
  stepping: {
    busy: boolean; state: string; stepCount: number;
    /** (v0.8a) 지금 스텝 착지 목표 (없으면 null) */ target?: Vec3 | null;
    /** (반응 클립) 스윙 발과 착지 목표 — 넘어짐 바닥을 곧 디딜 자리로 잡는다 (README 결정 164) */
    swing?: { foot: 'LeftFoot' | 'RightFoot'; target: readonly number[] } | null;
  };
  rng: Prng;
  /** 넘어짐 신호 (v0.5b FallMonitor) */
  fall: FallSignal | null;
  /** 피해 누적으로 무릎을 꿇을 만큼 다쳤는가 (v0.5b): 상처를 쥔 손을 놓지 않는다 */
  badlyHurt: boolean;
  /** 공중 신호 (v0.5c AirMonitor) */
  air: AirSignal | null;
  /** (v0.8b) 직전 스텝에 행동들이 곱한 관절 강도 배율 (Grab: 팔 힘이 빠지면 놓기) */
  lastStrength?: Partial<Record<JointName, number>>;
}

export abstract class Behavior {
  abstract readonly name: string;
  /** 의도 반응이 시작되는 시각 (감지 지연 뒤). 가중치는 여기서부터 transitionTime 동안 0 → 1 */
  startT: number;
  /** 끄기 요청 시각 (여기서부터 transitionTime 동안 1 → 0) */
  stopT: number | null = null;
  /** 이번 스텝 행동 가중치 (블렌더가 채움) */
  weight = 0;
  /** 로그용 단계 이름 */
  phase = '';
  constructor(readonly params: Record<string, unknown>, t0: number, readonly hitT: number) {
    this.startT = t0;
  }
  /** 블렌더 가중치를 무시하고 바로 1인 부분(힘 빠짐 등 수동 반응)이 있으면 true — 가중치는 출력 쪽에서 직접 다룬다 */
  get immediate(): boolean { return false; }
  stop(t: number): void { if (this.stopT === null) this.stopT = t; }
  abstract update(ctx: BehaviorContext): BehaviorOutput;
  /** 끝났으면 블렌더가 목록에서 뺀다 */
  done(t: number, transition: number): boolean { return this.stopT !== null && t >= this.stopT + transition; }
  /** 로그용 추가 정보 */
  info(): Record<string, unknown> | null { return null; }
  /** (v0.8b) 목록에서 빠질 때 (물리 객체 정리: 잡기 관절) */
  dispose(): void { /* 기본: 없음 */ }
}

export const smoothstep = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
/** 오르기 rise, 유지 hold, 내리기 fall (초) 사다리꼴 프로파일 (smoothstep 모서리), τ = 시작부터 시간 */
export const envelope = (tau: number, rise: number, hold: number, fall: number): number => {
  if (tau <= 0) return 0;
  if (tau < rise) return smoothstep(tau / rise);
  if (tau < rise + hold) return 1;
  return 1 - smoothstep((tau - rise - hold) / Math.max(1e-6, fall));
};
