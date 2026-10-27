// Browser side of item 4 (determinism) and a quick perf sample. Loaded through Vite by 04-determinism.ts.
import R from '@dimforge/rapier3d-compat';
import { runDet, DET_CONFIGS, type DetResult } from '../det';

declare global {
  interface Window { __det?: { version: string; results: DetResult[]; ua: string } | { error: string } }
}
try {
  await R.init();
  const results = DET_CONFIGS.map((c) => runDet(R, c));
  window.__det = { version: R.version(), results, ua: navigator.userAgent };
  document.getElementById('out')!.textContent = results.map((r) => `${r.name} raw=${r.rawAll} round=${r.roundAll}`).join('\n');
} catch (e) {
  window.__det = { error: String((e as Error)?.stack ?? e) };
}
