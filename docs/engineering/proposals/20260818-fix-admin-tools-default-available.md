---
description: agent-workflow-admin-tools 默认启用修复方案——mcpServers 读路径幂等确保平台服务注册
type: Permanent
---

# agent-workflow-admin-tools 默认启用修复 - 技术方案

**功能名称**: agent-workflow-admin-tools 默认启用（可装配到任意会话）
**关联 PRD**: docs/product/draft/20260811-agent-workflow-phase2.md（功能点 4：工作流管理工具集作为独立 scope 注册，**可装配到普通会话**）
**关联提案**: docs/engineering/proposals/20260811-feat-agent-workflow-phase2.md（承诺「随系统启动按 {name} 幂等 upsert」）
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工复验发现：**`agent-workflow-admin-tools` 似乎不会默认启用**。

### 1.2 根因分析

- 平台服务文档按 `{userId, name}` 隔离，由 `ensureAdminToolsServer(userId)` 幂等 upsert（`admin-tools.ts:461`）。
- 但该函数**只在 orchestrator 拉起 AI 节点会话时被调用**（`orchestrator.ts:84`）——提案承诺的「随系统启动幂等 upsert」从未实现。
- 后果：从未跑过工作流的用户，MCP Registry 与新建会话对话框的 MCP 选择器里**根本不存在** `agent-workflow-admin-tools`，PRD 验收点「可装配到普通会话」不成立；跑过工作流的用户也是事后才出现，且出现时机依赖副作用而非显式注册。

### 1.3 目标

- 任意用户的 `mcpServers` 列表始终包含平台内置 `agent-workflow-admin-tools`（`enabled: true`、`source/transport: platform`），可在设置页看到、在新建会话时装配。
- 不改动 `agent-workflow-tools`（节点作用域工具集，token 需 workflow payload，维持仅节点会话自动装配的设计）。

### 1.4 方案选择

| 方案 | 取舍 |
|------|------|
| 启动时遍历所有用户 upsert | 无法覆盖未来注册用户；启动耦合用户表 |
| 用户注册时 upsert | 无法覆盖存量用户 |
| **`mcpServers` 查询读路径幂等 ensure（采用）** | 覆盖存量与未来用户；upsert 幂等开销可忽略；列表即真相来源（Registry、新建会话选择器共用此查询） |

## 2. 修复方案

### 2.1 agent-api（servers/agent-api/src/graphql/resolvers/mcp-server.ts）

`Query.mcpServers` 在查询前调用 `await ensureAdminToolsServer(context.currentUser.id)`（读路径幂等确保注册），随后照常返回列表。前端无需改动（`McpRegistrySection` 已有「平台内置」badge；`NewSessionDialog` 按 `enabled` 过滤后自然出现该选项）。

### 2.2 测试（TDD + 状态语义演进回填断言）

| 层 | 用例 |
|----|------|
| agent-api `resolvers/mcp-server.test.ts` | ① mcpServers 查询调用 `ensureAdminToolsServer(userId)`（mock admin-tools 模块断言） |
| API `tests/api/src/agent-api/mcp-server.test.ts` | ② 原「authenticated 返回空列表」回填为「默认包含平台内置 agent-workflow-admin-tools（enabled=true、source=platform）」 |
| E2E `tests/e2e/src/settings-mcp-proxy.spec.ts` | ③ 原「MCP Servers 空状态」回填为「新用户 MCP 目录默认展示 agent-workflow-admin-tools（平台内置）」 |

## 3. 验证

1. 红：①②③ 先失败（②③ 为既有断言腐化，修改断言后对新行为为红→绿）。
2. 绿：实施修复，agent-api 单测全绿、build 通过。
3. 回归：其余子项目单测；Aspire 环境下 tests/api、tests/e2e 全量。
4. 人工复验路径：新注册用户 → 设置页 MCP 目录可见 `agent-workflow-admin-tools`（平台内置、启用中）→ 新建会话 MCP 选择器可勾选装配。
