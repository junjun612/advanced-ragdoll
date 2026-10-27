// 마일스톤 순서 비교. 순서는 config/milestones.json 하나에서만 정한다.
import order from '../../config/milestones.json';

export type Milestone = string;
export const MILESTONES: readonly Milestone[] = order;

/** 마일스톤의 순서 번호. 'v' 접두어는 무시한다. 목록에 없으면 예외. */
export function milestoneIndex(m: Milestone): number {
  const key = m.startsWith('v') ? m.slice(1) : m;
  const i = MILESTONES.indexOf(key);
  if (i < 0) throw new Error(`unknown milestone: ${m}`);
  return i;
}

/** a가 b보다 앞이면 음수, 같으면 0, 뒤면 양수. */
export const compareMilestones = (a: Milestone, b: Milestone): number => milestoneIndex(a) - milestoneIndex(b);

/** current 마일스톤에서 required 기능이 켜져 있는지 (current ≥ required). */
export const milestoneAtLeast = (current: Milestone, required: Milestone): boolean => compareMilestones(current, required) >= 0;
