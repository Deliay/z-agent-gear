---
description: 删除存活会话 ACP 进程泄漏修复方案（deleteHistorySession 绕停进程 + stop 与 start 竞态）
type: Permanent
---

# 删除存活会话 ACP 进程泄漏修复 - 技术方案

**功能名称**: 删除存活会话 ACP 进程泄漏修复
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md（跟进项「SessionView 删除存活会话可能绕过 stop-ack 生命周期」）
**关联方案**: docs/engineering/proposals/20260817-fix-session-lifecycle-worktree-acceptance.md
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工验收复现：**新建会话后直接点击「删除」，ACP 进程被保留（泄漏）；点击「关闭」则 ACP 进程正常结束**。

### 1.2 根因分析

两个互相独立的缺陷叠加：

**根因 1（主因）：前端删除路由绕过了 stop 生命周期**

- `apps/agent-web/src/components/session/SessionView.tsx:287`：`handleDeleteSession` 仅凭 `session.externalSessionId` 非空就走 `deleteHistorySession`——而**每一个初始化成功的存活会话都有 externalSessionId**（`acp-session-manager.ts` start 成功时写入）。
- `servers/agent-api/src/services/session-import.ts:87` `deleteHistorySession` 只做两件事：删 DB 记录 + 向 agent 同步删除历史（`acp:delete-history-session`），**从不发送 `acp:stop`**。
- 结果：存活（idling 等）会话被删除时 ACP 进程无人回收，且 DB 记录已删，事后无任何机制补救。「关闭」走 `closeSession` → `sessionService.close()` → `acp:stop`，进程正常结束——与复现现象完全一致。

**根因 2（次因）：stop 与 start 竞态，stop 被当作「controller 离线」吞掉**

新建会话在 `creating`/`connecting` 窗口内删除（此时 `externalSessionId` 未写入，前端走 `deleteSession`）：

- agent-api `sessionService.delete()` 正确发布 `acp:stop`（`session.ts:345`）。
- 但 controller-api `stopSessionWithAck`（`acp-session-manager.ts:826`）查 `sessions` Map 未命中——**映射要等 `acp:start:result` 成功才写入**（`acp-session-manager.ts:93`），而 Redis 订阅回调是 async 不串行的，stop 与 start 并发处理。
- 未命中即走「controller 离线」分支：仅写 `acp:stop:pending:{controllerId}` 便返回。该 pending 只在 controller **重连**（`reconcileOnRegister`）时消费——controller 一直在线则永不补做。
- start 随后完成，进程拉起，永久泄漏。

### 1.3 目标

- 存活会话无论经哪条删除路径，ACP 进程都必须被停止（带 ack 等待）。
- 保持 deleteHistorySession 的 agent 历史同步语义不变（删除后会话不得重新出现在「导入历史会话」列表）。
- 按 TDD 红-绿循环修复，agent-api / controller-api 单测全绿，API/E2E 回归通过。

### 1.4 范围

| 子项目 | 修复 |
|--------|------|
| servers/agent-api | 根因 1：`deleteHistorySession` 对非 ended 会话先委托 `sessionService.delete()`（带 ack 停 ACP + worktree 清理 + MCP 撤销 + 删库），再做 agent 历史同步 |
| servers/controller-api | 根因 2：start/resume 在途跟踪 + `stopSessionWithAck` 等待在途 start 结算后再停；session-command 对同会话生命周期命令（start/resume/stop）串行化 |
| apps/agent-web | 不改（deleteHistorySession 语义修正后现有路由即正确） |

## 2. 修复方案

### 2.1 agent-api：`deleteHistorySession` 停活进程（根因 1）

`services/session-import.ts`：

```ts
const LIVE_STATUSES = ['creating', 'connecting', 'idling', 'disconnected']; // running 维持现有拒绝守卫

// deleteHistorySession 内：
if (sessionStatus === 'running') throw ...                  // 现有行为不变
// 先取记录快照（externalSessionId/controllerId/cwd/acpServerType）
if (LIVE_STATUSES.includes(sessionStatus)) {
  await sessionService.delete(sessionId, userId);  // acp:stop + ack + worktree 清理 + MCP 撤销 + 删库 + 删消息
} else {
  await Session.deleteOne(...); await AcpMessage.deleteMany(...);  // ended：现有行为不变
}
// agent 历史同步逻辑不变（用快照字段）
```

- 无循环依赖：`session.ts` 不引用 `session-import.ts`。
- `sessionService.delete` 幂等处理 ack 超时（warn 后继续），与 deleteSession 行为一致。

### 2.2 controller-api：stop 等待在途 start 结算（根因 2）

`services/acp-session-manager.ts`：

1. 新增 `private startingSessions = new Map<string, Promise<unknown>>()`；`startSession`/`resumeSession` 进入时登记（try/finally 中结算删除）。
2. `stopSessionWithAck` 未命中 `sessions` Map 时：若 `startingSessions` 有该会话的在途 promise，先 `await` 其结算，再重查 `sessions` Map——命中则走正常 stop（清映射 + 落 ended + `acp:stop(ackRequired)` + 等 ack）；仍未命中才走 pending 分支。
3. `services/session-command.ts`：对同一 sessionId 的 `acp:start`/`acp:resume`/`acp:stop` 命令按到达顺序串行处理（per-session promise 链），消除「stop 先于 start 进入 manager」的残留窗口。

### 2.3 测试（TDD）

| 层 | 用例 |
|----|------|
| agent-api `session-import.test.ts` | ① idling 会话 deleteHistorySession → 发布 `acp:stop`（委托 delete）且 agent 历史同步仍执行；② ended 会话 → 不发 `acp:stop`，仅删库 + 同步（现状保持）；③ running 会话 → 抛错（现状保持） |
| controller-api `acp-session-manager.test.ts` | ④ start 在途时调用 stopSession → start 结算后 controller socket 收到 `acp:stop { ackRequired: true }`，会话落 ended，不写 pending |
| controller-api `session-command.test.ts` | ⑤ 同会话 acp:start 与 acp:stop 连续到达 → stopSession 在 startSession 完成后才被调用（顺序断言） |

## 3. 验证

1. 红：先补 5 个用例，确认 ①④⑤ 失败。
2. 绿：实施修复，agent-api / controller-api 单测全绿。
3. 回归：agent-controller / agent-web 单测、各子项目 build；Aspire 环境下 tests/api、tests/e2e 全量。
4. 人工复验路径：新建会话 → 初始化完成（idling）→ 直接删除 → controller 侧无残留 ACP 进程；新建 → connecting 窗口内删除 → 同样无残留。
