// 반응 클립 라이브러리 생성 (2026-10-27, README 결정 159~): 순간 밀림(충격) 뒤 사람이 비틀거리며 멈추는 클립.
// 밀림 조사(push_study)는 0.4초에 걸쳐 Hips를 옮겨서(손으로 계속 미는 동작) 클립 COM이 0.4초 동안 가속하고 그 뒤 급정거·달리기가 섞여,
// 순간 충격(sim의 Δv)을 받은 몸이 물리로 따라갈 수 없었다(추종 QP가 클립의 '밀리는 가속'까지 따라 하며 뒤로 더 가속). 그래서
//   루트 경로 = 밀림 프레임에서 바로 속도 Δv로 출발해 지수로 감속하는 경로 x(t) = D(1 − e^{−t/τ}), D = Δv·τ
// 를 준다(물리적으로 그럴듯한 감속, 걸음·몸통·팔 모양은 Kimodo가 채운다). 프롬프트·정지 키프레임은 밀림 조사와 같다.
// 사용법:
//   npx tsx tools/kimodo/reactLib.ts gen [--dirs back,front,...] [--str s05,s08,s11] [--seeds 1-6]   (서버 RP-v1.2 5310 필요, 캐시 있으면 GPU 없이)
//   npx tsx tools/kimodo/reactLib.ts list   (생성된 후보 clip.json 경로)
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './rig';
import { runCandidates, type ClipSpec } from './candidates';

const S = Math.SQRT1_2;
/** 움직이는 방향(밀려 가는 쪽, 월드 xz: 왼쪽 +X, 앞 +Z)과 힘 방향 문구 */
export const REACT_DIRS: Record<string, { move: [number, number]; text: string }> = {
  back: { move: [0, -1], text: 'on the chest from the front, pushing them backward' },
  front: { move: [0, 1], text: 'in the back from behind, pushing them forward' },
  left: { move: [1, 0], text: 'on their right shoulder from the right side, pushing them to their left' },
  right: { move: [-1, 0], text: 'on their left shoulder from the left side, pushing them to their right' },
  backleft: { move: [S, -S], text: 'on the chest from the front-right, pushing them diagonally backward and to their left' },
  backright: { move: [-S, -S], text: 'on the chest from the front-left, pushing them diagonally backward and to their right' },
  frontleft: { move: [S, S], text: 'in the back from behind on their right side, pushing them diagonally forward and to their left' },
  frontright: { move: [-S, S], text: 'in the back from behind on their left side, pushing them diagonally forward and to their right' },
};
/** 세기: 밀림 직후 Hips 속도 dv (m/s, sim Δv와 같은 뜻)와 감속 시정수 tau (초) → 멈출 때까지 이동 D = dv·tau */
export const REACT_STR: Record<string, { dv: number; tau: number; label: string }> = {
  s05: { dv: 0.5, tau: 0.55, label: 'Δv 0.5' },
  s08: { dv: 0.8, tau: 0.6, label: 'Δv 0.8' },
  s11: { dv: 1.1, tau: 0.65, label: 'Δv 1.1' },
};
const PUSH_FRAME = 30;
const PATH_DT = [0, 3, 6, 9, 12, 15, 18, 24, 30, 39, 48, 60, 75, 89];

export function reactSpec(dir: string, str: string, seeds: number[]): ClipSpec {
  const d = REACT_DIRS[dir]!, s = REACT_STR[str]!;
  const D = s.dv * s.tau;
  const pts: [number, number][] = [[0, 0]];
  const frames: number[] = [0];
  for (const k of PATH_DT) {
    const x = D * (1 - Math.exp(-(k / 30) / s.tau));
    pts.push([d.move[0] * x, d.move[1] * x]);
    frames.push(PUSH_FRAME + k);
  }
  return {
    clip: `react_${dir}_${str}`, label: `${dir} ${s.label} (순간 밀림 → 감속 ${Math.round(D * 100)}cm)`,
    text: `a person standing still is suddenly pushed ${d.text}, and recovers their balance`,
    duration_s: 4, models: ['rp12'], seeds, startPose: 'stand', rootMotion: 'kept',
    holdStartFrames: [24, 30], rootPath: { points: pts, frames },
    expect: { dir: d.move, endStillSpeed: 0.3 }, weights: { startPoseDeg: 0, endPoseDeg: 1.0 }, top: 3, filmCamera: Math.abs(d.move[0]) > 0.9 ? 'front' : 'side',
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (k: string, dflt: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : dflt; };
  const dirs = opt('--dirs', Object.keys(REACT_DIRS).join(',')).split(',');
  const strs = opt('--str', Object.keys(REACT_STR).join(',')).split(',');
  const sr = opt('--seeds', '1-6');
  const seeds = sr.includes('-') ? (() => { const [a, b] = sr.split('-').map(Number); return Array.from({ length: b! - a! + 1 }, (_, i) => a! + i); })() : sr.split(',').map(Number);
  const specDir = join(ROOT, 'tools', 'kimodo', 'specs', 'react_lib');
  mkdirSync(specDir, { recursive: true });
  if (argv[0] === 'list') {
    for (const d of dirs) for (const s of strs) for (const sd of seeds) {
      const p = join(ROOT, 'assets', 'kimodo', `react_${d}_${s}`, `rp12_s${sd}`, 'clip.json');
      if (existsSync(p)) console.log(p);
    }
    return;
  }
  for (const d of dirs) for (const s of strs) {
    const spec = reactSpec(d, s, seeds);
    const sp = join(specDir, `${spec.clip}.json`);
    writeFileSync(sp, JSON.stringify(spec, null, 2));
    console.log(`== ${spec.clip}: ${spec.label}`);
    await runCandidates(sp, { render: false, variant: 'fbx' });
  }
}

if (process.argv[1]?.endsWith('reactLib.ts')) main().catch((e) => { console.error(e); process.exit(1); });
