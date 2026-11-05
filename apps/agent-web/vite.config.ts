/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const proxyTarget = process.env.VITE_API_URL || process.env.VITE_BASE_URL || 'http://localhost:4000'
console.log(`Proxy to server ${proxyTarget}`)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/graphql': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 裁决 7：monaco 单列独立 chunk（动态 import 隔离，首屏不加载）
        manualChunks(id: string) {
          if (id.includes('node_modules') && id.includes('monaco-editor')) return 'monaco';
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
  },
})
