# controller-api

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + Socket.IO
- **ODM**: Mongoose (MongoDB, shared with agent-api)
- **Cache**: Redis (via ioredis, session + heartbeat)
- **Dev Runner**: tsx (watch mode)
- **Testing**: Vitest

## Architecture

```
src/
├── config/           # Environment configuration
├── services/
│   ├── socketio.ts   # Socket.IO server + event handling
│   ├── session.ts    # Session management (single key per session)
│   ├── heartbeat.ts  # Heartbeat detection + timeout scanner
│   └── command.ts    # Redis Pub/Sub command subscription
├── models/           # Mongoose models (shared schemas with agent-api)
├── middleware/
│   └── redis.ts      # Redis client initialization
└── index.ts          # Entry point
```

## 能力快照与 Elicitation resolved

- `acp:start:result` / `acp:resume:result` 可携带 `capabilities`：**仅在 payload 携带时**写入 `sessions.agentCapabilities`（旧 controller 不上报不覆盖历史快照）。
- 能力快照唯一持久化位置 = Mongo `sessions.agentCapabilities`；不为能力新增 Redis 键（`cacheCapabilities` 保持原语义）。
- 新增 `acp:elicitation:resolved`（controller → server）：透传 Redis `elicitation:resolved`（附 `userId`/`controllerId`），reason ∈ `unsupported_mode|timeout|cancelled`。
  `ElicitationManager.handleElicitationResolved` 做运行时校验：缺失/空 `sessionId` 或契约外 `reason` 直接丢弃并 `console.warn`；
  `requestId`/`detail` 截断到 200 字符后才入 Redis（controller payload 不可信）；payload 按白名单重建，
  非字符串 `detail`/未知字段直接丢弃（不能靠 `{...data}` 绕过截断）；`sessionId` 也有 200 上限。
- `acp:initial-config:result`（controller → server，契约 §2.39）：初始 mode/model 应用确认结果，仅当 acp:start/acp:resume 携带 modeId/modelId 时收敛后恰好一次。
  `ACPSessionManager.handleInitialConfigResult` 白名单校验（sessionId 非空、status ∈ applied|failed、error 截断 200，非法丢弃 + console.warn）；
  任一 failed 写 `Session.initialConfigError = { modeId?, modelId?, error, at }` 并经 publishStatus extra 下发（session-sse 透传见 agent-api）；
  全部 applied 时 `$unset` 该字段。
- `handleElicitationRequest` 校验 requestId/sessionId/mode/message/`requestedSchema`（≤64 KiB）/`url`（url 模式仅 http(s)、≤2048）/`toolCallId`/`elicitationId`；
  重复 requestId 先清旧 timer；controller `disconnect` 调 `clearForSocket` 清理该 socket 的 pending 与 timer。
- `acp:start:result.capabilities` 落库前有 64 KiB 体积防护：超限时保留 20 项 `features`，仅把 `raw` 替换为
  `{ truncated: true, originalBytes, preview }`（Agent 可控 `_meta` 不得放大 Mongo 文档）。
- Elicitation 超时：controller-api `TIMEOUT_MS=60s` 是唯一用户可见超时，到点同时“回 Agent cancel + 发布 resolved(timeout) + 回前端 cancel”。

## Dev Commands

```bash
aspire start    # Start all services via Aspire orchestration
npm run build   # Compile TypeScript
npm run start   # Start production server
npm run test    # Run tests
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 controller-api 的 HTTP endpoint。

## 云电脑标准注册约定

- 云电脑 worker 同时连接 cloud-controller `/worker` 与 controller-api 标准连接；标准连接使用 `ControllerKey(type=cloud)`（env `ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT`），**不得**把 `ZAG_CONTROLLER_KEY` 当作控制器 Key。
- agent-api 在创建云电脑时预创建 `Controller(type=cloud,status=registering,name=用户命名,version='0.0.0')`；本服务 `register` 的 upsert 使用 `$setOnInsert: { name: hostname }`，不覆盖用户命名。
- worker 不发送 `unregister`；容器销毁由 agent-api 编排。断开/心跳超时只影响 `Controller.status`（offline），云电脑生命周期以 `CloudHost.status` 为准。
- 心跳超时/断线恢复沿用既有标准会话语义；普通本地/云主机行为不变。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Worktree 提交人透传（committer）

- `session:command` 白名单中的 `git:worktree:add` 支持可选载荷 `committer {name,email}`：
  `session-command.ts` 校验后原样透传给 `worktreeService.handleAdd(requestId, controllerId, repoPath, worktreePath, branch, committer?)`，
  `emitToController('git:worktree:add', {..., committer})` 仅在非空时携带。
- **白名单不扩张**：committer 只是既有事件的字段扩展，不引入任意 git 命令通道；缺省 = 不下发，
  worker 沿用容器级 bot 身份。
- 下游 agent-gear ≥2.12.0 在 worktree 初始化后写 worktree 级 `user.name/user.email`（见
  `packages/agent-controller/AGENTS.md`）；旧版本 worker 忽略未知字段优雅降级。
- 契约：`contracts/agent-session-websocket.md` §3.12 + Redis relay 附录。

## 日志与可观测性

- **日志形态**：pino 单行 JSON（vendored `src/observability/`），字段字典与调用签名见 [`contracts/observability.md`](../../contracts/observability.md) §2 与 [`common-rules.md`](../../docs/engineering/common-rules.md)「日志与可观测性规范」。
- **span 清单**（另有 `httpContext()` 的 HTTP SERVER span、`socket.register` / `socket.disconnect` 连接生命周期 span）：
  - `messaging.process` — `session-command` 消费入口**每批/每命令一个 span**（属性 `sessionId`，`agent_message_chunk` 逐条只 `debug` 不开 span）；
  - `socket.handshake` — `/mcp-proxy` namespace 握手（`mcp-proxy-registry.ts`，提取 `auth.traceparent`）；
  - `heartbeat.tick` — 心跳扫描**每轮一个 span**，不逐事件；
  - `<channel> handle` — Redis 订阅回调入口一个 span（`command` / `gateway-relay` 的 `<COMMAND_CHANNEL> handle`、`permission-manager` / `elicitation-manager` / `harness-login-manager` / `mcp-forward-consumer` 各频道同型），父上下文取 `extractTraceparent(payload._meta)`。
- **Socket.IO / Redis `_meta` 封套位置**：Socket.IO 事件报文顶层 `_meta: { traceparent? }` 与握手 `auth.traceparent` 见 [`contracts/agent-session-websocket.md`](../../contracts/agent-session-websocket.md) §7；Redis 频道报文顶层 `_meta` 见 [`contracts/mcp-forward-redis.md`](../../contracts/mcp-forward-redis.md) §7。发布一律经 `publishJson(publish, channel, payload)`（`src/middleware/publish.ts`）注入 `_meta.traceparent`；所有消费者必须容忍 `_meta` 缺失（旧客户端/历史报文行为不变）。
- **env 变量**：`LOG_LEVEL` / `LOG_PRETTY`（仅非生产）/ `OTEL_SDK_DISABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`（**空 = 零外发**）/ `OTEL_EXPORTER_OTLP_HEADERS`（**禁止出现在任何日志**）/ `OTEL_SERVICE_NAME` / `OTEL_TRACES_SAMPLER(+_ARG)` 等，完整契约见 [`contracts/observability.md`](../../contracts/observability.md) §3。
- **排障**：`LOG_LEVEL=debug` 看逐事件日志；`OTEL_SDK_DISABLED=true` 关追踪导出（日志不受影响）；JSON 单行日志可直接 `grep`（`grep '"level":"error"'`、`grep '"trace_id":"<trace-id>"'` 串全链路、`grep '"component":"session-command"'` 按组件）。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)

## Lessons Learned

### 跨服务协议必须有双向集成测试

本次 Proxy timeout bug 的根因是 controller-api 与 agent-controller 之间的 HTTP 代理协议实现不一致。测试未覆盖的原因：

| 测试层 | 为什么没发现问题 |
|--------|----------------|
| `gateway-relay.test.ts`（controller-api 单元测试） | `handleTunnelData` 测试构造的 `http-response` JSON 数据格式（含 `statusCode`/`headers`/`body`）与真实 agent-controller 返回的格式不一致，但测试只验证 JSON 被正确处理，未验证真实 agent-controller 的输出格式 |
| `gateway.test.ts`（agent-controller 单元测试） | 从未测试 `http-request` JSON 输入和 `http-response` JSON 输出，只测了纯 TCP 数据通道 |
| `gateway-proxy.test.ts`（agent-api 单元测试） | Mock 了整个 Redis 层，无法发现下游协议不匹配 |
| E2E 测试 | Fake controller 与真实 agent-controller 的协议处理不同，掩盖了问题 |

**教训**：
1. **协议响应格式的测试数据必须来源于真实对端的输出** — `handleTunnelData` 的 `http-response` 测试数据与 agent-controller 实际发送的格式不符，导致解析逻辑错误地通过了测试
2. **跨服务边界的数据格式应在文档中精确定义，且测试数据必须严格遵循该定义** — `statusCode`/`headers` 分离格式 vs 原始 HTTP 响应字节格式的差异未被及时同步
3. **Mock 测试无法替代端到端协议一致性检查** — 关键数据通道需要集成测试来验证双向格式匹配

**改进措施**：
- 修改协议时，两端测试必须使用同一份 fixture 数据（避免 controller-api 用格式 A 测试，agent-controller 用格式 B 发送）
- `handleTunnelData` 的测试数据应直接来源于 agent-controller 的输出格式定义，而不是凭空构造
- 跨服务的数据格式变更需要两端的 AGENTS.md 同步更新协议说明

## 多租户一期（共写集合 tenantId）

- `controllers`/`sessions`/`controllerkeys`/`mcpservers`/`mcpsessionendpoints` 由本服务与 agent-api **共写**：两侧都必须 `userId + tenantId` 双写、查询 `tenantId + userId` 双条件（personal 期 tenantId==userId）。
- 复用/移植 agent-api `services/tenant-scope.ts` 插件（Mongoose v9 同步钩子；查询/更新/upsert/insertMany 自动补齐）；新增带 userId 的模型必须声明 `tenantId` 并 `applyTenantScope(schema)`。
- 注册 upsert 是「顶层 userId + $set（timestamps）」形态，插件需同时识别顶层与 `$set`/`$setOnInsert` 的 userId。
- 历史行由 agent-api 迁移 `014-tenant-id-rebackfill` 补齐（013 已在旧环境执行过，不会重跑）。
