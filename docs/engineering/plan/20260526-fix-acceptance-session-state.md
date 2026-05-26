---
description: Session 状态验收问题修复的实施计划
type: Permanent
---

# Session 状态验收问题修复 — 实施计划

**关联提案**: [[../proposals/20260526-fix-acceptance-session-state.md|v1.2]]
**创建日期**: 2026-05-26
**状态**: 待 review

## 概览

本次实施包含 5 个独立的验收问题修复，按顺序执行：

| # | 问题 | 范围 |
|---|------|------|
| 1 | 移除 `currentModel` 冗余字段 | models、GraphQL、SSE、services、前端、测试 |
| 2 | 允许 setting update 后继续发送消息 | SessionPage.tsx |
| 3 | 修复 sessionData useEffect 覆盖 SSE 状态 | SessionPage.tsx |
| 4 | SubAgent 子任务卡片正确渲染 | ToolCallCard.tsx |
| 5 | 路由切换 Session 时显示 loading 并重置状态 | App.tsx / SessionPage.tsx |

---

## Step 1: 移除 `currentModel` 字段

### 1.1 数据模型层

```bash
# 文件: servers/agent-api/src/models/session.ts
# 删除第 17 行: currentModel: { type: { id: String, name: String, provider: String } },

# 文件: servers/controller-api/src/models/session.ts
# 删除第 15 行: currentModel: { type: { id: String, name: String, provider: String } },
```

### 1.2 GraphQL / 契约层

```bash
# 1. contracts/agent-session.graphql
# 删除 Session 类型中的: currentModel: AgentModelInfo

# 2. servers/agent-api/src/graphql/schemas/session.ts
# 删除 currentModel 字段定义 (约第 56 行)

# 3. servers/agent-api/src/graphql/resolvers/session.ts
# 检查并移除 mapSession 中对 currentModel 的映射

# 4. apps/agent-web/src/graphql/types.ts
# 从 GetSessionQuery['session'] 类型中移除 currentModel 字段

# 5. apps/agent-web/src/graphql/queries.ts
# 从 GET_SESSION 查询中移除 currentModel { id name provider }

# 6. contracts/agent-session-websocket.md
# 从 SSE status 事件 payload 示例中移除 currentModel 字段
```

### 1.3 后端服务层

```bash
# 1. servers/agent-api/src/services/session-sse.ts
# - 第 40 行: addConnection 中 statusPayload 移除 currentModel
# - 第 102 行: ensureGlobalStatusSubscriber 中 extra 移除 currentModel
# - 第 138 行: broadcastStatus 中 extra 移除 currentModel

# 2. servers/agent-api/src/services/session.ts
# - mapSession 方法中移除 currentModel 映射 (约第 464 行)

# 3. servers/controller-api/src/services/acp-session-manager.ts
# - 类型定义中移除 currentModel (SessionStartData, SessionResumeData)
# - start 路径: updateData、statusExtra、cacheModes、publishStatus 调用移除 currentModel
# - resume 路径: 同上
# - refreshSessionCache: 移除 session:${sessionId}:currentModel Redis key
# - cacheModes: 移除 currentModel 参数和逻辑
# - publishStatus: 移除 extra.currentModel
```

### 1.4 Agent 控制器层

```bash
# 1. packages/agent-controller/src/acp/bridge.ts
# - 删除 extractCurrentModel 方法 (约第 225-229 行)
# - acp:start:result 处理中移除 currentModel (约第 70 行)
# - acp:resume:result 处理中移除 currentModel (约第 101 行)
# - acp:initialized 事件中移除 currentModel (约第 121 行)

# 2. packages/agent-controller/src/socketio-client.ts
# - acp:start:result 发送时移除 currentModel (约第 222 行)
# - acp:resume:result 发送时移除 currentModel (约第 280 行)
```

### 1.5 前端层

```bash
# apps/agent-web/src/pages/SessionPage.tsx
# - 删除 _currentModel state (约第 70 行)
# - 删除 sessionData useEffect 中的 setCurrentModel 调用 (约第 93 行)
# - 删除 SSE status 事件中的 setCurrentModel 调用 (约第 143 行)
```

### 1.6 测试层

```bash
# 1. tests/api/src/agent-api/session.test.ts
# - 移除 currentModel 相关断言和测试夹具

# 2. servers/agent-api/src/services/session-sse.test.ts
# - 移除 currentModel 相关测试用例

# 3. packages/agent-controller/tests/acp-bridge.test.ts
# - 移除 currentModel 相关断言
```

### 1.7 验证

```bash
# 全局搜索确认无遗漏
rg "currentModel" --type ts --type tsx --type graphql --type md
# 预期结果: 无匹配（或仅 DB migration 保留数据）
```

---

## Step 2: 修复 sessionData useEffect 覆盖 SSE 状态

### 2.1 问题说明

`SessionPage.tsx` 第 88-97 行的 useEffect 依赖 `sessionData`，每次 Sidebar 的 `GET_SESSIONS` 轮询返回都会触发，覆盖 SSE 更新的状态。

### 2.2 修改 SessionPage.tsx

```typescript
// 新增一个 ref 跟踪是否已初始化
const initializedRef = useRef(false);

// 修改 useEffect 依赖为 [id]，并增加 initializedRef 保护
useEffect(() => {
  if (sessionData?.session && !initializedRef.current) {
    initializedRef.current = true;
    setStatus(sessionData.session.status);
    if (sessionData.session.modes) setModes(sessionData.session.modes as AgentModeData[]);
    if (sessionData.session.currentModeId) setCurrentModeId(sessionData.session.currentModeId);
    if (sessionData.session.availableModels) setAvailableModels(sessionData.session.availableModels as AgentModelInfoData[]);
    if (sessionData.session.currentModelId) setCurrentModelId(sessionData.session.currentModelId);
  }
  // 使用 [id] 而非 [sessionData] 作为依赖
  // 当 session id 变化时会重新初始化
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [id]);
```

### 2.3 验证方式

1. 启动应用并创建 session
2. 在 ModelSwitcher 中切换 model
3. 观察 15 秒后 model 是否被"弹回"（修复前会，修复后不会）

---

## Step 3: 允许 setting update 后继续发送消息

### 3.1 问题说明

当最后一条消息是 setting update（config_option_update / current_mode_update）时，用户可能无法发送新消息。

### 3.2 修改 SessionPage.tsx

```typescript
// 新增 ref 跟踪最后一条消息是否为 setting update
const lastMessageIsSettingUpdateRef = useRef(false);

// SSE onmessage handler 中设置标记
if (data.type === 'message') {
  setMessages((prev) => [...prev, data.data]);
  try {
    const content = JSON.parse(data.data.content);
    if (content.sessionUpdate === 'config_option_update' || content.sessionUpdate === 'current_mode_update') {
      lastMessageIsSettingUpdateRef.current = true;
    }
  } catch { }
}

// SSE status 事件到达时，如果状态不是 idling/running，保留标记
if (data.type === 'status') {
  setStatus(data.data.status);
  // 不清除 lastMessageIsSettingUpdateRef.current
  // 因为此时状态可能还未切换完成
}

// handleSendMessage 中重置标记
const handleSendMessage = async (content: string) => {
  if (!id) return;
  lastMessageIsSettingUpdateRef.current = false; // reset
  setSending(true);
  await sendMessage({ variables: { sessionId: id, content, type: 'text' } });
};

// 修改 disabled 条件
disabled={(status !== 'running' && status !== 'idling') && !lastMessageIsSettingUpdateRef.current}
```

---

## Step 4: SubAgent 子任务卡片正确渲染

### 4.1 问题说明

`ToolCallCard.tsx` 未处理 `subagent_type` 字段，导致 SubAgent 和普通 ToolCall 都显示为相同的紫色卡片。

### 4.2 修改 ToolCallCard.tsx

```typescript
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface ToolCallCardProps {
  messages: Array<{ content: string | Record<string, unknown>; createdAt: string }>;
}

// 检测是否为 SubAgent
function isSubAgent(parsed: SessionUpdate): boolean {
  const rawInput = parsed.rawInput as Record<string, unknown> | undefined;
  return !!(parsed.subagent_type || (rawInput && rawInput.subagent_type));
}

// 类型标签映射
const subagentTypeLabels: Record<string, string> = {
  'explore': 'Explore',
  'general': 'General',
};

function ToolCallCard({ messages }: ToolCallCardProps) {
  let title = 'Tool Call';
  let status: string = 'in_progress';
  let rawInput: unknown = null;
  let isSubAgentFlag = false;
  let subagentType: string | null = null;

  for (const msg of messages) {
    try {
      const parsed = typeof msg.content === 'object'
        ? msg.content as SessionUpdate
        : JSON.parse(msg.content) as SessionUpdate;

      const rawInputObj = parsed.rawInput as Record<string, unknown> | undefined;

      if (parsed.sessionUpdate === 'tool_call' || parsed.sessionUpdate === 'tool_call_update') {
        const currentSubagentType = parsed.subagent_type || (rawInputObj?.subagent_type as string) || null;
        if (currentSubagentType) {
          isSubAgentFlag = true;
          subagentType = currentSubagentType;
        }
        if (parsed.title) title = parsed.title;
        if (parsed.status) status = parsed.status;
        if (parsed.rawInput) rawInput = parsed.rawInput;
      }
    } catch { }
  }

  const statusColors: Record<string, string> = {
    pending: 'yellow',
    in_progress: 'purple',
    completed: 'blue',
    failed: 'gray',
  };

  // 生成显示标题
  const displayTitle = (() => {
    if (isSubAgentFlag) {
      return `SubAgent: ${subagentTypeLabels[subagentType || ''] || subagentType || 'task'}`;
    }
    return `Tool Call: ${title}`;
  })();

  // 选择颜色（SubAgent 用蓝色）
  const displayColor = isSubAgentFlag ? 'blue' : (statusColors[status] as 'yellow' | 'purple' | 'blue' | 'gray') || 'purple';

  return (
    <AcpCard
      title={displayTitle}
      summary={status}
      defaultCollapsed={true}
      color={displayColor}
    >
      {rawInput != null && (
        <div className="mb-2">
          <div className="text-xs font-medium text-gray-500 mb-1">Input</div>
          <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto">
            {typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)}
          </pre>
        </div>
      )}
      <div className="text-xs text-gray-500">Status: {status}</div>
    </AcpCard>
  );
}

export default ToolCallCard;
```

---

## Step 5: 路由切换 Session 时显示 loading 并重置状态

### 5.1 问题说明

当用户在 `/sessions/sessionA` 时直接导航到 `/sessions/sessionB`，由于 React Router v7 复用 `SessionPage` 组件实例（无 `key` prop），导致：

1. `messages` 状态保留旧 session 的数据，直到 SSE `'history'` 到达才更新
2. 无 loading spinner 显示
3. 用户看到上一个 session 的消息列表

### 5.2 问题分析

**App.tsx 路由定义：**
```tsx
<Route path="sessions/:id" element={<SessionPage />} />
```
没有 `key` prop，React Router 复用组件实例。

**SessionPage.tsx state：**
```tsx
const [messages, setMessages] = useState<AcpMessage[]>([]);  // 初始化为空数组
const [status, setStatus] = useState<string>('connecting');
// ... 其他 state
```

当 `id` 从 `sessionA` 变为 `sessionB` 时：
- 组件实例复用，`useState` 的值保持不变
- `messages` 仍然是 `sessionA` 的消息
- `sessionLoading` 可能不会触发新的 loading 状态（Apollo 缓存）
- SSE 连接正确关闭并重建，但 messages 不会立即清空

### 5.3 方案

**方案一（推荐）：在路由上添加 `key` prop 强制组件重载**

```tsx
// App.tsx
<Route path="sessions/:id" element={<SessionPage key={useLocation().pathname} />} />
```

React Router v7 中，当 `key` 变化时会销毁旧组件并创建新组件，实现完全重置。

**方案二：在 SessionPage 内部监听 id 变化并重置所有状态**

```tsx
// SessionPage.tsx useEffect
useEffect(() => {
  // 当 id 变化时，重置所有状态
  setMessages([]);
  setStatus('connecting');
  setSending(false);
  setResuming(false);
  setErrorToast(null);
  // ... 重置其他状态
  initializedRef.current = false; // 重置初始化标记
}, [id]);
```

### 5.4 方案比较

| 方案 | 优点 | 缺点 |
|------|------|------|
| 方案一（key prop） | 简单彻底，React 自动处理所有状态重置 | 每次路由变化都销毁重建组件 |
| 方案二（内部监听） | 更细粒度控制，避免不必要的重载 | 需要手动重置所有 state，容易遗漏 |

**推荐方案一**：因为 SessionPage 本来就是路由页面，切换 session 本质上应该是一个全新的页面视图。

### 5.5 实现

**App.tsx:**

```tsx
// apps/agent-web/src/App.tsx
import { useLocation } from 'react-router-dom';

// 在路由中使用 key
<Route path="sessions/:id" element={<SessionPage key={useLocation().pathname} />} />
```

**注意：** 需要确保 `useLocation` 在 `Routes` 组件外部被调用，或者将 `key` 改为其他稳定值（如 `id` param）：

```tsx
// 方案 A: 使用 location.pathname
<Route path="sessions/:id" element={<SessionPage key={useLocation().pathname} />} />

// 方案 B: 直接使用 id（更精确，每次 session 切换都会重载）
// 但需要先获取 params，这里无法直接访问
// 所以方案 A 更适合当前结构
```

如果方案 A 有问题，可以使用更简单的方式——在 SessionPage 内部实现重置逻辑（方案二）。

### 5.6 验证方式

1. 打开 `/sessions/sessionA`
2. 直接在地址栏输入 `/sessions/sessionB` 并回车
3. 观察：
   - 是否立即显示 loading spinner
   - 是否清空了 sessionA 的消息
   - 是否在短暂延迟后显示 sessionB 的消息

---

## 验收清单

| # | 检查项 | 验证方式 |
|---|--------|----------|
| 1 | `currentModel` 全链路移除 | `rg "currentModel" --type ts --type tsx` 无匹配 |
| 2 | GraphQL `GET_SESSION` 不含 `currentModel` | Apollo DevTools 检查 network |
| 3 | SSE status 事件不含 `currentModel` | 浏览器 DevTools 检查 SSE 消息 |
| 4 | ModelSwitcher 切换后 15s 不被轮询覆盖 | 实际操作观察 |
| 5 | setting update 后可发送消息 | 实际操作观察 |
| 6 | SubAgent 显示蓝色卡片 + "SubAgent:" 前缀 | 触发 SubAgent 任务观察 |
| 7 | 普通 ToolCall 保持紫色卡片 | 触发普通 ToolCall 观察 |
| 8 | 路由切换 session 时显示 loading spinner | 直接在地址栏切换 session 观察 |
| 9 | 路由切换 session 时消息列表被清空 | 直接在地址栏切换 session 观察 |
| 10 | 所有测试通过 | `npm run test` |

---

## 执行顺序

```
Step 1 (移除 currentModel) → Step 2 (修复 useEffect 覆盖) → Step 3 (setting update) → Step 4 (SubAgent) → Step 5 (路由切换)
         ↓                           ↓                           ↓                    ↓                    ↓
      最复杂，先做                  依赖 SessionPage           独立                  独立                  简单
```

建议每个 Step 完成后运行 `npm run test` 验证无回归，再进行下一步。