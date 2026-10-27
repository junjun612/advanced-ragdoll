// Kimodo 출력 스켈레톤 SOMA77 (somaskel77): 응답 타입과 순기구학.
// 규약 (kimodo-server README): 미터, Y 위, 정면 +Z, 캐릭터 왼쪽 +X (우리와 같아서 축 변환 없음).
// 로컬 회전은 표준 T-pose 기준이고, T-pose에서 모든 관절의 월드 회전은 항등이다.
// 그래서 관절의 월드 회전 G는 곧 "rest에서 얼마나 돌았는가"(월드 기준)다.
import { type Vec3, add } from '../../src/sim/math/vec3';
import { type Quat, multiplyQ, normalizeQ, rotate } from '../../src/sim/math/quat';

export interface SomaSkeleton {
  name?: string;
  joint_names: string[];
  parents: number[];
  rest_offsets_m: Vec3[];
  rest_positions_m?: Vec3[];
  model_input_skeleton?: { joint_names: string[] };
}

/** POST /generate 응답에서 쓰는 필드 */
export interface KimodoResponse {
  id?: string;
  model?: string;
  text?: string;
  fps: number;
  num_frames?: number;
  seed?: number;
  bvh_path?: string;
  timing_s?: number;
  warnings?: unknown;
  skeleton: SomaSkeleton;
  root_positions: Vec3[];
  /** [T][77][w,x,y,z] */
  local_rotations_wxyz: [number, number, number, number][][];
  world_joint_positions: Vec3[][];
  /** [T][6] = [L heel, L toe, L toe end, R heel, R toe, R toe end] (kimodo skeleton/definitions.py: 4채널을 6채널로 늘림) */
  foot_contacts?: number[][];
}

/** wxyz → 우리 규약 xyzw */
export const wxyzToXyzw = (q: readonly number[]): Quat => [q[1]!, q[2]!, q[3]!, q[0]!];
/** xyzw → Kimodo 규약 wxyz */
export const xyzwToWxyz = (q: Readonly<Quat>): [number, number, number, number] => [q[3], q[0], q[1], q[2]];

export class Soma {
  readonly names: string[];
  readonly parents: number[];
  readonly offsets: Vec3[];
  readonly index: Map<string, number>;
  /** T-pose 월드 위치 (Hips = 원점) */
  readonly restPos: Vec3[];

  constructor(sk: SomaSkeleton) {
    this.names = sk.joint_names;
    this.parents = sk.parents;
    this.offsets = sk.rest_offsets_m;
    this.index = new Map(this.names.map((n, i) => [n, i]));
    this.restPos = [];
    this.parents.forEach((p, i) => {
      if (p > i) throw new Error('SOMA 관절 순서: 부모가 자식보다 뒤에 있음');
      this.restPos.push(p < 0 ? [0, 0, 0] : add(this.restPos[p]!, this.offsets[i]!));
    });
  }

  idx(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`SOMA 관절 없음: ${name}`);
    return i;
  }

  /** 순기구학: G_j = G_parent · L_j, P_j = P_parent + G_parent · offset_j. local은 xyzw. */
  fk(local: readonly Quat[], rootPos: Readonly<Vec3>): { G: Quat[]; P: Vec3[] } {
    const G: Quat[] = [], P: Vec3[] = [];
    this.parents.forEach((p, i) => {
      if (p < 0) {
        G.push(normalizeQ(local[i]!));
        P.push([rootPos[0], rootPos[1], rootPos[2]]);
      } else {
        G.push(normalizeQ(multiplyQ(G[p]!, local[i]!)));
        P.push(add(P[p]!, rotate(G[p]!, this.offsets[i]!)));
      }
    });
    return { G, P };
  }

  /** 응답 프레임 t의 FK */
  fkFrame(res: KimodoResponse, t: number): { G: Quat[]; P: Vec3[] } {
    return this.fk(res.local_rotations_wxyz[t]!.map(wxyzToXyzw), res.root_positions[t]!);
  }
}
