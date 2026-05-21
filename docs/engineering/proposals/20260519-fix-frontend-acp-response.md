# 前端 ACP 会话修复方案

**关联问题**: fix-acp-session-init.md 验收后前端无响应
**创建日期**: 2026-05-19
**作者**: ZeroAsh

## 1. 问题分析

### 问题 1: Vite 无代理配置导致 SSE 404（根因）

**现象**: Session 创建后前端始终显示 "connecting"，不会变为 "running"，消息区域显示 "No messages yet"。

**截图诊断**:
- 状态 badge 始终为黄色 "connecting"
- 消息区域空白，显示 "No messages yet. Start a conversation!"
- Input 框 placeholder 为 "Session is not active..."，Send 按钮灰色禁用
- 控制台错误: `Failed to load resource: the server responded with a status of 404 (Not Found)` + `SSE connection error`

**根因**: `apps/agent-web/vite.config.ts` 缺少 `server.proxy` 配置。

请求路径分析:
```
前端 EventSource: new EventSource('/api/session/${id}/stream')
                ↓
Vite dev server: http://localhost:35687/api/session/${id}/stream  ← 404!
                ↓
期望: proxy 转发到 → http://localhost:42367/api/session/${id}/stream
```

- **Apollo Client (GraphQL)**: 使用 `VITE_API_URL` 环境变量直连 agent-api（`http://localhost:42367/graphql`），跨域请求正常
- **EventSource (SSE)**: 使用相对路径 `/api/session/...`，请求发往 Vite dev server（同源），但 Vite 没有 `/api` 路由，返回 404

### 问题 2: ACP 消息类型渲染不完整

**合约定义的 AcpMessageType**: `text` | `image` | `tool_call` | `tool_result` | `plan` | `error`

**当前 `MessageItem.tsx` 支持**: `text` | `tool_call` | `tool_result` | `plan` | `error`

**缺失**:
- `image` 类型：合约定义了但未渲染为图片，走 default 分支显示为灰色纯文本
- `metadata` 字段：tool_call 的工具名、status 等元信息被丢弃（metadata 是 JSON string，从未解析）

### 问题 3: 前端无法与 ACP Server 交互

**消息流路径**:
```
前端 Send → GraphQL sendSessionMessage → agent-api → Redis session:command
→ controller-api sessionCommandService → acpSessionManager.sendMessage()
→ controller socket acp:message → bridge.sendInput() → opencode stdin
```

此路径在后端已验证通过（API 测试全部通过）。前端问题仅是 SSE 断导致看不到响应。

## 2. 修复方案

### 阶段 1: SSE 使用绝对 URL（与 GraphQL 统一）

**文件**: `apps/agent-web/src/pages/SessionPage.tsx`

当前 GraphQL 使用 `${VITE_API_URL}/graphql` 直连 agent-api，SSE 却用相对路径 `/api/session/...` 走 Vite dev server。统一为相同模式：

```typescript
// 修改前（相对路径，走 Vite → 404）
const eventSource = new EventSource(`/api/session/${id}/stream`);

// 修改后（绝对 URL，直连 agent-api，与 Apollo 一致）
const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const eventSource = new EventSource(`${apiBase}/api/session/${id}/stream`);
```

同时修复 `useSessionStream` hook 中的同一问题：

### 阶段 2: 完善 ACP 消息渲染

**文件**: `apps/agent-web/src/components/session/MessageItem.tsx`

1. **添加 `image` 类型渲染**:
```typescript
case 'image':
  return 'bg-indigo-100 text-indigo-900 border border-indigo-200';
```

渲染逻辑：当 `type === 'image'` 时，检查 `content` 是否为 base64 data URI 或 URL，渲染 `<img>` 标签。

2. **解析 `metadata` 字段**:
```typescript
const metadata = message.metadata ? JSON.parse(message.metadata) : null;

// tool_call 显示工具名
case 'tool_call':
  return (
    <div>
      <div className="text-xs font-mono opacity-75">{metadata?.toolName}</div>
      <Markdown>{message.content}</Markdown>
    </div>
  );
```

### 阶段 3: E2E 测试覆盖

#### 3.1 状态迁移测试

**新增文件**: `tests/e2e/src/session-status.spec.ts`

测试 session 从 `creating` → `connecting` → `running` 的完整状态迁移：

```typescript
test('should transition from creating to running via SSE', async ({ page }) => {
  // 1. 注册用户 + 创建 key + 启动 fake controller
  // 2. 创建 session
  // 3. fake controller 响应 acp:start:result success
  // 4. 验证前端状态变为 running（通过 SSE 推送）
  // 5. 验证 input 框变为可用
});
```

#### 3.2 消息渲染测试

**新增文件**: `tests/e2e/src/session-message.spec.ts`

```typescript
test('should render text messages from ACP server', async ({ page }) => {
  // 1. 创建 session 并等到 running
  // 2. fake controller 发送 acp:message (type: text)
  // 3. 验证消息出现在 MessageList 中
});

test('should render tool_call messages with metadata', async ({ page }) => {
  // 1. fake controller 发送 acp:message (type: tool_call, metadata: {toolName: "read_file"})
  // 2. 验证 "Tool Call" 标签和工具名显示
});

test('should render error messages with red styling', async ({ page }) => {
  // 1. fake controller 发送 acp:message (type: error)
  // 2. 验证 "Error" 标签和红色背景
});
```

#### 3.3 端到端对话测试

**新增文件**: `tests/e2e/src/session-chat.spec.ts`

```typescript
test('should send message and receive response via ACP', async ({ page }) => {
  // 1. 创建 session 并等到 running
  // 2. 用户在 input 输入消息并点击 Send
  // 3. 验证消息出现在 MessageList（direction: input）
  // 4. fake controller 收到 acp:message 并发送响应
  // 5. 验证响应消息出现在 MessageList（direction: output）
});
```

### 阶段 4: 错误检查

#### 4.1 前端 Console 检查

在所有 E2E 测试中添加 console 错误监控：

```typescript
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
});
test.afterEach(async () => {
  expect(errors).toEqual([]);
});
```

#### 4.2 后端 Logs 检查

API 测试中检查 controller-api 和 agent-api 无错误日志。

#### 4.3 Controller 检查

验证 controller 进程无 stderr 输出（除预期的 shutdown 日志外）。

## 3. 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| **阶段 1: SSE 统一 URL（根因修复）** | | |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | EventSource 使用 `VITE_API_URL` 绝对 URL |
| `apps/agent-web/src/hooks/useSessionStream.ts` | 修改 | 同上 |
| **阶段 2: 消息渲染** | | |
| `apps/agent-web/src/components/session/MessageItem.tsx` | 修改 | 添加 image 类型、解析 metadata |
| **阶段 3: E2E 测试** | | |
| `tests/e2e/src/session-status.spec.ts` | 新增 | 状态迁移 E2E 测试 |
| `tests/e2e/src/session-message.spec.ts` | 新增 | 消息渲染 E2E 测试 |
| `tests/e2e/src/session-chat.spec.ts` | 新增 | 端到端对话 E2E 测试 |

## 4. 验收标准

- [ ] SSE 使用 `VITE_API_URL` 绝对 URL（与 GraphQL 统一），无 404 错误
- [ ] SSE 连接成功（无 404 错误），前端能收到 `status` 和 `message` 事件
- [ ] Session 状态从 `creating` → `connecting` → `running` 正确迁移并反映在 UI
- [ ] `running` 状态时 input 框可用，`connecting` 时禁用
- [ ] ACP `text`/`tool_call`/`tool_result`/`plan`/`error`/`image` 消息正确渲染
- [ ] `tool_call` 显示工具名（从 metadata 解析）
- [ ] E2E 测试覆盖状态迁移、消息渲染、端到端对话
- [ ] 所有 E2E 测试中前端 console 无 error
- [ ] API 测试中后端 logs 无 error
- [ ] 集成测试中 controller 无 error
