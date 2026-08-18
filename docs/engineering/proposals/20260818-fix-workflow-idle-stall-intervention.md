---
description: 审批超时 agent 自动停止后工作流节点静默停留「执行中」修复方案——prompt 结束未推进节点时兜底提醒，再犯升级 FAILED + 人工介入待办
type: Permanent
---

# 审批超时后节点静默停留「执行中」修复 - 技术方案

**功能名称**: 工作流节点会话空闲停滞检测与人工介入升级
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工复验发现：**审批弹窗未及时审批 → agent 自动停止 → 会话状态「空闲」（idling），但工作流节点仍「执行中」（RUNNING）——无任何提醒，流程永久停滞**。

### 1.2 根因分析

现有兜底机制（`handleSessionEnded`，SESSION_STUCK 升级）只覆盖会话 **ended** 的场景。而「权限审批超时 → harness 取消当前 turn」走的是 `acp:prompt:complete` → `handlePromptComplete` → 状态 `running→idling`——**会话没有结束，只是空闲**，兜底根本不触发。节点 RUNNING 悬空，人类无感知。

推广而言：工作流节点会话的任何 turn 结束（`prompt:complete`）时若节点仍未推进（RUNNING/REWORK），都是停滞——正常推进路径上 completeCurrentNode/completeCurrentRework 在 turn 内完成（节点先 DONE、会话后 ended），不会误伤。

### 1.3 目标

- 工作流节点会话 turn 结束（idling）且节点未推进 → **兜底提醒一次**（补发提示词让 AI 继续；若卡在权限，重试会再次弹出审批待办，即现场提醒）；
- 再次空闲仍未推进 → 节点升级 **FAILED**（SESSION_STUCK，进入「需要人工介入」状态）+ 创建 **immediate 优先级人工介入待办**（强提醒，新待办类型 `workflow_intervention`）。

### 1.4 范围

| 子项目 | 修改 |
|--------|------|
| servers/controller-api | `handlePromptComplete` 发布 idling 时携带 `promptCompleted: true` 标记（publishStatus extra 白名单补该字段）——区分「start 落 idling」与「turn 结束落 idling」 |
| servers/agent-api | `sessionService.onSessionIdled/notifySessionIdled`；session-sse 订阅层对 `idling+promptCompleted` 触发通知；orchestrator 新增 `handleSessionIdled`（NUDGE 一次 → FAILED + 待办）；todo-service 新增 `createWorkflowInterventionTodo`；TodoItem 模型 enum 补类型 |
| contracts/schemas | `schemas/todo.ts` TodoType enum 补 `workflow_intervention` |
| apps/agent-web | TodoListPanel 补 `workflow_intervention` badge（「人工介入」） |

## 2. 关键设计

### 2.1 时序安全性（不误伤正常推进）

- AI 在 turn 内调用 completeCurrentNode → 节点先 DONE、会话经 onNodeDone 关闭为 ended → `handlePromptComplete` 的条件更新（要求 status='running'）未命中 → 不发布 idling → 不触发。工具调用结果先于 turn 结束返回，故 turn 结束时节点必然已转移。
- 仅当 turn 结束且节点仍 RUNNING/REWORK → 真实停滞。

### 2.2 升级路径（与 SESSION_STUCK 哲学一致）

`handleSessionIdled(sessionId)`：
1. 按 `nodes.sessionId` 找实例；非工作流会话直接返回。
2. 节点非 RUNNING/REWORK → 返回。
3. 首次（`!fallbackSent`）：置 `fallbackSent` 并补发 IDLE_NUDGE_PROMPT（会话 idling 映射仍在，addMessage 直达 bridge 执行；若卡在权限，重试触发新的审批待办弹窗=现场提醒）。
4. 再次（`fallbackSent`）：`transition(fail, SESSION_STUCK)` + 创建 `workflow_intervention` immediate 待办（强提醒）。

与 `handleSessionEnded` 共享 `fallbackSent` 计数：空闲停滞后再 ended（或反之）只兜底一次，随后 FAILED。

## 3. 测试（TDD）

| 层 | 用例 |
|----|------|
| controller-api acp-session-manager.test.ts | handlePromptComplete 发布的 idling 携带 promptCompleted=true |
| agent-api session-sse.test.ts / session.test.ts | idling+promptCompleted 触发 notifySessionIdled；裸 idling（start 落库）不触发；回调注册触发 |
| agent-api orchestrator.test.ts | O10：首次空闲停滞 → fallbackSent + 补发提醒（不 resume）；二次 → FAILED(SESSION_STUCK) + 人工介入待办；节点 DONE/非工作流会话 → 忽略 |
| agent-api todo-service | createWorkflowInterventionTodo 字段断言 |
| API tests/api workflow.test.ts | 新增用例：fake controller 对节点会话 emit prompt:start + prompt:complete（不调完成工具）→ 收到兜底提示词消息；再次 complete → 节点 FAILED 且 getTodoList 含 workflow_intervention 待办 |

## 4. 验证

1. 红→绿单测；四子项目 build。2. Aspire 下 tests/api、tests/e2e 全量。
3. 人工复验：工作流节点会话审批超时 → 自动兜底提醒一次（AI 继续或再次弹审批）→ 仍停滞则节点 FAILED（需人工介入）+ 待办强提醒。
