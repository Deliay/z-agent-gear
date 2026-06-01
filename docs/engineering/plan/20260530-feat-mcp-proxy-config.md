---
description: MCP 代理服务管理与配置下发 - 实现计划
type: Permanent
---

# MCP 代理服务管理与配置下发 - 实现计划

**关联 Proposal**: `proposals/20260530-feat-mcp-proxy-config.md`
**创建日期**: 2026-05-30

## 实现顺序

```
Phase 1: Contract + 数据模型
  └── Phase 2: MCP Proxy Key 管理 (controller-api)
       └── Phase 3: MCP Proxy 注册 + WebSocket 协议 (controller-api)
            └── Phase 4: MCP Forwarder 转发服务 (新服务)
                 └── Phase 5: Session 端点管理 (controller-api)
                      └── Phase 6: agent-gear mcp-proxy 子命令 (agent-controller)
                           └── Phase 7: agent-gear mcp 子命令 (agent-controller)
                                └── Phase 8: 前端 MCP 管理 UI (agent-web)
                                     └── Phase 9: 测试覆盖
```

---

## Phase 1: Contract + 数据模型

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/mcp-server.graphql` | 新增 | MCP Server GraphQL Schema |
| `contracts/mcp-proxy.graphql` | 新增 | MCP Proxy Key GraphQL Schema |
| `contracts/mcp-proxy-websocket.md` | 新增 | MCP Proxy 注册 WebSocket 协议 |
| `contracts/agent-session-websocket.md` | 修改 | `acp:start` 新增 `mcpEndpoint` 字段 |
| `contracts/agent-session.graphql` | 修改 | `CreateSessionInput` 新增 `mcpServerIds` |
| `servers/agent-api/src/models/mcp-server.ts` | 新增 | McpServer Mongoose Model |
| `servers/agent-api/src/graphql/schemas/mcp-server.ts` | 新增 | GraphQL Schema |
| `servers/agent-api/src/graphql/resolvers/mcp-server.ts` | 新增 | GraphQL Resolver |

### contracts/mcp-server.graphql

```graphql
enum McpServerTransport {
  registered_proxy
}

enum McpServerStatus {
  active
  offline
  disabled
}

type McpServer {
  id: ID!
  name: String!
  transport: McpServerTransport!
  command: String!
  status: McpServerStatus!
  lastHeartbeatAt: String
  createdAt: String!
  updatedAt: String!
}

type Query {
  mcpServers: [McpServer!]!
  mcpServer(id: ID!): McpServer
}
```

### contracts/mcp-proxy.graphql

```graphql
enum McpProxyKeyStatus {
  active
  revoked
}

type McpProxyKey {
  id: ID!
  name: String!
  keyPrefix: String!
  status: McpProxyKeyStatus!
  lastUsedAt: String
  createdAt: String!
}

type CreateMcpProxyKeyPayload {
  key: McpProxyKey!
  rawKey: String!
}

type Query {
  mcpProxyKeys: [McpProxyKey!]!
}

type Mutation {
  createMcpProxyKey(name: String!): CreateMcpProxyKeyPayload!
  revokeMcpProxyKey(id: ID!): Boolean!
}
```

### contracts/agent-session.graphql 变更

```graphql
input CreateSessionInput {
  controllerId: ID!
  acpServerType: AcpServerType! = opencode
  workspaceId: ID!
  enableWorktree: Boolean = false
  worktreeBranchSuffix: String
  mcpServerIds: [ID!]  # 新增
}
```

### contracts/agent-session-websocket.md 变更

在 `acp:start` Payload 中新增：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mcpEndpoint` | `McpEndpoint` | 否 | MCP 转发端点信息 |

**McpEndpoint 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | `string` | 是 | 转发端点 URL |
| `token` | `string` | 是 | Bearer Token |
| `serverNames` | `string[]` | 是 | MCP Server 名称列表 |

### servers/agent-api/src/models/mcp-server.ts

```typescript
import { Schema, model, Document } from 'mongoose';

export interface IMcpServer extends Document {
  userId: string;
  name: string;
  transport: 'registered_proxy';
  command: string;
  proxyConnectionId?: string;
  status: 'active' | 'offline' | 'disabled';
  lastHeartbeatAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const mcpServerSchema = new Schema<IMcpServer>(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    transport: { type: String, enum: ['registered_proxy'], default: 'registered_proxy' },
    command: { type: String, required: true },
    proxyConnectionId: { type: String, index: true },
    status: { type: String, enum: ['active', 'offline', 'disabled'], default: 'active' },
    lastHeartbeatAt: { type: Date },
  },
  { timestamps: true },
);

mcpServerSchema.index({ userId: 1, name: 1 }, { unique: true });

export const McpServer = model<IMcpServer>('McpServer', mcpServerSchema);
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
npm run test     # 单元测试
```

---

## Phase 2: MCP Proxy Key 管理 (controller-api)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/models/mcp-proxy-key.ts` | 新增 | McpProxyKey Mongoose Model |
| `servers/controller-api/src/services/mcp-proxy-key.ts` | 新增 | Key 生成/验证/撤销 Service |
| `servers/controller-api/src/routes/mcp-proxy.ts` | 新增 | GraphQL Schema + Resolver |

### servers/controller-api/src/models/mcp-proxy-key.ts

```typescript
import { Schema, model, Document } from 'mongoose';

export interface IMcpProxyKey extends Document {
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  lastUsedAt?: Date;
  createdAt: Date;
}

const mcpProxyKeySchema = new Schema<IMcpProxyKey>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    keyHash: { type: String, required: true },
    keyPrefix: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

mcpProxyKeySchema.index({ userId: 1, name: 1 }, { unique: true });

export const McpProxyKey = model<IMcpProxyKey>('McpProxyKey', mcpProxyKeySchema);
```

### servers/controller-api/src/services/mcp-proxy-key.ts

```typescript
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { McpProxyKey, IMcpProxyKey } from '../models/mcp-proxy-key.js';

const SALT_ROUNDS = 10;

export class McpProxyKeyService {
  async createKey(userId: string, name: string): Promise<{ key: IMcpProxyKey; rawKey: string }> {
    const rawKey = `mcp_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, SALT_ROUNDS);
    const keyPrefix = `${rawKey.slice(0, 7)}...${rawKey.slice(-4)}`;

    const key = await McpProxyKey.create({
      userId,
      name,
      keyHash,
      keyPrefix,
      status: 'active',
    });

    return { key, rawKey };
  }

  async verifyKey(rawKey: string): Promise<{ valid: boolean; keyId?: string; userId?: string }> {
    const keys = await McpProxyKey.find({ status: 'active' });
    for (const key of keys) {
      const match = await bcrypt.compare(rawKey, key.keyHash);
      if (match) {
        await McpProxyKey.findByIdAndUpdate(key._id, { lastUsedAt: new Date() });
        return { valid: true, keyId: key._id.toString(), userId: key.userId };
      }
    }
    return { valid: false };
  }

  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    const result = await McpProxyKey.findOneAndUpdate(
      { _id: keyId, userId },
      { status: 'revoked' },
    );
    return !!result;
  }

  async listKeys(userId: string): Promise<IMcpProxyKey[]> {
    return McpProxyKey.find({ userId }).sort({ createdAt: -1 });
  }
}
```

### 启动 & 验证

```bash
# controller-api 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 3: MCP Proxy 注册 + WebSocket 协议 (controller-api)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/mcp-proxy-registry.ts` | 新增 | 代理注册管理 Service |
| `servers/controller-api/src/routes/mcp-proxy.ts` | 修改 | 新增注册 REST API |
| `servers/controller-api/src/index.ts` | 修改 | 注册 mcp-proxy 路由 |

### servers/controller-api/src/services/mcp-proxy-registry.ts

```typescript
import { Server as SocketServer, Socket } from 'socket.io';
import { McpServer } from '../models/mcp-server.js'; // 需新建或复用 agent-api 的 model
import { McpProxyKeyService } from './mcp-proxy-key.js';

interface ProxyConnection {
  socket: Socket;
  serverId: string;
  userId: string;
  command: string;
}

export class McpProxyRegistry {
  private connections: Map<string, ProxyConnection> = new Map();
  private keyService: McpProxyKeyService;

  constructor(private io: SocketServer) {
    this.keyService = new McpProxyKeyService();
  }

  async register(
    rawKey: string,
    hostname: string,
    command: string,
    serverName: string,
  ): Promise<{ success: boolean; proxyId?: string; serverId?: string; error?: string }> {
    const { valid, keyId, userId } = await this.keyService.verifyKey(rawKey);
    if (!valid || !userId) {
      return { success: false, error: 'Invalid key' };
    }

    // 创建 McpServer 记录
    const server = await McpServer.create({
      userId,
      name: serverName,
      transport: 'registered_proxy',
      command,
      status: 'active',
    });

    const proxyId = `proxy_${server._id}`;
    return { success: true, proxyId, serverId: server._id.toString() };
  }

  handleConnection(socket: Socket, proxyId: string): void {
    this.connections.set(proxyId, { socket, serverId: '', userId: '', command: '' });

    socket.on('proxy:heartbeat', () => this.handleHeartbeat(proxyId));
    socket.on('proxy:response', (data) => this.handleResponse(proxyId, data));
    socket.on('proxy:unregister', () => this.handleUnregister(proxyId));
    socket.on('disconnect', () => this.handleDisconnect(proxyId));
  }

  async forwardRequest(proxyId: string, request: any): Promise<any> {
    const conn = this.connections.get(proxyId);
    if (!conn) throw new Error('Proxy not connected');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timeout')), 30000);
      conn.socket.once('proxy:response', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
      conn.socket.emit('proxy:request', request);
    });
  }

  private handleHeartbeat(proxyId: string): void {
    const conn = this.connections.get(proxyId);
    if (conn) {
      McpServer.findByIdAndUpdate(conn.serverId, { lastHeartbeatAt: new Date() });
    }
  }

  private handleResponse(proxyId: string, data: any): void {
    // 响应由 forwardRequest 的 Promise 处理
  }

  private async handleUnregister(proxyId: string): Promise<void> {
    const conn = this.connections.get(proxyId);
    if (conn) {
      await McpServer.findByIdAndUpdate(conn.serverId, { status: 'offline' });
      this.connections.delete(proxyId);
    }
  }

  private async handleDisconnect(proxyId: string): Promise<void> {
    await this.handleUnregister(proxyId);
  }
}
```

### servers/controller-api/src/routes/mcp-proxy.ts

```typescript
import { Router } from 'express';
import { McpProxyRegistry } from '../services/mcp-proxy-registry.js';

export function createMcpProxyRouter(registry: McpProxyRegistry): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const { key, hostname, command, serverName } = req.body;
    const result = await registry.register(key, hostname, command, serverName);
    res.json(result);
  });

  return router;
}
```

### 启动 & 验证

```bash
# controller-api 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 4: MCP Forwarder 转发服务 (新服务)

### 文件创建

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/mcp-forwarder/package.json` | 新增 | 项目配置 |
| `servers/mcp-forwarder/tsconfig.json` | 新增 | TypeScript 配置 |
| `servers/mcp-forwarder/Dockerfile` | 新增 | Docker 配置 |
| `servers/mcp-forwarder/src/index.ts` | 新增 | 入口文件 |
| `servers/mcp-forwarder/src/routes/mcp.ts` | 新增 | MCP 转发路由 |
| `servers/mcp-forwarder/src/middleware/auth.ts` | 新增 | JWT 验证中间件 |
| `servers/mcp-forwarder/src/services/endpoint.ts` | 新增 | 端点查询服务 |
| `servers/mcp-forwarder/src/services/forwarder.ts` | 新增 | 转发逻辑 |

### servers/mcp-forwarder/src/index.ts

```typescript
import express from 'express';
import { createMcpRouter } from './routes/mcp.js';

const app = express();
app.use(express.json());

const PORT = process.env.MCP_FORWARDER_PORT || 3002;

app.use('/mcp', createMcpRouter());

app.listen(PORT, () => {
  console.log(`MCP Forwarder listening on port ${PORT}`);
});
```

### servers/mcp-forwarder/src/middleware/auth.ts

```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.MCP_ENDPOINT_JWT_SECRET!;

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    (req as any).session = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
```

### servers/mcp-forwarder/src/routes/mcp.ts

```typescript
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { forwardToProxy } from '../services/forwarder.js';

export function createMcpRouter(): Router {
  const router = Router();
  router.use(authMiddleware);

  router.post('/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = (req as any).session;

    if (session.sessionId !== sessionId) {
      res.status(403).json({ error: 'Session mismatch' });
      return;
    }

    try {
      const result = await forwardToProxy(sessionId, req.body, session.serverNames);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
```

### servers/mcp-forwarder/src/services/forwarder.ts

```typescript
export async function forwardToProxy(
  sessionId: string,
  request: any,
  serverNames: string[],
): Promise<any> {
  // 通过 WebSocket 转发到 controller-api，再转到本地代理
  // 具体实现依赖于 controller-api 的 WebSocket 连接
  // 这里简化为 HTTP 调用 controller-api 的内部接口
  const response = await fetch(`${process.env.CONTROLLER_API_URL}/api/mcp-proxy/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, request, serverNames }),
  });
  return response.json();
}
```

### 启动 & 验证

```bash
# mcp-forwarder 目录下
npm install
npm run build
npm run dev    # 开发模式启动
```

---

## Phase 5: Session 端点管理 (controller-api)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/models/mcp-session-endpoint.ts` | 新增 | McpSessionEndpoint Model |
| `servers/controller-api/src/services/mcp-endpoint.ts` | 新增 | 端点管理 Service |
| `servers/controller-api/src/services/session.ts` | 修改 | 创建 Session 时创建端点 |

### servers/controller-api/src/models/mcp-session-endpoint.ts

```typescript
import { Schema, model, Document } from 'mongoose';

export interface IMcpSessionEndpoint extends Document {
  sessionId: string;
  userId: string;
  mcpServerIds: string[];
  tokenHash: string;
  status: 'active' | 'revoked';
  expiresAt: Date;
  createdAt: Date;
}

const mcpSessionEndpointSchema = new Schema<IMcpSessionEndpoint>(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    mcpServerIds: [{ type: String }],
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

mcpSessionEndpointSchema.index({ status: 1, expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpSessionEndpoint = model<IMcpSessionEndpoint>('McpSessionEndpoint', mcpSessionEndpointSchema);
```

### servers/controller-api/src/services/mcp-endpoint.ts

```typescript
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';

const JWT_SECRET = process.env.MCP_ENDPOINT_JWT_SECRET!;
const SALT_ROUNDS = 10;

export class McpEndpointService {
  async createEndpoint(
    sessionId: string,
    userId: string,
    mcpServerIds: string[],
    serverNames: string[],
  ): Promise<{ url: string; token: string }> {
    const token = jwt.sign(
      { sessionId, userId, serverNames },
      JWT_SECRET,
      { expiresIn: '24h' },
    );
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);

    await McpSessionEndpoint.create({
      sessionId,
      userId,
      mcpServerIds,
      tokenHash,
      status: 'active',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const forwarderUrl = process.env.MCP_FORWARDER_URL || 'http://localhost:3002';
    return {
      url: `${forwarderUrl}/mcp/${sessionId}`,
      token,
    };
  }

  async revokeEndpoint(sessionId: string): Promise<void> {
    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      { status: 'revoked' },
    );
  }
}
```

### 启动 & 验证

```bash
# controller-api 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 6: agent-gear mcp-proxy 子命令 (agent-controller)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/commands/mcp-proxy.ts` | 新增 | mcp-proxy 子命令实现 |
| `packages/agent-controller/src/index.ts` | 修改 | 新增 mcp-proxy 入口 |

### packages/agent-controller/src/commands/mcp-proxy.ts

```typescript
import { spawn, ChildProcess } from 'child_process';
import { io, Socket } from 'socket.io-client';

interface McpProxyOptions {
  server: string;
  key: string;
  command: string;
}

export async function startMcpRegistration(options: McpProxyOptions): Promise<void> {
  const { server, key, command } = options;

  // 1. 向服务器注册
  const response = await fetch(`${server}/api/mcp-proxy/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      hostname: process.env.HOSTNAME || 'unknown',
      command,
      serverName: command.split(' ').pop() || 'unknown',
    }),
  });

  const result = await response.json() as any;
  if (!result.success) {
    console.error('Registration failed:', result.error);
    process.exit(1);
  }

  console.log(`Registered as proxy ${result.proxyId}`);

  // 2. 启动本地命令
  const [cmd, ...args] = command.split(' ');
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  // 3. 建立 WebSocket 连接
  const socket = io(server, {
    auth: { proxyId: result.proxyId },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    console.log('WebSocket connected');
    socket.emit('proxy:register', { proxyId: result.proxyId });
  });

  // 4. 桥接请求
  socket.on('proxy:request', async (request) => {
    const response = await forwardToChild(child, request);
    socket.emit('proxy:response', { proxyId: result.proxyId, response });
  });

  // 5. 心跳
  setInterval(() => {
    socket.emit('proxy:heartbeat', { proxyId: result.proxyId });
  }, 30000);

  // 6. 清理
  process.on('SIGINT', () => {
    socket.emit('proxy:unregister', { proxyId: result.proxyId });
    child.kill();
    process.exit(0);
  });
}

function forwardToChild(child: ChildProcess, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

    child.stdout!.once('data', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });

    child.stdin!.write(JSON.stringify(request) + '\n');
  });
}
```

### packages/agent-controller/src/index.ts 变更

```typescript
if (command === 'mcp-proxy') {
  const proxyArgs = parseArgs({
    args: args.positionals.slice(1),
    options: {
      server: { type: 'string' },
      key: { type: 'string' },
      command: { type: 'string' },
    },
  });
  await startMcpRegistration({
    server: proxyArgs.values.server!,
    key: proxyArgs.values.key!,
    command: proxyArgs.values.command!,
  });
}
```

### 启动 & 验证

```bash
# agent-controller 目录下
npm run build
npm run test
```

---

## Phase 7: agent-gear mcp 子命令 (agent-controller)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/commands/mcp.ts` | 新增 | stdio MCP 代理实现 |
| `packages/agent-controller/src/index.ts` | 修改 | 新增 mcp 入口 |

### packages/agent-controller/src/commands/mcp.ts

```typescript
import * as readline from 'readline';

interface McpProxyOptions {
  endpoint: string;
  token: string;
}

export async function startMcpProxy(options: McpProxyOptions): Promise<void> {
  const { endpoint, token } = options;

  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      });
      const result = await response.json();
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err: any) {
      const error = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err.message },
      };
      process.stdout.write(JSON.stringify(error) + '\n');
    }
  });
}
```

### packages/agent-controller/src/index.ts 变更

```typescript
if (command === 'mcp') {
  const mcpArgs = parseArgs({
    args: args.positionals.slice(1),
    options: {
      endpoint: { type: 'string' },
      token: { type: 'string' },
    },
  });
  await startMcpProxy({
    endpoint: mcpArgs.values.endpoint!,
    token: mcpArgs.values.token!,
  });
}
```

### 启动 & 验证

```bash
# agent-controller 目录下
npm run build
npm run test
```

---

## Phase 8: 前端 MCP 管理 UI (agent-web)

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/pages/settings/mcp-proxy-keys/page.tsx` | 新增 | MCP Proxy Key 管理页 |
| `apps/agent-web/src/pages/settings/mcp-servers/page.tsx` | 新增 | MCP Server 列表页 |
| `apps/agent-web/src/graphql/mcp-server.ts` | 新增 | GraphQL 查询/变更 |
| `apps/agent-web/src/graphql/mcp-proxy-key.ts` | 新增 | GraphQL 查询/变更 |
| `apps/agent-web/src/components/session/CreateSessionDialog.tsx` | 修改 | 新增 MCP Server 选择 |

### 前端 GraphQL 查询

```typescript
// apps/agent-web/src/graphql/mcp-server.ts
import { gql } from '@apollo/client';

export const GET_MCP_SERVERS = gql`
  query GetMcpServers {
    mcpServers {
      id
      name
      transport
      command
      status
      lastHeartbeatAt
      createdAt
    }
  }
`;

// apps/agent-web/src/graphql/mcp-proxy-key.ts
export const GET_MCP_PROXY_KEYS = gql`
  query GetMcpProxyKeys {
    mcpProxyKeys {
      id
      name
      keyPrefix
      status
      lastUsedAt
      createdAt
    }
  }
`;

export const CREATE_MCP_PROXY_KEY = gql`
  mutation CreateMcpProxyKey($name: String!) {
    createMcpProxyKey(name: $name) {
      key {
        id
        name
        keyPrefix
        status
        createdAt
      }
      rawKey
    }
  }
`;

export const REVOKE_MCP_PROXY_KEY = gql`
  mutation RevokeMcpProxyKey($id: ID!) {
    revokeMcpProxyKey(id: $id)
  }
`;
```

### 启动 & 验证

```bash
# agent-web 目录下
npm run build
npm run test
```

---

## Phase 9: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/mcp-proxy-key.test.ts` | 新增 | Key 管理测试 |
| `servers/controller-api/src/services/mcp-proxy-registry.test.ts` | 新增 | 注册管理测试 |
| `servers/controller-api/src/services/mcp-endpoint.test.ts` | 新增 | 端点管理测试 |
| `packages/agent-controller/tests/commands/mcp-proxy.test.ts` | 新增 | mcp-proxy 命令测试 |
| `packages/agent-controller/tests/commands/mcp.test.ts` | 新增 | mcp 命令测试 |
| `servers/mcp-forwarder/src/routes/mcp.test.ts` | 新增 | 转发路由测试 |
| `tests/api/src/mcp/mcp-proxy-flow.test.ts` | 新增 | API 集成测试 |

### 测试要点

```typescript
// mcp-proxy-key.test.ts
describe('McpProxyKeyService', () => {
  it('should create key with rawKey and hash');
  it('should verify valid key');
  it('should reject invalid key');
  it('should revoke key');
  it('should list keys for user');
});

// mcp-proxy-registry.test.ts
describe('McpProxyRegistry', () => {
  it('should register proxy with valid key');
  it('should reject registration with invalid key');
  it('should handle heartbeat');
  it('should handle disconnect');
  it('should forward request to proxy');
});

// mcp-endpoint.test.ts
describe('McpEndpointService', () => {
  it('should create endpoint with JWT token');
  it('should revoke endpoint');
  it('should reject expired token');
});

// mcp-proxy.test.ts
describe('agent-gear mcp-proxy', () => {
  it('should register with server');
  it('should spawn child process');
  it('should forward stdio to WebSocket');
  it('should handle cleanup on exit');
});

// mcp.test.ts
describe('agent-gear mcp', () => {
  it('should read JSON-RPC from stdin');
  it('should forward to HTTP endpoint');
  it('should write response to stdout');
  it('should handle errors');
});
```

### 运行测试

```bash
# 各子项目目录下
npm run test
```

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `npm run dev` | `servers/mcp-forwarder` | 开发模式启动转发服务 |
| `aspire start` | 根目录 | 启动全部服务 |
| `agent-gear mcp-proxy --server http://localhost:4001 --key <key> --command "npx ..."` | 任意 | 注册本地 MCP 命令 |
| `agent-gear mcp --endpoint <url> --token <token>` | 任意 | stdio MCP 代理 |

---

## 验收 Checklist

- [ ] **Phase 1**: Contract + GraphQL schema + Mongoose model 编译通过
- [ ] **Phase 2**: MCP Proxy Key 生成/验证/撤销功能正常
- [ ] **Phase 3**: agent-gear mcp-proxy 注册成功，WebSocket 连接正常
- [ ] **Phase 3**: 心跳保持、断开重连、注销功能正常
- [ ] **Phase 4**: mcp-forwarder 转发服务启动正常
- [ ] **Phase 4**: JWT 验证中间件工作正常
- [ ] **Phase 5**: Session 创建时端点创建 + Token 签发正常
- [ ] **Phase 5**: Session 结束时 Token 撤销正常
- [ ] **Phase 6**: `agent-gear mcp-proxy` 命令注册本地 MCP 正常
- [ ] **Phase 6**: 子进程 stdio 桥接正常
- [ ] **Phase 7**: `agent-gear mcp` 命令 stdio 代理正常
- [ ] **Phase 7**: HTTP 转发 + 响应写回 stdout 正常
- [ ] **Phase 8**: MCP Proxy Key 管理页功能正常
- [ ] **Phase 8**: MCP Server 列表页展示正常
- [ ] **Phase 8**: Session 创建时 MCP Server 选择正常
- [ ] **Phase 9**: 所有单元测试通过
- [ ] **Phase 9**: API 集成测试通过
