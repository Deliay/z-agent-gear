---
description: integration→release 集成验收报告（AI Review 第十轮独立复核·打回 + 第十一轮返工复核·打回）：R10 十四项返工逐项核实为真修复且独立复跑全绿，但本 diff 自带的工作负载「必须标记」E2E（T-E17/T-E19）确定性失败（R11-1）、另有 16 项 session/gateway/auth 既有 E2E 失败待统一处置（R11-2）
type: Permanent
---

> **状态**: **第十一轮 AI Review 返工复核 · 打回（REJECT）**（被审对象：返工提交 `d3782e8` + 回填 `8951bc6`，详见第七、八节）。第十轮提出的 **14 项问题（R10-1~R10-14）已逐项核实为真修复**（逐行核对修复落点 + 独立复跑 tsc/单测/构建全绿），资金安全与事件可靠性不变量恢复成立。但本轮对 `origin/release...integration` 全量差异（180 文件 / +27168 行）继续审查时发现 **2 项新问题**：**R11-1（一般·必修）本 diff 新增的工作负载「必须标记」E2E 用例（T-E17/T-E19）对本 diff 新增 UI 确定性失败**，该功能的验收证据无效；**R11-2（一般·必须处置）16 项 session/gateway/auth E2E 既有失败**（两分支同代码，非本 diff 引入，但经第十轮委托「集成验收统一处置」必须给出结论）。**故本轮再次打回**：R11-1 必修后重提；R11-2 至少完成选择器修复或书面登记为已知基线债务。

## 关联文档

| 项 | 值 |
|----|----|
| 关联 PRD | [[../product/draft/20261018-credits-billing.md]]（费用中心 v2.1）、[[../product/draft/20261019-aspire-workload-proxy.md]]（Aspire 工作负载下载代理 v1.0） |
| 技术提案 | [[../proposals/20261018-feat-credits-billing.md]]（v2.1）、[[../proposals/20261019-feat-aspire-workload-proxy.md]]（v1.0） |
| 实现计划 | [[../plan/20261018-feat-credits-billing.md]]、[[../plan/20261019-feat-aspire-workload-proxy.md]] |
| 契约 | `contracts/admin-billing.graphql`、`contracts/billing.graphql`、`contracts/billing-openai.openapi.yaml`、`contracts/billing-events.asyncapi.yaml`、`contracts/cloud-controller-websocket.md` |
| 被审分支 | `integration`（第十轮 86ff98d → 第十一轮复核对象 `8951bc6`，与 origin 同步） |
| 差异范围 | `origin/release...integration`：第十轮 179 文件 / +25953；第十一轮复核时 180 文件 / +27168（含返工 `d3782e8`） |
| 验收日期 | 2026-10-20（第十轮打回 → 同日返工 → 第十一轮复核） |
| 上游产物 | 修复Review意见节点（`6ad6e2c93f0a2ef66c91bb2a`）：R10-1~R10-14 修复提交 `d3782e8` + 报告回填 `8951bc6`，PR #239 OPEN |

## 一、本轮验收范围与方法

### 1.1 变更范围

`integration` 相对 `release` 新增两个特性：

1. **费用中心（Credits 计费）**：六段计费管线（业务事件 → 计量 → 定价 → 账单 → 支付 → 收据）+ RabbitMQ 事件骨干（outbox + confirm + DLQ）+ 预留/周期结算 + OpenAI 兼容计费网关 + 两侧 GraphQL/界面 + cloud-controller 计费事件源头 + 三线（实为七线）对账。
2. **Aspire 工作负载下载代理**：Aspire CLI 安装包改由内网缓存代理下载，下载地址成为工作负载可见配置项，配套迁移 004 存量升级。

### 1.2 审查方法（独立复核）

- **不看历史验收报告**，仅以 PRD / 技术提案 / 契约文件作为判据基准；
- 逐文件审读资金与事件关键路径：`money/pricing/metering/invoicing/receipt/payment/credit-check/reservation/billing-service/settlement-tick/reconciliation`、`mq/*`、`billing-openai.ts`、`cloud-controller` 事件源头、`migrations/004`；
- 独立复跑验证（不引用历史数据）：`tsc --noEmit` × 3 服务全绿；Vitest 全量 1397 passed / 1 skipped；
- 并行专项审查：事件源头与消息可靠性、网关/契约/前端各一路，发现项均经**逐条人工复核**后才写入本报告（未采纳无法复现的结论）。

### 1.3 判据

| 级别 | 判据 |
|------|------|
| 阻断 | 资金安全不变量被破坏 / 明确违反 PRD 成功标准或异常边界表 |
| 重要 | 违反 PRD §4.4 可靠性要求、或造成系统性漏计费/错计费/不可发现 |
| 一般 | 功能与 PRD 验收项不符、可维护性/可运营性缺陷 |
| 观察 | 口径隐患、契约/文档不一致、暂不可触发的缺陷 |

## 二、验收问题清单

### R10-1【阻断】网关预检费用估算严重低估，预付费账户可被打出负余额（「不可透支」不变量被绕过）

- **问题描述**
  - `servers/admin-api/src/routes/billing-openai.ts:58-73`：`contentText()` 只提取 `text` 字段与字符串，**多模态内容块（image / audio / tool）全部返回 `''`**；
  - `billing-openai.ts:75-78`：`estimateTokens = Math.ceil(text.length / 4)`，对 CJK 文本（1 字 ≈ 1 token）**系统性低估约 4 倍**，对纯多模态请求估算输入 ≈ 0；
  - `billing-openai.ts:234-235`、`:261`：该估算值直接作为 `creditCheckService.check({ estimatedCredits })` 的预检额度，是计费链路**唯一**的同步卡点（提案 §5.2 实现点 1）。
- **根因分析**
  预检估算本应是实际费用的**上界**：`实际 = input×r_in + cached×r_cached + output×r_out ≤ promptTokens×r_in + maxOutputTokens×r_out = 估算`（输出受 `max_tokens` 硬上限约束）。因此只要输入估算不低估，`creditLimit=0` 的预付费账户余额**不可能**被打成负数。当前估算低估输入，恰好摧毁了这层不变量。
- **失败场景（可复现）**
  1. 前台账户（`creditLimit=0`）余额 0.05 credits，携带 1 张图片发起调用（真实 input 数千 token）→ `promptTokens≈0` → 预检 `Math.max(1, …)` 几乎必然放行 → 实际扣费远超余额，账户转负；违反 PRD §3.5「余额不足发起模型调用（无授信）→ 拒绝调用…不产生账单」。
  2. 同一账户以 2000 字中文提示词调用：估算 500 tokens，实际约 2000 tokens，额度闸门形同虚设。
- **修复方案**
  1. `contentText()` 对非文本 part 给出保守上界：文本按 `len/2`（或接入 tokenizer），图片/音频按固定高估系数（如 ≥1000 token/图），工具调用参数计入；
  2. `estimateTokens()` 的除数改为可配置倍率（CJK 保守），或对 `content` 非纯文本的请求直接按「请求上限成本」估算；
  3. 补充单测：多模态、CJK、tool_calls 三类请求的 `estimateCost` 必须 ≥ 实际用量费用（可用构造 usage 断言）。
- **验证结果（本轮）**：✅ 已复核 `billing-openai.ts:58-78`、`:234-235`、`:261` 与 `credit-check.ts:117-118` 的链路成立；❌ 修复待上游完成。

### R10-2【重要】`x-retry-count` 语义混用：发布侧重试数被当作消费侧重试计数，一次消费失败可直进 DLQ

- **问题描述**
  - `servers/admin-api/src/services/billing/mq/publisher.ts:157`、`servers/cloud-controller/src/services/billing-event-publisher.ts:331`：消息头 `x-retry-count` 取 **outbox 发布侧**的 `attempts`；
  - `servers/admin-api/src/services/billing/mq/consumers.ts:128-131`：消费侧把同一 header 当作**消费侧重试计数**，`retry = header + 1`，`retry > config.rabbitmqRetryMax`（默认 5）即直接进 DLQ。
- **根因分析**：同一 header 承载两个不同语义的计数器，未做隔离。
- **失败场景**
  outbox 因 broker 抖动重发 5 次后成功（`attempts=5`），消息**首次投递**即带 `x-retry-count=5`；消费端遇一次瞬时 Mongo 抖动 → `retry=6 > 5` → **一次消费失败即进 DLQ**，5s/10s/…/5min 的指数退避整体跳过，事件滞留死信 7 天。反向副作用：首次投递 `retry>0` 会误触发 `consumers.ts:181/254` 的「结算链补投门」，产生冗余 settlement 消息（被 `(reservationId, cycleSeq)` 幂等吸收，无资金风险但放大链路）。
- **修复方案**
  1. 消费侧重试计数独立 header（如 `x-consumer-retry`，首次投递恒 0，重投时由 `consumers.ts` 递增）；
  2. `x-retry-count` 仅表达发布侧尝试，或直接不再发送；
  3. 「补投结算链」改用 `msg.fields.redelivered` 或独立计数判断，不再复用该 header。
- **验证结果（本轮）**：✅ 三处引用已逐行核对（`publisher.ts:157`、`billing-event-publisher.ts:331`、`consumers.ts:128/130/181/254`）；❌ 修复待上游完成。

### R10-3【重要】outbox 隔离过激 + `model_call.*` 事件隔离后无补投线，模型调用可静默漏计

- **问题描述**
  - `servers/admin-api/src/services/billing/mq/publisher.ts:29,35`、`servers/cloud-controller/src/services/billing-event-publisher.ts:372-373`：`maxAttempts = 20`、`intervalMs = 2000` 且**无退避**；每轮失败即 `markFailed` 烧掉一次 `attempts`；
  - `billing-outbox.ts:117`（cloud-controller）/ `publisher.ts:77`（admin-api）：`failed: { $ne: true }` —— 一旦 `failed:true` 就**永不被 relay 认领**；
  - `servers/admin-api/src/services/billing/reconciliation.ts:212-271`：`events` 对账线**只扫描 cloud-controller 的容器**（`container.ready/destroyed`）；
  - `reconciliation.ts:345-379`：`apiCalls` 对账线**只出报告、不补投**（`cost>0 && invoiceSeq=null`）。
- **根因分析**：隔离（quarantine）之后缺少「复位/补投」出口；而 `model_call.*` 事件的生产者是 admin-api 自身，不在 `events` 线的扫描范围内。
- **失败场景**
  1. RabbitMQ 滚动重启 2~10 分钟：每轮只有队首行烧一次 `attempts`，约 40 秒即把队首事件隔离，随后逐行隔离；
  2. 容器事件最长 24h 后由 `events` 线复位重投（`reconciliation.ts:587-603`）；**`model_call.*` 事件没有任何复位线**，隔离后计量/扣费静默缺失，只剩 `apiCalls` 报告等人工处置；
  3. `RABBITMQ_DISABLED=true`（`aspire/AgentGear.AppHost/AppHost.cs:72-87` 逃生门）时，积压会按「每 40 秒一行」**全部**转为隔离行，与 `aspire/AgentGear.AppHost/AGENTS.md`「计费事件保留在 outbox 待恢复后补投」的承诺不符。
- **影响**：违反 PRD §4.4「事件不丢失…最终以对账兜底补算，任何消费都可被计费」。
- **修复方案**
  1. 区分**传输级失败**（连接断开/confirm 超时，不烧 per-message `attempts`）与**消息级被拒**；
  2. relay 失败轮次按指数退避（2s→30s），让 20 次尝试覆盖足够长的故障窗；
  3. 为 `model_call.*` 补一条复位/补投线（或通用 `failed:true` sweep），并把 `apiCalls` 线升级为「发现即补投」（复用 `repairEvent` + `repairOf` 护栏）；
  4. 契约/运维口径明确「隔离 + 人工」时必须有告警。
- **验证结果（本轮）**：✅ 已核实 `reconcileEvents` 仅覆盖容器、`reconcileApiCalls` 仅报告、隔离行过滤条件成立；❌ 修复待上游完成。

### R10-4【一般】`BillingApiCall.status='started'` 孤儿记录不可发现，且 UI 误显示为「完成」

- **问题描述**：`routes/billing-openai.ts:294` 先落 `status:'started', cost:0` 记录，`res.json` 之后才 `finalize` 落事实（`:452-453`）。进程在两者之间崩溃 → 记录永久停留 `started`。
- **根因分析**：`reconciliation.ts:355-356` 的 `apiCalls` 线只查 `cost>0 && status∈[completed, aborted]`，`started` 与 `failed` 都不在扫描范围；`apps/admin-web/src/pages/BillingPage.tsx:373-375` / `apps/agent-web/src/pages/BillingPage.tsx:284-286` 的状态映射为 `aborted→中断、failed→失败、其余→完成`，`started` 被显示为「完成」。
- **失败场景**：一次调用 UI 显示「完成」但无用量、无账单、无事件，两条对账线都看不见，成为不可发现的漏计。
- **修复方案**：UI 对 `started` 显示「进行中/异常」；`apiCalls` 线增补 `status∈[started,failed] 且 finishedAt 超时` 的孤儿检查；`contracts/admin-billing.graphql:149` 注释补齐 `started`。

### R10-5【一般】充值收据已生成但两端界面均无法查看

- **问题描述**：`services/billing/billing-service.ts:842-849` 为充值出具收据；但 `apps/admin-web/src/components/billing/InvoiceTable.tsx:51-57` 与 `apps/agent-web/src/pages/BillingPage.tsx:217-225` 只对 `invoice.type === 'charge'` 开放「查看」，`recharge` 显示 `-`。
- **影响**：PRD 后台充值流程第 F 步「生成充值账单与收据」在界面上不可达，对账争议时缺证。
- **修复方案**：`type !== 'charge'` 但 `receiptId` 非空的账单同样可点开（`adminBillingReceipt(invoiceId)` / `myBillingReceipt(invoiceId)` 已按账单直查，无后端改动）。

### R10-6【一般】对账中心只暴露 3 条线，其余 4 条线的报告标题被误标为「资源对账」

- **问题描述**：`apps/admin-web/src/pages/ReconciliationPage.tsx:12-16` 只有 funds/metering/resources 三个按钮；`:65` 的标题兜底 `report.line === 'funds' ? … : '资源对账'`；后端实际 7 条线（`services/billing/reconciliation.ts:36-44`：`funds/metering/resources/events/rollups/apiCalls/containerInvoices`）。
- **失败场景**：点「运行全部对账」返回 7 份报告，`apiCalls`（费用↔账单缺失）等报告标题显示为「资源对账」，差错归属被误导；也无法单线触发 `apiCalls`/`containerInvoices`。
- **修复方案**：按钮/下拉补全 7 条线；标题按 `line` 全量映射并回退显示原始 line 名；同步更新 `contracts/admin-billing.graphql:132` 注释。

### R10-7【一般】账单明细缺少 PRD 要求的「时间范围/类型/来源」筛选

- **问题描述**：PRD 功能点 7 验收项要求「账单明细可按时间范围、类型（消费/充值）、来源（容器/模型）筛选与分页查看」。后端 GraphQL 已支持 `from/to/type/category`（`apps/admin-web/src/graphql/queries.ts:238-244`、`apps/agent-web/src/graphql/queries.ts:472-490` 已声明变量），但 `apps/admin-web/src/pages/BillingPage.tsx:65-68`、`apps/agent-web/src/pages/BillingPage.tsx:45-47` 从未传入。
- **修复方案**：账单卡片加筛选控件并透传变量，切筛选时重置页码。

### R10-8【一般】Anthropic 转发路径缺少客户端中断的写保护（与 OpenAI 路径不对称）

- **问题描述**：`routes/billing-openai.ts:631-646`（流式循环结束后无条件 `res.write`/`res.end`）、`:425-427`（非流式无条件 `res.json`）；对照 OpenAI 路径已有 `if (!aborted)` 保护（`:488-493`）。
- **失败场景**：客户端恰在 Anthropic 流末尾前断开（`aborted=true`、socket 已销毁），`res.write` 打到已销毁响应，可能触发 `ERR_STREAM_DESTROYED` / `write after end` 的 `error` 事件；Express 未对 `res` 挂 error 监听，最坏中断进程。
- **修复方案**：所有 `res.write/res.end/res.json` 前判断 `!aborted && !res.writableEnded`，与 OpenAI 路径同标准。

### R10-9【观察】Anthropic usage 语义与管线「cached ⊆ input」扣减口径不一致（当前不可触发）

- **问题描述**：`billing-openai.ts:568-570`、`:606-611` 直接取 `usage.input_tokens` / `cache_read_input_tokens`；但 Anthropic 语义下 `input_tokens` **不含** `cache_read_input_tokens`。而 `services/billing/pricing.ts:154-155`（`cached = min(cached, input); nonCached = input - cached`）与 `metering.ts:113`（`cachedInputTokens > inputTokens` 时截断）按 OpenAI 语义（`prompt_tokens` **含** `cached_tokens`）处理。
- **当前状态**：网关把 `content` 数组压平为字符串（`contentText`），无法传递 `cache_control`，故 `cache_read_input_tokens` 实际恒为 0，**暂不可触发**；`cache_creation_input_tokens` 亦未采集。
- **风险**：一旦支持提示词缓存，将系统性少计费（如 `input=200, cache_read=1000` 时只计 200，800 token 无声消失）。
- **修复方案**：usage 归一时按 provider 分支——Anthropic 令 `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，`cachedInputTokens = cache_read_input_tokens`，使 `cached ⊆ input` 成立；或在契约中显式声明不支持缓存计费。

### R10-10【观察】错误体 `type` 枚举越界，500/502 响应未入契约

- `billing-openai.ts:251-277` 的 `type:'account_frozen'/'account_not_found'` 不在 `contracts/billing-openai.openapi.yaml:211-219` 的 `type` 枚举内；`:382`（500）、`:508`（502）未在 `:69-90` 的响应声明中。建议补齐枚举与响应条目，或统一用 `invalid_request_error`/`server_error` 承载、由 `code` 表达细分。

### R10-11【观察】每日对账 cron 无补跑，错过触发分钟即整日跳过

- `services/billing/scheduler.ts:38-40` 以「当前分钟 == `config.billingReconCron`」触发；进程在该分钟未运行（重启/停机）则当日不再执行，`lastReconKey` 只做去重不做补跑。会削弱「对账兜底」。建议改为「距上次成功运行 ≥ 24h 即执行」。

### R10-12【观察】结算路径的 preCheck 由计费侧自铸，「来源校验」弱于提案承诺

- `services/billing/billing-service.ts:751-761` 在扣费前自行 `checks.check({policy:'accrue-and-track'})` 生成凭证再交给 `payment.charge`；提案 §5.2 实现点 1 声称「payment/settle 入参强制携带 preCheck 凭证（来源校验），绕过即抛错」。实际 `credit-check.ts:130-152` 只校验「凭证存在、未过期、account/ref 一致」，无法证明「准入检查确实发生过」。建议在文档中如实限定，或让凭证由准入侧签发并携带单调计数。

### R10-13【观察】提案文档口径与实现不一致

- 提案 §5.2 判定公式写 `available - estimatedCredits >= -creditLimit`，而 `available = cash + gift + creditLimit - frozen` 已含 `creditLimit`，字面会双重计入授信；实现 `credit-check.ts:117-118` 采用 `available(含授信) - estimated >= 0`（与 PRD 功能点 6「余额可负、不超授信」一致，**实现正确**），建议更正文档。
- 提案 §4.3/§9.2 写「prefetch 默认 32」，实现 `config/index.ts:36` 默认 10。

### R10-14【观察】网关请求体未严格校验

- `billing-openai.ts:188-189`、`:299`：`stream:"true"`（字符串）会走非流分支并把 `stream:"true"` 透传上游，上游回 SSE 导致 usage 全 0、按估算兜底计费；`messages` 允许空数组。建议显式 `typeof body.stream === 'boolean'`、`messages.length >= 1`。

## 三、修复总览

| # | 问题 | 根因 | 级别 | 状态 | 修复 commit |
|---|------|------|------|------|-------------|
| R10-1 | 预检估算低估（多模态丢弃 / CJK len/4），预付费账户可透支 | 估算未构成实际费用上界，唯一同步卡点失效 | 阻断 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-2 | `x-retry-count` 发布/消费语义混用，一次消费失败直进 DLQ | 同一 header 承载两个计数器 | 重要 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-3 | outbox 隔离过激 + `model_call.*` 无补投线 | 隔离后无复位出口，事件线只覆盖容器 | 重要 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-4 | `started` 孤儿调用不可发现、UI 显示「完成」 | 对账线状态过滤 + UI 状态映射兜底 | 一般 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-5 | 充值收据无法查看 | 前端只对 `charge` 开放收据入口 | 一般 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-6 | 对账中心只暴露 3 条线且标题误标 | 前端硬编码三条 + 标签兜底 | 一般 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-7 | 账单筛选（时间/类型/来源）缺失 | 前端未透传已支持的 GraphQL 变量 | 一般 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-8 | Anthropic 路径缺中断写保护 | 与 OpenAI 路径保护不对称 | 一般 | ✅ 已修复并经第十一轮核实 | d3782e8 |
| R10-9 | Anthropic 缓存 token 口径不一致 | provider usage 语义未归一 | 观察 | ✅ 已修复（usage 归一） | d3782e8 |
| R10-10 | 错误 `type` 枚举越界、500/502 未入契约 | 契约与实现漂移 | 观察 | ✅ 已修复（契约补齐） | d3782e8 |
| R10-11 | 每日对账无补跑 | cron 按分钟精确匹配 | 观察 | ✅ 已修复（≥24h 补跑） | d3782e8 |
| R10-12 | preCheck 自铸，来源校验弱于文档 | 凭证签发点在扣费侧 | 观察 | ✅ 已如实限定（提案 + credit-check 注释） | d3782e8 |
| R10-13 | 提案公式/prefetch 口径与实现不符 | 文档未随实现更新 | 观察 | ✅ 已更正（提案） | d3782e8 |
| R10-14 | `stream`/`messages` 未严格校验 | 入参宽松 | 观察 | ✅ 已修复（严格校验 + 400 用例） | d3782e8 |

## 四、最终验证（本轮独立复跑）

| 项目 | 命令 | 结果 |
|------|------|------|
| 类型检查 admin-api | `npx tsc --noEmit` | ✅ 0 error |
| 类型检查 agent-api | `npx tsc --noEmit` | ✅ 0 error |
| 类型检查 cloud-controller | `npx tsc --noEmit` | ✅ 0 error |
| 单测 admin-api | `npx vitest run` | ✅ 542 passed / 1 skipped（55 文件） |
| 单测 agent-api | `npx vitest run` | ✅ 658 passed（46 文件） |
| 单测 cloud-controller | `npx vitest run` | ✅ 197 passed（14 文件） |
| 合计 | — | ✅ **1397 passed / 1 skipped** |
| API / E2E 集成 | `aspire start` + `tests/api`、`tests/e2e` | ⚠️ 本轮**未执行**：Aspire AppHost 启动卡在 `aspire-managed nuget search`（NuGet 源不可达，进程长时间挂起）导致 `Timed out waiting 120s for AppHost to start`，提高 `ASPIRE_CLI_START_TIMEOUT` 仍未完成。属**本机网络/环境限制，非代码缺陷**；集成/E2E 证据留待修复轮在可用编排环境中补跑 |

> 说明：单测全绿**不能**覆盖本轮 14 项发现——R10-1/R10-2/R10-3 均属跨进程/跨服务时序与估算口径问题，现有用例未构造相应故障窗口；这正是必须由代码审查发现的部分。

## 五、结论与打回理由

1. **R10-1 属资金安全不变量缺陷**：预付费账户「不可透支」是 PRD §3.5 明确的异常边界行为，当前因估算低估而可被普通中文请求/多模态请求绕过，且完全在用户可控范围内，必须修复后才能进入 release。
2. **R10-2/R10-3 属 PRD §4.4 可靠性违约**：「传递失败自动重试」「任何消费都可被计费」在当前实现下会被「一次消费失败直进 DLQ」「模型调用事件隔离后无人补投」打破，兜底依赖人工发现，与「对账兜底」承诺不符。
3. 一般项 R10-4~R10-8 直接对应 PRD 验收项（充值收据、账单筛选、对账结果可见）或进程稳定性，建议与阻断项一并修复。
4. 观察项 R10-9~R10-14 不阻断本轮，但 R10-9 一旦支持提示词缓存即转为真实少计费，应在支持缓存前处理。

5. 另需在可用编排环境中补跑 `tests/api` 与 `tests/e2e`（本轮因 Aspire AppHost 启动受 NuGet 源不可达影响未能执行），并把结果回填本报告第四节。

**处置：本轮 AI Review 打回（REJECT）**，请上游按 R10-1 → R10-2/R10-3 → R10-4~R10-8 的优先级修复并补充针对性回归用例（尤其故障窗口与估算上界用例），修复后重新提交 integration 验收。

## 六、经验总结

1. **「估算必须是实际的上界」**：凡以预估值做准入闸门（额度/配额/限流）的场景，估算口径必须保证不低估，否则闸门的拒绝语义会被静默穿透；估算函数应有「上界性质」的断言用例。
2. **消息头不要复用**：发布侧与消费侧的重试计数必须分属不同 header，否则 at-least-once 的退避语义会被破坏。
3. **隔离必须配复位出口**：任何「超过 N 次即隔离」的机制都要有自动 sweep / 对账补投线，且补投线的覆盖范围要与事件生产者范围一致（本例漏了 admin-api 自产的 `model_call.*`）。
4. **对账线数量变化必须同步 UI 与契约**：后端新增对账线时，前端标签映射与 GraphQL 注释是同一契约的一部分。
5. **两条相似路径要同标准**：OpenAI / Anthropic 两条转发路径的中断写保护必须一致，差异点是崩溃面。

## 七、R10 返工修复记录（2026-10-20）

> 修复提交：`d3782e8`（integration）。第十一轮复核请以本提交为被审对象。

| # | 修复内容 | 关键落点 | 回归用例 |
|---|----------|----------|----------|
| R10-1 | 预检输入改为 UTF-8 字节保守估算（默认 1 token/字节，可配置），图片/音频/文件/工具参数固定高估；输入单价取 `max(input, cached)`；缺省 `max_tokens` 注入上游硬上限 | `billing-openai.ts`、`config/index.ts` | CJK/多模态/tool_calls「估算 ≥ 实际」断言；`billing-openai.test.ts` |
| R10-2 | 消费侧重试独立为 `x-consumer-retry`；发布侧改为 `x-publish-attempts`；结算链补投改用消费侧重投/`redelivered` | `mq/consumers.ts`、`mq/publisher.ts`、cloud `billing-event-publisher.ts` | 发布 attempts 不触发 DLQ/补投；`redelivered` 可补投 |
| R10-3 | 传输级失败不消耗 per-message attempts，relay 失败 2s→30s 指数退避；`model_call.*` 隔离行自动复位，`apiCalls` 线发现即补投 | `mq/publisher.ts`、`billing-event-publisher.ts`、`reconciliation.ts` | 传输/消息级失败分流；隔离复位；cost-without-invoice 补投 |
| R10-4 | UI 对 `started` 显示「进行中/异常」；`apiCalls` 线新增超时 `started/failed` 孤儿检查；契约状态注释补齐 | admin/agent `BillingPage.tsx`、`reconciliation.ts`、`contracts/admin-billing.graphql` | 孤儿调用报告用例 |
| R10-5 | 充值账单在存在 `receiptId` 时同样可查看收据 | admin `InvoiceTable.tsx`、agent `BillingPage.tsx` | 前台充值收据用例 |
| R10-6 | 对账中心补全 7 条线，标题全量映射并回退原始 line | `ReconciliationPage.tsx`、契约注释 | 构建 + 对账中心 E2E |
| R10-7 | 账单明细接入时间范围/类型/来源筛选，变更重置页码 | admin/agent `BillingPage.tsx` | 构建 + 页面单测 |
| R10-8 | Anthropic 非流式/流式所有写响应前判断 `aborted`/`writableEnded` | `billing-openai.ts` | 与 OpenAI 路径同标准 |
| R10-9 | Anthropic usage 归一：`input = input + cache_read + cache_creation`，`cached = cache_read` | `billing-openai.ts` | usage 归一化单测 |
| R10-10 | 契约补齐 `account_not_found` 与 500/502 响应 | `contracts/billing-openai.openapi.yaml` | 契约审阅 |
| R10-11 | 每日对账改为「距上次成功 ≥ 24h 补跑」，失败不更新水位 | `scheduler.ts`、`config/index.ts` | 24h 补跑单测 |
| R10-12 | 提案如实限定 preCheck 只校验存在/未过期/account+ref，不证明来源 | 技术提案 §5.2 | 文档 |
| R10-13 | 更正提案判定公式（available 已含授信）、prefetch=10、退避与默认值 | 技术提案 | 文档 |
| R10-14 | 严格校验 `stream` 布尔、`max_tokens` 正整数、messages 非空 | `billing-openai.ts` | 网关 400 用例 |

### 本轮独立复跑

| 项目 | 结果 |
|------|------|
| `tsc --noEmit`（admin-api / cloud-controller） | ✅ 0 error |
| `npm run build`（admin-web / agent-web） | ✅ 通过 |
| Vitest admin-api | ✅ 554 passed / 1 skipped |
| Vitest agent-api | ✅ 658 passed |
| Vitest cloud-controller | ✅ 198 passed |
| Vitest admin-web | ✅ 207 passed |
| Vitest agent-web | ✅ 430 passed |
| tests/api（真实 Aspire 编排） | ✅ 453 passed / 1 skipped |
| tests/e2e 计费套件 | ✅ 3 passed（`billing.spec.ts`、`admin-billing.spec.ts`） |
| tests/e2e 全量 | ⚠️ 183 passed / 47 failed（首轮）；重启 Aspire 清库后复跑相关 47 项，28 passed / 19 failed。剩余失败集中在 session/gateway/admin-cloud 的既有选择器 strict-mode 与侧边栏文案，与本次计费改动无交集，待集成验收统一处置 |

## 八、第十一轮 AI Review 返工复核记录（2026-10-20）

> 被审对象：返工提交 `d3782e8`（代码）+ `8951bc6`（报告回填）。复核方式：对返工 diff **逐行独立审读**（不采信第七节自述），并独立复跑验证。

### 8.1 R10 十四项修复逐项核验（全部为真修复 ✅）

| # | 核验落点（本轮逐行确认） | 结论 |
|---|--------------------------|------|
| R10-1 | `billing-openai.ts`：`estimatePromptTextTokens`（UTF-8 字节/可配置倍率，`Math.max(1, …)` 钳位）、`estimateContentTokens`（image/audio/file 固定高估 8192/16384/16384、tool_calls 计序列化字节 + 固定开销、未知块「绝不返回 0」）、`estimateRequestTokens`（messages+tools 全量）、`estimateCost` 改 `max(input, cached)` 单价；缺省 `max_tokens` 注入上游硬上限（OpenAI 路径 `basePayload` 与 Anthropic 路径 `max_tokens: input.maxOutputTokens` 同源）；预检链路 `promptTokens → creditCheck.estimatedCredits` 不变量恢复成立 | ✅ |
| R10-2 | `mq/consumers.ts`：消费侧重试独立 `x-consumer-retry`，`wasRedelivered()` 只认消费侧计数/`msg.fields.redelivered`；`mq/publisher.ts:157` 与 cloud `billing-event-publisher.ts:331` 改发 `x-publish-attempts`；结算链补投门改用 `redelivered`，发布 attempts 不再触发 DLQ/补投 | ✅ |
| R10-3 | 传输级/消息级失败分流（`isMessageLevelRejection`：仅 AMQP replyCode 或 NO_ROUTE 等拒绝码烧 attempts）；relay 失败轮 2s→4s→8s→16s→30s 退避（`nextDelayMs`）；`reconcileApiCalls` 新增 `model_call.*` 隔离行自动复位 + 发现即补投（复用 `repairEvent`，`repairOf` 收敛护栏、eventId 撞索引分派 requeue/代偿） | ✅ |
| R10-4 | UI `started` 显示「进行中/异常」（admin/agent 两端）；`apiCalls` 线新增 `started/failed` 且超孤儿阈值（默认 30min）检查；契约 `admin-billing.graphql` 状态注释补 `started` | ✅ |
| R10-5 | `InvoiceTable.tsx` / agent `BillingPage.tsx` 改为 `type==='charge' || receiptId` 开放收据（两查询均已含 `receiptId` 字段） | ✅ |
| R10-6 | `ReconciliationPage.tsx` 补全 7 条线 + `LINE_LABELS` 全量映射并回退原始 line；契约注释同步 | ✅ |
| R10-7 | 两端账单明细接入开始/结束日期、类型（charge/recharge/adjust）、来源（container/model/manual）筛选并透传 GraphQL 变量，切筛选重置页码 | ✅ |
| R10-8 | Anthropic 非流式/流式所有 `res.write/res.end/res.json` 前判断 `aborted && writableEnded`；OpenAI 非流式两处补同标准保护 | ✅ |
| R10-9 | `applyAnthropicUsage`：`input = input_tokens + cache_read + cache_creation`、`cached = cache_read`，`cached ⊆ input` 成立（流式 `message_start`/非流式统一走该函数） | ✅ |
| R10-10 | `billing-openai.openapi.yaml` 补 `account_not_found` 枚举与 500/502 响应声明 | ✅ |
| R10-11 | `scheduler.ts` 改「距上次成功 ≥ 24h 补跑」，失败不更新水位、`reconRunning` 防重入 | ✅ |
| R10-12 | 技术提案 §5.2 与 `credit-check.verify` 注释如实限定（只证凭证存在/未过期/account+ref 一致，不证来源） | ✅ |
| R10-13 | 提案判定公式更正（`available - estimated >= 0`，available 已含授信）、prefetch=10、退避与配置表口径同步 | ✅ |
| R10-14 | `stream` 必须布尔、`max_tokens` 必须正整数、`messages` 非空，违例 400 且不打上游（有用例） | ✅ |

**资金安全独立验证**：本轮重点复核「补投不双扣」——`reconcileApiCalls` 补投走 `repairEvent`，其 `model_call.*` 消费链最终经 `handleModelCallEvent → chargeAndInvoice`，`idempotentKey: charge:model:${resourceId}` / `invoiceKey: invoice:model:${resourceId}` 为业务幂等键（与 eventId 无关），代偿行（`…:repair:<ts>`）重放不会重复扣费/重复开票；`repairOf` 护栏保证每个原始事件至多补投一次。**结论：R10-3 修复无双扣风险**。

### 8.2 本轮独立复跑（不引用上游数据）

| 项目 | 命令 | 结果 |
|------|------|------|
| 类型检查 admin-api / agent-api / cloud-controller | `npx tsc --noEmit` ×3 | ✅ 0 error |
| 单测 admin-api | `npx vitest run` | ✅ 554 passed / 1 skipped（55 文件） |
| 单测 agent-api | `npx vitest run` | ✅ 658 passed（46 文件） |
| 单测 cloud-controller | `npx vitest run` | ✅ 198 passed（14 文件） |
| 单测 + 构建 admin-web | `npx vitest run` + `npm run build` | ✅ 207 passed，构建通过 |
| 单测 + 构建 agent-web | `npx vitest run` + `npm run build` | ✅ 430 passed，构建通过 |
| tests/api / tests/e2e | 本轮未重复起 Aspire 编排 | 引用返工轮记录：tests/api 453 passed / 1 skipped；tests/e2e 计费套件 3 passed；tests/e2e 全量剩 19 failed（见 R11-1/R11-2） |

### 8.3 本轮新发现问题

#### R11-1【一般·必修】本 diff 新增的工作负载「必须标记」E2E 用例确定性失败，验收证据无效

- **问题描述**：`tests/e2e/src/admin-cloud-container.spec.ts` 的 **T-E17（:332）** 与 **T-E19（:439）** 是本 diff 新增用例（`release` 基线无此两用例、无「必须」相关断言），被测 UI（`StartContainerDialog` 必须开关、`WorkloadLogsDialog` 必须徽标）同样是本 diff 新增。两用例对本 diff 自身的 UI **必然失败**（非偶发）：
  1. **T-E17**：`dialog.getByRole('checkbox', { name: withInit.name })` 撞 strict-mode——必须开关渲染后 `aria-label='e2e-req-init-xxx 必须'` 与工作负载多选项 `aria-label='e2e-req-init-xxx'` 同时命中（Playwright name 匹配为子串），2 elements → click 失败（证据：`tests/e2e/test-results/admin-cloud-container-Admi-82dad-orkloads-with-an-initScript/error-context.md`）；
  2. **T-E19**：`dialog.getByText('必须', { exact: true })` 撞 strict-mode——选中 `required` 记录时 `WorkloadLogsDialog.tsx:120-122`（列表行徽标）与 `:141-143`（详情面板）各渲染一次「必须」，2 elements → `toBeVisible()` 失败（证据：`tests/e2e/test-results/admin-cloud-container-Admi-cce4f-tory-unmarked-direct-Mongo-/error-context.md`）。
- **根因分析**：用例选择器未对同名子串/重复文案做消歧（缺 `exact: true` 或作用域限定）；该 spec 合入前未在真实 UI 上跑绿过，导致「工作负载必须标记」（PRD 工作负载三期验收项）的 E2E 回归**形同虚设**。UI 行为本身经代码审读符合设计（开关仅对 initScript 工作负载展示、取消勾选即清除），缺陷在测试侧。
- **修复方案**：
  1. T-E17：工作负载多选 checkbox 点击处改 `getByRole('checkbox', { name: withInit.name, exact: true })`，必须开关保持 `name: \`${withInit.name} 必须\``；
  2. T-E19：「必须」断言限定到详情面板作用域（或改用 `getByText('必须', { exact: true }).first()` 并补断言列表行徽标），历史记录断言同步；
  3. 修复后在真实 Aspire 编排下复跑 `admin-cloud-container.spec.ts` **全文件**并把结果回填本报告。
- **验证结果（本轮）**：✅ 已核实两用例为本 diff 新增且失败根因如上；❌ 修复待上游完成。

#### R11-2【一般·必须处置】16 项 session/gateway/auth E2E 既有失败，全量 E2E 质量门长期不绿（第十轮委托「集成验收统一处置」）

- **问题描述**：全量 E2E 剩余 19 项失败中 16 项属 session（9）/gateway（6）/auth（1）：
  - session 系：`getByRole('button', { name: '新建会话' })` strict-mode——侧边栏 `Sidebar.tsx:358-360`（`aria-label="新建会话"`）与页面头部 `SessionPage.tsx:48` 同时渲染，2 elements（9 个用例全部倒在同一前置步骤）；
  - gateway 系（6）与 auth（1）：`locator('nav[aria-label="Sidebar"]').getByText('统一网关'/'会话')` 永远不可见——侧边栏导航为图标链接、可访问名由 `title` 属性承载（`Sidebar.tsx:187/233`），`getByText` 匹配不到文本节点。
- **归属判定（本轮实证）**：上述 spec（`session*.spec.ts`/`gateway.spec.ts`/`auth.spec.ts`）与相关 UI（`Sidebar.tsx`/`SessionPage.tsx`）在 `release` 与 `integration` **两分支逐行同代码**（`release...integration` 对这些文件无差异，Sidebar 的 diff 仅新增计费导航项），**失败与本 diff 无关、属既有测试腐化**（图标化侧边栏/双入口按钮改版后未同步适配 spec）。因此不构成对本集成变更的功能性打回理由。
- **处置要求（集成验收统一处置结论）**：以下二选一，且必须在本报告登记结论后随重提提交：
  1. **修复（推荐）**：给 16 项 spec 做选择器适配（`exact: true`、按 `title`/`aria-label` 定位导航链接、页面头部按钮加精确作用域），使全量 E2E 转绿；或
  2. **书面登记为已知基线债务**：在本报告与发布说明中明示「release 基线全量 E2E 即不绿」的 16 项清单、根因、修复责任与计划，明确其不得作为本集成的功能回归信号，同时不得掩盖 R11-1 类**本 diff 引入**的失败。
- **验证结果（本轮）**：✅ 归属判定已实证（两分支同代码）；❌ 处置结论待上游给出。

#### 观察项（不阻断，随下轮一并收口）

- **R11-3【观察】** `AdminOutboxPublisher.start()` / cloud `BillingEventPublisher.start()` 退避改造后：`start()` 二次调用可在首个 `setTimeout` 落位前并发拉起双 relay 循环；`stop()` 后在途 `run()` 仍会续排 `setTimeout`（unref 定时器、进程退出无碍，但 stop 语义不严密）。建议以 `started` 标志在重排前判活。
- **R11-4【观察】** R10-1 的「估算 ≥ 实际」上界性质仅在各模态固定高估常量（image 8192 / audio 16384 / file 16384 token）覆盖真实用量时严格成立；超长音频/超大文件输入（如 30min+ 音频）实际 token 可能超过常量。建议对 audio/file 增加请求体积/时长上限，或按 `max(常量, 序列化字节/倍率)` 取上界，并在契约中声明各模态上限。
- **R11-5【观察】** `config.billingReconCron` 在 R10-11 改造后已无消费方（死配置）；提案配置表已改 `BILLING_RECON_INTERVAL_MS`，建议删除该配置或注明废弃。
- **R11-6【观察】** `estimateRequestTokens(messages, body.tools)` 未计入已废弃的 legacy `body.functions`；仅影响仍传 `functions` 的调用方，建议顺手补计或显式拒绝。

### 8.4 第十一轮结论与打回理由

1. **R10-1~R10-14 全部为真修复**：资金安全（预检上界、补投业务幂等防双扣）与事件可靠性（重试头隔离、传输/消息级失败分流、隔离复位与补投线）不变量经逐行核验恢复成立，独立复跑 tsc ×3 + 单测 2047 passed / 1 skipped + 前端构建全绿，与上游自述一致。
2. **但 `integration..release` 的交付物中，本 diff 新增的 E2E 验收证据无效（R11-1）**：T-E17/T-E19 确定性红，工作负载「必须标记」功能没有可运行的 E2E 回归背书，不符合「随代码交付可绿回归」的集成验收要求。
3. **R11-2 需按 8.3 处置要求给出明确结论**（推荐修选择器），不得以「与计费无关」为由默认放行。

**处置：第十一轮 AI Review 打回（REJECT）**。请上游：① 修复 R11-1 两用例选择器并复跑 `admin-cloud-container.spec.ts` 全绿回填；② 对 R11-2 按「修复或书面登记基线债务」二选一给出结论并回填；③ 观察项 R11-3~R11-6 可随本次返工一并收口（非必须）。完成后重新提交 integration 验收（第十二轮）。

### 8.5 本轮经验沉淀

1. **新增 UI 的 E2E 必须先跑绿再合入**：spec 与 UI 同 PR 交付时，「用例写完没跑过」等价于没有回归；strict-mode 命中是这类问题最快的暴露信号。
2. **`getByRole(name)` 默认子串匹配**：存在派生命名（`<name>` 与 `<name> 必须`）时必须 `exact: true` 或换唯一作用域；`getByText` 同理防多节点。
3. **既有失败与变更引入的失败要分开定性**：先做「两分支同代码」基线比对再定归属，避免把测试腐化记到本次变更头上，也避免用「既有」掩盖本 diff 的新失败。

