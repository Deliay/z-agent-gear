---
description: 端口转发功能 - 实现计划
type: Permanent
---

# 端口转发功能 - 实现计划

**关联 Proposal**: `proposals/20260527-feat-port-forwarding.md`
**创建日期**: 2026-05-27
**更新日期**: 2026-05-27

## 核心原理

端口转发是**反向隧道**：agent-controller 连接到本地端口，通过 Socket.IO 将外部请求中继到该端口，使本地服务可从外部访问。

请求链路：`外部用户 → agent-api(代理) → controller-api(中继) → agent-controller(隧道) → localhost:port`

## 实现顺序

```
Phase 1: 数据模型 + Config
  └── Phase 2: agent-api 端口转发管理路由 (CRUD + GraphQL)
       └── Phase 3: agent-api 端口转发代理路由
            └── Phase 4: controller-api 内部路由 + 中继服务
                 └── Phase 5: agent-controller 隧道客户端
                      └── Phase 6: 前端界面（Sidebar + Dialog）
                           └── Phase 7: 测试覆盖
```

---

## Phase 1: 数据模型 + Config

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/port-forward.ts` | 新增 | 端口转发 Mongoose 模型 |
| `servers/agent-api/src/config/index.ts` | 修改 | 添加端口转发配置项 |

### servers/agent-api/src/models/port-forward.ts

```typescript
import mongoose from 'mongoose';

const portForwardSchema = new mongoose.Schema({
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  port: { type: Number, required: true, min: 1, max: 65535 },
  status: { type: String, enum: ['active', 'inactive', 'error'], default: 'active' },
}, { timestamps: true });

portForwardSchema.index({ controllerId: 1, port: 1 }, { unique: true });
portForwardSchema.index({ userId: 1 });
portForwardSchema.index({ controllerId: 1, status: 1 });

export const PortForward = mongoose.model('PortForward', portForwardSchema);
export type IPortForward = mongoose.InferSchemaType<typeof portForwardSchema>;
```

### servers/agent-api/src/config/index.ts 修改

```typescript
// 在现有配置后添加
controllerApiInternalUrl: process.env.CONTROLLER_API_INTERNAL_URL || 'http://localhost:4001',
portForwardMaxPerController: parseInt(process.env.PORT_FORWARD_MAX_PER_CONTROLLER || '5', 10),
```

### 启动 & 验证

```bash
cd servers/agent-api && npm run build
```

---

## Phase 2: agent-api 端口转发管理路由

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/port-forward.ts` | 新增 | CRUD 路由 |
| `servers/agent-api/src/services/port-forward.ts` | 新增 | 业务逻辑 |
| `servers/agent-api/src/graphql/schemas/port-forward.ts` | 新增 | GraphQL schema |
| `servers/agent-api/src/graphql/resolvers/port-forward.ts` | 新增 | GraphQL resolver |
| `servers/agent-api/src/graphql/schemas/index.ts` | 修改 | 注册 schema |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 注册 resolver |
| `servers/agent-api/src/index.ts` | 修改 | 注册路由 |

### 关键逻辑

**services/port-forward.ts** 核心方法：
- `createPortForward(controllerId, port, userId)`: 验证 controller 在线 → 检查限制(5) → 创建记录 → 调用内部接口注册隧道
- `getPortForwards(controllerId, userId)`: 查询列表
- `deletePortForward(controllerId, port, userId)`: 删除记录 → 调用内部接口销毁隧道

**routes/port-forward.ts**：
- `POST /api/forward/:controllerId/:port` → 创建
- `GET /api/forward/:controllerId` → 查询
- `DELETE /api/forward/:controllerId/:port` → 删除

### 启动 & 验证

```bash
cd servers/agent-api && npm run build
cd servers/agent-api && npm test
```

---

## Phase 3: agent-api 端口转发代理路由

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/port-forward-proxy.ts` | 新增 | 代理路由 |
| `servers/agent-api/src/index.ts` | 修改 | 注册代理路由 |

### 代理路由设计

```typescript
// 匹配所有 /api/forward/:controllerId/:port/* 的请求
router.all('/forward/:controllerId/:port/*', async (req, res) => {
  // 1. 验证身份（Bearer token）
  // 2. 验证端口转发存在且状态为 active
  // 3. 提取目标路径 (req.params[0])
  // 4. 转发请求到 controller-api 内部接口
  //    URL: ${CONTROLLER_API_INTERNAL_URL}/inner/api/forward/${controllerId}/${port}/${path}
  //    Method: 原始 method
  //    Headers: 透传原始 headers
  //    Body: 透传原始 body
  // 5. 透传 controller-api 的响应
});
```

### 启动 & 验证

```bash
cd servers/agent-api && npm run build
```

---

## Phase 4: controller-api 内部路由 + 中继服务

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/routes/port-forward.ts` | 新增 | 内部路由 |
| `servers/controller-api/src/services/port-forward.ts` | 新增 | 中继服务 |
| `servers/controller-api/src/index.ts` | 修改 | 注册路由和服务 |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 添加端口转发 Socket.IO 事件处理 |

### 中继服务设计

```typescript
export class PortForwardService {
  private io: SocketIOServer | null = null;
  private tunnels: Map<string, { controllerId: string; port: number; socketId: string }> = new Map();

  start(io: SocketIOServer): void { this.io = io; }

  // 注册隧道：通知 agent-controller 建立到本地端口的连接
  async registerTunnel(controllerId: string, port: number): Promise<{ success: boolean; tunnelId?: string; error?: string }> {
    // 通过 Socket.IO 发送 port-forward:create 给 agent-controller
    // 等待 port-forward:created 回调
    // 在 tunnels Map 中注册
  }

  // 销毁隧道
  async destroyTunnel(controllerId: string, port: number): Promise<void> {
    // 发送 port-forward:close 给 agent-controller
    // 从 tunnels Map 中移除
  }

  // 代理请求：将外部请求通过 Socket.IO 中继到 agent-controller
  async proxyRequest(controllerId: string, port: number, path: string, method: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    // 查找隧道
    // 通过 Socket.IO 发送 port-forward:data
    // 等待 port-forward:data 响应
    // 返回响应
  }
}
```

### Socket.IO 事件处理（socketio.ts 修改）

```typescript
// 在 socketio.ts 的 connection handler 中添加
socket.on('port-forward:created', async (payload: { tunnelId: string; success: boolean; error?: string }) => {
  if (!authenticated) return;
  portForwardService.handleTunnelCreated(payload);
});

socket.on('port-forward:data', async (payload: { tunnelId: string; data: Buffer }) => {
  if (!authenticated) return;
  portForwardService.handleTunnelData(payload);
});

socket.on('port-forward:close', async (payload: { tunnelId: string }) => {
  if (!authenticated) return;
  portForwardService.handleTunnelClose(payload);
});

socket.on('port-forward:error', async (payload: { tunnelId: string; error: string }) => {
  if (!authenticated) return;
  portForwardService.handleTunnelError(payload);
});
```

### 启动 & 验证

```bash
cd servers/controller-api && npm run build
cd servers/controller-api && npm test
```

---

## Phase 5: agent-controller 隧道客户端

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/port-forward.ts` | 新增 | 隧道管理器 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 添加端口转发事件处理 |

### 隧道管理器设计

```typescript
import net from 'net';

interface Tunnel {
  id: string;
  socket: net.Socket;
  controllerId: string;
  port: number;
}

export class PortForwardManager {
  private tunnels: Map<string, Tunnel> = new Map();
  private socket: Socket | null = null;

  setSocket(socket: Socket): void { this.socket = socket; }

  // 创建隧道：连接本地端口
  async createTunnel(tunnelId: string, controllerId: string, port: number): Promise<{ success: boolean; error?: string }> {
    const localSocket = net.connect({ host: '127.0.0.1', port }, () => {
      // 连接成功，注册隧道
      this.tunnels.set(tunnelId, { id: tunnelId, socket: localSocket, controllerId, port });
      // 通知 controller-api 隧道已建立
      this.socket?.emit('port-forward:created', { tunnelId, success: true });
    });

    // 收到本地数据 → 通过 Socket.IO 发送到 controller-api
    localSocket.on('data', (data) => {
      this.socket?.emit('port-forward:data', { tunnelId, data });
    });

    // 收到远程数据（从 controller-api）→ 写入本地 socket
    // 由 handleTunnelData 方法处理

    localSocket.on('error', (err) => {
      this.socket?.emit('port-forward:error', { tunnelId, error: err.message });
      this.tunnels.delete(tunnelId);
    });

    localSocket.on('close', () => {
      this.socket?.emit('port-forward:close', { tunnelId });
      this.tunnels.delete(tunnelId);
    });
  }

  // 处理从 controller-api 收到的数据 → 写入本地 socket
  handleTunnelData(tunnelId: string, data: Buffer): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (tunnel) {
      tunnel.socket.write(data);
    }
  }

  // 关闭隧道
  closeTunnel(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (tunnel) {
      tunnel.socket.destroy();
      this.tunnels.delete(tunnelId);
    }
  }

  // 关闭所有隧道
  closeAll(): void {
    for (const [id, tunnel] of this.tunnels) {
      tunnel.socket.destroy();
    }
    this.tunnels.clear();
  }
}

export const portForwardManager = new PortForwardManager();
```

### socketio-client.ts 修改

```typescript
import { portForwardManager } from './port-forward.js';

// 注册 socket
portForwardManager.setSocket(socket);

// 处理隧道创建请求
socket.on('port-forward:create', async (data: { tunnelId: string; controllerId: string; port: number }) => {
  await portForwardManager.createTunnel(data.tunnelId, data.controllerId, data.port);
});

// 处理远程数据 → 写入本地 socket
socket.on('port-forward:data', (data: { tunnelId: string; data: Buffer }) => {
  portForwardManager.handleTunnelData(data.tunnelId, data.data);
});

// 处理隧道关闭
socket.on('port-forward:close', (data: { tunnelId: string }) => {
  portForwardManager.closeTunnel(data.tunnelId);
});

// 断开连接时清理
socket.on('disconnect', () => {
  portForwardManager.closeAll();
});
```

### 启动 & 验证

```bash
cd packages/agent-controller && npm run build
cd packages/agent-controller && npm test
```

---

## Phase 6: 前端界面

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | controller 节点下添加端口转发分类 |
| `apps/agent-web/src/components/PortForwardDialog.tsx` | 新增 | 新建端口转发对话框 |
| `apps/agent-web/src/components/PortForwardItem.tsx` | 新增 | 端口转发列表项组件 |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 添加端口转发查询 |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 添加端口转发类型 |

### Sidebar.tsx 修改要点

在 controller 展开区域内，workspace 列表前添加"端口转发"分类：

```tsx
{controller.status === 'online' && (
  <li>
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-xs font-medium text-gray-400">端口转发</span>
      <button onClick={() => setPortForwardDialog({ controllerId: controller.id, ... })}>+</button>
    </div>
    {portForwards.map(pf => (
      <PortForwardItem key={pf.id} port={pf.port} status={pf.status} onDelete={...} />
    ))}
  </li>
)}
```

### PortForwardDialog.tsx

- 端口号输入框（1-65535）
- 显示已使用/限制数量
- 确认/取消按钮

### 启动 & 验证

```bash
cd apps/agent-web && npm run build
cd apps/agent-web && npm test
```

---

## Phase 7: 测试覆盖

### 测试类型

| 类型 | 文件 | 覆盖范围 |
|------|------|---------|
| 单元测试 | `servers/agent-api/src/services/port-forward.test.ts` | 业务逻辑 |
| 单元测试 | `servers/controller-api/src/services/port-forward.test.ts` | 中继服务 |
| 单元测试 | `packages/agent-controller/src/port-forward.test.ts` | 隧道管理 |
| API 测试 | `tests/api/port-forward.test.ts` | REST API 端点 |
| E2E 测试 | `tests/e2e/port-forward.test.ts` | 完整流程 |

### 测试命令

```bash
npm run test -- --testPathPattern=port-forward
```

---

## 验收 Checklist

### Phase 1: 数据模型
- [ ] Mongoose 模型编译通过
- [ ] 索引创建正确（controllerId + port 唯一索引）

### Phase 2: 管理路由
- [ ] 创建端口转发 API 正常（POST /api/forward/:controllerId/:port）
- [ ] 查询端口转发 API 正常（GET /api/forward/:controllerId）
- [ ] 删除端口转发 API 正常（DELETE /api/forward/:controllerId/:port）
- [ ] 身份验证正常
- [ ] Controller 在线状态检查正常
- [ ] 端口数量限制正常（per controller, max 5）

### Phase 3: 代理路由
- [ ] 外部请求能正确代理到 controller-api
- [ ] HTTP 方法、Headers、Body 透传正常
- [ ] 响应透传正常

### Phase 4: 中继服务
- [ ] 隧道注册正常
- [ ] 隧道销毁正常
- [ ] 数据双向中继正常

### Phase 5: 隧道客户端
- [ ] 连接本地端口正常
- [ ] 数据双向传输正常
- [ ] 连接错误处理正常
- [ ] 断开清理正常

### Phase 6: 前端界面
- [ ] 左侧面板显示端口转发分类
- [ ] 新建对话框工作正常
- [ ] 删除端口转发工作正常

---

## 常见问题

### Q: 本地端口无服务监听怎么办？
A: agent-controller 连接本地端口失败时，会通过 port-forward:error 事件通知，状态设为 error。

### Q: 网络中断怎么办？
A: Socket.IO 断开时，agent-controller 自动关闭所有隧道。controller-api 清理相关隧道状态。

### Q: 支持 UDP 吗？
A: 当前实现只支持 TCP，UDP 支持需要额外实现。

### Q: Session 结束后端口转发会怎样？
A: 端口转发独立于 session 生命周期，session 结束不影响端口转发。只有 controller 断开连接时，端口转发才会自动关闭。
