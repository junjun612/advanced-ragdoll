// 요약 판정과 지표 (SPEC 8.2, 10). 입력은 매 스텝의 CharacterState뿐이다.
import simCfg from '../../../config/sim.json';
import { classifyPosture, FEET, type JudgeConfig } from './posture';
import { pointInConvexPolygon } from '../math/geometry';
import type { BodyName, CharacterState, JointName, Posture, SimEvent, Summary, Vec3 } from '../types';
import { MuscleMetrics } from './muscleMetrics';
import { QualityMetrics } from './quality';
import { AnimMetrics } from './animMetrics';
import animDriverCfg from '../../../config/animDriver.json';
import { BehaviorMetrics, type BehaviorJudge } from './behaviorMetrics';
import { GetupMetrics } from './getupMetrics';
import { terrainDef, terrainHeightAt, isFlatTerrain, type TerrainName } from '../terrain';
import { ReactionMetrics } from './reactionMetrics';

const judge = simCfg.judge as JudgeConfig;

export interface SummaryContext {
  scenario: string;
  milestone: string;
  duration: number;
  /** 총질량(kg). energy 지표 정규화용 */
  totalMass?: number;
  /** (v0.8a) 지형: 자세 판정 높이를 그 아래 지면 기준으로 (없으면 평지) */
  terrain?: string;
}

export class SummaryBuilder {
  private readonly am: AnimMetrics;
  private prevT: number | null = null;
  private first: CharacterState | null = null;
  private last: CharacterState | null = null;
  private exploded = false;
  private explodedTime: number | null = null;
  private fallTime: number | null = null;
  private kneelStart: number | null = null;
  private kneelTime: number | null = null;
  /** 무릎 꿇기 가장 긴 연속 유지 (초), 머리가 처음 지면에 닿을 때 속도 (m/s, v0.5b) */
  private kneelHeldMax = 0;
  private headImpact: number | null = null;
  private firstGround: BodyName | null = null;
  private recoverStart: number | null = null;
  private recoveredTime: number | null = null;
  private lastHitTime = 0;
  private limitHits = 0;
  private violations: number[] = [];
  private selfPen = 0;
  private maxAngVel = 0;
  private maxLinVel = 0;
  private wasGrounded = new Set<BodyName>();
  private readonly mm: MuscleMetrics;
  private readonly qm: QualityMetrics;
  private readonly bm: BehaviorMetrics;
  private readonly gm: GetupMetrics;
  private readonly rm = new ReactionMetrics((simCfg as unknown as { reactionJudge?: { window: number } }).reactionJudge?.window ?? 3);
  private hadHit = false;
  private steps = 0;
  private landErr: number[] = [];
  private firstStepAfterHit: number | null = null;
  /** (v0.8c) 상호작용 지표: 로그에 interaction이 있을 때만 (혼자인 캐릭터 요약은 그대로) */
  private inter: { pen: number; propPen: number; charHits: number; charMaxDv: number; propHits: number; propMaxDv: number; firstContact: number | null; lookAtTime: number } | null = null;

  /** (v0.8a) 평지가 아닌 지형 정의 (평지면 null — 이전 경로 그대로) */
  private readonly terrain: ReturnType<typeof terrainDef> | null;

  constructor(readonly ctx: SummaryContext) {
    const td = terrainDef((ctx.terrain ?? 'flat') as TerrainName);
    this.terrain = isFlatTerrain(td) ? null : td;
    this.mm = new MuscleMetrics(simCfg.muscleJudge, ctx.totalMass ?? 0);
    this.qm = new QualityMetrics(simCfg.qualityJudge);
    this.am = new AnimMetrics(animDriverCfg.resume.reactHold);
    this.bm = new BehaviorMetrics((simCfg as unknown as { behaviorJudge: BehaviorJudge }).behaviorJudge);
    this.gm = new GetupMetrics((ctx.totalMass ?? 75) * 9.81);
  }

  onEvent(e: SimEvent): void {
    this.mm.onEvent(e);
    this.qm.onEvent(e);
    this.am.onEvent(e);
    this.bm.onEvent(e);
    this.gm.onEvent(e);
    this.rm.onEvent(e);
    if (e.type === 'step') {
      this.steps++;
      if (e.error !== undefined) this.landErr.push(e.error);
      if (this.hadHit && this.firstStepAfterHit === null) this.firstStepAfterHit = e.t - this.lastHitTime;
    }
    if (e.type === 'hit' && e.source !== undefined) {
      // (v0.8c) 접촉 감지 피격: 상대 종류별 수와 최대 Δv
      this.inter ??= { pen: 0, propPen: 0, charHits: 0, charMaxDv: 0, propHits: 0, propMaxDv: 0, firstContact: null, lookAtTime: 0 };
      if (e.source.startsWith('prop:')) { this.inter.propHits++; this.inter.propMaxDv = Math.max(this.inter.propMaxDv, e.dv ?? 0); }
      else { this.inter.charHits++; this.inter.charMaxDv = Math.max(this.inter.charMaxDv, e.dv ?? 0); }
    }
    if (e.type === 'hit') {
      this.hadHit = true;
      this.lastHitTime = e.t;
      this.recoverStart = null;
      this.recoveredTime = null;
    }
  }

  /** 매 스텝 호출. logFrame이면 프레임 단위 지표(limitHits)를 센다. */
  onState(s: CharacterState, logFrame: boolean): void {
    this.first ??= s;
    this.last = s;
    const t = s.time;
    this.mm.onState(s);
    this.qm.onState(s, logFrame);
    this.rm.onState(s);
    this.am.onState(s, this.prevT === null ? 0 : s.time - this.prevT, logFrame);
    this.prevT = s.time;
    this.bm.onState(s);
    this.gm.onState(s);

    // 폭발: 선속도 > 20, 각속도 > 50, NaN
    let bad = false;
    for (const name in s.bodies) {
      const b = s.bodies[name as BodyName];
      const lv = Math.hypot(...b.linVel), av = Math.hypot(...b.angVel);
      if (!Number.isFinite(lv + av + b.pos[0] + b.pos[1] + b.pos[2])) bad = true;
      if (lv > simCfg.safety.maxLinVel || av > simCfg.safety.maxAngVel) bad = true;
      this.maxAngVel = Math.max(this.maxAngVel, av);
      this.maxLinVel = Math.max(this.maxLinVel, lv);
    }
    if (bad && !this.exploded) { this.exploded = true; this.explodedTime = t; }

    // 자세 (state.posture와 같은 정의를 다시 평가해 fell 조건을 얻는다)
    const ground = new Set<BodyName>(s.contacts.map((c) => c.body));
    const tilt = Number(s.debug.spine2TiltDeg);
    const td = this.terrain;
    const gC = td ? terrainHeightAt(td, s.com[0], s.com[2]) : 0, gH = td ? terrainHeightAt(td, s.bodies.Hips.pos[0], s.bodies.Hips.pos[2]) : 0;
    const pr = classifyPosture({ ground, spine2TiltDeg: tilt, hipsHeight: s.bodies.Hips.pos[1] - gH, comHeight: s.com[1] - gC }, judge);
    if (pr.fellCond && this.fallTime === null) this.fallTime = t;
    if (pr.kneeling) {
      this.kneelStart ??= t;
      this.kneelHeldMax = Math.max(this.kneelHeldMax, t - this.kneelStart);
      if (this.kneelTime === null && t - this.kneelStart >= judge.kneelHoldTime - 1e-9) this.kneelTime = this.kneelStart;
    } else this.kneelStart = null;

    // 처음 지면에 닿은 바디 (발 제외). 시작 시점에 이미 닿아 있던 바디는 새 접촉이 아니다.
    if (this.firstGround === null && s !== this.first) {
      for (const c of s.contacts) {
        if (!FEET.has(c.body) && !this.wasGrounded.has(c.body)) { this.firstGround = c.body; break; }
      }
    }
    if (s === this.first) for (const b of ground) this.wasGrounded.add(b);
    if (this.headImpact === null && ground.has('Head') && s !== this.first) this.headImpact = Math.hypot(...s.bodies.Head.linVel);

    // 회복: 마지막 충격 이후 COM 속도 < 0.05 이고 COM 투영이 지지 다각형 안에 0.5초 이상
    if (t >= this.lastHitTime && this.recoveredTime === null) {
      const speed = Math.hypot(...s.comVel);
      const inside = pointInConvexPolygon([s.com[0], s.com[2]], s.supportPolygon);
      if (speed < judge.recoverComVel && inside) {
        this.recoverStart ??= t;
        if (t - this.recoverStart >= judge.recoverHoldTime - 1e-9) this.recoveredTime = this.recoverStart;
      } else this.recoverStart = null;
    }

    // 관절 제한
    let hit = false;
    for (const name in s.joints) {
      const j = s.joints[name as keyof typeof s.joints];
      this.violations.push(j.violationDeg);
      // 정의는 docs/ALGORITHMS.md: 제한을 tol 넘게 넘었거나, 제한에 붙은 채(여유 < pressMargin) 제한 쪽으로 움직이는 중
      if (j.limitMarginDeg > judge.limitHitTolDeg) hit = true;
      else if (j.limitMarginDeg > -judge.limitPressMarginDeg && j.limitApproachDegS > judge.limitPressVelDegS) hit = true;
    }
    if (logFrame && hit) this.limitHits++;
    this.selfPen = Math.max(this.selfPen, Number(s.debug.selfPenetration));
    if (s.interaction) {
      const it = (this.inter ??= { pen: 0, propPen: 0, charHits: 0, charMaxDv: 0, propHits: 0, propMaxDv: 0, firstContact: null, lookAtTime: 0 });
      it.pen = Math.max(it.pen, s.interaction.penetration);
      for (const c of s.interaction.contacts) {
        if (c.kind === 'prop') it.propPen = Math.max(it.propPen, c.penetration);
        if (it.firstContact === null && c.penetration > 0) it.firstContact = t;
      }
      if (s.interaction.lookAt && this.prevLookT !== null) it.lookAtTime += t - this.prevLookT;
      this.prevLookT = t;
    }
  }
  private prevLookT: number | null = null;

  finish(): Summary {
    const first = this.first, last = this.last;
    if (!first || !last) throw new Error('no states');
    const v = [...this.violations].sort((a, b) => a - b);
    const pct = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : 0);
    const dx = last.com[0] - first.com[0], dz = last.com[2] - first.com[2];
    const d = Math.hypot(dx, dz);
    const fallDirection: Vec3 | null = d >= judge.fallDirectionMinDist ? [dx / d, 0, dz / d] : null;
    const finalPosture: Posture = last.posture;
    const mm = this.mm.finish();
    return {
      scenario: this.ctx.scenario,
      milestone: this.ctx.milestone,
      duration: this.ctx.duration,
      exploded: this.exploded,
      explodedTime: this.explodedTime,
      fell: this.fallTime !== null,
      fallTime: this.fallTime,
      kneeled: this.kneelTime !== null,
      kneelTime: this.kneelTime,
      stepsTaken: this.steps,
      recoveredTime: this.recoveredTime,
      recoveredAfterHit: this.hadHit && this.recoveredTime !== null ? this.recoveredTime - this.lastHitTime : null,
      firstGroundContact: this.firstGround,
      fallDirection,
      finalPosture,
      metrics: {
        limitHits: this.limitHits,
        limitViolationP99Deg: pct(0.99),
        limitViolationMaxDeg: v.length ? v[v.length - 1]! : 0,
        selfPenetration: this.selfPen,
        maxAngVel: this.maxAngVel,
        maxLinVel: this.maxLinVel,
        comDisplacement: d,
        finalComHeight: last.com[1],
        ...mm.metrics,
        ...this.qm.finish(),
        ...this.am.finish(),
        ...this.bm.finish(),
        ...this.gm.finish(),
        ...this.rm.finish(),
        ...(this.landErr.length ? { landingErrorMean: this.landErr.reduce((a, b) => a + b, 0) / this.landErr.length, landingErrorMax: Math.max(...this.landErr) } : {}),
        ...(this.firstStepAfterHit !== null ? { firstLandingAfterHit: this.firstStepAfterHit } : {}),
        ...(this.kneelTime !== null ? { kneelTime: this.kneelTime, kneelHeldMax: this.kneelHeldMax } : {}),
        ...(this.fallTime !== null ? { headImpactSpeed: this.headImpact ?? 0 } : {}),
        ...(this.inter ? {
          interPenetrationMax: this.inter.pen, propPenetrationMax: this.inter.propPen,
          contactHits: this.inter.charHits, contactHitMaxDv: this.inter.charMaxDv, propHits: this.inter.propHits, propHitMaxDv: this.inter.propMaxDv,
          ...(this.inter.firstContact !== null ? { firstContactTime: this.inter.firstContact } : {}), lookAtOtherTime: this.inter.lookAtTime,
        } : {}),
      },
      info: mm.info,
      expectations: { passed: true, failures: [] },
    };
  }
}
