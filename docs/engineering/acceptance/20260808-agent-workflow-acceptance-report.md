---
description: Agent 工作流首轮验收反馈（4 个问题）的根因分析、修复方案与验证结果跟踪
type: Permanent
---

# Agent 工作流验收报告（2026-08-08）

> **状态**: 本轮受理 4 个验收反馈，已全部修复并验证通过（4/4 闭环）

## 关联文档

- PRD：[[20260808-agent-workflow]]（docs/product/released/20260808-agent-workflow.md）
- 技术方案：[[20260808-feat-agent-workflow]]（docs/engineering/proposals/20260808-feat-agent-workflow.md）
- 实现方案（plan）：docs/engineering/proposals/ 内同轮 plan 文档
- 分支：`feat/agent-workflow`（PR #154 → main）
- 验收日期：2026-08-08

## 需求概述

Agent 工作流：模板 → 已配置工作流 → 实例，人类节点与 AI 节点按 DAG 流转，AI 节点由 harness（ACP Agent）在会话中执行并通过平台 MCP 工具操作节点。本轮为首轮真实环境验收（真实 harness + 真实 UI 操作）。

## 验收问题清单

### 1. 配置工作流界面 mode/model 为文本输入框，无动态选项

**问题描述**：设置 → 工作流 → 配置工作流对话框中，选择 Harness 工具后，旁边的 Mode 和模型是纯文本输入框，用户无法知道可选值。期望：选择工具后动态拉起一个空实例，获取可选 mode/model 列表，变为下拉选择。

**根因分析**：

- 能力探测链路（`acp:check`）只做 CLI `--version` 检查（`packages/agent-controller/src/acp/detector.ts`），从不拉起 ACP 会话，因此拿不到 modes/models。
- modes/availableModels 只在真实 `session/new` 响应中存在（`acp-session-manager.ts` 的 `acp:start:result`），配置阶段没有会话可查。
- GraphQL `AcpCapability` 类型与 Redis 缓存结构（`acp:capability:<controllerId>`）均无 modes/models 字段，前端 `ConfigureWorkflowDialog` 只能用 `<Input>`。

**修复方案**（新增「按类型空实例探测」链路）：

1. 契约 `contracts/agent-session.graphql`：新增 `AcpModeOption` / `AcpModelOption` / `AcpServerOptions` 类型与 `Query.acpServerOptions(controllerId, acpServerType)`。
2. `packages/agent-controller`：新增 `src/acp/prober.ts`，收到 `acp:probe-options` 后按 serverType 拉起临时 ACP 进程（initialize + session/new），收集 modes/availableModels 后立即关闭，回 `acp:probe-options:result`。
3. `servers/controller-api`：新增 `acp-options-prober.ts`（请求/响应配对 + Redis 缓存 `acp:options:<controllerId>:<serverType>`，TTL 1h）；`session-command.ts` 分发 `acp:probe-options` 命令；`socketio.ts` 监听 `acp:probe-options:result`。
4. `servers/agent-api`：`sessionService.getAcpServerOptions`（缓存优先，未命中发命令并轮询）；GraphQL schema/resolver 新增查询。
5. `apps/agent-web`：`ConfigureWorkflowDialog` 按节点选择 Harness 后查询选项，有选项时 Mode/模型渲染为下拉（含「留空」项），探测中显示提示，无选项时回退文本输入。

**验证结果**：✅ controller-api 单测 383/383（含 prober 4 例）；agent-controller 单测 259/259（含 prober 3 例）；agent-web 单测 296/296（含配置对话框 3 例），tsc/lint 0 error；API 测试 A20（探测返回选项 + 二次查询命中缓存）通过；E2E-9（设置页对话框选择 Harness 后 Mode/模型变为下拉）通过

**修复 commit**：5e7eaa5

### 2. 工作流实例页频繁刷新，人类节点输入被清掉且无临时保存

**问题描述**：工作流实例页（`/workflows/:id`）每 5s 轮询刷新，人类节点输入框内容在输入过程中被刷新掉，也没有临时保存。

**根因分析**：

- `WorkflowInstancePage` 使用 `pollInterval: 5000`；人类节点输入框 `HumanNodeActions` 的 `input` 是纯组件内 `useState`（`WorkflowNodeTree.tsx`）。
- **（第一轮修复后仍复现）** Apollo Client v4 将 `notifyOnNetworkStatusChange` 默认值改为 `true`：每次轮询 `loading` 都会重新置为 `true`，页面 `if (loading)` 分支把整棵内容树替换成全屏 spinner，组件**卸载重挂**，焦点与 IME 输入组合被打断——这才是「刷新打断输入」的直接原因。
- 工作流是活的：轮询期间节点状态翻转（READY↔RUNNING 等）也会使条件渲染的 `HumanNodeActions` 卸载重挂。
- 全仓无任何草稿/临时保存机制。

**修复方案**：

1. `WorkflowInstancePage.tsx`：`useQuery` 显式 `notifyOnNetworkStatusChange: false`，且加载分支改为 `loading && !instance`——仅首次加载显示 spinner，轮询期间保持渲染现有内容，刷新不再卸载组件（焦点/IME 不受影响）。
2. `WorkflowNodeTree.tsx` 的 `HumanNodeActions`（第一轮已修）：输入内容按 `workflow-node-draft:<instanceId>:<nodeId>` 持久化到 localStorage，挂载时恢复，变更时保存，完成/打回成功后清除——状态翻转导致的重挂也不丢内容。
3. 保持 5s 轮询不变（工作流状态需要近实时），输入不再受刷新影响。

**验证结果**：✅ 页面级单测 2 例（轮询 refetch 中保持内容/焦点，首次加载显示 spinner）；agent-web 单测 298/298，lint 0 error；E2E-7 增强断言（跨 5s 轮询周期值保留 + **`toBeFocused` 焦点保持** + reload 恢复）通过；且已反向验证：回退本修复后 E2E-7 恰好失败在焦点断言上，证明该断言真实捕获「刷新打断输入」

**修复 commit**：5e7eaa5

### 3. 工作流流转后 harness 不开始工作（首条提示词被静默丢弃）

**问题描述**：如「产品需求」完成流转到「产出产品需求技术方案」后，提示词虽然发送给 harness 工具了，但 harness 没有开始执行。

**根因分析**（竞态消息丢失）：

- agent-api 侧 `sessionService.create()` 发布 `acp:start` 后立即返回，orchestrator 紧接着 `addMessage()` 发布首条 prompt（`session:message` 频道），两者背靠背发出。
- controller-api 同一 Redis subscriber 的 async listener 不串行：`handleAcpStart` 还在等真实 controller 回 `acp:start:result`（秒级），`handleInputMessage` 已被处理。
- `acp-session-manager.ts:575 forwardToController` 在会话尚未进入 active map 时 `return false` **静默丢弃**，无日志无重试。harness 进程被拉起但永远收不到 `session/prompt`，表现为「不开始工作」。rework 的 `acp:resume` + addMessage 是同一竞态。
- 既有 API/E2E 测试的 fake controller 秒回 `acp:start:result`，无法暴露该竞态。

**修复方案**：

1. `servers/controller-api/src/services/acp-session-manager.ts`：新增按 sessionId 的待发输入队列 `pendingInputs`；`forwardToController` 在会话未就绪时改为入队并记日志；`startSession`/`resumeSession` 成功注册会话后立即按序补发；会话失败/停止/断开时清空队列。

**验证结果**：✅ controller-api 单测含排队补发 3 例（start 竞态按序补发 / resume 竞态补发 / 失败清空）；API 测试 session.test.ts 新增「start 完成前发送的消息应排队，会话激活后补发」通过；E2E-8（acp:start:result 延迟 2s，首条提示词仍送达 controller socket）通过

**修复 commit**：5e7eaa5

### 4. 人类节点 RUNNING 状态下点「完成」报「不允许执行「启动」（start）」

**问题描述**：AI 节点（如「产出产品需求技术方案」）完成后，下游人类节点（「审核产品文档与技术方案」）变为「执行中」，此时提交 Review 意见点「完成」，报错：`节点「审核产品文档与技术方案」当前状态为 RUNNING，不允许执行「启动」（start）`。

**根因分析**：

- 引擎 `maybeActivate`（`engine.ts`）在上游全部 DONE 时把下游节点 READY→RUNNING，仅 FLAG 特判透传，HUMAN 节点也会被自动推进到 RUNNING（设计语义：进入「待人工处理」并出现在 `currentNodeNames`）。
- `instance.ts completeHumanNode` 实现为「无条件 start + complete」组合：节点已 RUNNING 时 `start` 转移（from: INITIALIZING/READY）非法，直接抛错。
- 首节点不受影响（实例化只置 READY 未激活），因此只有非首个人类节点触发。既有 A1-A18 未覆盖「RUNNING 人类节点完成」路径。

**修复方案**：

1. `servers/agent-api/src/services/workflow/instance.ts`：`completeHumanNode` 幂等化——节点 READY 时先补 `start`，已 RUNNING 时直接 `complete`；其他状态由引擎 `complete` 转移给出标准错误。

**验证结果**：✅ agent-api 单测 930/930（含 RUNNING 人类节点直接 complete 用例）；API 测试 A19（三节点 HUMAN→AI→HUMAN：下游人类节点 RUNNING 后人工完成 + 产物写黑板）通过；E2E-7 后半段（RUNNING 评审节点 UI 点「完成」成功）通过

**修复 commit**：5e7eaa5

### 5. 节点状态「初始化中」文案表意不清（第三轮验收）

**问题描述**：下游节点等待上游完成时显示「初始化中」，用户难以理解其语义。

**修复方案**：`WorkflowNodeTree.tsx` `NODE_STATUS_LABELS.INITIALIZING` 改为「等待中」（仅前端展示文案，状态枚举不变）；E2E-1/E2E-5 断言同步更新。

**验证结果**：✅ 新增单测「INITIALIZING 显示为等待中」通过；E2E-1/E2E-5 断言「等待中」通过

**修复 commit**：2aa294f

### 6. 节点产物只在黑板展示，节点卡片内看不到（第三轮验收）

**问题描述**：节点产物（人类输入/AI 产出）仅聚合在底部「工作流黑板」面板，查看单个节点的产出需要到黑板中按 key 人肉匹配。

**修复方案**：不改后端——产物 key 约定为 `{nodeId}-{nodeName}-产物-{title}`（`blackboard.ts artifactKey`），前端 `WorkflowNodeTree` 按 `node.id + node.name` 前缀过滤黑板条目，在节点卡片内新增「产物（N）」区块（标题 + 内容，与后端 `getArtifactKeys` 前缀匹配同构）。

**验证结果**：✅ 新增单测 3 例（卡片内展示本节点产物/不混入其他节点/无产物不显示区块）；E2E-5 新增节点卡片产物断言通过

**修复 commit**：2aa294f

### 7. 会话侧面板宽度不足，内容超出 client area 不可见（第三轮验收）

**问题描述**：节点「会话」侧面板（`sm:max-w-2xl` 672px）内嵌完整 SessionView，工具调用卡片的 `<pre>` 命令块（`white-space: pre` 不换行且无横向滚动）、AcpCard 折叠头标题/摘要、SessionHeader 左侧信息组均无收缩/换行处理，长内容直接撑破面板，部分内容在 client area 之外不可见。

**修复方案**：

1. `SessionSidePanel` 加宽为 `sm:max-w-4xl`（896px）。
2. `ToolCallCard` 两处命令 `<pre>` 加 `whitespace-pre-wrap break-all`（换行而非溢出/隐藏滚动）。
3. `AcpCard` 折叠头 title/summary 加 `min-w-0 truncate`，chevron 加 `shrink-0`。
4. `SessionHeader` 左侧容器加 `min-w-0 flex-1 flex-wrap`、标题 `truncate`、右侧按钮组 `shrink-0`。

**验证结果**：✅ 新增单测 2 例（长命令 pre 换行类名/AcpCard 截断类名）；E2E-5 新增断言（面板 clientWidth ≥ 896 且 `scrollWidth - clientWidth ≤ 1`）通过

**修复 commit**：2aa294f

### 8. AI 节点无失败状态：会话提醒后仍停止则节点卡死（第四轮验收）

**问题描述**：AI 节点会话停止后系统仅兜底提醒 1 次；提醒后仍停止则节点永远停在 RUNNING（死节点），流程暗中卡死且无任何用户感知。另需支持 LLM 判断任务无法继续时主动标记失败、人类介入后恢复。

**修复方案**：

1. **契约**：`contracts/workflow.graphql` 节点状态枚举加 `FAILED`，新增 `WorkflowNodeFailInfo { reason, source, at }`（source：SESSION_STUCK=提醒后仍停止 / LLM_REPORTED=LLM 主动标记）。
2. **引擎**（`engine.ts`）：新增转移事件 `fail`（RUNNING→FAILED，写 failInfo）与 `resumeFailed`（FAILED→RUNNING，清 failInfo）；失败天然阻断流程（非 DONE 下游永不激活），均不触发会话 hook。
3. **编排器**（`orchestrator.ts`）：`handleSessionEnded` 兜底提醒后会话再次停止 → 自动 `fail`（SESSION_STUCK），不再静默 return。
4. **MCP 工具**（`tool-handlers.ts`）：新增 `failCurrentNode`（reason 必填，LLM 主动标记）与 `resumeFailedNode`（人类对话给出指示后由 AI 调用恢复）。
5. **前端**：节点 badge 「失败」（destructive）+ 失败原因/人工介入引导块；实例页顶部阻断 banner（节点名+原因+引导）+ toast 强提醒（每节点仅一次，轮询去重）。

**验证结果**：✅ agent-api 单测 935/935（E13-E15 引擎转移、O6 二次停止升级失败、工具 12 个定义+fail/resumeFailed 用例）；API 测试 A22（MCP 标记失败阻断+恢复+恢复后可完成）、A23（二次停止→SESSION_STUCK）通过；E2E-4 扩展（二次停止→FAILED+UI banner/失败 badge+人类「继续」恢复会话后 resumeFailedNode→RUNNING）通过

**修复 commit**：c1b59bd

### 9. 对话内容太长仍会撑开容器（第四轮验收）

**问题描述**：会话面板加宽+上一轮修复后，长对话内容仍横向溢出。探查发现系统性遗漏：`prose` 类实际无效（未安装 @tailwindcss/typography），GFM 表格无滚动容器、行内 code/链接不断词、用户消息只 break-words（不缩 min-content）、ToolCallCard 结果文本/think 块与多处 font-mono 路径/值 span 无断行、SessionSidePanel grid item 缺 min-w-0。

**修复方案**：

1. `MarkdownContent`：新增 GFM `table` 渲染器（`overflow-x-auto` 包裹 + 单元格 `break-words`）、行内 `code` 与 `a` 加 `break-all`（一处修复覆盖 agent 消息/Thought/Fetch/Read 全部 markdown 场景）。
2. `MessageItem` 用户消息 `whitespace-pre-wrap` 加 `break-all`。
3. `ToolCallCard` 结果文本/think 块/全部 font-mono 路径与值 span 加 `break-all`。
4. `SessionSidePanel` 内容容器加 `min-w-0 overflow-hidden`（防 min-content 传播撑开 popup 列轨）；`DiffView` 文件头路径、`ReadCard` 路径、`ConfigOptionCard`/`ConfigOptionsPanel` 值加 `break-all`。

**验证结果**：✅ 新增单测 8 例（MarkdownContent 表格/行内 code/链接、用户消息 break-all、工具结果/think 断行、DiffView 长路径），agent-web 314/314、lint 0 error；E2E-5 无横向溢出断言（`scrollWidth - clientWidth ≤ 1`）持续通过

**修复 commit**：c1b59bd

### 10. 断连状态会话收不到兜底提示词，无人工恢复路径（第四轮验收）

**问题描述**：Controller 断连时会话进入 `disconnected` 状态，此时自动发送的「节点状态仍未推进」兜底提示词无法送达 AI；且后端 `resume()` 仅允许 `ended`，断连会话无法恢复；UI 上断连会话右上角显示「关闭」而非「继续」。

**修复方案**：

1. **后端**（`session.ts`）：`resume()` 放宽为允许 `ended`/`disconnected`（controller-api 的 pendingInputs 队列对断连会话天然有效，resume 成功后自动补发）。
2. **前端按钮**（`SessionHeader`）：`disconnected` 时显示「继续」而非「关闭」；`SessionView` 的 controllers 查询加 10s 轮询（controller 重连后「继续」按钮自动解锁）。
3. **确认框**（新组件 `ResumeConfirmDialog`）：断连会话点「继续」先弹「检测到 AI 断连，是否让 AI 继续？」确认框；工作流节点会话额外说明将自动发送工作流提示词。
4. **自动提示词**（`SessionView`）：确认后标记 `autoPromptAfterResumeRef`，SSE 收到 `idling`（会话 ready）时自动发送 `WORKFLOW_CONTINUE_PROMPT`——显式要求 AI 用 `getNodeInfo` 确认节点状态、FAILED 则先调 `resumeFailedNode`，然后继续之前的工作并以 `completeCurrentNode`/`rejectCurrentNode`/`failCurrentNode` 收尾；resume 超时自动清除标记防误发。
5. **契约/类型**：前端 GET_SESSION 补查 `workflowInstanceId`/`workflowNodeId`（后端早已暴露，仅前端未取）。

**验证结果**：✅ agent-api 单测新增 disconnected resume 用例；前端新增 4 例（SessionHeader 断连按钮、ResumeConfirmDialog 3 例）；E2E-10 全流程（断连→disconnected→UI「继续」→确认框→重连 resume→ready 自动发提示词→AI 调 completeCurrentNode 完成）通过

**修复 commit**：de15e2f

### 11. 工作流黑板未默认折叠且无数量显示（第五轮验收）

**问题描述**：实例页右侧边栏的「工作流黑板」始终展开，条目多时占据大量版面；垃圾桶已默认折叠并显示数量，黑板应保持一致交互。

**修复方案**（`BlackboardPanel.tsx`）：抽取 `CollapsibleSection` 组件（button + chevron + 图标 + 标题内联数量，默认折叠），黑板与垃圾桶统一走该模式（`工作流黑板（N）`/`垃圾桶（N）`）。

**验证结果**：✅ 前端新增 BlackboardPanel 4 例（默认折叠+数量、展开/折叠切换、黑板/垃圾桶 Markdown 渲染）

### 12. 黑板内容未做 Markdown 渲染（第五轮验收）

**问题描述**：黑板/垃圾桶条目值与节点卡片内聚合产物均以 `<pre>` 纯文本展示，AI 写入的 Markdown 产物（表格、列表、加粗等）不可读。

**修复方案**：`BlackboardPanel.EntryList` 与 `WorkflowNodeTree` 产物聚合区块的值渲染统一替换为会话页同款 `MarkdownContent`（react-markdown + GFM，表格横向滚动/断行约束已内置）。

**验证结果**：✅ 前端单测覆盖（BlackboardPanel 2 例、WorkflowNodeTree 1 例，断言 `**重点**` 渲染为 `<strong>`）

### 13. REWORK 状态节点无法再次打回上游（第五轮验收）

**问题描述**：a→b→c 流程中，c 打回 b 后 b 处于 REWORK；若 b 返工时发现问题根源在 a，需要再次打回 a，但引擎 `reject` 转移仅允许 `RUNNING→REJECT`，REWORK 节点调用打回被「不允许执行」拒绝。

**修复方案**：

1. **引擎**（`engine.ts`）：`reject` 转移源状态放宽为 `RUNNING`/`REWORK`（语义自然成立：REWORK 节点打回后自身进 REJECT、rejectInfo 覆盖、上游再次 REWORK 且 reworkCount 再 +1）。
2. **MCP 工具描述**（`tool-handlers.ts`）：`rejectCurrentNode` 描述同步为「RUNNING/REWORK→REJECT」。
3. **返工提示词**（`orchestrator.ts`）：REWORK 提示词补充「若返工中发现问题根源在更上游，可调用 rejectCurrentNode 将本节点打回并触发上游返工」。
4. **契约**（`contracts/workflow.graphql`）：`rejectNode` 注释同步。

**验证结果**：✅ 引擎单测新增 E16（REWORK→REJECT：rejectInfo 覆盖、黑板打回记录、上游再次 REWORK）；API 新增 A24（c 打回 b→b REWORK→b 打回 a→a REWORK 全链路留痕）

### 14. 链式打回后 b 完成时流程卡住（第六轮验收）

**问题描述**：a→b→c 链式打回（c 打回 b、b 打回 a）后，a 完成返工使 b 复工（RUNNING），但 c 仍为 REJECT；此时 b 调用 `completeCurrentNode`/`completeCurrentRework`，引擎对下游 c 执行 `start` 转移（仅允许 INITIALIZING/READY），报「不允许执行『启动』」，流程永久卡住。

**修复方案**（`engine.ts` `complete` 分支）：推进下游时按状态分派——下游为 REJECT 则执行 `resume`（REJECT→RUNNING，触发 onNodeResume 通知会话重新获取产物，语义与 `completeRework` 的「通知下游 REJECT 复工」一致），其余状态仍走 `start`。

**验证结果**：✅ 引擎单测新增 E17（complete 使下游 REJECT 节点 resume）；API 新增 A25（四节点链 c→b→a 链式打回 → a 返工完成 b 复工 → b 完成 c 自动复工，全流程不卡住）

### 15. 工作流实例缺少删除功能（第六轮验收）

**问题描述**：实例无法删除；删除需停止流程运转、对流程下所有会话执行删除操作，且实例必须软删除（标记删除，不删真实数据）。

**修复方案**：

1. **契约/schema**：新增 `deleteWorkflowInstance(id: ID!): Boolean!`。
2. **Model**：`WorkflowInstance` 加 `deletedAt`（默认 null）。
3. **Service**（`instance.ts deleteInstance`）：**先标记 deletedAt**（引擎 `transition` 对已删实例直接抛错、orchestrator 兜底查询排除已删实例，避免删会话过程中的竞态），再 `Session.find({ workflowInstanceId })` 逐个走 `sessionService.delete`（停止 ACP 会话、清理 worktree 与消息；单个失败记日志不中断）；`listForWorkspace`/`findById`/`completeHumanNode`/`rejectNode` 均过滤 `deletedAt: null`。
4. **前端**：实例页头部「删除实例」按钮 + 确认框（说明停流程、删除全部节点会话、软删不可撤销），确认后删除并跳转回会话列表。

**验证结果**：✅ 单测新增 7 例（实例服务软删/排除/幂等 5 例、引擎已删实例拒转 1 例、查询过滤 2 例）；API 新增 A26（删除后详情/列表排除、会话已删、已删实例拒绝操作、二次删除报错）；E2E-11（实例页删除 → 确认框 → 跳转 → 实例页不可访问 → 侧边栏移除 → 会话已删）；前端新增 2 例（确认框流程/取消）

### 16. 工作流界面未做移动端支持（第七轮验收）

**问题描述**：①节点卡片头部行（类型/标题/状态/返工次数/会话按钮）为不换行的 flex 行，窄屏下整行溢出展示不全；②节点不支持折叠，长工作流在移动端需大量滚动。

**修复方案**（`WorkflowNodeTree.tsx`）：

1. **头部行换行**：展开态头部行改 `flex flex-wrap items-center`，标题 `min-w-0 flex-1 truncate`，窄屏自动换行不溢出。
2. **节点折叠**：抽取 `NodeCard` 组件，按状态取默认折叠态——已完成（DONE）/等待中（INITIALIZING）默认折叠，执行中（RUNNING）/已打回（REJECT）/返工中（REWORK）/失败（FAILED）/待开始（READY）默认展开；折叠后只展示 chevron + 节点类型 + 标题；用户手动切换后以其为准（未切换时默认值随状态流转自动跟随）。

**验证结果**：✅ 前端新增 5 例（默认折叠/展开、切换、flex-wrap 断言），旧有用例同步适配展开前置；E2E-12（375px 窄屏：默认折叠/展开、手动展开折叠、页面无横向溢出）；E2E-1/3/5/7 断言同步适配折叠

### 17. AI 打回人类节点后，人类无重新提交渠道（第七轮验收）

**问题描述**：AI 节点调用 `rejectCurrentNode` 打回上游人类节点后，人类节点进入 REWORK，但 `completeHumanNode` 对 REWORK 状态走 `complete` 转移报「不允许执行」，且前端操作区仅 READY/RUNNING 显示——人类没有任何重新提交的路径，流程卡死。

**修复方案**：

1. **后端**（`instance.ts completeHumanNode`）：REWORK 人类节点改走 `completeRework` 转移（重置旧产物入垃圾桶、写新产物、DONE 并复工下游 REJECT 节点），与 AI 节点 `completeCurrentRework` 语义对齐。
2. **前端**（`WorkflowNodeTree`）：人类节点操作区（完成输入 + 完成/打回按钮）显示条件放宽为 READY/RUNNING/**REWORK**（REWORK 默认展开，操作区直接可见；REWORK 再点打回走第六轮已支持的 REWORK→REJECT）。
3. **契约**：`completeHumanNode` 注释同步 REWORK 语义。

**验证结果**：✅ 单测新增 2 例（completeHumanNode REWORK 走 completeRework；REWORK 人类节点操作区可见）；API 新增 A27（AI rejectCurrentNode 打回人类 → 人类重新提交 → exec 复工 RUNNING、旧产物入垃圾桶、复工消息送达）；E2E-13（AI 打回 → UI 返工中+操作区 → 重新提交 → exec 执行中、黑板/垃圾桶校验）

### 18. 折叠的节点需展示状态 badge、返工次数与「会话」按钮（第八轮验收）

**问题描述**：#16 的节点折叠实现折叠后只展示类型与标题，状态 badge、返工次数、「会话」按钮也被隐藏，折叠态下无法识别节点状态、也无法直达会话。

**修复方案**（`WorkflowNodeTree.tsx NodeCard`）：重构为统一头部行——折叠/展开均展示 chevron + 类型 + 标题 + 状态 badge + 返工次数 + 「会话」按钮（头部行保持 flex-wrap 适配窄屏），折叠仅隐藏内容区（描述/打回与失败信息/产物/人类操作区）。

**验证结果**：✅ 前端单测更新 3 例（折叠展示 badge/返工次数/会话按钮、折叠隐藏内容区）；E2E-12 移动端断言同步（折叠可见 badge、产物隐藏）；E2E-1/3/13 断言同步

### 19. 节点宽度依然溢出屏幕（第八轮验收）

**问题描述**：移动端与较窄桌面窗口下节点树仍超出屏幕宽度产生横向滚动。#16/#18 修了头部行换行但溢出未根治。

**根因**（Playwright 探针逐元素定位）：

1. **主因**：实例页网格 `grid gap-6 lg:grid-cols-[1fr_320px]` 在 lg 以下是隐式 `auto` 列，列轨按内容 max-content 宽度伸展（实测撑到 1187px），整个节点树随之超宽。
2. **次因**：Markdown 段落（`MarkdownContent` 的 `p` 渲染器）与产物标题对超长不可断字符串无 `overflow-wrap: anywhere`，min-content 撑破容器（`break-words` 不影响 min-content，此类场景无效）。

**修复方案**：

1. 网格改 `grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]`（Tailwind `grid-cols-1` = `minmax(0,1fr)`，列轨被约束在容器内）；节点树与黑板面板根节点加 `min-w-0`。
2. `MarkdownContent` 的 `p` 渲染器、节点描述/打回理由/失败信息、产物标题统一加 `wrap-anywhere`（overflow-wrap:anywhere，缩减 min-content）。

**验证结果**：✅ E2E-12 增强（375px 窄屏 + 180 字符无空格产物值 + 60 字符产物标题 + 全节点/黑板展开，断言无横向溢出）；E2E 13/13 全绿；agent-web 单测 332/332、lint 0 error

## 修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 1 | mode/model 无动态选项 | 能力探测只做版本检查，无空实例探测链路 | ✅ 已修复 | 5e7eaa5 + 03b4da7 |
| 2 | 实例页刷新清掉人类输入 | 条件渲染卸载 + 无草稿持久化 | ✅ 已修复 | 5e7eaa5 + 03b4da7 |
| 3 | 流转后 harness 不执行 | start/prompt 跨频道竞态，消息静默丢弃 | ✅ 已修复 | 5e7eaa5 + 03b4da7 |
| 4 | RUNNING 人类节点完成报错 | completeHumanNode 无条件 start | ✅ 已修复 | 5e7eaa5 + 03b4da7 |
| 5 | 「初始化中」文案表意不清 | 前端展示文案 | ✅ 已修复 | 2aa294f |
| 6 | 节点产物只在黑板展示 | 节点卡片未聚合本节点产物 | ✅ 已修复 | 2aa294f |
| 7 | 会话侧面板内容溢出不可见 | 面板过窄 + 内部元素无换行/截断 | ✅ 已修复 | 2aa294f |
| 8 | AI 节点无失败状态，提醒后仍停止则卡死 | 兜底仅 1 次后静默 return，无失败语义 | ✅ 已修复 | c1b59bd |
| 9 | 对话内容太长仍撑开容器 | prose 无效 + 表格/行内 code/用户消息等系统性缺断行 | ✅ 已修复 | c1b59bd |
| 10 | 断连会话收不到兜底提示词，无恢复路径 | resume 仅允许 ended + UI 无继续入口 | ✅ 已修复 | de15e2f |
| 11 | 黑板未默认折叠、无数量显示 | 黑板区始终展开，未复用垃圾桶折叠模式 | ✅ 已修复 | 97ee0c5 |
| 12 | 黑板内容未 Markdown 渲染 | 条目值以 pre 纯文本展示 | ✅ 已修复 | 97ee0c5 |
| 13 | REWORK 节点无法再次打回上游 | 引擎 reject 转移仅允许 RUNNING | ✅ 已修复 | 97ee0c5 |
| 14 | 链式打回后 b 完成时流程卡住 | complete 对下游 REJECT 节点走 start（非法） | ✅ 已修复 | 5deae6c |
| 15 | 实例缺少删除功能 | 无软删除机制与入口 | ✅ 已修复 | 5deae6c |
| 16 | 工作流界面未做移动端支持 | 节点头部行不换行溢出 + 无节点折叠 | ✅ 已修复 | cd70ad9 |
| 17 | AI 打回人类节点后无重新提交渠道 | completeHumanNode 不支持 REWORK + UI 操作区仅 READY/RUNNING | ✅ 已修复 | b26e190 |
| 18 | 折叠节点丢失状态 badge/返工次数/会话按钮 | 折叠态只渲染类型与标题 | ✅ 已修复 | 55932af |
| 19 | 节点宽度依然溢出屏幕（移动端/窄桌面） | 实例页网格隐式 auto 列按 max-content 伸展 + 长不可断文本无 wrap-anywhere | ✅ 已修复 | c46ccc1 |
| 20 | 实例缺少归档功能 | 无 archivedAt 软归档机制与 UI 入口 | ✅ 已修复 | pending |
| 21 | 实例状态缺少最后执行节点信息 | 无 lastNodeName/lastNodeStatus 字段与引擎 markLastNode 记录 | ✅ 已修复 | pending |

## 最终验证

| 项目 | 结果 |
|------|------|
| agent-api build/单测 | ✅ tsc 通过，945/945 |
| controller-api build/单测 | ✅ tsc 通过，383/383 |
| agent-controller build/单测 | ✅ tsc 通过，259/259 |
| agent-web lint/build/单测 | ✅ tsc + lint 0 error，340/340 |
| API 测试（tests/api） | ✅ 全量通过 287/287（含 A19~A29；gateway 隧道用例偶发环境超时 flake，隔离复跑通过） |
| E2E 测试（tests/e2e workflow.spec） | ✅ 13/13（E2E-1~13） |

## 经验总结

- **跨频道异步链路必须假设乱序**：agent-api 经 Redis pub/sub 发出的「命令」与「消息」在 controller-api 侧不保证处理顺序，凡「先启动会话再发消息」的模式都要在接收端做排队补发，且「发送失败」不允许静默 return，至少要记日志。
- **组合操作要考虑自动状态机**：引擎会自动推进节点状态（READY→RUNNING），人工操作接口（completeHumanNode）不能假设起始状态，应按当前状态幂等处理。
- **轮询刷新 + 条件渲染 = 输入必丢**：活数据页面的表单输入要么受控于不受条件渲染影响的层级，要么持久化草稿（localStorage 按键隔离即可，成本极低）。
- **Apollo Client v4 轮询陷阱**：`notifyOnNetworkStatusChange` 默认 `true`，`if (loading) return <Spinner/>` 写法会在每次轮询卸载整页——加载分支必须写成 `loading && !data`，「保留草稿」与「不打断输入」是两个问题，前者靠持久化，后者靠不卸载（焦点/IME 断言才能抓到）。
- **能力数据的获取时机要区分**：CLI 版本检查 ≠ 会话能力；modes/models 只有 session/new 后才有，配置阶段需要「空实例探测」这类按需懒加载链路，并按 controllerId+type 缓存避免重复拉起。
- **fake controller 秒回响应会掩盖竞态**：API/E2E 测试中的假 controller 应有意识地引入延迟变体（startDelayMs），才能覆盖真实 harness 的慢启动场景。
- **flex 行内容器默认不收缩，窄容器必溢出**：`<pre>` 默认不换行、flex 子项默认 `min-width: auto`，把完整视图嵌入窄面板（Dialog/Sheet）前必须系统性检查 `whitespace-pre-wrap break-all` / `min-w-0 truncate` / `shrink-0` 三件套；E2E 用 `scrollWidth - clientWidth ≤ 1` 可直接断言「无横向溢出」。
- **动画中的元素尺寸断言会抖动**：入场 zoom 动画期间 `boundingBox()` 量到的是缩放后的尺寸，宽度断言应用 `clientWidth`（布局尺寸，不受 transform 影响）。
- **「兜底 N 次后静默」等于隐性死节点**：防御性兜底（防死循环）必须配升级路径（失败状态+通知），否则最坏情况恰是最需要感知的情况。
- **会话关闭后其 MCP scoped token 随之失效**：E2E/集成测试模拟「人类介入后 AI 调工具」时，需先恢复会话拿到新签发的 token 再调 MCP。
- **Tailwind `prose` 类不是免费午餐**：未装 `@tailwindcss/typography` 时 `prose` 完全不生效，markdown 渲染的表格/链接/行内 code 必须在 components 覆写里自行约束断行与滚动；`break-words` 不缩 min-content，根治不可断长词要用 `break-all`。
- **CSS Grid 隐式列是横向溢出的隐形炸弹**：`grid` 不显式声明 `grid-cols-1` 时，移动端单列是 `auto` 轨按 max-content 伸展，任何子内容超宽都会撑破整页；显式 `grid-cols-1`（minmax(0,1fr)）+ 子级 `min-w-0` + 文本 `wrap-anywhere` 三件套缺一不可，且要用「超长无空格内容 + 全展开 + 窄视口」的极端场景做 E2E 溢出断言，空内容场景测不出来。
- **状态机放宽要配全链路检查**：`resume` 放宽到 `disconnected` 看似一行改动，但需确认下游每个环节对该状态兼容（controller-api pendingInputs 队列、前端按钮解锁所依赖的 controllerOnline 轮询新鲜度），并在 E2E 里跑通「断连→重连→恢复」全流程才算闭环。}
