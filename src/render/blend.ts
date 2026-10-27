// 렌더 블렌드 (SPEC v0.6 '렌더 블렌드'): 표시 자세 = slerp(애니 자세, 물리 자세, w). 상태 전환 순간의 시각적 튐을 숨긴다.
// 캡슐(디버그 표시)은 물리 그대로, FBX(보이는 캐릭터)는 이 표시 자세를 쓴다. sim 상태를 읽기만 한다.
import type { CharacterStateLite, Quat, Vec3 } from './stateTypes';

function slerpQ(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let bb: Quat = [b[0], b[1], b[2], b[3]];
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const q: Quat = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** 표시 상태: render.w < 1이고 애니 자세가 있으면 바디마다 위치 lerp·회전 slerp(애니 → 물리, w). 아니면 그대로 */
export function displayState(state: CharacterStateLite): CharacterStateLite {
  const w = state.render?.w;
  const anim = state.anim?.bodies;
  if (w === undefined || w >= 1 || !anim) return state;
  const bodies: CharacterStateLite['bodies'] = {};
  for (const [name, b] of Object.entries(state.bodies)) {
    const a = anim[name];
    if (!a) { bodies[name] = b; continue; }
    const pos: Vec3 = [a.pos[0] + (b.pos[0] - a.pos[0]) * w, a.pos[1] + (b.pos[1] - a.pos[1]) * w, a.pos[2] + (b.pos[2] - a.pos[2]) * w];
    bodies[name] = { ...b, pos, rot: slerpQ(a.rot, b.rot, w) };
  }
  return { ...state, bodies };
}
