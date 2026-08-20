---
description: 工作流优化 0821 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# 工作流优化 0821 - 实现计划

**关联 Proposal**: `proposals/20260821-feat-workflow-optimization.md`（v1.0）
**关联 PRD**: `docs/product/draft/20260821-workflow-optimization.md`
**feat-branch**: `feat/workflow-optimization`
**创建日期**: 2026-08-21

## 实现顺序

```
Phase 1: 契约更新（contracts/workflow.graphql）
  ├── Phase 2: agent-api（模型 + 工作流服务 + resolvers）
  └── Phase 3: agent-web（实例化选项 + 拖拽排序 + Graph View + 节点信息 + 重启编辑面板）
       └── Phase 4: API 测试（tests/api）
            └── Phase 5: E2E 测试（tests/e2e）
```

依赖说明：Phase 1 契约先行，是后续所有阶段的输入；Phase 2（后端）与 Phase 3（前端）契约对齐后可并行开发——按 `z-coding` 的子项目并行实现模式，各委托一个 subagent，分别基于 `feat/workflow-optimization` 创建开发分支 `servers/workflow-optimization`、`apps/workflow-optimization`，完成后各自提 PR 回 `feat/workflow-optimization` 待 review；测试阶段在全部实现合并后推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现，编码前加载 `docs/engineering/common-rules.md` 及对应端规范（`backend-rules.md` / `frontend-rules.md`）。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/workflow.graphql` | 修改 | 变更 1：`InstantiateWorkflowInput` 新增 `createWorkflowWorktree: Boolean`（默认 false），`WorkflowInstance` 新增 `workflowWorktreePath: String`、`workflowWorktreeBranch: String`；变更 2：`WorkflowTemplateNode` / `ConfiguredWorkflowNode` / `WorkflowNode` 及对应 Input 新增 `sortOrder: Int`（仅影响展示顺序）；变更 3：`restartNode(instanceId: ID!, nodeId: ID!, agentConfig: AgentNodeConfigInput): WorkflowNode!` 增加可选 `agentConfig` |

### 验证

- [ ] 契约与提案 §3.1 三处变更一致，评审通过

---

## Phase 2: agent-api

开发分支：`servers/workflow-optimization`（基于 `feat/workflow-optimization`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/workflow-instance.ts` | 修改 | 新增 `workflowWorktreePath` / `workflowWorktreeBranch`（可选 String）、`nodes[].sortOrder`（可选 Number） |
| `servers/agent-api/src/models/workflow-template.ts` | 修改 | `nodes[].sortOrder`（可选 Number，缺省按数组下标，存量无迁移） |
| `servers/agent-api/src/models/configured-workflow.ts` | 修改 | 同上 |
| `servers/agent-api/src/services/workflow/instance.ts` | 修改 | ① 实例化：图校验通过后、快照落库前，若 `createWorkflowWorktree` 且工作区支持 Git，经 Redis `git:worktree:add` 创建实例级 Worktree（复用 `services/session.ts` 的请求/响应通道），path/branch 存入实例；失败整体失败不落库，已建 Worktree 回滚 `git:worktree:remove`；② 误报修复：`getAvailableServerTypes()` 缓存缺失时回源——查 DB `controller.status`，online 则经 controller 通道主动拉取能力并回热缓存（短超时）后继续校验，offline/超时才真正报离线；③ `restartNode` 接受可选 `agentConfig`：`engine.transition('restart')` 前更新节点快照并校验新 `acpServerType` 在该 controller 可用能力内；④ 实例删除追加清理 `workflowWorktreePath`（复用 `session.ts` worktree 清理与白名单机制） |
| `servers/agent-api/src/services/workflow/configured.ts` | 修改 | 在线校验接入同一回源逻辑；回源函数抽取为共享函数供 `instance.ts` 复用 |
| `servers/agent-api/src/services/workflow/orchestrator.ts` | 修改 | `startNodeSession()` 工作目录优先级：节点 `initNewWorktree && requiresWorktree` → 维持现状建节点级 Worktree；否则实例存在 `workflowWorktreePath` → 以 `existingWorktreePath` 下发；否则工作区根目录。补充防御：节点启动前断言全部上游节点已 Done |
| `servers/agent-api/src/graphql/resolvers/workflow.ts` | 修改 | 新字段映射（`workflowWorktreePath/Branch`、`sortOrder`）、`instantiateWorkflow` 入参透传、`restartNode` 可选 `agentConfig`；保存节点图时校验仍为 DAG（复用现有图校验） |
| 相关 `*.test.ts` | 新增/修改 | 实例化建/回滚 Worktree；缓存缺失+controller 在线/离线两路回源；重启携带 agentConfig（合法/能力外 Harness 拒绝）；删除实例清理工作流 Worktree；`sortOrder` 存取与缺省回填；上游未 Done 断言 |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] 单测通过；实例化失败路径不产生半成品实例、已建 Worktree 被回滚
- [ ] 误报回归：缓存缺失 + controller 在线时实例化成功，离线时准确报离线
- [ ] 未启用节点级 Worktree 的节点会话 cwd 为实例 `workflowWorktreePath`
- [ ] 重启传能力外 Harness 被拒绝且不触发任何会话操作

---

## Phase 3: agent-web

开发分支：`apps/workflow-optimization`（基于 `feat/workflow-optimization`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/package.json` | 修改 | 新增依赖 `@xyflow/react`、`@dagrejs/dagre`（Graph View；拖拽排序复用既有 `@dnd-kit/*`，不新增 DnD 依赖） |
| `apps/agent-web/src/graphql/` | 修改 | `instantiateWorkflow` 入参加 `createWorkflowWorktree`；实例/节点查询补 `workflowWorktreePath`、`sortOrder`；`restartNode` 支持可选 `agentConfig` |
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 修改 | 新增「为工作流创建 Worktree」选项：Git 工作区可见且默认勾选，非 Git 工作区禁用并说明原因 |
| `apps/agent-web/src/components/workflow/WorkflowGraphEditor.tsx` | 修改 | 节点列表支持拖拽调整展示顺序（`@dnd-kit`），拖拽结果写回 `sortOrder` 随保存提交；模板/已配置工作流/实例化前节点图三处编辑入口统一生效 |
| `apps/agent-web/src/components/workflow/WorkflowGraphView.tsx` | 新增 | Graph View：`@xyflow/react` 渲染 + `@dagrejs/dagre` 分层布局（方向 LR，与执行顺序一致）；节点复用状态徽章样式，展示依赖连线与节点状态；数据来自实例详情现有 5s 轮询，与 List View 天然一致 |
| `apps/agent-web/src/components/workflow/WorkflowNodeTree.tsx` | 修改 | ① AI 节点卡片增加 Harness（`agentConfig.acpServerType`）与模型（`agentConfig.modelId`）展示，人类/旗帜节点不渲染；② 「重启」按钮由确认弹窗改为节点编辑面板（复用节点编辑表单的 agentConfig 编辑块，Harness 联动 Mode/模型），保存调 `restartNode(agentConfig)`，直接关闭不保存则节点无变化 |
| `apps/agent-web/src/pages/WorkflowInstancePage.tsx` | 修改 | 新增 List/Graph 视图切换（默认 List，localStorage 记忆），Graph 视图挂载 `WorkflowGraphView` |
| `apps/agent-web/src/components/__tests__/` | 新增/修改 | 实例化选项在 Git/非 Git 工作区的渲染与默认值；拖拽写回 `sortOrder`；Graph View 布局方向与状态渲染；节点卡片 Harness/模型展示（含重启后更新）；重启面板取消无副作用、保存携带新配置 |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 新增依赖构建通过；50 节点 Graph View 渲染流畅、可缩放/平移
- [ ] 展示顺序拖拽保存后再次打开保持；UI 不暗示展示顺序即执行顺序
- [ ] List View 现状交互不变；两视图节点状态实时一致

---

## Phase 4: API 测试（tests/api）

真实 Mongo/Redis + fake controller（含延迟变体），参照提案 §8.1 覆盖清单。

| # | 接口 | 用例 | 预期 |
|---|------|------|------|
| A1 | instantiateWorkflow | `createWorkflowWorktree=true` + Git 工作区 | 实例落库含 `workflowWorktreePath/Branch` |
| A2 | instantiateWorkflow | 选项关闭 / 非 Git 工作区 | 行为与现状一致，无 Worktree 字段 |
| A3 | instantiateWorkflow | Worktree 创建失败 | 整体失败、无半成品实例、已建 Worktree 回滚 |
| A4 | instantiateWorkflow | 能力缓存缺失 + controller 在线 | 回源校验通过，实例化成功（误报回归） |
| A5 | instantiateWorkflow | 能力缓存缺失 + controller 离线 | 准确报离线，实例化被阻止 |
| A6 | 节点会话启动 | 实例含 workflowWorktreePath | 未启用节点级 Worktree 的节点会话 cwd 为实例 Worktree；启用节点级 Worktree 的节点行为不变 |
| A7 | restartNode | 携带合法 agentConfig | 节点快照更新后以新配置重启，产物/打回记录保留规则不变 |
| A8 | restartNode | 携带能力外 Harness | 校验失败返回错误，不触发会话操作 |
| A9 | 实例/模板保存 | `sortOrder` 存取 | 保存后读取保持；缺省按数组下标回填；非 DAG 保存被拒绝 |
| A10 | deleteWorkflowInstance | 含工作流 Worktree 实例 | 工作流 Worktree 与节点级 Worktree 一并清理 |

### 验收 checklist

- [ ] A1–A10 全部通过

---

## Phase 5: E2E 测试（tests/e2e）

| # | 场景 | 验证点 |
|---|------|--------|
| E2E-1 | 实例化选项 | Git 工作区默认勾选「为工作流创建 Worktree」；非 Git 工作区禁用并提示 |
| E2E-2 | 拖拽排序 | 编辑节点图拖拽调整顺序，保存后重开保持；实例执行顺序仍与依赖关系一致 |
| E2E-3 | 多视图切换 | 详情页 List/Graph 切换，Graph 正确呈现依赖连线与节点状态，两视图状态一致 |
| E2E-4 | 节点信息展示 | AI 节点可见 Harness 与模型；人类/旗帜节点不展示 |
| E2E-5 | 可配置重启 | 重启弹编辑面板，更换 Harness 保存后节点以新配置重跑且展示信息同步更新；不保存关闭无任何变化 |

### 验收 checklist

- [ ] E2E-1 ~ E2E-5 全部通过（需在 Aspire 编排环境运行，与 API 套件串行执行）

---

## 总体验收

- [ ] 所有 Phase checklist 完成
- [ ] `servers/agent-api` / `apps/agent-web` build + lint + test 全绿
- [ ] API 测试 A1–A10、E2E 测试 E2E-1~5 通过
- [ ] 提案 §10 验收标准逐项达成（契约评审、实现、单测覆盖、API/E2E）
- [ ] PRD §1.3 成功标准逐项达成
- [ ] `servers/workflow-optimization`、`apps/workflow-optimization` 两个 PR review 通过并合并回 `feat/workflow-optimization`
