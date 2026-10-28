// 앱의 시뮬레이션 호스트: World·캐릭터·프롭 수명, 실시간 누적 스텝(고정 1/120), 시나리오 재생, 대화형 입력, 근육 튜닝 반영.
// 시나리오는 러너와 같은 공용 함수(src/sim/scenarioPlayer.ts)로 재생한다 → 같은 시드·같은 프레임의 상태가 npm run sim 로그와 같다 (README 결정 app-1).
// sim 코드는 그대로 쓴다(Node와 같은 src/sim). three.js·DOM을 모른다.
// (v0.9) 공개 API(src/sim/api.ts)만 쓴다 — docs/API.md
import { World, type Character, type HitInfo, type MuscleConfig, type CharacterDef, type BodyName, type RagdollConfig, type Scenario, type CharacterState, type JointName, type Vec3, type TerrainName, type PropDef } from '../sim/api';
import { ScenarioPlayback, randomFallScenario } from '../sim/api';

export interface AppConfig {
  version: string;
  character: string;
  seed: number;
  spawn: { position: Vec3; yaw: number; state: 'Active' | 'Ragdoll' | 'Animated'; pose: string };
  rootAssist: boolean;
  getup: boolean;
  maxFrameDt: number;
  maxStepsPerFrame: number;
  speeds: number[];
  defaultSpeed: number;
  /** 패널 추천 장면 버튼 */
  showcase: { scenario: string; label: string }[];
  pushDefault: 'small' | 'medium' | 'large';
  pushMaxDv: number;
  pushDuration: number;
  pushMinDragPx: number;
  bulletDv: number;
  explosionDv: number;
  throwProp: { halfExtents: Vec3; mass: number; speed: number; spawnDistance: number; lift: number; spin: number };
  addCharacter: { distance: number; maxCharacters: number; names: string[] };
  walk: { start: string; loop: string; stop: string };
  terrains: TerrainName[];
  animOverride: { max: number; step: number };
  camera: { fovDeg: number; position: Vec3; target: Vec3 };
  perf: { windowSec: number; slowRatio: number };
  graph: { windowSec: number; sampleHz: number; comHeightMax: number; errorMaxDeg: number; assistMaxN: number };
  tuning: { kpScaleMin: number; kpScaleMax: number; gainRangeFactor: number; maxTorqueMax: number; zetaMax: number };
}

/** UI 영역 강도 슬라이더 (muscles.json regions 이름). 관절 강도 = 그 관절을 포함한 영역 값들의 곱 */
export const REGION_LABEL: [string, string][] = [
  ['all', '전신'], ['upperBody', '상체'], ['lowerBody', '하체'], ['torso', '몸통'], ['neck', '목'],
  ['leftArm', '왼팔'], ['rightArm', '오른팔'], ['leftLeg', '왼다리'], ['rightLeg', '오른다리'],
];

export interface PushInfo {
  body: BodyName;
  point: Vec3;
  direction: Vec3;
  dv: number;
  /** 충격량 크기 (N·s) = 총질량 × Δv */
  impulse: number;
}

/** 화면의 캐릭터 하나 */
export interface AppChar {
  ch: Character;
  /** 표시 이름 (A, B, …) */
  label: string;
  def: CharacterDef;
  /** 루트·핀·겟업·애니 강제 보조 사용량 적분 (N·s) */
  assistIntegral: number;
}

export class SimHost {
  world!: World;
  chars: AppChar[] = [];
  scenario: Scenario | null = null;
  /** 지금 재생 중인 시나리오 (묶음 시나리오면 첫 시드 실행) */
  played: Scenario | null = null;
  playback: ScenarioPlayback | null = null;
  /** 자유 실행 지형 */
  terrain: TerrainName = 'flat';
  readonly regionScale: Record<string, number> = Object.fromEntries(REGION_LABEL.map(([r]) => [r, 1]));
  rootAssist: boolean;
  /** 애니 강제 비율 (setAnimOverride, 모든 캐릭터) */
  animOverride = 0;
  /** 근육 튜닝을 바꿨는가 (바꾸면 시나리오 첫 캐릭터에도 쓴다 → sim 로그와 달라진다) */
  musclesDirty = false;
  /** 대화형 입력(밀기·총탄·캐릭터 추가 …)이 들어갔는가 → sim 로그와 달라진다 */
  interacted = false;
  lastPush: PushInfo | null = null;
  /** 실시간 대비 sim 속도 측정 (최근 perf.windowSec초) */
  private perfLog: { real: number; sim: number; ms: number }[] = [];
  private acc = 0;
  private generation = 0;
  private propSeq = 0;

  constructor(
    readonly defs: Readonly<Record<string, CharacterDef>>,
    readonly ragdoll: RagdollConfig,
    public muscleCfg: MuscleConfig,
    readonly cfg: AppConfig,
  ) {
    this.rootAssist = cfg.rootAssist;
  }

  get time(): number {
    return this.world.time;
  }

  get primary(): AppChar {
    return this.chars[0]!;
  }

  /** 시나리오 끝 (러너처럼 round(duration / dt) 스텝) */
  get scenarioDone(): boolean {
    return !!this.playback && this.playback.done;
  }

  /** 시나리오와 같은 결과인가 (튜닝·대화형 입력·애니 강제가 없음) */
  get faithful(): boolean {
    return !!this.playback && !this.musclesDirty && !this.interacted && this.animOverride === 0;
  }

  private defOf(name: string): CharacterDef {
    const d = this.defs[name];
    if (!d) throw new Error(`캐릭터 설정 없음: config/characters/${name}.json`);
    return d;
  }

  /** 월드를 새로 만든다 (리셋·시나리오 불러오기) */
  async reset(): Promise<void> {
    const gen = ++this.generation;
    const sc = this.scenario;
    let world: World, chars: AppChar[], playback: ScenarioPlayback | null = null, played: Scenario | null = null;
    if (sc) {
      // 묶음 시나리오(getup_random_x20): 러너는 시드를 차례로 돌려 넘어진 것만 모은다 → 앱은 첫 시드 실행을 재생한다
      const b = sc.batch;
      played = b ? randomFallScenario(b.seedStart, { weights: b.weights as never, duration: b.duration, name: `${sc.name}__${b.seedStart}`, pushRange: b.pushRange }) : sc;
      playback = await ScenarioPlayback.create(played, this.ragdoll, {
        character: this.defOf(played.character), characterConfig: `config/characters/${played.character}.json`,
        extraCharacters: played.characters?.map((c) => ({ def: this.defOf(c.character ?? played!.character), config: `config/characters/${c.character ?? played!.character}.json` })),
        // 근육 튜닝을 바꿨을 때만 첫 캐릭터에 넘긴다 (안 바꿨으면 러너와 같은 기본 설정)
        ...(this.musclesDirty ? { characterOpts: { muscles: this.muscleCfg } } : {}),
      });
      world = playback.world;
      chars = playback.characters.map((ch, i) => ({ ch, label: playback!.names[i] ?? 'A', def: i === 0 ? this.defOf(played!.character) : this.defOf(played!.characters![i - 1]!.character ?? played!.character), assistIntegral: 0 }));
    } else {
      world = await World.create({ seed: this.cfg.seed, terrain: this.terrain });
      const def = this.defOf(this.cfg.character);
      const ch = world.addCharacter(def, this.ragdoll, { ...this.cfg.spawn }, { name: this.cfg.addCharacter.names[0], muscles: this.muscleCfg, rootAssist: this.rootAssist, getup: this.cfg.getup });
      chars = [{ ch, label: ch.name ?? 'A', def, assistIntegral: 0 }];
    }
    if (gen !== this.generation) { world.free(); return; }
    this.world?.free();
    this.world = world;
    this.chars = chars;
    this.playback = playback;
    this.played = played;
    this.rootAssist = chars[0]!.ch.getAssist().root;
    this.acc = 0;
    this.lastPush = null;
    this.interacted = false;
    this.perfLog = [];
    this.propSeq = 0;
    if (!sc) this.applyRegionScales();
    if (this.animOverride > 0) for (const c of chars) c.ch.setAnimOverride(this.animOverride);
  }

  /** 실시간 dt(배속 반영된)를 누적해 고정 스텝을 돈다 (한 프레임 최대 maxStepsPerFrame). 돈 스텝 수 */
  advance(realDt: number, wallMs: () => number): number {
    if (this.scenarioDone) return 0;
    this.acc += realDt;
    let n = 0;
    const dt = this.world.dt;
    const t0 = wallMs();
    while (this.acc >= dt - 1e-12 && !this.scenarioDone && n < this.cfg.maxStepsPerFrame) {
      this.stepOnce();
      this.acc -= dt;
      n++;
    }
    // 못 따라가면(느림) 밀린 시간을 버린다 — 속도 표시가 실시간 대비 비율을 보여 준다
    if (this.acc > dt) this.acc = 0;
    const ms = wallMs() - t0;
    this.perfLog.push({ real: realDt, sim: n * dt, ms });
    let tot = 0;
    while (this.perfLog.length > 1 && (tot = this.perfLog.reduce((a, p) => a + p.real, 0)) > this.cfg.perf.windowSec) this.perfLog.shift();
    return n;
  }

  /** 최근 sim 시간 / 요청 시간 (1 = 배속대로 따라감), 스텝당 ms */
  perf(): { ratio: number; msPerStep: number } {
    const real = this.perfLog.reduce((a, p) => a + p.real, 0), sim = this.perfLog.reduce((a, p) => a + p.sim, 0), ms = this.perfLog.reduce((a, p) => a + p.ms, 0);
    const steps = sim / this.world.dt;
    return { ratio: real > 0 ? sim / real : 1, msPerStep: steps > 0 ? ms / steps : 0 };
  }

  /** 고정 스텝 하나 (시나리오면 러너와 같은 순서로 이벤트를 넣는다) */
  stepOnce(): void {
    if (this.playback) { if (!this.playback.stepOnce()) return; }
    else this.world.step();
    const dt = this.world.dt;
    for (const c of this.chars) {
      const a = c.ch.getState().assist;
      c.assistIntegral += (a.root + a.pin + a.getup + (a.animOverride ?? 0)) * dt;
    }
  }

  state(i = 0): CharacterState {
    return this.chars[i]!.ch.getState();
  }

  /** 밀기 (SPEC 7.2 hit, type push): 충격량 J = 총질량 × Δv × 방향을 지정 바디·지점에 다음 스텝에 가한다. */
  push(ci: number, body: BodyName, point: Vec3, direction: Vec3, dv: number): PushInfo {
    const dir = unit(direction);
    const c = this.chars[ci]!;
    c.ch.hit({ type: 'push', body, point, direction: dir, magnitude: dv, ...(this.cfg.pushDuration > 0 ? { duration: this.cfg.pushDuration } : {}) });
    this.interacted = true;
    this.lastPush = { body, point, direction: dir, dv, impulse: c.def.totalMass * dv };
    return this.lastPush;
  }

  /** 총탄·근접 타격 (맞은 점, 방향) */
  strike(ci: number, type: 'bullet' | 'melee', body: BodyName, point: Vec3, direction: Vec3, dv: number): HitInfo {
    const h: HitInfo = { type, body, point, direction: unit(direction), magnitude: dv };
    this.chars[ci]!.ch.hit(h);
    this.interacted = true;
    return h;
  }

  /** 폭발: 모든 캐릭터가 받는다 (magnitude = 1m 거리 Δv, 거리에 반비례 — 피격 모델) */
  explode(point: Vec3, dv: number): void {
    for (const c of this.chars) c.ch.hit({ type: 'explosion', point, direction: [0, 1, 0], magnitude: dv });
    this.interacted = true;
  }

  /** 프롭 던지기: from에서 to 쪽으로 상자를 던진다 */
  throwProp(from: Vec3, to: Vec3): PropDef {
    const p = this.cfg.throwProp;
    const d = unit([to[0] - from[0], to[1] - from[1] + p.lift, to[2] - from[2]]);
    const def: PropDef = {
      id: `app_throw_${++this.propSeq}`,
      shape: { type: 'box', halfExtents: [...p.halfExtents] as Vec3 },
      mass: p.mass,
      position: from,
      linVel: [d[0] * p.speed, d[1] * p.speed, d[2] * p.speed],
      angVel: [p.spin, 0, p.spin * 0.5],
    };
    this.world.addProp(def);
    this.interacted = true;
    return def;
  }

  /** 캐릭터 추가 (자유 실행·시나리오 모두). 이름 = 다음 글자 */
  addCharacter(position: Vec3, yaw: number): AppChar | null {
    if (this.chars.length >= this.cfg.addCharacter.maxCharacters) return null;
    const names = this.cfg.addCharacter.names;
    const used = new Set(this.chars.map((c) => c.label));
    const name = names.find((n) => !used.has(n)) ?? `P${this.chars.length + 1}`;
    const def = this.defOf(this.cfg.character);
    const ch = this.world.addCharacter(def, this.ragdoll, { ...this.cfg.spawn, position, yaw }, { name, getup: this.cfg.getup });
    if (this.animOverride > 0) ch.setAnimOverride(this.animOverride);
    const c: AppChar = { ch, label: name, def, assistIntegral: 0 };
    this.chars.push(c);
    this.interacted = true;
    return c;
  }

  /** 걷기 시작·정지 (Kimodo 클립 추종) */
  walk(ci: number, on: boolean): void {
    const c = this.chars[ci]!;
    const w = this.cfg.walk;
    if (c.ch.getState().state !== 'Active') c.ch.setState('Active');
    c.ch.playClip(on ? w.loop : w.stop);
    this.interacted = true;
  }

  /** (README 결정 game-1) 게임 애니(걷기 클립 키네마틱)로 돌려받기: when 'recovered'면 복귀 가능 시점까지 기다린다 */
  returnToAnim(ci: number, when: 'recovered' | 'now'): boolean {
    const c = this.chars[ci]!;
    this.interacted = true;
    return c.ch.returnToAnimation(this.cfg.walk.loop, { when });
  }

  setAnimOverride(w: number): void {
    this.animOverride = w;
    for (const c of this.chars) c.ch.setAnimOverride(w);
  }

  setRootAssist(on: boolean): void {
    this.rootAssist = on;
    this.primary.ch.setAssist({ root: on });
    if (this.playback) this.interacted = true;
  }

  setRegionScale(region: string, v: number): void {
    this.regionScale[region] = v;
    this.applyRegionScales();
    if (this.playback) this.interacted = true;
  }

  /** 관절 강도 명령 = 그 관절을 포함한 UI 영역 값의 곱 */
  jointScale(joint: JointName): number {
    let s = 1;
    for (const [r] of REGION_LABEL) if (this.muscleCfg.regions[r]?.includes(joint)) s *= this.regionScale[r] ?? 1;
    return s;
  }

  private applyRegionScales(): void {
    const ch = this.primary.ch;
    ch.setMuscleScales(Object.fromEntries(ch.muscleJoints().map((j) => [j, this.jointScale(j)])));
  }

  /** 근육 설정 바꾸기를 즉시 반영 (다음 스텝부터, 첫 캐릭터) */
  applyMuscleConfig(cfg: MuscleConfig = this.muscleCfg): void {
    this.muscleCfg = cfg;
    this.musclesDirty = true;
    this.primary.ch.setMuscleConfig(cfg);
  }
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
