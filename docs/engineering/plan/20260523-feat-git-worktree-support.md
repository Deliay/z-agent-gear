---
description: Git Worktree 集成支持 - 实现计划
type: Permanent
---

# Git Worktree 集成支持 - 实现计划

**关联 Proposal**: `proposals/20260523-feat-git-worktree-support.md`
**创建日期**: 2026-05-23

## 实现顺序

```
Phase 0: Contract 确认（已有契约，待验证）
  └── Phase 1: agent-controller WorktreeHandler + FsHandler
       └── Phase 2: controller-api WorktreeService + FsMkdirService + 命令路由
            └── Phase 3: agent-api 数据模型 + 服务逻辑
                 └── Phase 4: agent-api GraphQL Schema/Resolver
                      └── Phase 5: 前端 WorkspaceSection Worktree 目录配置
                      └── Phase 6: 前端 DirectoryPicker 新建文件夹
                      └── Phase 7: 前端 NewSessionDialog Worktree 设置
                      └── Phase 8: 前端 Sidebar + SessionHeader Worktree 标识
                      └── Phase 9: API 测试 + 验收
```

依赖关系：Phase 1-4 串行依赖后端链路。Phase 5-8 前端任务可并行，但依赖于 Phase 3-4 完成后端 GraphQL 接口就绪。

---

## Phase 0: Contract 确认

契约已在 `contracts/` 中定义，本阶段确认覆盖完整性：

| 文件 | 已有内容 | 状态 |
|------|---------|------|
| `contracts/agent-controller.graphql` | `Controller.worktreeDir`, `setControllerWorktreeDir` | ✅ 已有 |
| `contracts/agent-session.graphql` | `Session.worktreePath/Branch`, `CreateSessionInput.enableWorktree/worktreeBranchSuffix` | ✅ 已有 |
| `contracts/agent-session-websocket.md` | `fs:mkdir/result`, `git:worktree:add/remove/result`, `git:status/result`, `git:commit/result` | ✅ 已有 |
| `contracts/controller-workspace.graphql` | 无需修改 | ✅ |

---

## Phase 1: agent-controller WorktreeHandler + FsHandler

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/worktree-handler.ts` | **新建** | Git worktree add/remove + status + commit 命令封装 |
| `packages/agent-controller/src/fs-handler.ts` | **新建** | Fs mkdir 命令封装 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 新增 `fs:mkdir`, `git:worktree:add`, `git:worktree:remove`, `git:status`, `git:commit` 事件监听 |

### `worktree-handler.ts` 设计

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, dirname } from 'fs';

const execAsync = promisify(exec);

export interface WorktreeAddResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

export interface WorktreeRemoveResult {
  success: boolean;
  error?: string;
}

export interface GitStatusResult {
  isClean: boolean;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  error?: string;
}

export class WorktreeHandler {
  async add(repoPath: string, worktreePath: string, branch: string): Promise<WorktreeAddResult> {
    try {
      mkdirSync(dirname(worktreePath), { recursive: true });
      const { stderr } = await execAsync(
        `git worktree add -b "${branch}" "${worktreePath}" "${repoPath}"`
      );
      if (stderr && !stderr.includes('already exists')) {
        return { success: false, error: stderr };
      }
      return { success: true, worktreePath, branch };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async remove(worktreePath: string): Promise<WorktreeRemoveResult> {
    try {
      const { stderr } = await execAsync(`git worktree remove "${worktreePath}"`);
      if (stderr) return { success: false, error: stderr };
      try { rmSync(worktreePath, { recursive: true }); } catch { /* ignore */ }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async status(path: string): Promise<GitStatusResult> {
    try {
      const { stdout } = await execAsync(`git -C "${path}" status --porcelain`);
      return { isClean: stdout.trim().length === 0 };
    } catch (err) {
      return { isClean: false, error: (err as Error).message };
    }
  }

  async commit(path: string, message: string): Promise<GitCommitResult> {
    try {
      await execAsync(`git -C "${path}" add -A`);
      const { stdout, stderr } = await execAsync(`git -C "${path}" commit -m "${message}"`);
      if (stderr && !stdout) return { success: false, error: stderr };
      const hash = stdout.match(/\[[\w\/]+ ([a-f0-9]+)\]/)?.[1];
      return { success: true, commitHash: hash };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const worktreeHandler = new WorktreeHandler();
```

### `fs-handler.ts` 设计

```typescript
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface FsMkdirResult {
  success: boolean;
  name?: string;
  path?: string;
  error?: string;
}

export class FsHandler {
  async mkdir(parentPath: string, folderName: string): Promise<FsMkdirResult> {
    try {
      const fullPath = join(parentPath, folderName);
      mkdirSync(fullPath, { recursive: true });
      return { success: true, name: folderName, path: fullPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const fsHandler = new FsHandler();
```

### `socketio-client.ts` 新增事件监听

在文件末尾附近（`git:init` 事件监听之后）新增：

```typescript
import { worktreeHandler } from './worktree-handler.js';
import { fsHandler } from './fs-handler.js';

// --- Worktree / Git 扩展事件 ---
socket.on('fs:mkdir', async (data: { requestId: string; parentPath: string; folderName: string }) => {
  const result = await fsHandler.mkdir(data.parentPath, data.folderName);
  socket.emit('fs:mkdir:result', { requestId: data.requestId, ...result });
});

socket.on('git:worktree:add', async (data: { requestId: string; repoPath: string; worktreePath: string; branch: string }) => {
  const result = await worktreeHandler.add(data.repoPath, data.worktreePath, data.branch);
  socket.emit('git:worktree:add:result', { requestId: data.requestId, ...result });
});

socket.on('git:worktree:remove', async (data: { requestId: string; repoPath: string; worktreePath: string }) => {
  const result = await worktreeHandler.remove(data.worktreePath);
  socket.emit('git:worktree:remove:result', { requestId: data.requestId, ...result });
});

socket.on('git:status', async (data: { requestId: string; path: string }) => {
  const result = await worktreeHandler.status(data.path);
  socket.emit('git:status:result', { requestId: data.requestId, ...result });
});

socket.on('git:commit', async (data: { requestId: string; path: string; message: string }) => {
  const result = await worktreeHandler.commit(data.path, data.message);
  socket.emit('git:commit:result', { requestId: data.requestId, ...result });
});
```

### 新增接口类型定义

```typescript
interface FsMkdirPayload {
  requestId: string;
  parentPath: string;
  folderName: string;
}

interface WorktreeAddPayload {
  requestId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
}

interface WorktreeRemovePayload {
  requestId: string;
  repoPath: string;
  worktreePath: string;
}

interface GitStatusPayload {
  requestId: string;
  path: string;
}

interface GitCommitPayload {
  requestId: string;
  path: string;
  message: string;
}
```

### 启动 & 验证

```bash
cd packages/agent-controller
npm run build
npm run test
```

---

## Phase 2: controller-api WorktreeService + FsMkdirService + 命令路由

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/worktree-service.ts` | **新建** | 协调 worktree/status/commit 请求-响应 |
| `servers/controller-api/src/services/fs-mkdir-service.ts` | **新建** | 协调 mkdir 请求-响应 |
| `servers/controller-api/src/services/session-command.ts` | 修改 | 新增 `fs:mkdir`, `git:worktree:add/remove`, `git:status`, `git:commit` 命令路由 |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 注册新 `:result` 事件处理 |

### `worktree-service.ts` 设计

```typescript
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class WorktreeService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  private async emitToController(controllerId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found: ${socketId}`); return; }
    socket.emit(event, payload);
  }

  async handleAdd(requestId: string, controllerId: string, repoPath: string, worktreePath: string, branch: string): Promise<void> {
    await this.emitToController(controllerId, 'git:worktree:add', { requestId, repoPath, worktreePath, branch });
  }

  async handleRemove(requestId: string, controllerId: string, repoPath: string, worktreePath: string): Promise<void> {
    await this.emitToController(controllerId, 'git:worktree:remove', { requestId, repoPath, worktreePath });
  }

  async handleStatus(requestId: string, controllerId: string, path: string): Promise<void> {
    await this.emitToController(controllerId, 'git:status', { requestId, path });
  }

  async handleCommit(requestId: string, controllerId: string, path: string, message: string): Promise<void> {
    await this.emitToController(controllerId, 'git:commit', { requestId, path, message });
  }

  async handleAddResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:worktree:add:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleRemoveResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:worktree:remove:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleStatusResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:status:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleCommitResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:commit:${requestId}`, JSON.stringify(result), 'EX', 60);
  }
}

export const worktreeService = new WorktreeService();
```

### `fs-mkdir-service.ts` 设计（可选复用 `folder-browser.ts` 模式）

```typescript
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class FsMkdirService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleMkdir(requestId: string, controllerId: string, parentPath: string, folderName: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found: ${socketId}`); return; }
    socket.emit('fs:mkdir', { requestId, parentPath, folderName });
  }

  async handleMkdirResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:mkdir:${requestId}`, JSON.stringify(result), 'EX', 30);
  }
}

export const fsMkdirService = new FsMkdirService();
```

### `session-command.ts` 新增命令路由

导入新 service：

```typescript
import { worktreeService } from './worktree-service.js';
import { fsMkdirService } from './fs-mkdir-service.js';
```

在 `subscribe()` 命令路由分支中新增：

```typescript
} else if (command.type === 'fs:mkdir' && command.requestId && command.controllerId && command.parentPath && command.folderName) {
  await fsMkdirService.handleMkdir(command.requestId, command.controllerId, command.parentPath as string, command.folderName as string);
} else if (command.type === 'git:worktree:add' && command.requestId && command.controllerId && command.repoPath && command.worktreePath && command.branch) {
  await worktreeService.handleAdd(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string, command.branch as string);
} else if (command.type === 'git:worktree:remove' && command.requestId && command.controllerId && command.repoPath && command.worktreePath) {
  await worktreeService.handleRemove(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string);
} else if (command.type === 'git:status' && command.requestId && command.controllerId && command.path) {
  await worktreeService.handleStatus(command.requestId, command.controllerId, command.path as string);
} else if (command.type === 'git:commit' && command.requestId && command.controllerId && command.path && command.message) {
  await worktreeService.handleCommit(command.requestId, command.controllerId, command.path as string, command.message as string);
}
```

更新 command 类型定义，新增字段：

```typescript
parentPath?: string;
folderName?: string;
repoPath?: string;
worktreePath?: string;
branch?: string;
message?: string;
```

### `socketio.ts` 注册新结果事件

导入新 service：

```typescript
import { worktreeService } from './services/worktree-service.js';
import { fsMkdirService } from './services/fs-mkdir-service.js';
```

在 socket 事件注册区（与现有 `git:init:result` 相邻）新增：

```typescript
socket.on('fs:mkdir:result', async (payload: { requestId: string } & Record<string, unknown>) => {
  if (!authenticated) return;
  await fsMkdirService.handleMkdirResult(payload.requestId, payload);
});

socket.on('git:worktree:add:result', async (payload: { requestId: string } & Record<string, unknown>) => {
  if (!authenticated) return;
  await worktreeService.handleAddResult(payload.requestId, payload);
});

socket.on('git:worktree:remove:result', async (payload: { requestId: string } & Record<string, unknown>) => {
  if (!authenticated) return;
  await worktreeService.handleRemoveResult(payload.requestId, payload);
});

socket.on('git:status:result', async (payload: { requestId: string } & Record<string, unknown>) => {
  if (!authenticated) return;
  await worktreeService.handleStatusResult(payload.requestId, payload);
});

socket.on('git:commit:result', async (payload: { requestId: string } & Record<string, unknown>) => {
  if (!authenticated) return;
  await worktreeService.handleCommitResult(payload.requestId, payload);
});
```

### 启动 & 验证

```bash
cd servers/controller-api
npm run build
npm run test
```

---

## Phase 3: agent-api 数据模型 + 服务逻辑

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/session.ts` | 修改 | 新增 `worktreePath`, `worktreeBranch` 字段 |
| `servers/agent-api/src/models/controller.ts` | 修改 | 新增 `worktreeDir` 字段 |
| `servers/agent-api/src/services/session.ts` | 修改 | `create()` 新增 Worktree 路径计算和命令下发；`delete()` 新增 Worktree 清理流程 |
| `servers/agent-api/src/services/controller.ts` | 修改 | 新增 `setWorktreeDir()` 方法；`mapController` 增加 `worktreeDir` 字段 |

### Model 变更

**`models/session.ts`** — 在 `cwd` 字段后新增：

```typescript
worktreePath: { type: String },
worktreeBranch: { type: String },
```

**`models/controller.ts`** — 在 `lastIp` 后新增：

```typescript
worktreeDir: { type: String },
```

### Service 变更 — `services/session.ts`

`create()` 方法增强 — 在查找 workspace 之后，创建 Session 之前插入 Worktree 逻辑：

```typescript
import { getRedisClient } from '../middleware/redis.js';

// 在 create() 方法中，找到 workspace 后：
let cwd = workspace.path;
let worktreePath: string | undefined;
let worktreeBranch: string | undefined;

if ((input as any).enableWorktree && (input as any).worktreeBranchSuffix) {
  const worktreeDir = (controller as any).worktreeDir || '~/.zag/worktrees';
  const resolvedWorktreeDir = worktreeDir.replace(/^~/, process.env.HOME || '/root');
  const branch = `${workspace.name}/${(input as any).worktreeBranchSuffix}`;
  const wtPath = path.join(resolvedWorktreeDir, workspace.name, (input as any).worktreeBranchSuffix);

  // 通过 Redis 下发 git:worktree:add
  const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await redis.publish('session:command', JSON.stringify({
    type: 'git:worktree:add',
    requestId,
    controllerId: input.controllerId,
    repoPath: workspace.path,
    worktreePath: wtPath,
    branch,
  }));

  // 轮询结果
  for (let i = 0; i < 30; i++) {
    const result = await redis.get(`git:worktree:add:${requestId}`);
    if (result) {
      const parsed = JSON.parse(result);
      if (!parsed.success) {
        throw new Error(`WORKTREE_ADD_FAILED: ${parsed.error}`);
      }
      await redis.del(`git:worktree:add:${requestId}`);
      cwd = wtPath;
      worktreePath = wtPath;
      worktreeBranch = branch;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!worktreePath) {
    throw new Error('WORKTREE_ADD_FAILED: Timeout waiting for git worktree add');
  }
}

// 创建 Session 文档时带上 worktreePath, worktreeBranch
const session = await Session.create({
  userId,
  controllerId: input.controllerId,
  controllerName: controller.name,
  acpServerType: input.acpServerType as 'opencode',
  status: 'creating',
  cwd,
  worktreePath,
  worktreeBranch,
});

// acp:start 的 cwd 使用 worktreePath（如有）
await redis.publish('session:command', JSON.stringify({
  type: 'acp:start',
  sessionId: session._id.toString(),
  controllerId: input.controllerId,
  serverType: input.acpServerType,
  cwd,
}));
```

`delete()` 方法增强 — 在停止 ACP 之前插入 Worktree 清理：

```typescript
async delete(id: string, userId: string): Promise<boolean> {
  const session = await Session.findOne({ _id: id, userId }).lean();
  if (!session) return false;

  const redis = getRedisClient();

  // 如果是 Worktree Session，执行清理
  if ((session as any).worktreePath && (session as any).worktreeBranch) {
    const workspace = await ControllerWorkspace.findOne({
      controllerId: session.controllerId,
      userId,
    }).lean();
    const repoPath = workspace?.path || session.cwd || '';

    // 1. git:status — 检测是否为 clean
    const statusReqId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'git:status',
      requestId: statusReqId,
      controllerId: session.controllerId.toString(),
      path: (session as any).worktreePath,
    }));

    let isClean = false;
    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:status:${statusReqId}`);
      if (result) {
        const parsed = JSON.parse(result);
        isClean = parsed.isClean === true;
        await redis.del(`git:status:${statusReqId}`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // 2. 非 clean → git:commit
    if (!isClean) {
      const commitReqId = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:commit',
        requestId: commitReqId,
        controllerId: session.controllerId.toString(),
        path: (session as any).worktreePath,
        message: 'chore: workspace cleanup code stash',
      }));
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:commit:${commitReqId}`);
        if (result) {
          await redis.del(`git:commit:${commitReqId}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 3. git:worktree:remove
    const rmReqId = `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'git:worktree:remove',
      requestId: rmReqId,
      controllerId: session.controllerId.toString(),
      repoPath,
      worktreePath: (session as any).worktreePath,
    }));

    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:worktree:remove:${rmReqId}`);
      if (result) {
        const parsed = JSON.parse(result);
        await redis.del(`git:worktree:remove:${rmReqId}`);
        if (!parsed.success) {
          // 清理失败，保留 Session 记录，抛出错误
          throw new Error(`WORKTREE_REMOVE_FAILED: ${parsed.error}`);
        }
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 原有逻辑：停止 ACP + 删除文档 + 删除消息
  await redis.publish('session:command', JSON.stringify({
    type: 'acp:stop',
    sessionId: id,
    reason: 'user_delete',
  }));

  await Session.findOneAndDelete({ _id: id, userId });
  await AcpMessage.deleteMany({ sessionId: id });
  await redis.del(`session:${id}:status`);
  return true;
}
```

`mapSession()` 方法增强：

```typescript
private mapSession(session: Record<string, unknown>): Record<string, unknown> {
  return {
    // ... 原有字段
    worktreePath: (session as any).worktreePath || null,
    worktreeBranch: (session as any).worktreeBranch || null,
  };
}
```

**导入 `path` 模块：**

```typescript
import path from 'path';
```

### Service 变更 — `services/controller.ts`

新增方法 + mapController 增强：

```typescript
async setWorktreeDir(id: string, userId: string, worktreeDir: string): Promise<Record<string, unknown> | null> {
  const controller = await Controller.findOneAndUpdate(
    { _id: id, userId },
    { worktreeDir },
    { new: true },
  ).lean();
  if (!controller) return null;
  return this.mapController(controller);
}
```

`mapController()` 增强：

```typescript
private mapController(controller: Record<string, unknown>): Record<string, unknown> {
  return {
    // ... 原有字段
    worktreeDir: (controller as any).worktreeDir || null,
  };
}
```

### 启动 & 验证

```bash
cd servers/agent-api
npm run build
npm run test
```

---

## Phase 4: agent-api GraphQL Schema/Resolver

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/controller.ts` | 修改 | `Controller` 类型新增 `worktreeDir`，新增 `setControllerWorktreeDir` mutation |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | `Session` 类型新增 `worktreePath`, `worktreeBranch`；`CreateSessionInput` 新增 `enableWorktree`, `worktreeBranchSuffix` |
| `servers/agent-api/src/graphql/resolvers/controller.ts` | 修改 | 新增 `setControllerWorktreeDir` resolver |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | `createSession` 适配新 input 字段（typescript 层面已透传，无需改动 resolver 逻辑，仅需确保 input 类型兼容） |

### Schema 变更 — `schemas/controller.ts`

`Controller` 类型新增字段：

```graphql
type Controller {
  # ... 原有字段
  worktreeDir: String
}
```

Mutation 新增：

```graphql
extend type Mutation {
  # ... 原有 mutation
  setControllerWorktreeDir(controllerId: ID!, worktreeDir: String!): Controller!
}
```

### Schema 变更 — `schemas/session.ts`

`Session` 类型新增字段：

```graphql
type Session {
  # ... 原有字段
  worktreePath: String
  worktreeBranch: String
}
```

`CreateSessionInput` 新增字段：

```graphql
input CreateSessionInput {
  controllerId: ID!
  acpServerType: AcpServerType! = opencode
  workspaceId: ID!
  enableWorktree: Boolean = false
  worktreeBranchSuffix: String
}
```

### Resolver 变更 — `resolvers/controller.ts`

导入 `controllerService`：

```typescript
import { controllerService } from '../../services/controller.js';
```

在 Mutation 对象中新增：

```typescript
setControllerWorktreeDir: async (
  _parent: unknown,
  args: { controllerId: string; worktreeDir: string },
  context: AuthContext,
) => {
  if (!context.currentUser) {
    throw new GraphQLError('Not authenticated');
  }
  const result = await controllerService.setWorktreeDir(
    args.controllerId,
    context.currentUser.id,
    args.worktreeDir,
  );
  if (!result) {
    throw new GraphQLError('Controller not found');
  }
  return result;
},
```

### 启动 & 验证

```bash
cd servers/agent-api
npm run build
npm run test
```

---

## Phase 5: 前端 WorkspaceSection Worktree 目录配置

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | Section 顶部新增 Worktree 目录配置行 |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `SET_CONTROLLER_WORKTREE_DIR` mutation |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 新增 `SetControllerWorktreeDirMutation` 类型 |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增 `GET_CONTROLLER` query（可按需） |

### WorkspaceSection 修改

在组件顶部添加 `worktreeDir` 状态和 `setControllerWorktreeDir` mutation：

```typescript
import { SET_CONTROLLER_WORKTREE_DIR } from '../../graphql/mutations';
import DirectoryPicker from '@/components/ui/DirectoryPicker';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

// 在组件内部：
const [showWorktreeDirPicker, setShowWorktreeDirPicker] = useState(false);
const [worktreeDir, setWorktreeDir] = useState<string | null>(null);
const [setControllerWorktreeDir] = useMutation(SET_CONTROLLER_WORKTREE_DIR);

// 加载 controller 信息获取 worktreeDir
const { data: controllerData } = useQuery<{ controller: { worktreeDir?: string | null } }>(
  gql`query GetController($id: ID!) {
    controller(id: $id) { worktreeDir }
  }`,
  { variables: { id: controllerId }, skip: !controllerId },
);

useEffect(() => {
  if (controllerData?.controller) {
    setWorktreeDir(controllerData.controller.worktreeDir || null);
  }
}, [controllerData]);

const handleWorktreeDirChange = async (path: string) => {
  await setControllerWorktreeDir({
    variables: { controllerId, worktreeDir: path },
  });
  setWorktreeDir(path);
  setShowWorktreeDirPicker(false);
};
```

在 JSX 顶部（`<h2>工作区</h2>` 之前）插入 Worktree 目录配置行：

```tsx
<div className="mb-4 rounded-lg border p-3">
  <div className="flex items-center justify-between">
    <div>
      <span className="text-sm font-medium">Git Worktree 工作目录</span>
      <p className="text-xs text-muted-foreground mt-0.5">
        {worktreeDir || '~/.zag/worktrees（默认）'}
      </p>
    </div>
    <Button
      size="sm"
      variant="outline"
      onClick={() => setShowWorktreeDirPicker(true)}
    >
      修改
    </Button>
  </div>
</div>

{showWorktreeDirPicker && (
  <Dialog open={showWorktreeDirPicker} onOpenChange={setShowWorktreeDirPicker}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>选择 Worktree 工作目录</DialogTitle>
        <DialogDescription>
          所有 Worktree 将创建在此目录下
        </DialogDescription>
      </DialogHeader>
      <DirectoryPicker
        controllerId={controllerId}
        onSelect={handleWorktreeDirChange}
        onClose={() => setShowWorktreeDirPicker(false)}
      />
    </DialogContent>
  </Dialog>
)}
```

### mutations.ts 新增

```typescript
export const SET_CONTROLLER_WORKTREE_DIR = gql`
  mutation SetControllerWorktreeDir($controllerId: ID!, $worktreeDir: String!) {
    setControllerWorktreeDir(controllerId: $controllerId, worktreeDir: $worktreeDir) {
      id
      worktreeDir
    }
  }
`
```

### types.ts 新增

```typescript
export interface SetControllerWorktreeDirMutation {
  setControllerWorktreeDir: ControllerData
}
```

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
```

---

## Phase 6: 前端 DirectoryPicker 新建文件夹

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/ui/DirectoryPicker.tsx` | 修改 | 新增「新建文件夹」按钮 + Dialog |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `CREATE_FOLDER` mutation |

### DirectoryPicker 修改

```typescript
import { CREATE_FOLDER } from '../../graphql/mutations';
import { useMutation } from '@apollo/client/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

// 在组件内部：
const [showNewFolder, setShowNewFolder] = useState(false);
const [newFolderName, setNewFolderName] = useState('');
const [createFolder] = useMutation(CREATE_FOLDER);

const handleCreateFolder = async () => {
  if (!newFolderName.trim() || !currentPath) return;
  try {
    const { data } = await createFolder({
      variables: {
        controllerId,
        parentPath: currentPath,
        folderName: newFolderName.trim(),
      },
    });
    if (data?.createFolder?.path) {
      // 进入新建文件夹
      handleNavigate(data.createFolder.path);
    }
  } catch (err) {
    console.error('Failed to create folder:', err);
  }
  setShowNewFolder(false);
  setNewFolderName('');
};
```

在目录列表上方或下方新增「新建文件夹」按钮：

```tsx
<div className="flex items-center gap-2 mb-2">
  {/* ... 返回按钮等原有内容 */}
  <Button
    variant="outline"
    size="sm"
    onClick={() => setShowNewFolder(true)}
  >
    + 新建文件夹
  </Button>
</div>

{showNewFolder && (
  <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>新建文件夹</DialogTitle>
      </DialogHeader>
      <Input
        value={newFolderName}
        onChange={(e) => setNewFolderName(e.target.value)}
        placeholder="文件夹名称"
        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
      />
      <DialogFooter>
        <Button variant="outline" onClick={() => setShowNewFolder(false)}>取消</Button>
        <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>创建</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)}
```

### mutations.ts 新增

```typescript
export const CREATE_FOLDER = gql`
  mutation CreateFolder($controllerId: ID!, $parentPath: String!, $folderName: String!) {
    createFolder(controllerId: $controllerId, parentPath: $parentPath, folderName: $folderName) {
      name
      path
    }
  }
`
```

### 说明

`createFolder` resolver 依赖 agent-api 通过 `fs:mkdir` Redis 命令下发给 controller-api → agent-controller。需要同时实现：

- agent-api GraphQL schema: `extend type Mutation { createFolder(...): FolderEntry! }`
- agent-api resolver: 调用 service 方法（类似 `detectGitRepo` 的 request-response 模式）
- agent-api service 新增 `createFolder` 方法（通过 Redis Pub/Sub 下发 `fs:mkdir` 命令并轮询结果）

---

## Phase 7: 前端 NewSessionDialog Worktree 设置

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/NewSessionDialog.tsx` | 修改 | 选择 workspace 后检测 Git 仓库，展示 Worktree 设置 Section |

### NewSessionDialog 修改

新增状态和查询：

```typescript
import { useLazyQuery } from '@apollo/client/react';
import { DETECT_GIT_REPO } from '../../graphql/queries';
import type { GitRepoInfoData } from '../../graphql/types';

// 在组件内部新增状态：
const [isGitRepo, setIsGitRepo] = useState(false);
const [enableWorktree, setEnableWorktree] = useState(false);
const [branchSuffix, setBranchSuffix] = useState('');
const [detectGitRepo] = useLazyQuery(DETECT_GIT_REPO, {
  fetchPolicy: 'network-only',
});
```

在选择 workspace 后（`useEffect` 中）触发 Git 检测：

```typescript
useEffect(() => {
  if (selectedWorkspace && selectedController) {
    setIsGitRepo(false);
    setEnableWorktree(false);
    detectGitRepo({
      variables: { controllerId: selectedController, workspaceId: selectedWorkspace },
    }).then((res) => {
      if (res.data?.detectGitRepo?.isGitRepo) {
        setIsGitRepo(true);
        const ws = workspaces.find((w) => w.id === selectedWorkspace);
        const defaultSuffix = `feat-${Math.random().toString(36).slice(2, 8)}`;
        setBranchSuffix(defaultSuffix);
      }
    });
  }
}, [selectedWorkspace, selectedController]);
```

修改 `onCreate` 调用，传递 Worktree 参数：

```typescript
// handleSubmit 中：
onCreate(selectedController, selectedAcpServer, selectedWorkspace, enableWorktree, branchSuffix);
```

在 Working Directory 选择区域之后新增 Worktree Section：

```tsx
{isGitRepo && (
  <div className="mb-6 rounded-md border p-3">
    <div className="mb-2 block text-sm font-medium text-card-foreground">
      Worktree 设置
    </div>
    <label className="flex cursor-pointer items-center gap-2 mb-3">
      <input
        type="checkbox"
        checked={enableWorktree}
        onChange={(e) => setEnableWorktree(e.target.checked)}
        className="h-4 w-4"
      />
      <span className="text-sm">启用 Git Worktree 隔离工作目录</span>
    </label>
    {enableWorktree && (
      <div>
        <label className="block text-xs text-muted-foreground mb-1">分支名称</label>
        <div className="flex items-center gap-0">
          <span className="rounded-l-md border border-r-0 bg-muted px-2 py-1.5 text-sm text-muted-foreground">
            {workspaces.find((w) => w.id === selectedWorkspace)?.name || ''}/
          </span>
          <input
            type="text"
            value={branchSuffix}
            onChange={(e) => setBranchSuffix(e.target.value)}
            className="w-full rounded-r-md border px-2 py-1.5 text-sm"
            placeholder="分支后缀"
          />
        </div>
      </div>
    )}
  </div>
)}
```

更新 Sidebar 中的 `handleCreateSession` 调用，传入新参数。

### Sidebar 修改

```typescript
const handleCreateSession = async (
  controllerId: string,
  acpServerType: string,
  workspaceId: string,
  enableWorktree?: boolean,
  worktreeBranchSuffix?: string,
) => {
  try {
    const { data } = await createSession({
      variables: {
        input: {
          controllerId,
          acpServerType,
          workspaceId,
          enableWorktree: enableWorktree || false,
          worktreeBranchSuffix: worktreeBranchSuffix || null,
        },
      },
      refetchQueries: [{ query: GET_SESSIONS }],
    });
    if (data?.createSession?.session?.id) {
      navigate(`/sessions/${data.createSession.session.id}`);
      setShowNewDialog(false);
    }
  } catch (error) {
    console.error('Failed to create session:', error);
  }
};
```

### queries.ts 确认

`DETECT_GIT_REPO` 查询已存在，无需新增。

---

## Phase 8: 前端 Sidebar + SessionHeader Worktree 标识

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | Worktree Session 使用 Git 分叉图标 |
| `apps/agent-web/src/components/session/SessionHeader.tsx` | 修改 | 标题栏显示 Worktree 路径 + Badge |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | 传递 `worktreePath` 到 SessionHeader |
| `apps/agent-web/src/graphql/types.ts` | 修改 | `SessionData` 新增 `worktreePath`, `worktreeBranch` |

### Sidebar 修改

在 session 列表渲染处，检查 `session.worktreePath`：

```tsx
// 在 session 链接的图标位置
{session.worktreePath ? (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-400">
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 3h-3a2 2 0 0 0-2 2v3" />
    <path d="M21 15v3a2 2 0 0 1-2 2h-3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <polyline points="7 9 12 4 17 9" />
    <polyline points="7 15 12 20 17 15" />
  </svg>
) : (
  <span className={`h-2 w-2 shrink-0 rounded-full ${statusColors[session.status] ?? 'bg-gray-500'}`} />
)}
```

### SessionHeader 修改

Props 接口新增 `worktreePath`，显示 Worktree 标记：

```typescript
interface Session {
  // ...原有字段
  worktreePath?: string | null;
}
```

在 cwd 显示区域旁边新增 Badge：

```tsx
{session?.cwd && (
  <div className="flex items-center gap-1">
    <span className="text-sm text-gray-500 font-mono">{session.cwd}</span>
    {session?.worktreePath && (
      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 font-medium flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 3h-3a2 2 0 0 0-2 2v3" />
          <path d="M21 15v3a2 2 0 0 1-2 2h-3" />
          <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
          <polyline points="7 9 12 4 17 9" />
          <polyline points="7 15 12 20 17 15" />
        </svg>
        Worktree
      </span>
    )}
  </div>
)}
```

### SessionPage 修改

在传递给 SessionHeader 的 session 对象中增加 worktreePath：

```typescript
<SessionHeader
  session={sessionData?.session ? {
    // ... 原有字段
    worktreePath: (sessionData.session as any).worktreePath || null,
  } : null}
  // ...
/>
```

### types.ts 修改

`SessionData` 接口新增：

```typescript
worktreePath?: string | null
worktreeBranch?: string | null
```

### GraphQL queries 确认

`GET_SESSION` 和 `GET_SESSIONS` query 需确认包含 `worktreePath` 和 `worktreeBranch` 字段。如有遗漏则补充。

---

## Phase 9: API 测试 + 验收

### 单元测试

| Phase | 测试文件 | 操作 | 说明 |
|-------|----------|------|------|
| Phase 1 | `packages/agent-controller/src/__tests__/worktree-handler.test.ts` | 新建 | WorktreeHandler: mock child_process，覆盖 add/remove/status/commit |
| Phase 1 | `packages/agent-controller/src/__tests__/fs-handler.test.ts` | 新建 | FsHandler: mock fs.mkdirSync |
| Phase 2 | `servers/controller-api/src/services/__tests__/worktree-service.test.ts` | 新建 | WorktreeService: request-response 流程 |
| Phase 2 | `servers/controller-api/src/services/__tests__/fs-mkdir-service.test.ts` | 新建 | FsMkdirService: request-response 流程 |
| Phase 3 | `servers/agent-api/src/services/__tests__/session.test.ts` | 修改 | 新增 Worktree create/delete 测试 |
| Phase 3 | `servers/agent-api/src/services/__tests__/controller.test.ts` | 修改 | 新增 setWorktreeDir 测试 |
| Phase 5-8 | 前端组件测试 | 新增/修改 | 组件渲染和交互测试（可选） |

### API 测试

| 测试场景 | 说明 |
|----------|------|
| `setControllerWorktreeDir` | 设置和读取 worktreeDir |
| `createSession` with worktree | 启用 worktree 的 session 创建（mock command 链路） |
| `deleteSession` with worktree | 删除 worktree session 的清理流程 |
| `createFolder` | 调用 fs:mkdir 创建文件夹 |

### 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `npm run test -- --run` | `tests/api` | 运行集成 API 测试 |
| `aspire start` | 根目录 | 启动全部服务 |

### 验收 Checklist

- [ ] **Phase 1**: WorktreeHandler.add/remove/status/commit 命令正常执行
- [ ] **Phase 1**: FsHandler.mkdir 正常创建文件夹
- [ ] **Phase 1**: agent-controller 收到 Socket.IO 事件后正确执行并回复
- [ ] **Phase 2**: WorktreeService 正确转发命令到 controller socket
- [ ] **Phase 2**: FsMkdirService 正确转发 mkdir 命令
- [ ] **Phase 2**: 新命令的 Redis 结果缓存正常
- [ ] **Phase 3**: Session 模型新增 worktreePath/worktreeBranch 字段
- [ ] **Phase 3**: Controller 模型新增 worktreeDir 字段
- [ ] **Phase 3**: SessionService.create 支持 enableWorktree + worktreeBranchSuffix
- [ ] **Phase 3**: SessionService.delete 两阶段清理（status → commit → remove）
- [ ] **Phase 3**: 清理失败时 Session 保留不删除
- [ ] **Phase 4**: GraphQL schema/resolver 完整覆盖
- [ ] **Phase 5**: WorkspaceSection 顶部显示 Worktree 目录配置行，可修改
- [ ] **Phase 6**: DirectoryPicker 支持新建文件夹
- [ ] **Phase 7**: NewSessionDialog 检测 Git 仓库后展示 Worktree 设置 Section
- [ ] **Phase 7**: 分支名为 `<workspace>/<suffix>`，suffix 默认随机生成
- [ ] **Phase 8**: Sidebar 中 Worktree Session 显示 Git 分叉图标
- [ ] **Phase 8**: SessionHeader 显示 Worktree 路径 + 标记
- [ ] 单元测试覆盖达标
- [ ] API 测试通过
