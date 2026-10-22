import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tsconfig 会把 src/**/*.test.ts 一并编译进 dist；在 vitest 默认排除项之外
    // 追加 **/dist/**，避免构建后重复执行编译副本（且 sidecar fixture 如 .mjs
    // 不会被 tsc 复制而必然失败）。不得用自定义数组覆盖默认值（会丢 .git 等默认排除）。
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
