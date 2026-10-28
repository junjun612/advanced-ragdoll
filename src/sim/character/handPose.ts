// 손가락 포즈 상태 (README 결정 pres-1): 손가락은 물리 바디가 아니다. 행동·접촉 상태로 손마다 포즈를 정하고
// 굽힘(curl)·벌림(spread)·엄지(thumb) 값을 스텝마다 부드럽게 따라가게 해 로그(CharacterState.fingers)로 내보낸다.
// 렌더(FBX 스킨)가 이 값을 손가락 본 회전으로 바꾼다. 시뮬레이션 결과(물리)에는 영향이 없다.
import type { BehaviorBlender } from './behaviors/blender';
import { HANDS, type HandName } from './behaviors/types';
import { Grab, HangOnLedge, BraceAgainstWall } from './behaviors/grab';
import { HoldWound } from './behaviors/holdWound';
import { BraceForFall, CatchFall, ProtectHead } from './behaviors/fall';
import { Flail } from './behaviors/air';

export type HandPoseName = 'rest' | 'limp' | 'fist' | 'grip' | 'reach' | 'clutch' | 'open' | 'guard' | 'spread';

export interface HandShape { curl: number; spread: number; thumb: number }

export interface HandPoseConfig {
  enabled: boolean;
  poses: Record<HandPoseName, HandShape>;
  /** 한글 이름 (필름 라벨) */
  ko: Record<HandPoseName, string>;
  /** 굽힘이 늘 때(쥐기)·줄 때(펴기)·이완으로 갈 때 시간 상수 (초) */
  tauClose: number;
  tauOpen: number;
  tauRelax: number;
  /** 피격 뒤 이 시간 동안 의도 반응(HitReaction)이 켜져 있으면 손에 힘이 들어감 (fist) */
  tenseWindow: number;
  /** 손목 근육 강도가 이보다 낮으면 늘어진 손 (limp) */
  limpStrength: number;
  /** 반응 걸음이 끝난 뒤에도 벌림을 유지하는 시간 (초) */
  spreadHold: number;
}

export interface FingerLog { pose: HandPoseName; curl: number; spread: number; thumb: number }

export class HandPoseController {
  readonly cur: Record<HandName, FingerLog>;
  /** 마지막으로 반응 걸음 중이던 시각 (벌림 유지) */
  private spreadT = -Infinity;
  constructor(readonly cfg: HandPoseConfig) {
    const r = cfg.poses.rest;
    this.cur = { LeftHand: { pose: 'rest', ...r }, RightHand: { pose: 'rest', ...r } };
  }

  /** 행동·접촉으로 손 포즈를 고른다 (우선순위 순) */
  private choose(h: HandName, x: { t: number; bl: BehaviorBlender; ground: ReadonlySet<string>; lying: boolean; state: string; handStrength: number; stepping: boolean }): HandPoseName {
    const live = x.bl.list.filter((b) => b.stopT === null);
    if (x.state === 'Ragdoll' || live.some((b) => b.name === 'Limp')) return 'limp';
    for (const b of live) {
      if (b instanceof Grab && b.hand === h) return b.holding ? 'grip' : b.grabPhase === 'reach' ? 'reach' : 'rest';
      if (b instanceof HangOnLedge) return 'grip';
      if (b instanceof BraceAgainstWall && b.hands.includes(h)) return 'open';
      if (b instanceof HoldWound && b.hand === h && b.usesHand) return b.phase === '누르기' ? 'clutch' : 'reach';
    }
    // 바닥을 짚는 손 (손 짚기·일어서기·누운 채 바닥에 닿음): 손바닥을 편다
    if (x.ground.has(h)) return x.lying && x.state !== 'GettingUp' && !live.some((b) => b instanceof CatchFall) ? 'limp' : 'open';
    if (live.some((b) => b instanceof CatchFall)) return 'open';
    const brace = live.find((b): b is BraceForFall => b instanceof BraceForFall);
    if (brace && !brace.ended && brace.arms.includes(h)) return 'open';
    if (live.some((b) => b instanceof ProtectHead && b.hands.includes(h) && b.releaseT === null)) return 'guard';
    if (live.some((b) => b instanceof Flail)) return 'spread';
    // 누움·몸부림·이완: 힘 빠진 반쯤 굽은 손
    if (x.lying || live.some((b) => b.name === 'Lie' || b.name === 'Writhe' || b.name === 'ImpactRelax')) return 'limp';
    if (x.handStrength < this.cfg.limpStrength) return 'limp';
    // 맞은 직후 의도 반응: 손에 힘이 들어감 (움찔하며 주먹)
    if (live.some((b) => b.name === 'HitReaction' && x.t - b.hitT < this.cfg.tenseWindow)) return 'fist';
    // 균형을 잡으며 내딛는 중(스텝 계층 lift·step): 손가락이 벌어진다 (Stagger는 대기 중에도 켜져 있어 쓰지 않는다)
    // 걸음 사이(두 발 지지 잠깐)에도 spreadHold초는 벌린 채 — 걸음마다 손가락이 쥐었다 폈다 깜빡이지 않게
    if (x.stepping) { this.spreadT = x.t; return 'spread'; }
    if (x.t - this.spreadT < this.cfg.spreadHold) return 'spread';
    return 'rest';
  }

  update(dt: number, x: { t: number; bl: BehaviorBlender; ground: ReadonlySet<string>; lying: boolean; state: string; handStrength: Record<HandName, number>; stepping: boolean }): void {
    if (!this.cfg.enabled) return;
    for (const h of HANDS) {
      const pose = this.choose(h, { ...x, handStrength: x.handStrength[h] });
      const goal = this.cfg.poses[pose], c = this.cur[h];
      const tau = pose === 'limp' || pose === 'rest' ? this.cfg.tauRelax : goal.curl > c.curl ? this.cfg.tauClose : this.cfg.tauOpen;
      const k = 1 - Math.exp(-dt / tau);
      c.pose = pose;
      c.curl += (goal.curl - c.curl) * k;
      c.spread += (goal.spread - c.spread) * k;
      c.thumb += (goal.thumb - c.thumb) * k;
    }
  }

  log(): Record<HandName, FingerLog> {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const o = {} as Record<HandName, FingerLog>;
    for (const h of HANDS) { const c = this.cur[h]; o[h] = { pose: c.pose, curl: r(c.curl), spread: r(c.spread), thumb: r(c.thumb) }; }
    return o;
  }
}
