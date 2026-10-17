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
- 路由：`/login`、`/change-password`（无侧边栏）、受保护布局 `AdminLayout` 下 `/models`（默认）、`/base-images`、`/cloud-containers` 与 `/cloud-workloads`。
- 「云端容器」页（`/cloud-containers`）：展示 cloud-controller 管理的工作容器（名称/状态/用途/关联对象/创建时间/在线时长），`useQuery` 10s 轮询刷新；「启动」对话框本期仅提供 `idle` 任务，并可多选挂载「工作负载」（默认不选，勾选顺序即提交顺序，**最多 10 个**；工作负载列表加载中/失败分别展示「加载中」与「错误 + 重试」，避免误判为空）；每行「强制销毁」二次确认。状态展示映射见裁决 4（创建中/连接中/**初始化中**/在线/销毁中/已退出/失败），初始化中展示当前执行的工作负载脚本名（`currentWorkloadName`）；在线时长按裁决 15 前端计算（`lib/format.ts` 的 `formatOnlineDuration`）。控制面离线时保留降级数据并提示。
- 「工作负载」页（`/cloud-workloads`）：工作负载 CRUD（名称 + 初始化脚本 + 清理脚本），新建/编辑共用对话框，删除二次确认。脚本摘要单行截断；前端预校验「名称必填且 ≤64 字符、两脚本至少其一非空、单脚本 ≤16 KiB」（服务端仍强制）。
- 工作负载执行日志：在「云端容器」页按容器查看（`WorkloadLogsDialog`）——执行记录列表（工作负载/阶段/状态/时间）+ 选中项的脚本内容快照与输出日志。日志查询 `pollInterval: 5000` 并带「刷新」按钮（PRD 功能点 5：执行中记录实时可刷新），轮询按 `id` 保留用户选中项；对话框自带 `useQuery`，与容器 10s 轮询解耦（轮询刷新不打断已打开对话框）。
- `ProtectedRoute`：未登录 → `/login`；`mustChangePassword` → `/change-password`（后端业务 resolver 亦有双保险拦截）。
- 数据加载分支一律写 `loading && !data`，避免 Apollo v4 轮询卸载整页（见 `frontend-rules.md`）。
- 组件从 agent-web 复制后独立演进，**禁止跨项目 import**。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环。详细指南参考 [TDD Skill](../../.agents/skills/tdd/SKILL.md)。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
