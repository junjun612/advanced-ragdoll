// 반응 사람다움 지표 (2026-10-27, README 결정 162·163). 충격이 있는 시나리오에서만 낸다 (없으면 빈 객체 → 이전 요약 그대로).
//   trunkTiltMaxAfterHit: 첫 충격 뒤 window초 안 Spine2 기울기(월드 위 기준) 최대 (도)
//   staggerSteps: 첫 충격 뒤 걸음 수 (step 이벤트; 스텝 계층·반응 추종 착지 모두)
//   armMomShareMean / armMomShareMax: 충격 뒤 window초 동안 균형 QP가 본 팔 각운동량 비율 |h_arm| / |k_G| (팔 관절 움직임이 만든 COM 둘레 각운동량 / 전신)
//   reactionClipUsed: 반응 클립을 고른 횟수
import type { CharacterState, SimEvent } from '../types';

export class ReactionMetrics {
  private hitT: number | null = null;
  private tilt = 0;
  private steps = 0;
  private share: number[] = [];
  private clips = 0;

  constructor(readonly window: number) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'hit') this.hitT ??= e.t;
    if (e.type === 'step' && this.hitT !== null) this.steps++;
    if (e.type === 'reactionStart') this.clips++;
  }

  onState(s: CharacterState): void {
    if (this.hitT === null || s.time < this.hitT || s.time > this.hitT + this.window) return;
    const q = s.bodies.Spine2.rot;
    // Spine2 위 축의 y = 1 − 2(x² + z²)
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    this.tilt = Math.max(this.tilt, (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI);
    const sh = s.balance?.armMomShare;
    if (typeof sh === 'number' && s.balance.enabled) this.share.push(sh);
  }

  finish(): Record<string, number> {
    if (this.hitT === null) return {};
    const mean = this.share.length ? this.share.reduce((a, b) => a + b, 0) / this.share.length : 0;
    return {
      trunkTiltMaxAfterHit: this.tilt, staggerSteps: this.steps,
      ...(this.share.length ? { armMomShareMean: mean, armMomShareMax: Math.max(...this.share) } : {}),
      ...(this.clips ? { reactionClipUsed: this.clips } : {}),
    };
  }
}
