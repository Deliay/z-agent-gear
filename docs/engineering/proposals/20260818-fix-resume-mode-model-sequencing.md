---
description: 工作流节点 resume/rework 路径 mode/model 时序修复方案——初始 mode/model 随 acp:resume 带内下发，在首条 prompt 前应用
type: Permanent
---

# 节点会话 resume 路径 mode/model 时序修复 - 技术方案

**功能名称**: 工作流节点 resume/rework 路径 mode/model 时序修复
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md
**关联契约**: contracts/agent-session-websocket.md §2.11
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工复验发现：**轮到新节点时，setModel/setMode 指令可能还没发过去就开始执行 prompt 了**——质问时序是否受控。

### 1.2 现状核查（create 路径 vs resume 路径）

**create 路径（startNodeSession）：时序已受控。** modeId/modelId 随 `acp:start` payload 带内下发（`session.ts:182-183`），controller 端 bridge 在 `session/new` 之后、`acp:initialized` 之前 `applyInitialModeModel()`（`bridge.ts:274`），而 prompt 只有在 `acp:start:result` 成功后才从 `pendingInputs` 补发——应用必然先于首条 prompt。

**resume 路径（reworkNodeSession / handleSessionEnded 兜底）：时序不受控。** 全链路四段全部缺失：

1. `sessionService.resume()` 的 `acp:resume` 发布**不带** modeId/modelId（`session.ts:298-306`）；
2. orchestrator 改用 `applyAgentConfig` → `setMode/setModel` 补救，但这两个方法有 `status !== 'idling'` 守卫（`session.ts:221,237`），resume 发起时状态为 ended/connecting → **静默丢弃，从未生效**；
3. controller-api `resumeSession` 的 `acp:resume` socket payload 不含 mode/model（`acp-session-manager.ts:445-455`）；
4. controller 端 `acp:resume` handler 不传 `initialModeId/initialModelId`（`socketio-client.ts:427-432`），且 `bridge.resume()` 不调用 `applyInitialModeModel()`（`bridge.ts:283-320`，两个分支都没有）。

结果：rework/兜底 resume 后 prompt 以 harness 默认 mode/model 执行——正是验收观察到的现象。

### 1.3 目标

- resume 路径与 create 路径对齐：初始 mode/model 随 `acp:resume` 带内下发，bridge 在 `acp:initialized`（→ `acp:resume:result` → prompt 补发）之前应用，时序严格受控。
- 删除 applyAgentConfig 在 rework/start 中的死调用（status 守卫使其恒为 no-op）。

### 1.4 范围

| 子项目 | 修改 |
|--------|------|
| servers/agent-api | `sessionService.resume` 支持可选 `initial: { modeId, modelId }` 并随 acp:resume 发布；orchestrator reworkNodeSession/handleSessionEnded 传入节点配置，删除死调用 applyAgentConfig |
| servers/controller-api | `resumeSession` 与 `handleAcpResume` 透传 modeId/modelId 到 acp:resume payload |
| packages/agent-controller | `AcpResumePayload` 增加 modeId/modelId；acp:resume handler 传 initialModeId/initialModelId；`bridge.resume()` 两个分支在 emit initialized 前 `applyInitialModeModel()` |
| contracts | `agent-session-websocket.md` §2.11 acp:resume payload 增加 modeId/modelId 可选字段，客户端行为补「result 前应用初始 mode/model」 |

## 2. 测试（TDD）

| 层 | 用例 |
|----|------|
| agent-api `session.test.ts` | resume 传 initial → 发布的 acp:resume 含 modeId/modelId；不传 → 不含 |
| agent-api `orchestrator.test.ts` | reworkNodeSession 以节点配置 mode/model 调 resume；不再调 setMode/setModel |
| controller-api `acp-session-manager.test.ts` | resumeSession 的 acp:resume payload 含 modeId/modelId |
| controller-api `session-command.test.ts` | acp:resume 命令透传 modeId/modelId 到 resumeSession（manager mock 补 resumeSession） |
| agent-controller `bridge.test.ts` | resume 在 acp:initialized 前应用 initial mode/model（含 newSession fallback 分支） |

## 3. 验证

1. 红：上述用例先失败。2. 绿：实施修复，四个子项目单测/build 全绿。3. 回归：Aspire 下 tests/api、tests/e2e 全量（A30 已覆盖 start 路径透传）。
4. 人工复验：节点配置 mode/model → 打回返工 → resume 后 harness 以配置值执行 prompt（harness 日志/UI badge 可见）。
