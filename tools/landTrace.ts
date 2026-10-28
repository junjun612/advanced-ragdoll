// 착지 제동 추적 (결정 land-*): 충격 뒤 0~0.6초를 120 Hz로
//   스텝 단계, 발별 접촉·하중(N), 실제 지면력(밀린 방향 수평 Fh·수직 Fv, m·dv/dt + 중력), 실제 COM 둘레 모멘트(dL/dt, 넘어짐 +),
//   착지발(마지막 스윙발)의 COM 대비 수평 거리 d(밀린 방향)·COM 높이 h, 힘선 원뿔 한계 Fv·d/h, 착지발 무릎 굽힘, 몸통 기울기, 착지 받기 세기(balance.land),
//   착지 목표 거리·고관절→목표/발 거리·스윙 진행.
// 사용법: SET=... npx tsx tools/landTrace.ts <시나리오> [시드] [끝 초]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { rotate, type Quat } from '../src/sim/math/quat';
import { cross, type Vec3 } from '../src/sim/math/vec3';

const [name, seedS, endS] = process.argv.slice(2);
const seed = Number(seedS ?? '1');
const tEnd = Number(endS ?? '0.6');
const DEG = 180 / Math.PI;
function cfgs(): Record<string, unknown> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const poses: Record<string, unknown> = {};
  for (const f of readdirSync('config/poses')) if (f.endsWith('.json')) poses[f.replace(/\.json$/, '')] = rd(join('config/poses', f));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), r: rd('config/reaction.json'), p: poses };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c;
}
async function main(): Promise<void> {
  const { runScenario } = await import('../src/sim/runner');
  const { findScenario, loadScenario, loadInputs, jitterScenario } = await import('./simCommon');
  const c = cfgs() as Record<string, never>;
  const sc = jitterScenario({ ...loadScenario(findScenario(name!)), seed }, seed);
  const hit = sc.events.find((e) => e.type === 'hit')!;
  const t0 = hit.t;
  const d0 = (hit as { hit?: { direction?: number[] } }).hit?.direction ?? [1, 0, 0];
  const dn = Math.hypot(d0[0]!, d0[2]!) || 1;
  const dir: Vec3 = [d0[0]! / dn, 0, d0[2]! / dn];
  const axis = cross([0, 1, 0], dir);
  let prevV: Vec3 | null = null, prevL: number | null = null, mass = 0;
  let landFoot: string | null = null;
  console.log('t | 단계 | 접촉L/R 하중L/R | Fh Fv | dL/dt | L | 착지발 d h 원뿔(Fv·d/h) | 무릎° | 몸통° | COM v | land');
  await runScenario({
    ...loadInputs(sc),
    characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, poses: c.p, reactionConfig: c.r },
    observe: {
      step: (w) => {
        const ch = w.characters[0]!;
        const t = w.time - t0;
        const com = ch.rd.com();
        if (!mass) mass = ch.rd.bodies.reduce((a, b) => a + b.rb.mass(), 0);
        const v = com.vel as Vec3;
        const g = 9.81;
        const Fh = prevV ? ((v[0] - prevV[0]) * dir[0] + (v[2] - prevV[2]) * dir[2]) * mass / w.dt : 0;
        const Fv = prevV ? (v[1] - prevV[1]) * mass / w.dt + mass * g : 0;
        prevV = [...v];
        const bs = ch.balance.state, ss = ch.stepping.state;
        const Lv = bs.angularMomentum;
        const L = Lv ? Lv[0] * axis[0] + Lv[1] * axis[1] + Lv[2] * axis[2] : NaN;
        const dL = prevL !== null && bs.enabled ? (L - prevL) / w.dt : NaN;
        prevL = bs.enabled ? L : null;
        if (ss.swingFoot) landFoot = ss.swingFoot;
        if (t < 0.15 || t > tEnd) return;
        const per = ch.perception();
        const cL = per.feet.LeftFoot.contact ? 'o' : '.', cR = per.feet.RightFoot.contact ? 'o' : '.';
        let dd = NaN, hh = NaN, kneeDeg = NaN;
        if (landFoot) {
          const fp = ch.rd.body(landFoot as never).rb.translation();
          dd = (fp.x - com.com[0]) * dir[0] + (fp.z - com.com[2]) * dir[2];
          hh = com.com[1] - fp.y;
          const kn = landFoot === 'LeftFoot' ? 'LeftLeg' : 'RightLeg';
          const j = ch.rd.joints.find((x) => x.name === kn)!;
          kneeDeg = ch.rd.coords(j)[0]! * DEG;
        }
        const q = ch.rd.body('Spine2').rb.rotation();
        const tilt = Math.acos(Math.max(-1, Math.min(1, rotate([q.x, q.y, q.z, q.w] as Quat, [0, 1, 0])[1]))) * DEG;
        // TILT=1: 균형 켜짐·스텝 상태·몸통 기울기·각속도만 (결정 land-4 진단)
        if (process.env.TILT) { const w2 = ch.rd.body('Spine2').rb.angvel(); const st = (ch.stepping as unknown as { st: string }).st; console.log(`${t.toFixed(3)} on=${bs.enabled} st=${st} tilt=${tilt.toFixed(1)} w=${(Math.hypot(w2.x, w2.y, w2.z) * DEG).toFixed(0)}°/s v=${(v[0] * dir[0] + v[2] * dir[2]).toFixed(2)} h=${com.com[1].toFixed(3)} poly=${per.supportPolygon.length}`); return; }
        const lg = bs.land ? +bs.land.toFixed(2) : null;
        let reach = '';
        if (landFoot && ss.target) {
          const hipN = landFoot === 'LeftFoot' ? 'LeftUpLeg' : 'RightUpLeg';
          const hp = ch.rd.body(hipN as never).rb.translation();
          const fp = ch.rd.body(landFoot as never).rb.translation();
          const tg = ss.target;
          reach = ` tgt-d ${(((tg[0] - com.com[0]) * dir[0] + (tg[2] - com.com[2]) * dir[2])).toFixed(2)} hip→tgt ${Math.hypot(tg[0] - hp.x, tg[1] + 0.045 - hp.y, tg[2] - hp.z).toFixed(2)} hip→foot ${Math.hypot(fp.x - hp.x, fp.y - hp.y, fp.z - hp.z).toFixed(2)} s ${ss.s.toFixed(2)}`;
        }
        console.log(`${t.toFixed(3)} | ${ss.state}/${ss.phase ?? '-'} ${landFoot?.[0] ?? ''} | ${cL}${cR} ${per.feet.LeftFoot.load.toFixed(0)}/${per.feet.RightFoot.load.toFixed(0)} | ${Fh.toFixed(0)} ${Fv.toFixed(0)} | ${dL.toFixed(0)} | ${L.toFixed(1)} | ${dd.toFixed(2)} ${hh.toFixed(2)} ${(Fv * dd / hh).toFixed(0)} | ${kneeDeg.toFixed(0)} | ${tilt.toFixed(0)} | ${((v[0] * dir[0] + v[2] * dir[2])).toFixed(2)} | ${lg ? JSON.stringify(lg) : ''}${reach}`);
      },
    },
  });
}
void main();
