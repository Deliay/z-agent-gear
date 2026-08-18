---
description: AI→AI 节点会话拉起失败修复方案——start 超时后工作流节点不再静默卡死 + 迟到 start:result 孤儿收割 + 同会话重复 start/resume 旧 bridge 清理
type: Permanent
---

# AI→AI 节点会话拉起失败修复 - 技术方案

**功能名称**: AI 节点接力时下游会话拉起失败（start 超时静默卡死）
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md（一般项 #18 部分覆盖）
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景与日志证据

人工复验发现：**AI 节点完成、下一个节点也是 AI 节点时，会出现会话不能拉起**。现场日志：

```
[ACP session] Received acp:start:result ... success=false error=ACP start timeout
[ACP] Removing failed session 6a84053c... (was creating)      ← 会话被删
[ACP session] Dispatcher: unknown requestId=req_... (ignoring) ← 迟到的 start:result 被丢弃
[ACP session] Starting session 6a84059a... (queued input message, queue size=1)
```

### 1.2 根因分析（三层缺陷）

1. **start 30s 超时 → 会话被删 → 工作流节点静默卡死**（主因）：`acp-session-manager.ts` 超时后 `cleanupFailedSession` 直接删除 Session 文档（statusAtStart 为 creating/connecting）并 publish `removed`；而 agent-api 侧 `removed` 只关 SSE 连接（`session-sse.ts:123`），**不通知工作流编排器**——节点停在 RUNNING、sessionId 悬空，流程永久卡死，人类无任何感知。
2. **迟到的 start:result 仅记日志**（验收 #18）：超时后 controller 仍可能拉起成功，result 到达时 dispatcher 已无 pending → `unknown requestId (ignoring)` → ACP 进程成孤儿。
3. **同 sessionId 重复 start/resume 覆盖 bridge 不清理**（次生）：controller 端 `acpBridges.set` 直接覆盖，旧 bridge（可能在途初始化）泄漏为双进程。

注：日志中该节点 cwd 为仓库根（未启用 worktree），排除同阶段 worktree 分支冲突因素；超时属环境性（harness 冷启动慢/负载），健壮性缺口才是产品缺陷。

### 1.3 目标

- 节点会话启动失败（removed）→ 节点升级 FAILED（`SESSION_START_FAILED`），人类可见、可「重启节点」恢复（已有机制）。
- 迟到的成功 result → 收割孤儿进程。
- 同会话重复 start/resume → 先停旧 bridge。

### 1.4 范围

| 子项目 | 修改 |
|--------|------|
| servers/agent-api | `sessionService` 增加 `onSessionRemoved` 回调；session-sse `removed` 分支触发；orchestrator 新增 `handleSessionRemoved`（RUNNING/REWORK 节点 → fail/SESSION_START_FAILED） |
| servers/controller-api | dispatcher unknown requestId 且 success → 会话不活跃且无在途 start/resume 时 emit acp:stop 收割 |
| packages/agent-controller | acp:start/acp:resume handler：同 sessionId 已存在 bridge 时先 stop 再替换 |
| contracts | `workflow.graphql` failInfo.source 注释补 SESSION_START_FAILED |

## 2. 修复方案

### 2.1 agent-api：removed 通知编排器，节点可见地失败

- `session.ts`：新增 `onSessionRemoved(callback)` / `notifySessionRemoved(sessionId)`（与 onSessionEnded 同模式）。
- `session-sse.ts` dispatchStatus `removed` 分支：关 SSE 后调用 `sessionService.notifyRemoved(sessionId)`（session-sse 已依赖 sessionService，无新分层问题）。
- `orchestrator.ts`：`register()` 注册 onSessionRemoved；新增 `handleSessionRemoved(sessionId)`——按 `nodes.sessionId` 找实例，节点状态为 RUNNING/REWORK 时 `transition(fail, { reason: '节点会话启动失败或运行中被移除，请人工重启节点', source: 'SESSION_START_FAILED' })`。节点已转移（DONE 等）则忽略。

### 2.2 controller-api：迟到成功 result 收割孤儿

dispatcher 的 unknown requestId 分支（start 与 resume 两处）：`payload.success === true` 且 `!this.sessions.has(sessionId)` 且 `!this.startingSessions.has(sessionId)` → `socket.emit('acp:stop', { sessionId })`（不带 ackRequired，fire-and-forget）。有在途 start/resume 时不收割（新 bridge 会经 2.3 替换旧 bridge）。

### 2.3 agent-controller：同会话重复 start/resume 先停旧 bridge

`acp:start`/`acp:resume` handler 在 `acpBridges.set` 前：若已有同 sessionId 旧 bridge → `await existing.stop().catch(()=>{})` + delete。旧 bridge 的 stop 会触发其 onStopped → 回 `acp:start:result(success=false)`（旧 requestId，server 端未知 → 不收割，语义自洽）。

### 2.4 契约

`contracts/workflow.graphql` failInfo.source 注释补 `SESSION_START_FAILED`（节点会话启动失败/被移除）。

## 3. 测试（TDD）

| 层 | 用例 |
|----|------|
| agent-api orchestrator.test.ts | ① removed 且节点 RUNNING → FAILED(SESSION_START_FAILED)；② 节点已 DONE → 忽略；③ session-sse：removed 状态触发 sessionService.notifyRemoved（或 session.test.ts 层回调触发断言） |
| controller-api acp-session-manager.test.ts | ④ start 超时后迟到 success result → emit acp:stop 收割；⑤ 迟到 success 但会话已有新在途 start → 不收割；⑥ 迟到 failure result → 不收割 |
| agent-controller socketio-client.test.ts | ⑦ 同 sessionId 重复 acp:start → 旧 bridge stop 被调用 |

## 4. 验证

1. 红→绿单测；四子项目 build。2. Aspire 下 tests/api、tests/e2e 全量。
3. 人工复验：模拟 harness 慢启动（或复现超时）→ 节点 FAILED 且可见可重启，无孤儿 ACP 进程。
