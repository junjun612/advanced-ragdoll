// air_study (v0.5c) 레퍼런스 수치: 바닥 몸부림 관절 각속도, 폭발 비행·착지·구름.
// 사용법: npx tsx tools/kimodo/airStats.ts writhe <clip.json>... [--last <초>: 끝 N초 중 누운 프레임만]   |   npx tsx tools/kimodo/airStats.ts thrown <clip.json> [pushFrame=30]
import type { Quat } from '../../src/sim/math/quat';
import { angleBetweenQ, rotate, twistAngle, multiplyQ, inverseQ, toRotationVector } from '../../src/sim/math/quat';
import { forwardKinematics } from '../../src/sim/character/pose';
import type { JointTargets } from '../../src/sim/character/pose';
import { loadDef, readJson } from './rig';
import type { PoseClipFile } from './toPoseClip';

type V3 = [number, number, number];
const DEG = 180 / Math.PI;
const def = loadDef();
const names = def.bodies.map((b) => b.name);
const bi = (n: string) => names.indexOf(n as never);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

function load(p: string) {
  const clip = readJson<PoseClipFile>(p);
  const fk = clip.frames.map((f) => forwardKinematics(def, f.joints as JointTargets, { pos: f.root.pos as V3, rot: f.root.rot as Quat }));
  return { clip, fk, fps: clip.fps };
}

const jointNames = (clip: PoseClipFile) => Object.keys(clip.frames[0]!.joints);
const angSpeed = (a: Quat, b: Quat, fps: number) => angleBetweenQ(a, b) * DEG * fps;
const flexDeg = (q: Quat) => twistAngle(q, [1, 0, 0]) * DEG;

function writhe(p: string, lastS = 0) {
  const { clip, fps } = load(p);
  const F = clip.frames;
  const lying = F.map((f, t) => (f.root.pos[1] < 0.45 && (lastS <= 0 || t >= F.length - 1 - lastS * fps) ? t : -1)).filter((t) => t >= 0 && t < F.length - 1);
  if (lying.length < fps) return { path: p, lyingS: r2(lying.length / fps), lies: false };
  const js = jointNames(clip);
  const perJoint: Record<string, number> = {};
  for (const j of js) perJoint[j] = mean(lying.map((t) => angSpeed((F[t]!.joints as Record<string, Quat>)[j]!, (F[t + 1]!.joints as Record<string, Quat>)[j]!, fps)));
  const allMean = mean(lying.map((t) => mean(js.map((j) => angSpeed((F[t]!.joints as Record<string, Quat>)[j]!, (F[t + 1]!.joints as Record<string, Quat>)[j]!, fps)))));
  const hsp = (t: number, k: number) => { const a = F[t]!.root.pos, b = F[Math.min(F.length - 1, t + k)]!.root.pos; return Math.hypot(b[0] - a[0], b[2] - a[2]) * fps / k; };
  const rootAng = mean(lying.map((t) => angSpeed(F[t]!.root.rot as Quat, F[t + 1]!.root.rot as Quat, fps)));
  const g = (ks: string[]) => r1(mean(ks.map((k) => perJoint[k]!)));
  return {
    path: p, lies: true, lyingS: r2(lying.length / fps), lyingFromS: r2(lying[0]! / fps),
    meanJointAngSpeedDegS: r1(allMean),
    hipsUpLeg: g(['LeftUpLeg', 'RightUpLeg']), knees: g(['LeftLeg', 'RightLeg']),
    arms: g(['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm']), hands: g(['LeftHand', 'RightHand']),
    spine: g(['Spine', 'Spine2']), head: g(['Head']), pelvisRotDegS: r1(rootAng),
    maxHipsHorizSpeedRaw: r2(Math.max(...lying.map((t) => hsp(t, 1)))),
    maxHipsHorizSpeed6f: r2(Math.max(...lying.map((t) => hsp(t, 6)))),
    hipsHeightMean: r2(mean(lying.map((t) => F[t]!.root.pos[1]))),
    hipFlexDeg: r1(mean(lying.flatMap((t) => ['LeftUpLeg', 'RightUpLeg'].map((j) => flexDeg((F[t]!.joints as Record<string, Quat>)[j]!))))),
    kneeFlexDeg: r1(mean(lying.flatMap((t) => ['LeftLeg', 'RightLeg'].map((j) => flexDeg((F[t]!.joints as Record<string, Quat>)[j]!))))),
  };
}

function thrown(p: string, push = 30) {
  const { clip, fk, fps } = load(p);
  const F = clip.frames;
  const hipsY = F.map((f) => f.root.pos[1]);
  const upper = ['Hips', 'Spine', 'Spine2', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'].map(bi);
  // 비발 접지: 상체·팔 바디 원점이 0.15m 아래 (캡슐 반지름 정도)
  const firstLow = fk.findIndex((tf, t) => t >= push && upper.some((i) => tf[i]!.pos[1] < 0.15));
  const firstHipsLow = hipsY.findIndex((y, t) => t >= push && y < 0.35);
  let minT = push; for (let t = push; t < F.length; t++) if (hipsY[t]! < hipsY[minT]!) minT = t;
  const peakY = Math.max(...hipsY.slice(push));
  const hsp = (t: number, k = 3) => { const a = F[Math.max(0, t - k)]!.root.pos, b = F[Math.min(F.length - 1, t + k)]!.root.pos; return Math.hypot(b[0] - a[0], b[2] - a[2]) * fps / (Math.min(F.length - 1, t + k) - Math.max(0, t - k)); };
  // 골반 피치 누적: Hips 월드 각속도의 X(옆) 성분 적분
  let pitch = 0, maxAbsPitch = 0;
  for (let t = push; t < F.length - 1; t++) {
    const w = toRotationVector(multiplyQ(fk[t + 1]![0]!.rot, inverseQ(fk[t]![0]!.rot)));
    pitch += w[0] * DEG; maxAbsPitch = Math.max(maxAbsPitch, Math.abs(pitch));
  }
  const fwd0 = rotate(fk[0]![0]!.rot, [0, 0, 1]);
  const flip = fk.some((tf, t) => t >= push && rotate(tf[0]!.rot, [0, 0, 1])[1] < -0.7);
  const up = fk.map((tf) => rotate(tf[0]!.rot, [0, 1, 0]));
  const invertedT = up.findIndex((u, t) => t >= push && u[1] < -0.5);
  // 팔: 상완 방향(Arm→ForeArm 원점)과 Spine2 아래축 사이 각
  const armAng = (tf: typeof fk[0], s: 'Left' | 'Right') => {
    const a = tf[bi(`${s}Arm`)]!.pos, b = tf[bi(`${s}ForeArm`)]!.pos;
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const n = Math.hypot(...d);
    const down = rotate(tf[bi('Spine2')]!.rot, [0, -1, 0]);
    return Math.acos(Math.max(-1, Math.min(1, (d[0] * down[0] + d[1] * down[1] + d[2] * down[2]) / n))) * DEG;
  };
  const land = firstLow >= 0 ? firstLow : minT;
  const flight = Array.from({ length: Math.max(0, land - push) }, (_, k) => push + k);
  return {
    path: p, fps, pushFrame: push,
    hipsYStart: r2(hipsY[0]!), peakHipsYAfterPush: r2(peakY), peakAtS: r2(hipsY.indexOf(peakY) / fps),
    firstUpperBodyGroundS: firstLow >= 0 ? r2(firstLow / fps) : null, firstUpperBodyGroundAfterPushS: firstLow >= 0 ? r2((firstLow - push) / fps) : null,
    firstUpperBody: firstLow >= 0 ? upper.filter((i) => fk[firstLow]![i]!.pos[1] < 0.15).map((i) => names[i]) : [],
    firstHipsBelow035S: firstHipsLow >= 0 ? r2(firstHipsLow / fps) : null,
    minHipsY: r2(hipsY[minT]!), minHipsAtS: r2(minT / fps),
    hipsHorizSpeedAtLanding: r2(hsp(land)), maxHipsHorizSpeedFlight: r2(Math.max(...flight.map((t) => hsp(t)))),
    hipsTravelZ: r2(F[F.length - 1]!.root.pos[2] - F[0]!.root.pos[2]),
    pelvisPitchNetDeg: r1(pitch), pelvisPitchMaxAbsDeg: r1(maxAbsPitch), fwdAxisPointsDown: flip,
    hipsUpInvertedAtS: invertedT >= 0 ? r2(invertedT / fps) : null, fwd0: fwd0.map(r2),
    armFromBodyDownDegFlight: { left: r1(mean(flight.map((t) => armAng(fk[t]!, 'Left')))), right: r1(mean(flight.map((t) => armAng(fk[t]!, 'Right')))),
      max: r1(Math.max(...flight.map((t) => Math.max(armAng(fk[t]!, 'Left'), armAng(fk[t]!, 'Right'))))) },
    armStandDeg: r1((armAng(fk[0]!, 'Left') + armAng(fk[0]!, 'Right')) / 2),
  };
}

const [mode, ...rest0] = process.argv.slice(2);
const li = rest0.indexOf('--last');
const lastS = li >= 0 ? Number(rest0[li + 1]) : 0;
const rest = li >= 0 ? rest0.filter((_, i) => i !== li && i !== li + 1) : rest0;
if (mode === 'writhe') {
  const rs = rest.map((p) => writhe(p, lastS));
  for (const r of rs) console.log(JSON.stringify(r));
  const ly = rs.filter((r) => r.lies) as Array<ReturnType<typeof writhe> & { meanJointAngSpeedDegS: number; maxHipsHorizSpeedRaw: number; maxHipsHorizSpeed6f: number }>;
  if (ly.length > 1) {
    const s = (k: 'meanJointAngSpeedDegS' | 'maxHipsHorizSpeedRaw' | 'maxHipsHorizSpeed6f') => { const v = ly.map((r) => r[k]); return { median: r2(median(v)), min: Math.min(...v), max: Math.max(...v) }; };
    console.log(JSON.stringify({ n: ly.length, meanJointAngSpeedDegS: s('meanJointAngSpeedDegS'), maxHipsHorizSpeedRaw: s('maxHipsHorizSpeedRaw'), maxHipsHorizSpeed6f: s('maxHipsHorizSpeed6f') }));
  }
} else if (mode === 'thrown') {
  console.log(JSON.stringify(thrown(rest[0]!, rest[1] ? Number(rest[1]) : 30), null, 1));
} else throw new Error('사용법: airStats.ts writhe <clip>... | thrown <clip> [pushFrame]');
