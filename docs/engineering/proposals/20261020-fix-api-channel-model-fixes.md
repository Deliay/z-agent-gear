---
description: 内建 API 渠道一期上线后问题修复技术提案：供应商模型手动导入（listGlobalProviderModels/importGlobalModels）、模型按供应商分组折叠（前台「系统内置」）、deleteGlobalModel、模型名全局唯一（重名检查 + 迁移 005 + 重名整理记录）
type: Permanent
---

# 内建 API 渠道一期上线后问题修复（供应商与模型管理）- 技术提案

**功能名称**: 内建 API 渠道供应商与模型管理优化
**关联 PRD**: `docs/product/draft/20261020-api-channel-model-fixes.md`
**技术提案版本**: v1.1
**创建日期**: 2026-10-20
**作者**: ZeroAsh
**feat-branch**: `fix/api-channel-model-fixes`
**版本说明**:
- v1.0（2026-10-20）初版。
- v1.1（2026-10-20，返工修订，对齐 PRD v1.1）① **agent-api 用户侧自动同步保留**：`syncSyncedModels` 不动，仅后台取消自动导入，§5.2 实现点 1 明确 admin/agent 两侧行为差异（对应打回项 1）；② **会话内「切换模型」分组移出范围**：核实 `packages/agent-controller/src/acp/bridge.ts` `extractConfigModels`（L168-178）与 `SessionConfigOptionData.options`（L33，仅 `{value, name}`）不产出 provider，探测链路无来源字段可透传，强行分组会退化为单组，改为保持现状并把「ACP 侧补来源字段」列为后续需求（对应打回项 2）；③ **重名整理记录持久化**：新增 `model_rename_records` 集合 + `modelRenameRecords` 后台查询 + 后台只读「重名整理记录」视图，作为改名对照的可查询核对载体（对应打回项 3）。

## 1. 概述

### 1.1 背景

内建 API 渠道一期（供应商/模型管理 + 计费网关）上线后暴露四个问题，与 PRD §1.1 一一对应，均落在「模型清单怎么来、怎么展示、怎么删、怎么保证唯一」四条线上：

```mermaid
graph TD
    A[admin-web 模型配置页] -->|createGlobalProvider| B[admin-api ProviderService.create]
    B -->|现状：连通性测试即拉全量模型| C[LLMAPIService.fetchModels]
    C -->|Model.insertMany 全量落库| D[(models 集合)]
    E[admin-web 可用模型<br/>平铺列表] -->|仅自定义模型可删| D
    F[agent-web 设置-可用模型] -->|直接展示 model.provider.name| D
    G[计费网关 billing-openai] -->|Model.findOne scope=global + name| D
    style B fill:#f66,color:#fff
    style E fill:#f66,color:#fff
    style F fill:#f66,color:#fff
    style G fill:#f66,color:#fff
```

现状代码事实：

1. **自动导入**：`servers/admin-api/src/services/provider.ts` `create()`（L139 `fetchModels` 连通性校验 → L165-190 `Model.insertMany` 全量导入）；`update()`（L226 `needsResync` → L232 重拉、L279-315 upsert + 删除陈旧模型）。前端 `apps/admin-web/src/components/models/ModelSection.tsx:165` 文案「添加供应商后自动拉取」。
2. **平铺展示 + 暴露供应商名**：`apps/admin-web/src/components/models/ModelSection.tsx`（`DndContext` 平铺列表）、`apps/agent-web/src/components/settings/ModelSection.tsx` / `ModelItem.tsx:81-83`（`{model.provider.name}` 原样展示供应商）。
3. **删不掉**：`servers/admin-api/src/services/model.ts` `delete()` L54-64 `if (!model.isCustom) return null;`；前端删除按钮仅 `model.isCustom` 时渲染（`ModelItem.tsx:73-83`）。导入模型只能禁用或随供应商删除。
4. **重名**：`models` 集合仅 `{providerId, name}` 唯一（`servers/admin-api/src/models/model.ts:26`），跨供应商可同名；而计费网关按 `Model.findOne({ scope: 'global', name, isEnabled: true })` 寻址（`servers/admin-api/src/routes/billing-openai.ts:195`），同名即路由不确定。

### 1.2 目标

- **仅后台**：供应商创建/更新**不再自动导入或同步模型**；新增「导入模型」手动导入链路（拉取上游清单 → 勾选 → 导入）。agent-api 用户侧供应商自动同步（`syncSyncedModels`）**保留不动**，两侧行为差异显式声明（§5.2 实现点 1、§6.1）。
- 后台与前台「可用模型」列表按供应商分组、默认折叠；前台后台来源模型统一显示「系统内置」。会话内「切换模型」列表保持现状（不参与分组，理由见 §5.2 实现点 3）。
- 后台可用模型支持删除任意模型（含导入模型），契约语义从「仅自定义」演进为「任意」。
- 后台模型名全局唯一（`scope=global` 内跨供应商唯一）：写入路径重名检查 + 数据库唯一索引兜底 + 存量重名一次性迁移整理，改名对照持久化为后台可查的「重名整理记录」。

### 1.3 范围

**做**：

- `admin-api`：新增 `listGlobalProviderModels` / `importGlobalModels` / `deleteGlobalModel` / `modelRenameRecords`；`create/updateGlobalProvider` 移除自动导入与重同步；模型写入路径统一重名检查；迁移 005（存量重名整理 + 部分唯一索引 + 改名记录落库）。
- `admin-web`：供应商「导入模型」弹窗；可用模型分组折叠；全量删除；重名即时校验；「重名整理记录」只读视图。
- `agent-web`：设置「可用模型」分组折叠 +「系统内置」展示。
- `contracts/admin-llm.graphql` 同步演进；测试覆盖（单测 / tests/api / tests/e2e）。

**不做**：

- 不改 `agent-api` 用户侧供应商/模型管理：用户添加供应商仍自动同步模型（`services/provider.ts` `syncSyncedModels`（create L69、update L142）保留），自定义模型仍按供应商内唯一，行为完全不变（PRD §4.3/§5.2 约束）。
- 不做会话内「切换模型」分组：该列表数据来自 ACP 探测的 configOptions，条目仅 `{id, name}`（`packages/agent-controller/src/acp/bridge.ts` `SessionConfigOptionData.options` L33、`extractConfigModels` L168-178），**不携带供应商/来源字段**，无法实现有意义的供应商分组；「ACP 侧补充模型来源字段」作为后续独立需求（见 §5.2 实现点 3、§6.1）。
- 不做模型改名/编辑能力；不做供应商级的前台分组（前台统一「系统内置」）。
- 不改计费网关寻址规则（`billing-openai.ts` 维持按模型名寻址，本期通过「名字唯一」使其确定）。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    subgraph 前端
        AW[admin-web<br/>模型配置页/导入弹窗]
        UW[agent-web<br/>设置-可用模型]
    end
    subgraph 后端
        AA[admin-api GraphQL<br/>provider/model resolvers]
        UA[agent-api GraphQL<br/>models 查询]
        LLM[LLMAPIService<br/>fetchModels]
        MIG[迁移 005<br/>重名整理+改名对照+唯一索引]
    end
    UP[上游供应商<br/>OpenAI/Anthropic 兼容 /models]
    DB[(MongoDB<br/>providers / models)]
    GW[计费网关 billing-openai<br/>按模型名寻址]

    AW -->|listGlobalProviderModels / importGlobalModels / deleteGlobalModel| AA
    AW -->|createGlobalProvider 不再自动导入| AA
    AA --> LLM --> UP
    AA --> DB
    UW -->|models / providers| UA --> DB
    MIG --> DB
    GW --> DB
```

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React + TypeScript + Vite（@base-ui/react + Tailwind、@dnd-kit、@apollo/client） | 后台 admin-web、前台 agent-web，沿用现有组件风格，不新增依赖 |
| 后端 | Node.js + Express + GraphQL（code-first SDL）+ Mongoose | admin-api 写全局配置；agent-api 读用户可见模型 |
| 数据库 | MongoDB | `providers` / `models` 集合；新增 partial unique index |
| 上游 | OpenAI / Anthropic 官方 SDK `models.list()` | 复用 `LLMAPIService.fetchModels`（10s 超时） |
| 测试 | vitest + supertest（tests/api）、Playwright（tests/e2e） | 沿用现有测试栈 |

### 2.3 模块划分

```mermaid
graph LR
    P[ProviderSection<br/>供应商区] --> I[ImportModelsDialog<br/>导入模型弹窗]
    I --> R[admin-api resolvers]
    R --> S[ProviderService / ModelService]
    S --> L[LLMAPIService]
    S --> DB[(models/providers)]
    M[ModelSection + ModelGroup<br/>可用模型分组] --> R
    U[agent-web ModelSection<br/>系统内置分组] --> UR[agent-api models 查询]
```

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| `admin-web` `ProviderSection` / `ProviderActionMenu` | 供应商管理 +「导入模型」入口 | 移除「自动拉取」文案；操作菜单新增导入项 |
| `admin-web` `ImportModelsDialog`（新增） | 拉取上游清单、勾选、导入 | `listGlobalProviderModels` + `importGlobalModels`；已导入/已存在禁选；全选/过滤/重试 |
| `admin-web` `ModelSection` + `ModelGroup`（新增）/ `ModelItem` | 分组折叠、删除、重名校验 | 按 `providerId` 分组；`@dnd-kit` 组内排序；删除不限 `isCustom` |
| `admin-api` `services/provider.ts` | 供应商增删改 | `create/update` 保留连通性校验、移除自动导入/重同步 |
| `admin-api` `services/model.ts` + `services/llm-api.ts` | 模型写入/删除/清单拉取 | 统一重名检查 `assertNamesAvailable`；`delete()` 放开 `isCustom` 限制 |
| `admin-api` `migrations/005-model-name-unique-global` | 存量重名整理 + 唯一索引 | 幂等；改名对照逐条写入 `model_rename_records` |
| `admin-api` `ModelRenameRecord`（新增）+ Query `modelRenameRecords` | 改名对照的持久化核对载体 | 迁移写入、后台只读查询 |
| `agent-api` `services/provider.ts` | 用户侧供应商管理（**不动**） | `syncSyncedModels`（create L69、update L142）保留，用户添加供应商仍自动同步 |
| `agent-web` `settings/ModelSection` / `ModelItem` | 分组折叠 +「系统内置」 | `scope === 'global'` 归并「系统内置」组；折叠复用既有手写模式 |

## 3. API 设计

### 3.1 API 契约

契约变更集中在 `contracts/admin-llm.graphql`（用户侧 `contracts/llm.graphql` 不变）。

#### 变更 1: Query `listGlobalProviderModels` — 拉取供应商上游模型清单

- **请求**（GraphQL Query）

  ```graphql
  listGlobalProviderModels(providerId: ID!): [ProviderModelOption!]!
  ```

  ```json
  { "query": "query($id: ID!) { listGlobalProviderModels(providerId: $id) { name isImported isDuplicate } }", "variables": { "id": "665f...c2a" } }
  ```

- **响应**

  ```json
  {
    "data": {
      "listGlobalProviderModels": [
        { "name": "gpt-4o", "isImported": true, "isDuplicate": false },
        { "name": "o3-mini", "isImported": false, "isDuplicate": true }
      ]
    }
  }
  ```

  ```graphql
  type ProviderModelOption {
    name: String!        # 上游模型名
    isImported: Boolean! # 该供应商下已导入（(providerId, name) 已存在）
    isDuplicate: Boolean! # 已被其他供应商模型占用（全局唯一冲突，禁止导入）
  }
  ```

- **错误**：`PROVIDER_CONNECTIVITY_ERROR`（连通性/凭据失败，沿用现有文案语义，仅校验不落库）、`PROVIDER_NOT_FOUND`。

#### 变更 2: Mutation `importGlobalModels` — 按勾选导入模型

- **请求**

  ```graphql
  importGlobalModels(providerId: ID!, names: [String!]!): [Model!]!
  ```

  ```json
  { "query": "mutation($id: ID!, $names: [String!]!) { importGlobalModels(providerId: $id, names: $names) { id name } }", "variables": { "id": "665f...c2a", "names": ["o3-mini", "gpt-4.1"] } }
  ```

- **响应**：返回**实际新建**的模型列表；`names` 内已在该供应商下导入的条目幂等跳过。

- **错误**：`MODEL_NAME_EXISTS`（与其他供应商模型重名，附冲突名称明细）、`MODEL_NAME_INVALID`（空名/非法名）、`PROVIDER_NOT_FOUND`、`PROVIDER_CONNECTIVITY_ERROR`（导入前复用上游连通校验，避免把凭据失效时期的脏数据写入）。

#### 变更 3: Mutation `deleteGlobalModel` — 删除任意模型（替换 `deleteGlobalCustomModel`）

- **请求**

  ```graphql
  deleteGlobalModel(id: ID!): Model   # 返回被删除模型，不存在返回 null
  ```

- **语义演进**：`deleteGlobalCustomModel` 仅允许 `isCustom: true`（`services/model.ts:54-64` 静默返回 null，resolver 抛 `Model not found or is not a custom model`）。本期契约直接演进为 `deleteGlobalModel`（任意模型可删），`admin-web` 调用点（`graphql/mutations.ts:124-130`、`ModelSection.tsx:97-112`）与 `tests/api/src/admin-api/llm.test.ts` 同步替换。删除仅移除模型文档本身，定价历史、账单、收据、计量记录不动。

#### 变更 4: 重名语义写入契约注释

`contracts/admin-llm.graphql` 头部注释补充：`scope=global` 内 `Model.name` 全局唯一（跨供应商）；`createGlobalCustomModel` / `importGlobalModels` 均返回 `MODEL_NAME_EXISTS`。

#### 变更 5: Query `modelRenameRecords` — 历史重名整理的改名对照（可查询核对载体）

- **请求**（GraphQL Query）

  ```graphql
  modelRenameRecords: [ModelRenameRecord!]!
  ```

  ```graphql
  type ModelRenameRecord {
    id: ID!
    modelId: ID!          # 被改名的模型（现以 newName 存在）
    providerId: ID!
    providerName: String! # 所属供应商名（冗余留档：供应商后续被删除仍可读）
    oldName: String!
    newName: String!
    batchId: String!      # 同一次整理批次（迁移 005 一次运行一个批次）
    renamedAt: DateTime!
  }
  ```

- **响应**

  ```json
  {
    "data": {
      "modelRenameRecords": [
        {
          "id": "6660...ab",
          "modelId": "665f...c2",
          "providerId": "665f...c2a",
          "providerName": "OpenAI-A",
          "oldName": "gpt-4o",
          "newName": "gpt-4o-2",
          "batchId": "20261020-005",
          "renamedAt": "2026-10-20T12:00:00.000Z"
        }
      ]
    }
  }
  ```

- **语义**：只读查询，仅迁移 005 写入记录；按 `renamedAt` 倒序返回全部记录。消费方为 admin-web「重名整理记录」只读视图（PRD §3.4）。记录是一次性历史整理的对照台账，不随模型删除而删除。

### 3.2 内部接口

| 接口 | 调用方 | 说明 |
|------|--------|------|
| `LLMAPIService.fetchModels(type, endpoint, credentialValue)` | `ProviderService.create/update`（连通性校验）、`ModelService.listProviderModels` | 复用现有实现（`services/llm-api.ts`，OpenAI/Anthropic SDK `models.list()`，10s 超时）；凭据解密仅在服务端进行 |
| `ModelService.assertNamesAvailable(names)` | `createGlobalCustomModel`、`importGlobalModels` | 统一重名检查入口（口径唯一，禁止各写入点自建规则） |
| `ProviderService.decryptedCredential(providerId)` | `listProviderModels` | 由 `encryptedCredential`（AES-256-GCM）解密，仅内存使用 |
| `ModelRenameRecord` 写入 | 迁移 005 | 每条改名写入一条对照记录（old/new/provider/batchId/renamedAt），作为「重名整理记录」数据源 |

## 4. 数据模型

### 4.1 数据库设计

#### 集合: `models`（`servers/admin-api/src/models/model.ts` 与 `servers/agent-api/src/models/model.ts` 同步演进）

| 字段 | 类型 | 说明 |
|------|------|------|
| `providerId` | ObjectId (ref Provider) | 所属供应商，`{providerId, name}` 唯一（保留） |
| `name` | String | 模型名；本期起在 `scope='global'` 内全局唯一 |
| `isCustom` | Boolean | 自定义模型标记（删除能力不再受其限制） |
| `isEnabled` | Boolean | 启停（保留） |
| `sortOrder` | Number | 顺序（分组内排序继续使用） |
| `scope` | `user \| global` | `global` = 后台（系统内置）来源 |
| `pricing` | SubDoc | 计费定价（不动） |

**索引变更**：

| 索引 | 类型 | 说明 |
|------|------|------|
| `{providerId: 1, name: 1}` | unique（既有） | 供应商内唯一，保留 |
| `{name: 1}` + `partialFilterExpression: { scope: 'global' }` | unique（**新增**） | 后台模型名全局唯一兜底；`user` 作用域不受影响 |

`providers`、`productprices` 等集合不做结构变更。

#### 集合: `model_rename_records`（新增，Mongoose `ModelRenameRecord`）

历史重名整理的改名对照台账——PRD §3.2 功能点 4「改名记录可核对」的持久化载体（不依赖控制台日志）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `modelId` | ObjectId | 被改名的模型（现以 `newName` 存在） |
| `providerId` | ObjectId | 所属供应商 id |
| `providerName` | String | 供应商名（冗余留档，供应商后续删除不影响可读） |
| `oldName` | String | 原名 |
| `newName` | String | 新名 |
| `batchId` | String | 整理批次（迁移 005 一次运行一个批次） |
| `renamedAt` | Date | 整理时间 |

索引：`{ renamedAt: -1 }`（列表排序）、`{ batchId: 1 }`（按批次检索）。写入方**仅迁移 005**，服务运行期不写；通过 Query `modelRenameRecords` 只读消费。记录不随模型删除而删除（审计留痕）。

### 4.2 缓存设计

不新增缓存。`listGlobalProviderModels` 为实时透传上游（管理员低频操作，追求清单新鲜度），不做服务端缓存，避免与导入结果不一致。

## 5. 技术实现方案

### 5.1 核心流程

手动导入模型：

```mermaid
sequenceDiagram
    participant U as 管理员
    participant AW as admin-web
    participant AA as admin-api
    participant UP as 上游供应商
    participant DB as MongoDB

    U->>AW: 供应商卡片点击「导入模型」
    AW->>AA: listGlobalProviderModels(providerId)
    AA->>DB: 读取供应商 + 解密凭据
    AA->>UP: models.list()
    UP-->>AA: 上游模型清单
    AA->>DB: 比对 (providerId,name) 已导入 / 全局重名
    AA-->>AW: [{name, isImported, isDuplicate}]
    U->>AW: 勾选（已导入/已存在禁选）后点击「导入」
    AW->>AA: importGlobalModels(providerId, names)
    AA->>AA: assertNamesAvailable(names) 重名检查
    AA->>DB: insertMany（幂等跳过已导入）
    AA-->>AW: 新建模型列表
    AW-->>U: 展示导入结果，分组列表刷新
```

分组折叠渲染（admin-web / agent-web 同构）：

```mermaid
flowchart TD
    A[models 列表] --> B{来源判定}
    B -->|agent-web 且 scope=global| C[合并为「系统内置」组]
    B -->|其余| D[按 providerId 分组<br/>组头=供应商名]
    C --> E[默认折叠渲染<br/>组头: 名称+数量+展开箭头]
    D --> E
    E --> F[组内: 启停/排序/删除/供应商副标题]
```

### 5.2 关键实现点

#### 实现点 1: 后台取消供应商创建/更新的自动导入与重同步（用户侧保持不变）

- **描述**：**仅 admin-api**——`ProviderService.create()` 删除 L165-190 的 `Model.insertMany` 段，`update()` 删除 L226-315 的 `needsResync` 重同步段；**保留** `fetchModels` 作为保存前连通性校验（凭据/地址填错仍能即时发现），只校验不落库。**agent-api 用户侧不动**：`servers/agent-api/src/services/provider.ts` 的 `syncSyncedModels`（L155-192，create L69 调用、update L142 重同步）及其事务/回滚逻辑原样保留，用户添加自定义供应商后仍自动同步该供应商模型。
- **两侧行为差异（显式声明，PRD §3.2 功能点 1「范围限定」同口径）**：

  | 维度 | 后台（admin-api，scope=global） | 前台用户侧（agent-api，scope=user） |
  |------|------|------|
  | 供应商创建后模型来源 | 不自动导入，管理员「导入模型」弹窗手动勾选 | 自动同步上游全量模型（现状，`syncSyncedModels`） |
  | 凭据/地址变更后 | 不自动重同步，由管理员手动增量导入 | 自动重同步（现状，保留自定义模型、清理陈旧同步模型） |
  | 模型删除 | 支持删除任意模型（本期新增） | 仅自定义模型（现状） |
  | 模型重名约束 | `scope=global` 内全局唯一（本期新增） | 供应商内唯一（现状，不变） |

- **技术细节**：`create()` 事务范围缩小为单文档写入；`admin-web` 空态文案从「添加供应商后自动拉取」改为「暂无可用模型，通过供应商的『导入模型』手动导入」；`tests/api/src/admin-api/llm.test.ts`、`servers/admin-api/src/services/provider.test.ts` 中「自动导入/重同步」断言改为「创建后 models 为空」，并**新增 agent-api 侧回归断言**（`servers/agent-api/src/services/provider.test.ts`：创建用户供应商仍自动同步、update 仍重同步），把上述行为差异锁进测试。
- **风险点**：运维习惯变化（过去靠自动同步刷新清单）→ 提案明确「刷新清单 = 重新打开导入弹窗增量导入」；更新凭据/地址后不再自动清理陈旧模型，由管理员用删除能力处理；两侧行为不一致带来的认知成本 → 后台导入弹窗/空态文案明确「手动导入」，用户侧不做改动。

#### 实现点 2: 导入模型弹窗与两条新链路

- **描述**：`ModelService.listProviderModels(providerId)` 拉上游清单并标注 `isImported`（`(providerId, name)` 已存在）与 `isDuplicate`（`scope=global` 且 `name` 被其他供应商占用）；`importModels(providerId, names)` 幂等导入。
- **技术细节**：`admin-web` 新增 `components/models/ImportModelsDialog.tsx`（清单 + 勾选 + 全选 + 关键字过滤 + 重试 + 结果反馈），入口在 `ProviderItem`/`ProviderActionMenu`；已导入与重名条目 `disabled` 并带「已导入」「已存在」标记；导入前服务端二次校验重名（防绕过 UI）。错误映射沿用 `resolvers/provider.ts:9-14` 的 E11000/连通性文案风格。
- **风险点**：上游清单可能很大（数百条）→ 弹窗内关键字过滤 + 虚拟滚动兜底（沿用现有列表样式，必要时分批渲染）；重复点击导入 → 幂等跳过，不报错。

#### 实现点 3: 模型分组折叠（admin-web / agent-web「可用模型」）

- **描述**：两处「可用模型」列表统一「按供应商分组、默认折叠」。admin-web `ModelSection` 把平铺 `SortableContext` 改为按 `providerId` 分组渲染（新增 `ModelGroup`：组头 = 供应商名 + 数量 + 展开箭头，`defaultExpanded: false`）；`@dnd-kit` 排序收敛为**组内排序**，`UPDATE_GLOBAL_MODEL_SORT_ORDER` 仍提交全量有序 id（组间顺序按供应商创建顺序拼接，保证接口不变）。agent-web `settings/ModelSection` 同构改造，`scope === 'global'` 的模型统一归入「系统内置」组，`ModelItem.tsx:81-83` 的 `{model.provider.name}` 在该组内不再渲染（改为「系统内置」徽标，沿用 `McpRegistrySection.tsx:39-42`「平台内置」徽标样式）。
- **会话内「切换模型」列表不参与分组（结论与依据）**：
  - **分组键**：不存在可靠分组键。该列表数据来自 ACP 探测的 configOptions：`packages/agent-controller/src/acp/bridge.ts` `SessionConfigOptionData.options`（L33）仅 `{ value, name }`，`extractConfigModels`（L168-178）映射出的 `availableModels` 只有 `{id, name}`，`provider` 为可选且**上游从未产出**（`acp-options-prober.ts` / `acp-session-manager.ts` 全链路透传的 `provider?: string` 恒为空）。按空 `provider` 分组必然退化为单一分组，无法达成 PRD 分组意图。
  - **兜底组名**：不适用（不实现分组）。若强行以「系统内置」作为兜底组名，会把「Agent 自身探测到的模型」错误表述为「平台后台内置模型」，与 PRD「系统内置 = 后台来源模型」的口径冲突。
  - **是否需要在 ACP 侧补充来源字段**：需要，但不在本期。补齐意味着 `SessionConfigOptionData.options` 增加 `provider` 并要求各 ACP Agent（opencode / claude-code / mimo / kimi 等）在 configOptions 中提供来源信息，涉及 `packages/agent-controller`（bridge/prober）、`controller-api`、`agent-api`、`contracts/agent-session.graphql` 多层与外部 Agent 协议数据，属独立需求。已在 PRD §5.2 约束登记为后续需求。
  - 本期对 `session/ModelSelectDialog.tsx` **零改动**（保持现状平铺列表），E2E 断言其不退化。
- **技术细节**：折叠交互沿用 agent-web 既有 `TreeSection`（`components/tree/TreeSection.tsx:14-67`）/ `Sidebar` 手写 `useState + chevron` 模式，抽一个轻量 `CollapsibleGroup` 共享组件（admin-web 无 Collapse 组件可复用，不引第三方库）；`agent-web` 的 `GET_MODELS` / `GET_PROVIDERS` 查询补 `scope` 字段（契约 `llm.graphql` 已有 `Model.scope: ConfigScope!`，后端零改动）；`aria-expanded` 可访问性与现有折叠组件一致。
- **风险点**：分组后拖拽排序语义变化（跨组拖动取消）→ 组内拖拽、组间不互拖，避免重排语义混乱；「系统内置」组内模型来自多个后台供应商，排序按原 `sortOrder`。

#### 实现点 4: 可用模型删除能力泛化

- **描述**：`ModelService.delete()` 去掉 `if (!model.isCustom) return null` 限制（`services/model.ts:54-64`），契约/前端演进为 `deleteGlobalModel`（见 §3.1 变更 3）；admin-web `ModelItem` 删除按钮不再限定 `isCustom`，确认弹窗文案补充影响说明（前台不可见、调用报「模型不存在」）。
- **技术细节**：删除不级联其他集合（定价真相在 `productprices`，账单/收据/计量为历史事实）；删除后 `(providerId, name)` 与全局名自动释放，可重新导入/新建同名；`agent-api` 用户侧 `deleteCustomModel` 语义不变（仅自定义）。
- **风险点**：删除被计费网关正在寻址的模型 → 网关返回 `model_not_found`（`billing-openai.ts:197` 既有行为），PRD 已定义为预期；删除操作补审计级日志（谁删了哪个模型）。

#### 实现点 5: 模型名全局唯一（重名检查 + 迁移 005）

- **描述**：三层保障——UI 即时校验、写入路径统一检查、数据库唯一索引兜底。
- **技术细节**：
  - `ModelService.assertNamesAvailable(names)`：校验 `scope='global'` 内 `name` 冲突（含跨供应商），`createGlobalCustomModel` / `importGlobalModels` 统一调用，冲突返回 `MODEL_NAME_EXISTS`（含冲突名明细）；admin-web `CustomModelDialog` 与 `ImportModelsDialog` 提交前本地预检并提示「模型名已存在」。
  - 迁移 `005-model-name-unique-global`（位于 `servers/admin-api/src/migrations/`，沿用该目录既有 runner + `admin_migrations` 账本/迁移锁模式）：① 扫描 `scope='global'` 存量重名；② 每组保留 `sortOrder` 最小、`createdAt` 最早的一条原名，其余按 `createdAt` 升序改名为 `<name>-2`、`<name>-3`…；③ **每条改名写入一条 `model_rename_records` 对照记录**（`oldName/newName/modelId/providerId/providerName/batchId/renamedAt`，见 §4.1）；④ 创建 partial unique index `{name:1}`（`partialFilterExpression: {scope:'global'}`）；⑤ 幂等（重跑检测无重名且索引已存在则跳过；已写入的对照记录不重复写），索引创建失败即抛错中止。
  - **改名记录的可查询核对载体（不依赖日志）**：`contracts/admin-llm.graphql` 新增 Query `modelRenameRecords`（§3.1 变更 5）；admin-web 模型配置页新增只读「重名整理记录」入口（折叠面板/弹窗），逐条展示 原名→新名、所属供应商、整理时间，按时间倒序。核对口径：记录条数 == 实际改名模型数，且每条 `oldName → newName` 与库内实际名称一一对应（API 测试逐条比对断言）。
- **风险点**：改名影响既有按名调用方 → 仅存量重名模型被改名（这些名字在网关下本就路由不确定），`model_rename_records` 提供持久 old→new 对照（后台可查），供运维公告与调用方迁移；并发写入在索引建立后由 E11000 兜底，resolver 统一映射为 `MODEL_NAME_EXISTS`。

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| 供应商保存时连通性校验 | 保留（仅校验不导入） | 一并移除 | A | 凭据/地址填错需即时发现；与「不自动导入」不冲突 |
| 更新供应商时模型重同步 | 保留 | 移除 | B | 模型清单完全由手动导入控制，凭据/地址变更不应静默增删模型 |
| 重名口径 | 供应商内唯一（现状） | `scope=global` 内全局唯一 | B | 计费网关按 `Model.findOne({scope:'global', name})` 寻址（`billing-openai.ts:195`），重名即路由不确定 |
| 重名兜底 | 仅应用层校验 | 应用层 + 部分唯一索引 | B | 防并发绕过；`user` 作用域用 partial index 隔离不受影响 |
| 存量重名处理 | 删除重名项 | 仅禁用 | 改名（保留最早原名，其余 `<name>-n`） | 删除丢数据；禁用无法建唯一索引；改名保数据且让寻址确定，对照记录落库可核对 |
| 删除能力契约 | 放宽 `deleteGlobalCustomModel` 语义 | 演进为 `deleteGlobalModel` | B | 命名语义清晰；admin-api/admin-web 同仓同步发布，无外部消费方 |
| 「系统内置」数据来源 | 后端新增字段 | 复用 `Model.scope` / `Provider.scope`，前端补齐查询 | B | 契约已有 `ConfigScope`，后端零改动、口径一致 |
| 分组折叠实现 | 引入折叠库 | 抽共享 `CollapsibleGroup`（沿用既有手写模式） | B | 两端已有成熟手写折叠模式，不新增依赖 |
| agent-api 用户侧自动同步 | 与后台一致移除（两侧行为统一） | **保留**用户侧自动同步，仅后台改手动导入 | B | PRD 功能点 1 只约束后台；移除会让用户添加供应商后得到 0 模型且无任何导入入口，构成未定义回归，违反 PRD §4.3/§5.2「前台用户自定义能力保持不变」（打回项 1） |
| 会话「切换模型」分组 | 按 `provider` 分组、空值兜底「系统内置」 | **移出本期范围**，保持现状；「ACP 侧补来源字段」另立后续需求 | B | ACP configOptions 仅 `{value, name}`（`bridge.ts` L33/L168-178），无来源字段可分组，强行实现退化为单组；「系统内置」兜底会把 Agent 探测模型错误表述为平台内置模型（打回项 2） |
| 重名整理记录载体 | 仅迁移控制台日志 | 持久化 `model_rename_records` + Query `modelRenameRecords` + 后台只读视图 | B | 日志不可持久查询、无法逐条验收；PRD 要求「改名记录可核对」（打回项 3） |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | `LLMAPIService.fetchModels` + 凭据加解密 | 导入链路复用，不新增上游调用方式 |
| 依赖 | 既有迁移 runner（`servers/*/src/migrations`） | 迁移 005 沿用既有模式与启动执行时机 |
| 约束 | 计费网关寻址规则不变 | 唯一性由本期保证，网关代码不动 |
| 约束 | `contracts/llm.graphql`（用户侧）不变 | `agent-api` 行为零变化（仅查询字段可选补 `scope`） |
| 约束 | 不引入新前端依赖 | 折叠组件自研复用 |

## 7. 项目结构

```
contracts/
└── admin-llm.graphql                        # 新增 ProviderModelOption / listGlobalProviderModels / importGlobalModels / deleteGlobalModel / modelRenameRecords
servers/admin-api/src/
├── models/model.ts                          # 新增 partial unique index（scope=global, name）
├── models/model-rename-record.ts            # 新增：改名对照台账（collection model_rename_records）
├── migrations/005-model-name-unique-global.ts  # 新增：存量重名整理（改名对照落库）+ 唯一索引
├── graphql/schemas/{provider,model}.ts      # SDL 演进（含 ModelRenameRecord / modelRenameRecords）
├── graphql/resolvers/{provider,model}.ts    # 新解析器 / 错误映射
└── services/{provider,model,llm-api}.ts     # 后台移除自动导入；assertNamesAvailable / listProviderModels / importModels / delete 放开
servers/agent-api/src/
├── models/model.ts                          # 同步演进索引定义（保持一致）
└── services/provider.ts                     # 不改动：syncSyncedModels 自动同步保留（用户侧行为不变，仅补回归测试）
apps/admin-web/src/
├── components/providers/{ProviderSection,ProviderActionMenu}.tsx  # 「导入模型」入口 / 文案
├── components/models/{ModelSection,ModelItem,CustomModelDialog}.tsx  # 分组折叠 / 删除 / 重名校验
└── components/models/{ModelGroup,ImportModelsDialog,CollapsibleGroup}.tsx  # 新增
└── components/models/ModelRenameRecordsPanel.tsx  # 新增：「重名整理记录」只读视图
apps/agent-web/src/
├── graphql/queries.ts                       # GET_MODELS / GET_PROVIDERS 补 scope
└── components/settings/{ModelSection,ModelItem}.tsx  # 分组折叠 +「系统内置」
└── components/session/ModelSelectDialog.tsx # 不改动（本期不分组，见 §5.2 实现点 3）
tests/
├── api/src/admin-api/llm.test.ts            # 新链路 / 重名 / 删除泛化 / 幂等 / modelRenameRecords
├── api/src/agent-api/…                      # 回归：用户侧供应商仍自动同步（行为差异锁进测试）
└── e2e/src/admin-model-config.spec.ts       # 导入弹窗、分组折叠、删除、重名提示、重名整理记录
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 新增/改动逻辑（service 层）单测覆盖率 ≥ 80%。
- API 测试覆盖：`listGlobalProviderModels`、`importGlobalModels`、`deleteGlobalModel`、`modelRenameRecords`、`createGlobalCustomModel` 重名分支、`create/updateGlobalProvider` 不再落模型、迁移 005（改名对照落库条数与改名数一致）。
- **行为差异锁进测试**：agent-api 用户侧「创建供应商仍自动同步、update 仍重同步」回归断言（防止后续误删 `syncSyncedModels`）。
- E2E 覆盖 PRD 四个功能点的主验收路径。

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | vitest | `ModelService.assertNamesAvailable` / `listProviderModels` / `importModels`（幂等、重名）、`ProviderService.create/update` 不落模型、迁移 005（重名整理规则、`model_rename_records` 写入、幂等、索引生效） |
| API 契约测试 | tests/api（supertest + 内存 Mongo） | `tests/api/src/admin-api/llm.test.ts`：新增三条链路全分支、错误码（`MODEL_NAME_EXISTS`/`PROVIDER_CONNECTIVITY_ERROR`）、`deleteGlobalModel` 对导入/自定义模型均可删、删除后同名可再导入、并发重名兜底、`modelRenameRecords` 与实际改名一一对应、scope 隔离（`user` 不受唯一索引影响） |
| API 回归测试 | tests/api | agent-api 用户侧供应商创建/更新仍自动同步模型（`syncSyncedModels` 行为不变） |
| E2E | Playwright | `tests/e2e/src/admin-model-config.spec.ts`：创建供应商后无自动导入 + 导入弹窗勾选导入 + 已导入/已存在禁选 + 分组折叠 + 删除确认 + 重名整理记录可查；agent-web 断言「系统内置」分组、无后台供应商名、会话「切换模型」不退化 |
| 回归 | tests/api / tests/e2e 既有用例 | 计费网关寻址、模型启停/排序、用户自定义模型链路不回归 |

## 9. 部署方案

### 9.1 环境规划

| 环境 | 用途 | 部署方式 |
|------|------|---------|
| 本地开发 | 开发自测 | Aspire（`aspire start`） |
| 测试 | 集成/E2E | CI + tests/api、tests/e2e |
| 生产 | 上线 | 既有发布流程（docker compose / K8s） |

### 9.2 配置管理

- 无新增配置项；沿用现有凭据加密密钥与上游超时设置。
- 迁移 005 随 admin-api 启动自动执行（`admin_migrations` 账本 + 迁移锁，与既有 migrations 一致），执行前建议备份 `models` 集合；改名对照持久写入 `model_rename_records`（后台「重名整理记录」可查），同时输出摘要日志供运维感知。

## 10. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract（`contracts/admin-llm.graphql`）评审通过
- [ ] 代码实现完成（admin-api / admin-web / agent-web 及迁移 005）
- [ ] 单元测试覆盖达标（新增逻辑 ≥ 80%）
- [ ] API 测试通过（含重名、删除泛化、幂等导入、迁移幂等、`modelRenameRecords` 与实际改名一一对应）
- [ ] agent-api 用户侧行为回归通过（创建供应商仍自动同步模型，`syncSyncedModels` 不变）
- [ ] 会话「切换模型」列表不退化（保持现状，无本期改动）
- [ ] E2E 测试通过（PRD §1.3 成功标准逐条可验证，含后台「重名整理记录」可查）

## 11. 相关文档

- [关联 PRD] `docs/product/draft/20261020-api-channel-model-fixes.md`
- [关联 Contract] `contracts/admin-llm.graphql`、`contracts/llm.graphql`、`contracts/billing-openai.openapi.yaml`
- [开发规范] `docs/engineering/{common,backend,frontend}-rules.md`
- [其他] `docs/engineering/proposals/20260517-feat-llm-provider-settings.md`（供应商/模型基线）、`docs/engineering/proposals/20261014-feat-admin-console.md`（全局 scope 机制）、`docs/engineering/proposals/20261018-feat-credits-billing.md`（计费网关寻址）
