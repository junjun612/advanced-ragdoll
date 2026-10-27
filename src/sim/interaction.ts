// 캐릭터 간 상호작용·떨어지는 물체 (SPEC 12 v0.8c, docs/ALGORITHMS.md v0.8c). 설정: config/interaction.json.
// - 프롭: 동적 강체(상자·구·캡슐). 시나리오 이벤트로 떨어뜨리거나 던진다.
// - 접촉 감지: Rapier가 이미 물리로 처리한 '다른 캐릭터·프롭' 접촉 충격량을 캐릭터마다 모아(감지 창) 전신 COM Δv(SPEC 7.2)로 바꾼다.
//   충격을 다시 가하지 않는다. 만든 hit은 반응만 일으킨다(Character.senseContact).
import interactionCfg from '../../config/interaction.json';
import { R, type PhysicsWorld } from './world';
import type { BodyName } from './character/characterDef';
import { type Vec3, add, scale, length } from './math/vec3';
import type { Quat } from './math/quat';

export interface InteractionConfig {
  sensing: { window: number; gap: number };
  character: { hitType: 'push' | 'melee'; minDv: number; lookAt: { minDv: number; /** (README 결정 169) 몸통·머리(trunkBodies)에 닿으면 이 문턱 */ trunkMinDv?: number; trunkBodies?: BodyName[]; delay: number; duration: number } | null; grabbable: boolean; noCollide: [BodyName, BodyName][] };
  handover: { standSpeed: number; standDv: number | null; walkDv: number | null; walkMaxDefer: number };
  /** 팔(위팔·전완·손)이 부딪히면 그 팔 근육 배율을 scale로 낮췄다가 recover초에 회복 (setMuscleScale, 이벤트 남음). null이면 끔 */
  armYield: { minDv: number; scale: number; recover: number } | null;
  prop: {
    hitType: 'push' | 'melee';
    minDv: number;
    /** 이보다 느린 프롭(바닥에 놓인 상자를 발로 참 등)은 날아온 충격이 아니라 장애물 접촉: hit은 push(행동 없음), 손으로 누르지 않음 */
    minImpactSpeed: number;
    /** 프롭 속도의 '몸 쪽으로 다가오는' 성분(접촉 법선)이 이보다 작으면 날아온 충격으로 보지 않는다 (m/s) */
    minApproach: number;
    holdWound: { minDv: number; delay: number; duration: number; bodies: BodyName[] } | null;
    defaults: { friction: number; restitution: number; density: number };
  };
  collisionBits: { firstBit: number; maxCharacters: number };
}

export const INTERACTION = interactionCfg as unknown as InteractionConfig;

export type PropShape =
  | { type: 'box'; halfExtents: Vec3 }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; halfHeight: number; radius: number };

/** 프롭 정의 (SPEC 7.2 addProp). 위치·속도는 월드, 회전은 [x, y, z, w] */
export interface PropDef {
  id: string;
  shape: PropShape;
  /** kg. 없으면 부피 × defaults.density */
  mass?: number;
  position: Vec3;
  rotation?: Quat;
  linVel?: Vec3;
  angVel?: Vec3;
  friction?: number;
  restitution?: number;
  /** (v0.8b 훅) 잡을 곳으로 쓸 수 있는가 */
  grabbable?: boolean;
  /** 렌더 색 [r, g, b] 0~1 (없으면 나무색) */
  color?: Vec3;
}

export interface PropState {
  id: string;
  pos: Vec3;
  rot: Quat;
  linVel: Vec3;
  angVel: Vec3;
}

/** meta.json에 남기는 프롭 정보 (렌더가 형상을 만든다) */
export interface PropMeta {
  id: string;
  shape: PropShape;
  mass: number;
  color?: Vec3;
  /** 생긴 시각 (이전 프레임에는 그리지 않는다) */
  t: number;
}

function shapeVolume(s: PropShape): number {
  if (s.type === 'box') return 8 * s.halfExtents[0] * s.halfExtents[1] * s.halfExtents[2];
  if (s.type === 'sphere') return (4 / 3) * Math.PI * s.radius ** 3;
  return Math.PI * s.radius ** 2 * 2 * s.halfHeight + (4 / 3) * Math.PI * s.radius ** 3;
}

export class Prop {
  readonly rb: R.RigidBody;
  readonly col: R.Collider;
  readonly mass: number;
  readonly meta: PropMeta;

  constructor(pw: PhysicsWorld, readonly def: PropDef, t: number, cfg: InteractionConfig = INTERACTION) {
    const d = cfg.prop.defaults;
    this.mass = def.mass ?? shapeVolume(def.shape) * d.density;
    const q = def.rotation ?? [0, 0, 0, 1];
    const lv = def.linVel ?? [0, 0, 0], av = def.angVel ?? [0, 0, 0];
    this.rb = pw.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(def.position[0], def.position[1], def.position[2])
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
        .setLinvel(lv[0], lv[1], lv[2])
        .setAngvel({ x: av[0], y: av[1], z: av[2] })
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const s = def.shape;
    const cd = s.type === 'box' ? R.ColliderDesc.cuboid(s.halfExtents[0], s.halfExtents[1], s.halfExtents[2])
      : s.type === 'sphere' ? R.ColliderDesc.ball(s.radius) : R.ColliderDesc.capsule(s.halfHeight, s.radius);
    cd.setMass(this.mass).setFriction(def.friction ?? d.friction).setRestitution(def.restitution ?? d.restitution);
    this.col = pw.world.createCollider(cd, this.rb);
    this.meta = { id: def.id, shape: def.shape, mass: this.mass, ...(def.color ? { color: def.color } : {}), t };
  }

  state(): PropState {
    const p = this.rb.translation(), q = this.rb.rotation(), lv = this.rb.linvel(), av = this.rb.angvel();
    return { id: this.def.id, pos: [p.x, p.y, p.z], rot: [q.x, q.y, q.z, q.w], linVel: [lv.x, lv.y, lv.z], angVel: [av.x, av.y, av.z] };
  }
}

/** 한 스텝 동안 한 상대에게서 받은 접촉 (Character 쪽 합) */
export interface StepContact {
  /** 상대 이름: 캐릭터 이름 또는 'prop:<id>' */
  source: string;
  kind: 'character' | 'prop';
  /** 몸이 받은 법선 충격량 합 (N·s, 월드) */
  J: Vec3;
  /** 바디별 충격량 크기 합 (맞은 바디 고르기) */
  byBody: Map<BodyName, number>;
  /** 충격량 가중 접촉점 합 (나누기 전) */
  pointSum: Vec3;
  wsum: number;
  /** 이 상대와의 최대 관통 깊이 (m, 양수) */
  penetration: number;
  /** 상대(프롭)의 직전 스텝 속력 (m/s, 몸 쪽으로 다가오는 성분이 minApproach 이상인 접촉만, 아니면 0) — 날아온 물체인지 가르는 데 쓴다. 캐릭터는 0 */
  speed: number;
}

/** 감지된 접촉 hit (감지 창 끝) */
export interface SensedHit {
  source: string;
  kind: 'character' | 'prop';
  body: BodyName;
  point: Vec3;
  /** 단위 방향 (ΣJ) */
  direction: Vec3;
  /** 전신 COM Δv (m/s) = |ΣJ| / 총질량 */
  dv: number;
  /** 감지 창 시작 시각 (첫 접촉) */
  t0: number;
  /** 이 접촉(첫 창부터)의 상대 최대 속력 (m/s, 프롭) */
  speed: number;
}

interface Episode {
  kind: 'character' | 'prop';
  t0: number;
  /** 창 시작 */
  tw: number;
  last: number;
  J: Vec3;
  byBody: Map<BodyName, number>;
  pointSum: Vec3;
  wsum: number;
  speed: number;
}

/**
 * 캐릭터 하나의 접촉 감지기: 상대별로 감지 창(window초) 동안 충격량을 모아 창 끝에 Δv를 낸다.
 * 접촉이 gap초 넘게 끊기면 그 상대의 접촉은 끝(남은 창도 그때 평가).
 */
export class ContactSensor {
  private eps = new Map<string, Episode>();
  /** 마지막 스텝 접촉 (로그) */
  last: StepContact[] = [];

  constructor(readonly totalMass: number, readonly cfg: InteractionConfig = INTERACTION) {}

  /** 스텝 하나의 접촉을 넣고, 창이 끝난 감지 hit을 돌려준다 (상대 이름 순 — 결정론) */
  update(t: number, contacts: StepContact[]): SensedHit[] {
    this.last = contacts;
    const out: SensedHit[] = [];
    const sc = this.cfg.sensing;
    for (const c of contacts) {
      if (length(c.J) <= 0 && c.wsum <= 0) continue;
      let e = this.eps.get(c.source);
      if (!e) { e = { kind: c.kind, t0: t, tw: t, last: t, J: [0, 0, 0], byBody: new Map(), pointSum: [0, 0, 0], wsum: 0, speed: 0 }; this.eps.set(c.source, e); }
      e.last = t;
      e.speed = Math.max(e.speed, c.speed);
      e.J = add(e.J, c.J);
      for (const [b, w] of c.byBody) e.byBody.set(b, (e.byBody.get(b) ?? 0) + w);
      e.pointSum = add(e.pointSum, c.pointSum);
      e.wsum += c.wsum;
    }
    for (const src of [...this.eps.keys()].sort()) {
      const e = this.eps.get(src)!;
      const ended = t - e.last > sc.gap;
      if (t - e.tw >= sc.window - 1e-9 || ended) {
        const h = this.evaluate(src, e);
        if (h) out.push(h);
        if (ended) this.eps.delete(src);
        else { e.tw = t; e.J = [0, 0, 0]; e.byBody = new Map(); e.pointSum = [0, 0, 0]; e.wsum = 0; }
      }
    }
    return out;
  }

  private evaluate(source: string, e: Episode): SensedHit | null {
    const jm = length(e.J);
    const dv = jm / this.totalMass;
    const min = e.kind === 'character' ? this.cfg.character.minDv : this.cfg.prop.minDv;
    if (dv < min || e.wsum <= 0) return null;
    let body: BodyName | null = null, best = -1;
    for (const [b, w] of [...e.byBody.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1))) if (w > best) { best = w; body = b; }
    return { source, kind: e.kind, body: body!, point: scale(e.pointSum, 1 / e.wsum), direction: scale(e.J, 1 / jm), dv, t0: e.t0, speed: e.speed };
  }
}
