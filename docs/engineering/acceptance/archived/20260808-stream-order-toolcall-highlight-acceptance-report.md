---
description: Session SSE 消息流时序错乱与工具调用卡片恒高亮的验收修复报告
type: Permanent
---

# Session 消息流时序与工具调用高亮验收报告

> **状态**: 受理验收反馈 2 项，全部修复并验证通过（2/2 闭环），待 PR 评审合入。

## 关联文档

- 契约：[[../../../contracts/agent-session-websocket.md]]、[[../../../contracts/agent-session.graphql]]
- 关联分支：`fix/stream-order-toolcall-highlight`
- 验收日期：2026-08-08

## 需求概述

本轮验收覆盖两个会话消息展示问题：

1. EventSource（SSE）stream 接口推送的消息存在时序问题，前端展示顺序错乱，但刷新后从数据库读取的顺序正确。
2. 工具调用卡片只在"正在调用"时高亮，完成后退化为普通灰色卡片；需要恒高亮，并使用同色系颜色按状态做略微区分。

## 验收问题清单

### 2.1 SSE stream 消息时序错乱

**问题描述**：session 消息通过 `GET /api/session/:id/stream`（SSE）实时推送到前端时，展示顺序偶发错乱；刷新页面后（走 `sessionMessages` 查询按 `_id` 排序）顺序恢复正常。复现路径：任意 session 中 agent 高频输出 chunk/tool_call 时观察前端消息流。

**根因分析**：controller-api `handleControllerMessage`（`servers/controller-api/src/services/acp-session-manager.ts`）对每条 `acp:message` 执行「先 `AcpMessage.create` 落库、后 `redis.publish('session:message')`」。Socket.IO 对每个数据包同步触发 async 监听器且不串行化（`servers/controller-api/src/services/socketio.ts`），高频消息到达时多个 handler 并发执行，publish 顺序 = Mongo 写入完成顺序；而 ObjectId（`_id`）在 `create()` 调用时同步生成，顺序 = 消息到达顺序。因此 **SSE 推送序 ≠ `_id` 序 ≠ 真实时序**。前端 SessionPage 对增量 `message` 事件纯 append 无排序无去重，直接放大该问题；刷新走 DB 查询按 `_id` 排序故恢复正确。

**修复方案**（选择后端排序：在源头保证 publish 顺序 = 到达顺序）：

1. controller-api `ACPSessionManager` 新增 per-session 消息处理队列（promise chain），同一 sessionId 的 `handleControllerMessage` 严格串行执行「落库 → 推送」（`acp-session-manager.ts`）。
2. 不同 session 之间不互相阻塞；队列尾部吞错，前一条消息处理失败不阻塞后续消息，错误仍通过返回值抛给调用方（socketio 记录日志）。
3. 前端不改（保持纯 append），由后端保证流内顺序。

**方案权衡**：前端排序需要可靠的跨进程排序键（ObjectId 跨进程同一秒内不保证严格有序，`createdAt` 仅毫秒精度），且无法修复 chunk 拼接依赖到达顺序的隐含假设；后端串行化在源头消除乱序，DB 序与流序天然一致，改动面最小。

**验证结果**：

- ✅ 单测：`acp-session-manager.test.ts` 新增 3 用例（落库乱序完成时 publish 仍按到达序、跨 session 不串行、单条失败不阻塞后续），controller-api 全量 346/346 通过
- ✅ API 测试：`session.test.ts` 新增「should stream rapidly emitted messages in arrival order」——fake controller 高频连发 5 条消息经真实 Mongo/Redis 由 SSE 接收，**修复前在真实服务上复现乱序（seq-1, seq-5, seq-3, seq-2, seq-4），修复后通过**
- ✅ E2E：`session-message.spec.ts` 新增「should display rapidly emitted messages in arrival order」，5 条 rapid tool_call 消息在页面 DOM 中按序渲染

### 2.2 工具调用卡片仅进行中高亮

**问题描述**：工具调用卡片（ToolCallCard/ReadCard/FetchCard/SubAgentCard）仅在 status 为 `in_progress`/`pending` 时显示高亮（info 色 + 脉冲动画），`completed`/`failed` 退化为与背景无差异的灰色卡片（`bg-muted border-border`），历史工具调用在消息流中缺乏辨识度。

**根因分析**：`AcpCard` 的配色表中仅 `purple`（进行中）为高亮样式，`blue`（completed）/`yellow`（failed）/`gray` 三者样式完全相同；各卡片按 status 三选一映射到这四个颜色值。

**修复方案**：

1. `AcpCard` 新增语义化配色 `active`/`completed`/`failed`，均为 info 同色系高亮：`active` 最强（`bg-info/10 border-info` + 脉冲），`completed`/`failed` 减弱（`bg-info/5 border-info/40`），`failed` 摘要文字使用 `text-destructive` 做略微区分（`AcpCard.tsx`）。
2. 保留旧有 `purple`/`blue`/`yellow`/`gray` 配色不动，避免影响 PlanCard（plan）/UsageCard（用量）等非工具调用卡片。
3. ToolCallCard/ReadCard/FetchCard/SubAgentCard 的 status 映射切换到新语义配色。

**验证结果**：

- ✅ 单测：`AcpCard.test.tsx` 新增 3 用例（active 最强高亮 + 脉冲、completed 同色系浅高亮无脉冲、failed 浅高亮 + destructive 摘要）；`ToolCallCard.test.tsx` 新增 2 用例（completed/failed 恒高亮不退化为 `bg-muted`），agent-web 全量 271/271 通过
- ✅ E2E：`session-message.spec.ts` 新增「should keep tool_call card highlighted after completion」，进行中 `bg-info/10` → 完成后 `bg-info/5`，均通过

## 修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 2.1 | SSE stream 消息时序错乱 | controller-api 并发落库，publish 序 ≠ `_id` 序 | ✅ 已修复 | 3aa83b5 / 90af1df |
| 2.2 | 工具调用卡片仅进行中高亮 | AcpCard 仅 purple 为高亮，completed/failed 为灰色 | ✅ 已修复 | df0d59a / 90af1df |

## 最终验证

| 项目 | 结果 |
|------|------|
| lint | ✅ 与 main 基线一致（agent-web 存量 1 error + 5 warnings，位于 MessageList.tsx 等未触碰文件，改动前后一致；controller-api 无 eslint 配置） |
| build | ✅ agent-web `tsc -b && vite build` 通过；controller-api `tsc --noEmit` 通过 |
| 单测 | ✅ controller-api 346/346（+3）；agent-web 271/271（+5） |
| API 测试 | ✅ tests/api 常规套件 256/256（含新增 SSE 时序用例；该用例在修复前的真实服务上复现乱序） |
| E2E | ✅ tests/e2e 151/151（含新增时序、恒高亮 2 用例）。注：与 API 套件并行运行时因资源竞争出现 10 项超时失败，单独串行重跑全部通过 |

## 遗留说明（不阻塞本轮验收，供 PR 评审参考）

1. **history/subscribe 竞态窗口**：`session-sse.ts` 先查 history 再订阅 Redis，窗口内 publish 的消息会丢失（表现为漏消息而非乱序），本次未改动，建议后续用「先订阅再发 history」或游标补漏修复。
2. **跨进程 `_id` 排序**：用户输入（agent-api 写入）与 agent 输出（controller-api 写入）跨进程，同一秒内 ObjectId 比较不严格等于真实时序，极端情况下 DB 序与真实时序可能偏差；如需严格全序需引入单调序号字段。
3. **前端增量消息无去重**：SessionPage 对 SSE `message` 事件纯 append，重连等场景可能重复展示；本次由后端保证顺序后未复现，可作为防御性改进。

## 经验总结

1. **「落库后推送」的并发模式必须用序字段或串行化兜底**：create 时同步生成 ObjectId、await 后再 publish 的写法在并发下必然导致 publish 序 ≠ `_id` 序；凡依赖推送顺序的链路（SSE 直推、chunk 拼接），写入方应 per-key 串行化。
2. **API 测试能确定性复现分布式时序 bug**：fake controller 高频连发 + 真实 Mongo/Redis + SSE 接收的组合，把单测中需要精心构造的竞态在集成环境直接暴露（修复前 seq-1,seq-5,seq-3,seq-2,seq-4），是此类 bug 最有效的回归手段。
3. **配色映射表要语义化而非颜色名**：AcpCard 的 `purple`/`blue`/`yellow` 名不副实（purple 实为 info 蓝、后三者同一样式），新增 `active`/`completed`/`failed` 语义键后映射意图清晰，且不影响存量调用方。
4. **E2E 与 API 套件不宜并行跑在同一套服务上**：两者共用 Mongo/Redis/服务进程，并行会造成超时型假失败；验收验证应串行执行或隔离环境。
