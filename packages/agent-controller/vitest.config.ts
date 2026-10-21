import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tsconfig 会把 src/**/*.test.ts 一并编译进 dist；不排除会导致构建后
    // 重复执行编译副本（且 sidecar fixture 如 .mjs 不会被 tsc 复制而必然失败）。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
