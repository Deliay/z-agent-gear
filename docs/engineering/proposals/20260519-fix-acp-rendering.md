# ACP 消息渲染改造计划

## 目标

基于 `@agentclientprotocol/sdk` 的 `SessionUpdate` 类型，改造前端消息列表的渲染逻辑，正确展示各类 ACP 更新。

## ACP SDK 类型参考

```typescript
// node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts

type SessionUpdate =
  | (ContentChunk & { sessionUpdate: "user_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_thought_chunk" })
  | (ToolCall & { sessionUpdate: "tool_call" })
  | (ToolCallUpdate & { sessionUpdate: "tool_call_update" })
  | (Plan & { sessionUpdate: "plan" })
  | (AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" })
  | (UsageUpdate & { sessionUpdate: "usage_update" })
  | ...

type ContentChunk = {
  content: ContentBlock;       // ContentBlock = TextContent | ImageContent | ...
  messageId?: string | null;
  _meta?: object | null;
}

type TextContent = { type: "text"; text: string }

type ToolCall = {
  title: string;               // 人类可读的工具描述
  toolCallId: string;
  kind?: ToolKind;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: ToolCallStatus;
}

type AvailableCommandsUpdate = {
  availableCommands: Array<{
    name: string;              // 命令名，如 "create_plan"
    description: string;       // 人类可读描述
    input?: AvailableCommandInput;
  }>;
}

type UsageUpdate = {
  size: number;                // 上下文窗口总大小 (tokens)
  used: number;                // 当前已用 tokens
  cost?: { amount: number; currency: string } | null;
}
```

## 改造内容

### 1. MessageItem 单条消息渲染

**文件**: `apps/agent-web/src/components/session/MessageItem.tsx`

当前 `MessageItem` 是纯展示组件，只接收单条 `AcpMessage`。需要根据 `sessionUpdate` 类型做不同渲染：

| sessionUpdate | 渲染方式 |
|---|---|
| `user_message_chunk` | 蓝色气泡，右对齐，`content.text` 作为纯文本 |
| `agent_message_chunk` | 白色气泡，左对齐，`content.text` 作为 Markdown 渲染 |
| `agent_thought_chunk` | 灰色引用块样式，`content.text` 作为代码/思考过程渲染 |
| `tool_call` | 紫色卡片，显示 `title`，可展开查看 `rawInput`/`locations` |
| `tool_call_update` | 同 tool_call，更新状态 |
| `available_commands_update` | 折叠卡片，摘要 "N 个工具已加载"，展开显示工具列表 |
| `usage_update` | 折叠卡片，摘要 "本次消耗 N tokens"，展开显示详细用量 |
| `plan` | 黄色卡片，显示计划条目 |

### 2. MessageList 分组逻辑

**文件**: `apps/agent-web/src/components/session/MessageList.tsx`

当前 `MessageList` 逐条渲染 `MessageItem`。需要改造为：

1. **遍历 messages**，按 `sessionUpdate` 类型分组：
   - 连续的 `agent_message_chunk` → 合并为一条 AI 回复
   - 连续的 `agent_thought_chunk` → 合并为一个思考块
   - `tool_call` + 紧随的 `tool_call_update` → 合并为一个工具调用卡片
   - `available_commands_update` / `usage_update` → 独立卡片

2. **分组策略**：
   ```
   groups = []
   for message in messages:
     parse acpUpdate from message.content
     if acpUpdate is agent_message_chunk:
       append text to current AI group
     else if acpUpdate is agent_thought_chunk:
       append text to current thought group
     else:
       flush current group, create new group for this message
   ```

3. **渲染分组**：每个 group 渲染为一个 `MessageItem` 或专用卡片组件

### 3. 新增组件

#### `AcpCard.tsx` - 通用 ACP 卡片容器

```tsx
// 折叠/展开的卡片容器
interface AcpCardProps {
  title: string;
  summary: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}
```

#### `AvailableCommandsCard.tsx` - 工具列表卡片

- 解析 `AvailableCommandsUpdate.availableCommands`
- 折叠时显示摘要：`${n} 个工具已加载`
- 展开时显示工具列表，每项显示 `name` + `description`

#### `UsageCard.tsx` - 用量卡片

- 解析 `UsageUpdate`
- 折叠时显示摘要：`本次消耗 ${used} tokens`
- 展开时显示：context window size、已用 tokens、费用（如有）

#### `ThoughtBlock.tsx` - 思考过程块

- 连续 `agent_thought_chunk` 合并后的渲染
- 使用灰色引用块样式（类似 `blockquote` 或代码块）
- `content.text` 渲染为等宽字体文本

### 4. 用户消息格式修正

**文件**: `servers/controller-api/src/services/acp-session-manager.ts`

当前 `sendMessage` 已经生成 ACP 格式：
```typescript
const rawContent = JSON.stringify({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text: message.content },
});
```

确认此格式与 SDK 的 `ContentChunk & { sessionUpdate: "user_message_chunk" }` 一致。

### 5. Bridge 无需修改

Bridge 已经发送原始 ACP `SessionUpdate` 对象，无需改动。

## 实现步骤

1. 新增 `AcpCard`、`AvailableCommandsCard`、`UsageCard`、`ThoughtBlock` 组件
2. 改造 `MessageList`：遍历 messages，解析 `content` 为 `SessionUpdate`，按类型分组
3. 改造 `MessageItem`：根据分组后的类型渲染不同样式
4. 更新测试
5. 遇到不确定的问题不要猜测！直接使用ask工具向用户提问！

## 验证

- 跑通所有单元测试、集成测试、API测试、E2E测试
- 启动 Aspire，发送消息，验证：
  - 用户消息蓝色气泡右对齐
  - AI 回复白色气泡左对齐，Markdown 正确渲染
  - 思考过程灰色引用块
  - 工具调用紫色卡片
  - 工具列表折叠卡片
  - 用量折叠卡片