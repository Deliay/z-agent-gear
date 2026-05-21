import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    testTimeout: 15_000,
    exclude: ['src/**/acp-real-*.test.ts'],
  },
});
