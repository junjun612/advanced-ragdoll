// 디버그 표시 (SPEC 8.3 표). 상태와 이벤트를 읽어 three.js 객체만 갱신한다.
// 텍스트(활성 행동, 자세)는 3D가 아니라 2D 오버레이에서 그리므로 문자열만 만든다.
import * as THREE from 'three';
import type { CharacterStateLite, FilmEvent, Vec2, Vec3 } from './stateTypes';
import type { FilmConfig } from './scene';

export const DEBUG_COLOR = {
  com: '#e02020',
  support: '#18a040',
  capture: '#2060e0',
  impact: '#f0c000',
  stepTarget: '#60c8f0',
  landing: '#1a3a8a',
  grab: '#9030c0',
  cop: '#f07800',
  force: '#c02090',
  contact: '#10a0a0',
  cmp: '#6020c0',
  angMom: '#e04080',
  wound: '#8a0010',
  handTarget: '#e000c0',
  gaze: '#00a0ff',
  fallHand: '#ff7a00',
  touchdown: '#00b8d4',
} as const;

/** 균형 전략 라벨 (이미지 안 한글) */
export const STRATEGY_LABEL: Record<string, string> = { ankle: '발목 전략', hip: '고관절 전략', off: '균형 꺼짐' };

/** 균형 텍스트: "발목 전략 · 여유 8.2cm" (고관절 가중치가 중간이면 함께). 균형 상태가 없으면 '' */
export function balanceText(state: CharacterStateLite): string {
  const b = state.balance;
  if (!b) return '';
  if (!b.enabled) return STRATEGY_LABEL.off!;
  const w = b.hipWeight > 0.05 && b.hipWeight < 0.95 ? ` ${b.hipWeight.toFixed(1)}` : '';
  return `${STRATEGY_LABEL[b.strategy] ?? b.strategy}${w} · 여유 ${(b.margin * 100).toFixed(1)}cm${settleText(state) ? ` · ${settleText(state)}` : ''}${romText(state) ? ` · ${romText(state)}` : ''}${toneText(state) ? ` · ${toneText(state)}` : ''}${b.land && b.land > 0.05 ? ` · 착지 받기 ${b.land.toFixed(1)}` : ''}`;
}

/** (결정 tone-1) 근긴장: "공동수축 0.8 · 신장 반사 Spine2 0.4 (감쇠 ×3.4)". 꺼져 있거나 0이면 '' */
export function toneText(state: CharacterStateLite): string {
  const k = state.tone;
  if (!k || (k.co < 0.05 && k.reflexMax < 0.05)) return '';
  const p: string[] = [];
  if (k.co >= 0.05) p.push(`공동수축 ${k.co.toFixed(1)}`);
  if (k.reflexMax >= 0.05) p.push(`신장 반사 ${k.reflexJoint ?? ''} ${k.reflexMax.toFixed(1)}`);
  return `${p.join(' · ')} (감쇠 ×${k.maxKd.toFixed(1)})`;
}

/** (결정 rom-4) 어깨 가동 범위 끝 저항이 걸린 팔: "어깨 끝 왼 7°" (토크 5 N·m 넘을 때). 없으면 '' */
export function romText(state: CharacterStateLite): string {
  const out: string[] = [];
  for (const [n, ko] of [['LeftArm', '왼'], ['RightArm', '오른']] as const) {
    const r = state.joints?.[n]?.rom;
    if (r && r.torque > 5) out.push(`${ko} ${Math.round(r.excessDeg)}°`);
  }
  return out.length ? `어깨 끝 ${out.join('·')}` : '';
}

/** 진정 단계 텍스트 (README 결정 settle-1): "진정 0.8" / "진정 풀림(걸음)". 충격 뒤 진정 판단 중이 아니면 '' */
const SETTLE_WHY_KO: Record<string, string> = { hit: '충격', step: '걸음', fall: '넘어짐', speed: '속도', margin: '여유', ineligible: '행동' };
export function settleText(state: CharacterStateLite): string {
  const s = state.balance?.settle;
  if (!s) return '';
  // 나온 직후 0.5초는 이유를 보인다 (reason = "<이유> <시각>")
  const [why, at] = s.reason.split(' ');
  if (s.since === null && why && state.time - Number(at) < 0.5) return `진정 풀림(${SETTLE_WHY_KO[why] ?? why})`;
  return s.level > 0 ? `진정 ${s.level.toFixed(1)}` : '';
}

const FOOT_KO: Record<string, string> = { LeftFoot: '왼발', RightFoot: '오른발' };

/** 스텝 상태 텍스트 (이미지 안 한글, v0.4): "왼발 스텝 2" · "정착" · "왼발 들기" · "오른발 모으기". 스텝 계층이 없으면 '' */
export function stepText(state: CharacterStateLite): string {
  const s = state.stepping;
  if (!s) return '';
  const foot = s.swingFoot ? FOOT_KO[s.swingFoot] ?? s.swingFoot : '';
  let t = '';
  if (s.state === 'step') t = s.kind === 'closing' ? `${foot} 모으기` : `${foot} 스텝 ${s.stepCount + 1}`;
  else if (s.state === 'lift') t = `${foot} 들기`;
  else if (s.state === 'settle') t = `정착 (${s.stepCount}걸음)`;
  else return '';
  if (s.phase === 'unload') t += ' · 하중 빼기';
  if (s.staggerHandoff) t += ' · 비틀거림 넘김';
  // (v0.8a) 지형 디딤: 디딤면 높이 차 / 헛디딤
  if (s.state === 'step' && s.terrain) t += s.terrain.void ? ' · 헛디딤(디딜 곳 없음)' : Math.abs(s.terrain.dh) >= 0.02 ? ` · ${s.terrain.dh < 0 ? '아래' : '위'} 디딤면 ${Math.round(Math.abs(s.terrain.dh) * 100)}cm` : '';
  return t;
}

const MODE_KO: Record<string, string> = { stance: '지지', landing: '착지 대기', liftoff: '떼기', swing: '스윙' };
/** 걷기 추종 넘김 이유 (이미지 글자는 한글) */
const HANDOVER_KO: Record<string, string> = { void: '헛디딤', trip: '걸림', balanceOff: '균형 꺼짐', noContact: '접촉 없음', low: '낮음' };

/** 애니 추종 텍스트 (v0.6): "걷기 추종 · 왼발 지지 · 오른발 스윙 · 핀 0.40" / "추종 넘김 (dcm 0.31)" / "키네마틱 재생". 클립이 없으면 '' */
const RET_BLOCK_KO: Record<string, string> = { react: '반응 중', reaction: '반응 클립', stepping: '걸음 중', moving: '움직임', feet: '두 발 아님', margin: '균형 여유', 'walk dcm': '걸음 오차', getup: '일어서기' };
/** (README 결정 game-1) 게임 애니 복귀 텍스트: "애니 복귀 대기 (걸음 중)" / "애니로 복귀 중 0.3/0.5초" */
export function returnText(state: CharacterStateLite): string {
  const r = state.returnAnim;
  if (!r) return '';
  if (r.phase === 'wait') { const b = r.blockedBy.split(' ')[0] === 'behavior' ? `행동 ${r.blockedBy.slice(9)}` : r.blockedBy.startsWith('posture') ? '서 있지 않음' : RET_BLOCK_KO[r.blockedBy] ?? r.blockedBy; return `애니 복귀 대기${b ? ` (${b})` : ' (곧)'}`; }
  if (r.phase === 'pin') return '애니 복귀 · 핀 블렌드';
  if (r.phase === 'kinematic' && r.kinT !== null) return `애니로 복귀 중 ${Math.max(0, state.time - r.kinT).toFixed(1)}/${(r.blendTime - r.pinTime).toFixed(1)}초`;
  return '';
}

export function walkText(state: CharacterStateLite): string {
  if (!state.anim) return '';
  const pin = state.pin && state.pin.strength > 0.005 ? ` · 핀 ${state.pin.strength.toFixed(2)}` : '';
  const rt = returnText(state);
  if (state.state === 'Animated') return rt || `키네마틱 재생${state.states?.transition ? ' (전환 중)' : ''}`;
  if (rt) return `${rt}${pin}`;
  const w = state.walk;
  if (!w) return `클립 추종${pin}`;
  if (!w.engaged) return `추종 넘김${w.handover ? ` (${HANDOVER_KO[w.handover] ?? w.handover})` : ''}${pin}`;
  const f = (n: string) => `${FOOT_KO[n] ?? n} ${MODE_KO[w.feet[n]?.mode ?? ''] ?? ''}`;
  return `클립 추종 · ${f('LeftFoot')} · ${f('RightFoot')}${w.phaseState ? ` · 위상 몸 따라 ×${w.rate.toFixed(2)}` : ''}${pin}`;
}

const REACT_DIR_KO: Record<string, string> = { back: '뒤', front: '앞', left: '왼쪽', right: '오른쪽', backleft: '왼쪽 뒤', backright: '오른쪽 뒤', frontleft: '왼쪽 앞', frontright: '오른쪽 앞' };
/** 반응 클립 텍스트 (2026-10-27): "반응 클립 뒤 Δv0.8 s2 · 상체 0.9 · 속도 1.4 · 걸음 1/2" */
export function reactionText(state: CharacterStateLite): string {
  const r = state.reaction;
  if (!r || r.phase === 'done' || !r.clip) return '';
  const m = /^react_([a-z]+)_s(d)(d)_s(d+)$/.exec(r.clip);
  const nm = m ? `${REACT_DIR_KO[m[1]!] ?? m[1]} Δv${m[2]}.${m[3]} s${m[4]}` : r.clip.replace(/^react_/, '');
  const st = r.style;
  return st ? `반응 클립 ${nm} · 상체 ${st.w.toFixed(1)} · 속도 ${st.rate.toFixed(1)} · 걸음 ${st.ourLandings}/${st.clipLandings.length}` : `반응 클립 ${nm} · ${r.tau.toFixed(2)}초`;
}

const GETUP_POSTURE_KO: Record<string, string> = { supine: '누움', prone: '엎드림', side: '옆', sit: '앉음' };
/** 일어서기 텍스트 (v0.7): "일어서기 1/3 · 엎드림 · 진행 45% · 보조 0.62 (210N)" / "균형 복귀" / "누워 쉼 1.2초" */
export function getupText(state: CharacterStateLite): string {
  const g = state.getup;
  if (!g) return '';
  const pk = g.posture ? GETUP_POSTURE_KO[g.posture] ?? g.posture : '';
  if (g.phase === 'rising') return `일어서기 ${g.attempt}/${g.maxAttempts}${pk ? ` · ${pk}` : ''} · 진행 ${Math.round((g.progress ?? 0) * 100)}%${g.assist.s > 0.005 ? ` · 보조 ${g.assist.s.toFixed(2)} (${Math.round(g.assist.force)}N)` : ''}`;
  if (g.phase === 'balance') return '일어섬 · 균형 복귀';
  if (g.settled > 0) return `누워 쉼 ${g.settled.toFixed(1)}초${pk ? ` · ${pk}` : ''}${g.attempt ? ` · 시도 ${g.attempt}회` : ''}`;
  return '';
}

/** 범례 항목 (이미지 안 한글). kind는 2D 견본 모양 */
export const LEGEND: { label: string; color: string; kind: 'dot' | 'cross' | 'line' | 'arrow' | 'text' | 'gradient' | 'foot' }[] = [
  { label: '질량중심', color: DEBUG_COLOR.com, kind: 'dot' },
  { label: '바닥 투영', color: DEBUG_COLOR.com, kind: 'cross' },
  { label: '지지 다각형', color: DEBUG_COLOR.support, kind: 'line' },
  { label: '캡처 포인트', color: DEBUG_COLOR.capture, kind: 'dot' },
  { label: '충격', color: DEBUG_COLOR.impact, kind: 'arrow' },
  { label: '활성 행동', color: '#202020', kind: 'text' },
  { label: '근육 강도', color: '', kind: 'gradient' },
  { label: '스텝 목표', color: DEBUG_COLOR.stepTarget, kind: 'foot' },
  { label: '실제 착지', color: DEBUG_COLOR.landing, kind: 'foot' },
  { label: '잡기 대상', color: DEBUG_COLOR.grab, kind: 'dot' },
  { label: '압력 중심', color: DEBUG_COLOR.cop, kind: 'dot' },
  { label: '가상 힘', color: DEBUG_COLOR.force, kind: 'arrow' },
  { label: '접촉력', color: DEBUG_COLOR.contact, kind: 'arrow' },
  { label: 'CMP', color: DEBUG_COLOR.cmp, kind: 'cross' },
  { label: '각운동량', color: DEBUG_COLOR.angMom, kind: 'arrow' },
  { label: '상처', color: DEBUG_COLOR.wound, kind: 'dot' },
  { label: '손 목표', color: DEBUG_COLOR.handTarget, kind: 'dot' },
  { label: '시선', color: DEBUG_COLOR.gaze, kind: 'line' },
  { label: '예측 손 착지', color: DEBUG_COLOR.fallHand, kind: 'cross' },
  { label: '예측 착지점', color: DEBUG_COLOR.touchdown, kind: 'dot' },
];

export const POSTURE_LABEL: Record<string, string> = {
  standing: '서 있음', kneeling: '무릎 꿇음', down: '쓰러짐', airborne: '공중',
};

/** 활성 행동 텍스트 (한글 이름, v0.5a): 가중치 큰 순 최대 3개, "상처 움켜쥐기 1.0 · 피격 반응 0.6". 한글 이름이 없으면 코드 이름 */
export function activeBehaviorText(state: CharacterStateLite): string {
  const src = state.behavior?.active ?? state.behaviors ?? [];
  // (relax-1) 충격 후 이완은 늘 앞에 (가중치가 늘 1이라 다른 1.0 행동에 밀려 안 보였다)
  const pri = (b: { name: string }) => (b.name === 'ImpactRelax' ? 1 : 0);
  const list = src.filter((b) => b.weight > 0.01).sort((a, b) => pri(b) - pri(a) || b.weight - a.weight).slice(0, 3);
  if (!list.length) return '';
  // (relax-1) 충격 후 이완은 가중치 대신 지금 팔다리 강도 배율("충격 후 이완 0.4", phase에 담김)
  return list.map((b) => `${('ko' in b && b.ko) || b.name} ${b.name === 'ImpactRelax' && 'phase' in b && b.phase ? b.phase : b.weight.toFixed(1)}`).join(' · ');
}

const HOLD_MODE_KO: Record<string, string> = { gesture: '뻗었다 거두기', kneelWait: '꿇은 뒤 쥐기 대기', look: '내려다보기' };
/** 손-상처 거리 텍스트 (v0.5a): "손-상처 3.2cm". (결정 leg-2) 다리 상처를 쥐지 않으면 판단과 필요·허용 숙임: "내려다보기 (숙임 90+°>45°)" (이유 문장은 로그 info.reach.why) */
export function clutchText(state: CharacterStateLite): string {
  const hw = (state.behavior?.active ?? []).find((b) => b.name === 'HoldWound' && b.weight > 0.05);
  const info = hw?.info as { mode?: string; reach?: { needDeg: number; allowDeg: number; why: string } } | null | undefined;
  const mode = info?.mode && HOLD_MODE_KO[info.mode] ? `${HOLD_MODE_KO[info.mode]}${info.reach ? ` (숙임 ${info.reach.needDeg > 90 ? '90+' : info.reach.needDeg.toFixed(0)}°>${info.reach.allowDeg.toFixed(0)}°)` : ''}` : '';
  const h = (state.behavior?.hands ?? []).find((x) => x.woundDist !== null && x.weight > 0.05);
  const dist = h && h.woundDist !== null ? `${h.hand === 'LeftHand' ? '왼손' : '오른손'}-상처 ${(h.woundDist * 100).toFixed(1)}cm` : '';
  return [mode, dist].filter(Boolean).join(' · ');
}

const FALL_KIND_KO: Record<string, string> = { forward: '앞', backward: '뒤', left: '왼쪽', right: '오른쪽' };
/** 넘어짐 텍스트 (v0.5b): "넘어짐 확실도 0.9 · 앞 · 0.35초" (확실도 0.15 미만이면 '') */
export function fallText(state: CharacterStateLite): string {
  const f = state.behavior?.fall;
  if (!f || f.certainty < 0.15) return '';
  return `넘어짐 확실도 ${f.certainty.toFixed(1)} · ${FALL_KIND_KO[f.kind] ?? f.kind} · ${f.timeToImpact.toFixed(2)}초`;
}

const GRAB_PHASE_KO: Record<string, string> = { reach: '뻗기', hold: '잡음', released: '놓음', failed: '못 잡음' };
/** 잡기 텍스트 (v0.8b): "왼손 잡음 420N · 미끄러짐 0.6cm · 오른손 뻗기" (잡기가 없고 벽 짚기만 있으면 '') */
export function grabText(state: CharacterStateLite): string {
  const g = state.behavior?.grab;
  if (!g || !g.hands.length) return '';
  return g.hands.map((h) => `${h.hand === 'LeftHand' ? '왼손' : '오른손'} ${GRAB_PHASE_KO[h.phase] ?? h.phase}${h.phase === 'hold' ? ` ${Math.round(h.force)}N · 미끄러짐 ${(h.slip * 100).toFixed(1)}cm` : ''}`).join(' · ');
}

/** 공중 텍스트 (v0.5c): 공중이면 "공중 0.42초 · 착지까지 0.31초", 착지 뒤 0.4초 동안 "착지 3.1m/s · Hips" */
export function airText(state: CharacterStateLite): string {
  const a = state.behavior?.air;
  if (!a) return '';
  if (!a.contact && a.airTime > 0.03) return `공중 ${a.airTime.toFixed(2)}초${a.timeToGround !== null ? ` · 착지까지 ${a.timeToGround.toFixed(2)}초` : ''}`;
  const l = a.landing;
  if (l && state.time - l.t < 0.4) return `착지 ${l.speedH.toFixed(1)}m/s · ${l.body}`;
  return '';
}

/** 충격 라벨: 폭발은 "폭발 Δv 4.6m/s", 그 밖은 "충격 <바디> <Δv>m/s" */
export function impactLabel(e: FilmEvent): string {
  const dv = e.dv != null ? `${Number(e.dv.toFixed(2))}m/s` : '';
  return e.detail === 'explosion' ? `폭발 Δv ${dv}` : `충격 ${e.body ?? ''} ${dv}`.trim();
}

/** t 시점에 표시할 충격 이벤트(t ≤ now < t + showSec). */
export function activeImpacts(events: readonly FilmEvent[] | undefined, now: number, showSec: number): FilmEvent[] {
  return (events ?? []).filter((e) => e.direction && now >= e.t - 1e-6 && now < e.t + showSec);
}

const overlay = (color: string, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: opacity < 1, opacity, side: THREE.DoubleSide });

/** xz 평면 띠(선분 두께 w)를 삼각형으로 만든다. y는 살짝 띄운다. */
function ribbonGeometry(segments: [Vec2, Vec2][], w: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const [a, b] of segments) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
    const p = [
      [a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz],
    ] as const;
    for (const i of [0, 1, 2, 0, 2, 3]) pos.push(p[i]![0], y, p[i]![1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export class DebugDraw {
  readonly group = new THREE.Group();
  private readonly com: THREE.Mesh;
  private readonly comCross: THREE.Mesh;
  private readonly capture: THREE.Mesh;
  private readonly grab: THREE.Mesh;
  private readonly support: THREE.Mesh;
  private readonly cop: THREE.Mesh;
  private readonly force = new THREE.Group();
  private balanceOn = true;
  private readonly contactBars: THREE.Mesh[] = [];
  private readonly contactMat = overlay(DEBUG_COLOR.contact, 0.9);
  private readonly cmpMark: THREE.Mesh;
  private readonly angArrow = new THREE.Group();
  private readonly arrows: THREE.Group[] = [];
  private readonly stepTargets: THREE.Mesh[] = [];
  private readonly arrowMat = overlay(DEBUG_COLOR.impact);
  private readonly stepMat = overlay(DEBUG_COLOR.stepTarget, 0.8);
  private readonly landMeshes: THREE.Mesh[] = [];
  private readonly landMat = overlay(DEBUG_COLOR.landing, 0.85);
  private captureOn = true;
  private readonly woundMeshes: THREE.Mesh[] = [];
  private readonly handMeshes: THREE.Mesh[] = [];
  private readonly fallMeshes: THREE.Mesh[] = [];
  private readonly airMeshes: THREE.Mesh[] = [];
  private readonly grabMeshes: THREE.Mesh[] = [];
  private readonly lineMeshes: THREE.Mesh[] = [];
  private impactOn = true;

  constructor(private readonly cfg: FilmConfig) {
    const d = cfg.debug;
    this.com = new THREE.Mesh(new THREE.SphereGeometry(d.comRadius, 14, 10), overlay(DEBUG_COLOR.com));
    const h = d.crossHalf;
    this.comCross = new THREE.Mesh(ribbonGeometry([[[-h, -h], [h, h]], [[-h, h], [h, -h]]], 0.022, 0.006), overlay(DEBUG_COLOR.com));
    this.capture = new THREE.Mesh(new THREE.SphereGeometry(d.capturePointRadius, 14, 10), overlay(DEBUG_COLOR.capture));
    this.grab = new THREE.Mesh(new THREE.SphereGeometry(d.grabTargetRadius, 14, 10), overlay(DEBUG_COLOR.grab));
    this.support = new THREE.Mesh(new THREE.BufferGeometry(), overlay(DEBUG_COLOR.support));
    this.cop = new THREE.Mesh(new THREE.CylinderGeometry(d.capturePointRadius, d.capturePointRadius, 0.004, 16), overlay(DEBUG_COLOR.cop));
    for (const m of [this.support, this.comCross, this.capture, this.com, this.grab, this.cop]) {
      m.renderOrder = 10;
      this.group.add(m);
    }
    // 가상 힘 화살표: COM에서 시작, 수평 피드백 힘 방향, 길이 ∝ |F|
    const fm = overlay(DEBUG_COLOR.force);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 10), fm);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 12), fm);
    shaft.renderOrder = head.renderOrder = 11;
    this.force.add(shaft, head);
    this.group.add(this.force);
    const ch = d.crossHalf * 0.8;
    this.cmpMark = new THREE.Mesh(ribbonGeometry([[[-ch, 0], [ch, 0]], [[0, -ch], [0, ch]]], 0.016, 0.007), overlay(DEBUG_COLOR.cmp));
    this.cmpMark.renderOrder = 10;
    this.group.add(this.cmpMark);
    const am = overlay(DEBUG_COLOR.angMom);
    const s2 = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1, 8), am), h2 = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 10), am);
    s2.renderOrder = h2.renderOrder = 11;
    this.angArrow.add(s2, h2);
    this.group.add(this.angArrow);
  }

  /** 항목별 표시 on/off (앱 토글). com = 질량중심 점과 바닥 투영, support = 지지 다각형, capture = 캡처 포인트, impact = 충격 화살표 */
  setPartVisible(part: 'com' | 'support' | 'capture' | 'impact' | 'balance', on: boolean): void {
    if (part === 'balance') this.balanceOn = on;
    else if (part === 'com') this.com.visible = this.comCross.visible = on;
    else if (part === 'support') this.support.visible = on;
    else if (part === 'capture') this.captureOn = on;
    else this.impactOn = on;
  }
  update(state: CharacterStateLite, events: readonly FilmEvent[] | undefined, now: number): void {
    const [cx, cy, cz] = state.com;
    this.com.position.set(cx, cy, cz);
    this.comCross.position.set(cx, 0, cz);

    const cp = state.capturePoint;
    this.capture.visible = !!cp && this.captureOn;
    if (cp) this.capture.position.set(cp[0], 0.02, cp[1]);

    const g = state.grabTarget;
    // (v0.8b) 손별 잡기 점은 updateBehavior가 그린다 (grabTarget 하나 점은 손 잡기 로그가 없을 때만)
    this.grab.visible = !!g && !state.behavior?.grab;
    if (g) this.grab.position.set(g[0], g[1], g[2]);

    const poly = state.supportPolygon ?? [];
    this.support.geometry.dispose();
    const segs: [Vec2, Vec2][] = [];
    if (poly.length >= 2) {
      for (let i = 0; i < poly.length; i++) segs.push([poly[i]!, poly[(i + 1) % poly.length]!]);
    }
    this.support.geometry = ribbonGeometry(segs, 0.02, 0.004);

    this.updateBalance(state);
    this.updateArrows(state, this.impactOn ? activeImpacts(events, now, this.cfg.impactShowSec) : []);
    this.updateStepTargets(state.stepTargets ?? []);
    this.updateLandings(state);
    this.updateBehavior(state);
  }

  /** 행동 (v0.5a): 상처(진한 빨강 점), 손 목표(자홍 점) + 손바닥→목표 선, 시선(하늘색 선, 머리→대상 방향 0.6m) */
  private updateBehavior(state: CharacterStateLite): void {
    const b = state.behavior;
    const wounds = b?.wounds ?? [];
    const hands = (b?.hands ?? []).filter((h) => h.weight > 0.05);
    const mk = (list: THREE.Mesh[], n: number, color: string, r: number) => {
      while (list.length < n) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), overlay(color)); m.renderOrder = 12; list.push(m); this.group.add(m); }
      list.forEach((m, i) => { m.visible = i < n; });
    };
    mk(this.woundMeshes, wounds.length, DEBUG_COLOR.wound, 0.022);
    wounds.forEach((w, i) => this.woundMeshes[i]!.position.set(w.point[0], w.point[1], w.point[2]));
    // 예측 손 착지점 (v0.5b): 넘어짐 확실도 0.3 이상, 대비가 끝나기 전(발 아닌 바디가 닿기 전)
    const f = b?.fall;
    const landed = (state.contacts ?? []).some((c) => !/Foot/.test(c.body));
    const fh = f && f.certainty >= 0.3 && !landed ? Object.values(f.hands) : [];
    mk(this.fallMeshes, fh.length, DEBUG_COLOR.fallHand, 0.03);
    fh.forEach((p, i) => { this.fallMeshes[i]!.position.set(p[0], p[1] + 0.01, p[2]); });
    // 예측 착지점 (v0.5c): 공중일 때
    const a = b?.air;
    const td = a && !a.contact && a.touchdown ? [a.touchdown] : [];
    mk(this.airMeshes, td.length, DEBUG_COLOR.touchdown, 0.035);
    td.forEach((p, i) => { this.airMeshes[i]!.position.set(p[0], p[1] + 0.01, p[2]); });
    // (v0.8b) 잡기: 잡은 앵커·뻗는 목표(보라 점, state.grabTarget 말고 손마다) + 손바닥→앵커/목표 선, 벽 탐지 점(보라 작은 점)
    const gh = (b?.grab?.hands ?? []).filter((h) => h.phase === 'reach' || h.phase === 'hold');
    const wallP = b?.grab?.wall ? [b.grab.wall.point] : [];
    mk(this.grabMeshes, gh.length + wallP.length, DEBUG_COLOR.grab, 0.02);
    gh.forEach((h, i) => { const p = h.anchor ?? h.target ?? h.palm; this.grabMeshes[i]!.position.set(p[0], p[1], p[2]); this.grabMeshes[i]!.scale.setScalar(h.phase === 'hold' ? 1.3 : 0.8); });
    wallP.forEach((p, i) => { const m = this.grabMeshes[gh.length + i]!; m.position.set(p[0], p[1], p[2]); m.scale.setScalar(0.6); });
    mk(this.handMeshes, hands.length, DEBUG_COLOR.handTarget, 0.016);
    hands.forEach((h, i) => { const p = h.target ?? h.ref; this.handMeshes[i]!.position.set(p[0], p[1], p[2]); });
    const segs: { a: Vec3; b: Vec3; color: string }[] = hands.map((h) => ({ a: h.palm, b: h.target ?? h.ref, color: DEBUG_COLOR.handTarget }));
    for (const h of gh) { const p = h.anchor ?? h.target; if (p) segs.push({ a: h.palm, b: p, color: DEBUG_COLOR.grab }); }
    const g = b?.gaze;
    const head = state.bodies.Head?.pos;
    if (g && head) {
      const d = [g.target[0] - head[0], g.target[1] - head[1], g.target[2] - head[2]];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      segs.push({ a: head, b: [head[0] + (d[0]! / l) * 0.6, head[1] + (d[1]! / l) * 0.6, head[2] + (d[2]! / l) * 0.6], color: DEBUG_COLOR.gaze });
    }
    while (this.lineMeshes.length < segs.length) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 6), overlay('#ffffff')); m.renderOrder = 12; this.lineMeshes.push(m); this.group.add(m); }
    this.lineMeshes.forEach((m, i) => {
      const s = segs[i];
      m.visible = !!s;
      if (!s) return;
      const a = new THREE.Vector3(...s.a), e = new THREE.Vector3(...s.b);
      const len = a.distanceTo(e);
      m.visible = len > 0.005;
      (m.material as THREE.MeshBasicMaterial).color.set(s.color);
      m.position.copy(a.clone().add(e).multiplyScalar(0.5));
      m.scale.set(1, Math.max(len, 1e-3), 1);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.clone().sub(a).normalize());
    });
  }

  /** 노란 화살표: 끝이 충격 지점(없으면 바디 중심)에 닿고, 길이는 Δv에 비례. */
  private updateArrows(state: CharacterStateLite, impacts: FilmEvent[]): void {
    const d = this.cfg.debug;
    while (this.arrows.length < impacts.length) {
      const a = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 10), this.arrowMat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.11, 14), this.arrowMat);
      shaft.renderOrder = head.renderOrder = 11;
      a.add(shaft, head);
      this.arrows.push(a);
      this.group.add(a);
    }
    this.arrows.forEach((a, i) => {
      const e = impacts[i];
      a.visible = !!e;
      if (!e?.direction) return;
      const dir = new THREE.Vector3(...e.direction).normalize();
      const tip: Vec3 = e.point ?? (e.body ? state.bodies[e.body]?.pos : undefined) ?? state.com;
      const len = d.arrowLengthBase + d.arrowLengthPerDv * (e.dv ?? 1);
      const headLen = 0.11;
      const [shaft, head] = a.children as [THREE.Mesh, THREE.Mesh];
      a.position.set(tip[0], tip[1], tip[2]);
      a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      // 그룹 로컬 +Y = 충격 방향. 끝(원점)에서 −Y 쪽으로 몸통이 뻗는다.
      head.position.set(0, -headLen / 2, 0);
      shaft.scale.set(1, Math.max(len - headLen, 0.01), 1);
      shaft.position.set(0, -headLen - (len - headLen) / 2, 0);
    });
  }

  /** 균형 (v0.3): CoP 원판(지면), 가상 힘 화살표(COM에서, 수평 성분, forceLengthPerN m/N), QP 접촉력 막대(접촉점에서 힘 방향, contactLengthPerN m/N) */
  private updateBalance(state: CharacterStateLite): void {
    const b = state.balance;
    // CMP (지면 십자), 각운동량 화살표 (COM에서, 수평 성분, angMomLengthPer m per kg·m²/s)
    this.cmpMark.visible = this.balanceOn && !!b?.enabled && !!b.cmp;
    if (b?.cmp) this.cmpMark.position.set(b.cmp[0], (b.groundHeight ?? 0) + 0.004, b.cmp[1]);
    const am = b?.angularMomentum;
    const kl = am ? Math.hypot(am[0], am[2]) * (this.cfg.debug.angMomLengthPer ?? 0.05) : 0;
    this.angArrow.visible = this.balanceOn && !!b?.enabled && kl > 0.03;
    if (this.angArrow.visible && am) {
      const [cx, cy, cz] = state.com;
      this.angArrow.position.set(cx, cy + 0.25, cz);
      this.angArrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(am[0], 0, am[2]).normalize());
      const [sh, hd] = this.angArrow.children as [THREE.Mesh, THREE.Mesh];
      sh.scale.set(1, kl, 1); sh.position.set(0, kl / 2, 0); hd.position.set(0, kl + 0.035, 0);
    }
    const cf = this.balanceOn && b?.enabled ? b.contactForces ?? [] : [];
    while (this.contactBars.length < cf.length) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 8), this.contactMat);
      m.renderOrder = 11;
      this.contactBars.push(m);
      this.group.add(m);
    }
    const k = this.cfg.debug.contactLengthPerN ?? 0.0008;
    this.contactBars.forEach((m, i) => {
      const c = cf[i];
      const len = c ? Math.hypot(c.f[0], c.f[1], c.f[2]) * k : 0;
      m.visible = !!c && len > 0.01;
      if (!c || !m.visible) return;
      const dir = new THREE.Vector3(c.f[0], c.f[1], c.f[2]).normalize();
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m.scale.set(1, len, 1);
      m.position.set(c.p[0] + dir.x * len / 2, c.p[1] + dir.y * len / 2, c.p[2] + dir.z * len / 2);
    });
    const gy = (b?.groundHeight ?? 0) + 0.006;
    this.cop.visible = this.balanceOn && !!b?.cop;
    if (b?.cop) this.cop.position.set(b.cop[0], gy, b.cop[1]);
    const f = b?.virtualForce;
    const fh = f ? Math.hypot(f[0], f[2]) : 0;
    const len = fh * (this.cfg.debug.forceLengthPerN ?? 0.002);
    this.force.visible = this.balanceOn && !!b?.enabled && len > 0.03;
    if (!this.force.visible || !f) return;
    const [cx, cy, cz] = state.com;
    const dir = new THREE.Vector3(f[0], 0, f[2]).normalize();
    this.force.position.set(cx, cy, cz);
    this.force.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const [shaft, head] = this.force.children as [THREE.Mesh, THREE.Mesh];
    const sl = Math.max(len - 0.08, 0.01);
    shaft.scale.set(1, sl, 1);
    shaft.position.set(0, sl / 2, 0);
    head.position.set(0, sl + 0.04, 0);
  }

  /** 실제 착지 (v0.4): 최근 착지 위치에 남색 발자국 테두리 + 목표→착지 오차 선 */
  private updateLandings(state: CharacterStateLite): void {
    const ls = (state.stepping?.landings ?? []).slice(-3);
    const need = ls.length * 2;
    while (this.landMeshes.length < need) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.landMat);
      m.renderOrder = 9;
      this.landMeshes.push(m);
      this.group.add(m);
    }
    this.landMeshes.forEach((m, i) => {
      const l = ls[Math.floor(i / 2)];
      m.visible = !!l;
      if (!l) return;
      m.geometry.dispose();
      if (i % 2 === 0) {
        const hw = 0.055, hl = 0.125, [x, z] = l.p;
        m.geometry = ribbonGeometry([[[x - hw, z - hl], [x + hw, z - hl]], [[x + hw, z - hl], [x + hw, z + hl]], [[x + hw, z + hl], [x - hw, z + hl]], [[x - hw, z + hl], [x - hw, z - hl]]], 0.012, 0.007);
      } else m.geometry = ribbonGeometry([[l.target, l.p]], 0.01, 0.008);
    });
  }

  /** 스텝 목표 훅 (v0.4~): 하늘색 발자국 */
  private updateStepTargets(targets: Vec2[]): void {
    while (this.stepTargets.length < targets.length) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.004, 0.25), this.stepMat);
      m.renderOrder = 9;
      this.stepTargets.push(m);
      this.group.add(m);
    }
    this.stepTargets.forEach((m, i) => {
      const t = targets[i];
      m.visible = !!t;
      if (t) m.position.set(t[0], 0.005, t[1]);
    });
  }
}
