# admin-web

云控制器管理后台前端（管理后台 Web）。

## 技术栈

- React 19 + TypeScript（strict）
- Vite 8 + Tailwind CSS v4（`@tailwindcss/vite`）
- Apollo Client 4（GraphQL）
- React Router v7
- shadcn（@base-ui/react）+ lucide-react + sonner
- Vitest + React Testing Library

## 开发命令

```bash
npm install
npm run dev        # Vite dev server（本地可独立运行，代理 /graphql → localhost:10003）
npm run build      # tsc -b && vite build
npm run lint       # eslint
npm test           # vitest run
```

本项目由 Aspire 编排启动，`VITE_ADMIN_API_URL` 由 Aspire 注入；也可单独 `npm run dev`。

## admin-api 接入地址（endpoint 四级优先）

`src/lib/api-base.ts` 按以下优先级解析 admin-api 地址（高优先在前）：

1. `localStorage['zag:admin-api-base']`：登录页「服务器地址」设置，保存前先 `GET <endpoint>/health` 探测，通过才落盘。
2. `window.__ADMIN_CONFIG__.apiUrl`：nginx 容器启动脚本按环境变量 `ADMIN_API_URL` 生成 `config.js` 注入。
3. `import.meta.env.VITE_ADMIN_API_URL`：构建期默认值。
4. 同源兜底 `''`：GraphQL 请求走相对路径 `/graphql`，由部署侧反代。

## 容器部署

- `Dockerfile`：多阶段构建（`node:24-alpine` 构建 → `nginx:1.27-alpine` 托管），构建参数 `VITE_ADMIN_API_URL` 透传给 `npm run build`。
- `nginx.conf`：SPA history fallback（`try_files $uri $uri/ /index.html`）+ `/assets/` 长缓存，不硬编码 `/graphql` 上游。
- `docker-entrypoint.d/40-generate-config-js.sh`：容器启动时按 `ADMIN_API_URL` 生成 `/usr/share/nginx/html/config.js`；未设置时生成空配置。

## 相关文档

- [AGENTS.md](./AGENTS.md)
- [Architecture Proposal](../../docs/engineering/proposals/20261014-feat-admin-console.md)
- [Implementation Plan](../../docs/engineering/plan/20261014-feat-admin-console.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
