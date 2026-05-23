---
description: 工作区设置页与 Git 能力支持 - 实现计划
type: Permanent
---

# 工作区设置页与 Git 能力支持 - 实现计划

**关联 Proposal**: `proposals/20260523-feat-workspace-git-support.md`
**创建日期**: 2026-05-23

## 实现顺序

```
Phase 0: Contracts（已产出待 review）
  └── Phase 1: agent-controller GitHandler
       └── Phase 2: controller-api GitBrowserService + Socket/Command 处理
            └── Phase 3: agent-api GraphQL + Service 扩展
                 └── Phase 4: 前端 AddWorkspaceDialog + WorkspaceSection 展开/折叠
                      └── Phase 5: 前端 Git 状态展示 + 默认分支设置
```

依赖关系：每个 Phase 依赖前一个 Phase 完成后进行集成验证。Phase 4 可独立于 Phase 1-3 进行 UI 结构改造，但 Git 功能展示需依赖 Phase 3。

---

## Phase 0: Contract（已完成）

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/controller-workspace.graphql` | 修改 | 新增 `defaultBranch`、`GitRepoInfo`、`detectGitRepo`、`initGitRepo`、`setWorkspaceDefaultBranch` |
| `contracts/agent-session-websocket.md` | 修改 | 新增文件系统事件总表 + `git:check`/`git:init` 事件定义 + Redis Pub/Sub 命令 |

---

## Phase 1: agent-controller GitHandler

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/git-handler.ts` | **新建** | Git 命令封装类 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 新增 `git:check` / `git:init` 事件监听 |

### `git-handler.ts` 设计

```typescript
interface GitCheckResult {
  isGitRepo: boolean;
  currentBranch?: string;
  branches?: string[];
  defaultBranch?: string;
  error?: string;
}

interface GitInitResult {
  success: boolean;
  error?: string;
}

export class GitHandler {
  async check(path: string): Promise<GitCheckResult> {
    // 1. 检测 git 仓库
    const gitDir = await execPromise('git rev-parse --git-dir', { cwd: path });
    if (!gitDir) {
      return { isGitRepo: false };
    }

    // 2. 获取当前分支
    const currentBranch = await execPromise('git rev-parse --abbrev-ref HEAD', { cwd: path });

    // 3. 获取所有本地分支
    const branchOutput = await execPromise('git branch --format="%(refname:short)"', { cwd: path });
    const branches = branchOutput.split('\n').filter(Boolean);

    // 4. 确定默认分支: main > master > 字母序第一个
    const defaultBranch = this.determineDefaultBranch(branches);

    return { isGitRepo: true, currentBranch, branches, defaultBranch };
  }

  async init(path: string): Promise<GitInitResult> {
    await execPromise('git init', { cwd: path });
    await execPromise('git branch -m main', { cwd: path });
    return { success: true };
  }

  private determineDefaultBranch(branches: string[]): string | undefined {
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
    return branches.sort((a, b) => a.localeCompare(b))[0];
  }
}

export const gitHandler = new GitHandler();
```

使用 `child_process.exec` 包装为 Promise：

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);
```

### `socketio-client.ts` 新增事件处理

在接口定义区域新增：

```typescript
interface GitCheckPayload {
  requestId: string;
  path: string;
}

interface GitInitPayload {
  requestId: string;
  path: string;
}
```

在 `connectToServer` 函数中新增事件监听（放在 FS 事件块附近）：

```typescript
socket.on('git:check', async (data: GitCheckPayload) => {
  console.log(`Git check requested: requestId=${data.requestId} path=${data.path}`);
  try {
    const result = await gitHandler.check(data.path);
    socket.emit('git:check:result', { requestId: data.requestId, ...result });
  } catch (error) {
    socket.emit('git:check:result', {
      requestId: data.requestId,
      isGitRepo: false,
      error: (error as Error).message,
    });
  }
});

socket.on('git:init', async (data: GitInitPayload) => {
  console.log(`Git init requested: requestId=${data.requestId} path=${data.path}`);
  try {
    const result = await gitHandler.init(data.path);
    socket.emit('git:init:result', { requestId: data.requestId, ...result });
  } catch (error) {
    socket.emit('git:init:result', {
      requestId: data.requestId,
      success: false,
      error: (error as Error).message,
    });
  }
});
```

### 启动 & 验证

```bash
cd packages/agent-controller
npm run build
npm run test
```

---

## Phase 2: controller-api GitBrowserService + Socket/Command 处理

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/git-browser.ts` | **新建** | Git 请求-响应协调服务 |
| `servers/controller-api/src/services/session-command.ts` | 修改 | 新增 `git:check` / `git:init` 命令 case |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 注册 `git:check:result` / `git:init:result` 事件处理 |

### `git-browser.ts` 设计

沿用 `FolderBrowserService` 相同的 request-response 模式：

```typescript
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class GitBrowserService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async check(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found: ${controllerId}`); return; }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline: ${controllerId}`); return; }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found: ${socketId}`); return; }

    socket.emit('git:check', { requestId, path });
  }

  async init(requestId: string, controllerId: string, path: string): Promise<void> {
    // 同上模式，emit 'git:init'
  }

  async handleCheckResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:check:${requestId}`, JSON.stringify(result), 'EX', 60);
    // 如果是合法仓库，同时缓存分支列表
    if (result.isGitRepo && result.branches) {
      // 分支列表缓存由 agent-api 侧在检测后处理
    }
  }

  async handleInitResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:init:${requestId}`, JSON.stringify(result), 'EX', 30);
  }
}

export const gitBrowserService = new GitBrowserService();
```

### `session-command.ts` 新增

在 Redis Pub/Sub 的消息处理分支中新增：

```typescript
} else if (command.type === 'git:check' && command.requestId && command.controllerId && command.path) {
  await this.handleGitCheck(command.requestId, command.controllerId, command.path);
} else if (command.type === 'git:init' && command.requestId && command.controllerId && command.path) {
  await this.handleGitInit(command.requestId, command.controllerId, command.path);
}
```

新增私有方法：

```typescript
private async handleGitCheck(requestId: string, controllerId: string, path: string): Promise<void> {
  await gitBrowserService.check(requestId, controllerId, path);
}

private async handleGitInit(requestId: string, controllerId: string, path: string): Promise<void> {
  await gitBrowserService.init(requestId, controllerId, path);
}
```

### `socketio.ts` 注册事件

在 socket 事件注册区（与 `fs:*` 处理相邻）新增：

```typescript
import { gitBrowserService } from '../services/git-browser.js';

// 在 start() 方法中
socket.on('git:check:result', async (data: { requestId: string } & Record<string, unknown>) => {
  await gitBrowserService.handleCheckResult(data.requestId, data);
});

socket.on('git:init:result', async (data: { requestId: string } & Record<string, unknown>) => {
  await gitBrowserService.handleInitResult(data.requestId, data);
});
```

### 启动 & 验证

```bash
cd servers/controller-api
npm run build
npm run test
```

---

## Phase 3: agent-api GraphQL + Service 扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/controller-workspace.ts` | 修改 | 新增 `defaultBranch` 字段 |
| `servers/agent-api/src/services/controller-workspace.ts` | 修改 | 新增 `detectGitRepo`、`initGitRepo`、`setDefaultBranch` 方法 |
| `servers/agent-api/src/graphql/schemas/controller-workspace.ts` | 修改 | 新增 `detectGitRepo`、`initGitRepo`、`setWorkspaceDefaultBranch` schema |
| `servers/agent-api/src/graphql/resolvers/controller-workspace.ts` | 修改 | 新增 resolver |

### model 变更

```typescript
const controllerWorkspaceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  name: { type: String, required: true },
  path: { type: String, required: true },
  isEnabled: { type: Boolean, default: true },
  defaultBranch: { type: String, default: undefined },  // 新增
}, { timestamps: true });
```

### service 变更

```typescript
import { getRedisClient } from '../middleware/redis.js';

async detectGitRepo(controllerId: string, workspaceId: string, userId: string): Promise<Record<string, unknown>> {
  const workspace = await this.findByIdAndValidate(workspaceId, userId, controllerId);

  const redis = getRedisClient();
  const requestId = `git_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 检查缓存
  const pathMd5 = createHash('md5').update(workspace.path).digest('hex');
  const cached = await redis.get(`git:branches:${controllerId}:${pathMd5}`);
  if (cached) {
    return JSON.parse(cached);
  }

  // 通过 Redis Pub/Sub 下发检测命令
  await redis.publish('session:command', JSON.stringify({
    type: 'git:check',
    requestId,
    controllerId,
    path: workspace.path,
  }));

  // 轮询结果
  for (let i = 0; i < 30; i++) {
    const result = await redis.get(`git:check:${requestId}`);
    if (result) {
      const parsed = JSON.parse(result);
      // 缓存分支列表
      if (parsed.isGitRepo && parsed.branches) {
        await redis.set(
          `git:branches:${controllerId}:${pathMd5}`,
          JSON.stringify(parsed),
          'EX', 60,
        );
      }
      await redis.del(`git:check:${requestId}`);
      return parsed;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('Git check timeout');
}

async initGitRepo(controllerId: string, workspaceId: string, userId: string): Promise<boolean> {
  const workspace = await this.findByIdAndValidate(workspaceId, userId, controllerId);

  const redis = getRedisClient();
  const requestId = `git_init_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await redis.publish('session:command', JSON.stringify({
    type: 'git:init',
    requestId,
    controllerId,
    path: workspace.path,
  }));

  for (let i = 0; i < 30; i++) {
    const result = await redis.get(`git:init:${requestId}`);
    if (result) {
      const parsed = JSON.parse(result);
      await redis.del(`git:init:${requestId}`);
      // 清理分支缓存
      const pathMd5 = createHash('md5').update(workspace.path).digest('hex');
      await redis.del(`git:branches:${controllerId}:${pathMd5}`);
      return parsed.success;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('Git init timeout');
}

async setDefaultBranch(id: string, defaultBranch: string, userId: string): Promise<IControllerWorkspace> {
  const workspace = await ControllerWorkspace.findOne({ _id: id, userId });
  if (!workspace) throw new Error('Workspace not found');
  workspace.defaultBranch = defaultBranch;
  return workspace.save();
}
```

导入依赖：

```typescript
import { createHash } from 'crypto';
```

### schema 变更

```graphql
extend type Query {
  detectGitRepo(controllerId: ID!, workspaceId: ID!): GitRepoInfo!
}

extend type Mutation {
  initGitRepo(controllerId: ID!, workspaceId: ID!): Boolean!
  setWorkspaceDefaultBranch(id: ID!, defaultBranch: String!): ControllerWorkspace!
}

type GitRepoInfo {
  isGitRepo: Boolean!
  currentBranch: String
  branches: [String!]
  defaultBranch: String
}
```

### resolver 变更

```typescript
detectGitRepo: async (
  _parent: unknown,
  args: { controllerId: string; workspaceId: string },
  context: AuthContext,
) => {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return controllerWorkspaceService.detectGitRepo(args.controllerId, args.workspaceId, context.currentUser.id);
},

initGitRepo: async (
  _parent: unknown,
  args: { controllerId: string; workspaceId: string },
  context: AuthContext,
) => {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return controllerWorkspaceService.initGitRepo(args.controllerId, args.workspaceId, context.currentUser.id);
},

setWorkspaceDefaultBranch: async (
  _parent: unknown,
  args: { id: string; defaultBranch: string },
  context: AuthContext,
) => {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return controllerWorkspaceService.setDefaultBranch(args.id, args.defaultBranch, context.currentUser.id);
},
```

### 启动 & 验证

```bash
cd servers/agent-api
npm run build
npm run test
```

---

## Phase 4: 前端 AddWorkspaceDialog + WorkspaceSection 展开/折叠

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/AddWorkspaceDialog.tsx` | **新建** | Dialog 包裹 DirectoryPicker |
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | 移除行内 DirectoryPicker，卡片支持展开/折叠 |
| `apps/agent-web/src/components/settings/WorkspaceManagerDialog.tsx` | 修改 | 移除行内 DirectoryPicker，改用 AddWorkspaceDialog |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增 `DETECT_GIT_REPO` query |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `INIT_GIT_REPO`、`SET_WORKSPACE_DEFAULT_BRANCH` mutation |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 新增 `GitRepoInfoData` 等类型 |

### `AddWorkspaceDialog.tsx` 设计

复现当前 `DirectoryPicker` 的行内功能，但包裹在 Dialog 中：

```tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DirectoryPicker } from '@/components/ui/DirectoryPicker';

interface AddWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controllerId: string;
  onCreated: () => void;
}

export default function AddWorkspaceDialog({ open, onOpenChange, controllerId, onCreated }: AddWorkspaceDialogProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!selectedPath) return;
    // 调用 createWorkspace mutation
    // 成功后调用 onCreated, onOpenChange(false)
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加工作区</DialogTitle>
          <DialogDescription>选择工作区目录</DialogDescription>
        </DialogHeader>
        <DirectoryPicker
          controllerId={controllerId}
          onSelect={(path) => setSelectedPath(path)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleConfirm} disabled={!selectedPath}>确认添加</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### `WorkspaceSection.tsx` 展开/折叠改造

当前行内 DirectoryPicker 改为「添加」按钮 → 打开 `AddWorkspaceDialog`。

每个工作区卡片改为可展开：

```tsx
const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
const [gitStates, setGitStates] = useState<Record<string, GitRepoInfoData>>({});

const toggleExpand = (id: string) => {
  setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};

// 展开时自动触发 Git 检测
useEffect(() => {
  expandedIds.forEach(id => {
    if (!gitStates[id]) {
      detectGitRepo({ variables: { controllerId, workspaceId: id } })
        .then(res => setGitStates(prev => ({ ...prev, [id]: res.data.detectGitRepo })));
    }
  });
}, [expandedIds]);
```

### GraphQL 新增

`queries.ts`:

```typescript
export const DETECT_GIT_REPO = gql`
  query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
    detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) {
      isGitRepo
      currentBranch
      branches
      defaultBranch
    }
  }
`;
```

`mutations.ts`:

```typescript
export const INIT_GIT_REPO = gql`
  mutation InitGitRepo($controllerId: ID!, $workspaceId: ID!) {
    initGitRepo(controllerId: $controllerId, workspaceId: $workspaceId)
  }
`;

export const SET_WORKSPACE_DEFAULT_BRANCH = gql`
  mutation SetWorkspaceDefaultBranch($id: ID!, $defaultBranch: String!) {
    setWorkspaceDefaultBranch(id: $id, defaultBranch: $defaultBranch) {
      id
      defaultBranch
    }
  }
`;
```

`types.ts`:

```typescript
export interface GitRepoInfoData {
  isGitRepo: boolean;
  currentBranch?: string | null;
  branches?: string[] | null;
  defaultBranch?: string | null;
}
```

### `WorkspaceManagerDialog.tsx` 修改

移除行内 DirectoryPicker，改为触发 `AddWorkspaceDialog`：

```tsx
const [showAddDialog, setShowAddDialog] = useState(false);

// 原 showPicker 状态和相关逻辑移除
// 「添加」按钮改为 setShowAddDialog(true)
```

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## Phase 5: 前端 Git 状态展示 + 默认分支设置

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | 展开区域 Git 状态 UI |

### WorkspaceSection 展开区域

在展开区域内根据 `isGitRepo` 展示不同内容：

```tsx
// 展开区域内容
{expandedIds.has(ws.id) && (
  <div className="border-t px-4 py-3 space-y-3">
    {gitStates[ws.id] ? (
      gitStates[ws.id].isGitRepo ? (
        <GitRepoView
          workspaceId={ws.id}
          gitInfo={gitStates[ws.id]}
          currentDefaultBranch={ws.defaultBranch}
          onBranchChange={(branch) => {
            // 调用 setWorkspaceDefaultBranch
            // 更新本地状态
          }}
        />
      ) : (
        <NonGitRepoView
          controllerId={controllerId}
          workspaceId={ws.id}
          onInitSuccess={() => {
            // 重新触发检测
          }}
        />
      )
    ) : (
      <div className="text-sm text-muted-foreground">正在检测 Git 仓库...</div>
    )}

    {/* 保持历史会话按钮 */}
    <div className="pt-2">
      <Button
        variant="outline" size="sm"
        disabled={!controllerOnline || !ws.isEnabled}
        onClick={() => setHistoryWorkspace(ws)}
      >
        历史会话
      </Button>
    </div>
  </div>
)}
```

### GitRepoView 组件（内联或提取）

```tsx
function GitRepoView({ workspaceId, gitInfo, currentDefaultBranch, onBranchChange }) {
  const [search, setSearch] = useState('');
  const branches = gitInfo.branches ?? [];
  const filtered = branches.filter(b => b.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-2">
      <div className="text-sm">
        <span className="text-muted-foreground">当前分支：</span>
        <span className="font-medium">{gitInfo.currentBranch}</span>
      </div>

      <div className="text-sm">
        <span className="text-muted-foreground">默认分支：</span>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={currentDefaultBranch || gitInfo.defaultBranch || ''}
          onChange={(e) => onBranchChange(e.target.value)}
        >
          {branches.map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      {/* 搜索过滤 */}
      <input
        type="text"
        placeholder="搜索分支..."
        className="w-full rounded border px-2 py-1 text-sm"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </div>
  );
}
```

### NonGitRepoView 组件

```tsx
function NonGitRepoView({ controllerId, workspaceId, onInitSuccess }) {
  const [initGitRepo] = useMutation(INIT_GIT_REPO);
  const [initializing, setInitializing] = useState(false);

  const handleInit = async () => {
    setInitializing(true);
    try {
      await initGitRepo({ variables: { controllerId, workspaceId } });
      onInitSuccess();
    } catch {
      // 错误处理
    } finally {
      setInitializing(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">该目录不是 Git 仓库</p>
      <Button size="sm" onClick={handleInit} disabled={initializing}>
        {initializing ? '初始化中...' : '初始化 Git 仓库'}
      </Button>
    </div>
  );
}
```

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## 测试计划

### 单元测试

| Phase | 测试文件 | 操作 | 说明 |
|-------|----------|------|------|
| Phase 1 | `packages/agent-controller/src/__tests__/git-handler.test.ts` | 新建 | GitHandler: mock child_process，覆盖检测/初始化/分支规则 |
| Phase 2 | `servers/controller-api/src/services/__tests__/git-browser.test.ts` | 新建 | GitBrowserService: request-response 流程 |
| Phase 3 | `servers/agent-api/src/services/__tests__/controller-workspace.test.ts` | 修改 | 新增 `detectGitRepo`/`initGitRepo`/`setDefaultBranch` 测试 |
| Phase 4 | `apps/agent-web/src/components/settings/__tests__/AddWorkspaceDialog.test.tsx` | 新建 | Dialog 渲染和交互 |
| Phase 4 | `apps/agent-web/src/components/settings/__tests__/WorkspaceSection.test.tsx` | 修改 | 展开/折叠逻辑 |
| Phase 5 | `apps/agent-web/src/components/settings/__tests__/WorkspaceSection.test.tsx` | 修改 | Git 状态展示 |

### E2E 测试

| 场景 | 步骤 |
|------|------|
| 工作区添加 Dialog | 点击添加 → 弹出 Dialog → 浏览目录 → 选择 → 确认添加 → 列表刷新 |
| 工作区展开/折叠 | 点击展开按钮 → 显示 Git 区域 → 再次点击 → 折叠 |
| 合法仓库检测 | 展开工作区 → 自动检测 → 显示当前分支 + 默认分支下拉框 |
| 默认分支选择 | 展开工作区 → 下拉框选择分支 → 记录为默认分支 |
| 非仓库初始化 | 展开工作区 → 显示初始化按钮 → 点击 → 初始化成功 → 刷新为合法仓库视图 |
| 分支搜索过滤 | 展开工作区 → 输入搜索关键词 → 分支列表过滤 |
| 控制器离线 | 展开工作区 → Git 操作禁用 → 显示离线提示 |

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `npm run test -- --run` | `tests/api` | 运行集成 API 测试 |
| `aspire start` | 根目录 | 启动全部服务 |
| `npm run dev -- --key <key> --server <endpoint>` | `packages/agent-controller` | 启动 agent-controller |

---

## 验收 Checklist

- [ ] **Phase 1**: `GitHandler.check()` 返回正确的检测结果和分支列表
- [ ] **Phase 1**: `GitHandler.init()` 执行 `git init && git branch -m main`
- [ ] **Phase 1**: 默认分支规则：`main` > `master` > 字母序第一个
- [ ] **Phase 1**: agent-controller 收到 Socket.IO 事件后正确执行命令并回复
- [ ] **Phase 2**: `GitBrowserService` 正确转发命令到 controller socket
- [ ] **Phase 2**: controller-api 收到 Redis 命令后正确处理 `git:check` / `git:init`
- [ ] **Phase 2**: 检测结果缓存到 Redis（TTL 60s）
- [ ] **Phase 3**: `detectGitRepo` 查询可用，返回 GitRepoInfo
- [ ] **Phase 3**: `initGitRepo` 变更可用，返回 Boolean
- [ ] **Phase 3**: `setWorkspaceDefaultBranch` 更新数据库
- [ ] **Phase 3**: 分支列表 Redis 缓存生效
- [ ] **Phase 4**: 添加工作区改为 Dialog 对话框
- [ ] **Phase 4**: 工作区卡片可展开/折叠
- [ ] **Phase 4**: 展开时自动触发 Git 检测
- [ ] **Phase 5**: 合法仓库展示当前分支 + 默认分支下拉框（可搜索）
- [ ] **Phase 5**: 选择分支后调用 `setWorkspaceDefaultBranch`
- [ ] **Phase 5**: 非仓库目录显示「初始化 Git 仓库」按钮
- [ ] **Phase 5**: 初始化成功后自动刷新为仓库视图
- [ ] **Phase 5**: 控制器离线时 Git 操作禁用
- [ ] 单元测试覆盖达标
- [ ] E2E 测试通过
