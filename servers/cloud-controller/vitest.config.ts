import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/models/**',
        'src/repositories/**',
        'src/services/k8s-client.ts',
      ],
    },
  },
  resolve: {
    extensions: ['.ts', '.js', '.json'],
  },
});
