---
description: integration→release 集成验收报告（PR #250）——ACP 协议增强（能力快照归一化 / 前端能力门控与能力面板 / 模型来源三档分组 / Elicitation 弹窗链路修复）集成级 AI Review。首轮打回 1 × 🔴 + 8 × 🟠 + 15 × 🟡；二轮复核 REJECT（二次打回）2 残余 + 6 新 🟠（§七）；三轮返工 8 项 🟠 主体真实修复且独立实跑全部复现（tsc ×4 全 0、单测 1979 passed、tests/api 13+6+3、tests/e2e 19 全 passed 0 skip、PR CLEAN、merge-tree 0 冲突），但**三轮复核结论 REJECT（三轮打回）**：4 × 🟠（B-1 修复新引入 reconcile 迟到 acp:stopped 误杀重建会话竞态；B-4 收口不完整+新引入副作用——owner='banner' stale 仍阻塞 immediate 自动弹窗与 StrictMode 首条自动弹窗丢失、AGENTS.md 台账失实、N6 浮空断言；「声称大于实际」第三轮复发——§八「每项均有可证伪回归测试」经改坏即红实证不成立 T-S8、契约 cancelled 条目失实自相矛盾、§8.3「入参校验均收口」措辞失实；A-2 收口不完整——billing T-CC-B11 外层 TOKEN 门控残留缺参整套静默 skip 假绿）；四轮返工 R1-R4 主体真实且变异实证全部复现（M1-M4 改坏即红）、独立实跑全部复现声称（tsc ×4 全 0、单测 1989 passed、tests/api 13+6+3、tests/e2e 19 全 passed 0 skip、缺参负向均红、PR CLEAN、merge-tree 0 冲突），但**四轮复核结论 REJECT（四轮打回）**：2 × 🟠（R1 收口不完整——迟到 acp:stopped 经内联监听器与 handleError 两条产出口仍可误杀重建会话；R2 修复反向引入生产缺陷——mountedOnceRef 依赖 StrictMode dev-only 语义致生产卸载清理永不注册）+ 1 × 🟡（AGENTS.md 精确化未执行）；详见 §九/§十一
type: Permanent
---

# integration→release 集成验收报告（2026-10-21，AI Review）

> **状态**: 🔁 **五轮返工完成，待五轮 AI Review 复核**——四轮复核 2 项 🟠（R5a 迟到 stopped 另两条产出口、R5b 非 StrictMode 卸载 cleanup 未注册）+ 🟡 R5c 已修复并完成变异实证（§十二）；五轮实跑：tsc ×4 全 0、单测 1991 passed（420/775/233/563）、eslint 0 error/6 存量 warning、tests/api 13+6+3 全 passed 0 skip、tests/e2e 19 passed 0 skip、三组缺参负向均红。

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
| 🟠-9 | billing-events / billing-gateway 同型静默 skip | 缺 MONGODB_URI 被静默当通过 | ⚠️ 部分修复（MONGODB_URI 维度缺参即 fail 已实测成立；外层 TOKEN 门控残留见 §9.3-R4，三轮打回项） | 04cdc21 |

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

> 状态：8 项 🟠 全部修复；§7.5 指定 🟡 四项 + 多项廉价项一并收口。三轮复核指出的 T-S8 浮空断言已在 §十 加固（删 `clearTimeout` 实测即红）。

### 8.1 A. 首轮残余（2 项）

| # | 修复 | 可证伪测试 |
|---|---|---|
| A-1（残余 🟠-7） | store 增加「打开时 todo 快照 + `stale` 标记」；Banner/TodoList 优先取列表最新数据，todo 被 TTL 删档/limit 挤出时退回快照并由 `ElicitationDialog stale` 展示「该问询已失效（已从待办移除）」，不再卸载表单；`ElicitationDialog` 新增 `isClosed` 提交守卫 | `PendingElicitationBanner.test.tsx` T-W14d（列表清空后状态仍显示）、`ElicitationDialog.test.tsx` T-W18 |
| A-2（残余 🟠-9） | `billing-events.test.ts` T-CC-B11、`billing-gateway.test.ts` T-B24/T-B27/T-B28 移除 `describe.skipIf`，缺 `MONGODB_URI` 显式 `expect(...).toBeTruthy()` 失败；**三轮复核补：billing-events 外层 `skipIf(!TOKEN)` 一并移除，缺 token 同样即失败**；`tests/api/AGENTS.md` 同步口径 | Aspire + MONGODB_URI + token 实跑：billing-gateway **6 passed / 0 skip**、billing-events **3 passed / 0 skip**；缺参负向：两者均红（非 skip） |

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
| 其他 | sessionId 兜底改 `updateMany`（T-TD6）；新增迁移 006 显式建 `elicitationData.requestId` 索引（含用例）；T-TD3/T-TD4/T-MS9/T-B5d 断言加固；`close()` owner 守卫；到期守卫去掉 +50ms；`aria-live`+`role=status`+`aria-atomic`；T-E36 补组内归属断言；`tests/api/AGENTS.md` 数字 24/5 → 33/6；controller-api 重复 requestId timer / 断线 pending / stop 5s timer。**入参校验范围（精确）**：requestId/sessionId/mode/message（三轮复核后又补 requestedSchema ≤64 KiB、url 仅 http(s) ≤2048、toolCallId/elicitationId） |

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
| PR #250 / merge-tree | ✅ 三轮复核时 MERGEABLE/CLEAN；merge-tree 对最新 release `cb369eb` 0 冲突 |

## 九、三轮 AI Review 复核（2026-10-21）：结论 REJECT（三轮打回）

### 9.1 复核方法与独立验证（不采信自报，全部本机实跑）

4 域并行深度复核（① agent-controller bridge/socketio-client；② agent-api + controller-api；③ agent-web 前端；④ 测试/契约/台账一致性）+ 关键结论人工逐条复核与反证 + **改坏即红实证**（对「可证伪」声明做变异测试）+ Aspire 全栈实机运行 tests/api 与 tests/e2e。

| 项目 | 三轮复核实跑 | 与返工声称对比 |
|---|---|---|
| tsc ×4（agent-controller / agent-api / controller-api / agent-web） | ✅ 全 0 | 一致 |
| 单测 | ✅ **1979 passed**（416 / 775 / 232 / 556） | 一致（且逐包增量 5/8/5/8 与 diff 新增用例数精确吻合） |
| eslint agent-web | ✅ 0 error / 6 warning | 一致 |
| tests/api session-capabilities + elicitation | ✅ **13 passed / 0 skip**（MONGODB_URI 注入） | 一致 |
| tests/api billing-gateway | ✅ **6 passed / 0 skip** | 一致 |
| tests/api billing-events | ✅ **3 passed / 0 skip**（MONGODB_URI + internal token） | 一致 |
| tests/e2e session-capabilities + permission | ✅ **19 passed / 0 skip** | 一致 |
| PR #250 | ✅ MERGEABLE / CLEAN，head `7bed2c1`，**18 commits** | head/状态一致；「17 commits」计数有误（实际 18） |
| 合并预检 `git merge-tree`（integration vs 最新 release `cb369eb`） | ✅ 0 冲突（tree `b28e3fc`） | 一致 |

**负向核对（缺参行为实测）**：session-capabilities 缺 `MONGODB_URI` → 显式红 ✅；billing-gateway 缺 `MONGODB_URI` → 整套红退出（T-B24 直接 fail、T-B27/T-B28 因 beforeAll 失败标 skip）✅；billing-events 缺 token → **3 skipped、退出码 0** ⚠️（见 R4）。

**关键事实**：本轮返工主体诚意与质量继续提升，8 项 🟠 中 A-1/B-3/B-5/B-6 四项真实修复且可证伪（经「回灌旧代码即红」反证实证），B-1/B-2/B-4/A-2 的核心机制亦真实落地。**打回不针对主体，而针对下列 4 项：修复不完整/新引入缺陷与「声称大于实际」病灶的第三次复发。**

### 9.2 二轮 8 项 🟠 逐项复核结论

| 二轮编号 | 问题 | 三轮结论 | 证据摘要 |
|---|---|---|---|
| A-1（残余-7） | 弹窗卸载无终态收敛 | ✅ FIXED | store 快照+stale（`elicitationDialog.ts:42-60`）、Banner/TodoList 回退不卸载、`ElicitationDialog` stale 文案+`isClosed` 守卫；T-W14d/T-W18 可证伪（变异 M1/M3 反证实证） |
| A-2（残余-9） | billing 静默 skip + 台账失实 | ⚠️ PARTIAL（R4） | MONGODB_URI 维度已封（缺参红，实测）；但 `billing-events.test.ts:20` 外层 `describe.skipIf(!TOKEN)` 仍包住 T-CC-B11 |
| B-1（N1） | bridge 三路径收敛缺口 | ✅ FIXED（引入 R1） | 三路径收敛成立（`subscribeToProcessExit`/`settlePendingOnDisconnect`/reconcile→`stop()`），T-B11/T-B11b 负断言真实；但 reconcile 改动新引入迟到 `acp:stopped` 竞态（R1） |
| B-2（N2） | controller-api 校验 fail-open | ⚠️ PARTIAL（R3a/R3c） | resolved 白名单重建/截断/dup-timer/clearForSocket 落地（T-S6e/T-S6f/T-S9 可证伪）；但 T-S8 对「重复 requestId 清 timer」**不可证伪**（改坏即红实证），且 `handleElicitationRequest` 仅封 requestId/sessionId/mode/message，`requestedSchema`/`url`/`toolCallId`/`elicitationId` 仍无校验无上限（`elicitation-manager.ts:85-122`） |
| B-3（N3） | 请求级 Map 泄漏 | ✅ FIXED | 7 处 `delete`/`settled` emit 一一配对（`bridge.ts:388-901`），两条建桥路径均订阅清 Map；T-B11c/T-B5d 可证伪 |
| B-4（N4） | store 状态机缺陷 | ⚠️ PARTIAL（R2） | close(owner) 守卫/卸载 cleanup/草稿保留/快照 sessionId 校验落地（变异 M2/M4 反证实证）；但 owner='banner' stale 仍阻塞 immediate 自动弹窗、StrictMode 首条自动弹窗丢失（R2） |
| B-5（N5） | 归属守卫缺口 | ✅ FIXED | `todo-service.ts:185,199` 缺 userId 返回 false 不查库；T-TD10 可证伪 |
| B-6（N6） | respond 无归属前置校验 | ✅ FIXED | `todo.ts:51-58/80-87` 先 `isRespondableTodo` 后 publish，未命中抛错；T-TR0a/T-TR0b/T-TD8/T-TD9 可证伪（断言含「不 publish」） |

### 9.3 三轮问题清单（打回依据）

**【🟠-R1 B-1 修复新引入：reconcile 迟到 `acp:stopped` 误杀重建的同 sessionId 会话】**

- **问题描述**：`socketio-client.ts:1339-1345` reconcile 杀会话先 `acpBridges.delete(entry.sessionId)` 再 `void bridge.stop()`（fire-and-forget）。`stop()` 在最长 5s race（`bridge.ts:357-367`）后 `emitStopped('user_close')`（`bridge.ts:377/943-951`），旧 bridge 的 `onStopped`（`socketio-client.ts:755`）按 sessionId 键 `acpBridges.delete` + `processRegistry.deregister` + `mcpRelay.unregisterSession`——若同 sessionId 在窗口内已重建（`acp-session-manager.ts:465-467` 注释明示存在「stop 后立即 resume」流），**新 bridge 被踢出路由表、新会话映射被 `handleControllerStopped`（`acp-session-manager.ts:448-475`）删除**（DB 状态仅在 `connecting` 时受保护，路由/注册不受保护）。36311e9 的 reconcile 只 delete 不 stop，无此迟到事件——属三轮修复新引入。
- **失败场景**：controller 重连触发 reconcile 杀会话 → 用户 ≤5s 内 resume 同一会话（Agent 无响应拖满 race 窗口时）→ 新会话被标 ended/断路由，需再次重连才能恢复。
- **修复方案**：reconcile 路径改为「先同步 `settlePendingOnDisconnect()`（或同步 settle）再异步 `stop()`」；或 `emitStopped`/`onStopped` 增加「`acpBridges.get(sessionId) === this` 才删除/上报」的持有权守卫；补回归测试（重建同 sessionId 后旧 bridge stop 不得删除新 bridge 条目、不得上报 `acp:stopped`）。
- **建议**：`reason:'user_close'` 语义可另立（如 `reconciled`），避免对账杀会话被服务端记为用户关闭。

**【🟠-R2 B-4 收口不完整 + 新引入副作用（含台账失实、浮空断言）】**

1. **owner='banner' 的 stale 弹窗仍阻塞后续 immediate 自动弹窗**：`TodoListPanel.tsx:61-67` 的 `liveElicitationTodo`/`elicitationStale` 仅在 `elicitationOwner === 'todo'` 时计算——owner='banner' 持有 stale 弹窗时 `elicitationStale` 恒 false → `elicitationBlocking` 恒 true → 自动弹窗效果早退。新 immediate 问询 65s 窗口内若用户未手动关掉 stale 弹窗即永久失效。**B-4 声称的「todo 缺失标记 stale 后不再阻塞后续 immediate 自动弹窗」只对 owner='todo' 成立**，`apps/agent-web/AGENTS.md`「（且不再阻塞后续 immediate 自动弹窗）」无限定表述失实（D1 实验因果闭合：禁用 `elicitationBlocking` 后转绿）。
2. **StrictMode 下首条 immediate 自动弹窗永久丢失（本轮 cleanup 新引入）**：`TodoListPanel.tsx:70` 卸载 cleanup `closeElicitation('todo')` 在 StrictMode 模拟卸载时关闭 auto-open 刚打开的弹窗，而 `processedImmediateRef`（:79）已记账该 id → 重挂载后不再重开。`main.tsx:13` 全局启用 `<StrictMode>`，dev 口径（Aspire 标准运行方式）首条 immediate 自动弹窗静默丢失（D3 实验：移除该 cleanup 行后转绿，因果闭合）。「测试绿、应用坏」——测试不带 StrictMode。
3. **声称的可证伪测试 N6 存在浮空断言**：`TodoListPanel.test.tsx:212` 中段 `waitFor(...)` **未 await**——「弹窗以已失效收敛」断言永不强制执行（变异 M3 实证：行为破损时该断言不使测试失败）。
- **修复方案**：① `elicitationBlocking`/`elicitationStale` 改 owner 无关（live 按 todoId 从全量 todos 派生，snapshot 回退校验 sessionId），补 owner='banner' stale 放行用例；② cleanup 与 `processedImmediateRef` 记账解耦（close 时同步清记账，或仅在「自己持有且非 StrictMode 重放」时关闭），补 StrictMode 渲染用例；③ N6 补 `await`；④ AGENTS.md 表述精确化。

**【🟠-R3 「声称大于实际」第三次复发（证据/契约/措辞面）】**

1. **§八「每项均有可证伪回归测试」声明不成立**：T-S8（`elicitation-manager.test.ts:287-305`，「重复 requestId 清旧 timer」的唯一回归测试）**改坏即红实证失败**——删除 `elicitation-manager.ts:100` 的 `clearTimeout(existing.timeout)` 后该文件 19/19 仍全绿（旧 timer 60s 触发被 `handleTimeout` 的 pending 守卫归并为同样 1 条 timeout，观测不可区分）；未用 `vi.getTimerCount()` 锁 timer 数。B-2 的 dup-timer 修复本身真实，但**证据声明大于证据实际**。
2. **契约 `cancelled` 条目失实且自相矛盾**：`contracts/agent-session-websocket.md:869-877` 新补录称「用户主动取消 / Agent 自发 complete …以上路径均…发 `resolved{cancelled}`」，但实现 `handleElicitationResponse` 的用户 cancel（`bridge.ts:864-880`）**不发** `resolved`（终态由 respond 路径直写，行为合理），且与同契约 §2.34「用户已响应的情况走 `acp:elicitation:response`」自相矛盾——§8.3「契约补录」声称的内容质量与实现不符。另「会话关闭后不应再出现迟到 `resolved{timeout}`」不变量存在反例窗口：`bridge.ts:356-375` settle 位于 5s race **之后**，Agent 无响应时 pending 问询余量 <5s 的窗口内仍会迟到发 timeout（建议 settle 前移一行）。
3. **§8.3「入参校验均收口」措辞失实**：`handleElicitationRequest` 仅校验 requestId/sessionId/mode/message（`elicitation-manager.ts:88-97`），`requestedSchema`（任意体积对象直落 Mongo `Mixed`）/`url`/`toolCallId`/`elicitationId` 仍无校验无上限——§7.5 明确点名的「message/**requestedSchema/url** 无校验」只收口 1/3。§8.2 B-2 行的列举（「校验 requestId/sessionId/mode/message」）准确，失实集中在 §8.3 汇总措辞。
- **修复方案**：① T-S8 改可证伪（`vi.getTimerCount()` 锁 timer 数或拆双 requestId 用例，确保删 clearTimeout 即红）；② 契约 cancelled 条目按实现修正（用户主动取消不发 resolved）并与 §2.34 对齐；③ §8.3 改精确列举；④ 补 `requestedSchema`/`url`/`toolCallId`/`elicitationId` 校验与长度上限（或显式登记为遗留并降级标注）。

**【🟠-R4 A-2 收口不完整：billing T-CC-B11 双门控残留，假绿通道未封死】**

- **问题描述**：`tests/api/src/cloud-controller/billing-events.test.ts:20` 外层 `describe.skipIf(!TOKEN)` 仍包住全部 3 用例含 T-CC-B11（自称「billingoutbox 落库的唯一集成验收」）——**缺 `CLOUD_CONTROLLER_INTERNAL_TOKEN`/`INTERNAL_API_TOKEN` 时整套静默 skip、退出码 0**（本轮实测 3 skipped / exit 0），缺参零覆盖假绿通道仍在；且与同文件 :64-67 新注释「条件跳过会把环境缺失静默当作通过」自相矛盾。MONGODB_URI 维度的「缺参即 fail」已真实落地（实测红），§8.1/上游产物「缺参即 fail」表述未限定参数维度，口径偏宽。
- **修复方案**：T-CC-B11 移出 TOKEN 门控（缺 token 即 fail），或将外层 `describe.skipIf(!TOKEN)` 改为缺参显式失败；消除同文件注释与门控的自相矛盾；AGENTS.md 同步精确口径。

### 9.4 反证记录（人工复核排除的子代理指控）

| 疑点 | 复核结论 |
|---|---|
| 域2 上报「permission-manager 完全 fail-open（🟠）」「handleElicitationComplete 零校验（🟠）」 | **降级为登记项**：两者均为 release 已有代码（`git diff release...integration` 不含 permission-manager；`git log -S handleElicitationComplete` 在本 PR 范围无引入提交），不属本次集成 diff 的打回依据；同型问题登记备查（🟡-R5） |
| 域2 上报「日志脱敏 / updated===0 告警文案被声称收口但未落地」 | **排除（误归因）**：两条仅存在于 §7.5 待办清单，§八与上游产物均未声称收口，不构成台账失实 |
| 域1 上报「unsupported_mode 早退不发 settled 不对称」 | **排除**：该路径从不写入请求 Map（`elicitation:sent` 未发），无泄漏面 |
| T-W4 顺序断言「自引用恒真」 | **部分成立但不判假**：组件侧改序/丢行即红（可证伪成立）；清单源头漂移靠 agent-controller 自身测试兜底，登记 🟡 补独立钉死断言 |
| 前轮经验复用：域间结论冲突时 | 均以「亲自读码 + 变异实验」定案（R1/R2 代码链逐行核证，R3a 变异实证，R4 实跑实测） |

### 9.5 🟡 随修复收口（节选）

settle 前移到 5s race 之前（bridge.ts:356-375，R3 关联）；spawner `'error'` 不 resolve `closed`（第四路径残余）；进程崩溃后不发 `acp:stopped` 残留死桥注册；stale 终态弹窗被下一个 immediate 顶掉（N-2，A-1「不再卸载」有条件）；切会话幻影弹窗单帧残留（N-4，live 路径不校验 sessionId）；drafts Map 无上限增长（N-5）；快照回退丢失终态更新（N-6）；`agentFeatures.ts` 跨包相对路径直插（N-7）；`handleOpenUrl` 先开窗后守卫（N-8）；E2E T-E36 组内归属无排除断言（模型串组也能绿）；`ElicitationDialog.test.tsx` 终态 describe 无 `resetElicitationDialog` 测试间污染；N3-reconcile 对 fake bridge 的恒真负断言、N3-disconnect 单 bridge 不证「遍历所有」；`mcp.test.ts` console.log 残留；bridge.test.ts:797 注释「真实时钟推进」实为 fake timers；PR commits 计数 17→18；permission-manager/handleElicitationComplete 同型 fail-open（9.4 降级项）。

### 9.6 修复要求（四轮复核入口条件）

1. **R1**：reconcile 收敛改「先同步 settle 再 stop」或 `emitStopped`/`onStopped` 加持有权守卫（`acpBridges.get(sessionId) === this`），补回归测试（重建同 sessionId 后旧 stop 不影响新会话）。
2. **R2**：`elicitationBlocking`/`elicitationStale` owner 无关 + StrictMode cleanup/记账解耦 + N6 补 `await` + AGENTS.md 精确化，每处补可证伪用例（含 owner='banner' stale 放行、StrictMode 渲染）。
3. **R3**：T-S8 改可证伪（删 clearTimeout 即红）；契约 cancelled 条目按实现修正并对齐 §2.34；§8.3 精确列举；requestedSchema/url/toolCallId/elicitationId 补校验（或显式登记遗留并降级标注）。
4. **R4**：T-CC-B11 移出/改造 TOKEN 门控为缺参即 fail，消除同文件注释矛盾，AGENTS.md 同步。
5. 台账一致性自查继续执行：报告/AGENTS.md/契约所有「已修复/不得出现/均收口」断言与实现逐条对照后方可声称；修复后重跑 tsc ×4、四包单测、tests/api（含 billing 两套注入 MONGODB_URI 与 token 实跑 + 缺参负向核对）、tests/e2e，登记实跑证据，重提**四轮 AI Review**。

### 9.7 判定

按验收红线「🔴/🟠 → 打回返工」：**REJECT（三轮打回）**，返工目标节点「修复Review意见」。三轮返工主体真实、可证伪性显著优于前两轮（数字链三重自洽、独立实跑全部复现），本轮 4 项 🟠 均为收口边界问题且修复方案便宜（多项为一行级修复），收口后可快速四轮复核。

## 十、四轮返工修复记录（2026-10-21，对应 §9.3 R1-R4）

> 状态：R1-R4 全部修复，均附可证伪回归测试（关键项已做变异实证）；§9.5 指定 🟡 项一并收口。

### 10.1 R1：reconcile 旧 bridge 迟到 stopped 误杀新会话

- `socketio-client` 的 `acp:reconcile` 改为**先同步** `bridge.settlePendingOnDisconnect()`，再 `bridge.stop({ silent: true })`；同 sessionId 重复 `acp:start` 的旧 bridge 也走 silent stop。
- `bridge.stop({silent:true})` 不发 `acp:stopped`（仍置 `stopped` 并清理 timer），`onStopped` 增加 `acpBridges.get(sessionId) === bridge` 持有权守卫。
- 测试：`R1: stop({silent:true}) 不发 acp:stopped`、`R1: 同 sessionId 重建后旧 bridge 的迟到 stopped 不影响新会话`（`socketio-client.test.ts`）；变异（去掉持有权守卫）实测该用例变红。

### 10.2 R2：stale 阻塞与 StrictMode 首弹丢失

- `TodoListPanel` 的 live todo 计算改为**与 owner 无关**，`elicitationBlocking = Boolean(liveElicitationTodo)`：banner 持有 stale（列表已移除）时同样放行后续 immediate。
- 卸载 cleanup 用 `mountedOnceRef` 跳过 StrictMode 的首次 cleanup（第二次挂载才注册清理），解决「cleanup 关掉首弹 + processed 记账后不再重开」。
- `N6` 中段 `waitFor` 补 `await`（浮空断言修正）。
- 测试：`R2-1: owner=banner 持 stale 快照时同样放行`、`R2-2: StrictMode 双挂载下首条 immediate 不丢失`；变异（恢复旧 blocking / 无条件 cleanup）实测两用例均红。

### 10.3 R3：台账一致性（T-S8、契约、校验范围）

- **T-S8 可证伪化**：先发首请求 → 推进 30s → 同 requestId 再发 → 在 t=65s 断言 **0 条 timeout**，t=95s 断言恰好 1 条；删除 `clearTimeout` 变异实测该用例红。
- **契约修正**：`agent-session-websocket.md` 删除「用户主动取消也发 `resolved{cancelled}`」的错误表述——用户取消走 `acp:elicitation:response` 写终态，本事件仅覆盖 complete/stop/error/进程退出/断线/对账。
- **settle 前移**：`bridge.stop()` 在 `cancel/closeSession` 的 5s race **之前**同步 `settlePendingRequests`，封死 race 窗口（测试 `R3: stop() 在 5s race 之前同步收敛 pending`，cancel 永久挂起仍立即收敛）。
- **入参校验补全**：`handleElicitationRequest` 新增 requestedSchema ≤64 KiB、url（url 模式仅 http(s)、≤2048）、toolCallId/elicitationId 校验；报告 §8.3 的「入参校验均收口」改为精确字段清单。
- 测试：`T-S11`（超大 schema / javascript: url / 非法 toolCallId 均不入 pending）。

### 10.4 R4：billing-events 外层 token 门控

- 移除 `describe.skipIf(!TOKEN)`，改为 `beforeEach(requireToken)`：缺 `CLOUD_CONTROLLER_INTERNAL_TOKEN` 时 3 个用例全部**失败**而非 skip。
- `billing-gateway` 的 beforeAll 在缺 MONGODB_URI 时不再抛错（避免 vitest 标 skipped），改为每个用例体内显式断言失败。
- 负向实跑：billing-events 缺 token → **3 failed / 0 skip**；billing-gateway 缺 MONGODB_URI → **T-B24/T-B27/T-B28 均 failed / 0 skip**；session-capabilities 缺 MONGODB_URI → T-AC5 failed（其余 6 passed）。

### 10.5 🟡 收口（节选）

| 项 | 处理 |
|---|---|
| N-4 切会话单帧幻影 | Banner 先校验快照 `sessionId` 再取 live，切会话不再渲染一帧旧弹窗 |
| N-5 drafts 无上限 | 草稿 Map 上限 50（LRU 淘汰最旧），含单测 |
| N-6 快照丢终态 | `syncElicitationSnapshot` 在 live 收敛时刷新快照；TTL 移除后仍显示「已提交」，不再退化为「已失效」，含测试 |
| N-8 先开窗 | `handleOpenUrl` 先校验 http(s)，非法 URL 不开窗、不回传（含单测） |
| spawner error 不 resolve closed | `error` 事件同样 `resolveClosed`，桥接层收敛 pending |
| T-E36 无排除断言 | 增加跨组 `not.toContainText` 排除断言 |
| N3-* 弱断言 | reconcile 断言 `stop({silent:true})` + settle 调用 + 无 stopped/resolved；disconnect 断言 settle 次数 |
| PR 计数 | 报告按实际提交数回填（三轮为 18，本轮后见 10.7） |
| 存量 fail-open 登记 | `permission-manager` / `handleElicitationComplete` 为 release 存量、不在本 PR diff，登记为已知后续项，不虚称已修 |

### 10.6 四轮独立实跑证据（Aspire 全栈）

| 项目 | 结果 |
|---|---|
| tsc ×4 | ✅ 全 0 |
| 单测 | ✅ **1989 passed**（agent-controller 419 / agent-api 775 / controller-api 233 / agent-web 562） |
| eslint agent-web | ✅ 0 error / 6 warning（均存量） |
| agent-web production build | ✅ 成功 |
| tests/api session-capabilities + elicitation | ✅ 13 passed / 0 skip |
| tests/api billing-gateway | ✅ 6 passed / 0 skip |
| tests/api billing-events | ✅ 3 passed / 0 skip |
| tests/e2e session-capabilities + permission | ✅ 19 passed / 0 skip |
| 缺参负向 | ✅ billing-events 3 failed/0 skip；billing-gateway T-B24/T-B27/T-B28 failed/0 skip；T-AC5 failed |
| 变异实证 | ✅ T-S8 删 clearTimeout 即红；R1 去持有权守卫即红；R2 旧 blocking/cleanup 即红 |
| 合并预检 | ✅ merge-tree 对最新 release 0 冲突 |

### 10.7 提交与 PR

- 代码修复 commit：`af51f4c`（含 R1-R4 修复、回归测试与变异实证）
- 报告回填 commit：本提交（仅文档；最终 head 以 PR 为准）
- PR #250：MERGEABLE / CLEAN（代码修复后仅追加本文档提交，commits 计数以 PR 页面为准）；merge-tree 对最新 release `cb369eb` 0 冲突。

## 十一、四轮 AI Review 复核（2026-10-21/22）：结论 REJECT（四轮打回）

### 11.1 复核方法与独立验证（不采信自报，全部本机实跑）

逐文件读码核对 `af51f4c`（21 文件）+ 全部台账声称与实现对照 + **改坏即红变异实证**（复跑四轮声称的 3 组变异）+ **独立证伪测试**（对声称的不变量写反向用例）+ Aspire 全栈实机运行 tests/api 与 tests/e2e + 缺参负向核对。

| 项目 | 四轮复核实跑 | 与返工声称对比 |
|---|---|---|
| tsc ×4（agent-controller / agent-api / controller-api / agent-web） | ✅ 全 0 | 一致 |
| 单测 | ✅ **1989 passed**（419 / 775 / 233 / 562） | **精确一致** |
| eslint agent-web | ✅ 0 error / 6 warning（均存量） | 一致 |
| agent-web production build | ✅ 成功（仅 chunk 体积提示） | 一致 |
| tests/api session-capabilities + elicitation | ✅ **13 passed / 0 skip** | 一致 |
| tests/api billing-gateway | ✅ **6 passed / 0 skip** | 一致 |
| tests/api billing-events | ✅ **3 passed / 0 skip** | 一致 |
| tests/e2e session-capabilities + permission | ✅ **19 passed / 0 skip** | 一致 |
| PR #250 | ✅ OPEN / MERGEABLE / CLEAN，head `b4a2e17`，22 commits | 一致（口径以 PR 页面为准） |
| 合并预检 `git merge-tree --write-tree`（vs `origin/release`） | ✅ exit 0 无冲突 | 一致 |

**缺参负向核对（实测）**：billing-events 缺 token → **3 failed / 0 skip** ✅；billing-gateway 缺 `MONGODB_URI` → **T-B24/T-B27/T-B28 failed / 0 skip** ✅；session-capabilities 缺 `MONGODB_URI` → **T-AC5 failed（其余 6 passed）** ✅——三组全部与 §10.4/§10.6 声称一致，R4 假绿通道封死属实。

**变异实证（复跑四轮声称）**：① 删 `elicitation-manager.ts:116` clearTimeout → T-S8 红 ✅；② 去掉 onStopped 持有权守卫 → R1 用例红 ✅；③ 回灌旧 `elicitationBlocking` → R2-1 红 ✅；④ 回灌旧无条件 cleanup → R2-2 红 ✅。四轮「改坏即红」声称**全部属实**（三轮 R3a「声称大于实际」病灶在证据面已收敛）。

**关键事实**：四轮返工质量与证据链继续提升，R1-R4 主体机制真实、可证伪性全部经变异实证复现。**打回不针对主体，而针对下列 2 项：R1/R2 修复各自在边界处留有/引入缺陷（各补证伪测试实测红），属同一「收口不完整 + 测试绿应用坏」病灶的第四轮变体。**

### 11.2 三轮 4 项 🟠 逐项复核结论

| 三轮编号 | 问题 | 四轮结论 | 证据摘要 |
|---|---|---|---|
| R1 | reconcile 迟到 `acp:stopped` 误杀重建会话 | ⚠️ PARTIAL（R5a） | 主路径真实修复：reconcile 先同步 settle 再 `stop({silent:true})`、替换路径 silent、`onStopped` 持有权守卫、`stop({silent:true})` 不发 `acp:stopped`（均核实 + 变异②实证）；但**迟到 stopped 的另两条产出口未设防**（见 11.3 R5a） |
| R2 | stale 阻塞 + StrictMode 首弹丢失 | ⚠️ PARTIAL（R5b） | blocking/stale owner 无关（变异③实证）、N6 补 `await`、R2-1/R2-2 可证伪均属实；但 `mountedOnceRef` **反向引入生产缺陷**（见 11.3 R5b） |
| R3 | 「声称大于实际」第三次复发 | ✅ FIXED | T-S8 可证伪化（变异①实证）；契约 `cancelled` 条目已按实现修正并与 §2.34 对齐（读码核实）；settle 前移至 5s race 之前（`bridge.ts:358-361`，R3 用例覆盖 cancel 永久挂起）；`handleElicitationRequest` 校验补全（requestedSchema ≤64KiB / url 仅 http(s) ≤2048 / toolCallId / elicitationId）+ T-S11；§8.3 已改精确字段清单 |
| R4 | billing T-CC-B11 双门控假绿 | ✅ FIXED | `describe.skipIf(!TOKEN)` 移除、`beforeEach(requireToken)`、billing-gateway beforeAll 不抛错 + 用例体显式断言；缺参负向三组实测全红 0 skip（11.1） |

### 11.3 四轮问题清单（打回依据）

**【🟠-R5a R1 收口不完整：迟到 `acp:stopped` 的另两条产出口未设防，「误杀重建会话」仍可复现】**

- **问题描述**：R1 为「迟到 `acp:stopped`」只封了两条出口：`stop({silent:true})` 不发事件、`onStopped` 加持有权守卫。但同一事件还有两条出口未设防：
  1. **内联监听器无守卫**：`acp:start`（`socketio-client.ts:691-696`）与 `acp:resume`（:830-836）各自注册的内联 `bridge.on('acp:stopped')`（`processRegistry.deregister(sessionId)` + `mcpRelay.unregisterSession(sessionId)`，按 sessionId 键删除）**没有** `acpBridges.get(sessionId) === bridge` 守卫——旧 bridge 的迟到本地 stopped 会把**新会话**的进程注册与 MCP relay 注册一并注销（新会话成为对账盲区、MCP 中继断链）。
  2. **`handleError` 无 silent/stopped 意识**：`bridge.ts:957-975` 无条件 `socket.emit('acp:stopped')` + 本地 emit——旧 bridge 若在被替换时仍处于初始化中（`acp:start` 注释自述的「start 超时后的兜底 resume/重试与迟到初始化交叠」恰是替换路径的**主场景**），init 随后失败即触发 `handleError`：本地 emit 命中 ① 的内联监听器，socket emit 命中服务端 `handleControllerStopped` 删除新会话映射——**R1 定义的失败模式经由另一条产出口原样重现**。
- **证伪实测**：独立证伪用例（替换同 sessionId → 模拟新 bridge 注册 → 旧 bridge 迟到 `acp:stopped`）**实测红**：`processRegistry.get('sess-r')` 为 undefined（新会话注册被注销）。而 R1 回归测试只断言「socket 不发 `acp:start:result`」，对内联监听器的破坏零感知——「旧 bridge 的迟到 stopped 不影响新会话」的**声称面大于测试面**。
- **修复方案**：内联监听器并入同一持有权守卫（`acpBridges.get(sessionId) === bridge` 才 deregister/unregister），或统一收口到 `onStopped`；`handleError` 尊重 silent/stopped（已 silent 或已 stopped 时不再发事件，或同样经持有权判定后发）；回归测试补两条断言（迟到 stopped 后新会话 registry/relay 注册存活、`handleError` 迟到不向服务端发 `acp:stopped`），证伪用例可直接改造沿用。

**【🟠-R5b R2 修复反向引入生产缺陷：卸载 cleanup 在非 StrictMode 下永不注册（「测试绿、应用坏」反向复发）】**

- **问题描述**：`TodoListPanel.tsx:80-88` 的 `mountedOnceRef` 方案把「跳过 StrictMode 首次 cleanup」实现为「首次 effect 不注册 cleanup」。但 StrictMode 的 setup→cleanup→setup 双调用是 **dev-only** 语义：生产环境每次挂载只跑一次 effect，首轮即 `return` undefined——**卸载 cleanup 永远不会被注册**，`closeElicitation('todo')` 在生产卸载时不再执行。真实卸载场景：移动端首页→会话详情（`MainLayout.tsx:105-110` 此时整个 Sidebar 不渲染）、桌面↔移动断点切换。结果：owner='todo' 的弹窗状态残留（重新挂载后幻影重现），代码注释「面板卸载时清理自己持有的状态」与 `apps/agent-web/AGENTS.md`「切会话/卸载时清理自己持有的状态」在生产口径**失实**。
- **证伪实测**：独立证伪用例（**不带 StrictMode** 渲染 → immediate 自动弹窗 → unmount → 断言 store 状态关闭）**实测红**：`todoId` 仍为 `'todo-p'`。R2-2 用例带 `<StrictMode>` 渲染，只能证明 dev 语义，测不到本缺陷；「第二次挂载才注册清理」仅在 StrictMode 成立。全库（TodoListPanel/store 测试）**无任何卸载清理用例**（StrictMode 与否均无）——与 R2 原缺陷同型的「测试绿、应用坏」以反向形式复发。
- **修复方案**：改为「cleanup 总是注册，但只跳过 StrictMode 的模拟卸载」语义（如 setup 内以微任务/时间戳标记「真实挂载完成」，cleanup 仅在标记后执行 `closeElicitation('todo')`）；或在 `closeElicitationDialog`/store 侧同步清 `processedImmediateRef` 记账后恢复无条件 cleanup；补「非 StrictMode 卸载即清理」可证伪用例（证伪用例可直接改造沿用）；同步修正注释与 AGENTS.md 表述。

**【🟡-R5c R2 修复要求「AGENTS.md 表述精确化」未执行】**：`af51f4c` 未包含 `apps/agent-web/AGENTS.md`（§9.6 第 2 条明确要求）。其中「不再阻塞后续 immediate」经 owner 无关修复后已为真，但同段「切会话/卸载时清理自己持有的状态」因 R5b 失实，且「只有列表中仍存在的问询才阻塞自动弹窗」等限定语未按要求落台账。随 R5b 一并精确化。

### 11.4 反证记录（人工复核排除的疑点）

| 疑点 | 复核结论 |
|---|---|
| R2-1 放行后 banner stale 弹窗被新 immediate 顶掉（表单丢失） | **不判缺陷**：§9.6 明确要求「blocking/stale owner 无关、stale 放行」，顶替是既定取舍；drafts 按 requestId 缓存兜底 |
| `stop({silent:true})` 后服务端不再收到该会话的 stopped | **不判缺陷**：reconcile 杀的本就是服务端已判定不存在/待杀的会话；替换路径服务端自身发起 `acp:start`，语义自洽 |
| `handleElicitationRequest` 非 url 模式下 `url` 字段仅限长不限协议 | **不判缺陷**：非 url 模式 `url` 不参与展示/开窗（前端 `handleOpenUrl` 已双重校验 http(s)），登记即可 |
| `validSchema` 对 `JSON.stringify` 抛错（循环引用） | **排除**：socket.io payload 经 JSON 反序列化，无循环引用面 |
| 四轮声称「变异实证」可能自证式摆拍 | **排除**：M1-M4 由本轮独立复跑重放，全部红，与声称一致 |

### 11.5 修复要求（五轮复核入口条件）

1. **R5a**：迟到 `acp:stopped` 全部产出口收口——内联监听器加持有权守卫（或并入 `onStopped`）、`handleError` 尊重 silent/stopped；补两条回归断言（新会话 registry/relay 注册存活、`handleError` 迟到不发服务端 `acp:stopped`）。
2. **R5b**：卸载 cleanup 改「总是注册、仅跳过 StrictMode 模拟卸载」（或 close 时清记账后恢复无条件 cleanup）；补「非 StrictMode 卸载即清理」可证伪用例；注释与 AGENTS.md 同步（含 R5c）。
3. 台账一致性自查继续：所有「清理/不影响/均收口」断言与实现逐条对照后方可声称；修复后重跑 tsc ×4、四包单测、tests/api 三套（含缺参负向）、tests/e2e，登记实跑与变异证据，重提**五轮 AI Review**。

### 11.6 判定

按验收红线「🔴/🟠 → 打回返工」：**REJECT（四轮打回）**，返工目标节点「修复Review意见」。四轮返工的证据链质量高（数字全对齐、变异全部可复现、假绿通道封死），本轮 2 项 🟠 均为一行至十行级的收口边界缺陷，且证伪用例已随本文档思路备好，修复成本低；R1/R2 连续两轮在同一类「迟到事件/卸载清理」边界上留口，建议修复时以「所有产出口逐一列举 + 每条产出口一条负断言」的方式自查后再提交。

## 十二、五轮返工修复记录（2026-10-21，对应 §11.3 R5a-R5c）

> 状态：R5a/R5b 全部修复，R5c 随 R5b 收口；每项均有可证伪回归测试并完成变异实证。

### 12.1 R5a：迟到 `acp:stopped` 的其余产出口

R1 只守住了 `onStopped`，仍有两条产出口可误杀新会话，本轮逐一封死：

| 产出口 | 修复 |
|---|---|
| `acp:start` 内联 `bridge.on('acp:stopped')`（processRegistry.deregister + mcpRelay.unregisterSession） | 增加 `acpBridges.get(sessionId) === bridge` 持有权守卫 |
| `acp:resume` 内联监听器（同型） | 同上 |
| `bridge.handleError`（初始化/提示失败，无条件 socket+本地 emit） | 新增 `silentStop` 标记（`stop({silent:true})` 入口即置位）；`handleError` 发现 `stopped || silentStop` 时只收敛 pending，**不再 emit** |

回归测试：
- `R1: 同 sessionId 重建后旧 bridge 的迟到 stopped 不影响新会话` 扩展为**注册 processRegistry 后**断言注册存活（不再只断言 socket 无 `acp:start:result`）。
- `R5a: silent stop 后迟到的 handleError 不再向服务端/本地发 acp:stopped`。
- 变异实证：删内联守卫 → 第一例红；去掉 `wasStopped` 早退 → 第二例红。

### 12.2 R5b：卸载 cleanup 在非 StrictMode 下永不注册

- 改为**无条件注册 cleanup**：cleanup 里置 `mountedRef=false` 并 `queueMicrotask` 检查；StrictMode 的 setup→cleanup→setup 在同一 tick 内把 `mountedRef` 重新置 true，微任务跳过关闭；真实卸载没有重新 setup，微任务执行 `closeElicitation('todo')`。
- 新增 `R5b: 非 StrictMode 真实卸载时清理 owner=todo 的弹窗状态`：`renderHook` 观察 store，卸载后断言 `todoId/owner` 归零。
- 变异实证：回灌旧 `mountedOnceRef` 逻辑 → 该用例红（`todoId` 仍为 `todo-prod`）。
- `apps/agent-web/AGENTS.md` 同步精确口径：真实卸载经微任务确认后清理；StrictMode 模拟卸载不关闭；stale 与 owner 无关；草稿上限 50（R5c）。

### 12.3 五轮实跑证据（Aspire 全栈）

| 项目 | 结果 |
|---|---|
| tsc ×4 | ✅ 全 0 |
| 单测 | ✅ **1991 passed**（agent-controller 420 / agent-api 775 / controller-api 233 / agent-web 563） |
| eslint agent-web | ✅ 0 error / 6 warning（均存量） |
| agent-web production build | ✅ 成功 |
| tests/api session-capabilities + elicitation | ✅ 13 passed / 0 skip |
| tests/api billing-gateway | ✅ 6 passed / 0 skip |
| tests/api billing-events | ✅ 3 passed / 0 skip |
| tests/e2e session-capabilities + permission | ✅ 19 passed / 0 skip |
| 缺参负向 | ✅ billing-events 缺 token 3 failed/exit 1；billing-gateway 缺 MONGODB T-B24/T-B27/T-B28 failed/exit 1；T-AC5 failed（其余 6 passed，exit 1） |
| 变异实证 | ✅ R5a 内联守卫/`wasStopped` 早退、R5b 旧 cleanup 逻辑，三处改坏均红 |

### 12.4 提交

- 代码修复 commit：五轮修复提交（R5a/R5b/R5c 及其回归测试，见 git log）
- 报告回填 commit：本提交
- PR #250：状态与 head 以 PR 页面为准。
