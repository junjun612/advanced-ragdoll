// HitReaction (SPEC v0.5a 행동 목록): 맞은 바디·인접 관절 힘 빠짐 → 회복, 맞은 쪽으로 움찔(몸통 굽힘·비틀기·머리), 무릎이 꺾이며 살짝 주저앉음.
// 힘 빠짐은 수동 반응이라 피격 직후(weakOnset), 움찔은 의도 반응이라 감지 지연(startT) 뒤에 시작한다.
import type { BodyName } from '../characterDef';
import type { JointName } from '../pose';
import { type Vec3, cross, dot, sub } from '../../math/vec3';
import { rotate } from '../../math/quat';
import { Behavior, envelope, type BehaviorContext, type BehaviorOutput, type JointOut } from './types';
import { bodyPose, degQ } from './kinematics';

export interface HitReactionParams {
  weakScale: number; neighborScale: number;
  /** (결정 leg-5) 다리를 맞았을 때 맞은 관절·이웃 관절 힘 빠짐 (없으면 weakScale·neighborScale) — 디딘 다리 무릎이 0.3까지 빠지면 꺾인 뒤 다시 펴지 못하고 주저앉았다 */
  legWeakScale?: number; legNeighborScale?: number;
  weakOnset: number; weakHold: number; recoverTime: [number, number];
  legScale: number; legDip: number; flinchDeg: number; headFlinchDeg: number; twistDeg: number;
  flinchRise: number; flinchHold: number; flinchFall: number;
  comDrop: number; comDropRise: number; comDropHold: number; comDropFall: number; duration: number; tiltAllowDeg?: number; trunkBrace?: number;
  /** 피격 정보 (hitModel이 넣는다) */
  body: BodyName; intensity: number; dir: Vec3; point: Vec3 | null;
}

const LEG_JOINTS: JointName[] = ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'];

export class HitReaction extends Behavior {
  readonly name = 'HitReaction';
  private readonly p: HitReactionParams;
  private weak: { joint: JointName; scale: number }[] = [];
  /** 움찔 방향 (관절 좌표계 도): 몸통 굽힘·옆·비틀기, 정한 시점에 한 번 계산 */
  private flinch: { flex: number; side: number; twist: number } | null = null;
  constructor(params: Record<string, unknown>, t0: number, hitT: number) {
    super(params, t0, hitT);
    this.p = params as unknown as HitReactionParams;
  }
  override get immediate(): boolean { return true; }

  private setup(ctx: BehaviorContext): void {
    const def = ctx.def;
    const b = this.p.body;
    const jointOf = (n: BodyName): JointName | null => (n === 'Hips' ? null : (n as JointName));
    const self = jointOf(b);
    const parent = def.bodies.find((x) => x.name === b)?.parent ?? null;
    // 인접 관절: 부모 쪽 관절 + 자식 관절. 몸통이 맞으면 팔다리(다른 사지)는 빼고 몸통·목만 (가슴을 맞아도 팔 힘은 그대로 — 그 팔로 상처를 쥔다)
    const limb = (n: string) => /Arm|Hand|Leg|Foot/.test(n);
    const neighbors = [parent ? jointOf(parent) : null, ...def.bodies.filter((x) => x.parent === b).map((x) => x.name as JointName)]
      .filter((x): x is JointName => !!x && (limb(b) || !limb(x)));
    const legHit = /Leg|Foot/.test(b);
    const ws = legHit ? this.p.legWeakScale ?? this.p.weakScale : this.p.weakScale;
    const ns = legHit ? this.p.legNeighborScale ?? this.p.neighborScale : this.p.neighborScale;
    if (self) this.weak.push({ joint: self, scale: ws });
    for (const n of neighbors) if (n !== self) this.weak.push({ joint: n, scale: ns });
    // 움찔: 맞은 점이 오목한 쪽이 되게 (충격이 들어온 쪽 = −dir 쪽으로 굽힘). 골반 heading 기준
    const hips = bodyPose(ctx.rd, 'Hips');
    const fwd = rotate(hips.rot, [0, 0, 1]), lat = rotate(hips.rot, [1, 0, 0]);
    const n: Vec3 = [-this.p.dir[0], -this.p.dir[1], -this.p.dir[2]];
    const k = this.p.intensity;
    const nf = dot(n, fwd), nl = dot(n, lat);
    // 비틀기: 충격의 수직축 둘레 토크 방향 (맞은 점이 몸 옆일수록 큼)
    const com = ctx.rd.com().com;
    const r = sub(this.p.point ?? bodyPose(ctx.rd, b).pos, com);
    const ty = cross(r, this.p.dir)[1];
    const lever = Math.min(1, Math.abs(dot(r, lat)) / 0.15);
    this.flinch = { flex: this.p.flinchDeg * k * nf, side: -this.p.flinchDeg * k * nl, twist: Math.sign(ty) * this.p.twistDeg * k * lever };
  }

  /** 시각 t의 힘 빠짐 배율 (1 = 정상) */
  private weakAt(t: number, scale: number): number {
    const p = this.p;
    const tau = t - this.hitT - p.weakOnset;
    if (tau < 0) return 1;
    const rec = p.recoverTime[0] + (p.recoverTime[1] - p.recoverTime[0]) * p.intensity;
    if (tau < p.weakHold) return scale;
    const k = Math.min(1, (tau - p.weakHold) / rec);
    return scale + (1 - scale) * k;
  }

  update(ctx: BehaviorContext): BehaviorOutput {
    if (!this.flinch) this.setup(ctx);
    const p = this.p;
    const t = ctx.t;
    if (t - this.hitT >= p.duration) this.stop(t);
    const joints: Partial<Record<JointName, JointOut>> = {};
    for (const w of this.weak) joints[w.joint] = { weight: 1, strength: this.weakAt(t, w.scale) };
    // 다리: 무릎이 살짝 꺾이도록 잠깐 약하게 (피격 0.05초 뒤부터 legDip초, 그 뒤 회복)
    const lt = t - this.hitT - 0.05;
    if (lt >= 0 && lt < p.legDip * 2) {
      const s = 1 - (1 - p.legScale) * p.intensity * envelope(lt, 0.03, p.legDip * 0.5, p.legDip);
      for (const j of LEG_JOINTS) joints[j] = { ...(joints[j] ?? { weight: 1 }), strength: (joints[j]?.strength ?? 1) * s };
    }
    // 의도 반응 (감지 지연 뒤): 움찔
    const e = envelope(t - this.startT, p.flinchRise, p.flinchHold, p.flinchFall);
    const f = this.flinch!;
    if (e > 0) {
      const sp = (k: number) => degQ(f.flex * k * e, f.twist * k * e, f.side * k * e);
      joints.Spine = { ...(joints.Spine ?? { weight: 1 }), add: sp(0.4) };
      joints.Spine2 = { ...(joints.Spine2 ?? { weight: 1 }), add: sp(0.6) };
      joints.Head = { ...(joints.Head ?? { weight: 1 }), add: degQ(p.headFlinchDeg * p.intensity * e, 0, 0) };
    }
    const tauDrop = t - this.hitT - 0.05;
    const comDrop = p.comDrop * p.intensity * envelope(tauDrop, p.comDropRise, p.comDropHold, p.comDropFall);
    this.phase = t - this.hitT < p.weakOnset + p.weakHold ? '힘 빠짐' : e > 0 ? '움찔' : '회복';
    // 맞은 직후 상체가 젖혀지는 동안 균형을 끄지 않는다 (사람은 크게 젖혀져도 발을 내딛어 버틴다)
    // 움찔하는 동안 몸통을 웅크려 굳힌다(보호 수축): 몸통 과제 이득 × (1 + (trunkBrace − 1)·움찔 정도)
    const brace = 1 + ((p.trunkBrace ?? 1) - 1) * envelope(t - this.hitT, 0.04, p.flinchRise + p.flinchHold, p.flinchFall);
    return { joints, comDrop, tiltAllowDeg: p.tiltAllowDeg ?? 0, trunkGainScale: brace };
  }

  override info(): Record<string, unknown> {
    return { body: this.p.body, intensity: this.p.intensity, flinch: this.flinch };
  }
}
