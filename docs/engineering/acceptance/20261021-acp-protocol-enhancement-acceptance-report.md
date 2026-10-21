---
description: integration→release 集成验收报告（PR #250）——ACP 协议增强（能力快照归一化 / 前端能力门控与能力面板 / 模型来源三档分组 / Elicitation 弹窗链路修复）集成级 AI Review 首轮打回：1 × 🔴（elicitation 终态写入无租户过滤、无终态守卫，越权写 + accepted→expired 覆盖竞态）+ 8 × 🟠（T-ES3 名实不符假绿与无 requestId 静默丢弃、raw.authMethods 契约漂移、stop() 65s timer 泄漏与迟到 timeout 事件、cancelled 死契约致待办悬挂、前端 now 冻结过期判定失效、Banner 早退卸载弹窗与双弹窗双回传、T-E31/T-E36 文档声称大于实际断言、模型来源分组唯一验收挂 MONGODB_URI 静默 skip）+ 15 × 🟡 随修复收口；独立实跑 tsc ×4 全 0、单测合计 1869 passed（agent-controller 389 / agent-api 732 / controller-api 223 / agent-web 525）、eslint 0 error；git merge-tree 合并预检 CONFLICTING（3 文件 add/add 与 import 块冲突）；打回要求修复后重提二轮复核
type: Permanent
---

# integration→release 集成验收报告（2026-10-21，AI Review）

> **状态**: ❌ **首轮 AI Review 打回（REJECT）**——对 PR #250（integration→release，12 提交 / 83 文件 / +6497 −116）做 4 域并行深度代码评审 + 关键结论人工逐条复核，共提出 **1 × 🔴 阻断 + 8 × 🟠 重要 + 15 × 🟡 建议**：🔴 为 elicitation 终态写入面（`markElicitationResolved`）无租户过滤、无终态守卫，可越权改写他人待办且用户已接受的决定可被 timeout 覆盖为 expired；🟠 集中在 elicitation 收敛链路（T-ES3 名实不符假绿、无 requestId 静默丢弃、`reason:'cancelled'` 零产生路径、stop() 后 65s 迟发 timeout 事件）、契约保真（`raw.authMethods` 非原文）、前端弹窗生命周期（`now` 冻结致过期判定失效、Banner 早退卸载已打开弹窗、双弹窗双回传）与验收证据完整性（T-E31/T-E36 声称大于断言、模型来源分组唯一验收挂 `MONGODB_URI` 静默 skip）。按验收红线「🔴/🟠 → 打回返工」，本轮**打回**，要求修复后重提二轮复核。合并预检 `git merge-tree` 实证 PR #250 `CONFLICTING`（3 文件），随修复项一并收口。

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
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.2 🟠-1 T-ES3 名实不符假绿；resolved 事件缺 requestId 时静默丢弃、终态不收敛

- **问题描述**：`servers/agent-api/src/services/elicitation-subscriber.test.ts:168-177` 用例名 `T-ES3: resolved(unsupported_mode) → failed`，断言却是 `expect(todoService.markElicitationResolved).not.toHaveBeenCalled()`（验证「什么都不做」）；`→ failed` 映射实际仅由 T-ES3b（:179-188）覆盖。同时 `elicitation-subscriber.ts:114-127` 对 `requestId` 缺失的事件**无任何兜底**（不按 sessionId 收敛、不告警），而 `controller-api/src/services/socketio.ts:205-218` 的 payload 类型明确允许 `requestId?: string`，bridge 的 `unsupported_mode` 路径（`bridge.ts:737-741`）实际就不带 requestId。
- **根因分析**：用例命名与断言内容脱节（「名字说 A、断言验 B」），按用例名扫描会误判覆盖已存在；接收端把「requestId 可选」的合法 payload 当作可丢弃。
- **修复方案**：重命名/重写 T-ES3 为「缺 requestId 时的兜底行为」并断言兜底结果（failed 映射断言保留在 T-ES3b）；`handleElicitationResolved` 对无 requestId 事件按 `sessionId` 兜底收敛或至少 `console.warn` 可观测告警（二选一需在契约显式声明）。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.3 🟠-2 快照 `raw.authMethods` 非「对端声明原文」，契约漂移且保真断言测不到调用点

- **问题描述**：`contracts/agent-session-websocket.md:176` 声明快照 `raw` = 对端声明原文（agentCapabilities / authMethods / clientCapabilities）；但 `bridge.ts:558` `this.authMethods = toAuthMethods(result.authMethods)` 已做形态转换（`type`→`kind` 重命名、`?? null` 补齐、`AuthMethodAgent` 字段丢弃），`bridge.ts:630` 快照 raw 传入的是**转换后产物**，原文不可恢复。`capabilities.test.ts:152-157`（T-C7 保真断言）直接喂 `normalizeCapabilities(fixture.authMethods)`，纯函数保真恒绿，**测不到调用点失真**。
- **根因分析**：归一化入参与「原文留存」两个职责共用同一字段，转换发生于留存之前。
- **修复方案**：initConnection 保留 `result.authMethods` 原文（`authMethodsRaw`）供快照 raw 使用；补一条穿过 `buildInitializedPayload()` 的断言 raw.authMethods 与 SDK 原始返回深相等的测试。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.4 🟠-3 `stop()`/`handleError()` 不清理 pending Maps：65s timer 泄漏 + 迟到 `resolved(timeout)` 事件

- **问题描述**：`bridge.ts:349-366` `stop()` 只清 `activePrompt/inputQueue/spawner`，`pendingElicitations`/`pendingPermissions` 两个 Map 与其中 65s `setTimeout` 均未触碰；`handleError()`（进程崩溃路径，:859）同样不清理。用户在弹窗打开后关闭会话 → 65 秒后对已终止会话发出 `acp:elicitation:resolved{reason:'timeout'}`（bridge.ts:756-761 为本次 diff 新增的对外事件），服务端把待办标 `expired`（用户视角：已关闭会话却被记「超时未响应」）；未 `unref()` 的 timer 最长拖住进程事件循环 65s。
- **根因分析**：生命周期清理清单未随新增 pending Map/对外事件同步扩展。
- **修复方案**：`stop()`/`handleError()`/`emitStopped()` 遍历两 Map：`clearTimeout` + `resolve({action:'cancel'})` + delete；若需给待办收口改发 `reason:'cancelled'`（与 🟠-4 一并处理）；补测试覆盖 stop 后 65s 不再发事件。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.5 🟠-4 契约枚举 `reason:'cancelled'` 零产生路径；`elicitation/complete` 不 settle pending，待办悬挂误标 expired

- **问题描述**：契约 §2.34 声明 `reason: "unsupported_mode" | "timeout" | "cancelled"` 并要求 agent-api 据此标记 failed/expired/cancelled；但 bridge 全文 `acp:elicitation:resolved` 仅两处发出（reason 只有 `unsupported_mode`/`timeout`），`'cancelled'` **零产生点**。对应入口 `unstable_completeElicitation`（`bridge.ts:813-818`）只转发 `acp:elicitation:complete`，不 settle `pendingElicitations`、不发 resolved → Agent 自行完成/取消的问询 pending Promise 悬挂至 65s 超时，被误标 `expired` 而非 `cancelled`。
- **根因分析**：契约先于实现声明了三值枚举，实现未补齐产生路径；complete 与 resolved 双通道的收敛语义未定义。
- **修复方案**：`unstable_completeElicitation` 中 delete+clearTimeout+resolve 并发 `resolved{reason:'cancelled'}`；或明确 complete 为独立收敛通道并从契约删除 `cancelled` 枚举（需同步 agent-api 映射文档）。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.6 🟠-5 ElicitationDialog `now` 冻结于挂载时刻，挂载后到期的问询不再进入「已过期」终态

- **问题描述**：`apps/agent-web/src/components/ElicitationDialog.tsx:85` `const [now] = useState(() => Date.now())`，`useState` 初始化器只执行一次；`:87-88` 的 `isExpired` 判定依赖该冻结值。`PendingElicitationBanner.tsx:44-52` 在 pending 存在期间**常驻挂载** Dialog（`open` 仅显隐），`now` 即 Banner 挂载时刻。问询 10:00 创建、10:05 到期、TTL 未清理的窄窗口内用户 10:06 点开 → `expiresAt(10:05) <= now(10:00:05)` 为 false → 弹窗仍显示「提交/拒绝」且可对已过期问询提交。测试 T-W15b 每次全新 `render`（now 必大于 expiresAt）恒绿，掩盖「同一实例跨过 expiresAt」场景。
- **根因分析**：把「当前时间」当作不随渲染更新的快照；测试只覆盖单时刻渲染。
- **修复方案**：改为 render 期取值 `const now = Date.now()`（随 15s 轮询重渲染刷新）或定时器在 expiresAt 触发重渲染；补 fake timers 推进时间的用例。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.7 🟠-6 PendingElicitationBanner 早退卸载已打开弹窗（表单丢失）；与 TodoListPanel 自动弹窗无互斥（双弹窗/双回传）

- **问题描述**：
  1. `PendingElicitationBanner.tsx:28` `if (pending.length === 0) return null`——用户正在弹窗中填表时轮询返回该 todo 已带 `resolution`（如 TTL 标 `expired`），组件整体早退 → **已打开的弹窗连同已填表单瞬间卸载**，无任何终态提示。这与 `TodoListPanel.tsx:25-30` 注释明示的设计（弹窗保留并随数据收敛展示终态）互相矛盾。
  2. Banner 自持 `open` 状态与 `TodoListPanel.tsx:28-42` 的自动弹窗（互斥仅限其自身两状态）零协调：桌面端 `priority=immediate` 问询可被 TodoListPanel 自动弹出，用户再点 Banner「查看」→ 第二个 `ElicitationDialog` 叠加，同一 `requestId` 双入口各自可提交/拒绝，产生重复回传或 UI 状态错乱。
- **根因分析**：「入口显隐」与「弹窗生命周期」耦合在同一早退分支；弹窗打开权未提升为共享状态。
- **修复方案**：入口按 `pending` 过滤、弹窗数据按 todo id 从全量 `todos` 派生（不过滤 resolution），已打开弹窗不随 pending 清空而卸载；「当前打开的问询 todo id」提升至共享 store，Banner 与 TodoListPanel 双入口读写同一状态。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.8 🟠-7 T-E31 / T-E36 文档与用例标题声称远大于实际断言（声称已测但实际未测）

- **问题描述**：
  - `tests/e2e/AGENTS.md:255`（T-E31「能力面板」）声称「**20 项状态、detail** 与 Agent 版本可见」，`session-capabilities.spec.ts:175-191` 实际仅断言 dialog 可见、Agent 版本文本、**单行** `agent-capability-row-session.load` 与 3 个状态 testid——20 项计数与 detail 展示零断言（面板只渲染 5 行/丢失 detail 列，用例照样绿）。
  - `tests/e2e/AGENTS.md:260`（T-E36「模型来源分组」）声称「四个组头、**固定顺序**、组头含判定依据」，`spec.ts:254-293` 对顺序**零断言**，且 `:286` `expect(getByTestId('model-group-平台内置')).toContainText('平台内置')` 断言「组头包含自己的组名」近恒真。
- **根因分析**：用例台账先行、断言落地缩水，台账未随实现回改；恒真断言未在自查中识别。与既往多轮「文档声称 vs 实测覆盖不符」同型。
- **修复方案**：T-E31 断言 `agent-capability-row-*` 计数 = 20 并至少断言一行 detail 文本；T-E36 按 `[data-testid^="model-group-"]` DOM 顺序断言四组固定顺序、删除 :286 恒真断言；或如实收缩 AGENTS.md 台账措辞。
- **验证结果**：待二轮回填（修复 commit：待回填）

### 3.9 🟠-8 模型来源分组唯一验收（T-AC5 / T-E36）挂 `MONGODB_URI` 静默 skip，存在按运行口径零覆盖假绿风险

- **问题描述**：`tests/api/src/agent-api/session-capabilities.test.ts:367` `describe.skipIf(!MONGODB_URI)`、`tests/e2e/src/session-capabilities.spec.ts:255` `test.skip(!MONGODB_URI, ...)`——环境缺失即静默 skip（不报错）。T-AC5 是「平台内置/自定义/Agent 自带/来源未知四组 + basis」唯一的 API 级断言，T-AC5/T-E36 是模型来源三档分组仅有的集成级/E2E 验收。
- **根因分析**：条件跳过把「环境缺失」静默转化为「已通过」，与历史 `billing-events.test.ts` 因缺 `INTERNAL_API_TOKEN` 永久 skip 的假绿同型；运行口径文档未强制注入 `MONGODB_URI`。
- **修复方案**：tests/api、tests/e2e 的 AGENTS.md 运行口径显式要求注入 `MONGODB_URI` 并在验收报告登记实跑（非 skip）证据；或缺变量时显式 fail/告警，不允许静默跳过。
- **验证结果**：待二轮回填（修复 commit：待回填）

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

## 四、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 🔴-1 | elicitation 终态写入无租户过滤/无终态守卫 | 归属校验与终态单调性未进数据层 | ⬜ 待修复 | — |
| 🟠-1 | T-ES3 名实不符 + 无 requestId 静默丢弃 | 用例命名与断言脱节；合法可选 payload 无兜底 | ⬜ 待修复 | — |
| 🟠-2 | `raw.authMethods` 非原文 | 转换与留存共用字段 | ⬜ 待修复 | — |
| 🟠-3 | `stop()` 后 timer 泄漏/迟到 timeout 事件 | 生命周期清理清单未扩展 | ⬜ 待修复 | — |
| 🟠-4 | `reason:'cancelled'` 死契约、待办悬挂误标 | 双通道收敛语义未定义 | ⬜ 待修复 | — |
| 🟠-5 | ElicitationDialog `now` 冻结 | 当前时间被当快照 | ⬜ 待修复 | — |
| 🟠-6 | Banner 卸载弹窗 + 双弹窗双回传 | 弹窗打开权未共享 | ⬜ 待修复 | — |
| 🟠-7 | T-E31/T-E36 声称大于断言 | 台账与断言脱节 | ⬜ 待修复 | — |
| 🟠-8 | 模型来源分组验收静默 skip | 环境缺失被静默当通过 | ⬜ 待修复 | — |
| 🟡×15 | §3.10 | — | ⬜ 随修复收口 | — |

## 五、最终验证

| 项目 | 本轮（首轮） | 二轮要求 |
|---|---|---|
| tsc（agent-controller / agent-api / controller-api / agent-web） | ✅ 全 0 | 复跑全 0 |
| 单测 | ✅ 合计 1869 passed（389 + 732 + 223 + 525） | 复跑全绿，且新修复项须有**可证伪**回归测试 |
| eslint（agent-web） | ✅ 0 error / 7 warning | 0 error，本 diff 新增告警收口 |
| tests/api（实机） | ⏸️ 未跑 | Aspire 全栈实跑，`MONGODB_URI` 注入下 T-AC5 **非 skip** 实证 |
| tests/e2e | ⏸️ 未跑 | T-E31/T-E36 断言收口后实跑 9 例 |
| 合并预检 | ❌ CONFLICTING（`session.ts` / `session.test.ts` / `socketio-client.test.ts`） | `git merge-tree` CLEAN：3 文件按并集解决（import 块取并集、两侧测试文件合并保留），且解决后复跑 agent-api + agent-controller 单测 |

## 六、经验总结

1. **终态写入面必须带归属与单调性两个不变量**：任何「按外部 id 直写终态」的新路径都要在数据层强制 `userId` + `resolution: null` 条件，否则越权与覆盖竞态必然出现。
2. **契约枚举先于实现声明即为债务**：`cancelled` 这类「声明了但零产生点」的枚举，要么补齐产生路径，要么删除，不允许留死契约。
3. **保真断言要穿过调用点**：纯函数层的深相等保真测试测不到调用点已做转换（T-C7 假绿盲区），raw/原文类断言必须穿过组装函数。
4. **用例名与台账是验收证据的一部分**：「名字说 A、断言验 B」与「台账声称大于断言」连续多轮复发，建议在自查清单中固定「用例名 ↔ 断言 ↔ 台账」三方一致性检查。
5. **条件 skip = 潜在假绿**：环境依赖用例必须显式登记实跑证据或缺参即 fail，禁止静默跳过当通过。
6. **常驻挂载组件的时间判定**不能用 `useState` 快照，弹窗生命周期与入口显隐必须解耦。
