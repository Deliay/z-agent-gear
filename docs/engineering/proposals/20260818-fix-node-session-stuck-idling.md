---
description: 节点会话接力后状态停留「空闲」修复方案——pendingInputs 补发必须先于状态 idling 落库之后
type: Permanent
---

# 节点会话接力后状态停留「空闲」修复 - 技术方案

**功能名称**: HUMAN→AI 节点接力会话状态停留「空闲」
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工复验发现：**人类节点完成交接到下一个 AI 节点时，拉起的会话状态只是「空闲」（idling）**——running 从未 latch。

### 1.2 根因分析（状态竞态）

`acp-session-manager.ts` `startSession` 成功分支的顺序缺陷（`resumeSession` 同样）：

```
sessions.set(sessionId)            // 111
flushPendingInputs(sessionId)      // 117 ← 补发排队 prompt（emit acp:message）
...
Session.findByIdAndUpdate(idling)  // 142 ← 状态落库 idling（在此之前仍是 connecting）
```

真实 harness 下的竞态时序：

1. `flushPendingInputs` 补发首条 prompt → controller bridge 立即执行并 emit `acp:prompt:start`；
2. controller-api `handlePromptStart` 执行 `findOneAndUpdate({_id, status: 'idling'}, {status: 'running'})`——**此时 DB 状态仍是 `connecting`（142 行尚未执行/未提交）→ 条件更新未命中**；
3. 142 行落库 `idling`；
4. prompt 执行完毕 → `handlePromptComplete` 要求 `status: 'running'` → 又未命中。

最终状态永远停在 **idling（空闲）**。是否命中取决于 Mongo 写库与 socket 往返的毫秒级先后——「有时候」复现与此吻合。测试从未暴露：fake controller 不应答 prompt、从不 emit `acp:prompt:start`。

### 1.3 修复

`startSession`/`resumeSession` 成功分支调整顺序：**先完成状态落库（idling）与 publishStatus，最后才 `flushPendingInputs`**——保证 `acp:prompt:start` 到达时状态已是 idling，`idling→running→idling` 严格有序。

### 1.4 范围

| 子项目 | 修改 |
|--------|------|
| servers/controller-api | `acp-session-manager.ts`：startSession/resumeSession 成功分支将 `flushPendingInputs` 移到状态落库与 publishStatus 之后 |

## 2. 测试（TDD）

| 层 | 用例 |
|----|------|
| controller-api `acp-session-manager.test.ts` | start：排队输入在 start 成功后补发时，`findByIdAndUpdate(status:'idling')` 的调用必须先于 `acp:message` emit（invocationCallOrder 断言）；resume 同样 |

## 3. 验证

1. 红→绿单测；四子项目 build。2. Aspire 下 tests/api、tests/e2e 全量。
3. 人工复验：人类节点完成 → AI 节点会话状态 idling→running→idling 正常流转，不再停留「空闲」。
