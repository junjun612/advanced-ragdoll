// 필름 도구 개발용 가짜 로그. sim 없이 필름스트립을 시험한다 (물리 아님, 키네마틱 연출).
// 사용법: npx tsx tools/film/fakeLog.ts [name=fake_fall]
// xbot.json rest 자세에서 시작해 0.3초에 등(Spine2)을 앞으로 맞고, 발끝을 축으로 앞으로 넘어지며
// 무릎·고관절을 굽힌 채 엎어진다. out/<name>/{log.jsonl, meta.json, summary.json}을 쓴다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Vec3, add, sub, scale, rotate, multiplyQ, inverseQ, fromAxisAngle, normalizeQ, type Quat, convexHull, type Vec2 } from '../../src/sim/math';
import type { BodyDef, CharacterDef } from '../../src/sim/character/characterDef';
import type { CharacterStateLite, FilmMeta, FilmSummary } from '../../src/render/stateTypes';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = process.argv[2] ?? 'fake_fall';
const def = JSON.parse(readFileSync(join(root, 'config', 'characters', 'xbot.json'), 'utf8')) as CharacterDef;
const byName = new Map(def.bodies.map((b) => [b.name, b]));

const DURATION = 3.0, LOG_DT = 1 / 30, HIT_T = 0.3, HIT_DV = 0.8, G = 9.81, L = 1.0, THETA_MAX = 1.53;
const PIVOT: Vec3 = [0, 0, 0.17];

// 관절 굽힘(도) = 넘어짐 진행도 p(0~1)의 함수. +flex는 docs/RAGDOLL_CONFIG.md 3장 규약.
const FLEX_AT_FULL: Record<string, number> = {
  Spine: 5, Spine2: 5, Head: -30,
  LeftUpLeg: 12, RightUpLeg: 20, LeftLeg: 20, RightLeg: 35, LeftFoot: -10, RightFoot: -10,
  LeftArm: 5, RightArm: 12, LeftForeArm: 10, RightForeArm: 20,
};

interface Pose { pos: Map<string, Vec3>; rot: Map<string, Quat> }

function fk(p: number, theta: number): Pose {
  const pos = new Map<string, Vec3>(), rot = new Map<string, Quat>(), delta = new Map<string, Quat>();
  for (const b of def.bodies) {
    if (!b.parent || !b.joint) {
      pos.set(b.name, [...b.restPosition]);
      rot.set(b.name, [...b.restRotation]);
      delta.set(b.name, [0, 0, 0, 1]);
      continue;
    }
    const parent = byName.get(b.parent)!;
    const qj = fromAxisAngle(b.joint.axesWorld.flex, ((FLEX_AT_FULL[b.name] ?? 0) * p * Math.PI) / 180);
    const d = multiplyQ(delta.get(parent.name)!, qj);
    const r = normalizeQ(multiplyQ(d, b.restRotation));
    const anchor = add(pos.get(parent.name)!, rotate(rot.get(parent.name)!, b.joint.anchorInParent));
    delta.set(b.name, d);
    rot.set(b.name, r);
    pos.set(b.name, sub(anchor, rotate(r, b.joint.anchorInChild)));
  }
  // 전신을 발끝 축(+X) 둘레로 theta만큼 앞으로 기울인다
  const R = fromAxisAngle([1, 0, 0], theta);
  for (const b of def.bodies) {
    pos.set(b.name, add(PIVOT, rotate(R, sub(pos.get(b.name)!, PIVOT))));
    rot.set(b.name, normalizeQ(multiplyQ(R, rot.get(b.name)!)));
  }
  // 가장 낮은 점을 지면(y=0)에 맞춘다
  let minY = Infinity;
  for (const b of def.bodies) for (const q of lowPoints(b, pos.get(b.name)!, rot.get(b.name)!)) minY = Math.min(minY, q[1]);
  for (const b of def.bodies) pos.set(b.name, add(pos.get(b.name)!, [0, -minY, 0]));
  return { pos, rot };
}

/** 형상의 아래쪽 후보 점(월드). 캡슐은 양 끝 반구 바닥, 구는 바닥, 박스는 8 꼭짓점. */
function lowPoints(b: BodyDef, p: Vec3, r: Quat): Vec3[] {
  const s = b.shape;
  if (s.type === 'sphere') return [add(p, [0, -s.radius, 0])];
  if (s.type === 'capsule') {
    const axis = rotate(multiplyQ(r, s.rotation), [0, s.halfHeight, 0]);
    return [add(add(p, axis), [0, -s.radius, 0]), add(sub(p, axis), [0, -s.radius, 0])];
  }
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(add(p, rotate(r, [sx * s.halfExtents[0], sy * s.halfExtents[1], sz * s.halfExtents[2]])));
  }
  return out;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r4v = <T extends number[]>(v: T): T => v.map(r4) as T;

// theta 적분: 맞기 전 0, 맞은 뒤 역진자 θ'' = g/L sinθ, 초기 각속도 = Δv/L
const states: CharacterStateLite[] = [];
let theta = 0, omega = 0, t = 0;
const SUB = 20, h = LOG_DT / SUB;
let prev: { pose: Pose; com: Vec3 } | null = null;
let fallTime: number | null = null, firstContact: string | null = null;
const nFrames = Math.round(DURATION / LOG_DT);

for (let f = 0; f <= nFrames; f++) {
  t = f * LOG_DT;
  const p = Math.min(1, theta / THETA_MAX);
  const pose = fk(Math.min(1, p * 1.4), theta);

  let com: Vec3 = [0, 0, 0];
  for (const b of def.bodies) com = add(com, scale(pose.pos.get(b.name)!, b.massRatio));
  const comVel = prev ? scale(sub(com, prev.com), 1 / LOG_DT) : [0, 0, 0] as Vec3;

  const contacts: CharacterStateLite['contacts'] = [];
  for (const b of def.bodies) {
    for (const q of lowPoints(b, pose.pos.get(b.name)!, pose.rot.get(b.name)!)) {
      if (q[1] < 0.004) contacts.push({ body: b.name, point: r4v([q[0], 0, q[2]] as Vec3), normal: [0, 1, 0], impulse: 0 });
    }
  }
  const support = convexHull(contacts.map((c) => [c.point[0], c.point[2]] as Vec2));
  const w0 = Math.sqrt(Math.max(com[1], 0.05) / G);
  const capturePoint: Vec2 = [com[0] + comVel[0] * w0, com[2] + comVel[2] * w0];
  const bad = contacts.find((c) => !/Foot|Hand|Leg$/.test(c.body) || /UpLeg/.test(c.body));
  if (bad && fallTime == null) { fallTime = r4(t); firstContact = bad.body; }

  const hit = t >= HIT_T;
  const k = hit ? Math.min(1, (t - HIT_T) / 0.5) : 0;
  const landed = theta >= THETA_MAX;
  const behaviors = !hit ? [{ name: 'Stand', weight: 1 }]
    : landed ? [{ name: 'Brace', weight: 0.3 }, { name: 'Relax', weight: 0.7 }]
    : [{ name: 'Stand', weight: r4(1 - k) }, { name: 'Brace', weight: r4(k) }];
  const joints: NonNullable<CharacterStateLite['joints']> = {};
  for (const b of def.bodies) {
    if (!b.joint) continue;
    const arm = /Arm|Hand/.test(b.name);
    const strength = landed ? 0.25 : 1 - k * (arm ? 0.2 : 0.7);
    joints[b.name] = { errorDeg: 0, torque: 0, saturated: false, strength: r4(strength) };
  }

  const bodies: CharacterStateLite['bodies'] = {};
  for (const b of def.bodies) {
    const pp = pose.pos.get(b.name)!;
    const lv = prev ? scale(sub(pp, prev.pose.pos.get(b.name)!), 1 / LOG_DT) : [0, 0, 0] as Vec3;
    bodies[b.name] = { pos: r4v(pp), rot: r4v(pose.rot.get(b.name)!), linVel: r4v(lv), angVel: [0, 0, 0] };
  }

  states.push({
    time: r4(t), state: 'Active', bodies, com: r4v(com), comVel: r4v(comVel), contacts,
    supportPolygon: support.map((v) => r4v(v)), capturePoint: r4v(capturePoint),
    stance: 'double', behaviors, joints,
    posture: fallTime != null ? 'down' : 'standing',
    assist: { root: 0, getup: 0, pin: 0 }, debug: {}, grabTarget: null,
  });
  prev = { pose, com };

  for (let s = 0; s < SUB; s++) {
    const tt = t + s * h;
    if (tt < HIT_T) continue;
    if (omega === 0 && theta === 0) omega = HIT_DV / L;
    omega += (G / L) * Math.sin(theta) * h;
    theta = Math.min(THETA_MAX, theta + omega * h);
    if (theta >= THETA_MAX) omega = 0;
  }
}

const sp2 = states.find((s) => s.time >= HIT_T)!.bodies['Spine2']!.pos;
const meta: FilmMeta = {
  scenario: name, milestone: '0.1', characterId: def.id, characterConfig: 'config/characters/xbot.json',
  logDt: r4(LOG_DT), duration: DURATION, cameras: ['side', 'front', 'top', 'follow'],
  events: [{ t: HIT_T, type: 'hit', body: 'Spine2', point: r4v([sp2[0], sp2[1], sp2[2] - 0.1] as Vec3), direction: [0, 0, 1], dv: HIT_DV }],
};
const summary: FilmSummary & Record<string, unknown> = {
  scenario: name, duration: DURATION, exploded: false, fell: fallTime != null, fallTime, kneeled: false, kneelTime: null,
  firstGroundContact: firstContact, stepsTaken: 0, recoveredTime: null,
  expectations: { passed: true, failures: [] },
};

const dir = join(root, 'out', name);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'log.jsonl'), states.map((s) => JSON.stringify(s)).join('\n') + '\n');
writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`${dir}: ${states.length} 프레임, 넘어짐 ${fallTime}초, 첫 접촉 ${firstContact}`);
