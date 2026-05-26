---
description: 修复 Session 状态相关的验收问题：前端清理 currentModel 冗余字段、修复 SubAgent/read/fetch 卡片渲染（tool_call_update 拦截问题）、修复 sessionData useEffect 被轮询覆盖、允许 setting update 后发送消息、路由切换时显示 loading 状态
type: Permanent
---

# Session 状态验收问题修复

**功能名称**: Session 状态验收问题修复
**技术提案版本**: v1.4
**创建日期**: 2026-05-26
**作者**: opencode

## 1. 概述

### 1.1 背景

当前代码中存在 5 个 Session 状态相关的验收问题：

1. **前端 `currentModel` 字段冗余** - 前端存在 `_currentModel` state 和 `setCurrentModel` 调用，但 `currentModel` 可从 `currentModelId` + `availableModels` 推导，属于死代码
2. **SubAgent / read / fetch 卡片未正确路由** - `kind=read`、`kind=fetch`、`kind=other+subagent_type` 的检测代码都在 `MessageList.tsx` 的 `else` 分支中（第 82-87 行），但由于 SubAgent/read/fetch 消息的 `sessionUpdate` 为 `tool_call_update`，被第 64 行提前拦截并归类为 `tool_call`
3. **`sessionData` useEffect 被 `GET_SESSIONS` 轮询覆盖** - Sidebar 每 15s 轮询会通过 Apollo 归一化缓存更新 `Session` 实体，触发 `useEffect([sessionData])`，覆盖 SSE 更新的状态
4. **Setting update 后可能无法发送消息** - 当最后一条消息是 setting update 且状态未及时切换时，输入框可能被禁用
5. **Session 路由切换时无 loading 状态** - 从 sessionA 直接导航到 sessionB 时，组件复用导致旧数据残留

> **注意**：后端和契约层的 `currentModel` 暂不处理，保留现有字段不做删除。

### 1.2 目标

- 前端清理 `currentModel` state 和相关调用
- SubAgent / read / fetch 卡片正确渲染（检测 `kind` 和 `subagent_type` 并路由到对应卡片组件）
- 修复 `sessionData` useEffect 被轮询覆盖的问题
- Setting update 消息后允许用户继续发送消息
- Session 路由切换时正确显示 loading 状态

### 1.3 范围

涉及 `apps/agent-web` 前端模块，`servers/agent-api`、`servers/controller-api`、`packages/agent-controller`、`contracts` 仅在 SSE 事件 payload 中移除 `currentModel`（不影响后端数据模型和契约定义）。

## 2. 问题分析与方案

### 2.1 问题一：移除 `currentModel`

#### 现状

`currentModel: { id: String, name: String, provider: String }` 是一个对象字段，存储完整的模型信息。而 `currentModelId: String` 仅存储模型 ID。两者同时写入 MongoDB、Redis，同时在 SSE、GraphQL 中传输。

关系图：

```mermaid
flowchart LR
    subgraph DB[MongoDB / Redis]
        CM[currentModel: {id, name, provider}]
        CMI[currentModelId: string]
        AM[availableModels: [{id, name, provider}]]
    end
    subgraph Frontend[Frontend]
        MS[ModelSwitcher]
    end
    CMI --> MS
    AM --> MS
    MS -->|本地查找| Derived[推导出 currentModel]
    CM -.->|从未使用| Dead[死代码]

    style Dead fill:#ff9999
    style CM fill:#ffcc99
```

`currentModel` 在前端是死代码：
- `SessionPage.tsx` 中 `_currentModel` 以下划线开头（未使用变量），仅通过 `setCurrentModel` 被动接收值
- `ModelSwitcher.tsx` 直接从 `currentModelId` + `availableModels` 本地推导 `currentModel`
- `InputBox.tsx` 不接收 `currentModel` prop，只接收 `currentModelId`

#### 方案

前端清理 `currentModel` state + SSE payload 清理（按层执行）：

```mermaid
flowchart TD
    A[开始] --> B[契约层: contracts/agent-session-websocket.md 移除 currentModel]
    B --> C[SSE Service 层: agent-api session-sse.ts 移除 currentModel payload]
    C --> D[Frontend: 移除 _currentModel state 和 setCurrentModel 调用]
    D --> E[完成]

    style B fill:#ffcc99
    style C fill:#ffcc99
```

> **注意**：后端数据模型（MongoDB schema）和 GraphQL 契约（agent-session.graphql, agent-api schema）暂不处理，保留 `currentModel` 字段不做删除。后端服务和控制器层中 SSE 事件 payload 清理见 Step 1。

### 2.2 问题二：SubAgent / read / fetch 卡片未正确路由

#### 现状

`MessageList.tsx` 的 `groupMessages` 函数中，消息分组类型检测逻辑如下（第 58-94 行）：

```typescript
if (sessionUpdateType === 'user_message_chunk') {
  groupType = 'user_message';
} else if (sessionUpdateType === 'agent_message_chunk') {
  groupType = 'agent_message';
} else if (sessionUpdateType === 'agent_thought_chunk') {
  groupType = 'thought';
} else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {  // ← 第64行
  groupType = 'tool_call';  // ← 所有 tool_call_update 消息被拦截
  // ...
} else {
  // ← 第76行：read/fetch/sub_agent 检测在这里，但永远不会被 tool_call_update 消息到达
  if (kind === 'read') groupType = 'read';
  else if (kind === 'fetch') groupType = 'fetch';
  else if (kind === 'other' && rawInput?.subagent_type) groupType = 'sub_agent';  // ← 死代码
}
```

用户反馈的三类消息数据结构：

**SubAgent:**
```json
{
  "sessionUpdate": "tool_call_update",
  "kind": "other",
  "subagent_type": "explore",
  "rawInput": { "subagent_type": "explore", ... }
}
```

**read:**
```json
{
  "sessionUpdate": "tool_call_update",
  "kind": "read",
  "locations": [{ "path": "..." }],
  "rawInput": { "filePath": "...", "limit": 90, "offset": 80 }
}
```

**fetch:**
```json
{
  "sessionUpdate": "tool_call_update",
  "kind": "fetch",
  "rawInput": { "url": "..." },
  "rawOutput": { "output": "..." }
}
```

#### 根因分析

所有三类消息的 `sessionUpdate` 均为 `"tool_call_update"`，在第 64 行被匹配并归类为 `'tool_call'`。第 76-93 行的 `else` 分支永远不会被这些消息到达，是死代码。

结果：
- 三类卡片全部被渲染为 `ToolCallCard`
- `ToolCallCard` 不处理 `locations`、`rawInput` 中的 `filePath`/`url` 等字段
- read 卡片应显示文件路径和内容、fetch 卡片应显示 URL 和结果，全部无法展示

#### 方案

在 `tool_call`/`tool_call_update` 分支中增加 `kind` 和 `subagent_type` 检测，根据 `kind` 路由到对应类型：

```typescript
} else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
  // 检查是否为 specialized tool call (sub_agent / read / fetch)
  if (parsed) {
    const p = parsed as Record<string, unknown>;
    const kind = p.kind as string | undefined;
    const rawInput = p.rawInput;
    if (kind === 'read') {
      groupType = 'read';
    } else if (kind === 'fetch') {
      groupType = 'fetch';
    } else if (kind === 'other' && rawInput && typeof rawInput === 'object' && (rawInput as Record<string, unknown>).subagent_type) {
      groupType = 'sub_agent';
    } else {
      groupType = 'tool_call';
    }
  } else {
    groupType = 'tool_call';
  }
```

分组策略：三类 specialized 类型均使用 `toolCallId` 分组（与 `tool_call` 相同），确保初始调用和后续更新合并到同一组。

`ReadCard.tsx`、`FetchCard.tsx`、`SubAgentCard.tsx` 均已正确实现，无需修改。

#### 根因分析

`content.sessionUpdate` 为 `"tool_call_update"`，在第 64 行被 `sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update'` 匹配，`groupType` 被设为 `'tool_call'`。

第 76-93 行的 `else` 分支中虽然有 `sub_agent` 检测（第 86 行：`kind === 'other' && rawInput?.subagent_type`），但该分支**永远不会被 `tool_call`/`tool_call_update` 消息到达**，是死代码。

结果：
- SubAgent 消息被渲染为 `ToolCallCard`
- `ToolCallCard` 不处理 `subagent_type`、`rawInput.description`、`rawInput.prompt`、`rawOutput` 等字段
- 用户看到的是普通的 "Tool Call — in_progress" 卡片，而非 SubAgent 信息

#### 方案

在 `tool_call`/`tool_call_update` 分支中增加 `subagent_type` 检测，如果检测到则路由到 `sub_agent` 类型：

```typescript
} else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
  // 检查是否为 SubAgent 消息
  if (parsed) {
    const p = parsed as Record<string, unknown>;
    const kind = p.kind as string | undefined;
    const rawInput = p.rawInput;
    const subagentType = p.subagent_type as string | undefined;
    const rawInputSubagentType = rawInput && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>).subagent_type
      : undefined;
    if (kind === 'other' && (subagentType || rawInputSubagentType)) {
      groupType = 'sub_agent';
    } else {
      groupType = 'tool_call';
    }
  } else {
    groupType = 'tool_call';
  }
```

检测逻辑：
1. 检查 `kind === 'other'`（SubAgent 消息的约定标识）
2. 检查 `content` 级别或 `rawInput` 中是否存在 `subagent_type`
3. 两者任一满足即归类为 `sub_agent`

SubAgent 消息的分组策略（第 98-106 行）：
- 对于 `sub_agent` 类型，应使用 `toolCallId` 分组（与 `tool_call` 相同），确保同一 SubAgent 的初始调用和后续更新合并到同一组

`SubAgentCard.tsx` 无需修改——它已正确处理 `rawInput.description`、`rawInput.prompt`、`rawOutput` 等字段。

### 2.3 问题三：`sessionData` useEffect 被轮询覆盖

#### 现状

SessionPage.tsx 中 SSE 事件处理已覆盖 SSE status 事件中的各个字段：

```typescript
} else if (data.type === 'status') {
  setStatus(data.data.status);
  if (data.data.status === 'ended' && data.data.error) { ... }
  if (data.data.status === 'idling') { ... }
  if (data.data.modes) setModes(data.data.modes);
  if (data.data.currentModeId) setCurrentModeId(data.data.currentModeId);
  if (data.data.currentModel) setCurrentModel(data.data.currentModel);
  if (data.data.availableModels) setAvailableModels(data.data.availableModels);
  if (data.data.currentModelId) setCurrentModelId(data.data.currentModelId);
}
```

但存在一个**严重的覆盖问题**——`sessionData` 的 `useEffect` 会被后台轮询触发，将 SSE 更新的状态覆盖掉：

```typescript
// SessionPage.tsx L88-97 — 问题根源
useEffect(() => {
  if (sessionData?.session) {
    setStatus(sessionData.session.status);
    if (sessionData.session.modes) setModes(sessionData.session.modes as AgentModeData[]);
    if (sessionData.session.currentModeId) setCurrentModeId(sessionData.session.currentModeId);
    // ... 覆盖所有状态
  }
}, [sessionData]); // ← 每次 sessionData 变化都触发
```

#### 根因分析

`Sidebar.tsx` 每 15 秒轮询 `GET_SESSIONS`：

```typescript
const { data: sessionsData } = useQuery<GetSessionsQuery>(GET_SESSIONS, {
  pollInterval: 15000,
});
```

该查询返回的 Session 列表包含 `currentModeId`、`currentModelId`、`modes`、`status`、`availableModels` 等字段。Apollo 的归一化缓存（normalized cache）会更新 `Session` 类型的缓存实体。由于 `SessionPage.tsx` 的 `GET_SESSION` 也读取同一个 `Session` 实体，Apollo 缓存更新会触发 `sessionData` 变化，进而触发 `useEffect([sessionData])`，将 React 本地状态覆盖为轮询返回的（可能已过时的）值。

典型场景复现步骤：

1. 用户在 SessionPage 中通过 `ModelSwitcher` 或 `SetSessionMode` mutation 切换 mode
2. 后端 `acpSessionManager.setMode()` 乐观更新 DB 并发布 `publishStatus('idling', { currentModeId: 'plan' })`
3. SSE `type: 'status'` 事件到达前端 → `setCurrentModeId('plan')` ✓
4. 15 秒后 `Sidebar` 的 `GET_SESSIONS` 轮询返回旧数据（`currentModeId: 'code'`）
5. Apollo 归一化缓存更新 → `sessionData` 变化 → `useEffect` 触发 → `setCurrentModeId('code')` ← **BUG：覆盖为旧值**
6. 用户看到 mode 被"弹回"修改前的值

#### 方案

**核心原则：`sessionData` 仅用于首次初始化，后续状态更新完全依赖 SSE `type: 'status'` 事件。**

```mermaid
flowchart TD
    subgraph Init[组件初始化]
        A[GET_SESSION GraphQL] -->|首次加载| B[sessionData useEffect]
        B --> C[初始化所有本地状态]
        C --> D[SSE 建立连接]
        D --> E[收到初始 status 事件<br/>与 sessionData 一致]
    end

    subgraph Runtime[运行期]
        F[GET_SESSIONS 轮询] -->|Apollo 缓存更新| G[sessionData 变化]
        G -->|已初始化, 跳过| H[不覆盖本地状态]
        I[SSE status 事件] -->|唯一更新源| J[setCurrentModeId / setStatus / ...]
    end

    Init --> Runtime
```

改动：

1. **`SessionPage.tsx`**：`sessionData` 的 `useEffect` 增加首次加载保护，仅在组件挂载时初始化一次，后续忽略

```typescript
const initializedRef = useRef(false);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [id]);
```

2. SSE `type: 'status'` 处理保持不变——它已经是状态更新的正确来源
3. `currentModel` 引用随问题一删除

### 2.4 问题四：最后一条消息是 setting update 时允许发送

#### 现状

```typescript
// SessionPage.tsx
disabled={status !== 'running' && status !== 'idling'}
```

输入框仅当 `status` 为 `running` 或 `idling` 时启用。而当 agent 返回 setting update 时，`handleControllerMessage`（`acp-session-manager.ts`）会同时：
1. 将消息写入 DB 并发送 SSE `type: 'message'` 事件
2. 发布 `publishStatus(sessionId, 'idling', ...)` 发送 SSE `type: 'status'` 事件

但由于 SSE 事件的到达存在时序差，`message` 事件先到（用户看到 setting update），`status` 事件后到（状态更新为 `idling`）。在间隙中：
- 如果状态恰好处于非 `running`/`idling` 的组合（如场景导致中继状态），用户无法发送

#### 方案

在 SessionPage 中跟踪最近一条 SSE 消息是否为 setting update，放宽 `disabled` 条件：

```mermaid
sequenceDiagram
    participant User
    participant FE as SessionPage
    participant SSE as SSE Stream

    Note over SSE: agent returns config_option_update
    SSE->>FE: type: 'message', content: { sessionUpdate: 'config_option_update' }
    FE->>FE: set lastMessageIsSettingUpdate = true
    Note over FE: status 可能尚未更新为 idling
    User->>FE: 尝试发送新消息
    FE->>FE: disabled = (status !== 'running' && status !== 'idling') && !lastMessageIsSettingUpdate
    Note over FE: 因为 lastMessageIsSettingUpdate = true, 允许发送
    SSE->>FE: type: 'status', status: 'idling'
    FE->>FE: set status = 'idling', reset flag
```

关键行为：
- SSE 收到 `config_option_update` / `current_mode_update` 时，设置 `lastMessageIsSettingUpdateRef.current = true`
- SSE 收到 `status` 事件时，如果 status 不是 `idling` 或 `running`，不清除该标记（让后续消息可用）
- 用户实际发送消息时，清除该标记
- 使用 `useRef` 而非 `useState` 避免额外渲染

### 2.5 问题五：路由切换 Session 时无 loading 状态

#### 现状

`App.tsx` 的 `SessionPage` 路由没有 `key` prop：

```tsx
<Route path="sessions/:id" element={<SessionPage />} />
```

当用户在 `/sessions/sessionA` 时直接导航到 `/sessions/sessionB`，React Router v7 复用 `SessionPage` 组件实例，导致：
1. `messages` 状态保留旧 session 的数据
2. 无 loading spinner 显示
3. 用户看到上一个 session 的消息列表

#### 方案

在 `App.tsx` 中创建包装组件，使用 `location.pathname` 作为 key 强制组件重载：

```tsx
function SessionPageRoute() {
  const location = useLocation();
  return <SessionPage key={location.pathname} />;
}

// 路由中使用
<Route path="sessions/:id" element={<SessionPageRoute />} />
```

---

## 3. 各层具体改动

### 3.1 前端层

| 文件 | 改动 |
|------|------|
| `apps/agent-web/src/pages/SessionPage.tsx:70` | 删除 `_currentModel` state |
| `apps/agent-web/src/pages/SessionPage.tsx:88-97` | `sessionData` useEffect 改为仅首次初始化，依赖从 `[sessionData]` 改为 `[id]` |
| `apps/agent-web/src/pages/SessionPage.tsx:93,143` | 删除 `setCurrentModel` 调用 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 新增 `initializedRef` 保护 Effect 重复执行 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 新增 `lastMessageIsSettingUpdateRef` 和相关逻辑 |
| `apps/agent-web/src/pages/SessionPage.tsx:355` | 修改 `disabled` 条件 |
| `apps/agent-web/src/components/session/MessageList.tsx:64-65` | `tool_call`/`tool_call_update` 分支中增加 `kind` 和 `subagent_type` 检测，路由到 `read`/`fetch`/`sub_agent` 类型 |
| `apps/agent-web/src/components/session/MessageList.tsx:98` | `sub_agent` 类型也使用 `toolCallId` 分组 |
| `apps/agent-web/src/App.tsx` | 新增 `SessionPageRoute` 包装组件，使用 `key={location.pathname}` |

### 3.2 SSE 契约层

| 文件 | 改动 |
|------|------|
| `contracts/agent-session-websocket.md:972-976` | SSE status 事件 payload 示例中删除 `currentModel` 字段 |

### 3.3 SSE 服务层

| 文件 | 改动 |
|------|------|
| `servers/agent-api/src/services/session-sse.ts:40` | `addConnection` 中 statusPayload 移除 `currentModel` |
| `servers/agent-api/src/services/session-sse.ts:102` | `ensureGlobalStatusSubscriber` 中 extra 移除 `currentModel` |
| `servers/agent-api/src/services/session-sse.ts:138` | `broadcastStatus` 中 extra 移除 `currentModel` |

## 4. 关键实现细节

### 4.1 新增：SubAgent 检测逻辑

```typescript
// MessageList.tsx — groupMessages 函数，第 64-65 行替换
} else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
  // 检查是否为 SubAgent 消息
  if (parsed) {
    const p = parsed as Record<string, unknown>;
    const kind = p.kind as string | undefined;
    const rawInput = p.rawInput;
    const hasSubagentType = !!(p.subagent_type as string | undefined) ||
      (rawInput && typeof rawInput === 'object' && !!(rawInput as Record<string, unknown>).subagent_type);
    if (kind === 'other' && hasSubagentType) {
      groupType = 'sub_agent';
    } else {
      groupType = 'tool_call';
    }
  } else {
    groupType = 'tool_call';
  }
```

### 4.2 新增：SubAgent 分组策略

在分组逻辑中，为 specialized 类型（`read`/`fetch`/`sub_agent`）增加 `toolCallId` 分组：

```typescript
if ((groupType === 'tool_call' || groupType === 'read' || groupType === 'fetch' || groupType === 'sub_agent') && toolCallId) {
  // Tool calls and specialized types: group by toolCallId across the entire message list
  if (toolCallGroupMap.has(toolCallId)) {
    groupIndex = toolCallGroupMap.get(toolCallId)!;
  } else {
    groupIndex = groups.length;
    toolCallGroupMap.set(toolCallId, groupIndex);
    groups.push({ type: groupType, messages: [], parsed, messageId: null });
  }
}
```

### 4.3 `lastMessageIsSettingUpdate` 逻辑

```typescript
// SessionPage.tsx
const lastMessageIsSettingUpdateRef = useRef(false);

// SSE onmessage handler:
if (data.type === 'message') {
  setMessages((prev) => [...prev, data.data]);
  // ...
  try {
    const content = JSON.parse(data.data.content);
    if (content.sessionUpdate === 'config_option_update' || content.sessionUpdate === 'current_mode_update') {
      lastMessageIsSettingUpdateRef.current = true;
    }
  } catch { }
}

// handleSendMessage:
const handleSendMessage = async (content: string) => {
  if (!id) return;
  lastMessageIsSettingUpdateRef.current = false; // reset on send
  // ...
};

// disabled:
disabled={(status !== 'running' && status !== 'idling') && !lastMessageIsSettingUpdateRef.current}
```

---

## 5. 验收标准

1. 前端 `_currentModel` state 和 `setCurrentModel` 调用已移除
2. SSE status 事件 payload 不再包含 `currentModel`
3. SubAgent 类型消息正确渲染为 `SubAgentCard`，显示 description、prompt、output 等内容
4. 每条 SSE `type: 'status'` 事件都能正确更新 `status`、`currentModelId`、`currentModeId`、`modes`、`availableModels`
5. `sessionData` 的 `useEffect` 不会因 `GET_SESSIONS` 轮询而覆盖本地状态
6. setting update 作为最后一条消息时，输入框可点击发送
7. 路由切换 Session 时显示 loading spinner 并清空旧状态
8. 所有现有测试通过

## 6. 执行顺序

```
Step 1 (移除 currentModel) → Step 2 (SubAgent 卡片渲染) → Step 3 (sessionData 覆盖修复) → Step 4 (setting update) → Step 5 (路由切换)
```

- Step 1 最复杂，涉及多模块
- Step 2-5 都是前端改动，可以独立进行
- 建议按序执行，每个 Step 完成后验证无回归

## 7. 相关文档

- [[contracts/agent-session.graphql]] — Session GraphQL 契约
- [[contracts/agent-session-websocket.md]] — SSE 协议文档
- [[20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换方案
- [[20260522-feat-model-switch-support.md]] — 模型切换支持方案
- [[20260519-fix-frontend-acp-response.md]] — 前端 ACP 响应修复（ToolCall 渲染基础）
