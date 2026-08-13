---
description: Agent 工作流 phase2 人类验收问题修复方案（多节点打回回流卡死 + 工作流 MCP 有效性跟随工作流）
type: Permanent
---

# Agent 工作流 Phase2 人类验收问题修复 - 技术方案

**功能名称**: 工作流多节点打回回流 + 工作流 MCP 有效性修复
**关联 PRD**: docs/product/draft/20260811-agent-workflow-phase2.md
**关联验收报告**: docs/engineering/acceptance/20260812-agent-workflow-phase2-acceptance-report.md
**feat-branch**: `integration`（PR #168 → release）
**创建日期**: 2026-08-13
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

phase2 上线后人类验收发现两类问题：

1. **多节点打回回流卡死**：`人类a → AI b → 人类c` 链中，`c 打回 b`、`b 也打回 a`、`a 重新提供信息`后，流程推进到 `b` 时无法继续向下流转，报错「c 没有配置 agent」。
2. **工作流 MCP 失效**：长时间任务或反复验收时，关闭会话会导致下发的 MCP 失效。期望：工作流内 MCP 访问有效性跟随**工作流**；普通会话仍跟随**会话**。

### 1.2 目标

- 修复多节点打回回流场景，流程可持续流转，人类节点复工不再拉起会话。
- 工作流节点会话的 MCP endpoint 有效性绑定到工作流实例生命周期，普通会话保持原行为。
- 使用 API 测试与 E2E 测试先写用例（红），再修复实现（绿），确保全部测试通过。

### 1.3 范围

| 项 | 说明 |
|----|------|
| 修复 | 问题 1（resume 类型守卫）、问题 2（MCP endpoint 跟随工作流） |
| 使能 | E2E `instantiate` helper 旧签名（AI 报告阻塞 #2）、E2E-18 缺 `nodes`（阻塞 #3）、`configuredWorkflowId` 非空契约冲突（阻塞 #1） |
| 不做 | AI 报告其余严重/一般/建议项（#4~#24）本方案暂不处理，另立修复轮次 |

## 2. 问题根因分析

### 2.1 问题 1：resume 人类节点误拉起会话

**调用链**：引擎 `complete`/`completeRework` 会对「下游 REJECT 节点」执行 `resume`（`engine.ts` 的 `resume` 转移），无条件触发 `onNodeResume` hook → orchestrator `resumeNodeSession`。

`resumeNodeSession`（`orchestrator.ts:154`）对**所有**节点执行「关闭旧会话 + `startNodeSession`」，而 `startNodeSession` 要求节点有 `agentConfig`。HUMAN/FLAG 节点无 agentConfig，于是抛「节点「c」缺少 Agent 配置，无法拉起会话」。

**复现**：`a(HUMAN) → b(AI) → c(HUMAN)`：
1. `c 打回 b`：c REJECT，b REWORK（resume b 会话）；
2. `b 打回 a`：b REJECT，a REWORK；
3. `a 重新提供`（completeRework）：a DONE，下游 b REJECT → resume（b 复工，重新拉起会话）；
4. `b 完成`：b DONE，下游 c REJECT → resume → `resumeNodeSession(c)` → HUMAN → 抛错，流程卡死。

### 2.2 问题 2：工作流 MCP endpoint 跟随会话 TTL / 关闭

`mcp-endpoint.ts` 对**所有** endpoint 一视同仁：
- JWT 签名带 `expiresIn`（默认 86400s），长时间任务超时后 token 失效；
- `getStatus` 按 `expiresAt` 判过期；
- `session.close()` 无条件 `revokeEndpoint`。

工作流节点会话的 MCP 工具服务（`agent-workflow-tools` / `agent-workflow-admin-tools`）是**平台服务**，其有效性应与工作流实例共存亡，而非随会话 TTL/关闭失效。普通会话（用户自选 MCP）应保持会话级有效性。

## 3. 修复方案

### 3.1 问题 1：`orchestrator.resumeNodeSession` 类型守卫

**文件**: `servers/agent-api/src/services/workflow/orchestrator.ts`

```ts
async resumeNodeSession(instance, node) {
  // HUMAN/FLAG 节点无会话，复工仅需引擎置 RUNNING，无需拉起会话
  if (node.type !== 'AI') return;
  if (node.sessionId) { /* close old session */ }
  await this.startNodeSession(instance, node);
}
```

### 3.2 问题 2：工作流 MCP endpoint 跟随工作流实例

**文件**:

1. `servers/agent-api/src/models/mcp-session-endpoint.ts`
   - 新增 `workflowInstanceId: String`；`expiresAt` 改为可空（工作流 endpoint 无 TTL）。

2. `servers/agent-api/src/services/mcp-endpoint.ts`
   - `createEndpoint(workflow?)`：工作流作用域时 JWT 不设 `expiresIn`、`expiresAt=null`、Redis `active` 不设 TTL、落库 `workflowInstanceId`；普通会话保持原逻辑。
   - `getStatus`：工作流作用域 endpoint 直接返回 `active`（无 TTL 判过期）。

3. `servers/agent-api/src/services/session.ts`
   - `close()`：工作流节点会话（`workflowInstanceId != null`）关闭时**不撤销** endpoint（有效性跟随工作流）；普通会话关闭仍撤销。`delete()` 仍一律撤销（实例删除时由 `deleteInstance` → `sessionService.delete` → `revokeEndpoint` 兜底）。

### 3.3 使能项（AI 报告阻塞项）

| # | 修复 |
|---|------|
| 阻塞 #1 | `contracts/workflow.graphql` 与 `schemas/workflow.ts` 中 `WorkflowInstance.configuredWorkflowId: ID!` → `ID`（TEMPLATE/BLANK 来源本就不保证存在） |
| 阻塞 #2 | `tests/e2e/src/workflow.spec.ts` `instantiate` helper 改用 `instantiateWorkflow(input)` |
| 阻塞 #3 | `tests/e2e/src/workflow.spec.ts` P2-E2E-18 `instantiateWorkflowFromConfigured` 补齐 `nodes` |

## 4. 测试策略

### 4.1 单元测试（`servers/agent-api` vitest）

- `orchestrator.test.ts`：HUMAN/FLAG 节点 `resumeNodeSession` 不调用 `sessionService.create/close`。
- `mcp-endpoint.test.ts`：工作流 endpoint JWT 无 `exp`、`expiresAt=null`、Redis 无 TTL、落库 `workflowInstanceId`；`getStatus` 对工作流 endpoint 返回 `active`；普通 endpoint 行为不变。
- `session.test.ts`：`close()` 对工作流会话不撤销 endpoint、普通会话撤销。

### 4.2 API 测试（`tests/api/src/agent-api/workflow.test.ts`）

- **A24（问题 1）**：三节点 `a(HUMAN)→b(AI)→c(HUMAN)` 全链路打回回流，断言 b 完成后 c 复工为 RUNNING、`completeCurrentNode` 返回 `isError=false`。
- **A25（问题 2）**：工作流节点会话 MCP token 无 `exp`（解码 payload），普通会话 MCP token 有 `exp`。

### 4.3 E2E 测试（`tests/e2e/src/workflow.spec.ts`）

- **E2E-14（问题 1）**：复用三节点模板 `input(HUMAN)→exec(AI)→review(HUMAN)`，API setup + fake controller 驱动 exec MCP 工具，覆盖 review 打回 exec → exec 打回 input → input 重新提交 → exec 完成 → review 复工 RUNNING 无报错。
- **E2E-15（问题 2）**：断言 exec 节点 MCP token 无 `exp`（有效性跟随工作流）。

## 5. 验收标准

- [x] agent-api 单测全绿（含新增用例）——520/520
- [x] API 测试 A24/A25 通过 —— 实际编号 A31/A32，全量 295/295
- [x] E2E 测试 E2E-14/E2E-15 通过 —— 实际编号 E2E-19/E2E-20，workflow.spec.ts 20/20
- [x] 工作流 MCP token 无 TTL；普通会话 token 保留 TTL
- [x] 多节点打回回流流程不卡死

## 6. 最终验证结果

| 项目 | 结果 |
|------|------|
| agent-api build | ✅ tsc |
| agent-api 单测 | ✅ 525/525 |
| agent-web build | ✅ vite |
| agent-web 单测 | ✅ 342/342 |
| API 测试 | ✅ 300/300（含 A31/A32/A33） |
| E2E 测试（workflow） | ✅ 21/21（含 E2E-19/E2E-20/E2E-21） |

## 7. 返工补充：节点重启机制（2026-08-13 第二轮）

**反馈**：节点会话失败时缺少重试机制，需在节点「执行中、返工中、失败」状态提供「重启节点」按钮。

**实现**：
- 引擎新增 `restart` 事件（`RUNNING/REWORK/FAILED → RUNNING`），清 `failInfo/rejectInfo/fallbackSent` 并触发 `onNodeRestart` hook。
- orchestrator 注册 `onNodeRestart → resumeNodeSession`（关闭旧会话 + 拉起全新会话；HUMAN/FLAG 类型守卫沿用）。
- 服务层新增 `restartNode(userId, instanceId, nodeId)`；GraphQL 新增 `restartNode(instanceId, nodeId)` mutation（契约 + schema + resolver）。
- 前端 `WorkflowNodeTree` 为 AI 节点在 RUNNING/REWORK/FAILED 状态展示「重启」按钮（`RESTART_NODE` mutation）。

**返工（确认弹框）**：点击「重启」先弹出确认框，明确「关闭并删除当前会话、重新拉起全新会话重试」的语义（删除会话不可撤销、节点产物与打回记录保留）；确认后才执行 `restartNode`。`WorkflowNodeTree` 新增 `restartTarget`/`restarting` 状态与 `RestartNodeDialog`；前端单测新增 4 例（点击先弹框不触发、确认触发、取消不触发、文案语义）；E2E-21 补充弹框与确认点击断言。

**验证**：
- 单测：engine.test.ts R1–R3（restart 状态转移 + 非法状态拒绝）、orchestrator.test.ts（restart 关闭旧会话拉起全新会话 / 人类节点不拉起）——525/525
- 前端单测：WorkflowNodeTree.test.tsx 新增重启确认框 4 例——346/346
- API：A33（重启 RUNNING→全新会话；重启 FAILED→清 failInfo 复工；A33b 非法状态拒绝）——300/300
- E2E：E2E-21（执行中节点展示「重启」按钮，弹框确认后会话切换并可继续完成）——21/21

## 8. 相关文档

- 验收报告：[[20260812-agent-workflow-phase2-acceptance-report]]
- 实现计划：[[20260811-feat-agent-workflow-phase2]]
