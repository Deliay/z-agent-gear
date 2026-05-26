---
description: Session 状态验收问题修复的实施计划
type: Permanent
---

# Session 状态验收问题修复 — 实施计划

**关联提案**: [[../proposals/20260526-fix-acceptance-session-state.md|v1.4]]
**创建日期**: 2026-05-26
**状态**: 待 review

## 概览

本次实施包含 5 个独立的验收问题修复，按顺序执行：

| # | 问题 | 范围 |
|---|------|------|
| 1 | 移除 `currentModel` 冗余字段 | models、GraphQL、SSE、services、前端、测试 |
| 2 | SubAgent 卡片正确渲染 | MessageList.tsx（检测逻辑 + 分组策略） |
| 3 | 修复 sessionData useEffect 被轮询覆盖 | SessionPage.tsx |
| 4 | 允许 setting update 后继续发送消息 | SessionPage.tsx |
| 5 | 路由切换 Session 时显示 loading 并重置状态 | App.tsx |

---

## Step 1: 移除 `currentModel` 字段

### 1.1 数据模型层

```bash
# 文件: servers/agent-api/src/models/session.ts
# 删除 currentModel 字段 (约第 17 行)

# 文件: servers/controller-api/src/models/session.ts
# 删除 currentModel 字段 (约第 15 行)
```

### 1.2 GraphQL / 契约层

```bash
# 1. contracts/agent-session.graphql
# 删除 Session 类型中的: currentModel: AgentModelInfo

# 2. servers/agent-api/src/graphql/schemas/session.ts
# 删除 currentModel 字段定义

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
# - addConnection 中 statusPayload 移除 currentModel
# - ensureGlobalStatusSubscriber 中 extra 移除 currentModel
# - broadcastStatus 中 extra 移除 currentModel

# 2. servers/agent-api/src/services/session.ts
# - mapSession 方法中移除 currentModel 映射

# 3. servers/controller-api/src/services/acp-session-manager.ts
# - 类型定义中移除 currentModel
# - start/resume 路径: updateData、statusExtra、cacheModes、publishStatus 调用移除 currentModel
# - refreshSessionCache: 移除 session:${sessionId}:currentModel Redis key
# - cacheModes: 移除 currentModel 参数和逻辑
# - publishStatus: 移除 extra.currentModel
```

### 1.4 Agent 控制器层

```bash
# 1. packages/agent-controller/src/acp/bridge.ts
# - 删除 extractCurrentModel 方法
# - acp:start:result / acp:resume:result / acp:initialized 处理中移除 currentModel

# 2. packages/agent-controller/src/socketio-client.ts
# - acp:start:result / acp:resume:result 发送时移除 currentModel
```

### 1.5 前端层

```bash
# apps/agent-web/src/pages/SessionPage.tsx
# - 删除 _currentModel state
# - 删除 sessionData useEffect 中的 setCurrentModel 调用
# - 删除 SSE status 事件中的 setCurrentModel 调用
```

### 1.6 验证

```bash
# 全局搜索确认无遗漏
rg "currentModel" --type ts --type tsx --type graphql --type md
# 预期结果: 无匹配（或仅 DB migration 保留数据）
```

---

## Step 2: SubAgent 卡片正确渲染

### 2.1 问题根因

`MessageList.tsx` 的 `groupMessages` 函数中，消息分组类型检测逻辑如下：

```typescript
// 第 64 行：tool_call / tool_call_update 被提前拦截
} else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
  groupType = 'tool_call';  // ← SubAgent 消息也被归类为 tool_call
  // ...
} else {
  // 第 86 行：sub_agent 检测在 else 分支，永远不会被 tool_call 消息到达
  if (kind === 'other' && rawInput?.subagent_type) {
    groupType = 'sub_agent';  // ← 死代码
  }
}
```

SubAgent 消息的 `sessionUpdate` 为 `"tool_call_update"`，被第 64 行提前拦截，永远无法到达第 86 行的 `sub_agent` 检测。

### 2.2 修改 MessageList.tsx

**改动 A：在 tool_call/tool_call_update 分支中增加 subagent 检测**

将第 64-65 行替换为：

```typescript
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

**改动 B：sub_agent 类型使用 toolCallId 分组**

将第 98 行从：

```typescript
if (groupType === 'tool_call' && toolCallId) {
```

改为：

```typescript
if ((groupType === 'tool_call' || groupType === 'sub_agent') && toolCallId) {
```

### 2.3 SubAgentCard.tsx — 无修改

`SubAgentCard.tsx` 已正确实现：读取 `rawInput.description`、`rawInput.prompt`、`rawOutput.output`，在 `AcpCard` 中渲染。

### 2.4 验证方式

1. 创建一个产生 SubAgent 子任务的 session
2. 观察 SubAgent 消息是否渲染为 `SubAgentCard`（而不是 `ToolCallCard`）
3. 验证卡片显示正确的 description、prompt、output 内容
4. 验证 `sub_agent` 检测也覆盖了初始 `tool_call`（sessionUpdate === 'tool_call'）和后续更新（sessionUpdate === 'tool_call_update'）

---

## Step 3: 修复 sessionData useEffect 被轮询覆盖

### 3.1 问题说明

`SessionPage.tsx` 第 88-97 行的 useEffect 依赖 `sessionData`，每次 Sidebar 的 `GET_SESSIONS` 轮询返回都会触发，覆盖 SSE 更新的状态。

### 3.2 修改 SessionPage.tsx

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [id]);
```

### 3.3 验证方式

1. 启动应用并创建 session
2. 在 ModelSwitcher 中切换 model
3. 观察 15 秒后 model 是否被"弹回"（修复前会，修复后不会）

---

## Step 4: 允许 setting update 后继续发送消息

### 4.1 问题说明

当最后一条消息是 setting update（config_option_update / current_mode_update）时，用户可能无法发送新消息。

### 4.2 修改 SessionPage.tsx

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

## Step 5: 路由切换 Session 时显示 loading 并重置状态

### 5.1 问题说明

`App.tsx` 的 `SessionPage` 路由没有 `key` prop，导致 React Router v7 复用组件实例，Session 路由切换时无 loading 状态。

### 5.2 修改 App.tsx

```tsx
// 新增包装组件
function SessionPageRoute() {
  const location = useLocation();
  return <SessionPage key={location.pathname} />;
}

// 路由中使用
<Route path="sessions" element={<SessionPageRoute />} />
<Route path="sessions/:id" element={<SessionPageRoute />} />
```

### 5.3 验证方式

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
| 4 | SubAgent 消息渲染为 SubAgentCard | 实际操作观察 |
| 5 | SubAgent 消息显示 description/prompt/output | 实际操作观察 |
| 6 | ModelSwitcher 切换后 15s 不被轮询覆盖 | 实际操作观察 |
| 7 | setting update 后可发送消息 | 实际操作观察 |
| 8 | 路由切换 session 时显示 loading spinner | 直接在地址栏切换 session 观察 |
| 9 | 路由切换 session 时消息列表被清空 | 直接在地址栏切换 session 观察 |
| 10 | 所有测试通过 | `npm run test` |

---

## 执行顺序

```
Step 1 (移除 currentModel) → Step 2 (SubAgent) → Step 3 (sessionData 覆盖) → Step 4 (setting update) → Step 5 (路由切换)
         ↓                           ↓                    ↓                     ↓                    ↓
      最复杂，涉及多模块            前端改动             前端                  前端                  前端
```

建议每个 Step 完成后运行 `npm run test` 验证无回归，再进行下一步。
