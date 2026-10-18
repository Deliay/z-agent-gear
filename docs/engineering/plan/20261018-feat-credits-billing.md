---
description: 费用中心（Credits 计费）实现计划：按「业务事件→计量→定价→账单→支付→收据」六段管线与 RabbitMQ 事件骨干（outbox+publisher confirm+幂等消费+DLQ）分阶段落地 admin-api 计费域、cloud-controller 计费源头与事件 outbox、统一预扣费检查、OpenAI 兼容计费网关、两侧前台/后台费用界面与三线对账，含精确文件清单、TDD 用例与分阶段验收 checklist
type: Permanent
---

# 费用中心（Credits 计费）- 实现计划

**关联 Proposal**: `docs/engineering/proposals/20261018-feat-credits-billing.md`（v2.1）
**关联 PRD**: `docs/product/draft/20261018-credits-billing.md`（v2.1）
**需求总分支（feat-branch）**: `feat/credits-billing`（需求总 PR：https://github.com/Deliay/z-agent-gear/pull/229）
**实现分支**: 基于 `feat/credits-billing` 创建实现分支（建议 `impl/credits-billing`，或按子项目拆分 `servers/credits-billing` / `apps/credits-billing`），完成后 PR 合并回需求总分支
**创建日期**: 2026-10-18
**计划版本**: v1.0
**版本说明**:
- v1.0（2026-10-18，首版）承接评审通过（`review-design` 节点经两轮打回——「按六段计费管线重设计」「引入 RabbitMQ」——后返工至 PRD/提案 v2.1）的上游产物，拆解为 10 个 Phase 的可执行实现计划；对提案留白处给出「计划期裁决」。

## 实现顺序

```mermaid
flowchart TD
    P1["Phase 1 契约<br/>admin-billing / billing / billing-openai / billing-events<br/>+ 存量契约字段与事件附录"] --> P2
    P2["Phase 2 编排与依赖<br/>Aspire RabbitMQ 资源 + amqplib + 环境变量"] --> P3
    P3["Phase 3 cloud-controller 计费源头<br/>billingAccountId/billingStartedAt + 事件 outbox + 带原因强拆"] --> P4
    P4["Phase 4 admin-api 计费域核心<br/>数据模型 + 六段管线 + 统一预扣费检查"] --> P5
    P5["Phase 5 admin-api 消息骨干<br/>RabbitMQ 接入 + 消费者 + 结算调度 + 三线对账"] --> P6
    P6["Phase 6 admin-api 对外接口<br/>/v1 OpenAI 网关 + /internal/billing + 后台 GraphQL"] --> P7
    P2 --> P6
    P4 --> P7
    P7["Phase 7 agent-api 前台费用<br/>billing.graphql + internal REST 客户端"] --> P8
    P6 --> P8
    P8["Phase 8 admin-web 费用中心<br/>账户/账单/充值/汇总/定价/API Key/对账"] --> P10
    P7 --> P9
    P9["Phase 9 agent-web 我的费用<br/>余额/欠费提示/账单/收据/汇总/API Key"] --> P10
    P10["Phase 10 测试与验收收口<br/>API + E2E + 消息链路 + 文档索引 + PR"]
```

**依赖说明**：

- **Phase 1（契约）先行**：契约是后续所有实现的唯一对齐基准，未评审通过不得进入编码。
- **Phase 2（编排/依赖）** 与 Phase 3/4 只共享「`RABBITMQ_URL` 等配置项命名」，可并行；但 Phase 3/5 编码前需确认依赖已加入 `package.json`。
- **Phase 3（cloud-controller）** 是计费的**源头**（`container.ready` / `container.destroyed` 事件与 `billingStartedAt`），Phase 4~6 的事件消费依赖其消息体口径，建议 Phase 3 先落地消息体再联调。
- **Phase 4（admin-api 计费域）** 是核心，纯函数/服务层可独立单测，不依赖 RabbitMQ，可先于 Phase 5 完成。
- **Phase 5（消息骨干/结算调度）** 依赖 Phase 4 的服务层与 Phase 2 的资源。
- **Phase 6（对外接口）** 依赖 Phase 4（服务层）与 Phase 5（网关事件走 outbox→MQ）、Phase 2（`RABBITMQ_URL`）。
- **Phase 7（agent-api）** 依赖 Phase 6 的 `/internal/billing/*`。
- **Phase 8（admin-web）** 依赖 Phase 6 的 GraphQL；**Phase 9（agent-web）** 依赖 Phase 7 的 GraphQL。
- **Phase 10** 在各子项目分支合并回需求总分支后收口。

开发模式统一采用 TDD（红-绿-重构）：每个 Phase 先写/改测试（RED）再写实现（GREEN）。编码前无条件加载 `docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端）、`docs/engineering/frontend-rules.md`（前端）及各子项目 `AGENTS.md`。

### 关键约束（提案 §1.2/§1.3/§6，实现期不得回退）

- **计量是事实、扣费是解释**：业务侧只发事件（不带金额），计费侧不回查业务库；计量/定价/账单可重放、可核对。
- **唯一同步卡点**：所有「扣费前」额度判断（容器保证金/周期重冻、模型调用准入）必须经 `CreditCheckService`；`payment`/`settle` 入参强制携带预检凭证，绕过即抛错。
- **金额整数化**：资金一律整数最小单位（0.01 credits = 1「分」）运算，代码层禁止浮点参与资金计算；token 计费 `ceil` 到分；时间桶/周期窗口统一 UTC。
- **三类幂等键**：`eventId`（业务事件）、`(reservationId, cycleSeq)`（周期结算）、`idempotentKey`（资金操作）为唯一索引；结算器无状态可重入，故障恢复 = 重跑。
- **对账兜底**：资金/计量/资源三线对账 + 僵尸预留扫描；任何事件丢失最终由对账补算，消耗不漏计。
- **事件可靠投递**：本地 outbox + publisher confirm + 消费幂等 + DLQ 四层组合；at-least-once；重复/乱序安全；积压不影响业务功能。
- **追加式不可变**：账单、收据、资金流水只增不删（schema 钩子拦截 update/delete）。
- **单向下沉**：`admin-api` 不直连 K8s、不双写容器库（降级只读除外）；计费写路径不落在 `agent-api`（经 admin-api 内部 REST 转发）。
- **禁止 rebase/squash**：遵循 z-git 规范，仅允许 merge。

## 计划期裁决（提案留白/含混处的实现口径）

1. **outbox 集合与归属**：`cloud-controller` 与 `admin-api`（网关）各自产生事件，统一写入共享集合 `billingoutbox`（字段严格对齐，沿用 `cloudcontainers` 共享集合的既有做法），以 `producer` 字段（`cloud-controller` / `admin-api`）区分来源；各服务的 relay **只处理本服务 `producer` 的行**，避免双 relay 重复发布。集合文档经 `syncIndexes` 建立 `{producer, published, createdAt}` 索引与 `eventId` 唯一索引。
2. **outbox 与业务状态一致性**：Mongo 非副本集不保证事务，outbox 采用**顺序写**（先写业务字段再写 outbox），outbox 写失败仅告警（不阻断生命周期）；事件丢失由资源/计量对账兜底（与提案「事件投递失败以对账兜底」一致），不引入两阶段提交。
3. **事件幂等键由业务确定**：`container.ready:<containerId>` / `container.destroyed:<containerId>` / `model_call.completed:<requestId>` / `model_call.aborted:<requestId>` 作为 `eventId`；唯一索引天然去重。`billingStartedAt` 仅在容器**首次**进入 `online`（含 init 完成收口与无脚本 register 直通两条路径）时写入，重复 `markOnline` 不重置、不重复投递。
4. **销毁事件投递条件**：仅当容器 `billingAccountId` 非空且 `billingStartedAt` 非空时投递 `container.destroyed`（携带 `minutes` 尾数或由计费侧按 `billingStartedAt`+`exitedAt` 计算），保证「未就绪即销毁」不计费、不产生空事件。
5. **带原因的强拆**：扩展 `DELETE /internal/containers/:id` 支持可选 `reason`（query 或 JSON body），透传 `containerService.destroy(id, { reason })`；`admin-api` 的 `CloudControllerClient.destroy(id, reason?)` 增加可选参数。强拆 reason 固定为 `余额不足超过 10 分钟，强制销毁`。
6. **预检凭证（preCheck）**：`CreditCheckService.check()` 返回结构化凭证 `{checkId, accountId, estimated, ref, createdAt, expiresAt}` 并写入进程内短期表（默认 TTL 5min，可注入仓储以便测试）；`payment`/`settle` 校验凭证存在、`accountId`/`ref` 匹配且未过期，否则抛错。不落库（避免第三份真相）。
7. **结算驱动双通道**：主通道为 RabbitMQ 延迟消息 `billing.settlement.cycle`（TTL+DLX 实现定时，`(reservationId, cycleSeq)` 幂等）；**保留**低频 `setInterval` 扫描 ACTIVE reservation（间隔 = `BILLING_CYCLE_SECONDS`）作为丢消息兜底（提案 D-15）。
8. **后台账户解析**：容器与调用方账户统一由 `billingAccountId` 承载；`adminStartCloudContainer` 未显式传入时缺省为**当前管理员账户**（`ownerType=admin_user`，get-or-create）；前台模型调用按 API Key 归属 `ownerType=front_user`。
9. **金额存储与展示**：持久层金额字段为整数「分」（0.01 credits）；GraphQL/API 边界除以 100 转 `Float` 展示；`productprices.rates` 存「分/百万 token」整数。`available = cash + gift + creditLimit − frozen`，`gift` 本期恒 0 但纳入公式与流水池枚举。
10. **API Key 校验不引入 admin-api Redis**：本期 `admin-api` 不新增 `ioredis`/`REDIS_URI` 依赖（其 `config` 现无 Redis），Key 校验走 Mongo（`keyPrefix` 索引定位 + bcrypt 比对），成功后更新 `lastUsedAt`。提案 §4.2 的「API Key Redis 缓存（可选）」本期**不做**，留待后续性能优化。
11. **模型定价单一真相**：价目真相在 `productprices`（productId = `model.<modelId>.token`）；`Model.pricing` 为便捷编辑视图，`updateModelPricing` 同时 upsert 价目档（旧档保留、带 `effectiveFrom`）并回写 `Model.pricing`。读取计费单价一律走 `productprices`（按消费时段取生效档）。
12. **未开启计费/未定价模型**：`pricing.isBillable=false` 的模型**放行调用但不计费**（记录 `billingapicalls`，不产生账单/事件计量）；定价缺失或不完整（闸门）的模型**拒绝调用**，返回 OpenAI 兼容 400 `invalid_request_error`、code `model_not_priced`。
13. **网关转发的供应商凭据**：`/v1` 网关按模型 `providerId` 读取 `providers` 全局文档，经 `services/crypto.ts` 解密 `encryptedCredential` 后构造供应商客户端（复用 `llm-api.ts` 的 `new OpenAI/Anthropic({ baseURL, apiKey })` 构造模式）；供应商凭据绝不下发给客户端。
14. **网关响应时序**：调用完成后**只写本地 outbox 即返回响应**（不等待 RabbitMQ confirm），发布与重试由 relay 异步完成；保证调用延迟不被计费链路拖累（PRD §4.1）。
15. **消息链路测试策略**：服务层单测用**可注入的 InMemory 事件总线/发布器替身**（与真实 MQ 解耦，保证 CI 绿灯）；真实 RabbitMQ 链路测试通过 `RABBITMQ_TEST_URL` 条件执行（未配置则 `describe.skip`），CI 提供 broker 时全量跑。
16. **索引建立**：关键唯一索引（`billingledgers.idempotentKey`、`billinginvoices{accountId,seq}`、`billingreservationcycles{reservationId,cycleSeq}`、`billingevents.eventId`、`billingrollups{accountId,granularity,bucketStart}`、`billingapikeys.keyPrefix`）由各 model 声明 + 启动时 `syncIndexes()` 建立（随 `admin-api` 启动，非 migration 脚本）。
17. **PRD/提案目录**：本期不移动产品文档生命周期目录（PRD 仍留 `draft/`，待实现验收后按流程归档）。
18. **`Model.pricing` schema 双侧同步**：`admin-api` 与 `agent-api` 的 `models/model.ts` 同步新增 `pricing` 子文档（沿用既有「双侧 schema 同步演进」注释约定），避免同一集合 schema 漂移。

---

## Phase 1: 契约（Contracts）

契约先行、评审锁定；后续所有 cols 以本阶段产物为唯一基准。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/admin-billing.graphql` | 新增 | 后台费用中心 GraphQL：枚举 `BillingOwnerType`/`BillingLedgerType`/`BillingCategory`/`BillingRollupGranularity`/`ReservationStatus`；类型 `BillingAccount`/`BillingInvoice`/`InvoiceItem`/`BillingReceipt`/`BillingRollup`/`BillingReservation`/`BillingApiKey`/`BillingApiKeyPayload`/`ReconciliationReport`；`Query.adminBilling*` 与 `Mutation.rechargeBillingAccount`/`setBillingAccountCreditLimit`/`setBillingAccountStatus`/`reconcileBillingAccount`/`runReconciliation`/`updateModelPricing`/`createBillingApiKey`/`revokeBillingApiKey`（提案 §3.1 原文） |
| `contracts/billing.graphql` | 新增 | 前台「我的费用」GraphQL：`myBillingAccount`/`myBillingInvoices`/`myBillingReceipts`/`myBillingRollups`/`myBillingApiKeys` + `createMyBillingApiKey`/`revokeMyBillingApiKey`（无充值 mutation） |
| `contracts/billing-openai.openapi.yaml` | 新增 | OpenAI 兼容计费网关：`GET /v1/models`、`POST /v1/chat/completions`（普通/SSE 流式）；鉴权 `Authorization: Bearer zag_sk_<hex>`；错误 401 `invalid_api_key` / 402 `insufficient_quota` / 404 `model_not_found` / 400 `model_not_priced` / 429 限速 |
| `contracts/billing-events.asyncapi.yaml` | 新增 | RabbitMQ 事件与调度消息契约：exchange `zag.billing.events`（topic）/`zag.billing.internal`（direct）；routing key `container.ready`/`container.destroyed`/`model_call.completed`/`model_call.aborted`；队列 `billing.metering.q`/`billing.settlement.q` + retry + DLQ；消息体（`eventId`/`eventType`/`occurredAt`/`accountId`/`resourceId`/`payload`）与调度消息 `billing.settlement.cycle` |
| `contracts/admin-cloud-container.graphql` | 修改 | `adminStartCloudContainer` 输入增加 `billingAccountId: ID`（可选，缺省=当前管理员账户）；`CloudContainer` 增加 `billingStartedAt: String`（就绪计费起点） |
| `contracts/admin-llm.graphql` | 修改 | 新增 `type ModelPricing` / `input ModelPricingInput`，`Model` 增加 `pricing: ModelPricing`，`Mutation.updateModelPricing` 归入本契约的模型定价写入（与 admin-billing 对齐，二选一登记，避免重复定义——**裁决 11**：`updateModelPricing` 定义于 `admin-billing.graphql`，本文件仅扩展 `ModelPricing` 类型与 `Model.pricing` 字段） |
| `contracts/llm.graphql` | 修改 | 与 `admin-llm.graphql` 同步新增 `ModelPricing` 类型与 `Model.pricing` 字段（前台模型展示用，只读） |
| `contracts/cloud-controller-websocket.md` | 修改 | 附录 A：A.2.2 `POST /internal/containers` body 增加 `billingAccountId?`；A.2.3 `DELETE /internal/containers/:id` 增加可选 `reason`（**裁决 5**）；A.3 容器 JSON 增加 `billingAccountId`/`billingStartedAt`；新增容器生命周期事件（`container.ready`/`container.destroyed`）与 outbox 投递说明 |

### 验收 checklist

- [ ] 四份新契约文件结构完整、可被 GraphQL schema 合并 / OpenAPI / AsyncAPI 解析器解析
- [ ] `admin-llm.graphql` 与 `llm.graphql` 的 `ModelPricing`/`Model.pricing` 双侧字段逐字一致；`updateModelPricing` 仅在 `admin-billing.graphql` 定义一处
- [ ] `cloud-controller-websocket.md` 附录 A 字段与事件与 `billing-events.asyncapi.yaml` 消息体口径一致（字段命名、大小写、时间格式）
- [ ] 契约评审通过（提案 §10 第 2 条）

---

## Phase 2: 编排与依赖（Aspire RabbitMQ + amqplib）

子项目：`aspire/AgentGear.AppHost`、`servers/admin-api`、`servers/cloud-controller`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | 新增 `builder.AddRabbitMQ("rabbitmq")` 资源（镜像参数化，与 mongo/redis 同风格）；`adminApi` 与 `cloudController` 增加 `.WithReference(rabbitmq)`；dev 模式补 `.WithEnvironment("RABBITMQ_URL", ...)` 兜底（本地无 Aspire 注入时用 `amqp://guest:guest@localhost:5672`） |
| `aspire/manifest/docker-compose.yaml` | 重新生成 | `aspire publish -o aspire/manifest` 后 `rm -f aspire/manifest/*.Dockerfile`；确认新增 `rabbitmq` 服务与 `admin-api`/`cloud-controller` 的 `RABBITMQ_URL` |
| `aspire/AgentGear.AppHost/AGENTS.md` | 修改 | Managed Resources 表新增 `rabbitmq` 行；补充 `admin-api`/`cloud-controller` 注入 `RABBITMQ_URL` 的说明 |
| `servers/admin-api/package.json` | 修改 | dependencies 新增 `amqplib`；devDependencies 新增 `@types/amqplib` |
| `servers/cloud-controller/package.json` | 修改 | dependencies 新增 `amqplib`；devDependencies 新增 `@types/amqplib` |
| `servers/admin-api/src/config/index.ts` | 修改 | 新增计费与 MQ 配置项（见提案 §9.2）：`rabbitmqUrl`/`rabbitmqPrefetch`/`rabbitmqRetryMax`/`billingCycleSeconds`/`containerDepositCredits`/`billingArrearsGraceMs`/`modelDefaultMaxOutputTokens`/`billingReconCron`/`reservationStaleMs`/`outboxRelayIntervalMs`；`parsePositiveInt` 复用 |
| `servers/cloud-controller/src/config/index.ts` | 修改 | 新增 `rabbitmqUrl`（`RABBITMQ_URL`，默认 `amqp://guest:guest@localhost:5672`）、`rabbitmqPrefetch`/`rabbitmqRetryMax`/`outboxRelayIntervalMs`；加入 `AppConfig` |

### 命令参考

```bash
# 生成 compose 并核对 rabbitmq 服务
cd aspire/AgentGear.AppHost && aspire publish -o ../manifest
rm -f ../manifest/*.Dockerfile && grep -n "rabbitmq\|RABBITMQ_URL" ../manifest/docker-compose.yaml
# 安装依赖
cd servers/admin-api && npm install amqplib && npm i -D @types/amqplib
cd servers/cloud-controller && npm install amqplib && npm i -D @types/amqplib
```

### 验收 checklist

- [ ] `aspire start` 能拉起 `rabbitmq` 资源，`admin-api`/`cloud-controller` 启动时 `RABBITMQ_URL` 已注入
- [ ] docker-compose manifest 含 `rabbitmq` 服务，两服务环境变量含 `RABBITMQ_URL`
- [ ] `amqplib` 依赖在两侧 `package.json`/lockfile 落地，`tsc` strict 通过
- [ ] 新增配置项均带安全默认值，非法值不导致 NaN（复用 `parsePositiveInt` 口径）

---

## Phase 3: cloud-controller 计费源头（字段 + 事件 outbox + 带原因强拆）

开发分支：`servers/credits-billing`。TDD：先写 `billing-event-publisher.test.ts` / `internal-api.test.ts` 增量用例（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/models/cloud-container.ts` | 修改 | schema 新增 `billingAccountId: String|null`、`billingStartedAt: Date|null`（`cloudcontainers` 集合，与 admin-api 只读模型对齐） |
| `servers/cloud-controller/src/models/billing-outbox.ts` | 新增 | `BillingOutbox` 模型（集合 `billingoutbox`）：`eventId`（唯一索引）、`producer`（`cloud-controller`）、`eventType`、`payload`（Mixed）、`published`（Boolean）、`attempts`、`lastError`、`createdAt`、`publishedAt`；`syncIndexes` |
| `servers/cloud-controller/src/services/billing-event-publisher.ts` | 新增 | `BillingEventPublisher`：`enqueue(event)` 写 outbox；`start()`/`stop()` 定时 relay（`OUTBOX_RELAY_INTERVAL_MS`）经 RabbitMQ confirm channel 发布到 `zag.billing.events` 并标记 `published`；失败保留由下一轮重试；连接自动重连（amqplib 心跳 30s）；拓扑声明幂等（复用 Phase 5 的 topology 模块或在 cloud-controller 内联声明同一拓扑） |
| `servers/cloud-controller/src/services/container-service.ts` | 修改 | 构造注入可选的 `onReady`/`onDestroyed` 事件钩子（保持 `ContainerService` 不直接依赖 RabbitMQ）；`markOnline` 首次置 online 时写 `billingStartedAt` 并触发 `onReady(container)`；`destroyLocked` 在 CAS `destroying→exited` 成功后触发 `onDestroyed(container)`（**裁决 4** 条件：`billingAccountId`+`billingStartedAt` 均非空） |
| `servers/cloud-controller/src/routes/internal-api.ts` | 修改 | `toCloudContainerJson` 透出 `billingAccountId`/`billingStartedAt`；`POST /containers` 解析可选 `billingAccountId` 并透传 `containerService.start(...)`；`DELETE /containers/:id` 解析可选 `reason`（query/body）并透传 `destroy(id, { reason })` |
| `servers/cloud-controller/src/services/container-service.ts` | 修改 | `start(...)` 增加 `billingAccountId`（写入 `repo.create`）；`destroy(id, { reason })` 已支持 reason（沿用） |
| `servers/cloud-controller/src/index.ts` | 修改 | 构造 `BillingEventPublisher` 并注入 `ContainerService` 的 `onReady`/`onDestroyed` 钩子；`start()` 中 `publisher.start()`、`stop()` 中 `publisher.stop()`；Mongo 连接后 `BillingOutbox.syncIndexes()` |
| `servers/cloud-controller/src/repositories/container-repository.ts` | 修改 | `CreateContainerInput`/`UpdateContainerInput`/`CloudContainerEntity` 增加 `billingAccountId`/`billingStartedAt` |

### 事件消息体（对齐 Phase 1 契约）

```jsonc
// routing key: container.ready
{ "eventId": "container.ready:<containerId>", "eventType": "container.ready",
  "occurredAt": "<billingStartedAt ISO>", "accountId": "<billingAccountId>",
  "resourceId": "<containerId>", "payload": { "billingStartedAt": "<ISO>" } }
// routing key: container.destroyed
{ "eventId": "container.destroyed:<containerId>", "eventType": "container.destroyed",
  "occurredAt": "<exitedAt ISO>", "accountId": "<billingAccountId>",
  "resourceId": "<containerId>", "payload": { "billingStartedAt": "<ISO>", "exitedAt": "<ISO>" } }
```

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-CC-B1 | `markOnline` 首次置 online | 写 `billingStartedAt` 一次并 `enqueue(container.ready)` |
| T-CC-B2 | 重复 `markOnline`（已 online） | 不重置 `billingStartedAt`、不重复入队 |
| T-CC-B3 | 无脚本 register 直通 `markOnline`（`socketio-gateway`）| 同样写入并投递（覆盖两条就绪路径） |
| T-CC-B4 | 销毁已计费容器 | 触发 `container.destroyed`，payload 含 `billingStartedAt`/`exitedAt` |
| T-CC-B5 | 未就绪（`billingStartedAt=null` 或 `billingAccountId=null`）即销毁 | 不投递 destroyed 事件 |
| T-CC-B6 | outbox relay 发布成功 | `published=true`、`publishedAt` 写入；失败保留 `published=false` 供重试 |
| T-CC-B7 | `DELETE /internal/containers/:id` 带 `reason` | `exitReason` 为该 reason（非默认「强制销毁」） |
| T-CC-B8 | `POST /internal/containers` 带 `billingAccountId` | 落库字段、A.3 JSON 透出 |
| T-CC-B9 | outbox 写失败 | 不阻断 `markOnline`/销毁，仅告警（裁决 2） |

### 命令参考

```bash
cd servers/cloud-controller && npm run build
cd servers/cloud-controller && npx vitest run
```

### 验收 checklist

- [ ] T-CC-B1~T-CC-B9 通过，既有 `container-service.test.ts` / `internal-api.test.ts` / `socketio-gateway.test.ts` 保持通过
- [ ] `billingAccountId`/`billingStartedAt` 与 admin-api 只读模型字段、契约附录 A.3 三方一致
- [ ] 生命周期不被计费投递阻塞（outbox 失败仅告警）；容器状态机与既有 CAS/互斥语义零变化
- [ ] 强拆 reason 可通过 `DELETE` 传入并在 `exitReason` 可查

---

## Phase 4: admin-api 计费域核心（数据模型 + 六段管线 + 统一预扣费检查）

开发分支：`servers/credits-billing`。TDD：服务层纯函数/InMemory 仓储先行。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/models/billing-account.ts` | 新增 | `BillingAccount`（集合 `billingaccounts`）：`ownerType`(front_user/admin_user)/`ownerId`（唯一复合索引）、`cashBalance`/`giftBalance`/`creditLimit`/`frozenAmount`（整数分）、`invoiceSeq`（从 0 起）、`status`(active/frozen)、`insufficientSince`、timestamps |
| `servers/admin-api/src/models/billing-ledger.ts` | 新增 | `BillingLedger`（`billingledgers`，不可变）：`accountId`/`pool`(cash/gift/credit)/`bizType`(recharge/charge/freeze/unfreeze/settle/adjust)/`deltaBalance`/`deltaFrozen`/`bizId`/`idempotentKey`(**唯一索引**)/`createdAt`；pre-update/remove 钩子抛错 |
| `servers/admin-api/src/models/billing-event.ts` | 新增 | `BillingEvent`（`billingevents`）：`eventId`(**唯一**)/`eventType`/`occurredAt`/`accountId`/`resourceId`/`payload`/`metered`/`receivedAt` |
| `servers/admin-api/src/models/metering-record.ts` | 新增 | `MeteringRecord`（`meteringrecords`）：`eventId`(**唯一**)/`accountId`/`resourceType`/`resourceId`/`productId`/`quantity`/`dims`/`windowFrom`/`windowTo`/`invoiced` |
| `servers/admin-api/src/models/product-price.ts` | 新增 | `ProductPrice`（`productprices`）：`productId`/`productName`/`pricingModel`(per_unit/per_token)/`unitPrice`/`rates{inputPerMillion,cachedInputPerMillion,outputPerMillion}`（整数分）/`isBillable`/`effectiveFrom`；`{productId, effectiveFrom}` 索引 |
| `servers/admin-api/src/models/billing-invoice.ts` | 新增 | `BillingInvoice`（`billinginvoices`）：`{accountId, seq}` **唯一索引**、`type`/`category`/`amount`/`balanceAfter`/`refType`/`refId`/`items[{productId,quantity,unitPrice,amount,meteringRef}]`/`receiptId`/`periodFrom`/`periodTo`/`createdAt` |
| `servers/admin-api/src/models/billing-payment.ts` | 新增 | `BillingPayment`（`billingpayments`）：`invoiceId`/`accountId`/`amount`/`pools[{pool,amount}]`/`status`/`idempotentKey`(**唯一**) |
| `servers/admin-api/src/models/billing-receipt.ts` | 新增 | `BillingReceipt`（`billingreceipts`）：`receiptNo`(**唯一**)/`invoiceId`/`paymentId`/`accountId`/`amount`/`balanceAfter`/`issuedAt` |
| `servers/admin-api/src/models/billing-reservation.ts` | 新增 | `BillingReservation` + `BillingReservationCycle`（`billingreservations`/`billingreservationcycles`）：reservation `status`/`reservedTotal`/`settledTotal`/`releasedTotal`/`startedAt`/`expectedEndAt`/`lastSettleAt`/`version`；cycle `{reservationId, cycleSeq}` **唯一索引** |
| `servers/admin-api/src/models/billing-rollup.ts` | 新增 | `BillingRollup`（`billingrollups`）：`{accountId, granularity, bucketStart}` **唯一索引**、`chargeTotal`/`rechargeTotal`/`chargeCount` |
| `servers/admin-api/src/models/billing-api-key.ts` | 新增 | `BillingApiKey`（`billingapikeys`）：`accountId`/`ownerType`/`ownerId`/`name`/`keyPrefix`(**索引**)/`keyHash`/`status`/`lastUsedAt` |
| `servers/admin-api/src/models/billing-api-call.ts` | 新增 | `BillingApiCall`（`billingapicalls`）：`requestId`/`accountId`/`apiKeyId`/`modelId`/三段 token/`cost`/`status`/`invoiceSeq`/`estimated`/`startedAt`/`finishedAt` |
| `servers/admin-api/src/models/billing-outbox.ts` | 新增 | `BillingOutbox`（`billingoutbox`，与 cloud-controller 同集合同字段，`producer='admin-api'`；**裁决 1**） |
| `servers/admin-api/src/models/model.ts` | 修改 | 新增 `pricing` 子文档（`inputPerMillion`/`cachedInputPerMillion`/`outputPerMillion`/`isBillable`，整数分，**裁决 18**） |
| `servers/admin-api/src/models/cloud-container.ts` | 修改 | 只读模型对齐新增 `billingAccountId`/`billingStartedAt` |
| `servers/admin-api/src/services/billing/money.ts` | 新增 | 整数分运算工具：`parseCredits`/`formatCredits`/`ceilToCent`/`sum`（禁止浮点） |
| `servers/admin-api/src/services/billing/credit-check.ts` | 新增 | `CreditCheckService.check()`：唯一额度判定入口；判定 `available - estimated >= -creditLimit`；策略 `reject-on-insufficient`/`accrue-and-track`；返回 preCheck 凭证（**裁决 6**）；`verify(preCheck)` 供 payment 校验 |
| `servers/admin-api/src/services/billing/account-service.ts` | 新增 | 账户 get-or-create（按 `ownerType+ownerId`）、查询/状态/授信调整、`reconcileAccount`（按 ledger 求和校准钱包，写 adjust+差错记录） |
| `servers/admin-api/src/services/billing/event-ingest.ts` | 新增 | 事件接入：`eventId` 唯一去重；落 `billingevents`；不解析金额 |
| `servers/admin-api/src/services/billing/metering.ts` | 新增 | 事件 → 计量事实：容器分钟数（按 `windowFrom/To` 切分、尾分钟 `ceil`）、模型三段 token；缺失兜底估算并标 `estimated`；可重放（`metered` 游标重置重扫） |
| `servers/admin-api/src/services/billing/pricing.ts` | 新增 | 用量 × 价目 → 费用；按 `windowFrom` 取生效 `effectiveFrom` 档；产出**单价快照**；`ceil` 到分 |
| `servers/admin-api/src/services/billing/invoicing.ts` | 新增 | 出账：`$inc invoiceSeq` 原子分配 seq、`{accountId,seq}` 唯一兜底；写 `billinginvoices`；累计 rollup 三粒度 |
| `servers/admin-api/src/services/billing/payment.ts` | 新增 | 拆池支付（frozen→cash→gift→credit）；写 ledger（`idempotentKey` 唯一）+ 原子 wallet 条件更新；强制校验 preCheck |
| `servers/admin-api/src/services/billing/receipt.ts` | 新增 | 收据出具（`R<日期><seq>`，含用量、单价快照、金额、余额） |
| `servers/admin-api/src/services/billing/rollup-service.ts` | 新增 | 分钟/小时/天 reduce-sum 累计与查询 |
| `servers/admin-api/src/services/billing/reservation.ts` | 新增 | 预留状态机 `PENDING→ACTIVE→SETTLING→SETTLED`(+`RELEASE_PENDING`)；`version` 乐观锁；`(reservationId,cycleSeq)` 唯一 |
| `servers/admin-api/src/services/billing/api-key-service.ts` | 新增 | Key 生成（`zag_sk_<32hex>`，明文仅返回一次，`keyHash` bcrypt）、校验（前缀索引 + bcrypt，更新 lastUsedAt）、吊销、归属校验 |
| `servers/admin-api/src/migrations/*` | 复用 | 不新增 migration；索引走 Phase 4/6 model 的 `syncIndexes()`（**裁决 16**） |

### 测试用例（增量，TDD）

| # | 用例 | 预期 |
|---|------|------|
| T-B1 | 事件/计量幂等 | 重复 `eventId` 不产生第二条 event/metering |
| T-B2 | 结算可重放 | 同账期重跑计量→定价→账单得到相同金额 |
| T-B3 | 定价单价快照 + 调价 | 新消费取新档、旧账单快照不变（`effectiveFrom`） |
| T-B4 | 账单 seq 并发 | 并发出账 seq 不重不漏（`$inc` + 唯一兜底重试） |
| T-B5 | `creditCheck` 判定矩阵 | `creditLimit=0/>0`、含冻结额、账户 frozen 的拒绝/放行正确 |
| T-B6 | 拆池优先级 | frozen→cash→gift→credit 顺序；预留结算优先耗冻结 |
| T-B7 | ledger/wallet 一致 | 每笔资金变动 ledger 累加恒等于 wallet 字段 |
| T-B8 | 金额整数化 | token 计费 `ceil` 到分；无浮点误差（`0.1+0.2` 类用例） |
| T-B9 | 计量缺失兜底 | 估算入账且 `estimated=true` |
| T-B10 | 追加式不可变 | ledger/invoice/receipt 的 update/delete 抛错 |
| T-B11 | preCheck 校验 | payment/settle 缺凭证或凭证不匹配抛错 |
| T-B12 | 精确核算 | `reconcileAccount` 以 ledger 为准修正 wallet 并写 adjust |

### 命令参考

```bash
cd servers/admin-api && npx vitest run src/services/billing
cd servers/admin-api && npm run build
```

### 验收 checklist

- [ ] `services/billing/*` 单测覆盖率 ≥ 90%（资金相关标准）
- [ ] 六段管线服务均可独立单测（不依赖 RabbitMQ/网络），纯函数与仓储注入清晰
- [ ] 唯一索引与追加式不可变在 `syncIndexes` 后生效；`tsc` strict 通过
- [ ] `available` 公式与金额整数化贯穿全部服务层

---

## Phase 5: admin-api 消息骨干（RabbitMQ 接入 + 消费者 + 结算调度 + 三线对账）

开发分支：`servers/credits-billing`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/services/billing/mq/connection.ts` | 新增 | amqplib 连接 + 自动重连（心跳 30s）+ confirm channel 封装 |
| `servers/admin-api/src/services/billing/mq/topology.ts` | 新增 | 声明 exchange/queue/DLX/retry/DLQ（`zag.billing.events`、`zag.billing.internal`、`billing.metering.q`、`billing.settlement.q`、`billing.*.retry.q`、`billing.*.dlq`）；与 cloud-controller 共用同一拓扑定义口径 |
| `servers/admin-api/src/services/billing/mq/publisher.ts` | 新增 | outbox relay：读 `producer='admin-api'` 未发布行 → `publish(confirm)` → 标记 published（`OUTBOX_RELAY_INTERVAL_MS`） |
| `servers/admin-api/src/services/billing/mq/consumers.ts` | 新增 | 手动 ack 消费者：`billing.metering.q`（事件→计量）、`billing.settlement.q`（周期结算消息）；处理成功才 ack；异常 nack 进 retry（TTL 指数退避），超次进 DLQ；`eventId` 幂等 |
| `servers/admin-api/src/services/billing/settlement-tick.ts` | 新增 | 周期结算器 + 欠费宽限强拆：按 `reservationId` 分区串行（复用 `KeyedMutex` 模式），`(reservationId,cycleSeq)` 幂等（**裁决 7**）；结算 → 用冻结抵本期 → `recheck(下期,accrue-and-track)` → 重冻下期；首期消息由消费者在 reservation ACTIVE 后发布延迟消息；兜底 `setInterval` 扫描 ACTIVE reservation |
| `servers/admin-api/src/services/billing/reconciliation.ts` | 新增 | 三线对账：资金（wallet vs Σledger）、计量（meteringrecords vs billingevents）、资源（ACTIVE reservations vs 存活容器）+ 僵尸预留扫描（`RESERVATION_STALE_MS`）；`BILLING_RECON_CRON`（默认每日 03:00） |
| `servers/admin-api/src/services/billing/scheduler.ts` | 新增 | 统一注册周期任务：outbox relay、对账 cron、reservation 兜底扫描；`start()/stop()` |
| `servers/admin-api/src/index.ts` | 修改 | 连接 Mongo 后 `syncIndexes()`（计费集合）；启动 MQ 连接/消费者/结算调度/对账；zombie 强拆经 `cloudControllerClient.destroy(id, reason)`（**裁决 5**）；`stop` 优雅关闭 |

### 核心流程（容器：保证金 + 周期实扣，对齐提案 §5.1）

```mermaid
sequenceDiagram
    participant CC as cloud-controller
    participant MQ as RabbitMQ
    participant TK as 结算消费者
    participant CK as CreditCheck
    participant ST as 定价/账单/支付
    participant RS as Reservation
    CC->>MQ: container.ready(outbox→confirm)
    MQ->>TK: consume(eventId 幂等)
    TK->>CK: check(保证金, reject)
    alt 额度不足且无授信
        CK-->>TK: allowed=false（进入欠费处置/告警）
    else 通过
        TK->>RS: 建 reservation + freeze(保证金)
        TK->>MQ: publish 延迟 billing.settlement.cycle(seq=0)
    end
    loop 每周期 1 分钟
        TK->>TK: 计量本期分钟→定价→账单→支付(优先冻结)
        TK->>CK: check(下期预估, accrue-and-track)
        alt 可重冻
            TK->>RS: freeze(下期) + publish 下一周期消息
        else 余额不足
            TK->>TK: 持续记账扣费 + insufficientSince 维护
        end
        alt 欠费连续 ≥ 10min
            TK->>CC: DELETE /internal/containers/:id?reason=余额不足超过 10 分钟，强制销毁
            TK->>RS: 最终结算 + 释放冻结 → SETTLED
        end
    end
    CC->>MQ: container.destroyed
    MQ->>TK: consume → 最终结算尾分钟 + 释放冻结
```

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-B13 | 消费幂等 | 重复投递同一事件/同一 `(reservationId,cycleSeq)` 无副作用 |
| T-B14 | 消费者崩溃重投 | at-least-once 不丢（未 ack 消息重投后处理成功） |
| T-B15 | 重试与 DLQ | 处理失败按 TTL 退避重试；超次进 DLQ 且费用中心可见 |
| T-B16 | 乱序安全 | 事件按 `occurredAt` 归位计量，不重复/不漏计 |
| T-B17 | 调度消息丢失兜底 | 删除周期消息后低频扫描仍能结算 |
| T-B18 | 欠费边界 | 9'59" 不拆、10'00" 强拆；宽限内充值清零计时 |
| T-B19 | 释放不被余额阻塞 | 结算时余额不足 → 现金转负 + 冻结照常释放 |
| T-B20 | 资源对账僵尸预留 | ACTIVE 且容器已删 → 强制结算释放；`expectedEndAt` 超期自动结算 |
| T-B21 | 资金对账 | 手工注入 wallet 漂移 → 报告差错并以 ledger 校准 |

### 命令参考

```bash
cd servers/admin-api && npx vitest run src/services/billing
# 真实消息链路（需 broker）
RABBITMQ_TEST_URL=amqp://guest:guest@localhost:5672 npx vitest run src/services/billing/mq
```

### 验收 checklist

- [ ] 消息链路：outbox→confirm→consume 全链路通；重复/乱序安全；DLQ 落信可查
- [ ] 结算由延迟消息驱动，扫描兜底有效；强拆理由写入容器 `exitReason`
- [ ] 三线对账可运行、可手工触发、差错可查；僵尸预留被释放
- [ ] 计费消费积压不阻塞容器/调用业务（消费者可横向扩展）

---

## Phase 6: admin-api 对外接口（OpenAI 网关 + internal REST + 后台 GraphQL）

开发分支：`servers/credits-billing`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/middleware/billing-key-auth.ts` | 新增 | 解析 `Authorization: Bearer zag_sk_<hex>` → 校验 API Key（**裁决 10**，走 Mongo）→ 注入 `accountId`/`apiKeyId` |
| `servers/admin-api/src/routes/billing-openai.ts` | 新增 | `GET /v1/models`（仅 `isEnabled && pricing.isBillable` 且定价完整的全局模型）；`POST /v1/chat/completions`（普通/流式透传，注入 `stream_options.include_usage=true`）；调用前 `creditCheck(reject)` → 402；转发供应商（解密凭据，OpenAI/Anthropic 形状转换）；采集 usage → 写 `billingapicalls` + **outbox**（`model_call.completed`/`aborted`，中断与缺失兜底 `estimated`）（**裁决 12/13/14**）；复用 `SlidingWindowRateLimiter` 限速 |
| `servers/admin-api/src/routes/internal-billing.ts` | 新增 | `/internal/billing/account`(GET, get-or-create)、`/invoices`、`/receipts`、`/rollups`、`POST /api-keys`、`DELETE /api-keys/:id`（Bearer `INTERNAL_API_TOKEN` 鉴权，复用 `middleware/internal-auth` 风格） |
| `servers/admin-api/src/graphql/schemas/billing.ts` | 新增 | 按 `contracts/admin-billing.graphql` 定义 typeDefs |
| `servers/admin-api/src/graphql/resolvers/billing.ts` | 新增 | `adminBilling*` Query 与全部 Mutation；`rechargeBillingAccount` 要求管理员身份（复用 `assertAdmin`）；`updateModelPricing` 同步 `Model.pricing` + `productprices`（裁决 11） |
| `servers/admin-api/src/graphql/schemas/index.ts` | 修改 | 注册 `billingTypeDefs` |
| `servers/admin-api/src/graphql/resolvers/index.ts` | 修改 | 注册 `billingResolvers`（Query/Mutation + 类型级字段） |
| `servers/admin-api/src/models/model.ts` 对应 service | 修改 | `services/model.ts` 的 `mapModel` 回填 `pricing`；`adminModels` 查询透出定价 |
| `servers/admin-api/src/index.ts` | 修改 | 挂载 `/v1`（gateway 路由，无需 admin JWT，走 Key 鉴权）与 `/internal/billing`（`INTERNAL_API_TOKEN`）；保留 `/graphql` |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-B22 | `GET /v1/models` | 仅返回已启用且可计费且定价完整模型 |
| T-B23 | 401/404/402/429 | 无效 Key 401 `invalid_api_key`；未知模型 404；余额不足且无授信 402 `insufficient_quota`（**不产生账单**）；限速 429 |
| T-B24 | 非流式计费 | 按三段 token 出账 + 收据，费用与定价吻合 |
| T-B25 | 流式计费 | 采集 usage，SSE 透传，出账一致 |
| T-B26 | 中断计费 | 客户端断开/上游中断 → `model_call.aborted`，按已产生用量出账并标注 |
| T-B27 | 计量缺失兜底 | usage 缺失 → `estimated=true` 估算出账 |
| T-B28 | 有授信透支 | 后台账户授信内余额为负仍可调用 |
| T-B29 | 未开启计费模型 | 放行、记录 `billingapicalls`、不产生账单；未定价 → 400 `model_not_priced` |
| T-B30 | `/internal/billing/*` 鉴权 | 无 token 401 |
| T-B31 | 后台 GraphQL | 账户/账单/收据/汇总/充值/授信/Key/对账契约一致；充值入 cash 池、生成账单+收据 |

### 命令参考

```bash
cd servers/admin-api && npx vitest run
cd servers/admin-api && npm run build
```

### 验收 checklist

- [ ] `/v1` 全端点契约一致（OpenAPI），错误码与 OpenAI 兼容
- [ ] 网关只写 outbox 即返回（不阻塞响应）；供应商凭据不透出
- [ ] 后台 GraphQL 全部 Query/Mutation 契约测试通过
- [ ] 后台账户为负（授信内）可调用；未定价模型拒绝且有明确提示

---

## Phase 7: agent-api 前台费用（billing.graphql + internal REST 客户端）

开发分支：`servers/credits-billing`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/config/index.ts` | 修改 | 新增 `adminApiUrl`（`ADMIN_API_URL`）、`internalApiToken`（`INTERNAL_API_TOKEN`）；缺失时不 fail-fast，调用写操作返回明确错误 |
| `servers/agent-api/src/services/billing-client.ts` | 新增 | 参照 `admin-api/services/cloud-controller-client.ts` 模式：原生 `fetch` + `AbortController` 超时 + Bearer；封装 `/internal/billing/*`（account/invoices/receipts/rollups/api-keys） |
| `servers/agent-api/src/graphql/schemas/billing.ts` | 新增 | 按 `contracts/billing.graphql` 定义 typeDefs（复用 `Billing*` 类型，需与 admin-api 命名一致） |
| `servers/agent-api/src/graphql/resolvers/billing.ts` | 新增 | `myBilling*` Query：从上下文取 `currentUser._id` → `ownerType=front_user` 经 billing-client 转发；`createMyBillingApiKey`/`revokeMyBillingApiKey`；充值 mutation 不提供 |
| `servers/agent-api/src/graphql/schemas/index.ts` | 修改 | 注册 `billingTypeDefs` |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 注册 `billingResolvers`（含类型级字段） |
| `servers/agent-api/src/models/model.ts` | 修改 | 同步新增 `pricing` 子文档（只读展示，**裁决 18**） |
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | `agentApi` 注入 `ADMIN_API_URL`（= admin-api endpoint）与 `INTERNAL_API_TOKEN` |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-A1 | `myBillingAccount` | 首次访问 get-or-create 前台账户，返回余额/冻结/欠费 |
| T-A2 | 账单/收据/汇总 | 按 ownerId 正确过滤，分页/时间范围/粒度生效 |
| T-A3 | `createMyBillingApiKey` | 返回完整 secret 一次；列表仅前缀 |
| T-A4 | `revokeMyBillingApiKey` | 归属校验后吊销；非本人拒绝 |
| T-A5 | 无充值 mutation | schema 不存在任何充值入口 |
| T-A6 | admin-api 不可达 | 返回明确错误（不静默空值） |

### 命令参考

```bash
cd servers/agent-api && npx vitest run
cd servers/agent-api && npm run build
```

### 验收 checklist

- [ ] 前台「我的费用」GraphQL 契约一致；计费写路径不落在 agent-api（仅只读 + Key 转发）
- [ ] 完整 API Key 仅生成时可见，吊销立即失效
- [ ] `ADMIN_API_URL`/`INTERNAL_API_TOKEN` 由 Aspire 注入

---

## Phase 8: admin-web 费用中心界面

开发分支：`apps/credits-billing`。前端规范见 `docs/engineering/frontend-rules.md` 与 `apps/admin-web/AGENTS.md`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/admin-web/src/graphql/queries.ts` | 修改 | 新增 `ADMIN_BILLING_ACCOUNTS`/`ACCOUNT`/`INVOICES`/`RECEIPTS`/`ROLLUPS`/`RESERVATIONS`/`RECONCILIATION_REPORTS`/`API_KEYS` |
| `apps/admin-web/src/graphql/mutations.ts` | 修改 | 新增 `RECHARGE`/`SET_CREDIT_LIMIT`/`SET_ACCOUNT_STATUS`/`RECONCILE_ACCOUNT`/`RUN_RECONCILIATION`/`UPDATE_MODEL_PRICING`/`CREATE_API_KEY`/`REVOKE_API_KEY` |
| `apps/admin-web/src/graphql/types.ts` | 修改 | 手写 `BillingAccount`/`BillingInvoice`/`InvoiceItem`/`BillingReceipt`/`BillingRollup`/`BillingReservation`/`BillingApiKey`/`ReconciliationReport` 及查询响应类型（与 `contracts/admin-billing.graphql` 人工对齐） |
| `apps/admin-web/src/pages/BillingPage.tsx` | 新增 | 费用中心：账户列表 + 详情抽屉（余额/冻结卡、账单表、收据、分钟/小时/天汇总图、充值、精确核算、授信调整） |
| `apps/admin-web/src/pages/ReconciliationPage.tsx` | 新增 | 对账中心：三线结果、差错明细、手动触发 |
| `apps/admin-web/src/components/billing/AccountTable.tsx` | 新增 | 账户概览与检索筛选 |
| `apps/admin-web/src/components/billing/RechargeDialog.tsx` | 新增 | 充值对话框（0.01 精度校验、备注） |
| `apps/admin-web/src/components/billing/InvoiceTable.tsx` | 新增 | 账单明细表（序号/时间/类型/金额/入账后余额/来源/描述） |
| `apps/admin-web/src/components/billing/ReceiptDrawer.tsx` | 新增 | 收据查看（用量/单价/金额/余额） |
| `apps/admin-web/src/components/billing/RollupChart.tsx` | 新增 | 汇总趋势图（分钟/小时/天） |
| `apps/admin-web/src/components/billing/MyApiKeyManager.tsx` | 新增 | 后台用户自有 API Key 管理（生成一次性展示、吊销） |
| `apps/admin-web/src/pages/ModelConfigPage.tsx` | 修改 | 模型列表/详情增加定价编辑（输入/缓存输入/输出每百万 token + 计费开关），落 `updateModelPricing` |
| `apps/admin-web/src/App.tsx` | 修改 | 新增路由 `/billing` → `BillingPage`、`/reconciliation` → `ReconciliationPage` |
| `apps/admin-web/src/components/AdminLayout.tsx` | 修改 | `NAV_ITEMS` 追加「费用中心」「对账中心」 |
| `apps/admin-web/src/lib/format.ts` | 修改 | 金额（分↔credits）展示格式化助手（如缺） |
| `apps/admin-web/src/pages/__tests__/*.test.tsx`、`components/__tests__/*.test.tsx` | 新增 | 关键交互组件测试（充值校验、账单渲染、Key 一次性展示） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-AW1 | 账户列表渲染与筛选 | 余额/冻结/授信/欠费状态展示正确 |
| T-AW2 | 充值对话框校验 | 0/负数/超精度被拒；成功后 refetch |
| T-AW3 | 账单/收据 | 明细与收据字段对齐契约 |
| T-AW4 | 汇总图 | 切换分钟/小时/天触发对应查询 |
| T-AW5 | API Key | 生成时一次性展示完整 Key，关闭后不可再取 |
| T-AW6 | 定价编辑 | 保存调用 `updateModelPricing` 并回显 |

### 命令参考

```bash
cd apps/admin-web && npm run build
cd apps/admin-web && npx vitest run
cd apps/admin-web && npm run lint
```

### 验收 checklist

- [ ] 费用中心/对账中心可从导航进入；页面加载守卫为 `loading && !data`
- [ ] 充值、授信调整、强拆等敏感操作有确认与操作人可审计
- [ ] 定价编辑与后台 GraphQL 一致；前端类型与契约人工对齐

---

## Phase 9: agent-web 我的费用界面

开发分支：`apps/credits-billing`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增 `MY_BILLING_ACCOUNT`/`MY_INVOICES`/`MY_RECEIPTS`/`MY_ROLLUPS`/`MY_API_KEYS` |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `CREATE_MY_API_KEY`/`REVOKE_MY_API_KEY` |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 手写前台账单类型（与 `contracts/billing.graphql` 对齐） |
| `apps/agent-web/src/pages/BillingPage.tsx` | 新增 | 我的费用：余额/冻结、欠费提示、账单明细、收据、按天/小时汇总、充值引导文案、API Key 管理 |
| `apps/agent-web/src/App.tsx` | 修改 | 新增路由 `/billing`（保护路由内，`MainLayout` 下） |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 新增「我的费用」入口（桌面 + 移动端各一处，参照现有 `settings` 入口位置） |
| `apps/agent-web/src/pages/__tests__/BillingPage.test.tsx` | 新增 | 余额/欠费/账单/Key 交互测试（或并入既有测试约定） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-AW7 | 余额与欠费提示 | 余额为负时展示欠费提示与充值引导（无自助充值入口） |
| T-AW8 | 账单/收据/汇总 | 与前台 GraphQL 契约一致 |
| T-AW9 | API Key | 生成一次性展示、吊销确认 |

### 命令参考

```bash
cd apps/agent-web && npm run build
cd apps/agent-web && npx vitest run
cd apps/agent-web && npm run lint
```

### 验收 checklist

- [ ] 前台可见余额/冻结/欠费/账单/收据/汇总/API Key，无任何自助充值入口
- [ ] 移动端与桌面端入口均可达

---

## Phase 10: 测试与验收收口（API + E2E + 消息链路 + 文档 + PR）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/admin-api/billing.test.ts` | 新增 | 后台 GraphQL 契约一致性、充值/授信/账单/收据/汇总/对账、`/internal/billing/*` 鉴权 |
| `tests/api/src/admin-api/billing-gateway.test.ts` | 新增 | `/v1/models`、`/v1/chat/completions`（流式/非流式/中断/401/402/404/400/429） |
| `tests/api/src/agent-api/billing.test.ts` | 新增 | `myBilling*` 前后台归属与只读约束 |
| `tests/api/src/cloud-controller/billing-events.test.ts` | 新增 | 就绪/销毁事件入 outbox、字段与强拆 reason |
| `tests/api/src/admin-api/helpers.ts`、`tests/api/src/agent-api/*`、`tests/e2e/src/helpers.ts` | 修改 | 补充计费用测试夹具（账户、模型定价、API Key） |
| `tests/e2e/src/admin-billing.spec.ts` | 新增 | 后台：充值 → 账户/账单/收据/汇总可见；定价设置；对账触发 |
| `tests/e2e/src/billing.spec.ts` | 新增 | 前台：充值→启动容器（含初始化）→保证金冻结→分钟账单/收据→欠费 10min 强拆+释放；建 Key→调模型→账单/收据→余额不足 402→充值恢复；事件丢失场景资源对账兜底释放 |
| `docs/engineering/AGENTS.md` | 修改 | 「实现计划（`plan/`）」索引新增 `20261018-feat-credits-billing.md` |
| `docs/engineering/plan/AGENTS.md` | 复用 | 无结构变更 |
| `docs/product/draft/20261018-credits-billing.md` | 复用 | 本期不移动生命周期目录（**裁决 17**） |

### 命令参考

```bash
# 各子项目
cd servers/admin-api && npm run build && npx vitest run
cd servers/agent-api && npm run build && npx vitest run
cd servers/cloud-controller && npm run build && npx vitest run
cd apps/admin-web && npm run build && npx vitest run && npm run lint
cd apps/agent-web && npm run build && npx vitest run && npm run lint
# 集成 API / E2E
cd tests/api && npx vitest run
cd tests/e2e && npx playwright test
# 编排
aspire start
```

### 总体验收 checklist（对齐提案 §10 / PRD §1.3）

- [ ] Contract 评审通过（admin-billing / billing / billing-openai / billing-events / 存量契约变更）
- [ ] 代码实现完成（六段管线、RabbitMQ 事件骨干与 outbox、预留/结算、计费网关、两侧 GraphQL、两侧界面、cloud-controller 事件与字段链路）
- [ ] 消息链路验收通过（outbox 补投、confirm、DLQ 处置、积压不阻塞业务、乱序/重复安全）
- [ ] 单元测试覆盖达标（billing ≥ 90%，含幂等/重放/状态机用例）
- [ ] API 测试通过（含 `/v1` 全错误码、内部 REST 401）
- [ ] E2E 通过（充值→保证金→周期结算→欠费强拆+释放；API Key 调用→402→充值恢复；事件丢失→对账兜底）
- [ ] 对账三线演示通过（差错注入 → 发现 → 校准/释放）
- [ ] PRD §1.3 成功标准逐条演示通过（账单序号从 0 连续、任一笔可完整回溯、快照余额与精确核算一致）
- [ ] 实现分支 PR 合并回 `feat/credits-billing`，需求总 PR #229 自动更新；实现计划文档保留在需求总分支

## 实现记录（2026-10-18，返工后 v1.1）

- **实现分支**: `impl/credits-billing`（基于需求总分支 `feat/credits-billing`）。
- **返工修复（代码审核打回项）**:
  1. **预检凭证 ref 统一**：`handleContainerReady` / `ReservationService.start` / `payment.freeze` 统一以 `resourceId` 作为 `ref.id`，ready→freeze 全链路集成测试通过。
  2. **金额单位统一**：`toBillingAccountWire` 等契约边界统一 `分 → credits`；删除零调用死代码 `toBillingAccount`；前台/后台账户接口口径一致。
  3. **结算步骤级幂等**：周期记录改为资金动作完成后的结果标记；账单增加 `idempotentKey` 唯一稀疏索引与确定性 `invoiceId`；final settle 尾结/释放均以幂等键重入，崩溃重跑不重复扣费/开票；`KeyedMutex` 按 reservation 串行。
  4. **冻结账户可继续记账**：`accrue-and-track` 在账户冻结/缺失时同样返回预检凭证（不再 `preCheck!` 抛错进入 DLQ）。
  5. **rollup 与出账解耦**：仅在 `BillingInvoice.create` 发生 E11000 时重试；rollup 失败仅告警（后补）。
  6. **预留唯一性**：`billingreservations.resourceId` 唯一索引兜底并发 start；`lastCycleSeq` 初始 `-1`，首期（seq 0）丢消息可由扫描兜底；`expectedEndAt` 随周期推进写入。
  7. **无冻结不解冻**：仅当对应 `freeze` 流水存在时才解冻；预留累计口径改为以 ledger 聚合重算。
  8. **对账防误伤**：资源对账在控制面列表失败时中止本线，不再批量结算 ACTIVE 预留；资金对账分页遍历全部账户。
  9. **MQ 可靠性**：消费者运行时自动重连/重订阅；重试改为 per-message `expiration` 指数退避（5s→5min）；超次死信落 `billingdeadletters` 并新增 `adminBillingDeadLetters` 查询；结算消息补齐 `accountId`；优雅关闭（SIGTERM/SIGINT → scheduler/MQ/Mongo）。
  10. **拆池支付**：现金 → 赠送金 → 授信（透支为负现金），ledger `allocations` + payment `pools` 留存拆池明细。
  11. **网关口径**：上游报错/超时按中断（aborted）计费并标注；用量缺失兜底按已收内容或请求输出上限估算（不低估），payload 增加 `estimatedInputTokens/estimatedOutputTokens`。
  12. **cloud-controller 终态补投**：`markExited/markFailed/reclaimResidualJob` 等非 destroy 终态同样投递 `container.destroyed`；`markOnline` 以条件更新原子写入 `billingStartedAt`。
  13. **前端**：agent-web 增加 `loading && !data` 守卫与错误展示；吊销 Key/授信调整/账户冻结均二次确认；分页；模型定价移入 `ModelConfigPage`（计划口径）。
  14. **编排**：`aspire/manifest/docker-compose.yaml` 已手工补齐 `rabbitmq` 服务、`RABBITMQ_URL`/`ConnectionStrings__rabbitmq` 与 agent-api `ADMIN_API_URL`/`INTERNAL_API_TOKEN`（`aspire publish` 在本环境 NuGet restore 不可达，manifest 与 AppHost 声明保持一致）。
- **测试（返工后）**:
  - `servers/admin-api/src/services/billing` 行覆盖率 **94.77%**（语句 89.54% / 函数 90.62%），覆盖 T-B1~T-B21 与 MQ 拓扑/消费/发布/重连。
  - cloud-controller 计费事件 T-CC-B1~B9、internal API 计费字段/强拆 reason。
  - 前端费用组件/页面交互：后台账户列表、充值校验、汇总、模型定价、前台欠费提示/Key 一次性展示/吊销确认。
  - `tests/api/src/admin-api/billing.test.ts`、`billing-gateway.test.ts`、`tests/api/src/agent-api/billing.test.ts`、`tests/api/src/cloud-controller/billing-events.test.ts`。
  - `tests/e2e/src/admin-billing.spec.ts`、`tests/e2e/src/billing.spec.ts`。
  - `RABBITMQ_TEST_URL` 条件链路测试：`src/services/billing/mq/rabbitmq.integration.test.ts`（未配置 broker 时 skip，裁决 15）。
- **仍留待真实环境演示**: 容器分钟计费→欠费强拆、网关流式/中断真实供应商调用、RabbitMQ 全链路在 CI broker 下执行（代码与条件测试已就位）。

## 实现记录（2026-10-19，返工 v1.2）

- **实现分支**: `impl/credits-billing`（基于需求总分支 `feat/credits-billing`）。
- **返工修复（代码审核第二轮打回项）**:
  1. **中-1 中断调用标注落到计费明细并可查（T-B26 彻底修复）**：`handleModelCallEvent` 对 `model_call.aborted` 生成明细描述「模型调用（中断：<reason>[，估算]） <model>」；账单 item 新增 `segment` 并以 `:aborted` 后缀标注（如 `output:aborted`）；`InvoiceItem.segment` 同步进 admin/前台契约与后台收据/前台收据展示。新增 `BillingApiCall` 出口：后台 `adminBillingApiCalls(accountId,status,page,pageSize)`、前台 `myBillingApiCalls`、内部 `GET /internal/billing/api-calls`，后台费用中心与前台「我的费用」新增「模型调用记录」表（完成/中断调用/失败 + 估算标注）。单测断言描述含「中断/<reason>」且 segment 含 `aborted`；agent-web 页面测试断言「中断调用」可见。
  2. **中-2 冻结账户拒绝启动新容器（PRD §3.5）**：`adminStartCloudContainer` 解析计费账户后校验 `status !== 'frozen'`，冻结则抛 `ACCOUNT_FROZEN`「账户已冻结，无法启动容器；请先充值或联系管理员处理」；已运行容器仍按欠费记账→宽限强拆。resolver 单测新增冻结拒绝断言。
  3. **低-3 agent-web 分页对齐**：账单、收据、调用记录均改 `pageSize=20` 并提供上/下一页（与 admin-web 一致）。
  4. **低-4 冻结提示口径**：网关 402 按 `check.reason` 区分——`ACCOUNT_FROZEN` → `account_frozen`/「账户已冻结，请联系管理员处理」，否则 `insufficient_quota`/「余额不足，请联系管理员充值」。
  5. **低-5 mappers 注释更正**：`mappers.ts` 注释改为「AccountService DTO（整数分）→ 契约 wire（金额换算为 credits）」，消除「已换算 credits」的二次换算隐患。
  6. **低-6 预检 ref 唯一化**：网关预检 `ref.id` 改为 `requestId`，与 `handleModelCallEvent` 扣费 ref 完全一致。
- **真实验证（本机 Aspire 全栈，`aspire start`，RabbitMQ 实容器）**:
  - `tests/api` 计费四件套（admin billing / billing-gateway / agent billing / cloud-controller billing-events）**10 passed**（注入 `INTERNAL_API_TOKEN`，真实服务端口 10003/10001/10004）。
  - `tests/e2e/src/admin-billing.spec.ts`（后台费用中心+对账）**2 passed**、`tests/e2e/src/billing.spec.ts`（前台我的费用+Key 一次性）**1 passed**，均跑在 AppHost 起的真实前后端（admin-web/agent-web 由 Aspire 托管）。
  - `aspire/AgentGear.AppHost` RabbitMQ 依赖以 NuGet 离线恢复（`NUGET_CERT_REVOCATION_MODE=offline`）后编译通过；镜像经内网 Harbor docker-hub 代理补齐本地 `rabbitmq:3-management`。
- **环境注记**: 全量 `tests/api` 中非计费套件（controller-api websocket / 会话等）依赖的端口与外部集成在共享环境存在既有不稳定，计费相关套件与 E2E 已在本机真实服务下全绿；其余待 CI 复核。

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| 新增 RabbitMQ 部署资源（Aspire/compose）落地困难 | 本地开发用 `rabbitmq:3-management` 单容器；拓扑与消费者均幂等声明/启动；出站失败由 outbox 补投 + 对账兜底，MQ 短暂不可用不丢消费 |
| outbox 与业务状态非事务一致（Mongo 非副本集） | 顺序写 + 失败仅告警 + 资源/计量对账兜底（裁决 2）；不引入 2PC |
| 网关变为计费瓶颈 / 增加调用延迟 | 网关只写 outbox 即返回；预检只读钱包单文档（<5ms）且无远程调用；计费追赶异步 |
| 金额浮点误差导致账不平 | 全链路整数分运算（裁决 9）；`money.ts` 统一入口；单测覆盖 `0.1+0.2` 类用例 |
| 并发出账/资金丢失更新 | `$inc invoiceSeq` + `{accountId,seq}` 唯一兜底重试；wallet 原子条件更新；`idempotentKey` 唯一 |
| 僵尸预留/事件丢失导致漏计或漏释放 | 三线对账 + 僵尸预留扫描 + `expectedEndAt` 自动结算；强拆释放不被余额阻塞 |
| 计费侧回查业务库导致耦合 | 事件携带全部规格/单价/时段；admin-api 不直连 K8s（复用 cloud-controller-client） |
| API Key 校验引入 admin-api Redis 的新依赖 | 本期不引入（裁决 10），走 Mongo 前缀索引 + bcrypt；后续可加缓存 |
| 旧容器/存量数据无 `billingAccountId` | 反向兼容：仅对带 `billingAccountId` 的容器计费；存量用户首次使用时懒建账户（初始余额 0） |
| 强拆误伤正常容器 | 仅对连续 10 分钟 `insufficient` 的账户触发；宽限内充值清零计时；reason 可审计 |
| 双侧 `Model.pricing` schema 漂移 | 同步演进并加注释（裁决 18）；契约 `ModelPricing` 双侧字段逐字一致 |

## 相关文档

- 关联 PRD：`docs/product/draft/20261018-credits-billing.md`（v2.1）
- 关联 Proposal：`docs/engineering/proposals/20261018-feat-credits-billing.md`（v2.1）
- 上游依赖：`docs/engineering/proposals/20261014-feat-cloud-agent-phase2.md`（容器生命周期）、`docs/engineering/proposals/20261017-feat-cloud-controller-workload.md`（初始化完成语义）
- 开发规范：`docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`、`docs/engineering/frontend-rules.md`
- 既有契约：`contracts/cloud-controller-websocket.md`、`contracts/admin-cloud-container.graphql`、`contracts/admin-llm.graphql`、`contracts/llm.graphql`
- 既有实现参考：`servers/admin-api/src/services/cloud-controller-client.ts`（内部 REST 客户端模式）、`servers/admin-api/src/graphql/resolvers/index.ts`（resolver 注册）、`servers/cloud-controller/src/services/container-service.ts`（生命周期 CAS）、`servers/cloud-controller/src/services/keyed-mutex.ts`、`servers/agent-api/src/services/key-cache.ts`
- 工程文档规范：`docs/engineering/AGENTS.md`、`docs/engineering/plan/AGENTS.md`
