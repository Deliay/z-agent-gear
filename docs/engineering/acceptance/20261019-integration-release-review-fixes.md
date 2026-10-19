---
description: integration→release（PR #238）集成级 AI Review 首轮打回后的返工对账报告——「修复声明 ↔ 实现」逐条映射（3 阻断 + 13 重要 + 随修项），覆盖 admin-api 与 cloud-controller 的 outbox/消费副本
type: Permanent
---

# integration→release 返工对账（2026-10-19，修复Review意见节点）

> **状态**: ✅ 返工完成，待复核（不采信自报数据；本轮已在本机以 Aspire 全栈实跑 API/E2E）。
> 上游验收报告：`docs/engineering/acceptance/20261019-integration-release-acceptance-report.md`（打回）。
> 基线：`integration` @ `9531916`（= `origin/main`），目标 `release` @ `283e542`。

## 一、独立复跑结果（本机实跑）

| 层 | 命令 | 结果 |
|---|---|---|
| admin-api 单测 | `npx vitest run`（MONGOMS_SYSTEM_BINARY=/usr/bin/mongod） | ✅ 514 passed / 1 skipped |
| admin-api 类型 | `npx tsc --noEmit` | ✅ 0 |
| cloud-controller 单测/类型 | `npx vitest run` / `npx tsc --noEmit` | ✅ 197 passed / 0 |
| admin-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error / 207 passed |
| agent-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error（6 存量 warning）/ 429 passed |
| tests/api（Aspire 全栈，`K8S_ENABLED=false`） | `npx vitest run` | ✅ 453 passed / 1 skipped（此前 3 项 `cloud-controller/billing-events` 假绿已实跑） |
| tests/e2e（费用 3 例） | `npx playwright test admin-billing.spec.ts billing.spec.ts` | ✅ 3 passed |

## 二、阻断项（3/3）

### R-1 计费事件乱序 → 同一会话重复计费

| 修复声明 | 实现（file:line） |
|---|---|
| 消费端按 `resourceId` 时序门控：已摄入 `destroyed` 或已存在 legacy 终结计费键时，迟到 `ready` 不建预留、不启动结算链 | `servers/admin-api/src/services/billing/billing-service.ts`：`handleContainerReady` 内 `BillingEvent.exists({resourceId,eventType:'container.destroyed'})` 与 `BillingLedger.exists({idempotentKey:'charge:container:<rid>:final'})` 判定 → 返回 `{created:false, skipped:true}`；消费端 `mq/consumers.ts` 仅 `!skipped && reservationId && (created||retry>0)` 才 `publishSettlement` |
| ready/destroyed 同锁串行且在锁内**重新读取**预留，消除「ready 建预留 vs destroyed 读到空 → legacy 全额」竞态 | `billing-service.ts`：`handleContainerDestroyed` 改为整体在 `billingMutex.runExclusive('container:<rid>')` 内、锁内 `findByResource`，再进入 `finalizeReservation`（`reservation:<id>` 锁） |
| outbox relay 顺序性：单条失败后**停止本轮**（不再 continue 发后一条），并释放剩余认领 | `servers/cloud-controller/src/services/billing-event-publisher.ts` `relayOnce`（`break` + `repository.release`）；`servers/admin-api/src/services/billing/mq/publisher.ts` `relayOnce`（`break` + `releaseClaims`）——**覆盖两份 outbox 实现** |
| 乱序集成测试：ready/destroyed 逆序只产生一笔计费 | `servers/admin-api/src/services/billing/billing-flow.test.ts` → 「R-1: destroyed 先于 ready 被消费时同一资源只产生一笔计费（乱序门控）」 |

### A-1 预留回滚无 freezeExists 守卫 → 蚕食他人冻结额

| 修复声明 | 实现（file:line） |
|---|---|
| 回滚前校验对应 freeze 流水是否存在，仅解冻**实际冻结额**（与 `settleCycle` 同口径） | `servers/admin-api/src/services/billing/reservation.ts`：`rollbackFreeze()` 查 `BillingLedger.findOne({accountId, idempotentKey})`，命中才 `unfreeze(frozen)`；`start` catch 对 deposit/cycle 两键分别调用 |
| `settleCycle` 的 freezeExists 也补账户过滤 | `reservation.ts` `BillingLedger.exists({idempotentKey: freezeKey, accountId})` |
| 回归：同账户并存预留 B 不受 A 回滚影响；无 freeze 落账时零 unfreeze | `review-fixes.test.ts` → 「A-1：start 回滚仅解冻『确实落账』的冻结额」「A-1：A 预留回滚不得蚕食同账户并存预留 B 的冻结额」 |

### A-2 `appliedLedgerIds` 水位淘汰后重放二次记账

| 修复声明 | 实现（file:line） |
|---|---|
| 新增**不淘汰**的独立幂等集合 `billingappliedledgers`（`{accountId,ledgerId}` 唯一索引） | `servers/admin-api/src/models/billing-applied-ledger.ts`（新增）；`index.ts` `billingModels` 注册 `syncIndexes` |
| 应用状态机：`applied` → no-op；`pending`（在途）→ 不重复；`pending` 且租约过期 → 按 ledger 真值**绝对校准**自愈（不再 `$inc`） | `servers/admin-api/src/services/billing/payment.ts`：`applyLedgerDelta` / `claimLedgerApplication` / `markLedgerApplied` / `healWalletFromLedger`；`LEDGER_APPLY_LEASE_MS = 60s` |
| 对账把钱包校准到 ledger 真值后，把**全部**历史行登记为已应用 | `account-service.ts`：`reconcileAccount` 调用新增 `markAllLedgerApplied` |
| 回归：同账户灌 1001 条流水后重放旧键余额不变 | `review-fixes.test.ts` → 「A-2：水位淘汰（>1000 条）后重放旧幂等键不再二次记账」 |

## 三、重要项（13/13）

| # | 修复声明 | 实现（file:line） |
|---|---|---|
| A-3 | stale 判定读**最新** `expectedEndAt`；finalize 前复核控制面存活，存活只补结算不置 SETTLED；SETTLED 后迟到 destroyed 补结缺额 | `settlement-tick.ts`（`isAlive` 注入、`findByIdSafe` 回读、跳过存活）；`reconciliation.ts` `reconcileResources`（存活仅上报 `reservation_expired_but_container_alive`）；`reservation.ts` `finalSettle` + `settleTailAfterSettled`（`charge:final-gap:<rid>:<from>`）；装配 `instances.ts` `isCloudContainerAlive` + `index.ts` |
| A-4 | 双定价源一致：`priceModel` 缺 productprices 档时回落 `models.pricing`；`isBillable=false` 不扣费 | `pricing.ts` `modelPricingFallback` + `priceModel`；测试 `pricing.test.ts`「A-4: productprices 缺档时回落 models.pricing」 |
| A-5 | `heldFrozen` 加 `accountId` 过滤 + `bizId` 正则转义；`recomputeTotals` 同 | `reservation.ts` `escapeRegExp` / `heldFrozen(reservationId, accountId)` / `recomputeTotals`；回归 `review-fixes.test.ts`「A-5: heldFrozen 过滤账户且转义正则」 |
| A-6 | `loadLedger` 按账户回读；`applyLedgerDelta` 断言归属不符即抛 | `payment.ts` `loadLedger(idempotentKey, accountId)`、`applyLedgerDelta` 首段校验；回归 `review-fixes.test.ts`「A-6：同幂等键但归属另一账户时拒绝应用」 |
| O-1 | ① 钩子同步调用 + 3 次重试（失败记 error），容器文档（`billingStartedAt/exitedAt`）为持久补偿源；② SIGTERM 前 `drainBillingHooks()`；③ 反向对账线 `events` 补投 ready/destroyed；④ 契约 A.3.1 措辞修正 | `cloud-controller/src/services/container-service.ts`（`emitHook`/`drainBillingHooks`）；`cloud-controller/src/index.ts` stop 顺序；`admin-api/src/services/billing/reconciliation.ts` `reconcileEvents`/`repairEvent`；`contracts/cloud-controller-websocket.md` A.3.1 |
| O1 | admin 计费 resolver 统一 GraphQL 错误映射（稳定 `extensions.code`） | `admin-api/src/graphql/resolvers/billing.ts` `toBillingGraphQLError` + `mapResolvers` 包裹全部 Query/Mutation（与 cloud-container `toGraphQLError` 同口径） |
| T-1 | 环境变量改为 `CLOUD_CONTROLLER_INTERNAL_TOKEN`；去重并补真实事件链路断言；AGENTS 清单补齐 | `tests/api/src/cloud-controller/billing-events.test.ts`（T-CC-B11 断言 outbox `container.destroyed`）；`tests/api/AGENTS.md` 新增 Billing 计费 API 章节 |
| T-2 | T-B22 断言语义（排除未定价/非计费）；T-B23 补 `model_not_priced` | `tests/api/src/admin-api/billing-gateway.test.ts` 新增「计费网关分支覆盖（直写模型）」 |
| D-1 | 契约补 `adminBillingReceipt(invoiceId)` 直查；前端改用直查 + loading/error 三态 | `contracts/admin-billing.graphql`、`admin-api/src/graphql/schemas/billing.ts`、`resolvers/billing.ts` `adminBillingReceipt`；`apps/admin-web/src/graphql/{queries,types}.ts`、`pages/BillingPage.tsx`、`components/billing/ReceiptDrawer.tsx` |
| D-2 | `selected` 由 `selectedId` + `useMemo(accounts.find)` 派生；mutation 后 merge 返回值 | `apps/admin-web/src/pages/BillingPage.tsx` |
| D-3 | 收据按产品标注单位（credits/百万 token vs credits/分钟）并给出自洽等式，避免极小费率显示 0.0000 | `apps/{admin,agent}-web/src/lib/billing-format.ts`（新增）；`ReceiptDrawer.tsx`、`agent-web/src/pages/BillingPage.tsx` |
| D-4 | 账单/调用/汇总三态（loading/error/empty）；充值成功后刷新账单与收据 | `apps/admin-web/src/pages/BillingPage.tsx`（`onRechargeSuccess`）、`apps/agent-web/src/pages/BillingPage.tsx` |
| D-5 | RabbitMQ 走内网镜像源（`RABBITMQ_IMAGE` 可覆盖）+ healthcheck + depends_on | `aspire/AgentGear.AppHost/AppHost.cs`、`aspire/manifest/docker-compose.yaml`、`aspire/AgentGear.AppHost/AGENTS.md` |

## 四、随修（5.3 优先级项）

| 建议 # | 修复声明 | 实现 |
|---|---|---|
| 1 | `updateModelPricing` 强制 `scope=global`；价目按 `productId` upsert，避免无限累积 | `resolvers/billing.ts` `updateModelPricing` |
| 3 | 对账 `line` 白名单 | `reconciliation.ts` `RECONCILIATION_LINES`/`isReconciliationLine` + `resolvers/billing.ts` `runReconciliation` |
| 5 | 迁移锁过期清理用 `deleteMany`；释放校验归属 `owner` | `migrations/models.ts`、`migrations/runner.ts`；测试 `migrations/runner.test.ts` |
| 15 | 中断时 input 有值、output=0 但已产生文本 → 按文本估算输出（不少计） | `routes/billing-openai.ts` `finalize` |
| 16 | outbox 发布头携带真实 `x-retry-count`（broker 重投后补投判据不失效） | `admin-api/.../mq/publisher.ts`、`cloud-controller/.../billing-event-publisher.ts` `publish(routingKey, message, attempt)` |
| 19 | 搜索重置页码；授信空输入不静默置 0；分页空页提示 | `apps/{admin,agent}-web/src/pages/BillingPage.tsx` |
| 21 | API Key secret 不入 Apollo 规范化缓存（`fetchPolicy:'no-cache'`） | `apps/admin-web/src/components/billing/MyApiKeyManager.tsx`、`apps/agent-web/src/pages/BillingPage.tsx` |
| 26 | 同 A-2 | 见 A-2 |
| token 三段 ceil | 整单先求和再 ceil，按最大余数法分配到各段（不再每段多收） | `money.ts` `allocateTokenCostCents` + `pricing.ts` `priceModel`；测试 `money.test.ts`/`pricing.test.ts` |
| A10 immutable | ledger/invoice/receipt 增加 `pre('save')` 守卫，覆盖 `load→save` 路径 | `models/billing-{ledger,invoice,receipt}.ts` |
| rollup 校准线 | 新增 `rollups` 对账线：近 24h rollup 累计 vs 账单真值逐账户比对 | `reconciliation.ts` `reconcileRollups` + 测试 |

> 未在预算内处理的 🟡（per-message TTL 队头阻塞需延迟交换机/插件、UTC 桶本地时区展示、契约 500/502 文档化、死代码清理等）保持既有记录，不构成打回项。

## 五、缺陷模式副本覆盖

- outbox/relay 顺序性与重试头：`cloud-controller` 与 `admin-api` **两份实现**均已修复。
- 钱包幂等：`payment.applyLedgerDelta` 为唯一应用点（freeze/unfreeze/charge/recharge 共用），`reconcileAccount` 同步登记。
- 预留时间线门控：`handleContainerReady`/`handleContainerDestroyed`/`settleCycle` 共用 `container:*`/`reservation:*` 键串行化。
