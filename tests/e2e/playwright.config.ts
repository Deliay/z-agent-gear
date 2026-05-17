import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 30000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:35273',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
  },
  webServer: [],
});
