---
description: 多 ACP Server 支持 - 实现计划
type: Permanent
---

# 多 ACP Server 支持 - 实现计划

**关联 Proposal**: `proposals/20260526-feat-multi-acp-server-support.md`
**创建日期**: 2026-05-26

## 实现顺序

```
Phase 1: Contract + agent-api enum 扩展
  └── Phase 2: controller-api enum + resumeSession serverType
       └── Phase 3: agent-controller 多 Server 检测 + spawner 选择
            └── Phase 4: 前端 ACP Server 类型标签可读展示
                 └── Phase 5: 测试覆盖
```

---

## Phase 1: Contract + agent-api enum 扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | `enum AcpServerType` 增加 `github_copilot` |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | 同步 `enum AcpServerType` |
| `servers/agent-api/src/models/session.ts` | 修改 | Mongoose `enum` 数组增加 `'github_copilot'` |

### contracts/agent-session.graphql 变更

```graphql
enum AcpServerType {
  opencode
  github_copilot
}
```

### servers/agent-api/src/models/session.ts 变更

```typescript
acpServerType: { type: String, enum: ['opencode', 'github_copilot'], required: true },
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
npm run test     # 单元测试
```

---

## Phase 2: controller-api enum + resumeSession serverType

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/models/session.ts` | 修改 | Mongoose `enum` 数组增加 `'github_copilot'` |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | `resumeSession` 从 DB 读取 `acpServerType` 并透传到 socket emit |

### servers/controller-api/src/models/session.ts 变更

```typescript
acpServerType: { type: String, enum: ['opencode', 'github_copilot'], required: true },
```

### acp-session-manager.ts resumeSession 变更

```typescript
async resumeSession(
  controllerSocket: Socket,
  sessionId: string,
  externalSessionId: string,
  controllerId: string,
  userId: string,
  cwd: string,
): Promise<{ success: boolean; error?: string }> {
  // 新增：从 DB 读取 acpServerType
  const doc = await Session.findById(sessionId).lean();
  const acpServerType = doc?.acpServerType ?? 'opencode';

  // ... 现有逻辑不变 ...

  controllerSocket.emit('acp:resume', {
    requestId,
    sessionId,
    externalSessionId,
    serverType: acpServerType,  // 新增字段
    cwd,
  });

  // ... 现有逻辑不变 ...
}
```

### 启动 & 验证

```bash
# controller-api 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 3: agent-controller 多 Server 检测 + spawner 选择

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/detector.ts` | 修改 | 新增 `detectGitHubCopilot()`、`getSpawnerConfig()`；`detect()` 并行检测两个 Server |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | `acp:start`/`acp:resume` handler 根据 `serverType` 创建对应 spawner；`AcpResumePayload` 补充 `serverType` |

### detector.ts 变更

```typescript
export class AcpDetector {
  async detect(): Promise<AcpServerInfo[]> {
    const [opencode, copilot] = await Promise.all([
      this.detectOpenCode(),
      this.detectGitHubCopilot(),
    ]);
    return [opencode, copilot];
  }

  private async detectOpenCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('opencode -v');
      return { type: 'opencode', available: true, version: this.parseVersion(stdout) };
    } catch {
      return { type: 'opencode', available: false };
    }
  }

  private async detectGitHubCopilot(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('copilot --version');
      return { type: 'github_copilot', available: true, version: this.parseVersion(stdout) };
    } catch {
      return { type: 'github_copilot', available: false };
    }
  }

  getSpawnerConfig(serverType: string): { command: string; args: string[] } {
    switch (serverType) {
      case 'github_copilot':
        return { command: 'copilot', args: ['--acp', '--stdio'] };
      case 'opencode':
      default:
        return { command: 'opencode', args: ['acp'] };
    }
  }

  private parseVersion(output: string): string {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }
}
```

### socketio-client.ts 变更

```typescript
interface AcpResumePayload {
  requestId: string;
  sessionId: string;
  externalSessionId: string;
  serverType: string;       // 新增
  cwd: string;
}

// 新增工厂函数
function createSpawner(serverType: string, sessionId: string, cwd: string): AcpSpawner {
  const config = acpDetector.getSpawnerConfig(serverType);
  return new AcpSpawner({ sessionId, cwd, command: config.command, args: config.args });
}

// acp:start handler
socket.on('acp:start', async (data: AcpStartPayload) => {
  const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
  const bridge = new AcpSessionBridge(socket, {
    sessionId: data.sessionId,
    cwd: data.cwd,
    mcpServers: data.mcpServers,
  }, spawner);
  // ... 后续逻辑不变 ...
});

// acp:resume handler
socket.on('acp:resume', async (data: AcpResumePayload) => {
  const spawner = createSpawner(data.serverType, data.sessionId, data.cwd);
  const bridge = new AcpSessionBridge(socket, {
    sessionId: data.sessionId,
    cwd: data.cwd,
  }, spawner);
  // ... 后续逻辑不变 ...
});
```

### 注意事项

- `acp:list-sessions` 和 `acp:load-session` 始终使用 OpenCode（默认 spawner），不做 serverType 区分
- `AcpSpawner`、`AcpSessionBridge`、`AcpSyncBridge` 本身无需改动（均已支持外部传入 spawner）

### 启动 & 验证

```bash
# agent-controller 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 4: 前端 ACP Server 类型标签可读展示

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/SessionHeader.tsx` | 修改 | `acpServerType` 标签使用可读映射 |

### SessionHeader.tsx 变更

```typescript
// 新增映射
const acpServerTypeLabels: Record<string, string> = {
  opencode: 'OpenCode',
  github_copilot: 'GitHub Copilot',
};

// 替换原有直接输出
{session?.acpServerType && (
  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
    {acpServerTypeLabels[session.acpServerType] || session.acpServerType}
  </span>
)}
```

### 启动 & 验证

```bash
# agent-web 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 5: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/tests/acp-detector.test.ts` | 修改 | 新增 `detectGitHubCopilot()` 测试 + `getSpawnerConfig()` 测试 |
| `servers/controller-api/src/services/acp-session-manager.test.ts` | 修改 | `resumeSession` 测试验证 `serverType` 传递 |
| `apps/agent-web/src/components/session/SessionHeader.test.tsx` | 修改 | 新增 `github_copilot` 标签显示测试 |
| `tests/api/src/controller-api/acp-websocket.test.ts` | 修改 | 创建 `github_copilot` 类型 Session 验证 |
| `tests/api/src/agent-api/session.test.ts` | 修改 | 创建 `github_copilot` 类型 Session 验证 |

### detector.test.ts 测试要点

```typescript
describe('AcpDetector', () => {
  it('should detect opencode', async () => { /* 已有 */ });
  it('should detect github copilot', async () => {
    vi.mocked(execAsync).mockResolvedValueOnce({ stdout: '1.0.0\n', stderr: '' });
    const result = await detector.detectGitHubCopilot();
    expect(result.type).toBe('github_copilot');
    expect(result.available).toBe(true);
  });
  it('should return getSpawnerConfig for github_copilot', () => {
    const config = detector.getSpawnerConfig('github_copilot');
    expect(config.command).toBe('copilot');
    expect(config.args).toEqual(['--acp', '--stdio']);
  });
  it('should return getSpawnerConfig for opencode', () => {
    const config = detector.getSpawnerConfig('opencode');
    expect(config.command).toBe('opencode');
    expect(config.args).toEqual(['acp']);
  });
});
```

### SessionHeader.test.tsx 测试要点

```typescript
it('should display GitHub Copilot label', () => {
  const session = { ...baseSession, acpServerType: 'github_copilot' };
  render(<SessionHeader session={session} status="running" onClose={noop} onDelete={noop} />);
  expect(screen.getByText('GitHub Copilot')).toBeDefined();
});
```

### 运行测试

```bash
# 各子项目目录下
npm run test     # 单元测试
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

- [ ] **Phase 1**: Contract + GraphQL schema + Mongoose model enum 编译通过
- [ ] **Phase 2**: controller-api resumeSession 从 DB 读取 `acpServerType` 并透传
- [ ] **Phase 3**: `AcpDetector.detect()` 返回 `opencode` + `github_copilot` 两个结果
- [ ] **Phase 3**: `acp:start` `serverType=github_copilot` 时 spawner 命令为 `copilot --acp --stdio`
- [ ] **Phase 3**: `acp:resume` `serverType=github_copilot` 时 spawner 命令为 `copilot --acp --stdio`
- [ ] **Phase 3**: `detect()` 中 opencode 检测失败不影响 copilot 检测结果
- [ ] **Phase 4**: SessionHeader 显示 "GitHub Copilot" 标签（而非原始 `github_copilot`）
- [ ] **Phase 4**: SessionHeader 显示 "OpenCode" 标签（而非原始 `opencode`）
- [ ] **Phase 5**: 所有测试通过
- [ ] **兼容性**: 已有 Session（`acpServerType=opencode`）不受任何影响
