// 인지 (SPEC 7.1의 2단계, v0.3): 지면 접촉, 발 아래 지면(레이캐스트), 지지 다각형, 발 하중, 압력 중심(CoP).
// 상태 스냅샷(getState)과 균형 계층이 같은 결과를 쓴다(스텝마다 한 번 계산해 캐시). 정의: docs/ALGORITHMS.md v0.3.
import { R } from '../world';
import type { PhysicsWorld } from '../world';
import type { Ragdoll } from './ragdoll';
import type { BodyName } from './characterDef';
import type { ContactState } from '../types';
import { type Vec3, add, dot, sub } from '../math/vec3';
import { rotate } from '../math/quat';
import { convexHull, type Vec2 } from '../math/geometry';

export const FOOT_NAMES = ['LeftFoot', 'RightFoot'] as const;
export type FootName = (typeof FOOT_NAMES)[number];
/** (v0.8a 발가락 바디 실험) 발가락 바디 → 그 발. 발가락 접촉은 발의 지지(지지 다각형·하중)로 센다 */
export const TOE_OF: Readonly<Partial<Record<string, FootName>>> = { LeftToeBase: 'LeftFoot', RightToeBase: 'RightFoot' };
/** 발(또는 그 발가락) 바디인가 */
export const isFootBody = (b: string): boolean => b === 'LeftFoot' || b === 'RightFoot' || b in TOE_OF;

export interface GroundHit {
  /** 레이가 지면에 닿은 점 */
  point: Vec3;
  normal: Vec3;
}

export interface FootPerception {
  name: FootName;
  /** 지면 접촉점이 하나라도 있는가 */
  contact: boolean;
  /** 접촉 법선력 합 (N, 직전 스텝 충격량 / dt) */
  load: number;
  /** 발 아래 지면 (레이캐스트). 없으면 null */
  ground: GroundHit | null;
  /** 발 박스 바닥면 꼭짓점 4개 (월드) */
  sole: Vec3[];
  /** 이 발이 지지 다각형에 넣은 점 (xz) */
  support: Vec2[];
  /**
   * (v0.8a, 평지가 아닐 때만) 바닥 꼭짓점마다 그 바로 아래에 지면이 있는가 (꼭짓점에서 짧은 레이). 발이 계단 코 밖으로 나가 허공에 뜬 꼭짓점은
   * 발 가운데 지면 평면 기준으로는 '닿음'으로 보여 지지 다각형·QP 접촉점에 들어갔다 — 받침 없는 곳에 압력 중심을 계획해 몸이 앞으로 흘렀다
   */
  soleSupported?: boolean[];
}

export interface Perception {
  contacts: ContactState[];
  /** 지면에 닿은 바디 */
  ground: Set<BodyName>;
  feet: Record<FootName, FootPerception>;
  /** 지지 다각형 (xz, 반시계 볼록 껍질) */
  supportPolygon: Vec2[];
  /** 발 접촉 법선력 가중 평균 (xz). 발 하중이 없으면 null */
  cop: Vec2 | null;
  /** 발 아래 지면 대표값 (접촉한 발 평균, 없으면 레이가 닿은 발 평균). 없으면 null */
  groundHeight: number | null;
  groundNormal: Vec3 | null;
  /** (v0.8b) 지면이 아닌 지형 물체(난간대·기둥·벽)와의 접촉 (kind = 물체 종류). 지면 접촉(ground)·자세 판정에는 넣지 않는다 */
  props: (ContactState & { kind: string })[];
  /** (v0.8b) 지형 물체에 닿은 바디 */
  propTouch: Set<BodyName>;
  /** (v0.8b) 'grabbable' 콜라이더(난간대·잡을 모서리 받침)에 닿은 바디 */
  grabTouch: Set<BodyName>;
}

export interface PerceptionConfig {
  groundContactDist: number;
  soleContactDist: number;
  rayLength: number;
  /**
   * (v0.5b) 허벅지 캡슐(반지름 7.2cm)이 무릎 관절점에서 이 거리(m) 안에서 지면에 닿으면 무릎(정강이) 접촉으로 본다.
   * 허벅지·정강이 캡슐 끝 구가 모두 무릎 관절점에 중심을 두고 허벅지가 더 굵어(정강이 5.5cm), 무릎을 꿇으면 허벅지 끝이 먼저 닿는다 (README 결정)
   */
  kneeContactDist?: number;
}

/** 지면 콜라이더들로 아래 방향 레이캐스트 (가장 가까운 것). */
export function castGround(pw: PhysicsWorld, origin: Readonly<Vec3>, maxDist: number): GroundHit | null {
  const ray = new R.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: 0, y: -1, z: 0 });
  let best: GroundHit | null = null, bestToi = Infinity;
  for (const c of pw.groundColliders) {
    const hit = c.castRayAndGetNormal(ray, maxDist, true);
    if (hit && hit.timeOfImpact < bestToi) {
      bestToi = hit.timeOfImpact;
      best = { point: [origin[0], origin[1] - hit.timeOfImpact, origin[2]], normal: [hit.normal.x, hit.normal.y, hit.normal.z] };
    }
  }
  return best;
}

/** 발 박스 바닥면(로컬 −Y) 꼭짓점 4개 (월드) */
export function soleCorners(pos: Readonly<Vec3>, rot: Readonly<[number, number, number, number]>, half: Readonly<Vec3>): Vec3[] {
  const out: Vec3[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) out.push(add(pos, rotate(rot, [sx * half[0], -half[1], sz * half[2]])));
  return out;
}

export function perceive(rd: Ragdoll, pw: PhysicsWorld, cfg: PerceptionConfig): Perception {
  // 지면 접촉 (자기 충돌 제외)
  const contacts: ContactState[] = [];
  const ground = new Set<BodyName>();
  const grabTouch = new Set<BodyName>();
  const footPts: Record<FootName, Vec2[]> = { LeftFoot: [], RightFoot: [] };
  const footLoad: Record<FootName, number> = { LeftFoot: 0, RightFoot: 0 };
  let copW = 0, copX = 0, copZ = 0;
  // 무릎 관절점 (정강이 바디의 관절 앵커)
  const knee = (thigh: BodyName): Vec3 | null => {
    const shin = rd.bodies.find((x) => x.def.parent === thigh);
    const a = shin?.def.joint?.anchorInChild;
    if (!shin || !a) return null;
    const t = shin.rb.translation(), q = shin.rb.rotation();
    return add([t.x, t.y, t.z], rotate([q.x, q.y, q.z, q.w], a));
  };
  for (const b of rd.bodies) {
    const isFoot = b.name === 'LeftFoot' || b.name === 'RightFoot' || b.name in TOE_OF;
    const footOf = (TOE_OF[b.name] ?? b.name) as FootName;
    const kp = cfg.kneeContactDist && (b.name === 'LeftUpLeg' || b.name === 'RightUpLeg') ? knee(b.name) : null;
    for (const bc of b.cols) for (const g of pw.groundColliders) {
      const grabG = pw.isGrabbable(g);
      pw.world.contactPair(bc, g, (m, flipped) => {
        const n = m.normal();
        const normal: Vec3 = flipped ? [n.x, n.y, n.z] : [-n.x, -n.y, -n.z];
        for (let i = 0; i < m.numContacts(); i++) {
          if (m.contactDist(i) > cfg.groundContactDist) continue;
          const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
          if (!lp) continue;
          const ct = bc.translation(), cr = bc.rotation();
          const w = rotate([cr.x, cr.y, cr.z, cr.w], [lp.x, lp.y, lp.z]);
          const point: Vec3 = [ct.x + w[0], ct.y + w[1], ct.z + w[2]];
          const impulse = m.contactImpulse(i);
          const name: BodyName = kp && Math.hypot(point[0] - kp[0], point[1] - kp[1], point[2] - kp[2]) < cfg.kneeContactDist! ? (b.name === 'LeftUpLeg' ? 'LeftLeg' : 'RightLeg') : b.name;
          contacts.push({ body: name, point, normal, impulse });
          ground.add(name);
          if (grabG) grabTouch.add(name);
          if (isFoot) {
            const f = footOf;
            footPts[f].push([point[0], point[2]]);
            const force = impulse / pw.dt;
            footLoad[f] += force;
            copW += force;
            copX += force * point[0];
            copZ += force * point[2];
          }
        }
      });
    }
  }

  // (v0.8b) 지형 물체(난간대·기둥·벽) 접촉: 지면과 따로
  const props: (ContactState & { kind: string })[] = [];
  const propTouch = new Set<BodyName>();
  if (pw.propColliders.length) for (const b of rd.bodies) for (const bc of b.cols) for (const g of pw.propColliders) {
    const kind = pw.propKind(g) ?? 'prop', grab = pw.isGrabbable(g);
    pw.world.contactPair(bc, g, (m, flipped) => {
      const n = m.normal();
      const normal: Vec3 = flipped ? [n.x, n.y, n.z] : [-n.x, -n.y, -n.z];
      for (let i = 0; i < m.numContacts(); i++) {
        if (m.contactDist(i) > cfg.groundContactDist) continue;
        const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
        if (!lp) continue;
        const ct = bc.translation(), cr = bc.rotation();
        const w = rotate([cr.x, cr.y, cr.z, cr.w], [lp.x, lp.y, lp.z]);
        props.push({ body: b.name, point: [ct.x + w[0], ct.y + w[1], ct.z + w[2]], normal, impulse: m.contactImpulse(i), kind });
        propTouch.add(b.name);
        if (grab) grabTouch.add(b.name);
      }
    });
  }

  const feet = {} as Record<FootName, FootPerception>;
  const poly: Vec2[] = [];
  let gh = 0, gn: Vec3 = [0, 0, 0], gCount = 0, gContact = false;
  for (const f of FOOT_NAMES) {
    const b = rd.body(f);
    const p = b.rb.translation(), q = b.rb.rotation();
    const pos: Vec3 = [p.x, p.y, p.z];
    const rot: [number, number, number, number] = [q.x, q.y, q.z, q.w];
    const shape = b.def.shape;
    const sole = shape.type === 'box' ? soleCorners(pos, rot, shape.halfExtents) : [];
    const g = castGround(pw, pos, cfg.rayLength);
    const contact = footPts[f].length > 0;
    const support: Vec2[] = [];
    // (v0.8a) 평지가 아니면 꼭짓점 아래 지면 확인 (꼭짓점 위 soleProbeUp m에서 아래로 soleProbeUp + soleContactDist + 0.01 m)
    const soleSupported = pw.flat ? undefined : sole.map((c) => {
      const up = 0.03;
      const h = castGround(pw, [c[0], c[1] + up, c[2]], up + cfg.soleContactDist + 0.01);
      return !!h;
    });
    if (contact) {
      // 지면에서 soleContactDist 안의 바닥 꼭짓점 + 실제 접촉점
      if (g) sole.forEach((c, i) => { if (dot(sub(c, g.point), g.normal) < cfg.soleContactDist && (!soleSupported || soleSupported[i])) support.push([c[0], c[2]]); });
      support.push(...footPts[f]);
      poly.push(...support);
    }
    feet[f] = { name: f, contact, load: footLoad[f], ground: g, sole, support, ...(soleSupported ? { soleSupported } : {}) };
    if (g && (contact || !gContact)) {
      if (contact && !gContact) { gh = 0; gn = [0, 0, 0]; gCount = 0; gContact = true; }
      gh += g.point[1];
      gn = add(gn, g.normal);
      gCount++;
    }
  }
  const nl = Math.hypot(...gn);
  return {
    contacts,
    ground,
    feet,
    supportPolygon: convexHull(poly),
    cop: copW > 0 ? [copX / copW, copZ / copW] : null,
    groundHeight: gCount ? gh / gCount : null,
    groundNormal: gCount && nl > 0 ? [gn[0] / nl, gn[1] / nl, gn[2] / nl] : null,
    props,
    propTouch,
    grabTouch,
  };
}

/** 다각형 넓이 중심 (점이 3개 미만이면 평균) */
export function polygonCentroid(poly: readonly Readonly<Vec2>[]): Vec2 | null {
  if (!poly.length) return null;
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cz += (p[1] + q[1]) * c;
  }
  if (poly.length < 3 || Math.abs(a) < 1e-9) {
    const s = poly.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Vec2, [0, 0] as Vec2);
    return [s[0] / poly.length, s[1] / poly.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// ── (v0.8a) 지면 인지: 디딜 자리(발판) 검사 ──

/** 발판 검사 설정 (config/stepping.json terrain) */
export interface FootholdConfig {
  /** 발바닥 표본 격자 [옆, 앞뒤] 개수 */
  grid: [number, number];
  /** 발바닥 표본이 가운데 지면 평면에서 이 높이(m) 안이면 '받침' */
  levelTol: number;
  /** 받침 비율이 이 값 이상이어야 디딜 수 있다 (발끝 한 줄이 계단 코 밖으로 나가는 정도까지) */
  minSupported: number;
  /** 경사 한계 (도) */
  maxSlopeDeg: number;
  /** 발바닥 표본 범위를 앞뒤로 이만큼(m) 늘린다 (착지 오차 여유: 뒤꿈치가 계단 코에 걸리지 않게) */
  margin?: number;
}

/** 발판 검사 결과: 가운데 지면 높이·법선, 디딜 수 있는가, 받침 비율, 가운데 평면보다 높은 표본의 최대 높이(m, 계단 모서리 위에 걸침) */
export interface Foothold { point: Vec3; height: number; normal: Vec3; steppable: boolean; supported: number; above: number }

/**
 * 발 원점을 (c, yaw)에 놓을 때 발바닥 아래 지면 (레이캐스트). 가운데 레이로 높이·법선을 얻고 발바닥 격자 표본마다 레이를 쏴
 * 가운데 지면 평면(법선 기준, 경사면은 평면 따라 높이가 바뀜)과 비교한다. 디딜 수 있음 = 경사 한계 안 + 평면보다 높은 표본 없음(levelTol) +
 * 받침 비율 ≥ minSupported (발이 계단 단 모서리에 걸치거나 허공에 떠 있지 않음). originY는 레이 시작 높이(그 위에서 아래로).
 */
export function probeFoothold(pw: PhysicsWorld, c: Readonly<Vec2>, yaw: number, half: Readonly<Vec3>, originY: number, cfg: FootholdConfig, maxDist = 6): Foothold | null {
  const g = castGround(pw, [c[0], originY, c[1]], maxDist);
  if (!g) return null;
  const n = g.normal;
  const slopeOk = n[1] >= Math.cos((cfg.maxSlopeDeg * Math.PI) / 180);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const [nx, nz] = cfg.grid;
  let sup = 0, tot = 0, above = -Infinity;
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const lx = nx > 1 ? (2 * i / (nx - 1) - 1) * half[0] * 0.85 : 0;
    const lz = nz > 1 ? (2 * k / (nz - 1) - 1) * (half[2] * 0.92 + (cfg.margin ?? 0)) : 0;
    // 발 로컬 (x 옆, z 앞) → 월드 xz (yaw: 앞 = (sin, cos))
    const dx = lx * cy + lz * sy, dz = -lx * sy + lz * cy;
    const h = castGround(pw, [c[0] + dx, originY, c[1] + dz], maxDist);
    tot++;
    if (!h) continue;
    // 가운데 평면 위 높이: y = g.y − (n.x·dx + n.z·dz)/n.y
    const planeY = g.point[1] - (n[0] * dx + n[2] * dz) / Math.max(1e-3, n[1]);
    const d = h.point[1] - planeY;
    above = Math.max(above, d);
    if (Math.abs(d) <= cfg.levelTol) sup++;
  }
  const supported = tot ? sup / tot : 0;
  return { point: g.point, height: g.point[1], normal: n, steppable: slopeOk && above <= cfg.levelTol && supported >= cfg.minSupported, supported, above: Math.max(0, above) };
}

// ── (v0.8b) 잡을 곳·벽 탐지 (docs/ALGORITHMS.md v0.8b) ──

/** 잡기 인지 설정 (config/behaviors.json grabSense) */
export interface GrabSenseConfig {
  /** 어깨 → 잡을 점 거리가 팔 길이(어깨~손바닥) × maxReach 안이어야 '손이 닿는다' */
  maxReach: number;
  /** 몸통 앞(Spine2 +Z)과 어깨 → 잡을 점 방향의 내적이 이 값 이상 (등 뒤 잡을 곳은 못 본다·못 뻗는다) */
  minFront: number;
  /** 감지 지연 (초): 행동은 이만큼 전의 인지 결과로 판단한다 */
  delay: number;
  /** 벽 탐지: 넘어지는 방향 수평 레이 길이 (m), 레이 시작 바디들 */
  wallProbe: number; wallFrom: string[];
  /** 모서리(어깨보다 아래)는 주저앉아 뻗는 만큼 이 거리(m) 더 멀리까지 후보 */
  crouchReach?: number;
  /** 모서리를 잡으려면 몸통 앞(수평)과 받침 안쪽 방향의 내적이 이 값 이상 (받침을 보고 있음) */
  edgeFacing?: number;
  /** (v0.8c, README 결정 174) 다른 사람 몸통(bodies)도 벽처럼 짚을 곳으로 본다 (레이가 맞은 바디를 따라간다). 없으면 끔 */
  person?: { bodies: string[]; from?: string[] };
}

/** 손 하나의 잡을 곳 후보: 잡을 곳 번호(TerrainDef.grabs), 가장 가까운 점(잡을 곳 축 위), 어깨에서 거리, 팔 길이, 몸통 앞 성분 */
export interface GrabCandidate { feature: number; kind: 'rail' | 'edge'; point: Vec3; dist: number; armLength: number; front: number }
export interface GrabSense { t: number; hands: Partial<Record<'LeftHand' | 'RightHand', GrabCandidate>> }
/** 벽 탐지 결과: 맞은 점, 바깥 법선(몸 쪽), 레이 시작점에서 거리 */
export interface WallSense {
  t: number; point: Vec3; normal: Vec3; dist: number; from: string; dir: Vec3;
  /** (v0.8c) 맞은 것이 다른 사람이면: 이름·바디와, 그 바디 로컬 맞은 점·법선 (사람은 움직이므로 짚는 동안 따라간다) */
  person?: { name: string; body: string; rb: R.RigidBody; cols: R.Collider[]; localPoint: Vec3; localNormal: Vec3 };
}

const HAND_ARM: Record<'LeftHand' | 'RightHand', { arm: string; fore: string }> = { LeftHand: { arm: 'LeftArm', fore: 'LeftForeArm' }, RightHand: { arm: 'RightArm', fore: 'RightForeArm' } };

/**
 * 잡을 곳 탐지 (SPEC v0.8b 인지): 'grabbable' 잡을 곳(난간대 축·받침 윗모서리) 가운데 손마다 어깨에서 가장 가까운 점이
 * 팔 길이 × maxReach 안이고 몸통 앞쪽(minFront)이면 후보. palmLocal = 손바닥 점(손 로컬)
 */
export function senseGrab(rd: Ragdoll, pw: PhysicsWorld, cfg: GrabSenseConfig, palmLocal: Readonly<Vec3>, t: number): GrabSense {
  const out: GrabSense = { t, hands: {} };
  const grabs = pw.terrainDef.grabs;
  if (!grabs.length) return out;
  const s2 = rd.body('Spine2').rb, st = s2.translation(), sq = s2.rotation();
  const qS: [number, number, number, number] = [sq.x, sq.y, sq.z, sq.w];
  const fwd = rotate(qS, [0, 0, 1]);
  for (const h of ['LeftHand', 'RightHand'] as const) {
    const A = rd.def.bodies.find((b) => b.name === HAND_ARM[h].arm)!, F = rd.def.bodies.find((b) => b.name === HAND_ARM[h].fore)!, H = rd.def.bodies.find((b) => b.name === h)!;
    const sh = add([st.x, st.y, st.z], rotate(qS, A.joint!.anchorInParent));
    const L = Math.hypot(...sub(F.joint!.anchorInParent, A.joint!.anchorInChild)) + Math.hypot(...sub(H.joint!.anchorInParent, F.joint!.anchorInChild)) + Math.hypot(...sub(palmLocal as Vec3, H.joint!.anchorInChild));
    let best: GrabCandidate | null = null;
    for (let i = 0; i < grabs.length; i++) {
      const g = grabs[i]!;
      const p = closestOnSegmentP(g.a, g.b, sh);
      const d = sub(p, sh);
      const dist = Math.hypot(...d);
      const front = dist > 1e-6 ? dot(d, fwd) / dist : 1;
      // 모서리가 어깨보다 아래면 주저앉으며 뻗을 수 있는 만큼(crouchReach) 더 멀리까지 본다
      const reach = cfg.maxReach * L + (g.kind === 'edge' && p[1] < sh[1] ? cfg.crouchReach ?? 0 : 0);
      if (dist > reach || front < cfg.minFront) continue;
      // 모서리는 받침 쪽(윗면 안쪽)을 보고 있을 때만 잡는다 — 등진 모서리(앞으로 떨어지는 몸의 발끝 뒤)는 손이 닿지 않는다
      if (g.kind === 'edge' && g.inward) { const fh = Math.hypot(fwd[0], fwd[2]) || 1; if ((fwd[0] * g.inward[0] + fwd[2] * g.inward[2]) / fh < (cfg.edgeFacing ?? 0)) continue; }
      if (!best || dist < best.dist) best = { feature: i, kind: g.kind, point: p, dist, armLength: L, front };
    }
    if (best) out.hands[h] = best;
  }
  return out;
}

function closestOnSegmentP(a: Readonly<Vec3>, b: Readonly<Vec3>, p: Readonly<Vec3>): Vec3 {
  const d = sub(b as Vec3, a as Vec3);
  const L2 = dot(d, d);
  const s = L2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p as Vec3, a as Vec3), d) / L2)) : 0;
  return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
}

/** 벽 탐지 (SPEC v0.8b 인지): 넘어지는 방향(수평 dir)으로 wallFrom 바디들에서 짧은 레이캐스트(wallProbe m), 가장 가까운 벽 */
export function senseWall(rd: Ragdoll, pw: PhysicsWorld, cfg: GrabSenseConfig, dir: Readonly<Vec3>, t: number): WallSense | null {
  const others = cfg.person ? pw.persons.filter((p) => p.bodies !== rd.bodies) : [];
  if (!pw.wallColliders.length && !others.length) return null;
  const n = Math.hypot(dir[0], dir[2]);
  if (n < 1e-6) return null;
  const d = { x: dir[0] / n, y: 0, z: dir[2] / n };
  let best: WallSense | null = null;
  // 사람은 벽보다 좁아 몸 가운데 레이 하나로는 비껴간다 — person.from(어깨·머리)에서도 쏜다 (벽은 wallFrom만, 이전과 같음)
  const froms = [...cfg.wallFrom, ...(others.length ? (cfg.person!.from ?? []).filter((f) => !cfg.wallFrom.includes(f)) : [])];
  for (const from of froms) {
    const o = rd.body(from as BodyName).rb.translation();
    const ray = new R.Ray({ x: o.x, y: o.y, z: o.z }, d);
    if (cfg.wallFrom.includes(from)) for (const c of pw.wallColliders) {
      const hit = c.castRayAndGetNormal(ray, cfg.wallProbe, true);
      if (hit && (!best || hit.timeOfImpact < best.dist)) best = { t, point: [o.x + d.x * hit.timeOfImpact, o.y, o.z + d.z * hit.timeOfImpact], normal: [hit.normal.x, hit.normal.y, hit.normal.z], dist: hit.timeOfImpact, from, dir: [d.x, 0, d.z] };
    }
    // (v0.8c) 다른 사람 몸통: 맞은 점·법선을 그 바디 로컬로 기억해 둔다
    for (const p of others) for (const b of p.bodies) {
      if (!cfg.person!.bodies.includes(b.name)) continue;
      for (const c of b.cols) {
        const hit = c.castRayAndGetNormal(ray, cfg.wallProbe, true);
        if (!hit || (best && hit.timeOfImpact >= best.dist)) continue;
        const point: Vec3 = [o.x + d.x * hit.timeOfImpact, o.y, o.z + d.z * hit.timeOfImpact];
        const normal: Vec3 = [hit.normal.x, hit.normal.y, hit.normal.z];
        const bt = b.rb.translation(), bq = b.rb.rotation();
        const qi: [number, number, number, number] = [-bq.x, -bq.y, -bq.z, bq.w];
        best = { t, point, normal, dist: hit.timeOfImpact, from, dir: [d.x, 0, d.z],
          person: { name: p.name, body: b.name, rb: b.rb, cols: b.cols, localPoint: rotate(qi, [point[0] - bt.x, point[1] - bt.y, point[2] - bt.z]), localNormal: rotate(qi, normal) } };
      }
    }
  }
  return best;
}

/** 감지 지연선: 매 스텝 넣고, delay초 전(그 시각 이전의 마지막) 값을 꺼낸다 */
export class DelayLine<T> {
  private buf: { t: number; v: T }[] = [];
  constructor(public delay: number) {}
  push(t: number, v: T): void {
    this.buf.push({ t, v });
    // delay보다 오래된 것 중 마지막 하나만 남긴다
    while (this.buf.length > 1 && this.buf[1]!.t <= t - this.delay + 1e-9) this.buf.shift();
  }
  get(t: number): T | null {
    let out: T | null = null;
    for (const e of this.buf) { if (e.t <= t - this.delay + 1e-9) out = e.v; else break; }
    return out;
  }
  clear(): void { this.buf = []; }
}
