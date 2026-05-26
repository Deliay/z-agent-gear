---
description: 修复三个 Session 状态相关的验收问题：移除 currentModel 冗余字段、允许 setting update 后发送消息、完善 SSE status 事件处理
type: Permanent
---

# Session 状态验收问题修复

**功能名称**: Session 状态验收问题修复
**技术提案版本**: v1.3
**创建日期**: 2026-05-26
**作者**: opencode

## 1. 概述

### 1.1 背景

当前代码中存在 4 个 Session 状态相关的验收问题：

1. **`currentModel` 与 `currentModelId` 两套字段并存**，`currentModel` 是冗余的（可从 `currentModelId` + `availableModels` 推导），增加维护成本和数据传输开销
2. **`sessionData` useEffect 被 `GET_SESSIONS` 轮询覆盖** - Sidebar 每 15s 轮询会通过 Apollo 归一化缓存更新 `Session` 实体，触发 `useEffect([sessionData])`，覆盖 SSE 更新的状态
3. **Setting update 后可能无法发送消息** - 当最后一条消息是 setting update 且状态未及时切换时，输入框可能被禁用
4. **Session 路由切换时无 loading 状态** - 从 sessionA 直接导航到 sessionB 时，组件复用导致旧数据残留

> **注意**：原问题 4（SubAgent 卡片未渲染）已由 main 的 UI 优化工作解决 - `MessageList.tsx` 已实现 `sub_agent` 分组和 `SubAgentCard` 组件。

### 1.2 目标

- 移除 `currentModel` 字段，全链路只使用 `currentModelId`
- 修复 `sessionData` useEffect 被轮询覆盖的问题
- Setting update 消息后允许用户继续发送消息
- Session 路由切换时正确显示 loading 状态

### 1.3 范围

涉及 `servers/agent-api`、`servers/controller-api`、`packages/agent-controller`、`apps/agent-web`、`contracts`、`tests` 六个模块。

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

全链路删除 `currentModel`，按层执行：

```mermaid
flowchart TD
    A[开始] --> B[Models: 移除 schema 字段]
    B --> C[Contracts: 移除 GraphQL 定义]
    C --> D[Backend Services]
    D --> D1[agent-api: session-sse, session.ts mapSession]
    D --> D2[controller-api: acp-session-manager 中所有引用]
    D --> D3[bridge.ts: 移除 extractCurrentModel 方法]
    D --> D4[socketio-client.ts: 移除 currentModel 组装]
    D --> E[Frontend: 移除 state 和 setCurrentModel 调用]
    D --> F[Tests: 移除相关断言和夹具]
    D --> G[Docs: 更新协议文档]
    F --> H[完成]
    G --> H
```

详情见下方【各层具体改动】表格。

### 2.2 问题二：最后一条消息是 setting update 时允许发送

#### 现状

```tsx
// SessionPage.tsx L355
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
- SSE 收到 `config_option_update` / `current_mode_update` 时，`lastMessageIsSettingUpdateRef.current = true`
- SSE 收到 `status` 事件时，如果 status 不是 `idling` 或 `running`，不清除该标记（让后续消息可用）
- 用户实际发送消息时，清除该标记
- 使用 `useRef` 而非 `useState` 避免额外渲染

### 2.3 问题三：SSE `type: 'status'` 事件更新状态

#### 现状

SessionPage.tsx 中 SSE 事件处理已覆盖 SSE status 事件中的各个字段：

```tsx
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

```tsx
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

`Sidebar.tsx` 每 15 秒轮询 `GET_SESSIONS`（L27-29）：

```tsx
const { data: sessionsData } = useQuery<GetSessionsQuery>(GET_SESSIONS, {
  pollInterval: 15000,
});
```

该查询返回的 Session 列表包含 `currentModeId`、`currentModelId`、`modes`、`status`、`availableModels` 等字段。Apollo 的归一化缓存（normalized cache）会更新 `Session` 类型的缓存实体。由于 `SessionPage.tsx` 的 `GET_SESSION` 也读取同一个 `Session` 实体，Apollo 缓存更新会触发 `sessionData` 变化，进而触发 `useEffect([sessionData])`，将 React 本地状态覆盖为轮询返回的（可能已过时的）值。

```mermaid
sequenceDiagram
    participant Sidebar
    participant Apollo as Apollo Cache
    participant SessionPage
    participant SSE as SSE Stream

    Note over Sidebar: GET_SESSIONS pollInterval: 15000
    Sidebar->>Apollo: 轮询更新 Session 缓存<br/>(含 stale currentModeId)
    Apollo->>SessionPage: sessionData 变化（Apollo 归一化通知）
    Note over SessionPage: useEffect([sessionData]) 触发
    SessionPage->>SessionPage: setCurrentModeId(staleValue) ← 覆盖！

    Note over SSE: 真正的状态更新来自 SSE
    SSE->>SessionPage: type: 'status', currentModeId: 'plan'
    SessionPage->>SessionPage: setCurrentModeId('plan') ✓

    Note over Sidebar: 15s 后再次轮询...
    Sidebar->>Apollo: 再次返回 old currentModeId
    Apollo->>SessionPage: sessionData 再次变化
    SessionPage->>SessionPage: setCurrentModeId(staleValue) ← 再次覆盖！
```

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
// 方案一：使用 initializedRef 确保只初始化一次
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
  // sessionData 不再参与依赖 — 改用 id 确保 session 切换时重新初始化
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [id]);
```

2. SSE `type: 'status'` 处理保持不变——它已经是状态更新的正确来源
3. `currentModel` 引用随问题一删除
4. `useSessionStream.ts` 的 `onStatus` 回调签名从 `(status: string) => void` 改为传递完整的 status event data 对象

#### 补充说明

- **为什么用 `id` 做依赖而非 `sessionData`**：当用户导航到另一个 session（路由 `id` 变化）时，组件实例可能复用（React Router 同路径模式），`ref` 会保持旧值。将依赖改为 `id` 确保了 session 切换时重新初始化。
- **为什么不把 `ref` 放进 `[]` 依赖中**：`initializedRef.current` 的变化不会触发重渲染，放在依赖数组中无意义。
- **SSE initial status 的冗余**：组件初始化时 `GET_SESSION` + SSE 初始 status 事件都包含相同的数据。先用 `GET_SESSION` 同步初始化（消除白屏等待），SSE 建立后会立即收到一致的 status 事件覆盖——这没有副作用，因为值相同。

### 2.4 问题四：路由切换 Session 时无 loading 状态

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

### 2.5 已被 main 解决：SubAgent 卡片渲染

`MessageList.tsx` 已实现 `sub_agent` 分组类型（第 86-87 行），`SubAgentCard.tsx` 已实现专用组件。`kind === 'other'` 且 `rawInput.subagent_type` 存在时会被识别为 `sub_agent` 类型并使用 `SubAgentCard` 渲染。

因此原问题 4（SubAgent 卡片未渲染）已在 main 的 UI 优化工作中解决，本次不再处理。

#### 现状

用户反映线上环境中 SubAgent（子任务）的卡片没有正确渲染。以下是实际收到的消息数据结构：

```json
{
  "id": "6a15643ae7227d801c6dacf2",
  "direction": "output",
  "type": "tool_call",
  "content": {
    "kind": "other",
    "title": "task",
    "status": "in_progress",
    "subagent_type": "explore",
    "sessionUpdate": "tool_call_update",
    "toolCallId": "call_00_FmrB6QVXt3w0WWnpm9IH5651",
    "rawInput": {
      "description": "Find currentModel usage",
      "prompt": "...",
      "subagent_type": "explore"
    }
  },
  "createdAt": "2026-05-26T09:13:30.228Z"
}
```

#### 根因分析

`ToolCallCard.tsx` 的解析逻辑：

```typescript
// ToolCallCard.tsx L23-43
for (const msg of messages) {
  const parsed = /* ... */;
  const tc = parseToolCall(parsed);
  const tcu = parseToolCallUpdate(parsed);
  if (tc) {
    title = tc.title;   // title = 'task'
    if (tc.status) status = tc.status;
    if (tc.rawInput) rawInput = tc.rawInput;
  }
  if (tcu) {
    if (tcu.title) title = tcu.title;  // 再次覆盖
    if (tcu.status) status = tcu.status;
    if (tcu.rawInput) rawInput = tcu.rawInput;
  }
}
```

卡片始终渲染为：
- **标题**：`"Tool Call: task"`（无法区分普通任务还是子任务）
- **颜色**：默认 `purple`（`statusColors['in_progress']`）

**关键字段**：`subagent_type` 是区分 SubAgent 的标记（值为 `"explore"`），但 `ToolCallCard` 完全未使用该字段。

#### 当前数据结构与组件支持情况

| 字段 | ToolCallCard 支持 | 说明 |
|------|-------------------|------|
| `title` | ✅ | 显示为 "Tool Call: {title}" |
| `status` | ✅ | 显示在 summary 和内部 |
| `rawInput` | ✅ | 折叠面板中渲染 |
| `subagent_type` | ❌ | 未使用，但这是区分 SubAgent 的关键字段 |
| `kind` | ❌ | 固定为 "other"，无区分意义 |

#### 方案

`ToolCallCard` 增加对 `subagent_type` 字段的检测，根据是否存在该字段来区分 SubAgent 和普通 ToolCall：

```typescript
// ToolCallCard.tsx 改造

// 检测是否为 SubAgent（rawInput 中存在 subagent_type 或直接存在 subagent_type 字段）
function isSubAgent(parsed: SessionUpdate): boolean {
  return !!(parsed.subagent_type || (parsed.rawInput && typeof parsed.rawInput === 'object' && (parsed.rawInput as Record<string, unknown>).subagent_type));
}

// 类型映射
const subagentTypeLabels: Record<string, string> = {
  'explore': 'Explore',
  'general': 'General',
  // 其他子任务类型...
};

// 标题生成
const displayTitle = (() => {
  const isSub = isSubAgent(parsed);
  if (isSub) {
    const subType = parsed.subagent_type || (parsed.rawInput as Record<string, unknown>)?.subagent_type as string;
    return `SubAgent: ${subagentTypeLabels[subType] || subType || 'task'}`;
  }
  return `Tool Call: ${parsed.title || 'task'}`;
})();

// 颜色映射（SubAgent 用蓝色）
const displayColor = isSub ? 'blue' : (statusColors[status] || 'purple');
```

#### 验收标准

1. 存在 `subagent_type` 字段的消息显示为蓝色卡片，标题包含 "SubAgent:" 前缀
2. 不存在 `subagent_type` 字段的消息保持现有的紫色卡片样式
3. `subagent_type` 值正确显示在卡片中
4. 无 `subagent_type` 且无 `rawInput` 时不会导致渲染错误

## 3. 各层具体改动

### 3.1 数据模型层

| 文件 | 改动 |
|------|------|
| `servers/agent-api/src/models/session.ts:17` | 删除 `currentModel` 字段 |
| `servers/controller-api/src/models/session.ts:15` | 删除 `currentModel` 字段 |

### 3.2 GraphQL / 契约层

| 文件 | 改动 |
|------|------|
| `contracts/agent-session.graphql:62` | 删除 `currentModel: AgentModelInfo` |
| `servers/agent-api/src/graphql/schemas/session.ts:56` | 删除 `currentModel` 字段 |
| `apps/agent-web/src/graphql/types.ts:115` | 删除 `currentModel?: AgentModelInfoData \| null` |
| `apps/agent-web/src/graphql/queries.ts:102-106` | 删除 `currentModel { id name provider }` |
| `contracts/agent-session-websocket.md:972-976` | 删除 `currentModel` 字段定义 |

### 3.3 后端服务层

| 文件 | 改动 |
|------|------|
| `servers/agent-api/src/services/session-sse.ts:40` | `addConnection` 中移除 `currentModel` |
| `servers/agent-api/src/services/session-sse.ts:102` | `ensureGlobalStatusSubscriber` 中移除 |
| `servers/agent-api/src/services/session-sse.ts:138` | `broadcastStatus` 中移除 |
| `servers/agent-api/src/services/session.ts:464` | `mapSession` 中移除 |
| `servers/controller-api/src/services/acp-session-manager.ts:58,92,96,100` | start 路径移除 |
| `servers/controller-api/src/services/acp-session-manager.ts:369,391,395,399` | resume 路径移除 |
| `servers/controller-api/src/services/acp-session-manager.ts:504-506` | `refreshSessionCache` 移除 |
| `servers/controller-api/src/services/acp-session-manager.ts:519,530-531` | `cacheModes` 移除 |
| `servers/controller-api/src/services/acp-session-manager.ts:556` | `publishStatus` 移除 |

### 3.4 Agent 控制器层

| 文件 | 改动 |
|------|------|
| `packages/agent-controller/src/acp/bridge.ts:225-229` | 删除 `extractCurrentModel` 方法 |
| `packages/agent-controller/src/acp/bridge.ts:70,101,121` | 删除 `currentModel` 调用 |
| `packages/agent-controller/src/socketio-client.ts:222,280` | 删除 `currentModel` 组装 |

### 3.5 前端层

| 文件 | 改动 |
|------|------|
| `apps/agent-web/src/pages/SessionPage.tsx:70` | 删除 `_currentModel` state |
| `apps/agent-web/src/pages/SessionPage.tsx:88-97` | `sessionData` useEffect 改为仅首次初始化，依赖从 `[sessionData]` 改为 `[id]` |
| `apps/agent-web/src/pages/SessionPage.tsx:93,143` | 删除 `setCurrentModel` 调用 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 新增 `initializedRef` 保护 Effect 重复执行 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 新增 `lastMessageIsSettingUpdateRef` 和相关逻辑 |
| `apps/agent-web/src/pages/SessionPage.tsx:355` | 修改 `disabled` 条件 |
| `apps/agent-web/src/hooks/useSessionStream.ts:12,51-52` | 扩展 `onStatus` 回调签名 |
| `apps/agent-web/src/components/session/ToolCallCard.tsx` | 增加 `subagent_type` 检测，区分 SubAgent / ToolCall 类型和颜色 |

### 3.6 测试层

| 文件 | 改动 |
|------|------|
| `tests/api/src/agent-api/session.test.ts:132,696,728-729,893,905` | 删除 `currentModel` 相关断言 |
| `servers/agent-api/src/services/session-sse.test.ts:240,250,254` | 删除 `currentModel` 相关用例 |
| `packages/agent-controller/tests/acp-bridge.test.ts:121,137` | 删除 `currentModel` 相关断言 |

## 4. 关键实现细节

### 4.1 `lastMessageIsSettingUpdate` 逻辑

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

### 4.2 `useSessionStream` 回调改造

```typescript
// 当前：
onStatus?: (status: string) => void;

// 改后：
interface SessionStatusData {
  status: string;
  currentModelId?: string | null;
  availableModels?: Array<{ id: string; name: string; provider?: string }> | null;
  currentModeId?: string | null;
  modes?: Array<{ id: string; name: string; description?: string }> | null;
  error?: string | null;
}
onStatus?: (data: SessionStatusData) => void;
```

## 5. 验收标准

1. `currentModel` 字段在全代码库中无引用（除 DB migration 保留数据外）
2. 前端 `SessionData` 类型不再包含 `currentModel`
3. GraphQL `GET_SESSION` 查询不再请求 `currentModel`
4. SSE status 事件 payload 不再包含 `currentModel`
5. setting update 作为最后一条消息时，输入框可点击发送
6. 每条 SSE `type: 'status'` 事件都能正确更新 `status`、`currentModelId`、`currentModeId`、`modes`、`availableModels`
7. `sessionData` 的 `useEffect` 不会因 `GET_SESSIONS` 轮询而覆盖本地状态
8. `useSessionStream` 的 `onStatus` 回调传递完整的 status data 对象
9. SubAgent 类型消息正确渲染为蓝色卡片，显示 "SubAgent:" 前缀和 `subagent_type`
10. 所有现有测试通过

## 6. 相关文档

- [[contracts/agent-session.graphql]] — Session GraphQL 契约
- [[contracts/agent-session-websocket.md]] — SSE 协议文档
- [[20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换方案
- [[20260522-feat-model-switch-support.md]] — 模型切换支持方案
- [[20260519-fix-frontend-acp-response.md]] — 前端 ACP 响应修复（ToolCall 渲染基础）
