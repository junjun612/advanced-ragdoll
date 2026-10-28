// 행동 블렌더 (SPEC v0.5 '행동 프레임워크', 7.1의 4~5단계). 정의: docs/ALGORITHMS.md v0.5a.
// - 행동 목록을 레이어(behaviors.json layers) 순으로 돌며 관절마다 가중치만큼 목표를 덮어쓰거나(target) 앞에 곱한다(add).
//   같은 레이어는 이름 순(결정론). 강도 배율은 1 + w·(s − 1)을 곱한다.
// - 의도 행동은 감지 지연(reactionDelay) 뒤 transitionTime 동안 가중치 0 → 1, 끌 때 1 → 0 (smoothstep).
//   수동 반응(힘 빠짐)을 가진 행동(immediate)은 피격 순간부터 가중치 1이고, 의도 부분은 행동 안에서 startT 뒤에 시작한다.
// - 손 IK 목표·시선·COM 낮추기·스텝 수정·몸통 강성도 같은 가중치로 합친다.
import type { JointName, JointTargets } from '../pose';
import type { BodyName } from '../characterDef';
import { isFootBody, type FootName } from '../perception';
import type { ResolvedHit, Wound } from '../hitModel';
import type { Prng } from '../../prng';
import { type Vec3, add, sub, scale, length, angleBetween } from '../../math/vec3';
import { type Quat, identityQ, multiplyQ, rotate, slerp } from '../../math/quat';
import type { Vec2 } from '../../math/geometry';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type HandName, type HandTarget, type StepMods, type FreeArm, HANDS } from './types';
import { HitReaction } from './hitReaction';
import { HoldWound } from './holdWound';
import { InjuredLeg, LookAt, Stagger, solveGaze } from './simple';
import { bodyPose } from './kinematics';
import { BraceForFall, CatchFall, FallMonitor, ProtectHead, type FallConfig, type FallSignal } from './fall';
import { Kneel, Limp } from './collapse';
import { AirMonitor, BlastStun, Flail, PrepareLanding, Roll, type AirConfig, type AirSignal } from './air';
import { Writhe } from './writhe';
import { ImpactRelax, Lie } from './relax';
import { Misstep, StairStep, Trip, Tumble, descendingAhead, type TumbleParams } from './terrain';
import { BraceAgainstWall, Grab, HangOnLedge } from './grab';
import { DelayLine, senseGrab, senseWall, type GrabSense, type GrabSenseConfig, type WallSense } from '../perception';

export interface BehaviorsConfig {
  reactionDelay: number;
  transitionTime: number;
  layers: Record<string, number>;
  koreanNames: Record<string, string>;
  HitReaction: Record<string, unknown>;
  Stagger: Record<string, unknown>;
  HoldWound: Record<string, unknown>;
  InjuredLeg: Record<string, unknown>;
  LookAt: Record<string, unknown> & { headShare: number; spineShare: number; maxYawDeg: number; maxPitchDeg: number; tau: number };
  /** v0.5b */
  fall: FallConfig;
  BraceForFall: Record<string, unknown>;
  ProtectHead: Record<string, unknown>;
  CatchFall: Record<string, unknown>;
  Kneel: Record<string, unknown>;
  Limp: Record<string, unknown>;
  damage: DamageConfig;
  /** v0.5c */
  air: AirConfig;
  Flail: Record<string, unknown>;
  PrepareLanding: Record<string, unknown>;
  Roll: Record<string, unknown>;
  Writhe: Record<string, unknown>;
  BlastStun: Record<string, unknown>;
  /** (relax-1) 충격 후 이완: 행동 값과 시작 조건 (몸통·머리 바디가 새로 닿을 때 그 바디의 하강 속도 ≥ ImpactRelax.minSpeed) */
  ImpactRelax: Record<string, unknown>;
  relaxStart: { enabled: boolean; bodies: string[]; retriggerGap: number };
  /** (relax-3) 넘어짐 대비가 몸통으로 착지한 뒤 누움 */
  Lie: Record<string, unknown>;
  /** 몸부림 시작: 누운 채(발·손·정강이 아닌 바디가 지면에 닿고 COM 높이 < maxComHeight) delay초, COM 속도 < maxSpeed */
  writheStart: { delay: number; maxComHeight: number; maxSpeed: number };
  /** 누운 자세 (착지·구르기 뒤, 몸부림 출발점) */
  lie: Record<string, unknown>;
  /** v0.8a 지형 행동 */
  StairStep: Record<string, unknown>;
  Tumble: Record<string, unknown>;
  Trip: Record<string, unknown>;
  Misstep: Record<string, unknown>;
  /** v0.8b 잡기·벽: 인지(감지 지연)·시작 조건·행동 */
  grabSense: GrabSenseConfig & { wallDirCertainty: number; wallDirSpeed: number };
  grabStart: GrabStartConfig;
  Grab: Record<string, unknown>;
  HangOnLedge: Record<string, unknown>;
  BraceAgainstWall: Record<string, unknown>;
}

/**
 * (v0.8b) 잡기·벽 짚기 시작 조건: 균형이 흔들림 = 피격 뒤 window초 안 + (스텝 계층이 내딛는 중 또는 넘어짐 확실도 ≥ certainty),
 * 또는 확실도 ≥ certaintyAny, 또는 공중·헛디딤. 첫 손은 가장 가까운 후보, 다른 손은 어깨 거리 ≤ 팔 길이 × secondHand일 때만.
 * 놓거나 못 잡은 손은 regrabDelay초 뒤 다시. 벽은 넘어지는 방향 레이 거리 ≤ wallMaxDist m, 끝난 뒤 wallCooldown초
 */
export interface GrabStartConfig { window: number; speed: number; edgeSecond: number; certainty: number; certaintyAny: number; secondHand: number; regrabDelay: number; wallMaxDist: number; wallCooldown: number }

/** (v0.8b) 잡기·벽 로그 (CharacterState.behavior.grab): 인지 후보(감지 지연 뒤), 벽 탐지, 손별 잡기 상태 */
export interface GrabLog {
  sense: { hand: HandName; point: Vec3; dist: number }[];
  wall: { point: Vec3; normal: Vec3; dist: number; person?: string } | null;
  hands: { hand: HandName; phase: string; kind: string; target: Vec3 | null; ref: Vec3 | null; anchor: Vec3 | null; force: number; slip: number; palm: Vec3 }[];
}

/**
 * 피해 누적 (v0.5b, SPEC 대표 장면 세부 규칙 '여러 발을 맞으면 strength 상한이 계속 떨어진다'):
 * 총탄마다 하체 힘 상한 lowerCap −= Δv × lowerPerDv[부위] (부위 = HoldWound.bodyRegion), 회복 없음, floor 아래로는 안 내려감.
 * 상한은 다리 관절 힘 상한 배율(capacity)로 걸린다. lowerCap < kneelBelow면 Kneel, < limpBelow면 Limp.
 */
export interface DamageConfig { lowerPerDv: Record<string, number>; floor: number; kneelBelow: number; limpBelow: number; kneelMaxSpeed: number; kneelWait: number; kneelCap: number }

/** 블렌드 결과 (균형·근육 계층 입력) */
export interface BlendResult {
  targets: JointTargets;
  strengthMul: Partial<Record<JointName, number>>;
  capacityMul: Partial<Record<JointName, number>>;
  hands: Partial<Record<HandName, HandTarget>>;
  comDrop: number;
  comShift: Vec2 | null;
  tiltAllowDeg: number;
  trunkGainScale: number;
  balanceMode: 'on' | 'weak' | 'off';
  stepAllowed: boolean;
  minComHeight: number | null;
  stepping: StepMods;
  freeArm: FreeArm | null;
}

/** 로그·시각화 (CharacterState.behavior) */
export interface BehaviorLogState {
  active: { name: string; ko: string; weight: number; layer: number; phase: string; info?: Record<string, unknown> | null }[];
  /** 관절별 레이어·가중치 ("HoldWound 1.00 > HitReaction 0.62", 위 레이어가 앞) */
  layers: Partial<Record<JointName, string>>;
  /** 행동이 곱한 강도 배율 (최종 strength는 joints[].strength) */
  strengthMul: Partial<Record<JointName, number>>;
  /** 상처 (월드 점·바깥 법선) */
  wounds: { id: number; body: BodyName; point: Vec3; normal: Vec3; type: string; dv: number; t: number }[];
  /** 손 목표: 최종 목표(target), 지금 궤적 기준(ref), 실제 손바닥(palm), 손바닥-목표 거리, 손바닥-상처 점 거리 */
  hands: { hand: HandName; target: Vec3 | null; ref: Vec3; palm: Vec3; dist: number; woundDist: number | null; weight: number; woundId: number | null }[];
  gaze: { target: Vec3; errorDeg: number; weight: number } | null;
  comDrop: number;
  tiltAllowDeg: number;
  trunkGainScale: number;
  balanceMode: string;
  /** 넘어짐 신호 (v0.5b): 확실도·항목·방향·예측 시간·손 착지점 */
  fall: (Omit<FallSignal, 'dir' | 'pivot'> & { dir: Vec3; pivot: Vec3 }) | null;
  /** 피해 누적: 하체 힘 상한 (v0.5b) */
  damage: { lowerCap: number };
  /** 공중 신호 (v0.5c): 공중 여부·시간, 착지 예측 시간·지점·속도, 마지막 착지 */
  air: AirSignal | null;
  /** (v0.8b) 잡기·벽 (잡을 곳·벽이 있는 지형에서만) */
  grab?: GrabLog;
  /** (relax-1) 마지막 몸통·머리 새 접촉: 시각·바디·충돌 |Δv|(m/s)·이완을 걸었는가 (한 번이라도 닿은 뒤에만) */
  impact?: { t: number; body: string; dv: number; relaxed: boolean };
}

export const emptyBehaviorLog = (): BehaviorLogState => ({ active: [], layers: {}, strengthMul: {}, wounds: [], hands: [], gaze: null, comDrop: 0, tiltAllowDeg: 0, trunkGainScale: 1, balanceMode: 'on', fall: null, damage: { lowerCap: 1 }, air: null });

export interface BlenderEvent { type: 'hitReacted' | 'behaviorStart' | 'behaviorStop'; detail: string; body?: BodyName; strength?: number; dv?: number }

/** 누움 판정에서 빼는 바디 (서 있거나 짚거나 꿇은 자세에서도 닿는 곳) */
const LIMB_ENDS = new Set<BodyName>(['LeftFoot', 'RightFoot', 'LeftHand', 'RightHand', 'LeftLeg', 'RightLeg', 'LeftToeBase', 'RightToeBase']);

export class BehaviorBlender {
  readonly list: Behavior[] = [];
  readonly wounds: Wound[] = [];
  events: BlenderEvent[] = [];
  state: BehaviorLogState = emptyBehaviorLog();
  private nextWound = 1;
  private gazeState = new Map<Behavior, { yaw: number; pitch: number }>();
  private seq = 0;
  private readonly order = new Map<Behavior, number>();
  readonly fall: FallMonitor;
  /** 하체 힘 상한 (피해 누적) */
  lowerCap = 1;
  private lastTiltAllow = 0;
  private kneelPendingT: number | null = null;
  readonly air: AirMonitor;
  /** 누운 채 지난 시작 시각 (몸부림 시작 판정) */
  private lyingSince: number | null = null;
  /** 이번 비행에서 Flail을 켠 적이 있는가 (착지하면 지움) */
  private flailedThisFlight = false;

  constructor(public cfg: BehaviorsConfig, readonly rng: Prng, gravity = 9.81) {
    this.fall = new FallMonitor(cfg.fall, gravity);
    this.air = new AirMonitor(cfg.air, gravity);
  }

  /** 행동 계층이 출력을 내는가 (행동이 있거나 피해가 쌓였으면) */
  get engaged(): boolean { return this.list.length > 0 || this.lowerCap < 1; }
  private has(name: string): boolean { return this.list.some((b) => b.name === name && b.stopT === null); }
  /** Limp: 다른 행동은 모두 끈다 */
  private startLimp(t: number, params: Record<string, unknown>): void {
    if (this.has('Limp')) return;
    for (const b of this.list) b.stop(t);
    this.make('Limp', params, t, t);
  }

  private layer(name: string): number { return this.cfg.layers[name] ?? 0; }

  private make(name: string, params: Record<string, unknown>, t0: number, hitT: number): Behavior {
    const base = (this.cfg as unknown as Record<string, Record<string, unknown>>)[name];
    if (!base || !(name in this.cfg.layers)) throw new Error(`unknown behavior '${name}' (known: ${Object.keys(this.cfg.layers).filter((n) => n !== 'Balance').join(', ')}, LiftFoot)`);
    const p = { ...base, ...(name === 'PrepareLanding' || name === 'Roll' || name === 'Writhe' || name === 'Tumble' || name === 'Lie' ? { lie: this.cfg.lie } : {}), ...params };
    const b = name === 'HitReaction' ? new HitReaction(p, t0, hitT)
      : name === 'HoldWound' ? new HoldWound(p, t0, hitT)
        : name === 'InjuredLeg' ? new InjuredLeg(p, t0, hitT)
          : name === 'Stagger' ? new Stagger(p, t0, hitT)
            : name === 'BraceForFall' ? new BraceForFall(p, t0, hitT)
              : name === 'ProtectHead' ? new ProtectHead(p, t0, hitT)
                : name === 'CatchFall' ? new CatchFall(p, t0, hitT)
                  : name === 'Kneel' ? new Kneel(p, t0, hitT)
                    : name === 'Limp' ? new Limp(p, t0, hitT)
                      : name === 'Flail' ? new Flail(p, t0, hitT)
                        : name === 'PrepareLanding' ? new PrepareLanding(p, t0, hitT)
                          : name === 'Roll' ? new Roll(p, t0, hitT)
                            : name === 'Writhe' ? new Writhe(p, t0, hitT)
                              : name === 'BlastStun' ? new BlastStun(p, t0, hitT)
                              : name === 'StairStep' ? new StairStep(p, t0, hitT)
                              : name === 'Tumble' ? new Tumble(p, t0, hitT)
                              : name === 'Trip' ? new Trip(p, t0, hitT)
                              : name === 'Misstep' ? new Misstep(p, t0, hitT)
                              : name === 'Grab' ? new Grab(p, t0, hitT)
                              : name === 'HangOnLedge' ? new HangOnLedge(p, t0, hitT)
                              : name === 'BraceAgainstWall' ? new BraceAgainstWall(p, t0, hitT)
                              : name === 'ImpactRelax' ? new ImpactRelax(p, t0, hitT)
                              : name === 'Lie' ? new Lie(p, t0, hitT)
                              : new LookAt(p, t0, hitT);
    this.list.push(b);
    this.order.set(b, this.seq++);
    this.events.push({ type: 'behaviorStart', detail: `${name} @${t0.toFixed(3)}` });
    return b;
  }

  /** 외부 트리거 (SPEC 7.2 trigger(name, params)). params.delay(초)를 주면 그만큼 뒤에 시작. LookAt { target: null }은 끄기 */
  trigger(name: string, params: Record<string, unknown>, t: number): void {
    const delay = typeof params.delay === 'number' ? params.delay : 0;
    if (name === 'LookAt') {
      for (const b of this.list) if (b.name === 'LookAt') b.stop(t);
      if (!params.target) return;
    }
    if (name === 'HoldWound' && params.woundId === undefined) {
      // 상처 없이 트리거: 지정한 바디·로컬 점에 상처를 만든다 (셋업용)
      const body = (params.body ?? 'Spine2') as BodyName;
      const local = (params.local ?? [0, 0, 0.1]) as Vec3;
      const n = length(local) > 1e-9 ? scale(local, 1 / length(local)) : [0, 0, 1] as Vec3;
      params = { ...params, woundId: this.addWound({ body, local, normalLocal: n, type: 'push', dv: 0 }, t).id };
    }
    if (name === 'Stagger') params = { ...params, immediate: true };
    if (name === 'Limp') { this.startLimp(t + delay, params); return; }
    this.make(name, params, t + delay, t);
  }

  private addWound(w: Omit<Wound, 'id' | 't'>, t: number): Wound {
    const wd: Wound = { ...w, id: this.nextWound++, t };
    this.wounds.push(wd);
    return wd;
  }

  /** 피격 (hitModel 결과) → 상처 저장, 행동 켜기. 의도 행동은 감지 지연 뒤 */
  onHit(res: ResolvedHit, t: number): void {
    const delay = this.cfg.reactionDelay;
    if (this.has('Limp')) return; // 이미 늘어진 몸은 충격만 받는다
    const wound = res.wound ? this.addWound(res.wound, t) : null;
    this.lastHitT = t;
    // 피해 누적 (총탄): 하체 힘 상한을 낮춘다
    if (res.type === 'bullet') {
      const region = ((this.cfg.HoldWound as { bodyRegion?: Record<string, string> }).bodyRegion ?? {})[res.body] ?? 'chest';
      const d = this.cfg.damage;
      this.lowerCap = Math.max(d.floor, this.lowerCap - res.dv * (d.lowerPerDv[region] ?? 0));
    }
    for (const name of res.behaviors) {
      if (name === 'HitReaction') {
        this.make(name, { body: res.body, intensity: res.intensity, dir: res.dir, point: res.point ?? null }, t + delay, t);
        this.events.push({ type: 'hitReacted', body: res.body, strength: res.intensity, dv: res.dv, detail: `${res.type} ${res.body} 강도 ${res.intensity.toFixed(2)}` });
      } else if (name === 'HoldWound') {
        // 피해 누적 (v0.5b): 이미 쥐고 있는 상처가 있으면 남은 손만 새 상처로(웅크림은 겹치지 않음), 두 손이 다 쥐고 있으면 그대로 누른다
        const holding = this.list.filter((b): b is HoldWound => b instanceof HoldWound && b.stopT === null);
        const busy = new Set(holding.map((b) => b.hand).filter((h): h is HandName => !!h));
        if (wound && busy.size < 2) this.make(name, { woundId: wound.id, ...(holding.length ? { crouch: false } : {}) }, t + delay, t);
      } else if (name === 'InjuredLeg') {
        const foot: FootName = res.body.startsWith('Right') ? 'RightFoot' : 'LeftFoot';
        if (!this.list.some((b) => b instanceof InjuredLeg && b.foot === foot && b.stopT === null)) this.make(name, { leg: res.body }, t, t);
      } else if (name === 'Stagger') {
        if (!this.list.some((b) => b instanceof Stagger && b.stopT === null)) this.make(name, {}, t, t);
      } else if (name === 'Limp') this.startLimp(t, { cause: 'death' });
      else if (name === 'BlastStun') this.make(name, { intensity: res.intensity }, t, t);
      else this.make(name, {}, t + delay, t);
    }
  }

  /**
   * 넘어짐·피해 행동 자동 시작 (v0.5b):
   * - 피해 누적 하체 상한 < limpBelow → Limp, < kneelBelow → Kneel
   * - 넘어짐 확실도 ≥ threshold → BraceForFall (감지 지연 뒤), 뒤·옆이면 ProtectHead(뒤: 두 손, 옆: 넘어지는 반대쪽 손)
   * - BraceForFall 중 손이 지면에 닿으면 CatchFall
   */
  private autoStart(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    const delay = this.cfg.reactionDelay;
    if (this.has('Limp')) return;
    const d = this.cfg.damage;
    if (this.lowerCap < d.limpBelow) { this.startLimp(t, { cause: 'damage' }); return; }
    // 무릎 꿇기는 비틀거림이 잦아든 뒤(스텝 계층이 쉬고 COM 수평 속도 < kneelMaxSpeed) — 뒤로 밀리는 중에 쪼그리면 주저앉아 뒤로 넘어간다. kneelWait초가 지나면 그냥
    if (this.lowerCap < d.kneelBelow && !this.has('Kneel') && !this.has('BraceForFall')) {
      this.kneelPendingT ??= t;
      const v = ctx.rd.com().vel;
      if ((!ctx.stepping.busy && Math.hypot(v[0], v[2]) < d.kneelMaxSpeed) || t - this.kneelPendingT >= d.kneelWait) this.make('Kneel', {}, t + delay, t);
    }
    // (v0.8a) 지형: 평지가 아니면 계단·경사 디딤(StairStep, 수동 지각이라 바로), 내리막에서 몸으로 닿아 빠르게 내려가면 굴러 내려감(Tumble)
    this.autoStartTerrain(ctx, t);
    // 공중 (v0.5c): Flail → PrepareLanding / Roll. 공중 행동이 있는 동안은 넘어짐 대비를 하지 않는다(날아가는 몸은 DCM이 바닥 밖이라 확실도가 곧 1이 된다)
    if (!this.tumbling && !this.holding.length) this.autoStartAir(ctx, t);
    // 몸부림 (v0.5c): 누운 채 delay초 + 느림 → Writhe (사망·이미 몸부림 중 제외)
    this.autoStartWrithe(ctx, t);
    // (v0.8b) 잡기·벽 짚기 (잡을 곳·벽이 있는 지형): 잡는 중·벽을 짚는 중에는 넘어짐 대비를 하지 않는다
    this.autoStartGrab(ctx, t);
    const airBusy = this.has('Tumble') || this.has('Lie') || this.grabBusy || this.list.some((b) => ((b instanceof Flail || b instanceof Writhe || b instanceof Misstep) && b.stopT === null) || ((b instanceof PrepareLanding || b instanceof Roll) && b.blocksFall));
    const f = ctx.fall;
    if (f && !airBusy && f.certainty >= (t < this.braceGuard.until ? this.braceGuard.threshold : this.cfg.fall.threshold) && !this.has('BraceForFall')) {
      this.make('BraceForFall', {}, t + delay, t);
      // 종류는 시작 시 정해 두고 ProtectHead도 같은 종류로
      if (f.kind !== 'forward') {
        const hands: HandName[] = f.kind === 'backward' ? [...HANDS] : f.kind === 'left' ? ['RightHand'] : ['LeftHand'];
        this.make('ProtectHead', { kind: f.kind, hands }, t + delay, t);
      }
    }
    const brace = this.list.find((b): b is BraceForFall => b instanceof BraceForFall && b.stopT === null);
    if (brace && !brace.ended && !this.list.some((b) => b instanceof CatchFall) && (ctx.per.ground.has('LeftHand') || ctx.per.ground.has('RightHand'))) this.make('CatchFall', {}, t, t);
    // (relax-3) 몸통으로 착지했거나 누움 조건: 대비를 끝내고 누움(Lie)으로 넘긴다. 머리 보호는 스스로 팔을 놓고 턱 당기기를 잠깐 더 유지하다 끝난다,
    // 손 짚기는 그 팔 힘을 빼며 이어진다 (몸부림이 시작되면 끈다)
    if (brace?.ended) {
      brace.stop(t);
      if (!this.has('Lie') && !this.has('Writhe')) this.make('Lie', { supported: brace.trunkT === null }, t, t);
    }
    // (relax-1) 충격 후 이완
    this.autoStartRelax(ctx, t);
  }

  /** (relax-1) 직전 스텝에 지면에 닿아 있던 바디 (새 접촉 판정) */
  private prevGround = new Set<string>();
  private prevVel: Record<string, Vec3> = {};
  private lastImpact: { t: number; body: string; dv: number; relaxed: boolean } | null = null;
  /**
   * (relax-1) 충격 후 이완 자동 시작: relaxStart.bodies(몸통·엉덩이·머리) 중 하나가 새로 지면에 닿고 그 바디의 하강 속도가 ImpactRelax.minSpeed 이상이면
   * ImpactRelax(즉시, 수동 반응). 이미 있으면 retriggerGap초 뒤의 새 충돌로 다시 떨어뜨린다. 일부러 웅크려 구르는 중(Roll·Tumble, 풀기 전)·
   * 잡고 매달린 중·늘어짐(이미 힘이 없음)은 제외
   */
  private autoStartRelax(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    const rs = this.cfg.relaxStart;
    if (!rs?.enabled) return;
    const now = new Set<string>(ctx.per.ground);
    const prev = this.prevGround;
    this.prevGround = now;
    // 충돌 세기 = 새로 닿는 순간 그 바디 속력 (m/s)
    const vel: Record<string, Vec3> = {};
    for (const b of rs.bodies) vel[b] = bodyPose(ctx.rd, b as BodyName).vel;
    const pv = this.prevVel;
    this.prevVel = vel;
    if (this.has('Limp') || this.tumbling || this.holding.length || this.has('HangOnLedge')) return;
    if (this.list.some((b) => b instanceof Roll && b.stopT === null && !b.resting)) return;
    const minSpeed = (this.cfg.ImpactRelax as { minSpeed: number }).minSpeed;
    let best: { body: string; speed: number } | null = null;
    let probe: { body: string; speed: number } | null = null;
    for (const b of rs.bodies) {
      if (!now.has(b) || prev.has(b) || !pv[b]) continue;
      // 닿는 순간 그 바디 속력 (직전·지금 스텝 중 큰 쪽): 접촉은 거리 여유(groundContactDist) 안에서 먼저 잡혀 충돌 전 속도가 남아 있을 수도, 이미 막혔을 수도 있다.
      // 법선 성분만 보면 손·다리로 받아 낸 뒤 엉덩이가 미끄러지며 닿는 넘어짐(0.4 m/s)과 누운 채 뒤척임을 구별하지 못했다 — 넘어지는 몸은 닿을 때 1 m/s 넘게 움직인다
      const sp = Math.max(length(pv[b]!), length(vel[b]!));
      if (!probe || sp > probe.speed) probe = { body: b, speed: sp };
      if (sp >= minSpeed && (!best || sp > best.speed)) best = { body: b, speed: sp };
    }
    if (probe) this.lastImpact = { t, body: probe.body, dv: probe.speed, relaxed: !!best };
    if (!best) return;
    const cur = this.list.find((b): b is ImpactRelax => b instanceof ImpactRelax && b.stopT === null);
    if (cur) { if (t - cur.impactT >= rs.retriggerGap) cur.retrigger(t, best.body, best.speed); return; }
    this.make('ImpactRelax', { body: best.body, speed: best.speed }, t, t);
  }

  /**
   * 공중 행동 자동 시작 (v0.5c, docs/ALGORITHMS.md v0.5c):
   * - 공중(접촉 없음 + 자유 낙하)이고 착지 예측 ≥ flailMinTime → Flail (감지 지연 뒤). 이때 넘어짐 대비·머리 보호·손 짚기는 끈다
   * - 공중이고 착지 예측 ≤ prepareLead → PrepareLanding
   * - 몸으로 착지할 자세(서 있지 않음)이고 착지 예측 ≤ rollLead이며 예측 착지 수평 속도 ≥ rollSpeed → Roll (미리 웅크림).
   *   발로 착지하면 착지 순간 그 속도(또는 경사면)일 때 Roll — 다리를 펴서 받은 뒤 구른다
   */
  private autoStartAir(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    const a = ctx.air, c = this.cfg.air, delay = this.cfg.reactionDelay;
    if (!a) return;
    if (a.contact && !this.list.some((b) => b instanceof Flail && b.stopT === null)) this.flailedThisFlight = false;
    // 비행이 짧으면(공중 시간 + 착지 예측 < minFlightTotal) 공중 행동을 켜지 않는다 — 넘어지며 발이 잠깐 뜨는 것은 넘어짐 대비가 맡는다
    if (a.airborne && a.airTime + (a.timeToGround ?? Infinity) >= c.minFlightTotal) {
      const ttg = a.timeToGround ?? Infinity;
      if (!this.flailedThisFlight && ttg >= c.flailMinTime) {
        this.flailedThisFlight = true;
        this.make('Flail', {}, t + delay, t);
        for (const b of this.list) if ((b instanceof BraceForFall || b instanceof ProtectHead || b instanceof CatchFall || b instanceof Stagger || b instanceof Lie) && b.stopT === null) b.stop(t);
      }
      if (ttg <= c.prepareLead && !this.list.some((b) => b instanceof PrepareLanding && b.tdT === null && b.stopT === null)) {
        for (const b of this.list) if ((b instanceof BraceForFall || b instanceof ProtectHead || b instanceof CatchFall || b instanceof PrepareLanding || b instanceof Lie) && b.stopT === null) b.stop(t);
        this.make('PrepareLanding', {}, t + delay, t);
      }
      if (!a.upright && ttg <= c.rollLead && a.touchdownSpeedH >= c.rollSpeed && !this.has('Roll')) this.make('Roll', {}, t + delay, t);
    }
    // 착지 순간 (예측 못 한 빠른 착지·경사)
    const l = a.landing;
    // 발로 착지하면 서 있던 높이를 다시 잰다 (낙하한 높이를 넘어짐의 COM 하강으로 세지 않게)
    if (l && Math.abs(l.t - t) < 1e-9 && l.flight >= c.minFlightTotal) this.fall.standH = null;
    if (l && Math.abs(l.t - t) < 1e-9 && l.flight >= c.minFlightTotal && !this.has('Roll')) {
      if (l.speedH >= c.rollSpeed || (l.slopeDeg >= c.rollSlopeDeg && l.speedH >= c.rollSlopeSpeed)) this.make('Roll', {}, t + delay, t);
    }
  }

  // ── (v0.8b) 잡기·벽 ──
  private grabLine: DelayLine<GrabSense> | null = null;
  private wallLine: DelayLine<WallSense | null> | null = null;
  private lastHitT = -Infinity;
  private grabEndT: Partial<Record<HandName, number>> = {};
  private wallEndT = -Infinity;
  private lastStrength: Partial<Record<JointName, number>> = {};
  private grabLog: GrabLog | null = null;
  private get grabs(): Grab[] { return this.list.filter((b): b is Grab => b instanceof Grab && b.stopT === null); }
  /** 잡고 있는 손 (Grab 'hold') */
  get holding(): Grab[] { return this.grabs.filter((g) => g.holding); }
  /** 잡기(뻗기·잡음) 또는 벽 짚기 중 — 넘어짐 대비를 시작하지 않는다 */
  private get grabBusy(): boolean { return this.grabs.length > 0 || this.list.some((b) => b instanceof BraceAgainstWall && b.stopT === null); }

  /**
   * (v0.8b) 잡기·벽 짚기 자동 시작 (docs/ALGORITHMS.md v0.8b):
   * - 매 스텝 잡을 곳 탐지(senseGrab)·벽 탐지(senseWall, 넘어지는 방향 = 넘어짐 신호 방향 또는 COM 수평 속도)를 감지 지연선에 넣고 delay초 전 결과로 판단
   * - 잡고 있으면 넘어짐 대비·머리 보호·손 짚기·공중 허우적·착지 준비·구르기·헛디딤을 끈다. 모서리를 잡고 발이 떠 있으면 HangOnLedge
   * - 균형이 흔들리면(grabStart) 손이 닿는 잡을 곳으로 Grab, 넘어지는 방향 가까이 벽이 있으면 BraceAgainstWall
   */
  private autoStartGrab(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    const pw = ctx.rd.pw, gs = this.cfg.grabSense, ga = this.cfg.grabStart;
    // (v0.8c, 결정 174) 다른 사람이 있으면 그 몸통도 짚을 곳(벽 탐지)으로 본다
    const hasGrab = pw.terrainDef.grabs.length > 0, hasWall = pw.wallColliders.length > 0 || (!!gs.person && pw.persons.length > 1);
    if (!hasGrab && !hasWall) return;
    this.grabLine ??= new DelayLine<GrabSense>(gs.delay);
    this.wallLine ??= new DelayLine<WallSense | null>(gs.delay);
    const f = ctx.fall;
    if (hasGrab) this.grabLine.push(t, senseGrab(ctx.rd, pw, gs, (this.cfg.Grab as { palmLocal: Vec3 }).palmLocal, t));
    if (hasWall) {
      const { vel } = ctx.rd.com();
      const dir: Vec3 | null = f && f.certainty >= gs.wallDirCertainty ? f.dir : Math.hypot(vel[0], vel[2]) >= gs.wallDirSpeed ? [vel[0], 0, vel[2]] : null;
      this.wallLine.push(t, dir ? senseWall(ctx.rd, pw, gs, dir, t) : null);
    }
    const sense = hasGrab ? this.grabLine.get(t) : null;
    const wall = hasWall ? this.wallLine.get(t) : null;
    this.grabLog = { sense: sense ? HANDS.flatMap((h) => { const x = sense.hands[h]; return x ? [{ hand: h, point: x.point, dist: x.dist }] : []; }) : [], wall: wall ? { point: wall.point, normal: wall.normal, dist: wall.dist, ...(wall.person ? { person: `${wall.person.name}:${wall.person.body}` } : {}) } : null, hands: [] };
    // 잡고 있으면: 넘어짐·공중 행동을 끄고, 모서리에 발이 떠 있으면 매달리기
    const hold = this.holding;
    if (hold.length) {
      for (const b of this.list) if ((b instanceof BraceForFall || b instanceof ProtectHead || b instanceof CatchFall || b instanceof Flail || b instanceof PrepareLanding || b instanceof Roll || b instanceof Misstep || b instanceof Lie) && b.stopT === null) b.stop(t);
      const feet = ctx.per.feet.LeftFoot.contact || ctx.per.feet.RightFoot.contact;
      if (hold.some((g) => g.kind === 'edge') && !feet && !this.has('HangOnLedge')) this.make('HangOnLedge', {}, t, t);
    }
    const hang = this.list.find((b): b is HangOnLedge => b instanceof HangOnLedge && b.stopT === null);
    if (hang) hang.anchors = hold.filter((g) => g.kind === 'edge' && g.anchor).map((g) => g.anchor!);
    if (this.has('Limp') || this.has('Tumble')) return;
    const c = f?.certainty ?? 0;
    const vH = Math.hypot(ctx.rd.com().vel[0], ctx.rd.com().vel[2]);
    const sinceHit = t - this.lastHitT;
    const need = (sinceHit >= this.cfg.reactionDelay && sinceHit <= ga.window && (ctx.stepping.busy || c >= ga.certainty || vH >= ga.speed)) || c >= ga.certaintyAny || !!ctx.air?.airborne || this.has('Misstep');
    if (!need) return;
    if (sense) {
      const active = this.grabs;
      const cand = HANDS.flatMap((h) => { const x = sense.hands[h]; return x ? [{ h, x }] : []; })
        .filter(({ h }) => !this.list.some((b) => b instanceof Grab && b.hand === h && (b.stopT === null || t - b.stopT < ga.regrabDelay)) && !this.list.some((b) => b instanceof HoldWound && b.hand === h && b.stopT === null) && t - (this.grabEndT[h] ?? -Infinity) >= ga.regrabDelay)
        .sort((a, b) => a.x.dist - b.x.dist);
      cand.forEach(({ h, x }, i) => {
        // 다른 손: 난간대는 가까울 때만(몸을 가로질러 뻗지 않음), 모서리는 두 손 다 (첫 손과 거리가 비슷하면)
        if ((i > 0 || active.length > 0) && x.dist > ga.secondHand * x.armLength && !(x.kind === 'edge' && x.dist <= cand[0]!.x.dist + ga.edgeSecond)) return;
        this.make('Grab', { hand: h, feature: x.feature }, t, t);
      });
    }
    if (wall && wall.dist <= ga.wallMaxDist && this.grabs.length === 0 && !this.has('BraceAgainstWall') && t - this.wallEndT >= ga.wallCooldown) {
      for (const b of this.list) if ((b instanceof BraceForFall || b instanceof ProtectHead || b instanceof CatchFall) && b.stopT === null) b.stop(t);
      this.make('BraceAgainstWall', { wall }, t, t);
    }
  }

  /** (v0.8a) 굴러 내려가는 중인가 (Tumble이 끝나 눕기 전) */
  private get tumbling(): boolean { return this.list.some((b) => b instanceof Tumble && b.stopT === null && !b.resting); }

  /**
   * (v0.8a) 지형 행동 자동 시작:
   * - 평지가 아니면 StairStep (즉시; 지형은 늘 보인다)
   * - 내리막(속도 방향 Tumble.probe m 앞 지면이 Tumble.min m 넘게 낮음)에서 발 아닌 바디가 닿은 채 COM 속도 ≥ startSpeed → Tumble (감지 지연 뒤).
   *   넘어짐 대비·머리 보호·손 짚기·구르기·착지 준비·허우적·비틀거림은 끈다
   */
  private autoStartTerrain(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    if (ctx.rd.pw.flat) return;
    if (!this.has('StairStep')) this.make('StairStep', {}, t, t);
    if (this.has('Tumble') || this.has('Kneel')) return;
    const tp = this.cfg.Tumble as unknown as TumbleParams;
    const { vel } = ctx.rd.com();
    const body = [...ctx.per.ground].some((b) => !isFootBody(b));
    const { com } = ctx.rd.com();
    const low = com[1] - ctx.rd.pw.groundHeightAt(com[0], com[2]) < tp.maxComHeight; // 몸이 그 아래 지면 가까이 (모서리 너머로 떨어지는 중은 아님)
    if (body && low && Math.hypot(vel[0], vel[1], vel[2]) >= tp.startSpeed && descendingAhead(ctx, vel, tp.probe, tp.min)) {
      for (const b of this.list) if ((b instanceof BraceForFall || b instanceof ProtectHead || b instanceof CatchFall || b instanceof Roll || b instanceof PrepareLanding || b instanceof Flail || b instanceof Stagger || b instanceof Trip || b instanceof Misstep || b instanceof Lie) && b.stopT === null) b.stop(t);
      this.make('Tumble', {}, t + this.cfg.reactionDelay, t);
    }
  }

  /** 몸부림 자동 시작: 누운 채(발·손·정강이가 아닌 바디가 지면에 닿고 COM이 낮음) delay초 지나고 COM이 느리면 */
  private autoStartWrithe(ctx: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng'>, t: number): void {
    const ws = this.cfg.writheStart;
    const { com, vel } = ctx.rd.com();
    // (v0.8a) COM 높이는 그 아래 지면 기준 (계단·받침 위에 누운 몸). 평지는 0
    const pw = ctx.rd.pw;
    const lying = [...ctx.per.ground].some((b) => !LIMB_ENDS.has(b)) && com[1] - (pw.flat ? 0 : pw.groundHeightAt(com[0], com[2])) < ws.maxComHeight;
    if (!lying) { this.lyingSince = null; return; }
    this.lyingSince ??= t;
    if (this.has('Writhe') || this.has('Limp') || this.tumbling || this.list.some((b) => b instanceof Roll && b.stopT === null && !b.resting)) return;
    // (relax-1) 충격 후 이완이 끝난 뒤에 몸부림 (힘이 빠진 몸이 아직 바닥에 자리 잡는 중에 몸부림 목표를 걸면 몸이 미끄러졌다)
    if (t - this.lyingSince >= ws.delay && length(vel) < ws.maxSpeed && !this.has('ImpactRelax')) {
      // 누움 단계의 행동(대비·착지·구르기)은 끈다 — 강도가 곱해져 몸부림이 힘을 못 쓴다. 몸부림은 누운 자세에서 출발한다
      for (const b of this.list) if ((b instanceof BraceForFall || b instanceof PrepareLanding || b instanceof Roll || b instanceof CatchFall || b instanceof ProtectHead || b instanceof Stagger || b instanceof Tumble || b instanceof Lie) && b.stopT === null) b.stop(t);
      this.make('Writhe', {}, t, t);
    }
  }

  /**
   * (v0.7) 일어서기 시작: 누움 단계 행동(몸부림·대비·구르기·상처 쥐기 등)을 바로 모두 뺀다(LookAt만 남김). 관절 목표는 겟업 관성화가 지금 자세에서 잇는다.
   * 누움·비행 기록과 '서 있던 높이'도 지운다(일어선 뒤 다시 잰다)
   */
  clearForGetup(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]!;
      if (b.name === 'LookAt') continue;
      this.events.push({ type: 'behaviorStop', detail: `${b.name} (getup)` });
      b.dispose();
      this.list.splice(i, 1);
      this.gazeState.delete(b);
      this.order.delete(b);
    }
    this.lyingSince = null;
    this.flailedThisFlight = false;
    this.kneelPendingT = null;
    this.fall.standH = null;
  }

  /**
   * (v0.7) 막 일어선 몸: until까지는 넘어짐 확실도가 threshold 이상일 때만 넘어짐 대비를 켠다 (일어서며 남은 운동량을 스텝으로 받는 중에
   * 대비가 먼저 켜져 균형을 끄면 받을 수 있던 비틀거림이 넘어짐이 됐다)
   */
  braceGuard = { until: -Infinity, threshold: 1 };

  /** 사망(Limp) 중인가 — 일어서지 않는다 */
  get dead(): boolean { return this.has('Limp'); }
  /**
   * 팔을 쓰는 행동이 쥔 손 (잡기·매달리기·벽 짚기·상처 누르기, 끝나며 가중치가 빠지는 동안 포함).
   * 반응 상체 스타일의 팔 묶음은 이 팔을 놓아 준다 — 행동이 팔을 쓰면 그 행동이 팔 모양을 정한다 (README 결정 167)
   */
  handsInUse(): Set<HandName> {
    const s = new Set<HandName>();
    for (const b of this.list) {
      if (b instanceof Grab || (b instanceof HoldWound && b.usesHand)) { if (b.hand) s.add(b.hand); }
      else if (b instanceof BraceAgainstWall) for (const h of b.hands) s.add(h);
      else if (b instanceof HangOnLedge) for (const h of HANDS) s.add(h);
    }
    return s;
  }

  /** 스텝 계층이 maxSteps 뒤에도 못 따라잡음 (stagger 이벤트) → Stagger를 바로 켠다 */
  onStaggerEvent(t: number): void {
    const s = this.list.find((b): b is Stagger => b instanceof Stagger && b.stopT === null);
    if (s) { if (s.armed) { s.armed = false; s.startT = t; } return; }
    this.make('Stagger', { immediate: true }, t, t);
  }

  /** 행동 가중치 (0~1) */
  private weightOf(b: Behavior, t: number): number {
    const T = this.cfg.transitionTime;
    let w = b.immediate ? 1 : smoothstep((t - b.startT) / T);
    if (b instanceof Stagger && b.armed) w = 0;
    if (b.stopT !== null) w *= 1 - smoothstep((t - b.stopT) / T);
    return w;
  }

  update(ctx0: Omit<BehaviorContext, 'base' | 'wounds' | 'busyHands' | 'rng' | 'fall' | 'badlyHurt' | 'air'>, base: JointTargets | null, active = true): BlendResult {
    const t = ctx0.t;
    const T = this.cfg.transitionTime;
    // 넘어짐 신호 (v0.5b): 행동이 없어도 매 스텝 계산해 로그에 남긴다 (PRNG를 쓰지 않아 v0.4 경로는 그대로)
    const fall = this.fall.update(ctx0.rd, ctx0.per, ctx0.dt, this.lastTiltAllow, this.list.some((b) => b instanceof Kneel && b.stopT === null), ctx0.stepping.busy, ctx0.stepping.swing ?? null);
    // 공중 신호 (v0.5c): 행동이 없어도 매 스텝 (PRNG를 쓰지 않는다)
    const air = this.air.update(ctx0.rd, ctx0.per, t, ctx0.dt);
    const ctx = { ...ctx0, fall, air, badlyHurt: this.lowerCap < this.cfg.damage.kneelBelow };
    if (active) this.autoStart(ctx, t);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]!;
      if (b.done(t, T)) {
        this.events.push({ type: 'behaviorStop', detail: b.name });
        b.dispose();
        if (b instanceof Grab) this.grabEndT[b.hand] = b.stopT!;
        if (b instanceof BraceAgainstWall) this.wallEndT = b.stopT!;
        this.list.splice(i, 1); this.gazeState.delete(b); this.order.delete(b);
      }
    }
    const sorted = [...this.list].sort((a, b) => this.layer(a.name) - this.layer(b.name) || a.name.localeCompare(b.name) || this.order.get(a)! - this.order.get(b)!);
    const targets: JointTargets = { ...(base ?? {}) };
    const strengthMul: Partial<Record<JointName, number>> = {};
    const capacityMul: Partial<Record<JointName, number>> = {};
    const hands: Partial<Record<HandName, HandTarget>> = {};
    const layerLog: Partial<Record<JointName, string[]>> = {};
    let comDrop = 0, tiltAllow = 0, trunkScale = 1;
    let comShift: Vec2 | null = null;
    let mode: 'on' | 'weak' | 'off' = 'on';
    let freeArm: FreeArm | null = null;
    let stepAllowed = true;
    let minComHeight: number | null = null;
    const stepping: StepMods = {};
    const busy = new Set<HandName>();
    // 꿇기를 기다리거나 내려다보기만 하는 HoldWound(결정 leg-2)는 손을 쓰지 않는다
    for (const b of this.list) if (b instanceof HoldWound && b.hand && b.stopT === null && b.usesHand) busy.add(b.hand);
    const log = emptyBehaviorLog();
    let topGaze: { target: Vec3; weight: number } | null = null;
    for (const b of sorted) {
      const w = this.weightOf(b, t);
      b.weight = w;
      const bctx: BehaviorContext = { ...ctx, base: targets, wounds: this.wounds, busyHands: busy, rng: this.rng, lastStrength: this.lastStrength };
      const out: BehaviorOutput = b.update(bctx);
      log.active.push({ name: b.name, ko: this.cfg.koreanNames[b.name] ?? b.name, weight: w, layer: this.layer(b.name), phase: b.phase, info: b.info() });
      // 스텝 수정은 가중치와 무관하게 (Stagger 대기 중에도 첫 스텝부터)
      if (out.stepping) {
        const s = out.stepping;
        if (s.injuredFoot) { stepping.injuredFoot = s.injuredFoot; stepping.injuredPenalty = s.injuredPenalty; stepping.injuredStepScale = s.injuredStepScale; }
        if (s.irregular) stepping.irregular = s.irregular;
        if (s.triggerRelax) stepping.triggerRelax = Math.max(stepping.triggerRelax ?? 0, w * s.triggerRelax);
        if (s.maxSteps) stepping.maxSteps = Math.min(stepping.maxSteps ?? Infinity, s.maxSteps);
        if (s.terrainStep) stepping.terrainStep = true;
        if (s.newEpisode) stepping.newEpisode = true;
      }
      if (w <= 1e-6) continue;
      const apply = (jn: JointName, jo: { target?: Quat; add?: Quat; weight: number; strength?: number; capacity?: number }) => {
        if (jo.capacity !== undefined) capacityMul[jn] = (capacityMul[jn] ?? 1) * (1 + w * (jo.capacity - 1));
        const wj = w * jo.weight;
        if (jo.target) targets[jn] = slerp(targets[jn] ?? identityQ(), jo.target, wj);
        if (jo.add) targets[jn] = multiplyQ(slerp(identityQ(), jo.add, wj), targets[jn] ?? identityQ());
        if (jo.strength !== undefined) strengthMul[jn] = (strengthMul[jn] ?? 1) * (1 + w * (jo.strength - 1));
        if (jo.target || jo.add) (layerLog[jn] ??= []).unshift(`${b.name} ${wj.toFixed(2)}`);
      };
      for (const [jn, jo] of Object.entries(out.joints)) if (jo) apply(jn as JointName, jo);
      if (out.gaze) {
        let gs = this.gazeState.get(b);
        if (!gs) { gs = { yaw: 0, pitch: 0 }; this.gazeState.set(b, gs); }
        const g = solveGaze({ ...bctx, base: targets }, out.gaze.target, this.cfg.LookAt, gs);
        if (b instanceof LookAt) b.setAngles(g.yaw, g.pitch);
        for (const [jn, jo] of Object.entries(g.joints)) if (jo) apply(jn as JointName, { ...jo, weight: jo.weight * out.gaze.weight });
        topGaze = { target: out.gaze.target, weight: w * out.gaze.weight };
      }
      if (out.hands) for (const h of HANDS) { const ht = out.hands[h]; if (ht) hands[h] = { ...ht, weight: w * ht.weight }; }
      comDrop += w * (out.comDrop ?? 0);
      if (out.comShift) comShift = [(comShift?.[0] ?? 0) + w * out.comShift[0], (comShift?.[1] ?? 0) + w * out.comShift[1]];
      tiltAllow = Math.max(tiltAllow, w * (out.tiltAllowDeg ?? 0));
      if (out.freeArm) freeArm = { reflexScale: 1 + w * (out.freeArm.reflexScale - 1), abductDeg: w * out.freeArm.abductDeg, loose: w * out.freeArm.loose, looseMotorScale: out.freeArm.looseMotorScale, looseReg: out.freeArm.looseReg, hands: freeArm ? freeArm.hands.filter((h) => out.freeArm!.hands.includes(h)) : [...out.freeArm.hands], parts: out.freeArm.parts };
      if (out.trunkGainScale !== undefined) trunkScale *= 1 + w * (out.trunkGainScale - 1);
      if (out.balanceMode === 'off' && w > 0.5) mode = 'off';
      else if (out.balanceMode === 'weak' && mode === 'on') mode = 'weak';
      if (out.stepAllowed === false && w > 0.5) stepAllowed = false;
      if (out.minComHeight !== undefined && w > 0.5) minComHeight = Math.min(minComHeight ?? Infinity, out.minComHeight);
    }
    // 로그
    for (const [jn, l] of Object.entries(layerLog)) log.layers[jn as JointName] = l!.join(' > ');
    log.strengthMul = strengthMul;
    for (const wd of this.wounds) {
      const bp = bodyPose(ctx.rd, wd.body);
      log.wounds.push({ id: wd.id, body: wd.body, point: add(bp.pos, rotate(bp.rot, wd.local)), normal: rotate(bp.rot, wd.normalLocal), type: wd.type, dv: wd.dv, t: wd.t });
    }
    for (const h of HANDS) {
      const ht = hands[h];
      if (!ht) continue;
      const hp = bodyPose(ctx.rd, h);
      const palm = add(hp.pos, rotate(hp.rot, ht.palmLocal));
      const hw = this.list.find((b): b is HoldWound => b instanceof HoldWound && b.hand === h && b.last !== null);
      const wl = ht.woundId !== null ? log.wounds.find((x) => x.id === ht.woundId) : undefined;
      log.hands.push({ hand: h, target: hw?.last?.target ?? null, ref: ht.palm, palm, dist: length(sub(palm, hw?.last?.target ?? ht.palm)), woundDist: wl ? length(sub(palm, wl.point)) : null, weight: ht.weight, woundId: ht.woundId });
    }
    const look = this.list.find((b): b is LookAt => b instanceof LookAt && b.stopT === null && !!b.target);
    const gz = look ? { target: look.target!, weight: look.weight } : topGaze;
    if (gz) {
      const hp = bodyPose(ctx.rd, 'Head');
      log.gaze = { target: gz.target, weight: gz.weight, errorDeg: (angleBetween(rotate(hp.rot, [0, 0, 1]), sub(gz.target, hp.pos)) * 180) / Math.PI };
    }
    log.comDrop = comDrop;
    log.tiltAllowDeg = tiltAllow;
    log.trunkGainScale = trunkScale;
    log.balanceMode = mode;
    log.fall = fall;
    log.air = air;
    log.damage = { lowerCap: this.lowerCap };
    if (this.lastImpact) log.impact = this.lastImpact;
    this.lastTiltAllow = tiltAllow;
    this.lastStrength = strengthMul;
    // (v0.8b) 잡기·벽 로그 (잡을 곳·벽이 있는 지형에서만 — 이전 지형 로그는 그대로)
    if (this.grabLog) {
      const pl = (this.cfg.Grab as { palmLocal: Vec3 }).palmLocal;
      for (const b of this.list) if (b instanceof Grab) {
        const hp = bodyPose(ctx.rd, b.hand);
        this.grabLog.hands.push({ hand: b.hand, phase: b.grabPhase, kind: b.kind, target: b.target, ref: b.grabPhase === 'reach' ? b.ref : null, anchor: b.anchor, force: b.joint?.forceMag ?? 0, slip: b.joint?.slip ?? 0, palm: add(hp.pos, rotate(hp.rot, pl)) });
      }
      log.grab = this.grabLog;
    }
    // 피해 누적: 다리 힘 상한
    // 무릎을 꿇는 동안은 kneelCap까지 덜 깎는다 (상한은 '서 있을 힘'이다: 꿇은 자세는 무릎·고관절 부하가 훨씬 작다)
    const kw = this.list.find((b) => b instanceof Kneel && b.stopT === null)?.weight ?? 0;
    const cap = this.lowerCap + (Math.max(this.lowerCap, this.cfg.damage.kneelCap) - this.lowerCap) * kw;
    if (cap < 1) for (const jn of ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'] as JointName[]) capacityMul[jn] = (capacityMul[jn] ?? 1) * cap;
    this.state = log;
    return { targets, strengthMul, capacityMul, hands, comDrop, comShift, tiltAllowDeg: tiltAllow, trunkGainScale: trunkScale, balanceMode: mode, stepAllowed, minComHeight, stepping, freeArm };
  }
}
