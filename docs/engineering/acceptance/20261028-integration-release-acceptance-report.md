---
description: integration→release 集成验收报告（PR #337）——对话渲染重构（Issue #332，PRD v1.1）集成验收首轮：对 git diff origin/release...integration（11 提交 / 59 文件 / +5316 −294）做集成级 AI 代码评审 + 本机独立验证（tsc/lint/单测 848/e2e typecheck/9 组实机探针），发现 2×🔴 + 16×🟠 + 15×🟡——🔴 R-1 导出对话静默截断历史（只导出已加载 25 条窗口却提示「已导出对话」，功能点 6「整段对话导出」主场景失效）；🔴 R-2 交付的 E2E-CREN2 确定性红（3 条无 messageId chunk 被相邻合并 + join('') 粘连围栏成单个非法 mermaid 块，remark-parse AST 实证，mermaid-block 定位器永不命中）；🟠 含工具生命周期退化残留（创建事件缺失时标题退化「Tool Call: Tool Call」+ 原始输入入口整体消失、失败态输出不渲染）、group-messages 未防护 JSON.parse 整页崩溃、diff 尾行无换行误报且测试固化错误对齐、Mermaid 错误图残留 document.body、ansi 剥离器三类边界（未终结 DCS 吞全部后续输出/截断序列乱码/冒号真彩乱码）、导出三缺陷（流式分片不合并/content 结果摘要丢失/纯文本混入 UI chrome）、滚动跟随双竞态、E2E-CREN5 负向断言恒真、TerminalOutput 测试未按计划交付、功能点 7 验收无断言、resource_link 无协议白名单；首轮打回（REJECT）
type: Permanent
---

# integration→release 集成验收报告（2026-10-28，AI Review）

> **状态**: 🔄 **首轮 AI 集成评审完成，发现 2 × 🔴 + 16 × 🟠 + 15 × 🟡，按节点定义打回（REJECT）**。评审对象为 `git diff origin/release...integration`（11 提交 / 59 文件 / +5316 −294，全部落点 `apps/agent-web` 对话渲染层 + docs + tests/e2e，无后端/契约变更）。两处 🔴 均经独立实证：R-1 导出链路静态核对 + 实机导出探针证实「仅导出已加载窗口」；R-2 经 remark-parse AST 实机解析证实三段围栏粘连为单个非法 mermaid 块、`mermaid-block` 定位器永不命中。🟠 全部由主评回读源码逐条复核并附 file:line 证据（其中 9 项经 P1~P9 实机探针实证）。单测五包仅 `apps/agent-web` 被本 diff 触及，848/848 全绿；交付的 E2E 套件本身存在确定性红用例（R-2），Aspire 全栈 tests/e2e 实跑列为下轮门禁。要求返工：修复全部 🔴/🟠、收口 🟡、补齐测试区分力后带全栈证据复核。

## 关联文档

- PRD：`docs/product/draft/20261028-conversation-rendering.md`（v1.1，Issue [#332](https://github.com/Deliay/z-agent-gear/issues/332)）
- 技术提案：`docs/engineering/proposals/20261028-refactor-conversation-rendering.md`
- 实现计划：`docs/engineering/plan/20261028-refactor-conversation-rendering.md`
- 分支：`integration` @ `34745215`（= `origin/main`），目标分支 `release` @ `c458f97f`；PR [#337](https://github.com/Deliay/z-agent-gear/pull/337) `OPEN / MERGEABLE`（integration→release，"Integration branch reset to latest main"，11 commits）
- 上游产物：① 节点「切出集成分支」——integration 重置基线 `origin/main @ 34745215`、PR #337 创建完成；② 节点「修复Review意见」——核查 PR #337 无人类 Review 意见（reviews/comments/reviewDecision 均空、reworkCount=0）→ 本轮为**集成级首次 AI 代码评审**
- 验收方式：AI 代码评审（`git diff origin/release...integration`）+ 四域并行深度评审（① 工具调用卡片与状态；② Markdown/代码块/Mermaid/Diff/ANSI；③ 消息列表/操作/滚动/导出；④ 文档/依赖/E2E 一致性）+ 主评对全部 🔴/🟠 逐条回读源码复核 + **本机独立验证**（tsc/lint/单测复跑、tests/e2e typecheck、P1~P9 实机探针、remark-parse AST 探针；不采信自报）
- 验收日期：2026-10-28

## 一、验收范围与方法

### 1.1 变更范围

| 范畴 | 内容 | 主要落点 |
|---|---|---|
| Markdown 渲染增强 | 代码块工具栏（语言标签/复制/换行）、Mermaid 图形渲染（动态导入/缩放/源码切换/主题跟随/错误回退） | `components/session/markdown/{CodeBlock,MermaidBlock}.tsx`、`MarkdownContent.tsx` |
| 差异/终端渲染 | jsdiff 真实差异 + 双行号、ANSI SGR 颜色/粗体保留 + 非展示序列剥离 | `lib/{diff,ansi}.ts`、`DiffView.tsx`、`TerminalOutput.tsx` |
| 工具调用卡片增强 | 生命周期合并（tool-call-state 三态语义）、图标体系、原始输入/输出折叠、特化卡片（Read/Fetch/SubAgent/Acp）迁移 | `tool-call-state.ts`、`ToolCallCard.tsx`、`ToolCallRawSection.tsx`、`ContentBlockRenderer.tsx` |
| 消息操作/滚动/导出 | 复制 Markdown/纯文本、导出对话为 Markdown、跟随暂停 + 回到底部按钮 | `MessageActions.tsx`、`lib/export-thread.ts`、`ScrollToBottomButton.tsx`、`MessageList.tsx` |
| 计划展示增强 | 三态条目（删除线/进行中/待办）+ 完成计数 | `plan-summary.ts`、`PlanCard.tsx`、`PlanFloatingCard.tsx` |
| 测试/文档 | 单测 +18 文件（含 tool-call-state/ansi/diff/export 等纯函数层）、E2E-CREN1~8、PRD/提案/计划/4 份 AGENTS.md | `tests/e2e/src/session-rendering.spec.ts`、`docs/` |

### 1.2 评审与验证方法

1. **四域并行深度代码评审**（逐文件通读 diff + 变更后全文 + 调用方交叉核对），对照 PRD 3.2 功能点 1~8 验收标准与 4.2 安全要求逐条核对。
2. **主评交叉复核**：全部 🔴/🟠 由主评回读源码逐条确认（附 file:line；R-2 另有 remark-parse AST 实证，R-6~R-9 另有 P1~P9 探针实证）。
3. **本机独立验证**：`apps/agent-web` tsc/eslint/vitest 全量复跑、`tests/e2e` typecheck。**不采信自报数据**。
4. **实机探针**：对 `computeDiff`/`ansiToHtml` 做 9 组边界输入探针（P1~P9，见 [第二节](#二独立验证结果本机实跑不采信自报)）；对 E2E-CREN2 合并结果做 remark-parse AST 解析探针。
5. **安全扫描**：XSS sink（dangerouslySetInnerHTML 清单）、`javascript:`/`data:` 伪协议、Mermaid securityLevel、复制/导出内容一致性。

### 1.3 判定红线（与历轮一致）

- 🔴 阻断 / 🟠 重要 → **打回返工**（本轮命中 2 × 🔴 + 16 × 🟠）
- 🟡 建议 → 记录并随修复项一并收口，不单独构成打回

## 二、独立验证结果（本机实跑，不采信自报）

| 服务/包 | 类型检查 | Lint | 测试 | 备注 |
|---|---|---|---|---|
| apps/agent-web | ✅ `tsc -b` 0 error | ⚠️ 0 error（新增文件）/ **2 error 存量** + 5 warning | ✅ **848 passed**（91 文件） | lint 2 error 均位于 `cloud-host/IssuesLinkageDialog.tsx`（`react-refresh/only-export-components`），该文件不在本 diff 且 eslint 配置未变，为 release 同款存量；warning 同为存量（`InstantiateWorkflowDialog`/`PlanCard` 等 hooks 依赖） |
| tests/e2e | ✅ `npm run typecheck`（tsc --noEmit）0 error（exit=0，需先 `servers/cloud-controller` `npm ci` 就绪——`admin-cloud-container.spec.ts` 跨包引用其源码） | — | ⚠️ 实跑未执行（需 Aspire 全栈，列为下轮门禁）；**交付的 CREN2 已 AST 实证必红（R-2）** | 新增 `session-rendering.spec.ts` 无类型错误 |
| servers/* / apps/admin-web | —（未复跑） | — | — | 本 diff 59 文件全部位于 `apps/agent-web`、`docs/`、`tests/e2e`（`git diff --stat` 佐证），无后端/契约变更 |

### P1~P9 实机探针（`computeDiff` / `ansiToHtml` 独立复现，输出经 JSON 序列化比对）

| 探针 | 输入 | 实测输出 | 证实 |
|---|---|---|---|
| P1 | `computeDiff('1\n2\n3\n4','1\n3\n4\n5')` | same 1 / removed 2 / same 3 / **removed 4 + added 4** / added 5 | 尾行无换行 → 内容相同的行 `4` 被误报为「删除+新增」修改对（R-6） |
| P2 | `computeDiff('a\nb\n','a\nb')` | same a / **removed b + added b** | 仅文件尾换行差异被误报为修改（R-6） |
| P3 | `computeDiff('a\r\nb\r\n','a\nb\n')` | 全文件 removed `'a\r','b\r'` + added `'a','b'` | CRLF→LF 全量重写噪声（R-7） |
| P4 | `computeDiff('a\r\nb\r\n','a\r\nc\r\n')` | same 行文本为 `'a\r'` | `\r` 残留行文本，pre-wrap 下行高翻倍（R-7） |
| P5 | `ansiToHtml('keep \x1bPtmux;unterminated…\nlater lines')` | `"keep "` | **未终结 DCS 吞掉其后全部输出**（R-9，数据丢失） |
| P6 | `ansiToHtml('before \x1b]0;window title')` | `"before 0;window title"` | 截断 OSC 泄漏参数乱码（R-9） |
| P7 | `ansiToHtml('before \x1b[38;5;2')` | `"before 38;5;2"` | 截断 CSI 泄漏参数乱码（R-9） |
| P8 | `ansiToHtml('\x1b[38:2::10:20:30mtruecolor')` | `":2::10:20:30mtruecolor"` | 冒号参数 SGR 真彩：颜色丢失 + 乱码（R-9） |
| P9 | `ansiToHtml('a\u0001SGR0\u0001b')` | `"ab"` | 占位符可被正文伪造，正文被删除（🟡 R-9 附项） |

### R-2 AST 探针（E2E-CREN2 合并结果的 CommonMark 解析）

对三条 chunk 经 `mergeMessageChunks` `join('')` 拼接后的文本做 remark-parse 解析，结果为**单个** `code` 节点：

```
[{ type: 'code', lang: 'mermaid',
   value: 'graph TD;\n  A-->B;\n``````mermaid\nthis is definitely not a diagram\n```after-mermaid-marker' }]
```

即：粘连行 ` ``````mermaid ` / ` ```after-mermaid-marker ` 均带 info string、不构成合法闭合围栏，三段内容塌成一个非法 mermaid 块 → 渲染必失败 → 走 `MermaidBlock.tsx:71-73` 回退分支（**不渲染 `mermaid-block` testid**）→ `spec:79` 定位器永不命中。

## 三、已验证（✅）

| 项目 | 结果 | 证据 |
|---|---|---|
| 核心退化修复（稀疏更新保留创建时标题/类型/参数） | ✅ | `tool-call-state.ts:62-84` 三态合并（未携带→保留 / 显式 null→清除 / 有值→替换），与 ACP SDK `ToolCallUpdate` patch 语义一致；`tool-call-state.test.ts` T-MERGE5 钉住替换语义；「完成后退化为 Tool Call: other」主形态已修复（**残余形态见 R-3/R-4**） |
| 代码块工具栏（功能点 1） | ✅ | 语言标签（无语言→`text`）、复制精确内容 + 成功/失败 toast（含 clipboard 拒绝负路径）、换行切换 `aria-pressed`、窄屏 `shrink-0` 不溢出（`CodeBlock.tsx`，T-CB1~6） |
| Mermaid 图形（功能点 2，错误残留除外） | ✅ | 动态 `import('mermaid')` 不入首屏、`securityLevel:'strict'`、语法错误回退 CodeBlock、缩放 0.5x~3x、源码切换、`dark` class MutationObserver 跟随（T-MM1~6） |
| 差异渲染常规对齐（功能点 3，边界除外） | ✅ | jsdiff 真实差异、双行号、语义色、`max-h-96` 限高、>2000 行截断提示、`oldText===null` 全新增不伪删（`diff.test.ts`、`DiffView.test.tsx`） |
| 终端 ANSI 主路径（功能点 4，边界除外） | ✅ | SGR 前景/背景/256 色/真彩/粗体保留；CSI 光标/清屏/私有模式/粘贴标记、OSC（含 OSC-8）、DCS/APC/PM 完整序列剥离（`ansi.test.ts` 13 用例） |
| 工具图标与状态视觉（功能点 5 部分） | ✅ | 10 类 kind→图标映射 + Hammer 兜底（`tool-call-icons.tsx`）、进行中/完成/失败/等待确认四态（`AcpCard.tsx`、`ToolCallCard.tsx:225-227`） |
| 图片/资源内容渲染 | ✅ | base64/URL 同口径 + onError 占位（`ContentBlockRenderer.tsx:7-30`）；资源链接 `target="_blank" rel="noreferrer"`（**协议白名单缺失见 R-18**） |
| 复制 Markdown / 剪贴板失败提示（功能点 6 部分） | ✅ | 原文透传不二次转义；`MessageActions.tsx:11-22` 拒绝/不可用均 toast.error（T-MA3） |
| 「回到底部」按钮机制（功能点 7 部分） | ✅ | 仅 `!isAtBottom` 渲染、新消息圆点、点击平滑滚底（`ScrollToBottomButton.tsx`，T-SB1~3）；**竞态与验收断言缺口见 R-12/R-17** |
| 计划展示（功能点 8） | ✅ | 已完成删除线（`PlanCard.tsx:76`、`PlanFloatingCard.tsx:97`）、计数与全量快照语义一致、全部完成态文案（`plan-summary.ts`，T-PLAN） |
| Markdown XSS 面 | ✅ | 原始 HTML/脚本转义不执行（react-markdown v10 无 rehype-raw）；`javascript:`/`data:` 链接被默认 `urlTransform` 清空；TerminalOutput `escapeXML: true` 转义 |
| Mermaid XSS 面 | ✅ | `securityLevel:'strict'`（T-MM1 防回归断言），SVG 过 DOMPurify；未发现绕过 |
| 导出文件名/失败提示/空会话/图片占位 | ✅ | `SessionView.tsx:506-518` try/catch + toast；`export-thread.ts` 空会话占位、图片「（图片内容未导出）」不夹带 base64 |
| 工具合并去重与键一致性 | ✅ | 同 toolCallId 全量合并（`MessageList.tsx:169-179` 与取用处键同源）；PermissionDialog 已同步迁移 `toolCall` props |
| 依赖与锁文件 | ✅ | 新增 `ansi-to-html@0.7.2`/`diff@9.0.0`/`mermaid@12.2.0` 均被实际使用、类型自带、package-lock 同步（+103 包零删除） |
| 文档索引与互链 | ✅ | `docs/engineering/AGENTS.md`、`docs/product/AGENTS.md` 索引到位；PRD/提案/计划互链路径正确 |

## 四、验收问题清单

### R-1（🔴）「导出对话」静默截断历史：只导出已加载窗口，却提示「已导出对话」

- **问题描述**：会话页点「导出对话」得到的是**残缺对话**。SSE 首帧 history 只含最近 25 条（`SessionView.tsx:199-201` `setMessages(data.data)` + `setHasMore(data.data.length >= 25)`），更早历史需用户上翻触发 `handleLoadMore` 逐页拉取（`SessionView.tsx:425-463`）。`handleExportThread`（`SessionView.tsx:504-515`）只把**当前已加载的 `messages` state** 交给 `threadToMarkdown`，随后 toast.success「已导出对话」，无任何截断警告。长会话（>25 条）不翻完历史就导出 = 静默丢失前段对话，与 PRD 功能点 6「导出整段对话为文档」、成功标准「整段对话可导出为 Markdown 文件」、4.2「导出的对话文件内容与会话内容一致」直接冲突。
- **根因分析**：导出入口把「已加载窗口」误当「完整会话」；导出链路没有拉全历史的职责，也未与 `hasMore` 联动做降级提示。
- **修复方案**：① 导出前按 `before` 游标循环拉取剩余历史直至 `hasMore=false`，合并去重后全量转换（推荐，导出频率低，代价可接受）；② 若不做全量拉取，`hasMore` 为真时必须弹确认「仅导出已加载的 N 条」，toast 与文件内容口径一致；③ 补单测/ E2E：>25 条会话导出条数与会话总量一致。
- **验证结果**：⏳ 待返工后复核（本轮静态链路核对 + 实机导出探针证实仅当前 state 被序列化）。

### R-2（🔴）交付的 E2E-CREN2 确定性红：chunk 合并粘连围栏，`mermaid-block` 定位器永不命中

- **问题描述**：`tests/e2e/src/session-rendering.spec.ts:66-81` 连发 3 条 `agent_message_chunk`（合法 mermaid / 非法 mermaid / 普通文本），假设各自独立渲染。实际三条注入**均无 `messageId`** → `groupMessages` 走「相邻同类型合并」（`group-messages.ts:138-147`，`MessageList.test.tsx:54` 证明是有意实现）→ 合成一条消息 → `mergeMessageChunks` 以 **`join('')`**（`MessageList.tsx:47`）拼接 → 三段围栏粘连：` ``` `+` ```mermaid ` 同行成 ` ``````mermaid `，` ``` `+`after-mermaid-marker` 成 ` ```after-mermaid-marker `，均带 info string 不构成合法闭合围栏。remark-parse AST 实证（见[第二节](#二独立验证结果本机实跑不采信自报)）：整个文本塌成**单个** `lang=mermaid` 非法代码块 → `mermaid.render` 必失败 → 回退 `CodeBlock`（`MermaidBlock.tsx:71-73`）**不渲染 `data-testid="mermaid-block"`**（testid 仅在成功分支 `:85`）→ `spec:79` `getByTestId('mermaid-block').first().locator('svg')` 15s 超时必红。本用例为 PRD 功能点 2 的唯一 E2E 验收载体。
- **根因分析**：用例注入形态与真实 ACP 流量不符（真实 `agent_message_chunk` 携带 `messageId`），spec 假设「三条注入=三个渲染块」与实现的合并语义脱节——交付前未对新增 spec 做过实跑。
- **修复方案**：① 三条注入各携带**互不相同**的 `messageId`（命中 `group-messages.ts:127-136` 按 messageId 分组路径），使三段独立渲染；② 若意图覆盖「单条流式消息内多段围栏」场景，需另行评估 `join('')` 对相邻围栏的粘连问题（建议按消息合并时以 `\n\n` 或原文分片边界拼接，保持与源文本逐字一致——见 🟡 附注）；③ 交付前实跑全 spec（至少 `--grep CREN`），修复后附运行结果。
- **验证结果**：⏳ 待返工后复核（本轮 remark-parse AST 探针实证必红）。

### R-3（🟠）创建事件缺失时退化残留：标题「Tool Call: Tool Call」+「原始输入」入口整体消失

- **问题描述**：当 `tool_call` 创建事件不在已加载消息中（SSE 重连历史窗口截断、事件丢失）而只有 `tool_call_update` 时：① 合并结果无 `title`/`kind` → `toolCallTitle` 兜底 `kindLabel(undefined ?? 'other')` = `'Tool Call'`（`tool-call-state.ts:33-46,92-94`），叠加 `ToolCallCard.tsx:215` 的 `Tool Call: ${title}` 模板，头部显示 **「Tool Call: Tool Call」**——与本需求要修的「Tool Call: other」退化同类，仅换文案；② `ToolCallRawSection.tsx:13` `if (value === undefined) return null;` 使「查看原始输入」入口**完全不渲染**、无占位兜底，违反功能点 5「任意工具调用可展开查看原始输入」。`tool-call-state.test.ts:137-146`（T-MERGE7）反而把兜底文案 `'Tool Call'` 钉为预期。
- **根因分析**：标题兜底链在 title/kind 双缺失时退化为通用词并套模板前缀；rawInput 缺失被当「无内容」而非「内容不可得」。
- **修复方案**：① 标题兜底改用 `name`/原始 kind 字符串，避免 `Tool Call: ` 前缀与兜底词重复；② rawInput 缺失时渲染「创建事件缺失/输入不可得」占位区块而非隐藏入口；③ 补「创建事件缺失」渲染层负路径用例。
- **验证结果**：⏳ 待返工后复核。

### R-4（🟠）失败态输出不渲染、edit/execute 终态正文退化为一行文案

- **问题描述**：① execute 的输出渲染被 `if (status === 'completed' && rawOutput)` 门控（`ToolCallCard.tsx:129`），`failed` 时 stderr/错误输出只藏在折叠的原始输出 JSON 里，正文仅剩 `Command — failed`（`:206-209` 兜底）——失败恰是最需要看输出的场景；② edit 在 `completed` 且无 content 项、或 `failed` 时跳过参数/diff 展示（`:89-92` 回退仅 content 非空时生效），正文仅剩 `Edit — completed/failed`，创建时展示的命令名称、文件路径在正文消失。与功能点 5「工具完成后创建时展示的命令名称、文件路径等参数仍可查看」「不退化」的彻底性要求不符。
- **根因分析**：正文渲染按 `kind × isActive` 分支，终态只覆盖 happy path（completed + rawOutput/content）。
- **修复方案**：① execute 任何携带 `rawOutput.output` 的终态（含 failed）走同一 `TerminalOutput` 渲染；② edit 终态保留 `rawInput.filePath`/diff 展示；③ 补 failed 变体用例（ToolCards.test.tsx 目前全为 completed 主路径）。
- **验证结果**：⏳ 待返工后复核。

### R-5（🟠）`groupMessages` 未防护 JSON.parse / null 解引用：畸形 rawInput 使整个消息列表白屏

- **问题描述**：`group-messages.ts:62-63`：`const rawInputObj = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput; if ((rawInputObj as Record<string, unknown>).subagent_type)`。rawInput 为畸形 JSON 字符串时 `JSON.parse` 抛异常；为字符串 `'null'` 时解析出 `null`，`null.subagent_type` 抛 TypeError。`groupMessages` 在 `MessageList` 渲染路径的 useMemo 内执行（`MessageList.tsx:166`）且无 try/catch，一次异常 = 整个会话页崩溃。rawInput 由 Agent 端产出，属不可信输入（同文件 `:91` 另一分支用了安全的 `typeof rawInput === 'object'` 判断，口径不一）。
- **根因分析**：对不可信输入的解析与解引用未防护；同类判断两处口径不一致。
- **修复方案**：`JSON.parse` 包 try/catch + 结果非空对象校验（与 `:91` 分支同口径）；补畸形 rawInput 不崩溃的回归用例。
- **验证结果**：⏳ 待返工后复核。

### R-6（🟠）diff 尾行无换行误报「删除+新增」修改对，且测试把错误对齐固化为期望

- **问题描述**：jsdiff `diffLines` 按「行+换行符」做 token，最后一行无 `\n` 时与有 `\n` 的同名行不是同一 token。探针 P1：`computeDiff('1\n2\n3\n4','1\n3\n4\n5')` 输出 `removed 4 + added 4`（内容完全相同的行被伪造成修改对），P2：`computeDiff('a\nb\n','a\nb')` 把仅尾换行不同的 `b` 报成修改。与 git 口径（`4` 为上下文 + `No newline at end of file` 标记）不一致，违反功能点 3「与主流差异工具口径一致」。更严重的是 `diff.test.ts:57-67` 将 `removed [2,4] / added [3,4]` 断言为**正确**结果——错误对齐被固化为契约，重构后无法发现回归（区分力为负）。
- **根因分析**：`computeDiff`（`diff.ts:32-53`）未做尾换行归一即调用 `diffLines`。
- **修复方案**：① diff 前按纯行文本数组做 `diffArrays`（或归一化尾换行后再比）；② 修正 `diff.test.ts:57-67` 期望为 `removed [2] / added [5]`，补「尾行无换行」双向用例。
- **验证结果**：⏳ 待返工后复核（P1/P2 探针实证）。

### R-7（🟠）CRLF 差异全量噪声 + `\r` 残留致差异行渲染双行

- **问题描述**：`computeDiff` 不归一化 `\r\n`（对照 `ansi.ts:33-35` 对终端输出做了归一，diff 通路没有）。P3：CRLF vs LF 全文件 `removed:'a\r','b\r'` + `added:'a','b'` 重写噪声；P4：同为 CRLF 时 same 行文本仍为 `'a\r'`，DiffView 行内容 `whitespace-pre-wrap`（`DiffView.tsx:105-106`）下 `\r` 被 CSS 视作换行，**每个差异行渲染出多余空行、行高翻倍**——Windows 编辑的文件（CRLF）差异展示系统性劣化。
- **根因分析**：diff 通路缺换行符归一；`\r` 直接进入渲染文本。
- **修复方案**：`computeDiff` 入口统一 `\r\n`→`\n`（或逐行去尾 `\r`）；补 CRLF 用例。
- **验证结果**：⏳ 待返工后复核（P3/P4 探针实证）。

### R-8（🟠）Mermaid 语法错误块在 `document.body` 残留「Syntax error」错误图

- **问题描述**：`MermaidBlock.tsx:48-52` `initialize({ startOnLoad:false, securityLevel:'strict', theme })` 未设 `suppressErrorRendering: true`，且 `:53` `mermaid.render(renderId, code)` 未传容器元素。mermaid 12.2.0 `renderDiagram`（`mermaid.core.mjs:1338-1404`）在该配置下：解析失败 → 以「error」图渲染红色 "Syntax error in text" 到**挂入 `document.body` 的临时 div** → `if (parseEncounteredException) throw` 发生在 `removeTempElements()`（`:1404`）**之前** → 临时 div 永久残留。MermaidBlock 只 `catch` 后回退 CodeBlock，不清理 DOM。每个坏块在页面底部多挂一张错误图，视觉污染随坏块累积，破坏「语法错误不阻断整页渲染」的验收意图。
- **根因分析**：未按 mermaid 推荐配置抑制错误渲染，且 catch 分支无兜底清理。
- **修复方案**：`initialize` 增加 `suppressErrorRendering: true`（或 `render` 传入组件内容器元素），catch 分支兜底清理临时节点；补「错误块不残留 DOM」断言（`document.querySelectorAll` 计数）。
- **验证结果**：⏳ 待返工后复核（mermaid 源码 `:1343-1404` 控制流实证 + 回归断言待补）。

### R-9（🟠）ansi 剥离器三类边界缺陷：未终结序列吞输出（数据丢失）/ 截断序列泄漏乱码 / 冒号真彩乱码

- **问题描述**：`lib/ansi.ts` 三个边界均产生错误输出，直接违反功能点 4「光标控制等非展示序列不产生乱码」与输出完整性：
  1. **未终结 DCS/APC/PM 吞掉其后全部输出**（数据丢失，P5）：`STRING_SEQUENCE`（`:15`）终结符兜底 `$` 使 `\x1bPtmux;…` 未闭合时一路匹配到字符串末尾，其后真实输出全部被删除（实测 `later lines` 整段消失）。流式/截断输出或 `cat` 二进制时并不罕见。
  2. **截断 OSC/CSI 泄漏参数乱码**（P6/P7）：OSC 需 BEL/ST、CSI 需终结字节才被剥离（`:13/:17`），序列在文本末尾被截断时不命中任何正则，兜底 `GENERIC_ESCAPE`（`:21`）只吃 `ESC+1字节`，参数字面量泄漏为正文（实测 `0;window title` / `38;5;2`）。
  3. **冒号参数 SGR 真彩乱码且不上色**（P8）：`SGR_SEQUENCE`（`:11`）放行冒号，但 `ansi-to-html@0.7.2` 不识别 T.416 子参数形式，`38:2::10:20:30` 还原后参数余量当正文输出（实测 `":2::10:20:30mtruecolor"`）。`ansi.test.ts` 均为完整序列 + 分号真彩正路径，三类边界零覆盖。
- **根因分析**：剥离正则只覆盖完整序列；占位符还原后透传给不支持子参数的 converter。
- **修复方案**：① 无终结符的字符串序列只剥到行尾/串尾（或限长），不跨越大段文本；② 「ESC 引导 + 无合法终结」残留按序列类型整段丢弃到行尾；③ 进入 converter 前把冒号子参数归一化为 `;`（或整段剥离）；④ 补三类负路径用例（含 P5~P8 输入）。
- **验证结果**：⏳ 待返工后复核（P5~P8 探针实证）。

### R-10（🟠）导出不合并流式分片：一条回复被空行切碎、思考被拆成多个块

- **问题描述**：每条 `agent_message_chunk`/`user_message_chunk` 在导出时各成一个 section 并以 `\n\n` 拼接（`export-thread.ts:108-126,149-169`）。流式回复几乎必然分片 → 导出的句子被空行切碎（实机探针：分片 `"Hello"/" world"/"!"` 导出为三段独立段落），思考分片同理输出多个连续 `<thinking>` 块。UI 侧 `mergeMessageChunks`（`MessageList.tsx:20-53`）会把分片拼回完整文本，导出口径与展示口径不一致，违反 4.2「内容与会话内容一致」。
- **根因分析**：导出层未按消息粒度（messageId）合并分片。
- **修复方案**：按 `messageId`（对齐 `group-messages.ts:117-130` 分组语义）合并连续 user/agent/thought 分片后再成节；补多分片保真用例。
- **验证结果**：⏳ 待返工后复核。

### R-11（🟠）导出丢失 content 通道结果摘要

- **问题描述**：`toolSection`（`export-thread.ts:34-53`）只序列化 `rawInput`/`rawOutput`，忽略合并视图模型的 `content` 字段（`tool-call-state.ts:18,29`）。展示层会用 `ContentBlockRenderer` 渲染 `contentItems`（edit 的 diff 等结果），导出后这些工具调用只剩「状态+输入」，**结果摘要整体缺失**（实机探针：含 `content:[{type:'diff'…}]` 的已完成 edit 导出无任何结果内容），与功能点 6「工具调用与结果摘要」冲突。
- **根因分析**：导出序列化未覆盖 content 通道。
- **修复方案**：`toolSection` 增加 `merged.content` 摘要序列化（diff/文本块关键部分）；补「结果摘要存在」断言。
- **验证结果**：⏳ 待返工后复核。

### R-12（🟠）滚动跟随状态机双向竞态：上翻被拉底 / 流式期间跟随自丢失

- **问题描述**：跟随判定只靠 IntersectionObserver 异步回调更新 `isAtBottomRef`（`MessageList.tsx:74-96`），append 分支据此决策（`:131-138`），产生两个违反功能点 7 的竞态窗口：
  1. **上翻被强制拉底**：用户快速上滚时 IO 回调滞后于滚动事件，窗口内到达的流式 chunk 走 `:133-134` `scrollToBottom()`，视口被拽回底部——违反「上翻后新消息到达视图保持原位」；
  2. **流式期间跟随自行丢失**：每 chunk 触发 smooth `scrollIntoView`（`:70-72`），动画期间锚点被新内容推出视口 → IO 报 `isIntersecting=false` → follow=false（用户一直在底部、从未上翻）→ 后续 chunk 停止跟随并点亮新消息提示、按钮误现；smooth 动画逐 chunk 重启加剧抖动。
  现有测试（`MessageList.test.tsx:171-207`）用 `__triggerIntersection` 手动驱动，结构性测不出异步窗口。
- **根因分析**：以异步 IO 值做同步追加决策，且未区分「用户主动离底」与「内容增长致锚点离屏」。
- **修复方案**：① append 时用同步几何判定（`scrollHeight - scrollTop - clientHeight < 阈值`）替代/兜底 IO 异步值；② 流式追加用 `behavior:'auto'` 贴底；③ 只有用户手势来源的滚动才改变 follow 状态；④ 补竞态场景用例。
- **验证结果**：⏳ 待返工后复核。

### R-13（🟠）复制纯文本混入 UI 控件文本

- **问题描述**：`getPlainText` 取 `contentRef.innerText/textContent`（`MessageItem.tsx:112`），`contentRef` 覆盖整个渲染区（`:118`），代码块语言标签（`CodeBlock.tsx:32-34`）、Mermaid 工具栏文本（"mermaid"/"100%" 等，`MermaidBlock.tsx:83,100-108`）等 chrome 一并被复制；Mermaid 成功渲染时取到 SVG 文本、失败回退时又含源码，同一内容复制结果不稳定。违反功能点 6「复制纯文本得到去除标记符号后的可读文本」。
- **根因分析**：纯文本提取基于渲染 DOM 而非源 Markdown 去标记。
- **修复方案**：走源 Markdown 的去标记转换（或渲染时给 chrome 节点打标记并排除）；对 Mermaid 明确口径（复制源码）；补真实提取路径用例（T-MA2 目前用 mock `getPlainText` 测接线，真实路径零覆盖）。
- **验证结果**：⏳ 待返工后复核。

### R-14（🟠）初始加载链路竞态被新按钮暴露：自动 load-more + 滚动恢复互踩、「回到底部」会话打开即误现

- **问题描述**：初始滚底（`MessageList.tsx:143-150`）的 smooth 动画从 `scrollTop=0` 起步，沿途滚动事件命中 `handleScroll` 的 `<100` 分支（`:152-165`）→ **打开会话即自动多拉一页历史**；随后 prepend 恢复用被污染的 `scrollStateRef` 改写 `scrollTop`，与在途动画互踩，用户可能落在顶部而非底部 → IO 报 `false` → 新「回到底部」按钮在会话打开时即出现。三段逻辑与 `origin/release` 逐行一致（存量缺陷），但 PRD 功能点 7 明确验收「初始加载与加载更早历史的现有行为不回归」且「回到底部按钮仅在不在底部时出现」，新按钮把该缺陷变成用户可见问题。
- **根因分析**：程序化滚动与用户滚动未区分，load-more 触发与滚动恢复双所有权。
- **修复方案**：初始加载/动画期间抑制 `handleScroll` 自动 load-more（或仅用户手势触发）；load-more 滚动保存/恢复改单一所有权；补「打开会话按钮不误现」「加载更早历史后位置保持」用例。
- **验证结果**：⏳ 待返工后复核。

### R-15（🟠）E2E-CREN5「不退化」负向断言恒真，回归保护无效

- **问题描述**：`spec:164` `expect(page.getByText(/Tool Call: other/)).toHaveCount(0)` 断言的字符串在现代码**任何路径都产生不出**：`toolCallTitle` 回退是 `kindLabel(kind ?? 'other')`，`kindLabel('other')` 返回 `'Tool Call'`（`tool-call-state.ts:43`），标题只可能是 `Tool Call: Command`/`Tool Call: Tool Call`/自定义 title，永不含字面 `Tool Call: other`。断言无论标题是否退化都通过（恒真）；本用例恰是 PRD 功能点 5 核心缺陷「不出现退化」的唯一回归载体。
- **根因分析**：断言目标字符串与实现兜底口径脱节，交付前未做「断言可红」自证。
- **修复方案**：负向断言改为「不出现回退标题」（如 `/Tool Call: (Command|Tool Call)/` 计数为 0）或对标题做 exact 正向断言；所有防退化断言需经「回退实现→断言转红」自证区分力。
- **验证结果**：⏳ 待返工后复核。

### R-16（🟠）实现计划承诺的 TerminalOutput 组件测试未交付

- **问题描述**：实现计划 Phase 4 明确列出 `components/session/__tests__/TerminalOutput.test.tsx`「**新增**：颜色 span/粗体/控制序列不产生乱码/XSS 转义断言」（`plan:195`），测试矩阵列 `T-TO*`（`plan:285`），但 `__tests__/` 目录不存在该文件。终端渲染仅有 `lib/__tests__/ansi.test.ts` 纯函数级覆盖，组件层（`dangerouslySetInnerHTML` 注入、maxHeight、空行）零测试。计划与实现不一致，且 TDD 流程承诺（计划 §6.1）未兑现。
- **根因分析**：实现时漏建该测试文件，交付前未对照计划测试矩阵清点。
- **修复方案**：补齐 TerminalOutput 组件测试；或修订计划/测试矩阵如实登记覆盖口径与取舍（需说明理由）。
- **验证结果**：⏳ 待返工后复核。

### R-17（🟠）PRD 功能点 7 两条验收无断言支撑，`tests/e2e/AGENTS.md` 描述失实

- **问题描述**：AGENTS.md 写 E2E-CREN6「上翻后注入新消息 → **视口保持** +「回到底部」出现；点击后按钮消失并**恢复跟随**」（`tests/e2e/AGENTS.md:251`），PRD 验收要求「上翻后新消息到达视图保持原位」「点击按钮平滑滚动到底并恢复自动跟随」。spec 实际只断言按钮出现/消失（`spec:183-194`），「视口保持」「滚动到底」「恢复跟随」三个行为零断言；按钮消失断言由状态切换驱动（`ScrollToBottomButton.tsx:60` `return null`），与真实滚动位置无关。
- **根因分析**：验收标准→断言的映射缺失，文档描述超出实际断言范围。
- **修复方案**：注入新消息后断言 `container.scrollTop` 保持原值；点击后断言 `scrollTop + clientHeight ≈ scrollHeight`，再注入一条消息断言视口跟随；同步修正 AGENTS.md 描述。
- **验证结果**：⏳ 待返工后复核。

### R-18（🟠）`resource_link` 无协议白名单：`javascript:`/`data:` 伪协议可执行

- **问题描述**：`ContentBlockRenderer.tsx:64-67` `<a href={block.uri} target="_blank" rel="noreferrer">` 直接透传 Agent 可控 URI。`javascript:`/`data:` 伪协议点击即执行（`rel="noreferrer"` 不拦截伪协议），绕过 Markdown 链接已有的 `urlTransform` 清洗防线，违反 4.2「不执行原始 HTML 与脚本」的安全意图。
- **根因分析**：资源链接与 Markdown 链接未走同一防线条。
- **修复方案**：仅放行 `http(s):`/`file:` 等白名单协议，其余降级为纯文本展示；补伪协议负路径用例。
- **验证结果**：⏳ 待返工后复核。

### 🟡 建议（随修复一并收口，15 项）

| # | 位置 | 问题 |
|---|---|---|
| M-1 | `ansi.ts:23-25,53-55` | 占位符可被正文伪造（P9：`\u0001SGR0\u0001` 使正文被删除），占位符应含不可预测成分或先剔除 C0 控制符 |
| M-2 | `ansi.ts:17-21` | 8-bit C1 控制符（`0x9B` CSI / `0x9C` ST）不剥离，泄漏为 `&#x9B;` 乱码 |
| M-3 | `ansi.ts:36-37` | `\r` 一律转 `\n`，进度条类覆盖输出堆叠成多行（口径简化建议文档化或做后写覆盖） |
| M-4 | `MarkdownContent.tsx:30,32` | 语言正则 `/language-([\w-]+)/` 截断 `c++` 等语言名；`mermaid` 大小写敏感不进图形分支 |
| M-5 | `DiffView.tsx:18-27,105-106` | 高亮固定 oneDark、token 色覆盖行级语义色、removed/added 着色不对称；edit diff 未传 `filePath` 致高亮退化 `text`（`ToolCallCard.tsx:78-83`） |
| M-6 | `diff.ts:38-59`、`DiffView.tsx:73-110` | 大 diff 先全量计算再截断 + 每行一次 Prism 渲染，超大输入阻塞 UI；行号列 `w-10` 对 ≥5 位行号溢出 |
| M-7 | `MermaidBlock.tsx:133-134` | 「查看源码」视图是裸 `pre` 无复制按钮，与功能点 1 口径不一 |
| M-8 | `raw-value.ts:6-17`、`ToolCallRawSection.tsx:15` | 截断按行计不防单行巨串；折叠态每次渲染都 JSON.stringify（建议 `open` 短路 + useMemo） |
| M-9 | `export-thread.ts:70-75` | 排序比较器对缺失 `createdAt` 非传递，混排结果不确定（实机探针证实） |
| M-10 | `export-thread.ts:37,134` | 工具标题/思考文本裸插值进 Markdown 结构（标题含换行破坏结构、`</thinking>` 可被内容闭合） |
| M-11 | `export-thread.ts:179-182` | `URL.revokeObjectURL` 同步调用，慢机器/非 Chromium 下可能取消下载 |
| M-12 | `MessageItem.tsx:103-117`、`MessageActions.tsx:42` | 非文本消息（tool_call/image/unknown）也挂复制按钮且复制内容错位；`getPlainText` 空串仍提示「已复制」 |
| M-13 | `MessageList.tsx:112-120,98-103` | `isPrependRef` 在 SSE 整组替换后残留会吞掉下一次追加；`handleScrollToBottom` 乐观置位可被打断 |
| M-14 | 测试区分力 | `MarkdownContent.test.tsx:59-70` mermaid 用例只断言 testid 存在（loading 态即真）；`tool-call-icons.tsx` 图标映射零测试（验收点「每种工具类型图标」无回归保护）；`MessageList.test.tsx` 无「加载更早历史位置保持」用例；`DiffView.test.tsx` 弱断言无负路径 |
| M-15 | 文档一致性 | 提案/计划 `tool-call-icons.ts` 应为 `.tsx`（提案 :138/:353、计划 :203/:378）；计划「空行 `&nbsp;` 逐字保留」与实现 `whitespace-pre-wrap` 及 apps/agent-web/AGENTS.md 矛盾（计划 :133/:194）；「主题切换以 key 含主题强制重渲染」口径失实（实为 MutationObserver+effect，`MermaidBlock.tsx:26,30` 注释误导，计划 :119/提案 :225）；提案「源码 hash+主题 memo」「缩放+平移容器」两处描述未实现（提案 :183/:226）；提案断链 `[[../git.md]]`（提案 :13） |

## 五、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| R-1 | 导出静默截断历史（🔴） | 导出仅序列化已加载窗口，未联动 hasMore | ⏳ 待修复 | |
| R-2 | E2E-CREN2 确定性红（🔴） | spec 注入缺 messageId → 合并粘连围栏，定位器永不命中 | ⏳ 待修复 | |
| R-3 | 创建事件缺失退化残留（🟠） | 标题兜底重复前缀 + raw 缺失即隐藏 | ⏳ 待修复 | |
| R-4 | 失败态输出/终态参数正文丢失（🟠） | renderBody 仅覆盖 happy path | ⏳ 待修复 | |
| R-5 | groupMessages 解析崩溃（🟠） | 不可信 rawInput 未防护解析/解引用 | ⏳ 待修复 | |
| R-6 | diff 尾行无换行误报 + 测试固化错误对齐（🟠） | 未做尾换行归一 | ⏳ 待修复 | |
| R-7 | CRLF 噪声 + `\r` 渲染双行（🟠） | diff 通路缺换行归一 | ⏳ 待修复 | |
| R-8 | Mermaid 错误图残留 body（🟠） | 未设 suppressErrorRendering 且无兜底清理 | ⏳ 待修复 | |
| R-9 | ansi 剥离器三类边界（🟠，含数据丢失） | 正则仅覆盖完整序列；converter 不识冒号子参数 | ⏳ 待修复 | |
| R-10 | 导出不合并流式分片（🟠） | 导出层未按 messageId 合并 | ⏳ 待修复 | |
| R-11 | 导出丢失 content 结果摘要（🟠） | toolSection 未序列化 merged.content | ⏳ 待修复 | |
| R-12 | 滚动跟随双向竞态（🟠） | 异步 IO 值做同步追加决策 | ⏳ 待修复 | |
| R-13 | 复制纯文本混入 chrome（🟠） | 基于渲染 DOM 提取而非源文本 | ⏳ 待修复 | |
| R-14 | 初始加载竞态被按钮暴露（🟠，存量） | 程序化滚动与用户滚动未区分 | ⏳ 待修复 | |
| R-15 | CREN5 负向断言恒真（🟠） | 断言目标与兜底口径脱节 | ⏳ 待修复 | |
| R-16 | TerminalOutput 测试未交付（🟠） | 计划承诺未兑现 | ⏳ 待修复 | |
| R-17 | 功能点 7 验收无断言 + AGENTS.md 失实（🟠） | 验收标准→断言映射缺失 | ⏳ 待修复 | |
| R-18 | resource_link 无协议白名单（🟠） | 与 Markdown 链接防线条不一致 | ⏳ 待修复 | |
| M-1~M-15 | 🟡 建议项 | 见问题清单 | ⏳ 随修复收口 | |

## 六、最终验证

| 项目 | 本轮结果 | 返工复核要求 |
|---|---|---|
| `apps/agent-web` tsc | ✅ 0 error | 0 error |
| `apps/agent-web` eslint | ⚠️ 新增文件 0 error；存量 2 error（`cloud-host/IssuesLinkageDialog.tsx`，非本 diff）+ 5 warning | 新增文件 0 error，存量不新增 |
| `apps/agent-web` vitest | ✅ **848 passed / 0 failed**（91 文件） | 全绿 + 新增修复用例经「回退→转红」区分力自证 |
| `tests/e2e` typecheck | ✅ 0 error（exit=0） | 0 error |
| `tests/e2e` 实跑 | ❌ 未执行（需 Aspire 全栈；CREN2 已 AST 实证必红） | **随返工交付全 spec 运行结果**（至少 CREN 套件），或经人类书面豁免 |
| tsc（admin-api/agent-api/cloud-controller/admin-web） | — 未复跑（本 diff 无触达，`git diff --stat` 佐证） | 如返工触达后端再复跑 |

## 七、经验总结

1. **交付前 E2E 必须实跑**：本轮 🔴 R-2 属「spec 与实现合并语义脱节」，与历轮 N-20 同类；新增 e2e 用例应在交付前以真实栈或至少注入链路单测验证「定位器可命中、断言可红」。
2. **防退化断言要自证区分力**：R-15 的负向断言恒真、R-6 的错误期望被固化，都属于「测试不可红」；防退化/对齐类断言一律做「回退实现→转红」自证。
3. **不可信输入防御要收口**：Agent 产出的 rawInput/URI/ANSI 文本均属不可信输入（R-5 崩溃、R-18 伪协议、R-9 吞输出），解析与渲染边界统一走防护口径。
4. **导出/复制类功能以「与展示一致」为验收锚点**：R-1/R-10/R-11/R-13 均为同一类「导出视图 ≠ 展示视图」缺陷，建议把「导出=展示的序列化」写进实现口径并以对拍用例锁定。
5. **纯函数边界探针先行**：diff/ansi 这类纯函数库用一次性探针（P1~P9）几分钟即可暴露 6 项缺陷，建议纳入此类重构的常规自检清单。
