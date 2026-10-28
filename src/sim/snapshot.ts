// 직렬화 (SPEC 12 v0.9 "직렬화(상태 저장·복원)", docs/API.md, README 결정 9a-2).
// World 한 개의 전체 상태(Rapier 물리 + 행동·균형·스텝·클립 재생·반응 클립·겟업 등 모든 JS 상태)를 JSON으로 저장하고, 새 World로 복원한다.
// 복원한 World를 이어서 돌린 결과는 원래 실행과 바이트 단위로 같다 (tests/snapshot.test.ts).
//
// 방식: 일반 객체 그래프 직렬화.
// - Rapier: World.takeSnapshot() 바이트(base64). 복원 뒤 강체·콜라이더·관절 래퍼는 핸들로 새 월드의 것으로 다시 잇는다.
// - JS 상태: World에서 닿는 모든 객체를 같은 객체는 한 번만(공유·순환 보존) 표로 적는다. 클래스 인스턴스는 아래 등록표의 프로토타입으로 되살린다.
// - 정적 데이터(포즈·클립·겟업·반응 라이브러리, config/*.json 모듈)는 내용 대신 번호만 적는다. 같은 빌드에서만 복원할 수 있다(지문으로 확인).
// - 저장하지 않는 것: 이벤트 리스너(Character.on 콜백 — 복원 뒤 다시 등록한다), 접촉 거르기 훅(복원 때 다시 만든다).
// 저장은 읽기만 한다(게터를 부르지 않고 자기 속성만 읽는다) — 저장해도 시뮬레이션은 바뀌지 않는다.
import { R, initRapier, PhysicsWorld } from './world';
import type { CharacterDef } from './character/characterDef';
import { World, Character } from './api';
import { Prng } from './prng';
import { POSES } from './character/poseLibrary';
import { ANIM_CLIPS } from './character/animClips';
import { GETUP_LIBRARY } from './character/getupClips.generated';
import { REACTION_CLIPS } from './character/reactionClips.generated';
import { AnimClip, AnimDriver, Inertializer } from './character/animDriver';
import { RootAssist } from './character/assist';
import { Balance } from './character/balance';
import { AirMonitor, BlastStun, Flail, PrepareLanding, Roll } from './character/behaviors/air';
import { BehaviorBlender } from './character/behaviors/blender';
import { Kneel, Limp } from './character/behaviors/collapse';
import { BraceForFall, CatchFall, FallMonitor, ProtectHead } from './character/behaviors/fall';
import { BraceAgainstWall, Grab, GrabJoint, HangOnLedge } from './character/behaviors/grab';
import { HitReaction } from './character/behaviors/hitReaction';
import { HoldWound } from './character/behaviors/holdWound';
import { SmoothNoise } from './character/behaviors/noise';
import { InjuredLeg, LookAt, Stagger } from './character/behaviors/simple';
import { Misstep, StairStep, Trip, Tumble } from './character/behaviors/terrain';
import { Writhe } from './character/behaviors/writhe';
import { GetupAssist, GetupController, GetupLibrary, RootBlend } from './character/getup';
import { GetupQP } from './character/getupQP';
import { Muscles } from './character/muscles';
import { DelayLine } from './character/perception';
import { PinAssist } from './character/pin';
import { PoseClip } from './character/pose';
import { Ragdoll } from './character/ragdoll';
import { ReactionController, ReactionLibrary } from './character/reaction';
import { SettleController } from './character/settle';
import { PoweredStates } from './character/states';
import { Stepping } from './character/stepping';
import { WalkController } from './character/walk';
import { WholeBody } from './dynamics/wholeBody';
import { ContactSensor, Prop } from './interaction';
import { FrameLogger } from './logger';
import { AnimMetrics } from './metrics/animMetrics';
import { BehaviorMetrics } from './metrics/behaviorMetrics';
import { GetupMetrics } from './metrics/getupMetrics';
import { MuscleMetrics } from './metrics/muscleMetrics';
import { QualityMetrics } from './metrics/quality';
import { ReactionMetrics } from './metrics/reactionMetrics';
import { SummaryBuilder } from './metrics/summary';
import animDriverCfg from '../../config/animDriver.json';
import assistCfg from '../../config/assist.json';
import balanceCfg from '../../config/balance.json';
import behaviorsCfg from '../../config/behaviors.json';
import getupCfg from '../../config/getup.json';
import hitModelCfg from '../../config/hitModel.json';
import hitScaleCfg from '../../config/hitScale.json';
import interactionCfg from '../../config/interaction.json';
import milestonesCfg from '../../config/milestones.json';
import musclesCfg from '../../config/muscles.json';
import reactionCfg from '../../config/reaction.json';
import simCfg from '../../config/sim.json';
import steppingCfg from '../../config/stepping.json';

/** 스냅샷 형식 이름·판 (형식을 바꾸면 판을 올린다) */
export const SNAPSHOT_FORMAT = 'advanced-ragdoll/world-snapshot';
export const SNAPSHOT_VERSION = 1;

/** 값 인코딩: JSON 원시값 그대로, 그 밖은 표지 하나짜리 객체 */
export type Enc =
  | number | string | boolean | null
  | { $o: number } // 객체 표 번호
  | { $s: number } // 정적 데이터 번호
  | { $n: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { $u: 0 } // undefined
  | { $t: 0 } // 저장하지 않는 필드 자리 (TRANSIENT, 속성 순서 유지)
  | { $rb: number } | { $co: number } | { $ij: number } | { $rw: 0 }; // Rapier 강체·콜라이더·관절 핸들, Rapier 월드

/** 객체 표 항목 */
export type SnapNode =
  | { t: 'o'; c?: string; p: Record<string, Enc> } // 일반 객체 (c = 등록 클래스 이름, 'null' = 프로토타입 없음)
  | { t: 'a'; v: Enc[] }
  | { t: 'm'; v: [Enc, Enc][] }
  | { t: 's'; v: Enc[] }
  | { t: 'ta'; c: string; v: Enc[] }
  | { t: 'x'; c: keyof typeof REBUILD; a: Enc[] }; // 다시 계산하는 파생 데이터 (만든 인자만 저장, REBUILD)

/** World 스냅샷 (JSON으로 그대로 저장·전송할 수 있다) */
export interface WorldSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  /** 저장 시각 (s)·스텝 수 (참고) */
  time: number;
  steps: number;
  /** 정적 데이터 지문 (같은 빌드인지 확인) */
  statics: { count: number; hash: string };
  /** Rapier World.takeSnapshot() (base64) */
  physics: string;
  root: Enc;
  /** 함께 저장한 호출자 데이터 (runner 체크포인트 등). World 객체와 공유하는 객체는 공유한 채로 되살아난다 */
  extra?: Enc;
  objects: SnapNode[];
}

// ── 클래스 등록표 (키 = 이름. 축소 빌드에서도 같도록 객체 속성 이름으로 정한다) ──
// 새 클래스를 만들어 World에서 닿게 하면 여기에 넣는다 (없으면 save()가 이름과 경로를 알려 준다).
// (api.ts와 서로 import하므로 모듈 맨 위가 아니라 처음 쓸 때 만든다)
const classList = (): Record<string, { prototype: unknown }> => ({
  World, Character, PhysicsWorld, Prng, Prop, ContactSensor,
  AnimClip, AnimDriver, Inertializer, RootAssist, Balance, BehaviorBlender, AirMonitor, FallMonitor,
  BlastStun, Flail, PrepareLanding, Roll, Kneel, Limp, BraceForFall, CatchFall, ProtectHead, BraceAgainstWall, Grab, GrabJoint, HangOnLedge,
  HitReaction, HoldWound, SmoothNoise, InjuredLeg, LookAt, Stagger, Misstep, StairStep, Trip, Tumble, Writhe,
  GetupAssist, GetupController, GetupLibrary, RootBlend, GetupQP, Muscles, DelayLine, PinAssist, PoseClip, Ragdoll,
  ReactionController, ReactionLibrary, SettleController, PoweredStates, Stepping, WalkController, WholeBody,
  FrameLogger, AnimMetrics, BehaviorMetrics, GetupMetrics, MuscleMetrics, QualityMetrics, ReactionMetrics, SummaryBuilder,
});
/** Rapier 데이터 클래스 (wasm 객체를 갖지 않는 순수 JS 값): 일반 객체처럼 저장한다 */
const RAPIER_DATA = ['Vector3', 'Quaternion', 'Ray', 'Ball', 'Cuboid', 'RoundCuboid', 'Capsule', 'Cylinder', 'Cone', 'Segment', 'Triangle'] as const;
/** 저장하지 않는 필드 (클래스 이름 → 필드 → 복원 때 넣을 값) */
const TRANSIENT: Record<string, Record<string, () => unknown>> = {
  // 이벤트 콜백: 복원 뒤 호출자가 다시 등록한다
  Character: { listeners: () => new Map() },
  // 접촉 거르기 훅(클로저): World가 복원 뒤 다시 만든다 (World._afterRestore)
  PhysicsWorld: { hooks: () => null },
};
/**
 * 정적 데이터에서 다시 계산할 수 있는 큰 파생 객체: 내용 대신 만든 인자를 저장하고 복원 때 같은 생성자로 다시 만든다(같은 계산 → 같은 비트).
 * 반응 클립 라이브러리(48클립 특징)와 클립 캐시가 스냅샷의 대부분(36MB)이라 이렇게 둔다(결정 9a-2). 순서 = 복원 순서 (클립 먼저)
 */
const REBUILD = {
  /** 애니 클립 (AnimDriver.getClip 캐시와 같은 식): [그 클립을 가진 재생기, 이름] */
  AnimClip: (a: unknown[]) => { const d = a[0] as AnimDriver, name = a[1] as string; return new AnimClip({ ...d.library[name]!, name }, d.def, d.cfg.soleDownHeight); },
  /** 반응 클립 라이브러리 (Character.startReaction과 같은 식): [재생기, 정의, 질량 모델, 클립 이름들] */
  ReactionLibrary: (a: unknown[]) => new ReactionLibrary(a[0] as AnimDriver, a[1] as CharacterDef, a[2] as AnimDriver['mass'], a[3] as string[]),
};
const TYPED = { Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array } as const;

let registry: { byProto: Map<object, string>; byName: Map<string, object> } | null = null;
function classes() {
  if (registry) return registry;
  const byProto = new Map<object, string>(), byName = new Map<string, object>();
  for (const [k, c] of Object.entries(classList())) { byProto.set(c.prototype as object, k); byName.set(k, c.prototype as object); }
  const rx = R as unknown as Record<string, { prototype?: object }>;
  for (const k of RAPIER_DATA) { const p = rx[k]?.prototype; if (p) { byProto.set(p, 'R.' + k); byName.set('R.' + k, p); } }
  registry = { byProto, byName };
  return registry;
}

// ── 정적 데이터 (라이브러리·설정 모듈): 순서가 지문이다. 바꾸면 SNAPSHOT_VERSION을 올린다 ──
let statics: { ids: Map<object, number>; list: object[]; hash: string } | null = null;
function staticTable() {
  if (statics) return statics;
  const roots: unknown[] = [POSES, ANIM_CLIPS, GETUP_LIBRARY, REACTION_CLIPS, animDriverCfg, assistCfg, balanceCfg, behaviorsCfg, getupCfg, hitModelCfg, hitScaleCfg, interactionCfg, milestonesCfg, musclesCfg, reactionCfg, simCfg, steppingCfg];
  const ids = new Map<object, number>(), list: object[] = [];
  const h = new Hasher();
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') { h.value(v); return; }
    const known = ids.get(v);
    if (known !== undefined) { h.str('#' + known); return; }
    ids.set(v, list.length);
    list.push(v);
    if (Array.isArray(v)) { h.str('['); for (const x of v) visit(x); h.str(']'); return; }
    h.str('{');
    for (const k of Object.keys(v)) { h.str(k); visit((v as Record<string, unknown>)[k]); }
    h.str('}');
  };
  for (const r of roots) visit(r);
  statics = { ids, list, hash: h.hex() };
  return statics;
}

/** 정적 데이터 지문 (테스트: 시뮬레이션이 정적 데이터를 고치지 않는지 확인할 때 다시 계산한다) */
export function staticFingerprint(recompute = false): { count: number; hash: string } {
  if (recompute) statics = null;
  const s = staticTable();
  return { count: s.list.length, hash: s.hash };
}

/** FNV-1a 64비트 (32비트 두 개) — 문자열·숫자(비트 그대로) */
class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193 ^ 0x9e3779b9;
  private readonly f = new Float64Array(1);
  private readonly u = new Uint32Array(this.f.buffer);
  private mix(x: number): void {
    this.a = Math.imul(this.a ^ x, 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ ((x * 31) >>> 0), 0x01000193) >>> 0;
  }
  str(s: string): void { for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i)); this.mix(0xff); }
  value(v: unknown): void {
    if (typeof v === 'number') { this.f[0] = v; this.mix(this.u[0]!); this.mix(this.u[1]!); }
    else this.str(typeof v + ':' + String(v));
  }
  hex(): string { return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0'); }
}

// ── base64 (Node·브라우저 공통, 전역 API에 기대지 않는다) ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '=');
  }
  return s;
}
function fromBase64(s: string): Uint8Array {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  const val = (c: string) => { const i = B64.indexOf(c); if (i < 0) throw new Error(`snapshot: bad base64 character '${c}'`); return i; };
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (val(s[i]!) << 18) | (val(s[i + 1]!) << 12) | ((s[i + 2] === '=' ? 0 : val(s[i + 2]!)) << 6) | (s[i + 3] === '=' ? 0 : val(s[i + 3]!));
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ── 저장 ──
function encodeNumber(x: number): Enc {
  if (Number.isNaN(x)) return { $n: 'NaN' };
  if (x === Infinity) return { $n: 'Infinity' };
  if (x === -Infinity) return { $n: '-Infinity' };
  if (Object.is(x, -0)) return { $n: '-0' };
  return x;
}

class Encoder {
  readonly objects: SnapNode[] = [];
  private readonly ids = new Map<object, number>();
  private readonly path: string[] = [];
  private readonly reg = classes();
  private readonly st = staticTable();
  /** 재생기 캐시에 든 클립 → (재생기, 이름) */
  private readonly clipOwner = new Map<AnimClip, { driver: AnimDriver; name: string }>();
  constructor(private readonly rw: R.World, drivers: readonly AnimDriver[]) {
    for (const d of drivers) for (const [name, c] of (d as unknown as { clips: Map<string, AnimClip> }).clips) if (!this.clipOwner.has(c)) this.clipOwner.set(c, { driver: d, name });
  }

  private fail(msg: string): never {
    throw new Error(`snapshot: ${msg} at ${this.path.join('') || '(root)'}`);
  }

  enc(v: unknown): Enc {
    switch (typeof v) {
      case 'number': return encodeNumber(v);
      case 'string': case 'boolean': return v;
      case 'undefined': return { $u: 0 };
      case 'object': break;
      default: this.fail(`cannot save a ${typeof v}`);
    }
    if (v === null) return null;
    const o = v as object;
    const sid = this.st.ids.get(o);
    if (sid !== undefined) return { $s: sid };
    const known = this.ids.get(o);
    if (known !== undefined) return { $o: known };
    // Rapier 래퍼: 핸들만 (복원한 Rapier 월드에서 다시 찾는다)
    if (o instanceof R.RigidBody) return { $rb: o.handle };
    if (o instanceof R.Collider) return { $co: o.handle };
    if (o instanceof R.ImpulseJoint) return { $ij: o.handle };
    if (o instanceof R.World) { if (o !== this.rw) this.fail('a second Rapier world'); return { $rw: 0 }; }
    const id = this.objects.length;
    this.ids.set(o, id);
    this.objects.push(null as unknown as SnapNode); // 자리 (순환 참조가 같은 번호를 쓰게)
    this.objects[id] = this.node(o);
    return { $o: id };
  }

  private sub(key: string, v: unknown): Enc {
    this.path.push(key);
    const e = this.enc(v);
    this.path.pop();
    return e;
  }

  private node(o: object): SnapNode {
    if (Array.isArray(o)) {
      if (Object.keys(o).length !== o.length) this.fail('sparse array or array with extra properties');
      return { t: 'a', v: o.map((x, i) => this.sub(`[${i}]`, x)) };
    }
    if (o instanceof Map) return { t: 'm', v: [...o].map(([k, x], i) => [this.sub(`<key ${i}>`, k), this.sub(`<${String(k)}>`, x)] as [Enc, Enc]) };
    if (o instanceof Set) return { t: 's', v: [...o].map((x, i) => this.sub(`{${i}}`, x)) };
    if (ArrayBuffer.isView(o)) {
      const name = Object.entries(TYPED).find(([, C]) => o instanceof C)?.[0];
      if (!name) this.fail(`unsupported typed array ${o.constructor.name}`);
      const ta = o as unknown as ArrayLike<number> & ArrayBufferView;
      if (ta.byteOffset !== 0 || ta.byteLength !== ta.buffer.byteLength) this.fail('typed array view on a shared buffer');
      return { t: 'ta', c: name, v: Array.from(ta, encodeNumber) };
    }
    const own = o instanceof AnimClip ? this.clipOwner.get(o) : undefined;
    if (own) return { t: 'x', c: 'AnimClip', a: [this.sub('<driver>', own.driver), own.name] };
    if (o instanceof ReactionLibrary) return { t: 'x', c: 'ReactionLibrary', a: [this.sub('.anim', o.anim), this.sub('.def', o.def), this.sub('.mass', o.mass), this.sub('<names>', o.meta.map((m) => m.name))] };
    const proto = Object.getPrototypeOf(o) as object | null;
    let c: string | undefined;
    if (proto === null) c = 'null';
    else if (proto !== Object.prototype) {
      c = this.reg.byProto.get(proto);
      if (!c) this.fail(`unregistered class '${(proto as { constructor?: { name?: string } }).constructor?.name ?? '?'}' (add it to classList in src/sim/snapshot.ts)`);
    }
    const skip = c ? TRANSIENT[c] : undefined;
    const p: Record<string, Enc> = {};
    for (const k of Object.keys(o)) {
      if (skip && k in skip) { p[k] = { $t: 0 }; continue; }
      p[k] = this.sub('.' + k, (o as Record<string, unknown>)[k]);
    }
    if (Object.getOwnPropertySymbols(o).length) this.fail('symbol-keyed property');
    return c ? { t: 'o', c, p } : { t: 'o', p };
  }
}

/**
 * World 상태 저장. extra = 함께 저장할 호출자 데이터 (World에서 닿는 객체를 가리키면 공유 그대로 복원된다).
 * 이벤트 리스너는 저장하지 않는다.
 */
export function saveWorld(world: World, extra?: unknown): WorldSnapshot {
  const rw = world.physics.world;
  const e = new Encoder(rw, world.characters.map((c) => c.anim));
  const root = e.enc(world);
  const ex = extra === undefined ? undefined : e.enc(extra);
  const st = staticTable();
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    time: world.time,
    steps: world.physics.steps,
    statics: { count: st.list.length, hash: st.hash },
    physics: toBase64(rw.takeSnapshot()),
    root,
    ...(ex !== undefined ? { extra: ex } : {}),
    objects: e.objects,
  };
}

// ── 복원 ──
function decodeNumber(x: { $n: string }): number {
  switch (x.$n) {
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    case '-Infinity': return -Infinity;
    case '-0': return -0;
    default: throw new Error(`snapshot: bad number tag '${x.$n}'`);
  }
}

/** World 상태 복원: 새 World와 함께 저장한 extra를 돌려준다. 이벤트 리스너는 다시 등록한다 */
export async function restoreWorld(s: WorldSnapshot): Promise<{ world: World; extra: unknown }> {
  if (s.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot: not a world snapshot (format '${String(s.format)}')`);
  if (s.version !== SNAPSHOT_VERSION) throw new Error(`snapshot: version ${s.version} is not supported (this build reads ${SNAPSHOT_VERSION})`);
  const st = staticTable();
  if (s.statics.count !== st.list.length || s.statics.hash !== st.hash) {
    throw new Error(`snapshot: static data differs from this build (snapshot ${s.statics.count}/${s.statics.hash}, build ${st.list.length}/${st.hash}) — clip libraries or config/*.json changed`);
  }
  await initRapier();
  const rw = R.World.restoreSnapshot(fromBase64(s.physics));
  if (!rw) throw new Error('snapshot: Rapier could not restore the physics snapshot');
  const reg = classes();
  const live: unknown[] = new Array(s.objects.length);
  // 1) 빈 껍데기 (순환·공유 참조를 위해 먼저 모두 만든다)
  s.objects.forEach((n, i) => {
    if (n.t === 'a') live[i] = new Array(n.v.length);
    else if (n.t === 'm') live[i] = new Map();
    else if (n.t === 's') live[i] = new Set();
    else if (n.t === 'ta') {
      const C = TYPED[n.c as keyof typeof TYPED];
      if (!C) throw new Error(`snapshot: unknown typed array '${n.c}'`);
      live[i] = (C as unknown as Float64ArrayConstructor).from(n.v, (x: Enc) => (typeof x === 'number' ? x : decodeNumber(x as { $n: string })));
    } else if (n.t === 'x') {
      const proto = reg.byName.get(n.c);
      if (!proto || !(n.c in REBUILD)) throw new Error(`snapshot: unknown derived class '${n.c}'`);
      live[i] = Object.create(proto) as object;
    } else {
      const proto = n.c === undefined ? Object.prototype : n.c === 'null' ? null : reg.byName.get(n.c);
      if (proto === undefined) throw new Error(`snapshot: unknown class '${n.c}'`);
      live[i] = Object.create(proto) as object;
    }
  });
  const dec = (e: Enc): unknown => {
    if (e === null || typeof e !== 'object') return e;
    if ('$o' in e) return live[e.$o];
    if ('$s' in e) { const v = st.list[e.$s]; if (v === undefined) throw new Error(`snapshot: bad static id ${e.$s}`); return v; }
    if ('$n' in e) return decodeNumber(e);
    if ('$u' in e) return undefined;
    if ('$rb' in e) { const b = rw.getRigidBody(e.$rb); if (!b) throw new Error(`snapshot: rigid body ${e.$rb} missing`); return b; }
    if ('$co' in e) { const c = rw.getCollider(e.$co); if (!c) throw new Error(`snapshot: collider ${e.$co} missing`); return c; }
    if ('$ij' in e) { const j = rw.getImpulseJoint(e.$ij); if (!j) throw new Error(`snapshot: joint ${e.$ij} missing`); return j; }
    if ('$rw' in e) return rw;
    throw new Error(`snapshot: bad value ${JSON.stringify(e)}`);
  };
  // 2) 내용 채우기 (속성 순서 그대로)
  s.objects.forEach((n, i) => {
    const o = live[i];
    if (n.t === 'a') n.v.forEach((x, j) => { (o as unknown[])[j] = dec(x); });
    else if (n.t === 'm') for (const [k, x] of n.v) (o as Map<unknown, unknown>).set(dec(k), dec(x));
    else if (n.t === 's') for (const x of n.v) (o as Set<unknown>).add(dec(x));
    else if (n.t === 'o') {
      const rec = o as Record<string, unknown>;
      const tr = n.c ? TRANSIENT[n.c] : undefined;
      for (const [k, x] of Object.entries(n.p)) {
        if (x !== null && typeof x === 'object' && '$t' in x) {
          const make = tr?.[k];
          if (!make) throw new Error(`snapshot: field '${k}' of '${n.c ?? 'Object'}' was not saved`);
          rec[k] = make();
        } else rec[k] = dec(x);
      }
    }
  });
  // 3) 파생 데이터 다시 만들기 (껍데기에 채운다 — 이미 이 객체를 가리키는 참조가 그대로 맞다)
  for (const kind of Object.keys(REBUILD) as (keyof typeof REBUILD)[]) {
    s.objects.forEach((n, i) => {
      if (n.t !== 'x' || n.c !== kind) return;
      Object.assign(live[i] as object, REBUILD[kind](n.a.map(dec)));
    });
  }
  const world = dec(s.root);
  if (!(world instanceof World)) throw new Error('snapshot: root is not a World');
  world._afterRestore();
  return { world, extra: s.extra === undefined ? undefined : dec(s.extra) };
}
