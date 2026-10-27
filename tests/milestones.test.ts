import { describe, it, expect } from 'vitest';
import { MILESTONES, compareMilestones, milestoneAtLeast, milestoneIndex } from '../src/sim/milestones';
import hitScale from '../config/hitScale.json';

describe('milestones', () => {
  it('order matches SPEC 12 / CLAUDE.md', () => {
    expect(MILESTONES).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5a', '0.5b', '0.5c', '0.6', '0.7', '0.8a', '0.8b', '0.8c', '0.9', '1.0']);
  });
  it('compare / atLeast', () => {
    expect(compareMilestones('0.5a', '0.5c')).toBeLessThan(0);
    expect(compareMilestones('v0.8b', '0.8b')).toBe(0);
    expect(milestoneAtLeast('0.6', '0.5c')).toBe(true);
    expect(milestoneAtLeast('0.4', '0.5a')).toBe(false);
    expect(() => milestoneIndex('0.5')).toThrow();
  });
  it('hitScale fixed values (SPEC 7.2)', () => {
    expect(hitScale).toEqual({ small: 0.3, medium: 0.8, large: 1.5 });
  });
});
