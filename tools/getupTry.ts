// 겟업 클립 하나를 쓰러진 자세 하나에서 물리로 시험한다 (v0.7 디버그·라이브러리 시험).
// 사용법: npx tsx tools/getupTry.ts <out 이름> --clip <클립 json> --pose <out/시나리오 이름 | 자세 json> [--duration 9] [--film]
// 자세: out/<시나리오>/log.jsonl 마지막 프레임 바디, 또는 { bodies: [{pos,rot}...] } json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScenario } from '../src/sim/runner';
import { loadInputs } from './simCommon';
import { stringifyRounded } from '../src/sim/logger';
import type { Scenario } from '../src/sim/scenario';
import type { AnimClipFile } from '../src/sim/character/animDriver';
import type { GetupConfig, GetupEntry, GetupLibraryData } from '../src/sim/character/getup';
import { classifyFeature, poseFeature } from '../src/sim/character/getupFeatures';
import { clipFK } from './kimodo/getupLib';
import type { CharacterDef } from '../src/sim/character/characterDef';
import type { Vec3 } from '../src/sim/math/vec3';
import type { Quat } from '../src/sim/math/quat';

export type Pose = { pos: Vec3; rot: Quat }[];

export function poseFromOut(def: CharacterDef, scen: string, at?: number): Pose {
  const lines = readFileSync(join('out', scen, 'log.jsonl'), 'utf8').trim().split('\n');
  let s = JSON.parse(lines.at(-1)!) as { time: number; bodies: Record<string, { pos: Vec3; rot: Quat }> };
  if (at !== undefined) for (const l of lines) { const x = JSON.parse(l) as typeof s; if (x.time >= at - 1e-6) { s = x; break; } }
  return def.bodies.map((b) => ({ pos: s.bodies[b.name]!.pos, rot: s.bodies[b.name]!.rot }));
}

/** 클립 파일들 → 라이브러리 (시험용: 성공률 1, 특징은 클립 0프레임) */
export function libraryOf(def: CharacterDef, clips: { file: AnimClipFile; balanceTau: number; feetTau?: number }[]): GetupLibraryData {
  const entries: GetupEntry[] = clips.map(({ file, balanceTau, feetTau }) => {
    const feat = poseFeature(def, clipFK(def, file)[0]!);
    return { id: file.name, clip: file.name, path: '', rep: file.name, posture: classifyFeature(feat), feature: feat, successRate: 1, balanceTau, feetTau: feetTau ?? balanceTau };
  });
  return { entries, clips: Object.fromEntries(clips.map((c) => [c.file.name, c.file])) };
}

export interface TryResult { why: string; steps: number; balanceT: number | null; vAtBalance: number | null; done: boolean; standing: boolean; doneT: number | null; startT: number | null; assist: number; assistPeak: number; attempts: number; fails: number; exploded: boolean; finalHipsY: number }

/** 쓰러진 자세 + 라이브러리로 duration초 돌린다 */
export async function tryGetup(o: { name: string; pose: Pose; library: GetupLibraryData; duration?: number; seed?: number; only?: string; write?: boolean; extraEvents?: Scenario['events']; cfg?: GetupConfig }): Promise<TryResult> {
  const sc: Scenario = {
    name: o.name, milestone: '0.7', duration: o.duration ?? 9, seed: o.seed ?? 1, terrain: 'flat', character: 'xbot',
    spawn: { position: [0, 0, 0], yaw: 0, state: 'Active', bodies: o.pose }, clip: 'stand', assist: { root: false },
    getup: o.only ? { only: o.only } : true, events: o.extraEvents ?? [], cameras: ['side', 'front'], expect: {},
  };
  const inp = loadInputs(sc);
  const res = await runScenario({ ...inp, characterOpts: { getupLibrary: o.library, ...(o.cfg ? { getupConfig: o.cfg } : {}) } });
  const ev = res.meta.events;
  const done = ev.find((e) => e.type === 'getupDone');
  const start = ev.find((e) => e.type === 'getupStart');
  const s = res.summary;
  if (o.write !== false) {
    const dir = join('out', o.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), res.log);
    writeFileSync(join(dir, 'summary.json'), stringifyRounded(s, 2) + '\n');
    writeFileSync(join(dir, 'meta.json'), stringifyRounded(res.meta, 2) + '\n');
  }
  const lastLine = res.log.trim().split('\n').at(-1)!;
  const last = JSON.parse(lastLine) as { bodies: { Hips: { pos: Vec3 } } };
  const bal = ev.find((e) => e.type === 'getupBalance');
  let vAtBalance: number | null = null;
  if (bal) for (const l of res.log.trim().split(String.fromCharCode(10))) { const x = JSON.parse(l) as { time: number; comVel: Vec3 }; if (x.time >= bal.t - 1e-6) { vAtBalance = Math.hypot(x.comVel[0], x.comVel[2]); break; } }
  return {
    why: ev.find((e) => e.type === 'getupFail' || e.type === 'getupGiveUp')?.detail?.split(' ')[0] ?? (done ? (s.finalPosture === 'standing' ? 'ok' : 'fellAfterDone') : bal ? 'notDone' : 'noBalance'),
    steps: ev.filter((e) => e.type === 'step' && (!bal || e.t >= bal.t)).length, balanceT: bal ? bal.t - (start?.t ?? 0) : null, vAtBalance,
    done: !!done, standing: s.finalPosture === 'standing', doneT: done ? done.t : null, startT: start ? start.t : null,
    assist: s.metrics['assistUsage.getup'] ?? 0, assistPeak: s.metrics.getupAssistPeakBW ?? 0,
    attempts: ev.filter((e) => e.type === 'getupStart').length, fails: ev.filter((e) => e.type === 'getupFail' || e.type === 'getupGiveUp').length,
    exploded: s.exploded, finalHipsY: last.bodies.Hips.pos[1],
  };
}

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const name = a[0]!;
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const def = loadInputs({ character: 'xbot' } as Scenario).character;
  const clipPaths = a.filter((_, i) => a[i - 1] === '--clip');
  const clips = clipPaths.map((p) => {
    const file = JSON.parse(readFileSync(p, 'utf8')) as AnimClipFile & { info?: { getup?: { balanceTau?: number; feetTau?: number } } };
    file.name = file.name || basename(p, '.json');
    return { file, balanceTau: file.info?.getup?.balanceTau ?? (file.frames.length - 1) / file.fps, feetTau: file.info?.getup?.feetTau };
  });
  const poseArg = get('--pose')!;
  const pose = existsSync(poseArg) ? (JSON.parse(readFileSync(poseArg, 'utf8')) as { bodies: Pose }).bodies : poseFromOut(def, poseArg, get('--at') ? Number(get('--at')) : undefined);
  const r = await tryGetup({ name, pose, library: libraryOf(def, clips), duration: Number(get('--duration') ?? 9) });
  console.log(JSON.stringify(r));
  if (a.includes('--film')) spawnSync('npx', ['tsx', 'tools/film.ts', name, '--both', '--camera', get('--camera') ?? 'side', '--compare', 'anim'], { stdio: 'inherit', shell: true });
}

if (process.argv[1] && basename(process.argv[1]).startsWith('getupTry')) main().catch((e: unknown) => { console.error(e); process.exit(1); });
