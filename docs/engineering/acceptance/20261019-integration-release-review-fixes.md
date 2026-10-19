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
| O-1 | ① 钩子同步调用 + 共 **3 次尝试**（首次 + 100ms/250ms 两次退避，仍失败记 error），容器文档（`billingStartedAt/exitedAt`）为持久补偿源；② SIGTERM 前 `drainBillingHooks()`；③ 反向对账线 `events` 补投 ready/destroyed；④ 契约 A.3.1 措辞修正 | `cloud-controller/src/services/container-service.ts`（`emitHook`/`drainBillingHooks`）；`cloud-controller/src/index.ts` stop 顺序；`admin-api/src/services/billing/reconciliation.ts` `reconcileEvents`/`repairEvent`；`contracts/cloud-controller-websocket.md` A.3.1 |
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

---

## 六、第二轮复核返工对账（2026-10-20，针对 R2-1~R2-6 + 8.4 优先项）

> 基线：`integration` @ `d512678`。二次复核报告：`20261019-integration-release-acceptance-report.md` §八。
> **对账纪律**：按**修复要求子项**逐条打勾；未做子项显式标注「部分修复/未做」，不再以问题编号整单入账。

### 6.1 独立复跑（本机实跑，不采信自报）

| 层 | 命令 | 结果 |
|---|---|---|
| admin-api 单测/tsc | `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npx vitest run` / `tsc --noEmit` | ✅ 528 passed / 1 skipped，tsc 0 |
| cloud-controller 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 197 passed，tsc 0 |
| agent-api 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 658 passed，tsc 0 |
| admin-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error / 207 passed |
| agent-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error（6 存量 warning）/ 429 passed |
| tests/api（Aspire 全栈干净实例，注入 `INTERNAL_API_TOKEN`） | `npx vitest run` | ✅ **454 passed / 0 skipped** |
| 费用 E2E | `playwright test admin-billing.spec.ts billing.spec.ts` | ✅ 3 passed |
| AppHost 编译 / `aspire publish` | `dotnet build` / `aspire publish -o <tmp>` | ✅ 0 error；生成 compose 含内网镜像 + healthcheck + `depends_on` |

### 6.2 R2-1（🔴 阻断，A-2 修复不完整）— 子项逐条

| 子项 | 状态 | 实现 | 回归（可区分修复前后） |
|---|---|---|---|
| ① `claimedAt` 入 schema | ✅ 已做 | `models/billing-applied-ledger.ts:26` 新增 `claimedAt:{type:Date,default:null,index:true}`（严格模式不再剥离 `$set:{claimedAt}` → 租约 CAS/接管真实生效） | `review-fixes.test.ts` 新增「A-2/R2-1」：直接置标记 `walletApplied:false, claimedAt=过期` 后 **raw 读回断言 `claimedAt` 为 `Date`**（自证字段落库） |
| ① 崩溃窗口不再二次记账 | ✅ 已做 | `payment.ts claimLedgerApplication`：`claimedAt` 真实落库后，`in-flight`（租约内不重复）/`stale`（租约后接管→`healWalletFromLedger` 绝对校准）分支可达 | 同上：pending+过期租约 + **真实挤出水位** 后重放 `applied:true` 且**余额不变**（修复前：CAS 恒命中→`claimed`→再 `$inc`，余额 -100） |
| ① `markLedgerApplied` 不再吞错 | ✅ 已做 | `payment.ts:1215`（原 `.catch(()=>undefined)`）改为向上抛 | 由上述重放路径 + 类型检查覆盖 |
| ② 回归改为真实挤出水位 | ✅ 已做 | 测试用 `payments.recharge` ×1001（经 `applyLedgerDelta`）挤出 `appliedLedgerIds`，并断言两条键均**不在**水位 | 修复前该测试的 pending+过期租约段会二扣（见上） |
| ③ `markAllLedgerApplied` 移至校准回写**之后** | ✅ 已做 | `account-service.ts`：`mismatch` 分支先 `BillingAccount.updateOne` 回写分池余额 → 其后才 `markAllLedgerApplied`（无漂移分支同理） | `billing-flow.test.ts` T-B12 全绿 |
| ③ 与 `accountMutex` 互斥 | ✅ 已做 | `keyed-mutex.ts` 导出共享 `accountMutex`；`PaymentService`（charge/freeze/unfreeze/recharge 全部钱包写）+ `AccountService.reconcileAccount` 共用同一把账户锁 | admin-api 全量单测 + API 集成通过 |
| ③ `markAllLedgerApplied` 吞错 | ✅ 已做 | 去掉 `.catch(()=>undefined)`，失败上抛并由 `reconcileFunds` 逐账户记入对账错误（不再静默留重放窗口） | 类型检查 + 对账测试通过 |

### 6.3 R2-2（🟠 O-1 隔离行/DLQ 补投盲区）— 子项逐条

| 子项 | 状态 | 实现 |
|---|---|---|
| `eventRecorded` 不再把隔离行/DLQ 当已投递 | ✅ | `reconciliation.ts containerEventDelivered`：按**业务态**（预留终态/legacy 全额键/destroyed 事件）+**投递态**（`failed:true`→未完成；`published:false`→在途可视已完成；`published:true`→未达成则未完成）判定，替换原「行存在即已记录」 |
| 补投可执行：撞 eventId 有代偿路径 | ✅ | `repairEvent`：`failed` 行→重置为 pending；`published` 未生效行→以 `…:repair:<ts>` 代偿 eventId 重新入列 |
| 双隔离回归（补投且不重复计费） | ✅ | `reconciliation.test.ts` 新增 3 例：隔离行重置、DLQ 代偿重投、在途不重投；`billing-flow.test.ts` 新增「R2-2：补投后 ready+destroyed 各重放一次仍只产生一笔计费」 |

### 6.4 R2-3（🟠 声明↔实现对账失实）— 逐条纠正

| 原声明 | 处理 | 结果 |
|---|---|---|
| O-1「失败记 error」 | 补实现 | `container-service.ts:186` 改 `logger.error`；注释同为 error |
| O-1「重试 3 次（200/500/1000ms）」 | 口径统一 | 注释/契约改为「共 **3 次尝试**（首次 + 100ms/250ms 两次退避）」；契约 `cloud-controller-websocket.md` A.3.1 同步 |
| T-1「去重」 | **如实标注：未做（声明失误）** | 经核对 `T-CC-B4/B8`（billingAccountId 回显）与 `T-CC-B7`（exitReason）在 `internal-api.test.ts` **无重复覆盖**，故未删减；T-1 实际交付为「环境变量纠正 + billing-events 真实执行 + 新增 T-CC-B11」 |
| O1「与 cloud-container 同口径」 | 补实现 | `cloud-container.ts toGraphQLError` 未知错误补 `INTERNAL_SERVER_ERROR` code；`agent-api` 400 由 `BAD_REQUEST` 改 `INVALID_ARGUMENT`（测试同步），跨应用词汇统一为 `NOT_FOUND/INVALID_ARGUMENT/INTERNAL_SERVER_ERROR` |
| T-2「修旧 T-B22/T-B23」 | 补实现 | 见 6.6（旧用例改标题/去误导、ID 去重、补全 0 档断言） |

### 6.5 R2-4（🟠 A-4 对账线 + 零费率告警）— 子项

| 子项 | 状态 | 实现 |
|---|---|---|
| ① 价源回落 | ✅ | `pricing.ts priceModel`（首轮） |
| ② 告警/拒绝 | ✅ | `priceModel` 对**全 0 档**也回落 `models.pricing`；`billing-service.handleModelCallEvent` 对 `amountCents===0` 区分「无档 / 全 0 档」显式告警 |
| ③ 对账线 `cost>0 且无 invoice` | ✅ | 新增对账线 `apiCalls`（`BillingApiCall.cost>0 & invoiceSeq=null` → 报告）；含 `reconciliation.test.ts` 断言 |

### 6.6 R2-5（🟠 O1 错误映射收尾）— 子项

| 子项 | 状态 | 实现 |
|---|---|---|
| 9 处裸 `GraphQLError` 补 code | ✅ | `resolvers/billing.ts` 新增 `billingError(message, code)`；9 处（`:77,83,140,212,214,301,312,371,385`）全部带稳定 code |
| 四类错误映射断言测试 | ✅ | 新增 `resolvers/billing-errors.test.ts`：MoneyError→INVALID_ARGUMENT、ApiKeyNotFoundError→NOT_FOUND、业务消息（不存在/已存在/余额不足/非法）→各稳定 code、未知→INTERNAL_SERVER_ERROR、GraphQLError 透传 |
| 启发式覆盖「已存在/余额不足」 | ✅ | `toBillingGraphQLError` 增加 `CONFLICT`（已存在/重复）与 `INSUFFICIENT_FUNDS`（余额不足）分支 |

### 6.7 R2-6（🟠 T-2 名实不符本体）— 子项

| 子项 | 状态 | 实现 |
|---|---|---|
| 处置旧用例 | ✅ | 旧 T-B22（仅形状）→ 更名 `T-B21`（明示「形状」）；旧 T-B23（401）→ `T-B25`；旧 T-B23（缺参数/未知模型，标题含未断言的「未定价模型 400」）→ `T-B26` 且删去未断言文案 |
| 消除重复 ID | ✅ | DB 块内 T-B22/T-B23 → `T-B27`/`T-B28`；文件内 T-B2* ID 现唯一（T-B21/B24/B25/B26/B27/B28） |
| POST 侧补「全 0 档」400 | ✅ | `T-B28` 循环覆盖 `pricing:null`（`no-pricing-*`）与**全 0 档**（`unpriced-*`）两类，均断言 400 `model_not_priced` |

### 6.8 8.4 🟡 优先项（1/2/7/8）

| # | 状态 | 实现 |
|---|---|---|
| 1 rollup 校准线小时桶错位 | ✅ | `reconcileRollups` 窗口起点对齐 `floor_hour`（`bucketFrom`）；`count` 纳入比对 |
| 2 finalSettle 崩溃窗口账实不符 | ✅ 部分 | `!claimed` 仅在 `SETTLING/RELEASE_PENDING`（崩溃恢复）继续收敛，其余不再穿行扣费；`applied:false` 时以 **ledger 实际 `deltaBalance`** 回填金额；`settleTailAfterSettled` CAS 失败重读重试一次。**未做**：把 `charge:final` 全量窗口化（窄窗口内仍依赖既有幂等键） |
| 7 测试缺口 | ✅ 部分 | 补 A10 `pre('save')` 锚定（load→save）、#15 `resolveUsageFallback` 单测、`deleteMany` 过期清理断言；**未做**：`x-retry-count` 发布头、`adminBillingReceipt` API 级用例、admin `BillingPage` 页面级用例 |
| 8 前端守卫 | ✅ | `receiptQuery.refetch` 仅在有 `receiptInvoice` 时触发；`toggleStatus` 先报「变更成功」再单独处理 refetch 失败，不反向误报方向翻转 |

### 6.9 8.4 其余 🟡（未列优先，如实标注）

- 11（settleCycle 解冻额口径）：✅ `settleCycle` 改按 freeze 流水 `deltaFrozen` 解冻（与 `rollbackFreeze` 同口径）。
- 12（注记/A-2 余项）：✅ `billing-ledger.ts` 水位注释改为「辅助水位、幂等由 `billingappliedledgers` 保证」；`markLedgerApplied` 不再吞错。历史无标记流水的重放窗口（`claimLedgerApplication` 的 legacy 信号「宁可漏补不重复扣」）已在 `claimLedgerApplication` 注释标注（R3-7 补充：`billing-ledger.ts` 同时说明 `walletApplied` 作为 legacy 信号只会漏判不会误判）。
- 9（RabbitMQ 固化）：✅ 改为在 `AppHost.cs ConfigureComposeFile` 固化 healthcheck + `depends_on` + 内网镜像，`aspire publish` 实跑验证不再漂移。
- 13（单实例前提入契约）：✅ 契约 A.3.1 显式标注 `billingMutex` 为进程内锁、多副本前必须落库化互斥；`billingStartedAt=null` 边界亦在契约明示（🟡4）。
- 未做：3（`{reservationId}` 结构化索引，保留转义兜底）、5（legacy/events 双计 MeteringRecord 用量统计）、6（网关估算逐段 ceil 展示值）、10（per-message TTL 队头阻塞、UTC 桶本地时区、契约 500/502、死代码清理）。

---

## 七、第三轮复核返工对账（2026-10-20，针对 R3-1~R3-7）

> 基线：`integration` @ `c982ed4`。三方复核报告：`20261019-integration-release-acceptance-report.md` §九。
> **对账纪律**：按修复要求子项逐条打勾；未做/部分子项显式标注。本轮起对「声明的状态机/守卫」执行
> **探针回退验证**（回退实现确认用例变红），结论见 7.1。

### 7.1 探针回退验证（本轮新增固定复核手段，本机实跑）

| 探针 | 回退范围 | 目标用例 | 结果 |
|---|---|---|---|
| Probe A | 仅 `billing-applied-ledger.ts`（删 `claimedAt`） | `review-fixes.test.ts`「A-2/R2-1」 | 🔴 变红：`AssertionError: expected 100701 to be 100801`（余额被二次 `$inc`） |
| Probe B | `payment.ts` + `account-service.ts` + `keyed-mutex.ts` + `billing-applied-ledger.ts` 全回退至 `d512678` | 同上 | 🔴 变红：同断言（`expected 100701 to be 100801`） |

结论：R2-1 回归**不再是空转**——崩溃残留改由**正常代码路径**构造（注入 `markLedgerApplied` 抛错：`claimLedgerApplication` 先写入 `claimedAt`、`incWalletByLedger` 已 `$inc`，随后标记无法转 `applied`），
不再用原生驱动直写 `claimedAt`（撤回上一轮「CAS 恒命中→再 `$inc`」的空转自证）。断言顺序改为**先校验重放不二扣**（探针两配置均在此变红），
末尾再自证 `claimedAt` 经正常路径真实落库（schema 缺字段即红）。

### 7.2 独立复跑（本机实跑，不采信自报）

| 层 | 命令 | 结果 |
|---|---|---|
| admin-api 单测/tsc | `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npx vitest run` / `tsc --noEmit` | ✅ **533 passed / 1 skipped**，tsc 0 |
| cloud-controller 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 197 passed，tsc 0 |
| agent-api 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 658 passed，tsc 0 |
| admin-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error / 207 passed |
| agent-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error（6 存量 warning）/ 429 passed |
| tests/api（Aspire 全栈干净实例，注入 `INTERNAL_API_TOKEN`） | `npx vitest run` | ✅ **454 passed / 0 skipped** |
| 费用 E2E | `playwright test admin-billing.spec.ts billing.spec.ts` | ✅ 3 passed |

### 7.3 R3-1（🔴 阻断，回归空转）— 子项

| 子项 | 状态 | 实现/证据 |
|---|---|---|
| 崩溃残留经正常路径构造 | ✅ | 注入 `markLedgerApplied` 抛错（现上抛）→ 标记停在 `pending`、`claimedAt` 由 `claimLedgerApplication` 写入、`$inc` 已落账 |
| raw 读回断言 `claimedAt` 经正常路径落库 | ✅ | 末尾 `expect(claimedAtCaptured).toBeInstanceOf(Date)`；Probe A 变红 |
| 租约过期后重放断言余额不变且走自愈 | ✅ | `nowValue += 5min` + 经 `payments.recharge`×1001 真实挤出水位；`expect(balance).toBe(balanceBefore)`；Probe A/B 均在此变红 |
| 两种回退配置下均失败 | ✅ | 见 7.1（两探针均红） |
| 撤回不实声明 | ✅ | 本节取代上一轮「修复前：CAS 恒命中→claimed→再 `$inc`」的空转自证；上一轮该表述已在此更正 |

### 7.4 R3-2（🟠 无限补投放大环）— 子项

| 子项 | 状态 | 实现 |
|---|---|---|
| 收敛护栏 | ✅ | ① `billing-outbox.ts`（admin+cloud-controller 两份）新增 `repairOf` 索引；`repairEvent` 补投前 `BillingOutbox.exists({repairOf: eventId})`，**每个源事件至多补投一次**（`bounded`）；② destroyed 分支把 `FAILED` 预留判终态；③ 零计费窗口（`exitedAt<=startedAt`）判终态不补投 |
| 连续两轮 repair 行数收敛回归 | ✅（R4-2 修正后） | DLQ 用例：连续两轮（`now` 前进使代偿 eventId 变化）断言代偿行恒为 1/源事件（Probe D 下红于 `expected 2 to be 1`）。「FAILED 预留 + 零计费窗口」用例：destroyed 断言改为**业务事实** `countDocuments({eventId:/^container\.destroyed:/})===0`（Probe D 下红于 `expected 2 to be +0`）；ready 有界性改由 `repairOf` 计数锚定（预置 DLQ ready 行 → 两轮后 `^container.ready:c-zero` 恒为 2、`repairOf` 恒为 1；Probe D 下红）。⚠️ 上一轮该用例的 `/destroyed.*repair/` 断言为**空转**（修复前补投的是朴素 `container.destroyed:c-*` 行、不含 `repair` 字样），已在 R4-2 更正并标注。 |
| 修正 `repaired` 语义 | ✅ | `repairEvent` 返回 `'injected'|'requeued'|'bounded'|'in-flight'|'failed'`；在途分支不再谎报 `repaired:true`，对账报告如实记录 `action` |

### 7.5 R3-3（🟠 finalSettle 永久少收未声明）— 子项

> **R4-1 更正**：本节上一轮的「✅ 不推过未收费窗口」属**声明过度**——gap 幂等键仅编码窗口**起点**，二次崩溃（同一 `chargedTo`、更晚 `endedAt`）撞键 no-op 却仍无条件把游标推到新 `endedAt` → 尾段仍永久漏收。已在 R4-1 彻底修正（§8.1）。

| 子项 | 状态 | 实现 |
|---|---|---|
| 不把 `lastSettleAt` 推过未收费窗口 | ✅（R4-1 修正后；R5-1 再修正） | 幂等键/`bizId` **编码区间两端**（`…:final:<from>:<to>` / `…:final-gap:<from>:<to>`）；恢复时以 `settledCoverage` 取 **ledger 已覆盖终点**，只补未覆盖尾段 [终点, `endedAt`]；游标仅在补收生效时推进到 `endedAt`，否则停在已覆盖终点（`cursor`）。⚠️ **R5-1 更正**：上一轮该「游标只推进/停在覆盖终点」在**逆向输入**（`endedAt < lastSettleAt` 的迟到 destroyed）下不成立——`cursor` 仅在 `minutes>0` 块内钳位，`minutes<=0` 时收尾直接写回 `endedAt` → 游标回退进已收费区间。已改为初始 `max(endedAt,lastSettleAt)` + 落库 `$max` 钳位（§9.1） |
| 至少一条区分性回归 | ✅ | `billing-flow.test.ts`「R3-3」（单崩溃：断言 gap 500、`amount=1500`、游标=T2）+「R4-1」（二次崩溃：断言合计 2000、游标=T3）。回退 `reservation.ts` 至 `2a95c4a`：两者分别红于 `expected 1000 to be 1500` / `expected 1000 to be 2000` |
| 残余风险如实声明 | ✅（R4-1 修正后） | 仅剩「历史无编码 `final` 行（`bizId` 无窗口终点，本机制上线前的构建，未发布）」；`settleTailAfterSettled` 改为同一「覆盖终点」口径（不再有「CAS 先推进游标、后扣费」的漏收窗口，见 §7.8） |

### 7.6 R3-4（🟠 零费率档无锚点 + 告警误报）— 子项

| 子项 | 状态 | 实现 |
|---|---|---|
| 全 0 档回落区分性回归 | ✅ | `pricing.test.ts`「R3-4: productprices 存在全 0 价目档时回落 models.pricing」：全 0 档 + `models.pricing` 有价 → 断言 `amountCents=100` 且调用 `Model.findOne`（修复前 amount=0） |
| 显式非计费档不回落 | ✅ | 同文件「显式非计费档（`isBillable:false`）」：断言 `Model.findOne` 未被调用、`amountCents=0`、`items=[]` |
| 告警排除非计费/零用量 + 文案修正 | ✅ | `billing-service.ts`：仅 `billable && hasUsage` 时告警；文案按快照区分 `all-zero effective price row` / `priced to zero` / `no effective price row`，不再对非计费档输出「has no effective price row」 |

### 7.7 R3-5 / R3-6 / R3-7（🟡 随修）

| # | 子项 | 状态 | 实现 |
|---|---|---|---|
| R3-5 | T-B25 跨文件重号 | ✅ | `billing-gateway.test.ts` 的 `T-B25` → `T-B29`；`tests/api/AGENTS.md` 同步；文件内/跨文件 `T-B2*` ID 唯一 |
| R3-5 | 旧注释引用 T-B22/T-B23 | ✅ | `billing-gateway.test.ts:73` 改为 `T-B27/T-B28` |
| R3-6 | review-fixes.md「3 次重试」自相矛盾 | ✅ | §五 O-1 行改为「共 **3 次尝试**（首次 + 100ms/250ms 两次退避）」，与代码 `[0,100,250]`/契约一致 |
| R3-6 | agent-api 注释残留 BAD_REQUEST | ✅ | `agent-api/src/graphql/resolvers/billing.ts` 注释改为 `INVALID_ARGUMENT/NOT_FOUND/BILLING_UNAVAILABLE` |
| R3-6 | reconciliation 注释旧语义 / 格式损伤 | ✅ | `reconcileEvents` 注释重写为「业务态 + 投递态」；`report()` 修复 `{ return {` 粘连格式 |
| R3-6 | 契约交叉引用错误（§A.1 部署约束） | ✅ | 改为「**单实例部署前提**」（原引用的 A.1 实为鉴权章） |
| R3-7 | `walletApplied` 注释与实现矛盾 | ✅ | `billing-ledger.ts` 注释说明该字段作为 **legacy 信号**只会漏判（false-negative）不会误判（false-positive），与 `claimLedgerApplication` 一致 |
| R3-7 | 「重放窗口已标注」无对应注释 | ✅ | `account-service.ts markAllLedgerApplied` 新增「残余风险（已显式标注）」段（登记失败 → 下次对账前的水位淘汰重放窗口） |
| R3-7 | 8.4#1 无区分性测试 | ✅ | `reconciliation.test.ts`「rollups: 小时桶边界对齐」：`floor_hour(from)` 桶 + 同桶账单，断言 0 漂移（修复前误报 1） |
| R3-7 | `markLedgerApplied` 上抛后失败面无注入回归 | ✅ | 7.1 的 R3-1 用例即注入 `markLedgerApplied` 失败并断言调用链失败面（charge 抛错 + 重放自愈） |

### 7.8 未做/部分（如实标注）

- R3-6：`reconciliation.ts` 注释已重写；无其它遗留。
- R3-3/R4-1：**历史无编码 `final` 行**（`bizId` 形如 `…:final`，仅存在于本机制上线前的构建、且该构建从未发布）无法判定已覆盖终点 → `console.warn` 并保守推进游标（残余风险）；该历史行场景下 `minutes`（全窗口）与 `amount`（回填+补收）可能轻微不一致（仅报告值，无资金泄漏）。
- R4-1：`settleTailAfterSettled` 的并发安全依赖调用方 `billingMutex.runExclusive('reservation:${id}')`（唯一调用方 `billing-service.finalizeReservation` 已满足）；若未来旁路该锁直接调用，尾部补收的幂等键可能重叠——已在方法注释标注「序列化由调用方提供」前提。
- 前两轮 8.4 未做项（3/5/6/10）本轮未动，保持如实标注。

---

## 八、第四轮复核返工对账（2026-10-20，针对 R4-1 / R4-2）

> 基线：`integration` @ `ab1a3b7`（复核对象 §十）。复核口径升级：**断言以业务事实为单位、探针回退为固定手段**。
> 本轮两个问题同属「回归空转 / 声明过度」，已按新口径重做并以探针实证（见 8.3）。

### 8.1 R4-2（🔴 阻断：R3-2 守卫回归仍空转）— 子项

| 子项 | 状态 | 实现 / 证据 |
|---|---|---|
| destroyed 断言改为「该资源无任何补投行」 | ✅ | `reconciliation.test.ts`「FAILED 预留与零计费窗口」：`countDocuments({ eventId: /^container\.destroyed:/ }) === 0`（以事件 entity 为单位，不再用 `/destroyed.*repair/` 这一修复实现命名特征）。**Probe D**（`reconciliation.ts` 回退至 `c982ed4`）下红于 `expected 2 to be +0`——实证修复前确实补投 2 条朴素 `container.destroyed:c-*` 行 |
| ready 有界性用 `repairOf` 计数锚定 | ✅ | 用例预置一条「已发布未生效」（DLQ）的 `container.ready:c-zero` → 首轮注入 `…:repair:<ts>`（`repairOf` 落库），第二轮被 `repairOf` 护栏判 `bounded` 不再新增；断言 `^container.ready:c-zero` 恒为 2、`repairOf==='container.ready:c-zero'` 恒为 1。**Probe D** 下第二轮新增第三条 → 红 |
| 修正空转回归 + 对账表注明探针结论 | ✅ | 已在 §7.4 更正上一轮 `/destroyed.*repair/` 空转与 ready「11000→in-flight 兜底（非 `repairOf` 护栏）」的伪锚定 |
| `repairOf` 护栏本身（①） | ✅（复核已确认） | Probe D 下 DLQ 用例红于 `expected 2 to be 1` |

### 8.2 R4-1（🟠 重要：R3-3 修复不完整 + 声明过度）— 子项

| 子项 | 状态 | 实现 / 证据 |
|---|---|---|
| gap 幂等键 / `bizId` 编码区间两端 | ✅ | `charge:final` → `bizId=…:final:<from>:<to>`；`charge:final-gap` → `idempotentKey=charge:final-gap:<rid>:<from>:<to>`、`bizId=…:final-gap:<from>:<to>`（`reservation.ts`）。同 (from,to) 重放幂等；不同 `endedAt` 不再撞键静默漏收 |
| 按 ledger 已覆盖终点只补未覆盖尾段 | ✅ | 新增 `settledCoverage(accountId,rid)`：汇总 `charge:final` + 全部 `charge:final-gap` 的 `bizId` 区间端点，取 `max(to)` 为 `coveredEnd`。`finalSettle` 恢复分支以 `coveredEnd` 为 tail 起点（不再只看 `final` 的 `chargedTo`） |
| 推进游标前核对「已收费终点 ≥ 新 endedAt」 | ✅（R5-1 再修正） | 新增 `cursor`：仅当尾段补收**生效**（或零价尾段）才推进到 `endedAt`，否则停在 `bizId` 已证实的覆盖终点；`lastSettleAt` 写入改用 `cursor`。`settleTailAfterSettled` 同口径改造（去掉「CAS 先推进游标、后扣费」的漏收窗口，改为覆盖终点驱动 + `$max` 推进）。⚠️ 上一轮该行**声明过度**：未覆盖 `endedAt < lastSettleAt` 的逆向输入（`minutes<=0` 时钳位块被跳过，游标回退）；R5-1 已补齐并补 R5-P1/P2 回归 |
| Probe G 场景区分性回归 | ✅ | `billing-flow.test.ts`「R4-1」：`final[T0,T1]=1000` + 首次崩溃恢复 `final-gap[T1,T2]=500`，以 `endedAt=T3` 重放 → 断言**业务事实**合计 `ΣdeltaBalance=2000`、新增 `final-gap[T2,T3]=500`、`result.amount=2000`、游标=T3。**Probe**（回退 `reservation.ts` 至 `2a95c4a`）下红于 `expected 1000 to be 2000` |
| 单崩溃路径仍可区分（Probe C 复核） | ✅ | 同文件「R3-3」断言 gap `[T1,T2]=500`、`amount=1500`；回退至 `2a95c4a` 红于 `expected 1000 to be 1500` |
| 7.5/7.8 声明与残余风险如实改写 | ✅ | §7.5 标注上一轮「✅ 不推过未收费窗口」为声明过度并更正；§7.8 改为「仅剩历史无编码 `final` 行 + `settleTailAfterSettled` 的串行前提」 |

### 8.3 探针回退验证（本轮固定复核手段，本机实跑）

| 探针 | 回退范围 | 目标用例 | 结果 |
|---|---|---|---|
| R4-2 Probe D | `reconciliation.ts` → `c982ed4` | 「FAILED 预留与零计费窗口…」 | 🔴 `AssertionError: expected 2 to be +0`（destroyed 补投 2 条） |
| R4-1 Probe | `reservation.ts` → `2a95c4a` | 「R4-1: 二次崩溃恢复…」 | 🔴 `AssertionError: expected 1000 to be 2000` |
| R4-1 Probe | `reservation.ts` → `2a95c4a` | 「R3-3: 最终结算崩溃恢复…」 | 🔴 `AssertionError: expected 1000 to be 1500` |

### 8.4 独立复跑（本机实跑，不采信自报）

| 层 | 命令 | 结果 |
|---|---|---|
| admin-api 单测/tsc | `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npx vitest run` / `tsc --noEmit` | ✅ **534 passed / 1 skipped**，tsc 0 |
| cloud-controller 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 197 passed，tsc 0 |
| agent-api 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 658 passed，tsc 0 |
| admin-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error / 207 passed |
| agent-web | `tsc -b` / `eslint src` / `vitest run` | ✅ 0 / 0 error（6 存量 warning）/ 429 passed |
| tests/api（Aspire 全栈干净实例，注入 `INTERNAL_API_TOKEN`） | `npx vitest run` | ✅ **454 passed / 0 skipped** |
| 费用 E2E | `playwright test admin-billing.spec.ts billing.spec.ts` | ✅ 3 passed |

### 8.5 未做/部分（如实标注）

- R4-1：历史无编码 `final` 行仍无法判定覆盖终点（未发布构建产物，实际应无）——`console.warn` + 保守推进游标并声明（见 §7.8）。
- R4-1：`settleTailAfterSettled` 串行前提依赖 `billingMutex`（已在方法注释标注）；未引入跨账户快照版本以彻底去除该前提（超出本节点范围）。

---

## 九、第五轮复核返工对账（2026-10-20，针对 R5-1 / R5-2）

> 基线：`integration` @ `ea2aa73`（复核对象 §十一）。复核口径：游标/状态机不变量须覆盖**逆向与边界输入**；
> 「仅当 X 才…否则…」的每个「否则」分支逐一回归；断言以业务事实为单位；探针回退为固定手段。

### 9.1 R5-1（🟠 重要：finalSettle 游标回退进已收费区间）— 子项

| 子项 | 状态 | 实现 / 证据 |
|---|---|---|
| ① 游标绝不回退 | ✅ | `cursor` 初始化为 `new Date(Math.max(endedAt, from))`（`from=lastSettleAt??startedAt`）；`minutes<=0`（`endedAt<lastSettleAt` 的迟到 destroyed）时整块跳过也不会写回 `endedAt`。收尾改 `$max: { lastSettleAt: cursor, expectedEndAt: cursor }`（落库层再兜底），不再用 `$set` 直写 |
| ① expectedEndAt 同口径 | ✅ | 与 `lastSettleAt` 同一 `$max` 钳位 |
| ② R5-P1/P2 区分性回归 | ✅ | `billing-flow.test.ts`「R5-P1/P2」：cycle 已收 `[T0,T5]=500`、游标=T5 → `finalSettle(T3)` 后断言 `lastSettleAt=T5`、`expectedEndAt=T5`；随后 `finalSettle(T7)` 断言 `amount=200`、`windowFrom=T5`、gap `[T5,T7]=200`、不存在 `[T3,T7]` gap、**Σcharge=700**、游标=T7 |
| ② 探针（回退后变红） | ✅ | 回退 `reservation.ts`+`payment.ts` 至 `3829c65`：R5-P1 红于 `expected 1790812980000 to be 1790813100000`（即 T3 vs T5，与复核复现一致）；R5-2 红于 `expected null not to be null` |
| ③ `settleTailAfterSettled` 起点口径统一 | ✅ | `gapFrom = Math.max(coverage.coveredEnd ?? lastSettleAt, lastSettleAt)`；并在代码注释明确声明 **`settledCoverage` 不含 `cycle:*` 流水、依赖「游标不回退」前提**（`cycle` 已收费区间由游标承载） |
| ④ 声明精确化 | ✅ | `finalSettle` JSDoc 改为：`bizId` 编码区间两端；但 `charge:final` 的幂等键仍是预留级单键 `charge:final:<rid>`（非区间编码），恢复时回读 `bizId` 判定覆盖终点 |
| ⑤ §7.5/§8.2 标注过度声明 | ✅ | 两处均加「R5-1 更正」：上一轮「游标只推进/停在覆盖终点」在逆向输入下不成立 |

### 9.2 R5-2（🟡 随修·建议：零价尾段不落流水 → 覆盖/游标口径分裂）— 子项

| 子项 | 状态 | 实现 / 证据 |
|---|---|---|
| 零价尾段同落 0 元流水 | ✅ | `finalSettle` gap 分支与 `settleTailAfterSettled` 均**无条件** `payments.charge({ amountCents })`（含 0）；`charge(0)` 写 `deltaBalance:0` 的 ledger 行，使 `settledCoverage.coveredEnd` 与游标同步推进 |
| 账实口径干净 | ✅ | `payment.ts` 将 `deltaBalance: -amount` 改为 `amount === 0 ? 0 : -amount`，避免零额流水落成 `-0`（`toBe(+0)` 断言失败） |
| 区分性回归 | ✅ | `billing-flow.test.ts`「R5-2」：价格置 0 → `finalSettle(T2)` 断言 `charge:final-gap:<rid>:T1:T2` 存在且 `deltaBalance===0`、游标=T2；价格恢复 100 → `finalSettle(T3)` 只收 `[T2,T3]=100`、Σ=200（不回溯计费 `[T1,T2]`）。回退后红于 `expected null not to be null` |

### 9.3 探针回退验证（本机实跑）

| 探针 | 回退范围 | 目标用例 | 结果 |
|---|---|---|---|
| R5 Probe | `reservation.ts` + `payment.ts` → `3829c65` | 「R5-P1/P2」 | 🔴 `expected 1790812980000 to be 1790813100000`（游标回退 T5→T3） |
| R5 Probe | 同上 | 「R5-2」 | 🔴 `expected null not to be null`（零价尾段未落流水） |

### 9.4 独立复跑（本机实跑）

| 层 | 命令 | 结果 |
|---|---|---|
| admin-api 单测/tsc | `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npx vitest run` / `tsc --noEmit` | ✅ **536 passed / 1 skipped**，tsc 0 |
| cloud-controller 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 197 passed，tsc 0 |
| agent-api 单测/tsc | `npx vitest run` / `tsc --noEmit` | ✅ 658 passed，tsc 0 |
| admin-web | `tsc -b` / `vitest run` | ✅ 0 / 207 passed |
| agent-web | `tsc -b` / `vitest run` | ✅ 0 / 429 passed |
| tests/api（Aspire 干净实例，注入 `INTERNAL_API_TOKEN`） | `npx vitest run` | ✅ **454 passed / 0 skipped** |
| 费用 E2E | `playwright test admin-billing.spec.ts billing.spec.ts` | ✅ 3 passed |

### 9.5 未做/残余（如实标注）

- `settledCoverage` 仅覆盖 `charge:final` / `charge:final-gap`，**不含 `cycle:*`**；将其纳入需要给 cycle 流水也编码窗口区间（本轮未改）。当前以「游标绝不回退 + `gapFrom=max(coveredEnd, lastSettleAt)`」保证不重复计费——该不变量已由 R5-P1/P2 回归锚定。
- 历史无编码 `final` 行（本机制上线前构建、未发布）仍无法从流水判定覆盖终点，退回以游标为准并告警（残余风险）。
- `settleTailAfterSettled` 的串行前提仍依赖调用方 `billingMutex.runExclusive('reservation:${id}')`（方法注释已标注）。
- 前两轮 8.4 未做项（3/5/6/10）本轮未动，保持如实标注。

### 9.6 已复核确认项（本轮未触碰）

R4-2 destroyed 业务事实断言 + ready `repairOf` 锚定、R4-1 区间两端编码 + `settledCoverage` + 只补未覆盖尾段、`settleTailAfterSettled` 去 CAS 先推进窗口、R3-1~R3-7 实现均保持上一轮确认状态。
