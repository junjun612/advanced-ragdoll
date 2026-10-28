// 가슴 밀림 초반 꺾임 분해 (결정 chest-*): 충격 순간부터 0.15초(기본)를 120 Hz로
//   ① 충격량: 피격 이벤트(바디·지점)와 충격 직후 바디별 Δv(밀린 방향 성분)·각속도 변화, 몸통 사슬 각운동량
//   ② 각도(충격 직전 대비, 밀린 쪽으로 넘어지는 회전 +): 몸통(Spine2 월드)·골반(Hips 월드)·척추(Spine2↔Hips)·Spine(Spine↔Hips)·Spine2(Spine2↔Spine)·고관절 평균
//   ③ 근육: Spine·Spine2·고관절 오차°, 추정 토크 크기, 포화, 강도
//   ④ 균형: 켜짐·단계, 감지 몸통 기울기(지연), QP 관절 토크(밀린 쪽 넘어짐 축 성분, + = 넘어짐을 막는 쪽), wbTorsoError
// 사용법: SET=... npx tsx tools/chestTrace.ts <시나리오> [시드] [끝 초] [--mode base|nobal|ragdoll|nodelay] [--csv out.csv]
//   nobal: 충격부터 끝까지 균형 계층을 끈다(근육 = 서기 목표 PD 그대로, 모터 배율 1) — 수동 강성만의 반응
//   ragdoll: 충격부터 근육 0 — 충격량 분포의 순수 기계적 결과
//   SET은 onsetTrace와 같은 키(b·s·h·r·p) + m(muscles)·hm(hitModel)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rotate, multiplyQ, conjugate, toRotationVector, type Quat } from '../src/sim/math/quat';
import { cross, dot, type Vec3 } from '../src/sim/math/vec3';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]!; argv.splice(i, 2); return v; };
const MODE = opt('--mode', 'base');
const CSV = opt('--csv', '');
const DUR = Number(opt('--dur', '0'));
const QUIET = argv.includes('--quiet'); if (QUIET) argv.splice(argv.indexOf('--quiet'), 1);
const [name, seedS, endS] = argv;
const seed = Number(seedS ?? '1');
const tEnd = Number(endS ?? '0.15');
const DEG = 180 / Math.PI;
function cfgs(): Record<string, Record<string, unknown>> {
  const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const poses: Record<string, unknown> = {};
  for (const f of readdirSync('config/poses')) if (f.endsWith('.json')) poses[f.replace(/\.json$/, '')] = rd(join('config/poses', f));
  const c: Record<string, Record<string, unknown>> = { b: rd('config/balance.json'), s: rd('config/stepping.json'), h: rd('config/behaviors.json'), r: rd('config/reaction.json'), p: poses, m: rd('config/muscles.json'), hm: rd('config/hitModel.json') };
  for (const kv of (process.env.SET ?? '').split(';').filter(Boolean)) {
    const i = kv.indexOf('=');
    const path = kv.slice(0, i).trim().split('.');
    let o = c[path[0]!]!;
    for (const p of path.slice(1, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
    o[path.at(-1)!] = JSON.parse(kv.slice(i + 1));
  }
  return c;
}
const qOf = (r: { x: number; y: number; z: number; w: number }): Quat => [r.x, r.y, r.z, r.w];
/** q0 → q1 상대 회전(월드) 벡터를 axis에 투영 (도) */
const relAxis = (q0: Quat, q1: Quat, axis: Vec3) => { let d = multiplyQ(q1, conjugate(q0)); if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]]; return dot(toRotationVector(d), axis) * DEG; };

export interface ChestRow { t: number; trunk: number; pelvis: number; spine: number; j1: number; j2: number; hip: number; sensedTrunk: number; trunkW: number; L: number; Lupper: number; bal: string; qpS1: number; qpS2: number; qpHip: number; mS1: number; mS2: number; satS: string; errS1: number; errS2: number }

async function main(): Promise<void> {
  const { runScenario } = await import('../src/sim/runner');
  const { findScenario, loadScenario, loadInputs, jitterScenario } = await import('./simCommon');
  const c = cfgs() as Record<string, never>;
  const sc = jitterScenario({ ...loadScenario(findScenario(name!)), seed }, seed);
  const hit = sc.events.find((e) => e.type === 'hit')! as unknown as { t: number; hit: { direction: number[]; body?: string; point?: number[]; magnitude?: unknown; duration?: number } };
  if (DUR > 0) hit.hit.duration = DUR;
  const t0 = hit.t;
  const d0 = hit.hit.direction;
  const dn = Math.hypot(d0[0]!, d0[2]!) || 1;
  const dir: Vec3 = [d0[0]! / dn, 0, d0[2]! / dn];
  const axis = cross([0, 1, 0], dir); // 밀린 쪽으로 넘어지는 회전 축
  const rows: ChestRow[] = [];
  let base: Record<string, Quat> | null = null;
  let pre: Record<string, { v: Vec3; w: Vec3 }> | null = null;
  let masses: Record<string, number> = {};
  let lastCmd: { torque: Record<string, Vec3 | undefined> } | null = null;
  const hist: { t: number; q: Quat }[] = [];
  let dvPrinted = false;
  if (!QUIET) console.log(`# ${name} 시드 ${seed} 모드 ${MODE} 충격 ${JSON.stringify(hit.hit)} t0=${t0.toFixed(3)} 방향 ${dir.map((x) => x.toFixed(2))}`);
  await runScenario({
    ...loadInputs(sc),
    characterOpts: { balanceConfig: c.b, steppingConfig: c.s, behaviorsConfig: c.h, poses: c.p, reactionConfig: c.r, muscles: c.m, hitModelConfig: c.hm } as never,
    observe: {
      setup: (w) => {
        const ch = w.characters[0]! as unknown as { balance: { update: (...a: unknown[]) => { cmd: unknown } } };
        const orig = ch.balance.update.bind(ch.balance);
        ch.balance.update = (...a: unknown[]) => { const r = orig(...a); lastCmd = r.cmd as never; return r; };
      },
      step: (w) => {
        const ch = w.characters[0]! as never as {
          rd: { bodies: { name: string; rb: { rotation(): { x: number; y: number; z: number; w: number }; linvel(): { x: number; y: number; z: number }; angvel(): { x: number; y: number; z: number }; mass(): number } }[]; body(n: string): { rb: { rotation(): { x: number; y: number; z: number; w: number }; angvel(): { x: number; y: number; z: number } } } };
          balance: { enabled: boolean; state: { enabled: boolean; angularMomentum: Vec3 }; cfg: { delay: number } };
          stepping: { state: { state: string; phase?: string } };
          muscles: { out(n: string): { errorDeg: number; torque: number; saturated: boolean; strength: number } };
          setState?: (s: string) => void;
        };
        const t = w.time - t0; // 이 스텝(충격을 가한 스텝 포함)이 끝난 시각 − 충격 시각
        const rot: Record<string, Quat> = {};
        for (const b of ch.rd.bodies) rot[b.name] = qOf(b.rb.rotation());
        hist.push({ t, q: rot.Spine2! });
        if (!Object.keys(masses).length) for (const b of ch.rd.bodies) masses[b.name] = b.rb.mass();
        if (t < 1e-9) {
          base = rot;
          pre = {};
          for (const b of ch.rd.bodies) { const v = b.rb.linvel(), aw = b.rb.angvel(); pre[b.name] = { v: [v.x, v.y, v.z], w: [aw.x, aw.y, aw.z] }; }
          // 실험 모드: 다음 스텝(충격 스텝)부터 적용
          if (t > -w.dt * 0.5) {
            if (MODE === 'nobal') ch.balance.enabled = false;
          }
          return;
        }
        if (MODE === 'ragdoll' && (ch as unknown as { stateName: string }).stateName !== 'Ragdoll') (ch as unknown as { setState(s: string): void }).setState('Ragdoll');
        if (t > tEnd + 1e-9 || !base || !pre) return;
        if (!dvPrinted && !QUIET) {
          dvPrinted = true;
          console.log('바디 | 질량 kg | Δv 밀린 방향 m/s | Δω 넘어짐 축 °/s | 충격량 몫 N·s');
          let tot = 0;
          for (const b of ch.rd.bodies) {
            const v = b.rb.linvel(), aw = b.rb.angvel();
            const dv = (v.x - pre[b.name]!.v[0]) * dir[0] + (v.z - pre[b.name]!.v[2]) * dir[2];
            const dw = ((aw.x - pre[b.name]!.w[0]) * axis[0] + (aw.y - pre[b.name]!.w[1]) * axis[1] + (aw.z - pre[b.name]!.w[2]) * axis[2]) * DEG;
            tot += masses[b.name]! * dv;
            console.log(`${b.name} | ${masses[b.name]!.toFixed(2)} | ${dv.toFixed(3)} | ${dw.toFixed(0)} | ${(masses[b.name]! * dv).toFixed(1)}`);
          }
          console.log(`합 Σm·Δv = ${tot.toFixed(1)} N·s (전신 Δv ${(tot / Object.values(masses).reduce((a, x) => a + x, 0)).toFixed(3)} m/s)`);
          console.log('t | 균형 | 몸통° 골반° 척추°(Spine° Spine2°) 고관절° | 감지 몸통° | 몸통 ω°/s | L 전신 | QP τ Spine Spine2 고관절(+막음) | 근육 |τ| Spine Spine2 | 오차° Spine Spine2 | 포화');
        }
        const trunk = relAxis(base.Spine2!, rot.Spine2!, axis);
        const pelvis = relAxis(base.Hips!, rot.Hips!, axis);
        const spine = trunk - pelvis;
        const j1 = relAxis(base.Spine!, rot.Spine!, axis) - pelvis;
        const j2 = trunk - relAxis(base.Spine!, rot.Spine!, axis);
        const hip = pelvis - 0.5 * (relAxis(base.LeftUpLeg!, rot.LeftUpLeg!, axis) + relAxis(base.RightUpLeg!, rot.RightUpLeg!, axis));
        const delay = ch.balance.cfg.delay;
        const hs = hist.filter((h) => h.t <= t - delay + 1e-9);
        const sensedTrunk = hs.length ? relAxis(base.Spine2!, hs.at(-1)!.q, axis) : 0;
        const s2w = ch.rd.body('Spine2').rb.angvel();
        const trunkW = (s2w.x * axis[0] + s2w.y * axis[1] + s2w.z * axis[2]) * DEG;
        const bs = ch.balance.state;
        const L = bs.enabled ? dot(bs.angularMomentum, axis) : NaN;
        // 몸통 사슬(Spine·Spine2·머리·팔) 각운동량은 생략 — 전신 L만
        const cmdT = (n: string) => { const v = lastCmd?.torque[n]; return v ? -dot(v, axis) : 0; }; // 자식에 +τ: 넘어짐 축 반대 = 막음 → 부호 뒤집어 + = 막음
        const ss = ch.stepping.state;
        const mo = (n: string) => ch.muscles.out(n);
        const row: ChestRow = {
          t, trunk, pelvis, spine, j1, j2, hip, sensedTrunk, trunkW, L, Lupper: 0,
          bal: bs.enabled ? `${ss.state}/${ss.phase ?? '-'}` : 'off',
          qpS1: cmdT('Spine'), qpS2: cmdT('Spine2'), qpHip: 0.5 * (cmdT('LeftUpLeg') + cmdT('RightUpLeg')),
          mS1: mo('Spine').torque, mS2: mo('Spine2').torque,
          satS: `${mo('Spine').saturated ? 'S' : '-'}${mo('Spine2').saturated ? 'S' : '-'}${mo('LeftUpLeg').saturated ? 'L' : '-'}${mo('RightUpLeg').saturated ? 'R' : '-'}`,
          errS1: mo('Spine').errorDeg, errS2: mo('Spine2').errorDeg,
        };
        rows.push(row);
        if (!QUIET) console.log(`${t.toFixed(3)} | ${row.bal} | ${trunk.toFixed(1)} ${pelvis.toFixed(1)} ${spine.toFixed(1)}(${j1.toFixed(1)} ${j2.toFixed(1)}) ${hip.toFixed(1)} | ${sensedTrunk.toFixed(1)} | ${trunkW.toFixed(0)} | ${L.toFixed(1)} | ${row.qpS1.toFixed(0)} ${row.qpS2.toFixed(0)} ${row.qpHip.toFixed(0)} | ${row.mS1.toFixed(0)} ${row.mS2.toFixed(0)} | ${row.errS1.toFixed(1)} ${row.errS2.toFixed(1)} | ${row.satS}`);
      },
    },
  });
  const pk = (k: keyof ChestRow) => Math.max(...rows.map((r) => r[k] as number));
  const at = (tt: number) => rows.reduce((b, r) => (Math.abs(r.t - tt) < Math.abs(b.t - tt) ? r : b), rows[0]!);
  const r10 = at(0.1);
  console.log(`요약 ${name} 시드 ${seed} ${MODE}: 0.1초 몸통 ${r10.trunk.toFixed(1)} 골반 ${r10.pelvis.toFixed(1)} 척추 ${r10.spine.toFixed(1)} | 창 최대 몸통 ${pk('trunk').toFixed(1)} 골반 ${pk('pelvis').toFixed(1)} 척추 ${pk('spine').toFixed(1)}`);
  if (CSV) writeFileSync(CSV, ['t,trunk,pelvis,spine,j1,j2,hip,sensed,trunkW,qpS1,qpS2,qpHip,mS1,mS2', ...rows.map((r) => [r.t, r.trunk, r.pelvis, r.spine, r.j1, r.j2, r.hip, r.sensedTrunk, r.trunkW, r.qpS1, r.qpS2, r.qpHip, r.mS1, r.mS2].map((x) => x.toFixed(4)).join(','))].join('\n'));
}
void main();
