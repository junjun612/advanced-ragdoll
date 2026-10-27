// 자세 판정 (SPEC 8.2). CharacterState.posture와 summary(fell·kneeled)가 같은 정의를 쓴다.
import type { BodyName, Posture } from '../types';

export interface JudgeConfig {
  groundContactDist: number;
  kneelSpine2TiltDeg: number;
  kneelHipsMinHeight: number;
  kneelHoldTime: number;
  fellComHeight: number;
  recoverComVel: number;
  recoverHoldTime: number;
  limitHitTolDeg: number;
  limitPressMarginDeg: number;
  limitPressVelDegS: number;
  fallDirectionMinDist: number;
  /** 허벅지의 무릎 끝 접촉을 무릎(정강이) 접촉으로 보는 거리 (m, v0.5b) */
  kneeContactDist?: number;
}

/** 지면에 닿아도 넘어짐이 아닌 바디: 발·손·정강이 */
export const SUPPORT_OK: ReadonlySet<BodyName> = new Set<BodyName>(['LeftFoot', 'RightFoot', 'LeftHand', 'RightHand', 'LeftLeg', 'RightLeg', 'LeftToeBase', 'RightToeBase']);
export const SHINS: ReadonlySet<BodyName> = new Set<BodyName>(['LeftLeg', 'RightLeg']);
export const FEET: ReadonlySet<BodyName> = new Set<BodyName>(['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase']);

export interface PostureInput {
  /** 지면에 닿은 바디 */
  ground: ReadonlySet<BodyName>;
  spine2TiltDeg: number;
  hipsHeight: number;
  comHeight: number;
}

export interface PostureResult {
  posture: Posture;
  kneeling: boolean;
  /** 8.2 fell 조건 (자세와 무관하게 평가) */
  fellCond: boolean;
}

export function classifyPosture(s: PostureInput, j: JudgeConfig): PostureResult {
  let onlySupport = true;
  let shin = false;
  for (const b of s.ground) {
    if (!SUPPORT_OK.has(b)) onlySupport = false;
    if (SHINS.has(b)) shin = true;
  }
  const kneeling = s.ground.size > 0 && onlySupport && shin && s.spine2TiltDeg < j.kneelSpine2TiltDeg && s.hipsHeight > j.kneelHipsMinHeight;
  const fellCond = !onlySupport || (!kneeling && s.comHeight < j.fellComHeight);
  const posture: Posture = s.ground.size === 0 ? 'airborne' : kneeling ? 'kneeling' : fellCond ? 'down' : 'standing';
  return { posture, kneeling, fellCond };
}
