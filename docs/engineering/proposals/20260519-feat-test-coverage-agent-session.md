# Agent Session 测试覆盖报告

**关联提案**: `20260518-proposal-agent-session.md`
**创建日期**: 2026-05-19

## 1. 提案测试要求 vs 实际覆盖

### 1.1 按模块覆盖

| 提案要求 | 提案测试类型 | 测试文件 | 状态 |
|---------|------------|---------|------|
| agent-api Session Service | 单元测试 (Vitest) | `servers/agent-api/src/services/session.test.ts` | ✅ |
| agent-api Session SSE Service | 单元测试 (Vitest) | `servers/agent-api/src/services/session-sse.test.ts` | ✅ |
| agent-api Session GraphQL | 集成测试 (Vitest + supertest) | `tests/api/src/agent-api/session.test.ts` | ✅ |
| agent-api SSE 端点 | 集成测试 (Vitest + supertest) | `tests/api/src/agent-api/session.test.ts` (SSE 部分) | ✅ |
| controller-api ACP Session Manager | 单元测试 (Vitest) | `servers/controller-api/src/services/acp-session-manager.test.ts` | ✅ |
| controller-api ACP Capability Detector | 单元测试 (Vitest) | `servers/controller-api/src/services/acp-capability-detector.test.ts` | ✅ |
| controller-api ACP 事件处理 | 集成测试 (Vitest + socket.io-client) | `tests/api/src/controller-api/acp-websocket.test.ts` | ✅ |
| 控制器 ACP Detector | 单元测试 (Vitest) | `packages/agent-controller/tests/acp-detector.test.ts` | ✅ |
| 控制器 ACP Spawner | 单元测试 (Vitest) | `packages/agent-controller/tests/acp-spawner.test.ts` | ✅ |
| 前端 Session 页面组件 | 组件测试 (Vitest + RTL) | _(待补充)_ | ⚠️ |
| 前端 Session E2E | E2E 测试 (Playwright) | `tests/e2e/src/session.spec.ts` | ✅ |

### 1.2 按测试类型覆盖

| 测试类型 | 提案要求 | 实际文件数 | 状态 |
|---------|---------|-----------|------|
| agent-api 单元测试 | Session Service, SSE Service | 2 | ✅ |
| agent-api 集成测试 | GraphQL mutations/queries, SSE 端点 | 1 | ✅ |
| controller-api 单元测试 | ACP Session Manager, Capability Detector | 2 | ✅ |
| controller-api 集成测试 | ACP 事件处理、消息转发 | 1 | ✅ |
| 控制器单元测试 | ACP Detector, ACP Spawner | 2 | ✅ |
| 前端组件测试 | Session 页面、消息列表 | 0 | ⚠️ |
| 前端 E2E 测试 | Session 管理流程 | 1 (10 用例) | ✅ |

## 2. 测试用例清单

### 2.1 agent-api 单元测试

**文件**: `servers/agent-api/src/services/session.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| createSession | 创建 Session，验证状态为 creating |
| getSession | 获取 Session 详情 |
| getSessions | 获取用户 Session 列表 |
| closeSession | 关闭 Session，状态变为 ended |
| deleteSession | 删除 Session |
| sessionMessage | 添加 AcpMessage 到 Session |
| getSessionMessages | 分页获取 Session 消息 |

**文件**: `servers/agent-api/src/services/session-sse.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| addSubscriber | 添加 SSE 订阅者 |
| removeSubscriber | 移除 SSE 订阅者 |
| broadcastMessage | 广播消息到所有订阅者 |
| getHistory | 获取历史消息 |

### 2.2 agent-api 集成测试

**文件**: `tests/api/src/agent-api/session.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| createSession mutation | 创建 Session，验证返回 payload |
| sessions query | 查询 Session 列表 |
| session query | 查询单个 Session |
| sessionMessages query | 查询 Session 消息 |
| closeSession mutation | 关闭 Session |
| deleteSession mutation | 删除 Session |
| ACP 启动流程 | createSession → acp:start → acp:start:result → status=running |
| ACP 消息转发 | acp:message(input) → acp:message(output) |
| ACP 停止流程 | acp:stop → acp:stopped → status=ended |
| 权限验证 | 不能操作其他用户的 Session |

### 2.3 controller-api 单元测试

**文件**: `servers/controller-api/src/services/acp-session-manager.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| acquireSession | 获取 Session 控制权 |
| releaseSession | 释放 Session |
| forwardToController | 转发消息到 Controller |
| isSessionActive | 检查 Session 是否活跃 |
| cleanupSessions | 清理过期 Session |

**文件**: `servers/controller-api/src/services/acp-capability-detector.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| detectAcpServers | 检测 ACP Server |
| 缓存命中 | 1 小时内返回缓存结果 |
| 缓存过期 | 重新检测 |

### 2.4 controller-api 集成测试

**文件**: `tests/api/src/controller-api/acp-websocket.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| acp:check | 请求检测 ACP 能力 |
| acp:check:result | 返回检测结果 |
| acp:start | 启动 ACP Session |
| acp:start:result | 返回启动结果 |
| acp:message (input) | 转发前端输入到 Controller |
| acp:message (output) | 转发 Controller 输出 |
| acp:stop | 停止 ACP Session |
| acp:stopped | Session 已停止通知 |
| session:command bridge | agent-api → controller-api Redis 桥接 |
| session:message bridge | 消息转发桥接（不重复写 DB） |

### 2.5 控制器单元测试

**文件**: `packages/agent-controller/tests/acp-detector.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| detectOpenCode | 检测 OpenCode 是否可用 |
| detectOpenCodeVersion | 获取 OpenCode 版本号 |
| OpenCode 不可用 | 返回 available=false |

**文件**: `packages/agent-controller/tests/acp-spawner.test.ts`

| 用例 | 覆盖场景 |
|------|---------|
| spawn | 启动 OpenCode ACP 进程 |
| spawn 失败 | 进程启动失败处理 |
| 进程退出 | 进程退出事件通知 |

### 2.6 前端 E2E 测试

**文件**: `tests/e2e/src/session.spec.ts` (10 用例)

| 用例 | 覆盖场景 |
|------|---------|
| 空状态显示 | 会话列表页显示「暂无会话」空状态 |
| 无在线 controller | New Session dialog 显示「无在线控制器」 |
| 有在线 controller | 注册 controller → New Session dialog 显示在线 controller |
| 创建会话并跳转 | 选择 controller → 创建 → 跳转到会话详情页 |
| 会话详情页结构 | 显示会话状态、输入框、消息区域 |
| 状态未运行时禁用输入 | 会话状态非 running 时输入框禁用 |
| 显示状态 badge | 会话详情页显示状态 badge |
| 关闭会话 | 点击关闭 → 状态更新为已删除 |
| 删除会话 | 点击删除 → 跳转回会话列表 |
| 未登录重定向 | 直接访问 `/sessions` → 重定向到登录页 |

## 3. 测试运行结果

```
✅ agent-api 单元测试: 166 passed
✅ controller-api 单元测试: 90 passed
✅ agent-controller 单元测试: 45 passed
✅ agent-api + controller-api 集成测试: 88 passed
✅ 前端 E2E 测试: 36 passed (auth 8 + settings-llm 10 + settings-controller 8 + session 10)
```

## 4. 未覆盖项

| 未覆盖项 | 原因 | 优先级 |
|---------|------|--------|
| 前端 Session 组件单元测试 | SessionPage 使用 SSE + GraphQL，需 mock EventSource | Medium |
| SSE 心跳机制测试 | 需要真实 SSE 连接，集成测试已覆盖 | Low |
| Redis 缓存 TTL 测试 | 需要真实 Redis，单元测试已 mock | Low |
