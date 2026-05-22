---
description: 可用模型展示与 Agent 模式切换 - 实现计划
type: Permanent
---

# 可用模型展示与 Agent 模式切换 - 实现计划

**关联 Proposal**: `proposals/20260522-feat-available-models-and-mode-switch.md`
**创建日期**: 2026-05-22

## 实现顺序

```
Phase 1: agent-api 数据模型扩展
  └── Phase 2: agent-api setSessionMode 逻辑
       └── Phase 3: controller-api acp:set-mode 处理
            └── Phase 4: agent-controller acp:set-mode + bridge.setMode
                 └── Phase 5: 前端模式切换 UI + 模型展示
```

各阶段可向下游传递数据契约，Phase 2 依赖 Phase 1 的 Model/Schema 变更，Phase 3 依赖 Phase 2 的 Redis 命令格式，以此类推。

---

## Phase 1: agent-api 数据模型扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/session.ts` | 修改 | 添加 `modes`、`currentModeId`、`currentModel` 字段 |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | 添加 `AgentMode`、`AgentModelInfo` 类型，扩展 `Session` 字段 |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | 新增 `setSessionMode` resolver |
| `servers/agent-api/src/services/session.ts` | 修改 | 新增 `setMode()` 方法；`mapSession()` 扩展 |
| `servers/agent-api/src/services/session-sse.ts` | 修改 | SSE status 事件支持 modes/models/currentModeId 字段 |

### session.ts (Model) 变更

```typescript
// 新增字段
modes: [{ id: String, name: String, description: String }],
currentModeId: String,
currentModel: { id: String, name: String, provider: String }
```

### session.ts (Service) 变更

```typescript
async setMode(sessionId: string, userId: string, modeId: string): Promise<boolean> {
  // 1. 验证 session 属于当前用户
  // 2. 验证 session.status === 'idling'
  // 3. 发布 acp:set-mode 到 Redis session:command
  // 4. 返回 true
}

// mapSession 扩展 modes/currentModeId/currentModel
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # 确认 TypeScript 编译通过
npm run test     # 运行单元测试
```

---

## Phase 2: controller-api ACP set-mode 处理

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/session-command.ts` | 修改 | 添加 `acp:set-mode` 命令 case 及 handler |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | 新增 `setMode()` 方法；`startSession`/`resumeSession` 解析 modes/models 字段 |

### session-command.ts 变更

```typescript
// subscribe() 中的 command type 分支新增
} else if (command.type === 'acp:set-mode' && command.sessionId && command.modeId) {
  await this.handleAcpSetMode(command.sessionId, command.modeId);
}

// 新增 handler
private async handleAcpSetMode(sessionId: string, modeId: string): Promise<void> {
  // 1. 查找 controller socket（从 acpSessionManager 获取）
  // 2. 发送 acp:set-mode Socket.IO 事件
}
```

### acp-session-manager.ts 变更

```typescript
async setMode(sessionId: string, modeId: string): Promise<boolean> {
  // 1. 从 this.sessions 查找 session
  // 2. Socket.IO emit acp:set-mode { sessionId, modeId }
  // 3. 返回 true
}

// startSession/start:result 解析 payload.modes/currentModeId/currentModel
// resumeSession/resume:result 解析 payload.modes/currentModeId/currentModel
// 缓存到 Redis session:{id}:modes 等 key
// 当收到 current_mode_update 时更新 Redis 并发布 session:status
```

### 启动 & 验证

```bash
# controller-api 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 3: agent-controller acp:set-mode + bridge.setMode

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 添加 `acp:set-mode` 事件处理 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | 新增 `setMode()` 方法；`start()` 回调 modes/models |

### socketio-client.ts 变更

```typescript
interface AcpSetModePayload {
  sessionId: string;
  modeId: string;
}

// 在 ACP events 区域新增
socket.on('acp:set-mode', (data: AcpSetModePayload) => {
  const bridge = acpBridges.get(data.sessionId);
  if (bridge) {
    bridge.setMode(data.modeId);
  }
});
```

### bridge.ts 变更

```typescript
async setMode(modeId: string): Promise<void> {
  if (!this.connection || !this.acpSessionId) return;
  // 发送 session/set_mode JSON-RPC
  await this.connection.setMode?.({ sessionId: this.acpSessionId, modeId });
}

// start() 中 newSession 结果包含 modes/currentModeId/currentModel
// resume() 中 resumeSession/newSession 结果包含 modes/currentModeId/currentModel
// 通过 acp:start:result / acp:resume:result 带回到 controller-api
```

### 启动 & 验证

```bash
# agent-controller 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 4: 前端模式切换 UI + 模型展示

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/types.ts` | 修改 | 新增 `AgentModeData`、`AgentModelInfoData` 类型 |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | `GET_SESSION` 扩展 modes/currentModeId/currentModel |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `SET_SESSION_MODE` |
| `apps/agent-web/src/components/session/ModeSwitcher.tsx` | **新建** | 当前模式按钮组件 |
| `apps/agent-web/src/components/session/ModeSelectDialog.tsx` | **新建** | 模式选择 Dialog |
| `apps/agent-web/src/components/session/InputBox.tsx` | 修改 | 左侧集成 ModeSwitcher |
| `apps/agent-web/src/components/session/SessionHeader.tsx` | 修改 | 展示当前模型 badge |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | 新增 modes/currentModeId/currentModel 状态；SSE 事件扩展 |

### 组件设计

**ModeSwitcher** (`components/session/ModeSwitcher.tsx`):

```tsx
interface ModeSwitcherProps {
  currentModeId: string | null;
  modes: AgentMode[];
  status: string;
  onSetMode: (modeId: string) => Promise<void>;
}

// 渲染：按钮 <span>🎯 {当前模式名} ▾</span>
// disabled: status !== 'idling'
// onClick: 打开 ModeSelectDialog
```

**ModeSelectDialog** (`components/session/ModeSelectDialog.tsx`):

```tsx
interface ModeSelectDialogProps {
  open: boolean;
  modes: AgentMode[];
  currentModeId: string | null;
  loading: boolean;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

// Dialog 标题: "切换工作模式"
// 列表项: 名称 + 描述 + 选中态 (✓)
// 底部: 取消 + 确认按钮
```

**InputBox 改造**:

```tsx
// 在 textarea 左侧添加 ModeSwitcher
<div className="flex gap-2 items-start">
  <ModeSwitcher ... />
  <textarea ... />
  <button ... />
</div>
```

**SessionHeader 改造**:

```tsx
// 在 acpServerType badge 旁边添加模型 badge
{session?.currentModel && (
  <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">
    {session.currentModel.name}
  </span>
)}
```

**SessionPage 状态扩展**:

```typescript
const [modes, setModes] = useState<AgentMode[]>([]);
const [currentModeId, setCurrentModeId] = useState<string | null>(null);
const [currentModel, setCurrentModel] = useState<{ id: string; name: string; provider?: string } | null>(null);

// SSE status 事件解析
if (data.data.modes) setModes(data.data.modes);
if (data.data.currentModeId) setCurrentModeId(data.data.currentModeId);
if (data.data.currentModel) setCurrentModel(data.data.currentModel);

// mode:changed 事件处理
if (data.type === 'mode:changed') {
  setCurrentModeId(data.data.modeId);
}
```

### 启动 & 验证

```bash
# agent-web 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## 测试计划

### 单元测试

| 阶段 | 测试文件 | 新增/修改 |
|------|----------|-----------|
| Phase 1 | `servers/agent-api/src/services/session.test.ts` | 修改 - 添加 setMode 测试 |
| Phase 2 | `servers/controller-api/src/services/session-command.test.ts` | 修改 - 添加 acp:set-mode 测试 |
| Phase 3 | `packages/agent-controller/tests/acp/bridge.test.ts` | 修改 - 添加 setMode 测试 |
| Phase 4 | `apps/agent-web/src/components/session/__tests__/ModeSwitcher.test.tsx` | 新建 |
| Phase 4 | `apps/agent-web/src/components/session/__tests__/ModeSelectDialog.test.tsx` | 新建 |

### 运行测试

每个阶段完成后运行：

```bash
npm run test    # 在对应子项目目录下
```

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `aspire start` | 根目录 | 启动全部服务 |
| `npm run dev -- --key <key> --server http://localhost:4001` | `packages/agent-controller` | 启动 agent-controller 连接测试环境 |

---

## 验收 Checklist

- [ ] **Phase 1**: Session 模型编译通过，GraphQL schema 包含新类型和 mutation
- [ ] **Phase 2**: controller-api 收到 acp:set-mode 命令后正确转发到 socket
- [ ] **Phase 3**: agent-controller 收到 acp:set-mode 后调用 bridge.setMode 发送 JSON-RPC
- [ ] **Phase 4**: 前端创建/恢复 Session 后展示当前模式和可用模式列表
- [ ] **Phase 4**: 输入框左侧模式按钮在 idling 时可点击
- [ ] **Phase 4**: running/connecting/ended 状态下按钮置灰
- [ ] **Phase 4**: 选择新模式后按钮文字更新
- [ ] **Phase 4**: SessionHeader 展示当前模型名称（只读）
- [ ] **Phase 4**: modes/models 为空时优雅降级（按钮隐藏）
- [ ] **Phase 4**: 单元测试通过
