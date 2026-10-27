// 시나리오 재생 공용 부품 (README 결정 app-1): 러너(src/sim/runner.ts)와 브라우저 앱(src/app)이 같은 함수로
// 캐릭터를 만들고 이벤트를 넣는다. 그래서 앱에서 본 장면 = npm run sim 로그 (같은 시드·같은 호출 순서 → 바이트 동일).
// three.js·DOM을 모른다.
import { World, type Character, type CharacterOpts, type SpawnOpts } from './api';
import type { CharacterDef } from './character/characterDef';
import type { RagdollConfig } from './character/ragdoll';
import type { Expect, Scenario, ScenarioEvent } from './scenario';
import { milestoneAtLeast } from './milestones';

/** 시나리오 등장인물 하나 (첫 캐릭터 = 시나리오 최상위, 나머지 = scenario.characters 순서) */
export interface CastMember {
  /** 여러 캐릭터 시나리오면 이름 (첫 캐릭터 primaryName 기본 'A'), 혼자면 undefined */
  name: string | undefined;
  def: CharacterDef;
  config: string;
  spawn: SpawnOpts;
  clip: string | null | undefined;
  opts: CharacterOpts;
  expect: Expect | undefined;
}

export interface CastInputs {
  character: CharacterDef;
  characterConfig: string;
  extraCharacters?: { def: CharacterDef; config: string }[];
  /** 첫 캐릭터 설정 덮어쓰기 (스윕·튜닝·앱 근육 튜닝) */
  characterOpts?: CharacterOpts;
}

const getupOf = (sc: Scenario, g: Scenario['getup']) => g ?? milestoneAtLeast(sc.milestone, '0.7');

/** 시나리오 → 등장인물 목록 (러너와 앱이 같은 옵션으로 만든다) */
export function scenarioCast(sc: Scenario, inp: CastInputs): CastMember[] {
  const multi = !!sc.characters?.length;
  const cast: CastMember[] = [
    { name: multi ? sc.primaryName ?? 'A' : undefined, def: inp.character, config: inp.characterConfig, spawn: sc.spawn, clip: sc.clip, expect: sc.expect,
      opts: { rootAssist: sc.assist?.root, balance: sc.balance, stepping: sc.stepping, getup: getupOf(sc, sc.getup), ...inp.characterOpts } },
    ...(sc.characters ?? []).map((c, i) => ({
      name: c.name, def: inp.extraCharacters?.[i]?.def ?? inp.character, config: inp.extraCharacters?.[i]?.config ?? inp.characterConfig, spawn: c.spawn, clip: c.clip, expect: c.expect,
      opts: { rootAssist: c.assist?.root, balance: c.balance, stepping: c.stepping, getup: getupOf(sc, c.getup) } as CharacterOpts,
    })),
  ];
  const names = cast.map((s) => s.name);
  if (multi && new Set(names).size !== names.length) throw new Error(`scenario ${sc.name}: duplicate character names ${names.join(', ')}`);
  return cast;
}

/** 등장인물 하나를 월드에 넣는다 (addCharacter + 시작 클립) */
export function addCastMember(world: World, ragdoll: RagdollConfig, m: CastMember): Character {
  const ch = world.addCharacter(m.def, ragdoll, m.spawn, m.name !== undefined ? { ...m.opts, name: m.name } : m.opts);
  if (m.clip) ch.playClip(m.clip);
  return ch;
}

/** 시나리오 이벤트를 시각 순으로 (같은 시각은 파일 순서 그대로 — 안정 정렬) */
export const sortedEvents = (sc: Scenario): ScenarioEvent[] => [...sc.events].sort((a, b) => a.t - b.t);

/** 이벤트를 받는 캐릭터 (char가 없으면 첫 캐릭터) */
export type CharacterByName = (name: string | undefined) => Character;

/** 시나리오 이벤트 하나를 넣는다 (스텝 시작 전) */
export function applyScenarioEvent(world: World, byName: CharacterByName, e: ScenarioEvent): void {
  if (e.type === 'spawnProp') { world.addProp(e.prop); return; }
  const ch = byName(e.char);
  if (e.type === 'hit') ch.hit(e.hit);
  else if (e.type === 'setState') ch.setState(e.state);
  else if (e.type === 'setMuscleScale') ch.setMuscleScale(e.region, e.scale, e.recoverTime);
  else if (e.type === 'playClip') ch.playClip(e.clip, { startTime: e.startTime });
  else if (e.type === 'setAssist') ch.setAssist({ root: e.root });
  else if (e.type === 'setBalance') ch.setBalance(e.on);
  else if (e.type === 'trigger') ch.trigger(e.behavior, e.params);
  else if (e.type === 'setStepping') ch.setStepping(e.on);
  else if (e.type === 'lookAt') ch.lookAt(e.target);
  else if (e.type === 'setGetup') ch.setGetup(e.on);
  else throw new Error(`unknown scenario event type '${(e as { type: string }).type}'`);
}

/** 이번 스텝 시작 시각(world.time)까지 온 이벤트인가 (러너와 같은 허용 오차) */
export const eventDue = (world: World, e: ScenarioEvent): boolean => e.t <= world.time + world.dt * 1e-6;

/**
 * 실시간 재생용 시나리오 진행기 (앱): 러너 loop와 같은 순서로 이벤트를 넣고 world.step()을 부른다.
 * 러너처럼 총 round(duration / dt) 스텝에서 멈춘다. 대화형 입력(밀기·캐릭터 추가 등)은 호출자가 스텝 사이에 직접 넣는다.
 */
export class ScenarioPlayback {
  readonly events: ScenarioEvent[];
  readonly totalSteps: number;
  step = 0;
  private next = 0;

  constructor(readonly world: World, readonly scenario: Scenario, readonly characters: Character[], readonly names: (string | undefined)[]) {
    this.events = sortedEvents(scenario);
    this.totalSteps = Math.round(scenario.duration / world.dt);
  }

  /** 시나리오 월드를 만든다 (World.create + 등장인물). 러너 runScenario와 같은 순서 */
  static async create(sc: Scenario, ragdoll: RagdollConfig, inp: CastInputs, dt?: number): Promise<ScenarioPlayback> {
    const world = await World.create({ seed: sc.seed, terrain: sc.terrain, dt });
    const cast = scenarioCast(sc, inp);
    const chars = cast.map((m) => addCastMember(world, ragdoll, m));
    return new ScenarioPlayback(world, sc, chars, cast.map((m) => m.name));
  }

  get done(): boolean {
    return this.step >= this.totalSteps;
  }

  byName: CharacterByName = (n) => {
    if (n === undefined) return this.characters[0]!;
    const i = this.names.indexOf(n);
    if (i < 0) throw new Error(`scenario ${this.scenario.name}: unknown character '${n}' in event`);
    return this.characters[i]!;
  };

  /** 고정 스텝 하나 (끝났으면 아무것도 안 함). 돈 스텝이면 true */
  stepOnce(): boolean {
    if (this.done) return false;
    this.step++;
    while (this.next < this.events.length && eventDue(this.world, this.events[this.next]!)) applyScenarioEvent(this.world, this.byName, this.events[this.next++]!);
    this.world.step();
    return true;
  }
}
