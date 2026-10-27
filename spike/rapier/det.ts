// Determinism run shared by Node and the browser page. Returns per-frame hashes of the full state.
import type RAPIER from '@dimforge/rapier3d-compat';
import { makeDropPush } from './scenario';
import type { Method } from './muscles';

export type DetConfig = { name: string; muscles: Method | null; seed: number; dt: number; iters: number };
export const DET_CONFIGS: DetConfig[] = [
  { name: 'passive', muscles: null, seed: 7, dt: 1 / 120, iters: 8 },
  { name: 'motorB+gc', muscles: 'B', seed: 7, dt: 1 / 120, iters: 8 },
  { name: 'spdC+gc', muscles: 'C', seed: 7, dt: 1 / 120, iters: 8 },
];

function fnv1a(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const enc = new TextEncoder();

export function runDet(R: typeof RAPIER, c: DetConfig) {
  const sc = makeDropPush(R, { mode: 'generic', dt: c.dt, iters: c.iters, seed: c.seed, seconds: 5, muscles: c.muscles, kpScale: 300 });
  const rawHashes: number[] = [];
  const roundHashes: number[] = [];
  let rawAll = 0x811c9dc5, roundAll = 0x811c9dc5;
  let last: number[] = [];
  for (let f = 0; f < sc.frames; f++) {
    sc.step();
    const s: number[] = [];
    sc.rd.state(s);
    const raw = new Uint8Array(new Float64Array(s).buffer);
    const rnd = enc.encode(s.map((x) => x.toFixed(4)).join(','));
    rawHashes.push(fnv1a(raw));
    roundHashes.push(fnv1a(rnd));
    rawAll = fnv1a(raw, rawAll);
    roundAll = fnv1a(rnd, roundAll);
    last = s;
  }
  const hips = sc.rd.byName.get('Hips')!.rb.translation();
  sc.world.free();
  return { name: c.name, frames: rawHashes.length, rawAll, roundAll, rawHashes, roundHashes, last, hipsFinal: [hips.x, hips.y, hips.z] };
}
export type DetResult = ReturnType<typeof runDet>;
