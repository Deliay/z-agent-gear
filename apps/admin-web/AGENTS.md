# admin-web

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **GraphQL Client**: Apollo Client 4
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library

## Dev Commands

```bash
npm install
npm run build    # tsc -b && vite build
npm run lint
npm test
npm run preview
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`；单独开发时 Vite dev 代理 `/graphql` → `http://localhost:10003`。

## 认证与路由

- 登录态持久化在 `localStorage`（`admin_token` / `admin_user`），不使用 cookie（计划期裁决 8）。
- 路由：`/login`、`/change-password`（无侧边栏）、受保护布局 `AdminLayout` 下 `/models`（默认）、`/base-images` 与 `/cloud-containers`。
- 「云端容器」页（`/cloud-containers`）：展示 cloud-controller 管理的工作容器（名称/状态/用途/关联对象/创建时间/在线时长），`useQuery` 10s 轮询刷新；「启动」对话框本期仅提供 `idle` 任务；每行「强制销毁」二次确认。状态展示映射见裁决 4（创建中/连接中/在线/销毁中/已退出/失败），在线时长按裁决 15 前端计算（`lib/format.ts` 的 `formatOnlineDuration`）。控制面离线时保留降级数据并提示。
- `ProtectedRoute`：未登录 → `/login`；`mustChangePassword` → `/change-password`（后端业务 resolver 亦有双保险拦截）。
- 数据加载分支一律写 `loading && !data`，避免 Apollo v4 轮询卸载整页（见 `frontend-rules.md`）。
- 组件从 agent-web 复制后独立演进，**禁止跨项目 import**。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环。详细指南参考 [TDD Skill](../../.agents/skills/tdd/SKILL.md)。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
