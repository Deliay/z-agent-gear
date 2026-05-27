---
description: 端口转发功能 - 实现计划
type: Permanent
---

# 端口转发功能 - 实现计划

**关联 Proposal**: `proposals/20260527-feat-port-forwarding.md`
**创建日期**: 2026-05-27

## 实现顺序

```
Phase 1: 数据模型 + Contract
  └── Phase 2: agent-api 端口转发路由
       └── Phase 3: controller-api 内部路由
            └── Phase 4: agent-controller 端口转发实现
                 └── Phase 5: 前端界面
                      └── Phase 6: 测试覆盖
```

---

## Phase 1: 数据模型 + Contract

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/port-forward.ts` | 新增 | 端口转发Mongoose模型 |
| `servers/controller-api/src/models/port-forward.ts` | 新增 | 共享模型（可选，或复用agent-api的） |
| `contracts/port-forward.graphql` | 新增 | GraphQL schema（可选） |
| `servers/agent-api/src/graphql/schemas/port-forward.ts` | 新增 | GraphQL类型定义（可选） |

### servers/agent-api/src/models/port-forward.ts

```typescript
import mongoose from 'mongoose';

const portForwardSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  port: { type: Number, required: true, min: 1, max: 65535 },
  status: { type: String, enum: ['active', 'inactive', 'error'], default: 'active' },
}, { timestamps: true });

portForwardSchema.index({ sessionId: 1, port: 1 }, { unique: true });
portForwardSchema.index({ userId: 1 });
portForwardSchema.index({ sessionId: 1, status: 1 });

export const PortForward = mongoose.model('PortForward', portForwardSchema);
export type IPortForward = mongoose.InferSchemaType<typeof portForwardSchema>;
```

### 启动 & 验证

```bash
# 验证模型编译
cd servers/agent-api && npm run build

# 运行单元测试
cd servers/agent-api && npm test -- --testPathPattern=models
```

---

## Phase 2: agent-api 端口转发路由

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/port-forward.ts` | 新增 | 端口转发REST路由 |
| `servers/agent-api/src/services/port-forward.ts` | 新增 | 端口转发业务逻辑 |
| `servers/agent-api/src/services/port-forward.test.ts` | 新增 | 单元测试 |
| `servers/agent-api/src/index.ts` | 修改 | 注册新路由 |

### servers/agent-api/src/routes/port-forward.ts

```typescript
import { Router, type Request, type Response } from 'express';
import { authenticateExpressUser } from '../middleware/auth.js';
import { portForwardService } from '../services/port-forward.js';

const router = Router();

// 创建端口转发
router.post('/forward/:sessionId/:port', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { sessionId, port } = req.params;
  const portNum = parseInt(port, 10);

  try {
    const result = await portForwardService.createPortForward(
      sessionId,
      portNum,
      currentUser.id
    );
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('not found') || message.includes('not running')) {
      res.status(400).json({ error: message });
    } else if (message.includes('limit reached')) {
      res.status(400).json({ error: message });
    } else if (message.includes('already exists')) {
      res.status(409).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// 查询端口转发列表
router.get('/forward/:sessionId', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { sessionId } = req.params;

  try {
    const result = await portForwardService.getPortForwards(sessionId, currentUser.id);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// 删除端口转发
router.delete('/forward/:sessionId/:port', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { sessionId, port } = req.params;
  const portNum = parseInt(port, 10);

  try {
    await portForwardService.deletePortForward(sessionId, portNum, currentUser.id);
    res.json({ success: true, message: 'Port forward deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('not found')) {
      res.status(404).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

export const portForwardRouter = router;
```

### servers/agent-api/src/services/port-forward.ts

```typescript
import { PortForward, type IPortForward } from '../models/port-forward.js';
import { Session } from '../models/session.js';
import { config } from '../config/index.js';

const MAX_PORTS_PER_SESSION = config.portForwardMaxPerSession || 3;
const CONTROLLER_API_INTERNAL_URL = config.controllerApiInternalUrl;

export const portForwardService = {
  async createPortForward(sessionId: string, port: number, userId: string) {
    // 1. 验证session存在且属于当前用户
    const session = await Session.findOne({ _id: sessionId, userId });
    if (!session) {
      throw new Error('Session not found');
    }

    // 2. 验证session状态为运行中
    if (session.status !== 'idling' && session.status !== 'running') {
      throw new Error('Session is not running');
    }

    // 3. 检查端口数量限制
    const count = await PortForward.countDocuments({ sessionId, status: 'active' });
    if (count >= MAX_PORTS_PER_SESSION) {
      throw new Error(`Port limit reached: maximum ${MAX_PORTS_PER_SESSION} ports per session`);
    }

    // 4. 检查端口是否已存在
    const existing = await PortForward.findOne({ sessionId, port });
    if (existing) {
      throw new Error(`Port forward already exists for port ${port}`);
    }

    // 5. 创建端口转发记录
    const portForward = new PortForward({
      sessionId,
      userId,
      port,
      status: 'active',
    });
    await portForward.save();

    // 6. 调用controller-api内部接口
    try {
      const response = await fetch(`${CONTROLLER_API_INTERNAL_URL}/inner/api/forward/${sessionId}/${port}`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        // 如果调用失败，更新状态为error
        portForward.status = 'error';
        await portForward.save();
        throw new Error('Failed to start port forward on controller');
      }
    } catch (error) {
      // 网络错误，更新状态为error
      portForward.status = 'error';
      await portForward.save();
      throw error;
    }

    return {
      id: portForward._id.toString(),
      sessionId: portForward.sessionId.toString(),
      port: portForward.port,
      status: portForward.status,
      createdAt: portForward.createdAt,
    };
  },

  async getPortForwards(sessionId: string, userId: string) {
    const portForwards = await PortForward.find({ sessionId, userId });
    
    return {
      portForwards: portForwards.map(pf => ({
        id: pf._id.toString(),
        sessionId: pf.sessionId.toString(),
        port: pf.port,
        status: pf.status,
        createdAt: pf.createdAt,
      })),
      total: portForwards.length,
      limit: MAX_PORTS_PER_SESSION,
    };
  },

  async deletePortForward(sessionId: string, port: number, userId: string) {
    const portForward = await PortForward.findOne({ sessionId, port, userId });
    if (!portForward) {
      throw new Error('Port forward not found');
    }

    // 调用controller-api内部接口停止端口转发
    try {
      await fetch(`${CONTROLLER_API_INTERNAL_URL}/inner/api/forward/${sessionId}/${port}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to stop port forward on controller:', error);
      // 即使调用失败，也删除记录
    }

    await PortForward.deleteOne({ _id: portForward._id });

    return { success: true };
  },
};
```

### servers/agent-api/src/index.ts 修改

```typescript
import { portForwardRouter } from './routes/port-forward.js';

// 在现有路由后添加
app.use('/api', portForwardRouter);
```

### 启动 & 验证

```bash
# 验证编译
cd servers/agent-api && npm run build

# 运行单元测试
cd servers/agent-api && npm test -- --testPathPattern=port-forward

# 运行API测试
cd servers/agent-api && npm test -- --testPathPattern=routes
```

---

## Phase 3: controller-api 内部路由

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/routes/port-forward.ts` | 新增 | 内部端口转发路由 |
| `servers/controller-api/src/services/port-forward.ts` | 新增 | 端口转发服务 |
| `servers/controller-api/src/index.ts` | 修改 | 注册新路由 |

### servers/controller-api/src/routes/port-forward.ts

```typescript
import { Router, type Request, type Response } from 'express';
import { portForwardService } from '../services/port-forward.js';

const router = Router();

// 内部接口：创建端口转发
router.post('/forward/:sessionId/:port', async (req: Request, res: Response) => {
  const { sessionId, port } = req.params;
  const portNum = parseInt(port, 10);

  try {
    const result = await portForwardService.startPortForward(sessionId, portNum);
    res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// 内部接口：删除端口转发
router.delete('/forward/:sessionId/:port', async (req: Request, res: Response) => {
  const { sessionId, port } = req.params;
  const portNum = parseInt(port, 10);

  try {
    await portForwardService.stopPortForward(sessionId, portNum);
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export const portForwardRouter = router;
```

### servers/controller-api/src/services/port-forward.ts

```typescript
import { io } from '../index.js'; // 需要从index.ts导出io实例
import { Session } from '../models/session.js';

export const portForwardService = {
  async startPortForward(sessionId: string, port: number) {
    // 1. 验证session存在
    const session = await Session.findById(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // 2. 获取关联的controller socket
    const controllerId = session.controllerId.toString();
    const sockets = await io.in(`controller:${controllerId}`).fetchSockets();
    
    if (sockets.length === 0) {
      throw new Error('Controller not connected');
    }

    const socket = sockets[0];

    // 3. 通过Socket.IO发送端口转发请求
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Port forward request timeout'));
      }, 10000);

      socket.emit('port-forward:start', { sessionId, port }, (response: any) => {
        clearTimeout(timeout);
        
        if (response.success) {
          resolve({
            success: true,
            portForwardId: response.portForwardId,
          });
        } else {
          reject(new Error(response.error || 'Failed to start port forward'));
        }
      });
    });
  },

  async stopPortForward(sessionId: string, port: number) {
    const session = await Session.findById(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const controllerId = session.controllerId.toString();
    const sockets = await io.in(`controller:${controllerId}`).fetchSockets();
    
    if (sockets.length === 0) {
      // Controller不在线，直接返回成功
      return { success: true };
    }

    const socket = sockets[0];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Port forward stop timeout'));
      }, 10000);

      socket.emit('port-forward:stop', { sessionId, port }, (response: any) => {
        clearTimeout(timeout);
        
        if (response.success) {
          resolve({ success: true });
        } else {
          reject(new Error(response.error || 'Failed to stop port forward'));
        }
      });
    });
  },
};
```

### servers/controller-api/src/index.ts 修改

```typescript
import { portForwardRouter } from './routes/port-forward.js';

// 导出io实例供service使用
export { io };

// 添加路由
app.use('/inner/api', portForwardRouter);
```

### 启动 & 验证

```bash
# 验证编译
cd servers/controller-api && npm run build

# 运行单元测试
cd servers/controller-api && npm test -- --testPathPattern=port-forward
```

---

## Phase 4: agent-controller 端口转发实现

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/port-forward.ts` | 新增 | 端口转发客户端 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 添加端口转发事件处理 |
| `packages/agent-controller/src/port-forward.test.ts` | 新增 | 单元测试 |

### packages/agent-controller/src/port-forward.ts

```typescript
import net from 'net';
import { EventEmitter } from 'events';

interface PortForwardInstance {
  server: net.Server;
  port: number;
  sessionId: string;
  connections: Set<net.Socket>;
}

export class PortForwardManager extends EventEmitter {
  private portForwards: Map<string, PortForwardInstance> = new Map();

  async startPortForward(sessionId: string, port: number): Promise<{ success: boolean; portForwardId?: string; error?: string }> {
    const key = `${sessionId}:${port}`;
    
    if (this.portForwards.has(key)) {
      return { success: false, error: 'Port forward already exists' };
    }

    try {
      const server = net.createServer((socket) => {
        this.handleConnection(sessionId, port, socket);
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => {
          resolve();
        });

        server.on('error', (error) => {
          reject(error);
        });
      });

      const instance: PortForwardInstance = {
        server,
        port,
        sessionId,
        connections: new Set(),
      };

      this.portForwards.set(key, instance);

      this.emit('port-forward:started', { sessionId, port });

      return { 
        success: true, 
        portForwardId: key,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  async stopPortForward(sessionId: string, port: number): Promise<{ success: boolean; error?: string }> {
    const key = `${sessionId}:${port}`;
    const instance = this.portForwards.get(key);

    if (!instance) {
      return { success: false, error: 'Port forward not found' };
    }

    // 关闭所有活动连接
    for (const connection of instance.connections) {
      connection.destroy();
    }

    // 关闭服务器
    await new Promise<void>((resolve) => {
      instance.server.close(() => {
        resolve();
      });
    });

    this.portForwards.delete(key);

    this.emit('port-forward:stopped', { sessionId, port });

    return { success: true };
  }

  private handleConnection(sessionId: string, port: number, socket: net.Socket) {
    const key = `${sessionId}:${port}`;
    const instance = this.portForwards.get(key);

    if (!instance) {
      socket.destroy();
      return;
    }

    instance.connections.add(socket);

    socket.on('close', () => {
      instance.connections.delete(socket);
    });

    socket.on('error', (error) => {
      console.error(`Connection error for port ${port}:`, error);
      instance.connections.delete(socket);
    });

    // 这里可以添加实际的转发逻辑
    // 目前只是保持连接打开
    this.emit('port-forward:connection', { sessionId, port, socket });
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.portForwards.entries()).map(([key, instance]) => {
      return this.stopPortForward(instance.sessionId, instance.port);
    });

    await Promise.all(promises);
  }

  getPortForwards(): Array<{ sessionId: string; port: number; connections: number }> {
    return Array.from(this.portForwards.entries()).map(([key, instance]) => ({
      sessionId: instance.sessionId,
      port: instance.port,
      connections: instance.connections.size,
    }));
  }
}

export const portForwardManager = new PortForwardManager();
```

### packages/agent-controller/src/socketio-client.ts 修改

```typescript
import { portForwardManager } from './port-forward.js';

// 在socket事件监听中添加
socket.on('port-forward:start', async (data: { sessionId: string; port: number }, callback: Function) => {
  try {
    const result = await portForwardManager.startPortForward(data.sessionId, data.port);
    callback(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    callback({ success: false, error: message });
  }
});

socket.on('port-forward:stop', async (data: { sessionId: string; port: number }, callback: Function) => {
  try {
    const result = await portForwardManager.stopPortForward(data.sessionId, data.port);
    callback(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    callback({ success: false, error: message });
  }
});

// 在断开连接时清理所有端口转发
socket.on('disconnect', async () => {
  await portForwardManager.stopAll();
});
```

### 启动 & 验证

```bash
# 验证编译
cd packages/agent-controller && npm run build

# 运行单元测试
cd packages/agent-controller && npm test -- --testPathPattern=port-forward
```

---

## Phase 5: 前端界面

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/PortForwardPanel.tsx` | 新增 | 端口转发面板组件 |
| `apps/agent-web/src/components/PortForwardDialog.tsx` | 新增 | 端口转发对话框 |
| `apps/agent-web/src/services/port-forward.ts` | 新增 | 端口转发API服务 |
| `apps/agent-web/src/pages/SessionDetail.tsx` | 修改 | 集成端口转发面板 |

### 启动 & 验证

```bash
# 验证编译
cd apps/agent-web && npm run build

# 运行单元测试
cd apps/agent-web && npm test -- --testPathPattern=port-forward
```

---

## Phase 6: 测试覆盖

### 测试类型

| 类型 | 文件 | 覆盖范围 |
|------|------|---------|
| 单元测试 | `servers/agent-api/src/services/port-forward.test.ts` | 业务逻辑 |
| 单元测试 | `servers/controller-api/src/services/port-forward.test.ts` | 内部服务 |
| 单元测试 | `packages/agent-controller/src/port-forward.test.ts` | 端口转发管理 |
| API测试 | `tests/api/port-forward.test.ts` | REST API端点 |
| E2E测试 | `tests/e2e/port-forward.test.ts` | 完整流程 |

### 测试命令

```bash
# 运行所有测试
npm run test

# 运行特定测试
npm run test -- --testPathPattern=port-forward

# 运行E2E测试
npm run test:e2e
```

---

## 验收 Checklist

### Phase 1: 数据模型
- [ ] Mongoose模型编译通过
- [ ] 索引创建正确
- [ ] 类型定义完整

### Phase 2: agent-api路由
- [ ] 创建端口转发API工作正常
- [ ] 查询端口转发API工作正常
- [ ] 删除端口转发API工作正常
- [ ] 身份验证正常工作
- [ ] Session状态检查正常
- [ ] 端口数量限制正常
- [ ] 单元测试通过

### Phase 3: controller-api内部路由
- [ ] 内部创建接口工作正常
- [ ] 内部删除接口工作正常
- [ ] Socket.IO事件发送正常
- [ ] 单元测试通过

### Phase 4: agent-controller实现
- [ ] 端口监听正常
- [ ] 连接处理正常
- [ ] 资源清理正常
- [ ] 单元测试通过

### Phase 5: 前端界面
- [ ] 端口转发面板显示正常
- [ ] 创建端口转发对话框工作正常
- [ ] 删除端口转发工作正常
- [ ] 状态显示正确

### Phase 6: 测试覆盖
- [ ] 单元测试覆盖率 >= 80%
- [ ] API测试通过
- [ ] E2E测试通过
- [ ] 集成测试通过

---

## 常见问题

### Q: 端口被占用怎么办？
A: agent-controller在监听端口时会捕获EADDRINUSE错误，返回失败响应。

### Q: 网络中断怎么办？
A: agent-api调用controller-api失败时会更新端口转发状态为error，并返回错误响应。

### Q: 如何限制访问来源？
A: 内部接口可以通过网络配置限制访问来源，或者添加简单的密钥验证。

### Q: 支持UDP吗？
A: 当前实现只支持TCP，UDP支持需要额外实现。