// v0.9 공개 API (SPEC 7.2, docs/API.md): SPEC 이벤트(fell·gotUp·grabbed·released), 레퍼런스 경계, 앱 import 규칙.
// 알림 이벤트를 들어도 시뮬레이션·로그가 바뀌지 않아야 한다 (README 결정 9a-4).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimEvent } from '../src/sim/api';
import { runScenario, type RunResult } from '../src/sim/runner';
import { findScenario, loadInputs, loadScenario } from '../tools/simCommon';

const outputs = (r: RunResult) => ({ log: r.log, summary: JSON.stringify(r.summary), meta: JSON.stringify(r.meta) });
const NOTIFY = ['fell', 'gotUp', 'grabbed', 'released', 'step', 'exploded'] as const;

async function listened(name: string) {
  const inp = loadInputs(loadScenario(findScenario(name)));
  const got: SimEvent[] = [];
  const refs: { t: number; hasJoints: boolean; tracking: boolean; clip: string | null }[] = [];
  const res = await runScenario(inp, {
    listen: (ch) => {
      for (const ev of NOTIFY) ch.on(ev, (e) => got.push(e));
      ch.on('hit', () => { const r = ch.reference(); if (r) refs.push({ t: r.t, hasJoints: !!r.joints, tracking: !!r.tracking, clip: r.clip?.name ?? null }); });
    },
  });
  return { got, refs, res: outputs(res), plain: outputs(await runScenario(inp)) };
}

describe('public API events (v0.9)', () => {
  it('getup_supine: fell then gotUp; listening does not change the run', async () => {
    const { got, res, plain } = await listened('getup_supine');
    const fell = got.filter((e) => e.type === 'fell'), up = got.filter((e) => e.type === 'gotUp');
    expect(fell.length).toBeGreaterThanOrEqual(1);
    expect(up).toHaveLength(1);
    expect(fell[0]!.t).toBeGreaterThan(1);
    expect(up[0]!.t).toBeGreaterThan(fell[0]!.t);
    // 알림 전용: world.events(meta)에 없다
    expect(res.meta).not.toMatch(/"type":"(fell|gotUp)"/);
    expect(res).toEqual(plain);
  }, 300_000);

  it('rail_grab: grabbed with hand and anchor point; released when the hold ends (after the arm goes limp)', async () => {
    const { got, res, plain } = await listened('rail_grab');
    const g = got.filter((e) => e.type === 'grabbed');
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g[0]!.body).toMatch(/Hand$/);
    expect(g[0]!.point).toHaveLength(3);
    expect(res).toEqual(plain);
    // 잡은 팔 힘을 잠깐 빼면(setMuscleScale 0 → 2초에 회복) 그 뒤 잡기가 끝날 때(버텨 냄 recovered, 또는 넘어진 뒤 행동 끝) 'released'가 온다.
    // (결정 rom-6) 놓는 시각은 혼돈 궤적에 달려 있다(어깨 끝 저항 끔: 5.08초 버텨 냄, 켬: 5.24초 넘어진 뒤 6.47초) → 장면 길이(6초)에 3초를 더해 끝나기 전에 놓이게 한다
    const sc0 = loadScenario(findScenario('rail_grab'));
    const inp = loadInputs({ ...sc0, duration: sc0.duration + 3 });
    const ev: SimEvent[] = [];
    await runScenario(inp, {
      listen: (ch) => {
        ch.on('released', (e) => ev.push(e));
        ch.on('grabbed', (e) => { ev.push(e); ch.setMuscleScale(e.body === 'LeftHand' ? 'leftArm' : 'rightArm', 0, 2); });
      },
    });
    const g2 = ev.find((e) => e.type === 'grabbed'), r2 = ev.find((e) => e.type === 'released');
    expect(g2).toBeDefined();
    expect(r2).toBeDefined();
    expect(r2!.body).toBe(g2!.body);
    expect(r2!.t).toBeGreaterThan(g2!.t);
  }, 300_000);

  it('reference(): reference frame is available to listeners (joint targets for the tracker)', async () => {
    const { refs } = await listened('push_front_medium');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.hasJoints)).toBe(true);
  }, 300_000);
});

describe('app uses only the public API', () => {
  it('src/app imports from src/sim only through api.ts', () => {
    const files = readdirSync('src/app').filter((f) => f.endsWith('.ts')).map((f) => join('src/app', f));
    const bad = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/from\s+'(\.\.\/sim\/[^']+)'/g)].map((m) => `${f}: ${m[1]}`)).filter((x) => !x.endsWith("'../sim/api") && !x.endsWith(': ../sim/api'));
    expect(bad).toEqual([]);
  });
});
