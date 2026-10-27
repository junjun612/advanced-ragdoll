// Kimodo 서버 클라이언트 (SPEC 11.3, docs/KIMODO.md).
// - 모델 태그(rp12 / seed11)로 서버를 고른다: config/kimodo.json의 url에서 /health 모델 이름을 확인하고, 다르면 다른 서버들을 찾아본다.
// - 요청은 프로세스 안에서 한 번에 하나씩 보낸다 (GPU를 사람의 다른 작업과 공유). 여러 프로세스를 동시에 돌리지 않는다.
// - 요청·응답·BVH를 assets/kimodo/<clip>/<model>_s<seed>/에 저장한다. 같은 요청이 이미 저장돼 있으면 서버를 부르지 않는다.
// - seed는 필수다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadKimodoConfig, type KimodoConfig } from './rig';
import type { KimodoResponse } from './soma';
import type { KimodoKeyframe } from './fromPose';

export interface GenerateRequest {
  text: string;
  duration_s?: number;
  num_frames?: number;
  seed: number;
  fps?: number;
  diffusion_steps?: number;
  cfg_type?: string | null;
  cfg_weight?: number | number[] | null;
  postprocess?: boolean;
  bvh_standard_tpose?: boolean;
  include_frames?: boolean;
  constraints?: {
    root_path?: [number, number][];
    root_path_frames?: number[];
    root_path_heading?: [number, number][];
    keyframes?: KimodoKeyframe[];
    raw?: unknown[];
  };
}

export interface GenerateResult {
  dir: string;
  res: KimodoResponse;
  cached: boolean;
}

export const candidateDir = (clip: string, model: string, seed: number): string =>
  join(ROOT, 'assets', 'kimodo', clip, `${model}_s${seed}`);

let chain: Promise<unknown> = Promise.resolve();
/** 프로세스 안 직렬화 */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function health(url: string, timeoutMs = 10_000): Promise<{ model: string; text_encoder?: string; vram?: unknown } | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as { model: string };
  } catch {
    return null;
  }
}

/** 모델 태그 → 살아 있는 서버 url */
export async function resolveServer(model: string, cfg: KimodoConfig = loadKimodoConfig()): Promise<string> {
  const want = cfg.servers[model];
  if (!want) throw new Error(`모델 태그 없음: ${model} (config/kimodo.json servers: ${Object.keys(cfg.servers).join(', ')})`);
  const urls = [want.url, ...Object.values(cfg.servers).map((s) => s.url).filter((u) => u !== want.url)];
  for (const u of urls) {
    const h = await health(u);
    if (h?.model === want.model) return u;
  }
  throw new Error(`${want.model} 서버를 찾지 못함 (${urls.join(', ')}). docs/KIMODO.md 대로 서버를 켠다`);
}


export async function generate(
  clip: string, model: string, req: GenerateRequest, opts: { force?: boolean; log?: (s: string) => void } = {},
): Promise<GenerateResult> {
  if (!Number.isInteger(req.seed)) throw new Error('seed는 필수다');
  const cfg = loadKimodoConfig();
  const log = opts.log ?? ((s: string) => console.log(s));
  const full: GenerateRequest = {
    fps: cfg.request.fps,
    diffusion_steps: cfg.request.diffusion_steps,
    postprocess: cfg.request.postprocess,
    bvh_standard_tpose: cfg.request.bvh_standard_tpose,
    include_frames: true,
    ...req,
  };
  const dir = candidateDir(clip, model, req.seed);
  const reqPath = join(dir, 'request.json'), resPath = join(dir, 'response.json');
  const saved = { model: cfg.servers[model]?.model, request: full };
  if (!opts.force && existsSync(reqPath) && existsSync(resPath) && readFileSync(reqPath, 'utf8') === JSON.stringify(saved, null, 2)) {
    return { dir, res: JSON.parse(readFileSync(resPath, 'utf8')) as KimodoResponse, cached: true };
  }
  return serial(async () => {
    const url = await resolveServer(model, cfg);
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= cfg.request.retries + 1; attempt++) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${url}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(full),
          signal: AbortSignal.timeout(cfg.request.timeoutS * 1000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
        const res = (await r.json()) as KimodoResponse;
        mkdirSync(dir, { recursive: true });
        writeFileSync(reqPath, JSON.stringify(saved, null, 2));
        writeFileSync(resPath, JSON.stringify(res));
        if (res.bvh_path && existsSync(res.bvh_path)) copyFileSync(res.bvh_path, join(dir, 'motion.bvh'));
        log(`  생성 ${clip} ${model} s${req.seed}: ${((Date.now() - t0) / 1000).toFixed(1)}초 (서버 ${res.timing_s ?? '?'}초)`);
        return { dir, res, cached: false };
      } catch (e) {
        lastErr = e;
        log(`  실패 ${clip} ${model} s${req.seed} (시도 ${attempt}): ${e instanceof Error ? e.message : String(e)}`);
        if (attempt <= cfg.request.retries) await sleep(cfg.request.retryDelayS * 1000 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  });
}
