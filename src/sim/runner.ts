// 시나리오 러너 (SPEC 9): 시나리오 하나를 돌려 로그·요약·메타를 만든다. 파일 쓰기는 tools/가 한다(sim은 Node API 없이 돈다).
// (v0.8c) 여러 캐릭터·프롭: 캐릭터마다 로그·요약을 따로 만든다(첫 캐릭터 = 기존 log.jsonl·summary.json, 나머지 = extraLogs·summary.others).
// 캐릭터 하나뿐인 시나리오는 이전과 같은 순서로 같은 호출을 한다(로그·요약 바이트 동일).
import simCfg from '../../config/sim.json';
import { World, type Character } from './api';
import type { CharacterDef } from './character/characterDef';
import type { RagdollConfig } from './character/ragdoll';
import type { CharacterOpts } from './api';
import { FrameLogger, stringifyRounded } from './logger';
import { SummaryBuilder } from './metrics/summary';
import { checkExpect, type Expect, type Scenario } from './scenario';
import type { Meta, Summary } from './types';
import { saveWorld, restoreWorld, type WorldSnapshot } from './snapshot';
import { scenarioCast, addCastMember, applyScenarioEvent, eventDue, sortedEvents } from './scenarioPlayer';

export interface RunResult {
  log: string;
  summary: Summary;
  meta: Meta;
  /** 스텝당 평균 ms (참고) */
  msPerStep: number;
  /** (v0.8c) 두 번째 이후 캐릭터 로그 (meta.characters의 log 파일 이름으로 쓴다) */
  extraLogs?: { name: string; file: string; log: string }[];
  /** (v0.8c) 프롭 로그 (로그 프레임마다 {time, props}) */
  propsLog?: string;
}

export interface RunInputs {
  scenario: Scenario;
  character: CharacterDef;
  characterConfig: string;
  ragdoll: RagdollConfig;
  /** (v0.8c) 두 번째 이후 캐릭터 정의 (scenario.characters 순서). 없으면 첫 캐릭터 정의 */
  extraCharacters?: { def: CharacterDef; config: string }[];
  /** 근육·보조·포즈 설정 바꾸기 (스윕·튜닝용, 첫 캐릭터) */
  characterOpts?: CharacterOpts;
  /** 물리 타임스텝 바꾸기 (스윕용, 기본 config/sim.json) */
  dt?: number;
  /** 성능 측정용 시계 (선택). 결과에는 영향 없음 */
  now?: () => number;
}

interface Slot {
  name: string | undefined;
  ch: Character;
  logger: FrameLogger;
  sb: SummaryBuilder;
  expect: Expect | undefined;
  def: CharacterDef;
  config: string;
}

/** 캐릭터 로그 파일 이름: 첫 캐릭터 log.jsonl, 나머지 log.<이름>.jsonl */
export const logFileOf = (name: string, primary: boolean): string => (primary ? 'log.jsonl' : `log.${name}.jsonl`);

/** (v0.9) 체크포인트: 시나리오 실행 중간 상태 (World 스냅샷 + 러너 상태). JSON으로 저장해 resumeScenario로 이어 돌린다 */
export interface RunCheckpoint {
  scenario: string;
  /** 이 스텝을 마친 뒤의 상태 (0 = 첫 스텝 전) */
  step: number;
  snapshot: WorldSnapshot;
}

export interface RunOptions {
  /** 이 스텝 번호들을 마친 직후 체크포인트를 만든다 (실행은 끝까지 계속한다). 0 = 0프레임 기록 뒤 첫 스텝 전 */
  checkpointAt?: readonly number[];
  onCheckpoint?: (cp: RunCheckpoint) => void;
  /** 캐릭터마다 리스너를 더 건다 (요약 리스너 뒤, 복원 뒤에도 다시 부른다). 듣기만 해야 한다 */
  listen?: (ch: Character, name: string | undefined) => void;
}

/** 러너 상태 (체크포인트에 World와 함께 저장한다) */
interface RunState {
  slots: Slot[];
  next: number;
  step: number;
  propLines: string[];
}


/** 요약이 듣는 캐릭터 이벤트 (등록 순서 고정 — 복원 뒤에도 같은 순서로 다시 건다) */
function wire(sl: Slot): void {
  const { ch, sb } = sl;
  ch.on('hit', (e) => sb.onEvent(e));
  ch.on('setMuscleScale', (e) => sb.onEvent(e));
  ch.on('step', (e) => sb.onEvent(e));
  ch.on('hitReacted', (e) => sb.onEvent(e));
  ch.on('walkHandover', (e) => sb.onEvent(e));
  ch.on('walkResume', (e) => sb.onEvent(e));
  for (const ev of ['getupStart', 'getupBalance', 'getupDone', 'getupFail', 'getupCancel', 'getupGiveUp'] as const) ch.on(ev, (e) => sb.onEvent(e));
}

export async function runScenario(inp: RunInputs, opts: RunOptions = {}): Promise<RunResult> {
  const sc = inp.scenario;
  const world = await World.create({ seed: sc.seed, terrain: sc.terrain, dt: inp.dt });
  try {
    // (app-1) 등장인물·이벤트는 앱과 같은 공용 함수 (src/sim/scenarioPlayer.ts)
    const specs = scenarioCast(sc, inp);
    const everySteps = Math.max(1, Math.round(1 / simCfg.logHz / world.dt));
    const slots: Slot[] = specs.map((sp) => {
      const ch = addCastMember(world, inp.ragdoll, sp);
      const logger = new FrameLogger(everySteps);
      const sb = new SummaryBuilder({ scenario: sc.name, milestone: sc.milestone, duration: sc.duration, totalMass: ch.totalMass(), terrain: sc.terrain });
      const sl = { name: sp.name, ch, logger, sb, expect: sp.expect, def: sp.def, config: sp.config };
      wire(sl);
      opts.listen?.(ch, sp.name);
      return sl;
    });
    const hasProps = [...sc.events].some((e) => e.type === 'spawnProp');
    const st: RunState = { slots, next: 0, step: 0, propLines: [] };
    // 0 프레임
    for (const sl of slots) {
      const s0 = sl.ch.getState();
      sl.sb.onState(s0, true);
      sl.logger.log(s0);
    }
    if (hasProps) st.propLines.push(propLine(world));
    return await loop(inp, world, st, opts);
  } finally {
    world.free();
  }
}

/** (v0.9) 체크포인트에서 이어 돌린다. inp는 체크포인트를 만든 실행과 같아야 한다 (시나리오 이벤트 목록을 다시 쓴다) */
export async function resumeScenario(inp: RunInputs, cp: RunCheckpoint, opts: RunOptions = {}): Promise<RunResult> {
  if (cp.scenario !== inp.scenario.name) throw new Error(`checkpoint is for scenario '${cp.scenario}', not '${inp.scenario.name}'`);
  const { world, extra } = await restoreWorld(cp.snapshot);
  try {
    const st = extra as RunState;
    for (const sl of st.slots) { wire(sl); opts.listen?.(sl.ch, sl.name); }
    return await loop(inp, world, st, opts);
  } finally {
    world.free();
  }
}

function propLine(world: World): string {
  return stringifyRounded({ time: world.time, props: world.props.map((p) => p.state()) });
}

async function loop(inp: RunInputs, world: World, st: RunState, opts: RunOptions): Promise<RunResult> {
  const sc = inp.scenario;
  const multi = !!sc.characters?.length;
  const dt = world.dt;
  const { slots } = st;
  const byName = (n: string | undefined): Character => {
    if (n === undefined) return slots[0]!.ch;
    const s = slots.find((x) => x.name === n);
    if (!s) throw new Error(`scenario ${sc.name}: unknown character '${n}' in event`);
    return s.ch;
  };
  const events = sortedEvents(sc);
  const hasProps = events.some((e) => e.type === 'spawnProp');
  const cps = new Set(opts.checkpointAt ?? []);
  const checkpoint = () => { if (cps.has(st.step)) opts.onCheckpoint?.({ scenario: sc.name, step: st.step, snapshot: saveWorld(world, st) }); };
  const totalSteps = Math.round(sc.duration / dt);
  const t0 = inp.now?.() ?? 0;
  checkpoint();
  while (st.step < totalSteps) {
    const step = ++st.step;
    // 이번 스텝 시작 시각(world.time)까지 온 이벤트를 넣는다
    while (st.next < events.length && eventDue(world, events[st.next]!)) applyScenarioEvent(world, byName, events[st.next++]!);
    world.step();
    for (const sl of slots) {
      const s = sl.ch.getState();
      const logStep = sl.logger.isLogStep(step);
      sl.sb.onState(s, logStep);
      if (logStep) sl.logger.log(s);
    }
    if (hasProps && slots[0]!.logger.isLogStep(step)) st.propLines.push(propLine(world));
    checkpoint();
  }
  const t1 = inp.now?.() ?? 0;
  const sums = slots.map((sl) => sl.sb.finish());
  const summary = sums[0]!;
  const failures = checkExpect(sc.expect, summary);
  if (multi) {
    // 다른 캐릭터 요약과 기대값 (실패 사유 앞에 이름)
    summary.others = {};
    slots.slice(1).forEach((sl, i) => {
      const s = sums[i + 1]!;
      const f = sl.expect ? checkExpect(sl.expect, s) : [];
      s.expectations = { passed: f.length === 0, failures: f };
      summary.others![sl.name!] = s;
      failures.push(...f.map((x) => `${sl.name}: ${x}`));
    });
  }
  summary.expectations = { passed: failures.length === 0, failures };
  const ch0 = slots[0]!.ch;
  const everySteps = Math.max(1, Math.round(1 / simCfg.logHz / dt));
  const meta: Meta = {
    scenario: sc.name,
    milestone: sc.milestone,
    characterId: inp.character.id,
    characterConfig: inp.characterConfig,
    logDt: everySteps * dt,
    duration: sc.duration,
    cameras: sc.cameras,
    terrain: sc.terrain,
    events: world.events,
    muscles: ch0.muscles.gains(),
    ...(multi ? { characters: slots.map((sl, i) => ({ name: sl.name!, log: logFileOf(sl.name!, i === 0), characterId: sl.def.id, characterConfig: sl.config })) } : {}),
    ...(hasProps ? { props: world.props.map((p) => p.meta), propsLog: 'props.jsonl' } : {}),
  };
  const ran = totalSteps;
  return {
    log: slots[0]!.logger.text(), summary, meta, msPerStep: ran ? (t1 - t0) / ran : 0,
    ...(multi ? { extraLogs: slots.slice(1).map((sl) => ({ name: sl.name!, file: logFileOf(sl.name!, false), log: sl.logger.text() })) } : {}),
    ...(hasProps ? { propsLog: st.propLines.join('\n') + '\n' } : {}),
  };
}
