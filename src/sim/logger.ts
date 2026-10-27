// 프레임 로그 (SPEC 8.1): 한 줄에 CharacterState 하나, 숫자는 소수 4자리로 반올림 (재실행 바이트 비교용).
import type { CharacterState } from './types';

export function round4(x: number): number {
  const r = Math.round(x * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

/** JSON.stringify용: 모든 숫자를 4자리로 */
export const roundReplacer = (_k: string, v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? round4(v) : v);

export const stringifyRounded = (x: unknown, indent?: number): string => JSON.stringify(x, roundReplacer, indent);

export class FrameLogger {
  readonly lines: string[] = [];
  /** logDt 간격(스텝 수) */
  constructor(readonly everySteps: number) {}

  /** step 번호가 로그 프레임이면 true */
  isLogStep(step: number): boolean {
    return step % this.everySteps === 0;
  }

  log(s: CharacterState): void {
    this.lines.push(stringifyRounded(s));
  }

  text(): string {
    return this.lines.length ? this.lines.join('\n') + '\n' : '';
  }
}
