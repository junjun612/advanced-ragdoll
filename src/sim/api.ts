// 공개 API (SPEC 7.2) — v0.3 부분집합: World.create / addCharacter / step, Character.hit / applyImpulse / setState / playClip / setMuscleScale / setAssist / setBalance / getState / on.
// 한 스텝 순서는 SPEC 7.1을 따른다. Rapier 객체는 이 밖으로 내보내지 않는다(getState만 쓴다).
import simCfg from '../../config/sim.json';
import hitScale from '../../config/hitScale.json';
import musclesCfg from '../../config/muscles.json';
import assistCfg from '../../config/assist.json';
import balanceCfg from '../../config/balance.json';
import steppingCfg from '../../config/stepping.json';
import hitModelCfg from '../../config/hitModel.json';
import behaviorsCfg from '../../config/behaviors.json';
import animDriverCfg from '../../config/animDriver.json';
import getupCfg from '../../config/getup.json';
import reactionCfg from '../../config/reaction.json';
import { ReactionController, ReactionLibrary, styleTrackingRef, type ReactionConfig } from './character/reaction';
import settleCfg from '../../config/settle.json';
import { SettleController, type SettleConfig } from './character/settle';
import presenceCfg from '../../config/presence.json';
import gameCfg from '../../config/game.json';
import { HandPoseController, type HandPoseConfig } from './character/handPose';
import { BreathController, type BreathConfig } from './character/breath';
import { ToneController, type ToneConfig } from './character/tone';
import type { PresenceBehaviorConfig } from './character/behaviors/blender';
/** (pres-1) 누움 판정에서 빼는 바디 (서 있거나 짚거나 꿇어도 닿는 곳) */
const HAND_POSE_LIMB_ENDS = new Set<string>(['LeftFoot', 'RightFoot', 'LeftHand', 'RightHand', 'LeftLeg', 'RightLeg', 'LeftToeBase', 'RightToeBase', 'LeftForeArm', 'RightForeArm']);
import { GETUP_LIBRARY } from './character/getupClips.generated';
import { GetupAssist, GetupController, GetupLibrary, RootBlend, type GetupConfig, type GetupLibraryData, type GetupLog } from './character/getup';
import { classifyFeature, poseFeature, POSTURE_KO } from './character/getupFeatures';
import { GetupQP } from './character/getupQP';
import { AnimClip, AnimDriver, Inertializer, massModelOf, yawOfQ, type AnimClipFile, type AnimDriverConfig, type AnimRef, type Xform } from './character/animDriver';
import { ANIM_CLIPS } from './character/animClips';
import { REACTION_CLIPS } from './character/reactionClips.generated';
import { PoweredStates, type StatesConfig, type StatesLog } from './character/states';
import { PinAssist, type PinConfig, type PinState } from './character/pin';
import { WalkController, type WalkConfig, type WalkState } from './character/walk';
import { resolveHit, pushProfile, type HitModelConfig } from './character/hitModel';
import { BehaviorBlender, type BehaviorsConfig } from './character/behaviors/blender';
import type { BalanceBehaviorInput } from './character/balance';
import { Prng } from './prng';
import { PhysicsWorld, initRapier, R, type TerrainName } from './world';
import { Ragdoll, limitApproachRate, limitSigned, limitViolation, type RagdollConfig } from './character/ragdoll';
import { Muscles, type MuscleConfig } from './character/muscles';
import { RootAssist, type AssistConfig } from './character/assist';
import { Balance, type BalanceConfig } from './character/balance';
import { Stepping, type SteppingConfig } from './character/stepping';
import type { FootName } from './character/perception';
import { perceive, isFootBody, type Perception } from './character/perception';
import { PoseClip, forwardKinematics, lowestFootY, type PoseFile, type JointTargets } from './character/pose';
import { POSES } from './character/poseLibrary';
import type { BodyName, CharacterDef } from './character/characterDef';
import { classifyPosture, type JudgeConfig } from './metrics/posture';
import { type Vec3, add, sub, length, normalize, scale, angleBetween } from './math/vec3';
import { fromAxisAngle, fromTo, multiplyQ, rotate, slerp as slerpQ, conjugate as conjugateQ, angleBetweenQ, type Quat } from './math/quat';
import { signedDistanceToPolygon, type Vec2 } from './math/geometry';
import type { BodyState, CharacterState, JointName, JointState, ReturnAnimLog, SimEvent, StateName } from './types';
import { ContactSensor, INTERACTION, Prop, type PropDef, type SensedHit, type StepContact } from './interaction';
import type { LookAt } from './character/behaviors/simple';
import { saveWorld, restoreWorld, type WorldSnapshot } from './snapshot';
import type { ReferenceFrame } from './tracker';
import type { HandName } from './character/behaviors/types';

export interface HitInfo {
  type: 'bullet' | 'melee' | 'explosion' | 'push';
  body?: BodyName;
  /** explosion: 폭발 중심 (필수, 월드). 그 밖: 맞은 점 */
  point?: Vec3;
  /** explosion은 쓰지 않는다 (방사형) */
  direction: Vec3;
  /** 전신 COM Δv (m/s) 또는 config/hitScale.json 이름 */
  magnitude: number | 'small' | 'medium' | 'large';
  /**
   * (v0.5b, push만) 충격을 이 시간(초) 동안 고르게 나눠 가한다 — 손으로 미는 것처럼. 없거나 0이면 한 스텝(v0.1~v0.4 그대로).
   * 합은 같은 J = 총질량 × Δv. 큰 밀기를 12kg 몸통 한 바디에 한 스텝에 주면 몸통만 9 m/s로 튀어 채찍처럼 젖혀졌다 (README 결정)
   */
  duration?: number;
}

export type CharacterEvent = 'hit' | 'exploded' | 'fell' | 'setMuscleScale' | 'setAssist' | 'setBalance' | 'step' | 'stepStart' | 'stagger' | 'trigger' | 'footReplace' | 'hitReacted' | 'behaviorStart' | 'behaviorStop' | 'lookAt' | 'setState' | 'walkHandover' | 'walkResume'
  | 'reactionStart' | 'reactionEnd' | 'collisionSnap'
  | 'getupReady' | 'getupStart' | 'getupBalance' | 'getupDone' | 'getupFail' | 'getupCancel' | 'getupGiveUp' | 'setGetup' | 'voidStep'
  // (v0.9, SPEC 7.2) 알림 전용 이벤트: 리스너에만 보내고 world.events(로그)에는 남기지 않는다 (README 결정 9a-4)
  | 'gotUp' | 'grabbed' | 'released'
  // (README 결정 game-1) 게임 애니 복귀: recovered = 복귀 가능 시점(알림 전용), returnStart/returnDone/returnCancel = returnToAnimation 진행(로그에 남음)
  | 'recovered' | 'returnStart' | 'returnDone' | 'returnCancel';

/** (v0.9) 알림 전용 이벤트 (world.events에 남지 않음) */
export const NOTIFY_ONLY_EVENTS: readonly CharacterEvent[] = ['fell', 'gotUp', 'grabbed', 'released', 'recovered'];

/** (README 결정 game-1) config/game.json */
export interface GameConfig {
  recovered: { holdTime: number; standSpeed: number; standCpMargin: number; walkDcmError: number; allowBehaviors: string[] };
  returnToAnim: { blendTime: number; pinFrac: number; minKinematicBlend: number };
  variation: { enabled: boolean; clipCostTol: number; legBias: number; armScale: number; delayJitter: number };
}
const GAME = gameCfg as unknown as GameConfig;

/** (game-1) returnToAnimation 옵션 */
export interface ReturnOpts {
  /** 전체 전환 시간 (s, 기본 config/game.json returnToAnim.blendTime). 앞 pinFrac은 핀 블렌드, 나머지는 키네마틱 관성화 */
  blendTime?: number;
  /** 'recovered'(기본): 복귀 가능 시점까지 기다렸다가 돌아간다. 'now': 바로 (반응 중이면 핀 없이 관성화만) */
  when?: 'recovered' | 'now';
  /** 클립 시작 시각 (s). 없으면 루프 클립은 지금 발 접촉·다리 자세에 가장 가까운 위상, 아니면 0 */
  startTime?: number;
  /** 클립이 향할 방향 yaw (rad). 없으면 지금 골반 방향 (걷던 클립을 이어 갈 때는 그 클립 방향) */
  yaw?: number;
}


// (v0.9) 앱·도구가 src/sim/api.ts 하나만 import하도록 공개 타입을 다시 내보낸다 (docs/API.md)
export type { BodyName, CharacterDef } from './character/characterDef';
export type { RagdollConfig } from './character/ragdoll';
export type { MuscleConfig } from './character/muscles';
export type { PropDef, PropState } from './interaction';
export type { Scenario, ScenarioEvent } from './scenario';
export type { CharacterState, JointName, ReturnAnimLog, SimEvent, StateName, Vec3 } from './types';
export type { TerrainName } from './world';
export type { WorldSnapshot } from './snapshot';
export type { ReferenceFrame, Tracker, TrackerCommand, TrackingRef } from './tracker';
export { CURRENT_TRACKER } from './tracker';
export { ScenarioPlayback } from './scenarioPlayer';
export { randomFallScenario } from './getupScenarios';

/** 스폰 (SPEC 7.2 + v0.2 확장): pose = 그 목표 포즈로 서 있게 만든다(발바닥 최저점을 position.y에 맞춤), pin = 고정 바디(시험 장치) */
export interface SpawnOpts {
  position: Vec3;
  yaw: number;
  state?: StateName;
  pose?: string;
  pin?: BodyName[];
  /** pose 스폰 때 두 발바닥이 수평이 되도록 몸 전체를 돌린다 (기본 true, 경사 스폰은 false) */
  levelFeet?: boolean;
  /** (v0.7) 바디별 월드 자세(def.bodies 순서)로 스폰 — 쓰러진 자세에서 시작(겟업 라이브러리 시험·시나리오). position·yaw만큼 옮기고 돌린다(원점 기준) */
  bodies?: { pos: Vec3; rot: [number, number, number, number] }[];
}

/** 캐릭터별 설정 바꾸기 (튜닝·스윕용). 없으면 config/*.json */
export interface CharacterOpts {
  muscles?: MuscleConfig;
  assist?: AssistConfig;
  poses?: Readonly<Record<string, PoseFile>>;
  /** 루트 보조를 처음부터 켬/끔 (없으면 assist.json enabledByDefault) */
  rootAssist?: boolean;
  balanceConfig?: BalanceConfig;
  /** 균형 계층을 처음부터 켬/끔 (없으면 balance.json enabledByDefault) */
  balance?: boolean;
  steppingConfig?: SteppingConfig;
  /** 행동·피격 설정 바꾸기 (v0.5a, 튜닝용). 없으면 config/behaviors.json, config/hitModel.json */
  behaviorsConfig?: BehaviorsConfig;
  hitModelConfig?: HitModelConfig;
  /** 스텝 계층을 처음부터 켬/끔 (없으면 stepping.json enabledByDefault, v0.4) */
  stepping?: boolean;
  /** 애니메이션 통합 설정 (v0.6, 튜닝용). 없으면 config/animDriver.json */
  animConfig?: AnimConfig;
  /** 애니 클립 라이브러리 덧붙이기·바꾸기 (v0.6, 후보 평가용). 이름이 같으면 이것이 이긴다 */
  animClips?: Readonly<Record<string, AnimClipFile>>;
  /**
   * (v0.7) 일어서기: true/false = 켬/끔(게임이 막음), 객체 = 시험 옵션(probe: 판정만 하고 그 순간 자세를 남김, only: 이 클립만).
   * 없으면 켬
   */
  getup?: boolean | { enabled?: boolean; probe?: boolean; only?: string };
  /** (v0.7) 겟업 라이브러리 바꾸기 (라이브러리 만들기·시험용). 없으면 assets/library/getup.json */
  getupLibrary?: GetupLibraryData;
  getupConfig?: GetupConfig;
  /**
   * (v0.8c) 여러 캐릭터 월드에서 이 캐릭터 이름 (이벤트 char, 접촉 상대 이름, 로그 파일). 없으면 혼자인 캐릭터(이전과 같은 로그·이벤트).
   * 두 번째 이후 캐릭터는 시드 PRNG 하위 스트림을 'character:<이름>' 아래로 갈라 쓴다(첫 캐릭터는 그대로)
   */
  name?: string;
  /** (2026-10-27) 반응 클립 추종 설정 바꾸기. 없으면 config/reaction.json */
  reactionConfig?: ReactionConfig;
  /** (2026-10-27, 결정 settle-1) 진정 단계 설정 바꾸기. 없으면 config/settle.json */
  settleConfig?: SettleConfig;
  /** (README 결정 game-3) 반응 변주 켬/끔. 없으면 config/game.json variation.enabled */
  variation?: boolean;
}


/** config/animDriver.json (v0.6) */
export interface AnimConfig {
  driver: AnimDriverConfig;
  states: StatesConfig;
  pin: PinConfig;
  walk: WalkConfig;
  /**
   * 반응·복귀: 피격·밀기 뒤 reactHold초는 반응 중(핀 0). 걷기 추종을 넘긴 뒤 스텝 계층이 서기로 돌아오고(이후 minHold초) 막는 행동이 없으면
   * 클립 위상을 맞춰 다시 붙인다(policy 'resume') 또는 서 있는다('stop'). blockers = 다시 붙이지 않는 행동
   */
  resume: {
    reactHold: number; minHold: number; policy: 'resume' | 'stop'; blockers: string[]; blendTime: number; maxDcmError: number;
    /** 멈춘 몸으로 걷기에 돌아갈 때 쓸 걷기 시작 클립 (루프 클립 이름 → 시작 클립 이름). 수평 속도 < startMaxSpeed일 때 startTau부터 재생 */
    startClips?: Record<string, string>; startMaxSpeed?: number; startTau?: number;
    /** 시작 클립 끝 chainBefore초 전에 루프 클립의 가장 가까운 위상(클립 기준 자세로 맞춤)으로 넘어간다 */
    chainBefore?: number;
  };
  /** (app-2) 애니 강제 비율 오버라이드 (setAnimOverride). 없으면 꺼짐 */
  animOverride?: { default: number; mode: 'full' | 'shape'; fallbackPose: string };
}

const DEG = 180 / Math.PI;
/** 누움 판정에서 빼는 바디 (blender와 같음: 서 있거나 짚거나 꿇은 자세에서도 닿는 곳) */
const LIMB_ENDS = new Set<BodyName>(['LeftFoot', 'RightFoot', 'LeftHand', 'RightHand', 'LeftLeg', 'RightLeg', 'LeftToeBase', 'RightToeBase']);
const judge = simCfg.judge as JudgeConfig;
const gravityMag = length(simCfg.gravity as Vec3);

export function resolveMagnitude(m: HitInfo['magnitude']): number {
  if (typeof m === 'number') return m;
  const v = (hitScale as Record<string, number>)[m];
  if (v === undefined) throw new Error(`unknown hit magnitude '${m}'`);
  return v;
}

export class World {
  readonly characters: Character[] = [];
  /** (v0.8c) 프롭 (떨어지거나 던진 물체) */
  readonly props: Prop[] = [];
  /** 모든 캐릭터의 이벤트 (meta.json events) */
  readonly events: SimEvent[] = [];
  readonly prng: Prng;
  /** (v0.8c) 콜라이더 → 주인 (캐릭터 순번 또는 프롭 순번). 지면은 없음 */
  private readonly owners = new Map<number, { char: number } | { prop: number }>();
  /** (v0.8c) 접촉 거르기 훅을 켠 콜라이더 → 바디 이름 */
  private readonly hookBody = new Map<number, BodyName>();
  /** (v0.8c) 이번 스텝 서로 다른 캐릭터 바디 사이 최대 관통 깊이 (m), 지금까지 최대 */
  interPenetration = 0;
  interPenetrationMax = 0;
  /** (v0.8c) 프롭 직전 스텝 속도 (접촉 전 속도 — 접촉 스텝 뒤에는 이미 줄어 있다) */
  private propVel: Vec3[] = [];

  private constructor(readonly physics: PhysicsWorld, readonly seed: number) {
    this.prng = new Prng(seed);
  }

  static async create(opts: { seed: number; dt?: number; terrain?: TerrainName; gravity?: Vec3 }): Promise<World> {
    await initRapier();
    return new World(new PhysicsWorld({ dt: opts.dt, terrain: opts.terrain, gravity: opts.gravity }), opts.seed);
  }

  get time(): number {
    return this.physics.time;
  }
  get dt(): number {
    return this.physics.dt;
  }

  addCharacter(def: CharacterDef, cfg: RagdollConfig, spawn: SpawnOpts, opts: CharacterOpts = {}): Character {
    const k = this.characters.length;
    if (k >= INTERACTION.collisionBits.maxCharacters) throw new Error(`too many characters (max ${INTERACTION.collisionBits.maxCharacters}, config/interaction.json)`);
    const c = new Character(this, def, cfg, spawn, opts);
    this.characters.push(c);
    this.physics.persons.push({ name: c.name ?? `#${k}`, bodies: c.rd.bodies });
    for (const b of c.rd.bodies) for (const col of b.cols) this.owners.set(col.handle, { char: k });
    // (v0.8c) 두 번째 캐릭터부터: 모든 캐릭터에 충돌 비트를 준다 (몸 안 제외 쌍은 막고 캐릭터끼리는 충돌, ragdoll.ts charBit). 혼자면 그대로 0
    if (this.characters.length > 1) this.characters.forEach((ch, i) => ch.rd.setCharBit(1 << (INTERACTION.collisionBits.firstBit - i)));
    // (v0.8c) 캐릭터끼리 충돌하지 않을 바디 쌍 (config character.noCollide, 예: 발끼리) — Rapier 접촉 거르기 훅. 혼자인 월드는 훅 없음
    const nc = INTERACTION.character.noCollide;
    if (this.characters.length > 1 && nc.length) {
      for (const ch of this.characters) for (const b of ch.rd.bodies) if (nc.some(([x, y]) => x === b.name || y === b.name)) for (const col of b.cols) { col.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS); this.hookBody.set(col.handle, b.name); }
      this.installContactFilter();
    }
    this.physics.refreshContacts();
    return c;
  }

  /** (v0.8c) 캐릭터끼리 noCollide 바디 쌍 접촉 거르기 훅 (한 번만 만든다. 복원 뒤에도 다시 만든다) */
  private installContactFilter(): void {
    const nc = INTERACTION.character.noCollide;
    this.physics.hooks ??= {
      filterContactPair: (h1, h2) => {
        const o1 = this.owners.get(h1), o2 = this.owners.get(h2);
        if (o1 && o2 && 'char' in o1 && 'char' in o2 && o1.char !== o2.char) {
          const b1 = this.hookBody.get(h1), b2 = this.hookBody.get(h2);
          if (b1 && b2 && nc.some(([x, y]) => (x === b1 && y === b2) || (x === b2 && y === b1))) return null;
        }
        return R.SolverFlags.COMPUTE_IMPULSE;
      },
      filterIntersectionPair: () => true,
    };
  }

  // ── 직렬화 (v0.9, src/sim/snapshot.ts, docs/API.md) ──
  /**
   * 지금 상태를 JSON 직렬화 가능한 스냅샷으로 저장한다 (Rapier 물리 + 모든 캐릭터·프롭의 행동·균형·스텝·클립·반응·겟업 상태).
   * World.load로 복원해 이어서 돌리면 원래 실행과 바이트 단위로 같다. 이벤트 리스너는 저장하지 않는다. 저장은 시뮬레이션을 바꾸지 않는다
   */
  save(): WorldSnapshot {
    return saveWorld(this);
  }

  /** 스냅샷에서 새 World를 만든다 (같은 빌드의 스냅샷만). Character.on 리스너는 다시 등록한다 */
  static async load(s: WorldSnapshot): Promise<World> {
    return (await restoreWorld(s)).world;
  }

  /** @internal 복원 직후 (snapshot.ts): 저장하지 않은 훅을 다시 만든다 */
  _afterRestore(): void {
    if (this.hookBody.size > 0) this.installContactFilter();
  }

  /** (v0.8c, SPEC 7.2 addProp) 프롭을 만든다 (지금 시각, 정의의 위치·속도로) */
  addProp(def: PropDef): Prop {
    if (this.props.some((p) => p.def.id === def.id)) throw new Error(`prop id '${def.id}' already exists`);
    const p = new Prop(this.physics, def, this.time);
    this.owners.set(p.col.handle, { prop: this.props.length });
    this.props.push(p);
    this.events.push({ t: this.time, type: 'propSpawn', detail: def.id });
    return p;
  }

  /** (v0.8c) 이름으로 캐릭터 찾기 */
  character(name: string): Character | undefined {
    return this.characters.find((c) => c.name === name);
  }

  /** (v0.8c) 다른 캐릭터·프롭이 있는 월드인가 (접촉 감지를 돈다). 혼자인 캐릭터 월드는 이전과 똑같이 돈다 */
  get interactive(): boolean {
    return this.characters.length > 1 || this.props.length > 0;
  }

  /**
   * (v0.8b 훅, v0.8c 설정) 잡을 곳 후보 콜라이더: grabbable 프롭 + (config/interaction.json character.grabbable이면) 다른 캐릭터의 바디.
   * Grab 행동(v0.8b)이 이것을 읽는다. 기본은 다른 캐릭터를 잡지 않는다
   */
  grabTargets(self: Character | null): { kind: 'prop' | 'character'; id: string; collider: R.Collider }[] {
    const out: { kind: 'prop' | 'character'; id: string; collider: R.Collider }[] = [];
    for (const p of this.props) if (p.def.grabbable) out.push({ kind: 'prop', id: p.def.id, collider: p.col });
    if (INTERACTION.character.grabbable) {
      for (const c of this.characters) if (c !== self) for (const b of c.rd.bodies) for (const col of b.cols) out.push({ kind: 'character', id: `${c.name ?? ''}:${b.name}`, collider: col });
    }
    return out;
  }

  /** 고정 스텝 하나 (SPEC 7.1). */
  step(): void {
    for (const c of this.characters) c._preStep(); // 1~7
    this.physics.stepPhysics(); // 8
    for (const c of this.characters) c._postStep(); // 9 (10 로그는 호출자가 getState로)
    if (this.interactive) this.senseContacts();
    for (const c of this.characters) c._notifyEvents(); // (v0.9) 알림 전용 이벤트 (듣는 사람이 있을 때만)
  }

  /**
   * (v0.8c) 접촉 감지: 캐릭터마다 다른 캐릭터·프롭에서 이번 스텝 받은 법선 충격량(Rapier 접촉 해, 이미 몸에 들어간 것)을 상대별로 모아
   * 감지기(감지 창 → Δv → hit)에 넣는다. 캐릭터 사이 관통 깊이도 잰다. 충격을 새로 가하지 않는다
   */
  private senseContacts(): void {
    const pw = this.physics.world;
    const t = this.time;
    let pen = 0;
    this.characters.forEach((c, ci) => {
      const per = new Map<string, StepContact>();
      for (const b of c.rd.bodies) for (const bc of b.cols) {
        pw.contactPairsWith(bc, (other) => {
          const o = this.owners.get(other.handle);
          if (!o || ('char' in o && o.char === ci)) return;
          const isChar = 'char' in o;
          const source = isChar ? (this.characters[o.char]!.name ?? `#${o.char}`) : `prop:${this.props[o.prop]!.def.id}`;
          pw.contactPair(bc, other, (m, flipped) => {
            const n = m.normal();
            // 몸(bc)이 받는 법선 방향: 상대 → 몸 (perception.ts 지면 접촉과 같은 규칙)
            const nrm: Vec3 = flipped ? [n.x, n.y, n.z] : [-n.x, -n.y, -n.z];
            for (let i = 0; i < m.numContacts(); i++) {
              const d = -m.contactDist(i);
              let sc = per.get(source);
              if (!sc) { sc = { source, kind: isChar ? 'character' : 'prop', J: [0, 0, 0], byBody: new Map(), pointSum: [0, 0, 0], wsum: 0, penetration: 0, speed: 0 }; per.set(source, sc); }
              if (d > sc.penetration) sc.penetration = d;
              if (isChar && d > pen) pen = d;
              // 프롭이 몸 쪽으로 다가오던 속력 (직전 스텝 속도 · 법선): 떨어지거나 날아온 물체 vs 발로 찬 상자
              // 날아온 물체로 칠 속력: 프롭 속력, 단 몸 쪽으로 다가오는 성분이 minApproach 이상일 때만 (아니면 0 — 굴러가는 상자를 발로 참)
              if (!isChar) {
                const pv = this.propVel[o.prop];
                if (pv && pv[0] * nrm[0] + pv[1] * nrm[1] + pv[2] * nrm[2] >= INTERACTION.prop.minApproach) sc.speed = Math.max(sc.speed, Math.hypot(pv[0], pv[1], pv[2]));
              }
              const imp = m.contactImpulse(i);
              if (!(imp > 0)) continue;
              const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
              if (!lp) continue;
              const ct = bc.translation(), cr = bc.rotation();
              const w = rotate([cr.x, cr.y, cr.z, cr.w], [lp.x, lp.y, lp.z]);
              const point: Vec3 = [ct.x + w[0], ct.y + w[1], ct.z + w[2]];
              sc.J = add(sc.J, scale(nrm, imp));
              sc.byBody.set(b.name, (sc.byBody.get(b.name) ?? 0) + imp);
              sc.pointSum = add(sc.pointSum, scale(point, imp));
              sc.wsum += imp;
            }
          });
        });
      }
      const contacts = [...per.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
      c._onContacts(t, contacts);
    });
    this.interPenetration = pen;
    this.interPenetrationMax = Math.max(this.interPenetrationMax, pen);
    this.propVel = this.props.map((p) => { const v = p.rb.linvel(); return [v.x, v.y, v.z] as Vec3; });
  }

  /** 렌더 프레임 시간 누적 → 필요한 만큼 고정 스텝 */
  advance(realDt: number): number {
    return this.physics.advance(realDt, () => this.step());
  }

  free(): void {
    this.physics.free();
  }
}

interface Pending {
  /** 피격 (hitModel이 Rapier 스텝 직전 자세로 충격량·상처·행동을 정한다) */
  hit?: HitInfo & { dv: number };
  /** (v0.8c) 접촉으로 감지한 피격: 충격은 물리가 이미 가했으므로 다시 가하지 않고 반응만 (source = 상대) */
  sensed?: SensedHit;
  /** applyImpulse 직접 */
  body?: BodyName;
  impulse?: Vec3;
  point?: Vec3;
}

export class Character {
  readonly rd: Ragdoll;
  readonly muscles: Muscles;
  readonly rootAssist: RootAssist;
  readonly balance: Balance;
  readonly stepping: Stepping;
  readonly poses: Readonly<Record<string, PoseFile>>;
  /** 행동 계층 (v0.5a) */
  readonly behaviors: BehaviorBlender;
  readonly hitModel: HitModelConfig;
  private clip: { clip: PoseClip; t0: number } | null = null;
  /** 파워드 랙돌 상태 머신 (v0.6) */
  readonly states: PoweredStates;
  /** 애니메이션 클립 재생기 (v0.6) */
  readonly anim: AnimDriver;
  /** 핀 보조 (v0.6, assist.pin) */
  readonly pin: PinAssist;
  /** 애니 추종 걷기 (v0.6) */
  readonly walk: WalkController;
  readonly animCfg: AnimConfig;
  private readonly animLib: Readonly<Record<string, AnimClipFile>>;
  /** 반응 중(핀 0) 끝 시각 (피격·밀기 뒤 reactHold) */
  private reactUntil = -Infinity;
  /** 걷기 추종을 넘긴 시각 (복귀 판정) */
  private handoverT: number | null = null;
  /** 걷기 시작 클립 재생 중이면 그 뒤 이어 갈 루프 클립 (v0.6) */
  private resumeTo: string | null = null;
  private walkNoCollide = 0;
  /** 마지막 상태 전환의 속도 넘김 차이 (지표): 바디별 |v_set − v_kinematic| 최대 */
  private switchJump: { t: number; lin: number; ang: number; hit: boolean } | null = null;
  private get stateName(): StateName { return this.states.name; }
  /** 일어서기 (v0.7): 판정·시도·실행 상태, 겟업 보조, 라이브러리 */
  readonly getup: GetupController;
  readonly getupAssist: GetupAssist;
  readonly getupLib: GetupLibrary;
  /** 겟업 전신 QP (v0.7) */
  readonly getupQP: GetupQP;
  private getupRefTau: number | null = null;
  /** 겟업 뒤 Idle: 애니 추종 QP에 다시 붙이지 않음 (다른 클립 재생·상태 바꾸기 때 풂) */
  private getupIdleHold = false;
  /** 겟업 취소·실패 뒤 서기 포즈 목표로 관성화 (클립 목표 → 서기 포즈가 한 스텝에 바뀌면 손이 53 rad/s로 돌았다) */
  private readonly standBlend = new Inertializer();
  /** (2026-10-27) 반응 클립 추종 */
  readonly reaction: ReactionController;
  /** 진정 단계 (README 결정 settle-1): 버틴 뒤 팔을 내리고 상체를 세운다 */
  readonly settle: SettleController;
  /** (README 결정 pres-1) 손가락 포즈 상태 (렌더 전용, 물리 영향 없음) */
  readonly handPose: HandPoseController;
  /** (README 결정 pres-3) 호흡·미세 움직임 (서기 포즈 목표 변조) */
  readonly breath: BreathController;
  /** (결정 tone-1) 근긴장: 공동수축·신장 반사 → 근육 모터 강성·감쇠 배율 */
  readonly tone: ToneController;
  private reactionLib: ReactionLibrary | null = null;
  private readonly reactionNames: string[];
  private readonly baseWalkCfg: WalkConfig;
  private pending: Pending[] = [];
  private listeners = new Map<CharacterEvent, ((e: SimEvent) => void)[]>();
  /** (v0.9) 알림 이벤트 상태: 넘어짐 걸쇠(다시 설 때까지 한 번), 잡고 있는 손 */
  private notifyState: { down: boolean; holding: Partial<Record<HandName, true>> } = { down: false, holding: {} };
  /** (v0.9) 이번 스텝 레퍼런스 (레퍼런스 ↔ 추종기 경계, src/sim/tracker.ts) */
  private lastRef: ReferenceFrame | null = null;
  /** (app-2) 애니 강제 비율 0~1 (setAnimOverride). 0이면 아무것도 하지 않는다 */
  private animOverrideW = 0;
  /** (app-2) 애니 강제 핀 (처음 켤 때 만든다 — 한 번도 안 켜면 로그·스냅샷 그대로) */
  private animOverridePin: PinAssist | null = null;
  private animOverrideSource: 'clip' | 'pose' | '' = '';
  private animOverridePose: PoseClip | null = null;
  private exploded = false;
  /** (README 9f-11) 안전 검사: 이번 스텝 바깥 충격 여부, 직전 스텝 운동 에너지·바디별 부모 기준 회전, 진행 중인 속도 초과 구간 */
  private extImpulseNow = false;
  private prevKE = 0;
  private prevRel: Quat[] = [];
  private overRun: { n: number; start: number; ke0: number; keMax: number; allow: number; body: number; desc: string; preRel: Quat; ended: boolean } | null = null;
  private lastGood: { t: Vec3; r: [number, number, number, number] }[] = [];
  private cache: { step: number; state: CharacterState } | null = null;
  private colliderIdx = new Map<number, number>();
  private perCache: { step: number; per: Perception } | null = null;
  /** 시간에 걸쳐 나눠 가하는 충격 (push duration): 바디, 스텝당 충격량, 바디 로컬 작용점, 남은 스텝. (결정 chest-2) w = 남은 스텝별 몫(전체 J 대비, 반사인 모양), 있으면 J는 전체 충격량 */
  private ongoing: { body: BodyName; J: Vec3; local: Vec3 | null; left: number; w?: number[] }[] = [];
  /** (결정 chest-2) 이번 스텝 밀기 접촉 힘(N = 충격량/dt)·남은 접촉 시간(초). 접촉이 없으면 null (로그 push, 필름 균형 줄 '미는 힘') */
  private pushNow: { force: number; left: number } | null = null;
  /** (v0.8c) 이름 (여러 캐릭터 월드). 없으면 혼자 */
  readonly name: string | undefined;
  /** (v0.8c) 다른 캐릭터·프롭 접촉 감지기 */
  readonly contactSensor: ContactSensor;
  /** (v0.8c) 부딪힌 상대 돌아보기 (시작·끝 시각, 상대 이름) */
  private lookOther: { source: string; start: number; end: number; on: boolean } | null = null;
  /** (v0.8c) 로그: 마지막 감지 hit, 이번 스텝 접촉 */
  private lastSensed: SensedHit & { t: number } | null = null;
  /** (v0.8c) 접촉 피격으로 걷기 추종을 놓을 이유 (다음 균형 갱신 뒤 적용) */
  private contactHandover: { why: string; t: number; now: boolean } | null = null;
  /** (game-3) 반응 변주: 켬 여부, 하위 스트림, 이번 피격에 뽑은 값 (clipU = 반응 클립 후보 고르기 [0,1), arm = 팔 모양 세기 배율, delay = 감지 지연 ±) */
  private readonly variationOn: boolean;
  private readonly varRng: Prng | null;
  private variation: { n: number; clipU: number; arm: number; delay: number; legBias: number } | null = null;
  /** (game-1) 복귀 가능 판정: 무장(바깥 충격·넘어짐·일어서기 뒤), 조건을 만족한 시작 시각, 마지막 판정, 막는 이유 */
  private recovery: { armed: boolean; since: number | null; ok: boolean; blockedBy: string; step: number } = { armed: false, since: null, ok: false, blockedBy: '', step: -1 };
  /** (game-1) 게임 애니 복귀 진행 (returnToAnimation). null = 한 번도 부르지 않음 */
  private ret: (ReturnAnimLog & { when: 'recovered' | 'now'; startTime?: number; yaw?: number; go: boolean }) | null = null;

  constructor(readonly world: World, readonly def: CharacterDef, cfg: RagdollConfig, spawn: SpawnOpts, opts: CharacterOpts = {}) {
    const pres = presenceCfg;
    this.poses = opts.poses ?? POSES;
    this.name = opts.name;
    // (v0.8c) 두 번째 이후 캐릭터는 자기 하위 스트림 (첫 캐릭터는 이전과 같은 스트림 → 혼자인 시나리오 결과 그대로)
    const rng = world.characters.length === 0 ? world.prng : world.prng.fork(`character:${opts.name ?? world.characters.length}`);
    // 목표 포즈로 스폰: Hips를 rest 위치에 두고 순기구학 → 발바닥 최저점을 spawn.position.y로 → yaw·위치 적용
    let transforms: { pos: Vec3; rot: [number, number, number, number] }[] | undefined;
    this.animCfg = opts.animConfig ?? (animDriverCfg as unknown as AnimConfig);
    const glib = opts.getupLibrary ?? GETUP_LIBRARY;
    // 반응 클립 라이브러리 (2026-10-27): REACTLIB 실험(animClips)이 반응 클립을 주면 정적 라이브러리 대신 그것만 쓴다
    const extra = opts.animClips ?? {};
    const rlib = Object.keys(extra).some((k) => k.startsWith(((opts.reactionConfig ?? reactionCfg) as { clipPrefix: string }).clipPrefix)) ? {} : REACTION_CLIPS;
    const lib: Readonly<Record<string, AnimClipFile>> = { ...ANIM_CLIPS, ...glib.clips, ...rlib, ...extra };
    this.animLib = lib;
    const animSpawn = spawn.pose && lib[spawn.pose] ? spawn.pose : null;
    let animAnchor: Xform | null = null;
    if (spawn.bodies) {
      // 쓰러진 자세로 스폰 (v0.7): 바디 자세를 Y축 yaw로 돌리고 position만큼 옮긴다
      const q = fromAxisAngle([0, 1, 0], spawn.yaw);
      transforms = spawn.bodies.map((b) => ({ pos: add(rotate(q, b.pos), spawn.position), rot: multiplyQ(q, b.rot) }));
    } else if (animSpawn) {
      // 애니 클립으로 스폰 (v0.6): 클립 0프레임 FK. 앵커 = 스폰 yaw, Hips(xz)가 스폰 위치 위
      const ac = new AnimClip(lib[animSpawn]!, def, this.animCfg.driver.soleDownHeight);
      const p0 = ac.poseAt(0);
      const r0 = rotate(fromAxisAngle([0, 1, 0], spawn.yaw), [p0.root.pos[0], 0, p0.root.pos[2]]);
      animAnchor = { yaw: spawn.yaw, pos: [spawn.position[0] - r0[0], spawn.position[1], spawn.position[2] - r0[2]] };
      const tf = forwardKinematics(def, p0.joints, p0.root);
      const q = fromAxisAngle([0, 1, 0], animAnchor.yaw);
      transforms = tf.map((b) => ({ pos: add(rotate(q, b.pos), animAnchor!.pos), rot: multiplyQ(q, b.rot) }));
    } else if (spawn.pose) {
      const qYaw = fromAxisAngle([0, 1, 0], spawn.yaw);
      const hips = def.bodies[0]!;
      let local = forwardKinematics(def, this.getClip(spawn.pose).sample(0), { pos: hips.restPosition, rot: [0, 0, 0, 1] });
      // 발 평평하게 (v0.3, 기본 켬): 두 발 위 방향 평균을 월드 위로 돌리는 회전을 Hips 둘레로 전체에 적용한다.
      // 다리를 앞으로 기울인 서기 포즈(발목 굽힘 > 무릎 − 고관절)도 발바닥이 지면에 붙은 채, 몸 전체가 앞으로 기운 자세로 시작한다
      if (spawn.levelFeet !== false) {
        let up: Vec3 = [0, 0, 0];
        def.bodies.forEach((b, i) => { if (b.shape.type === 'box') up = add(up, rotate(local[i]!.rot, [0, 1, 0])); });
        if (length(up) > 1e-9) {
          const fix = fromTo(normalize(up), [0, 1, 0]);
          const o = hips.restPosition;
          local = local.map((tf) => ({ pos: add(o, rotate(fix, sub(tf.pos, o))), rot: multiplyQ(fix, tf.rot) }));
        }
      }
      const dy = -lowestFootY(def, local);
      transforms = local.map((tf) => {
        const p = rotate(qYaw, [tf.pos[0], tf.pos[1] + dy, tf.pos[2]]);
        return { pos: [p[0] + spawn.position[0], p[1] + spawn.position[1], p[2] + spawn.position[2]] as Vec3, rot: multiplyQ(qYaw, tf.rot) };
      });
    }
    this.rd = new Ragdoll(world.physics, def, cfg, { position: spawn.position, yaw: spawn.yaw, transforms, pin: spawn.pin });
    this.contactSensor = new ContactSensor(def.totalMass);
    this.states = new PoweredStates(spawn.state ?? 'Ragdoll', this.animCfg.states);
    const g = world.physics.world.gravity;
    this.muscles = new Muscles(
      this.rd,
      opts.muscles ?? (musclesCfg as unknown as MuscleConfig),
      (j) => cfg.bodies[j.name]?.jointDamping ?? cfg.defaultJointDamping,
      [g.x, g.y, g.z],
      this.stateName !== 'Ragdoll',
    );
    const hrb = this.rd.body('Hips').rb;
    const hr = hrb.rotation();
    const ac = (opts.assist ?? (assistCfg as AssistConfig)).root;
    const hp = hrb.translation();
    this.rootAssist = new RootAssist(this.rd, ac, [hr.x, hr.y, hr.z, hr.w], [hp.x, hp.y, hp.z], Math.hypot(g.x, g.y, g.z), opts.rootAssist);
    const bc = opts.balanceConfig ?? (balanceCfg as unknown as BalanceConfig);
    this.balance = new Balance(this.rd, def, bc, spawn.yaw, [g.x, g.y, g.z], opts.balance);
    if (this.poses.stand) this.balance.standTargets = this.getClip('stand').sample(0);
    const vr = rng.fork('balanceVariation');
    this.balance.applyVariation(() => vr.float());
    // 스텝 계층 (v0.4): 균형 계층 안에서 돈다. 트리거 지터·다리 선호는 시드 PRNG 하위 스트림
    this.stepping = new Stepping(this.rd, def, opts.steppingConfig ?? (steppingCfg as unknown as SteppingConfig), rng.fork('stepping'), opts.stepping);
    this.balance.stepping = this.stepping;
    // 행동 계층 (v0.5a): 시드 PRNG 하위 스트림 'behaviors', 비틀거림 지터는 'stagger' (스텝 스트림과 따로)
    this.behaviors = new BehaviorBlender(opts.behaviorsConfig ?? (behaviorsCfg as unknown as BehaviorsConfig), rng.fork('behaviors'), Math.hypot(g.x, g.y, g.z));
    this.hitModel = opts.hitModelConfig ?? (hitModelCfg as unknown as HitModelConfig);
    this.stepping.staggerRng = rng.fork('stagger');
    // 애니메이션 통합 (v0.6): 클립 재생기·핀 보조·애니 추종 걷기. 애니 클립이 없으면 아무것도 하지 않는다(v0.5c 경로 그대로)
    const mm = massModelOf(this.rd.bodies);
    this.anim = new AnimDriver(def, mm, this.animCfg.driver, lib);
    this.pin = new PinAssist(this.rd, this.animCfg.pin, mm);
    this.walk = new WalkController(this.rd, def, this.animCfg.walk);
    this.balance.walk = this.walk;
    this.baseWalkCfg = this.animCfg.walk;
    // 반응 클립 추종 (2026-10-27): 라이브러리 = 애니 클립 중 clipPrefix로 시작하는 것 (특징은 처음 쓸 때 계산)
    const rcfg = opts.reactionConfig ?? (reactionCfg as unknown as ReactionConfig);
    this.reactionNames = Object.keys(lib).filter((k) => k.startsWith(rcfg.clipPrefix)).sort();
    this.reaction = new ReactionController(rcfg, null, this.animCfg.walk);
    this.settle = new SettleController(opts.settleConfig ?? (settleCfg as unknown as SettleConfig));
    this.handPose = new HandPoseController(pres.handPose as unknown as HandPoseConfig);
    this.breath = new BreathController(pres.breath as unknown as BreathConfig, rng.fork('breath'));
    this.tone = new ToneController((this.muscles.cfg as unknown as { tone?: ToneConfig }).tone ?? ({ enabled: false } as ToneConfig));
    this.behaviors.presence = { reaction: pres.reaction, gaze: pres.gaze } as unknown as PresenceBehaviorConfig;
    // (game-3) 반응 변주: 캐릭터별 하위 스트림 (fork는 부모 상태를 쓰지 않는다 → 끄면 이전 결과 그대로)
    this.variationOn = opts.variation ?? GAME.variation.enabled;
    this.varRng = this.variationOn ? rng.fork('variation') : null;
    this.behaviors.lastRd = this.rd;
    if (animSpawn && animAnchor) {
      this.anim.play(animSpawn, world.time, { anchor: animAnchor, startTime: 0, blendTime: 0 });
      if (this.states.name === 'Animated') this.setBodiesKinematic(true);
    } else if (spawn.pose) this.playClip(spawn.pose);
    // 일어서기 (v0.7)
    const gc = opts.getupConfig ?? (getupCfg as unknown as GetupConfig);
    this.getupLib = new GetupLibrary(glib, def);
    const go = opts.getup;
    this.getup = new GetupController(gc, this.getupLib, typeof go === 'boolean' ? go : go?.enabled ?? true);
    if (typeof go === 'object') { this.getup.probe = !!go.probe; this.getup.only = go.only; }
    this.getupAssist = new GetupAssist(this.rd, gc.assist, gravityMag);
    this.getupQP = new GetupQP(this.rd, def, gc.qp, [g.x, g.y, g.z]);
    for (const b of this.rd.bodies) for (const c of b.cols) this.colliderIdx.set(c.handle, b.idx);
    this.saveGood();
  }

  /** 일어서기 켜기·끄기 (SPEC 12 v0.7 '게임이 막을 수 있음'). 끄면 일어서는 중이면 그대로 두고 새로 시작하지 않는다 */
  setGetup(on: boolean): void {
    this.getup.enabled = on;
    this.emit({ t: this.world.time, type: 'setGetup', detail: `getup=${on}` });
  }

  /** 바디 월드 자세 (def.bodies 순서) */
  bodyTransforms(): { pos: Vec3; rot: [number, number, number, number] }[] {
    return this.rd.bodies.map((b) => { const p = b.rb.translation(), q = b.rb.rotation(); return { pos: [p.x, p.y, p.z] as Vec3, rot: [q.x, q.y, q.z, q.w] as [number, number, number, number] }; });
  }

  /** 서기 포즈 클립을 기본 목표로 되돌린다 (겟업 취소·실패 뒤: 누움 행동이 서기 포즈 위에서 돈다, v0.5b와 같음) */
  private restoreStandClip(): void {
    this.anim.stop();
    if (this.poses.stand) {
      this.clip = { clip: this.getClip('stand'), t0: this.world.time };
      this.standBlend.start(this.world.time, this.getup.cfg.exec.blendTime, { joints: this.currentJoints(), vel: {} }, { joints: this.clip.clip.sample(0), vel: {} });
    }
  }

  /**
   * 일어서기 (v0.7, docs/ALGORITHMS.md v0.7). 인지 뒤, 목표 포즈 전에 부른다.
   * monitor: 누워 안정되면(설정 지연) 포즈 매칭으로 클립을 골라 GettingUp으로. rising: 균형 복귀·실패 판정. balance: 클립 끝에서 Idle로.
   */
  private getupStep(t: number, per: Perception, hitNow: boolean): void {
    const g = this.getup, gc = g.cfg;
    const { com, vel } = this.rd.com();
    const ground = per.ground;
    // (v0.8a) 평지가 아니면 누움 높이는 COM 아래 지면 기준 (계단에 걸친 발의 지면은 몸과 다른 높이)
    const pw = this.world.physics;
    const lying = [...ground].some((b) => !LIMB_ENDS.has(b)) && com[1] - (pw.flat ? (per.groundHeight ?? 0) : pw.groundHeightAt(com[0], com[2])) < gc.detect.lyingComHeight;
    if (g.phase === 'rising') {
      if (hitNow) {
        // 일어서는 중 피격: 취소하고 행동 계층으로 (취소는 시도로 세지 않는다)
        g.attempts = Math.max(0, g.attempts - 1);
        g.tried.delete(g.run!.item.clip);
        this.endGetup(t, 'Active', `cancel(hit) ${g.run!.item.id}`, 'getupCancel');
        return;
      }
      const run = g.run!;
      const ref = this.anim.ref(t);
      if (!ref || this.anim.clip?.name !== run.item.clip) { this.endGetup(t, 'Ragdoll', 'fail(no clip)', 'getupFail'); return; }
      const tau = this.anim.tau;
      const hip = this.rd.body('Hips').rb.translation();
      const refHip = run.root.apply(t, ref.bodies[0]!);
      const both = per.feet.LeftFoot.contact && per.feet.RightFoot.contact;
      const others = [...ground].some((b) => !isFootBody(b));
      const sq = this.rd.body('Spine2').rb.rotation();
      const tiltDeg = angleBetween(rotate([sq.x, sq.y, sq.z, sq.w], [0, 1, 0]), [0, 1, 0]) * DEG;
      // DCM(포착점)이 두 발 지지 다각형 안 handoverDcmMargin m 안쪽: 넘겨받은 균형 계층이 스텝 없이 받을 수 있는 상태
      const hC = Math.max(0.3, com[1] - (per.groundHeight ?? 0));
      const omg = Math.sqrt(gravityMag / hC);
      const dcmIn = per.supportPolygon.length >= 3 && signedDistanceToPolygon([com[0] + vel[0] / omg, com[2] + vel[2] / omg], per.supportPolygon) <= -gc.balance.handoverDcmMargin;
      // 남은 수평 속도가 작거나(handoverMaxSpeed) DCM이 지지 다각형 안이면 넘긴다. balanceTau + dcmWaitMax가 지나면 그냥
      if ((Math.hypot(vel[0], vel[2]) < gc.balance.handoverMaxSpeed || dcmIn || tau >= run.item.balanceTau + gc.balance.dcmWaitMax) && (tau >= run.item.feetTau - gc.exec.handoverEarly || com[1] - (per.groundHeight ?? 0) >= gc.balance.upComHeight) && both && !others && tiltDeg < gc.exec.handoverTiltDeg && hip.y >= gc.balance.minHipsFrac * refHip.pos[1] && com[1] - (per.groundHeight ?? 0) >= gc.balance.handoverComHeight) {
        // 균형 복귀: 거의 섰다(COM 높이 ≥ handoverComHeight, 두 발, 몸통 섬) → Active + 균형·스텝 계층(v0.4, 서 있는 몸)이 남은 클립 관절 목표를 따른다.
        // 일어선 몸에는 클립과 다른 수평 운동량이 남는다(0.3~0.7 m/s) — 애니 추종 QP는 클립 COM을 쫓다 넘어졌고, 스텝 계층은 한두 걸음으로 받는다.
        // 클립 끝에서 Idle 클립으로 관성화하고, 멈추면 복귀(tryResume)가 Idle 추종에 다시 붙인다
        this.states.name = 'Active';
        this.states.trans = null;
        run.assistAtBalance = g.assistStrength(t, tau);
        g.phase = 'balance';
        run.balanceT = t;
        this.behaviors.fall.reset();
        this.behaviors.braceGuard = { until: t + gc.balance.braceGuardTime, threshold: gc.balance.braceGuardThreshold };
        this.balance.minComHeightOverride = gc.balance.balanceMinComHeight;
        // 서기 COM 높이 = 클립 끝(서 있음) COM 높이 (지면 기준)
        { const c = this.anim.getClip(run.item.clip); this.balance.ensureStandHeight(this.clipComHeight(c)); }
        if (gc.balance.idleAtHandover) {
          // 목표 자세 = Idle (지금 몸에 맞춘 앵커, 지금 관절 자세에서 관성화). 겟업 클립의 남은 발 고쳐 딛기가 스텝 계층과 싸우지 않게
          const bc = gc.balance;
          this.anim.play(bc.idleClip, t, { anchor: this.anchorFor(bc.idleClip, 0), startTime: 0, blendTime: 0 });
          this.anim.blendFromActual(t, this.currentJoints(), {}, bc.idleBlend);
          this.clip = null;
        }
        this.walk.reset();
        this.walk.engaged = false;
        this.handoverT = t;
        const st0 = (['LeftFoot', 'RightFoot'] as const).filter((f) => per.feet[f].contact);
        this.stepping.handover(t, st0.length === 1 ? st0[0]! : null);
        g.last = `balance ${run.item.id} @${(t - run.t0).toFixed(2)}s`;
        this.emit({ t, type: 'getupBalance', detail: `${run.item.id} tau=${tau.toFixed(2)} after ${(t - run.t0).toFixed(2)}s` });
        return;
      }
      run.lowFor = hip.y < refHip.pos[1] - gc.exec.failHipsDrop ? run.lowFor + this.world.dt : 0;
      if (tau > run.item.balanceTau + gc.exec.balanceGrace || run.lowFor >= gc.exec.failHold) {
        const why = run.lowFor >= gc.exec.failHold ? 'low' : 'timeout';
        const last = g.attempts >= gc.exec.maxAttempts;
        this.endGetup(t, last ? 'Active' : 'Ragdoll', `fail(${why}) ${run.item.id}`, last ? 'getupGiveUp' : 'getupFail');
      }
      return;
    }
    if (g.phase === 'balance') {
      const run = g.run!;
      if (lying) { this.balance.minComHeightOverride = null; this.restoreStandClip(); g.phase = 'monitor'; g.run = null; g.last = `fell again ${run.item.id}`; this.emit({ t, type: 'getupFail', detail: `fell again ${run.item.id}` }); return; }
      // 겟업 클립이 끝나 가면 Idle 클립으로 (지금 몸에 맞춘 앵커, 관성화). 걷기 추종은 붙이지 않는다(스텝 계층이 멈추면 tryResume이 붙인다)
      const bc = gc.balance;
      if (this.anim.clip?.name === run.item.clip && this.anim.tau >= this.anim.clip.duration - bc.idleBefore) {
        this.anim.play(bc.idleClip, t, { anchor: this.anchorFor(bc.idleClip, 0), startTime: 0, blendTime: bc.idleBlend });
        this.clip = null;
        this.handoverT = t;
        this.getupIdleHold = true;
      }
      // 완료: Idle 클립에서 스텝 계층이 멈추고 Idle 추종에 다시 붙었을 때 (또는 settleMax초 동안 서 있음)
      // 서기 높이에 가까워지면 균형 끄는 높이 기준을 원래대로
      if (com[1] - (per.groundHeight ?? 0) > 0.8) this.balance.minComHeightOverride = null;
      // 완료: Idle 클립 목표로 스텝 계층이 쉬고 COM이 느리게 settleHold초 (또는 settleMax초)
      const still = this.anim.clip?.name === bc.idleClip && !this.stepping.busy && Math.hypot(vel[0], vel[2]) < bc.settleSpeed;
      run.stillFor = still ? (run.stillFor ?? 0) + this.world.dt : 0;
      // 상처가 깊어(피해 누적) 일어선 뒤 무릎을 꿇으면 그것으로 끝 (Kneel이 자세를 맡는다)
      const kneel = this.behaviors.list.some((b) => b.name === 'Kneel' && b.stopT === null);
      if (kneel || run.stillFor >= bc.settleHold || t - run.balanceT! >= gc.balance.settleMax) {
        this.balance.minComHeightOverride = null;
        g.phase = 'monitor';
        g.last = `done ${run.item.id} ${(t - run.t0).toFixed(2)}s`;
        this.emit({ t, type: 'getupDone', detail: `${run.item.id} ${(t - run.t0).toFixed(2)}s attempt ${g.attempts}` });
        g.run = null;
        g.resetEpisode();
      }
      return;
    }
    // monitor
    // (v0.8a) 겟업 라이브러리는 평지 클립이다: 몸 아래 지면이 평평하지 않으면(계단·경사) 일어서지 않는다 (README 결정)
    const blocked = this.exploded || (this.behaviors.dead && !g.probe) || this.stateName === 'Animated' || t < this.reactUntil || (!pw.flat && !this.flatAround(com));
    const start = g.shouldStart(t, lying && !blocked, length(vel), this.behaviors.lowerCap < 1);
    if (!start) return;
    const tf = this.bodyTransforms();
    const feat = poseFeature(this.def, tf);
    if (g.probe) {
      if (!g.ready) { g.ready = { t, transforms: tf }; this.emit({ t, type: 'getupReady', detail: classifyFeature(feat) }); }
      return;
    }
    const m = this.getupLib.best(feat, gc.match, g.tried, g.only);
    if (!m) return;
    // 정렬: 클립 공간 → 월드. yaw = −ψ (ψ는 지금 → 클립), 클립 0프레임 Hips xz를 지금 Hips xz에, 높이는 지면
    const yaw = -m.yaw;
    const c0 = m.item.frame0[0]!.pos;
    const r0 = rotate(fromAxisAngle([0, 1, 0], yaw), [c0[0], 0, c0[2]]);
    const hp = tf[0]!.pos;
    const anchor: Xform = { yaw, pos: [hp[0] - r0[0], per.groundHeight ?? 0, hp[2] - r0[2]] };
    this.behaviors.clearForGetup();
    for (const e of this.behaviors.events) this.emit({ t, type: e.type, detail: e.detail });
    this.behaviors.events = [];
    this.clip = null;
    this.anim.play(m.item.clip, t, { anchor, startTime: 0, blendTime: 0 });
    this.anim.rate = gc.exec.rate;
    this.anim.blendFromActual(t, this.currentJoints(), {}, gc.exec.blendTime);
    const ref0 = this.anim.ref(t)!;
    const root = new RootBlend();
    root.start(t, gc.exec.blendTime, tf[0]!, { pos: ref0.bodies[0]!.pos, rot: ref0.bodies[0]!.rot });
    g.attempts++;
    g.tried.add(m.item.clip);
    const posture = classifyFeature(feat);
    g.run = { item: m.item, t0: t, cost: m.cost, yaw, posture, root, lowFor: 0, balanceT: null };
    g.phase = 'rising';
    this.getupQP.reset();
    g.settledSince = null;
    this.states.name = 'GettingUp';
    this.states.trans = null;
    this.walk.reset();
    this.walk.engaged = false;
    g.last = `start ${m.item.id} (${POSTURE_KO[posture]}, 비용 ${m.cost.toFixed(2)})`;
    this.emit({ t, type: 'getupStart', detail: `${m.item.id} ${posture} cost=${m.cost.toFixed(3)} attempt ${g.attempts}` });
  }

  /** (v0.8a) COM 둘레(getup.terrain.radius m 십자 5점) 지면 높이 차가 getup.terrain.maxStep m 이하이고 경사가 없으면 평평 */
  private flatAround(c: Readonly<Vec3>): boolean {
    const pw = this.world.physics, tc = this.getup.cfg.terrain ?? { radius: 0.8, maxStep: 0.03 };
    if (pw.terrainDef.slopeDeg !== 0) return false;
    const r = tc.radius;
    const hs = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].map(([dx, dz]) => pw.groundHeightAt(c[0] + dx!, c[2] + dz!));
    return Math.max(...hs) - Math.min(...hs) <= tc.maxStep;
  }

  /** 클립 마지막 프레임(서 있음)의 COM 높이 (클립 공간, 지면 맞춤 = 지면 위 높이) */
  private clipComHeight(c: AnimClip): number {
    const fk = c.fk[c.n - 1]!, mm = this.anim.mass;
    let y = 0, M = 0;
    fk.forEach((b, i) => { y += (b.pos[1] + rotate(b.rot, mm.localCom[i]!)[1]) * mm.mass[i]!; M += mm.mass[i]!; });
    return y / M;
  }

  /** 겟업을 끝낸다 (실패·취소): 상태를 바꾸고 클립·보조를 멈춘다. 다음 시도는 retryDelay 뒤 */
  private endGetup(t: number, state: StateName, why: string, ev: CharacterEvent): void {
    const g = this.getup;
    this.states.name = state;
    this.states.trans = null;
    this.restoreStandClip();
    this.getupAssist.set(0, null);
    g.phase = 'monitor';
    g.run = null;
    g.settledSince = null;
    g.notBefore = t + g.cfg.detect.retryDelay;
    g.last = why;
    this.emit({ t, type: ev, detail: `${why} attempt ${g.attempts}` });
  }

  totalMass(): number {
    return this.rd.totalMass();
  }

  // ── 외부 자극 ──
  /**
   * 피격 (SPEC 7.2, v0.5a hitModel). 다음 스텝 시작에 hitModel이 종류별로 충격량 J = 총질량 × Δv × 방향을 나눠 가하고(합은 J),
   * 상처를 맞은 바디 로컬로 저장하고, 행동(HitReaction·HoldWound·InjuredLeg·Stagger)을 켠다. magnitude가 없으면 종류별 기본값.
   */
  hit(h: HitInfo): void {
    if (h.type === 'explosion' && !h.point) throw new Error('explosion hit needs point (blast center)');
    const def = h.type === 'bullet' ? this.hitModel.bullet.defaultMagnitude : h.type === 'melee' ? this.hitModel.melee.defaultMagnitude : undefined;
    const dv = h.magnitude === undefined && def !== undefined ? def : resolveMagnitude(h.magnitude);
    this.pending.push({ hit: { ...h, dv } });
  }

  applyImpulse(body: BodyName, impulse: Vec3, worldPoint?: Vec3): void {
    this.pending.push({ body, impulse, point: worldPoint });
  }

  /** 시선 대상 (SPEC 7.2). null이면 끈다 */
  lookAt(target: Vec3 | null): void {
    this.behaviors.trigger('LookAt', { target }, this.world.time);
    this.emit({ t: this.world.time, type: 'lookAt', detail: target ? target.map((x) => x.toFixed(2)).join(',') : 'null' });
  }

  /**
   * 상태 바꾸기 (SPEC 7.2, v0.6 상태 머신). Animated ↔ Active는 states.ts 규칙대로 바디를 키네마틱/동적으로 바꾸고,
   * Animated → Active는 애니 중앙 차분 속도를 넘긴다(튐 없음). hit = 피격으로 바뀜(핀 없이, 짧은 표시 블렌드)
   */
  setState(s: StateName, opts: { hit?: boolean } = {}): void {
    const t = this.world.time;
    const act = this.states.request(s, t, { hit: opts.hit, hasAnim: !!this.anim.clip });
    if (act === 'kinematic') this.setBodiesKinematic(true);
    else if (act === 'dynamic') this.setBodiesKinematic(false, opts.hit);
    this.emit({ t, type: 'setState', detail: `${s}${opts.hit ? ' (hit)' : ''}` });
  }

  /**
   * 바디를 키네마틱(애니가 위치를 정함) 또는 동적으로. 동적으로 바꿀 때 애니 중앙 차분 속도를 넘긴다:
   * 질량 중심 속도 = 바디 원점 속도 + ω × (R·로컬 질량 중심). 넘긴 속도와 직전 키네마틱 속도의 차이를 지표로 남긴다
   */
  private setBodiesKinematic(kin: boolean, hit = false): void {
    const t = this.world.time;
    if (kin) {
      for (const b of this.rd.bodies) b.rb.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
      return;
    }
    const ref = this.anim.clip ? this.anim.ref(t) : null;
    let jl = 0, ja = 0;
    this.rd.bodies.forEach((b, i) => {
      const lv0 = b.rb.linvel(), av0 = b.rb.angvel();
      b.rb.setBodyType(R.RigidBodyType.Dynamic, true);
      if (!ref) return;
      const q = b.rb.rotation(), lc = b.rb.localCom();
      const w = ref.bodyAng[i]!;
      const r = rotate([q.x, q.y, q.z, q.w], [lc.x, lc.y, lc.z]);
      const v = add(ref.bodyLin[i]!, [w[1] * r[2] - w[2] * r[1], w[2] * r[0] - w[0] * r[2], w[0] * r[1] - w[1] * r[0]]);
      b.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
      b.rb.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
      jl = Math.max(jl, Math.hypot(v[0] - lv0.x, v[1] - lv0.y, v[2] - lv0.z));
      ja = Math.max(ja, Math.hypot(w[0] - av0.x, w[1] - av0.y, w[2] - av0.z));
    });
    this.switchJump = { t, lin: jl, ang: ja, hit };
    // 걷기 추종은 새로 시작 (앵커는 그대로: 키네마틱 재생과 같은 기준). (결정 land-5) 전환 뒤 상태 기반 위상
    this.walk.reset();
    if (hit) this.walk.noteDisturbance(t);
    this.walk.engaged = true;
  }

  /** 지금 몸에 맞춘 클립 앵커: yaw = 골반 정면, xz = 클립 tau의 두 발 중점 ↔ 실제 두 발 중점, y = 지면 */
  private anchorFor(clipName: string, tau: number, yawOverride?: number): Xform {
    const hq = this.rd.body('Hips').rb.rotation();
    const yaw = yawOverride ?? yawOfQ([hq.x, hq.y, hq.z, hq.w]);
    const clip = this.anim.getClip(clipName);
    const p = clip.poseAt(tau);
    const fk = forwardKinematics(this.def, p.joints, p.root);
    const cm = scale(add(fk[clip.footIdx.LeftFoot]!.pos, fk[clip.footIdx.RightFoot]!.pos), 0.5);
    const lf = this.rd.body('LeftFoot').rb.translation(), rf = this.rd.body('RightFoot').rb.translation();
    const am: Vec3 = [(lf.x + rf.x) / 2, 0, (lf.z + rf.z) / 2];
    const rc = rotate(fromAxisAngle([0, 1, 0], yaw), [cm[0], 0, cm[2]]);
    const gy = this.perception().groundHeight ?? 0;
    return { yaw, pos: [am[0] - rc[0], gy, am[2] - rc[2]] };
  }

  private getClip(name: string): PoseClip {
    const f = this.poses[name];
    if (!f) throw new Error(`unknown pose/clip '${name}' (known: ${Object.keys(this.poses).join(', ')})`);
    return new PoseClip(f, this.poses);
  }

  /** 근육 목표 클립 재생 (SPEC 7.2). v0.2: 블렌드 없음, 다음 스텝부터 새 목표. 루프 여부는 클립 파일을 따른다 */
  playClip(clip: string, opts: { startTime?: number; blendIn?: number } = {}): void {
    if (this.animLib[clip]) {
      // v0.6 애니 클립: 지금 몸에 맞춘 앵커로 재생, 관성화로 이어 붙임. 걷기 추종 새로 시작
      this.getupIdleHold = false;
      const tau = opts.startTime ?? 0;
      this.anim.play(clip, this.world.time, { anchor: this.anchorFor(clip, tau), startTime: tau, blendTime: opts.blendIn });
      this.clip = null;
      this.walk.reset();
      this.walk.engaged = true;
      return;
    }
    this.anim.stop();
    this.clip = { clip: this.getClip(clip), t0: this.world.time - (opts.startTime ?? 0) };
  }

  /** 영역 근육 강도 배율 (SPEC 7.2). recoverTime(초)을 주면 그동안 1로 선형 회복 */
  setMuscleScale(region: string, scale: number, recoverTime?: number): void {
    this.muscles.setScale(region, scale, this.world.time, recoverTime);
    const rec = recoverTime ? ` recover ${recoverTime}s` : '';
    this.emit({ t: this.world.time, type: 'setMuscleScale', detail: `${region}=${scale}${rec}` });
  }

  /** 행동 트리거 (SPEC 7.2). LiftFoot(셋업, 스텝 계층) 또는 행동 계층 행동 (params가 behaviors.json 기본값을 덮는다) */
  trigger(behavior: string, params: Record<string, unknown> = {}): void {
    if (behavior === 'LiftFoot') {
      const foot = (params.foot ?? 'RightFoot') as FootName;
      if (foot !== 'LeftFoot' && foot !== 'RightFoot') throw new Error(`LiftFoot: bad foot '${String(foot)}'`);
      this.stepping.liftFoot(foot, params.height as number | undefined, params.duration as number | undefined);
    } else this.behaviors.trigger(behavior, params, this.world.time);
    this.emit({ t: this.world.time, type: 'trigger', detail: `${behavior} ${JSON.stringify(params)}` });
  }

  /** 스텝 계층 켜기·끄기 (v0.4) */
  setStepping(on: boolean): void {
    this.stepping.enabled = on;
  }

  /** 균형 계층 켜기·끄기 (v0.3) */
  setBalance(on: boolean): void {
    this.balance.enabled = on;
    this.emit({ t: this.world.time, type: 'setBalance', detail: `balance=${on}` });
  }

  /** 인지 (7.1의 2단계): 접촉·지면·지지 다각형. 물리 스텝마다 한 번 계산한다 */
  perception(): Perception {
    const step = this.world.physics.steps;
    if (this.perCache && this.perCache.step === step) return this.perCache.per;
    const bc = this.balance.cfg.perception;
    const per = perceive(this.rd, this.world.physics, { groundContactDist: judge.groundContactDist, soleContactDist: bc.soleContactDist, rayLength: bc.rayLength, kneeContactDist: judge.kneeContactDist });
    this.perCache = { step, per };
    return per;
  }

  /** 명시적 보조 켜기·끄기 (v0.2: 루트 보조) */
  setAssist(a: { root?: boolean }): void {
    if (a.root !== undefined) this.rootAssist.enabled = a.root;
    this.emit({ t: this.world.time, type: 'setAssist', detail: `root=${this.rootAssist.enabled}` });
  }

  /** 이벤트 듣기 (SPEC 7.2, docs/API.md 4장). 리스너는 직렬화하지 않는다 — 복원 뒤 다시 등록한다 */
  on(ev: CharacterEvent, cb: (e: SimEvent) => void): void {
    const l = this.listeners.get(ev) ?? [];
    l.push(cb);
    this.listeners.set(ev, l);
  }

  /** (v0.9) 이벤트 그만 듣기 */
  off(ev: CharacterEvent, cb: (e: SimEvent) => void): void {
    const l = this.listeners.get(ev);
    if (!l) return;
    const i = l.indexOf(cb);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) this.listeners.delete(ev);
  }

  private emit(e: SimEvent): void {
    if (this.name !== undefined) e = { ...e, char: this.name };
    this.world.events.push(e);
    for (const cb of this.listeners.get(e.type as CharacterEvent) ?? []) cb(e);
    // (game-1) 걷기 추종을 놓음·일어섬 → 복귀 가능 판정 무장
    if (e.type === 'walkHandover' || e.type === 'getupDone') this.recovery.armed = true;
    // (v0.9) SPEC 7.2 이름 gotUp = 일어서기 성공 (getupDone과 같은 순간, 알림 전용)
    if (e.type === 'getupDone') this.notify({ ...e, type: 'gotUp' });
  }

  /** (v0.9) 알림 전용: 리스너에만 보낸다 (world.events·로그는 그대로) */
  private notify(e: SimEvent): void {
    const l = this.listeners.get(e.type as CharacterEvent);
    if (!l) return;
    if (this.name !== undefined) e = { ...e, char: this.name };
    for (const cb of [...l]) cb(e);
  }

  /**
   * @internal (v0.9) World.step 끝(접촉 감지 뒤): fell·grabbed·released 알림. 듣는 사람이 없으면 아무것도 계산하지 않는다(시뮬레이션·로그 그대로).
   * fell = 자세가 down이 됨(SPEC 8.2), 다시 standing이 될 때까지 한 번. grabbed·released = 손이 잡기 관절을 만들거나 놓음
   */
  _notifyEvents(): void {
    const t = this.world.time;
    const ns = this.notifyState;
    // (game-1) 복귀 가능 시점: 듣는 사람이 있거나 'recovered'를 기다리는 복귀가 있을 때만 판정한다 (없으면 시뮬레이션·로그 그대로)
    const waiting = this.ret?.phase === 'wait' && this.ret.when === 'recovered';
    if (this.listeners.has('recovered') || waiting) {
      this.evalRecovery(t);
      const rc = this.recovery;
      if (rc.ok && rc.armed) { rc.armed = false; this.notify({ t, type: 'recovered', detail: this.anim.clip && this.walk.engaged ? `walking ${this.anim.clip.name}` : 'standing' }); }
      if (this.ret && waiting) { this.ret.blockedBy = rc.blockedBy; if (rc.ok) this.ret.go = true; }
    }
    if (this.listeners.has('fell')) {
      const s = this.getState();
      if (s.posture === 'down' && !ns.down) {
        ns.down = true;
        this.notify({ t, type: 'fell', detail: [...new Set(s.contacts.map((c) => c.body))].join(',') });
      } else if (s.posture === 'standing') ns.down = false;
    }
    if (this.listeners.has('grabbed') || this.listeners.has('released')) {
      const now: Partial<Record<HandName, true>> = {};
      for (const g of this.behaviors.holding) {
        now[g.hand] = true;
        if (!ns.holding[g.hand]) this.notify({ t, type: 'grabbed', body: g.hand, ...(g.anchor ? { point: [...g.anchor] as Vec3 } : {}), detail: `${g.hand} ${g.kind}` });
      }
      for (const h of Object.keys(ns.holding) as HandName[]) if (!now[h]) this.notify({ t, type: 'released', body: h, detail: h });
      ns.holding = now;
    }
  }

  /**
   * (v0.9) 이번 스텝 레퍼런스: 레퍼런스 생성(클립 → 반응 스타일 → 행동 편집)이 추종기(전신 QP + 근육)에 넘긴 것 (src/sim/tracker.ts, README 결정 164·9a-3).
   * 첫 스텝 전에는 null
   */
  reference(): ReferenceFrame | null {
    return this.lastRef;
  }

  /**
   * (app-2) 애니 강제 비율 (PuppetMaster 핀 가중치): 0~1. 바디를 애니 레퍼런스(클립 기준 자세, 없으면 서기 포즈) 쪽으로 핀 보조 힘으로 끈다.
   * 피격 반응·비틀거림·넘어짐 중에도 건다 — 사람이 일부러 켜는 시연·실험용 오버라이드(기본 0, 시나리오 이벤트로는 못 쓴다). 사용량 = getState().assist.animOverride
   */
  setAnimOverride(weight: number): void {
    const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
    if (w > 0 && !this.animOverridePin) {
      const oc = this.animCfg.animOverride ?? { default: 0, mode: 'full' as const, fallbackPose: 'stand' };
      this.animOverridePin = new PinAssist(this.rd, { ...this.animCfg.pin, enabled: true, mode: oc.mode }, this.pin.mass);
    }
    if (w === this.animOverrideW) return;
    this.animOverrideW = w;
    this.emit({ t: this.world.time, type: 'setAnimOverride', detail: `w=${w.toFixed(2)}` });
  }

  /** (app-2) 애니 강제 비율 */
  getAnimOverride(): number {
    return this.animOverrideW;
  }

  // ── 게임 애니 복귀 (README 결정 game-1, docs/API.md '게임에 넣기', config/game.json) ──
  /**
   * 반응이 끝난 몸을 게임 애니(키네마틱 Animated)로 돌려준다. clip = 애니 클립 이름(Kimodo 등, 게임이 이어서 재생할 것).
   * when 'recovered'(기본)이면 복귀 가능 시점('recovered')까지 기다렸다가, 'now'면 다음 스텝에 시작한다.
   * 전환: 클립을 지금 몸에 맞춰(앵커·위상) 재생하고 출력을 지금 자세에서 관성화 → 핀 블렌드(pinFrac × blendTime, assist.pin) → 키네마틱 + 남은 차이 관성화.
   * 전환 중 맞으면 취소하고 반응한다(when 'recovered'면 다시 기다린다). 돌려주는 값: 받아들였는가 (폭발·사망이면 false)
   */
  returnToAnimation(clip: string, opts: ReturnOpts = {}): boolean {
    if (!this.animLib[clip]) throw new Error(`returnToAnimation: unknown anim clip '${clip}'`);
    const t = this.world.time;
    if (this.exploded || this.behaviors.dead) return false;
    const rc = GAME.returnToAnim;
    const bt = Math.max(0, opts.blendTime ?? rc.blendTime);
    const when = opts.when ?? 'recovered';
    this.ret = { phase: 'wait', clip, requestT: t, startT: null, kinT: null, blendTime: bt, pinTime: bt * rc.pinFrac, residualPos: 0, residualDeg: 0, blockedBy: '', when, go: when === 'now', ...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}), ...(opts.yaw !== undefined ? { yaw: opts.yaw } : {}) };
    this.recovery.since = null;
    this.emit({ t, type: 'returnStart', detail: `${clip} when=${when} blend=${bt.toFixed(2)}` });
    // 이미 게임 애니(이번 스텝에 들어온 피격이 없을 때): 새 클립을 지금 출력에서 관성화로 이어 재생한다.
    // 피격이 대기 중이면 다음 스텝에 Active로 바뀌므로 반응 뒤 복귀로 기다린다
    if (this.stateName === 'Animated' && !this.pending.length) {
      const tau = opts.startTime ?? 0;
      this.anim.play(clip, t, { anchor: this.anchorFor(clip, tau, opts.yaw), startTime: tau, blendTime: bt });
      this.ret.phase = 'done'; this.ret.startT = t; this.ret.kinT = t;
      this.emit({ t, type: 'returnDone', detail: `${clip} (already Animated)` });
    }
    return true;
  }

  /** (game-1) 기다리는·진행 중인 복귀를 취소한다 (핀 블렌드 중이면 Active로 남는다) */
  cancelReturn(): void {
    const r = this.ret;
    if (!r || r.phase === 'done' || r.phase === 'cancel') return;
    if (r.phase === 'pin' && this.states.trans?.to === 'Animated') this.states.trans = null;
    r.phase = 'cancel';
    this.emit({ t: this.world.time, type: 'returnCancel', detail: 'api' });
  }

  /**
   * (game-1) 복귀 가능 판정 (config/game.json recovered): recovered = 조건이 holdTime초 이어짐, blockedBy = 막는 이유('' = 지금 조건 만족).
   * 'recovered' 이벤트와 같은 판정이다. 한 스텝에 한 번 계산한다
   */
  recoveryStatus(): { recovered: boolean; blockedBy: string } {
    this.evalRecovery(this.world.time);
    return { recovered: this.recovery.ok, blockedBy: this.recovery.blockedBy };
  }

  /** (game-1) 지금 게임 애니로 돌려받아도 되는가 (= recoveryStatus().recovered) */
  canReturnToAnimation(): boolean {
    return this.recoveryStatus().recovered;
  }

  /** (game-1) 복귀 가능 조건 판정 (스텝 끝, 같은 스텝이면 다시 하지 않음) */
  private evalRecovery(t: number): void {
    const step = this.world.physics.steps;
    const rc = this.recovery;
    if (rc.step === step) return;
    rc.step = step;
    const R = GAME.recovered;
    const s = this.getState();
    let why = '';
    if (this.stateName !== 'Active') why = `state ${this.stateName}`;
    else if (this.exploded || this.behaviors.dead) why = 'dead';
    else if (this.getup.phase !== 'monitor') why = 'getup';
    else if (s.posture !== 'standing') why = `posture ${s.posture}`;
    else if (t < this.reactUntil) why = 'react';
    else if (this.reaction.active) why = 'reaction';
    else {
      // 켜져 있거나 아직 꺼져 가는 행동 (핀 블렌드 중 '반응 중 핀 0' 지표와 같은 기준)
      const b = this.behaviors.state.active.find((x) => x.weight > 0.01 && !R.allowBehaviors.includes(x.name)) ?? this.behaviors.list.find((x) => x.stopT === null && !R.allowBehaviors.includes(x.name));
      if (b) why = `behavior ${b.name}`;
      else if (this.stepping.busy) why = 'stepping';
      else {
        const c = this.anim.clip;
        const walking = !!c && c.loop && this.walk.engaged && !this.isReactionClip(c.name);
        if (walking) {
          const e = this.walk.state.dcmError;
          if (Math.hypot(e[0], e[1]) > R.walkDcmError) why = 'walk dcm';
        } else if (c && this.walk.engaged && !c.loop) why = `clip ${c.name}`;
        else if (Math.hypot(s.comVel[0], s.comVel[2]) > R.standSpeed) why = 'moving';
        else if (s.stance !== 'double') why = 'feet';
        else if ((this.balance.state.cpMargin ?? 0) < R.standCpMargin) why = 'margin';
      }
    }
    rc.blockedBy = why;
    if (why) { rc.since = null; rc.ok = false; return; }
    rc.since ??= t;
    rc.ok = t - rc.since >= R.holdTime - 1e-9;
  }

  /** (game-1) 키네마틱으로 바꾸고 남은 차이(물리 자세 ↔ 애니 출력)를 관성화로 지운다 */
  private enterKinematic(t: number, viaPin: boolean): void {
    const r = this.ret!;
    if (!viaPin) {
      this.states.lastSwitch = { t, from: this.states.name, to: 'Animated', hit: false };
      this.states.name = 'Animated';
      this.states.trans = null;
    }
    this.setBodiesKinematic(true);
    // 남은 차이 (로그): 애니 출력 바디 vs 지금 물리 바디
    const out = this.anim.bodiesAt(t, this.anim.tau);
    let dp = 0, dq = 0, worstP = '', worstQ = '';
    this.rd.bodies.forEach((b, i) => {
      const p = b.rb.translation(), q = b.rb.rotation(), o = out[i]!;
      const ep = Math.hypot(p.x - o.pos[0], p.y - o.pos[1], p.z - o.pos[2]), eq = angleBetweenQ([q.x, q.y, q.z, q.w], o.rot) * DEG;
      if (ep > dp) { dp = ep; worstP = b.name; }
      if (eq > dq) { dq = eq; worstQ = b.name; }
    });
    r.residualPos = dp; r.residualDeg = dq;
    const hips = this.rd.body('Hips').rb;
    const hp = hips.translation(), hq = hips.rotation(), hv = hips.linvel(), hw = hips.angvel();
    // 재생 속도는 원래대로 (걷기 추종이 위상을 맞추려 바꿔 둔 것) — 속도 차이도 관성화가 받는다
    this.anim.rate = 1;
    this.anim.blendFromBody(t, { joints: this.currentJoints(), vel: this.currentJointVel(), root: { pos: [hp.x, hp.y, hp.z], rot: [hq.x, hq.y, hq.z, hq.w] }, rootVel: { lin: [hv.x, hv.y, hv.z], ang: [hw.x, hw.y, hw.z] } }, Math.max(GAME.returnToAnim.minKinematicBlend, r.blendTime - (viaPin ? r.pinTime : 0)));
    this.stepping.handover(t, null);
    this.recovery.armed = false;
    r.phase = 'kinematic';
    r.kinT = t;
    this.emit({ t, type: 'setState', detail: `Animated (return ${r.clip}, residual ${(dp * 100).toFixed(1)}cm ${worstP} ${dq.toFixed(1)}° ${worstQ})` });
  }

  /** (game-1) 복귀 시작: 클립을 지금 몸에 맞춰 재생, 출력을 지금 자세에서 관성화, 핀 블렌드 또는 바로 키네마틱 */
  private startReturn(t: number): void {
    const r = this.ret!;
    r.go = false;
    if (this.stateName === 'GettingUp' || this.exploded || this.behaviors.dead) { r.phase = r.when === 'recovered' ? 'wait' : 'cancel'; return; }
    const per = this.perception();
    const cur = this.anim.clip;
    const same = !!cur && cur.name === r.clip && this.stateName === 'Active' && this.walk.engaged && r.startTime === undefined && r.yaw === undefined;
    const joints = this.currentJoints();
    const jointVel = this.currentJointVel();
    if (!same) {
      const clip = this.anim.getClip(r.clip);
      const hq = this.rd.body('Hips').rb.rotation();
      const yaw = r.yaw ?? yawOfQ([hq.x, hq.y, hq.z, hq.w]);
      const fp = (n: FootName): Vec3 => { const p = this.rd.body(n).rb.translation(); return [p.x, p.y, p.z]; };
      const tau = r.startTime ?? (clip.loop ? this.anim.matchPhase(r.clip, { contact: { LeftFoot: per.feet.LeftFoot.contact, RightFoot: per.feet.RightFoot.contact }, footPos: { LeftFoot: fp('LeftFoot'), RightFoot: fp('RightFoot') }, joints, comVel: this.rd.com().vel, yaw }).tau : 0);
      this.anim.play(r.clip, t, { anchor: this.anchorFor(r.clip, tau, r.yaw), startTime: tau, blendTime: 0 });
      this.clip = null;
      this.getupIdleHold = false;
      this.resumeTo = null;
      this.handoverT = null;
      if (this.stateName === 'Active') { this.walk.reset(); this.walk.engaged = true; }
    }
    // 애니 출력(관절 + 루트)을 지금 몸 자세에서 시작해 blendTime초에 클립으로 관성화: 핀이 끄는 목표가 지금 자세에서 출발한다(당김 튐 없음)
    {
      const hips = this.rd.body('Hips').rb;
      const hp = hips.translation(), hr = hips.rotation(), hv = hips.linvel(), hw = hips.angvel();
      this.anim.blendFromBody(t, { joints, vel: jointVel, root: { pos: [hp.x, hp.y, hp.z], rot: [hr.x, hr.y, hr.z, hr.w] }, rootVel: { lin: [hv.x, hv.y, hv.z], ang: [hw.x, hw.y, hw.z] } }, r.blendTime);
    }
    r.startT = t;
    const reacting = t < this.reactUntil || this.reaction.active || this.behaviors.state.active.some((b) => b.name !== 'LookAt' && b.weight > 0.01);
    if (this.stateName === 'Active' && r.pinTime > 0 && !reacting && this.animCfg.pin.enabled) {
      // 핀 블렌드 (SPEC v0.6 허용 범위: Animated ↔ Active 전환 블렌드). 끝나면 states.update가 키네마틱으로 → enterKinematic
      this.states.request('Animated', t, { hasAnim: true });
      if (this.states.trans) { this.states.trans.pinTime = r.pinTime; this.states.trans.renderTime = r.pinTime; }
      r.phase = 'pin';
    } else this.enterKinematic(t, false);
  }

  /** (game-1) 매 스텝 (입력 처리 뒤): 전환 중 피격이면 취소, 시작 신호면 시작 */
  private returnStep(t: number, hitNow: boolean): void {
    const r = this.ret!;
    if (hitNow && (r.phase === 'pin' || r.phase === 'kinematic')) {
      if (r.phase === 'pin' && this.states.trans?.to === 'Animated') this.states.trans = null;
      r.phase = r.when === 'recovered' ? 'wait' : 'cancel';
      this.emit({ t, type: 'returnCancel', detail: `hit (${r.when === 'recovered' ? 'wait again' : 'cancel'})` });
      return;
    }
    if (r.phase === 'kinematic' && r.kinT !== null && t - r.kinT >= Math.max(GAME.returnToAnim.minKinematicBlend, r.blendTime - r.pinTime) - 1e-9) {
      r.phase = 'done';
      this.emit({ t, type: 'returnDone', detail: `${r.clip} ${(t - r.requestT).toFixed(2)}s` });
    }
    if (r.phase === 'wait' && r.go) this.startReturn(t);
  }

  /** (game-3) 피격마다 반응 변주를 뽑는다 (변주를 끄면 아무것도 안 함). 순서 고정: 클립 고르기, 팔 세기, 지연, 다리 선호 */
  private drawVariation(): void {
    const r = this.varRng;
    if (!r) return;
    const v = GAME.variation;
    const clipU = r.float();
    const arm = 1 + v.armScale * (2 * r.float() - 1);
    const delay = v.delayJitter * (2 * r.float() - 1);
    const legBias = v.legBias * (2 * r.float() - 1);
    this.variation = { n: (this.variation?.n ?? 0) + 1, clipU, arm, delay, legBias };
    this.stepping.varBias = { LeftFoot: legBias, RightFoot: -legBias };
  }

  /** (game-3) 마지막 피격에 뽑은 반응 변주 (변주를 끄거나 아직 맞지 않았으면 null) */
  reactionVariation(): { n: number; clipU: number; arm: number; delay: number; legBias: number } | null {
    return this.variation ? { ...this.variation } : null;
  }

  /** (app-2) 애니 강제 레퍼런스: 클립 기준 자세(Animated 아님) 또는 서기 포즈를 지금 엉덩이 수평 위치·방향에 세운 자세 (속도 0) */
  private animOverrideRef(t: number, ref: AnimRef | null): AnimRef | null {
    if (this.stateName === 'Animated') return null;
    if (ref) { this.animOverrideSource = 'clip'; return ref; }
    this.animOverrideSource = 'pose';
    const oc = this.animCfg.animOverride;
    if (!this.animOverridePose) this.animOverridePose = this.getClip(oc?.fallbackPose ?? 'stand');
    const targets = this.animOverridePose.sample(t);
    const hips = this.rd.bodies[0]!.rb;
    const hp = hips.translation(), hq = hips.rotation();
    const yaw = yawOfQ(multiplyQ([hq.x, hq.y, hq.z, hq.w], conjugateQ(this.def.bodies[0]!.restRotation)));
    const root = { pos: [hp.x, 0, hp.z] as Vec3, rot: fromAxisAngle([0, 1, 0], yaw) };
    const tf = forwardKinematics(this.def, targets, root);
    const actual = this.rd.bodies.map((b) => { const p = b.rb.translation(), q = b.rb.rotation(); return { pos: [p.x, p.y, p.z] as Vec3, rot: [q.x, q.y, q.z, q.w] as [number, number, number, number] }; });
    const dy = lowestFootY(this.def, actual) - lowestFootY(this.def, tf);
    const bodies = tf.map((x) => ({ pos: [x.pos[0], x.pos[1] + dy, x.pos[2]] as Vec3, rot: x.rot }));
    const zero = bodies.map(() => [0, 0, 0] as Vec3);
    return { bodies, bodyLin: zero, bodyAng: zero.map(() => [0, 0, 0] as Vec3) } as unknown as AnimRef;
  }

  /** (v0.9) 루트 보조가 켜져 있는가 */
  getAssist(): { root: boolean } {
    return { root: this.rootAssist.enabled };
  }

  /** (v0.9) 근육 이득 런타임 교체 (튜닝 UI). 강도·영역 배율·피로 상태는 그대로 */
  setMuscleConfig(cfg: MuscleConfig): void {
    this.muscles.reconfigure(cfg);
  }

  /** (v0.9) 관절별 근육 이득 (kp·kd·최대 토크) */
  muscleGains(): { joint: JointName; kp: number; kd: number; maxTorque: number }[] {
    return this.muscles.gains();
  }

  /** (v0.9) 근육이 있는 관절 이름 (def 순서) */
  muscleJoints(): JointName[] {
    return this.muscles.joints.map((m) => m.name);
  }

  /** (v0.9) 여러 영역·관절 강도를 한 번에 (튜닝 UI 슬라이더). 회복 없음, 이벤트는 하나만 남긴다 */
  setMuscleScales(scales: Readonly<Record<string, number>>): void {
    const t = this.world.time;
    for (const [r, v] of Object.entries(scales)) this.muscles.setScale(r, v, t);
    this.emit({ t, type: 'setMuscleScale', detail: Object.entries(scales).map(([r, v]) => `${r}=${v}`).join(' ') });
  }

  // ── 스텝 (World.step이 부른다) ──
  /** 7.1의 1~7단계 */
  _preStep(): void {
    // 1. 입력 이벤트
    const t = this.world.time;
    // (v0.6) 키네마틱 재생 중 피격·충격 → 먼저 Active로 (애니 속도를 넘겨 튐 없이, 반응 중이라 핀 없음)
    if (this.pending.length && this.states.name === 'Animated') this.setState('Active', { hit: true });
    if (this.pending.length) this.reactUntil = Math.max(this.reactUntil, t + this.animCfg.resume.reactHold);
    this.behaviors.walking = !!this.anim.clip && this.walk.engaged;
    const applyJ = (body: BodyName, Jv: Vec3, pt: Vec3 | undefined): Vec3 => {
      const rb = this.rd.body(body).rb;
      const J = { x: Jv[0], y: Jv[1], z: Jv[2] };
      this.balance.noteExternalImpulse(Jv);
      if (pt) { rb.applyImpulseAtPoint(J, { x: pt[0], y: pt[1], z: pt[2] }, true); return pt; }
      const c = rb.worldCom();
      rb.applyImpulse(J, true);
      return [c.x, c.y, c.z];
    };
    // 나눠 가하는 충격의 나머지 (push duration)
    let pushJ: Vec3 = [0, 0, 0], pushLeft = 0;
    for (const o of this.ongoing) {
      const rb = this.rd.body(o.body).rb, tr = rb.translation(), q = rb.rotation();
      const Jk = o.w ? scale(o.J, o.w[o.w.length - o.left] ?? 0) : o.J;
      applyJ(o.body, Jk, o.local ? add([tr.x, tr.y, tr.z], rotate([q.x, q.y, q.z, q.w], o.local)) : undefined);
      pushJ = add(pushJ, Jk);
      o.left--;
      pushLeft = Math.max(pushLeft, o.left);
    }
    this.ongoing = this.ongoing.filter((o) => o.left > 0);
    for (const p of this.pending) {
      if (p.sensed && p.hit) {
        // (v0.8c) 접촉 감지 피격: 충격량은 물리가 이미 넣었다. 피격 모델은 행동·상처만 정하고 충격은 가하지 않는다
        const res = resolveHit(p.hit, p.hit.dv, this.rd, this.def.totalMass, this.hitModel);
        this.emit({ t, type: 'hit', body: res.body, point: p.sensed.point, direction: res.dir, dv: res.dv, detail: res.type, source: p.sensed.source });
        this.drawVariation();
        this.behaviors.onHit(res, t);
        this.breath.onHit(res.dv);
        this.tone.onHit(t, res.dv, 'contact');
        this.reactToContact(t, p.sensed);
        // (README 결정 168) 반응 클립은 빈 공간에서 밀린 사람이다: 다른 사람·물체에 부딪히면 스타일을 놓고 균형·스텝 계층과 접촉 반응(팔 힘 빼기·돌아보기)이 받는다
        const st = this.reaction.style;
        if (st && st.outT === null && this.reaction.cfg.releaseOnContact) { st.outT = t; st.outDur = this.reaction.cfg.style?.releaseTime ?? this.reaction.cfg.style?.blendOut ?? 0.3; this.reaction.log = { ...this.reaction.log, reason: `release contact ${p.sensed.source}` }; }
      } else if (p.hit) {
        // 피격 모델 (v0.5a): 종류별 충격량 분배·상처·행동
        const res = resolveHit(p.hit, p.hit.dv, this.rd, this.def.totalMass, this.hitModel);
        let point: Vec3 | undefined;
        // (결정 chest-2) 밀기 접촉 시간: 주지 않으면 hitModel.json push.defaultDuration(손으로 미는 접촉 0.1~0.3초), 모양 push.profile(rect 고르게 | halfSine 반사인)
        const pushDur = p.hit.type === 'push' ? p.hit.duration ?? this.hitModel.push.defaultDuration ?? 0 : 0;
        const n = pushDur > 0 ? Math.max(1, Math.round(pushDur / this.world.dt)) : 1;
        const prof = n > 1 && this.hitModel.push.profile === 'halfSine' ? pushProfile(n) : null;
        res.impulses.forEach((im, i) => {
          const J = prof ? scale(im.J, prof[0]!) : scale(im.J, 1 / n);
          const pt = applyJ(im.body, J, im.point);
          if (i === 0) point = im.point ?? pt;
          if (n > 1) {
            pushJ = add(pushJ, J);
            pushLeft = Math.max(pushLeft, n - 1);
            const rb = this.rd.body(im.body).rb, tr = rb.translation(), q = rb.rotation();
            const local = im.point ? rotate([-q.x, -q.y, -q.z, q.w], sub(im.point, [tr.x, tr.y, tr.z])) : null;
            this.ongoing.push(prof ? { body: im.body, J: im.J, local, left: n - 1, w: prof } : { body: im.body, J, local, left: n - 1 });
          }
        });
        this.emit({ t, type: 'hit', body: res.body, point: res.point ?? point, direction: res.dir, dv: res.dv, detail: res.type });
        this.drawVariation();
        this.behaviors.onHit(res, t);
        this.breath.onHit(res.dv);
        this.tone.onHit(t, res.dv, res.type);
        // (2026-10-27) 반응 클립 추종: 감지 지연 뒤 클립을 고른다 (서 있는 몸, 스텝 계층이 켜져 있을 때)
        this.scheduleReaction(t, p.hit.type, res.dv, res.body);
      } else if (p.body && p.impulse) applyJ(p.body, p.impulse, p.point);
    }
    this.pushNow = pushLeft > 0 || length(pushJ) > 0 ? { force: length(pushJ) / this.world.dt, left: pushLeft * this.world.dt } : null;
    const hitNow = this.pending.some((p) => !!p.hit || !!p.impulse);
    // (README 9f-11) 이번 스텝에 바깥 충격(피격·나눠 가하는 밀기)을 넣었는가 — 폭발 판정의 에너지 증가에서 뺀다
    this.extImpulseNow = hitNow || this.ongoing.length > 0;
    // (결정 land-3) 새 충격은 착지 받기 단계를 끝낸다 (다음 착지까지)
    if (hitNow) this.stepping.lastHitT = t;
    this.pending = [];
    // (game-1) 복귀 가능 판정 무장(바깥 충격·일어서기), 게임 애니 복귀 진행
    if (hitNow || this.getup.phase !== 'monitor') this.recovery.armed = true;
    if (this.ret) this.returnStep(t, hitNow);
    // (v0.8c) 부딪힌 상대 돌아보기: 시선 목표를 상대 머리로 갱신
    if (this.lookOther) this.updateLookOther(t);
    // 2. 인지
    const per = this.perception();
    // (v0.7) 일어서기: 판정·시작·균형 복귀·실패·피격 취소
    this.getupStep(t, per, hitNow);
    // 3. 상태 머신 (v0.6): 전환 블렌드 진행 (Active → Animated는 블렌드가 끝나면 키네마틱)
    if (this.states.update(t) === 'kinematic') {
      // (game-1) 복귀 핀 블렌드가 끝남: 키네마틱 + 남은 차이 관성화
      if (this.ret?.phase === 'pin') this.enterKinematic(t, true);
      else this.setBodiesKinematic(true);
    }
    // (2026-10-27) 반응 클립 추종 시작: 충격 + 감지 지연이 지나면 상태 매칭으로 클립·시각을 골라 애니 추종으로
    if (this.reaction.pendingT !== null || this.reaction.waitLanding) {
      const v = this.rd.com().vel;
      this.reaction.peakSpeed = Math.max(this.reaction.peakSpeed, Math.hypot(v[0], v[2]));
      if (this.reaction.pendingT !== null && t >= this.reaction.pendingT - 1e-9) this.startReaction(t, per);
    }
    // 5. 목표 포즈: 애니 클립(v0.6, 관성화 포함) 또는 포즈 클립(v0.2)
    const ref: AnimRef | null = this.anim.clip ? this.anim.ref(t) : null;
    let clipTargets = ref ? ref.joints : this.clip ? (this.standBlend.active ? this.standBlend.apply(t, this.clip.clip.sample(t - this.clip.t0)) : this.clip.clip.sample(t - this.clip.t0)) : null;
    // Animated: 키네마틱 바디를 다음 스텝 애니 자세로 (Rapier가 속도를 정한다)
    if (ref && this.states.name === 'Animated') {
      const nx = this.anim.bodiesAt(t + this.world.dt, this.anim.tau + this.anim.rate * this.world.dt);
      this.rd.bodies.forEach((b, i) => {
        const tf = nx[i]!;
        b.rb.setNextKinematicTranslation({ x: tf.pos[0], y: tf.pos[1], z: tf.pos[2] });
        b.rb.setNextKinematicRotation({ x: tf.rot[0], y: tf.rot[1], z: tf.rot[2], w: tf.rot[3] });
      });
    }
    // (README 결정 settle-1) 진정 단계: 충격 뒤 DCM이 다각형 안에 넉넉하고 넘어짐 확실도가 낮은 상태가 이어지면 '버텼다' → 팔을 서기 자세로 내리고 상체를 세운다.
    // 판단 입력은 직전 스텝의 균형(DCM 여유)·넘어짐 확실도 값. 반응 걸음·새 충격·크게 흔들림이면 바로 나온다
    // (README 결정 pres-3) 호흡·미세 움직임: 서기 포즈 클립(애니 클립 아님)을 따르는 서 있는 몸에만
    if (this.breath.cfg.enabled) {
      const hp = this.rd.body('Hips').rb.translation();
      const pw = this.world.physics, gh = pw.flat ? 0 : pw.groundHeightAt(hp.x, hp.z);
      // 가파른 경사에서는 끈다: 발목 한계 근처로 서 있어 작은 상체 변조에도 넘어졌다(slope20_push 근처 입력 12시드 넘어짐 1 → 4, README 결정 pres-6)
      const bc = this.breath.cfg, e = 0.2;
      const slopeDeg = pw.flat ? 0 : (Math.atan(Math.hypot(pw.groundHeightAt(hp.x + e, hp.z) - pw.groundHeightAt(hp.x - e, hp.z), pw.groundHeightAt(hp.x, hp.z + e) - pw.groundHeightAt(hp.x, hp.z - e)) / (2 * e)) * 180) / Math.PI;
      this.breath.update(this.world.dt, !ref && this.stateName === 'Active' && !this.behaviors.dead && this.getup.phase === 'monitor' && hp.y - gh >= this.breath.cfg.minHipsH && slopeDeg < bc.maxSlopeDeg,
        this.stepping.busy || this.behaviors.list.some((b) => b.stopT === null && b.name !== 'LookAt' && b.name !== 'InjuredLeg'));
      if (!ref) clipTargets = this.breath.apply(t, clipTargets);
    }
    const idleTargets = clipTargets;
    if (this.settle.cfg.enabled) {
      const v = this.rd.com().vel;
      const sst = this.stepping.state;
      const walkingNow = !!ref && this.animCfg.walk.enabled && this.walk.engaged && !this.isReactionClip(ref.clip);
      const blocked = this.behaviors.list.some((b) => this.reaction.cfg.blockBehaviors.includes(b.name) && b.stopT === null);
      this.settle.update({
        t, dt: this.world.dt, hitNow,
        eligible: this.stateName === 'Active' && this.balance.state.enabled && !walkingNow && this.getup.phase === 'monitor' && !blocked,
        cpMargin: this.balance.state.cpMargin ?? 0, fall: this.behaviors.state.fall?.certainty ?? 0, speed: Math.hypot(v[0], v[2]),
        reactiveStep: sst.state === 'lift' || (sst.state === 'step' && sst.kind !== 'closing'),
      });
      // 진정 정도가 1로 endStyleHold초: 반응 상체 스타일을 놓는다 (나오기 blendOut — 그 뒤는 서기(Idle) 자세 목표)
      const st = this.reaction.style;
      if (st && st.outT === null && this.settle.styleDone(t)) { st.outT = t; this.reaction.log = { ...this.reaction.log, reason: 'settled' }; }
    }
    // (2026-10-27) 반응 상체 스타일: 클립의 척추·머리·팔 목표를 우리 걸음에 맞춰 (README 결정 160)
    if (this.reaction.style) clipTargets = this.applyStyle(t, clipTargets);
    // 진정 단계 레퍼런스: 팔 → 서기(Idle) 자세 팔, 척추·머리 → 서기 자세(천천히)
    if (this.settle.level > 0) clipTargets = this.settle.apply(clipTargets, idleTargets);
    // 레퍼런스 → 추종기 경계 (README 결정 164): 관절 목표(clipTargets)와 관절별 추종 세기만 넘긴다
    this.balance.trackRef = this.reaction.style && this.reaction.style.w > 0 ? styleTrackingRef(this.reaction.cfg.style!, this.reaction.style.clip, this.reaction.style.w, this.reaction.style.armK) : null;
    this.balance.settleRef = this.settle.ref();
    this.balance.settleLog = this.settle.log;
    // (결정 tone-1) 근긴장: 서서 균형을 잡는 동안만(넘어짐·누움·일어서기·Ragdoll은 배율 1). 신장 반사 입력 = 직전 스텝 근육의 신장 속도.
    // 레벨은 근육 모터(7단계)와 전신 QP 자세 과제(힌트 toneRef, tone.qp)에 같이 쓴다
    if (this.tone.cfg.enabled) {
      const stretch: Partial<Record<JointName, number>> = {};
      for (const m of this.muscles.joints) stretch[m.name] = m.stretch;
      this.tone.update(t, this.world.dt, stretch, this.stateName === 'Active' && this.balance.state.enabled && this.getup.phase === 'monitor' && !this.behaviors.dead);
      const q = this.tone.cfg.qp;
      this.balance.toneRef = q && Object.keys(this.tone.level).length ? { level: this.tone.level, kpGain: q.kpGain, kdGain: q.kdGain, wGain: q.wGain } : null;
    }
    // 4~5. 행동 (v0.5a): 클립 목표 위에 레이어·가중치 블렌드 → 관절 목표, 강도 배율, 손 IK 목표, COM 낮추기, 스텝 수정
    const ss = this.stepping.state;
    const blend = this.behaviors.update({ t, dt: this.world.dt, rd: this.rd, def: this.def, per, bodyIdx: (n) => this.rd.body(n).idx, stepping: { busy: this.stepping.busy, state: ss.state, stepCount: ss.stepCount, target: ss.target, swing: ss.phase === 'swing' && ss.swingFoot && ss.target ? { foot: ss.swingFoot, target: ss.target } : null } }, clipTargets, this.stateName === 'Active');
    // (v0.9) 레퍼런스 ↔ 추종기 경계: 추종기(균형·근육)에 넘기는 레퍼런스를 남긴다 (읽기만, src/sim/tracker.ts)
    const refJoints = this.behaviors.engaged ? blend.targets : clipTargets;
    this.lastRef = {
      t,
      joints: refJoints ? { ...refJoints } : null,
      tracking: this.balance.trackRef,
      ...(this.balance.settleRef ? { settle: this.balance.settleRef } : {}),
      clip: ref ? { name: ref.clip, tau: ref.tau } : null,
      behavior: this.behaviors.engaged ? { active: this.behaviors.list.filter((b) => b.stopT === null).map((b) => b.name), strengthMul: { ...blend.strengthMul }, balanceMode: blend.balanceMode, hands: { ...blend.hands } } : null,
    };
    for (const e of this.behaviors.events) this.emit({ t, type: e.type, detail: e.detail, ...(e.body ? { body: e.body } : {}), ...(e.strength !== undefined ? { strength: e.strength } : {}), ...(e.dv !== undefined ? { dv: e.dv } : {}) });
    this.behaviors.events = [];
    // 행동이 하나도 없으면 v0.4와 똑같이 (클립 목표 그대로, 행동 입력 없음)
    const behOn = this.behaviors.engaged;
    this.stepping.mods = behOn ? blend.stepping : {};
    const behIn: BalanceBehaviorInput | null = behOn ? blend : null;
    // (v0.6) 핀 보조: 전환 블렌드 + 추종 중 강도, 반응 중(피격·외란·비틀거림) 0. 균형 QP가 렌치를 알도록 먼저 계산한다
    const locoOn = !!ref && this.stateName === 'Active' && this.animCfg.walk.enabled;
    if (ref) {
      // 반응 클립 추종 중에는 핀 0 (피격 반응 중 핀 금지, CLAUDE.md)
      const reacting = t < this.reactUntil || this.reaction.active || this.behaviors.list.some((b) => b.name !== 'LookAt' && b.stopT === null) || (locoOn && !this.walk.engaged);
      const blendPin = this.states.blendPin(t);
      const byClip = this.animCfg.pin.trackingByClip?.[ref.clip];
      const trackS = byClip?.strength ?? this.animCfg.pin.trackingStrength;
      const target = reacting ? 0 : Math.max(blendPin, locoOn && this.walk.engaged ? trackS : 0);
      if (!reacting && this.states.trans) this.pin.schedule(blendPin, this.world.dt, true);
      else this.pin.schedule(target, this.world.dt);
      this.pin.reason = this.pin.strength > 0 ? (this.states.trans ? 'blend' : 'tracking') : '';
      this.pin.compute(this.stateName === 'Animated' ? null : ref, this.pin.reason === 'tracking' && byClip ? byClip.mode : undefined);
    } else if (this.pin.strength > 0 || this.pin.usage > 0) { this.pin.schedule(0, this.world.dt, true); this.pin.compute(null); }
    // (app-2) 애니 강제 비율: 피격·반응 중에도 레퍼런스 쪽으로 (사람이 켠 오버라이드, 기본 0이면 건너뜀)
    const ao = this.animOverridePin;
    if (ao && (this.animOverrideW > 0 || ao.usage > 0)) {
      ao.schedule(this.animOverrideW, this.world.dt, true);
      ao.reason = this.animOverrideW > 0 ? 'override' : '';
      ao.compute(this.animOverrideW > 0 ? this.animOverrideRef(t, ref) : null);
    }
    const aoOn = !!ao && ao.usage > 0;
    const pinWrench = aoOn ? ao!.wrench.map((w, i) => ({ f: add(w.f, this.pin.usage > 0 ? this.pin.wrench[i]!.f : [0, 0, 0]), tau: add(w.tau, this.pin.usage > 0 ? this.pin.wrench[i]!.tau : [0, 0, 0]) })) : this.pin.usage > 0 ? this.pin.wrench : null;
    // 6. 균형 (v0.3): 목표 수정 + 관절 토크 명령. 애니 추종 중이면(v0.6) 걷기 추종 QP
    const wasEngaged = this.walk.engaged;
    const bal = this.balance.update(t, this.world.dt, this.stateName === 'Active', per, behOn ? blend.targets : clipTargets, this.def.totalMass, behIn, locoOn ? { ref: ref!, anim: this.anim, pinWrench } : null);
    // (v0.8c) 걷다가 다른 사람과 부딪힘: 걷기 추종을 바로 놓고 스텝 계층(멈칫·비틀거림)에 넘긴다 → 서면 tryResume이 걷기 시작 클립으로 다시 걷는다
    // 스윙 중이면 그 발이 디딜 때까지(두 발 접촉) 기다린다 — 스윙 도중 넘기면 스텝 계층이 같은 발을 다시 내디뎌 큰 걸음 끝에 넘어졌다 (최대 stopWalkMaxDefer초)
    if (this.contactHandover) {
      const both = per.feet.LeftFoot.contact && per.feet.RightFoot.contact;
      if (!(locoOn && this.walk.engaged)) this.contactHandover = null;
      else if (this.contactHandover.now || both || t - this.contactHandover.t >= INTERACTION.handover.walkMaxDefer) {
        this.walk.engaged = false; this.walk.state.engaged = false; this.walk.state.handover = this.contactHandover.why;
        this.contactHandover = null;
      }
    }
    // (v0.6) 걷기 추종 중에는 스윙발·지지 다리 정강이 충돌을 끈다 (좁은 걸음에서 발 상자가 정강이 캡슐을 스쳐 스윙이 멈췄다)
    // 피격·밀기 뒤 legNoCollideReactHold초 동안은 legNoCollideReact 쌍도 끈다 (옆 밀림 교차 디딤에서 무릎·허벅지가 엇갈린다. 평소 걷기에서 끄면 다리가 안으로 모여 걸음이 무너졌다)
    const nc = !(locoOn && this.walk.engaged) ? 0 : t < this.reactUntil - this.animCfg.resume.reactHold + this.animCfg.walk.legNoCollideReactHold ? 2 : 1;
    if (nc !== this.walkNoCollide) {
      this.walkNoCollide = nc;
      const w = this.animCfg.walk;
      this.rd.setRuntimeNoCollide(nc === 0 ? null : ([...w.legNoCollide, ...(nc === 2 ? w.legNoCollideReact : [])] as [BodyName, BodyName][]));
    }
    if (locoOn && wasEngaged && !this.walk.engaged) {
      // 걷기 추종을 넘김 (큰 외란): 스텝 계층이 바로 반응하게 상태를 비우고 이벤트를 남긴다
      this.handoverT = t;
      const wf = this.walk.state.feet;
      const st0 = (['LeftFoot', 'RightFoot'] as const).filter((f) => per.feet[f].contact);
      const stanceFoot = st0.length === 1 ? st0[0]! : st0.length === 2 ? (per.feet.LeftFoot.load >= per.feet.RightFoot.load ? 'LeftFoot' : 'RightFoot') : null;
      void wf;
      this.stepping.handover(t, stanceFoot);
      // 모터 목표가 지금 자세에서 클립 자세로 이어지게 (관성화)
      this.anim.blendFromActual(t, this.currentJoints(), {}, this.animCfg.resume.blendTime);
      this.emit({ t, type: 'walkHandover', detail: this.walk.state.handover ?? '' });
      // (v0.8a) 헛디딤(낭떠러지로 내딛음) → Misstep, 장애물에 발이 걸림 → Trip + 비틀거림 (행동 계층, docs/ALGORITHMS.md v0.8a)
      const hf = this.walk.handoverFoot;
      if (this.walk.state.handover === 'void') this.behaviors.trigger('Misstep', { foot: hf ?? 'RightFoot' }, t);
      else if (this.walk.state.handover === 'trip') { this.behaviors.trigger('Trip', { foot: hf ?? 'RightFoot' }, t); this.behaviors.onStaggerEvent(t); }
      // 반응 클립에서 크게 벗어남: 클립을 놓고 서기 포즈 목표(관성화)로 v0.4 균형·스텝 계층이 받는다 (반응 클립에는 다시 붙이지 않는다)
      if (this.reaction.active) this.endReaction(t, `handover ${this.walk.state.handover ?? ''}`);
    }
    if (this.reaction.active && !this.reaction.style) this.reactionStep(t, per);
    for (const e of this.stepping.events) {
      this.emit({ t, type: e.type, detail: e.detail, ...(e.foot ? { body: e.foot } : {}), ...(e.error !== undefined ? { error: e.error } : {}) });
      if (e.type === 'stagger') this.behaviors.onStaggerEvent(t);
      // (v0.8a) 디딜 곳 없는 낭떠러지로 내딛음 → 헛디딤
      if (e.type === 'voidStep' && !this.behaviors.list.some((b) => b.name === 'Misstep' && b.stopT === null)) this.behaviors.trigger('Misstep', { foot: e.foot ?? 'RightFoot' }, t);
      // 반응 클립을 첫 반응 착지 뒤에 붙이는 방식(startOn 'landing'): 스텝 계층이 첫 걸음으로 받은 뒤 클립을 고른다
      if (e.type === 'step' && this.reaction.style) this.reaction.style.ours++;
      if (e.type === 'step') this.breath.onStep();
      if (e.type === 'step' && this.reaction.waitLanding) { this.reaction.waitLanding = false; this.reaction.pendingT = t + this.world.dt; }
    }
    this.stepping.events = [];
    // 7. 근육 (토크·힘 reset 포함) → 루트 보조
    // (v0.7) 일어서는 중: 근육 강성 × motorScale(균형 계층은 꺼져 있다), 겟업 보조를 클립 기준(관성화한 Hips)으로
    let mcmd = bal.cmd;
    if (this.stateName === 'GettingUp' && this.getup.run && ref) {
      const ex = this.getup.cfg.exec;
      // 팔(위팔·전완·손)은 강성을 덜 올린다: 몸이 클립보다 늦으면 높은 강성의 팔이 채찍처럼 휘둘렸다(손 7 m/s, 클립은 3 m/s)
      const msJ: Partial<Record<JointName, number>> = {};
      for (const jn of ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'] as JointName[]) msJ[jn] = ex.armMotorScale;
      mcmd = { torque: {}, gcScale: {}, motorScale: ex.motorScale, motorScaleJ: msJ };
      const rt = this.getup.run.root.apply(t, ref.bodies[0]!);
      this.getupAssist.set(this.getup.assistStrength(t, this.anim.tau), { y: rt.pos[1], vy: ref.bodyLin[0]![1], rot: rt.rot });
      // 겟업 전신 QP: 실제 접촉점 힘으로 클립 COM(지지 기준)·자세를 따른다
      const feetOnly = per.feet.LeftFoot.contact && per.feet.RightFoot.contact && [...per.ground].every((b) => isFootBody(b)) && ref.feet.LeftFoot.stance && ref.feet.RightFoot.stance;
      if (this.getup.cfg.qp.enabled && (feetOnly || !this.getup.cfg.qp.feetPhaseOnly)) {
        const q = this.getupQP.update(t, this.world.dt, per, ref, rt, this.def.totalMass, this.getupAssist.predict());
        if (q) mcmd = q.cmd;
      }
      this.getupRefTau = this.anim.tau;
    } else if (this.getup.phase === 'balance' && this.getup.run && ref && this.anim.clip?.name === this.getup.run.item.clip && this.getup.assistStrength(t, this.anim.tau) > 1e-4) {
      // 균형으로 넘긴 뒤 보조 꼬리 (클립 기준 Hips 높이·자세, tailTime초에 0으로)
      const rt = ref.bodies[0]!;
      this.getupAssist.set(this.getup.assistStrength(t, this.anim.tau), { y: rt.pos[1], vy: ref.bodyLin[0]![1], rot: rt.rot });
      this.getupRefTau = this.anim.tau;
    } else {
      if (this.getupAssist.strength > 0) this.getupAssist.set(0, null);
      this.getupRefTau = this.getup.phase === 'balance' ? this.anim.tau : null;
    }
    const toneMul = this.tone.cfg.enabled ? { kp: this.tone.kp, kd: this.tone.kd } : null;
    this.muscles.apply(this.world.dt, t, this.stateName !== 'Ragdoll', bal.targets, mcmd, behOn ? blend.strengthMul : null, behOn ? blend.capacityMul : null, toneMul);
    this.pin.apply();
    this.animOverridePin?.apply();
    this.rootAssist.apply();
    this.getupAssist.measure();
    // (v0.6) 걷기 추종 복귀: 스텝 계층이 서기로 돌아오고 막는 행동이 없으면 가장 가까운 클립 위상으로 다시 붙인다
    if (locoOn && !this.walk.engaged) this.tryResume(t, per);
    if (locoOn && this.walk.engaged) this.chainResume(t);
    this.anim.advance(this.world.dt);
  }

  // ── 반응 클립 추종 (2026-10-27, docs/ALGORITHMS.md '반응 클립 추종') ──
  private isReactionClip(name: string | undefined): boolean { return !!name && name.startsWith(this.reaction.cfg.clipPrefix); }

  /** 충격을 받으면 감지 지연 뒤 클립을 고르도록 예약한다. 서 있는(또는 반응 중인) Active 몸, 균형·스텝 계층이 켜져 있을 때만 */
  private scheduleReaction(t: number, type: string, dv: number, body: string): void {
    const rc = this.reaction.cfg;
    if (rc.hitBodies && !rc.hitBodies.includes(body)) return;
    if (!rc.enabled || !this.reactionNames.length || !rc.hitTypes.includes(type) || dv < rc.minDv || dv > rc.maxDv) return;
    if (this.stateName !== 'Active' && this.stateName !== 'Animated') return;
    if (!this.balance.enabled || !this.stepping.enabled || this.getup.phase !== 'monitor' || this.behaviors.dead || this.exploded) return;
    const cur = this.anim.clip;
    const walking = !!cur && !this.isReactionClip(cur.name) && cur.loop && cur.stepSequence(this.anim.tau, 2).length > 0;
    if (walking && !rc.whileWalking) return;
    // 반응 중 다시 맞음: rehit = 'release'이면 상체 스타일을 풀고(나오기) 스텝 계층·팔 균형에 맡긴다 (연속 밀림은 클립 한 개로 대표할 수 없다)
    if (this.reaction.style && rc.rehit === 'release') { const st = this.reaction.style; if (st.outT === null) { st.outT = t; st.outDur = rc.style?.releaseTime ?? rc.style?.blendOut ?? 0.3; } return; }
    if (rc.startOn === 'landing') { this.reaction.waitLanding = true; this.reaction.pendingT = null; } else this.reaction.pendingT = t + Math.max(0, rc.delay + (this.variation?.delay ?? 0));
    this.reaction.peakSpeed = 0;
    this.reaction.hitT = t;
    this.reaction.log = { ...this.reaction.log, phase: 'wait', reason: '' };
  }

  /** 상태 매칭으로 클립·시각을 고르고 애니 추종(walk.ts)으로 따라가기 시작 */
  private startReaction(t: number, per: Perception): void {
    const rc = this.reaction.cfg;
    this.reaction.pendingT = null;
    // 그사이 넘어지기 시작했거나(대비·사망) 일어서기 중이면 하지 않는다
    if (this.stateName !== 'Active' || this.getup.phase !== 'monitor' || this.behaviors.dead || this.behaviors.list.some((b) => rc.blockBehaviors.includes(b.name) && b.stopT === null)) {
      this.reaction.log = { ...this.reaction.log, phase: this.reaction.active ? 'track' : 'done', reason: 'blocked' };
      return;
    }
    this.reactionLib ??= new ReactionLibrary(this.anim, this.def, this.anim.mass, this.reactionNames);
    this.reaction.lib = this.reactionLib;
    const fp = (n: FootName): Vec3 => { const p = this.rd.body(n).rb.translation(); return [p.x, p.y, p.z]; };
    const hq = this.rd.body('Hips').rb.rotation();
    const { com, vel } = this.rd.com();
    const cur = this.anim.clip;
    const walking = !!cur && !this.isReactionClip(cur.name) && cur.loop;
    const m = this.reactionLib.match({
      com, comVel: vel, feet: { LeftFoot: fp('LeftFoot'), RightFoot: fp('RightFoot') }, contact: { LeftFoot: per.feet.LeftFoot.contact, RightFoot: per.feet.RightFoot.contact },
      pelvisYaw: yawOfQ(multiplyQ([hq.x, hq.y, hq.z, hq.w], conjugateQ(this.def.bodies[0]!.restRotation))), joints: this.currentJoints(), walking, peakSpeed: Math.max(this.reaction.peakSpeed, Math.hypot(vel[0], vel[2])),
    }, rc);
    const vh: [number, number] = [vel[0], vel[2]];
    if ((rc.mode ?? 'track') === 'style') {
      // 상체 스타일 (README 결정 160): 다리·COM은 스텝 계층, 클립은 척추·머리·팔 목표만 (우리 걸음에 맞춰 시간 늘이기)
      const sc = rc.style!;
      const peak = Math.max(this.reaction.peakSpeed, Math.hypot(vel[0], vel[2]));
      const ch = this.reactionLib.chooseStyle(vel, peak, yawOfQ(multiplyQ([hq.x, hq.y, hq.z, hq.w], conjugateQ(this.def.bodies[0]!.restRotation))), walking, sc, this.variation ? { tol: GAME.variation.clipCostTol, u: this.variation.clipU } : undefined);
      if (!ch) { this.reaction.log = { ...this.reaction.log, phase: 'done', reason: 'none', vel: vh }; return; }
      const prevW = this.reaction.style?.w ?? 0;
      this.reaction.style = { clip: ch.meta.name, tau: ch.meta.pushTau + (t - (this.reaction.hitT ?? t)), rate: 1, w: prevW, startT: t - prevW * sc.blendIn, outT: null, landings: this.reactionLib.landings(ch.meta.name, sc.landingMinMove), ours: 0, standSince: null, dirCos: ch.dirCos, gate: this.reaction.style?.gate ?? (rc.style!.stepGate ? rc.style!.stepGate.inStep : 1), from: prevW > 0 ? this.reaction.lastOut : null, fromT: t, armK: this.reaction.style?.armK ?? this.styleArmGoal(t) };
      this.reaction.active = true;
      this.reaction.log = { phase: 'track', clip: ch.meta.name, tau: this.reaction.style.tau, startT: t, cost: ch.cost, vel: vh, clipVel: null, reason: '', candidates: this.reactionLib.meta.length };
      this.emit({ t, type: 'reactionStart', detail: `style ${ch.meta.name} dvPeak=${ch.meta.dvPeak.toFixed(2)} peak=${peak.toFixed(2)} cos=${ch.dirCos.toFixed(2)} cost=${ch.cost.toFixed(3)}` });
      return;
    }
    if (!m || m.cost > rc.maxCost) {
      this.reaction.log = { ...this.reaction.log, phase: this.reaction.active ? 'track' : 'done', reason: m ? `none ${m.clip} ${m.cost.toFixed(2)}` : 'none', vel: vh, cost: m?.cost ?? 0 };
      return;
    }
    if (!this.reaction.active) this.reaction.returnTo = cur && !this.isReactionClip(cur.name) ? { kind: 'clip', name: cur.name } : { kind: 'stand' };
    const anchor = { yaw: m.anchor.yaw, pos: [m.anchor.pos[0], per.groundHeight ?? 0, m.anchor.pos[2]] as Vec3 };
    const joints = this.currentJoints();
    this.anim.play(m.clip, t, { anchor, startTime: m.tau, blendTime: 0 });
    this.anim.blendFromActual(t, joints, {}, rc.blendTime);
    this.clip = null;
    this.getupIdleHold = false;
    this.resumeTo = null;
    this.handoverT = null;
    this.walk.cfg = this.reaction.walkCfg;
    this.walk.reset();
    this.walk.engaged = true;
    // 서기 스텝 계층은 쉰다 (반응 클립이 걸음을 정한다). 넘기면 handover가 다시 깨운다
    this.stepping.handover(t, null);
    this.reaction.active = true;
    this.reaction.lastPlant = { LeftFoot: fp('LeftFoot'), RightFoot: fp('RightFoot') };
    this.reaction.landingsSeen = t;
    this.reaction.log = { phase: 'track', clip: m.clip, tau: m.tau, startT: t, cost: m.cost, vel: vh, clipVel: [m.clipVel[0], m.clipVel[2]], reason: '', candidates: this.reactionLib.meta.length };
    this.emit({ t, type: 'reactionStart', detail: `${m.clip} tau=${m.tau.toFixed(3)} cost=${m.cost.toFixed(3)} (vel ${m.terms.vel.toFixed(2)} com ${m.terms.com.toFixed(2)} feet ${m.terms.feet.toFixed(2)} contact ${m.terms.contact.toFixed(2)} legs ${m.terms.legs.toFixed(2)} peak ${m.terms.peak.toFixed(2)})` });
  }

  /** style 모드 한 스텝: 재생 속도(클립 k번째 착지 ↔ 우리 k번째 착지 예측), 가중치 들어가기·나오기, 상체 관절 목표 섞기 */
  /** 팔 묶음 목표 배율: 행동이 쓰는 손(blender.handsInUse)이나 부딪혀 힘을 뺀 팔(근육 명령 배율 < 1)은 0 */
  private styleArmGoal(t: number): Record<'Left' | 'Right', number> {
    const used = this.behaviors.handsInUse();
    const k = (sd: 'Left' | 'Right') => (used.has(`${sd}Hand`) || this.muscles.commandedScale(`${sd}Arm`, t) < 1 ? 0 : 1);
    return { Left: k('Left'), Right: k('Right') };
  }

  private applyStyle(t: number, base: JointTargets | null): JointTargets | null {
    const st = this.reaction.style!;
    const sc = this.reaction.cfg.style!;
    const dt = this.world.dt;
    const clip = this.anim.getClip(st.clip);
    // 재생 속도: 다음 클립 착지 시각 T까지 남은 클립 시간 / 우리 다음 착지까지 남은 시간
    const ss = this.stepping.state;
    const T = st.landings[st.ours];
    let rateDes = 1;
    if (T !== undefined) {
      if (T <= st.tau) rateDes = sc.rate.min;
      else if (this.stepping.busy && ss.state === 'step' && ss.duration) rateDes = (T - st.tau) / Math.max(0.04, (1 - Math.min(1, ss.s ?? 0)) * ss.duration);
      else rateDes = this.stepping.busy ? sc.rate.settle : 1;
    }
    rateDes = Math.max(sc.rate.min, Math.min(sc.rate.max, rateDes));
    st.rate += (rateDes - st.rate) * (1 - Math.exp(-dt / sc.rate.tau));
    // 나오기: 스텝 계층이 서기로 돌아오고 holdAfterStand초 또는 클립 끝
    if (this.stepping.busy) st.standSince = null; else st.standSince ??= t;
    if (st.outT === null && ((st.standSince !== null && t - st.standSince >= sc.holdAfterStand) || st.tau >= clip.duration - sc.blendOut)) st.outT = t;
    // (README 결정 170) 반응 중 넘어짐·바닥 행동(blockBehaviors)이 켜지거나 Active가 아니면 그 행동이 몸을 맡는다: releaseTime초에 놓는다
    if (st.outT === null && (this.stateName !== 'Active' || this.behaviors.list.some((b) => this.reaction.cfg.blockBehaviors.includes(b.name) && b.stopT === null))) { st.outT = t; st.outDur = sc.releaseTime ?? sc.blendOut; this.reaction.log = { ...this.reaction.log, reason: 'release block' }; }
    const sm = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
    // 걸음 문: stepGate가 있으면 스텝 계층이 반응 걸음(스윙)을 하는 동안은 스타일을 줄이고(gate.inStep배, gate.down초), 걸음 사이·정착에서 gate.up초에 되살린다
    if (sc.stepGate) {
      const inStep = this.stepping.busy && ss.state === 'step';
      const goal = inStep ? sc.stepGate.inStep : 1;
      const tg = goal < st.gate ? sc.stepGate.down : sc.stepGate.up;
      st.gate += (goal - st.gate) * (1 - Math.exp(-dt / Math.max(1e-3, tg)));
    } else st.gate = 1;
    st.w = st.gate * sm((t - st.startT) / Math.max(1e-3, sc.blendIn)) * (st.outT === null ? 1 : 1 - sm((t - st.outT) / Math.max(1e-3, st.outDur ?? sc.blendOut)));
    // 팔 묶음 풀기 (README 결정 167): 행동(잡기·벽 짚기·상처 누르기)이 쓰는 팔, 부딪혀 힘을 뺀 팔은 blendIn초에 걸쳐 클립 모양·추종 세기를 놓는다
    const goalK = this.styleArmGoal(t);
    const kK = 1 - Math.exp(-dt / Math.max(1e-3, sc.blendIn));
    for (const sd of ['Left', 'Right'] as const) st.armK[sd] += (goalK[sd] - st.armK[sd]) * kK;
    const pose = clip.poseAt(st.tau);
    const out: JointTargets = { ...(base ?? {}) };
    // (game-3) 반응 변주: 팔 모양 세기 배율 (변주를 끄면 1)
    const armVar = this.variation?.arm ?? 1;
    for (const j of sc.joints) {
      const c = pose.joints[j];
      if (!c) continue;
      const sd = j.startsWith('Left') ? 'Left' : j.startsWith('Right') ? 'Right' : null;
      out[j] = slerpQ(base?.[j] ?? [0, 0, 0, 1], c, st.w * (sd ? st.armK[sd] * armVar : 1));
      // 반응 중 다시 맞아 클립이 바뀌었으면 이전 출력에서 blendIn초에 걸쳐 넘어간다
      const fq = st.from?.[j];
      if (fq) out[j] = slerpQ(fq, out[j]!, sm((t - st.fromT) / Math.max(1e-3, sc.blendIn)));
    }
    this.reaction.lastOut = out;
    this.reaction.log = { ...this.reaction.log, tau: st.tau, style: { clip: st.clip, tau: st.tau, rate: st.rate, w: st.w, ourLandings: st.ours, clipLandings: st.landings, dirCos: st.dirCos, ...(st.armK.Left < 1 || st.armK.Right < 1 ? { armK: { ...st.armK } } : {}) } };
    st.tau += st.rate * dt;
    if (st.outT !== null && st.w <= 1e-4) {
      this.reaction.style = null;
      this.reaction.active = false;
      this.reaction.log = { ...this.reaction.log, phase: 'done', reason: 'end' };
      this.emit({ t, type: 'reactionEnd', detail: 'style end' });
    }
    return out;
  }

  /** 추종 중 매 스텝: 걸음 세기(착지 = walk.ts 착지 기록, 발이 countMinMove 넘게 옮겨진 것), 끝 판정 */
  private reactionStep(t: number, per: Perception): void {
    const r = this.reaction;
    const clip = this.anim.clip;
    if (!clip || !this.isReactionClip(clip.name)) { this.endReaction(t, 'clip'); return; }
    r.log = { ...r.log, tau: this.anim.tau };
    for (const l of this.walk.state.landings) {
      if (l.t <= r.landingsSeen + 1e-9) continue;
      r.landingsSeen = l.t;
      const last = r.lastPlant[l.foot];
      const moved = last ? Math.hypot(l.p[0] - last[0], l.p[1] - last[2]) : Infinity;
      const p = this.rd.body(l.foot).rb.translation();
      r.lastPlant[l.foot] = [p.x, p.y, p.z];
      if (moved > r.cfg.countMinMove) this.emit({ t, type: 'step', body: l.foot, error: l.error, detail: `reaction ${clip.name}` });
    }
    const v = this.rd.com().vel;
    const still = Math.hypot(v[0], v[2]) < r.cfg.endSpeed && per.feet.LeftFoot.contact && per.feet.RightFoot.contact;
    if (this.anim.tau >= clip.duration - 1e-6 || (this.anim.tau >= clip.duration - r.cfg.endBefore && still)) this.endReaction(t, 'end');
  }

  /** 반응 추종을 끝내고 돌아간다: 서기 포즈(관성화) 또는 이전 클립(Idle 등) */
  private endReaction(t: number, reason: string): void {
    const r = this.reaction;
    if (!r.active) return;
    r.active = false;
    r.log = { ...r.log, phase: 'done', reason };
    this.walk.cfg = this.baseWalkCfg;
    const ret = r.returnTo;
    const joints = this.currentJoints();
    if (ret.kind === 'clip' && !reason.startsWith('handover')) {
      this.anim.play(ret.name, t, { anchor: this.anchorFor(ret.name, 0), startTime: 0, blendTime: 0 });
      this.anim.blendFromActual(t, joints, {}, r.cfg.returnBlend);
      this.walk.reset();
      this.walk.engaged = true;
    } else {
      this.anim.stop();
      this.walk.reset();
      this.walk.engaged = true;
      if (this.poses.stand) {
        this.clip = { clip: this.getClip('stand'), t0: t };
        this.standBlend.start(t, r.cfg.returnBlend, { joints, vel: {} }, { joints: this.clip.clip.sample(0), vel: {} });
      }
    }
    if (!reason.startsWith('handover')) this.stepping.handover(t, null);
    this.emit({ t, type: 'reactionEnd', detail: reason });
  }

  /**
   * (game-1) 지금 관절 상대 각속도 (관절 목표 형식의 왼쪽 곱 각속도: q̇ = ½ω q, q = (P·F_P)⁻¹·C·F_C → ω = (P·F_P)⁻¹ (ω_C − ω_P)).
   * 관성화 시작 속도 — 0으로 두면 스윙하던 발이 전환 순간 멈췄다(바디 속도 불연속 3.2 m/s)
   */
  private currentJointVel(): Partial<Record<JointName, Vec3>> {
    const out: Partial<Record<JointName, Vec3>> = {};
    for (const j of this.rd.joints) {
      const pb = this.rd.bodies[j.parent]!.rb, cb = this.rd.bodies[j.child]!.rb;
      const pq = pb.rotation(), wp = pb.angvel(), wc = cb.angvel();
      out[j.name] = rotate(conjugateQ(multiplyQ([pq.x, pq.y, pq.z, pq.w], j.def.frameInParent)), [wc.x - wp.x, wc.y - wp.y, wc.z - wp.z]);
    }
    return out;
  }

  /** 지금 관절 상대 회전 (정의 관절 좌표계, 목표 형식) */
  private currentJoints(): JointTargets {
    const joints: JointTargets = {};
    for (const j of this.rd.joints) {
      const pq = this.rd.bodies[j.parent]!.rb.rotation(), cq = this.rd.bodies[j.child]!.rb.rotation();
      joints[j.name] = multiplyQ(multiplyQ(conjugateQ(multiplyQ([pq.x, pq.y, pq.z, pq.w], j.def.frameInParent)), [cq.x, cq.y, cq.z, cq.w]), j.def.frameInChild);
    }
    return joints;
  }

  /** 걷기 추종 복귀 (v0.6): 위상 맞추기(발 접촉 패턴 + 두 발 위치 + 다리 관절 + 앞 속도) → 앵커를 지금 발에 맞추고 관성화로 이어 붙임 */
  private tryResume(t: number, per: Perception): void {
    const rc = this.animCfg.resume;
    if (rc.policy !== 'resume' || !this.anim.clip) return;
    // (v0.7) 겟업 뒤 Idle은 애니 추종 QP에 다시 붙이지 않고 균형·스텝 계층(서 있는 몸)이 Idle 자세를 따른다: 일어선 발 자리는 Idle 클립과 달라
    // 클립 COM을 쫓는 추종 QP가 몇 초 뒤 무게 옮기기에서 지지 다각형 밖으로 밀려 넘어졌다 (README 결정)
    if (this.getupIdleHold || (this.getup.run && this.anim.clip.name === this.getup.run.item.clip)) return;
    if (this.stepping.busy || (this.handoverT !== null && t - this.handoverT < rc.minHold)) return;
    if (this.behaviors.list.some((b) => rc.blockers.includes(b.name) && b.stopT === null)) return;
    if (!per.feet.LeftFoot.contact && !per.feet.RightFoot.contact) return;
    const clip = this.anim.clip;
    const hq = this.rd.body('Hips').rb.rotation();
    const yaw = this.anim.anchor.yaw;
    const joints: JointTargets = {};
    for (const j of this.rd.joints) {
      const pq = this.rd.bodies[j.parent]!.rb.rotation(), cq = this.rd.bodies[j.child]!.rb.rotation();
      joints[j.name] = multiplyQ(multiplyQ(conjugateQ(multiplyQ([pq.x, pq.y, pq.z, pq.w], j.def.frameInParent)), [cq.x, cq.y, cq.z, cq.w]), j.def.frameInChild);
    }
    const fp = (n: 'LeftFoot' | 'RightFoot'): Vec3 => { const p = this.rd.body(n).rb.translation(); return [p.x, p.y, p.z]; };
    const m = this.anim.matchPhase(clip.name, { contact: { LeftFoot: per.feet.LeftFoot.contact, RightFoot: per.feet.RightFoot.contact }, footPos: { LeftFoot: fp('LeftFoot'), RightFoot: fp('RightFoot') }, joints, comVel: this.rd.com().vel, yaw });
    // 거의 멈춘 몸 + 걷기 시작 클립이 있으면: 시작 클립으로 다시 걷기 시작(사람이 비틀거린 뒤 멈췄다가 다시 걷는 것). 끝나 갈 때 루프 클립으로 잇는다(chainResume)
    const startClip = rc.startClips?.[clip.name];
    const v0 = this.rd.com().vel;
    if (startClip && Math.hypot(v0[0], v0[2]) < (rc.startMaxSpeed ?? 0)) {
      const tau0 = rc.startTau ?? 0;
      // 앵커: 클립에서 먼저 떼지 않는 발(지지발)의 클립 위치를 실제 그 발에 맞춘다 (비틀거림 뒤 넓게 선 자세에서 두 발 중점에 맞추면
      // 첫 스윙 때 COM이 지지발 바깥에 남아 옆으로 넘어졌다). 방향은 지금 골반 방향
      const sc = this.anim.getClip(startClip);
      const anchor = this.anchorFor(startClip, tau0);
      const endOf = (f: 'LeftFoot' | 'RightFoot') => { const ph = sc.footPhase(f, tau0); return ph.stance ? ph.tEnd : -Infinity; };
      const sup = endOf('LeftFoot') >= endOf('RightFoot') ? 'LeftFoot' : 'RightFoot';
      {
        const p0 = sc.poseAt(tau0);
        const fk0 = forwardKinematics(this.def, p0.joints, p0.root);
        const cf = rotate(fromAxisAngle([0, 1, 0], anchor.yaw), fk0[sc.footIdx[sup]]!.pos);
        const af = fp(sup);
        anchor.pos = [af[0] - cf[0], anchor.pos[1], af[2] - cf[2]];
      }
      this.anim.play(startClip, t, { anchor, startTime: tau0, blendTime: rc.blendTime });
      this.resumeTo = clip.name;
      this.walk.reset();
      this.walk.engaged = true;
      this.handoverT = null;
      this.emit({ t, type: 'walkResume', detail: `start ${startClip} tau=${tau0.toFixed(2)}` });
      return;
    }
    // 속도가 너무 다르면(멈춘 몸 ↔ 걷는 클립) 붙이지 않는다: 붙이자마자 DCM 오차로 다시 넘어간다 (걷기 시작 클립이 맡을 일)
    {
      const h = 1 / clip.fps;
      const pp = clip.poseAt(m.tau + h), pm = clip.poseAt(m.tau - h);
      const mmod = this.anim.mass;
      const comOf = (p: { joints: JointTargets; root: { pos: Vec3; rot: [number, number, number, number] } }): Vec3 => {
        const fk = forwardKinematics(this.def, p.joints, p.root);
        let c: Vec3 = [0, 0, 0], M = 0;
        fk.forEach((b, i) => { c = add(c, scale(add(b.pos, rotate(b.rot, mmod.localCom[i]!)), mmod.mass[i]!)); M += mmod.mass[i]!; });
        return scale(c, 1 / M);
      };
      const vc = rotate(fromAxisAngle([0, 1, 0], yaw), scale(sub(comOf(pp), comOf(pm)), 1 / (2 * h)));
      const v = this.rd.com().vel;
      const om = Math.sqrt(gravityMag / Math.max(0.3, this.rd.com().com[1] - (per.groundHeight ?? 0)));
      if (Math.hypot(v[0] - vc[0], v[2] - vc[2]) / om > rc.maxDcmError) return;
    }
    // 앵커: 클립 tau의 두 발 중점 ↔ 실제 두 발 중점 (걷는 방향은 처음 방향 유지)
    const anchor = this.anchorFor(clip.name, m.tau);
    anchor.yaw = yaw;
    const p = clip.poseAt(m.tau);
    const fk = forwardKinematics(this.def, p.joints, p.root);
    const cm = scale(add(fk[clip.footIdx.LeftFoot]!.pos, fk[clip.footIdx.RightFoot]!.pos), 0.5);
    const rcm = rotate(fromAxisAngle([0, 1, 0], yaw), [cm[0], 0, cm[2]]);
    const lf = fp('LeftFoot'), rf = fp('RightFoot');
    anchor.pos = [(lf[0] + rf[0]) / 2 - rcm[0], anchor.pos[1], (lf[2] + rf[2]) / 2 - rcm[2]];
    void hq;
    this.anim.jump(t, m.tau, anchor, rc.blendTime);
    this.walk.reset();
    this.walk.engaged = true;
    this.handoverT = null;
    this.emit({ t, type: 'walkResume', detail: `tau=${m.tau.toFixed(3)} cost=${m.cost.toFixed(3)}` });
  }

  /** 걷기 시작 클립 → 루프 클립 잇기 (v0.6): 시작 클립 기준 자세(발 접촉·두 발 위치·다리 관절·COM 속도)로 루프 클립 위상을 맞추고, 두 발 중점이 같게 앵커를 잡아 관성화로 넘어간다 */
  private chainResume(t: number): void {
    const clip = this.anim.clip;
    const rc = this.animCfg.resume;
    if (!clip || clip.loop || !this.resumeTo || this.anim.tau < clip.duration - (rc.chainBefore ?? 0.5)) return;
    const ref = this.anim.ref(t);
    if (!ref) return;
    const yaw = this.anim.anchor.yaw;
    const m = this.anim.matchPhase(this.resumeTo, {
      contact: { LeftFoot: ref.feet.LeftFoot.stance, RightFoot: ref.feet.RightFoot.stance },
      footPos: { LeftFoot: ref.feet.LeftFoot.pos, RightFoot: ref.feet.RightFoot.pos }, joints: ref.joints, comVel: ref.comVel, yaw,
    });
    const loop = this.anim.getClip(this.resumeTo);
    const p = loop.poseAt(m.tau);
    const fk = forwardKinematics(this.def, p.joints, p.root);
    const cm = scale(add(fk[loop.footIdx.LeftFoot]!.pos, fk[loop.footIdx.RightFoot]!.pos), 0.5);
    const rcm = rotate(fromAxisAngle([0, 1, 0], yaw), [cm[0], 0, cm[2]]);
    const lf = ref.feet.LeftFoot.pos, rf = ref.feet.RightFoot.pos;
    const anchor = { yaw, pos: [(lf[0] + rf[0]) / 2 - rcm[0], this.anim.anchor.pos[1], (lf[2] + rf[2]) / 2 - rcm[2]] as Vec3 };
    this.anim.play(this.resumeTo, t, { anchor, startTime: m.tau, blendTime: rc.blendTime });
    this.emit({ t, type: 'walkResume', detail: `chain ${this.resumeTo} tau=${m.tau.toFixed(3)} cost=${m.cost.toFixed(3)}` });
    this.resumeTo = null;
  }

  /**
   * (v0.8c) World가 스텝 뒤 부른다: 이번 스텝 다른 캐릭터·프롭 접촉. 합 충격량을 균형 계층에 외부 충격으로 알리고(측정 지면력 예측에서 빼서
   * 발바닥 압력처럼 즉시 알게 되지 않게 — 밀기와 같은 규칙), 감지 창이 끝난 접촉은 다음 스텝 시작에 피격으로 넣는다
   */
  _onContacts(t: number, contacts: StepContact[]): void {
    let J: Vec3 = [0, 0, 0];
    for (const c of contacts) J = add(J, c.J);
    if (length(J) > 0) this.balance.noteExternalImpulse(J);
    for (const h of this.contactSensor.update(t, contacts)) {
      const ic = h.kind === 'character' ? INTERACTION.character : INTERACTION.prop;
      // 느린 프롭(바닥의 상자를 차거나 그 위에 누움)은 날아온 충격이 아니라 장애물: hit을 만들지 않는다 (충격량은 위에서 균형 계층에 알렸다)
      if (h.kind === 'prop' && h.speed < INTERACTION.prop.minImpactSpeed) continue;
      this.pending.push({ hit: { type: ic.hitType, body: h.body, point: h.point, direction: h.direction, magnitude: h.dv, dv: h.dv }, sensed: h });
      this.lastSensed = { ...h, t };
    }
  }

  /** (v0.8c) 접촉 피격 뒤 의도 반응: 부딪힌 캐릭터를 돌아봄, 프롭에 맞은 자리를 손으로 누름 (config/interaction.json) */
  private reactToContact(t: number, h: SensedHit): void {
    if (this.behaviors.list.some((b) => b.name === 'Limp' && b.stopT === null)) return;
    // 팔이 부딪히면 팔 힘을 잠깐 뺀다 (흔들던 팔은 부딪히면 밀려난다 — 굳은 팔이 받은 충격을 몸통에 그대로 넘겨 걷기가 무너졌다; 손 밀기 22개 위상 중 넘어짐 4 → 1)
    const ay = INTERACTION.armYield;
    if (ay && h.dv >= ay.minDv) {
      const side = h.body.startsWith('Left') ? 'left' : h.body.startsWith('Right') ? 'right' : null;
      if (side && /(Arm|ForeArm|Hand)$/.test(h.body)) this.setMuscleScale(`${side}Arm`, ay.scale, ay.recover);
    }
    // 애니 추종 중 접촉으로 밀림: 서 있는 클립(Idle)이면 바로 균형·스텝 계층에 넘긴다(서서 밀린 몸은 v0.4 반응 스텝이 맡는다 — Idle 추종 QP는
    // DCM 오차 0.6m까지 버티다 넘겨 0.35 m/s 밀기에도 한 걸음 없이 넘어졌다). 걷는 클립이면 stopWalkDv 이상일 때만(두 발이 디딜 때) 넘긴다
    const ref = this.anim.clip && this.states.name === 'Active' ? this.anim.ref(t) : null;
    if (ref && this.walk.engaged && !this.contactHandover) {
      const standing = Math.hypot(ref.comVel[0], ref.comVel[2]) < INTERACTION.handover.standSpeed;
      const min = standing ? INTERACTION.handover.standDv : h.kind === 'character' ? INTERACTION.handover.walkDv : null;
      if (min !== null && h.dv >= min) this.contactHandover = { why: `contact ${h.source} ${h.dv.toFixed(2)}`, t, now: standing };
    }
    if (h.kind === 'character') {
      const la = INTERACTION.character.lookAt;
      if (la && h.dv >= (la.trunkMinDv !== undefined && la.trunkBodies?.includes(h.body) ? la.trunkMinDv : la.minDv) && this.world.character(h.source)) {
        const start = this.lookOther?.on && this.lookOther.source === h.source ? t : t + la.delay;
        this.lookOther = { source: h.source, start, end: t + la.delay + la.duration, on: this.lookOther?.on === true && this.lookOther.source === h.source };
      }
    } else {
      const hw = INTERACTION.prop.holdWound;
      if (hw && h.dv >= hw.minDv && hw.bodies.includes(h.body) && !this.behaviors.list.some((b) => b.name === 'HoldWound' && b.stopT === null)) {
        const rb = this.rd.body(h.body).rb, tr = rb.translation(), q = rb.rotation();
        const local = rotate([-q.x, -q.y, -q.z, q.w], sub(h.point, [tr.x, tr.y, tr.z]));
        this.trigger('HoldWound', { body: h.body, local, duration: hw.duration, delay: hw.delay });
      }
    }
  }

  private updateLookOther(t: number): void {
    const lo = this.lookOther!;
    const other = this.world.character(lo.source);
    if (!other || t >= lo.end) {
      if (lo.on) this.behaviors.trigger('LookAt', { target: null }, t);
      this.lookOther = null;
      return;
    }
    if (t < lo.start) return;
    const hp = other.rd.body('Head').rb.translation();
    const target: Vec3 = [hp.x, hp.y, hp.z];
    const cur = this.behaviors.list.find((b): b is LookAt => b.name === 'LookAt' && b.stopT === null) as LookAt | undefined;
    if (lo.on && cur) cur.target = target;
    else {
      this.behaviors.trigger('LookAt', { target }, t);
      lo.on = true;
    }
  }

  /** 7.1의 9단계: 안전 검사 */
  _postStep(): void {
    let nan = false;
    let worst = '';
    let over = '', overBody = -1;
    const dt = this.world.dt;
    this.rd.bodies.forEach((b, i) => {
      if (nan) return;
      const p = b.rb.translation(), q = b.rb.rotation(), lv = b.rb.linvel(), av = b.rb.angvel();
      const vals = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, lv.x, lv.y, lv.z, av.x, av.y, av.z];
      if (vals.some((x) => !Number.isFinite(x))) {
        nan = true;
        worst = `${b.name} NaN`;
        return;
      }
      // (v0.9, README 9f-5) 폭발 = 솔버가 보고한 속도와 이번 스텝 실제 자세 변화(차분 속도)가 둘 다 기준을 넘음.
      // 접촉이 시작되는 스텝에 보고 각속도만 한 스텝 튀고(위팔 107.7 rad/s) 실제로는 8.8 rad/s만 돈 뒤 다음 스텝 10.9로 돌아오는 경우가 있었다(퍼징)
      const g = this.lastGood[i]!;
      const l = Math.hypot(lv.x, lv.y, lv.z), a = Math.hypot(av.x, av.y, av.z);
      const fl = Math.hypot(p.x - g.t[0], p.y - g.t[1], p.z - g.t[2]) / dt;
      const fa = (2 * Math.acos(Math.min(1, Math.abs(q.x * g.r[0] + q.y * g.r[1] + q.z * g.r[2] + q.w * g.r[3])))) / dt;
      if (!over && Math.min(l, fl) > simCfg.safety.maxLinVel) { over = `${b.name} linVel ${l.toFixed(2)} (차분 ${fl.toFixed(2)})`; overBody = i; }
      if (!over && Math.min(a, fa) > simCfg.safety.maxAngVel) { over = `${b.name} angVel ${a.toFixed(2)} (차분 ${fa.toFixed(2)})`; overBody = i; }
    });
    if (!nan) worst = this.classifyOver(over, overBody);
    if (nan) {
      // 마지막 정상 자세로 되돌리고 속도를 0으로
      this.rd.bodies.forEach((b, i) => {
        const g = this.lastGood[i]!;
        b.rb.setTranslation({ x: g.t[0], y: g.t[1], z: g.t[2] }, true);
        b.rb.setRotation({ x: g.r[0], y: g.r[1], z: g.r[2], w: g.r[3] }, true);
        b.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      });
    } else this.saveGood();
    if (worst) {
      if (this.states.name === 'Animated') this.setBodiesKinematic(false);
      this.states.name = 'Ragdoll';
      this.states.trans = null;
      if (!this.exploded) {
        this.exploded = true;
        this.emit({ t: this.world.time, type: 'exploded', detail: worst });
      }
    }
    // (pres-1) 손가락 포즈: 행동·접촉 → 손마다 굽힘·벌림 (로그 전용)
    if (this.handPose.cfg.enabled) {
      const ground = this.perception().ground;
      const lying = [...ground].some((b) => !HAND_POSE_LIMB_ENDS.has(b));
      const hs = (h: 'LeftHand' | 'RightHand') => this.muscles.out(h).strength;
      this.handPose.update(this.world.dt, { t: this.world.time, bl: this.behaviors, ground, lying, state: this.stateName, handStrength: { LeftHand: hs('LeftHand'), RightHand: hs('RightHand') }, stepping: this.stepping.state.state === 'lift' || this.stepping.state.state === 'step' });
    }
  }

  /**
   * (v0.9, README 9f-11) 속도 초과(보고·차분 둘 다 기준 초과) 구간을 폭발과 충돌 튐으로 나눈다.
   * 폭발 = explodeSteps 스텝 연속 초과, 또는 초과 중 캐릭터 운동 에너지가 구간 직전보다 energyGrowth 넘게 늘어남(바깥 충격을 넣은 스텝 제외).
   * 그보다 짧게 끝나면 충돌 튐: 구간 직전부터 snapWindowSteps 스텝(렌더 한 프레임) 동안 그 바디가 부모 기준으로 돈 각을 재어 'collisionSnap' 이벤트(strength = 도)로 남긴다.
   * 돌려주는 값 = 폭발이면 상세, 아니면 ''.
   */
  private classifyOver(over: string, overBody: number): string {
    const sc = simCfg.safety;
    const step = this.world.physics.steps;
    const rel = this.rd.bodies.map((b) => {
      const q = b.rb.rotation(), qc: Quat = [q.x, q.y, q.z, q.w];
      if (b.parentIdx < 0) return qc;
      const p = this.rd.bodies[b.parentIdx]!.rb.rotation();
      return multiplyQ(conjugateQ([p.x, p.y, p.z, p.w]), qc);
    });
    let ke = 0, M = 0;
    const P: Vec3 = [0, 0, 0];
    for (const b of this.rd.bodies) {
      const v = b.rb.linvel(), w = b.rb.angvel(), m = b.rb.mass(), I = b.rb.principalInertia();
      ke += 0.5 * m * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * ((I.x + I.y + I.z) / 3) * (w.x * w.x + w.y * w.y + w.z * w.z);
      M += m; P[0] += m * v.x; P[1] += m * v.y; P[2] += m * v.z;
    }
    // 이 스텝에 물리적으로 들어올 수 있는 에너지 상한: 중력 일률 M·g·|v_COM| + 근육 최대 일률 (J)
    const gN = Math.hypot(...(simCfg.gravity as Vec3));
    const inflow = (M * gN * (Math.hypot(P[0], P[1], P[2]) / Math.max(1e-9, M)) + sc.musclePowerW) * this.world.dt;
    let worst = '';
    const run = this.overRun;
    const finish = (r: NonNullable<typeof run>) => {
      const deg = (angleBetweenQ(r.preRel, rel[r.body]!) * 180) / Math.PI;
      this.emit({ t: this.world.time, type: 'collisionSnap', body: this.rd.bodies[r.body]!.name, strength: Math.round(deg * 10) / 10, detail: `${r.desc} · ${r.n}스텝 · 운동 에너지 ×${r.ke0 > 0 ? (r.keMax / r.ke0).toFixed(2) : '-'}` });
      this.overRun = null;
    };
    if (over) {
      if (run && run.ended) finish(run);
      const r = this.overRun ?? (this.overRun = { n: 0, start: step, ke0: this.prevKE, keMax: 0, allow: 0, body: overBody, desc: over, preRel: this.prevRel[overBody] ?? rel[overBody]!, ended: false });
      r.n++;
      r.keMax = Math.max(r.keMax, ke);
      r.allow += inflow;
      // 바깥 충격(피격·폭발)을 넣은 스텝은 에너지 기준을 그 뒤 값으로 다시 잡는다 — 폭풍에 날아간 팔의 운동 에너지는 입력이지 솔버가 만든 것이 아니다
      if (this.extImpulseNow) { r.ke0 = Math.max(r.ke0, ke); r.allow = 0; }
      const grow = !this.extImpulseNow && r.ke0 > 0 && ke > r.ke0 * (1 + sc.energyGrowth) + r.allow;
      if (r.n >= sc.explodeSteps || grow) {
        worst = `${over} (${r.n}스텝 연속${grow ? `, 운동 에너지 ×${(ke / r.ke0).toFixed(2)}` : ''})`;
        this.overRun = null;
      }
    } else if (run) {
      run.ended = true;
      if (step - run.start + 1 >= sc.snapWindowSteps) finish(run);
    }
    this.prevKE = ke;
    this.prevRel = rel;
    return worst;
  }

  private saveGood(): void {
    this.lastGood = this.rd.bodies.map((b) => {
      const p = b.rb.translation(), q = b.rb.rotation();
      return { t: [p.x, p.y, p.z], r: [q.x, q.y, q.z, q.w] };
    });
  }

  // ── 조회 ──
  getState(): CharacterState {
    const step = this.world.physics.steps;
    if (this.cache && this.cache.step === step) return this.cache.state;
    const state = this.buildState();
    this.cache = { step, state };
    return state;
  }

  /** v0.6 로그: 애니 기준 자세(고스트 비교용), 걷기 추종, 핀, 상태 머신, 표시 블렌드. 애니 클립을 안 쓰면 비움(v0.5c 로그 그대로) */
  private animState(): Pick<CharacterState, 'anim' | 'walk' | 'pin' | 'states' | 'render'> {
    const t = this.world.time;
    if (!this.anim.clip && !this.states.trans && this.pin.strength === 0 && !this.switchJump) return {};
    const ref = this.anim.clip ? this.anim.ref(t) : null;
    const bodies = {} as Record<BodyName, { pos: Vec3; rot: [number, number, number, number] }>;
    if (ref) this.rd.bodies.forEach((b, i) => { bodies[b.name] = { pos: ref.bodies[i]!.pos, rot: ref.bodies[i]!.rot }; });
    const rw = this.states.renderW(t);
    return {
      anim: ref ? { clip: ref.clip, tau: ref.tau, phase: ref.phase, rate: this.anim.rate, blendDeg: ref.blendDeg, com: ref.com, bodies, feet: { LeftFoot: { stance: ref.feet.LeftFoot.stance, heelH: ref.feet.LeftFoot.heelH, toeH: ref.feet.LeftFoot.toeH }, RightFoot: { stance: ref.feet.RightFoot.stance, heelH: ref.feet.RightFoot.heelH, toeH: ref.feet.RightFoot.toeH } } } : null,
      walk: ref && this.stateName !== 'Animated' ? this.walk.state : null,
      pin: this.pin.state(),
      states: { ...this.states.log(t), switchJump: this.switchJump },
      render: ref && rw < 1 ? { w: rw } : null,
    };
  }

  /** v0.7 로그: 일어서기 상태. 한 번도 판정·시도하지 않았으면 비움(이전 로그 그대로) */
  private getupState(): Pick<CharacterState, 'getup'> {
    const g = this.getup;
    if ((!g.enabled || g.probe || g.settledSince === null) && g.phase === 'monitor' && g.attempts === 0 && g.last === null) return {};
    const posture = g.run ? null : g.settledSince !== null ? classifyFeature(poseFeature(this.def, this.bodyTransforms())) : null;
    const log: GetupLog = g.log(this.world.time, this.getupRefTau, this.getupAssist, posture);
    if (g.phase === 'rising' && this.getupQP.log) log.qp = this.getupQP.log;
    return { getup: log };
  }

  /** (v0.8c) 상호작용 로그 (다른 캐릭터·프롭이 있는 월드에서만 — 혼자인 캐릭터 로그는 그대로) */
  private interactionState(): Pick<CharacterState, 'interaction'> {
    if (!this.world.interactive) return {};
    const cs = this.contactSensor.last;
    let pen = 0;
    for (const c of cs) if (c.kind === 'character') pen = Math.max(pen, c.penetration);
    const ls = this.lastSensed;
    return {
      interaction: {
        name: this.name ?? '',
        contacts: cs.map((c) => ({ source: c.source, kind: c.kind, J: c.J, penetration: c.penetration, point: c.wsum > 0 ? scale(c.pointSum, 1 / c.wsum) : null })),
        penetration: pen,
        lastHit: ls ? { t: ls.t, source: ls.source, body: ls.body, dv: ls.dv, direction: ls.direction } : null,
        lookAt: this.lookOther?.on ? this.lookOther.source : null,
      },
    };
  }

  private buildState(): CharacterState {
    const rd = this.rd;
    const pw = this.world.physics;
    const bodies = {} as Record<BodyName, BodyState>;
    let maxAng = 0, maxLin = 0, maxAngBody = '';
    for (const b of rd.bodies) {
      const p = b.rb.translation(), q = b.rb.rotation(), lv = b.rb.linvel(), av = b.rb.angvel();
      bodies[b.name] = { pos: [p.x, p.y, p.z], rot: [q.x, q.y, q.z, q.w], linVel: [lv.x, lv.y, lv.z], angVel: [av.x, av.y, av.z] };
      const a = Math.hypot(av.x, av.y, av.z), l = Math.hypot(lv.x, lv.y, lv.z);
      if (a > maxAng) { maxAng = a; maxAngBody = b.name; }
      maxLin = Math.max(maxLin, l);
    }
    const { com, vel: comVel } = rd.com();

    // 지면 접촉·지지 다각형 (인지)
    const per = this.perception();
    const ground = per.ground;
    const left = ground.has('LeftFoot'), right = ground.has('RightFoot');
    const stance = left && right ? 'double' : left ? 'left' : right ? 'right' : 'none';
    // (v0.8a) 높이는 그 아래 지면 기준 (계단·모서리 위에서도 같은 판정). 평지는 지면 0 → 이전과 같은 값
    const gC = pw.flat ? 0 : pw.groundHeightAt(com[0], com[2]);
    const gH = pw.flat ? 0 : pw.groundHeightAt(bodies.Hips.pos[0], bodies.Hips.pos[2]);
    const h = Math.max(com[1] - gC, 1e-3);
    const w0 = Math.sqrt(h / gravityMag);
    const capturePoint: Vec2 = [com[0] + comVel[0] * w0, com[2] + comVel[2] * w0];

    // 자세
    const s2 = bodies.Spine2;
    const tilt = angleBetween(rotate(s2.rot, [0, 1, 0]), [0, 1, 0]) * DEG;
    const pr = classifyPosture({ ground, spine2TiltDeg: tilt, hipsHeight: bodies.Hips.pos[1] - gH, comHeight: com[1] - gC }, judge);

    // 관절
    const joints = {} as Record<JointName, JointState>;
    let maxViol = 0;
    for (const j of rd.joints) {
      const c = rd.coords(j);
      const viol = limitViolation(c, j.limits) * DEG;
      maxViol = Math.max(maxViol, viol);
      const mo = this.muscles.out(j.name);
      const w = rd.relAngVel(j);
      const tc = mo.targetCoords;
      joints[j.name] = {
        errorDeg: mo.errorDeg,
        torque: mo.torque,
        saturated: mo.saturated,
        strength: mo.strength,
        targetDeg: [tc[0] * DEG, tc[1] * DEG, tc[2] * DEG],
        relAngVelDegS: [w[0] * DEG, w[1] * DEG, w[2] * DEG],
        coordsDeg: [c[0] * DEG, c[1] * DEG, c[2] * DEG],
        violationDeg: viol,
        limitMarginDeg: limitSigned(c, j.limits, true) * DEG,
        limitApproachDegS: rd.limitApproachRate(j, c) * DEG,
        ...((j.name === 'LeftArm' || j.name === 'RightArm') && rd.shoulderRom[j.name] ? { rom: rd.shoulderRom[j.name] } : {}),
      };
    }

    // 자기 관통 (인접 쌍 제외, 최대 깊이)
    let selfPen = 0;
    for (const b of rd.bodies) for (const bc of b.cols) {
      pw.world.contactPairsWith(bc, (other) => {
        const oi = this.colliderIdx.get(other.handle);
        if (oi === undefined || oi <= b.idx || rd.adjacent.has(`${b.idx}|${oi}`)) return;
        pw.world.contactPair(bc, other, (m) => {
          for (let i = 0; i < m.numContacts(); i++) selfPen = Math.max(selfPen, -m.contactDist(i));
        });
      });
    }

    return {
      time: this.world.time,
      state: this.stateName,
      bodies,
      com,
      comVel,
      contacts: per.contacts,
      supportPolygon: per.supportPolygon,
      capturePoint,
      stance,
      posture: pr.posture,
      behaviors: this.behaviors.state.active.map((b) => ({ name: b.name, weight: b.weight })),
      behavior: this.behaviors.state,
      joints,
      assist: { root: this.rootAssist.usage, getup: this.getupAssist.usage, pin: this.pin.usage, ...(this.animOverridePin ? { animOverride: this.animOverridePin.usage } : {}) },
      ...(this.animOverridePin ? { animOverride: { weight: this.animOverrideW, usage: this.animOverridePin.usage, source: this.animOverrideSource, bodies: this.animOverridePin.state().bodies } } : {}),
      ...(this.ret ? { returnAnim: { phase: this.ret.phase, clip: this.ret.clip, requestT: this.ret.requestT, startT: this.ret.startT, kinT: this.ret.kinT, blendTime: this.ret.blendTime, pinTime: this.ret.pinTime, residualPos: this.ret.residualPos, residualDeg: this.ret.residualDeg, blockedBy: this.ret.blockedBy } } : {}),
      ...this.getupState(),
      ...(this.reaction.log.phase !== 'done' || this.reaction.log.reason ? { reaction: this.reaction.log } : {}),
      ...this.animState(),
      ...this.interactionState(),
      balance: this.balance.state,
      stepping: this.stepping.state,
      stepTargets: this.stepping.state.target ? [[this.stepping.state.target[0], this.stepping.state.target[2]]] : [],
      ...(this.handPose.cfg.enabled ? { fingers: this.handPose.log() } : {}),
      ...(this.breath.cfg.enabled ? { breath: this.breath.log() } : {}),
      ...(this.tone.cfg.enabled ? { tone: this.tone.log } : {}),
      ...(this.pushNow ? { push: this.pushNow } : {}),
      ...(this.behaviors.state.grab ? { grabTarget: this.behaviors.state.grab.hands.map((h) => h.anchor ?? h.target).find((p) => !!p) ?? null } : {}),
      debug: {
        spine2TiltDeg: tilt,
        maxAngVel: maxAng,
        maxAngVelBody: maxAngBody,
        maxLinVel: maxLin,
        maxLimitViolationDeg: maxViol,
        selfPenetration: selfPen,
        exploded: this.exploded ? 1 : 0,
        torqueSq: this.muscles.torqueSq,
        clip: this.clip?.clip.name ?? '',
        rootAssistForce: this.rootAssist.force,
        rootAssistTorque: this.rootAssist.torque,
      },
    };
  }
}
