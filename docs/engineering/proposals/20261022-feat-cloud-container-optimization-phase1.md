---
description: 云容器优化一期技术提案：会话/工作流弹窗列表实时刷新、新建云电脑初始化 Github 项目工作区、新建会话默认注入 MCP 与控制器默认 MCP 设置、拉起会话前置选择模型与模式
type: Permanent
---

# 云容器优化一期 - 技术提案

**功能名称**: 云容器优化一期
**关联 PRD**: `docs/product/draft/20261022-cloud-container-optimization-phase1.md`
**技术提案版本**: v1.1
**创建日期**: 2026-10-22
**作者**: ZeroAsh Agent
**feat-branch**: `feat/cloud-container-optimization-phase1`

> v1.1 变更（评审返工）：① 「创建云电脑 + Github 项目准备」由后端 ready 回调编排改为**前端调用 API 编排**（`createCloudHost` → 轮询就绪 → `setupCloudHostGithubProject`），进度展示**复用安装工作负载 / Git 设置的进度对话框**，云电脑创建作为其中第一个阶段；② 模式/模型探测缓存由 1h 调整为 **5 分钟**，模型列表新增/启用/禁用/删除后**立即清空缓存**，并在新建会话与工作流节点配置两处增加**「刷新」按钮**（点击即清缓存并重新获取）。

## 1. 概述

### 1.1 背景

云电脑（`Controller.type === 'cloud'`，云端工作容器 harness）已具备「Git 项目设置」（`CloudHostSetupOperation`：工作负载设置 → Git 项目设置 → 会话创建）、MCP 注册中心与 MCP 端点注入、Agent 工作流（已配置工作流/模板）、以及「按类型空实例探测」得到的可用模式与模型能力。但这些能力在「拉起」链路上存在四处断点：

1. `NewSessionDialog` 的工作区列表查询 `GetControllerWorkspacesEnabled` 与 `InstantiateWorkflowDialog` 的 `GetConfiguredWorkflows` / `GetWorkflowTemplates` / `GetWorkspaces` 均为 Apollo 默认 `cache-first`，对话框打开不刷新；「Git 项目设置」成功后只 refetch `HOME_OVERVIEW`，因此新增工作区/新建工作流要整页 reload 才可见。
2. `NewCloudHostDialog` 只收 `name / harnessTypes / workloadIds`，Github 项目必须等容器 ready 后再手动执行一次「Git 项目设置」，进度分散在「云电脑创建」与「Git 设置进度」两处。
3. `SessionService.create` 只有「云会话自动并入 `agent-cloud-host-tools`」这一处自动装配，`mcpServerIds` 缺省即不注入；`CloudHostGithubService.runSessionStep` 与 `CloudHostService.handleReadyLocked` 的自动建会话均不带 MCP。系统中无「默认注入 MCP」配置。
4. `CreateSessionInput` 无 `modeId` / `modelId`，模型与模式只能会话起来后 `setSessionMode` / `setSessionModel` 切换；而工作流侧已通过 `acpServerOptions(controllerId, acpServerType)`（按类型空实例探测 + `controllerId+type` 缓存）拿到了前置选项，但缓存 TTL 1h 过长、模型列表新增/启用/禁用/删除后不会失效，也没有手动刷新入口。

### 1.2 目标

- 所有「+」对话框（新建会话、实例化工作流）打开即拉取最新列表，无需整页刷新。
- 新建云电脑选择 Github 项目后，由前端依次调用 `createCloudHost` → 轮询就绪 → `setupCloudHostGithubProject` 完成项目准备与项目会话创建；进度复用既有「工作负载 / Git 设置」进度对话框，云电脑创建作为其中第一个阶段。
- 新建会话默认注入 MCP（默认「全部已启用」），并新增控制器级「默认注入 MCP」配置；自动建会话遵循同一配置。
- `CreateSessionInput` 支持 `modeId` / `modelId` 前置传参，新建会话对话框复用 `acpServerOptions` 探测结果供用户选择；探测缓存 5 分钟、模型库变化即失效，两处选择器提供「刷新」按钮。

### 1.3 范围

**做**：

- `contracts/agent-session.graphql`（`CreateSessionInput +modeId/modelId`、`refreshAcpServerOptions`）、`contracts/agent-controller.graphql`（`Controller.defaultMcp + setControllerDefaultMcp`）、`contracts/cloud-host.graphql`（`Query.cloudHost(id)`、`SetupCloudHostGithubProjectInput.createSession`）契约变更。
- agent-api：`SessionService.create` 默认 MCP 解析合并与 `modeId/modelId` 透传、`setControllerDefaultMcp`、`refreshAcpServerOptions`（清缓存 + 重探测）、模型列表增删改/启用停用处的探测缓存失效钩子、`setupCloudHostGithubProject` 的 `createSession` 开关。
- controller-api：探测缓存 TTL 由 3600s 调整为 300s（`acp-options-prober`）。
- agent-web：`NewSessionDialog` / `InstantiateWorkflowDialog` 列表刷新、MCP 默认勾选、模型/模式前置选择与「刷新」按钮、控制器设置「默认注入 MCP」、`NewCloudHostDialog` Github 项目区块与「前端编排 + 统一进度对话框」（复用 `GithubSetupProgressDialog`，前置「启动云电脑」阶段）。
- 单元测试、API 测试、E2E 测试（TDD 红-绿-重构）。

**不做**：

- 不改变云电脑「每用户 1 实例、停止即销毁、会话只读」生命周期契约。
- 不做 MCP 服务本身的注册/停用能力变更（沿用 MCP 注册中心与 `setMcpServerEnabled`）。
- 不做会话中途更换默认 MCP（仅作用于新建会话）。
- 不做多 Harness 场景的自动会话创建（沿用「多 Harness 不自动建会话」约定）。
- 不新增独立的模型/模式探测链路（复用既有空实例探测与缓存）。
- 不改变会话内切换模型/模式、工作流节点 `agentConfig` 的既有语义。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    subgraph Web[agent-web]
        NSD[NewSessionDialog<br/>工作区/MCP/模型/模式]
        NCH[NewCloudHostDialog + 统一进度对话框<br/>前端编排]
        IWD[InstantiateWorkflowDialog<br/>工作流来源列表]
        CCS[控制器设置<br/>默认注入 MCP]
    end
    subgraph API[agent-api GraphQL]
        CS[createSession]
        CCH[createCloudHost]
        SCM[setControllerDefaultMcp]
        SO[acpServerOptions]
    end
    subgraph SVC[agent-api Services]
        SS[SessionService.create<br/>默认 MCP 解析合并]
        CHS[CloudHostService]
        CHG[CloudHostGithubService<br/>workload → gitSetup → session]
        WS[controllerWorkspaceService]
    end
    subgraph CC[cloud-controller + agent-controller]
        CONT[容器/工作负载/运行脚本]
        PROBE[acp prober 空实例探测]
    end
    NSD --> CS
    NSD --> SO
    CCS --> SCM
    IWD -->|GetConfiguredWorkflows/GetWorkflowTemplates| API
    NCH -->|1. createCloudHost| CCH
    NCH -->|2. 轮询 cloudHost 就绪| CHS
    NCH -->|3. setupCloudHostGithubProject| CHG
    CHG --> CONT
    CS --> SS
    SS --> WS
    SO --> PROBE
    CHG -->|ensureWorkspace + createSession| SS
```

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS v4 | 沿用 `apps/agent-web` |
| 前端数据 | Apollo Client v4 + GraphQL Code Generator | 本期以 `fetchPolicy` / `refetch` 控制刷新 |
| 后端 | Node.js 24 + Express v5 + GraphQL-Yoga | `servers/agent-api` |
| 数据库 | MongoDB（Mongoose） | `Controller` / `CloudHost` / `McpServer` / `Session` |
| 缓存 | Redis | `acp:options:<controllerId>:<serverType>`（5 分钟，复用并调整 TTL）、`session:command` |
| 容器编排 | cloud-controller 内部 REST + Socket.IO | 既有 workload / runtime-script 通路，不改 |

### 2.3 模块划分

```mermaid
graph LR
    A[agent-web 对话框层] --> B[agent-api GraphQL 层]
    B --> C[SessionService]
    B --> D[CloudHostService]
    B --> E[CloudHostGithubService]
    C --> F[(MongoDB)]
    D --> G[cloud-controller]
    E --> G
    C --> H[(Redis 命令/探测缓存)]
```

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| `NewSessionDialog` | 会话创建参数采集 | 打开即刷新工作区；`acpServerOptions` 探测（5 分钟缓存）+ 「刷新」按钮；MCP 默认勾选；`modeId/modelId` 提交 |
| `InstantiateWorkflowDialog` | 工作流实例化来源采集 | 打开即刷新 `GetConfiguredWorkflows` / `GetWorkflowTemplates` / `GetWorkspaces` |
| `ControllerConfigPage` / `McpDefaultSection` | 控制器默认注入 MCP 配置 | `setControllerDefaultMcp`；「默认全部」开关 + 多选 |
| `NewCloudHostDialog` + 统一进度对话框 | 创建云电脑（可选 Github 项目）与进度展示 | 前端编排 `createCloudHost` → 轮询就绪 → `setupCloudHostGithubProject`；复用 `GithubSetupProgressDialog`，前置「启动云电脑」阶段 |
| `SessionService` | 会话创建/恢复/切换 | 默认 MCP 解析合并；`modeId/modelId` 随 `acp:start` 下发 |
| `CloudHostService` | 云电脑生命周期 | 创建/就绪状态查询（供前端编排轮询）/停止/删除 |
| `CloudHostGithubService` | Git 项目设置三步编排 | 幂等步骤、`createSession` 开关（多 Harness 跳过会话创建）、失败可就地重试 |

## 3. API 设计

> 契约式开发：先改 `contracts/`，再实现 schema/resolver。以下为契约文件变更点。

### 3.1 API 契约

#### 接口 1: `CreateSessionInput` 扩展（`contracts/agent-session.graphql`）

```graphql
input CreateSessionInput {
  controllerId: ID!
  acpServerType: String!
  workspaceId: ID
  enableWorktree: Boolean = false
  worktreeBranchSuffix: String
  existingWorktreePath: String
  # 语义变更：缺省 = 按控制器「默认注入 MCP」解析（useAllEnabled 时取全部已启用 MCP）；
  # 显式传数组 = 以调用方为准（含空数组 = 不注入）。云会话仍自动并入 agent-cloud-host-tools。
  mcpServerIds: [ID!]
  additionalDirectories: [String!]
  # 新增：拉起前选择的模式/模型（来自 acpServerOptions 探测结果）；缺省使用工具默认值
  modeId: ID
  modelId: ID
}
```

- **响应**：沿用 `CreateSessionPayload`（`session`）。
- **校验**：`modeId` / `modelId` 仅做非空长度与字符集校验，不强校验是否在探测结果内（工具侧对未知值按默认处理）；`mcpServerIds` 沿用「必须属于当前用户且 `enabled=true`，否则 `MCP_SERVER_NOT_FOUND`」。

#### 接口 2: 控制器默认注入 MCP（`contracts/agent-controller.graphql`）

```graphql
type ControllerDefaultMcp {
  # true = 新建会话默认注入「全部已启用 MCP」（动态跟随新增服务）；false = 仅注入 serverIds
  useAllEnabled: Boolean!
  serverIds: [ID!]!
}

extend type Controller {
  defaultMcp: ControllerDefaultMcp!
}

extend type Mutation {
  # useAllEnabled=true 时忽略 serverIds（服务端归一为 []）；false 时 serverIds 允许为空数组（= 不注入）
  setControllerDefaultMcp(controllerId: ID!, useAllEnabled: Boolean!, serverIds: [ID!] = []): Controller!
}
```

- **响应**：更新后的 `Controller`（含 `defaultMcp`）。
- **错误**：`CONTROLLER_NOT_FOUND`；`MCP_SERVER_NOT_FOUND`（`serverIds` 中存在非本用户/已停用/已删除的服务）。
- **兼容**：未配置过的存量控制器 `defaultMcp = { useAllEnabled: true, serverIds: [] }`（缺省即「全部」），无数据迁移。

#### 接口 3: 云电脑创建与项目准备（前端编排，`contracts/cloud-host.graphql`）

创建 + 项目准备由前端按序调用既有 API 编排（不在后端新增编排），只需两处小契约补充：

```graphql
# ① 进度对话框需要以 1.5s 级别轮询云电脑启动状态（HOME_OVERVIEW 15s 轮询过慢）
type Query {
  cloudHost(id: ID!): CloudHost
}

# ② 多 Harness 场景不自动建会话：跳过「会话创建」步骤（operation 记 SKIPPED）
input SetupCloudHostGithubProjectInput {
  controllerId: ID!
  accountId: ID!
  repoFullName: String!
  targetPath: String!
  workloadIds: [ID!]
  createSession: Boolean = true    # 新增，缺省 true
}

# ③ 选择 Github 项目时抑制 ready 时的默认会话（项目会话由 ② 的 session 步骤创建）
input CreateCloudHostInput {
  name: String!
  harnessTypes: [HarnessType!]!
  workloadIds: [ID!]
  createDefaultSession: Boolean = true   # 新增，缺省 true（不带项目时行为完全不变）
}
```

- **前端编排顺序**：`createCloudHost(name, harnessTypes, workloadIds, createDefaultSession=false)`（选了项目时）→ 轮询 `cloudHost(id)` 直至 `RUNNING` → `setupCloudHostGithubProject(controllerId, accountId, repoFullName, targetPath, workloadIds, createSession)` → 轮询 `cloudHostSetupOperation(id)`（既有）→ 成功且 `sessionId` 非空时跳转会话。项目会话创建成功后由服务端回填 `CloudHost.defaultSessionId`（若为空），避免 Sidebar 误报「默认会话创建失败」。
- **进度展示**：复用「安装工作负载 / Git 设置」进度对话框（`GithubSetupProgressDialog`），在其三步之前增加「启动云电脑」阶段（由 `cloudHost(id).status` 驱动），四阶段为「启动云电脑 → 工作负载设置 → Git 项目设置 → 会话创建」。
- **错误**：`ACCOUNT_NOT_FOUND` / `invalid targetPath`（非绝对路径或含 `..`、反斜杠）/ 既有 `name`、`harness`、`workload` 校验不变；启动失败停留在「启动云电脑」阶段并提供重建入口。

#### 接口 4: 手动刷新模式/模型选项（`contracts/agent-session.graphql`）

```graphql
extend type Mutation {
  # 清空该 controllerId+acpServerType 的探测缓存并立即重新探测，返回最新结果
  # （新建会话对话框与工作流节点配置的「刷新」按钮共用）
  refreshAcpServerOptions(controllerId: ID!, acpServerType: String!): AcpServerOptions!
}
```

- **响应**：`AcpServerOptions`（与 `acpServerOptions` 同形：`modes / models / currentModeId / currentModelId / probedAt`）。
- **行为**：先删除 Redis `acp:options:<controllerId>:<serverType>`，再走既有探测链路（`acp:probe-options` + 轮询 35s）；探测失败返回空选项并保留 60s 失败缓存，不抛错。
- **错误**：`CONTROLLER_NOT_FOUND`。

#### 接口 5: 既有查询复用（无契约变更）

| 查询 | 用途 |
|------|------|
| `acpServerOptions(controllerId, acpServerType)` | 拉起会话前探测模式/模型（与工作流节点配置同源，`controllerId+type` 缓存 5 分钟） |
| `controllerWorkspaces(controllerId)` | 新建会话工作区列表（改为打开即取最新） |
| `configuredWorkflows(controllerId)` / `workflowTemplates` / `workspaces` | 实例化工作流来源列表（改为打开即取最新） |
| `cloudHostSetupOperation(id)` / `retryCloudHostSetupOperation(id)` | 项目准备进度与就地重试（复用） |
| `mcpServers` | 默认注入 MCP 配置与会话 MCP 勾选数据源 |
| `githubAccounts` | 云电脑创建对话框内 Github 项目区块数据源 |

### 3.2 内部接口

本期不新增内部 REST 接口，沿用既有通路：

| 通路 | 说明 |
|------|------|
| `POST /internal/containers/:id/workloads` | 「工作负载设置」步骤（Github 预制负载安装） |
| `POST /internal/containers/:id/runtime-scripts` | 「Git 项目设置」步骤（容器内 `gh repo clone`，`githubAuth`） |
| `POST /internal/cloud-hosts/:id/ready` | 容器就绪回调（不变；仅 `createDefaultSession=true` 且单 Harness 时建默认会话） |
| `POST /internal/cloud-hosts/:controllerId/github-credential` | 仓库级最小化凭据下发（不变） |
| Redis `session:command` `acp:start` | 已支持 `modeId` / `modelId`（工作流已在用），本期会话创建复用 |

## 4. 数据模型

### 4.1 数据库设计

#### 表/集合: `controllers`（`servers/agent-api/src/models/controller.ts`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `defaultMcp.useAllEnabled` | Boolean | 默认 `true`；`true` 表示动态注入全部已启用 MCP |
| `defaultMcp.serverIds` | [ObjectId] | `useAllEnabled=false` 时的注入集合，允许空数组 |

> 嵌套子文档注意 Mongoose 空对象物化：`defaultMcp` 需字段级 resolver 归一化为 `{ useAllEnabled: true, serverIds: [] }`（历史行无该字段），并在 `resolvers/index.ts` 登记（backend-rules「resolver 合并清单」）。

#### 表/集合: `cloudhosts`（`servers/agent-api/src/models/cloud-host.ts`）

- **无新增字段**：前端编排不暂存项目信息（项目参数由前端调用 `setupCloudHostGithubProject` 时携带），`CreateCloudHostInput.createDefaultSession` 只影响 ready 行为、不落库。
- 复用既有 `status` / `defaultSessionId`：项目会话创建成功后回填 `defaultSessionId`（若为空），保持「RUNNING 且单 Harness 必有 `defaultSessionId` 或明确失败提示」的既有前端语义。

#### 表/集合: `cloud_host_setup_operations`（不改结构）

- 复用既有 `steps: workload | gitSetup | session`、`status: PENDING/RUNNING/SUCCEEDED/FAILED/SKIPPED`、`retry` 幂等语义；`createSession=false` 时 `session` 步骤记 `SKIPPED`，不改变步骤机。

### 4.2 缓存设计

| Key | 内容 | TTL | 说明 |
|-----|------|-----|------|
| `acp:options:<controllerId>:<serverType>` | 模式/模型探测结果 | **300s（5 分钟）**，失败 60s | 由 controller-api `acp-options-prober` 写入时的 TTL 调整（原 3600s） |
| `session:command`（Redis pub/sub） | `acp:start` 含 `modeId/modelId` | - | 既有通路，工作流节点已在用 |

探测缓存失效策略（三类触发）：

| 触发 | 处理 |
|------|------|
| 用户在模型列表**新增 / 启用 / 禁用 / 删除**模型 | agent-api 模型管理 mutation 成功后调用 `invalidateAcpOptionsCache(...)`：删除受影响的 `acp:options:<controllerId>:<serverType>` key（用户级模型变更删该用户全部控制器的 key；系统内置模型变更删全部用户的 key） |
| 用户点击**「刷新」按钮** | 前端调用 `refreshAcpServerOptions(controllerId, acpServerType)`：服务端先删 key 再立即重新探测并返回 |
| TTL 到期（5 分钟） | 自然过期，下次访问触发重新探测 |

> 默认 MCP 解析不引入缓存：`McpServer` 查询为小集合按 `_id/$in` 或 `userId+enabled` 过滤，直接读库，避免缓存失效带来的「默认集合不更新」问题。

## 5. 技术实现方案

### 5.1 核心流程

创建云电脑并初始化 Github 项目（前端编排，统一进度对话框）：

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as agent-web（统一进度对话框）
    participant A as agent-api
    participant CC as cloud-controller
    participant C as 工作容器
    U->>W: 新建云电脑（含 Github 项目）
    W->>A: ① createCloudHost(..., createDefaultSession=false)
    A->>CC: POST /internal/containers（启动 harness）
    loop 阶段一「启动云电脑」：轮询 cloudHost(id)（1.5s）至 RUNNING
        W->>A: cloudHost(id)
    end
    W->>A: ② setupCloudHostGithubProject(..., createSession)
    A->>CC: 阶段二「工作负载设置」（Github 预制负载）
    A->>C: 阶段三「Git 项目设置」（runtime-script + 最小化凭据 clone）
    A->>A: 阶段四「会话创建」：ensureWorkspace(finalPath) + createSession（默认 MCP）
    A->>A: 回填 defaultSessionId（若为空）
    loop 轮询 cloudHostSetupOperation(id)（1.5s）
        W->>A: cloudHostSetupOperation(id)
    end
    W->>U: 同一对话框展示四阶段进度
    W->>U: 成功后跳转项目会话
    Note over A,W: 未选择项目：createDefaultSession=true，ready 时建默认会话（现状不变）<br/>失败：阶段一失败提示重建；阶段二/三/四失败就地重试（retryCloudHostSetupOperation）
```

新建会话（默认 MCP + 前置选择模型/模式）：

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as agent-web
    participant A as agent-api
    participant P as 空实例探测
    U->>W: 打开会话「+」
    W->>A: controllerWorkspaces(controllerId)（打开即取最新）
    W->>A: acpServerOptions(controllerId,acpServerType)
    A->>P: 缓存未命中时发起探测
    P-->>W: modes/models（缓存 5 分钟，模型变更失效/可刷新）
    W->>U: 展示模式/模型下拉 + MCP 默认勾选（按控制器默认）
    U->>W: 调整后创建
    W->>A: createSession(...,mcpServerIds,modeId,modelId)
    A->>A: MCP 归属校验 + mcpEndpoint 创建
    A->>A: Redis acp:start（含 modeId/modelId）
    A-->>U: 会话就绪（MCP/模型/模式已就位）
```

### 5.2 关键实现点

#### 实现点 1: 「+」对话框列表实时刷新

- **描述**: `NewSessionDialog` 的 `GetControllerWorkspacesEnabled`、`InstantiateWorkflowDialog` 的 `GetConfiguredWorkflows` / `GetWorkflowTemplates` / `GetWorkspaces`、`WorkflowSection` 的来源列表，改为「打开即取最新」。
- **技术细节**:
  - 统一策略：`useQuery` 保留 `cache-first` 首屏快照，`useEffect([open])` 内调用 `refetch()`；或直接 `fetchPolicy: 'network-only'`（列表小，代价可接受）。二选一在实现期统一为一种写法。
  - `GithubSetupProgressDialog` 成功后除 `HOME_OVERVIEW` 外增加 `refetchQueries: ['GetControllerWorkspacesEnabled']`，形成「操作方负责失效」的闭环（不依赖对话框下次打开的刷新兜底）。
  - 加载分支遵循 frontend-rules「Apollo v4 轮询陷阱」：`loading && !data` 才显示骨架，刷新期间不得卸载表单、不得清空用户已填内容（E2E 断言输入不丢）。
  - 不在 Sidebar/首页新增信息流查询（`HOME_OVERVIEW` 统一下发约束不变）；对话框保持自有查询，避免把弹窗数据流耦合进首页聚合。
- **风险点**: `refetch()` 与用户操作并发时的竞态——用「刷新只替换列表数据、不重置受控输入」保证。

#### 实现点 2: 新建云电脑初始化 Github 项目（前端编排 + 复用工作负载进度对话框）

- **描述**: 由前端依次调用 `createCloudHost` → 轮询就绪 → `setupCloudHostGithubProject` 完成「创建 + 项目准备」；进度复用安装工作负载 / Git 设置的进度对话框，云电脑创建作为其中第一个阶段展示。
- **技术细节**:
  - **编排边界**：整体顺序由前端驱动（后端 ready 回调不新增编排）；三步「工作负载设置 / Git 项目设置 / 会话创建」仍由既有 `CloudHostGithubService` 执行（幂等、可重试），即「前端编排步骤、后端执行步骤」。
  - **进度对话框复用**：`GithubSetupProgressDialog` 泛化为「项目准备进度对话框」，新增可选前置阶段「启动云电脑」（props 如 `hostId` / `showStartupStage`）：阶段一由 `cloudHost(id)`（1.5s 轮询）驱动，阶段二~四沿用 `cloudHostSetupOperation(id)`（1.5s 轮询）；沿用「`loading && !data` 不卸载内容」与 `retryCloudHostSetupOperation` 就地重试。工作负载安装 / 手动「Git 项目设置」等既有入口不显示前置阶段，行为零变化。
  - **会话去重**：已选项目时 `createCloudHost(..., createDefaultSession=false)` 抑制 ready 默认会话，项目会话由 setup 的 `session` 步骤创建（`createSession=true`），成功后回填 `defaultSessionId`（若为空），避免 Sidebar 误报「默认会话创建失败」；多 Harness 传 `createSession=false`，`session` 步骤记 `SKIPPED`（沿用「多 Harness 不自动建会话」）。
  - **表单复用**：`NewCloudHostDialog` 增加「Github 项目（可选）」区块，复用 `GithubProjectSetupDialog` 的帐号/仓库/前缀地址/最终地址预览（抽取 `useGithubProjectForm` + `lib/workspace-path.ts`）；校验（帐号归属、`repoFullName` 形态、`targetPath` 绝对路径且不含 `..`/反斜杠）前端即时提示，服务端沿用既有校验。
  - **失败路径**：阶段一失败（容器启动失败）停留在该阶段并提供重建入口（删除 + 重建）；阶段二/三失败就地重试；阶段四失败沿用「仓库已就绪，请手动创建会话」降级，云电脑保持可用。
- **风险点**: ① 阶段切换竞态——以 `cloudHost(id).status === 'RUNNING'` 为唯一推进条件；`setupCloudHostGithubProject` 调用失败（网络）时停留在阶段一末尾并提供「重试项目准备」，配合同 `controllerId` 的 operation 幂等去重避免重复执行；② 忘记抑制默认会话会多出一个空会话——`createDefaultSession=false` 必须与「已选项目」绑定在同一提交路径上；③ 复用进度框需保证旧入口零回归（组件测试 + 既有 E2E 回归）。

#### 实现点 3: 默认 MCP 注入与控制器默认 MCP 设置

- **描述**: 新建会话默认注入 MCP；控制器可配置默认注入集合；自动建会话遵循同一配置。
- **技术细节**:
  - `SessionService.create`（`servers/agent-api/src/services/session.ts` L145 附近合并段）扩展解析顺序：
    1. 调用方显式传 `mcpServerIds`（含空数组）→ 以调用方为准；
    2. 未传 → 读 `Controller.defaultMcp`：`useAllEnabled=true` 取用户全部 `enabled=true` 的 `McpServer` id；否则取 `serverIds`（过滤已删除/已停用）；
    3. 云会话继续并入 `ensureCloudHostToolsServer(userId)`（既有行为）；
    4. 去重后走既有「归属校验 + `mcpEndpointService.createEndpoint`」链路（fail-fast 语义不变）。
  - 自动建会话入口不传 `mcpServerIds` 即可自动生效：`cloud-host-github-service.ts` `runSessionStep`、`cloud-host-service.ts` `handleReadyLocked` 默认会话、创建期项目会话。
  - GraphQL：`Controller.defaultMcp` 字段 resolver 归一（历史行空对象物化陷阱），并按 backend-rules 在 `resolvers/index.ts` 登记；`setControllerDefaultMcp` 校验 `serverIds` 必须属于当前用户且 `enabled=true`。
  - 前端：控制器设置新增「默认注入 MCP」区块（`components/settings/McpDefaultSection.tsx`）：「默认注入全部 MCP」开关 + MCP 多选（开关开启时禁用并提示「新 MCP 上线后自动注入」）；`NewSessionDialog` 打开时按该配置预选（全部勾选/按子集勾选），用户可调整，提交显式 `mcpServerIds`。
- **风险点**: 「全部」是动态语义——用户后续新增 MCP 会自动进入默认集合（这是需求预期，需在设置界面明示）；已停用服务必须从解析结果中剔除，避免 `MCP_SERVER_NOT_FOUND` 导致建会话失败。

#### 实现点 4: 拉起会话前置选择模型与模式（含缓存时效、失效与刷新）

- **描述**: 选定 `acpServerType` 后复用 `acpServerOptions` 探测结果供用户前置选择 `modeId` / `modelId`；探测缓存 5 分钟、模型库变化即失效，并在新建会话与工作流节点配置两处提供「刷新」按钮。
- **技术细节**:
  - 前端 `NewSessionDialog` 在控制器 + 工具确定后发起 `GetAcpServerOptions`（与 `WorkflowGraphEditor.AgentNodeOptionFields` 同源同写法）：loading 提示「正在探测可用模式与模型…」，渲染下拉（首项「默认」= 留空不传），无选项时仅「默认」不阻断创建。
  - 契约 `CreateSessionInput.modeId/modelId` → resolver → `SessionService.create` 内参（已存在）→ Redis `acp:start`（已支持），controller-api/agent-controller 链路零改动。
  - **缓存 5 分钟**：controller-api `acp-options-prober.handleProbeResult` 写入 `acp:options:<controllerId>:<serverType>` 的 TTL 由 3600s 调整为 300s（失败缓存保持 60s）；agent-api `SessionService.getAcpServerOptions` 的缓存优先读逻辑不变。
  - **模型库变化即失效**：agent-api 模型管理相关 mutation（新增模型 / 启用 / 禁用 / 删除，含用户模型与系统内置模型）成功后调用 `invalidateAcpOptionsCache(...)` 删除受影响的探测 key：用户级变更删该用户全部 `acp:options:<controllerId>:*`，系统内置变更删全部用户的 key（SCAN 匹配或按 controllerId 枚举，二选一在实现期定，单测覆盖两个分支的归属判定）。
  - **「刷新」按钮**：`NewSessionDialog` 与 `WorkflowGraphEditor.AgentNodeOptionFields`（`ConfigureWorkflowDialog` / `InstantiateWorkflowDialog` / `EditInstanceNodeDialog` 共用）的模式/模型选择区各加一个刷新按钮，点击调用 `refreshAcpServerOptions(controllerId, acpServerType)`（服务端先删缓存再重探测并返回），结果就地替换选项列表；探测期间按钮转 loading，失败保留旧选项并提示。
  - 遵循 backend-rules「能力探测」：配置阶段无会话可查，只走空实例探测，不编造 pre-session 能力数据。
- **风险点**: 探测失败/超时（既有实现返回空列表）不得阻断建会话；模型变更失效若漏掉系统内置模型的全局影响，会出现「删了模型还能选到」的陈旧选项——失效范围判定必须有单测；高频点刷新会拉起空实例探测，按钮在探测进行中禁用以防连点。

#### 实现点 5: 工作流「+」列表刷新（含 MCP 创建的条目）

- **描述**: 通过 MCP（`agent-workflow-admin-tools`）创建的已配置工作流/模板需在前端「+」对话框立即可见。
- **技术细节**: 与实现点 1 同一策略——`InstantiateWorkflowDialog` 打开即 `refetch` `GetConfiguredWorkflows` / `GetWorkflowTemplates`；`ConfigureWorkflowDialog` / `TemplateEditorDialog` 保存后的既有 `refetchQueries` 保留；`WorkflowSection` 进入设置页时刷新一次。AI/MCP 侧创建路径（`createConfiguredWorkflow` / `createWorkflowTemplate`）无需改动（对话框刷新即兜底），不引入推送通道。
- **风险点**: 已删除条目的陈旧缓存——`refetch` 以服务端返回为准整表替换。

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| 默认 MCP 作用域 | 用户级全局一份 | 控制器级一份 | B | 需求明确「在控制器设置中增加设置」；不同控制器（本地/云电脑）常用工具集不同 |
| 「默认全部」语义 | 保存时物化全量 id 列表 | 动态标志 `useAllEnabled`（跟随新增 MCP） | B | 需求要求「系统中的 MCP 都默认启用」，物化列表会在新增 MCP 后失真 |
| 空配置的表达 | `serverIds=null` 表示全部 | 显式 `useAllEnabled` + `serverIds` 两字段 | B | GraphQL 单列表字段无法区分「未配置/null/空数组」，显式标志无歧义且可测试 |
| 列表刷新策略 | 对话框打开即 `refetch` | 统一收敛到 `HOME_OVERVIEW` 聚合下发 | A | 弹窗数据不在首页信息流范围；改动最小、可独立测试，且不违反「首页/Sidebar 不各自发起查询」约束 |
| Github 项目初始化编排 | 后端 ready 回调内编排（服务端暂存项目） | **前端调用 API 编排**（`createCloudHost` → 轮询就绪 → `setupCloudHostGithubProject`） | B | 后端零新增编排，进度/失败/重试全部在用户可见的对话框内就地处理；三步编排继续复用 `CloudHostSetupOperation` 的幂等与重试 |
| 项目准备进度展示 | 新建「云电脑创建」专用进度框 | **复用工作负载安装 / Git 设置进度对话框**，前置「启动云电脑」阶段 | B | 打回意见明确要求复用；一个对话框看全程，旧入口不显示前置阶段即零回归 |
| 项目会话与默认会话 | ready 建默认会话 + 项目会话各一个（两会话） | `createDefaultSession=false` 抑制默认会话，项目会话即默认会话 | B | 避免同一台云电脑多出一个空会话；回填 `defaultSessionId` 保持前端自动进入与失败提示语义 |
| 模型/模式探测缓存时效 | 沿用 1h 只读缓存 | **5 分钟 + 模型库变更失效 + 手动刷新** | B | 打回意见；模型列表高频调整，1h 陈旧不可接受，且要能立即取到最新 |
| 「刷新」按钮实现 | 前端删缓存后重发查询（无删缓存入口，做不到） | `refreshAcpServerOptions` mutation（删缓存 + 重探测 + 返回结果） | B | 一次往返完成「清缓存 + 重取」，服务端语义明确、可 API 测试；新建会话与工作流节点配置共用同一入口 |
| 模型/模式探测 | 新建会话探测接口 | 复用 `acpServerOptions`（工作流同款） | B | 同一探测源保证「与工作流看到的选项一致」，零新增链路 |
| 会话模型/模式 | 创建后 `setSessionModel/setSessionMode` | `CreateSessionInput` 前置传参 | B | `acp:start` 已支持 `modeId/modelId`（工作流在用），前置传参避免「起错会话再切换」的空转对话 |
| 自动建会话的模型/模式 | 一并按探测默认注入 | 不传，沿用工具默认 | B | 需求只要求「拉起会话时给用户前置选择」；自动建会话无用户在场，不编造选择 |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | Git 项目设置（`CloudHostSetupOperation` 三步编排） | 前端编排的后半程复用其步骤、幂等与重试语义 |
| 依赖 | `acpServerOptions` 空实例探测 | 复用 `controllerId+type` 缓存，仅调整 TTL 与失效，不新增第二套探测 |
| 依赖 | MCP 注册中心（`McpServer` / `mcpEndpoint`） | 默认 MCP 解析的数据源与注入通路 |
| 依赖 | `GithubSetupProgressDialog`（工作负载安装 / Git 设置进度框） | 泛化复用，新增前置「启动云电脑」阶段，旧入口零回归 |
| 约束 | 云电脑生命周期契约 | 每用户 1 实例、停止即销毁、会话只读，均不改 |
| 约束 | `HOME_OVERVIEW` 数据流约束 | 首页/Sidebar 信息流唯一聚合，不得各自发起信息流查询（进度对话框为独立交互面，允许自有轮询） |
| 约束 | Mongoose 空对象物化 + `resolvers/index.ts` 登记 | 新增嵌套字段必须配字段 resolver 与登记（backend-rules） |
| 约束 | 契约先行 | 先改 `contracts/`，再实现 schema/resolver 与前端 codegen |
| 约束 | 能力探测口径 | 不编造 pre-session 能力数据，只走空实例探测（backend-rules「能力探测」） |

## 7. 项目结构

```
z-agent-gear/
├── contracts/
│   ├── agent-session.graphql          # CreateSessionInput: +modeId/modelId、mcpServerIds 语义注释；refreshAcpServerOptions
│   ├── agent-controller.graphql       # Controller.defaultMcp + setControllerDefaultMcp
│   └── cloud-host.graphql             # Query.cloudHost(id)、CreateCloudHostInput.createDefaultSession、SetupCloudHostGithubProjectInput.createSession
├── servers/controller-api/src/
│   └── services/acp-options-prober.ts # 探测缓存 TTL 3600s → 300s
├── servers/agent-api/src/
│   ├── models/
│   │   └── controller.ts              # +defaultMcp 子文档
│   ├── graphql/
│   │   ├── schemas/{agent-controller,cloud-host,session}.ts   # +cloudHost(id)/refreshAcpServerOptions/defaultMcp
│   │   └── resolvers/{agent-controller,cloud-host,session}.ts # 字段 resolver 归一 + 登记
│   └── services/
│       ├── session.ts                 # 默认 MCP 解析合并、modeId/modelId 透传、getAcpServerOptions
│       ├── acp-options-cache.ts       # 新增：invalidateAcpOptionsCache（模型变更失效）
│       ├── model.ts / llm 相关 resolver # 模型增删改/启用停用处挂失效钩子
│       ├── cloud-host-service.ts      # createDefaultSession 开关；defaultSessionId 回填
│       └── cloud-host-github-service.ts # createSession 开关（多 Harness 记 SKIPPED）
├── apps/agent-web/src/
│   ├── components/session/NewSessionDialog.tsx            # 列表刷新/MCP 预选/模型模式前置选择+刷新按钮
│   ├── components/workflow/InstantiateWorkflowDialog.tsx  # 来源列表打开即刷新
│   ├── components/workflow/WorkflowGraphEditor.tsx        # 选项区增加「刷新」按钮
│   ├── components/cloud-host/NewCloudHostDialog.tsx       # Github 项目区块 + 前端编排
│   ├── components/cloud-host/GithubSetupProgressDialog.tsx # 泛化：前置「启动云电脑」阶段
│   ├── components/cloud-host/GithubProjectSetupDialog.tsx # 表单逻辑抽取共享（useGithubProjectForm）
│   ├── components/settings/McpDefaultSection.tsx          # 新增：默认注入 MCP
│   ├── pages/ControllerConfigPage.tsx                     # 挂载新设置区块
│   └── graphql/{queries,mutations,workflow}.ts            # 契约字段同步 + codegen
└── tests/
    ├── api/                          # GraphQL 契约与服务行为测试
    └── e2e/                          # Playwright 场景测试
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 全程 TDD 红-绿-重构：先写失败测试（契约/服务行为），再写最少实现，最后重构。
- 单元测试（vitest）覆盖：默认 MCP 解析矩阵（显式传参 / 未传 + useAllEnabled / 未传 + 子集 / 空数组 / 停用与删除剔除）、`setControllerDefaultMcp` 校验、`createDefaultSession` / `createSession` 开关语义（含 `SKIPPED` 步骤）、`modeId/modelId` 透传、`invalidateAcpOptionsCache` 的失效范围判定（用户级 / 系统内置全局）。
- API 测试（`tests/api`，vitest + supertest）覆盖：`createSession`（默认 MCP / 显式 MCP / modeId/modelId）、`setControllerDefaultMcp`、`createCloudHost(createDefaultSession)`、`setupCloudHostGithubProject(createSession)`、`cloudHost(id)`、`refreshAcpServerOptions`（清缓存 + 重探测 + 返回）、`cloudHostSetupOperation` 进度与重试、模型 mutation 后探测缓存确实失效、`acpServerOptions` 5 分钟缓存复用。

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | vitest | 服务层解析/合并/校验逻辑、缓存失效范围判定、字段 resolver 归一 |
| API 测试 | tests/api（vitest + supertest） | 契约变更端点、错误码、幂等与回退语义、缓存 TTL 与失效 |
| E2E 测试 | tests/e2e（Playwright） | 五条验收主链路（见 §9），含「列表刷新不丢输入」「进度框四阶段推进」「刷新按钮取到新选项」断言 |
| 前端组件测试 | vitest + React Testing Library | `NewSessionDialog` 预选/探测态/刷新按钮、`McpDefaultSection`、云电脑项目区块表单校验、`GithubSetupProgressDialog` 前置阶段（旧入口不显示前置阶段的零回归用例） |

## 9. 验收标准

- [ ] 技术方案评审通过、Contract 评审通过
- [ ] 「Git 项目设置」添加工作区后，不刷新页面打开会话「+」即可选到新工作区并建会话
- [ ] 新建云电脑可选择 Github 项目：前端依次编排创建与项目准备，四阶段（启动云电脑 → 工作负载设置 → Git 项目设置 → 会话创建）在同一进度对话框内可见，成功后自动进入项目会话；失败可就地重试/手动设置且云电脑可用；不带项目与既有工作负载安装入口零回归
- [ ] 新建会话 MCP 默认全选并按控制器默认配置预选；会话内 MCP 工具可用；「Git 项目设置」自动创建的会话同样带默认 MCP
- [ ] 控制器设置可配置「默认注入 MCP」，保存后对后续新建会话生效；清空选择即回到不注入
- [ ] 新建会话可前置选择模式与模型（与工作流节点选项一致），留空走工具默认；探测中/无选项不阻断创建
- [ ] 模式/模型选项缓存 5 分钟内复用；模型列表新增/启用/禁用/删除后立即失效；「刷新」按钮（新建会话与工作流节点配置两处）点击即取到最新选项
- [ ] 通过 MCP 创建已配置工作流/模板后，不刷新页面打开工作流「+」即可看到并实例化
- [ ] 单元测试覆盖达标、API 测试通过、E2E 测试通过

## 10. 相关文档

- 产品需求：`docs/product/draft/20261022-cloud-container-optimization-phase1.md`
- 契约：`contracts/agent-session.graphql`、`contracts/agent-controller.graphql`、`contracts/cloud-host.graphql`
- 既有提案：`docs/engineering/proposals/20261021-feat-github-workload.md`、`docs/engineering/proposals/20261020-feat-container-harness-support.md`、`docs/engineering/proposals/20261022-feat-workload-optimization.md`、`docs/engineering/proposals/20260522-feat-available-models-and-mode-switch.md`
- 开发规范：`docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`、`docs/engineering/frontend-rules.md`
