// 일어서기 지표 (v0.7, docs/ALGORITHMS.md v0.7). 겟업 이벤트가 없으면 아무것도 내지 않는다(이전 요약 그대로).
// - getupFirstStart: 첫 시작 시각 (초), getupPostureSupine/Prone/Side: 첫 시도의 자세 분류(누움·엎드림·옆)
// - getupStarts / getupDone / getupFails / getupCancels / getupGiveUp: 사건 수
// - getupSuccess: 마지막 겟업이 끝까지(Idle 복귀) 갔고 끝 자세가 서 있음(또는 상처로 무릎 꿇음)이면 1
// - getupStandTime: 성공한 시도의 시작 → 균형 복귀(두 발로 섬) (초), getupDoneTime: 그 쓰러짐의 첫 시도 시작 → 완료(Idle 추종) (초)
// - getupAssistPeakBW: 겟업 보조 수직 힘 최대 / 체중 (허용 범위 maxForceBodyWeight 안), getupAssistTorquePeak (N·m)
// - getupHandContact / getupKneeContact: 일어서는 중(GettingUp) 손·무릎(정강이)이 바닥을 짚었는가 (사람다움: 손으로 밀고 무릎으로 체중 이동)
// - getupAirborneMax: 일어서는 중·막 선 뒤 몸 전체가 바닥에서 뜬 가장 긴 시간 (초, 깡충 뜀·보조로 떠오름 확인)
// - getupBodySpeedMax: 일어서는 중 바디 선속도 최대 (m/s, 순간이동·튐 확인), getupPostSteps: 균형 복귀 뒤 스텝 수
import type { CharacterState, SimEvent } from '../types';

export class GetupMetrics {
  private starts = 0;
  private done = 0;
  private fails = 0;
  private cancels = 0;
  private giveUp = 0;
  private episodeStart: number | null = null;
  private attemptStart: number | null = null;
  private standTime: number | null = null;
  private doneTime: number | null = null;
  private lastDoneT: number | null = null;
  private lastBalanceT: number | null = null;
  private peakF = 0;
  private peakT = 0;
  private hand = 0;
  private knee = 0;
  private speed = 0;
  private postSteps = 0;
  private lastState: CharacterState | null = null;
  private firstStart: number | null = null;
  private firstPosture = '';
  private airRun = 0;
  private airMax = 0;
  private prevT: number | null = null;

  constructor(readonly weight: number) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'getupStart') { this.starts++; if (this.firstStart === null) this.firstPosture = e.detail?.split(' ')[1] ?? ''; this.firstStart ??= e.t; this.attemptStart = e.t; this.episodeStart ??= e.t; }
    else if (e.type === 'getupBalance') { this.lastBalanceT = e.t; if (this.attemptStart !== null) this.standTime = e.t - this.attemptStart; this.postSteps = 0; }
    else if (e.type === 'getupDone') { this.done++; this.lastDoneT = e.t; if (this.episodeStart !== null) this.doneTime = e.t - this.episodeStart; this.episodeStart = null; }
    else if (e.type === 'getupFail') this.fails++;
    else if (e.type === 'getupCancel') this.cancels++;
    else if (e.type === 'getupGiveUp') { this.giveUp++; this.episodeStart = null; }
    else if (e.type === 'step' && this.lastBalanceT !== null) this.postSteps++;
  }

  onState(s: CharacterState): void {
    this.lastState = s;
    const dt = this.prevT === null ? 0 : s.time - this.prevT;
    this.prevT = s.time;
    // 일어서는 중·막 선 뒤 바닥에서 몸이 다 뜬 시간 (깡충 뛰기·떠오름 확인)
    if (s.state === 'GettingUp' || s.getup?.phase === 'balance') {
      this.airRun = s.contacts.length ? 0 : this.airRun + dt;
      this.airMax = Math.max(this.airMax, this.airRun);
    } else this.airRun = 0;
    if (s.state !== 'GettingUp') return;
    const g = s.getup;
    if (g) { this.peakF = Math.max(this.peakF, g.assist.force); this.peakT = Math.max(this.peakT, g.assist.torque); }
    for (const c of s.contacts) {
      if (c.body === 'LeftHand' || c.body === 'RightHand') this.hand = 1;
      if (c.body === 'LeftLeg' || c.body === 'RightLeg') this.knee = 1;
    }
    for (const b of Object.values(s.bodies)) this.speed = Math.max(this.speed, Math.hypot(...b.linVel));
  }

  finish(): Record<string, number> {
    if (!this.starts) return {};
    const last = this.lastState;
    // 성공 = 마지막 겟업이 Idle 복귀까지 갔고 끝에 누워 있지 않음 (서 있음, 또는 상처가 깊어 일어선 뒤 무릎을 꿇음 — 피해 누적 Kneel, README 결정)
    const success = this.lastDoneT !== null && (last?.posture === 'standing' || last?.posture === 'kneeling') && last.getup?.phase !== 'rising' ? 1 : 0;
    return {
      getupStarts: this.starts, getupFirstStart: this.firstStart ?? 0, getupPostureSupine: this.firstPosture === 'supine' ? 1 : 0, getupPostureProne: this.firstPosture === 'prone' ? 1 : 0, getupPostureSide: this.firstPosture === 'side' ? 1 : 0, getupDone: this.done, getupFails: this.fails, getupCancels: this.cancels, getupGiveUp: this.giveUp, getupSuccess: success,
      ...(this.standTime !== null ? { getupStandTime: this.standTime } : {}),
      ...(this.doneTime !== null ? { getupDoneTime: this.doneTime } : {}),
      getupAssistPeakBW: this.peakF / this.weight, getupAssistTorquePeak: this.peakT,
      getupHandContact: this.hand, getupKneeContact: this.knee, getupBodySpeedMax: this.speed, getupPostSteps: this.postSteps, getupAirborneMax: this.airMax,
    };
  }
}
