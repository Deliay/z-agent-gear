---
description: Agent 工作流二期 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# Agent 工作流二期：工作流管理与实例化机制完善 - 实现计划

**关联 Proposal**: `proposals/20260811-feat-agent-workflow-phase2.md`
**关联 PRD**: `docs/product/draft/20260811-agent-workflow-phase2.md`
**feat-branch**: `feat/agent-workflow-phase2`
**创建日期**: 2026-08-11

## 实现顺序

```
Phase 1: 契约更新（contracts/）
  └── Phase 2: agent-api 数据模型增量 + 已配置工作流图编辑
       └── Phase 3: 统一实例化 instantiate(input) + 实例节点编辑 updateNode
            └── Phase 4: Orchestrator 快照读取 + 旧实例回退
                 └── Phase 5: 工作流管理 MCP 工具集（admin-tools）+ platform 分发泛化
                      └── Phase 6: GraphQL schemas/resolvers 更新
                           ├── Phase 7: agent-web WorkflowGraphEditor 抽取 + 已配置工作流编辑器升级
                           │    └── Phase 8: agent-web 实例化三入口 + 实例化前配置界面 + 实例节点编辑
                           └── Phase 9: API 测试
                                └── Phase 10: E2E 测试
```

依赖说明：Phase 2 的模型字段与 Phase 1 契约对齐；Phase 3 依赖 Phase 2 的快照字段；Phase 4 依赖 Phase 3 的快照落库；Phase 5 依赖 Phase 2/3 的服务函数（薄封装）；Phase 7/8 前端依赖 Phase 6 的 GraphQL 可运行；测试阶段（9/10）在后端可运行后推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/workflow.graphql` | 修改 | 按提案 §3.1：`ResourceCreatedBy`/`InstantiateSource` 枚举；`WorkflowTemplate`/`ConfiguredWorkflow` 增 `createdBy`；`WorkflowNode` 增快照字段；`ConfiguredWorkflowNodeInput` 全量化；`InstantiateWorkflowInput`/`WorkflowNodeUpdateInput` 新增；`instantiateWorkflow` 签名变更、`updateWorkflowNode` 新增 |
| `contracts/mcp-server.graphql` | 修改 | `source: platform` 注释更新：节点作用域工具集随节点会话自动装配，工作流管理工具集可装配到任意会话 |

### 验证

- [ ] 契约与提案 §3.1 一致，评审通过

---

## Phase 2: agent-api 数据模型增量 + 已配置工作流图编辑

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/workflow-template.ts` | 修改 | 新增 `createdBy`（HUMAN 默认/AI）、`createdBySessionId` |
| `servers/agent-api/src/models/configured-workflow.ts` | 修改 | 新增 `createdBy`/`createdBySessionId`；节点子文档入参全量化（与模板节点同构 + agentConfig） |
| `servers/agent-api/src/models/workflow-instance.ts` | 修改 | 节点子文档新增快照字段 `prompts/artifactTitles/agentConfig/requiresWorktree`（可选，旧实例兼容） |
| `servers/agent-api/src/services/workflow/template.ts` | 修改 | 创建支持写入 `createdBy`；删除增加 AI 归属校验辅助（内置模板拒绝沿用一期） |
| `servers/agent-api/src/services/workflow/template.test.ts` | 修改 | 归属写入/删除校验用例 |
| `servers/agent-api/src/services/workflow/configured.ts` | 修改 | `update()` 放开图编辑：接受全量 `nodes`，复用 `validateTemplateGraph()` + agentConfig 校验（capabilities）；nodeKey 集合变更不再限制；`delete()` 移除「活跃实例引用」约束 |
| `servers/agent-api/src/services/workflow/configured.test.ts` | 修改 | 用例 C1–C4（见文末测试计划） |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] C1–C4 全部通过（改 prompts/增删节点/调依赖保存成功；非法图报与模板一致的具体错误；编辑后新实例按新内容快照）
- [ ] 删除有活跃实例的已配置工作流成功，实例不受影响

---

## Phase 3: 统一实例化 + 实例节点编辑

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/instance.ts` | 修改 | `instantiate(userId, input)` 统一入口：三来源必填校验 → controller/workspace 归属校验 → 完整图校验 + agentConfig 校验 + requiresWorktree git 校验 → 节点全量快照落库（首节点 READY，其余 INITIALIZING）；新增 `updateNode(instanceId, nodeId, input)`：原子条件更新（`status ∈ [INITIALIZING,READY]` 且 `startedAt: null`），旧实例节点先回查补齐快照再应用修改，未匹配区分「不存在」与「已开始」 |
| `servers/agent-api/src/services/workflow/instance.test.ts` | 修改 | 用例 I1–I6、N1–N5（见文末测试计划） |

### 设计要点

- 三来源（CONFIGURED/TEMPLATE/BLANK）仅决定节点图初值，服务端始终以 `input.nodes` 提交图为准校验并快照落库。
- 原子条件更新消除与引擎 `maybeActivate` 的竞态：编辑与 start 只有一方生效。

### 验收 checklist

- [ ] I1–I6、N1–N5 全部通过；`updateWorkflowNode` 状态校验覆盖全部状态枚举
- [ ] 提交图与来源图不同时以提交图为准落库

---

## Phase 4: Orchestrator 快照读取 + 旧实例回退

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/orchestrator.ts` | 修改 | 提示词组装与 `SessionService.create` 参数（acpServerType/modeId/modelId/initNewWorktree）改从实例节点快照读取；快照字段缺失时回退一期 `loadConfiguredNode()`（仅服务旧实例） |
| `servers/agent-api/src/services/workflow/orchestrator.test.ts` | 修改 | 用例 S1–S3（见文末测试计划） |

### 验收 checklist

- [ ] S1–S3 全部通过（新实例不回查配置；旧实例行为与一期一致；配置被删后旧实例回查错误可读）
- [ ] 进行中旧实例在配置被编辑后行为不回归（C4 已知边界文案）

---

## Phase 5: 工作流管理 MCP 工具集 + platform 分发泛化

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/tool-handlers.ts` | 修改 | 抽出 platform 公共层 `PLATFORM_HANDLERS: Record<serverName, PlatformHandler>`，一期 `agent-workflow-tools` 逻辑迁入 |
| `servers/agent-api/src/services/workflow/admin-tools.ts` | 新增 | 13 个工具薄封装服务层：模板 4 个、控制器列表 1 个、已配置工作流 4 个、实例化 3 个、入参 schema 查询 1 个；`ADMIN_TOOL_SCHEMAS` 单一来源（同时服务 `tools/list` 与调用前校验、`getWorkflowToolInputSchema` 查表返回）；归属校验（创建写 `createdBy=AI`+`createdBySessionId`，删除仅允许 AI 创建资源） |
| `servers/agent-api/src/services/workflow/admin-tools.test.ts` | 新增 | 用例 M1–M11（见文末测试计划） |
| `servers/agent-api/src/services/workflow/admin-server.ts`（或并入 seed/启动模块） | 新增 | 启动时按 `{name}` 幂等 upsert `agent-workflow-admin-tools` 平台服务（同 `ensureWorkflowToolsServer` 模式） |
| `servers/agent-api/src/routes/mcp.ts` | 修改 | platform 分支按 serverName 查表分发；admin 工具集仅需 `{userId, sessionId}` token（无 `workflow` payload） |

### 验收 checklist

- [ ] M1–M11 全部通过
- [ ] admin 工具集作为普通 McpServer 出现在 Registry，可经既有 `mcpServerIds` 装配到任意会话；未装配 token 被 serverNames 白名单拒绝
- [ ] 一期节点作用域工具行为无回归

---

## Phase 6: GraphQL schemas/resolvers 更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/workflow.ts` | 修改 | 对齐 Phase 1 契约增量 |
| `servers/agent-api/src/graphql/resolvers/workflow.ts` | 修改 | `updateConfiguredWorkflow` 图编辑语义；`instantiateWorkflow` 新签名；新增 `updateWorkflowNode`；`createdBy` 透出（GraphQL 路径一律 HUMAN） |
| `servers/agent-api/src/graphql/resolvers/workflow.test.ts` | 修改 | 新/变更 mutation 权限与基础用例 |

### 验收 checklist

- [ ] `npm run build && npm run test` 通过
- [ ] 契约与实现一致，无遗漏字段

---

## Phase 7: agent-web WorkflowGraphEditor 抽取 + 已配置工作流编辑器升级

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/workflow/WorkflowGraphEditor.tsx` | 新增 | 从 `TemplateEditorDialog` 抽取节点图表单组件（增删节点、依赖多选、提示词数组、产物 title、阶段、Agent 配置），供设置页与实例化配置界面复用 |
| `apps/agent-web/src/components/workflow/TemplateEditorDialog.tsx` | 修改 | 改为复用 `WorkflowGraphEditor`，行为不变 |
| `apps/agent-web/src/components/workflow/ConfigureWorkflowDialog.tsx` | 修改 | 升级为完整图编辑（与模板编辑器同形态）；顶部保留「复制自模板《x》v{n}」文案；保存调全量 `updateConfiguredWorkflow` |
| `apps/agent-web/src/graphql/workflow.ts` | 修改 | 契约增量对应 query/mutation 文档更新 |
| `apps/agent-web/src/components/__tests__/` | 修改 | 编辑器组件测试 |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 模板编辑器行为回归无变化
- [ ] 已配置工作流可编辑完整节点图并保存，非法图有前端提示与服务端错误回显
- [ ] 编辑配置不影响来源模板与已存在实例

---

## Phase 8: agent-web 实例化三入口 + 配置界面 + 实例节点编辑

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 修改 | 重构两步：① 选择来源（已配置工作流/模板/空白）与目标；② 实例化前配置界面（复用 `WorkflowGraphEditor`），确认后提交 `instantiateWorkflow(input)`；空白来源初始为人类首节点占位 |
| `apps/agent-web/src/components/workflow/EditInstanceNodeDialog.tsx` | 新增 | 实例节点设置编辑弹窗（复用 `WorkflowGraphEditor` 节点表单），保存调 `updateWorkflowNode` |
| `apps/agent-web/src/components/workflow/WorkflowNodeTree.tsx` | 修改 | `INITIALIZING/READY` 节点显示「编辑」入口；服务端拒绝时 toast「节点已开始，不可修改」；节点提示词展示注明「实例节点为实例化时的副本」 |
| `apps/agent-web/src/components/__tests__/` | 修改 | 对话框与节点树组件测试 |

### 验收 checklist

- [ ] 工作区「+」下三种实例化方式均弹出配置界面，确认后才创建实例
- [ ] 从模板实例化不落地已配置工作流；从空白可从零搭建节点图
- [ ] 未开始节点编辑保存生效；已开始节点编辑被拒并提示

---

## Phase 9: API 测试（tests/api）

覆盖提案 §8.3 全部用例：

| # | 接口 | 用例 | 预期 |
|---|------|------|------|
| A1 | updateConfiguredWorkflow | 全量图编辑 | 保存成功，来源模板不变 |
| A2 | instantiateWorkflow | 三来源 | 均创建成功，节点快照完整 |
| A3 | updateWorkflowNode | 未开始/已开始 | 分别成功/拒绝 |
| A4 | /mcp admin-tools 全工具 | 装配 admin 服务 token | 功能与归属校验符合 M 系列 |
| A5 | /mcp admin-tools | 未装配该服务的 token | serverNames 白名单拒绝 |
| A6 | deleteConfiguredWorkflow | 存在活跃实例 | 删除成功，实例不受影响 |

### 验收 checklist

- [ ] A1–A6 全部通过

---

## Phase 10: E2E 测试（tests/e2e）

| # | 场景 | 验证点 |
|---|------|--------|
| E2E-1 | 设置页编辑已配置工作流图 | 保存成功、校验错误回显 |
| E2E-2 | 从模板实例化（配置界面补齐 Agent 配置） | 实例创建、节点快照为提交内容 |
| E2E-3 | 从空白实例化 | 配置界面从零搭建节点图后创建成功 |
| E2E-4 | 实例视图编辑未开始节点 | 保存生效；开始后再编辑被拒绝 |
| E2E-5 | AI 会话装配管理工具集完成编排 | 创建模板→配置→实例化全链路；删除人类资源被拒 |

### 验收 checklist

- [x] E2E-1 ~ E2E-5 全部通过（对应 spec 中 P2-E2E-14 ~ P2-E2E-18，需在 Aspire 编排环境运行）

---

## 测试用例总表（单元测试明细）

> 与提案 §8.2 一致，此处为执行清单。

- **已配置工作流图编辑 C1–C4**：改 prompts/增删节点/调依赖通过完整图校验；非法图报具体错误；编辑后新实例以编辑后内容快照；一期旧实例回退读配置当前内容（nodeKey 被删时报「旧实例引用的配置已变更」）。
- **统一实例化 I1–I6**：CONFIGURED 正常含全量快照；TEMPLATE/BLANK 来源必填校验；非法图（环/双首节点）拒绝；agentConfig 缺失/类型不在 capabilities 拒绝；requiresWorktree 非 git 工作区拒绝；提交图与来源图不同以提交图为准。
- **实例节点编辑 N1–N5**：INITIALIZING/READY 且 startedAt=null 更新成功；RUNNING/DONE/REJECT/REWORK/FAILED 拒绝；旧实例节点先补齐快照再修改；实例已删除拒绝；编辑与引擎 start 并发仅一方生效。
- **快照读取 S1–S3**：新实例来自快照不回查；旧实例回退行为与一期一致；配置被删后旧实例错误可读。
- **管理工具集 M1–M11**：创建写归属；AI 可删 AI 创建；人类创建/内置删除拒绝；listControllers 仅当前用户；配置校验复用；AI 删除引用中配置成功；实例化缺 controllerId 参数错误；FromContent 不落库直接建实例；token 作用域越权结构化错误；getWorkflowToolInputSchema 返回与 ADMIN_TOOL_SCHEMAS 一致；非法工具名可读错误。

## 总体验收

- [ ] 所有 Phase checklist 完成
- [ ] `servers/agent-api` / `apps/agent-web` build + lint + test 全绿
- [ ] API 测试 A1–A6、E2E 测试 E2E-1~5 通过
- [ ] PRD §1.3 成功标准逐项达成（配置可迭代 / 实例化低门槛 / 实例可微调 / AI 可编排）
