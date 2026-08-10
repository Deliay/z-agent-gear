---
description: Agent 工作流 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# Agent 工作流 - 实现计划

**关联 Proposal**: `proposals/20260808-feat-agent-workflow.md`
**关联 PRD**: `docs/product/draft/20260808-agent-workflow.md`
**feat-branch**: `feat/agent-workflow`
**创建日期**: 2026-08-08

## 实现顺序

```
Phase 1: 契约更新（contracts/）
  └── Phase 2: agent-api 数据模型 + 模板/配置/黑板服务
       └── Phase 3: 节点状态机引擎 WorkflowEngine
            └── Phase 4: 会话编排 Orchestrator + Session 打标 + 兜底
                 └── Phase 5: Scoped MCP Registry（工作流工具）
                      └── Phase 6: GraphQL schemas/resolvers + 默认模板种子
                           ├── Phase 7: agent-web SessionView 抽取 + 设置工作流 section
                           │    └── Phase 8: agent-web 侧边栏层级 + 实例视图 + 会话侧面板
                           └── Phase 9: API 测试
                                └── Phase 10: E2E 测试
```

依赖说明：Phase 2 的模型字段与 Phase 1 契约对齐；Phase 3 依赖 Phase 2 的黑板服务；Phase 4/5 依赖引擎的 transition 入口；Phase 7/8 前端依赖 Phase 6 的 GraphQL 可运行；测试阶段（9/10）在对应后端可运行后并行推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/workflow.graphql` | 新增 | 按提案 §3.1：类型/枚举/Input/Query/Mutation 全量 |
| `contracts/agent-session.graphql` | 修改 | `Session` 增加 `workflowInstanceId/workflowNodeId`；`sessions` 增加 `includeWorkflowSessions` 参数 |
| `contracts/mcp-server.graphql` | 修改 | `transport: platform` 去掉 P2 标记转正 |

### 验证

- [x] 契约与提案 §3.1 一致，评审通过

---

## Phase 2: agent-api 数据模型 + 模板/配置/黑板服务

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/workflow-template.ts` | 新增 | WorkflowTemplate 模型（含 version/isBuiltin/nodes 子文档） |
| `servers/agent-api/src/models/configured-workflow.ts` | 新增 | ConfiguredWorkflow 模型（快照节点 + agentConfig） |
| `servers/agent-api/src/models/workflow-instance.ts` | 新增 | WorkflowInstance 模型（nodes 实例状态 + blackboard/blackboardTrash Map） |
| `servers/agent-api/src/services/workflow/template.ts` | 新增 | 模板 CRUD + `validateTemplateGraph()` 纯函数（校验规则见提案 §4.1） |
| `servers/agent-api/src/services/workflow/template.test.ts` | 新增 | 用例 T1–T9（见文末测试计划） |
| `servers/agent-api/src/services/workflow/configured.ts` | 新增 | 复制快照、配置校验（controller 归属、capabilities）、删除约束 |
| `servers/agent-api/src/services/workflow/configured.test.ts` | 新增 | 配置校验与复制语义用例 |
| `servers/agent-api/src/services/workflow/blackboard.ts` | 新增 | get/set/remove（入垃圾桶）、产物前缀匹配、打回记录 |
| `servers/agent-api/src/services/workflow/blackboard.test.ts` | 新增 | 用例 B1–B4 |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [x] `validateTemplateGraph()` 纯函数覆盖 T1–T9 全部通过
- [x] 从模板复制生成快照，修改模板后副本不变
- [x] 黑板 remove 后数据进入 blackboardTrash

---

## Phase 3: 节点状态机引擎 WorkflowEngine

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/engine.ts` | 新增 | `transition(instanceId, nodeId, event, payload)` 唯一入口；状态转移表 + 合法性校验；事件副作用（下游 start/上游 rework/复工通知）以 hook 注册，避免与 Orchestrator 循环依赖 |
| `servers/agent-api/src/services/workflow/engine.test.ts` | 新增 | 用例 E1–E12 |

### 设计要点

- 状态转移表显式声明：`INITIALIZING→READY`、`READY→RUNNING`、`RUNNING→{DONE,REJECT}`、`REJECT→RUNNING`、`{READY,RUNNING,DONE}→REWORK`、`REWORK→DONE`，其余一律拒绝并返回可读错误。
- 多上游汇合：节点所有 `dependsOn` 均 DONE 才允许 READY→RUNNING。
- FLAG 节点：收到上游完成事件即透传，不产生会话。
- 每次转移更新实例 `currentNodeNames`（全部 RUNNING 节点名）。

### 验收 checklist

- [x] E1–E12 全部通过，非法转移错误信息人类可读
- [x] 引擎不直接 import Orchestrator（依赖注入/hook）

---

## Phase 4: 会话编排 Orchestrator + Session 打标 + 兜底

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/session.ts` | 修改 | 新增 `workflowInstanceId: ObjectId?`、`workflowNodeId: String?` |
| `servers/controller-api/src/models/session.ts` | 修改 | 同步副本字段（两服务共享 Mongo） |
| `servers/agent-api/src/services/workflow/orchestrator.ts` | 新增 | `startNodeSession/reworkNodeSession/endNodeSession`；提示词组装（系统提示+节点提示词数组+上游产物）；阶段 worktree 后缀 `<instance-slug>/<stage-slug>`；注册为引擎 hook |
| `servers/agent-api/src/services/workflow/orchestrator.test.ts` | 新增 | 用例 O1–O8 |
| `servers/agent-api/src/services/session.ts` | 修改 | `create()` 支持内部打标参数；`mapSession()` 透出新字段；`sessions` 查询默认排除工作流会话；状态变 `ended` 时回调引擎兜底检查 |
| `servers/agent-api/src/services/session.test.ts` | 修改 | 打标/排除查询/兜底回调用例 |

### 验收 checklist

- [x] O1–O8 全部通过
- [x] 兜底仅触发 1 次，无死循环
- [x] `sessions` 默认查询不含工作流会话

---

## Phase 5: Scoped MCP Registry（工作流工具）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/mcp-endpoint.ts` | 修改 | JWT payload 扩展 `workflow: {instanceId, nodeId}`（仅节点会话） |
| `servers/agent-api/src/services/mcp-endpoint.test.ts` | 修改 | 用例 S1–S3 |
| `servers/agent-api/src/routes/mcp.ts` | 修改 | serverName 为平台服务 `agent-workflow-tools` 时分发到本地 handler（不经 Redis 转发） |
| `servers/agent-api/src/services/workflow/tool-handlers.ts` | 新增 | 10 个工具：getCurrentNodeId / getParentNodeIds / getNodeInfo / getNodeArtifactKeys / getBlackboardKeys / getBlackboardValue / removeBlackboardKey / completeCurrentNode / rejectCurrentNode / completeCurrentRework；参数校验 + 状态转移校验 + 可读错误 |
| `servers/agent-api/src/services/workflow/tool-handlers.test.ts` | 新增 | 工具参数/作用域/状态校验用例 |

### 验收 checklist

- [x] 节点会话 token 可正确映射 instanceId/nodeId；普通会话调用返回未授权
- [x] 非法状态转移的操作类工具返回结构化错误提示

---

## Phase 6: GraphQL schemas/resolvers + 默认模板种子

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/workflow.ts` | 新增 | 对齐 `contracts/workflow.graphql` |
| `servers/agent-api/src/graphql/resolvers/workflow.ts` | 新增 | 全部 Query/Mutation resolver（userId 作用域） |
| `servers/agent-api/src/graphql/schemas/index.ts` / `resolvers/index.ts` | 修改 | 注册 workflow |
| `servers/agent-api/src/graphql/schemas/session.ts` / `resolvers/session.ts` | 修改 | Session 新字段 + `includeWorkflowSessions` |
| `servers/agent-api/src/services/workflow/seed.ts` | 新增 | 启动时幂等 upsert 内置「开发工作流」模板（10 节点，正式提示词文案） |
| `servers/agent-api/src/graphql/resolvers/workflow.test.ts` | 新增 | resolver 权限与基础用例 |

### 验收 checklist

- [x] `npm run build && npm run test` 通过
- [x] 服务启动后内置模板可见且不可编辑

---

## Phase 7: agent-web SessionView 抽取 + 设置工作流 section

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/SessionView.tsx` | 新增 | 从 `SessionPage.tsx` 抽取可复用会话主体（Header/MessageList/InputBox/useSessionStream） |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | 改为复用 `SessionView`，路由行为不变 |
| `apps/agent-web/src/components/settings/WorkflowSection.tsx` | 新增 | 模板列表 + 已配置工作流列表 + 两个按钮 |
| `apps/agent-web/src/components/workflow/TemplateEditorDialog.tsx` | 新增 | 节点表单编辑（类型/名称/描述/阶段/提示词数组/产物 title/依赖多选）+ 前端基础校验 + 只读流程图预览 |
| `apps/agent-web/src/components/workflow/ConfigureWorkflowDialog.tsx` | 新增 | 选模板 → 选 Controller → 逐 AI 节点 Agent 配置；复制来源文案 |
| `apps/agent-web/src/pages/SettingsPage.tsx` | 修改 | NAV_ITEMS 注册工作流 section |
| `apps/agent-web/src/graphql/workflow.ts` | 新增 | workflow 相关 query/mutation 文档 |
| `apps/agent-web/src/components/__tests__/` | 新增 | WorkflowSection / TemplateEditorDialog 组件测试 |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [x] SessionPage 行为回归无变化
- [x] 模板编辑器可创建/编辑/删除模板，非法图有前端提示
- [x] 配置工作流表单展示「复制自模板 vX」文案

---

## Phase 8: agent-web 侧边栏层级 + 实例视图 + 会话侧面板

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 工作区下新增「工作流」分组（实例列表 + 「+」）；工作流会话不出现在会话列表 |
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 新增 | 选择已配置工作流并实例化；非 git 工作区禁用并提示 |
| `apps/agent-web/src/pages/WorkflowInstancePage.tsx` | 新增 | 阶段分组节点树（状态/返工次数）+ 黑板与垃圾桶面板 + 会话入口 |
| `apps/agent-web/src/components/workflow/WorkflowNodeTree.tsx` | 新增 | 节点树组件 |
| `apps/agent-web/src/components/workflow/BlackboardPanel.tsx` | 新增 | 黑板/垃圾桶 key-value 展示 |
| `apps/agent-web/src/components/workflow/SessionSidePanel.tsx` | 新增 | Sheet/Dialog 侧面板内嵌 `SessionView` |
| `apps/agent-web/src/App.tsx`（路由） | 修改 | 新增 `/workflows/:id` 路由 |
| 人类节点操作 | 新增 | 完成（文本输入）/打回（弹框输入理由）交互，接入 `completeHumanNode`/`rejectNode` |

### 验收 checklist

- [x] 侧边栏出现工作流层级，工作流会话不可见于会话列表
- [x] 实例视图可完成人类节点、打回（弹框输入理由）、打开会话侧面板

---

## Phase 9: API 测试（tests/api）

覆盖提案 §8.3 全部用例 A1–A18，重点：

| 分组 | 用例 |
|------|------|
| 模板 | A1 创建、A2 非法图 422、A3 内置只读、A4 version 自增 |
| 配置 | A5 复制快照与隔离、A6 缺 agentConfig、A7 capabilities 校验、A8 禁止改图、A9 活跃实例删除约束 |
| 实例 | A10 实例化首节点 READY、A11 非 git 工作区拒绝、A12 人类节点完成接力、A13 打回留痕、A18 权限隔离 |
| 会话 | A14 默认排除工作流会话 |
| MCP 工具 | A15 节点作用域、A16 非法状态提示、A17 移除入垃圾桶 |

### 验收 checklist

- [x] A1–A18 全部通过

---

## Phase 10: E2E 测试（tests/e2e）

| # | 场景 | 验证点 |
|---|------|--------|
| E2E-1 | 配置默认模板 → 实例化 → 人类节点输入 → AI 节点拉起 | 实例状态推进、会话打标、侧边栏不可见 |
| E2E-2 | AI 节点完成接力 | 下游会话收到含上游产物的提示词，上游会话结束 |
| E2E-3 | 打回 → 返工 → 复工 | 原会话 resume 收到打回原因，返工完成后下游继续 |
| E2E-4 | 会话兜底 | 未转移状态时收到兜底提示词 |
| E2E-5 | 实例视图 | 阶段分组节点树、黑板可见、侧面板可打开 |
| E2E-6 | 设置页管理 | 创建模板、复制配置、文案可见 |

### 验收 checklist

- [x] E2E-1 ~ E2E-6 全部通过

---

## 测试用例总表（单元测试明细）

> 与提案 §8.2 一致，此处为执行清单。

- **模板校验 T1–T9**：线性链通过；nodeKey 重复拒绝；dependsOn 缺失引用拒绝；环检测拒绝并报环；双首节点拒绝；AI 首节点拒绝；AI 节点空 prompts 拒绝；HUMAN 节点带 prompts 拒绝；钻石依赖通过。
- **引擎 E1–E12**：合法转移全通过（含 startedAt/reworkedAt/reworkCount 维护）；非法转移拒绝；首节点打回拒绝；多上游汇合；FLAG 透传；并行分支 currentNodeNames。
- **黑板 B1–B4**：读写一致；remove 入垃圾桶；产物前缀匹配；打回记录序号递增。
- **编排 O1–O8**：提示词组装（含/不含上游产物）；会话打标；阶段 worktree 后缀复用；非 git 拒绝；兜底发送/不发送；完成后先接力再结束。
- **Token S1–S3**：节点 payload 含 workflow 字段；普通会话兼容；会话结束 401。

## 总体验收

- [x] 所有 Phase checklist 完成
- [x] `servers/agent-api` / `apps/agent-web` build + lint + test 全绿
- [x] API 测试 A1–A18、E2E 测试 E2E-1~6 通过
- [ ] 使用默认「开发工作流」完成一次真实需求演示
