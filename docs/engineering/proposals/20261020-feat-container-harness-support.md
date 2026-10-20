---
description: 容器启动任务支持 harness 类型技术提案（v3.0 范围裁剪）：云主机复用 Controller 主机模型（cloud 图标/标准 ACP 会话）、agent-gear 双连接、purpose=harness 全链路、OpenCode 预制工作负载与容器作用域模型 Key；统一存储与会话存取二期
type: Permanent
---

# 容器启动任务支持 harness 类型（OpenCode 云主机）- 技术提案

**功能名称**: 容器启动任务 harness 类型、OpenCode 云主机
**关联 PRD**: docs/product/draft/20261020-container-harness-support.md
**技术提案版本**: v3.0
**创建日期**: 2026-10-20
**作者**: ZeroAsh
**feat-branch**: `feat/container-harness-support`

> v2.0 变更（需求重构）：
>
> 1. **交付面反转**：一期交付面改为前台 agent-web；admin-web/admin-api 的启动对话框、容器治理页移出一期（`adminStartCloudContainer` 维持仅 `IDLE` 现状不动）。启动链路改为 **agent-api → cloud-controller 内部 API**。
> 2. **产品模型变更**：harness 容器直接复用既有 `Controller` 模型（`ControllerType.cloud` 枚举已存在），经既有 ControllerKey 握手注册进 controller-api，`homeOverview.controllers` 自动包含、左侧导航栏同构展示（云图标），主机界面（Harness 工具（ACP）列表）与标准「会话」链路（`createSession` → `session:command acp:start` → opencode ACP）**零改动复用**。
> 3. **用户命名**：agent-api 预创建 `Controller`（`type='cloud'`、`status='registering'`、`name`=用户命名），创建即出现在主机列表（启动中）。
> 4. **标准会话**：容器内 agent-gear（agent-controller）天然支持 opencode ACP，走既有标准「会话」链路。
>
> v3.0 变更（范围裁剪返工，与 PRD v3.0 同步）：
>
> 1. **统一存储本期不做**：`unified-storage.openapi.yaml`、`storageobjects`/`storageusages`/`storagetokens`、`quota-guard`、storage 域服务与「我的存储」页面整体移至二期。
> 2. **会话导入暂不做**：「恢复的会话」（`myStoredOpencodeSessions`、`optionsSource=OPENCODE_SESSIONS`、`opencode session import`）移至二期；因会话导出依赖统一存储，「存储会话」与 post 导出（`opencode session list/export` + 存储令牌）一并移至二期。
> 3. 一期聚焦：`purpose=harness` 全链路、前台云主机（命名/云图标/主机同构/标准会话）、OpenCode 预制工作负载（固定版本安装 + `opencode.jsonc` 模型凭证注入）、容器作用域模型 Key 与计费分流。
>
> 按实现计划节点对当前代码事实的核查修正（沿用）：agent-gear 升 **2.5.0**（云主机双连接模式），cloud-controller `MIN_WORKER_VERSION` 保持 `2.2.0`、harness 容器单独做 2.5.0 门禁；worker 镜像**未预装** `@opencode/cli`（固定版本安装）；OpenCode 配置文件为 `opencode.jsonc`；tests/api 用 `fetch`（非 supertest）；新增后端 `HARNESS_ENABLED` 开关（沿用 cloud-controller `toBool` 模式）。

## 1. 概述

### 1.1 背景

`20261014-feat-cloud-agent-phase2` 交付了 K8s 云端工作容器基线；`20261017-feat-cloud-controller-workload` / `20261018-feat-workload-phase1` 交付了工作负载体系（参数表单、隐式依赖、预制工作负载、执行留档）；`20261018-feat-credits-billing` 交付了费用中心（计费账户、API Key、OpenAI 兼容计费网关）；「主机」体系（`Controller` + ControllerKey + `homeOverview` + 标准会话 + Harness 工具（ACP）探测）已在 agent-api/controller-api/agent-web 稳定运行。当前事实：

- 云端容器启动任务类型（`purpose`）**仅开放 `idle`**：`servers/admin-api/src/graphql/resolvers/cloud-container.ts`、`servers/cloud-controller/src/routes/internal-api.ts`、`servers/cloud-controller/src/services/container-service.ts` 三处硬编码拒绝其余值。
- worker 镜像（`deploy/images/worker/Dockerfile`）预装 `agent-gear@2.4.x`、`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`，**不含 `@opencode/cli`**；`packages/agent-controller` 当前版本 `2.4.0`。
- agent-gear 的连接端点是抽象的（`parseEndpoint` + `connectToServer(endpoint, key)`），同一二进制既可拨 `wss://<cloud-controller>/worker`（工作负载通道），也可按标准 ControllerKey 拨 controller-api 注册为「主机」——但今天 worker 只走前者，`register.key` 被 cloud-controller 忽略，不产生 `Controller` 记录。
- `ControllerType` 枚举**已有 `cloud` 值**（契约 `contracts/agent-controller.graphql`），但前端一律硬编码 `type:'local'`，也没有按主机类型区分的图标。
- 计费 Key（`billingapikeys`）无有效期/作用域概念。

本期需求（PRD v3.0）：启动任务新增 **harness** 类型并**在前台（agent-web）交付**——用户命名新建云主机、选 harness（一期 OpenCode）；云主机作为一台「主机」进左侧导航栏（云图标、与普通主机同构的 ACP 列表与标准会话）；OpenCode 工作负载负责环境准备与**容器专用模型调用凭证**注入（前台用户模型/计费口径）。**统一存储与会话导入/导出二期交付**，后台管理面本期不做。

### 1.2 目标

- agent-api 新增前台云主机域：创建（命名 + harness）、列表、销毁；`HARNESS_ENABLED` 开关控制入口。
- 云主机 = 既有 `Controller`（`type='cloud'`）：预创建 `Controller` + `ControllerKey(type:'cloud')`，容器内 agent-gear 以 **2.5.0 云主机模式双连接**——`/worker`（cloud-controller：工作负载 init、shutdown）+ controller-api 标准连接（主机/会话/ACP）。
- `purpose=harness` 在 cloud-controller 内部 API 与 `ContainerService.start` 放开（admin GraphQL 本期不动，维持 `IDLE`）；启动请求携带 harness 选择与一次性 secrets（模型 Key、控制器 Key）。
- 预制「OpenCode（Harness）」工作负载（migration `005`）：固定版本安装 `@opencode/cli` 并硬校验、写 `opencode.jsonc` 注入 custom provider（网关端点 + 容器作用域 Key + 模型清单）。**本期无参数、无 post 脚本**（会话参数二期随统一存储交付）。
- 标准会话链路零改动：云主机上 `createSession` → `session:command acp:start`（`opencode acp`）；对话记录按既有 `acpmessages` 机制留档。
- 容器作用域模型 API Key：有效期 = 容器有效期、销毁即撤销；可用模型 = 用户个人模型列表；自定义模型不计费（网关代转发、凭据不出服务端）、系统模型计费入用户计费账户。
- 单元 / API（fetch 风格）/ E2E 测试与 worker 镜像自验文档同步更新；普通主机与后台存量能力零回归。

### 1.3 范围

**做**：

- agent-api 前台云主机域（GraphQL 契约 `contracts/cloud-host.graphql`）：`createCloudHost`（含命名）、`myCloudHosts`、`destroyCloudHost`。
- `Controller` 预创建（`type='cloud'`、`status='registering'`、用户命名）与云图标展示；销毁时清理 Controller/Key/模型 Key。
- agent-gear 2.5.0 云主机模式（双连接、不发 `unregister`、默认工作区、`harness prepare` 子命令写 `opencode.jsonc`）。
- cloud-controller：`purpose=harness` 放开、secrets 一次性下发与 env 注入（脱敏）、销毁撤销触发、harness 容器 agent-gear ≥2.5.0 门禁。
- 预制「OpenCode（Harness）」工作负载（migration `005`，init-only、无参数）。
- 容器作用域模型 Key（铸造、注入、到期失效、撤销三线幂等）。
- 计费网关容器 Key 分流（系统模型记账 / 自定义模型代转发不记账）。
- agent-web：Sidebar 云图标、「新建云主机」对话框（名称/harness）、云主机销毁与状态。
- worker 镜像（BUILD.md 校验清单）、`HARNESS_ENABLED` 开关。

**不做**：

- **统一存储（整体二期）**：S3 桶/MinIO、类 S3 CRUD+list API、`storageobjects`/`storageusages`/`storagetokens`、quota-guard 用量限额、user-path 目录体系、「我的存储」页与后台存储治理。
- **会话导入（二期）**：「恢复的会话」参数、已存会话查询 API、`opencode session import`、参数动态选项（`optionsSource`）。
- **会话导出（二期，随统一存储）**：「存储会话」参数、post 脚本 `opencode session list/export`、会话包上传与存储布局。
- 后台（admin-web/admin-api）harness 入口：启动对话框扩展、容器治理页 harness 过滤、后台模型口径（`adminStartCloudContainer` 维持仅 `IDLE`）——二期。
- 第二个 harness（Claude Code / Codex 等）——`harnessType` 白名单预留，本期仅 `opencode`。
- 云主机工作区内容持久化（随容器生命周期）。
- 计费口径变化（定价/账单/支付链路不动，仅新增容器作用域 Key 入口与转发规则）。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    AW[agent-web<br/>Sidebar 云图标 / 新建云主机 / 标准会话] -->|GraphQL| AA[agent-api<br/>cloud-host 域]
    AA -->|Mongoose| M[(MongoDB<br/>controllers / controllerkeys /<br/>cloudcontainers / billingapikeys)]
    AA -->|内部 HTTP + Bearer| CC[cloud-controller]
    AA -->|内部 HTTP| AD[admin-api<br/>internal-billing]
    CC -->|K8s Job| K[K8s]
    K --> W[worker Pod<br/>agent-gear 2.5.0 云主机模式]
    W -->|① Socket.IO /worker<br/>register / workload:run+env / workload:result / shutdown| CC
    W -->|② Socket.IO 标准连接<br/>register key=zag_k_cloud / heartbeat / acp:*| CA[controller-api]
    CA <-->|session:command acp:start| W
    CA -->|upsert Controller type=cloud| M
    W -->|OpenAI 兼容 /v1<br/>zag_sk_ 容器 Key| BG[计费网关 admin-api]
    BG --> M
    AA -.启动时.-> MIG[migration runner<br/>005-preset-harness-opencode]
```

关键边界：

- **云主机 = `Controller`（`type='cloud'`）**：`homeOverview.controllers`、`acpCapabilities`、`createSession` 全部零改动复用；agent-web 仅按 `type==='cloud'` 换图标 + 增加创建入口。
- agent-gear **双连接**：`/worker` 通道保留工作负载体系（init、必须失败、留档、shutdown）；标准通道承载主机/会话。两条通道互不感知，由 agent-gear 云主机模式统一编排。
- `cloudworkloads` 仍由 admin-api 写（migration 005 产物），cloud-controller 只读下发；harness 语义由预制工作负载（`workloadKind='harness'`、`harnessType`）承载。
- `cloudcontainers` 由 cloud-controller 写（单一事实源），新增 `userId`（属主前台用户）、`controllerKeyId`、`containerApiKeyId`。
- 模型 Key 由 admin-api 铸造与撤销（billing 域），cloud-controller 只传递（env）与触发撤销。
- 统一存储边界（二期）：本期不引入任何存储依赖；会话对话记录沿用既有 `acpmessages` 留档。

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React + TypeScript + Vite + Apollo Client | agent-web，复用 Sidebar/NewSessionDialog/对话框体系 |
| 后端 | Node.js + Express + GraphQL + Mongoose | agent-api（云主机域/主机预创建）、cloud-controller（生命周期/env/撤销）、admin-api（internal-billing） |
| Worker | Node.js（agent-gear 2.5.0） | 云主机模式（双连接）、harness prepare（`opencode.jsonc` 注入） |
| 数据库 | MongoDB | 复用共享实例；`cloudcontainers` 扩展 |
| 消息 | RabbitMQ | 沿用计费事件通道；`container.destroyed` 作为 Key 撤销兜底信号 |
| 协议 | GraphQL + 内部 HTTP + Socket.IO | 云主机/会话走 GraphQL；worker 双 Socket.IO |

### 2.3 模块划分

```mermaid
graph LR
    A[agent-web<br/>云图标/新建云主机] --> B[agent-api<br/>cloud-host resolver]
    B --> C[cloud-host service<br/>校验/凭据编排/主机预创建]
    B --> D[controller-key service<br/>cloud Key]
    B --> E[admin-api client<br/>internal-billing]
    B --> F[cloud-controller client<br/>purpose=harness]
    G[cloud-controller<br/>container-service + workload-dispatcher] --> H[agent-gear 2.5.0<br/>① /worker 生命周期 ② 标准主机连接]
    H --> I[controller-api<br/>register/acp/session 零改动]
    H --> J[harness prepare<br/>opencode.jsonc 注入]
    J --> K[计费网关<br/>模型转发/记账分流]
```

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| agent-api cloud-host service | 创建/销毁云主机、凭据编排 | 复用 controller-key/工作区服务；`HARNESS_ENABLED` 开关 |
| agent-api controller 预创建 | `Controller(type=cloud, registering, 用户命名)` + `ControllerKey(type=cloud)` | register upsert 兼容 `$setOnInsert`；销毁清理 |
| cloud-controller container-service | `purpose=harness` 生命周期、secrets→env、销毁撤销 | 放开校验、脱敏、harness 门禁（agent-gear ≥2.5.0） |
| cloud-controller workload-dispatcher | init 批次 + 容器级 `env` 下发 | `workload:run` 扩展 `env` |
| agent-gear 云主机模式 | 双连接编排、默认工作区、不发 unregister | 版本 2.5.0；`/worker` + 标准连接并存 |
| agent-gear harness prepare | `opencode.jsonc` 注入（custom provider） | 幂等合并配置、secret 不进日志 |
| admin-api internal-billing | 容器作用域 Key 铸造/撤销 | `scope`/`containerId`/`expiresAt` |
| admin-api billing-openai | 容器 Key 模型范围与转发/记账分流 | 自定义模型代转发不记账 |
| agent-web | 云图标、新建云主机对话框、销毁 | `type==='cloud'` 分支；复用对话框组件 |

## 3. API 设计

### 3.1 API 契约

新增：`contracts/cloud-host.graphql`。
扩展：`contracts/agent-controller.graphql`（语义澄清）、`contracts/agent-controller-websocket.md`（云主机注册约定）、`contracts/cloud-controller-websocket.md`（purpose/secrets/env/门禁）、`contracts/admin-billing.graphql`（Key scope）、`contracts/billing-openai.openapi.yaml`（容器 Key 分流）。
**不在本期改动**：`contracts/admin-cloud-container.graphql`（admin 启动维持仅 `IDLE`，二期再扩 `HARNESS`）；`contracts/admin-cloud-workload.graphql`（`optionsSource` 二期随会话参数交付）。
**二期新增（本期不建）**：`contracts/unified-storage.openapi.yaml`、`contracts/admin-unified-storage.graphql`。

#### 3.1.1 前台云主机（`contracts/cloud-host.graphql` 新增）

```graphql
# 云主机（harness 容器）前台契约
#
# 鉴权：Authorization: Bearer <user JWT>；未认证 UNAUTHENTICATED（`Not authenticated`）。
# 数据归属：
# - `controllers`/`controllerkeys`：agent-api 预创建（type=cloud），controller-api 注册时 upsert。
# - `cloudcontainers`：cloud-controller 持有（单一事实源），agent-api 经内部 HTTP 代理取数；
#   控制面不可达时列表降级只读落库状态（与 admin 侧容器列表降级模式一致）。
# - 服务端强制：云主机属主 = 当前用户；`HARNESS_ENABLED=false` 时全部入口返回
#   `harness feature is disabled`。
# - 二期扩展位：`storeSessions` / `restoreSessionIds`（会话存取）与统一存储查询届时追加。

enum CloudHostHarnessType { OPENCODE }

enum CloudHostStatus {
  PROVISIONING  # 创建中/容器启动中（Controller.status=registering）
  ONLINE        # 主机已注册在线
  OFFLINE       # 心跳丢失/已结束但记录保留
  DESTROYING
  EXITED
  FAILED
}

type CloudHost {
  id: ID!                       # = controllerId（主机同构展示的事实源）
  name: String!                 # 用户命名（= Controller.name）
  controllerId: ID!
  containerId: ID
  status: CloudHostStatus!
  harnessType: CloudHostHarnessType!
  createdAt: String!
  readyAt: String               # 首次在线
  exitedAt: String
  failureReason: String
}

input CreateCloudHostInput {
  name: String!                            # trim 后 1~64 字符，用户命名
  harnessType: CloudHostHarnessType!
}

type Query {
  myCloudHosts: [CloudHost!]!
}

type Mutation {
  createCloudHost(input: CreateCloudHostInput!): CloudHost!
  destroyCloudHost(id: ID!): Boolean!      # 幂等：终态重复调用返回 true
}
```

错误文案（逐字）：

| 条件 | 错误 |
|------|------|
| `HARNESS_ENABLED=false` | `harness feature is disabled` |
| `name` 为空/超长 | `name is required` / `name is too long` |
| `harnessType` 不在白名单 | `unsupported harness type` |
| 容器配额/并发超限（每用户并发云主机 ≤ 3） | `too many cloud hosts` |
| 控制面不可达（创建/销毁） | `control plane unavailable`（写不降级） |

#### 3.1.2 Controller 主机语义（`contracts/agent-controller.graphql` 澄清、`agent-controller-websocket.md` 约定）

- `ControllerType.cloud` 语义落地：agent-api 在创建云主机时**预创建** `Controller { type:'cloud', status:'registering', name:<用户命名>, keyId }`；容器内 agent-gear 以 `ControllerKey(type:'cloud')` 的 raw key 注册，controller-api `register` 的 `findOneAndUpdate({keyId}, {..., type: keyType, status:'online'}, {upsert:true})` 沿用——已存在文档时 `$setOnInsert.name` 不覆盖用户命名。
- 状态展示：`registering` → 前台「启动中」；`online`/`offline` 与普通主机同口径（心跳 60s 超时扫描沿用）。
- **云主机注册约定**（`agent-controller-websocket.md` 增补）：云主机模式下 agent-gear **不发送 `unregister`**（该事件会删除 Controller+Key，属本地卸载语义）；容器销毁由 agent-api `destroyCloudHost` 编排清理（Controller/Key 撤销），避免与心跳离线语义打架。
- 云图标：agent-web 按 `controller.type === 'cloud'` 渲染云图标（普通主机维持现状），无契约字段新增。

#### 3.1.3 模型调用凭证与计费分流（`admin-billing.graphql` / `billing-openai.openapi.yaml` 扩展）

`BillingApiKey` 扩展：`scope: BillingApiKeyScope { ACCOUNT CONTAINER }`、`containerId: ID`、`expiresAt: String`（scope=CONTAINER 时非空 = 容器有效期）。

计费网关语义（容器 Key）：

- 鉴权后追加：`scope=CONTAINER` 且（`expiresAt` 过期 **或** 关联容器已终态 **或** Key 已撤销）→ `401 invalid api key`。
- `GET /v1/models`：返回 Key 属主**个人可用模型列表**（启用的系统模型 + 其自定义模型）；后台口径（后台模型列表）本期不接入前台 Key，预留。
- `POST /v1/chat/completions`：
  - 命中**自定义模型** → 网关代转发到用户配置的端点（用户凭据留服务端、不进容器），**不产生计费记录**；
  - 命中**系统模型** → 既有计费链路（定价/预留/计量/记账），费用计入 Key 绑定的用户计费账户。

内部接口（`routes/internal-billing.ts` 扩展）：`POST /internal/billing/api-keys`（body 增 `scope`/`containerId`/`expiresAt`）、`POST /internal/billing/api-keys/:id/revoke`（幂等）。

### 3.2 内部接口

#### 3.2.1 agent-api → cloud-controller（`POST /internal/containers` 扩展）

```jsonc
{
  "purpose": "harness",                  // 新增允许值（idle | harness；其余沿用 400 UNSUPPORTED_PURPOSE）
  "refId": "<controllerKeyId>",          // 关联 ControllerKey，销毁清理用
  "userId": "<owner>",                   // 属主前台用户（计费口径来源）
  "harness": { "type": "opencode" },     // 一期无参数；二期追加 storeSessions/restoreSessionIds
  "workloadPlan": [ /* 自动展开 OpenCode（Harness）（init-only）+ 依赖项 */ ],
  "billingAccountId": "…",
  "secrets": {                            // 一次性下发，仅用于 env 注入，不落库明文
    "controllerEndpoint": "wss://<controller-api>",
    "controllerKey": "zag_k_1_…",         // ControllerKey(type=cloud) raw key
    "modelApiKey": "zag_sk_…"
  },
  "hostName": "<用户命名>",
  "agentGearMinVersion": "2.5.0"          // harness 容器专用门禁
}
```

- `secrets` 仅在创建请求中出现：cloud-controller 用于构建 `workload:run` 的 `env`，**不写入任何持久化**（日志/落库脱敏）。
- 新增 `GET /internal/containers?userId=`（agent-api 列表/状态代理）与既有 `DELETE /internal/containers/:id` 复用。

#### 3.2.2 cloud-controller → admin-api（撤销，幂等三线）

- `POST /internal/billing/api-keys/:id/revoke`。
- 触发线 1：容器终态（`exited`/`failed`/`destroy()` 完成）时撤销；线 2：`container.destroyed` 计费事件消费兜底；线 3：admin-api 定时对账扫描「容器已终态但 Key 仍 active」并撤销。

#### 3.2.3 Worker ↔ cloud-controller（Socket.IO `/worker` 扩展）

`workload:run` payload 增加容器级 `env`（对本容器全部脚本生效，区别于 `WORKLOAD_PARAM_*` 单条生效）：

```jsonc
{
  "phase": "init",
  "env": {
    "ZAG_HARNESS_TYPE": "opencode",
    "ZAG_CONTAINER_ID": "…",
    "ZAG_HOST_NAME": "<用户命名>",
    "ZAG_CONTROLLER_ENDPOINT": "wss://<controller-api>",
    "ZAG_CONTROLLER_KEY": "zag_k_1_…",
    "ZAG_DEFAULT_WORKSPACE": "/home/zag/workspace",
    "ZAG_USER_TYPE": "front_user",
    "ZAG_USER_ID": "…",
    "ZAG_MODEL_API_KEY": "zag_sk_…",
    "ZAG_MODEL_BASE_URL": "https://…/v1",
    "ZAG_MODEL_IDS": "model-1,model-2"
  },
  "items": [ /* 同现状 */ ]
}
```

- secret 值仅随下发报文存在，worker 内存持有并注入脚本进程环境；日志对 `ZAG_MODEL_API_KEY`/`ZAG_CONTROLLER_KEY` 统一 `***` 脱敏。
- 版本门禁：`MIN_WORKER_VERSION` **保持 `2.2.0`**（存量 idle 容器不受影响）；harness 容器按 `agentGearMinVersion=2.5.0` 单独门禁（`register` 携带的 `version` 不满足即拒绝并提示升级，沿用版本门禁流程）。

## 4. 数据模型

### 4.1 数据库设计

#### 集合: `controllers`（复用 + 约定）

| 字段 | 类型 | 说明 |
|------|------|------|
| type | string | 本期启用 `cloud`（枚举已存在）；云图标展示依据 |
| status | string | 预创建 `registering` → 注册后 `online` → 心跳超时 `offline` |
| name | string | 云主机 = 用户命名（预创建写入，register 不覆盖） |
| keyId | ref | 关联 `controllerkeys`（type=cloud）；销毁清理入口 |

#### 集合: `controllerkeys`（复用）

- `createControllerKey` 既有 `type` 字段落 `cloud`；raw key `zag_k_1_<48hex>` 注入容器 env `ZAG_CONTROLLER_KEY`；撤销沿用既有语义。

#### 集合: `cloudcontainers`（扩展）

| 字段 | 类型 | 说明 |
|------|------|------|
| purpose | string | 枚举扩展 `harness`（`CONTAINER_PURPOSES`） |
| userId | string | 属主前台用户（计费/会话口径来源），索引 |
| controllerKeyId | ObjectId | 关联 ControllerKey，销毁清理编排用 |
| harnessType | string \| null | `opencode` |
| containerApiKeyId | ObjectId \| null | 容器作用域模型 Key |

（二期追加：`harnessOptions {storeSessions, restoreSessionIds}`、`storageTokenId` 及统一存储相关集合。）

#### 集合: `controllerworkspaces`（复用）

- 云主机创建时预置默认工作区行 `{userId, controllerId, name:'workspace', path: $ZAG_DEFAULT_WORKSPACE, isEnabled:true}`，标准会话直接可用。

#### 集合: `billingapikeys`（扩展）

| 字段 | 类型 | 说明 |
|------|------|------|
| scope | string | `account`（现状）/ `container`，缺省 `account` |
| containerId | ObjectId \| null | scope=container 非空，索引 |
| expiresAt | Date \| null | = 容器有效期；`< now` 视同失效 |

#### 集合: `admin_migrations`（新增批次）

- `005-preset-harness-opencode`：预制工作负载「OpenCode（Harness）」（presetKey `harness-opencode`、`workloadKind='harness'`、`harnessType='opencode'`、`isPreset=true`、`paramSchema=[]`、仅 init 脚本），幂等不覆盖。

### 4.2 缓存设计

- 不引入新缓存：ACP 能力沿用既有 Redis 缓存（`acp:capability:*` 1h）。
- 计费网关模型列表判定沿用现有 pricing 查询；热点化后可加 60s 内存 TTL（后续项）。

## 5. 技术实现方案

### 5.1 核心流程

#### 5.1.1 新建云主机（端到端）

```mermaid
sequenceDiagram
    participant AW as agent-web
    participant AA as agent-api
    participant AD as admin-api
    participant CC as cloud-controller
    participant W as worker(agent-gear 2.5.0)
    participant CA as controller-api

    AW->>AA: createCloudHost{name, OPENCODE}
    AA->>AA: HARNESS_ENABLED / 名称与 harness 校验 / 并发数校验
    AA->>AD: POST /internal/billing/api-keys（scope=container, expiresAt）
    AA->>AA: createControllerKey(type=cloud) + 预创建 Controller(registering, 用户命名) + 默认工作区
    AA->>CC: POST /internal/containers {purpose:'harness', secrets, workloadPlan, agentGearMinVersion:2.5.0}
    CC->>CC: 落库 creating（userId/controllerKeyId/harnessType）→ issue token → K8s Job
    W->>CC: ① /worker register（workload 通道）
    CC->>W: workload:run(init, env=ZAG_*, items=[OpenCode init])
    W->>W: npm i -g @opencode/cli@pin（幂等）+ opencode --version 硬校验
    W->>W: agent-gear harness prepare → 写 opencode.jsonc（custom provider）
    W->>CA: ② 标准连接 register（key=ZAG_CONTROLLER_KEY）→ Controller upsert status=online
    W->>CA: 上报默认工作区/ACP 能力（既有机制）
    CC-->>AA: 状态流转 ONLINE
    AW->>AA: myCloudHosts（homeOverview 含该主机，云图标）
    AW->>CA: createSession(controllerId, opencode, workspaceId)  —— 标准会话
    CA->>W: session:command acp:start（opencode acp）—— 零改动复用
```

#### 5.1.2 启动计划展开（harness 版）

1. agent-api 把预制「OpenCode（Harness）」自动加入 `workloadPlan`；本期该工作负载**无参数**（`paramSchema=[]`）。
2. 其余工作负载一期不开放给前台用户（云主机 = harness 单主体）；依赖展开沿用 `workload-plan` 逻辑（harness 预制项可带依赖，如 Node.js 环境）。
3. 执行序：被依赖项 → OpenCode（Harness）；`required=true`（主体硬失败，沿用工作负载三期语义）。
4. 二期接入会话参数时：`store_sessions`/`restore_session_ids` 归一进 `workloadPlan` 参数，并追加 `optionsSource` 动态选项（本期不实现）。

#### 5.1.3 云主机模式（agent-gear 2.5.0 双连接）

```mermaid
stateDiagram-v2
    [*] --> Worker连接: ① /worker register（工作负载/生命周期）
    [*] --> 标准连接: ② register key=cloud Key（主机/会话）
    Worker连接 --> Init批次: workload:run(init)
    Init批次 --> 就绪: 成功（注册/刷新 ACP 能力）
    Init批次 --> 失败: required 失败（硬失败注销）
    就绪 --> 退出: shutdown / 销毁（本期无 post 批次）
    标准连接 --> 会话服务: acp:start / acp:check / heartbeat
```

- 两条 Socket.IO 连接并存于同一 agent-gear 进程（新增 supervisor 编排）：`/worker` 沿用现状；标准连接沿用 `connectToServer(controller-api, cloudKey)` 与既有 ACP/会话事件。
- **不发送 `unregister`**（避免删除 Controller/Key）；进程退出后心跳超时 → `offline`。
- 默认工作区：`ZAG_DEFAULT_WORKSPACE` 目录在 init 时创建，注册后经既有工作区机制上报（agent-api 已预置 `ControllerWorkspace` 行，路径一致即可）。
- 本期无 post 脚本；会话导出二期随统一存储接入（`harness persist` 预留不实现）。

#### 5.1.4 云主机销毁

```mermaid
sequenceDiagram
    participant AW as agent-web
    participant AA as agent-api
    participant CC as cloud-controller
    participant W as worker(agent-gear)
    participant AD as admin-api

    AW->>AA: destroyCloudHost(id)
    AA->>CC: DELETE /internal/containers/:id
    CC->>W: shutdown（宽限期后退出；本期无 post 批次）
    CC->>CC: 容器终态
    CC->>AD: revoke 模型 Key（幂等）
    AA->>AA: 清理 Controller + ControllerKey（保留容器留档）
    AW->>AA: myCloudHosts（该主机转 EXITED，历史可追溯）
```

- 销毁编排幂等（重复调用返回 true）；Key 撤销三线兜底（§3.2.2）。

#### 5.1.5 OpenCode 配置注入（custom provider，`opencode.jsonc`）

`agent-gear harness prepare` 写 `~/.config/opencode/opencode.jsonc`（存在则合并 `provider.zag`，不动其他配置），格式按 https://opencode.ai/v2/docs/providers/#custom：

```jsonc
{
  "provider": {
    "zag": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ZAG Model Gateway",
      "options": { "baseURL": "<ZAG_MODEL_BASE_URL>", "apiKey": "<ZAG_MODEL_API_KEY>" },
      "models": { "<modelId>": { "name": "<displayName>" } }
    }
  }
}
```

- `models` 取 `ZAG_MODEL_IDS`（启动时按用户个人模型列表生成快照）。
- 自定义模型不计费：容器内统一走 `zag` provider，网关按模型归属分流；用户自定义模型真实端点与凭据保存在服务端。
- Key 有效期 = 容器有效期：`expiresAt` 取 Job `activeDeadlineSeconds` 对应时刻；销毁撤销兜底。

### 5.2 关键实现点

#### 实现点 1: 前台云主机域（agent-api）

- **描述**: 新增 `graphql/schemas/cloud-host.ts` + `services/cloud-host-service.ts`：`createCloudHost/myCloudHosts/destroyCloudHost`；`HARNESS_ENABLED`（`toBool` 模式）关闭时全部入口 `harness feature is disabled`。
- **技术细节**: 创建编排顺序（Key 铸造 → Controller 预创建 → 内部启动）；任一步失败回滚已铸凭据（幂等撤销）；列表经 cloud-controller 内部 API 取容器状态，控制面离线降级只读落库（与既有容器列表降级同构）。
- **风险点**: 并发创建限额（≤3/用户）与重复点击幂等；`CreateCloudHostInput` 二期追加会话参数时保持向后兼容。

#### 实现点 2: Controller 预创建与云图标呈现（agent-api / agent-web）

- **描述**: agent-api 复用 `controller-key.ts` 的 `create()`（`type:'cloud'`）与 `Controller` 预创建（`status='registering'`、`name`=用户命名）；`register` upsert 沿用（`$setOnInsert.name` 不覆盖）；销毁清理 Controller+Key。agent-web Sidebar 按 `type==='cloud'` 渲染云图标 + 「新建云主机」入口。
- **技术细节**: `homeOverview.controllers` 自动包含（零改动）；`registering` 状态在 Sidebar 展示「启动中」样式；`NewSessionDialog` 对 `registering` 主机隐藏（就绪后可选）。
- **风险点**: 既有 `GenerateKeyDialog`/`ControllerListSection` 硬编码 `type:'local'` 保持不动（云主机不走手工 Key 流程）；`unregister` 语义仅本地卸载，云主机不发。

#### 实现点 3: agent-gear 2.5.0 云主机模式（packages/agent-controller）

- **描述**: 新增 `src/cloud-host/supervisor.ts`（双连接编排）、`src/harness/prepare.ts`（`opencode.jsonc` 注入）、`src/cli/harness.ts`（`agent-gear harness prepare`）；`CONTROLLER_VERSION='2.5.0'`。
- **技术细节**: 双连接互不阻塞；`/worker` 通道事件沿用；标准连接复用 `connectToServer`；不发 `unregister`；`harness prepare` 幂等合并 provider 配置、secret 脱敏。
- **风险点**: 双连接断线重连互不干扰；`opencode.jsonc` 已存在用户配置时合并而非覆盖。

#### 实现点 4: purpose=harness 全链路（cloud-controller）

- **描述**: `routes/internal-api.ts` / `container-service.ts` 放开为白名单 `idle|harness`（其余维持 `UNSUPPORTED_PURPOSE`「该任务类型暂未开放」）；`CONTAINER_PURPOSES` 扩展 `harness`；secrets 一次性下发 → `workload:run env`；销毁触发撤销；harness 容器 `agentGearMinVersion=2.5.0` 门禁。**admin GraphQL 不动**（维持 `IDLE`）。
- **技术细节**: `cloudcontainers` 新字段落库快照；secret 脱敏 helper 统一；`buildServerEndpoint` 沿用。
- **风险点**: 存量 idle 流程回归（门禁保持 `MIN_WORKER_VERSION=2.2.0`）；secrets 出现在错误路径日志的风险（脱敏单测）。

#### 实现点 5: 预制「OpenCode（Harness）」工作负载（admin-api migration 005）

- **描述**: 写入 `name='OpenCode（Harness）'`、`presetKey='harness-opencode'`、`workloadKind='harness'`、`harnessType='opencode'`、`paramSchema=[]`、仅 init 脚本（见 §5.3）。幂等不覆盖。
- **技术细节**: 固定版本安装 `npm install -g @opencode/cli@<pin>` + `opencode --version` 硬校验（镜像未预装，必须安装）；随后 `agent-gear harness prepare` 注入模型配置。
- **风险点**: 安装源可达性（内部 registry/代理沿用既有工作负载下载口径）；「安装返回 0 但不可用」必须被硬校验拦截。

#### 实现点 6: 容器作用域模型 Key（admin-api / cloud-controller）

- **描述**: `api-key-service` 增加 `createContainerScopedKey` / `revoke`（幂等）；三线撤销兜底（§3.2.2）。
- **技术细节**: 明文仅铸造时返回一次；`expiresAt` 由 cloud-controller 按 Job `activeDeadlineSeconds` 回传；secret 全链路脱敏。
- **风险点**: 撤销幂等（重复撤销/先撤销后到期）；`expiresAt` 双端一致。

#### 实现点 7: 计费网关分流（前台口径）

- **描述**: `routes/billing-openai.ts` 鉴权后解析 Key 属主；容器 Key `/v1/models` 按**用户个人模型列表**返回；`/v1/chat/completions` 自定义模型→服务端代转发不记账、系统模型→既有计费链路。
- **技术细节**: 自定义模型 ID 判定沿用 `llm` 域口径（属主自定义优先，冲突记日志）；SSE 流式透传保持语义；不记账路径不产生 MeteringRecord/outbox。
- **风险点**: 代转发超时/错误映射；用户凭据不出服务端的约束单测。

#### 实现点 8: agent-web 云主机体验

- **描述**: Sidebar 云图标（`type==='cloud'`）+「新建云主机」入口；`NewCloudHostDialog`（名称必填、harness 选择）；云主机详情（状态/销毁确认）。
- **技术细节**: 复用 `homeOverview` 数据流（子组件不自建信息流查询）；`registering` 展示「启动中」；销毁二次确认；二期在对话框追加「存储会话/恢复的会话」参数区与「我的存储」页。
- **风险点**: 移动端布局回归（沿用响应式组件）；命名长度校验前后端一致。

### 5.3 预制脚本（migration 内置，示意）

#### OpenCode（Harness）init 脚本（本期唯一脚本，无 post 脚本）

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1) 安装/校验 OpenCode CLI（镜像未预装，固定版本幂等安装）
if ! command -v opencode >/dev/null 2>&1; then
  npm install -g "@opencode/cli@${OPENCODE_CLI_PIN:-pin}"
fi
opencode --version   # 必须校验成功，避免「安装返回 0 但不可用」

# 2) 默认工作区 + 模型配置注入（opencode.jsonc，custom provider）
agent-gear harness prepare
```

> 需求原文写作 `npm install -g @opencode-cli`；官方包名为 `@opencode/cli`（worker 镜像当前**未预装**，由本脚本固定版本安装），见 §6.1 决策 3。
> 二期追加 post 脚本（`opencode session list/export` 写统一存储）与会话参数时，本脚本保持向后兼容扩展。

## 6. 技术决策

### 6.1 决策列表

| # | 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|---|------|--------|--------|---------|------|
| 1 | 交付面 | 后台 admin-web 启动 | 前台 agent-web 自助创建 | B | 需求重构：直接呈现在 agent-web，后台本期不做 |
| 2 | 云主机建模 | 新建「CloudHost」实体与页面 | 复用 `Controller`（`type='cloud'`，枚举已存在） | B | 「界面与正常主机一致」零成本达成；会话/ACP 零改动 |
| 3 | OpenCode 安装 | `@opencode-cli`（需求原文） | `@opencode/cli` 固定版本安装 | B | 官方包名；镜像未预装，需幂等安装 + `opencode --version` 硬校验 |
| 4 | harness 载体 | 平台代码写死 harness 流程 | 预制「harness 类型」工作负载（presetKey） | B | 复用工作负载留档/必须失败体系 |
| 5 | worker 通道 | 仅标准连接（controller-api） | 双连接（`/worker` + 标准连接） | B | 保留工作负载 init/留档/shutdown 体系，会话走标准通道；单连接需重构 controller-api 生命周期，风险大 |
| 6 | 主机命名 | register 携带 name | agent-api 预创建 `Controller(name, registering)` | B | 创建即出现在主机列表（启动中），register upsert 不覆盖命名；契约零改动 |
| 7 | 云主机清理 | 发 `unregister`（删 Controller+Key） | 不发 unregister，销毁时编排清理 | B | `unregister` 是本地卸载语义；云主机保留状态留档、由 `destroyCloudHost` 统一清理 |
| 8 | 版本门禁 | 提升 `MIN_WORKER_VERSION` | 保持 2.2.0 + harness 专用 2.5.0 门禁 | B | 存量 idle 容器零影响；harness 能力按需门禁（agent-gear 2.5.0） |
| 9 | 模型 Key 铸造 | admin-api 铸造（billing 域） | agent-api/cloud-controller 自铸 | A | 计费域唯一写入方；cloud-controller 仅传递与触发撤销 |
| 10 | Key 失效 | 仅 expiresAt | 仅销毁撤销 | 两者叠加 | 「有效期=容器有效期」需到期硬失效 + 销毁立即失效 |
| 11 | 自定义模型调用 | 注入用户端点/凭据进容器 | 网关代转发，凭据留服务端 | B | 用户凭据不落容器；网关统一决定计费与否 |
| 12 | 统一存储与会话存取 | 一期交付 | 二期交付 | B | 需求裁剪：统一存储本期不做、会话导入暂不做（导出随存储一并二期） |
| 13 | 会话留档 | 自建会话留档 | 既有标准会话消息留档（`acpmessages`） | B | 对话记录本就服务端留档；跨容器会话迁移二期随统一存储 |
| 14 | 本期工作负载参数 | 预留空参数 | `paramSchema=[]` 二期再加 | B | 会话参数依赖统一存储，避免空壳参数 |
| 15 | 配置文件 | `opencode.json` | `opencode.jsonc` | B | 与当前 opencode CLI 约定一致（注释友好），按实测落地 |
| 16 | 功能开关 | 无开关 | `HARNESS_ENABLED`（agent-api，toBool） | B | 灰度与回滚；沿用 cloud-controller `toBool` 模式 |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | 主机/会话/ACP 体系（Controller、homeOverview、createSession） | 云主机零改动复用 |
| 依赖 | 工作负载体系（参数/依赖/留档/必须失败） | 20261017/20261018 已交付 |
| 依赖 | 费用中心（账户/API Key/计费网关/事件） | 20261018 已交付；扩展 Key 模型 |
| 依赖 | 模型列表（用户可用模型/自定义模型） | 前台口径 |
| 约束 | 一期仅 `opencode` harness | `SUPPORTED_HARNESS_TYPES` 白名单 |
| 约束 | 后台本期不做 | admin 契约/页面零改动（`IDLE` 维持） |
| 约束 | 统一存储/会话导入导出本期不做 | 二期；本期不引入 S3/MinIO 依赖与存储契约 |
| 约束 | secret 不落库、不进日志 | env 注入 + 脱敏 + 一次性下发 |
| 约束 | 每用户并发云主机 ≤ 3 | 保护配额 |
| 约束 | agent-gear 2.5.0；`MIN_WORKER_VERSION` 保持 2.2.0 + harness 专用门禁 | 存量零影响 |

## 7. 项目结构

```
contracts/
├── cloud-host.graphql                   # 新增：前台云主机
├── agent-controller.graphql             # 澄清：type=cloud 语义（无字段新增）
├── agent-controller-websocket.md        # 增补：云主机注册约定（不发 unregister）
├── cloud-controller-websocket.md        # 扩展：purpose=harness、secrets、workload:run env、门禁
├── admin-billing.graphql                # 扩展：scope/containerId/expiresAt + revoke
└── billing-openai.openapi.yaml          # 扩展：容器 Key 模型范围与分流

servers/agent-api/src/
├── graphql/schemas/cloud-host.ts        # 新增：前台云主机 resolver
├── services/cloud-host-service.ts       # 新增：创建/销毁编排、凭据回滚
├── services/cloud-controller-client.ts  # 新增：内部 HTTP 客户端
└── services/controller-key.ts           # 复用：type=cloud

servers/admin-api/src/
├── routes/internal-billing.ts           # 扩展：scope 铸造 + revoke
├── services/billing/api-key-service.ts  # 扩展：容器作用域 Key
├── routes/billing-openai.ts             # 扩展：分流（自定义不记账）
└── migrations/005-preset-harness-opencode.ts  # 新增（init-only）

servers/cloud-controller/src/
├── routes/internal-api.ts               # 放开 purpose、secrets
├── services/container-service.ts        # 放开 purpose、落库快照、销毁撤销、2.5.0 门禁
├── services/workload-dispatcher.ts      # workload:run env 注入
└── models/cloud-container.ts            # userId/controllerKeyId/harnessType/containerApiKeyId

packages/agent-controller/src/           # agent-gear 2.5.0
├── cloud-host/supervisor.ts             # 新增：双连接编排（不发 unregister）
├── harness/prepare.ts                   # 新增：opencode.jsonc 注入
└── cli/harness.ts                       # 新增：agent-gear harness prepare

apps/agent-web/src/
├── components/Sidebar.tsx               # 云图标 + 新建云主机入口
├── components/cloud-host/NewCloudHostDialog.tsx  # 新增
└── pages/…                              # 云主机详情/销毁

deploy/images/worker/                    # BUILD.md 校验清单（opencode 固定版本）
tests/api / tests/e2e                    # 见 §8（fetch 风格 API 测试）
```

（二期新增：`contracts/unified-storage.openapi.yaml`、`servers/admin-api/src/services/storage/`、`models/storage-*.ts`、agent-gear `harness/persist.ts` + `storage-client.ts`、agent-web「我的存储」。）

## 8. 测试策略

### 8.1 测试覆盖要求

- 单元测试覆盖率 ≥ 80%（cloud-host-service、容器 Key、agent-gear cloud-host/harness prepare）。
- API 测试覆盖全部新增/扩展端点（`tests/api`，**fetch 风格**，跑在 Aspire 真实服务上）：`createCloudHost` 全错误文案矩阵、`myCloudHosts/destroyCloudHost` 幂等、容器 Key 401/模型范围、自定义模型不记账、`HARNESS_ENABLED` 开关。
- E2E 覆盖 agent-web 云主机完整体验（新建命名、云图标、ACP 列表、标准会话、销毁确认）。

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元 | vitest | Key 铸造/到期/撤销幂等、cloud-host 编排回滚、harness prepare（mock opencode.jsonc 合并）、双连接 supervisor |
| API | vitest + fetch（tests/api） | GraphQL 云主机矩阵、计费网关分流、内部 revoke、register upsert 命名保留 |
| 集成 | vitest（cloud-controller） | purpose=harness 生命周期、env 注入脱敏、销毁撤销、2.5.0 门禁、MIN_WORKER_VERSION 2.2.0 回归 |
| E2E | Playwright（tests/e2e） | 新建云主机对话框（命名必填）、Sidebar 云图标与启动中状态、标准会话创建（opencode）、销毁流程 |
| 自验 | worker 镜像 BUILD.md | `@opencode/cli@pin` 安装、`opencode --version`、`opencode.jsonc` 注入后可调网关 |

### 8.3 回归

- 既有 `idle` 启动（admin 后台）、工作负载体系、计费全链路、普通主机/标准会话全绿。
- Sidebar/主机界面对普通主机零视觉与行为变化；后台 admin-web 零改动。
- 存量 `controllers`（type=local）展示不受影响。

## 9. 部署方案

### 9.1 环境规划

| 环境 | 用途 | 部署方式 |
|------|------|---------|
| 本地/Aspire | 开发联调 | 既有编排（mongodb/redis/rabbitmq），无新增资源 |
| Docker Compose | 交付验证 | aspire publish 产物无新增服务 |
| K8s（生产） | 云主机容器 | agent-api 新增 `HARNESS_ENABLED` 等 env；无存储依赖 |

### 9.2 配置管理

| 配置 | 说明 | 默认 |
|------|------|------|
| `HARNESS_ENABLED` | agent-api 云主机功能开关 | `false`（灰度开） |
| `OPENCODE_CLI_PIN` | `@opencode/cli` 安装版本 | 固定 pin（BUILD.md 锁定） |
| `CLOUD_HOST_MAX_PER_USER` | 每用户并发云主机上限 | `3` |
| `HARNESS_INIT_TIMEOUT_MS` | harness init 预算 | 沿用 `WORKLOAD_INIT_TIMEOUT_MS` |

### 9.3 发布顺序

1. 契约合入（contract-first）。
2. admin-api（Key 扩展 + migration 005 + 分流）。
3. cloud-controller（purpose/env/撤销/门禁）→ agent-gear 发版 **2.5.0** → worker 镜像重建（BUILD.md 校验）。
4. agent-api（云主机域）→ agent-web（云图标/对话框）。
5. 灰度：`HARNESS_ENABLED=true` 按用户放开；回滚 = 关开关（云主机存量按生命周期自然收敛）。

## 10. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract 评审通过（新增 1 份 + 扩展 5 份；admin-cloud-container/admin-cloud-workload 零改动）
- [ ] 前台可命名新建云主机；名称/harness 必填校验、`HARNESS_ENABLED` 开关生效
- [ ] 云主机出现在左侧导航栏：云图标、名称=用户命名、状态口径与普通主机一致；界面与普通主机一致（支持的 Harness 工具（ACP）列表含 OpenCode）
- [ ] 云主机上创建的会话即标准「会话」，对话/模式/模型/历史消息与普通主机一致，消息按既有机制留档
- [ ] OpenCode 环境开箱即用：固定版本安装 + `opencode --version` 硬校验、`opencode.jsonc` 注入成功
- [ ] 容器作用域 Key：有效期=容器有效期、销毁立即失效、明文不落库不进日志
- [ ] 计费：系统模型计费入用户账户、自定义模型不计费；可用模型=用户个人模型列表
- [ ] 本期无任何统一存储/会话导入导出入口与依赖（S3/MinIO 不引入）
- [ ] 后台零改动：admin 启动维持仅 `IDLE`，admin-web 无新增入口
- [ ] 单元/API/E2E 全绿，既有回归全绿（普通主机/会话/计费/idle）
- [ ] worker 镜像自验（opencode 固定版本安装/校验）与发布顺序、灰度开关就绪

## 11. 相关文档

- [[../../product/draft/20261020-container-harness-support.md]] — 本期 PRD（v3.0）
- [[20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败）
- [[20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）
- [[20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- contracts/：`cloud-host.graphql`、`agent-controller.graphql`、`agent-controller-websocket.md`、`cloud-controller-websocket.md`、`admin-billing.graphql`、`billing-openai.openapi.yaml`
- OpenCode custom provider：https://opencode.ai/v2/docs/providers/#custom
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
