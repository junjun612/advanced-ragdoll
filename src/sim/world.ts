// Rapier 초기화와 물리 월드 (SPEC 4, 7.1). 고정 타임스텝 + 누적 시간 방식.
// v0.0 결론: timestep 기본값 1/60 → 직접 설정, 솔버 반복 8.
import R from '@dimforge/rapier3d-compat';
import simCfg from '../../config/sim.json';
import type { Vec3 } from './math/vec3';
import { TERRAINS, terrainDef, terrainHeightAt, type TerrainDef, type TerrainName } from './terrain';

export type Rapier = typeof R;
export { R, TERRAINS, type TerrainName };

let ready: Promise<void> | null = null;
/** Rapier wasm 초기화 (한 번만). */
export function initRapier(): Promise<void> {
  ready ??= R.init();
  return ready;
}

export interface PhysicsOpts {
  /** 기본 1/stepHz (config/sim.json) */
  dt?: number;
  /** 기본 config/sim.json gravity. 테스트에서 무중력 확인용으로만 바꾼다 */
  gravity?: Vec3;
  terrain?: TerrainName;
}

const v = (a: Readonly<Vec3>) => ({ x: a[0], y: a[1], z: a[2] });

export class PhysicsWorld {
  readonly world: R.World;
  readonly dt: number;
  readonly terrain: TerrainName;
  /** 지형 정의 (v0.8a): 상자·경사. 해석식 지면 높이(groundHeightAt)와 렌더가 같은 정의를 쓴다 */
  readonly terrainDef: TerrainDef;
  readonly groundColliders: R.Collider[] = [];
  private groundHandles = new Set<number>();
  /** (v0.8b) 지면이 아닌 물체 콜라이더 (난간대·기둥·벽) — 접촉은 per.props로 따로 센다 */
  readonly propColliders: R.Collider[] = [];
  /** (v0.8b) 벽 콜라이더 (벽 탐지 레이캐스트 대상) */
  readonly wallColliders: R.Collider[] = [];
  /**
   * (v0.8c 짚기, README 결정 174) 이 월드의 사람들 (World.addCharacter가 등록). 다른 사람의 몸통은 넘어지는 쪽에 있으면 벽처럼 짚는다(senseWall).
   * 혼자인 월드는 자기 하나뿐이라 아무것도 바뀌지 않는다. 바디 이름 → 콜라이더·강체를 읽기만 한다
   */
  readonly persons: { name: string; bodies: { name: string; rb: R.RigidBody; cols: R.Collider[] }[] }[] = [];
  private propKinds = new Map<number, string>();
  /** (v0.8b) 'grabbable' 태그가 붙은 콜라이더 (난간대, 잡을 모서리가 있는 받침) */
  private grabbableHandles = new Set<number>();
  private acc = 0;
  private stepCount = 0;
  /** (v0.8c) 접촉 쌍 거르기 훅 (여러 캐릭터 월드에서만; 없으면 이전과 같은 step()) */
  hooks: R.PhysicsHooks | null = null;

  /** initRapier()가 끝난 뒤에만 만든다. */
  constructor(opts: PhysicsOpts = {}) {
    this.dt = opts.dt ?? 1 / simCfg.stepHz;
    this.terrain = opts.terrain ?? 'flat';
    this.terrainDef = terrainDef(this.terrain);
    this.world = new R.World(v(opts.gravity ?? (simCfg.gravity as Vec3)));
    this.world.timestep = this.dt;
    this.world.numSolverIterations = simCfg.solverIterations;
    this.buildTerrain();
  }

  private buildTerrain(): void {
    const t = simCfg.terrain;
    const slope = this.terrainDef.slopeDeg;
    // 평지: 윗면이 y = 0. 경사: 같은 판을 X축으로 −각 돌려 윗면이 원점을 지나고 +Z 쪽으로 올라간다 (법선 (0, cos, −sin)).
    // 마찰 결합 규칙 Min → 바디 마찰(SPEC 6.2)이 그대로 유효 마찰이 된다.
    const a = (slope * Math.PI) / 180;
    const h = t.flatThickness / 2;
    const desc = R.ColliderDesc.cuboid(t.flatHalfExtent, h, t.flatHalfExtent)
      .setTranslation(0, -h * Math.cos(a), h * Math.sin(a))
      .setRotation({ x: Math.sin(-a / 2), y: 0, z: 0, w: Math.cos(-a / 2) })
      .setFriction(t.friction)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0)
      .setRestitutionCombineRule(R.CoefficientCombineRule.Min);
    this.addGround(this.world.createCollider(desc));
    // (v0.8a) 바닥 위 상자: 계단 단·모서리 받침·장애물. 모두 지면(접촉·레이캐스트 대상)이고 마찰·반발은 바닥과 같다
    for (const b of this.terrainDef.boxes) {
      // 모서리는 반지름 edgeRadius로 둥글게 (실제 계단 코처럼; 날카로운 상자 모서리에 손·발이 걸리면 가벼운 손이 한 스텝에 50 rad/s 넘게 튀었다).
      // roundCuboid의 반 크기는 둥근 테두리 안쪽이라 그만큼 줄여 바깥 크기는 그대로
      const r = Math.min(t.edgeRadius ?? 0, ...b.half.map((x) => x * 0.5));
      const d = (r > 0 ? R.ColliderDesc.roundCuboid(b.half[0] - r, b.half[1] - r, b.half[2] - r, r) : R.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2]))
        .setTranslation(b.center[0], b.center[1], b.center[2])
        .setFriction(t.friction)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0)
        .setRestitutionCombineRule(R.CoefficientCombineRule.Min);
      const c = this.world.createCollider(d);
      this.addGround(c);
      // (v0.8b) 잡을 모서리가 있는 받침은 grabbable
      if (b.kind === 'platform' && this.terrainDef.grabs.some((g) => g.kind === 'edge')) this.grabbableHandles.add(c.handle);
    }
    // (v0.8b) 지면이 아닌 물체: 난간대·기둥(캡슐), 벽(상자). 마찰·반발은 바닥과 같다
    for (const p of this.terrainDef.props) {
      let d: R.ColliderDesc;
      if (p.kind === 'wall') d = R.ColliderDesc.cuboid(p.half[0], p.half[1], p.half[2]).setTranslation(p.center[0], p.center[1], p.center[2]);
      else {
        const ax: Vec3 = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]];
        const L = Math.hypot(ax[0], ax[1], ax[2]);
        // 캡슐은 로컬 Y축: Y → 막대 방향으로 돌린다 (q = 반각 공식, Y와 반대 방향이면 X축 180°)
        const u: Vec3 = [ax[0] / L, ax[1] / L, ax[2] / L];
        const c: Vec3 = [u[2], 0, -u[0]], w = 1 + u[1];
        const n = Math.hypot(c[0], c[1], c[2], w);
        const q = n < 1e-9 ? { x: 1, y: 0, z: 0, w: 0 } : { x: c[0] / n, y: c[1] / n, z: c[2] / n, w: w / n };
        d = R.ColliderDesc.capsule(L / 2, p.radius).setTranslation((p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2).setRotation(q);
      }
      d.setFriction(t.friction).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min);
      const c = this.world.createCollider(d);
      this.propColliders.push(c);
      this.propKinds.set(c.handle, p.kind);
      if (p.kind === 'wall') this.wallColliders.push(c);
      if (p.grabbable) this.grabbableHandles.add(c.handle);
    }
  }

  /** (v0.8b) 지형 물체 종류 (난간대 'rail'·기둥 'post'·벽 'wall'), 지형 물체가 아니면 null */
  propKind(c: R.Collider): string | null {
    return this.propKinds.get(c.handle) ?? null;
  }

  /** (v0.8b) 'grabbable' 태그 콜라이더인가 */
  isGrabbable(c: R.Collider): boolean {
    return this.grabbableHandles.has(c.handle);
  }

  /** (v0.8a) (x, z) 위 지면 높이 (해석식, 평지는 정확히 0) */
  groundHeightAt(x: number, z: number): number {
    return terrainHeightAt(this.terrainDef, x, z);
  }

  /** (v0.8a) 평지(이전 마일스톤 경로)인가 */
  get flat(): boolean {
    return this.terrainDef.slopeDeg === 0 && this.terrainDef.boxes.length === 0;
  }

  private addGround(c: R.Collider): void {
    this.groundColliders.push(c);
    this.groundHandles.add(c.handle);
  }

  isGround(c: R.Collider): boolean {
    return this.groundHandles.has(c.handle);
  }

  /** 지금까지 진행한 시뮬레이션 시간 (스텝 수 × dt, 누적 오차 없음) */
  get time(): number {
    return this.stepCount * this.dt;
  }
  get steps(): number {
    return this.stepCount;
  }

  /** Rapier 한 스텝 (7.1의 8단계). */
  stepPhysics(): void {
    if (this.hooks) this.world.step(undefined, this.hooks);
    else this.world.step();
    this.stepCount++;
  }

  /**
   * 접촉 갱신만 한다: 한 스텝 돌려 narrow phase를 채운 뒤 모든 바디의 위치·회전을 되돌리고 속도를 0으로 둔다
   * (스폰 직후 t=0 상태가 접촉을 반영하게). 시뮬레이션 시간·스텝 수는 늘리지 않는다. 스폰 시점 속도는 0이라 되돌려도 손실이 없다.
   * (극소 타임스텝으로 돌리면 관절 솔버가 폭발해서 이 방식을 쓴다.)
   */
  refreshContacts(): void {
    const saved: { rb: R.RigidBody; t: R.Vector; r: R.Rotation }[] = [];
    this.world.bodies.forEach((rb) => {
      if (rb.isDynamic()) saved.push({ rb, t: rb.translation(), r: rb.rotation() });
    });
    if (this.hooks) this.world.step(undefined, this.hooks);
    else this.world.step();
    const zero = { x: 0, y: 0, z: 0 };
    for (const s of saved) {
      s.rb.setTranslation(s.t, false);
      s.rb.setRotation(s.r, false);
      s.rb.setLinvel(zero, false);
      s.rb.setAngvel(zero, false);
    }
  }

  /** 렌더 프레임 시간을 누적해서 고정 스텝을 필요한 만큼 돈다. 돌린 스텝 수를 돌려준다. */
  advance(realDt: number, stepFn: () => void): number {
    this.acc += realDt;
    let n = 0;
    while (this.acc >= this.dt - 1e-12) {
      stepFn();
      this.acc -= this.dt;
      n++;
    }
    return n;
  }

  free(): void {
    this.world.free();
  }
}
