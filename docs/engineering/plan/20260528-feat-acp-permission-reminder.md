---
description: ACP授权提醒功能 - 实现计划
type: Permanent
---

# ACP授权提醒 - 实现计划

**关联 Proposal**: `proposals/20260528-feat-acp-permission-reminder.md`
**创建日期**: 2026-05-28
**更新日期**: 2026-05-28

## 核心原理

当Agent发送`session/request_permission`时，`AcpSessionBridge`暂停等待用户响应，通过WebSocket → Redis → SSE链路将权限请求推送到前端，用户审批后结果原路返回。

请求链路：`OpenCode Agent → AcpSessionBridge(暂停) → agent-controller → Socket.IO → controller-api → Redis → agent-api → SSE → 前端 → 用户`

响应链路：`用户 → 前端 → GraphQL → agent-api → Redis → controller-api → Socket.IO → agent-controller → AcpSessionBridge → OpenCode Agent`

## 关键设计决策

- **权限请求转发**：新增WebSocket事件 `acp:permission` / `acp:permission:response`
- **内部通信**：Redis Pub/Sub（支持多服务器部署）
- **前端推送**：SSE（复用现有session stream）
- **待办存储**：MongoDB（持久化） + Redis（实时查询）
- **超时处理**：用户选择 > Session设置 > 全局设置 > 默认「允许一次」

## 实现顺序

```
Phase 1: Contract 更新（WebSocket + GraphQL）
  └── Phase 2: 数据模型（TodoItem + Session/Global设置）
       └── Phase 3: controller-api（PermissionManager）
            └── Phase 4: agent-controller（AcpSessionBridge改造）
                 └── Phase 5: agent-api（TodoService + GraphQL Resolver）
                      └── Phase 6: 前端（待办入口 + PermissionDialog + 设置）
                           └── Phase 7: 测试覆盖
```

---

## Phase 1: Contract 更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session-websocket.md` | 修改 | 新增 `acp:permission` / `acp:permission:response` 事件 |
| `contracts/agent-session.graphql` | 修改 | 新增 TodoItem 类型 + respondPermission Mutation |

### WebSocket 新增事件

#### `acp:permission`（Controller → Server）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求ID |
| `sessionId` | `string` | 是 | Session ID |
| `toolCall` | `object` | 是 | `{ toolCallId: string }` |
| `options` | `PermissionOption[]` | 是 | 审批选项 |

#### `acp:permission:response`（Server → Controller）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求ID |
| `outcome` | `object` | 是 | `{ outcome: 'selected'\|'cancelled', optionId?: string }` |

### GraphQL 新增

```graphql
enum PermissionOptionKind {
  allow_once
  allow_always
  reject_once
  reject_always
}

type PermissionOption {
  optionId: String!
  name: String!
  kind: PermissionOptionKind!
}

enum TodoPriority {
  immediate
  urgent
  medium
  low
}

enum TodoType {
  permission_request
}

type TodoItem {
  id: ID!
  type: TodoType!
  priority: TodoPriority!
  title: String!
  description: String
  isRead: Boolean!
  data: JSON
  createdAt: String!
}

extend type Query {
  getTodoList: [TodoItem!]!
  getUnreadTodoCount: Int!
}

extend type Mutation {
  respondPermission(requestId: String!, outcome: String!, optionId: String): Boolean!
  markTodoRead(todoId: ID!): Boolean!
  markAllTodoRead: Boolean!
  updatePermissionTimeout(sessionId: ID, timeoutAction: String!): Boolean!
}
```

---

## Phase 2: 数据模型

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/todo-item.ts` | 新增 | 待办事项模型 |
| `servers/agent-api/src/models/session.ts` | 修改 | 添加 `permissionTimeoutAction` 字段 |
| `servers/agent-api/src/models/user.ts` | 修改 | 添加 `globalPermissionTimeoutAction` 字段 |

### TodoItem 模型

```typescript
const todoItemSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['permission_request'], required: true },
  priority: { type: String, enum: ['immediate', 'urgent', 'medium', 'low'], required: true },
  title: { type: String, required: true },
  description: { type: String },
  isRead: { type: Boolean, default: false },
  data: {
    requestId: String,
    sessionId: ObjectId,
    toolCallId: String,
    options: [{
      optionId: String,
      name: String,
      kind: String,
    }],
  },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });
```

### Session 模型扩展

```typescript
// 新增字段
permissionTimeoutAction: { 
  type: String, 
  enum: ['use_global', 'allow_once', 'reject', 'cancel'], 
  default: 'use_global' 
}
```

### User 模型扩展

```typescript
// 新增字段
globalPermissionTimeoutAction: { 
  type: String, 
  enum: ['allow_once', 'reject', 'cancel'], 
  default: 'allow_once' 
}
```

---

## Phase 3: controller-api

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/permission-manager.ts` | 新增 | 权限请求管理服务 |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 注册 `acp:permission` 事件处理 |
| `servers/controller-api/src/services/redis-subscriber.ts` | 修改 | 订阅 `permission:response` 频道 |

### PermissionManager 服务

```typescript
export class PermissionManager {
  private pendingRequests = new Map<string, {
    socketId: string;
    sessionId: string;
    timeout: NodeJS.Timeout;
  }>();

  constructor(private io: SocketIOServer) {}

  async handlePermissionRequest(socket: Socket, data: {
    requestId: string;
    sessionId: string;
    toolCall: { toolCallId: string };
    options: PermissionOption[];
  }): Promise<void> {
    const timeout = setTimeout(() => this.handleTimeout(data.requestId), 60_000);
    this.pendingRequests.set(data.requestId, {
      socketId: socket.id,
      sessionId: data.sessionId,
      timeout,
    });

    // 发布到Redis
    await redis.publish('permission:request', JSON.stringify({
      requestId: data.requestId,
      controllerId: socket.data.controllerId,
      sessionId: data.sessionId,
      userId: socket.data.userId,
      toolCall: data.toolCall,
      options: data.options,
    }));
  }

  async handlePermissionResponse(data: {
    requestId: string;
    outcome: RequestPermissionOutcome;
  }): Promise<void> {
    const pending = this.pendingRequests.get(data.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(data.requestId);

    const socket = this.io.sockets.sockets.get(pending.socketId);
    if (socket) {
      socket.emit('acp:permission:response', {
        requestId: data.requestId,
        outcome: data.outcome,
      });
    }
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    const socket = this.io.sockets.sockets.get(pending.socketId);
    if (socket) {
      socket.emit('acp:permission:response', {
        requestId,
        outcome: { outcome: 'cancelled' },
      });
    }
  }
}
```

### socketio.ts 修改

```typescript
// 在 register 成功后添加
socket.on('acp:permission', (data) => {
  permissionManager.handlePermissionRequest(socket, data);
});
```

### redis-subscriber.ts 修改

```typescript
// 订阅 permission:response 频道
redisSubscriber.subscribe('permission:response', (message) => {
  const data = JSON.parse(message);
  permissionManager.handlePermissionResponse(data);
});
```

---

## Phase 4: agent-controller

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | 改造 `requestPermission()` |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 添加 `acp:permission:response` 处理 |

### AcpSessionBridge 改造

```typescript
// 新增属性
private pendingPermissions = new Map<string, {
  resolve: (response: acp.RequestPermissionResponse) => void;
  timeout: NodeJS.Timeout;
}>();

// 改造 requestPermission
async requestPermission(
  params: acp.RequestPermissionRequest,
): Promise<acp.RequestPermissionResponse> {
  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      this.pendingPermissions.delete(requestId);
      resolve({ outcome: { outcome: 'cancelled' } });
    }, 65_000); // 比server端超时多5秒
    
    this.pendingPermissions.set(requestId, { resolve, timeout });
    
    this.socket.emit('acp:permission', {
      requestId,
      sessionId: this.sessionId,
      toolCall: params.toolCall,
      options: params.options,
    });
  });
}

// 新增：处理响应
handlePermissionResponse(requestId: string, outcome: acp.RequestPermissionOutcome): void {
  const pending = this.pendingPermissions.get(requestId);
  if (!pending) return;
  
  clearTimeout(pending.timeout);
  this.pendingPermissions.delete(requestId);
  pending.resolve({ outcome });
}
```

### socketio-client.ts 修改

```typescript
socket.on('acp:permission:response', (data: {
  requestId: string;
  outcome: RequestPermissionOutcome;
}) => {
  const bridge = getActiveBridge(data.sessionId);
  if (bridge) {
    bridge.handlePermissionResponse(data.requestId, data.outcome);
  }
});
```

---

## Phase 5: agent-api

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/todo-service.ts` | 新增 | 待办事项服务 |
| `servers/agent-api/src/services/permission-timeout.ts` | 新增 | 超时策略服务 |
| `servers/agent-api/src/graphql/schemas/todo.ts` | 新增 | GraphQL schema |
| `servers/agent-api/src/graphql/resolvers/todo.ts` | 新增 | GraphQL resolver |
| `servers/agent-api/src/services/redis-subscriber.ts` | 修改 | 订阅 `permission:request` 频道 |
| `servers/agent-api/src/services/sse.ts` | 修改 | 添加 `permission_request` 事件类型 |

### TodoService

```typescript
export class TodoService {
  async createPermissionTodo(userId: string, data: PermissionRequestData): Promise<TodoItem> {
    const todo = await TodoItem.create({
      userId,
      type: 'permission_request',
      priority: 'immediate',
      title: 'Agent请求权限审批',
      description: `工具调用 ${data.toolCall.toolCallId} 请求权限`,
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
        options: data.options,
      },
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    // SSE推送
    sseService.pushToUser(userId, {
      type: 'permission_request',
      data: { ...todo.toObject(), requestId: data.requestId },
    });

    return todo;
  }

  async respondPermission(userId: string, requestId: string, outcome: RequestPermissionOutcome): Promise<void> {
    // 发布到Redis
    await redis.publish('permission:response', JSON.stringify({ requestId, outcome }));
    
    // 标记已处理
    await TodoItem.updateOne(
      { userId, 'data.requestId': requestId },
      { $set: { isRead: true } }
    );
  }

  async getTimeoutAction(userId: string, sessionId: string): Promise<string> {
    // 1. 查询Session设置
    const session = await Session.findById(sessionId);
    if (session?.permissionTimeoutAction && session.permissionTimeoutAction !== 'use_global') {
      return session.permissionTimeoutAction;
    }
    
    // 2. 查询全局设置
    const user = await User.findById(userId);
    if (user?.globalPermissionTimeoutAction) {
      return user.globalPermissionTimeoutAction;
    }
    
    // 3. 默认值
    return 'allow_once';
  }
}
```

### redis-subscriber.ts 修改

```typescript
redisSubscriber.subscribe('permission:request', async (message) => {
  const data = JSON.parse(message);
  await todoService.createPermissionTodo(data.userId, data);
});
```

---

## Phase 6: 前端

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 添加待办入口图标+未读数 |
| `apps/agent-web/src/components/TodoListPanel.tsx` | 新增 | 待办列表面板 |
| `apps/agent-web/src/components/PermissionDialog.tsx` | 新增 | 权限审批Dialog |
| `apps/agent-web/src/components/GlobalNotification.tsx` | 新增 | 全局弹窗通知 |
| `apps/agent-web/src/hooks/useTodo.ts` | 新增 | 待办状态管理 |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增待办查询 |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增权限响应变更 |
| `apps/agent-web/src/pages/SettingsPage.tsx` | 修改 | 添加全局权限超时设置 |
| `apps/agent-web/src/components/session/SessionSettings.tsx` | 修改 | 添加Session权限超时设置 |

### Sidebar 修改

```tsx
// 在用户名右侧、设置按钮左侧添加
<div className="flex items-center gap-2">
  <span>{userName}</span>
  <TodoBadge /> {/* 新增：待办图标+未读数 */}
  <SettingsButton />
</div>
```

### TodoListPanel

```tsx
export function TodoListPanel() {
  const { todos, unreadCount, markRead, markAllRead } = useTodo();
  
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0">
              {unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="flex justify-between items-center mb-2">
          <h4 className="font-medium">待办事项</h4>
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            全部已读
          </Button>
        </div>
        <ScrollArea className="h-[300px]">
          {todos.map(todo => (
            <TodoItem key={todo.id} todo={todo} onRead={markRead} />
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
```

### PermissionDialog

```tsx
export function PermissionDialog({ open, onOpenChange, todo }: Props) {
  const { respondPermission } = useRespondPermission();
  const [responding, setResponding] = useState(false);
  
  const handleRespond = async (optionId?: string) => {
    setResponding(true);
    try {
      await respondPermission({
        requestId: todo.data.requestId,
        outcome: optionId ? 'selected' : 'cancelled',
        optionId,
      });
      onOpenChange(false);
    } finally {
      setResponding(false);
    }
  };
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent请求权限审批</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            工具调用 ID: {todo.data.toolCallId}
          </p>
          
          <div className="flex flex-col gap-2">
            {todo.data.options.map(option => (
              <Button
                key={option.optionId}
                variant={option.kind.startsWith('allow') ? 'default' : 'destructive'}
                onClick={() => handleRespond(option.optionId)}
                disabled={responding}
              >
                {option.name}
              </Button>
            ))}
            <Button variant="outline" onClick={() => handleRespond()} disabled={responding}>
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### GlobalNotification

```tsx
export function GlobalNotification() {
  const { currentPermission, setCurrentPermission } = useTodo();
  
  if (!currentPermission) return null;
  
  return (
    <div className="fixed top-4 right-4 z-50">
      <Card className="w-80 border-destructive">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bell className="h-4 w-4 text-destructive" />
            {currentPermission.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-2">
          <p className="text-sm">{currentPermission.description}</p>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button size="sm" onClick={() => openPermissionDialog(currentPermission)}>
            查看详情
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCurrentPermission(null)}>
            稍后处理
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
```

### 设置页面

```tsx
// 全局设置
<Select value={globalTimeoutAction} onValueChange={setGlobalTimeoutAction}>
  <SelectItem value="allow_once">允许一次</SelectItem>
  <SelectItem value="reject">拒绝</SelectItem>
  <SelectItem value="cancel">取消</SelectItem>
</Select>

// Session设置
<Select value={sessionTimeoutAction} onValueChange={setSessionTimeoutAction}>
  <SelectItem value="use_global">使用全局设置</SelectItem>
  <SelectItem value="allow_once">允许一次</SelectItem>
  <SelectItem value="reject">拒绝</SelectItem>
  <SelectItem value="cancel">取消</SelectItem>
</Select>
```

---

## Phase 7: 测试覆盖

### 文件修改

| 类型 | 文件 | 覆盖范围 |
|------|------|---------|
| 单元测试 | `servers/controller-api/src/services/permission-manager.test.ts` | 请求-响应流程、超时处理 |
| 单元测试 | `servers/agent-api/src/services/todo-service.test.ts` | 待办创建、响应、超时策略 |
| 单元测试 | `packages/agent-controller/src/acp/bridge.test.ts` | requestPermission改造 |
| API测试 | GraphQL端点 | respondPermission、getTodoList |
| E2E测试 | 完整流程 | Agent请求 → 用户审批 → Agent继续 |

### 测试重点

1. `AcpSessionBridge.requestPermission()` 超时返回cancelled
2. 权限请求-响应端到端流程
3. 超时策略优先级：用户 > Session > 全局 > 默认
4. 待办事项创建、查询、标记已读
5. 全局弹窗触发和关闭
6. 并发权限请求处理

---

## 验收 Checklist

- [ ] Contract 更新完成（WebSocket + GraphQL）
- [ ] TodoItem 模型创建成功
- [ ] Session/User 模型扩展成功
- [ ] PermissionManager 请求-响应流程正常
- [ ] AcpSessionBridge.requestPermission() 等待用户响应
- [ ] 超时后按优先级返回默认选项
- [ ] TodoService 创建待办、响应正常
- [ ] SSE 推送 permission_request 事件
- [ ] 待办列表显示正常
- [ ] 权限审批Dialog交互正常
- [ ] 全局弹窗触发正常
- [ ] 设置页面保存生效
- [ ] 所有测试通过

## 命令参考

```bash
# 启动开发环境
aspire start

# 运行测试
npm run test

# 运行lint
npm run lint

# 类型检查
npm run typecheck
```
