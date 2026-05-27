---
description: 端口转发功能 - 实现计划
type: Permanent
---

# 端口转发功能 - 实现计划

**关联 Proposal**: `proposals/20260527-feat-port-forwarding.md`
**创建日期**: 2026-05-27
**更新日期**: 2026-05-27

## 核心原理

端口转发是**反向隧道**：agent-controller 连接到本地端口，通过 Socket.IO 将外部请求中继到该端口。

请求链路：`外部用户 → agent-api(代理, 需鉴权) → Redis Pub/Sub → controller-api(中继) → Socket.IO → agent-controller(隧道) → localhost:port`

## 关键设计决策

- **管理 API**：GraphQL（Mutation 创建/删除，Query 查询）
- **代理 API**：REST（需鉴权，透传请求/响应）
- **内部通信**：Redis Pub/Sub（支持多服务器部署）
- **隧道通信**：Socket.IO（controller-api ↔ agent-controller）

## 实现顺序

```
Phase 1: 数据模型 + Config
  └── Phase 2: agent-api GraphQL 管理 API
       └── Phase 3: agent-api 代理路由 (REST, 需鉴权)
            └── Phase 4: controller-api Redis 订阅 + Socket.IO 中继
                 └── Phase 5: agent-controller 隧道客户端
                      └── Phase 6: 前端界面
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
portForwardMaxPerController: parseInt(process.env.PORT_FORWARD_MAX_PER_CONTROLLER || '5', 10),
```

---

## Phase 2: agent-api GraphQL 管理 API

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/port-forward.ts` | 新增 | GraphQL schema |
| `servers/agent-api/src/graphql/resolvers/port-forward.ts` | 新增 | GraphQL resolver |
| `servers/agent-api/src/services/port-forward.ts` | 新增 | 业务逻辑（含 Redis Pub/Sub） |
| `servers/agent-api/src/graphql/schemas/index.ts` | 修改 | 注册 schema |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 注册 resolver |

### GraphQL Schema

```graphql
type PortForward {
  id: ID!
  controllerId: ID!
  port: Int!
  status: String!
  createdAt: DateTime!
}

type PortForwardList {
  portForwards: [PortForward!]!
  total: Int!
  limit: Int!
}

extend type Query {
  portForwards(controllerId: ID!): PortForwardList!
}

extend type Mutation {
  createPortForward(controllerId: ID!, port: Int!): PortForward!
  deletePortForward(controllerId: ID!, port: Int!): Boolean!
}
```

### 业务逻辑

**createPortForward**：
1. 验证 context.currentUser
2. 查询 Controller，验证存在且 status === 'online'
3. `PortForward.countDocuments({ controllerId, status: 'active' })` < 5
4. 检查端口不重复
5. 创建记录
6. Redis PUBLISH `port-forward:command` → `{ type: 'tunnel:create', controllerId, port }`

**deletePortForward**：
1. 验证 context.currentUser
2. 查找并删除记录
3. Redis PUBLISH `port-forward:command` → `{ type: 'tunnel:close', controllerId, port }`

---

## Phase 3: agent-api 代理路由 (REST, 需鉴权)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/port-forward-proxy.ts` | 新增 | 代理路由 |
| `servers/agent-api/src/index.ts` | 修改 | 注册代理路由 |

### 代理路由设计

```typescript
router.all('/forward/:controllerId/:port/*', async (req, res) => {
  // 1. 验证 Bearer token（复用现有 authenticateExpressUser）
  // 2. 查询 PortForward 记录，确认 active
  // 3. Redis PUBLISH port-forward:command { type: 'proxy:request', requestId, controllerId, port, path, method, headers, body }
  // 4. 等待 Redis 响应（GET pf_proxy:{requestId}，轮询或订阅）
  // 5. 透传响应
});
```

---

## Phase 4: controller-api Redis 订阅 + Socket.IO 中继

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/port-forward.ts` | 新增 | 中继服务（Redis 订阅 + Socket.IO） |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 添加端口转发 Socket.IO 事件处理 |
| `servers/controller-api/src/index.ts` | 修改 | 启动中继服务 |

### 中继服务设计

```typescript
export class PortForwardRelayService {
  private io: SocketIOServer | null = null;
  private tunnels: Map<string, { controllerId: string; port: number; socketId: string }> = new Map();
  private instanceId: string = crypto.randomUUID();

  start(io: SocketIOServer): void {
    this.io = io;
    // 订阅 Redis 频道 port-forward:command
    // 收到命令后：
    //   tunnel:create → 检查是否有对应 controller 连接 → Socket.IO 发送给 agent-controller
    //   tunnel:close → 销毁隧道
    //   proxy:request → 查找隧道 → Socket.IO 中继数据 → 发布响应到 port-forward:response
  }
}
```

### Socket.IO 事件处理（socketio.ts 修改）

```typescript
socket.on('port-forward:created', (payload) => { ... });
socket.on('port-forward:data', (payload) => { ... });
socket.on('port-forward:close', (payload) => { ... });
socket.on('port-forward:error', (payload) => { ... });
```

---

## Phase 5: agent-controller 隧道客户端

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/port-forward.ts` | 新增 | 隧道管理器 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 添加端口转发事件处理 |

### 隧道管理器

```typescript
export class PortForwardManager {
  private tunnels: Map<string, { id: string; socket: net.Socket }> = new Map();

  createTunnel(tunnelId: string, port: number): Promise<{ success: boolean; error?: string }> {
    // net.connect({ host: '127.0.0.1', port })
    // 成功后注册隧道，通知 controller-api
    // 数据事件：socket.on('data') → emit 'port-forward:data'
  }

  handleTunnelData(tunnelId: string, data: Buffer): void {
    // 写入本地 socket
  }

  closeTunnel(tunnelId: string): void { ... }
  closeAll(): void { ... }
}
```

---

## Phase 6: 前端界面

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 添加 GET_PORT_FORWARDS 查询 |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 添加 CREATE/DELETE_PORT_FORWARD |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 添加类型 |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 添加端口转发分类 |
| `apps/agent-web/src/components/PortForwardDialog.tsx` | 新增 | 对话框 |
| `apps/agent-web/src/components/PortForwardItem.tsx` | 新增 | 列表项 |

---

## Phase 7: 测试覆盖

| 类型 | 文件 | 覆盖范围 |
|------|------|---------|
| 单元测试 | `servers/agent-api/src/services/port-forward.test.ts` | 业务逻辑 |
| 单元测试 | `servers/controller-api/src/services/port-forward.test.ts` | 中继服务 |
| 单元测试 | `packages/agent-controller/src/port-forward.test.ts` | 隧道管理 |
| API 测试 | GraphQL 端点 | createPortForward / deletePortForward / portForwards |
| E2E 测试 | 完整流程 | 前端 → GraphQL → 隧道 → 本地端口 |

---

## 验收 Checklist

- [ ] GraphQL Mutation/Query 工作正常
- [ ] 代理路由鉴权正常
- [ ] Redis Pub/Sub 跨服务器通信正常
- [ ] Socket.IO 隧道数据双向传输正常
- [ ] 本地端口连接/断开处理正常
- [ ] 前端界面操作正常
- [ ] 所有测试通过
