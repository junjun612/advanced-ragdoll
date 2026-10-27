// 팔 자연스러움 지표 (2026-10-27, 사람다움 작업): sim 로그와 Kimodo 레퍼런스 클립에 같은 정의를 쓴다.
// 창 = 충격(밀림 시작) 시각 ~ +window초. 정의:
//   elev  = 위팔(어깨 관절점 → 팔꿈치 관절점)과 몸통(Spine2) 아래 축 사이 각(도). 팔이 몸에 붙어 늘어지면 10~20°, 수평으로 들면 90°
//   elevMean = 창 안 프레임·두 팔 평균, elevP90 = 프레임마다 두 팔 중 큰 값의 90백분위, outFrac = 그 값이 outDeg 넘는 프레임 비율
//   elbowMean = 팔꿈치 굽힘(위팔·전완 방향 사이 각) 평균, usage = Spine2 기준 팔 바디 상대 각속도 평균(°/s, refSimilarity와 같음)
//   trunkPeak = Spine2 기울기 최대(도)
import { type Vec3, sub, normalize, dot } from '../src/sim/math/vec3';
import { type Quat, rotate, multiplyQ, angleBetweenQ } from '../src/sim/math/quat';
import type { CharacterDef } from '../src/sim/character/characterDef';

export interface ArmFrame { t: number; rot: Record<string, Quat> }
export interface ArmStats { elevMean: number; elevP90: number; outFrac: number; elbowMean: number; usage: number; trunkPeak: number; /** 충격 1초 뒤부터 창 끝까지(회복·정착 구간) 팔 들림 > outDeg 비율 */ lateOut: number }
export interface ArmAngles { elev: { Left: number; Right: number }; elbow: { Left: number; Right: number }; trunk: number }

const DEG = 180 / Math.PI;
const ARM_BODIES = ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'];

/** 한 프레임의 팔 들림·팔꿈치·몸통 기울기 (도) */
export function armAngles(def: CharacterDef, rot: Record<string, Quat>): ArmAngles {
  const B = (n: string) => def.bodies.find((b) => b.name === n)!;
  const down = rotate(rot.Spine2!, [0, -1, 0]);
  const out: ArmAngles = { elev: { Left: 0, Right: 0 }, elbow: { Left: 0, Right: 0 }, trunk: Math.acos(Math.max(-1, Math.min(1, -down[1]))) * DEG };
  for (const s of ['Left', 'Right'] as const) {
    const up = sub(B(`${s}ForeArm`).joint!.anchorInParent, B(`${s}Arm`).joint!.anchorInChild);
    const fore = sub(B(`${s}Hand`).joint!.anchorInParent, B(`${s}ForeArm`).joint!.anchorInChild);
    const u = normalize(rotate(rot[`${s}Arm`]!, up) as Vec3);
    const v = normalize(rotate(rot[`${s}ForeArm`]!, fore) as Vec3);
    out.elev[s] = Math.acos(Math.max(-1, Math.min(1, dot(u, down)))) * DEG;
    out.elbow[s] = Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * DEG;
  }
  return out;
}

export function armStats(def: CharacterDef, fr: ArmFrame[], t0: number, window: number, outDeg = 40): ArmStats {
  const w = fr.filter((f) => f.t >= t0 - 1e-9 && f.t <= t0 + window + 1e-9);
  const elevs: number[] = [], maxE: number[] = [], elb: number[] = [];
  let lateN = 0, lateO = 0;
  let trunkPeak = 0;
  for (const f of w) {
    const a = armAngles(def, f.rot);
    trunkPeak = Math.max(trunkPeak, a.trunk);
    elevs.push(a.elev.Left, a.elev.Right);
    elb.push(a.elbow.Left, a.elbow.Right);
    maxE.push(Math.max(a.elev.Left, a.elev.Right));
    if (f.t >= t0 + 1.0 - 1e-9) { lateN++; if (Math.max(a.elev.Left, a.elev.Right) > outDeg) lateO++; }
  }
  let us = 0, un = 0;
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1]!, b = w[i]!;
    const ca: Quat = [-a.rot.Spine2![0], -a.rot.Spine2![1], -a.rot.Spine2![2], a.rot.Spine2![3]];
    const cb: Quat = [-b.rot.Spine2![0], -b.rot.Spine2![1], -b.rot.Spine2![2], b.rot.Spine2![3]];
    for (const n of ARM_BODIES) {
      us += (angleBetweenQ(multiplyQ(ca, a.rot[n]!), multiplyQ(cb, b.rot[n]!)) * DEG) / Math.max(1e-9, b.t - a.t);
      un++;
    }
  }
  const mean = (x: number[]) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : 0);
  const sorted = [...maxE].sort((a, b) => a - b);
  return {
    elevMean: mean(elevs), elevP90: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))]! : 0,
    outFrac: maxE.length ? maxE.filter((e) => e > outDeg).length / maxE.length : 0,
    elbowMean: mean(elb), usage: un ? us / un : 0, trunkPeak, lateOut: lateN ? lateO / lateN : 0,
  };
}

/** 로그 줄(JSON) → ArmFrame */
export const logToArmFrames = (log: string): ArmFrame[] =>
  log.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const s = JSON.parse(l) as { time: number; bodies: Record<string, { rot: Quat }> };
    return { t: s.time, rot: Object.fromEntries(Object.entries(s.bodies).map(([k, b]) => [k, b.rot])) };
  });
