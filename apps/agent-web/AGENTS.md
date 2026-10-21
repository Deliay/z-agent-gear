# agent-web

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **GraphQL Client**: Apollo Client
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library

## Dev Commands

```bash
aspire start     # Start all services via Aspire orchestration
npm run build    # Production build
npm run preview  # Preview production build
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 agent-web 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 首页数据流

首页（`HomePage`）与桌面端侧边栏（`Sidebar`）的全部信息流由 `pages/MainLayout.tsx` 挂载的唯一一次 `HOME_OVERVIEW` 查询（`graphql/home.ts`，`pollInterval: 15000`）统一下发，子组件通过 `stores/homeOverview.ts` 的 `useHomeOverview()` 消费，**不得各自发起信息流查询**（会话/控制器/工作区/工作流/待办/网关/Worktree 均随聚合查询下发）。

- 首屏不阻塞布局外壳：`MainLayout` 先渲染侧边栏/页面外壳，聚合数据到达后各区块同批填充；任何需要 loading 兜底的判断必须写成 `loading && !data`，避免轮询时卸载整页（见 `frontend-rules.md` Apollo v4 轮询陷阱）。
- 归属字段（`WorkflowInstance.workspace` / `controller`）可能已被删除，消费方须判空，回退显示「未知工作区」。
- 网关/Worktree 为嵌套惰性字段：网关为纯 DB 查询、不随控制器在线状态降级（离线控制器仍返回其网关配置行，UI 层按 `status` 自行隐藏该区块）；Worktree 经 Redis relay 扇出，离线或失败/超时后端降级为空列表。
- 设置「可用模型」按组展示并默认折叠：「系统内置」组（`scope=global`）固定排首位、只读（无拖拽/无删除/开关置灰并提示「系统内置模型不可修改」），组内不展示后台供应商名；用户供应商组按 `providerId` 分组，仅组内可拖拽，排序只提交用户模型 id（不含 global）；跨组拖拽忽略。
- 会话内「切换模型」按来源分组：组序固定「平台内置 → Agent 自带 → 自定义 → 来源未知」，组头展示数量与判定依据（`availabilityModels[].basis` 去重后以「；」连接），组内保持原顺序；`group` 缺失归入「来源未知」。

## 会话能力门控与能力面板

- 能力清单由会话级快照（`session.features`）驱动，`SessionHeader` 右侧「能力清单」按钮打开 `AgentCapabilityPanel`（20 项固定顺序 + status/detail + Agent 版本）；无快照时显示「该会话创建于能力快照上线前，继续会话后可获取能力清单」。
- 门控语义集中在 `hooks/useAgentCapabilities.ts`：**只有「有快照且明确 unsupported」才拦截**，旧会话/旧 Agent（无快照）与 `partial` 一律放行（零退化）。
- 生效入口：模型切换（`config.model`）、模式切换（`config.mode`）、布尔配置项（`config.boolean`）、会话「继续」（`session.resume` 与 `session.load` 同时 unsupported 才禁用）；命令列表、历史导入/删除不门控。
- 会话内挂载 `PendingElicitationBanner`：消费首页聚合的 `todos`，筛选本会话未 resolved 的问询，保证移动端（Sidebar 未挂载）也能打开 `ElicitationDialog`。
- `ElicitationDialog` 按 `resolution` / 已过期的 `expiresAt` 展示「已过期/已取消/已失效/已提交/已拒绝」并隐藏操作；`TodoListPanel` 按 todo id 跟踪弹窗数据，轮询后自动收敛为终态。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
