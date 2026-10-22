import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    testTimeout: 15_000,
    // 共享一套服务/DB：admin 套件与 agent scope 回归存在共享状态与口令轮换，
    // 必须串行执行（见 tests/api/AGENTS.md）
    fileParallelism: false,
    // 保留 vitest 默认排除项（node_modules/dist/.git 等），仅追加 acp-real 特例
    exclude: [...configDefaults.exclude, 'src/**/acp-real-*.test.ts'],
  },
});
