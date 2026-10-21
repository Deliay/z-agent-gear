---
description: integration→release 集成验收报告（PR #250）——ACP 协议增强（能力快照归一化 / 前端能力门控与能力面板 / 模型来源三档分组 / Elicitation 弹窗链路修复）集成级 AI Review。首轮打回 1 × 🔴 + 8 × 🟠 + 15 × 🟡；二轮返工主体修复真实落地且可证伪（独立实跑 tsc ×4 全 0、单测 1953 passed、tests/api 13 passed 无 skip、tests/e2e 19 passed、PR #250 CLEAN、merge-tree 0 冲突），但**二轮复核结论 REJECT（二次打回）**：2 项 🟠 残余（弹窗卸载无终态收敛、billing-events/billing-gateway 同型静默 skip 且台账标已修复）+ 6 项新 🟠（bridge 进程崩溃/对账杀会话/断线仍迟到 timeout、controller-api 校验 fail-open、请求 Map 泄漏、elicitationDialog store 无卸载对账致自动弹窗失效与跨会话幻影重开、markElicitationCompleted 归属守卫静默失效、respond 路径无归属前置校验）；详见 §七
type: Permanent
---

# integration→release 集成验收报告（2026-10-21，AI Review）

> **状态**: 🔁 **三轮返工完成，待三轮 AI Review 复核**——首轮 1 × 🔴 + 8 × 🟠 + 15 × 🟡（§三）、二轮复核 2 项 🟠 残余 + 6 项新 🟠（§七）均已逐项修复并附可证伪回归测试（§八）；三轮独立实跑：tsc ×4 全 0、单测 1979 passed（416/775/232/556）、eslint 0 error/6 存量 warning、tests/api 13 + billing-gateway 6 + billing-events 3 全 passed 0 skip、tests/e2e 19 passed 0 skip。

## 关联文档

- PRD：`docs/product/draft/20261021-acp-protocol-enhancement.md`
- 技术方案：`docs/engineering/proposals/20261021-feat-acp-protocol-enhancement.md`
- 实现计划：`docs/engineering/plan/20261021-feat-acp-protocol-enhancement.md`
- 调研附录：`docs/engineering/proposals/20261021-feat-acp-protocol-enhancement-opencode-support.md`
- 分支：`integration` @ `c7d8c10`（= `origin/main`），目标分支 `release` @ `8df1d34`；PR #250 `OPEN / CONFLICTING`
- 上游产物：节点「修复Review意见」确认本轮无人类 Review 意见（`rejectInfo=null`、`reworkCount=0`、PR #250 reviews=0）→ 本节点为**集成级首次 AI 代码评审**
- 验收方式：4 域并行深度代码评审（① ACP 协议核心 packages/agent-controller + contracts；② 服务端 servers/agent-api + controller-api；③ 前端 apps/agent-web；④ 测试与文档 tests/api、tests/e2e、docs、AGENTS.md）+ **关键结论人工逐条复核**（不采信分域评审结论）+ 本机独立实跑 tsc / 单测 / eslint + `git merge-tree` 合并预检
- 验收日期：2026-10-21

## 一、验收范围与方法

### 1.1 变更范围

| 特性 | 内容 | 主要落点 |
|---|---|---|
| 能力快照归一化 | `capabilities.ts` 20 项 FeatureId 全集与平台支持矩阵、`normalizeCapabilities()` 三态合并（supported/partial/unsupported）、`buildInitializedPayload()` 快照上送、落库 `Session.agentCapabilities` 与 GraphQL `features/agentCapabilities` 输出 | `packages/agent-controller/src/acp/capabilities.ts`、`servers/{agent-api,controller-api}` |
| 前端能力门控/能力面板 | `useAgentCapabilities` 门控（ModeSwitcher/ModelSwitcher/ConfigOptionsPanel/SessionHeader/输入框）、`AgentCapabilityPanel` 20 项能力清单、`PendingElicitationBanner` 会话内问询兜底入口 | `apps/agent-web/**` |
| 模型来源三档分组 | `inferModelSource()` 库比对→标识前缀→兜底三档推断、`AgentModelInfo.source/sourceProvider/group/basis`、ModelSelectDialog 四组固定顺序分组、SSE 覆盖来源字段时保留 GraphQL 推断（a2cb10f） | `servers/agent-api/src/services/model-source.ts`、`apps/agent-web/src/components/session/ModelSelectDialog.tsx` |
| Elicitation 弹窗链路修复 | bridge form/url 双模式问询、65s 兜底超时、`acp:elicitation:resolved` 事件链（controller-api→Redis→agent-api subscriber→TodoItem 终态）、`respondElicitation` mutation、ElicitationDialog 终态展示 | `packages/agent-controller/src/acp/bridge.ts`、`servers/**`、`apps/agent-web/**` |
| 测试/契约/文档 | tests/api 2 套（426+246 行）、tests/e2e 1 套（368 行）、contracts 双契约更新、PRD/提案/实现计划、各层 AGENTS.md | `tests/**`、`contracts/**`、`docs/**` |

### 1.2 评审方法

1. **分域并行深度评审**（4 域，逐行阅读非抽查）：各域独立产出问题清单（含文件:行号 + 代码证据 + 失败场景），并各自登记「未覆盖部分」。
2. **关键结论人工复核**：全部 🔴/🟠 及疑点由评审主持者逐条回读源码确认/排除（含对子代理上报疑点的**反证**，见 §1.4）。
3. **独立实机验证**：本机全新安装依赖后独立实跑 4 个受影响包的 `tsc` + 全量单测 + `eslint`，不采信任何历史/自报数据。
4. **合并预检**：`git merge-tree --write-tree origin/release origin/integration` 实证冲突面。
5. **安全扫描**：新增行 secret/凭据、`dangerouslySetInnerHTML`、调试 `console.log`、TODO/FIXME 残留。

### 1.3 判定红线（与既往各轮一致）

- 🔴 阻断 / 🟠 重要 → **打回返工**（本轮命中）
- 🟡 建议 → 记录并随修复项一并收口，不单独构成打回

### 1.4 反证记录（人工复核排除的疑点）

| 疑点 | 复核结论 |
|---|---|
| ElicitationDialog `return null` 位于 `useState` 之前 → 条件 hooks 崩溃（分域评审上报的潜在 🔴） | **排除**：`ElicitationDialog.tsx:65` 的 `return null` 属于 `splitUrl()` 工具函数 catch 分支，组件（:68 起）无任何早退位于 hooks 之前，`useState`（:70/:71/:85）均为无条件调用，不存在 hooks 数量变化崩溃 |
| bridge `unsupported_mode` 事件不带 `requestId` | **坐实**：`bridge.ts:737-741` 仅带 `sessionId/reason/detail`（契约允许可选），与 subscriber `if (data.requestId)` 丢弃路径组合即 §3.2 的 🟠 问题 |

## 二、独立验证结果（本机实跑，不采信自报）

| 服务/包 | 类型检查 | Lint | 测试 | 备注 |
|---|---|---|---|---|
| packages/agent-controller | ✅ `tsc --noEmit` 0 | — | ✅ **389 passed**（33 文件） | 含 elicitation 真协议集成测试 |
| servers/agent-api | ✅ `tsc --noEmit` 0 | — | ✅ **732 passed**（53 文件） | — |
| servers/controller-api | ✅ `tsc --noEmit` 0 | — | ✅ **223 passed**（19 文件） | — |
| apps/agent-web | ✅ `tsc -b` 0 | ✅ 0 error / 7 warning（6 条为存量文件，1 条 `TodoListPanel.tsx:94` exhaustive-deps 为本 diff 新增，见 🟡） | ✅ **525 passed**（60 文件） | — |
| tests/api（实机集成套件） | — | — | ⏸️ 本轮未跑 | 需 Aspire 全栈；且 §3.9 指出关键用例挂 `MONGODB_URI` 静默 skip，二轮必须以注入 `MONGODB_URI` 的实跑证据收口 |
| tests/e2e（能力 9 例） | — | — | ⏸️ 本轮未跑 | 同上，T-E31/T-E36 断言缺口须先收口 |
| 合并预检 | `git merge-tree` | — | ❌ **CONFLICTING（3 文件）** | `session.ts`（import 块 content 冲突）、`session.test.ts`（add/add）、`socketio-client.test.ts`（add/add），与上游产物提示一致 |

**结论**：四包 tsc/单测/lint 全绿说明实现与单测自洽，但单测全绿**不构成放行依据**——本轮问题集中在跨层契约保真、终态收敛写入面与验收证据完整性，恰为 mock 单测无法暴露的面。

## 三、验收问题清单

### 3.1 🔴-1 elicitation 终态写入面无租户过滤、无终态守卫：越权写 + accepted→expired 覆盖竞态

- **问题描述**：`servers/agent-api/src/services/todo-service.ts:180-188` 新增的 `markElicitationResolved(requestId, resolution)` 仅以 `{ 'elicitationData.requestId': requestId }` 做 `updateOne`，**不含 userId 过滤、不含 `resolution: null` 终态守卫**。两条调用路径均受影响：
  1. **越权写**：`graphql/resolvers/todo.ts:77-83` 的 `respondElicitation` mutation 只取 `args.requestId` 直写上述 update（另写 `isRead: true`）；`services/elicitation-subscriber.ts:120-122` 完全忽略 payload 中的 `data.userId`（controller-api `elicitation-manager.ts:139-152` 明明已透传 `userId: socket.data.userId`）。任何已登录/已认证侧持有他人 `requestId` 即可把他人问询待办写成任意终态并标已读，用户问询被静默吞掉。
  2. **终态覆盖（真实竞态）**：`controller-api/src/services/elicitation-manager.ts` `handleTimeout` 无条件 publish `resolved(timeout)`。用户恰在 60s 边界点击接受 → `respondElicitation` 写入 `accepted` 的同时 timeout 事件已被发布 → subscriber 随后把 `accepted` **覆盖为 `expired` + `isRead:true`**，用户的接受决定被数据层抹除，与 AGENTS.md「用户已响应的情况不走该事件」承诺相反（该承诺只存在于发送侧注释，接收侧无任何强制）。
- **根因分析**：终态写入被实现为「按外部可得 id 的无条件覆盖」，归属校验与终态单调性（accepted/declined/cancelled 不可被 timeout 覆盖）两个不变量均未进入数据层；payload 已携带的 `userId` 在接收端被丢弃，属防御缺失而非能力缺失。
- **修复方案**：
  1. `markElicitationResolved` 增加 `userId` 参数并进入 filter：`{ 'elicitationData.requestId': requestId, userId, resolution: null }`；subscriber 传 `data.userId`，`respondElicitation` 传 `context.currentUser.id`。
  2. 终态单调：对 timeout/自发 resolved 路径仅在 `resolution: null` 时写入（条件更新）；用户响应路径如需覆盖仅允许 null→终态。
  3. 补测试：跨用户 requestId 不命中（modifiedCount=0）、accepted 后迟到 timeout 不覆盖。
- **验证结果**：✅ `todo-service.test.ts` T-TD1/3/4/5/6/7 + `todo.test.ts` T-TR1/2 覆盖跨用户不命中、accepted 后迟到 timeout 不覆盖、缺 userId 拒写、session 兜底；Aspire 实跑 T-AC6/AC7 通过。

### 3.2 🟠-1 T-ES3 名实不符假绿；resolved 事件缺 requestId 时静默丢弃、终态不收敛

- **问题描述**：`servers/agent-api/src/services/elicitation-subscriber.test.ts:168-177` 用例名 `T-ES3: resolved(unsupported_mode) → failed`，断言却是 `expect(todoService.markElicitationResolved).not.toHaveBeenCalled()`（验证「什么都不做」）；`→ failed` 映射实际仅由 T-ES3b（:179-188）覆盖。同时 `elicitation-subscriber.ts:114-127` 对 `requestId` 缺失的事件**无任何兜底**（不按 sessionId 收敛、不告警），而 `controller-api/src/services/socketio.ts:205-218` 的 payload 类型明确允许 `requestId?: string`，bridge 的 `unsupported_mode` 路径（`bridge.ts:737-741`）实际就不带 requestId。
- **根因分析**：用例命名与断言内容脱节（「名字说 A、断言验 B」），按用例名扫描会误判覆盖已存在；接收端把「requestId 可选」的合法 payload 当作可丢弃。
- **修复方案**：重命名/重写 T-ES3 为「缺 requestId 时的兜底行为」并断言兜底结果（failed 映射断言保留在 T-ES3b）；`handleElicitationResolved` 对无 requestId 事件按 `sessionId` 兜底收敛或至少 `console.warn` 可观测告警（二选一需在契约显式声明）。
- **验证结果**：✅ `elicitation-subscriber.test.ts` T-ES2/3/3b/4/5/6 + `bridge.test.ts` T-B3 覆盖；`unsupported_mode` 事件已携带 requestId。

### 3.3 🟠-2 快照 `raw.authMethods` 非「对端声明原文」，契约漂移且保真断言测不到调用点

- **问题描述**：`contracts/agent-session-websocket.md:176` 声明快照 `raw` = 对端声明原文（agentCapabilities / authMethods / clientCapabilities）；但 `bridge.ts:558` `this.authMethods = toAuthMethods(result.authMethods)` 已做形态转换（`type`→`kind` 重命名、`?? null` 补齐、`AuthMethodAgent` 字段丢弃），`bridge.ts:630` 快照 raw 传入的是**转换后产物**，原文不可恢复。`capabilities.test.ts:152-157`（T-C7 保真断言）直接喂 `normalizeCapabilities(fixture.authMethods)`，纯函数保真恒绿，**测不到调用点失真**。
- **根因分析**：归一化入参与「原文留存」两个职责共用同一字段，转换发生于留存之前。
- **修复方案**：initConnection 保留 `result.authMethods` 原文（`authMethodsRaw`）供快照 raw 使用；补一条穿过 `buildInitializedPayload()` 的断言 raw.authMethods 与 SDK 原始返回深相等的测试。
- **验证结果**：✅ `bridge.test.ts` T-B6 断言 `raw.authMethods` 与 initialize 原文深相等且不同于归一化产物。

### 3.4 🟠-3 `stop()`/`handleError()` 不清理 pending Maps：65s timer 泄漏 + 迟到 `resolved(timeout)` 事件

- **问题描述**：`bridge.ts:349-366` `stop()` 只清 `activePrompt/inputQueue/spawner`，`pendingElicitations`/`pendingPermissions` 两个 Map 与其中 65s `setTimeout` 均未触碰；`handleError()`（进程崩溃路径，:859）同样不清理。用户在弹窗打开后关闭会话 → 65 秒后对已终止会话发出 `acp:elicitation:resolved{reason:'timeout'}`（bridge.ts:756-761 为本次 diff 新增的对外事件），服务端把待办标 `expired`（用户视角：已关闭会话却被记「超时未响应」）；未 `unref()` 的 timer 最长拖住进程事件循环 65s。
- **根因分析**：生命周期清理清单未随新增 pending Map/对外事件同步扩展。
- **修复方案**：`stop()`/`handleError()`/`emitStopped()` 遍历两 Map：`clearTimeout` + `resolve({action:'cancel'})` + delete；若需给待办收口改发 `reason:'cancelled'`（与 🟠-4 一并处理）；补测试覆盖 stop 后 65s 不再发事件。
- **验证结果**：✅ `bridge.test.ts` T-B5c/T-B5d 断言 stop 后 pending 收敛为 cancelled，65s 后无迟到事件。

### 3.5 🟠-4 契约枚举 `reason:'cancelled'` 零产生路径；`elicitation/complete` 不 settle pending，待办悬挂误标 expired

- **问题描述**：契约 §2.34 声明 `reason: "unsupported_mode" | "timeout" | "cancelled"` 并要求 agent-api 据此标记 failed/expired/cancelled；但 bridge 全文 `acp:elicitation:resolved` 仅两处发出（reason 只有 `unsupported_mode`/`timeout`），`'cancelled'` **零产生点**。对应入口 `unstable_completeElicitation`（`bridge.ts:813-818`）只转发 `acp:elicitation:complete`，不 settle `pendingElicitations`、不发 resolved → Agent 自行完成/取消的问询 pending Promise 悬挂至 65s 超时，被误标 `expired` 而非 `cancelled`。
- **根因分析**：契约先于实现声明了三值枚举，实现未补齐产生路径；complete 与 resolved 双通道的收敛语义未定义。
- **修复方案**：`unstable_completeElicitation` 中 delete+clearTimeout+resolve 并发 `resolved{reason:'cancelled'}`；或明确 complete 为独立收敛通道并从契约删除 `cancelled` 枚举（需同步 agent-api 映射文档）。
- **验证结果**：✅ `bridge.test.ts` T-B5e 断言 Agent complete 收敛 pending 并发 `resolved(cancelled)`。

### 3.6 🟠-5 ElicitationDialog `now` 冻结于挂载时刻，挂载后到期的问询不再进入「已过期」终态

- **问题描述**：`apps/agent-web/src/components/ElicitationDialog.tsx:85` `const [now] = useState(() => Date.now())`，`useState` 初始化器只执行一次；`:87-88` 的 `isExpired` 判定依赖该冻结值。`PendingElicitationBanner.tsx:44-52` 在 pending 存在期间**常驻挂载** Dialog（`open` 仅显隐），`now` 即 Banner 挂载时刻。问询 10:00 创建、10:05 到期、TTL 未清理的窄窗口内用户 10:06 点开 → `expiresAt(10:05) <= now(10:00:05)` 为 false → 弹窗仍显示「提交/拒绝」且可对已过期问询提交。测试 T-W15b 每次全新 `render`（now 必大于 expiresAt）恒绿，掩盖「同一实例跨过 expiresAt」场景。
- **根因分析**：把「当前时间」当作不随渲染更新的快照；测试只覆盖单时刻渲染。
- **修复方案**：改为 render 期取值 `const now = Date.now()`（随 15s 轮询重渲染刷新）或定时器在 expiresAt 触发重渲染；补 fake timers 推进时间的用例。
- **验证结果**：✅ `ElicitationDialog.test.tsx` T-W15c 用 fake timers 跨过 expiresAt，弹窗立即显示已过期且隐藏提交。

### 3.7 🟠-6 PendingElicitationBanner 早退卸载已打开弹窗（表单丢失）；与 TodoListPanel 自动弹窗无互斥（双弹窗/双回传）

- **问题描述**：
  1. `PendingElicitationBanner.tsx:28` `if (pending.length === 0) return null`——用户正在弹窗中填表时轮询返回该 todo 已带 `resolution`（如 TTL 标 `expired`），组件整体早退 → **已打开的弹窗连同已填表单瞬间卸载**，无任何终态提示。这与 `TodoListPanel.tsx:25-30` 注释明示的设计（弹窗保留并随数据收敛展示终态）互相矛盾。
  2. Banner 自持 `open` 状态与 `TodoListPanel.tsx:28-42` 的自动弹窗（互斥仅限其自身两状态）零协调：桌面端 `priority=immediate` 问询可被 TodoListPanel 自动弹出，用户再点 Banner「查看」→ 第二个 `ElicitationDialog` 叠加，同一 `requestId` 双入口各自可提交/拒绝，产生重复回传或 UI 状态错乱。
- **根因分析**：「入口显隐」与「弹窗生命周期」耦合在同一早退分支；弹窗打开权未提升为共享状态。
- **修复方案**：入口按 `pending` 过滤、弹窗数据按 todo id 从全量 `todos` 派生（不过滤 resolution），已打开弹窗不随 pending 清空而卸载；「当前打开的问询 todo id」提升至共享 store，Banner 与 TodoListPanel 双入口读写同一状态。
- **验证结果**：✅ `PendingElicitationBanner.test.tsx` T-W14b（pending 清空仍保留终态弹窗）/ T-W14c（共享打开权单弹窗）；E2E T-E38/E39 实跑。

### 3.8 🟠-7 T-E31 / T-E36 文档与用例标题声称远大于实际断言（声称已测但实际未测）

- **问题描述**：
  - `tests/e2e/AGENTS.md:255`（T-E31「能力面板」）声称「**20 项状态、detail** 与 Agent 版本可见」，`session-capabilities.spec.ts:175-191` 实际仅断言 dialog 可见、Agent 版本文本、**单行** `agent-capability-row-session.load` 与 3 个状态 testid——20 项计数与 detail 展示零断言（面板只渲染 5 行/丢失 detail 列，用例照样绿）。
  - `tests/e2e/AGENTS.md:260`（T-E36「模型来源分组」）声称「四个组头、**固定顺序**、组头含判定依据」，`spec.ts:254-293` 对顺序**零断言**，且 `:286` `expect(getByTestId('model-group-平台内置')).toContainText('平台内置')` 断言「组头包含自己的组名」近恒真。
- **根因分析**：用例台账先行、断言落地缩水，台账未随实现回改；恒真断言未在自查中识别。与既往多轮「文档声称 vs 实测覆盖不符」同型。
- **修复方案**：T-E31 断言 `agent-capability-row-*` 计数 = 20 并至少断言一行 detail 文本；T-E36 按 `[data-testid^="model-group-"]` DOM 顺序断言四组固定顺序、删除 :286 恒真断言；或如实收缩 AGENTS.md 台账措辞。
- **验证结果**：✅ E2E T-E31/T-E36 实跑通过（20 行 + detail、四组 DOM 顺序）。

### 3.9 🟠-8 模型来源分组唯一验收（T-AC5 / T-E36）挂 `MONGODB_URI` 静默 skip，存在按运行口径零覆盖假绿风险

- **问题描述**：`tests/api/src/agent-api/session-capabilities.test.ts:367` `describe.skipIf(!MONGODB_URI)`、`tests/e2e/src/session-capabilities.spec.ts:255` `test.skip(!MONGODB_URI, ...)`——环境缺失即静默 skip（不报错）。T-AC5 是「平台内置/自定义/Agent 自带/来源未知四组 + basis」唯一的 API 级断言，T-AC5/T-E36 是模型来源三档分组仅有的集成级/E2E 验收。
- **根因分析**：条件跳过把「环境缺失」静默转化为「已通过」，与历史 `billing-events.test.ts` 因缺 `INTERNAL_API_TOKEN` 永久 skip 的假绿同型；运行口径文档未强制注入 `MONGODB_URI`。
- **修复方案**：tests/api、tests/e2e 的 AGENTS.md 运行口径显式要求注入 `MONGODB_URI` 并在验收报告登记实跑（非 skip）证据；或缺变量时显式 fail/告警，不允许静默跳过。
- **验证结果**：✅ T-AC5 在 `MONGODB_URI` 注入下实跑（非 skip），7 passed；缺失时显式失败。

### 3.10 🟡 建议项（15 项，随修复收口）

| # | 问题 | 位置 |
|---|---|---|
| 1 | `markElicitationResolved` 查询 `elicitationData.requestId` 无配套索引（COLLSCAN 风险）；`todo-service.test.ts` 无「终态覆盖/跨用户」用例 | `servers/agent-api/src/models/todo-item.ts`、`services/todo-service.ts` |
| 2 | `acp:elicitation:resolved` 入参与 `reason` 无运行时校验，未知 reason 归并为 `cancelled`；`detail` 无长度限制原样进 Redis | `servers/controller-api/src/services/socketio.ts:205-218`、`elicitation-subscriber.ts:114-117` |
| 3 | `agentCapabilities` 以 `Mixed` 原样落库、`raw: JSON` 原样外露，无结构/体积上限 | `controller-api/src/services/acp-session-manager.ts:149-152`、`agent-api/src/graphql/schemas/session.ts` |
| 4 | `inferModelSource` 以展示名（name）优先匹配平台库，同名碰撞/空名条目误归属 | `servers/agent-api/src/services/model-source.ts:49-52` |
| 5 | bridge `detail: String(mode)` Agent 可控字符串直入事件与展示，无截断 | `packages/agent-controller/src/acp/bridge.ts:735-741` |
| 6 | 快照 `raw` 无体积上限（`_meta` 任意 KV），可放大 WS/Mongo 写入 | `packages/agent-controller/src/acp/capabilities.ts:247-251` |
| 7 | T-B5 不推进 65s 时钟，锁不住 `clearTimeout` 回归 | `packages/agent-controller/src/acp/bridge.test.ts:629-647` |
| 8 | `CLIENT_CAPABILITIES` 断言自引用恒真（常量改 `{}` 测试仍绿） | `packages/agent-controller/tests/acp-sync-bridge.test.ts:69`、`src/acp/bridge.test.ts:517-518` |
| 9 | `elicitation.url` 分支零测试覆盖（payload 组装无断言） | `packages/agent-controller/src/acp/bridge.ts:776-786` |
| 10 | `vitest.config.ts` `exclude` 覆盖默认值，丢默认排除项 | `packages/agent-controller/vitest.config.ts:7-9` |
| 11 | `prober.ts` `capabilities` 类型必填但运行时可 undefined | `packages/agent-controller/src/acp/prober.ts:12,61` |
| 12 | T-AC1/T-AC3 台账声称「原文 / 其余字段不变」，断言未覆盖（raw 未查询） | `tests/api/src/agent-api/session-capabilities.test.ts:218-230,265-275` |
| 13 | T-ARC1 `toBeGreaterThanOrEqual(20)` 放宽契约「20 项」；T-ARC2 名实不符；T-AC6 `toBeDefined` 对 `null` 恒过；T-AC2 冗余断言 | `tests/api/src/controller-api/acp-real-capabilities.test.ts:221,229-245`、`session-capabilities.test.ts:304` |
| 14 | FeatureId 清单在两份测试手抄复制，与「唯一事实源」声明冲突；E2E `setupSession` 有 `acp:start` 事件早于 sessionId 赋值的竞态（假红 flaky）；`acp-real-capabilities.test.ts:106` 残留 `console.log` | `tests/**` |
| 15 | 前端小项：`AgentCapabilityPanel` 与 `useAgentCapabilities` 取数路径不一致（`features ?? []` 空数组不穿透、门控可被数据形态绕过）；ModelSelectDialog T-W6 用 `indexOf` 子串定位有撞名风险；`mergeModelSources` 死返回值；i18n 中英混排、Banner 无 `aria-live`；`TodoListPanel.tsx:94` exhaustive-deps 告警 | `apps/agent-web/**` |

## 3.11 二轮返工修复记录（逐项可证伪）

> 每项均先落测试再改实现；测试名同时登记在对应包内，修复前可红。

| # | 修复内容 | 关键落点 | 可证伪回归测试 |
|---|---|---|---|
| 🔴-1 | `markElicitationResolved` filter 强制 `userId` + `resolution: null`；缺 `userId` 直接拒绝；`markTodoAsResponded`/`markElicitationCompleted` 同样加归属；`todoitems.elicitationData.requestId` 建索引 | `todo-service.ts`、`todo.ts`、`models/todo-item.ts` | `todo-service.test.ts` T-TD1/3/4/5/6/7、`todo.test.ts` T-TR1/2 |
| 🟠-1 | subscriber 运行时 reason 白名单（未知→failed+告警）、缺 `userId` 拒写、缺 `requestId` 按 `sessionId` 兜底；bridge `unsupported_mode` 也携带 `requestId` | `elicitation-subscriber.ts`、`bridge.ts` | `elicitation-subscriber.test.ts` T-ES2/3/3b/4/5/6、`bridge.test.ts` T-B3 |
| 🟠-2 | `initConnection` 留存 `authMethodsRaw`，快照 `raw.authMethods` 用原文；测试穿过 `start()`/`buildInitializedPayload()` 调用点 | `bridge.ts` | `bridge.test.ts` T-B6 |
| 🟠-3 | `stop()`/`handleError()` 统一 `settlePendingRequests`：clearTimeout + resolve(cancel) + delete，问询补发 `resolved(cancelled)`；`emitStopped` 清 text timer | `bridge.ts` | `bridge.test.ts` T-B5c/T-B5d |
| 🟠-4 | Agent `unstable_completeElicitation` 按 `elicitationId` 定位 pending 就地收敛并发 `resolved(cancelled)`；补齐契约产生路径 | `bridge.ts`、contract | `bridge.test.ts` T-B5e |
| 🟠-5 | `ElicitationDialog` 当前时间入 state + 到期定时器 + props 变化刷新，挂载后跨过 `expiresAt` 立即过期 | `ElicitationDialog.tsx` | `ElicitationDialog.test.tsx` T-W15c（fake timers 推进） |
| 🟠-6 | 新增 `stores/elicitationDialog.ts`（todoId+owner 共享打开权）；Banner 不再早退卸载弹窗，弹窗按 id 从全量 todos 派生；TodoListPanel 与 Banner 互斥 | `stores/elicitationDialog.ts`、`PendingElicitationBanner.tsx`、`TodoListPanel.tsx` | `PendingElicitationBanner.test.tsx` T-W14b/T-W14c |
| 🟠-7 | T-E31 断言 20 行 + detail 文本；T-E36 断言 `model-group-*` DOM 固定顺序、删除恒真断言 | `tests/e2e/src/session-capabilities.spec.ts` | E2E T-E31/T-E36 实跑 |
| 🟠-8 | T-AC5/T-E36 删除静默 skip，缺 `MONGODB_URI` 显式失败；文档运行口径同步 | tests/api、tests/e2e、AGENTS.md | Aspire 实跑 T-AC5 非 skip（7 passed） |
| 🟡-1 | 终态索引（见 🔴-1） | `models/todo-item.ts` | — |
| 🟡-2 | controller-api 运行时校验 reason/sessionId、requestId/detail 截断 200 | `elicitation-manager.ts` | `elicitation-manager.test.ts` T-S6b/6c/6d |
| 🟡-3 | controller 落库 64 KiB 上限，保留 features 仅截断 raw | `acp-session-manager.ts` | `acp-session-manager.test.ts` T-S1b |
| 🟡-4 | 模型来源改按 `id` 判定（不再用展示名），空名条目跳过 | `model-source.ts` | `model-source.test.ts` T-MS8/T-MS9 |
| 🟡-5 | `unsupported_mode.detail` 截断 100 | `bridge.ts` | `bridge.test.ts` T-B3b |
| 🟡-6 | 快照 raw 单份 16 KiB 上限 + 截断摘要 | `capabilities.ts` | `capabilities.test.ts` T-C9 |
| 🟡-7 | T-B5 响应后推进 65s，锁 `clearTimeout` 回归 | `bridge.test.ts` | T-B5 |
| 🟡-8 | CLIENT_CAPABILITIES 断言改显式字面量（去掉自引用） | `bridge.test.ts`、`capabilities.test.ts`、`acp-sync-bridge.test.ts` | 上述用例 |
| 🟡-9 | url 模式 payload 零覆盖补齐 | `bridge.test.ts` | T-B5b |
| 🟡-10 | `vitest.config` 用 `configDefaults.exclude` + dist，保留默认排除 | `vitest.config.ts` | 全量单测 |
| 🟡-11 | prober `capabilities` 改可选并在缺省时不写入 | `prober.ts` | tsc/单测 |
| 🟡-12 | T-AC1 增查 `raw` 深相等；T-AC3 补 status/id | `session-capabilities.test.ts` | Aspire 实跑 |
| 🟡-13 | T-ARC1 改定长 20；T-ARC2 逐项精确断言；删除 T-AC2 冗余断言；T-AC6 `not.toBeNull` | tests/api | `test:real`/常规实跑 |
| 🟡-14 | 测试直接引用 `capabilities.ts` 的 FEATURE_IDS；`setupSession` 先等 sessionId 再回包；移除 console.log | tests/** | E2E T-E31/T-E37 实跑 |
| 🟡-15 | 面板与门控共用 `useAgentCapabilities`（hasSnapshot 以 agentCapabilities 为准）；T-W6 改 DOM 顺序断言；`mergeModelSources` 去掉死返回；Banner 加 `aria-live`；TodoListPanel exhaustive-deps 告警消除 | `apps/agent-web/**` | `AgentCapabilityPanel.test.tsx`、`ModelSelectDialog.test.tsx`、eslint 6 warning（全存量） |

## 四、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 🔴-1 | elicitation 终态写入无租户过滤/无终态守卫 | 归属校验与终态单调性未进数据层 | ✅ 已修复 | 3f30ecf |
| 🟠-1 | T-ES3 名实不符 + 无 requestId 静默丢弃 | 用例命名与断言脱节；合法可选 payload 无兜底 | ✅ 已修复 | 3f30ecf |
| 🟠-2 | `raw.authMethods` 非原文 | 转换与留存共用字段 | ✅ 已修复 | 3f30ecf |
| 🟠-3 | `stop()` 后 timer 泄漏/迟到 timeout 事件 | 生命周期清理清单未扩展 | ✅ 已修复 | 3f30ecf |
| 🟠-4 | `reason:'cancelled'` 死契约、待办悬挂误标 | 双通道收敛语义未定义 | ✅ 已修复 | 3f30ecf |
| 🟠-5 | ElicitationDialog `now` 冻结 | 当前时间被当快照 | ✅ 已修复 | 3f30ecf |
| 🟠-6 | Banner 卸载弹窗 + 双弹窗双回传 | 弹窗打开权未共享 | ✅ 已修复 | 3f30ecf |
| 🟠-7 | T-E31/T-E36 声称大于断言 | 台账与断言脱节 | ✅ 已修复 | 3f30ecf |
| 🟠-8 | 模型来源分组验收静默 skip | 环境缺失被静默当通过 | ✅ 已修复 | 3f30ecf |
| 🟡×15 | §3.10 | — | ✅ 随修复收口（逐项见 §3.11） | 3f30ecf |
| 合并冲突 | PR #250 CONFLICTING（3 文件） | main/release 分叉改同一批 session 文件 | ✅ 已按并集解决（`merge release`） | 3f30ecf |
| 🟠-9 | billing-events / billing-gateway 同型静默 skip | 缺 MONGODB_URI 被静默当通过 | ✅ 三轮修复（缺参即 fail，实跑 3+6 passed 0 skip，见 §8.1 A-2） | 04cdc21 |

> 说明：本节 🟠-8 行原仅覆盖 T-AC5/T-E36；首轮同时点名的「billing-events 同型」对应 🟠-9，已于三轮返工按同标准治理（§8.1 A-2），避免「声称大于实际」再次复发。

## 五、最终验证

| 项目 | 首轮 | 二轮返工（本轮实跑） |
|---|---|---|
| tsc（agent-controller / agent-api / controller-api / agent-web） | ✅ 全 0 | ✅ 全 0（agent-web `tsc -b`） |
| 单测 | ✅ 合计 1869 passed（389 + 732 + 223 + 525） | ✅ 合计 **1953 passed**（agent-controller 411 / agent-api 767 / controller-api 227 / agent-web 548） |
| eslint（agent-web） | ✅ 0 error / 7 warning | ✅ 0 error / 6 warning（均为存量，本 diff 新增告警已消除） |
| tests/api（实机） | ⏸️ 未跑 | ✅ Aspire 全栈实跑 `session-capabilities.test.ts` **7 passed**（注入 `MONGODB_URI`，T-AC5 **非 skip**；含 T-AC1 raw 深相等、T-AC6/AC7 终态） |
| tests/e2e | ⏸️ 未跑 | ✅ Aspire 全栈实跑 `session-capabilities.spec.ts` **9 passed**（T-E31 20 行+detail、T-E36 顺序断言、T-E38 过期收敛）+ `permission.spec.ts` **10 passed**（TodoListPanel 改动回归） |
| 合并预检 | ❌ CONFLICTING（3 文件） | ✅ 已 `merge origin/release` 按并集解决（`session.ts` import 并集 + Session 字段合并、`session.test.ts` 双测试套件保留、`socketio-client.test.ts` 双套件保留），解决后 agent-api 758、agent-controller 404 单测通过，PR 转 CLEAN |

## 六、经验总结

1. **终态写入面必须带归属与单调性两个不变量**：任何「按外部 id 直写终态」的新路径都要在数据层强制 `userId` + `resolution: null` 条件，否则越权与覆盖竞态必然出现。
2. **契约枚举先于实现声明即为债务**：`cancelled` 这类「声明了但零产生点」的枚举，要么补齐产生路径，要么删除，不允许留死契约。
3. **保真断言要穿过调用点**：纯函数层的深相等保真测试测不到调用点已做转换（T-C7 假绿盲区），raw/原文类断言必须穿过组装函数。
4. **用例名与台账是验收证据的一部分**：「名字说 A、断言验 B」与「台账声称大于断言」连续多轮复发，建议在自查清单中固定「用例名 ↔ 断言 ↔ 台账」三方一致性检查。
5. **条件 skip = 潜在假绿**：环境依赖用例必须显式登记实跑证据或缺参即 fail，禁止静默跳过当通过。
6. **常驻挂载组件的时间判定**不能用 `useState` 快照，弹窗生命周期与入口显隐必须解耦。

## 七、二轮 AI Review 复核（2026-10-21）：结论 REJECT（二次打回）

### 7.1 复核方法与独立验证（不采信自报，全部本机实跑）

4 域并行深度复核（① agent-api 后端；② agent-controller + controller-api；③ agent-web 前端；④ 测试与契约）+ 关键结论人工逐条复核与反证。独立验证结果：

| 项目 | 二轮复核实跑 | 与返工声称对比 |
|---|---|---|
| tsc ×4（agent-controller / agent-api / controller-api / agent-web） | ✅ 全 0 | 一致 |
| 单测 | ✅ **1953 passed**（411 / 767 / 227 / 548） | 一致 |
| eslint agent-web | ✅ 0 error / 6 warning | 一致，且「6 均存量」**经反证成立**（见 7.4） |
| tests/api（Aspire 全栈 + MONGODB_URI） | ✅ `session-capabilities` + `elicitation` **13 passed / 0 skip**（T-AC5 非 skip） | 一致 |
| tests/e2e（Aspire 全栈） | ✅ `session-capabilities` 9 + `permission` 10 = **19 passed / 0 skip** | 一致 |
| PR #250 | ✅ MERGEABLE / CLEAN，15 commits，head `e966c9e` | 一致 |
| 合并预检 `git merge-tree`（integration vs 最新 release `cb369eb`） | ✅ 0 冲突 | 一致 |
| 467337e 冲突并集核对 | ✅ `session.test.ts` / `socketio-client.test.ts` 两侧测试套件均保留、实跑通过，无静默丢弃 | 一致 |

**关键事实**：返工提交（`467337e` + `3f30ecf` + `e966c9e`）所声称的修复内容与 diff 实际一致，无「声称改了但没改」；所有首轮 🔴/🟠 的核心修复均有可证伪回归测试（T-TD1/T-TD4/T-TD5 断言完整 filter、T-ES3 断言兜底调用、T-B5c/T-B5e 推进 65s 负断言、T-B6 穿过调用点断言 raw 原文、T-W15c/T-W14b/T-W14c 经「回灌旧代码即红」反证实证、T-E31/T-E36 计数+顺序断言、T-AC5/T-E36 缺参即 fail）。**打回不针对返工诚意与主体质量，而针对下列残余与新问题。**

### 7.2 首轮问题逐项复核结论

| 首轮编号 | 问题 | 二轮结论 | 证据摘要 |
|---|---|---|---|
| 🔴-1 | elicitation 终态写入无租户过滤/终态守卫 | ✅ FIXED（留 N5/N6 加固缺口，见 7.3） | `todo-service.ts:204-216` filter 强制 `userId` + `resolution:null`、缺 userId 拒写；`todo-item.ts:48` requestId 索引；T-TD1/T-TD4/T-TD5 可证伪 |
| 🟠-2 | T-ES3 名实不符 + resolved 缺 requestId 静默丢弃 | ✅ FIXED | `elicitation-subscriber.ts:148-157` sessionId 兜底 + 双缺告警；T-ES3 更名后名实一致；bridge `unsupported_mode` 先分配 requestId（`bridge.ts:764-780`） |
| 🟠-3 | raw.authMethods 非原文契约漂移 | ✅ FIXED | `bridge.ts:588-590/661-663` `authMethodsRaw` 原文入快照；T-B6 穿 `start()→buildInitializedPayload` 可证伪；契约 :176 与实现一致 |
| 🟠-4 | stop()/handleError() 不清 pending 致 timer 泄漏/迟到 timeout | ⚠️ PARTIAL | 指定两路径已修（`bridge.ts:368-396/927-929`，T-B5c 可证伪）；但**进程崩溃 / `acp:reconcile` 杀会话 / socket 断线**三条旁路不收敛（N1） |
| 🟠-5 | reason:'cancelled' 死契约、complete 不 settle | ✅ FIXED | `bridge.ts:856-878` 就地 settle + 发 `resolved{cancelled}`，`stop()` 为第二产生点；T-B5e 可证伪；契约 :865-867 同步 |
| 🟠-6 | ElicitationDialog `now` 冻结致过期判定失效 | ✅ FIXED | `ElicitationDialog.tsx:85-95` 到期 setTimeout + 依赖重取时、cleanup 到位；到期后提交按钮移除；T-W15c 反证实证（旧代码红） |
| 🟠-7 | Banner 早退卸载弹窗 + 双弹窗双回传 | ⚠️ PARTIAL | 互斥已落地（`stores/elicitationDialog.ts` 单例打开权，T-W14b/T-W14c 反证实证）；但 todo 离开列表（TTL 删档/limit 挤出）时弹窗仍被卸载且无终态收敛（N4-a），store 无卸载对账（N4-b） |
| 🟠-8 | T-E31/T-E36 台账声称大于断言 | ✅ FIXED | `session-capabilities.spec.ts:185-193`（20 行计数+detail）、`:288-299`（四组 DOM 顺序 + basis 断言），恒真断言已删，逐项「改坏即红」核对 |
| 🟠-9 | MONGODB_URI 静默 skip（含 billing-events 同型） | ⚠️ PARTIAL | T-AC5/T-E36 已缺参即 fail（:365-369 / :260-261）；但 **billing-events T-CC-B11、billing-gateway T-B27/T-B28 同型未治理**（N2），首轮明确点名的「billing-events 同型」零改动 |
| 🟡×15 | §3.10 建议项 | ✅ 大部收口 | 15 项中约 11 项真实收口；残余见 7.5 |

### 7.3 二轮问题清单（打回依据）

**【A. 首轮 🟠 残余（2 项）】**

1. **🟠（残余-7）弹窗卸载无终态收敛口子未封死**：`PendingElicitationBanner.tsx:35` / `TodoListPanel.tsx:59` 均 `todos.find(...) ?? null`，todo 离开列表（`todo-item.ts:49` TTL 到点删档、`todo-service.ts:145-146` limit(100) 挤出）时弹窗连同表单被卸载、无任何终态提示（/tmp 反证实证 `dialogStillThere=false, statusShown=false`）。「弹窗保留到出现终态」的修复承诺被打破。
2. **🟠（残余-9）同型静默 skip 未治理 + 台账声称大于实际**：`tests/api/src/cloud-controller/billing-events.test.ts:67`（T-CC-B11 为 billingoutbox 落库唯一集成验收）、`tests/api/src/admin-api/billing-gateway.test.ts:76,226`（T-B27/T-B28 为计费过滤唯一集成验收）仍 `describe.skipIf(!MONGODB_URI)`，缺参零覆盖假绿；而报告 §四 将 🟠-8/🟠-9 标「✅ 已修复」——首轮打回的原始病灶「声称大于实际」自身复发。

**【B. 返工新引入/新暴露 🟠（6 项）】**

3. **🟠-N1 bridge 收敛缺口，返工声称不变量存在可复现反例**：`bridge.ts` 无 `spawner.closed`/exit 订阅（注释却称「进程崩溃同样必须收敛 pending」），`socketio-client.ts:1302-1326` `acp:reconcile` 杀会话 `process.kill` + `acpBridges.delete` 不调 `bridge.stop()`，`socketio-client.ts:1373-1379` disconnect 仅清回包桥不停 bridge——Agent 崩溃/被对账终止/断线后 65s 仍迟到发 `acp:elicitation:resolved{timeout}`，直接反证 AGENTS.md「会话关闭后不得再出现 65s 迟到的 timeout 事件」。
4. **🟠-N2 controller-api 校验 fail-open**：`elicitation-manager.ts:165-172` `JSON.stringify({ ...data, ... })` 展开使**非字符串 `detail`（对象/数组）与任意未知字段绕过 200 字符截断直入 Redis**，`sessionId` 无长度上限；与「requestId/detail 截断到 200 后才入 Redis（controller payload 不可信）」声称不符。测试仅覆盖字符串场景。
5. **🟠-N3 socketio-client 请求级 Map 泄漏**：`elicitationRequestBridge`/`permissionRequestBridge`（`socketio-client.ts:723-728/824-828`）仅在用户回包或断开时删键，65s 超时、`stop()` settle、complete settle 均不删——请求级 Map 单调增长，已 stop 的 bridge 被引用无法 GC。
6. **🟠-N4 前端 elicitationDialog store 状态机缺陷**：store（`stores/elicitationDialog.ts:37-44`）无卸载/失联对账（全仓无 unmount cleanup），弹窗被卸载或 Banner 随会话切换卸载后 `{todoId, owner}` 残留：① `TodoListPanel.tsx:64` 因残留 id 永久跳过后续 immediate 问询的自动弹窗（问询 65s 超时，错过即失效）；② `active` 派生不校验 sessionId（`PendingElicitationBanner.tsx:34-36` 只按 id 查全量 todos）→ 切换会话后他 session 的问询弹窗幻影重开。
7. **🟠-N5 agent-api 归属守卫不一致（🔴-1 声称不变量的执行缺口）**：`markElicitationCompleted`（`todo-service.ts:180-186`）/`markTodoAsResponded`（:169-178）无「缺 userId 拒写」运行时守卫，且 Mongoose 9 会把 `undefined` filter 键整体剥离（`Query.cast()` 实测证实）——userId 缺失时归属条件**静默退化**为「匹配任意租户同 elicitationId」而非安全空操作，与 `markElicitationResolved` 的显式拒写（:204）不一致。当前唯一发布方恒注入 userId，现实可利用性低，但不变量必须在数据层闭合。
8. **🟠-N6 respond 路径无归属前置校验**：`graphql/resolvers/todo.ts:49-55/68-75` `respondPermission`/`respondElicitation` **先 publish 响应、后写待办，全程不校验待办归属**，恒返回 `true`——持他人 requestId 即可代他人应答（如代接受权限请求→Agent 执行命令）。防护完全依赖 requestId 熵（≈50bit 随机，无枚举面），属「靠 id 不可猜」而非授权校验；🔴-1 只封了写、未封动作。

### 7.4 反证记录（人工复核排除的疑点）

| 疑点 | 复核结论 |
|---|---|
| 前端域上报「报告称 6 warning 均存量失实，TodoListPanel exhaustive-deps 为本 diff 告警」 | **排除**：将 `origin/release` 版 `TodoListPanel.tsx` 原样跑 eslint，同样触发 `todos` exhaustive-deps 告警（release :34:9 ↔ 当前 :47:9，同一规则同一变量同一 hook，仅行号平移）——「6 均存量」声称成立，该条指控不采纳 |
| agent-api 域疑点「`resolution: null` 过滤语义是否含字段不存在」 | **确认为正确语义**：`resolution` 无 default，pending 文档字段缺失，`Query.cast()` 实测 filter 原样下推，终态单调成立 |
| 各域上报弱断言是否构成假绿 | T-TD3/T-TD4/T-MS9/T-B5d 的 mock 恒真部分属实但均有可证伪的 filter/负断言接力，不构成假绿；已列 🟡 随修复加固 |

### 7.5 🟡 随修复收口（节选，共 18 项登记于各域清单）

sessionId 兜底 `updateOne` 无排序（多 pending 时误收敛其一，应 `updateMany`/消歧）、requestId 索引无迁移兜底、T-TD3/T-TD4/T-MS9/T-B5d 弱断言加固、T-W4 名实不符（声称固定顺序未断言顺序）、T-W14c 补单回传计数、前端 `FEATURE_ORDER`/`FEATURE_LABELS` 手抄 20 个 FeatureId（应引唯一事实源并补 ID 集合一致性断言）、`tests/api/vitest.config.ts` exclude 覆盖默认排除、契约补录（64KiB 落库截断形态、settle 路径 `cancelled` 产生条件与 detail、16KiB 为 UTF-8 字节口径）、preview 按字符切可碎 surrogate pair、ElicitationDialog 到期 +50ms 窗口与 `handleRespond` 无 `isClosed` 守卫、`close()` 无 owner 守卫、owner 切换丢表单已填值、aria-live 挂载即插不播报、`tests/api/AGENTS.md` 数字漂移（24/5 ↔ 33/6）、console.log 残留（`mcp.test.ts` 等）、subscriber 错误路径日志脱敏、`updated===0` 告警文案漏「不存在/TTL 清理」、T-E36 补组内 model→组归属断言、createSession 异常时 handler 悬挂 90s、controller-api 重复 requestId 覆盖旧 timer 泄漏、controller 断线不清理 manager pending、`stop()` 5s race timer 不清理、`handleElicitationRequest` 对 message/requestedSchema/url 无校验。

### 7.6 修复要求（三轮复核入口条件）

1. 7.3-A 两项 🟠 残余 + 7.3-B 六项新 🟠 **全部修复**，每项须有**可证伪回归测试**（能红于修复前）；N1 须覆盖「Agent 进程崩溃 / reconcile 杀会话 / socket 断线」三路径不发迟到 timeout；N2 须补非字符串 detail 与未知字段用例；N5/N6 须补跨租户拒写/拒答回归。
2. **台账一致性自查**：报告与各 AGENTS.md 中所有「已修复/不得出现」类断言逐一对照实现，消除声称大于实际（本轮已复发一次）；billing-events/billing-gateway 按 T-AC5 同标准改为缺参即 fail（或显式登记实跑证据并降级标注）。
3. 7.5 🟡 一次性批量收口（至少前端 FeatureId 唯一事实源、vitest exclude、契约补录、T-W4 顺序断言四项）。
4. 修复后重跑：tsc ×4、四包单测、tests/api（含 billing-events/billing-gateway 注入 MONGODB_URI 实跑）、tests/e2e，随修复说明登记实跑证据，重提**三轮 AI Review**。

### 7.7 判定

按验收红线「🔴/🟠 → 打回返工」：**REJECT（二次打回）**，返工目标节点「修复Review意见」。主体修复质量与测试可证伪性较首轮显著提升（1953 单测/13 API/19 E2E 全部独立复现、冲突并集干净、PR CLEAN），收口上述 8 项 🟠 与台账一致性后可快速三轮复核。

## 八、三轮返工修复记录（2026-10-21，对应 7.3 A+B 共 8 项 🟠）

> 状态：8 项 🟠 全部修复，且每项均有可证伪回归测试；§7.5 指定 🟡 四项 + 多项廉价项一并收口。

### 8.1 A. 首轮残余（2 项）

| # | 修复 | 可证伪测试 |
|---|---|---|
| A-1（残余 🟠-7） | store 增加「打开时 todo 快照 + `stale` 标记」；Banner/TodoList 优先取列表最新数据，todo 被 TTL 删档/limit 挤出时退回快照并由 `ElicitationDialog stale` 展示「该问询已失效（已从待办移除）」，不再卸载表单；`ElicitationDialog` 新增 `isClosed` 提交守卫 | `PendingElicitationBanner.test.tsx` T-W14d（列表清空后状态仍显示）、`ElicitationDialog.test.tsx` T-W18 |
| A-2（残余 🟠-9） | `billing-events.test.ts` T-CC-B11、`billing-gateway.test.ts` T-B24/T-B27/T-B28 移除 `describe.skipIf`，缺 `MONGODB_URI` 显式 `expect(...).toBeTruthy()` 失败；`tests/api/AGENTS.md` 同步口径 | Aspire + MONGODB_URI 实跑：billing-gateway **6 passed / 0 skip**、billing-events **3 passed / 0 skip** |

### 8.2 B. 返工新引入/新暴露（6 项）

| # | 修复 | 可证伪测试 |
|---|---|---|
| B-1（N1 进程崩溃/reconcile/断线） | `bridge` 订阅 `spawner.closed` 收敛 pending；新增 `settlePendingOnDisconnect()`；`socketio-client` 的 `acp:reconcile` 杀会话改走 `bridge.stop()`，`disconnect` 遍历 bridges 调 `settlePendingOnDisconnect()`；`stop()` 的 5s race timer 结束即清理 | `bridge.test.ts` T-B11（进程退出）/T-B11b（断线）推进 65s 负断言；`socketio-client.test.ts` N3-reconcile（断言 `bridge.stop()`）/N3-disconnect（断言 settle 被调用） |
| B-2（N2 校验 fail-open） | `handleElicitationResolved` 按白名单重建 payload：非字符串 `detail`/未知字段丢弃、`sessionId` ≤200、超长截断 200；`handleElicitationRequest` 校验 requestId/sessionId/mode/message，重复 requestId 清旧 timer；`disconnect` 调 `clearForSocket` | `elicitation-manager.test.ts` T-S6e（对象 detail + evil 字段不进 Redis）/T-S6f/T-S8/T-S9/T-S10 |
| B-3（N3 请求级 Map 泄漏） | bridge 在超时/响应/stop/complete/断线收敛时发 `permission:settled` / `elicitation:settled`；socketio-client 订阅并删除 requestId → bridge 映射 | `bridge.test.ts` T-B11c（响应/超时均 settled）、T-B5d（settle 后 65s 不二次 settled） |
| B-4（N4 store 状态机） | `close(owner)` 持有方守卫；Banner/TodoList 卸载 cleanup；Banner 校验快照 `sessionId`（切会话不幻影重开）；todo 缺失标记 stale 后不再阻塞后续 immediate 自动弹窗；表单草稿按 requestId 保留（owner 切换不丢已填值） | `PendingElicitationBanner.test.tsx` T-W14e、`TodoListPanel.test.tsx` N6、`stores/__tests__/elicitationDialog.test.ts`（owner 守卫/快照/切换）、`ElicitationDialog.test.tsx` T-W19（草稿跨挂载） |
| B-5（N5 归属守卫缺口） | `markTodoAsResponded` / `markElicitationCompleted` 缺 `userId` 直接返回 false、不查库（不依赖 Mongoose 剥离 undefined 的隐式行为） | `todo-service.test.ts` T-TD10 |
| B-6（N6 respond 无前置校验） | `respondPermission`/`respondElicitation` 先调 `isRespondableTodo(userId, requestId, type)`（问询含 `resolution:null`），未命中抛错、**不 publish**；新增 `isRespondableTodo` 查询 | `todo.test.ts` T-TR0a（问询跨租户拒答）/T-TR0b（权限跨租户拒答）、`todo-service.test.ts` T-TD8/T-TD9 |

### 8.3 🟡 收口（含指定四项）

| 项 | 修复 |
|---|---|
| 前端 FeatureId 唯一事实源 | 新增 `apps/agent-web/src/constants/agentFeatures.ts` 直接引用 agent-controller `FEATURE_IDS`；`AgentCapabilityPanel` 使用该常量；capabilities 的 16KiB 计数改 `TextEncoder`（去掉 Buffer，前端可安全引入） |
| `tests/api/vitest.config.ts` exclude | 改用 `configDefaults.exclude` + `acp-real-*`，保留默认排除项 |
| 契约补录 | `raw` 16KiB 为 UTF-8 字节口径 + 落库 64KiB 截断形态；`cancelled` 产生条件（complete/stop/error/进程退出/断线/reconcile）与「此后不得迟到 timeout」 |
| T-W4 顺序断言 | `AgentCapabilityPanel.test.tsx` 断言 20 行 DOM 顺序等于唯一事实源，并断言集合大小 20 |
| 其他 | sessionId 兜底改 `updateMany`（T-TD6）；新增迁移 006 显式建 `elicitationData.requestId` 索引（含用例）；T-TD3/T-TD4/T-MS9/T-B5d 断言加固；`close()` owner 守卫；到期守卫去掉 +50ms；`aria-live`+`role=status`+`aria-atomic`；T-E36 补组内归属断言；`tests/api/AGENTS.md` 数字 24/5 → 33/6；controller-api 重复 requestId timer / 断线 pending / stop 5s timer / 入参校验均收口 |

### 8.4 三轮独立实跑证据（本机，Aspire 全栈）

| 项目 | 结果 |
|---|---|
| tsc ×4 | ✅ 全 0 |
| 单测 | ✅ **1979 passed**（agent-controller 416 / agent-api 775 / controller-api 232 / agent-web 556） |
| eslint agent-web | ✅ 0 error / 6 warning（全存量，无新增） |
| tests/api session-capabilities + elicitation | ✅ **13 passed / 0 skip**（MONGODB_URI 注入，T-AC5 非 skip） |
| tests/api billing-gateway | ✅ **6 passed / 0 skip**（MONGODB_URI 注入） |
| tests/api billing-events | ✅ **3 passed / 0 skip**（MONGODB_URI + internal token） |
| tests/e2e session-capabilities + permission | ✅ **19 passed / 0 skip** |
| PR #250 / merge-tree | ✅ 待推送后复核（本地 merge-tree 对最新 release 0 冲突） |
