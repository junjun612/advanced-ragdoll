// 피격 모델 (SPEC v0.5 '피격 모델', 7.2). 설정: config/hitModel.json, 정의: docs/ALGORITHMS.md v0.5a.
// 종류(push / bullet / melee)마다 충격량 J = 총질량 × Δv × 방향을 어디에 어떻게 나눠 가할지와, 어떤 행동을 켤지를 정한다.
// 크기는 항상 전신 COM Δv라서 종류와 무관하게 COM 속도 변화는 Δv다(나눠 가해도 합이 J).
import type { Ragdoll } from './ragdoll';
import type { BodyName, ShapeDef } from './characterDef';
import { type Vec3, add, sub, scale, dot, length, normalize, cross } from '../math/vec3';
import { type Quat, conjugate, rotate } from '../math/quat';
import { castGround } from './perception';

export type HitType = 'bullet' | 'melee' | 'explosion' | 'push';

export interface HitModelConfig {
  bullet: { defaultMagnitude: number; behaviors: string[]; legBodies: BodyName[]; rayBack: number; pointShare: number; maxPointDv: number; carryBodies: BodyName[] };
  melee: { defaultMagnitude: number; selfShare: number; behaviors: string[] };
  push: { behaviors: string[] };
  /** (v0.5c) 폭발: 전 바디 방사형 충격 (SPEC 7.2: magnitude = 중심 1m 거리 COM Δv, 거리에 반비례) */
  explosion?: ExplosionConfig;
  staggerMinDv: number;
  intensityRefDv: number;
  /** 사망 임계값 (v0.5b, Δv m/s): 종류와 무관하게 이 크기 이상이면 Limp. null이면 끔 */
  deathDv: number | null;
}

/**
 * 폭발 (v0.5c, docs/ALGORITHMS.md v0.5c): 바디 i의 Δv_i = magnitude × refDist / max(minDist, d_i) (d_i = 중심 → 바디 질량 중심),
 * (바디 거리와 COM 거리를 perBodyFalloff로 기하 혼합), 방향 = 중심 → 바디(지면 폭발은 수평 성분만). 지면 근처 폭발(중심이 지면에서 groundBlastHeight 안)은 지면 반사로 위 성분을 더한다:
 * 위 Δv = groundLift × Δv_i × max(0, 1 − h_i / liftFadeHeight) (h_i = 바디 높이, 다리가 가장 많이 들린다).
 * 마지막에 전체를 같은 배율로 맞춰 전신 COM Δv 크기 = magnitude × refDist / max(minDist, d_COM) (7.2 정의 그대로).
 */
export interface ExplosionConfig {
  refDist: number;
  minDist: number;
  groundBlastHeight: number;
  groundLift: number;
  liftFadeHeight: number;
  /** 수평 성분 높이 배율 기울기 (1/m): 1 + heightGain × (바디 높이 − COM 높이), 최소 0.2 */
  heightGain: number;
  /** 바디별 거리 반비례를 얼마나 쓸지 (0 = 전 바디 COM 거리의 Δv, 1 = 바디마다 자기 거리) */
  perBodyFalloff: number;
  behaviors: string[];
  /** 폭발 종류의 사망 임계값 (COM Δv, m/s, 공통 deathDv 대신). null이면 끔. 폭발 Δv는 '날아가는 속도'라 밀기·총탄과 같은 문턱을 쓰지 않는다 (README 결정) */
  deathDv: number | null;
}

/** 상처: 맞은 바디 로컬 좌표 (SPEC 세부 규칙 — 몸이 움직여도 손이 같은 자리를 따라간다) */
export interface Wound {
  id: number;
  body: BodyName;
  /** 바디 로컬 표면 점·바깥 법선 */
  local: Vec3;
  normalLocal: Vec3;
  t: number;
  type: HitType;
  dv: number;
}

export interface ResolvedHit {
  type: HitType;
  body: BodyName;
  dv: number;
  dir: Vec3;
  /** 대표 지점 (월드): 총탄 입사점, 그 밖에는 point 또는 바디 질량 중심(가한 뒤 이벤트에 채운다) */
  point: Vec3 | undefined;
  impulses: { body: BodyName; J: Vec3; point?: Vec3 }[];
  /** 총탄만: 상처 (바디 로컬, id·t는 행동 계층이 채운다) */
  wound: Omit<Wound, 'id' | 't'> | null;
  /** 켤 행동 */
  behaviors: string[];
  /** 반응 강도 0~1 = min(1, Δv / intensityRefDv) */
  intensity: number;
}

interface BodyPose { pos: Vec3; rot: Quat }

const bodyPose = (rd: Ragdoll, name: BodyName): BodyPose => {
  const rb = rd.body(name).rb;
  const t = rb.translation(), q = rb.rotation();
  return { pos: [t.x, t.y, t.z], rot: [q.x, q.y, q.z, q.w] };
};

/** 캡슐 축 선분 (바디 로컬): 형상 로컬 +Y를 shape.rotation으로 돌린 축 × ±halfHeight */
function capsuleSegment(s: Extract<ShapeDef, { type: 'capsule' }>): [Vec3, Vec3] {
  const a = rotate(s.rotation, [0, s.halfHeight, 0]);
  return [scale(a, -1), a];
}

function closestOnSegment(p: Readonly<Vec3>, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const u = l2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, u));
}

/** 반직선 o + t·d (|d| = 1)와 구(중심 c, 반지름 r)의 첫 교점 t (없으면 null) */
function raySphere(o: Readonly<Vec3>, d: Readonly<Vec3>, c: Readonly<Vec3>, r: number): number | null {
  const oc = sub(o, c);
  const b = dot(oc, d), cc = dot(oc, oc) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s, t1 = -b + s;
  return t0 >= 0 ? t0 : t1 >= 0 ? t1 : null;
}

/** 반직선과 캡슐(선분 a-b, 반지름 r)의 첫 교점 t */
function rayCapsule(o: Readonly<Vec3>, d: Readonly<Vec3>, a: Readonly<Vec3>, b: Readonly<Vec3>, r: number): number | null {
  let best: number | null = null;
  const take = (t: number | null) => { if (t !== null && t >= 0 && (best === null || t < best)) best = t; };
  const ab = sub(b, a), L = length(ab);
  if (L > 1e-9) {
    const u = scale(ab, 1 / L);
    // 무한 원기둥: |(o + t d − a) × u|² = r²
    const oa = sub(o, a);
    const dp = sub(d, scale(u, dot(d, u))), op = sub(oa, scale(u, dot(oa, u)));
    const A = dot(dp, dp), B = 2 * dot(dp, op), C = dot(op, op) - r * r;
    const disc = B * B - 4 * A * C;
    if (A > 1e-12 && disc >= 0) {
      for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
        const h = dot(add(oa, scale(d, t)), u);
        if (h >= 0 && h <= L) take(t);
      }
    }
  }
  take(raySphere(o, d, a, r));
  take(raySphere(o, d, b, r));
  return best;
}

/** 반직선과 상자(반크기 h, 원점 중심)의 첫 교점 t (슬랩) */
function rayBox(o: Readonly<Vec3>, d: Readonly<Vec3>, h: Readonly<Vec3>): number | null {
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (Math.abs(o[k]!) > h[k]!) return null; continue; }
    let a = (-h[k]! - o[k]!) / d[k]!, b = (h[k]! - o[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 > t1 || t1 < 0) return null;
  return t0 >= 0 ? t0 : t1;
}

/** 바디 로컬 점 p에서 가장 가까운 형상 표면 점과 바깥 법선 */
export function surfaceAt(shape: ShapeDef, p: Readonly<Vec3>): { point: Vec3; normal: Vec3 } {
  if (shape.type === 'sphere') {
    const n = length(p) > 1e-9 ? normalize(p) : [0, 0, 1] as Vec3;
    return { point: scale(n, shape.radius), normal: n };
  }
  if (shape.type === 'capsule') {
    const [a, b] = capsuleSegment(shape);
    const c = closestOnSegment(p, a, b);
    const dv = sub(p, c);
    const n = length(dv) > 1e-9 ? normalize(dv) : normalize(cross(sub(b, a), [1, 0, 0]));
    return { point: add(c, scale(n, shape.radius)), normal: n };
  }
  // 상자: 가장 가까운 면
  const h = shape.halfExtents;
  let k = 0, best = Infinity;
  for (let i = 0; i < 3; i++) { const d = h[i]! - Math.abs(p[i]!); if (d < best) { best = d; k = i; } }
  const n: Vec3 = [0, 0, 0];
  n[k] = p[k]! >= 0 ? 1 : -1;
  const q: Vec3 = [Math.max(-h[0], Math.min(h[0], p[0])), Math.max(-h[1], Math.min(h[1], p[1])), Math.max(-h[2], Math.min(h[2], p[2]))];
  q[k] = n[k]! * h[k]!;
  return { point: q, normal: n };
}

/**
 * 총탄 입사점 (바디 로컬): 월드 직선 (through − rayBack·dir) + t·dir 이 주 형상 표면과 처음 만나는 점.
 * 빗나가면 through에서 가장 가까운 표면 점.
 */
export function entryPoint(shape: ShapeDef, pose: BodyPose, through: Readonly<Vec3>, dir: Readonly<Vec3>, rayBack: number): { local: Vec3; normalLocal: Vec3 } {
  const qi = conjugate(pose.rot);
  const o = rotate(qi, sub(sub(through, scale(dir, rayBack)), pose.pos));
  const d = normalize(rotate(qi, dir));
  const tLocal = rotate(qi, sub(through, pose.pos));
  let t: number | null = null;
  if (shape.type === 'sphere') t = raySphere(o, d, [0, 0, 0], shape.radius);
  else if (shape.type === 'capsule') { const [a, b] = capsuleSegment(shape); t = rayCapsule(o, d, a, b, shape.radius); }
  else t = rayBox(o, d, shape.halfExtents);
  const p = t === null ? tLocal : add(o, scale(d, t));
  const s = surfaceAt(shape, p);
  return { local: s.point, normalLocal: s.normal };
}

/**
 * 피격 하나를 충격량 목록·상처·켤 행동으로 바꾼다 (Rapier 스텝 직전, 지금 자세 기준).
 * dv = 전신 COM Δv (이미 이름 → 숫자로 바꾼 값, 없으면 종류별 기본값).
 */
export function resolveHit(
  h: { type: HitType; body?: BodyName; point?: Vec3; direction: Vec3 },
  dv: number,
  rd: Ragdoll,
  totalMass: number,
  cfg: HitModelConfig,
): ResolvedHit {
  if (h.type === 'explosion') {
    const r = resolveExplosion(h, dv, rd, cfg);
    const death = cfg.explosion?.deathDv;
    if (death !== null && death !== undefined && r.dv >= death) r.behaviors = ['Limp'];
    return r;
  }
  const dir = normalize(h.direction);
  const body = h.body ?? 'Spine2';
  const J = scale(dir, totalMass * dv);
  const intensity = Math.min(1, dv / cfg.intensityRefDv);
  // 공통 규칙 (v0.5b): 사망 임계값 이상이면 충격 분배는 종류대로, 행동은 Limp만
  const r = resolveHitInner(h, dv, rd, totalMass, cfg, dir, body, J, intensity);
  if (cfg.deathDv !== null && cfg.deathDv !== undefined && dv >= cfg.deathDv) r.behaviors = ['Limp'];
  return r;
}

/** 폭발: 바디마다 거리 반비례 방사형 Δv (+ 지면 반사 위 성분), 합을 COM Δv 정의에 맞춘다. 결과 dv·dir = 실제 전신 COM Δv 크기·방향 */
function resolveExplosion(h: { point?: Vec3; direction: Vec3 }, magnitude: number, rd: Ragdoll, cfg: HitModelConfig): ResolvedHit {
  const ec = cfg.explosion;
  if (!ec) throw new Error('hitModel.json: explosion config missing');
  if (!h.point) throw new Error('explosion hit needs point (blast center, world)');
  const c = h.point;
  const g = castGround(rd.pw, [c[0], c[1] + 2, c[2]], 50);
  const gh = g ? g.point[1] : 0;
  const ground = c[1] - gh <= ec.groundBlastHeight;
  const { com } = rd.com();
  const M = rd.totalMass();
  const dvAt = (d: number) => (magnitude * ec.refDist) / Math.max(ec.minDist, d);
  const dCom = length(sub(com, c));
  const raw: { body: BodyName; J: Vec3 }[] = [];
  let sum: Vec3 = [0, 0, 0];
  for (const b of rd.bodies) {
    const wc = b.rb.worldCom();
    const p: Vec3 = [wc.x, wc.y, wc.z];
    const rv = sub(p, c);
    const d = length(rv);
    // 크기: COM 거리와 바디 거리의 기하 혼합 (perBodyFalloff = 0이면 모두 같은 Δv, 1이면 바디마다 거리 반비례)
    const v = Math.pow(dvAt(dCom), 1 - ec.perBodyFalloff) * Math.pow(dvAt(d), ec.perBodyFalloff);
    // 방향: 지면 폭발은 지면을 따라 수평 방사 + 지면 반사로 낮은 바디를 위로, 공중 폭발은 3D 방사
    const radial = ground ? [rv[0], 0, rv[2]] as Vec3 : rv;
    const rl = length(radial);
    const dir = rl > 1e-6 ? scale(radial, 1 / rl) : [0, 1, 0] as Vec3;
    // 수평 성분은 높을수록 세게 (heightGain/m, COM 높이 기준, 0.2배 이상): 발은 지면 마찰에 붙잡히고 상체가 폭풍을 더 받는다 → 상체가 뒤로 젖혀지며 발이 들린다
    const hk = Math.max(0.2, 1 + ec.heightGain * (p[1] - com[1]));
    let dvv = scale(dir, v);
    dvv = [dvv[0] * hk, dvv[1], dvv[2] * hk];
    if (ground) dvv = add(dvv, [0, ec.groundLift * v * Math.max(0, 1 - (p[1] - gh) / ec.liftFadeHeight), 0]);
    const J = scale(dvv, rd.massOf(b.idx));
    raw.push({ body: b.name, J });
    sum = add(sum, J);
  }
  // 전신 COM Δv 크기를 정의값으로 (방향은 바디별 합이 정한다)
  const want = dvAt(dCom);
  const got = length(sum) / M;
  const k = got > 1e-9 ? want / got : 0;
  const impulses = raw.map((r) => ({ body: r.body, J: scale(r.J, k) }));
  const dir = got > 1e-9 ? normalize(sum) : [0, 1, 0] as Vec3;
  return { type: 'explosion', body: 'Hips', dv: want, dir, point: [...c] as Vec3, impulses, wound: null, behaviors: [...ec.behaviors], intensity: Math.min(1, want / cfg.intensityRefDv) };
}

function resolveHitInner(
  h: { type: HitType; body?: BodyName; point?: Vec3; direction: Vec3 },
  dv: number, rd: Ragdoll, totalMass: number, cfg: HitModelConfig, dir: Vec3, body: BodyName, J: Vec3, intensity: number,
): ResolvedHit {
  if (h.type === 'push') {
    return { type: 'push', body, dv, dir, point: h.point, impulses: [{ body, J, point: h.point }], wound: null, behaviors: [...cfg.push.behaviors], intensity };
  }
  if (h.type === 'bullet') {
    const rb = rd.body(body);
    const pose = bodyPose(rd, body);
    const through = h.point ?? pose.pos;
    const e = entryPoint(rb.def.shape, pose, through, dir, cfg.bullet.rayBack);
    const world = add(pose.pos, rotate(pose.rot, e.local));
    const beh = [...cfg.bullet.behaviors];
    if (cfg.bullet.legBodies.includes(body)) beh.push('InjuredLeg');
    if (dv >= cfg.staggerMinDv) beh.push('Stagger');
    // 입사점에 pointShare, 나머지는 몸통 사슬 질량 중심에 질량 비례 (hitModel.json $bulletShare)
    const carry = cfg.bullet.carryBodies;
    const cm = carry.map((n) => rd.massOf(rd.body(n).idx));
    const cs = cm.reduce((a, x) => a + x, 0);
    const jMag = totalMass * dv;
    const share = cs > 0 ? Math.min(cfg.bullet.pointShare, jMag > 0 ? (rd.massOf(rb.idx) * cfg.bullet.maxPointDv) / jMag : 1) : 1;
    const impulses: ResolvedHit['impulses'] = [{ body, J: scale(J, share), point: world }];
    carry.forEach((n, i) => { if (cs > 0) impulses.push({ body: n, J: scale(J, ((1 - share) * cm[i]!) / cs) }); });
    return {
      type: 'bullet', body, dv, dir, point: world, impulses,
      wound: { body, local: e.local, normalLocal: e.normalLocal, type: 'bullet', dv }, behaviors: beh, intensity,
    };
  }
  // melee: selfShare를 맞은 바디에, 나머지를 인접 바디(부모·자식)에 질량 비례로
  const def = rd.def;
  const neighbors = def.bodies.filter((b) => b.name !== body && (b.parent === body || def.bodies.find((x) => x.name === body)?.parent === b.name)).map((b) => b.name);
  const masses = neighbors.map((n) => rd.massOf(rd.body(n).idx));
  const msum = masses.reduce((a, b) => a + b, 0);
  const self = msum > 0 ? cfg.melee.selfShare : 1;
  const impulses: ResolvedHit['impulses'] = [{ body, J: scale(J, self), point: h.point }];
  neighbors.forEach((n, i) => impulses.push({ body: n, J: scale(J, ((1 - self) * masses[i]!) / msum) }));
  return { type: 'melee', body, dv, dir, point: h.point, impulses, wound: null, behaviors: [...cfg.melee.behaviors], intensity };
}
