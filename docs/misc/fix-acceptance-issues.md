# 验收问题分析与修复方案

**创建日期**: 2026-05-19
**作者**: ZeroAsh

---

## 问题 1: Thinking 和工具调用提示需要可折叠

### 现状

`ThoughtBlock` 和 `tool_call` 消息当前以展开状态渲染，无法折叠。而 `AvailableCommandsCard` 和 `UsageCard` 已使用 `AcpCard` 组件实现折叠功能。

### 原因分析

- `ThoughtBlock` (`apps/agent-web/src/components/session/ThoughtBlock.tsx`) 直接渲染完整思考内容，无折叠逻辑
- `tool_call` 在 `MessageItem` (`apps/agent-web/src/components/session/MessageItem.tsx`) 中渲染为紫色卡片，也无折叠
- `AcpCard` 组件已实现通用折叠容器，但 `ThoughtBlock` 和 `tool_call` 未使用它

### 修复方案

#### 1. ThoughtBlock 改用 AcpCard

```tsx
// ThoughtBlock.tsx
import AcpCard from './AcpCard';

export default function ThoughtBlock({ chunks, createdAt }: ThoughtBlockProps) {
  const text = chunks
    .map((chunk) => (chunk.content.type === 'text' ? chunk.content.text : ''))
    .join('');

  if (!text) return null;

  const summary = text.length > 60 ? text.slice(0, 60) + '...' : text;

  return (
    <AcpCard
      title="Thinking"
      summary={summary}
      defaultCollapsed={true}
      color="gray"
    >
      <div className="font-mono text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
        {text}
      </div>
      <div className="mt-2 text-xs text-gray-500">
        {createdAt ? new Date(createdAt).toLocaleTimeString() : ''}
      </div>
    </AcpCard>
  );
}
```

#### 2. tool_call 消息改用 AcpCard

在 `MessageList.tsx` 的 `tool_call` 分支中，将 `tool_call` + 紧随的 `tool_call_update` 合并为一个 `ToolCallCard`，使用 `AcpCard` 包装：

```tsx
// 新增 ToolCallCard.tsx
import AcpCard from './AcpCard';
import type { ToolCall } from '@agentclientprotocol/sdk';

interface ToolCallCardProps {
  toolCall: ToolCall;
  updates?: Array<{ status?: string; title?: string }>;
}

export default function ToolCallCard({ toolCall, updates }: ToolCallCardProps) {
  const latestUpdate = updates?.[updates.length - 1];
  const status = latestUpdate?.status || toolCall.status || 'running';
  const title = latestUpdate?.title || toolCall.title;

  const statusColors = {
    running: 'purple',
    completed: 'blue',
    failed: 'gray',
  } as const;

  return (
    <AcpCard
      title={`Tool: ${title}`}
      summary={status}
      defaultCollapsed={true}
      color={statusColors[status as keyof typeof statusColors] || 'purple'}
    >
      {toolCall.rawInput && (
        <div className="mb-2">
          <div className="text-xs font-medium text-gray-500 mb-1">Input</div>
          <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto">
            {JSON.stringify(toolCall.rawInput, null, 2)}
          </pre>
        </div>
      )}
      {latestUpdate?.status && (
        <div className="text-xs text-gray-500">Status: {latestUpdate.status}</div>
      )}
    </AcpCard>
  );
}
```

### 验证方案

1. 启动 Aspire，创建 session 并发送消息
2. 验证思考过程显示为可折叠的灰色卡片，默认折叠
3. 验证工具调用显示为可折叠的紫色卡片，默认折叠
4. 验证展开后内容正确显示
5. 运行 E2E 测试确认无回归

---

## 问题 2: ACP 协议按 messageId 拆分消息，需要聚合展示

### 现状

每条 ACP `SessionUpdate` chunk 存储为独立的 MongoDB 文档，前端逐个渲染。同一逻辑消息（如一段 AI 回复）可能被拆成多个 chunk 发送，每个 chunk 有不同的 `_id`，但共享相同的 `messageId`。

### 原因分析

**ACP SDK 类型**:
```typescript
type ContentChunk = {
  content: ContentBlock;
  /**
   * A unique identifier for the message this chunk belongs to.
   * All chunks belonging to the same message share the same `messageId`.
   * A change in `messageId` indicates a new message has started.
   */
  messageId?: string | null;
}
```

**当前存储**: controller-api 的 `handleControllerMessage()` 将每个 `SessionUpdate` 作为独立文档存储，`messageId` 仅存在于 `content` JSON 字符串内部，未提取为独立字段。

**当前分组**: `MessageList.groupMessages()` 仅按连续相同 `sessionUpdate` 类型分组，不考虑 `messageId`。如果同一消息的 chunks 被其他类型的消息（如 `usage_update`）打断，会被错误拆分为多个组。

### 修复方案

#### 1. Mongoose Schema 添加 messageId 字段

```typescript
// servers/agent-api/src/models/acp-message.ts
// servers/controller-api/src/models/acp-message.ts
const acpMessageSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  messageId: { type: String, index: true },  // 新增：ACP ContentChunk.messageId
  direction: { type: String, enum: ['input', 'output'], required: true },
  type: { type: String, enum: ['text', 'image', 'tool_call', 'tool_result', 'plan', 'error'], required: true },
  content: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
```

#### 2. controller-api 存储时提取 messageId

```typescript
// servers/controller-api/src/services/acp-session-manager.ts
async handleControllerMessage(sessionId: string, message: SessionUpdate): Promise<void> {
  const rawContent = JSON.stringify(message);
  // 提取 messageId（ContentChunk 类型中有此字段）
  const messageId = (message as Record<string, unknown>).messageId as string | undefined;

  // ... type classification ...

  const acpMessage = await AcpMessage.create({
    sessionId,
    messageId: messageId || null,  // 存储 messageId
    direction: 'output' as const,
    type,
    content: rawContent,
  });
}
```

#### 3. 前端按 messageId 分组

修改 `MessageList.groupMessages()`：

```typescript
function groupMessages(messages: AcpMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const parsed = parseSessionUpdate(message.content);
    const sessionUpdateType = parsed?.sessionUpdate;
    const chunkMessageId = (parsed as Record<string, unknown>)?.messageId as string | undefined;

    let groupType: MessageGroup['type'];
    // ... type classification (same as before) ...

    // 关键改动：只有 message/thought 类型且 messageId 相同时才继续当前组
    const shouldContinue =
      currentGroup &&
      currentGroup.type === groupType &&
      (groupType === 'message' || groupType === 'thought') &&
      chunkMessageId &&
      currentGroup.messageId === chunkMessageId;

    if (shouldContinue) {
      currentGroup!.messages.push(message);
    } else {
      currentGroup = {
        type: groupType,
        messages: [message],
        parsed,
        messageId: chunkMessageId || null,
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}
```

#### 4. GraphQL Schema 添加 messageId 查询支持

```graphql
type AcpMessage {
  id: ID!
  sessionId: ID!
  messageId: String       # 新增
  direction: AcpMessageDirection!
  type: AcpMessageType!
  content: String!
  metadata: String
  createdAt: String!
}
```

### 验证方案

1. 启动 Aspire，创建 session 并发送消息
2. 验证同一 messageId 的多个 chunks 合并显示为一条消息
3. 验证不同 messageId 的 chunks 分开显示
4. 验证被 `usage_update` 等打断的同一消息仍能正确聚合
5. 检查 MongoDB 中 `messageId` 字段正确存储
6. 运行所有测试确认无回归

---

## 问题 3: Close/Delete 工具未中止 ACP Server Session

### 现状

用户在 Web UI 点击 Close/Delete 按钮后，session 状态在数据库中更新，但 controller-api 拉起的 ACP server 进程（如 opencode）未被终止，继续运行。

### 原因分析

**架构断层**:

| 操作 | DB/Cache 清理 | 发送 acp:stop 给 controller? |
|------|-------------|---------------------------|
| `closeSession` (GraphQL) | 设置 status='ended'，清 Redis | **否** |
| `deleteSession` (GraphQL) | 删除 session + messages，清 Redis | **否** |
| `ACPSessionManager.stopSession()` | 发送 acp:stop，清理映射，设置 ended | **是** — 但从未被调用 |

**关键代码路径**:

1. `agent-api/services/session.ts` 的 `close()` 方法只更新数据库状态为 `ended`，不发布任何命令给 controller-api
2. `agent-api/services/session.ts` 的 `delete()` 方法只删除数据库记录，不通知 controller-api
3. `controller-api/services/acp-session-manager.ts` 的 `stopSession()` 方法已正确实现（发送 `acp:stop` 到 controller，清理内存映射，更新 DB 状态），但**没有任何代码路径调用它**

**消息流断裂点**:
```
前端 Close/Delete → GraphQL mutation → agent-api 更新 DB
                                          ↓ (缺失)
                              应发布 Redis session:command → controller-api 调用 stopSession()
```

### 修复方案

#### 1. agent-api 发布停止命令

在 `agent-api/services/session.ts` 的 `close()` 和 `delete()` 方法中，发布 Redis 命令通知 controller-api：

```typescript
// servers/agent-api/src/services/session.ts
import { getRedisClient } from '../config/redis';

async close(id: string, userId: string): Promise<boolean> {
  const session = await Session.findOneAndUpdate(
    { _id: id, userId },
    { status: 'ended', endedAt: new Date() },
  );
  if (session) {
    // 通知 controller-api 停止 ACP session
    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      sessionId: id,
      command: 'acp:stop',
      reason: 'user_close',
    }));
    await redis.del(`session:${id}:status`);
    return true;
  }
  return false;
}

async delete(id: string, userId: string): Promise<boolean> {
  // 先通知 controller-api 停止 ACP session
  const redis = getRedisClient();
  await redis.publish('session:command', JSON.stringify({
    sessionId: id,
    command: 'acp:stop',
    reason: 'user_delete',
  }));

  const result = await Session.findOneAndDelete({ _id: id, userId });
  if (result) {
    await AcpMessage.deleteMany({ sessionId: id });
    await redis.del(`session:${id}:status`);
    return true;
  }
  return false;
}
```

#### 2. controller-api 处理 acp:stop 命令

在 `controller-api/services/session-command.ts` 中添加 `acp:stop` 命令处理：

```typescript
// servers/controller-api/src/services/session-command.ts
async handleCommand(payload: { sessionId: string; command: string; reason?: string }): Promise<void> {
  switch (payload.command) {
    case 'acp:start':
      await this.acpSessionManager.startSession(payload.sessionId);
      break;
    case 'acp:check':
      await this.acpSessionManager.handleAcpCheck(payload.sessionId);
      break;
    case 'acp:stop':  // 新增
      await this.acpSessionManager.stopSession(payload.sessionId, payload.reason || 'user_request');
      break;
  }
}
```

#### 3. agent-controller 响应 acp:stop

已实现（`packages/agent-controller/src/socketio-client.ts` line 174-181）：

```typescript
socket.on('acp:stop', (data: AcpStopPayload) => {
  const bridge = acpBridges.get(data.sessionId);
  if (bridge) {
    bridge.stop();  // 发送 SIGTERM 到 ACP 进程
    acpBridges.delete(data.sessionId);
  }
});
```

无需修改。

### 验证方案

1. 启动 Aspire，创建 session 并等到 running
2. 点击 Close 按钮
3. 验证：
   - 前端 session 状态变为 ended
   - controller-api 的 ACP 进程被终止（`ps` 检查无 opencode 进程）
   - agent-controller 日志显示 `ACP stop requested` 和 `SIGTERM`
4. 重复测试 Delete 按钮
5. 运行 API 测试覆盖 `closeSession` 和 `deleteSession` 流程
6. 运行 E2E 测试确认无回归

---

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| **问题 1: 可折叠 UI** | | |
| `apps/agent-web/src/components/session/ThoughtBlock.tsx` | 修改 | 改用 AcpCard 包装 |
| `apps/agent-web/src/components/session/ToolCallCard.tsx` | 新增 | 工具调用折叠卡片 |
| `apps/agent-web/src/components/session/MessageList.tsx` | 修改 | tool_call 分支使用 ToolCallCard |
| **问题 2: messageId 聚合** | | |
| `servers/agent-api/src/models/acp-message.ts` | 修改 | Schema 添加 messageId 字段 |
| `servers/controller-api/src/models/acp-message.ts` | 修改 | Schema 添加 messageId 字段 |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | 存储时提取 messageId |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | AcpMessage 类型添加 messageId |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | resolver 返回 messageId |
| `apps/agent-web/src/components/session/MessageList.tsx` | 修改 | groupMessages 按 messageId 分组 |
| **问题 3: Close/Delete 中止 session** | | |
| `servers/agent-api/src/services/session.ts` | 修改 | close/delete 发布 Redis acp:stop 命令 |
| `servers/controller-api/src/services/session-command.ts` | 修改 | 处理 acp:stop 命令 |
| `tests/api/src/agent-api/session.test.ts` | 修改 | 补充 close/delete 测试 |
| `tests/e2e/src/session.spec.ts` | 修改 | E2E 验证 session 中止 |

---

## 实施顺序

1. **问题 3** (优先级最高): Close/Delete 未中止 session 影响用户体验和资源泄漏
2. **问题 2**: messageId 聚合是数据正确性的基础
3. **问题 1**: UI 改进，依赖问题 2 的分组逻辑

## 验收标准

- [ ] Thinking 块默认折叠，展开后显示完整思考过程
- [ ] tool_call 默认折叠，展开后显示输入/输出/状态
- [ ] 同一 messageId 的 chunks 合并显示为一条消息
- [ ] 不同 messageId 的 chunks 分开显示
- [ ] Close session 后 ACP 进程被终止
- [ ] Delete session 后 ACP 进程被终止
- [ ] 所有单元测试、API 测试、E2E 测试通过
