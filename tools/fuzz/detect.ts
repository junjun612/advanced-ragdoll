// 퍼징 감지기 (SPEC 12 v0.9) — 실행기와 분리해 학습 환경(무작위 초기 상태 평가·에피소드 종료 판정)에서도 다시 쓴다 (README 9f-6).
// 쓰는 법: const d = new FuzzDetector(world); 매 world.step() 뒤 d.step(world); 끝나면 d.findings, d.maxAngVel …
// 읽기만 한다 — 시뮬레이션 결과를 바꾸지 않는다.
// 층(layer): physics = 랙돌·Rapier·근육 구동 계층(폭발·NaN·관통·오류, 추종기를 바꿔도 남는다 → 고친다),
//            controller = 행동·제어기 계층 갇힘(누운 채 시도 없음·같은 행동 오래·겟업 실패 반복·진동 → 목록만 남긴다, 1.0 이후 학습형 추종기로 바뀜)
import type { World, Character } from '../../src/sim/api';
import { terrainDef, baseHeightAt, type TerrainDef } from '../../src/sim/terrain';
import type { BodyName, Vec3, SimEvent } from '../../src/sim/types';
import fuzzCfg from '../../config/fuzz.json';
import simCfg from '../../config/sim.json';

export type FindingKind = 'explosion' | 'nan' | 'penetration' | 'tunnel' | 'stuckBehavior' | 'stuckGettingUp' | 'getupFailLoop' | 'lyingStuck' | 'oscillation' | 'error';
export const FATAL: FindingKind[] = ['explosion', 'nan', 'penetration', 'tunnel', 'error'];

export interface Finding {
  kind: FindingKind;
  char: string;
  t: number;
  detail: string;
  /** 그때 켜진 행동·상태 (원인 분류용) */
  ctx?: string;
}

const D = fuzzCfg.detect;

function behaviorsOf(ch: Character): string {
  const s = ch.getState();
  return `${s.state}/${s.posture} [${s.behaviors.filter((b) => b.weight > 0).map((b) => b.name).join(',')}]${s.getup ? ` getup:${s.getup.phase}` : ''}`;
}

/** 바디 중심이 지형 표면 아래로 들어간 깊이 (m, 지면 판·상자·벽 안). 0 = 밖 */
function tunnelDepth(td: TerrainDef, p: Readonly<Vec3>): number {
  let d = 0;
  const base = baseHeightAt(td, p[2]);
  // 바닥 판은 flatHalfExtent 안에서만 (경사를 굴러 내려간 프롭이 판 끝 밖으로 떨어지는 것은 관통이 아니다)
  const half = simCfg.terrain.flatHalfExtent;
  const onPlate = Math.abs(p[0]) < half && Math.abs(p[2]) < half * Math.cos((td.slopeDeg * Math.PI) / 180);
  if (onPlate && p[1] < base && base - p[1] < 1) d = Math.max(d, (base - p[1]) * Math.cos((td.slopeDeg * Math.PI) / 180));
  for (const b of td.boxes) {
    const top = b.center[1] + b.half[1], bot = b.center[1] - b.half[1];
    if (Math.abs(p[0] - b.center[0]) < b.half[0] && Math.abs(p[2] - b.center[2]) < b.half[2] && p[1] < top && p[1] > bot) {
      // 가장 가까운 면까지 거리 (위·옆)
      const inX = b.half[0] - Math.abs(p[0] - b.center[0]), inZ = b.half[2] - Math.abs(p[2] - b.center[2]), inY = top - p[1];
      d = Math.max(d, Math.min(inX, inZ, inY));
    }
  }
  for (const w of td.props) {
    if (w.kind !== 'wall') continue;
    const ins = [0, 1, 2].map((i) => w.half[i]! - Math.abs(p[i]! - w.center[i]!));
    if (ins.every((x) => x > 0)) d = Math.max(d, Math.min(...ins));
  }
  return d;
}

class CharWatch {
  readonly name: string;
  private behStart = new Map<string, number>();
  private behMax = new Map<string, number>();
  private gettingUpStart: number | null = null;
  private lyingSince: number | null = null;
  private lastGetupStart = -1;
  private getupFails = 0;
  private giveUps = 0;
  private prevW: Vec3[] | null = null;
  private flips: number[][] = [];
  private oscSince: number | null = null;
  private reported = new Set<string>();
  /** 관절별 (시각, 한 스텝 근육 목표 변화 각(도)) 최근 0.25초 */
  readonly tgtJump = new Map<string, [number, number][]>();
  /** 관절별 (시각, 제한 넘음(도)) 최근 0.1초 */
  private readonly violHist = new Map<string, [number, number][]>();
  private prevTgt = new Map<string, Vec3>();
  /** 폭발 판정 바디의 자세 차분 각속도(이번·다음 스텝, 실제로 돈 각/dt)를 상세에 붙인다 — 솔버가 보고한 속도만 튄 것인지 가린다 */
  private pendingFd: { f: Finding; body: string; n: number } | null = null;
  private prevRot = new Map<string, number[]>();
  dead = false;
  fell = false;

  constructor(readonly ch: Character, readonly findings: Finding[], idx: number) {
    this.name = ch.name ?? (idx === 0 ? 'A' : `#${idx}`);
    const add = (kind: FindingKind, e: SimEvent, detail: string) => this.findings.push({ kind, char: this.name, t: e.t, detail, ctx: behaviorsOf(ch) });
    // 폭발: 그 바디 관절(과 부모 관절)의 근육 목표가 직전 0.25초 동안 한 스텝에 가장 크게 바뀐 각(도) — 목표 불연속이 원인인지 가린다
    ch.on('exploded', (e) => {
      const b = (e.detail ?? '').split(' ')[0] ?? '';
      const par = ch.def.bodies.find((x) => x.name === b)?.parent ?? '';
      const jump = (jn: string) => Math.max(0, ...(this.tgtJump.get(jn) ?? []).map((x) => x[1])).toFixed(0);
      // 직전 스텝 그 관절의 제한 넘음(도) 최대 — 접촉에 눌려 관절 제한을 크게 넘었다가 튀어 돌아오는 경우를 가린다
      const viol = Math.max(0, ...(this.violHist.get(b) ?? []).map((x) => x[1])).toFixed(0);
      add(e.detail?.includes('NaN') ? 'nan' : 'explosion', e, `${e.detail ?? ''} (목표 튐 ${b} ${jump(b)}°${par && par !== 'Hips' ? `, ${par} ${jump(par)}°` : ''}, 제한 넘음 ${viol}°)`);
      this.pendingFd = { f: this.findings.at(-1)!, body: b, n: 0 };
    });
    ch.on('getupStart', (e) => { this.lastGetupStart = e.t; });
    ch.on('getupFail', () => { this.getupFails++; });
    ch.on('getupGiveUp', (e) => { this.giveUps++; this.once('getupFailLoop', e.t, `겟업 포기 (실패 ${this.getupFails}회)`); });
  }

  private once(kind: FindingKind, t: number, detail: string): void {
    const key = `${kind}:${detail.split(' ')[0]}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.findings.push({ kind, char: this.name, t, detail, ctx: behaviorsOf(this.ch) });
  }

  step(dt: number): { maxW: number; maxWBody: string } {
    const s = this.ch.getState();
    const t = s.time;
    let maxW = 0, maxWBody = '';
    for (const [jn, j] of Object.entries(s.joints)) {
      const p = this.prevTgt.get(jn);
      if (p) {
        const h = this.tgtJump.get(jn) ?? [];
        h.push([t, Math.max(Math.abs(j.targetDeg[0] - p[0]), Math.abs(j.targetDeg[1] - p[1]), Math.abs(j.targetDeg[2] - p[2]))]);
        while (h.length && h[0]![0] < t - 0.25) h.shift();
        this.tgtJump.set(jn, h);
      }
      this.prevTgt.set(jn, [...j.targetDeg] as Vec3);
      const vh = this.violHist.get(jn) ?? [];
      vh.push([t, j.violationDeg]);
      while (vh.length && vh[0]![0] < t - 0.1) vh.shift();
      this.violHist.set(jn, vh);
    }
    if (this.pendingFd) {
      const pf = this.pendingFd;
      const q = s.bodies[pf.body as BodyName]?.rot, p = this.prevRot.get(pf.body);
      if (q && p) pf.f.detail += ` 차분${pf.n ? '+1' : ''} ${((2 * Math.acos(Math.min(1, Math.abs(p[0]! * q[0] + p[1]! * q[1] + p[2]! * q[2] + p[3]! * q[3])))) / dt).toFixed(1)}`;
      if (++pf.n >= 2) this.pendingFd = null;
    }
    for (const n of Object.keys(s.bodies)) this.prevRot.set(n, [...s.bodies[n as BodyName].rot]);
    // NaN (상태 전체: 바디·COM)
    if (![...s.com, ...s.comVel].every(Number.isFinite)) this.once('nan', t, 'COM NaN');
    // 행동 연속 시간
    const active = new Set(s.behaviors.filter((b) => b.weight > 0).map((b) => b.name));
    if (active.has('Limp')) this.dead = true;
    for (const n of active) if (!this.behStart.has(n)) this.behStart.set(n, t);
    for (const [n, t0] of [...this.behStart]) {
      if (!active.has(n)) { this.behStart.delete(n); continue; }
      const d = t - t0;
      this.behMax.set(n, Math.max(this.behMax.get(n) ?? 0, d));
      if (d >= D.stuckBehavior && !D.stuckBehaviorIgnore.includes(n)) this.once('stuckBehavior', t, `${n} ${d.toFixed(1)}초 연속`);
    }
    // GettingUp 상태 오래
    if (s.state === 'GettingUp') {
      this.gettingUpStart ??= t;
      if (t - this.gettingUpStart >= D.stuckBehavior) this.once('stuckGettingUp', t, `GettingUp ${(t - this.gettingUpStart).toFixed(1)}초`);
    } else this.gettingUpStart = null;
    // 누운 채 겟업 시도 없음 (살아 있고 겟업이 켜져 있을 때)
    if (s.posture === 'down') this.fell = true;
    if (s.posture === 'down' && s.state !== 'GettingUp' && !this.dead && s.getup?.enabled !== false) {
      this.lyingSince ??= t;
      const since = Math.max(this.lyingSince, this.lastGetupStart);
      if (t - since >= D.lyingStuck) this.once('lyingStuck', t, `누운 채 ${(t - since).toFixed(1)}초 시도 없음 (getup ${s.getup?.phase ?? '없음'})`);
    } else this.lyingSince = null;
    if (this.getupFails >= D.getupFailMax) this.once('getupFailLoop', t, `겟업 실패 ${this.getupFails}회`);
    // 진동: 바디 각속도 방향 뒤집힘 횟수 (최근 1초)
    const names = Object.keys(s.bodies) as BodyName[];
    const ws = names.map((n) => s.bodies[n].angVel);
    if (!this.flips.length) this.flips = names.map(() => []);
    let worst = 0, worstBody = '';
    ws.forEach((w, i) => {
      const m = Math.hypot(w[0], w[1], w[2]);
      if (m > maxW) { maxW = m; maxWBody = names[i]!; }
      const p = this.prevW?.[i];
      const fl = this.flips[i]!;
      if (p && m > D.oscMinAngVel && Math.hypot(p[0], p[1], p[2]) > D.oscMinAngVel && p[0] * w[0] + p[1] * w[1] + p[2] * w[2] < 0) fl.push(t);
      while (fl.length && fl[0]! < t - 1) fl.shift();
      if (fl.length > worst) { worst = fl.length; worstBody = names[i]!; }
    });
    this.prevW = ws;
    if (worst >= D.oscFlipsPerSec) {
      this.oscSince ??= t;
      if (t - this.oscSince >= D.oscHold) this.once('oscillation', t, `${worstBody} 각속도 뒤집힘 ${worst}회/초`);
    } else this.oscSince = null;
    void dt;
    return { maxW, maxWBody };
  }

  longest(): Record<string, number> {
    return Object.fromEntries([...this.behMax].map(([k, v]) => [k, Math.round(v * 100) / 100]));
  }
}

/** 접촉 깊이 감시: 몸 콜라이더 ↔ 다른 것(지형·다른 캐릭터·프롭)의 최대 관통 깊이 */
class PenWatch {
  max = 0;
  private reported = new Set<string>();
  constructor(readonly findings: Finding[]) {}

  step(world: World, td: TerrainDef): void {
    const pw = world.physics.world;
    const t = world.time;
    const owner = new Map<number, string>();
    world.characters.forEach((c, i) => { for (const b of c.rd.bodies) for (const col of b.cols) owner.set(col.handle, `${c.name ?? (i === 0 ? 'A' : `#${i}`)}:${b.name}`); });
    world.props.forEach((p) => owner.set(p.col.handle, `prop:${p.def.id}`));
    world.characters.forEach((c, i) => {
      const me = c.name ?? (i === 0 ? 'A' : `#${i}`);
      for (const b of c.rd.bodies) {
        for (const col of b.cols) {
          pw.contactPairsWith(col, (other) => {
            const o = owner.get(other.handle);
            if (o && o.startsWith(`${me}:`)) return; // 몸 안
            pw.contactPair(col, other, (m) => {
              for (let k = 0; k < m.numContacts(); k++) {
                const d = -m.contactDist(k);
                if (d > this.max) this.max = d;
                if (d > D.penetrationMax) {
                  const what = o ?? 'terrain';
                  const key = `${me}:${b.name}|${what.replace(/:.*/, '')}`;
                  if (!this.reported.has(key)) {
                    this.reported.add(key);
                    this.findings.push({ kind: 'penetration', char: me, t, detail: `${b.name} ↔ ${what} 깊이 ${(d * 100).toFixed(1)}cm`, ctx: behaviorsOf(c) });
                  }
                }
              }
            });
          });
        }
        // 지형 빠져나감 (접촉이 없어진 관통)
        const p = b.rb.translation();
        const dd = tunnelDepth(td, [p.x, p.y, p.z]);
        if (dd > D.tunnelDepth) {
          const key = `tunnel:${me}:${b.name}`;
          if (!this.reported.has(key)) { this.reported.add(key); this.findings.push({ kind: 'tunnel', char: me, t, detail: `${b.name} 지형 속 ${(dd * 100).toFixed(1)}cm`, ctx: behaviorsOf(c) }); }
        }
      }
    });
    for (const p of world.props) {
      const q = p.rb.translation();
      const dd = tunnelDepth(td, [q.x, q.y, q.z]);
      if (dd > D.tunnelDepth) {
        const key = `tunnel:prop:${p.def.id}`;
        if (!this.reported.has(key)) { this.reported.add(key); this.findings.push({ kind: 'tunnel', char: `prop:${p.def.id}`, t, detail: `프롭 ${p.def.id} 지형 속 ${(dd * 100).toFixed(1)}cm` }); }
      }
      if (![q.x, q.y, q.z].every(Number.isFinite)) this.findings.push({ kind: 'nan', char: `prop:${p.def.id}`, t, detail: '프롭 NaN' });
    }
  }
}


/** 층별 분류 */
export const LAYER: Record<FindingKind, 'physics' | 'controller'> = {
  explosion: 'physics', nan: 'physics', penetration: 'physics', tunnel: 'physics', error: 'physics',
  stuckBehavior: 'controller', stuckGettingUp: 'controller', getupFailLoop: 'controller', lyingStuck: 'controller', oscillation: 'controller',
};

/** 월드 하나의 감지기: 만든 뒤(캐릭터를 다 넣은 뒤) 매 스텝 step(world)을 부른다 */
export class FuzzDetector {
  readonly findings: Finding[] = [];
  private readonly watches: CharWatch[] = [];
  private readonly pen: PenWatch;
  private readonly td: TerrainDef;
  maxAngVel = 0;
  maxAngBody = '';
  /** (README 9f-11) 충돌 튐 (폭발이 아닌 1~2스텝 속도 초과): 캐릭터, 시각, 바디, 렌더 한 프레임에 보이는 회전각(도), 상세 */
  readonly snaps: { char: string; t: number; body: string; deg: number; detail: string }[] = [];
  constructor(world: World) {
    this.td = terrainDef(world.physics.terrain);
    this.pen = new PenWatch(this.findings);
    world.characters.forEach((c, i) => {
      const cw = new CharWatch(c, this.findings, i);
      this.watches.push(cw);
      c.on('collisionSnap', (e) => this.snaps.push({ char: cw.name, t: e.t, body: e.body ?? '', deg: e.strength ?? 0, detail: e.detail ?? '' }));
    });
  }
  step(world: World): void {
    for (const cw of this.watches) {
      const r = cw.step(world.dt);
      if (r.maxW > this.maxAngVel) { this.maxAngVel = r.maxW; this.maxAngBody = `${cw.name}:${r.maxWBody}`; }
    }
    this.pen.step(world, this.td);
  }
  get maxPenetration(): number { return this.pen.max; }
  get fell(): boolean { return this.watches.some((w) => w.fell); }
  /** 캐릭터 순번 → 이름 */
  nameOf(i: number): string { return this.watches[i]?.name ?? String(i); }
  /** 물리 계층 발견이 있는가 (학습 환경 에피소드 종료·무효 판정용) */
  get physicsFailed(): boolean { return this.findings.some((f) => LAYER[f.kind] === 'physics'); }
}
