// v0.8a 지형: 지형 정의·해석식 지면 높이, 상자 콜라이더와 레이캐스트 일치, 발판 검사(계단 코에 걸친 발은 디딜 수 없음), 경사면 발판.
import { describe, it, expect } from 'vitest';
import { initRapier, PhysicsWorld } from '../src/sim/world';
import { terrainDef, terrainHeightAt, isFlatTerrain } from '../src/sim/terrain';
import { castGround, probeFoothold } from '../src/sim/character/perception';
import simCfg from '../config/sim.json';

const st = simCfg.terrain.stairs;
const half: [number, number, number] = [0.056, 0.062, 0.1249];
const fh = { grid: [3, 5] as [number, number], levelTol: 0.02, minSupported: 1, maxSlopeDeg: 30, margin: 0.015 };

describe('terrain (v0.8a)', () => {
  it('flat is flat and exactly 0; stairs heights step down by rise per run', () => {
    expect(isFlatTerrain(terrainDef('flat'))).toBe(true);
    expect(terrainHeightAt(terrainDef('flat'), 3, -2)).toBe(0);
    const d = terrainDef('stairs');
    const H = st.count * st.rise;
    expect(terrainHeightAt(d, 0, -0.5)).toBeCloseTo(H, 9);
    for (let k = 1; k < st.count; k++) expect(terrainHeightAt(d, 0, (k - 0.5) * st.run)).toBeCloseTo(H - k * st.rise, 9);
    expect(terrainHeightAt(d, 0, st.count * st.run + 0.5)).toBe(0);
  });

  it('raycast hits the same heights as the analytic definition (stairs, ledge, slope)', async () => {
    await initRapier();
    for (const name of ['stairs', 'ledge', 'slope20', 'box_obstacle'] as const) {
      const pw = new PhysicsWorld({ terrain: name });
      for (const [x, z] of [[0, -0.6], [0.3, 0.45], [-0.2, 1.05], [0, 3.0], [0.4, 5]]) {
        const g = castGround(pw, [x!, 10, z!], 20);
        expect(g).not.toBeNull();
        expect(g!.point[1]).toBeCloseTo(pw.groundHeightAt(x!, z!), 3);
      }
      pw.free();
    }
  });

  it('foothold: centered on a tread is steppable, straddling a nosing is not', async () => {
    await initRapier();
    const pw = new PhysicsWorld({ terrain: 'stairs' });
    const mid = probeFoothold(pw, [0, 1.5 * st.run], 0, half, 3, fh)!;
    expect(mid.steppable).toBe(true);
    expect(mid.height).toBeCloseTo(st.count * st.rise - 2 * st.rise, 3);
    const edge = probeFoothold(pw, [0, st.run + 0.02], 0, half, 3, fh)!;
    expect(edge.steppable).toBe(false);
    expect(edge.above).toBeGreaterThan(0.1);
    pw.free();
  });

  it('foothold: a flat foot on a 20° slope plane is steppable (plane-relative check)', async () => {
    await initRapier();
    const pw = new PhysicsWorld({ terrain: 'slope20' });
    const f = probeFoothold(pw, [0.1, 0.4], Math.PI, half, 3, fh)!;
    expect(f.steppable).toBe(true);
    expect(Math.acos(f.normal[1]) * 180 / Math.PI).toBeCloseTo(20, 1);
    pw.free();
  });
});
