import { defineConfig, configDefaults } from 'vitest/config';

// 병렬 에이전트 worktree(.claude/worktrees/)의 테스트가 같이 잡히지 않게 뺀다
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
