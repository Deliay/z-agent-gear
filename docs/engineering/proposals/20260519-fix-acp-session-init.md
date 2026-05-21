# ACP Session 初始化修复方案

**关联问题**: 20260518-proposal-agent-session.md 验收问题
**创建日期**: 2026-05-19
**作者**: ZeroAsh

## 1. 问题分析

### 问题 1: Session 清理状态未同步前端（已确认）

**现象**: controller-api 超时后删除了 session，但前端仍显示 "connecting"。

**根因**: agent-api 的 SSE 服务 (`session-sse.ts`) 存在两个缺陷:

1. **`session:status` 频道未订阅**: controller-api 通过 `publishStatus()` 向 Redis `session:status` 频道发布状态变更，但 agent-api 的 SSE 服务从未订阅该频道。`broadcastStatus()` 方法存在但无调用方。

2. **`session:message` 频道名不匹配**: controller-api 发布到全局 `session:message` 频道，但 SSE 服务订阅的是 per-session 的 `session:${sessionId}:messages` 频道。名称不匹配导致消息无法通过 Redis Pub/Sub 传递。

### 问题 2: Controller 已启动 Agent 但 Controller-API 超时（待诊断）

**现象**: Controller 日志显示 ACP session 创建成功 (`ses_1c0ff23b7ffePHF9Qq7mj2j0zI`)，但 controller-api 报 `ACP start timeout` 并删除了 session。

**已知事实**:
- opencode 启动 + ACP 握手耗时不超过 2 秒
- 30s 超时不应被触发
- `acp:start:result` 事件可能从未被 controller 发出，或发出后未被 controller-api 接收

**待定位**: 需要通过诊断日志确认以下环节的实际执行情况:

```
controller-api                        controller                            bridge
─────────────                    ─────────────                        ─────────────
1. emit acp:start ──────────────> 2. 收到 acp:start
                                  3. 创建 bridge
                                  4. bridge.start()
                                  5. initialize() ──────────────────> 6. spawn opencode
                                                                        7. send initialize
                                                                        8. recv initialize response
                                                                        9. send session/new
                                                                       10. recv session/new response
                                                                       11. emit acp:initialized
                                  12. onInitialized ────────────────> 13. emit acp:start:result
14. 收到 acp:start:result ???
15. once listener 触发 ???
```

需要在以下关键点加日志:
- **点 1**: controller-api 发送 `acp:start` 时记录 requestId 和 sessionId
- **点 2**: controller 收到 `acp:start` 时记录
- **点 5-10**: bridge 每个步骤记录耗时
- **点 12**: controller 的 `onInitialized` / `onStopped` 是否被调用
- **点 13**: controller 发送 `acp:start:result` 时记录
- **点 14-15**: controller-api 的 `once` listener 是否收到事件

## 2. 修复方案

### 阶段 1: 诊断日志（优先）

在以下文件增加带时间戳的诊断日志:

**`packages/agent-controller/src/socketio-client.ts`**:
```typescript
// acp:start handler:
console.log(`[ACP ctrl] received acp:start sessionId=${data.sessionId} requestId=${data.requestId}`);

// onInitialized:
console.log(`[ACP ctrl] onInitialized sessionId=${payload.sessionId} → emitting acp:start:result`);
socket.emit('acp:start:result', { ... });

// onStopped:
console.log(`[ACP ctrl] onStopped sessionId=${payload.sessionId} reason=${payload.reason} → emitting acp:start:result`);
socket.emit('acp:start:result', { ... success: false });
```

**`packages/agent-controller/src/acp/bridge.ts`**:
```typescript
// 每个步骤记录耗时:
const t0 = Date.now();
console.log(`[ACP bridge] initialize start sessionId=${this.sessionId}`);
// ... send initialize
console.log(`[ACP bridge] initialize response in ${Date.now()-t0}ms`);
// ... send session/new
console.log(`[ACP bridge] session/new response in ${Date.now()-t0}ms sessionId=${this.acpSessionId}`);
```

**`servers/controller-api/src/services/acp-session-manager.ts`**:
```typescript
// 发送 acp:start:
console.log(`[ACP mgr] emitting acp:start sessionId=${sessionId} requestId=${requestId}`);

// once listener 触发:
console.log(`[ACP mgr] received acp:start:result requestId=${payload.requestId} success=${payload.success}`);

// 超时触发:
console.log(`[ACP mgr] TIMEOUT sessionId=${sessionId} requestId=${requestId}`);
```

### 阶段 2: SSE 状态同步

**文件**: `servers/agent-api/src/services/session-sse.ts`

1. 在 `addConnection()` 中增加对 `session:status` 全局频道的订阅
2. 收到状态变更后调用 `broadcastStatus()` 推送到前端
3. 收到 `removed` 状态时关闭 SSE 连接并通知前端
4. 连接建立时发送当前 session 状态（避免丢失中间状态）

### 阶段 3: Aspire 编排 agent-controller

**文件**: `aspire/AgentGear.AppHost/AppHost.cs`

Controller 的 key 在运行时通过 GraphQL 创建，无法在 AppHost 启动时确定。使用 `WithExplicitStart()` 标记 controller 为非自动启动资源。Key 通过写入 `~/.zag/config.toml` 注入（controller 启动时自动读取）。

```csharp
var controller = builder.AddNodeApp("agent-controller", "../../packages/agent-controller", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ZAG_SERVER_ENDPOINT", controllerApi.GetEndpoint("http"))
    .WithExplicitStart()  // 不自动启动，需手动 `aspire resource agent-controller start`
    .WaitFor(controllerApi);
```

**手动启动流程**:

```bash
# 1. 启动基础设施 + 后端服务
aspire start

# 2. 创建用户和 key（通过 GraphQL Playground 或 curl）
curl -X POST http://localhost:<agent-api-port>/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation{signup(username:\"dev\",password:\"pass123\"){token}}"}'

# 3. 创建 controller key
curl -X POST http://localhost:<agent-api-port>/graphql \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"query":"mutation{createControllerKey(input:{name:\"dev\",type:local}){rawKey}}"}'

# 4. 将 key 写入配置文件
cat > ~/.zag/config.toml << EOF
[key]
value = "<rawKey>"
[server]
endpoint = "http://localhost:<controller-api-port>"
EOF

# 5. 手动启动 controller（自动读取 ~/.zag/config.toml）
aspire resource agent-controller start
```

**Controller 配置读取优先级**: `--key` CLI 参数 > `ZAG_CONTROLLER_KEY` 环境变量 > `~/.zag/config.toml`

### 阶段 4: 真实 Controller 集成测试

**新增文件**: `tests/api/src/controller-api/acp-real-controller.test.ts`

测试中不通过 Aspire 启动 controller，而是直接 spawn 进程（更灵活、更可控）。Key 写入 `~/.zag/config.toml`，controller 启动时自动读取。

```typescript
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONTROLLER_PKG = path.resolve(__dirname, '../../../../packages/agent-controller');
const CONFIG_DIR = join(homedir(), '.zag');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');

function writeControllerConfig(key: string, endpoint: string): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `[key]\nvalue = "${key}"\n[server]\nendpoint = "${endpoint}"\n`, 'utf-8');
}

describe('ACP Real Controller Integration', () => {
  let controllerProcess: ChildProcess;
  let rawKey: string;
  let controllerId: string;

  beforeAll(async () => {
    // 1. 创建用户和 key
    const token = await signup();
    const key = await createKey(token);
    rawKey = key.rawKey;

    // 2. 写入配置文件
    writeControllerConfig(rawKey, controllerApiUrl);

    // 3. 启动真实 controller 进程（自动读取 ~/.zag/config.toml）
    controllerProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: CONTROLLER_PKG,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--import tsx' },
    });

    // 4. 等待 controller 注册（监听 stdout 中的 "Controller registered" 日志）
    controllerId = await waitForRegistration(controllerProcess);

    // 5. 等待 controller 在 DB 中变为 online
    await waitForControllerOnline(controllerId);
  });

  afterAll(() => {
    controllerProcess?.kill('SIGTERM');
  });

  it('should create ACP session with real opencode', async () => {
    const session = await createSession(controllerId);
    const status = await waitForSessionStatus(session.id, 'running', 30_000);
    expect(status).toBe('running');
  });

  it('should receive ACP messages via SSE', async () => {
    const session = await createSession(controllerId);
    await waitForSessionStatus(session.id, 'running', 30_000);

    const messages = await collectSSEMessages(session.id, (msg) => msg.type === 'message');
    expect(messages.length).toBeGreaterThan(0);
  });
});
```

**测试辅助函数**:

```typescript
function waitForRegistration(proc: ChildProcess, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller registration timeout')), timeoutMs);
    proc.stdout?.on('data', (data) => {
      const line = data.toString();
      const match = line.match(/Controller registered: (\w+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
}

async function waitForControllerOnline(controllerId: string, timeoutMs = 10_000): Promise<void> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
    const body = await res.json();
    if (body.data?.controller?.status === 'online') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Controller did not come online');
}

async function waitForSessionStatus(sessionId: string, expected: string, timeoutMs = 30_000): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
    const body = await res.json();
    const status = body.data?.session?.status;
    if (status === expected) return status;
    if (status === 'ended' || status === 'removed') throw new Error(`Session unexpected status: ${status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session did not reach status '${expected}' within ${timeoutMs}ms`);
}
```

## 3. 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| **阶段 1: 诊断日志** | | |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 增加 acp:start / onInitialized / onStopped 日志 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | 增加初始化各步骤耗时日志 |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | 增加 emit / receive / timeout 日志 |
| **阶段 2: SSE 状态同步** | | |
| `servers/agent-api/src/services/session-sse.ts` | 修改 | 订阅 `session:status` 频道，连接时发送当前状态 |
| **阶段 3: Aspire 编排** | | |
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | 新增 agent-controller 资源（`WithExplicitStart` + 外部参数） |
| **阶段 4: 集成测试** | | |
| `tests/api/src/controller-api/acp-real-controller.test.ts` | 新增 | 真实 controller 集成测试（spawn 进程） |

## 4. 验收标准

- [ ] 诊断日志覆盖完整事件流，可通过 `aspire logs` 追踪每个环节
- [ ] 根据日志定位到 `acp:start:result` 丢失/延迟的真实原因
- [ ] 修复该原因（而非猜测性修改）
- [ ] 单元测试全部通过
- [ ] `aspire start` 后 controller 不自动启动
- [ ] 写入 `~/.zag/config.toml` 后 `aspire resource agent-controller start` 可启动 controller
- [ ] 集成测试覆盖真实 controller ACP session 创建流程
- [ ] Session 状态变更通过 SSE 实时推送到前端
