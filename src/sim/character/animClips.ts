// 애니메이션 클립 라이브러리 (SPEC 11.1 포즈 클립, v0.6): assets/poses/kimodo_*.json (sim은 파일 시스템을 쓰지 않으므로 정적 import).
// 동작 클립은 Kimodo 생성 클립만 쓴다 (CLAUDE.md). 클립을 추가하면 여기에도 넣는다. 이름 = 파일 이름(확장자 없이).
import idleRelaxed from '../../../assets/poses/kimodo_idle_relaxed.json';
import walkForward from '../../../assets/poses/kimodo_walk_forward.json';
import walkBackward from '../../../assets/poses/kimodo_walk_backward.json';
import walkStart from '../../../assets/poses/kimodo_walk_start.json';
import type { AnimClipFile } from './animDriver';

export const ANIM_CLIPS: Readonly<Record<string, AnimClipFile>> = {
  kimodo_idle_relaxed: idleRelaxed as unknown as AnimClipFile,
  kimodo_walk_forward: walkForward as unknown as AnimClipFile,
  kimodo_walk_backward: walkBackward as unknown as AnimClipFile,
  kimodo_walk_start: walkStart as unknown as AnimClipFile,
};
