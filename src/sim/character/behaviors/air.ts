// 공중 (SPEC v0.5c 행동 목록): 공중 감지·착지 예측(AirMonitor) → Flail(공중 허우적), PrepareLanding(착지 준비·흡수), Roll(구르기).
// 정의: docs/ALGORITHMS.md v0.5c. 값: config/behaviors.json air·Flail·PrepareLanding·Roll.
import type { JointName } from '../pose';
import type { Ragdoll } from '../ragdoll';
import type { Perception } from '../perception';
import { castGround, isFootBody } from '../perception';
import type { BodyName } from '../characterDef';
import { type Vec3, add, sub, scale, normalize, cross } from '../../math/vec3';
import { inverse3, mulVec3 } from '../../math/mat3';
import { type Quat, rotate, fromRotationVector, slerp } from '../../math/quat';
import { Behavior, smoothstep, type BehaviorContext, type BehaviorOutput, type JointOut, type HandName, HANDS } from './types';
import { armChain, bodyPose, degQ, handRotation, solveArm } from './kinematics';
import { clampTarget, rateLimited } from './fall';
import { SmoothNoise } from './noise';
import type { CharacterDef } from '../characterDef';

export interface AirConfig {
  /** 접촉이 없어진 뒤 이 시간(초)이 지나야 공중으로 본다 (발이 잠깐 뜨는 것 제외) */
  minAirTime: number;
  /** 자유 낙하 판정: COM 수직 가속도(저역 통과 accTau초)가 −freeFallAccel m/s² 아래 (전정기관의 '무중력' 감각; 고정 시험 장치에 매달린 몸은 0) */
  freeFallAccel: number; accTau: number;
  /** 착지 예측: predictStep초 간격으로 maxPredict초까지 탄도 궤적을 따라가며 지면 레이캐스트 */
  predictStep: number; maxPredict: number;
  /** 골반 위 방향이 월드 위와 이 각(도) 안이면 '서 있는 자세로 착지'(발로 착지 준비) */
  uprightDeg: number;
  /** 착지까지 예측 시간이 이 값(초) 이상이면 Flail (짧게 떨어지는 것은 허우적대지 않고 착지 준비만) */
  flailMinTime: number;
  /** 착지까지 예측 시간이 이 값(초) 이하면 PrepareLanding (감지 지연·전환을 빼고 착지 0.3초 전에 활성) */
  prepareLead: number;
  /** 착지까지 rollLead초 안이고 예측 착지 수평 속도 ≥ rollSpeed(m/s)면(또는 경사 rollSlopeDeg° 이상에서 rollSlopeSpeed) Roll */
  rollLead: number; rollSpeed: number; rollSlopeDeg: number; rollSlopeSpeed: number;
  /** 착지 기록: 이 시간(초) 이상 공중이었다가 닿은 것만 */
  minFlight: number;
  /** 공중 행동(Flail·PrepareLanding·Roll)은 공중 시간 + 착지 예측이 이 값(초) 이상인 비행에서만 */
  minFlightTotal: number;
}

/** 공중 신호 (로그 behavior.air) */
export interface AirSignal {
  /** 지면에 닿은 바디가 있는가 */
  contact: boolean;
  /** 공중 (접촉 없음 minAirTime 이상 + 자유 낙하) */
  airborne: boolean;
  /** 접촉 없이 지난 시간 (초) */
  airTime: number;
  freeFall: boolean;
  /** COM 수직 가속도 (저역 통과, m/s²) */
  accY: number;
  /** 착지까지 예측 시간 (초, 접촉 중이면 0, 예측 범위 밖이면 null) */
  timeToGround: number | null;
  /** 가장 먼저 닿을 것으로 보는 바디 */
  lowestBody: BodyName | null;
  /** 예측 착지점 (그 바디의 최저점이 닿는 곳), 착지 때 COM 속도 */
  touchdown: Vec3 | null;
  touchdownVel: Vec3 | null;
  /** 예측 착지 수평 속도 (m/s) */
  touchdownSpeedH: number;
  /** 골반이 서 있는 자세에 가까운가 */
  upright: boolean;
  /** 마지막 착지: 시각, 수평·수직 속도, 처음 닿은 바디, 그 전 공중 시간, 지면 기울기(도) */
  landing: { t: number; speedH: number; vy: number; body: BodyName; flight: number; slopeDeg: number } | null;
}

/**
 * 공중 감지와 착지 예측: 지면 접촉이 없고 COM이 자유 낙하 중이면 공중. 착지 시간은 몸을 자세 고정 강체로 보고(COM 탄도 + 각속도 ω로 회전)
 * 형상 끝점의 최저점이 그 아래 지면(레이캐스트)에 닿는 첫 시각 (predictStep 표본 + 선형 보간).
 */
export class AirMonitor {
  signal: AirSignal;
  private prevVy: number | null = null;
  private accY = 0;
  private airStart: number | null = null;
  private wasAirborne = false;
  private landing: AirSignal['landing'] = null;
  constructor(public cfg: AirConfig, readonly g: number) {
    this.signal = { contact: true, airborne: false, airTime: 0, freeFall: false, accY: 0, timeToGround: 0, lowestBody: null, touchdown: null, touchdownVel: null, touchdownSpeedH: 0, upright: true, landing: null };
  }

  update(rd: Ragdoll, per: Perception, t: number, dt: number): AirSignal {
    const cfg = this.cfg;
    const { com, vel } = rd.com();
    if (this.prevVy !== null) {
      const a = (vel[1] - this.prevVy) / dt;
      this.accY += (a - this.accY) * (1 - Math.exp(-dt / Math.max(1e-4, cfg.accTau)));
    }
    this.prevVy = vel[1];
    const contact = per.ground.size > 0;
    if (contact) {
      if (this.wasAirborne && this.airStart !== null && t - this.airStart >= cfg.minFlight) {
        const first = per.contacts[0]?.body ?? 'Hips';
        const n = per.contacts[0]?.normal ?? [0, 1, 0];
        this.landing = { t, speedH: Math.hypot(vel[0], vel[2]), vy: vel[1], body: first, flight: t - this.airStart, slopeDeg: (Math.acos(Math.max(-1, Math.min(1, n[1]))) * 180) / Math.PI };
      }
      this.airStart = null;
      this.wasAirborne = false;
    } else this.airStart ??= t;
    const airTime = contact || this.airStart === null ? 0 : t - this.airStart;
    const freeFall = this.accY < -cfg.freeFallAccel;
    const airborne = !contact && airTime >= cfg.minAirTime - 1e-9 && freeFall;
    if (airborne) this.wasAirborne = true;
    const hips = bodyPose(rd, 'Hips');
    const upright = rotate(hips.rot, [0, 1, 0])[1] >= Math.cos((cfg.uprightDeg * Math.PI) / 180);
    let ttg: number | null = contact ? 0 : null;
    let lowestBody: BodyName | null = null;
    let touchdown: Vec3 | null = null, tdVel: Vec3 | null = null;
    if (!contact) {
      // 몸을 '자세 고정 강체'로 보고 COM 탄도 + 고정 자세 각속도 ω(점질량 근사 관성 I⁻¹·각운동량)로 돌린 형상 끝점들의 최저점이
      // 그 아래 지면(레이캐스트)에 닿는 첫 시각. 날아가며 몸이 돌면(발이 들림) 가장 낮은 바디가 바뀌는 것까지 본다
      const pts: { r: Vec3; rad: number; body: BodyName }[] = [];
      let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
      let L: Vec3 = [0, 0, 0];
      for (const b of rd.bodies) {
        const tr = b.rb.translation(), q = b.rb.rotation(), lv = b.rb.linvel();
        const p: Vec3 = [tr.x, tr.y, tr.z];
        const rq: Quat = [q.x, q.y, q.z, q.w];
        const m = rd.massOf(b.idx);
        const r = sub(p, com);
        Ixx += m * (r[1] * r[1] + r[2] * r[2]); Iyy += m * (r[0] * r[0] + r[2] * r[2]); Izz += m * (r[0] * r[0] + r[1] * r[1]);
        Ixy -= m * r[0] * r[1]; Ixz -= m * r[0] * r[2]; Iyz -= m * r[1] * r[2];
        L = add(L, scale(cross(r, sub([lv.x, lv.y, lv.z], vel)), m));
        const sh = b.def.shape;
        if (sh.type === 'sphere') pts.push({ r, rad: sh.radius, body: b.name });
        else if (sh.type === 'capsule') {
          const a = rotate(rq, rotate(sh.rotation, [0, sh.halfHeight, 0]));
          pts.push({ r: add(r, a), rad: sh.radius, body: b.name }, { r: sub(r, a), rad: sh.radius, body: b.name });
        } else {
          const h = sh.halfExtents;
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push({ r: add(r, rotate(rq, [sx * h[0], sy * h[1], sz * h[2]])), rad: 0, body: b.name });
        }
      }
      const Ii = inverse3([Ixx, Ixy, Ixz, Ixy, Iyy, Iyz, Ixz, Iyz, Izz]);
      const om: Vec3 = Ii ? mulVec3(Ii, L) : [0, 0, 0];
      const lowestAt = (s: number): { p: Vec3; body: BodyName; c: Vec3 } => {
        const R = fromRotationVector(scale(om, s));
        const c: Vec3 = [com[0] + vel[0] * s, com[1] + vel[1] * s - 0.5 * this.g * s * s, com[2] + vel[2] * s];
        let best = Infinity, bp: Vec3 = c, bb: BodyName = 'Hips';
        for (const q of pts) {
          const w = add(c, rotate(R, q.r));
          const y = w[1] - q.rad;
          if (y < best) { best = y; bp = [w[0], y, w[2]]; bb = q.body; }
        }
        return { p: bp, body: bb, c };
      };
      const at = (s: number): { p: Vec3; gh: number; body: BodyName } => {
        const l = lowestAt(s);
        const gr = castGround(rd.pw, [l.p[0], Math.max(l.p[1], l.c[1]) + 1, l.p[2]], 60);
        return { p: l.p, gh: gr ? gr.point[1] : -Infinity, body: l.body };
      };
      let prev = at(0);
      lowestBody = prev.body;
      const h = cfg.predictStep;
      for (let s = h; s <= cfg.maxPredict + 1e-9; s += h) {
        const cur = at(s);
        const d0 = prev.p[1] - prev.gh, d1 = cur.p[1] - cur.gh;
        if (d1 <= 0) {
          const u = d0 > d1 ? Math.max(0, Math.min(1, d0 / (d0 - d1))) : 1;
          ttg = s - h + u * h;
          touchdown = add(prev.p, scale(sub(cur.p, prev.p), u));
          tdVel = [vel[0], vel[1] - this.g * ttg, vel[2]];
          lowestBody = cur.body;
          break;
        }
        prev = cur;
      }
    }
    this.signal = {
      contact, airborne, airTime, freeFall, accY: this.accY, timeToGround: ttg, lowestBody, touchdown, touchdownVel: tdVel,
      touchdownSpeedH: tdVel ? Math.hypot(tdVel[0], tdVel[2]) : Math.hypot(vel[0], vel[2]), upright, landing: this.landing,
    };
    return this.signal;
  }
}

const SIDES = [['Left', 1], ['Right', -1]] as const;
const j = (s: string, n: string) => `${s}${n}` as JointName;

/** 관절 목표 (도) → 제한 안으로 자른 JointOut */
function jt(def: CharacterDef, jn: JointName, flex: number, twist: number, side: number, weight: number, strength?: number): JointOut {
  return { target: clampTarget(def, jn, degQ(flex, twist, side)), weight, ...(strength !== undefined ? { strength } : {}) };
}

/** 누운 자세 (v0.5c 공통: 착지·구르기 뒤 누움, 몸부림의 출발점): 관절 목표(도)와 강도. 서기 포즈를 약한 힘으로 붙든 채 누우면 엎드린 몸이 다리를 펴며 엉덩이를 들어 올렸고, 팔은 가벼워 허공에 떠 있었다 */
export interface LiePose { hip: number; knee: number; ankle: number; spine: number; head: number; armFlex: number; armSide: number; elbow: number; strength: number; armStrength: number }

/** 누운 자세 관절 출력: 가중치 weight, 강도는 1 → (strength·armStrength)를 k만큼 */
export function lieJoints(def: CharacterDef, lp: LiePose, weight: number, k: number): Partial<Record<JointName, JointOut>> {
  const sb = 1 + (lp.strength - 1) * k, sa = 1 + (lp.armStrength - 1) * k;
  const out: Partial<Record<JointName, JointOut>> = {};
  for (const [s, sg] of SIDES) {
    out[j(s, 'UpLeg')] = jt(def, j(s, 'UpLeg'), lp.hip, 0, sg * 4, weight, sb);
    out[j(s, 'Leg')] = jt(def, j(s, 'Leg'), lp.knee, 0, 0, weight, sb);
    out[j(s, 'Foot')] = jt(def, j(s, 'Foot'), lp.ankle, 0, 0, weight, sb);
    out[j(s, 'Arm')] = jt(def, j(s, 'Arm'), lp.armFlex, 0, sg * lp.armSide, weight, sa);
    out[j(s, 'ForeArm')] = jt(def, j(s, 'ForeArm'), lp.elbow, 0, 0, weight, sa);
    out[j(s, 'Hand')] = jt(def, j(s, 'Hand'), 0, 0, 0, weight, sa);
  }
  out.Spine = jt(def, 'Spine', lp.spine * 0.5, 0, 0, weight, sb);
  out.Spine2 = jt(def, 'Spine2', lp.spine * 0.5, 0, 0, weight, sb);
  out.Head = jt(def, 'Head', lp.head, 0, 0, weight, sb);
  return out;
}

export interface StunParams {
  /** 강도 배율 (전 관절, 즉시), 유지 시간 (초), 회복 시간 (초) */
  scale: number; hold: number; recover: number;
}

/**
 * 폭풍 충격 (BlastStun, v0.5c): 폭발을 맞은 순간 전신 근육이 잠깐 풀린다(수동 반응, 즉시) — 힘이 빠진 몸이 폭풍에 꺾이고
 * 머리·팔이 휘청인다. 강도 배율만 낸다(목표 없음): 위 레이어의 Flail·착지 준비 강도에 곱해진다.
 */
export class BlastStun extends Behavior {
  readonly name = 'BlastStun';
  private readonly p: StunParams;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as StunParams;
  }
  override get immediate(): boolean { return true; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, tau = ctx.t - this.hitT;
    const s = p.scale + (1 - p.scale) * smoothstep((tau - p.hold) / p.recover);
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const b of ctx.def.bodies) if (b.joint) joints[b.name as JointName] = { weight: 1, strength: s };
    if (tau >= p.hold + p.recover && this.stopT === null) this.stop(ctx.t);
    this.phase = s < 0.999 ? '힘 풀림' : '회복';
    return { joints };
  }
}

export interface FlailParams {
  /** 노이즈 주파수 범위 (Hz) — 낮게: 사람이 공중에서 팔다리를 휘젓는 것은 1 Hz 안팎이다 (빠르면 경련, 일정하면 춤) */
  band: [number, number];
  /** 놀람 반사(처음 startleTime초): 팔을 옆·앞으로 크게 벌림 (모로 반사처럼) */
  startleTime: number;
  /** 노이즈가 커지는 시간 (초) */
  noiseRise: number;
  /** 팔: 어깨 앞 올림·벌림(도)과 노이즈 진폭, 비틀기 진폭, 팔꿈치 굽힘·진폭, 손목 진폭 */
  arm: { flex: number; flexAmp: number; abduct: number; abductAmp: number; twistAmp: number; elbow: number; elbowAmp: number; wristAmp: number; strength: number };
  /** 다리: 고관절 굽힘·진폭, 벌림·진폭, 무릎 굽힘·진폭, 발목 */
  leg: { hip: number; hipAmp: number; side: number; sideAmp: number; knee: number; kneeAmp: number; ankle: number; ankleAmp: number; strength: number };
  /** 몸통·머리: 척추 굽힘·진폭, 옆 진폭, 머리 굽힘(턱 당김)·진폭, 비틀기 진폭 */
  trunk: { spine: number; spineAmp: number; sideAmp: number; head: number; headAmp: number; headTwistAmp: number; strength: number };
}

/**
 * 공중 허우적 (Flail): 시드 노이즈 관절 목표로 팔다리를 휘젓는다. 먼저 팔을 옆·앞으로 크게 벌리는 놀람 반사, 그 위에 채널마다
 * 다른 낮은 주파수 노이즈(좌우가 맞지 않아 춤처럼 보이지 않음). 균형·스텝 끔. 지면에 닿으면 끝난다.
 */
export class Flail extends Behavior {
  readonly name = 'Flail';
  private readonly p: FlailParams;
  private noise: SmoothNoise | null = null;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as FlailParams;
  }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t;
    this.noise ??= new SmoothNoise(ctx.rng.fork(`Flail@${this.hitT.toFixed(4)}`), p.band, 2);
    if (ctx.per.ground.size > 0 && this.stopT === null) this.stop(t);
    const tau = Math.max(0, t - this.startT);
    const k = smoothstep(tau / p.startleTime);
    const amp = smoothstep((tau - 0.5 * p.startleTime) / p.noiseRise);
    const n = (c: string) => amp * this.noise!.at(c, tau);
    const joints: Partial<Record<JointName, JointOut>> = {};
    const a = p.arm, l = p.leg, tr = p.trunk;
    for (const [s, sg] of SIDES) {
      joints[j(s, 'Arm')] = jt(ctx.def, j(s, 'Arm'), k * a.flex + a.flexAmp * n(`${s}ArmF`), a.twistAmp * n(`${s}ArmT`), sg * (k * a.abduct + a.abductAmp * n(`${s}ArmS`)), 1, a.strength);
      joints[j(s, 'ForeArm')] = jt(ctx.def, j(s, 'ForeArm'), Math.max(5, a.elbow + a.elbowAmp * n(`${s}Elb`)), 0, 0, 1, a.strength);
      joints[j(s, 'Hand')] = jt(ctx.def, j(s, 'Hand'), a.wristAmp * n(`${s}Wr`), 0, 0, 1, a.strength);
      joints[j(s, 'UpLeg')] = jt(ctx.def, j(s, 'UpLeg'), l.hip + l.hipAmp * n(`${s}HipF`), 0, sg * (l.side + l.sideAmp * n(`${s}HipS`)), 1, l.strength);
      joints[j(s, 'Leg')] = jt(ctx.def, j(s, 'Leg'), Math.max(5, l.knee + l.kneeAmp * n(`${s}Knee`)), 0, 0, 1, l.strength);
      joints[j(s, 'Foot')] = jt(ctx.def, j(s, 'Foot'), l.ankle + l.ankleAmp * n(`${s}Ank`), 0, 0, 1, l.strength);
    }
    for (const sp of ['Spine', 'Spine2'] as JointName[]) joints[sp] = jt(ctx.def, sp, 0.5 * (tr.spine + tr.spineAmp * n(`${sp}F`)), 0, 0.5 * tr.sideAmp * n(`${sp}S`), 1, tr.strength);
    joints.Head = jt(ctx.def, 'Head', tr.head + tr.headAmp * n('HeadF'), tr.headTwistAmp * n('HeadT'), 0, 1, tr.strength);
    this.phase = k < 1 ? '놀람' : '허우적';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
}

export interface PrepareLandingParams {
  /** 발로 착지 준비 (서 있는 자세): 고관절·무릎·발목 (도), 벌림, 나는 방향으로 다리를 내밀기 (도/(m/s), 최대), 다리 강도 */
  legs: { hip: number; knee: number; ankle: number; side: number; velGain: number; velMax: number; strength: number };
  /** 몸으로 착지 준비 (누운·기운 자세): 턱 당김, 척추·고관절·무릎 굽힘 (몸을 둥글게) */
  body: { chin: number; spine: number; hip: number; knee: number };
  /** 팔 벌리기: 어깨 앞 올림·벌림·팔꿈치, 가중치(아래 Flail이 조금 비치게) */
  arms: { flex: number; abduct: number; elbow: number; weight: number; strength: number };
  /** 발 착지 흡수: 닿는 순간 무릎 강도 strength로 떨어졌다가 time초에 회복, 무릎·고관절·발목·척추 목표, 그 뒤 release초에 풀고 균형으로 넘김 */
  absorb: { strength: number; time: number; knee: number; hip: number; ankle: number; spine: number; bendTime: number; release: number };
  /** 몸 착지 뒤: hold초 자세 유지 → restTime초에 restStrength까지 힘을 빼고 누움 */
  land: { hold: number; restTime: number };
  /** 누운 자세 (behaviors.json lie) */
  lie: LiePose;
}

/**
 * 착지 준비: 공중에서 지면이 가까워지면(착지 예측 시간 ≤ prepareLead) 서 있는 자세면 다리를 지면 쪽으로 펴고(나는 방향으로 조금 내밂)
 * 팔을 벌린다. 몸이 기울어 있으면 몸을 둥글게 하고 턱을 당긴다. 발이 닿으면 무릎 강도를 순간적으로 낮추고 무릎·고관절을 굽혀 흡수한 뒤
 * 균형 계층에 넘긴다(균형·스텝 켬). 몸이 먼저 닿으면 잠깐 버틴 뒤 힘을 빼고 눕는다.
 */
export class PrepareLanding extends Behavior {
  readonly name = 'PrepareLanding';
  private readonly p: PrepareLandingParams;
  tdT: number | null = null;
  feet = true;
  private upright = true;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as PrepareLandingParams;
  }
  /** 넘어짐 대비(BraceForFall)를 막는가: 공중·몸 착지·누움 동안 (발 착지 흡수 중에는 넘어지면 대비해야 하므로 막지 않는다) */
  get blocksFall(): boolean { return this.stopT === null && (this.tdT === null || !this.feet); }
  get resting(): boolean { return this.tdT !== null && !this.feet; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    const air = ctx.air;
    if (this.tdT === null && ctx.per.ground.size > 0 && t >= this.startT) {
      this.tdT = t;
      const g = [...ctx.per.ground];
      this.feet = g.every((b) => isFootBody(b) || b === 'LeftLeg' || b === 'RightLeg');
    }
    if (this.tdT === null && air) this.upright = air.upright;
    const joints: Partial<Record<JointName, JointOut>> = {};
    const hips = bodyPose(ctx.rd, 'Hips');
    if (this.tdT === null) {
      if (this.upright) {
        // 나는 방향(골반 기준)으로 다리를 내밀어 착지 때 발이 COM을 받치게
        const v = ctx.rd.com().vel;
        const f = rotate(hips.rot, [0, 0, 1]), lft = rotate(hips.rot, [1, 0, 0]);
        const L = p.legs;
        const clampV = (x: number) => Math.max(-L.velMax, Math.min(L.velMax, x));
        const vf = clampV(L.velGain * (v[0] * f[0] + v[2] * f[2])), vl = clampV(L.velGain * (v[0] * lft[0] + v[2] * lft[2]));
        for (const [s, sg] of SIDES) {
          joints[j(s, 'UpLeg')] = jt(def, j(s, 'UpLeg'), L.hip + vf, 0, sg * L.side + vl, 1, L.strength);
          joints[j(s, 'Leg')] = jt(def, j(s, 'Leg'), L.knee, 0, 0, 1, L.strength);
          joints[j(s, 'Foot')] = jt(def, j(s, 'Foot'), L.ankle, 0, 0, 1, L.strength);
        }
        this.phase = '착지 준비 (발)';
      } else {
        const B = p.body;
        for (const [s, sg] of SIDES) {
          joints[j(s, 'UpLeg')] = jt(def, j(s, 'UpLeg'), B.hip, 0, sg * 6, 1);
          joints[j(s, 'Leg')] = jt(def, j(s, 'Leg'), B.knee, 0, 0, 1);
        }
        joints.Spine = jt(def, 'Spine', B.spine * 0.5, 0, 0, 1);
        joints.Spine2 = jt(def, 'Spine2', B.spine * 0.5, 0, 0, 1);
        joints.Head = jt(def, 'Head', B.chin, 0, 0, 1);
        this.phase = '착지 준비 (몸)';
      }
      const A = p.arms;
      for (const [s, sg] of SIDES) {
        joints[j(s, 'Arm')] = jt(def, j(s, 'Arm'), A.flex, 0, sg * A.abduct, A.weight, A.strength);
        joints[j(s, 'ForeArm')] = jt(def, j(s, 'ForeArm'), A.elbow, 0, 0, A.weight, A.strength);
      }
      return { joints, balanceMode: 'off', stepAllowed: false };
    }
    const tau = t - this.tdT;
    if (this.feet) {
      // 발 착지 흡수: 무릎 강도를 떨어뜨렸다 회복, 무릎·고관절을 굽힌 자세로, 끝나면 균형 계층으로
      const ab = p.absorb;
      const fade = 1 - smoothstep((tau - ab.time) / ab.release);
      const bend = smoothstep(tau / ab.bendTime);
      const ks = ab.strength + (1 - ab.strength) * smoothstep(tau / ab.time);
      const L = p.legs;
      for (const [s, sg] of SIDES) {
        joints[j(s, 'UpLeg')] = jt(def, j(s, 'UpLeg'), L.hip + (ab.hip - L.hip) * bend, 0, sg * L.side, fade);
        joints[j(s, 'Leg')] = jt(def, j(s, 'Leg'), L.knee + (ab.knee - L.knee) * bend, 0, 0, fade, ks);
        joints[j(s, 'Foot')] = jt(def, j(s, 'Foot'), L.ankle + (ab.ankle - L.ankle) * bend, 0, 0, fade);
        joints[j(s, 'Arm')] = jt(def, j(s, 'Arm'), p.arms.flex, 0, sg * p.arms.abduct, fade * p.arms.weight);
      }
      joints.Spine = jt(def, 'Spine', ab.spine * 0.5 * bend, 0, 0, fade);
      joints.Spine2 = jt(def, 'Spine2', ab.spine * 0.5 * bend, 0, 0, fade);
      if (tau >= ab.time + ab.release && this.stopT === null) this.stop(t);
      this.phase = '착지 흡수';
      return { joints, balanceMode: 'on', stepAllowed: true };
    }
    // 몸으로 착지: 잠깐 버틴 뒤 힘을 빼고 눕는다
    const L = p.land;
    const k = smoothstep((tau - L.hold) / L.restTime);
    this.phase = k > 0 ? '누움' : '착지';
    return { joints: lieJoints(def, p.lie, k, k), balanceMode: 'off', stepAllowed: false };
  }
  override info(): Record<string, unknown> { return { tdT: this.tdT, feet: this.feet, upright: this.upright }; }
}

export interface RollParams {
  /** 웅크림 (도): 척추 굽힘(둘에 나눔), 턱 당김, 고관절·무릎 굽힘, 강도 */
  tuck: { spine: number; chin: number; hip: number; knee: number; strength: number; armStrength: number };
  /** 머리 감싸기: 손바닥 점 Head 로컬(x는 그 손 쪽), 팔꿈치 힌트(Spine2 로컬), 목표 변화 최대 (rad/s) */
  guardLocal: Vec3; elbowPole: Vec3; maxTargetRate: number; palmLocal: Vec3;
  /** 구르는 동안: 닿은 뒤 최소 minTime초, COM 수평 속도 < endSpeed이고 골반 각속도 < endAngVel이면 끝(최대 maxTime초) */
  minTime: number; maxTime: number; endSpeed: number; endAngVel: number;
  /** 끝: releaseTime초에 웅크림을 풀고 restStrength까지 힘을 뺀다 → 누움 */
  releaseTime: number;
  lie: LiePose;
}

/**
 * 구르기: 착지 수평 속도가 크면(또는 경사) 몸을 웅크리고(척추·고관절·무릎 굽힘, 턱 당김) 두 손으로 머리를 감싼 채 굴러 운동량을 흘린다.
 * 골반 각속도가 줄고 몸이 느려지면 웅크림을 풀고 눕는다. 균형·스텝 끔.
 */
export class Roll extends Behavior {
  readonly name = 'Roll';
  private readonly p: RollParams;
  contactT: number | null = null;
  endT: number | null = null;
  /** 골반이 굴러간 각 (도, 수평축 각속도 적분) */
  rollDeg = 0;
  private readonly prevT = new Map<JointName, Quat>();
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as RollParams;
  }
  get blocksFall(): boolean { return this.stopT === null; }
  get resting(): boolean { return this.endT !== null; }
  update(ctx: BehaviorContext): BehaviorOutput {
    const p = this.p, t = ctx.t, def = ctx.def;
    if (this.contactT === null && ctx.per.ground.size > 0) this.contactT = t;
    const hips = bodyPose(ctx.rd, 'Hips');
    const { vel } = ctx.rd.com();
    const wH = Math.hypot(hips.angVel[0], hips.angVel[2]);
    if (this.contactT !== null && this.endT === null) {
      this.rollDeg += (wH * ctx.dt * 180) / Math.PI;
      const tc = t - this.contactT;
      const slow = Math.hypot(vel[0], vel[2]) < p.endSpeed && wH < p.endAngVel;
      if ((tc >= p.minTime && slow) || tc >= p.maxTime) this.endT = t;
    }
    const joints: Partial<Record<JointName, JointOut>> = {};
    const rel = this.endT === null ? 0 : smoothstep((t - this.endT) / p.releaseTime);
    const w = 1 - rel;
    const T = p.tuck;
    const sTrunk = T.strength;
    for (const [s, sg] of SIDES) {
      joints[j(s, 'UpLeg')] = jt(def, j(s, 'UpLeg'), T.hip, 0, sg * 6, w, sTrunk);
      joints[j(s, 'Leg')] = jt(def, j(s, 'Leg'), T.knee, 0, 0, w, sTrunk);
      joints[j(s, 'Foot')] = { weight: 1, strength: sTrunk };
    }
    joints.Spine = jt(def, 'Spine', T.spine * 0.5, 0, 0, w, sTrunk);
    joints.Spine2 = jt(def, 'Spine2', T.spine * 0.5, 0, 0, w, sTrunk);
    joints.Head = jt(def, 'Head', T.chin, 0, 0, w, sTrunk);
    // 두 손으로 머리 감싸기 (ProtectHead와 같은 IK)
    const s2 = bodyPose(ctx.rd, 'Spine2'), head = bodyPose(ctx.rd, 'Head');
    const sArm = T.armStrength;
    for (const h of HANDS as readonly HandName[]) {
      const ch = armChain(def, h);
      const palm = add(head.pos, rotate(head.rot, [p.guardLocal[0] * ch.side, p.guardLocal[1], p.guardLocal[2]]));
      const inward = normalize(sub(head.pos, palm));
      const q = handRotation(ch, inward, rotate(head.rot, [0, 1, 0]));
      const pole = rotate(s2.rot, [p.elbowPole[0] * ch.side, p.elbowPole[1], p.elbowPole[2]]);
      const sol = solveArm(def, ch, s2.rot, s2.pos, palm, q, p.palmLocal, pole);
      for (const [jn, tq] of Object.entries(sol.targets)) joints[jn as JointName] = { target: rateLimited(this.prevT, jn as JointName, tq, p.maxTargetRate, ctx.dt, def), weight: w, strength: sArm };
    }
    // 풀기: 웅크림 목표를 누운 자세 쪽으로 rel만큼 (강도도 누운 자세로)
    if (rel > 0) {
      // 힘은 먼저(풀기 앞 1/3) 빼고 자세는 천천히 — 힘이 남은 채 다리를 펴면 무릎·머리를 짚은 몸이 엉덩이를 들어 올렸다
      const lie = lieJoints(def, p.lie, 1, smoothstep(3 * rel));
      for (const [jn, jo] of Object.entries(lie)) {
        const cur = joints[jn as JointName];
        joints[jn as JointName] = cur?.target ? { target: slerp(cur.target, jo!.target!, rel), weight: cur.weight + (1 - cur.weight) * rel, strength: jo!.strength } : { ...jo!, weight: rel };
      }
    }
    this.phase = this.contactT === null ? '웅크림' : this.endT === null ? '구르기' : rel < 1 ? '풀기' : '누움';
    return { joints, balanceMode: 'off', stepAllowed: false };
  }
  override info(): Record<string, unknown> { return { contactT: this.contactT, endT: this.endT, rollDeg: this.rollDeg }; }
}
