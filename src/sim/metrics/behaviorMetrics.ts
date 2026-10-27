// 행동·피격 지표 (v0.5a, SPEC 12 v0.5a 대표 장면 완료 기준·9.2 v0.5a 기대값). 매 스텝 CharacterState만 읽는다. 정의: docs/ALGORITHMS.md v0.5a.
// 기준 피격 = 첫 bullet/melee 피격(없으면 첫 피격). 손 지표는 그 피격의 상처를 쥐는 손(행동 로그 hands)으로 잰다.
// - clutchReachTime: 피격 → 손바닥 점이 상처 점에서 clutchDist 안에 처음 든 시각 (초)
// - clutchHoldTime: clutchDist 안에 머문 가장 긴 연속 시간 (clutchGap초 미만 이탈은 이어 붙임)
// - clutchIntentOnset: 피격 → HoldWound 가중치 > 0.01 (의도 반응 시작)
// - clutchMoveOnset: 피격 → 손바닥이 상처 쪽으로 다가가는 속도(손바닥-상처 거리 감소율, moveWindow초 평균)가 moveOnsetSpeed를 처음 넘은 시각
//   (손 이동 시작. 상처 점 기준 상대 속도라서 피격 순간 몸통이 젖혀지며 생기는 수동 움직임은 다가감으로 세지 않는다)
// - clutchDistMean: 쥐고 있는 동안(clutchDist 안) 손바닥-상처 거리 평균
// - trunkYawTowardHitDeg: 피격 뒤 yawWindow초 동안 Spine2 heading yaw 변화 중 충격 토크 방향(맞은 쪽) 성분의 최대
// - comAlongHit: 피격 뒤 COM 수평 이동의 충격 방향 성분 최대 (m)
// - gazeErrorDeg: 마지막 gazeWindow초 동안 머리 앞(+Z)과 시선 대상 방향 사이 각 평균
// - hitJointStrengthMin: 피격 뒤 0.5초 안 맞은 바디 관절 strength 최소 (맞은 바디가 Hips면 Spine)
// - stepsInjuredFoot / stepsHealthyFoot / firstStepHealthy: InjuredLeg가 있을 때 발별 걸음 수, 첫 걸음이 성한 발이면 1
// - injuredLegStrengthMax: InjuredLeg 동안 다친 다리 고관절 strength 최대, loadHealthyMean: 마지막 1.5초 성한 발 하중 비율 평균
// - hitReactedEvents: hitReacted 이벤트 수
// (v0.5b) - braceStart: BraceForFall 가중치 > 0.01 첫 시각, braceLeadTime: 그때부터 발 아닌 바디가 지면에 처음 닿을 때까지 (초)
//   fallCertaintyMax: 넘어짐 확실도 최대, fallPredictError: 예측 손 착지점(대비 시작 때)과 실제 첫 손 접촉점 수평 거리 (m)
// - limpKneeLeadTime: Limp 시작 뒤 Spine2가 limpSpine2Drop m 내려간 시각 − 무릎 굽힘이 limpKneeFlexDeg에 닿은 시각 (양수 = 무릎이 먼저)
// (v0.5c) 공중·바닥 (※ 정의, docs/ALGORITHMS.md v0.5c):
// - airTimeMax: 가장 긴 비행(지면 접촉 없음) 시간 (초), touchdownT: 그 비행이 끝난 시각, touchdownSpeedH: 그때 COM 수평 속도
// - flailAirCoverage: 그 비행 중 시작 + flailGrace초(공중 감지 + 감지 지연 + 전환) 뒤부터 착지까지 Flail 가중치 > 0.01인 비율
// - prepLandingLead: 착지 시각 − 그 비행 중 PrepareLanding 가중치 > 0.01이 된 첫 시각 (초)
// - rolled: Roll이 켜진 적 있으면 1, rollDegMax: Roll 동안 골반이 굴러간 각 (도)
// - writheStart: Writhe 가중치 > 0.01 첫 시각, 그때부터 writheWindow초 동안: writheComSpeedMax (m/s), writheJointSpeedMean (관절 상대 각속도 크기 평균 °/s),
//   writheSpeedInRange: writheJointSpeedMean이 behaviors.json Writhe.jointSpeedRange 안이면 1, writheWindowS: 실제로 잰 길이 (초)
// (v0.8a) 지형 (※ 정의, docs/ALGORITHMS.md v0.8a, 그 행동이 켜진 시나리오에만):
// - tumbled: Tumble이 켜진 적 있으면 1, tumbleTime: Tumble 가중치 > 0.01이고 풀기 전인 시간 (초), tumbleGuardFrac: 그동안 손바닥이 머리에서 0.2 m 안인 손이 있던 비율,
//   tumbleDrop: Tumble 시작 때 COM 아래 지면 높이 − 끝(마지막 프레임) 높이 (m, 굴러 내려간 높이) — 지면 높이는 로그에 없어 COM 높이 차로 근사
// - tripped: Trip이 켜진 적 있으면 1, misstep: Misstep이 켜진 적 있으면 1
// (v0.8b) 잡기·벽 (※ 정의, docs/ALGORITHMS.md v0.8b, 잡기·벽 짚기가 시도된 시나리오에만):
// - grabbed: 잡기 관절을 만든 적 있으면 1, gripTime: 기준 피격 → 첫 잡음 (초), grabSlipMax: 잡은 동안 손바닥 점과 앵커(잡은 순간 손바닥 점) 거리 최대 (m),
//   grabForceMax: 잡기 관절 추정 힘 최대 (N), grabHoldTime: 한 손 이상 잡고 있던 시간 (초), hangTime: HangOnLedge 가중치 > 0.5 시간 (초)
// - wallBraced: 벽 짚기 중 손·어깨가 벽에 닿았으면 1, wallContactLead: 피격 → 첫 벽 접촉 (초), wallContactSpeed: 그때 손바닥(어깨는 COM 수평) 속도 (m/s), wallPushOff: 밀어내기를 시작했으면 1
import behaviorsCfg from '../../../config/behaviors.json';
import type { CharacterState, SimEvent, Vec3, BodyName } from '../types';
import { rotate } from '../math/quat';
import { FEET as FEET_ALL } from './posture';

export interface BehaviorJudge {
  clutchDist: number;
  clutchGap: number;
  moveOnsetSpeed: number;
  moveWindow: number;
  gazeWindow: number;
  yawWindow: number;
  limpKneeFlexDeg: number;
  limpSpine2Drop: number;
  /** v0.5c */
  flailGrace: number;
  writheWindow: number;
}

const yawOf = (q: readonly [number, number, number, number]): number => { const f = rotate(q as never, [0, 0, 1]); return Math.atan2(f[0], f[2]); };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class BehaviorMetrics {
  private hit: { t: number; body: BodyName | null; dir: Vec3; point: Vec3 | null; type: string } | null = null;
  private hitState: { yaw: number; com: Vec3; yawSign: number } | null = null;
  private woundId: number | null = null;
  private dHist: { t: number; d: number }[] = [];
  private reach: number | null = null;
  private intent: number | null = null;
  private move: number | null = null;
  private runStart: number | null = null;
  private lastIn: number | null = null;
  private holdMax = 0;
  private inSum = 0;
  private inN = 0;
  private yawMax = -Infinity;
  private yawAbs = 0;
  private along = 0;
  private gaze: { t: number; e: number }[] = [];
  private lastT = 0;
  private hitStrMin = Infinity;
  private injured: 'LeftFoot' | 'RightFoot' | null = null;
  private steps: { foot: string; t: number }[] = [];
  private injStrMax = -Infinity;
  private injSince: number | null = null;
  private loads: { t: number; healthy: number }[] = [];
  private reacted = 0;
  private any = false;
  private braceT: number | null = null;
  private bracePred: Record<string, Vec3> | null = null;
  private groundT: number | null = null;
  private handErr: number | null = null;
  private certMax = 0;
  private limp: { t: number; s2: number; knee: number | null; drop: number | null } | null = null;
  // v0.5c
  private flight: { t0: number; frames: { t: number; flail: boolean }[]; prep: number | null } | null = null;
  private best: { dur: number; td: number; speedH: number; cover: number | null; prepLead: number | null } | null = null;
  private rolled = false;
  // (v0.8b) 잡기·벽
  private grabTried = false;
  private gripT: number | null = null;
  private grabHold = 0;
  private grabSlip = 0;
  private grabForce = 0;
  private hang = 0;
  private wallTried = false;
  private wallContact: { t: number; body: string; speed: number } | null = null;
  private wallPush = false;
  private tumble: { t0: number; y0: number; time: number; guard: number; active: number; yEnd: number } | null = null;
  private tripped = false;
  private prevT: number | null = null;
  private misstep = false;
  private rollDeg = 0;
  private writhe: { t0: number; comMax: number; sum: number; n: number; last: number } | null = null;

  constructor(readonly j: BehaviorJudge) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'hit') {
      const strong = e.detail === 'bullet' || e.detail === 'melee';
      if (!this.hit || (strong && this.hit.type === 'push')) {
        this.hit = { t: e.t, body: e.body ?? null, dir: e.direction ?? [0, 0, 0], point: e.point ?? null, type: e.detail ?? 'push' };
        this.hitState = null;
      }
    }
    if (e.type === 'hitReacted') this.reacted++;
    if (e.type === 'step') this.steps.push({ foot: e.body ?? '', t: e.t });
  }

  onState(s: CharacterState): void {
    const t = s.time;
    this.lastT = t;
    const b = s.behavior;
    if (b && b.active.length) this.any = true;
    const inj = b?.active.find((x) => x.name === 'InjuredLeg');
    if (inj && !this.injured) this.injured = (inj.info?.foot as 'LeftFoot' | 'RightFoot') ?? null;
    if (this.injured) {
      const hip = s.joints[this.injured === 'LeftFoot' ? 'LeftUpLeg' : 'RightUpLeg'];
      // 근육 활성화 저역 통과(30ms)가 끝난 뒤부터 (켜진 뒤 0.2초)
      this.injSince ??= t;
      if (inj && t - this.injSince > 0.2) this.injStrMax = Math.max(this.injStrMax, hip.strength);
      const ll = s.balance?.loadLeft;
      if (ll !== undefined && s.balance.enabled) this.loads.push({ t, healthy: this.injured === 'LeftFoot' ? 1 - ll : ll });
    }
    if (b?.gaze) this.gaze.push({ t, e: b.gaze.errorDeg });
    // 넘어짐 (v0.5b)
    if (b?.fall) this.certMax = Math.max(this.certMax, b.fall.certainty);
    const br = b?.active.find((x) => x.name === 'BraceForFall');
    if (br && br.weight > 0.01 && this.braceT === null) { this.braceT = t; this.bracePred = b?.fall ? { ...b.fall.hands } : null; }
    const nonFoot = s.contacts.filter((c) => !FEET_ALL.has(c.body));
    if (this.braceT !== null && this.groundT === null && nonFoot.length) this.groundT = t;
    if (this.braceT !== null && this.handErr === null && this.bracePred) {
      const hc = s.contacts.find((c) => c.body === 'LeftHand' || c.body === 'RightHand');
      const pp = hc ? this.bracePred[hc.body] : undefined;
      if (hc && pp) this.handErr = Math.hypot(hc.point[0] - pp[0], hc.point[2] - pp[2]);
    }
    // 공중·바닥 (v0.5c)
    const wOf = (n: string) => b?.active.find((x) => x.name === n)?.weight ?? 0;
    const contact = s.contacts.length > 0;
    if (!contact) {
      this.flight ??= { t0: t, frames: [], prep: null };
      this.flight.frames.push({ t, flail: wOf('Flail') > 0.01 });
      if (this.flight.prep === null && wOf('PrepareLanding') > 0.01) this.flight.prep = t;
    } else if (this.flight) {
      const f = this.flight;
      const dur = t - f.t0;
      if (!this.best || dur > this.best.dur) {
        const fr = f.frames.filter((x) => x.t >= f.t0 + this.j.flailGrace);
        this.best = { dur, td: t, speedH: Math.hypot(s.comVel[0], s.comVel[2]), cover: fr.length ? fr.filter((x) => x.flail).length / fr.length : null, prepLead: f.prep === null ? null : t - f.prep };
      }
      this.flight = null;
    }
    const tb = b?.active.find((x) => x.name === 'Tumble');
    if (tb) {
      this.tumble ??= { t0: t, y0: s.com[1], time: 0, guard: 0, active: 0, yEnd: s.com[1] };
      const pv = this.prevT;
      if (tb.weight > 0.01 && tb.info?.endT === null && pv !== null) this.tumble.time += t - pv;
      this.tumble.guard = Number(tb.info?.guardTime ?? 0);
      this.tumble.active = Number(tb.info?.activeTime ?? 0);
    }
    if (this.tumble) this.tumble.yEnd = s.com[1];
    if (b?.active.some((x) => x.name === 'Trip')) this.tripped = true;
    if (b?.active.some((x) => x.name === 'Misstep')) this.misstep = true;
    // (v0.8b) 잡기·벽
    const gl = b?.grab;
    if (gl) {
      const dtp = this.prevT === null ? 0 : t - this.prevT;
      const hold = gl.hands.filter((h) => h.phase === 'hold');
      if (gl.hands.length) this.grabTried = true;
      if (hold.length) {
        this.gripT ??= t;
        this.grabHold += dtp;
        for (const h of hold) { this.grabSlip = Math.max(this.grabSlip, h.slip); this.grabForce = Math.max(this.grabForce, h.force); }
      }
    }
    if (b?.active.some((x) => x.name === 'HangOnLedge' && x.weight > 0.5)) this.hang += this.prevT === null ? 0 : t - this.prevT;
    const wb = b?.active.find((x) => x.name === 'BraceAgainstWall');
    if (wb) {
      this.wallTried = true;
      const fc = wb.info?.firstContact as { t: number; body: string; speed: number } | null | undefined;
      if (fc && !this.wallContact) this.wallContact = fc;
      if (wb.info?.pushT !== null && wb.info?.pushT !== undefined) this.wallPush = true;
    }
    this.prevT = t;
    const roll = b?.active.find((x) => x.name === 'Roll');
    if (roll) { this.rolled = true; this.rollDeg = Math.max(this.rollDeg, Number(roll.info?.rollDeg ?? 0)); }
    if (wOf('Writhe') > 0.01) this.writhe ??= { t0: t, comMax: 0, sum: 0, n: 0, last: t };
    if (this.writhe && t <= this.writhe.t0 + this.j.writheWindow + 1e-9) {
      const w = this.writhe;
      w.comMax = Math.max(w.comMax, Math.hypot(...s.comVel));
      let js = 0, jn = 0;
      for (const k in s.joints) { const v = s.joints[k as keyof typeof s.joints].relAngVelDegS; js += Math.hypot(v[0], v[1], v[2]); jn++; }
      if (jn) { w.sum += js / jn; w.n++; }
      w.last = t;
    }
    const lp = b?.active.find((x) => x.name === 'Limp');
    if (lp && !this.limp) this.limp = { t, s2: s.bodies.Spine2.pos[1], knee: null, drop: null };
    if (this.limp) {
      const knee = Math.max(s.joints.LeftLeg.coordsDeg[0], s.joints.RightLeg.coordsDeg[0]);
      if (this.limp.knee === null && knee >= this.j.limpKneeFlexDeg) this.limp.knee = t;
      if (this.limp.drop === null && s.bodies.Spine2.pos[1] <= this.limp.s2 - this.j.limpSpine2Drop) this.limp.drop = t;
    }
    const h = this.hit;
    if (!h || t < h.t) return;
    if (!this.hitState) {
      const yaw = yawOf(s.bodies.Spine2.rot);
      const r: Vec3 = h.point ? [h.point[0] - s.com[0], 0, h.point[2] - s.com[2]] : [0, 0, 0];
      const ty = r[2] * h.dir[0] - r[0] * h.dir[2];
      this.hitState = { yaw, com: [...s.com] as Vec3, yawSign: Math.sign(ty) };
    }
    const hs = this.hitState;
    const tau = t - h.t;
    // 맞은 바디 관절 strength
    if (tau <= 0.5 && h.body) {
      const jn = (h.body === 'Hips' ? 'Spine' : h.body) as keyof typeof s.joints;
      const js = s.joints[jn];
      if (js) this.hitStrMin = Math.min(this.hitStrMin, js.strength);
    }
    if (tau <= this.j.yawWindow) {
      const dy = wrap(yawOf(s.bodies.Spine2.rot) - hs.yaw) * (180 / Math.PI);
      this.yawAbs = Math.max(this.yawAbs, Math.abs(dy));
      if (hs.yawSign !== 0) this.yawMax = Math.max(this.yawMax, hs.yawSign * dy);
    }
    const dh = Math.hypot(h.dir[0], h.dir[2]);
    if (dh > 1e-6) this.along = Math.max(this.along, ((s.com[0] - hs.com[0]) * h.dir[0] + (s.com[2] - hs.com[2]) * h.dir[2]) / dh);
    // 손 (그 피격의 상처를 쥐는 손)
    if (!b) return;
    if (this.woundId === null) {
      const w = b.wounds.find((x) => Math.abs(x.t - h.t) < 1e-6);
      if (w) this.woundId = w.id;
    }
    if (this.woundId === null) return;
    const hw = b.active.find((x) => x.name === 'HoldWound' && x.info?.woundId === this.woundId);
    if (hw && hw.weight > 0.01 && this.intent === null) this.intent = tau;
    const hand = (hw?.info?.hand as string | undefined) ?? b.hands.find((x) => x.woundId === this.woundId)?.hand;
    const wd = b.wounds.find((x) => x.id === this.woundId);
    if (!hand || !wd) return;
    // 손바닥 점은 행동 로그(hands[].palm, HoldWound가 손 과제를 거는 동안)에서 읽는다
    const lh = b.hands.find((x) => x.hand === hand);
    if (!lh) return;
    const palm = lh.palm;
    const d = Math.hypot(palm[0] - wd.point[0], palm[1] - wd.point[1], palm[2] - wd.point[2]);
    this.dHist.push({ t, d });
    while (this.dHist.length > 2 && this.dHist[1]!.t <= t - this.j.moveWindow) this.dHist.shift();
    const h0 = this.dHist[0]!;
    if (this.move === null && t - h0.t >= this.j.moveWindow - 1e-9 && (h0.d - d) / (t - h0.t) >= this.j.moveOnsetSpeed) this.move = h0.t - h.t;
    if (d <= this.j.clutchDist) {
      if (this.reach === null) this.reach = tau;
      if (this.runStart === null || (this.lastIn !== null && t - this.lastIn > this.j.clutchGap)) this.runStart = t;
      this.lastIn = t;
      this.holdMax = Math.max(this.holdMax, t - this.runStart);
      this.inSum += d; this.inN++;
    }
  }

  finish(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.any) return out;
    if (this.hit) {
      out.comAlongHit = this.along;
      if (this.hitState?.yawSign) out.trunkYawTowardHitDeg = this.yawMax;
      out.trunkYawMaxAbsDeg = this.yawAbs;
      if (Number.isFinite(this.hitStrMin)) out.hitJointStrengthMin = this.hitStrMin;
    }
    if (this.woundId !== null) {
      out.clutchReachTime = this.reach ?? 99;
      out.clutchHoldTime = this.holdMax;
      if (this.intent !== null) out.clutchIntentOnset = this.intent;
      out.clutchMoveOnset = this.move ?? 99;
      if (this.inN) out.clutchDistMean = this.inSum / this.inN;
    }
    const g = this.gaze.filter((x) => x.t >= this.lastT - this.j.gazeWindow);
    if (g.length) out.gazeErrorDeg = g.reduce((a, x) => a + x.e, 0) / g.length;
    if (this.injured) {
      const inj = this.steps.filter((s) => s.foot === this.injured).length;
      out.stepsInjuredFoot = inj;
      out.stepsHealthyFoot = this.steps.length - inj;
      if (this.steps.length) out.firstStepHealthy = this.steps[0]!.foot !== this.injured ? 1 : 0;
      if (Number.isFinite(this.injStrMax)) out.injuredLegStrengthMax = this.injStrMax;
      const l = this.loads.filter((x) => x.t >= this.lastT - 1.5);
      if (l.length) out.loadHealthyMean = l.reduce((a, x) => a + x.healthy, 0) / l.length;
    }
    out.hitReactedEvents = this.reacted;
    out.fallCertaintyMax = this.certMax;
    if (this.braceT !== null) {
      out.braceStart = this.braceT;
      if (this.groundT !== null) out.braceLeadTime = this.groundT - this.braceT;
      if (this.handErr !== null) out.fallPredictError = this.handErr;
    }
    if (this.best) {
      out.airTimeMax = this.best.dur;
      out.touchdownT = this.best.td;
      out.touchdownSpeedH = this.best.speedH;
      if (this.best.cover !== null) out.flailAirCoverage = this.best.cover;
      out.prepLandingLead = this.best.prepLead ?? -1;
    }
    if (this.tumble) {
      out.tumbled = 1;
      out.tumbleTime = this.tumble.time;
      out.tumbleGuardFrac = this.tumble.active > 0 ? this.tumble.guard / this.tumble.active : 0;
      out.tumbleDrop = this.tumble.y0 - this.tumble.yEnd;
    }
    if (this.grabTried) {
      out.grabbed = this.gripT !== null ? 1 : 0;
      out.gripTime = this.gripT !== null && this.hit ? this.gripT - this.hit.t : -1;
      out.grabSlipMax = this.grabSlip;
      out.grabForceMax = this.grabForce;
      out.grabHoldTime = this.grabHold;
      out.hangTime = this.hang;
    }
    if (this.wallTried) {
      out.wallBraced = this.wallContact ? 1 : 0;
      out.wallContactLead = this.wallContact && this.hit ? this.wallContact.t - this.hit.t : -1;
      out.wallContactSpeed = this.wallContact?.speed ?? -1;
      out.wallPushOff = this.wallPush ? 1 : 0;
    }
    if (this.tripped) out.tripped = 1;
    if (this.misstep) out.misstep = 1;
    out.rolled = this.rolled ? 1 : 0;
    if (this.rolled) out.rollDegMax = this.rollDeg;
    if (this.writhe) {
      const w = this.writhe;
      const mean = w.n ? w.sum / w.n : 0;
      const r = (behaviorsCfg as unknown as { Writhe: { jointSpeedRange: [number, number] } }).Writhe.jointSpeedRange;
      out.writheStart = w.t0;
      out.writheWindowS = w.last - w.t0;
      out.writheComSpeedMax = w.comMax;
      out.writheJointSpeedMean = mean;
      out.writheSpeedInRange = mean >= r[0] && mean <= r[1] ? 1 : 0;
    }
    if (this.limp && this.limp.knee !== null) out.limpKneeLeadTime = (this.limp.drop ?? this.lastT) - this.limp.knee;
    else if (this.limp) out.limpKneeLeadTime = -1;
    return out;
  }
}
