---
description: 首页展示优化 - 实现计划，从技术提案拆解的契约先行分阶段任务（workflowInstances 放宽 + 按控制器索引 + homeOverview 聚合 + 前端一次加载改造）与测试覆盖计划
type: Permanent
---

# 首页展示优化 - 实现计划

**关联 Proposal**: `proposals/20261013-feat-unified-home-display.md`（v1.0）
**关联 PRD**: `docs/product/draft/20261013-unified-home-display.md`（v1.0）
**feat-branch**: `feat/unified-home-display`
**开发分支**: `impl/unified-home-display`（基于 `feat/unified-home-display`）
**创建日期**: 2026-10-13
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约变更（contracts/ 三份，契约先行）
  └── Phase 2: agent-api —— workflowInstances 参数放宽 + 归属字段 + 复合索引（TDD 核心）
       └── Phase 3: agent-api —— sessions(controllerId) 过滤
            └── Phase 4: agent-api —— homeOverview 聚合查询（含嵌套惰性字段）
                 └── Phase 5: 前端 —— HOME_OVERVIEW 手写类型 + MainLayout 挂载下传
                      └── Phase 6: 前端 —— HomePage / Sidebar / 消费组件改造（工作流集中列表）
                           └── Phase 7: 测试补全（组件测试 + API 测试补漏 + E2E）
                                └── Phase 8: 全量回归 + PRD 验收核对
```

依赖说明：Phase 1→2→3→4 为契约到后端的严格顺序（后端查询能力是 `homeOverview` 的组合来源）；Phase 5 依赖 Phase 1 契约即可先行并行开发，但联调依赖 Phase 4；Phase 6 依赖 Phase 5 的数据下传形态；Phase 7 贯穿各 Phase（TDD 用例先行），收口阶段补 E2E。开发模式采用 TDD（红-绿-重构）：每个后端 Phase 先写 `tests/api` 与单测增量用例（RED）再实现（GREEN）；编码前加载 `docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端 Phase）与 `docs/engineering/frontend-rules.md`（前端 Phase）。

关键约束（提案 §5.2/§6.1，实现期不得回退）：

- **契约先行**：先改 `contracts/` 并独立提交，再动实现；三份契约与提案 §3.1 逐字段对齐。
- **resolver 合并清单登记**：新增 Query 级与类型级字段 resolver 必须登记进 `servers/agent-api/src/graphql/resolvers/index.ts`（`backend-rules.md` 显性陷阱：漏登记时单测直引 resolver 对象不报错，但线上不生效）。
- **前端 GraphQL 类型全手写**：契约变更同步 `apps/agent-web/src/graphql/types.ts`、`graphql/workflow.ts`（无 codegen）。
- **向后兼容**：`workflowInstances` 旧调用（`workspaceId` 必传）语义零变化；`sessions` 旧调用不受影响；设置页等仍在用的查询（`GetWorkspaces` / `GetControllerWorkspaces` 等）保留不动。
- **薄 resolver**：`homeOverview` 只用 `Promise.all` 组合既有 service，不新增 service 层；`Controller.gateways` / `ControllerWorkspace.worktrees` 为嵌套字段，仅查询语句选择时才执行（`gateways` 为纯 DB 查询，`worktrees` 经 Redis relay 扇出）。
- **降级语义**：`ControllerWorkspace.worktrees` 离线或扇出失败/超时降级为空列表（`Controller.gateways` 为纯 DB 查询、不随在线状态降级）；聚合查询单分支失败按 GraphQL 部分数据语义返回（字段置 null + errors），前端各区块独立判空，不拖垮整次查询。
- **加载态写法**：`loading && !data`（`frontend-rules.md` Apollo v4 轮询陷阱：`if (loading) return <Spinner/>` 会在 15s 轮询时卸载整页）。
- **不动的范围**：controller-api、agent-controller CLI、工作流详情页查询（`GET_WORKFLOW_INSTANCE`）、网关/Worktree 变更类操作。
- **索引随启动自动建立**：`WorkflowInstance` 新增复合索引靠 Mongoose `autoIndex`，无迁移脚本。

计划期裁决（提案留白的实现细节，实现期按此执行）：

- **归属字段形态**：`WorkflowInstance` 增加 `workspace: ControllerWorkspace` / `controller: Controller` 可空对象字段（提案 §3.1 首选项）。工作区已删除 → `workspace: null`，前端显示「未知工作区」（PRD 3.5 边界）。
- **worktrees 嵌套字段元素类型**：沿用既有契约类型 `WorkspaceWorktree`（提案 §3.1 示意写作 `Worktree`，以 `contracts/controller-workspace.graphql` 实际类型为准）。
- **session service 方法名**：现状为 `findAllByUser(userId, options)`，提案 §3.2 示意 `list(...)`；实现按现有签名扩展 `options`，不重命名。
- **待办刷新节奏**：`TodoListPanel` 现状 5s 轮询，并入 `homeOverview` 后统一 15s（提案 §2.3「单一 pollInterval: 15000」）；待办刷新频率放缓为已接受的行为变化，不为待办保留独立查询。
- **`sessionTotalCount` 语义**：与 `homeOverview.sessions` 同口径计数（当前等于列表长度），独立字段是为了将来列表限量返回时卡片不受影响；HomePage「会话总数」「最近会话（前 5）」逻辑与现状一致（提案 §5.2 实现点 3）。

---

## Phase 1: 契约变更（contracts/）

开发分支：`impl/unified-home-display`（基于 `feat/unified-home-display`）。本 Phase 变更独立提交（`docs(contracts): ...` 或 `feat(contracts): ...`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/workflow.graphql` | 修改 | Query（~L273）`workflowInstances(workspaceId: ID!, archived: Boolean)` 改为 `workflowInstances(workspaceId: ID, controllerId: ID, archived: Boolean)`，注释说明「二者可同传取交集；都不传 = 当前用户全部实例」；`WorkflowInstance` 类型（~L156）增加 `workspace: ControllerWorkspace`、`controller: Controller` 可空归属字段，注释「归属对象可能已被删除，消费方须判空」 |
| `contracts/agent-session.graphql` | 修改 | Query（~L327）`sessions(includeWorkflowSessions: Boolean)` 改为 `sessions(controllerId: ID, includeWorkflowSessions: Boolean)`，注释「`controllerId` 可选，按控制器过滤」 |
| `contracts/home.graphql` | 新增 | `homeOverview: HomeOverview!` 聚合查询；`HomeOverview { controllers: [Controller!]!, sessions: [Session!]!, sessionTotalCount: Int!, workspaces: [ControllerWorkspace!]!, workflowInstances: [WorkflowInstance!]!, archivedWorkflowInstances: [WorkflowInstance!]!, todos: [TodoItem!]!, unreadTodoCount: Int! }`；`extend type Controller { gateways: GatewayList! }`、`extend type ControllerWorkspace { worktrees: [WorkspaceWorktree!]! }`，注释「嵌套惰性解析：仅查询语句选择时展开；`gateways` 纯 DB 查询不降级，`worktrees` Redis relay 扇出、离线或扇出失败返回空列表」 |

### 验收 checklist

- [ ] 三份契约与提案 §3.1 逐字段一致（`worktrees` 元素类型为 `WorkspaceWorktree`）
- [ ] 契约变更独立提交，后续 Phase 才动实现代码
- [ ] 旧签名调用方（`workflowInstances(workspaceId:)` / `sessions`）语法仍合法

---

## Phase 2: agent-api —— workflowInstances 放宽 + 归属字段 + 复合索引

TDD 顺序：先写 `instance.test.ts` / `workflow.test.ts` 与 `tests/api/src/agent-api/workflow.test.ts` 增量用例（RED）→ 实现（GREEN）→ 保持存量用例全绿。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/workflow-instance.ts` | 修改 | 补两个复合索引：`{ userId: 1, archivedAt: 1, createdAt: -1 }`（跨工作区全量列表）、`{ userId: 1, controllerId: 1, archivedAt: 1, createdAt: -1 }`（按控制器过滤）；`controllerId` 当前无索引 |
| `servers/agent-api/src/services/workflow/instance.ts` | 修改 | 新增 `list(userId, { workspaceId?, controllerId?, archived? })`：动态组装过滤条件，恒有 `{ userId, deletedAt: null }`，`workspaceId`/`controllerId` 可选叠加取交集，`archivedAt` 按 `archived` 取 `null` / `{ $ne: null }`（与 `listForWorkspace` L50 现状语义一致）；`listForWorkspace` 改为委托 `list`（唯一调用点 `resolvers/workflow.ts:190` 同步迁移） |
| `servers/agent-api/src/graphql/schemas/workflow.ts` | 修改 | `workflowInstances` 签名同步契约（~L246）；`WorkflowInstance` 类型补 `workspace` / `controller` 可空字段 |
| `servers/agent-api/src/graphql/resolvers/workflow.ts` | 修改 | Query resolver 参数归一后调用 `list`；新增类型级字段 resolver：`WorkflowInstance.workspace`（按 `workspaceId` 查 workspace service，已删除返回 `null`）、`WorkflowInstance.controller`（按 `controllerId` 查 controller service，同上） |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 登记 `WorkflowInstance` 类型级字段 resolver（显性陷阱，见关键约束） |
| `servers/agent-api/src/services/workflow/instance.test.ts` | 修改 | 增量单测：过滤条件组装（无参 / workspaceId / controllerId / 交集 / archived） |
| `tests/api/src/agent-api/workflow.test.ts` | 修改 | 增量 API 测试 T-W*（真实 Mongo，混合数据） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-W1 | 无参数查询 `workflowInstances` | 返回当前用户全部未归档实例（跨工作区、跨控制器） |
| T-W2 | 仅 `workspaceId` | 与现状 `listForWorkspace` 行为一致（回归） |
| T-W3 | 仅 `controllerId` | 仅返回该控制器下实例 |
| T-W4 | `workspaceId` + `controllerId` 同传 | 取交集 |
| T-W5 | `archived: true`（无参与有参组合） | 仅归档实例 |
| T-W6 | 混合数据（多用户 / 多控制器 / 多工作区） | 不泄露其他用户实例 |
| T-W7 | 实例的 workspace 已删除 | `workspace: null`，`controller` 正常返回 |
| T-W8 | 旧调用方式（`workspaceId` 必传） | 语义零变化（兼容断言） |

### 命令参考

```bash
cd servers/agent-api && npx vitest run src/services/workflow/instance.test.ts src/graphql/resolvers/workflow.test.ts
# API 测试（需先起 Aspire，见 tests/api/AGENTS.md）
aspire start && aspire wait agent-api
API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npm test -- workflow
```

### 验收 checklist

- [ ] T-W1 ~ T-W8 全部通过
- [ ] `listForWorkspace` 除委托实现外无残留直调
- [ ] 两个新复合索引已声明；类型级字段 resolver 已登记 `resolvers/index.ts`
- [ ] 存量 workflow 用例全绿（T-W2 即回归锚点）

---

## Phase 3: agent-api —— sessions(controllerId) 过滤

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | `sessions` 签名改 `sessions(controllerId: ID, includeWorkflowSessions: Boolean)`（~L201） |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | 透传 `controllerId` 到 service |
| `servers/agent-api/src/services/session.ts` | 修改 | `findAllByUser(userId, { includeWorkflowSessions?, controllerId? })`：`controllerId` 有值时叠加过滤；复用既有 `{ controllerId: 1, status: 1 }` 与 `{ userId: 1, createdAt: -1 }` 索引，不新增 |
| `tests/api/src/agent-api/session.test.ts` | 修改 | 增量 API 测试 T-S* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-S1 | `sessions(controllerId: X)` | 仅 X 控制器下会话 |
| T-S2 | `sessions()` 无参 | 与现状一致（回归） |
| T-S3 | `controllerId` + `includeWorkflowSessions` 组合 | 过滤正确叠加 |
| T-S4 | 跨用户隔离 | 不泄露他人会话 |

### 命令参考

```bash
cd tests/api && API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npm test -- session
```

### 验收 checklist

- [ ] T-S1 ~ T-S4 全部通过
- [ ] 无 schema 字段变更、无新增索引

---

## Phase 4: agent-api —— homeOverview 聚合查询

TDD 顺序：先写 `tests/api/src/agent-api/home.test.ts`（RED，全字段 + 降级 + 部分失败语义）→ 实现（GREEN）→ 补 resolver 单测。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/home.ts` | 新增 | `homeOverview: HomeOverview!` 与 `HomeOverview` 类型定义（对齐 `contracts/home.graphql`） |
| `servers/agent-api/src/graphql/resolvers/home.ts` | 新增 | `homeOverview` 用 `Promise.all` 并行调用既有 service：`controllerService.findAllByUser`、`sessionService.findAllByUser`（`sessionTotalCount` 同口径计数）、`controllerWorkspaceService.findAllByUser`、`workflowInstanceService.list`（archived false / true 两路）、`getTodoList` / `getUnreadTodoCount` 既有 todo 链路；嵌套字段 `Controller.gateways`（按控制器调 gateway service，纯 DB 查询）与 `ControllerWorkspace.worktrees`（复用 `workspaceWorktrees` 服务链路，经 Redis relay 扇出）惰性解析，单路失败降级空列表 |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 登记 `homeResolvers.Query`、`Controller.gateways`、`ControllerWorkspace.worktrees` |
| `servers/agent-api/src/graphql/resolvers/home.test.ts` | 新增 | resolver 单测：组合逻辑、单分支失败降级（Promise.allSettled 或 try/catch 归一） |
| `tests/api/src/agent-api/home.test.ts` | 新增 | API 测试 T-H* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-H1 | `homeOverview` 全字段 | 各字段与对应既有查询结果一致（同数据集交叉断言） |
| T-H2 | 查询语句不含 `gateways`/`worktrees` | 不触发嵌套字段解析（mock/计数断言；`worktrees` 不发生 Redis relay 扇出） |
| T-H3 | 查询语句含 `controllers.gateways` | 返回该控制器的网关列表（纯 DB 查询，不随控制器在线状态降级） |
| T-H4 | 查询语句含 `workspaces.worktrees` | 各工作区返回其 Worktree 列表；单个工作区扇出失败 → 空列表，其余字段正常 |
| T-H5 | 某一分支数据为空（如无工作流） | 对应字段空数组/0，其余字段正常 |
| T-H6 | 跨用户隔离 | 全部字段仅含当前用户数据 |

### 命令参考

```bash
cd servers/agent-api && npx vitest run src/graphql/resolvers/home.test.ts
cd tests/api && API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npm test -- home
```

### 验收 checklist

- [ ] T-H1 ~ T-H6 全部通过
- [ ] `homeOverview` 无新增 service 层；`gateways`/`worktrees` 未选择时不解析（`worktrees` 不发生 Redis relay 扇出）
- [ ] 三个新/改 resolver 均已登记 `resolvers/index.ts`

---

## Phase 5: 前端 —— HOME_OVERVIEW 手写类型 + MainLayout 挂载下传

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/home.ts` | 新增 | `HOME_OVERVIEW` 查询（命名 `HomeOverview`，与 `Get*` 前缀区分聚合查询）与手写类型；查询语句包含 `controllers { ... gateways { ... } }`、`workspaces { ... worktrees { ... } }`、`workflowInstances` / `archivedWorkflowInstances`（含 `workspace`/`controller` 归属）、`sessions`、`sessionTotalCount`、`todos`、`unreadTodoCount`，与 `contracts/home.graphql` 人工对齐 |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 增加 `HomeOverview` 等手写类型；`WorkflowInstanceSummaryData` 补 `workspace` / `controller` 可空归属（`graphql/workflow.ts` 内联定义处同步） |
| `apps/agent-web/src/graphql/workflow.ts` | 修改 | `GetWorkflowInstances` 变量类型放宽：`$workspaceId: ID!` → `$workspaceId: ID`（L285），类型声明同步 |
| `apps/agent-web/src/pages/MainLayout.tsx` | 修改 | 挂载 `useQuery(HOME_OVERVIEW, { pollInterval: 15000 })`（单一查询、单一轮询）；以 props/context 下传 `HomePage` 与 `Sidebar`（**首屏不阻塞布局外壳、无独立加载分支**：聚合数据未就绪时以空数据渲染外壳、数据到达后各区块同批填充；整体错误 `error && !data` + 重试入口） |

### 行为变化说明（实现与验证时确认）

- 首页 + 侧边栏信息流由「约 `3 + 3×工作区数 + 1×在线控制器数 + 2` 次请求 ×15s 轮询」收敛为「1 次请求 ×15s 轮询」；待办刷新从 5s 放缓为 15s（计划期裁决）。
- 整体加载失败展示全局错误 + 重试，重试仍是一次请求（PRD 3.5）。

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-F1 | MainLayout 挂载 | 仅发起一次 `HomeOverview` 查询，`pollInterval` 为 15000 |
| T-F2 | 轮询期间 `loading` 为真 | 不卸载子页面（`loading=true` 且已有数据时仍渲染 outlet/sidebar、不出现整页 spinner，含焦点/IME 不丢的等价断言） |
| T-F3 | 查询失败 | 整体错误提示 + 重试入口，重试发一次请求 |

### 命令参考

```bash
cd apps/agent-web && npx vitest run src/pages && npm run build && npm run lint
```

### 验收 checklist

- [ ] T-F1 ~ T-F3 全部通过
- [ ] TypeScript strict 编译通过；手写类型与契约一致
- [ ] `grep -rn "useQuery" apps/agent-web/src/pages/MainLayout.tsx` 仅 `HOME_OVERVIEW` 一处

---

## Phase 6: 前端 —— HomePage / Sidebar / 消费组件改造（工作流集中列表）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/pages/HomePage.tsx` | 修改 | 删除自身 `GET_SESSIONS` / `GET_CONTROLLERS` 查询，消费下传数据；「在线控制器/会话总数/控制器总数」卡片与「最近会话（前 5，按 `updatedAt` 排序截取）」逻辑与现状一致 |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 删除自身 6 路查询（`GetSessions`/`GetControllers`/`GetWorkspaces`/`GetWorkflowInstances`×2/后续由 `homeOverview` 覆盖的其它调用），消费下传数据；工作流改为**集中列表**：每个控制器「工作流」`TreeSection` 下平铺该控制器全部实例（按 `instance.controllerId` 分组或 `workflowInstances` 前端过滤），不再按工作区拆 `WorkflowSidebarGroupInline`；条目增加一行所属工作区/控制器辅助信息（`workspace?.name ?? '未知工作区'`，PRD 3.5），点击直达工作流详情（沿用既有跳转）；归档实例在折叠分组中展示（`archivedWorkflowInstances`）；移除 `handleInstancesChange` / `hasWorkflowInstances` 的按工作区计数逻辑 |
| `apps/agent-web/src/components/GatewaySection.tsx` | 修改 | 改为消费 `homeOverview.controllers.gateways` 下传数据（纯展示），删除自身 `GET_GATEWAYS` 查询；`GatewayDialog` / `GatewayItem` 不动 |
| `apps/agent-web/src/components/worktree/WorktreeSidebarGroup.tsx` | 修改 | 改为消费 `homeOverview.workspaces.worktrees` 下传数据（纯展示），删除自身 `WORKSPACE_WORKTREES` 查询 |
| `apps/agent-web/src/components/TodoListPanel.tsx` | 修改 | 消费 `homeOverview.todos` / `unreadTodoCount`，删除 `GetTodoList` / `GetUnreadTodoCount` 查询；`markTodoRead` 等 mutation 的 refetch 目标改为 `HOME_OVERVIEW` |
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 修改 | 保留 `GET_WORKFLOW_INSTANCES`（变量已放宽，现状 `workspaceId` 传参兼容）；实例化成功后的 refetch 增加 `HOME_OVERVIEW`（或依赖 15s 轮询兜底，二选一并注明） |
| `apps/agent-web/src/components/__tests__/Sidebar.test.tsx` 等 | 修改 | `Sidebar.test.tsx` / `TodoListPanel.test.tsx` / `worktree/WorktreeSidebarGroup.test.tsx` 改为 mock `HOME_OVERVIEW` 下传数据；断言集中列表渲染与归属标注、归档折叠、点击跳转 |

### 全局检索确认（收口必查）

- `grep -rn "GetWorkflowInstances\|GET_WORKFLOW_INSTANCES" apps/agent-web/src`：除 `graphql/workflow.ts` 定义与 `InstantiateWorkflowDialog` 外无残留调用。
- `grep -rn "GetTodoList\|GetUnreadTodoCount\|GetGateways\|WorkspaceWorktrees" apps/agent-web/src`：首页/侧边栏链路组件内无残留调用；`queries.ts` 定义保留（设置页 `WorkspaceSection` 等仍用 `GetWorkspaces` / `GetControllerWorkspaces`，不动）。
- `grep -rn "WorkflowSidebarGroupInline" apps/agent-web/src`：无残留。

### 验收 checklist

- [ ] 打开首页（含桌面端 Sidebar）仅 `HOME_OVERVIEW` 一路查询
- [ ] 工作流为集中平铺列表（不按工作区分组），条目可识别所属工作区/控制器，点击直达详情，归档可查
- [ ] 空状态/离线/归属删除边界符合 PRD 3.5（未知工作区置灰、离线控制器标记、空列表提示）
- [ ] 桌面端与移动端布局均不回归（`responsive-layout.spec.ts` 相关断言）

---

## Phase 7: 测试补全

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/__tests__/Sidebar.test.tsx` | 修改 | 补集中列表用例：多控制器多工作区混合数据渲染、归属标注、归档折叠、空状态 |
| `apps/agent-web/src/pages/__tests__/MainLayout.test.tsx`（或就近） | 新增 | 单次查询下传与轮询不卸载断言（若 Phase 5 未覆盖） |
| `tests/e2e/src/home.spec.ts` | 新增 | E2E T-E* |
| `tests/api/src/agent-api/home.test.ts` | 修改 | 补漏（如部分失败语义、并发扇出） |

### 测试用例（E2E 增量）

| # | 用例 | 预期 |
|---|------|------|
| T-E1 | 打开首页（Playwright route 拦截计数 `/graphql`） | 首屏仅 1 次请求 |
| T-E2 | 停留一个轮询周期 | 每轮新增请求恰为 1 次 |
| T-E3 | 工作流集中列表 | 全部工作流不展开工作区即可见；条目标注工作区/控制器；点击直达详情 |
| T-E4 | 按控制器浏览 | 选定控制器可见其工作区/会话/工作流 |
| T-E5 | 某信息流为空 | 对应区块空状态，其余正常 |

### 命令参考

```bash
# E2E（见 tests/e2e/AGENTS.md，先起 Aspire，端口以 aspire describe 为准）
aspire start && aspire wait agent-api && aspire wait agent-web
BASE_URL=http://localhost:35615 API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npx playwright test home.spec.ts
```

### 验收 checklist

- [ ] T-E1 ~ T-E5 全部通过
- [ ] 前端单测覆盖新增/改造组件（`npm run test` 全绿）
- [ ] API 与 E2E 套件串行执行（`common-rules.md` 测试陷阱：两套套件不并行共享服务）

---

## Phase 8: 全量回归 + PRD 验收核对

### 命令参考

```bash
# 后端
cd servers/agent-api && npm run build && npm run lint && npx vitest run
# 前端
cd apps/agent-web && npm run build && npm run lint && npm run test
# API 全量（tests/api/AGENTS.md）
aspire start && aspire wait agent-api
cd tests/api && API_URL=... CONTROLLER_API_URL=... npm run test:all
# E2E 全量（tests/e2e/AGENTS.md，与 API 套件串行）
cd tests/e2e && BASE_URL=... API_URL=... CONTROLLER_API_URL=... npx playwright test
```

### 总体验收 checklist

- [ ] 单元测试覆盖率 ≥ 80%（common-rules）
- [ ] API 测试通过（含 `workflowInstances` 五种参数组合、`sessions(controllerId)`、`homeOverview` 降级语义）
- [ ] E2E 测试通过（首页单次请求断言为硬性项）
- [ ] PRD 验收标准逐条核对（`docs/product/draft/20261013-unified-home-display.md` §3.2 各功能点验收标准 + §1.3 成功标准）
  - [ ] 工作流集中列表 + 归属标注 + 直达详情 + 归档可查
  - [ ] 按控制器查看工作区/会话/工作流
  - [ ] 首页首屏仅一次请求、一轮轮询一次请求、数量增加请求次数不变、多路到达不闪烁重排
- [ ] PRD 3.5 异常边界逐条核对（工作区删除、控制器离线、空列表、整体失败重试、部分为空）
- [ ] 提 PR 回 `feat/unified-home-display`（需求总 PR #200），待 review

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| `worktrees` 扇出（1×工作区数的 Redis relay）拖慢单次请求 | 并发扇出 + 既有超时兜底；必要时首页查询语句不选 `worktrees`、仅侧边栏展开时单独查（提案 §5.2 风险点，预留开关位） |
| 漏登记 `resolvers/index.ts` 导致字段不生效 | Phase 2/4 验收 checklist 显式核对；API 测试走真实 schema（非直引 resolver 对象）可暴露 |
| 手写类型与契约漂移 | Phase 5 收口时人工逐字段比对 + `npm run build` strict 编译 |
| 存量调用回归 | T-W8 / T-S2 兼容断言锚定旧语义；`InstantiateWorkflowDialog` 保留原查询 |
| 后端先行发布与旧前端并存 | `workspaceId` 放宽向后兼容，前后端可分两次发布（提案 §9） |

## 相关文档

- 关联 PRD：`docs/product/draft/20261013-unified-home-display.md`
- 关联 Proposal：`docs/engineering/proposals/20261013-feat-unified-home-display.md`
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
- 测试规范：`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`
