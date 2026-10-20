---
description: integration→release 集成验收报告（AI Review 第十轮独立复核·打回）：网关预检估算低估可致预付费账户透支、x-retry-count 语义混用致一次消费失败直进 DLQ、model_call 事件隔离后无补投线等 3 项必修 + 5 项一般 + 6 项观察
type: Permanent
---

> **状态**: **第十轮 AI Review 独立复核 · 打回（REJECT）→ 已返工，待第十一轮复核**（修复提交 `d3782e8`，详见第七节）。本轮由 AI Review 节点对 `integration..release` 全量差异（179 文件 / +25953 行）做独立代码审查，**未参考任何历史验收报告**，仅以 PRD / 技术提案 / API 契约为基准。共提出 **14 项**问题：**1 项阻断（R10-1）+ 2 项重要（R10-2、R10-3）+ 5 项一般（R10-4~R10-8）+ 6 项观察（R10-9~R10-14）**。其中 R10-1 直接违反 PRD §3.5「余额不足且不支持透支时拒绝调用」的资金安全不变量，R10-2/R10-3 违反 PRD §4.4「事件不丢失、传递失败自动重试、任何消费都可被计费」，**故本轮打回，要求上游修复后重新提交验收**。

## 关联文档

| 项 | 值 |
|----|----|
| 关联 PRD | [[../product/draft/20261018-credits-billing.md]]（费用中心 v2.1）、[[../product/draft/20261019-aspire-workload-proxy.md]]（Aspire 工作负载下载代理 v1.0） |
| 技术提案 | [[../proposals/20261018-feat-credits-billing.md]]（v2.1）、[[../proposals/20261019-feat-aspire-workload-proxy.md]]（v1.0） |
| 实现计划 | [[../plan/20261018-feat-credits-billing.md]]、[[../plan/20261019-feat-aspire-workload-proxy.md]] |
| 契约 | `contracts/admin-billing.graphql`、`contracts/billing.graphql`、`contracts/billing-openai.openapi.yaml`、`contracts/billing-events.asyncapi.yaml`、`contracts/cloud-controller-websocket.md` |
| 被审分支 | `integration`（5965fe9，与 origin 同步） |
| 差异范围 | `origin/release...integration`：179 文件变更，+25953 / −77 |
| 验收日期 | 2026-10-20 |
| 上游产物 | 修复Review意见节点：无 Review 意见需修复（reworkCount=0，PR #239 无 Review 评论/结论） |

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
| R10-1 | 预检估算低估（多模态丢弃 / CJK len/4），预付费账户可透支 | 估算未构成实际费用上界，唯一同步卡点失效 | 阻断 | 待修复 | — |
| R10-2 | `x-retry-count` 发布/消费语义混用，一次消费失败直进 DLQ | 同一 header 承载两个计数器 | 重要 | 待修复 | — |
| R10-3 | outbox 隔离过激 + `model_call.*` 无补投线 | 隔离后无复位出口，事件线只覆盖容器 | 重要 | 待修复 | — |
| R10-4 | `started` 孤儿调用不可发现、UI 显示「完成」 | 对账线状态过滤 + UI 状态映射兜底 | 一般 | 待修复 | — |
| R10-5 | 充值收据无法查看 | 前端只对 `charge` 开放收据入口 | 一般 | 待修复 | — |
| R10-6 | 对账中心只暴露 3 条线且标题误标 | 前端硬编码三条 + 标签兜底 | 一般 | 待修复 | — |
| R10-7 | 账单筛选（时间/类型/来源）缺失 | 前端未透传已支持的 GraphQL 变量 | 一般 | 待修复 | — |
| R10-8 | Anthropic 路径缺中断写保护 | 与 OpenAI 路径保护不对称 | 一般 | 待修复 | — |
| R10-9 | Anthropic 缓存 token 口径不一致 | provider usage 语义未归一 | 观察 | 待修复/声明 | — |
| R10-10 | 错误 `type` 枚举越界、500/502 未入契约 | 契约与实现漂移 | 观察 | 待修复 | — |
| R10-11 | 每日对账无补跑 | cron 按分钟精确匹配 | 观察 | 待修复 | — |
| R10-12 | preCheck 自铸，来源校验弱于文档 | 凭证签发点在扣费侧 | 观察 | 待澄清 | — |
| R10-13 | 提案公式/prefetch 口径与实现不符 | 文档未随实现更新 | 观察 | 待更正 | — |
| R10-14 | `stream`/`messages` 未严格校验 | 入参宽松 | 观察 | 待修复 | — |

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

