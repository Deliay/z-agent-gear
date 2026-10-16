import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 30000,
  // 共享服务/Mongo：admin 套件会轮换共享管理员口令、清理全局供应商，且与 tests/api 共享 DB。
  // 多 worker 并行会互相污染，必须强制串行（见 AGENTS.md）。
  fullyParallel: false,
  workers: 1,

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:35273',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
  },
  webServer: [],
});
