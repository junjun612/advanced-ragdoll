// 전신 강체 동역학 모델 (v0.3, README 결정 49). 부유 기저(Hips 6) + 관절(구형 3, 경첩 1) 트리 = 43 자유도.
// 표현: 월드 좌표 원점 기준 공간 벡터(Featherstone 6D, 운동 (ω, v_O), 힘 (n_O, f)). 관절 속도는 준속도:
//   - 기저: Hips 공간 속도 (ω, v_O) 6
//   - 구형: 상대 각속도 ω_c − ω_p (월드) 3, S = [e_k; p × e_k], Ṡq̇ = [0; ṗ × ω_rel] (ṗ = 관절점 p의 부모 쪽 속도)
//   - 경첩: 축 a(부모에 고정) 둘레 각속도 1, S = [a; p × a], Ṡq̇ = v_p ×ₘ (S q̇)
// 질량·관성은 Rapier 바디 값(질량 중심, 주관성 × 주축 회전)을 그대로 쓴다 → 물리와 같은 모델.
// 제공: 질량 행렬 M, 원점 운동량 행렬 A_O(= M의 기저 6행), 바이어스, 바디 자코비안(발·Spine2), 역동역학(RNEA).
import type { Ragdoll } from '../character/ragdoll';
import { type Vec3, add, cross, dot, scale, sub } from '../math/vec3';
import { type Quat, rotate, multiplyQ } from '../math/quat';

/** 공간 벡터 6 = [각, 선] */
export type V6 = [number, number, number, number, number, number];
const v6 = (a: Readonly<Vec3>, b: Readonly<Vec3>): V6 => [a[0], a[1], a[2], b[0], b[1], b[2]];
const ang = (m: Readonly<V6>): Vec3 => [m[0], m[1], m[2]];
const lin = (m: Readonly<V6>): Vec3 => [m[3], m[4], m[5]];
const add6 = (a: Readonly<V6>, b: Readonly<V6>): V6 => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5]];
const scale6 = (a: Readonly<V6>, s: number): V6 => [a[0] * s, a[1] * s, a[2] * s, a[3] * s, a[4] * s, a[5] * s];
const dot6 = (a: Readonly<V6>, b: Readonly<V6>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] + a[5] * b[5];
/** 운동 외적 v ×ₘ m */
const crossM = (v: Readonly<V6>, m: Readonly<V6>): V6 => v6(cross(ang(v), ang(m)), add(cross(ang(v), lin(m)), cross(lin(v), ang(m))));
/** 힘 외적 v ×* f */
const crossF = (v: Readonly<V6>, f: Readonly<V6>): V6 => v6(add(cross(ang(v), ang(f)), cross(lin(v), lin(f))), cross(ang(v), lin(f)));

interface Body {
  idx: number;
  parent: number;
  type: 'free' | 'sph' | 'hinge';
  dof0: number;
  ndof: number;
  /** 자식 바디 로컬 관절점 */
  anchorInChild: Vec3;
  /** 경첩 축 (부모 바디 로컬) */
  axisParent: Vec3;
  /** 이 바디 속도에 기여하는 자유도 (조상 + 자기, 오름차순) */
  dofs: number[];
}

interface BodyState {
  m: number;
  c: Vec3;
  /** 질량 중심 회전 관성 (월드 3×3, 행 우선) */
  Ic: number[];
  /** 공간 속도 (원점) */
  v: V6;
  /** q̈ = 0일 때의 공간 가속도 (바이어스) */
  a0: V6;
  /** 이 바디 관절의 S 열들 */
  S: V6[];
}

export interface WBState {
  /** 자유도별 S 열 (월드), 바이어스 */
  S: V6[];
  qd: number[];
  bodies: BodyState[];
}

const mat3Vec = (A: readonly number[], x: Readonly<Vec3>): Vec3 => [A[0]! * x[0] + A[1]! * x[1] + A[2]! * x[2], A[3]! * x[0] + A[4]! * x[1] + A[5]! * x[2], A[6]! * x[0] + A[7]! * x[1] + A[8]! * x[2]];

export class WholeBody {
  readonly bodies: Body[] = [];
  readonly n: number;
  /** 관절 이름(자식 바디 이름) → 바디 인덱스 */
  readonly byName = new Map<string, number>();

  constructor(readonly rd: Ragdoll) {
    let dof = 0;
    for (const b of rd.bodies) {
      const jd = b.def.joint;
      const type: Body['type'] = b.parentIdx < 0 ? 'free' : jd?.type === 'hinge' ? 'hinge' : 'sph';
      const ndof = type === 'free' ? 6 : type === 'hinge' ? 1 : 3;
      const parentDofs = b.parentIdx < 0 ? [] : this.bodies[b.parentIdx]!.dofs;
      const dofs = [...parentDofs];
      for (let k = 0; k < ndof; k++) dofs.push(dof + k);
      this.bodies.push({
        idx: b.idx,
        parent: b.parentIdx,
        type,
        dof0: dof,
        ndof,
        anchorInChild: jd ? [...jd.anchorInChild] as Vec3 : [0, 0, 0],
        axisParent: jd ? [...jd.axis] as Vec3 : [1, 0, 0],
        dofs,
      });
      this.byName.set(b.name, b.idx);
      dof += ndof;
    }
    this.n = dof;
  }

  /** 관절점 월드 위치 */
  jointPoint(i: number): Vec3 {
    const rb = this.rd.bodies[i]!.rb;
    const t = rb.translation(), q = rb.rotation();
    return add([t.x, t.y, t.z], rotate([q.x, q.y, q.z, q.w], this.bodies[i]!.anchorInChild));
  }

  /** Rapier 바디 상태에서 q̇, 공간 속도, 바이어스 가속도, 관성을 만든다 */
  state(): WBState {
    const S: V6[] = new Array(this.n);
    const qd: number[] = new Array(this.n).fill(0);
    const out: BodyState[] = [];
    for (const b of this.bodies) {
      const rb = this.rd.bodies[b.idx]!.rb;
      const m = rb.mass();
      const wc = rb.worldCom(), q = rb.rotation(), pf = rb.principalInertiaLocalFrame(), pi = rb.principalInertia();
      const fr: Quat = multiplyQ([q.x, q.y, q.z, q.w], [pf.x, pf.y, pf.z, pf.w]);
      const ex = rotate(fr, [1, 0, 0]), ey = rotate(fr, [0, 1, 0]), ez = rotate(fr, [0, 0, 1]);
      const Ic = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (const [e, I] of [[ex, pi.x], [ey, pi.y], [ez, pi.z]] as const)
        for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) Ic[r * 3 + k]! += I * e[r]! * e[k]!;
      const c: Vec3 = [wc.x, wc.y, wc.z];
      const w = rb.angvel(), lv = rb.linvel();
      const om: Vec3 = [w.x, w.y, w.z];
      const bs: BodyState = { m, c, Ic, v: [0, 0, 0, 0, 0, 0], a0: [0, 0, 0, 0, 0, 0], S: [] };
      if (b.type === 'free') {
        const vO = sub([lv.x, lv.y, lv.z], cross(om, c));
        for (let k = 0; k < 6; k++) { const col: V6 = [0, 0, 0, 0, 0, 0]; col[k] = 1; S[b.dof0 + k] = col; bs.S.push(col); }
        const vv = v6(om, vO);
        for (let k = 0; k < 6; k++) qd[b.dof0 + k] = vv[k]!;
        bs.v = vv;
      } else {
        const P = out[b.parent]!;
        const p = this.jointPoint(b.idx);
        const prb = this.rd.bodies[b.parent]!.rb;
        const pw = prb.angvel();
        const wRel = sub(om, [pw.x, pw.y, pw.z]);
        let sq: V6;
        if (b.type === 'sph') {
          for (let k = 0; k < 3; k++) {
            const e: Vec3 = [0, 0, 0];
            e[k] = 1;
            const col = v6(e, cross(p, e));
            S[b.dof0 + k] = col;
            bs.S.push(col);
            qd[b.dof0 + k] = wRel[k]!;
          }
          sq = v6(wRel, cross(p, wRel));
          const pdot = add(lin(P.v), cross(ang(P.v), p));
          bs.a0 = add6(P.a0, v6([0, 0, 0], cross(pdot, wRel)));
        } else {
          const pq = prb.rotation();
          const a = rotate([pq.x, pq.y, pq.z, pq.w], b.axisParent);
          const col = v6(a, cross(p, a));
          S[b.dof0] = col;
          bs.S.push(col);
          const r = dot(wRel, a);
          qd[b.dof0] = r;
          sq = scale6(col, r);
          bs.a0 = add6(P.a0, crossM(P.v, sq));
        }
        bs.v = add6(P.v, sq);
      }
      out.push(bs);
    }
    return { S, qd, bodies: out };
  }

  /** 공간 관성 × 운동 벡터: (Ic ω + c × l, l), l = m(v_O + ω × c) */
  static inertiaMul(b: BodyState, x: Readonly<V6>): V6 {
    const om = ang(x);
    const l = scale(add(lin(x), cross(om, b.c)), b.m);
    return v6(add(mat3Vec(b.Ic, om), cross(b.c, l)), l);
  }

  /**
   * 질량 행렬 M (n×n, 행 우선), 원점 운동량 행렬 A_O (6×n), 원점 운동량 변화 바이어스 Σ(I a0 + v ×* I v).
   */
  massAndMomentum(st: WBState): { M: Float64Array; A: Float64Array; hBias: V6; momentum: V6 } {
    const n = this.n;
    const M = new Float64Array(n * n), A = new Float64Array(6 * n);
    let hBias: V6 = [0, 0, 0, 0, 0, 0], mom: V6 = [0, 0, 0, 0, 0, 0];
    for (const b of this.bodies) {
      const bs = st.bodies[b.idx]!;
      const F = b.dofs.map((j) => WholeBody.inertiaMul(bs, st.S[j]!));
      for (let x = 0; x < b.dofs.length; x++) {
        const i = b.dofs[x]!;
        for (let r = 0; r < 6; r++) A[r * n + i]! += F[x]![r]!;
        for (let y = 0; y <= x; y++) {
          const j = b.dofs[y]!;
          const val = dot6(st.S[j]!, F[x]!);
          M[i * n + j]! += val;
          if (i !== j) M[j * n + i]! += val;
        }
      }
      const Iv = WholeBody.inertiaMul(bs, bs.v);
      mom = add6(mom, Iv);
      hBias = add6(hBias, add6(WholeBody.inertiaMul(bs, bs.a0), crossF(bs.v, Iv)));
    }
    return { M, A, hBias, momentum: mom };
  }

  /** 바디 i의 공간 자코비안 열 (자유도, 6벡터)과 바이어스 가속도 a0 */
  jacobian(st: WBState, i: number): { dofs: number[]; cols: V6[]; a0: V6; v: V6 } {
    const b = this.bodies[i]!;
    return { dofs: b.dofs, cols: b.dofs.map((j) => st.S[j]!), a0: st.bodies[i]!.a0, v: st.bodies[i]!.v };
  }

  /**
   * 역동역학 (RNEA, 원점 공간 벡터). q̈와 외력(바디별 원점 렌치: 중력·접촉)으로 관절 토크를 낸다.
   * 반환: 관절별 월드 토크 벡터(관절점 둘레, 구형 3 / 경첩은 축 방향), 기저 잔차(0이어야 함).
   */
  inverseDynamics(st: WBState, qdd: readonly number[], fext: readonly V6[]): { torque: Vec3[]; baseResidual: V6 } {
    const nb = this.bodies.length;
    const a: V6[] = new Array(nb);
    const f: V6[] = new Array(nb);
    for (const b of this.bodies) {
      const bs = st.bodies[b.idx]!;
      let acc = bs.a0;
      const own = b.type === 'free' ? b.dofs : b.dofs.slice(b.dofs.length - b.ndof);
      // a0는 조상까지 바이어스를 누적했으므로 q̈ 기여는 조상 가속도 + 자기 S q̈
      acc = b.parent >= 0 ? add6(acc, sub6(a[b.parent]!, st.bodies[b.parent]!.a0)) : acc;
      for (const j of own) acc = add6(acc, scale6(st.S[j]!, qdd[j]!));
      a[b.idx] = acc;
      const Iv = WholeBody.inertiaMul(bs, bs.v);
      f[b.idx] = sub6(add6(WholeBody.inertiaMul(bs, acc), crossF(bs.v, Iv)), fext[b.idx]!);
    }
    for (let i = nb - 1; i > 0; i--) {
      const p = this.bodies[i]!.parent;
      f[p] = add6(f[p]!, f[i]!);
    }
    const torque: Vec3[] = [];
    for (const b of this.bodies) {
      if (b.type === 'free') { torque.push([0, 0, 0]); continue; }
      const p = this.jointPoint(b.idx);
      const fi = f[b.idx]!;
      // 관절점 둘레 모멘트 = n_O − p × f
      let t = sub(ang(fi), cross(p, lin(fi)));
      if (b.type === 'hinge') {
        const ax = ang(st.S[b.dof0]!);
        t = scale(ax, dot(t, ax));
      }
      torque.push(t);
    }
    return { torque, baseResidual: f[0]! };
  }
}

const sub6 = (a: Readonly<V6>, b: Readonly<V6>): V6 => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5]];

/** 점 p에 작용하는 힘 f의 원점 렌치 */
export const wrenchAt = (p: Readonly<Vec3>, f: Readonly<Vec3>): V6 => v6(cross(p, f), f);
export { v6, ang, lin, add6, scale6, dot6, sub6 };

/** 일반화 힘 (자유도별 S_jᵀ f_subtree): RNEA를 그대로 쓰되 기저 포함 모든 자유도에 투영 (테스트·검증용) */
export function generalizedForces(wb: WholeBody, st: WBState, qdd: readonly number[], fext: readonly V6[]): number[] {
  const nb = wb.bodies.length;
  const a: V6[] = new Array(nb), f: V6[] = new Array(nb);
  for (const b of wb.bodies) {
    const bs = st.bodies[b.idx]!;
    const own = b.type === 'free' ? b.dofs : b.dofs.slice(b.dofs.length - b.ndof);
    let acc = b.parent >= 0 ? add6(bs.a0, sub6(a[b.parent]!, st.bodies[b.parent]!.a0)) : bs.a0;
    for (const j of own) acc = add6(acc, scale6(st.S[j]!, qdd[j]!));
    a[b.idx] = acc;
    const Iv = WholeBody.inertiaMul(bs, bs.v);
    f[b.idx] = sub6(add6(WholeBody.inertiaMul(bs, acc), crossF(bs.v, Iv)), fext[b.idx]!);
  }
  for (let i = nb - 1; i > 0; i--) f[wb.bodies[i]!.parent] = add6(f[wb.bodies[i]!.parent]!, f[i]!);
  const out = new Array<number>(wb.n).fill(0);
  for (const b of wb.bodies) {
    const own = b.type === 'free' ? b.dofs : b.dofs.slice(b.dofs.length - b.ndof);
    for (const j of own) out[j] = dot6(st.S[j]!, f[b.idx]!);
  }
  return out;
}
