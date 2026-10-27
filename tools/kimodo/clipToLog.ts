// 포즈 클립 → 필름 로그 (out/<name>/log.jsonl + meta.json + summary.json), 그리고 기존 `npm run film`으로 렌더.
// 사용법: npm run film:clip -- <clip> [--name <out 이름>] [--title <제목>] [--cycles <n>] [--no-render] [film 옵션: --fbx|--both|--camera ...]
//   <clip>: 파일 경로, 또는 assets/poses/<clip>.json, 또는 assets/poses/kimodo_<clip>.json
// 바디 상태는 우리 랙돌 설정(config/characters/xbot.json)으로 FK한 키네마틱 자세다(물리 아님). 상태 타입은 sim 계약(src/sim/types.ts)을 따른다.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CharacterState, Meta, Summary } from '../../src/sim/types';
import type { BodyName } from '../../src/sim/character/characterDef';
import { type Vec3, add, sub, scale } from '../../src/sim/math/vec3';
import { rotate } from '../../src/sim/math/quat';
import { convexHull, type Vec2 } from '../../src/sim/math/geometry';
import { ROOT, Rig, SIDES, loadDef, loadKimodoConfig, readJson, type BodyFrame } from './rig';
import { Soma, type SomaSkeleton } from './soma';
import { fromClipFrames, type PoseClipFile } from './toPoseClip';
import { applyX } from './loop';

export type LogState = Pick<CharacterState,
  'time' | 'state' | 'bodies' | 'com' | 'comVel' | 'contacts' | 'supportPolygon' | 'capturePoint' | 'stance' | 'posture' | 'behaviors' | 'assist' | 'debug'>;

/** SOMA 스켈레톤은 FK에 쓰지 않지만 Rig가 요구한다 (rest 보정 계산). 캐시된 응답 하나에서 읽는다 */
export function somaSkeleton(): SomaSkeleton {
  const p = join(ROOT, 'tools', 'kimodo', 'somaskel77.json');
  if (!existsSync(p)) throw new Error(`${p} 없음 (npm run kimodo:candidates가 처음 응답에서 만든다)`);
  return readJson<SomaSkeleton>(p);
}

export function resolveClipPath(arg: string): string {
  const cands = [resolve(arg), join(ROOT, 'assets', 'poses', `${arg}.json`), join(ROOT, 'assets', 'poses', `kimodo_${arg}.json`)];
  const p = cands.find((c) => existsSync(c));
  if (!p) throw new Error(`클립 없음: ${arg} (${cands.join(', ')})`);
  return p;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r4v = <T extends number[]>(v: T): T => v.map(r4) as T;

/** 클립 → 로그 상태들. 루프는 cycles번 반복 (kept면 loopRootDelta만큼 옮겨 가며) */
export function clipToStates(rig: Rig, clip: PoseClipFile, cycles = 1): LogState[] {
  const base = fromClipFrames(rig, clip);
  let frames: BodyFrame[] = base;
  if (clip.loop && cycles > 1) {
    frames = [];
    let cur = base;
    for (let c = 0; c < cycles; c++) {
      frames.push(...cur);
      if (clip.loopRootDelta) { const d = { yaw: clip.loopRootDelta.yaw, pos: clip.loopRootDelta.pos }; cur = cur.map((f) => applyX(d, f)); }
    }
  }
  const dt = 1 / clip.fps;
  const contactsAt = (t: number) => clip.frames[t % clip.frames.length]!.contacts;
  const states: LogState[] = [];
  let prev: { pos: Vec3[]; com: Vec3 } | null = null;
  frames.forEach((f, t) => {
    const pos = rig.positions(f);
    let com: Vec3 = [0, 0, 0];
    rig.bodies.forEach((b, i) => { com = add(com, scale(pos[i]!, b.massRatio)); });
    const comVel = prev ? scale(sub(com, prev.com), 1 / dt) : [0, 0, 0] as Vec3;
    const bodies = {} as CharacterState['bodies'];
    rig.bodies.forEach((b, i) => {
      const lv = prev ? scale(sub(pos[i]!, prev.pos[i]!), 1 / dt) : [0, 0, 0] as Vec3;
      bodies[b.name] = { pos: r4v(pos[i]!), rot: r4v(f.rot[i]!), linVel: r4v(lv), angVel: [0, 0, 0] };
    });
    const contacts: CharacterState['contacts'] = [];
    const cc = contactsAt(t);
    for (const side of SIDES) {
      const name = `${side}Foot` as const;
      if (!cc[name]) continue;
      const i = rig.idx(name);
      const s = rig.bodies[i]!.shape;
      if (s.type !== 'box') continue;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const p = add(pos[i]!, rotate(f.rot[i]!, [sx * s.halfExtents[0], -s.halfExtents[1], sz * s.halfExtents[2]]));
        contacts.push({ body: name, point: r4v(p), normal: [0, 1, 0], impulse: 0 });
      }
    }
    const left = !!cc.LeftFoot, right = !!cc.RightFoot;
    const w0 = Math.sqrt(Math.max(com[1], 0.05) / 9.81);
    states.push({
      time: r4(t * dt), state: 'Animated', bodies, com: r4v(com), comVel: r4v(comVel), contacts,
      supportPolygon: convexHull(contacts.map((c) => [c.point[0], c.point[2]] as Vec2)).map((v) => r4v(v)),
      capturePoint: r4v([com[0] + comVel[0] * w0, com[2] + comVel[2] * w0]),
      stance: left && right ? 'double' : left ? 'left' : right ? 'right' : 'none',
      posture: left || right ? 'standing' : 'airborne',
      behaviors: [], assist: { root: 0, getup: 0, pin: 0 }, debug: {},
    });
    prev = { pos, com };
  });
  return states;
}

export function writeLog(name: string, title: string, clip: PoseClipFile, states: LogState[]): string {
  const dir = join(ROOT, 'out', name);
  mkdirSync(dir, { recursive: true });
  const duration = r4((states.length - 1) / clip.fps);
  const meta: Meta = {
    scenario: title, milestone: 'kimodo', characterId: 'xbot', characterConfig: 'config/characters/xbot.json',
    logDt: r4(1 / clip.fps), duration, cameras: ['side'], events: [],
  };
  const summary: Omit<Summary, 'expectations'> = {
    scenario: title, milestone: 'kimodo', duration, exploded: false, explodedTime: null, fell: false, fallTime: null,
    kneeled: false, kneelTime: null, stepsTaken: null, recoveredTime: null, recoveredAfterHit: null, firstGroundContact: null,
    fallDirection: null, finalPosture: 'standing', metrics: {}, info: { source: clip.source },
  };
  writeFileSync(join(dir, 'log.jsonl'), states.map((s) => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

/** npm run film 실행 (렌더는 기존 도구 그대로) */
export function runFilm(name: string, filmArgs: string[]): void {
  const r = spawnSync('npx', ['tsx', 'tools/film.ts', name, ...filmArgs], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`film 실패: ${name}`);
}

export function filmClip(clipPath: string, o: { name?: string; title?: string; cycles?: number; render?: boolean; filmArgs?: string[] } = {}): string {
  const clip = readJson<PoseClipFile>(clipPath);
  const rig = new Rig(loadDef(), new Soma(somaSkeleton()), loadKimodoConfig());
  const name = o.name ?? basename(clipPath, '.json');
  const states = clipToStates(rig, clip, o.cycles ?? 1);
  const dir = writeLog(name, o.title ?? `${clip.name} (${clip.source})`, clip, states);
  if (o.render ?? true) runFilm(name, o.filmArgs ?? []);
  return dir;
}

function main(): void {
  const argv = process.argv.slice(2);
  let clip = '', name: string | undefined, title: string | undefined, cycles = 1, render = true;
  const filmArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--name') name = argv[++i];
    else if (a === '--title') title = argv[++i];
    else if (a === '--cycles') cycles = Number(argv[++i]);
    else if (a === '--no-render') render = false;
    else if (a === '--camera') filmArgs.push(a, argv[++i] ?? '');
    else if (a.startsWith('--')) filmArgs.push(a);
    else if (!clip) clip = a;
  }
  if (!clip) throw new Error('사용법: npm run film:clip -- <clip> [--name n] [--title t] [--cycles n] [--fbx|--both] [--camera side]');
  const dir = filmClip(resolveClipPath(clip), { name, title, cycles, render, filmArgs });
  console.log(dir);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
