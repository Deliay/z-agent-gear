---
description: ACP 权限提醒工具调用详情缺失与 Elicitation 场景全链路打通的验收修复报告
type: Permanent
---

# ACP 权限提醒与 Elicitation 验收报告

> **状态**: 受理验收反馈 2 项，全部修复并验证通过（2/2 闭环），待 PR 评审合入。

## 关联文档

- PRD：[[../../product/released/20260528-acp-permission-reminder.md]]、[[../../product/released/20260803-acp-v1-completion.md]]
- 技术方案：[[../proposals/20260803-feat-acp-v1-completion.md]]、[[../plan/20260803-feat-acp-v1-completion.md]]（Phase 12）
- 契约：[[../../../contracts/agent-session-websocket.md]]、[[../../../contracts/agent-session.graphql]]
- 关联分支：`fix/acp-permission-elicitation`
- 验收日期：2026-08-07
- 外部协议参考：[ACP Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)

## 需求概述

本轮验收覆盖两个 ACP 协议接入问题：

1. 用户收到的权限申请提醒没有显示具体的工具调用信息，仅展示 toolCallId，需要将 toolCall 信息聚合透传，提取对用户有用的内容（工具标题、类型、参数摘要、文件位置）。
2. ACP Elicitation（`elicitation/create` / `elicitation/complete`，UNSTABLE）在代码上线后从未体现，需要实现全链路并用 单测 + API 测试 + E2E 测试（agent 使用 opencode）覆盖，确保全链路打通。

## 验收问题清单

### 2.1 权限申请提醒缺少工具调用详情

**问题描述**：用户在收到权限申请提醒时，对话框只显示 `工具调用 ID`（如 `call_xxx`）的裸文本，看不到工具名称、命令、文件路径等具体信息，无法做出审批决策。复现路径：任意 session 触发 Agent 工具权限申请 → 前端 PermissionDialog。

**根因分析**：ACP `session/request_permission` 源头携带完整 `ToolCall` 对象（`title`/`kind`/`rawInput`/`locations`），agent-controller 与 controller-api 均整体透传，但 agent-api 落库与 SSE 推送时只提取了 `toolCallId`（`permission-subscriber.ts`、`todo-service.ts`、`TodoItem` schema 均收窄），前端 PermissionDialog 只能退化为「拉最近 100 条 session 消息按 toolCallId 匹配」，存在时序竞争与窗口限制，匹配失败即降级为裸 ID。

**修复方案**：

1. 契约拓宽 `acp:permission` 的 `toolCall` 载荷（`contracts/agent-session-websocket.md` §2.19），GraphQL 新增 `PermissionToolCall` 类型（`contracts/agent-session.graphql`）。
2. controller-api 修正 toolCall 类型声明为完整透传（`servers/controller-api/src/services/permission-manager.ts`、`socketio.ts`）。
3. agent-api 落库完整 toolCall 并生成用户可读摘要（`servers/agent-api/src/models/todo-item.ts`、`services/todo-service.ts`、`services/permission-subscriber.ts`、GraphQL schema）。
4. 前端 PermissionDialog 优先渲染 todo 自带的 toolCall 详情（标题 + kind 徽标 + 参数摘要 + 文件位置），保留消息匹配与裸 ID 作为兜底（`apps/agent-web/src/components/PermissionDialog.tsx`）。

**验证结果**：

- ✅ 单测：`todo-service.test.ts`（完整 toolCall 落库、title/description 摘要）592/592 通过（agent-api 全量）
- ✅ API 测试：`permission.test.ts` 新增「persist full toolCall details in permission todo」断言 title/kind/rawInput/locations 全字段持久化，255/255 通过
- ✅ E2E：`permission.spec.ts` 新增「show tool call details in permission dialog」，弹窗直接渲染标题/kind 徽标/命令/文件位置，149/149 通过

### 2.2 ACP Elicitation 场景未接入

**问题描述**：ACP v1 Elicitation（form/url 两种模式）在 SDK（@agentclientprotocol/sdk 1.3.0）中已具备类型与能力协商，且 opencode 1.18.11 已支持发出 `elicitation/create`，但本系统全链路（bridge → controller-api → agent-api → web）均未实现，Agent 发起 Elicitation 时走 SDK method-not-found 兜底，场景从未体现。

**根因分析**：Elicitation 在 ACP 协议中为 UNSTABLE 能力，此前产品/技术方案将其列为 P2 未排期（`docs/engineering/plan/20260803-feat-acp-v1-completion.md` Phase 12 未勾选）；GraphQL 契约曾预留 `respondElicitation` 但无 resolver 实现，其余环节完全空白。

**修复方案**：

1. 契约定义 `acp:elicitation` / `acp:elicitation:response` / `acp:elicitation:complete` Socket.IO 事件与 GraphQL `ElicitationRequestData`/`respondElicitation`（`contracts/`）。
2. agent-controller：声明 `elicitation.form/url` client capabilities，实现 `unstable_createElicitation`（pending Map + 65s 超时回 cancel + Socket.IO 透传，未知模式立即 cancel 不挂起）与 `unstable_completeElicitation`（透传完成通知）（`packages/agent-controller/src/acp/bridge.ts`、`socketio-client.ts`、`acp/sync-bridge.ts`）。
3. controller-api：新增 `ElicitationManager`（Redis `elicitation:request/response/complete` 频道、60s 超时回 cancel）与 Socket.IO 接线（`servers/controller-api/src/services/elicitation-manager.ts`、`socketio.ts`）。
4. agent-api：新增 `elicitation-subscriber`（建 `elicitation_request` 待办 + SSE）、`respondElicitation` resolver、TodoItem `elicitationData`（`servers/agent-api/`）。
5. 前端：新增 `ElicitationDialog`（form 模式 schema 驱动表单：enum/oneOf 单选、array 多选、boolean、number、string/format、default 预填、required 校验；url 模式完整 URL + 域名高亮 + 确认后打开；统一 accept/decline/cancel 三动作），TodoListPanel 自动弹出（`apps/agent-web/src/components/`）。
6. 测试覆盖见下。

**验证结果**：

- ✅ 单测：agent-controller 253/253（bridge elicitation 6 用例：form/url 透传、未知模式即 cancel、65s 超时、complete 转发、capability 声明）；controller-api 343/343（ElicitationManager 8 用例）；agent-api 592/592（subscriber/resolver/todo-service）；agent-web 266/266（ElicitationDialog 13 用例）
- ✅ Wire 测试：`acp-wire-elicitation.test.ts` 以 opencode 兼容 fake ACP agent 走真实 SDK 序列化，断言线上 JSON-RPC payload（capabilities 广告、form accept 响应、url accept + `elicitation/complete` 转发）3/3 通过
- ✅ API 测试：`elicitation.test.ts` 6/6（form/url 建待办、accept 带 content 回传、decline 不带 content、complete 标记已读、鉴权拒绝）
- ✅ E2E：`elicitation.spec.ts` 4/4（form 自动弹窗→选择→提交回传 content、decline/cancel 回传、url 域名高亮 + 同意后 window.open + accept 回传）
- ✅ 真实 opencode：`acp-real-elicitation.test.ts` 以真实 agent-controller 进程拉起真实 `opencode acp`，验证声明 elicitation capabilities 的 initialize 握手与 session/new 全通过（session 达 idling）

### 修复中顺带解决的阻塞缺陷（非本轮验收项，但阻塞验收链路）

1. **Mongoose 空子文档导致混合待办列表查询崩溃**：Mongoose 会把 schema 声明的嵌套子文档物化为空对象，`ElicitationRequestData.requestId` 等非空字段解析报错，前端 GetTodoList（同时查两种 data）整体失败 → 所有弹窗静默失效。修复：新增 `TodoItem.data`/`TodoItem.elicitationData`/`PermissionRequestData.toolCall` 字段 resolver 归一为空为 null，并在 `resolvers/index.ts` 合并（此前仅合并 Query/Mutation）。
2. **acp-real 测试环境变量泄漏**：宿主环境 `ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT` 优先级高于 config 文件，导致真实控制器注册 INVALID_KEY。修复：测试 spawn 环境剔除这两个变量。
3. **acp-real 测试断言腐化**（基线失败，与本次改动无关）：session 启动后期望状态 `running` 应为 `idling`（running 仅 prompt 处理中）；`sessionMessages` 查询携带已移除的 `offset` 参数。均已修正。
4. **遗留基线失败（未修复）**：`acp-real-session-import.test.ts` 依赖 minefield-online 目录的真实 opencode `session/load`，opencode 侧报 "Internal error: OpenCode service failure"，属 opencode 环境/版本问题，与本分支无关，建议单独跟进。

## 修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 2.1 | 权限提醒缺少工具调用详情 | agent-api 落库/SSE 收窄为 toolCallId，前端匹配不可靠 | ✅ 已修复 | 9aef13e / 7535b8e / 188f9fc / 29c935f / adf779a |
| 2.2 | Elicitation 场景未接入 | 全链路未实现（P2 未排期） | ✅ 已修复 | 9aef13e / 9b49484 / 7535b8e / 188f9fc / 29c935f / f2092f8 / adf779a |

## 最终验证

| 项目 | 结果 |
|------|------|
| lint | ✅ 与 main 基线一致（仅存量 1 error + 5 warnings，位于 MessageList.tsx 等未触碰文件） |
| build | ✅ agent-web `tsc -b && vite build` 通过；agent-controller `tsc --noEmit` 通过 |
| 单测 | ✅ agent-controller 253 / controller-api 343 / agent-api 592 / agent-web 266，全部通过 |
| API 测试 | ✅ tests/api 255/255；acp-real（真实 opencode）：controller 2/2、elicitation 1/1、mcp-passthrough 通过；session-import 基线失败（见 2.2 节遗留项） |
| E2E | ✅ tests/e2e 149/149 全部通过（含 elicitation 4、permission 10） |

## 经验总结

1. **嵌套子文档必须考虑 Mongoose 空对象物化**：schema 声明的 nested subdocument 即使从未赋值也会以 `{}` 出现，GraphQL 非空字段会直接崩查询；新增嵌套结构时应同步加字段 resolver 归一化，且 API 测试要覆盖「混合类型列表 + 消费方真实查询字段」。
2. **resolver 合并清单是隐性陷阱**：`resolvers/index.ts` 手工枚举合并键，新增类型级 resolver（非 Query/Mutation）时必须登记，否则单元测试（直接引用 resolver 对象）无法发现未生效。
3. **测试进程环境要隔离宿主 env**：spawn 真实进程做集成测试时，`{ ...process.env }` 会把宿主的配置覆盖变量（如 `ZAG_CONTROLLER_KEY`）带进被测进程，config 优先级（CLI > env > file）会放大这种问题。
4. **状态机语义演进要回填测试断言**：session 状态拆出 `idling` 后，存量测试期望 `running` 形成基线腐化；状态语义变更应全局检索测试断言。
5. **真实 agent 的确定性覆盖边界**：真实 opencode 的 initialize/session/new 可确定性验证（能力协商、握手回归），但触发 agent 主动发起 elicitation 需要 LLM 决策，不确定性部分用 wire 级 fake agent（同一 ACP 协议字节流）补齐，形成「真实握手 + 协议字节流 + 全链路 stub」的三层覆盖。
6. **聚合信息应尽早沉淀到持久层**：toolCall 详情在前端「现查现配」不可靠（时序竞争），在 agent-api 落库时聚合透传后，前端展示链路自然简化且可测试。
