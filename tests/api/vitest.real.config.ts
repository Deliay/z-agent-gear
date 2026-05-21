import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    testTimeout: 30_000,
    include: ['src/**/acp-real-*.test.ts'],
    fileParallelism: false,
  },
});
