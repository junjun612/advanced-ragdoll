// npm run sweep:kp — v0.0 근육 스파이크 측정을 실제 캐릭터(hold_pose_pinned)로 다시 한다 (SPEC v0.2).
// kpScale을 5 … 51200(×2)으로 바꿔 가며 진동 시작점·자세 오차를 잰다. 결과: out/kpSweep.json, 표는 stdout(마크다운).
// 변형: start = target(목표 포즈로 스폰) / rest(rest A포즈로 스폰 → stand 목표로 가는 과도 응답 포함), gc = 중력 보상 켬/끔,
//       dt = 1/120(기본) / 1/240(rest + gc만, SPEC 4 "v0.2에서 재확인"),
//       start = stand: hold_pose_assist(지면에 서서 루트 보조) — Hips가 고정되지 않은 전신 결합에서의 진동 확인.
// 오차는 전 구간 평균·최대(rest 시작은 t=0 오차 20°가 최대값이 된다)와 마지막 1초 평균(errLast1s, 스파이크 정의).
// 진동 판정은 스파이크와 같은 정의(jitterAll ≥ 5/s: 관절별 축 합 부호 반전/초, 앞뒤 |ω| > 0.1 rad/s) 또는 폭발.
import { writeFileSync, mkdirSync } from 'node:fs';
import { runScenario } from '../src/sim/runner';
import { findScenario, loadInputs, loadScenario } from './simCommon';
import type { MuscleConfig } from '../src/sim/character/muscles';
import musclesJson from '../config/muscles.json';

const KPS = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
const OSC = 5;
const base = musclesJson as unknown as MuscleConfig;
const sc0 = loadScenario(findScenario('hold_pose_pinned'));
const scStand = loadScenario(findScenario('hold_pose_assist'));

type Row = { dt: string; start: string; gc: boolean; kp: number; errLast1s: number; exploded: boolean; jitterAll: number; jitterAllJoint: string; jitter: number; errMean: number; errMax: number; maxAngVel: number; saturation: number };
const rows: Row[] = [];
const extra = new Map<number, string>();
const VARIANTS = [
  { dt: 1 / 120, start: 'target', gc: true }, { dt: 1 / 120, start: 'target', gc: false },
  { dt: 1 / 120, start: 'rest', gc: true }, { dt: 1 / 120, start: 'rest', gc: false },
  { dt: 1 / 240, start: 'rest', gc: true },
  { dt: 1 / 120, start: 'stand', gc: true },
] as const;
for (const { dt, start, gc } of VARIANTS)
    for (const kp of KPS) {
      const muscles: MuscleConfig = {
        ...base,
        kpScale: kp,
        joints: Object.fromEntries(Object.entries(base.joints).map(([k, v]) => [k, { ...v, gravityComp: gc ? v.gravityComp : 0 }])) as MuscleConfig['joints'],
      };
      const sc = start === 'stand' ? scStand : { ...sc0, spawn: { ...sc0.spawn, pose: start === 'target' ? sc0.spawn.pose : undefined } };
      const res = await runScenario({ ...loadInputs(sc), characterOpts: { muscles }, dt });
      const m = res.summary.metrics;
      // 마지막 1초 평균 오차 (로그 프레임, strength 1인 관절 전부)
      const lines = res.log.trim().split('\n').map((l) => JSON.parse(l) as { time: number; joints: Record<string, { errorDeg: number }> });
      const tail = lines.filter((s) => s.time >= sc.duration - 1 - 1e-9);
      const errLast1s = tail.reduce((a, s) => a + Object.values(s.joints).reduce((b, j) => b + j.errorDeg, 0) / 15, 0) / tail.length;
      if (start === 'stand') extra.set(kp, `fell=${res.summary.fell} footErrMax=${m.jointErrorMaxDeg!.toFixed(2)}`);
      rows.push({
        dt: dt === 1 / 120 ? '1/120' : '1/240', start, gc, kp, errLast1s,
        exploded: res.summary.exploded,
        jitterAll: m.jitterAll!, jitterAllJoint: res.summary.info?.jitterAllJoint ?? '',
        jitter: m.jitter!,
        errMean: m.jointErrorMeanDeg!, errMax: m.jointErrorMaxDeg!,
        maxAngVel: m.maxAngVel!, saturation: m.saturation!,
      });
    }

mkdirSync('out', { recursive: true });
writeFileSync('out/kpSweep.json', JSON.stringify(rows, null, 1) + '\n');
const f = (x: number, d = 2) => x.toFixed(d);
console.log('| dt | 시작 | 중력 보상 | kpScale | 진동(jitterAll/s, 관절) | 빠른 반전 jitter/s | 마지막 1초 오차° | 오차 평균° | 오차 최대° | 최대 각속도 | 포화 비율 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows)
  console.log(`| ${r.dt} | ${r.start} | ${r.gc ? '켬' : '끔'} | ${r.kp} | ${r.exploded ? '폭발' : `${f(r.jitterAll, 1)} ${r.jitterAll >= OSC ? `**${r.jitterAllJoint}**` : ''}`} | ${f(r.jitter, 1)} | ${f(r.errLast1s, 3)} | ${f(r.errMean)} | ${f(r.errMax)} | ${f(r.maxAngVel, 1)} | ${f(r.saturation, 3)} |`);
console.log('');
for (const v of VARIANTS) {
  const d = v.dt === 1 / 120 ? '1/120' : '1/240';
  const bad = rows.filter((r) => r.dt === d && r.start === v.start && r.gc === v.gc && (r.exploded || r.jitterAll >= OSC)).map((r) => r.kp);
  console.log(`dt ${d} ${v.start} gc=${v.gc}: oscillation at kp = ${bad.length ? bad.join(', ') : 'none'}`);
}
for (const [kp, x] of extra) console.log(`stand kp ${kp}: ${x}`);
