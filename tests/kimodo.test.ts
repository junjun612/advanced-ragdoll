// Kimodo 파이프라인 (tools/kimodo, SPEC 11.3): 사원수 순서, SOMA FK, 리타깃 왕복, 클립 FK, 루프 이음매.
// 서버를 부르지 않는다. assets/kimodo/에 저장된 응답(요청·시드 포함)을 쓴다.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { type Quat, rotate, fromAxisAngle, angleBetweenQ } from '../src/sim/math/quat';
import { length, sub } from '../src/sim/math/vec3';
import { forwardKinematics } from '../src/sim/character/pose';
import { POSES } from '../src/sim/character/poseLibrary';
import type { PoseFile } from '../src/sim/character/pose';
import { Soma, wxyzToXyzw, xyzwToWxyz, type KimodoResponse, type SomaSkeleton } from '../tools/kimodo/soma';
import { Rig, loadDef, loadKimodoConfig } from '../tools/kimodo/rig';
import { checkFrame0, frameToSoma, fromPose, poseFileFrame } from '../tools/kimodo/fromPose';
import { cleanFlicker, fromClipFrames, retarget, toClipFrames } from '../tools/kimodo/toPoseClip';
import { applyX, features } from '../tools/kimodo/loop';
import { processResponse, type ClipSpec } from '../tools/kimodo/candidates';

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const skel = readJson<SomaSkeleton>('tools/kimodo/somaskel77.json');
const rig = new Rig(loadDef(), new Soma(skel), loadKimodoConfig());
const library = POSES as Record<string, PoseFile>;
const DEG = 180 / Math.PI;
const ROUNDTRIP = 'assets/kimodo/roundtrip_stand';

describe('사원수 순서 (Kimodo wxyz ↔ 우리 xyzw)', () => {
  it('Y축 90° 회전이 같은 회전으로 바뀐다', () => {
    const wxyz = [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 0];
    const q = wxyzToXyzw(wxyz);
    const v = rotate(q, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[2]).toBeCloseTo(-1, 9); // +X를 Y축으로 90° → −Z (오른손)
    expect(xyzwToWxyz(q)).toEqual(wxyz);
  });
  it('왕복이 항등', () => {
    const q: Quat = [0.1, -0.2, 0.3, Math.sqrt(1 - 0.14)];
    expect(wxyzToXyzw(xyzwToWxyz(q))).toEqual(q);
  });
});

describe('SOMA77 FK', () => {
  for (const model of ['rp12', 'seed11']) {
    const p = `${ROUNDTRIP}/${model}_s0/response.json`;
    it.runIf(existsSync(p))(`${model}: 로컬 회전 FK = world_joint_positions (≤ 0.1 mm)`, () => {
      const res = readJson<KimodoResponse>(p);
      const soma = new Soma(res.skeleton);
      let max = 0;
      res.root_positions.forEach((_, t) => {
        const { P } = soma.fkFrame(res, t);
        P.forEach((x, j) => { max = Math.max(max, length(sub(x, res.world_joint_positions[t]![j]!))); });
      });
      expect(max).toBeLessThan(1e-4);
    });
  }
});

describe('리타깃 왕복 (우리 포즈 → Kimodo 키프레임 → 우리 바디)', () => {
  const stand = poseFileFrame(rig, library.stand!, library);

  it('stand → SOMA → 바디: 회전 ≤ 0.01°, 위치 ≤ 1 mm (서버 없이)', () => {
    const { local, root } = frameToSoma(rig, stand);
    const { G, P } = rig.soma.fk(local, root);
    const back = rig.fromSoma(G, P);
    back.rot.forEach((q, i) => expect(angleBetweenQ(q, stand.rot[i]!) * DEG).toBeLessThan(0.01));
    const a = rig.jointPositions(stand), b = rig.jointPositions(back);
    a.forEach((x, i) => expect(length(sub(x, b[i]!))).toBeLessThan(1e-3));
  });

  it('rest 보정: SOMA T-pose(로컬 항등) → 우리 바인드에서 팔다리 분절 방향이 SOMA와 같다', () => {
    const id = rig.soma.names.map((): Quat => [0, 0, 0, 1]);
    const { G, P } = rig.soma.fk(id, [0, 1, 0]);
    const f = rig.fromSoma(G, P);
    // 팔 사슬은 rest(A포즈)보다 armDownDeg만큼 올라가 수평이 된다
    const armRel = rig.jointRel(f).LeftArm!;
    expect(angleBetweenQ(armRel, [0, 0, 0, 1]) * DEG).toBeCloseTo(rig.def.restPose.armDownDeg, 0);
  });

  for (const model of ['rp12', 'seed11']) {
    const p = `${ROUNDTRIP}/${model}_s0/response.json`;
    it.runIf(existsSync(p))(`${model}: 생성 0프레임과 보낸 키프레임 오차 ≤ 2 cm (SPEC 11.3)`, () => {
      const res = readJson<KimodoResponse>(p);
      const fp = fromPose(rig, stand);
      // 저장된 요청의 키프레임이 지금 stand 포즈로 만든 것과 같아야 의미가 있다 (stand.json이 바뀌면 다시 생성: docs/KIMODO.md)
      const req = readJson<{ request: { constraints: { keyframes: { root_position: number[] }[] } } }>(`${ROUNDTRIP}/${model}_s0/request.json`);
      const sentRoot = req.request.constraints.keyframes[0]!.root_position;
      const sameKey = Math.hypot(sentRoot[0]! - fp.keyframe.root_position[0], sentRoot[1]! - fp.keyframe.root_position[1], sentRoot[2]! - fp.keyframe.root_position[2]) < 1e-4;
      const local = req.request.constraints.keyframes[0] as unknown as { local_joints_rot: number[][] };
      const sentFk = rig.soma.fk(local.local_joints_rot.map((r) => {
        const a = Math.hypot(r[0]!, r[1]!, r[2]!);
        return (a < 1e-12 ? [0, 0, 0, 1] : [...fromAxisAngle(r as [number, number, number], a)]) as Quat;
      }), sentRoot as [number, number, number]).P;
      const e = checkFrame0(rig, sameKey ? fp.positions : sentFk, res);
      expect(e.max).toBeLessThanOrEqual(rig.cfg.fromPose.maxFrame0ErrorM);
    });
  }
});

describe('포즈 클립 FK', () => {
  const p = `${ROUNDTRIP}/rp12_s0/response.json`;
  it.runIf(existsSync(p))('클립 저장 → 읽기 → FK가 리타깃 결과와 같고, sim forwardKinematics와도 같다', () => {
    const res = readJson<KimodoResponse>(p);
    const r = retarget(rig, res);
    const clip = { frames: toClipFrames(rig, r.frames, r.contacts) };
    const back = fromClipFrames(rig, clip);
    back.forEach((f, t) => {
      const a = rig.positions(f), b = rig.positions(r.frames[t]!);
      a.forEach((x, i) => expect(length(sub(x, b[i]!))).toBeLessThan(1e-4));
      const fr = clip.frames[t]!;
      const sim = forwardKinematics(rig.def, fr.joints, { pos: fr.root.pos, rot: fr.root.rot });
      sim.forEach((s, i) => expect(length(sub(s.pos, a[i]!))).toBeLessThan(1e-4));
    });
  });
});

describe('발 접촉 정리', () => {
  it('짧은 끊김은 메우고 짧은 접촉은 지운다 (양 끝 구간은 그대로)', () => {
    const T = true, F = false;
    expect(cleanFlicker([T, T, T, F, T, T, T], 3)).toEqual([T, T, T, T, T, T, T]);
    expect(cleanFlicker([F, F, F, T, F, F, F], 3)).toEqual([F, F, F, F, F, F, F]);
    expect(cleanFlicker([T, F, F, F, F, T], 3)).toEqual([T, F, F, F, F, T]);
  });
});

describe('루프 이음매', () => {
  for (const [clip, model, seed] of [['walk_forward', 'rp12', 1], ['idle_relaxed', 'rp12', 2]] as const) {
    const p = `assets/kimodo/${clip}/${model}_s${seed}/response.json`;
    it.runIf(existsSync(p))(`${clip} ${model} s${seed}: 이음매 위치 오차·가속도·관절 각속도 불연속이 기준 이하`, () => {
      const spec = readJson<ClipSpec>(`tools/kimodo/specs/${clip}.json`);
      const res = readJson<KimodoResponse>(p);
      const stand = poseFileFrame(rig, library.stand!, library);
      const out = processResponse(rig, spec, res, model, seed, null, stand);
      const m = out.scores.metrics as Record<string, number> & { seamPosCm: number; seamAccelCm: number; interiorAccelP95Cm: number };
      expect(m.seamPosCm).toBeLessThan(3);
      // 이음매 가속도는 루프 안쪽 가속도 분포 안에 있어야 한다
      expect(m.seamAccelCm).toBeLessThanOrEqual(Math.max(0.5, 1.5 * m.interiorAccelP95Cm));
      // 관절 각속도 불연속: 이음매에서 관절 상대 회전 한 프레임 변화의 변화량 ≤ 안쪽 최대
      const frames = fromClipFrames(rig, out.clip);
      const d = out.clip.loopRootDelta;
      const next = applyX(d ? { yaw: d.yaw, pos: d.pos } : { yaw: 0, pos: [0, 0, 0] }, frames[0]!);
      const seq = [...frames, next, applyX(d ? { yaw: d.yaw, pos: d.pos } : { yaw: 0, pos: [0, 0, 0] }, frames[1]!)];
      const rel = seq.map((f) => rig.jointRel(f));
      const step = (t: number, k: string) => angleBetweenQ(rel[t]![k as 'Spine']!, rel[t + 1]![k as 'Spine']!) * DEG;
      const jerkAt = (t: number) => Math.max(...Object.keys(rel[0]!).map((k) => Math.abs(step(t, k) - step(t - 1, k))));
      const L = frames.length;
      let inner = 0;
      for (let t = 1; t < L - 2; t++) inner = Math.max(inner, jerkAt(t));
      expect(Math.max(jerkAt(L - 1), jerkAt(L))).toBeLessThanOrEqual(Math.max(1, 1.5 * inner));
      expect(features(rig, frames[0]!).length).toBe(rig.bodies.length * 3 + 1);
    });
  }
});

describe('refSimilarity', () => {
  it('DTW: 같은 곡선을 시간만 늘린 것은 거의 0, 다른 곡선은 크다', async () => {
    const { dtw } = await import('../tools/kimodo/refSimilarity');
    const a = Array.from({ length: 30 }, (_, i) => Math.sin(i / 5));
    const b = Array.from({ length: 30 }, (_, i) => Math.sin(Math.min(29, i * 1.15) / 5));
    const c = a.map((x) => x + 1.5);
    const plain = a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0) / 30;
    // 시간 늘림은 DTW가 대부분 흡수한다 (남는 것은 이산화 오차)
    expect(dtw(30, 30, (i, j) => Math.abs(a[i]! - b[j]!), 15).mean).toBeLessThan(0.25 * plain);
    expect(dtw(30, 30, (i, j) => Math.abs(a[i]! - c[j]!), 15).mean).toBeGreaterThan(0.4); // 높이 차이는 DTW로 못 없앤다
  });
  const p = 'assets/poses/kimodo_push_recover_front.json';
  it.runIf(existsSync(p))('레퍼런스를 자기 자신과 비교하면 0, 밀림 시작을 찾는다', async () => {
    const { compare, refStates } = await import('../tools/kimodo/refSimilarity');
    const ref = refStates(p);
    const { detectOnset, resample, toFrames } = await import('../tools/kimodo/refSimilarity');
    const on = detectOnset(resample(toFrames(ref)));
    const r = compare(ref, { events: [{ t: on / 30, type: 'hit' }] }, ref, { scenario: 'self', clip: 'self' });
    expect(r.refSimilarity).toBeLessThan(1e-3);
    expect(r.items.steps.sim).toBe(r.items.steps.ref);
  });
});
