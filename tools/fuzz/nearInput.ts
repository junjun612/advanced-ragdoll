// 근처 입력 시드 묶음 통계 (README 9f-7 회귀 판정): npx tsx tools/fuzz/nearInput.ts <변형: base | old | h8,h12,md,ffv 묶음> <시드 수 N> <시나리오 ... | ALL | falls:<시작 시드>>
// muscles.json 모듈 객체를 그 자리에서 바꿔(모든 캐릭터에 적용) 근처 입력(jitterScenario 시드 1..N)으로 시나리오를 돌린다
import muscles from '../../config/muscles.json';
import hitModelCfg from '../../config/hitModel.json';
import presenceCfg from '../../config/presence.json';
import steppingCfg from '../../config/stepping.json';
import { runScenario } from '../../src/sim/runner';
import { findScenario, loadScenario, loadInputs, jitterScenario } from '../simCommon';

const [v, nS, ...names] = process.argv.slice(2);
// v: old(v0.8c) | 쉼표 묶음 플래그(설정 파일 기준에 더함): h8·h12(손 관성), md(밀기 최소 접촉 0.025초), ffv(발 힘-속도) | base(설정 파일 그대로)
const flags = new Set(v!.split(','));
const m = muscles as unknown as { forceVelocity?: { joints: Record<string, number[]> }; targetInertialize?: { joints: string[] }; coordsNearCurrent?: boolean };
const old = flags.has('old');
if (old) { m.forceVelocity = { joints: {} }; m.targetInertialize!.joints = []; m.coordsNearCurrent = false; }
const hm = hitModelCfg as unknown as { push: { minDuration?: number } };
if (old) hm.push.minDuration = 0;
if (flags.has('md')) hm.push.minDuration = 0.025;
if (flags.has('ffv')) { m.forceVelocity!.joints.LeftFoot = [15, 30]; m.forceVelocity!.joints.RightFoot = [15, 30]; }
// nr: 어깨 끝 저항 끔(결정 rom-3 이전). (README 결정 pres-*) 인간다움 실험 끄기: nd 반응 지연 흔들기, ng 위협 돌아보기, nf 넘어질 곳 보기, ns 머리 안정, nb 호흡, np 전부(= 실험 전 물리)
const pc = presenceCfg as unknown as { reaction: { enabled: boolean }; gaze: { glance: { enabled: boolean }; fallWeight: number; stabilize: { enabled: boolean } }; breath: { enabled: boolean } };
const np = flags.has('np');
if (np || flags.has('nd')) pc.reaction.enabled = false;
if (np || flags.has('ng')) pc.gaze.glance.enabled = false;
if (np || flags.has('nf')) pc.gaze.fallWeight = 0;
if (np || flags.has('ns')) pc.gaze.stabilize.enabled = false;
if (np || flags.has('nb')) pc.breath.enabled = false;
// (결정 tone-4) nsu: 정착 중 상체 자세 감쇠를 다리와 같게(tone-4 이전). tone: 근긴장(공동수축) 켜기(tone-1, 기본 끔)
if (flags.has('nsu')) delete (steppingCfg as unknown as { postureKd: { settleUpper?: number } }).postureKd.settleUpper;
if (flags.has('tone')) (muscles as unknown as { tone: { enabled: boolean } }).tone.enabled = true;
const hand = flags.has('h12') ? 12 : flags.has('h8') ? 8 : null;
const inputs = (sc: Parameters<typeof loadInputs>[0]) => {
  const i = loadInputs(sc);
  const bodies = (i.ragdoll as unknown as { bodies: Record<string, { inertiaScale?: number }> }).bodies;
  if (old) for (const n of ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot']) bodies[n]!.inertiaScale = 4;
  if (hand) for (const n of ['LeftHand', 'RightHand']) bodies[n]!.inertiaScale = hand;
  // (결정 merge2-*) nr: 어깨 끝 저항 끄기(rom-3 이전 물리)
  if (flags.has('nr')) delete (i.ragdoll as { shoulderRom?: unknown }).shoulderRom;
  return i;
};
// falls:<시작 시드> = getup_random_x20과 같은 무작위 쓰러짐(사망 제외)을 N개 돌려 성공(일어서서 Idle, 폭발 없음) 수
if (names[0]?.startsWith('falls:')) {
  const { randomFallScenario } = await import('../../src/sim/getupScenarios');
  const sc0 = loadScenario(findScenario('getup_random_x20'));
  const b = sc0.batch!;
  const start = Number(names[0].slice(6));
  let fell = 0, ok = 0;
  const fails: number[] = [];
  for (let seed = start; seed < start + Number(nS); seed++) {
    const fs = randomFallScenario(seed, { weights: b.weights as never, duration: b.duration, name: `f${seed}`, pushRange: b.pushRange });
    const s = (await runScenario({ ...inputs(fs) })).summary;
    if (!s.fell) continue;
    fell++;
    if (s.metrics.getupSuccess === 1 && !s.exploded) ok++; else fails.push(seed);
  }
  console.log(`${v} falls ${start}+${nS}: 성공 ${ok}/${fell}  실패 ${fails.join(',')}`);
  process.exit(0);
}
const { listScenarioFiles } = await import('../simCommon');
const list = names[0] === 'ALL' ? listScenarioFiles().map(loadScenario).filter((s) => !s.batch && !s.knownIssue).map((s) => s.name) : names;
let tp = 0, tn = 0;
for (const n of list) {
  const sc0 = loadScenario(findScenario(n));
  let pass = 0;
  const fails: string[] = [];
  for (let seed = 1; seed <= Number(nS); seed++) {
    const sc = jitterScenario(sc0, seed);
    const r = await runScenario({ ...inputs(sc) });
    const s = r.summary;
    if (s.expectations.passed) pass++;
    else fails.push(`${seed}:${s.expectations.failures.map((f) => f.split(':')[0]).join('/')}${s.exploded ? `!폭발(${r.meta.events.filter((e) => e.type === 'exploded').map((e) => `${e.t.toFixed(3)} ${e.detail}`).join(';')})` : ''}`);
  }
  console.log(`${v} ${n}: ${pass}/${nS}  실패 ${fails.join(' ')}`);
  tp += pass; tn += Number(nS);
}
console.log(`${v} 합계 ${tp}/${tn}`);
