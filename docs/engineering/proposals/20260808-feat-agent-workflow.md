---
description: Agent 工作流技术方案 —— 工作流模型、节点状态机引擎、节点作用域 MCP 工具、实例视图与默认开发工作流模板
type: Permanent
---

# Agent 工作流 — 技术提案

**功能名称**: Agent 工作流
**关联 PRD**: `docs/product/draft/20260808-agent-workflow.md`
**技术提案版本**: v1.0
**创建日期**: 2026-08-08
**作者**: Kimi
**feat-branch**: `feat/agent-workflow`

## 1. 概述

### 1.1 背景

PRD 提出「Agent 工作流」：横跨多个会话、围绕 GitHub PR 与分支工作的统一工作流体系。现状盘点（代码走查结论）：

- **会话模型**（`servers/agent-api/src/models/session.ts`）已具备 `worktreePath`/`worktreeBranch`/`externalSessionId`/`status`，创建会话支持 `enableWorktree + worktreeBranchSuffix`（`SessionService.create` 通过 Redis `session:command` 频道发布 `git:worktree:add`），`resume()` 支持继续已结束会话。Session 与 Workspace 是**创建期瞬态关联**（仅取 `workspace.path` 作为 `cwd`），Session 上未持久化 `workspaceId`。
- **MCP 分发**：已有会话级 MCP Endpoint（`McpSessionEndpoint` + JWT，路由 `servers/agent-api/src/routes/mcp.ts`，`POST /:sessionId[/:serverName]`，经 Redis `mcp:forward:*` 转发给 controller-api 的 MCP Proxy）。`McpServer.transport` 已预留 `platform` 类型（契约中标记 P2，未实现），可作为平台内置 MCP 工具的挂载点。当前仅支持**服务级**装配，无**工具级 / 作用域级**分发。
- **前端**：侧边栏（`apps/agent-web/src/components/Sidebar.tsx`）为 Controller → Workspace（按 path 派生）→ Session 三级；设置页（`SettingsPage.tsx`）按 section 注册；会话页 `SessionPage.tsx` 状态与页面耦合，无可嵌入的侧面板形态（仅有 `TodoListPanel` 的 popover 先例）。

### 1.2 目标

1. 落地工作流领域模型：工作流模板、已配置工作流、工作流实例、实例节点、工作流黑板（含垃圾桶）。
2. 实现节点状态机引擎：初始化 / 开始 / 完成 / 打回 / 返工 / 返工完成 / 复工 / 旗帜透传，驱动会话的创建、继续与结束。
3. 实现**节点作用域 MCP Registry**（Scoped MCP Registry）：把「工作流工具集」作为平台 MCP 服务注入节点会话，token 可映射到具体实例节点。
4. 前端落地：侧边栏工作流层级、设置工作流 section、工作流实例视图（阶段分组节点树 + 黑板 + 会话侧面板）。
5. 内置默认「开发工作流」模板。

### 1.3 范围

**做**：

- agent-api：工作流模型与 GraphQL 契约、节点状态机引擎（WorkflowEngine）、节点作用域 MCP 工具端点、会话结束兜底提示词。
- agent-web：侧边栏「工作流」层级（隐藏工作流会话）、设置「工作流」section、工作流实例视图与会话侧面板。
- contracts：新增 `workflow.graphql`，更新 `agent-session.graphql` / `mcp-server.graphql`。
- 默认「开发工作流」模板种子数据。

**不做**：

- 工作流模板的多用户分享 / 导入导出。
- 非人类首节点的工作流（本期约束：首节点必须是人类节点）。
- controller-api 与 agent-controller（CLI）的协议变更（沿用现有 `acp:start/resume/stop`、`git:worktree:*`、`session:*` 通道）。
- MCP Proxy 链路的改造（平台 MCP 工具不经过 Proxy，由 agent-api 直接处理）。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    A[agent-web] -->|GraphQL / SSE| B[agent-api]
    B -->|GraphQL Resolver| WF[WorkflowEngine<br/>节点状态机]
    WF --> SVC[SessionService<br/>创建/继续/结束会话]
    WF --> BB[(MongoDB<br/>workflow_*)]
    SVC -->|Redis session:command| C[controller-api]
    C -->|Socket.IO| D[agent-controller]
    D -->|ACP session/new/resume| E[Agent 进程]
    E -->|MCP over HTTP<br/>Bearer scoped-token| MCP[agent-api /mcp 路由<br/>工作流工具 handler]
    MCP --> WF
```

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind v4 + urql | 复用现有技术栈 |
| 后端 | Node.js + Express + GraphQL Yoga + Mongoose | 工作流引擎落于 agent-api |
| 数据库 | MongoDB | 新增 workflow 相关集合 |
| 缓存/消息 | Redis Pub/Sub | 沿用 `session:command` 等既有频道，不新增控制器侧协议 |
| 其他 | MCP over HTTP（Streamable HTTP） | 节点作用域工具挂载于既有 `/mcp` 路由 |

### 2.3 模块划分

```mermaid
graph LR
    subgraph agent-api
        R[GraphQL Resolvers] --> E[WorkflowEngine<br/>状态机/事件调度]
        E --> N[NodeSessionOrchestrator<br/>节点会话编排]
        E --> B[BlackboardService<br/>黑板/垃圾桶]
        T[WorkflowToolHandlers<br/>MCP 工具实现] --> E
        T --> B
    end
    subgraph agent-web
        SB[Sidebar 工作流层级] --> WP[WorkflowInstancePage]
        ST[Settings 工作流 section] --> WP
        WP --> SP[SessionSidePanel<br/>复用会话组件]
    end
```

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| WorkflowEngine | 节点状态转移校验、事件（start/complete/reject/rework/resume）调度 | 纯函数状态机 + Mongo 事务更新 |
| NodeSessionOrchestrator | AI 节点会话的拉起、继续、结束；提示词组装（系统提示 + 节点提示词数组 + 上游产物） | 复用 `SessionService.create/resume`，会话打标 `workflowInstanceId/workflowNodeId` |
| BlackboardService | 黑板 key-value 读写、产物 key 前缀匹配、移除入垃圾桶、打回记录 | Mongo `Map` 字段 |
| WorkflowToolHandlers | 10 个 MCP 工具的参数校验、状态转移校验、错误提示 | 挂载 `transport: platform` 的 McpServer |
| Scoped MCP Registry | 节点作用域 token 签发与映射 | 扩展 `McpSessionEndpoint` token payload |

## 3. API 设计

### 3.1 API 契约

新增 `contracts/workflow.graphql`（要点摘录）：

```graphql
enum WorkflowNodeType { HUMAN, AI, FLAG }
enum WorkflowNodeStatus { INITIALIZING, READY, RUNNING, DONE, REJECT, REWORK }

type WorkflowTemplate {
  id: ID!, name: String!, description: String
  nodes: [WorkflowTemplateNode!]!, isBuiltin: Boolean!
  createdAt: String!, updatedAt: String!
}
type WorkflowTemplateNode {
  nodeKey: String!, type: WorkflowNodeType!, name: String!, description: String
  stage: String!, prompts: [String!]          # AI 节点提示词数组
  artifactTitles: [String!]                   # 预定义产物 title
  dependsOn: [String!]!                       # 上游 nodeKey
  requiresWorktree: Boolean!
}
type ConfiguredWorkflow {
  id: ID!, name: String!, controllerId: ID!
  sourceTemplateId: ID, sourceTemplateVersion: String   # 复制来源, 无强关联
  nodes: [ConfiguredWorkflowNode!]!
}
type ConfiguredWorkflowNode {
  nodeKey: String!, agentConfig: AgentNodeConfig        # AI 节点必填
}
type AgentNodeConfig {
  acpServerType: String!, modeId: String, modelId: String
  initNewWorktree: Boolean!
}
type WorkflowInstance {
  id: ID!, configuredWorkflowId: ID!, controllerId: ID!, workspaceId: ID!
  name: String!, currentNodeNames: [String!]!   # 对外状态 = 执行中节点
  nodes: [WorkflowNode!]!, blackboard: [BlackboardEntry!]!
  blackboardTrash: [BlackboardEntry!]!
  createdAt: String!
}
type WorkflowNode {
  id: ID!, nodeKey: String!, type: WorkflowNodeType!, name: String!
  description: String, status: WorkflowNodeStatus!
  stage: String!, sessionId: ID
  createdAt: String!, startedAt: String, reworkedAt: String, reworkCount: Int!
}
type BlackboardEntry { key: String!, value: String!, updatedAt: String! }

type Query {
  workflowTemplates: [WorkflowTemplate!]!
  configuredWorkflows(controllerId: ID): [ConfiguredWorkflow!]!
  workflowInstances(workspaceId: ID!): [WorkflowInstance!]!
  workflowInstance(id: ID!): WorkflowInstance
}
type Mutation {
  createWorkflowTemplate(input: WorkflowTemplateInput!): WorkflowTemplate!
  updateWorkflowTemplate(id: ID!, input: WorkflowTemplateInput!): WorkflowTemplate!
  deleteWorkflowTemplate(id: ID!): Boolean!
  configureWorkflow(templateId: ID!, input: ConfigureWorkflowInput!): ConfiguredWorkflow!  # 从模板复制
  updateConfiguredWorkflow(id: ID!, input: ConfigureWorkflowInput!): ConfiguredWorkflow!
  deleteConfiguredWorkflow(id: ID!): Boolean!
  instantiateWorkflow(configuredWorkflowId: ID!, workspaceId: ID!, name: String!): WorkflowInstance!
  completeHumanNode(instanceId: ID!, nodeId: ID!, input: String): WorkflowNode!
  rejectNode(instanceId: ID!, nodeId: ID!, reason: String!): WorkflowNode!   # 人类打回
}
```

对既有契约的增量：

- `contracts/agent-session.graphql`：`Session` 增加 `workflowInstanceId: ID`、`workflowNodeId: ID`；`sessions` 查询默认**排除**工作流会话（新增参数 `includeWorkflowSessions: Boolean` 供实例视图使用）。`CreateSessionInput` 不暴露工作流字段（由引擎内部调用服务层）。
- `contracts/mcp-server.graphql`：`transport: platform` 从 P2 转为正式支持，`source: platform` 的平台服务「agent-workflow-tools」随系统自动注册（仅在工作流节点会话装配时生效）。

### 3.2 内部接口

- `WorkflowEngine.transition(instanceId, nodeId, event, payload)`：唯一状态转移入口，所有路径（GraphQL mutation / MCP 工具 / 兜底逻辑）统一走此入口做校验。
- `NodeSessionOrchestrator.startNodeSession(instance, node)` / `reworkNodeSession(...)` / `endNodeSession(...)`：封装会话创建/继续/结束与提示词组装。
- `BlackboardService.get/set/remove(instanceId, key, value)`：`remove` 将 entry 挪入 `blackboardTrash` 并记录时间。

## 4. 数据模型

### 4.1 数据库设计

#### 集合： workflow_templates

| 字段 | 类型 | 说明 |
|------|------|------|
| userId | ObjectId | 归属用户（内置模板为系统用户/空 + `isBuiltin`） |
| name / description | String | 模板名称/描述 |
| nodes[] | SubDoc | nodeKey, type, name, description, stage, prompts[], artifactTitles[], dependsOn[], requiresWorktree |
| isBuiltin | Boolean | 是否为内置默认模板 |

#### 集合： configured_workflows

| 字段 | 类型 | 说明 |
|------|------|------|
| userId / controllerId | ObjectId | 归属用户 / 关联 Controller |
| name | String | 名称 |
| sourceTemplateId / sourceTemplateVersion | ObjectId / String | 复制来源（仅展示用，**无强关联**） |
| nodes[] | SubDoc | 模板节点的**快照副本** + agentConfig（acpServerType/modeId/modelId/initNewWorktree） |

#### 集合： workflow_instances

| 字段 | 类型 | 说明 |
|------|------|------|
| userId / controllerId / workspaceId / configuredWorkflowId | ObjectId | 归属四元组 |
| name | String | 实例名称 |
| nodes[] | SubDoc | 实例节点：nodeId, nodeKey, type, name, description, stage, status, sessionId, createdAt, startedAt, reworkedAt, reworkCount, rejectInfo{reason, fromNodeId, at} |
| blackboard | Map<String,String> | 工作流黑板（产物 key：`{nodeId}-{nodeName}-产物-{title}`；打回记录 key：`打回-{nodeId}-{序号}`） |
| blackboardTrash | Map<String,String> | 黑板垃圾桶 |

#### 集合： sessions（增量字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| workflowInstanceId | ObjectId? | 归属工作流实例（可空） |
| workflowNodeId | String? | 归属实例节点（可空） |

### 4.2 缓存设计

- 沿用 Redis 既有缓存模式；工作流实例当前状态读多写少，引擎每次转移后失效 `workflow:instance:<id>` 缓存（TTL 60s 兜底）。
- 节点作用域 MCP token 沿用 `McpSessionEndpoint` 的 Redis 状态缓存（`mcp:endpoint:<sessionId>`）。

## 5. 技术实现方案

### 5.1 核心流程

**实例化与首节点**：

```mermaid
sequenceDiagram
    participant U as 用户
    participant G as GraphQL
    participant E as WorkflowEngine
    participant D as MongoDB
    U->>G: instantiateWorkflow(configuredWorkflowId, workspaceId)
    G->>E: instantiate()
    E->>D: 校验 workspace 支持 git(若需 worktree)<br/>创建实例, 全部节点 INITIALIZING
    E->>D: 首节点(人类) → READY
    G-->>U: WorkflowInstance
    U->>G: completeHumanNode(输入初版需求)
    G->>E: transition(complete)
    E->>D: 写入产物 key, 节点 DONE, 触发下游 start 事件
```

**AI 节点执行（开始 → 完成 → 下游接力）**：

```mermaid
sequenceDiagram
    participant E as WorkflowEngine
    participant O as NodeSessionOrchestrator
    participant S as SessionService
    participant A as Agent(会话)
    participant M as /mcp 工作流工具
    E->>O: startNodeSession(node READY→RUNNING)
    O->>S: create(worktree 按阶段配置, mcp 注入工作流工具)
    O->>O: 组装提示词: 工作流系统提示<br/>+ 节点提示词数组 + 上游产物
    O->>S: sendSessionMessage(提示词)
    A->>M: getCurrentNodeId / getBlackboardValue ...
    M-->>A: 节点作用域数据
    A->>M: completeCurrentNode()
    M->>E: transition(complete) 校验 RUNNING→DONE
    E->>O: 下游节点 start 事件(新建会话) + 结束本节点会话
    O->>S: closeSession(本节点)
```

**打回与返工**：

```mermaid
sequenceDiagram
    participant D as 下游节点会话/人类
    participant E as WorkflowEngine
    participant U as 上游节点
    D->>E: rejectNode(reason) 校验 RUNNING→REJECT
    E->>E: 黑板写入打回记录
    E->>U: transition(rework) → REWORK<br/>resume 原会话并发送打回原因
    U->>E: completeRework() 校验 REWORK→DONE<br/>重置产物
    E->>D: transition(resume) REJECT→RUNNING<br/>提示其用 MCP 重新获取产物
```

**会话兜底**：`SessionService` 状态变为 `ended` 时，引擎检查其绑定节点状态是否在会话存续期内发生过转移；若未转移且节点仍处于 RUNNING，则 `resume()` 会话并发送兜底提示词（面向 LLM 撰写，说明其身处自动化系统、必须使用提供的工作流工具对当前节点执行完成/打回等操作）。兜底重试限 1 次，防止死循环。

### 5.2 关键实现点

#### 实现点 1：节点作用域 MCP Registry（Scoped MCP Registry）

- **描述**：将「工作流工具集」实现为 `transport: platform`、`source: platform` 的平台 MCP 服务 `agent-workflow-tools`，注册逻辑内置于 `routes/mcp.ts`：当请求的 serverName 为该平台服务时，不经 Redis 转发，直接调用 `WorkflowToolHandlers`。
- **技术细节**：节点会话创建时，`McpSessionEndpoint` 的 JWT payload 扩展 `{sessionId, userId, serverNames, workflow: {instanceId, nodeId}}`；工具 handler 从 token 解析节点上下文，实现「获得当前节点 ID / 父节点 ID」的作用域映射。节点操作类工具调用 `WorkflowEngine.transition` 做状态转移校验，失败返回结构化错误（code + 人类/LLM 可读的提示）。
- **风险点**：token 泄漏即可操作节点 → token TTL 沿用会话级配置，会话结束即吊销 endpoint（既有逻辑）。

#### 实现点 2：阶段与 Worktree 的对应

- **描述**：PRD 要求「每个阶段使用一个 Worktree」。实例化时按阶段生成 `worktreeBranchSuffix = <instance-slug>/<stage-slug>`；节点 `agentConfig.initNewWorktree = true` 的会话使用所属阶段的后缀创建 worktree（同一阶段内多个节点会话**复用**同一 worktree 路径，由 `SessionService.create` 幂等处理：worktree 已存在则直接使用）。
- **风险点**：同阶段多个 AI 节点串行执行（引擎保证依赖顺序），不存在并发写同一 worktree；若模板出现同阶段并行分支，需在后置迭代处理并发隔离（本期不做）。

#### 实现点 3：前端会话侧面板

- **描述**：从 `SessionPage.tsx` 抽取会话主体（`SessionHeader + MessageList + InputBox + useSessionStream`）为可复用组件 `<SessionView sessionId />`，`SessionPage` 与 `WorkflowInstancePage` 的侧面板（基于 `ui/dialog` 的 Sheet 模式）共同复用。
- **风险点**：`SessionPage` 内状态与路由耦合（`NewSessionDialog` 等），抽取时需保持路由页行为不变。

#### 实现点 4：侧边栏隐藏工作流会话

- **描述**：`sessions` 查询默认排除 `workflowInstanceId != null` 的会话；侧边栏在工作区节点下新增「工作流」分组（实例列表 + 「+」），实例项展示当前执行节点名作为状态。
- **技术细节**：工作区分组现有逻辑按 `cwd` 派生；工作流实例直接挂 `workspaceId`，不再依赖路径推导。

#### 实现点 5：默认模板种子

- **描述**：agent-api 启动时幂等 upsert 内置模板「开发工作流」（10 节点：产品需求 → 产出产品需求技术方案 → 审核产品文档与技术方案 → 产出实现方案 → 审核实现文档 → 代码实现 → AI审核代码 → 人类审核代码与验收 → 代码合并 → 完成开发），各 AI 节点提示词数组按 PRD §3.4 完善为面向 LLM 的正式文案，产物 title 预定义，首节点为人类节点，`requiresWorktree: true`。

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| 工作流引擎落点 | agent-api | controller-api | agent-api | 数据模型、SessionService、MCP 路由均在 agent-api；controller-api 仅做转发 |
| 黑板存储 | 实例文档内 Map | 独立集合 | 实例文档内 Map | 单实例黑板规模小，原子更新简单 |
| 工作流工具分发 | 复用 MCP Proxy 链路 | 平台 MCP 服务（`transport: platform`） | 平台 MCP 服务 | 工具由平台自身提供，无需转发到执行机；契约已预留该类型 |
| 节点上下文映射 | 工具参数显式传 nodeId | scoped token 隐式映射 | scoped token | 防止会话越权操作其他节点，符合 PRD 要求 |
| 模板与已配置工作流 | 引用 + 继承 | 快照复制 | 快照复制 | PRD 明确要求无强关联，文案体现「复制」 |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | Git Worktree 会话隔离（已上线） | worktree 工作流的前提 |
| 依赖 | 集成式 MCP Registry（`feat/integrated-mcp-registry`） | 会话 MCP 装配链路 |
| 约束 | 首节点必须是人类节点 | PRD 约束 |
| 约束 | controller-api / agent-controller 协议不变 | 降低改动面 |

## 7. 项目结构

```
servers/agent-api/src/
├── models/
│   ├── workflow-template.ts        # 新增
│   ├── configured-workflow.ts      # 新增
│   ├── workflow-instance.ts        # 新增
│   └── session.ts                  # 增量 workflowInstanceId/workflowNodeId
├── services/workflow/
│   ├── engine.ts                   # 状态机与事件调度
│   ├── orchestrator.ts             # 节点会话编排/提示词组装/兜底
│   ├── blackboard.ts               # 黑板/垃圾桶/打回记录
│   ├── tool-handlers.ts            # 10 个 MCP 工具实现
│   └── seed.ts                     # 默认「开发工作流」模板种子
├── graphql/workflow/               # resolvers + typeDefs
└── routes/mcp.ts                   # 平台 MCP 服务分发分支

apps/agent-web/src/
├── components/workflow/            # 节点树/黑板/实例化对话框
├── components/session/SessionView.tsx   # 从 SessionPage 抽取复用
├── components/settings/WorkflowSection.tsx
├── pages/WorkflowInstancePage.tsx
└── components/Sidebar.tsx          # 工作流层级 + 隐藏工作流会话

contracts/
├── workflow.graphql                # 新增
├── agent-session.graphql           # 增量
└── mcp-server.graphql              # transport: platform 转正
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 状态机引擎：所有合法/非法转移 100% 覆盖（单元测试）。
- API 测试覆盖：`workflow.graphql` 全部 Query/Mutation；`/mcp` 工作流工具的参数校验与作用域校验。

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | vitest | 状态机、提示词组装、黑板 key 前缀匹配、兜底逻辑 |
| API 测试 | 既有 tests/api 框架 | workflow GraphQL、scoped MCP token、会话打标与排除 |
| E2E 测试 | 既有 tests/e2e 框架 | 实例化 → 人类节点完成 → AI 节点接力 → 打回 → 返工 → 完成 全链路 |

## 9. 部署方案

### 9.1 环境规划

| 环境 | 用途 | 部署方式 |
|------|------|---------|
| 本地 | 开发调试 | aspire start（既有编排，无新增服务） |
| 测试 | API/E2E | 既有测试环境 |

### 9.2 配置管理

- 无新增环境变量；MCP token TTL 沿用 `mcpEndpointTokenTtl`。
- 新增 Mongo 集合无需迁移脚本（纯增量）。

## 10. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract 评审通过
- [ ] 代码实现完成
- [ ] 单元测试覆盖达标（状态机 100%）
- [ ] API 测试通过
- [ ] E2E 测试通过（含打回/返工链路）

## 11. 相关文档

- 关联 PRD：`docs/product/draft/20260808-agent-workflow.md`
- 关联 Contract：`contracts/workflow.graphql`（待新增）
- 参考：[[20260523-feat-git-worktree-support]]
