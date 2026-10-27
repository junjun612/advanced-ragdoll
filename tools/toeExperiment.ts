// 발가락(ToeBase) 바디 실험 (v0.8a, SPEC 6.1 '발가락 바디 추가 여부를 실험으로 정한다'): 같은 시나리오·근처 입력을 발 박스 하나(지금)와
// 발 + 발가락(경첩) 두 바디로 돌려 걷기·스텝 품질과 착지 오차를 비교한다. 발가락 변형은 메모리에서만 만든다(설정 파일을 바꾸지 않음).
// 사용법: npx tsx tools/toeExperiment.ts [--sweep 6] [--toeKp 0.05] [시나리오...]
import { readFileSync } from 'node:fs';
import { findScenario, loadScenario, loadInputs, jitterScenario } from './simCommon';
import { runScenario } from '../src/sim/runner';
import type { CharacterDef, BodyDef, BodyName } from '../src/sim/character/characterDef';
import type { RagdollConfig } from '../src/sim/character/ragdoll';
import type { MuscleConfig } from '../src/sim/character/muscles';
import type { Vec3 } from '../src/sim/math/vec3';

const argv = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const N = opt('--sweep', 6);
const toeKp = opt('--toeKp', 0.05);
const ballFrac = opt('--ball', 0.72);
const names = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
const list = names.length ? names : ['push_front_medium', 'push_back_medium', 'push_left_medium', 'push_front_small', 'stairs_push_down', 'slope20_push', 'walk_forward_track'];

/** 발 박스를 뒤꿈치~볼(ballFrac)과 볼~발끝 두 바디로 나눈다. 발가락 = 경첩(옆 축), 질량은 발 질량을 길이 비로 나눈다 */
function toeVariant(def0: CharacterDef): CharacterDef {
  const def = structuredClone(def0);
  for (const side of ['Left', 'Right'] as const) {
    const fi = def.bodies.findIndex((b) => b.name === `${side}Foot`);
    const foot = def.bodies[fi]!;
    if (foot.shape.type !== 'box') throw new Error('foot is not a box');
    const h = foot.shape.halfExtents;
    const L = 2 * h[2];
    const heelZ = foot.restPosition[2] - h[2], toeZ = foot.restPosition[2] + h[2];
    const ballZ = heelZ + L * ballFrac;
    const soleY = foot.restPosition[1] - h[1];
    const footLen = ballZ - heelZ, toeLen = toeZ - ballZ;
    const newFootPos: Vec3 = [foot.restPosition[0], foot.restPosition[1], heelZ + footLen / 2];
    const dz = foot.restPosition[2] - newFootPos[2];
    const ankle = foot.joint!;
    ankle.anchorInChild = [ankle.anchorInChild[0], ankle.anchorInChild[1], ankle.anchorInChild[2] + dz];
    foot.restPosition = newFootPos;
    foot.shape = { type: 'box', halfExtents: [h[0], h[1], footLen / 2] };
    const m = foot.massRatio;
    foot.massRatio = m * (footLen / L);
    const toeH = 0.022;
    const toePos: Vec3 = [newFootPos[0], soleY + toeH, ballZ + toeLen / 2];
    const ball: Vec3 = [newFootPos[0], soleY + toeH, ballZ];
    const toe: BodyDef = {
      name: `${side}ToeBase` as BodyName, parent: foot.name, sourceBones: [`${side}ToeBase`, `${side}Toe_End`], representativeBone: `${side}ToeBase`, jointBone: `${side}ToeBase`,
      shape: { type: 'box', halfExtents: [h[0] * 0.95, toeH, toeLen / 2] },
      massRatio: m * (toeLen / L), inertiaScale: 1, restPosition: toePos, restRotation: [0, 0, 0, 1],
      joint: {
        type: 'hinge', anchorInParent: [ball[0] - newFootPos[0], ball[1] - newFootPos[1], ball[2] - newFootPos[2]], anchorInChild: [0, ball[1] - toePos[1], ball[2] - toePos[2]],
        frameInParent: [0, 0, 0, 1], frameInChild: [0, 0, 0, 1], axis: [1, 0, 0], axesWorld: { flex: [1, 0, 0], twist: [0, 1, 0], side: [0, 0, 1] },
        limitsDeg: { flex: [-60, 25] },
      },
      friction: 1,
    } as BodyDef;
    def.bodies.splice(fi + 1, 0, toe);
  }
  return def;
}

const muscles0 = JSON.parse(readFileSync('config/muscles.json', 'utf8')) as MuscleConfig & { joints: Record<string, unknown>; regions: Record<string, string[]> };
const toeMuscles = structuredClone(muscles0);
for (const s of ['Left', 'Right']) {
  toeMuscles.joints[`${s}ToeBase`] = { kpRatio: toeKp, maxTorque: 30, gravityComp: 1.0 };
  for (const r of ['all', 'lowerBody', `${s.toLowerCase()}Leg`]) toeMuscles.regions[r]!.push(`${s}ToeBase`);
}

type Row = Record<string, number | string>;
const out: Row[] = [];
for (const n of list) {
  for (const variant of ['box', 'toe'] as const) {
    const agg = { pass: 0, fell: 0, rec: 0, land: [] as number[], slide: [] as number[], jerk: [] as number[], walkSlide: [] as number[], walkLand: [] as number[], clipCom: [] as number[], dist: [] as number[] };
    for (let seed = 1; seed <= N; seed++) {
      let sc = { ...loadScenario(findScenario(n)), seed };
      sc = jitterScenario(sc, seed);
      const inp = loadInputs(sc);
      const ragdoll = structuredClone(inp.ragdoll) as RagdollConfig & { bodies: Record<string, unknown> };
      if (variant === 'toe') for (const s of ['Left', 'Right']) ragdoll.bodies[`${s}ToeBase`] = { angularDamping: 50, inertiaScale: 4, jointDamping: 0.1 };
      const character = variant === 'toe' ? toeVariant(inp.character) : inp.character;
      const r = await runScenario({ ...inp, character, ragdoll, characterOpts: { ...(variant === 'toe' ? { muscles: toeMuscles as unknown as MuscleConfig } : {}), getup: false } });
      const s = r.summary, m = s.metrics;
      if (s.expectations.passed) agg.pass++;
      if (s.fell) agg.fell++;
      if (s.recoveredAfterHit !== null) agg.rec++;
      for (const e of r.meta.events) if (e.type === 'step' && typeof e.error === 'number') agg.land.push(e.error);
      if (m.footSlide !== undefined) agg.slide.push(m.footSlide);
      if (m.comJerk !== undefined) agg.jerk.push(m.comJerk);
      if (m.walkFootSlidePerStep !== undefined) agg.walkSlide.push(m.walkFootSlidePerStep);
      if (m.walkLandingErrorMean !== undefined) agg.walkLand.push(m.walkLandingErrorMean);
      if (m.clipComErrCm !== undefined) agg.clipCom.push(m.clipComErrCm);
      if (m.walkDistance !== undefined) agg.dist.push(m.walkDistance);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    out.push({ scenario: n, variant, pass: `${agg.pass}/${N}`, fell: agg.fell, rec: agg.rec, landErr: mean(agg.land), nLand: agg.land.length, footSlide: mean(agg.slide), comJerk: mean(agg.jerk), walkSlide: mean(agg.walkSlide), walkLand: mean(agg.walkLand), clipComCm: mean(agg.clipCom), walkDist: mean(agg.dist) });
    const r = out[out.length - 1]!;
    console.log(Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isNaN(v) ? '-' : v.toFixed(3)) : v}`).join('  '));
  }
}
