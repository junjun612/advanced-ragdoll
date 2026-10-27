// 시나리오 형식 (SPEC 9.1)과 기대값 판정.
import type { HitInfo, SpawnOpts } from './api';
import type { StateName, Summary, Vec3, BodyName } from './types';
import type { TerrainName } from './world';
import type { PropDef } from './interaction';

/**
 * 시나리오 이벤트. (v0.8c) char = 받을 캐릭터 이름(여러 캐릭터 시나리오, 없으면 첫 캐릭터).
 * spawnProp = 그 시각에 프롭을 만든다(위치·속도·회전은 정의대로 — 떨어뜨리기·던지기)
 */
export type ScenarioEvent = { char?: string } & (
  | { t: number; type: 'spawnProp'; prop: PropDef }
  | { t: number; type: 'hit'; hit: HitInfo }
  | { t: number; type: 'setState'; state: StateName }
  /** v0.2: 영역 근육 배율 (SPEC 7.2 setMuscleScale) */
  | { t: number; type: 'setMuscleScale'; region: string; scale: number; recoverTime?: number }
  /** v0.2: 근육 목표 클립 (config/poses/<clip>.json) */
  | { t: number; type: 'playClip'; clip: string; startTime?: number }
  /** v0.2: 명시적 보조 켜기·끄기 */
  | { t: number; type: 'setAssist'; root?: boolean }
  /** v0.3: 균형 계층 켜기·끄기 */
  | { t: number; type: 'setBalance'; on: boolean }
  /** v0.4: 행동 트리거 (SPEC 7.2, 셋업용 LiftFoot) */
  | { t: number; type: 'trigger'; behavior: string; params?: Record<string, unknown> }
  /** v0.4: 스텝 계층 켜기·끄기 */
  | { t: number; type: 'setStepping'; on: boolean }
  /** v0.5a: 시선 대상 (SPEC 7.2 lookAt, null이면 끄기) */
  | { t: number; type: 'lookAt'; target: Vec3 | null }
  /** v0.7: 일어서기 켜기·끄기 (게임이 막음) */
  | { t: number; type: 'setGetup'; on: boolean });

/** (v0.8c) 두 번째 이후 캐릭터 (첫 캐릭터는 시나리오 최상위 character/spawn/clip/expect) */
export interface ExtraCharacter {
  name: string;
  /** 없으면 시나리오 character */
  character?: string;
  spawn: SpawnOpts;
  clip?: string | null;
  assist?: { root?: boolean };
  balance?: boolean;
  stepping?: boolean;
  getup?: boolean | { enabled?: boolean; probe?: boolean; only?: string };
  /** 이 캐릭터의 기대값 (없으면 확인 안 함) */
  expect?: Expect;
}

export interface Range {
  min?: number;
  max?: number;
}

export interface Expect {
  exploded?: boolean;
  fell?: boolean;
  kneeled?: boolean;
  /** (v0.5b) true면 kneeled 또는 fell 중 하나는 참이어야 함 (SPEC 9.2 shot_belly_clutch_kneel '`kneeled` true 또는 넘어짐') */
  kneeledOrFell?: boolean;
  /** firstGroundContact가 이 목록 중 하나여야 함 (v0.5b: 앞으로 넘어지면 손) */
  firstGroundContactIn?: BodyName[];
  /** firstGroundContact가 이 목록에 없어야 함 */
  firstGroundContactNot?: BodyName[];
  recoveredWithin?: number;
  steps?: [number, number];
  /** 넘어진 방향: 시작~끝 COM 수평 이동 방향과 dir 사이 각 ≤ maxAngleDeg */
  fallDirection?: { dir: Vec3; maxAngleDeg: number };
  metrics?: Record<string, Range>;
}

export interface Scenario {
  name: string;
  milestone: string;
  description?: string;
  duration: number;
  seed: number;
  terrain: TerrainName;
  character: string;
  spawn: SpawnOpts;
  /** 시작 목표 클립 (없으면 spawn.pose, 그것도 없으면 rest) */
  clip?: string | null;
  /** 시작 시 보조 (v0.2: 루트 보조). 없으면 config/assist.json 기본값 */
  assist?: { root?: boolean };
  /** 균형 계층 (v0.3). 없으면 config/balance.json enabledByDefault */
  balance?: boolean;
  /** 스텝 계층 (v0.4). 없으면 config/stepping.json enabledByDefault. 이전 마일스톤 단독 검증 시나리오는 false */
  stepping?: boolean;
  /**
   * 일어서기 (v0.7). 없으면 v0.7 이후 시나리오는 켜고, 그 전 마일스톤 시나리오는 끈다(그 마일스톤 기능 범위로 검증 — README 결정).
   * 객체면 시험 옵션 (CharacterOpts.getup)
   */
  getup?: boolean | { enabled?: boolean; probe?: boolean; only?: string };
  /**
   * (v0.7) 묶음 시나리오: 무작위 쓰러짐(src/sim/getupScenarios.ts) count개를 seedStart부터 돌린다(넘어지지 않은 시드는 건너뜀, 최대 maxTries개).
   * 요약 지표는 묶음 집계(getupSuccessCount 등). 각 실행 로그는 out/<이름>/runs/<시드>/
   */
  batch?: { kind: 'randomFalls'; count: number; seedStart: number; maxTries: number; duration: number; weights?: Record<string, number>; pushRange?: [number, number] };
  events: ScenarioEvent[];
  /** (v0.8c) 두 번째 이후 캐릭터. 있으면 첫 캐릭터 이름은 primaryName(기본 'A') */
  characters?: ExtraCharacter[];
  primaryName?: string;
  cameras: string[];
  reference?: string | null;
  /** 알려진 문제 (README 결정 번호와 한 줄). 있으면 sim:all이 실패를 회귀로 세지 않고 '알려진 문제' 절에 따로 보인다 */
  knownIssue?: string;
  expect: Expect;
}

const KNOWN = new Set(['exploded', 'fell', 'kneeled', 'kneeledOrFell', 'firstGroundContactIn', 'firstGroundContactNot', 'recoveredWithin', 'steps', 'fallDirection', 'metrics']);

/** 기대값을 확인해 실패 사유 목록을 돌려준다. 모르는 키는 실패로 친다(조용히 통과시키지 않는다). */
export function checkExpect(e: Expect, s: Summary): string[] {
  const f: string[] = [];
  for (const k of Object.keys(e)) if (!KNOWN.has(k) && !k.startsWith('$')) f.push(`unsupported expect key '${k}'`);
  const eq = (k: 'exploded' | 'fell' | 'kneeled') => {
    if (e[k] !== undefined && s[k] !== e[k]) f.push(`${k}: expected ${e[k]}, got ${s[k]}`);
  };
  eq('exploded');
  eq('fell');
  eq('kneeled');
  if (e.kneeledOrFell && !s.kneeled && !s.fell) f.push('kneeledOrFell: neither kneeled nor fell');
  if (e.firstGroundContactIn && (!s.firstGroundContact || !e.firstGroundContactIn.includes(s.firstGroundContact)))
    f.push(`firstGroundContact: ${s.firstGroundContact ?? 'none'} not in [${e.firstGroundContactIn.join(', ')}]`);
  if (e.firstGroundContactNot && s.firstGroundContact && e.firstGroundContactNot.includes(s.firstGroundContact))
    f.push(`firstGroundContact: ${s.firstGroundContact} is not allowed`);
  if (e.recoveredWithin !== undefined) {
    // 충격이 있으면 마지막 충격부터 잰다 (README 결정 37)
    const r = s.recoveredAfterHit ?? s.recoveredTime;
    if (r === null) f.push('recoveredWithin: never recovered');
    else if (r > e.recoveredWithin) f.push(`recoveredWithin: ${r.toFixed(2)} > ${e.recoveredWithin}`);
  }
  if (e.steps) {
    if (s.stepsTaken === null) f.push('steps: step counting not available');
    else if (s.stepsTaken < e.steps[0] || s.stepsTaken > e.steps[1]) f.push(`steps: ${s.stepsTaken} not in [${e.steps.join(', ')}]`);
  }
  if (e.fallDirection) {
    const d = s.fallDirection;
    if (!d) f.push('fallDirection: no horizontal COM movement');
    else {
      const t = e.fallDirection.dir;
      const n = Math.hypot(t[0], t[2]);
      const c = (d[0] * t[0] + d[2] * t[2]) / n;
      const ang = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
      if (ang > e.fallDirection.maxAngleDeg) f.push(`fallDirection: ${ang.toFixed(1)}° off (max ${e.fallDirection.maxAngleDeg}°)`);
    }
  }
  for (const [k, r] of Object.entries(e.metrics ?? {})) {
    const v = s.metrics[k];
    if (v === undefined) {
      f.push(`metrics.${k}: not computed`);
      continue;
    }
    if (r.min !== undefined && v < r.min) f.push(`metrics.${k}: ${v.toFixed(4)} < min ${r.min}`);
    if (r.max !== undefined && v > r.max) f.push(`metrics.${k}: ${v.toFixed(4)} > max ${r.max}`);
  }
  return f;
}
