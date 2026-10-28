// 게임 실사용 API (README 결정 game-1·game-3, docs/API.md '게임에 넣기'): 반응 뒤 게임 애니 복귀, 복귀 가능 시점 이벤트, 반응 변주.
import { describe, it, expect } from 'vitest';
import { World, type Character, type SimEvent } from '../src/sim/api';
import { findScenario, loadInputs, loadScenario } from '../tools/simCommon';
import { resumeCase } from './snapshotCases';

const inp = loadInputs(loadScenario(findScenario('walk_push_return')));

async function walker(seed = 1, variation?: boolean): Promise<{ w: World; ch: Character }> {
  const w = await World.create({ seed });
  const ch = w.addCharacter(inp.character, inp.ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Animated', pose: 'kimodo_walk_forward' }, variation === undefined ? {} : { variation });
  return { w, ch };
}
const steps = (w: World, s: number) => { for (let i = 0; i < Math.round(s * 120); i++) w.step(); };

describe('game API: return to animation (game-1)', () => {
  it('walk (Animated) → push → recovered → back to Animated walk, no pin during reaction, continuous', async () => {
    const { w, ch } = await walker();
    const got: SimEvent[] = [];
    for (const ev of ['recovered', 'returnStart', 'returnDone', 'returnCancel'] as const) ch.on(ev, (e) => got.push(e));
    let fell = 0;
    ch.on('fell', () => fell++);
    steps(w, 1.0);
    ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, -1], magnitude: 0.3, duration: 0.15 });
    expect(ch.returnToAnimation('kimodo_walk_forward')).toBe(true);
    let pinReact = 0, maxJump = 0;
    let prev: Record<string, number[]> | null = null;
    for (let i = 0; i < 4 * 120; i++) {
      w.step();
      const s = ch.getState();
      if (s.time < 1.7) pinReact += s.assist.pin;
      const pos = Object.fromEntries(Object.entries(s.bodies).map(([n, b]) => [n, b.pos]));
      if (prev && s.returnAnim?.kinT !== null && s.returnAnim && Math.abs(s.time - (s.returnAnim.kinT ?? -1) - w.dt) < 1e-9) {
        for (const [n, p] of Object.entries(pos)) maxJump = Math.max(maxJump, Math.hypot(p[0]! - prev[n]![0]!, p[1]! - prev[n]![1]!, p[2]! - prev[n]![2]!));
      }
      prev = pos;
    }
    const s = ch.getState();
    expect(s.state).toBe('Animated');
    expect(fell).toBe(0); // 걷기 클립은 두 발이 잠깐 뜨는 순간이 있어 자세 대신 넘어짐 알림으로 본다
    expect(s.returnAnim?.phase).toBe('done');
    expect(pinReact).toBe(0);
    const types = got.map((e) => e.type);
    expect(types).toEqual(['returnStart', 'recovered', 'returnDone']);
    // 키네마틱 전환 스텝 바디 이동량: 걷는 속도 수준 (1.4 m/s·dt ≈ 1.2cm, 순간이동 없음)
    expect(maxJump).toBeLessThan(0.05);
    // 'recovered'는 알림 전용 (로그에 없음), 복귀 이벤트는 로그에 남는다
    expect(w.events.some((e) => e.type === 'recovered')).toBe(false);
    expect(w.events.some((e) => e.type === 'returnDone')).toBe(true);
    w.free();
  }, 120_000);

  it("'now' returns a standing Active body to the clip at once (kinematic + inertialization)", async () => {
    const w = await World.create({ seed: 1 });
    const ch = w.addCharacter(inp.character, inp.ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' });
    steps(w, 0.5);
    expect(ch.returnToAnimation('kimodo_idle_relaxed', { when: 'now', blendTime: 0.4 })).toBe(true);
    steps(w, 0.05);
    expect(ch.getState().state).toBe('Animated');
    steps(w, 0.5);
    expect(ch.getState().returnAnim?.phase).toBe('done');
    expect(ch.getState().debug.exploded).toBe(0);
    w.free();
  }, 60_000);

  it('a hit during the wait keeps waiting; recoveryStatus explains what blocks the return', async () => {
    const { w, ch } = await walker();
    steps(w, 0.5);
    ch.hit({ type: 'push', body: 'Spine2', direction: [1, 0, 0], magnitude: 0.25, duration: 0.15 });
    ch.returnToAnimation('kimodo_walk_forward');
    steps(w, 0.3);
    const st = ch.recoveryStatus();
    expect(st.recovered).toBe(false);
    expect(st.blockedBy).not.toBe('');
    expect(ch.getState().returnAnim?.phase).toBe('wait');
    ch.cancelReturn();
    w.step(); // getState는 스텝마다 한 번 계산한다
    expect(ch.getState().returnAnim?.phase).toBe('cancel');
    w.free();
  }, 60_000);

  it('unknown clip throws', async () => {
    const { w, ch } = await walker();
    expect(() => ch.returnToAnimation('no_such_clip')).toThrow(/unknown anim clip/);
    w.free();
  });
});

describe('game API: reaction variation (game-3)', () => {
  const run = async (seed: number, variation: boolean) => {
    const w = await World.create({ seed });
    const ch = w.addCharacter(inp.character, inp.ragdoll, { position: [0, 0, 0], yaw: 0, state: 'Active', pose: 'stand' }, { variation });
    steps(w, 0.5);
    ch.hit({ type: 'push', body: 'Spine2', direction: [0, 0, -1], magnitude: 'small' });
    steps(w, 1.0);
    const out = { state: JSON.stringify(ch.getState().bodies), v: ch.reactionVariation() };
    w.free();
    return out;
  };
  it('deterministic per seed; off draws nothing', async () => {
    const a = await run(3, true), b = await run(3, true), c = await run(4, true), off = await run(3, false);
    expect(a.state).toBe(b.state);
    expect(a.v).toEqual(b.v);
    expect(a.v).not.toEqual(c.v);
    expect(off.v).toBeNull();
    expect(a.v!.arm).toBeGreaterThan(0.8);
    expect(a.v!.arm).toBeLessThan(1.2);
  }, 120_000);
});

describe('serialization: game return', () => {
  // 기다림(반응 중) · 키네마틱 관성화 직후 · 두 번째 피격 뒤에서 저장 → 복원 → 이어 돌리기
  resumeCase('walk_push_return', [0.35, 0.495, 0.66]);
});
