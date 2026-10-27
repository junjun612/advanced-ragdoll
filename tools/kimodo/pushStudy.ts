// 밀림 반응 레퍼런스 조사 (SPEC 원칙 8 "사람 레퍼런스를 따른다"): 방향 4 × 세기 3 × 모델 2 × 시드 6.
// 사람(Kimodo 모캡 분포)이 같은 밀림에서 제자리로 버티는지, 몇 발 내딛는지, 몸통 기울기·팔 사용·회복 시간·Δv가 어떤지 표로 낸다.
// 사용법: npx tsx tools/kimodo/pushStudy.ts [--no-render]
// 출력: tools/kimodo/specs/push_study/*.json (스펙), assets/kimodo/push_<dir>_<strength>/ (후보), assets/kimodo/push_study/summary.json,
//       assets/kimodo/push_study/push_<dir>.png (세기별 대표, 한글 라벨), 표는 콘솔(마크다운)과 summary.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, Rig, loadDef, loadKimodoConfig, readJson } from './rig';
import { rotate, multiplyQ as mul } from '../../src/sim/math/quat';
import { Soma } from './soma';
import { runCandidates, candLabel, filmName, type Candidate, type ClipSpec } from './candidates';
import { clipToStates, filmClip, somaSkeleton } from './clipToLog';
import { detectOnset, normalize, pushDv, resample, toFrames, type Frame } from './refSimilarity';
import { composeImages } from './compose';
import type { PoseClipFile } from './toPoseClip';

export const DIRS = {
  front: { kor: '앞에서', phrase: 'on the chest from the front, pushing them backward', dir: [0, -1] as [number, number], camera: 'side' },
  back: { kor: '뒤에서', phrase: 'in the back from behind, pushing them forward', dir: [0, 1] as [number, number], camera: 'side' },
  left: { kor: '왼쪽에서', phrase: 'on their left shoulder from the left side, pushing them to their right', dir: [-1, 0] as [number, number], camera: 'front' },
  right: { kor: '오른쪽에서', phrase: 'on their right shoulder from the right side, pushing them to their left', dir: [1, 0] as [number, number], camera: 'front' },
};
/**
 * 세기 = 밀린 뒤 PUSH_RISE_S초 동안 Hips가 밀린 방향으로 옮겨지는 거리 (Kimodo root_path 제약, m).
 * 프롬프트 세기 단어(lightly tapped / pushed firmly / shoved hard)만으로는 RP가 거의 바뀌지 않아서(Δv 0.04~0.10 m/s, 거의 모두 제자리,
 * summary_text_strength.md) 위치 변화로 밀림 크기를 준다. 프롬프트는 세기와 상관없이 같다.
 */
export const STRENGTHS = {
  light: { kor: '가볍게 툭', dispM: 0.06 },
  mild: { kor: '보통', dispM: 0.10 },
  medium: { kor: '살짝 세게', dispM: 0.15 },
  hard: { kor: '세게', dispM: 0.30 },
  veryhard: { kor: '아주 세게', dispM: 0.50 },
  extreme: { kor: '매우 강하게', dispM: 0.80 },
  /** 넘어짐 레퍼런스: 같은 0.5m 경로 + "넘어진다" 프롬프트 */
  fall: { kor: '넘어짐 (프롬프트)', dispM: 0.50 },
};
export const PUSH_FRAME = 30;
export const PUSH_RISE_S = 0.4;
const fallText = (phrase: string) => `a person standing still is suddenly shoved hard ${phrase}, loses their balance and falls to the ground`;
const pushText = (phrase: string) => `a person standing still is suddenly pushed ${phrase}, and recovers their balance`;
type Dir = keyof typeof DIRS;
type Strength = keyof typeof STRENGTHS;

export interface Reaction {
  onsetS: number;
  dvMS: number;
  steps: number;
  peakDispCm: number;
  /** 밀림 방향 성분 최대 COM 이동 (cm) — 음수면 반대로 감 */
  alongCm: number;
  trunkTiltDeg: number;
  armDegS: number;
  recoveryS: number | null;
  directionOk: boolean;
  /** 밀림 0.3초 전~밀림 사이 COM의 밀림 방향 이동 (cm). 크면 밀림을 미리 아는 '예측 반응' → 레퍼런스에서 뺀다 */
  preMoveCm: number;
  anticipatory: boolean;
  /** 넘어짐: Hips 바디 높이가 fallHipsY 아래로 내려감 */
  fell: boolean;
  hipsMinY: number;
  /** 넘어질 때 손(손 바디 중심 y < 0.12)이 Hips(y < 0.35)보다 먼저 바닥 근처에 갔는가 */
  handsFirst: boolean | null;
  /** 물리 타당성: 걸음마다 착지 발 위치와 직전 캡처 포인트(COM + v·√(h/g)) 수평 거리 평균 (cm) */
  cpStepErrCm: number | null;
  /** 물리 타당성: 걸음 없이 버틴 경우 캡처 포인트가 두 발 영역(발 중심 사각형 + 발 반길이 0.12/반폭 0.06) 밖으로 나간 최대 거리 (cm) */
  cpOutsideCm: number | null;
}

const PRE_MOVE_MAX_CM = 2;
const FALL_HIPS_Y = 0.55;

const tilt = (f: Frame): number => {
  const up = rotate(f.rot.Spine2!, [0, 1, 0]);
  return (Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180) / Math.PI;
};

/** 클립(우리 바디) → 반응 지표. 정면 +Z 클립 좌표 기준 dir 방향 */
export function reactionOf(rig: Rig, clip: PoseClipFile, dir: [number, number], onsetFrame?: number): Reaction {
  const fr = resample(toFrames(clipToStates(rig, clip, 1)));
  // 밀림 시점: 경로 제약으로 준 프레임(알고 있으면) 또는 COM 가속도 피크
  const on = onsetFrame ?? (typeof clip.info?.pushFrame === 'number' ? clip.info.pushFrame : detectOnset(fr));
  // 방향은 클립 좌표(0프레임 정면 +Z) 그대로 쓰려고 정면 회전 없이 원점만 옮긴다
  const c = fr[on]!.com;
  const after = fr.slice(on);
  const along = Math.max(...after.map((f) => ((f.com[0] - c[0]) * dir[0] + (f.com[2] - c[2]) * dir[1]))) * 100;
  const peak = Math.max(...after.map((f) => Math.hypot(f.com[0] - c[0], f.com[2] - c[2]))) * 100;
  const nf = normalize(fr, on);
  const t0 = tilt(fr[on]!);
  const aft = nf.filter((f) => f.t >= 0);
  // 걸음·회복·팔은 refSimilarity와 같은 정의
  let steps = 0;
  for (const side of ['LeftFoot', 'RightFoot'] as const) {
    let last: number[] | null = null;
    aft.forEach((f, i) => {
      const down = f.feet[side];
      const p = f.pos[side]!;
      if (down && (i === 0 || !aft[i - 1]!.feet[side]) && last && Math.hypot(p[0] - last[0]!, p[2] - last[2]!) > 0.05) steps++;
      if (down) last = p;
    });
  }
  const sp = (i: number) => {
    const a = aft[Math.max(0, i - 1)]!, b = aft[Math.min(aft.length - 1, i + 1)]!;
    return Math.hypot(b.com[0] - a.com[0], b.com[2] - a.com[2]) / Math.max(1e-9, b.t - a.t);
  };
  let rec: number | null = null, run = 0;
  for (let i = 0; i < aft.length; i++) {
    if (aft[i]!.t < 0.1) continue;
    run = sp(i) < 0.1 ? run + 1 : 0;
    if (run >= 9) { rec = aft[i - 8]!.t; break; }
  }
  const arm = armDegS(aft.filter((f) => f.t <= 2));
  // 예측 반응: 밀림 0.3초 전부터 밀림까지 COM이 밀릴 방향으로 움직인 거리 (키프레임에서 자리 잡는 흔들림은 방향이 섞여 거의 상쇄된다)
  const s0 = Math.max(0, on - 9);
  const preMoveCm = ((fr[on]!.com[0] - fr[s0]!.com[0]) * dir[0] + (fr[on]!.com[2] - fr[s0]!.com[2]) * dir[1]) * 100;
  // 넘어짐·손
  const hipsY = fr.map((f) => f.pos.Hips![1]);
  const hipsMinY = Math.min(...hipsY.slice(on));
  const fell = hipsMinY < FALL_HIPS_Y;
  let handsFirst: boolean | null = null;
  if (fell) {
    const tHand = fr.findIndex((f, i) => i >= on && Math.min(f.pos.LeftHand![1], f.pos.RightHand![1]) < 0.12);
    const tHips = fr.findIndex((f, i) => i >= on && f.pos.Hips![1] < 0.35);
    handsFirst = tHand >= 0 && (tHips < 0 || tHand <= tHips);
  }
  // 캡처 포인트
  const g = 9.81;
  const cpAt = (i: number): number[] => {
    const a = fr[Math.max(0, i - 1)]!, b = fr[Math.min(fr.length - 1, i + 1)]!, dt = b.t - a.t;
    const v = [(b.com[0] - a.com[0]) / dt, (b.com[2] - a.com[2]) / dt];
    const w = Math.sqrt(Math.max(0.3, fr[i]!.com[1]) / g);
    return [fr[i]!.com[0] + v[0]! * w, fr[i]!.com[2] + v[1]! * w];
  };
  const errs: number[] = [];
  for (const side of ['LeftFoot', 'RightFoot'] as const) {
    let last: number[] | null = null;
    for (let i = on; i < fr.length; i++) {
      const f = fr[i]!, down = f.feet[side];
      if (down && !fr[i - 1]!.feet[side] && last && Math.hypot(f.pos[side]![0] - last[0]!, f.pos[side]![2] - last[2]!) > 0.05) {
        const cp = cpAt(i - 1);
        errs.push(Math.hypot(f.pos[side]![0] - cp[0]!, f.pos[side]![2] - cp[1]!) * 100);
      }
      if (down) last = f.pos[side]!;
    }
  }
  let cpOutside: number | null = null;
  if (steps === 0 && !fell) {
    cpOutside = 0;
    for (let i = on; i < fr.length; i++) {
      const L = fr[i]!.pos.LeftFoot!, R = fr[i]!.pos.RightFoot!, cp = cpAt(i);
      const dx = Math.max(0, Math.min(L[0], R[0]) - 0.06 - cp[0]!, cp[0]! - Math.max(L[0], R[0]) - 0.06);
      const dz = Math.max(0, Math.min(L[2], R[2]) - 0.12 - cp[1]!, cp[1]! - Math.max(L[2], R[2]) - 0.12);
      cpOutside = Math.max(cpOutside, Math.hypot(dx, dz) * 100);
    }
  }
  return {
    onsetS: fr[on]!.t, dvMS: pushDv(fr, on), steps, peakDispCm: peak, alongCm: along,
    trunkTiltDeg: Math.max(...aft.map(tilt)) - t0, armDegS: arm, recoveryS: fell ? null : rec, directionOk: along > 0.5 * peak,
    preMoveCm, anticipatory: preMoveCm > PRE_MOVE_MAX_CM, fell, hipsMinY, handsFirst,
    cpStepErrCm: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null, cpOutsideCm: cpOutside,
  };
}

function armDegS(fr: Frame[]): number {
  const inv = (q: number[]) => [-q[0]!, -q[1]!, -q[2]!, q[3]!] as [number, number, number, number];
  let s = 0, n = 0;
  for (let i = 1; i < fr.length; i++) {
    for (const b of ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm']) {
      const a = mul(inv(fr[i - 1]!.rot.Spine2!), fr[i - 1]!.rot[b]!), c = mul(inv(fr[i]!.rot.Spine2!), fr[i]!.rot[b]!);
      const d = Math.min(1, Math.abs(a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3]));
      s += (2 * Math.acos(d) * 180) / Math.PI / (fr[i]!.t - fr[i - 1]!.t);
      n++;
    }
  }
  return n ? s / n : 0;
}

const med = (a: number[]): number => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };
const rng = (a: number[], d = 2): string => (a.length ? `${med(a).toFixed(d)} (${Math.min(...a).toFixed(d)}~${Math.max(...a).toFixed(d)})` : '-');

export function specFor(dir: Dir, strength: Strength): ClipSpec {
  const D = DIRS[dir];
  return {
    clip: `push_${dir}_${strength}`,
    label: `${D.kor} ${STRENGTHS[strength].kor} 밀림 (${Math.round(STRENGTHS[strength].dispM * 100)}cm/${PUSH_RISE_S}초)`,
    text: strength === 'fall' ? fallText(D.phrase) : pushText(D.phrase),
    // 밀림 직전 0.2초(24·30프레임)를 stand 자세로 고정: 텍스트·경로만 주면 모델이 밀림을 미리 알고 2~10cm 먼저 움직였다 (summary_path_only.md)
    holdStartFrames: [PUSH_FRAME - 6, PUSH_FRAME],
    rootPath: {
      points: [[0, 0], [0, 0], [D.dir[0] * STRENGTHS[strength].dispM, D.dir[1] * STRENGTHS[strength].dispM]],
      frames: [0, PUSH_FRAME, PUSH_FRAME + Math.round(PUSH_RISE_S * 30)],
    },
    duration_s: strength === 'fall' ? 5.0 : 4.0,
    models: ['rp12', 'seed11'],
    seeds: [1, 2, 3, 4, 5, 6],
    startPose: 'stand',
    rootMotion: 'kept',
    expect: strength === 'fall' ? { dir: D.dir } : { dir: D.dir, endStillSpeed: 0.3 },
    weights: { startPoseDeg: 0, endPoseDeg: 1.0 },
    top: 3,
    filmCamera: D.camera,
  };
}

async function main(): Promise<void> {
  const render = !process.argv.includes('--no-render');
  const cfg = loadKimodoConfig();
  const rig = new Rig(loadDef(), new Soma(somaSkeleton()), cfg);
  const specDir = join(ROOT, 'tools', 'kimodo', 'specs', 'push_study');
  const outDir = join(ROOT, 'assets', 'kimodo', 'push_study');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const rows: { dir: Dir; strength: Strength; model: string; seed: number; total: number; r: Reaction; cand: Candidate }[] = [];
  for (const dir of Object.keys(DIRS) as Dir[]) {
    for (const strength of Object.keys(STRENGTHS) as Strength[]) {
      const spec = specFor(dir, strength);
      const sp = join(specDir, `${spec.clip}.json`);
      writeFileSync(sp, JSON.stringify(spec, null, 2) + '\n');
      const cands = await runCandidates(sp, { render: false, variant: 'fbx' });
      for (const c of cands) {
        const clip = readJson<PoseClipFile>(c.clipPath);
        rows.push({ dir, strength, model: c.model, seed: c.seed, total: c.scores.total, r: reactionOf(rig, clip, DIRS[dir].dir, PUSH_FRAME), cand: c });
      }
    }
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows.map(({ cand: _c, ...x }) => x), null, 2));

  // 표: 방향 × 세기 × 모델. 유효 = 밀린 방향으로 움직였고 밀림 전에 미리 움직이지 않은 후보 (나머지 통계는 유효 후보만)
  const lines = [
    '| 방향 | 세기 (Hips 이동/0.4초) | 모델 | 유효 | 넘어짐 | 제자리(0걸음) | 걸음 수 분포 | Δv m/s 중앙(범위) | COM 최대 이동 cm | 몸통 기울기 ° | 팔 사용 °/s | 회복 s | CP-착지 cm | CP 이탈 cm | 넘어질 때 손 먼저 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const valid = (r: Reaction) => r.directionOk && !r.anticipatory;
  for (const dir of Object.keys(DIRS) as Dir[]) for (const strength of Object.keys(STRENGTHS) as Strength[]) for (const model of ['rp12', 'seed11']) {
    const rs = rows.filter((x) => x.dir === dir && x.strength === strength && x.model === model).map((x) => x.r);
    const ok = rs.filter(valid);
    const st = ok.filter((r) => !r.fell);
    const fl = ok.filter((r) => r.fell);
    const hist = new Map<number, number>();
    st.forEach((r) => hist.set(Math.min(r.steps, 4), (hist.get(Math.min(r.steps, 4)) ?? 0) + 1));
    const h = [...hist.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k === 4 ? '4+' : k}걸음 ${v}`).join(', ');
    const num = (a: (number | null)[]) => a.filter((x): x is number => x !== null);
    lines.push(`| ${DIRS[dir].kor} | ${STRENGTHS[strength].kor} (${Math.round(STRENGTHS[strength].dispM * 100)}cm) | ${cfg.servers[model]!.label} | ${ok.length}/${rs.length} | ${fl.length}/${ok.length} | ${st.filter((r) => r.steps === 0).length}/${st.length} | ${h || '-'} | ${rng(ok.map((r) => r.dvMS))} | ${rng(st.map((r) => r.peakDispCm), 0)} | ${rng(ok.map((r) => r.trunkTiltDeg), 1)} | ${rng(ok.map((r) => r.armDegS), 0)} | ${rng(num(st.map((r) => r.recoveryS)), 2)} | ${rng(num(st.map((r) => r.cpStepErrCm)), 0)} | ${rng(num(st.map((r) => r.cpOutsideCm)), 0)} | ${fl.length ? `${fl.filter((r) => r.handsFirst).length}/${fl.length}` : '-'} |`);
  }
  const md = ['# 밀림 반응 레퍼런스 조사 (Kimodo)', '',
    '- 밀림 = 0프레임 stand 키프레임 + Hips 경로 제약 (1.0초에 제자리, 1.4초에 밀린 방향으로 세기만큼). 프롬프트는 세기와 무관하게 같다 (넘어짐 행만 "falls" 프롬프트).',
    '- 유효 = COM이 밀린 방향으로 움직였고(진행 성분 > 전체 이동의 절반) 밀림 전 0.3초 동안 밀릴 방향으로 2cm 넘게 미리 움직이지 않은 후보(예측 반응 제외). 나머지 통계는 유효 후보(걸음·회복·CP는 안 넘어진 후보)만.',
    '- CP-착지 = 걸음마다 착지 발과 직전 캡처 포인트 거리 (작을수록 물리적으로 그럴듯). CP 이탈 = 제자리 버팀에서 캡처 포인트가 발 영역 밖으로 나간 최대 거리 (크면 걸음 없이 버티기 어려운 동작).',
    '- 정의: tools/kimodo/pushStudy.ts. 레퍼런스는 전략(걸음 수·타이밍·팔·몸통) 기준이고 정확한 수치 기준이 아니다 (docs/KIMODO.md).', '',
    ...lines, ''].join('\n');
  writeFileSync(join(outDir, 'summary.md'), md);
  console.log(md);

  if (!render) return;
  // 대표 이미지: 방향마다 세기 3줄. 대표 = RP 방향 맞은 후보 중 걸음 수 최빈값, 그중 점수 1위 (없으면 SEED)
  for (const dir of Object.keys(DIRS) as Dir[]) {
    const items = [];
    for (const strength of Object.keys(STRENGTHS) as Strength[]) {
      const pick = (model: string) => {
        const ok = rows.filter((x) => x.dir === dir && x.strength === strength && x.model === model && x.r.directionOk && !x.r.anticipatory);
        if (!ok.length) return null;
        const cnt = new Map<number, number>();
        const key = (x: (typeof ok)[number]) => (x.r.fell ? 99 : x.r.steps);
        ok.forEach((x) => cnt.set(key(x), (cnt.get(key(x)) ?? 0) + 1));
        const mode = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
        return ok.filter((x) => key(x) === mode).sort((a, b) => a.total - b.total)[0]!;
      };
      const p = pick('rp12') ?? pick('seed11');
      if (!p) continue;
      const spec = specFor(dir, strength);
      filmClip(p.cand.clipPath, {
        name: filmName(spec.clip, p.cand), filmArgs: ['--fbx', '--camera', DIRS[dir].camera],
        title: `${spec.label} · ${candLabel(cfg, p.cand)} · ${p.r.fell ? '넘어짐' : p.r.steps === 0 ? '제자리' : `${p.r.steps}걸음`} · Δv ${p.r.dvMS.toFixed(2)}m/s`,
      });
      const fr = Math.floor((readJson<PoseClipFile>(p.cand.clipPath).frames.length - 1) / 30 / 0.1 + 1e-6) + 1;
      items.push({
        png: join(ROOT, 'out', filmName(spec.clip, p.cand), 'film_fbx.png'),
        label: `${STRENGTHS[strength].kor} ${Math.round(STRENGTHS[strength].dispM * 100)}cm · ${candLabel(cfg, p.cand)}`,
        sub: `${p.r.fell ? `넘어짐${p.r.handsFirst ? '(손 먼저)' : ''}` : p.r.steps === 0 ? '제자리 버팀' : `${p.r.steps}걸음`} · Δv ${p.r.dvMS.toFixed(2)}m/s · COM 이동 ${p.r.peakDispCm.toFixed(0)}cm · 몸통 ${p.r.trunkTiltDeg.toFixed(0)}° · 회복 ${p.r.recoveryS?.toFixed(1) ?? '-'}초`,
        cells: Array.from({ length: 10 }, (_, i) => Math.min(fr - 1, 8 + Math.round((i * 27) / 9))),
      });
    }
    await composeImages(items, join(outDir, `push_${dir}.png`), {
      title: `${DIRS[dir].kor} 밀림 — 세기별 대표 반응 (Kimodo 레퍼런스)`, scale: 0.75, note: '칸: 0.8~3.5초 10칸 (밀림 1.0초) · 대표 = 유효 후보의 걸음 수 최빈값 중 자동 점수 1위 (RP 우선)',
    });
    console.log(join(outDir, `push_${dir}.png`));
  }
}

if (process.argv[1]?.endsWith('pushStudy.ts')) main().catch((e: unknown) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
