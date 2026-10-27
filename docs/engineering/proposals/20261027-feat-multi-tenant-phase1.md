---
description: 多租户一期技术提案 v1.1（评审返工）：三层帐号模型——accounts 集合承载登录（account→user）、users 瘦身身份主体、tenants 1..n 成员（tenant→user，personal 租户 _id 复用 userId 且一期单成员）；AuthContext.tenantId、带 userId 集合清洗 tenantId、计费 ownerType front_user→tenant 余额零改动、前台硬关 signup、后台租户只读管理与后台开户（agent-api 内部端点保有 accounts/users/tenants 写权）
type: Permanent
---

# 多租户一期 - 技术提案

**功能名称**: 多租户一期（三层帐号体系与数据按租户隔离）
**关联 PRD**: `docs/product/draft/20261027-multi-tenant-phase1.md`（v1.1）
**技术提案版本**: v1.1
**创建日期**: 2026-10-27
**作者**: z-agent-bot
**feat-branch**: `feat/multi-tenant-phase1`
**版本说明**:
- v1.0（2026-10-27）初版。
- v1.1（2026-10-27，评审返工，[PR #330](https://github.com/Deliay/z-agent-gear/pull/330) CHANGES_REQUESTED）按评审意见「租户可以有多个成员；整体设计为 租户(tenant)→用户(user)、账户(account)→用户(user)；增加 account 建模，将原 user 登录部分整合到 account」重构数据模型与全文：新增 `accounts` 集合承载登录（原 `users.username/passwordHash` 迁入）、`users` 瘦身为身份主体、`tenants.memberUserIds` 一对多成员关联（一期 personal 租户单成员）；认证链路改为「账户登录 → 用户 → 租户成员解析」；迁移 012 改为三件套拆分迁移；决策表新增 D7/D8。

## 1. 概述

### 1.1 背景

平台当前为单帐号模式：`users` 集合同时承载登录凭据（`username/passwordHash`）与身份，`sessions`、`controllers`、`cloudhosts` 等 20+ 集合以 `userId` 归属，计费账户 `billingaccounts.ownerType='front_user'`、`ownerId=userId`。评审要求按三层关联重构：

```mermaid
flowchart LR
    T[tenants<br/>租户] -->|memberUserIds 1..n| U[users<br/>用户/身份主体]
    A[accounts<br/>账户/登录凭据] -->|userId n..1| U
    T -->|持有| B[(billingaccounts<br/>ownerType=tenant)]
    U -->|经租户使用| R[(sessions/controllers/<br/>cloudhosts/...<br/>+tenantId)]
```

- **账户（account）**：登录凭据实体，`username`+`passwordHash`，`userId` 指向所属用户（account→user，n..1；一期一用户一账户，模型支持一用户多账户）。
- **用户（user）**：身份主体，不再含登录凭据；承载 `name` 与个人偏好（`globalPermissionTimeoutAction`）。
- **租户（tenant）**：`memberUserIds` 一对多包含用户（tenant→user）；一期仅 `type='personal'` 个人专属租户——单成员、不可删除、不可添加成员（服务层硬约束），模型本身支持多成员，为二期团队租户预留。

核心简化仍然成立：personal 租户 `_id` 复用所属 User `_id`（tenantId==userId），余额迁移只改 `ownerType` 不改 `ownerId`、数据清洗只新增字段不改值。

### 1.2 目标

- 新增 `accounts`、`tenants` 两个集合（agent-api 为写方）；`users` 移除登录字段瘦身为身份主体；存量用户无损迁移为「账户+用户+个人专属租户」三件套。
- 认证链路三层化：`login` 走 `accounts` 校验；token 载荷仍为 `userId`（已发 token 不失效）；中间件解析 `User → 其租户成员关系 → tenantId` 入 `AuthContext`。
- 前台全部服务/Resolver 的归属查询与写入由 `userId` 切换为 `tenantId`；`billingaccounts`/`billingapikeys` 的 `ownerType` 由 `front_user` 迁移为 `tenant`（`ownerId` 不变），充值对象呈现为租户。
- 前台关闭注册：契约删除 `signup`、agent-api 移除 resolver、agent-web 移除 `/register` 路由与入口链接。
- 后台新增租户管理：租户列表/详情（含成员用户列表、余额），只读；后台开户（创建账户+用户+个人租户+零余额租户计费账户）。

### 1.3 范围

**做**：

- agent-api：`accounts`/`tenants` 模型与迁移、`users` 瘦身、AuthContext/中间件 tenantId 解析、全部带 `userId` 集合的 `tenantId` 清洗迁移与查询切换、`signup` 移除、`POST /internal/users` 开户内部端点、`me` 附带租户信息。
- admin-api：`accounts`/`users`/`tenants` 只读镜像模型、`admin-tenant.graphql` 契约实现（列表/详情/开户）、计费 `ownerType` 迁移（`front_user→tenant`）、后台充值入口按租户呈现。
- cloud-controller：`cloudcontainers` 写入与查询补 `tenantId`（该集合写方在 cloud-controller）。
- contracts：`auth.graphql`（删 signup、`User.tenant`/`User.name`）、新增 `admin-tenant.graphql`、`billing.graphql` / `admin-billing.graphql`（`BillingOwnerType` 增 `tenant`）、内部 REST 说明。
- agent-web：移除注册页与入口；admin-web：新增租户列表/详情页与开户入口、充值对象切换为租户。

**不做**：

- 多人租户的成员管理（邀请/移除/角色）、多账户登录方式（第三方登录绑定）、租户切换（模型预留，二期及以后）；
- 个人专属租户的删除/加成员能力（PRD 明确禁止）；
- admin-api 全局管理面的租户隔离（PRD 明确本期除外）；
- `providers`/`models`（`scope='user'` 且无 `userId` 字段，现状为全体前台用户共享一份用户级配置）的租户化归属——遵循需求「仅清洗带 userId 的 collection」口径，本期维持现状，列入二期治理（见 §6.1 决策 D5）；
- 已签发 JWT 的强制失效与重签（token 载荷不变，见 §6.1 决策 D2）。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    subgraph agent-web
        L[登录页<br/>移除注册入口]
        B1[我的费用<br/>租户口径]
    end
    subgraph admin-web
        T1[租户列表/详情页]
        T2[后台开户入口]
        B2[费用中心<br/>充值对象=租户]
    end
    subgraph agent-api
        AUTH[authenticateUser<br/>userId→User→tenantId]
        LOGIN[login resolver<br/>走 accounts 校验]
        RS[Resolvers/Services<br/>查询口径 userId→tenantId]
        ACC[(accounts<br/>username 唯一<br/>userId→users)]
        USR[(users<br/>身份主体, 无凭据)]
        TEN[(tenants<br/>memberUserIds 1..n)]
        IU[POST /internal/users<br/>开户内部端点]
        BC[BillingClient<br/>ownerType=tenant]
    end
    subgraph admin-api
        TR[admin-tenant resolvers<br/>只读 + 开户转发]
        BA[(billingaccounts<br/>ownerType: front_user→tenant)]
        MIR[accounts/users/tenants 只读镜像]
    end
    subgraph cloud-controller
        CC[cloudcontainers 写方<br/>+tenantId]
    end
    L --> LOGIN --> ACC
    LOGIN --> AUTH --> USR --> TEN
    RS --> TEN
    T1 --> TR --> MIR
    T2 --> TR -->|INTERNAL_API_TOKEN| IU
    IU --> ACC
    IU --> USR
    IU --> TEN
    B2 --> BA
    BC --> BA
```

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 后端 | Node.js 24 + TypeScript strict + Express 5 + graphql-yoga | agent-api / admin-api / cloud-controller 现状一致 |
| 数据库 | MongoDB（Mongoose） | 迁移走各服务既有 `migrations/runner`（启动时执行、幂等、带 `.test.ts`） |
| 前端 | React 19 + TypeScript + Vite + Apollo Client | agent-web / admin-web 既有页面模式 |
| 测试 | Vitest + tests/api + tests/e2e | TDD 红-绿-重构 |

### 2.3 模块划分

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| agent-api `models/account.ts`（新增） | 账户模型（登录凭据） | `username` 唯一（规则沿用原 users：2-20 字符）、`passwordHash`、`userId` 索引；bcrypt 散列不变 |
| agent-api `models/user.ts`（变更） | 用户模型瘦身 | 移除 `username`/`passwordHash`；保留 `_id`、`globalPermissionTimeoutAction`；新增 `name`（展示名，迁移时=原 username） |
| agent-api `models/tenant.ts`（新增） | 租户模型 | personal 租户 `_id` 复用 owner user `_id`；`type: personal/team`；`memberUserIds: [ObjectId]`（一期 personal 恒单成员）；`name` 唯一索引（personal=用户名，原 users.username 已唯一） |
| agent-api 迁移 `012-account-user-tenant` | 存量 users 三件套拆分 | 逐 user：创建 `accounts`（继承 username/passwordHash，userId=user._id）→ 更新 `users`（`$unset` username/passwordHash、`$set` name）→ 创建 `tenants`（_id=user._id，type=personal，memberUserIds=[user._id]）；幂等（按 accounts/tenants 存在性跳过）、可重跑、批处理 |
| agent-api 迁移 `013-tenant-id-backfill` | 全部带 `userId` 集合补 `tenantId` 与索引 | 逐集合 `updateMany({userId 存在, tenantId 缺失}, {$set: tenantId=userId})`；新增 `{tenantId:1,...}` 索引（唯一索引同步扩展，如 `mcp_servers.{userId,name}`→`{tenantId,name}`） |
| agent-api `middleware/auth.ts` + `AuthContext` | 解析并下发 `tenantId` | token→userId→`User.findById`（无凭据后 select 无敏感字段顾虑）→ tenantId 解析：查 `tenants` 含该 userId 的 personal 租户（一期恒 `_id==userId`，带一级回退 `tenantId=userId`）；helper `requireTenantId(context)` |
| agent-api 各 service/resolver | 查询与写入口径切换 | 全量 grep `userId` 过滤点逐一替换为 `tenantId`；写入同时落 `userId`（保留回滚与追溯）与 `tenantId` |
| agent-api `routes/internal-users.ts`（新增） | 后台开户内部端点 | Bearer `INTERNAL_API_TOKEN`；创建 Account+User+Tenant 三件套 + 经 billing-client get-or-create 零余额租户账户；按 username 幂等 |
| admin-api 迁移 `014-billing-owner-tenant` | `ownerType: front_user→tenant` | `updateMany` 幂等；枚举扩展；`ownerId` 不变 |
| admin-api `graphql/resolvers/tenant.ts`（新增） | 租户列表/详情/开户 | 只读镜像查询 tenants + users + accounts（用户名取自 account）+ billingaccounts 聚合余额；开户转发 `POST /internal/users` |
| cloud-controller `models/cloud-container.ts` | `cloudcontainers` 补 `tenantId` | 写入口径与 agent-api `startHarness` 下发参数对齐；迁移由 cloud-controller 侧执行 |
| agent-web | 移除注册 | 删 `RegisterPage`、`/register` 路由、登录页注册链接 |
| admin-web | 租户管理页 + 开户 + 充值对象切换 | 新页面 `TenantsPage`/`TenantDetailPage`；`BillingPage` 充值入口改为按租户检索 |

## 3. API 设计

### 3.1 API 契约

#### 契约 1: `contracts/auth.graphql`（变更）

- **删除** `Mutation.signup`（硬关闭注册）。
- `login` 入参不变（username/password），语义变为「账户登录」；返回的 `User` 为身份主体视图。
- `User` 调整：移除对登录字段的任何暴露（原本也未暴露），新增 `name` 与 `tenant`：

```graphql
type Tenant {
  id: ID!
  name: String!
  type: TenantType! # personal | team
  memberCount: Int! # 租户成员数（tenant→user 一对多；一期 personal 恒为 1）
}

type User {
  id: ID!
  name: String!    # 展示名（迁移后=原用户名）
  tenant: Tenant!  # 当前用户归属租户（一期恒为个人专属租户）
  createdAt: String!
}

type AuthPayload {
  token: String!
  user: User!
}

type Query {
  me: User
}

type Mutation {
  login(username: String!, password: String!): AuthPayload!
}
```

> 账户（Account）不在前台契约暴露独立类型；登录即账户校验，`me` 返回用户视图。用户名唯一性由 `accounts.username` 承载。

#### 契约 2: `contracts/admin-tenant.graphql`（新增）

```graphql
# 后台租户与账户管理（多租户一期）
# 鉴权：全部需要 admin JWT；租户与用户为只读视图，开户为唯一写操作。
# 模型口径：租户(tenant)→用户(user) 一对多；账户(account)→用户(user) 承载登录。

type AdminTenant {
  id: ID!
  name: String!
  type: TenantType!        # personal | team（一期仅 personal）
  memberCount: Int!
  balance: Float           # 租户计费账户可用余额（credits），无账户为 null
  createdAt: String!
}

type AdminTenantUser {
  id: ID!                  # 用户 id
  name: String!            # 用户展示名
  username: String!        # 登录账户名（取自其 account）
  createdAt: String!
}

type AdminTenantDetail {
  id: ID!
  name: String!
  type: TenantType!
  users: [AdminTenantUser!]!   # 只读列表（tenant.memberUserIds 展开）
  createdAt: String!
}

type Query {
  adminTenants(keyword: String, page: Int, pageSize: Int): [AdminTenant!]!
  adminTenant(id: ID!): AdminTenantDetail
}

type Mutation {
  # 后台开户：创建登录账户+用户+同名个人专属租户+零余额租户费用账户
  adminCreateFrontUser(username: String!, password: String!): AdminTenantUser!
}
```

错误口径：用户名重复 `Username already taken`、用户名长度 2-20、密码 ≥6（与原 signup 校验一致，规则收敛到 accounts）。

#### 契约 3: `contracts/billing.graphql` / `contracts/admin-billing.graphql`（变更）

```graphql
enum BillingOwnerType {
  front_user   # 已废弃：存量行由迁移转为 tenant，仅作历史兼容保留读
  admin_user
  tenant       # 新增：前台租户账户
}
```

- `adminBillingAccounts(ownerType:)` 支持按 `tenant` 过滤；`rechargeBillingAccount(accountId:)` 语义不变（accountId 已指向租户计费账户，后台 UI 由「按帐号检索」改为「按租户检索」）。
- 内部 REST `GET /internal/billing/account?ownerType&ownerId&ownerName`：agent-api 调用方改传 `ownerType=tenant`、`ownerId=tenantId`、`ownerName=租户名`；兼容期内服务端对 `front_user` 读取自动按同 id 的 `tenant` 行解析（迁移已保证 ownerId 不变）。

> 命名澄清：本提案中「账户/account」指登录账户（`accounts` 集合）；计费侧「账户」一律称「计费账户」（`billingaccounts`）。两者无语义关联。

### 3.2 内部接口

#### `POST /internal/users`（agent-api 新增，供 admin-api 开户）

- **鉴权**: Bearer `INTERNAL_API_TOKEN`（与既有 `/internal/*` 一致）。
- **请求**: `{ "username": "...", "password": "..." }`
- **响应**:
  - 201 `{ user: { id, name, createdAt }, account: { id, username }, tenant: { id, name, type } }`
  - 400 `{ error: 'INVALID_BODY' }`（message 附具体规则）
  - 409 `{ error: 'USERNAME_TAKEN' }`
- **事务语义**（顺序执行，失败向前回滚已建文档）：
  1. 校验 username/password 规则；
  2. 创建 `users`（`name=username`）；
  3. 创建 `accounts`（`username` 唯一、`passwordHash`、`userId`）——唯一索引冲突即 409；
  4. 创建 `tenants`（`_id=user._id`、`name=username`、`type='personal'`、`memberUserIds=[user._id]`）；
  5. 经 `/internal/billing/account` get-or-create 租户计费账户（`ownerType=tenant`、`ownerId=tenantId`、`ownerName=租户名`）。
- **幂等**：按 username 幂等——重复提交若三件套已完整存在则返回既有视图（200），不重复创建；半完成状态按缺失步骤补齐。
- **错误体**统一 `{ error: '<UPPER_CODE>' }`，内部异常只记服务端日志（与 `internal-billing.ts` 口径一致）。

## 4. 数据模型

### 4.1 数据库设计

#### 集合: `accounts`（新增，agent-api 写方；admin-api 只读镜像）

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | 新账户 id（不复用 userId，保持 account→user 单向引用） |
| `username` | String | 登录名，唯一索引；2-20 字符（沿用原 users 规则） |
| `passwordHash` | String | bcrypt 散列，规则不变 |
| `userId` | ObjectId(ref: User) | 归属用户（account→user，n..1），索引 |
| `createdAt/updatedAt` | Date | timestamps |

#### 集合: `users`（变更，agent-api 写方；admin-api 只读镜像）

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | 不变（存量 id 稳定，全部 `userId` 引用零改动） |
| `name` | String | 展示名（迁移时=原 username） |
| ~~`username`/`passwordHash`~~ | — | 移除，迁入 `accounts` |
| `globalPermissionTimeoutAction` | String | 不变 |
| `createdAt/updatedAt` | Date | 不变 |

#### 集合: `tenants`（新增，agent-api 写方；admin-api 只读镜像）

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | personal 租户复用 owner user `_id`（tenantId==userId）；未来 team 租户独立生成 |
| `name` | String | 租户名（personal=用户名）；唯一索引 |
| `type` | String | `personal` \| `team`（一期仅 personal） |
| `memberUserIds` | [ObjectId] | **tenant→user 一对多成员关联**；personal 恒为 `[ownerUserId]`；不可删除/不可加成员由服务层硬约束（无对应 API） |
| `createdAt/updatedAt` | Date | timestamps |

#### 集合: 带 `userId` 的既有集合（统一变更）

逐集合新增 `tenantId: { type, required: true, index: true }`（类型对齐各集合现有 `userId` 类型：String 或 ObjectId），存量行清洗为与 `userId` 同值（personal 租户 id==userId）：

| 服务 | 集合 | 备注 |
|------|------|------|
| agent-api | sessions, controllers, controllerkeys, controllerworkspaces, gateways, mcp_servers, mcp_session_endpoints, cloudhosts, cloud_host_github_bindings, cloud_host_issues_linkages, cloud_host_setup_operations, configuredworkflows, workflowinstances, workflowprhandlers, workflowtemplates, issueworkflowtriggers, todoitems, user_commit_settings, githubaccounts | 唯一索引如 `mcp_servers.{userId,name}` 同步扩展为 `{tenantId,name}` |
| cloud-controller | cloudcontainers | 写方在 cloud-controller，`tenantId` 由 agent-api 拉起时下发 |
| admin-api | billingaccounts, billingapikeys | 不加 `tenantId` 字段，改走 `ownerType='tenant'` + `ownerId=tenantId`（口径等价，避免双写） |

> `acpmessages` 无 `userId`（经 sessionId 归属 Session），隔离由 Session 级 tenantId 校验承担，不新增字段。
> `providers`/`models`（scope=user）无 `userId`，本期不动（见决策 D5）。

#### 集合: `billingaccounts`（admin-api 迁移）

- `ownerType` 枚举扩展 `tenant`；迁移将全部 `front_user` 行 `updateMany` 为 `tenant`；`ownerId`（=userId=personal tenantId）、余额、流水、冻结、`appliedLedgerIds`、`invoiceSeq` 全部不变——**余额零改动即完成迁移**。

### 4.2 缓存设计

- 认证解析不新增缓存：`authenticateUser` 已按请求查库；tenantId 解析一期恒等 `_id==userId`（personal 租户文档直取），仅一次额外 findById；不引入 Redis 依赖。后续支持多成员/团队租户时再评估请求级缓存。
- 既有的计费/模型/选项缓存 key 不含 owner 口径切换影响，无需改造。

## 5. 技术实现方案

### 5.1 核心流程

登录（账户承载认证）：

```mermaid
sequenceDiagram
    participant C as 前端
    participant A as agent-api
    participant D as MongoDB
    C->>A: login(username, password)
    A->>D: Account.findOne({username})
    D-->>A: account
    A->>A: bcrypt.verify(password, account.passwordHash)
    A->>D: User.findById(account.userId)
    D-->>A: user
    A->>A: signToken(userId)（载荷不变，已发 token 不失效）
    A-->>C: AuthPayload{ token, user{ id, name, tenant } }
```

请求期租户上下文解析：

```mermaid
sequenceDiagram
    participant C as 前端
    participant A as agent-api
    participant D as MongoDB
    C->>A: GraphQL (Bearer JWT)
    A->>A: verifyToken → userId
    A->>D: User.findById(userId) + Tenant.findById(userId)（personal 恒等直取）
    D-->>A: user + tenant
    A->>A: AuthContext = { currentUser, tenantId }
    A->>D: 业务查询 filter { tenantId }
    D-->>A: 本租户数据
    A-->>C: 响应
```

后台开户（三件套 + 计费账户）：

```mermaid
sequenceDiagram
    participant AD as admin-web
    participant AA as admin-api
    participant AG as agent-api
    participant D as MongoDB
    AD->>AA: adminCreateFrontUser(username,password)
    AA->>AG: POST /internal/users (INTERNAL_API_TOKEN)
    AG->>D: 创建 User → Account(username 唯一) → Tenant(personal, memberUserIds=[userId])
    AG->>AA: 经 /internal/billing/account get-or-create(ownerType=tenant)
    AG-->>AA: 201 { user, account, tenant }
    AA-->>AD: AdminTenantUser
```

数据迁移（发布时自动执行）：

```mermaid
flowchart TD
    M1[agent-api 迁移 012<br/>users 拆分为 accounts+users+tenants 三件套] --> M2[agent-api 迁移 013<br/>带 userId 集合清洗 tenantId + 建索引]
    M2 --> M3[admin-api 迁移 014<br/>billing ownerType front_user→tenant]
    M3 --> M4[cloud-controller 迁移<br/>cloudcontainers 清洗 tenantId]
    M4 --> V[启动后自检:<br/>无 userId 无 tenantId 的孤儿行=0<br/>无 account 的 user=0]
```

### 5.2 关键实现点

#### 实现点 1: 查询口径切换的完备性

- **描述**: 前台所有数据访问必须以 `tenantId` 过滤。
- **技术细节**: 以 `grep -rn "userId" servers/agent-api/src/{services,graphql}` 全量枚举过滤点，逐一替换为 `requireTenantId(context)` 取值；`respondPermission`/`respondElicitation` 等终态写入不变量（filter 含 `userId`）同步改为 `tenantId`（值相同，语义升级）；跨租户访问统一抛 `Not found`（不泄露存在性）。
- **风险点**: 遗漏某个过滤点即形成越权或串租户——以「逐集合 checklist + 每集合至少一条隔离 API 测试」兜底；`TodoService` 等已有「缺 userId 拒绝写入」防御的位置改为「缺 tenantId 拒绝写入」。

#### 实现点 2: 三件套迁移的原子感与幂等

- **描述**: 迁移 012 把每个存量 user 拆为 accounts+users+tenants，必须可重跑、不得出现半迁移状态。
- **技术细节**: 按 user 粒度三步骤顺序执行，每步以目标集合存在性（`accounts.userId` / `tenants._id` / `users` 已无 username）为幂等判据，重跑只补齐缺失步骤；迁移完成后校验：无账户的用户数=0、无租户的用户数=0、用户名唯一冲突=0；批处理 + 进度日志。
- **风险点**: `users.username` 唯一索引需在全部行迁移完成后下线（同迁移末尾 `dropIndex`，幂等）；迁移中途失败的行在重跑时补齐，不影响已成功行。
- **回滚策略**: 迁移不删除原字段值外的任何数据；回滚版本需先恢复 `users.username/passwordHash`（由 accounts 回填）再回退代码——一期接受「回滚需配套脚本」并在迁移文件内附回滚说明。

#### 实现点 3: 注册硬关闭

- **描述**: 契约、resolver、前端三层同时移除。
- **技术细节**: `contracts/auth.graphql` 删 `signup`；agent-api `resolvers/auth.ts` 删实现；agent-web 删 `RegisterPage.tsx`、`/register` 路由、`LoginPage` 注册链接；schema 先行的契约式开发保证前端编译期即暴露遗漏引用。
- **风险点**: agent-web 内对 `signup` 的其余引用（测试/mock）需同步清理。

#### 实现点 4: 计费口径切换

- **描述**: 余额迁移 = `ownerType` 枚举改写；前后台读写口径统一为 `tenant`。
- **技术细节**: admin-api 迁移 014；`billing-client.ts` 全部 `ownerType:'front_user'` 改 `'tenant'`，`ownerName` 传租户名；admin-web 充值入口由按帐号检索改为按租户检索（`adminTenants` 选租户 → 取其计费账户 → 既有充值 mutation）；兼容期内部接口对 `front_user` 读请求按同 id `tenant` 行解析。
- **风险点**: 发布窗口内旧 agent-api 仍传 `front_user`——兼容解析兜底；欠费止损、冻结、API Key 等既有资金规则逻辑零改动（accountId 不变）。

#### 实现点 5: 三层模型的写方单一日志

- **描述**: `accounts`/`users`/`tenants` 写方仅 agent-api（含 `/internal/users`）；admin-api 一律只读镜像。
- **技术细节**: admin-api 新增三个只读镜像模型（schema 注释标注「与 agent-api 同步演进」，沿用 `cloud-host.ts` 镜像惯例）；成员列表展开顺序：`tenant.memberUserIds` → `users` + `accounts(userId)` 聚合出用户名。

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| D1 personal 租户 id 取值 | 独立生成新 ObjectId | 复用 userId（Tenant._id=User._id） | B | 数据清洗只增字段不改值；余额 ownerId 不变；查询切换零映射；team 租户二期用独立 id |
| D2 tenantId 传递 | 签发进 JWT | 中间件每次按 User 解析 | B | 已发 token 不失效；未来多租户/换租不落 token 语义负担；一次直取成本可忽略 |
| D3 accounts/users/tenants 写权 | admin-api 直接写库 | agent-api 开 `/internal/users`，admin-api 转发 | B | 遵守「写方各自单一」（对照 cloudhosts 只读镜像惯例）；用户名/密码校验不双份 |
| D4 注册关闭方式 | feature flag 软关闭 | 契约+resolver+前端硬移除 | B | PRD 要求硬关闭；无运行时分支残留 |
| D5 providers/models 租户化 | 本期补 tenantId 并归一到某租户 | 本期维持 scope=user 共享现状，二期治理 | B | 需求口径仅清洗带 userId 集合；现状本为全员共享（无归属字段），强行归一会造成他方配置丢失 |
| D6 存量 userId 字段 | 清洗后删除 | 保留双写一段时期 | B | 回滚安全；二期再评估下线 |
| D7 登录凭据归属 | user 保留 username/passwordHash | 新增 accounts 集合承载登录（account→user） | B | **评审要求**：账户独立建模为后续多登录方式（GitHub 绑定等）预留；users 瘦身为身份主体 |
| D8 租户成员关系建模 | 独立 membership 集合 | `tenants.memberUserIds` 内嵌数组（tenant→user） | B | **评审要求**的关联方向；一期成员数恒 1，内嵌数组直取零 join；二期团队租户成员量级内嵌仍可控，超限再拆 membership |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | 费用中心（`20261018-feat-credits-billing`） | ownerType 迁移以其账户/账单/收据体系为基础 |
| 依赖 | admin 鉴权（`admin-auth.graphql`） | 租户管理与开户复用 admin JWT |
| 约束 | 迁移在各自服务启动时执行完成再对外服务 | 与既有 migrations runner 一致；发布顺序：admin-api（兼容解析）→ agent-api → cloud-controller |
| 约束 | personal 租户约束由服务层硬保证 | 无删除/加成员 API，契约层即不存在入口 |
| 约束 | 用户名唯一性由 `accounts.username` 唯一索引承载 | 开户/未来新增登录方式都经此约束 |

## 7. 项目结构

```
servers/agent-api/src/
├── models/account.ts                   # 新增 Account（登录凭据，userId→users）
├── models/user.ts                      # 瘦身：移除 username/passwordHash，+name
├── models/tenant.ts                    # 新增 Tenant（memberUserIds 1..n）
├── middleware/auth.ts                  # 解析 tenantId 入 AuthContext
├── graphql/resolvers/auth.ts           # login 走 accounts；删 signup
├── routes/internal-users.ts            # 新增开户内部端点
├── migrations/012-account-user-tenant.ts(+test)  # 三件套拆分迁移
├── migrations/013-tenant-id-backfill.ts(+test)   # tenantId 清洗
└── services/...                        # 查询口径 userId→tenantId 全量切换
servers/admin-api/src/
├── models/account.ts, user.ts, tenant.ts         # 只读镜像
├── graphql/{schemas,resolvers}/tenant.ts         # 新增
├── migrations/014-billing-owner-tenant.ts(+test) # ownerType 迁移
└── services/billing/...                # ownerType=tenant 口径
servers/cloud-controller/src/models/cloud-container.ts  # +tenantId
apps/agent-web/src/                     # 移除 RegisterPage 与路由/入口
apps/admin-web/src/pages/               # TenantsPage / TenantDetailPage 新增
contracts/auth.graphql                  # 删 signup、User.name/tenant、Tenant 类型
contracts/admin-tenant.graphql          # 新增
contracts/billing.graphql, admin-billing.graphql  # BillingOwnerType+tenant
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 迁移均有 `.test.ts`（既有 runner 模式）：
  - 012：逐 user 三件套齐全（account 可验密、user 无凭据字段、personal 租户单成员）；幂等重跑；半完成状态补齐；用户名冲突计数为 0；`users.username` 旧唯一索引下线。
  - 013：逐集合清洗与索引；014：ownerType 改写与金额不变断言。
- 认证：原用户名密码登录成功（account 路径）；token 载荷 userId 不变；`me` 返回 `name`+`tenant`；`signup` 契约不存在。
- 每个带 tenantId 的集合至少一条 API 级隔离用例（租户 A 写入 → 租户 B 列表/详情/修改/删除不可达，返回 `Not found`）。
- 开户：`adminCreateFrontUser` 成功/重名/非法参数/未鉴权；开户后新账户可登录、`me.tenant` 为同名 personal 租户、租户计费账户余额 0；重复提交幂等。
- 计费：迁移后余额核对（抽样 ownerId 行余额不变）；后台按租户充值到账；云电脑创建扣费走 tenant 计费账户；`front_user` 兼容解析。
- 前端：登录页无注册入口；admin-web 租户列表/详情只读渲染、开户表单校验。

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Vitest | 迁移、tenant 解析 helper、开户端点、login 走 accounts、口径切换后的 service |
| API 测试 | tests/api（Vitest + 编排环境） | auth/tenant/admin-tenant/billing 契约用例（T-MT 系列） |
| E2E 测试 | tests/e2e（Playwright） | 老用户升级登录无感知、前台无注册、后台开户→新账户登录、后台按租户充值 |

## 9. 部署方案

### 9.1 环境规划

| 环境 | 用途 | 部署方式 |
|------|------|---------|
| 本地编排 | 开发与 TDD | `aspire start` 全量服务 |
| 生产 | 发布 | 顺序：admin-api（兼容解析先行）→ agent-api → cloud-controller → 前端 |

### 9.2 配置管理

- 无新增环境变量；`INTERNAL_API_TOKEN` 复用既有值（admin-api 增加对 agent-api `/internal/users` 的调用地址配置，沿用既有 agent-api 内部地址配置项）。

## 10. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract（auth / admin-tenant / billing×2 / 内部 REST）评审通过
- [ ] 迁移 012/013/014 幂等可重跑：存量用户三件套齐全（账户可登录、用户无凭据、personal 租户单成员）、全部带 userId 行有同值 tenantId、计费 ownerType 全量 tenant 且金额不变
- [ ] 租户隔离 API 测试逐集合通过；跨租户访问统一 `Not found`
- [ ] 前台无任何注册通道；后台开户→登录→同名租户→零余额计费账户全链路通过
- [ ] 后台租户列表/详情只读可用，按租户充值到账
- [ ] API 测试通过、E2E 测试通过

## 11. 相关文档

- 关联 PRD：[[../../product/draft/20261027-multi-tenant-phase1.md]]
- 需求来源：[GitHub Issue #329 — 多租户一期](https://github.com/Deliay/z-agent-gear/issues/329)
- 评审记录：[PR #330](https://github.com/Deliay/z-agent-gear/pull/330)（v1.0 CHANGES_REQUESTED → v1.1 三层模型重构）
- 计费基础：[[20261018-feat-credits-billing.md]]
- 开发规范：[[../common-rules.md]]、[[../backend-rules.md]]、[[../frontend-rules.md]]
