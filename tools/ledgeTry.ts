// (v0.8b 탐색용) 잡기 시나리오를 설정 덮어쓰기로 바꿔 가며 돌리고 잡기·매달리기 요약과 손 궤적을 찍는다 (파일을 쓰지 않는다).
// 사용법: npx tsx tools/ledgeTry.ts <scenario> '<JSON 덮어쓰기 배열>' [--trace]
//   키: 'beh.<경로>' = config/behaviors.json, 'rea.<경로>' = config/reaction.json, 'step.<경로>' = config/stepping.json, 'rag.<경로>' = config/ragdoll.json(이 실행 입력), 'char.<경로>' = 캐릭터 정의(xbot.json), 그 밖 = 시나리오. 예: '[{"beh.Grab.reachSpeed":2}]'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findScenario, loadScenario, loadInputs, OUT_DIR } from './simCommon';
import { stringifyRounded } from '../src/sim/logger';
import { rotate, conjugate, type Quat } from '../src/sim/math/quat';
import { sub, normalize, type Vec3 } from '../src/sim/math/vec3';
import { runScenario } from '../src/sim/runner';
import type { Scenario } from '../src/sim/scenario';
import behaviorsCfg from '../config/behaviors.json';
import reactionCfg from '../config/reaction.json';
import steppingCfg from '../config/stepping.json';

function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  const ks = path.split('.');
  let c = o as Record<string, unknown>;
  for (const k of ks.slice(0, -1)) c = c[k] as Record<string, unknown>;
  c[ks.at(-1)!] = v;
}

const base = loadScenario(findScenario(process.argv[2]!));
const arg = process.argv[3] ?? '[{}]';
const variants = JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg) as Record<string, unknown>[];
const trace = process.argv.includes('--trace');
const f2 = (a: readonly number[] | undefined | null) => (a ? a.map((x) => x.toFixed(2)).join(',') : '-');
for (const v of variants) {
  const sc = JSON.parse(JSON.stringify(base)) as Scenario;
  const saved = JSON.parse(JSON.stringify(behaviorsCfg)) as typeof behaviorsCfg;
  const savedR = JSON.parse(JSON.stringify(reactionCfg)) as typeof reactionCfg;
  const savedS = JSON.parse(JSON.stringify(steppingCfg)) as typeof steppingCfg;
  const inp = loadInputs(sc);
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('beh.')) setPath(behaviorsCfg as unknown as Record<string, unknown>, k.slice(4), x);
    else if (k.startsWith('step.')) setPath(steppingCfg as unknown as Record<string, unknown>, k.slice(5), x);
    else if (k.startsWith('rag.')) setPath(inp.ragdoll as unknown as Record<string, unknown>, k.slice(4), x);
    else if (k.startsWith('rea.')) setPath(reactionCfg as unknown as Record<string, unknown>, k.slice(4), x);
    else if (k.startsWith('char.')) setPath(inp.character as unknown as Record<string, unknown>, k.slice(5), x);
    else setPath(sc as unknown as Record<string, unknown>, k, x);
  }
  const r = await runScenario(inp);
  Object.assign(behaviorsCfg, saved);
  Object.assign(reactionCfg, savedR);
  Object.assign(steppingCfg, savedS);
  // --write <이름>: out/<이름>/에 로그·요약·메타를 써서 필름을 만들 수 있게 (변형이 여럿이면 마지막 것)
  const wi = process.argv.indexOf('--write');
  if (wi > 0) {
    const dir = join(OUT_DIR, process.argv[wi + 1]!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), r.log);
    for (const x of r.extraLogs ?? []) writeFileSync(join(dir, x.file), x.log);
    if (r.propsLog) writeFileSync(join(dir, r.meta.propsLog ?? 'props.jsonl'), r.propsLog);
    writeFileSync(join(dir, 'summary.json'), stringifyRounded(r.summary, 2) + '\n');
    writeFileSync(join(dir, 'meta.json'), stringifyRounded({ ...r.meta, scenario: process.argv[wi + 1] }, 2) + '\n');
  }
  const s = r.summary, m = s.metrics;
  console.log(`=== ${JSON.stringify(v)}  ${s.expectations.passed ? 'PASS' : 'FAIL ' + s.expectations.failures.join('; ')}`);
  console.log(`  grabbed=${m.grabbed} grip=${(m.gripTime ?? -1).toFixed(2)} slip=${(m.grabSlipMax ?? 0).toFixed(3)} F=${(m.grabForceMax ?? 0).toFixed(0)} hold=${(m.grabHoldTime ?? 0).toFixed(2)} hang=${(m.hangTime ?? 0).toFixed(2)} fell=${s.fell} expl=${s.exploded}`);
  // 손바닥-잡을 목표 최소 거리 (잡기 전, 연속 지표)
  let minD = Infinity, minT = 0;
  for (const line of r.log.trim().split('\n')) {
    const f = JSON.parse(line);
    for (const h of (f.behavior?.grab?.hands ?? []) as { phase: string; target: number[] | null; palm: number[] }[]) {
      if (h.phase !== 'reach' || !h.target) continue;
      const d = Math.hypot(h.palm[0]! - h.target[0]!, h.palm[1]! - h.target[1]!, h.palm[2]! - h.target[2]!);
      if (d < minD) { minD = d; minT = f.time; }
    }
  }
  // (v0.8c) 다른 사람과 처음 닿은 내 바디 (접촉점에 가장 가까운 바디 중심) — 머리 먼저인지 손 먼저인지
  {
    const fc: string[] = [];
    for (const line of r.log.trim().split('\n')) {
      const f = JSON.parse(line);
      const cs = (f.interaction?.contacts ?? []).filter((c: { kind: string }) => c.kind === 'character');
      if (!cs.length) continue;
      for (const c of cs) {
        if (!c.point) continue;
        let best = '', bd = 9;
        for (const [n, b] of Object.entries(f.bodies as Record<string, { pos: number[] }>)) { const d = Math.hypot(b.pos[0]! - c.point[0], b.pos[1]! - c.point[1], b.pos[2]! - c.point[2]); if (d < bd) { bd = d; best = n; } }
        if (!fc.includes(best)) fc.push(`${best}@${f.time.toFixed(2)}`);
      }
      if (fc.length >= 40) break;
    }
    if (fc.length) console.log(`  firstContacts=${fc.slice(0, 4).join(' ')} headAt=${fc.find((x) => x.startsWith('Head@'))?.slice(5) ?? '-'}`);
  }
  // 머리 − 엉덩이 높이 최소 (음수 = 거꾸로 뒤집힘)
  let hx = 9;
  for (const line of r.log.trim().split('\n')) {
    const f = JSON.parse(line);
    if (f.time > 1.6 && f.time < 3) hx = Math.min(hx, f.bodies.Head.pos[1] - f.bodies.Hips.pos[1]);
  }
  // 왼팔 시상면 굽힘 (몸통 기준, 0 = 아래, 90 = 앞, 180 = 위, 음수 = 뒤로 폄): 잡은 순간과 끝 (사람 폄 한계 약 −60°)
  const flexAt = (f: { bodies: Record<string, { pos: number[]; rot: number[] }> }) => {
    const u = normalize(sub(f.bodies.LeftForeArm!.pos as Vec3, f.bodies.LeftArm!.pos as Vec3));
    const l = rotate(conjugate(f.bodies.Spine2!.rot as Quat), u);
    return (Math.atan2(l[2], -l[1]) * 180) / Math.PI;
  };
  const frames = r.log.trim().split('\n').map((x) => JSON.parse(x));
  const gT = m.gripTime !== undefined && m.gripTime >= 0 ? 1 + m.gripTime : null;
  const fg = gT !== null ? frames.find((f) => f.time >= gT) : null;
  let flexMin = 999;
  for (const f of frames) if (gT !== null && f.time >= gT && f.time <= gT + 1.5) flexMin = Math.min(flexMin, flexAt(f));
  let romMax = 0;
  for (const f of frames) for (const n of ['LeftArm', 'RightArm']) romMax = Math.max(romMax, f.joints[n]?.rom?.excessDeg ?? 0);
  const fl = frames.at(-1);
  console.log(`  romExcessMax=${romMax.toFixed(1)} endHead=${fl.bodies.Head.pos.map((x: number) => x.toFixed(2)).join(',')} endHips=${fl.bodies.Hips.pos.map((x: number) => x.toFixed(2)).join(',')}`);
  console.log(`  headMinusHipMin=${hx.toFixed(2)} armFlexAtGrip=${fg ? flexAt(fg).toFixed(0) : '-'} armFlexMinAfter=${flexMin.toFixed(0)} armFlexEnd=${flexAt(frames.at(-1)).toFixed(0)}`);
  console.log(`  minPalmTarget=${minD.toFixed(3)} @${minT.toFixed(2)}`);
  if (process.argv.includes('--events')) for (const e of r.meta.events) if (/behavior|grab|step|hit/.test(e.type)) console.log(`   ${e.t.toFixed(2)} ${e.char ?? ''} ${e.type} ${e.detail ?? ''} ${e.body ?? ''} ${e.source ?? ''}`);
  if (trace) {
    for (const line of r.log.trim().split('\n')) {
      const f = JSON.parse(line);
      if (f.time < Number(process.env.FROM ?? 0.95) || f.time > Number(process.env.TO ?? 3) || Math.round(f.time * 120) % 4) continue;
      if (process.argv.includes('--arm')) {
        const j = f.joints;
        const ref = (f.behavior?.grab?.hands ?? []).find((h: { hand: string }) => h.hand === 'LeftHand')?.ref;
        console.log(`  ${f.time.toFixed(3)} LArm c ${f2(j.LeftArm.coordsDeg)} t ${f2(j.LeftArm.targetDeg)} e${j.LeftArm.errorDeg.toFixed(0)} s${j.LeftArm.strength.toFixed(2)} | LFore c ${f2(j.LeftForeArm.coordsDeg)} t ${f2(j.LeftForeArm.targetDeg)} | ref ${f2(ref)} palm ${f2(f.bodies.LeftHand.pos)} bal ${f.behavior?.balanceMode} ${JSON.stringify(f.balance?.on ?? f.balance?.active ?? '')}`);
        continue;
      }
      const hs = (f.behavior?.grab?.hands ?? []) as { hand: string; phase: string; target: number[]; palm: number[]; slip: number; force: number }[];
      console.log(`  ${f.time.toFixed(3)} hip ${f2(f.bodies.Hips.pos)} sp2 ${f2(f.bodies.Spine2.pos)} ` + hs.map((h) => `${h.hand[0]}:${h.phase} palm ${f2(h.palm)} tgt ${f2(h.target)} F${h.force.toFixed(0)} s${h.slip.toFixed(3)}`).join(' | ') + ' ' + (f.behaviors ?? []).filter((b: { weight: number }) => b.weight > 0.05).map((b: { name: string }) => b.name).join(','));
    }
  }
}
