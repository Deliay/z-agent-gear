---
description: Agent 工作流首轮验收反馈（4 个问题）的根因分析、修复方案与验证结果跟踪
type: Permanent
---

# Agent 工作流验收报告（2026-08-08）

> **状态**: 本轮受理 4 个验收反馈，已全部修复并验证通过（4/4 闭环，待随 commit 回填）

## 关联文档

- PRD：[[20260808-agent-workflow]]（docs/product/draft/20260808-agent-workflow.md）
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

**修复 commit**：待回填

### 2. 工作流实例页频繁刷新，人类节点输入被清掉且无临时保存

**问题描述**：工作流实例页（`/workflows/:id`）每 5s 轮询刷新，人类节点输入框内容在输入过程中被刷新掉，也没有临时保存。

**根因分析**：

- `WorkflowInstancePage` 使用 `pollInterval: 5000`；人类节点输入框 `HumanNodeActions` 的 `input` 是纯组件内 `useState`（`WorkflowNodeTree.tsx`）。
- 工作流是活的：轮询期间任意节点状态翻转（如 READY↔RUNNING、REJECT→RUNNING）都会使 `HumanNodeActions` 的条件渲染（`status === READY || RUNNING`）变化，组件卸载重挂导致输入丢失。
- 全仓无任何草稿/临时保存机制。

**修复方案**：

1. `WorkflowNodeTree.tsx` 的 `HumanNodeActions`：输入内容按 `workflow-node-draft:<instanceId>:<nodeId>` 键持久化到 localStorage，挂载时恢复，变更时保存，完成/打回成功后清除。
2. 保持 5s 轮询不变（工作流状态需要近实时），输入不再受刷新影响。

**验证结果**：✅ agent-web 单测含 WorkflowNodeTree 草稿 3 例（持久化/隔离/完成后清除）；E2E-7 前半段（输入跨 5s 轮询周期保留 + 页面刷新后 localStorage 恢复）通过

**修复 commit**：待回填

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

**修复 commit**：待回填

### 4. 人类节点 RUNNING 状态下点「完成」报「不允许执行「启动」（start）」

**问题描述**：AI 节点（如「产出产品需求技术方案」）完成后，下游人类节点（「审核产品文档与技术方案」）变为「执行中」，此时提交 Review 意见点「完成」，报错：`节点「审核产品文档与技术方案」当前状态为 RUNNING，不允许执行「启动」（start）`。

**根因分析**：

- 引擎 `maybeActivate`（`engine.ts`）在上游全部 DONE 时把下游节点 READY→RUNNING，仅 FLAG 特判透传，HUMAN 节点也会被自动推进到 RUNNING（设计语义：进入「待人工处理」并出现在 `currentNodeNames`）。
- `instance.ts completeHumanNode` 实现为「无条件 start + complete」组合：节点已 RUNNING 时 `start` 转移（from: INITIALIZING/READY）非法，直接抛错。
- 首节点不受影响（实例化只置 READY 未激活），因此只有非首个人类节点触发。既有 A1-A18 未覆盖「RUNNING 人类节点完成」路径。

**修复方案**：

1. `servers/agent-api/src/services/workflow/instance.ts`：`completeHumanNode` 幂等化——节点 READY 时先补 `start`，已 RUNNING 时直接 `complete`；其他状态由引擎 `complete` 转移给出标准错误。

**验证结果**：✅ agent-api 单测 930/930（含 RUNNING 人类节点直接 complete 用例）；API 测试 A19（三节点 HUMAN→AI→HUMAN：下游人类节点 RUNNING 后人工完成 + 产物写黑板）通过；E2E-7 后半段（RUNNING 评审节点 UI 点「完成」成功）通过

**修复 commit**：待回填

## 修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 1 | mode/model 无动态选项 | 能力探测只做版本检查，无空实例探测链路 | ✅ 已修复 | 待回填 |
| 2 | 实例页刷新清掉人类输入 | 条件渲染卸载 + 无草稿持久化 | ✅ 已修复 | 待回填 |
| 3 | 流转后 harness 不执行 | start/prompt 跨频道竞态，消息静默丢弃 | ✅ 已修复 | 待回填 |
| 4 | RUNNING 人类节点完成报错 | completeHumanNode 无条件 start | ✅ 已修复 | 待回填 |

## 最终验证

| 项目 | 结果 |
|------|------|
| agent-api build/单测 | ✅ tsc 通过，930/930 |
| controller-api build/单测 | ✅ tsc 通过，383/383 |
| agent-controller build/单测 | ✅ tsc 通过，259/259 |
| agent-web lint/build/单测 | ✅ tsc + lint 0 error，296/296 |
| API 测试（tests/api） | ✅ 全量通过（含 A19/A20/A21） |
| E2E 测试（tests/e2e workflow.spec） | ✅ 9/9（E2E-1~9） |

## 经验总结

- **跨频道异步链路必须假设乱序**：agent-api 经 Redis pub/sub 发出的「命令」与「消息」在 controller-api 侧不保证处理顺序，凡「先启动会话再发消息」的模式都要在接收端做排队补发，且「发送失败」不允许静默 return，至少要记日志。
- **组合操作要考虑自动状态机**：引擎会自动推进节点状态（READY→RUNNING），人工操作接口（completeHumanNode）不能假设起始状态，应按当前状态幂等处理。
- **轮询刷新 + 条件渲染 = 输入必丢**：活数据页面的表单输入要么受控于不受条件渲染影响的层级，要么持久化草稿（localStorage 按键隔离即可，成本极低）。
- **能力数据的获取时机要区分**：CLI 版本检查 ≠ 会话能力；modes/models 只有 session/new 后才有，配置阶段需要「空实例探测」这类按需懒加载链路，并按 controllerId+type 缓存避免重复拉起。
- **fake controller 秒回响应会掩盖竞态**：API/E2E 测试中的假 controller 应有意识地引入延迟变体（startDelayMs），才能覆盖真实 harness 的慢启动场景。
