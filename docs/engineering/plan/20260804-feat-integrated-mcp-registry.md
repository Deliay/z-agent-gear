---
description: 集成式 MCP 注册中心 - 实现计划（P1 详细拆解 + P2 概要）
type: Permanent
---

# 集成式 MCP 注册中心 - 实现计划

**关联 Proposal**: [[../proposals/20260804-feat-integrated-mcp-registry.md]]（v2.1）
**关联 PRD**: `docs/product/draft/20260804-integrated-mcp-registry.md`（v1.1）
**feat-branch**: `feat/integrated-mcp-registry`
**创建日期**: 2026-08-04

## 实现顺序

```
Phase 1: Contract 更新 + 数据模型扩展
  ├── Phase 2: controller-api — Registry 多副本化（owner 表 + Redis 消费 + acp:start 透传）
  ├── Phase 3: agent-api — MCP 入口 + Endpoint 服务迁入 + Redis 转发客户端   (与 P2 并行)
  │    └── Phase 4: 会话装配链路（agent-api session → controller-api → agent-controller）
  │         └── Phase 5: agent-web — Registry 目录页 + 会话创建多选
  │              └── Phase 6: 移除 mcp-forwarder + 网关路由 + 编排收尾
  │                   └── Phase 7: P1 测试覆盖（API + E2E）
  └── Phase 8+: P2 概要（HTTP 绑定 / 平台内置 / 工具清单）
```

- Phase 2 与 Phase 3 是 Redis 协议的两端，Contract（Phase 1）锁定后可并行开发。
- 全程遵循 TDD 红-绿-重构：每个 Phase 先写失败测试，再实现。

---

## Phase 1: Contract 更新 + 数据模型扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/mcp-server.graphql` | 修改 | transport/source/enabled/tools 字段 + `setMcpServerEnabled` Mutation |
| `contracts/mcp-forward-redis.md` | 新增 | Redis 请求-响应转发协议 |
| `contracts/gateway-proxy.openapi.yaml` | 修改 | 新增 `/mcp/{sessionId}` 路由 |
| `contracts/agent-session-websocket.md` | 修改 | `mcpEndpoint.url` 指向统一网关 |
| `contracts/mcp-proxy-websocket.md` | 修改 | 移除 `mcp:forward` 描述；确认 `proxy:unregistered`/`proxy:shutdown` 语义 |
| `servers/agent-api/src/models/mcp-server.ts` | 修改 | 模型扩展 |
| `servers/controller-api/src/models/mcp-server.ts` | 修改 | 模型扩展（与 agent-api 保持一致） |

### contracts/mcp-server.graphql（P1 部分）

```graphql
enum McpServerTransport {
  registered_proxy
  http      # P2 启用
  platform  # P2 启用
}

enum McpServerSource {
  proxy
  manual    # P2 启用
  platform  # P2 启用
}

type McpServerTool {
  name: String!
  description: String
}

type McpServer {
  id: ID!
  name: String!
  transport: McpServerTransport!
  source: McpServerSource!
  enabled: Boolean!
  command: String
  url: String
  hostname: String
  status: McpServerStatus!
  tools: [McpServerTool!]!
  toolsSyncedAt: String
  lastHeartbeatAt: String
  createdAt: String!
  updatedAt: String!
}

type Mutation {
  setMcpServerEnabled(id: ID!, enabled: Boolean!): McpServer!
}
```

### contracts/mcp-forward-redis.md（核心内容）

```markdown
## 频道
- `mcp:forward:request`  agent-api → 所有 controller-api 副本（广播）
- `mcp:forward:response` controller-api（持有者）→ agent-api

## 消息结构
request:  { requestId: uuid, serverId: string, sessionId: string, request: JsonRpcRequest }
response: { requestId: uuid, response?: JsonRpcResponse, error?: { code, message } }

## 寻址规则
1. agent-api 先 GET `mcp:proxy:owner:{serverId}`（TTL 45s，代理心跳刷新，断开删除）
2. 无 owner → 直接返回 SERVER_OFFLINE（fail-fast，不广播）
3. 有 owner → 广播 request；仅本地持有该 serverId 活跃 socket 的副本处理
4. agent-api 按 requestId 匹配 response，30s 超时 → FORWARD_TIMEOUT

## 错误码
SERVER_OFFLINE / ENDPOINT_REVOKED / FORWARD_TIMEOUT / SERVER_NOT_FOUND
```

### 数据模型迁移

- `mcpservers` 存量记录迁移脚本（启动时幂等执行）：`source='proxy'`、`enabled=true`。
- 新增字段：`source`、`hostname`、`url`、`headersEncrypted`、`enabled`、`tools[]`、`toolsSyncedAt`。

### 验收 Checklist

- [ ] 契约评审通过，与 proposal v2.1 一致
- [ ] 存量数据迁移后 `mcpServers` 查询结果不变（兼容）

---

## Phase 2: controller-api — Registry 多副本化

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/mcp-proxy-registry.ts` | 修改 | instanceId、owner 注册表、Redis 请求消费 |
| `servers/controller-api/src/services/mcp-forward-consumer.ts` | 新增 | 订阅 `mcp:forward:request` 并分发 |
| `servers/controller-api/src/socket/session-command.ts` | 修改 | `acp:start` 透传 `mcpEndpoint` |
| `servers/controller-api/src/services/mcp-endpoint.ts` | 删除 | 迁至 agent-api（Phase 3） |
| `servers/controller-api/src/routes/mcp-endpoint.ts` | 删除 | 同上 |
| `servers/controller-api/src/index.ts` | 修改 | 移除 endpoint 路由挂载，启动 consumer |

### 关键实现

```ts
// mcp-proxy-registry.ts 增量
const instanceId = crypto.randomUUID(); // 进程级

// proxy:register / proxy:heartbeat 时
await redis.set(`mcp:proxy:owner:${serverId}`, instanceId, 'EX', 45);
// proxy:unregister / disconnect 时
await redis.del(`mcp:proxy:owner:${serverId}`);

// mcp-forward-consumer.ts
sub.subscribe('mcp:forward:request');
sub.on('message', async (_, message) => {
  const { requestId, serverId, sessionId, request } = JSON.parse(message);
  if (!registry.hasActiveProxy(serverId)) return; // 非持有者直接忽略
  try {
    const response = await registry.forwardRequest(serverId, request);
    await redis.publish('mcp:forward:response', JSON.stringify({ requestId, response }));
  } catch (e) {
    await redis.publish('mcp:forward:response',
      JSON.stringify({ requestId, error: { code: 'FORWARD_ERROR', message: String(e) } }));
  }
});
```

- `session-command.ts::handleAcpStart`：将 payload 中的 `mcpEndpoint` 透传进发往 agent-controller 的 `acp:start`。

### 测试（先红后绿）

- 单测：owner 写入/删除/心跳续期；非持有副本忽略请求；持有副本响应含 requestId；转发异常回 error。
- 双实例测试：两个 registry 实例，仅持有者 publish 响应。

### 验收 Checklist

- [ ] 双副本场景仅持有者响应
- [ ] 代理断开后 owner key 清除
- [ ] `acp:start` 携带 `mcpEndpoint` 到达 agent-controller 侧消息

---

## Phase 3: agent-api — MCP 入口 + Redis 转发客户端

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/mcp.ts` | 新增 | `POST /mcp/:sessionId` 入口 |
| `servers/agent-api/src/services/mcp-endpoint.ts` | 新增 | 从 controller-api 迁入并扩展（签发/吊销/续期/校验） |
| `servers/agent-api/src/services/mcp-forwarder.ts` | 新增 | Redis 请求-响应客户端 |
| `servers/agent-api/src/models/mcp-session-endpoint.ts` | 新增 | 模型（含 `serverIds`） |
| `servers/agent-api/src/config/index.ts` | 修改 | `mcpEndpointJwtSecret`、`gatewayUrl`、`mcpEndpointTokenTtl` |
| `servers/agent-api/src/index.ts` | 修改 | 挂载 `/mcp` 路由 |

### 关键实现

```ts
// routes/mcp.ts
router.post('/mcp/:sessionId', async (req, res) => {
  const payload = verifyMcpJwt(req.headers.authorization);        // 401 on fail
  if (payload.sessionId !== req.params.sessionId) return res.status(401).json(...);
  const endpoint = await mcpEndpointService.getStatus(req.params.sessionId); // Redis → Mongo
  if (endpoint !== 'active') return res.status(401).json(jsonRpcError('ENDPOINT_REVOKED'));

  const serverName = req.body?.params?.serverName ?? payload.serverNames[0];
  const server = await McpServer.findOne({ userId: payload.userId, name: serverName, enabled: true });
  if (!server) return res.json(jsonRpcError('SERVER_NOT_FOUND'));

  // P1: registered_proxy → Redis 转发；http/platform → P2
  const owner = await redis.get(`mcp:proxy:owner:${server._id}`);
  if (!owner) return res.json(jsonRpcError('SERVER_OFFLINE'));
  const response = await mcpForwarder.request({ serverId: server._id, sessionId, request: req.body });
  res.json(response);
});

// services/mcp-forwarder.ts — 参考 routes/gateway-proxy.ts 的 port-forward 模式
async function request(msg): Promise<JsonRpcResponse> {
  const requestId = crypto.randomUUID();
  const responsePromise = waitForResponse(requestId, 30_000); // FORWARD_TIMEOUT on timeout
  await redis.publish('mcp:forward:request', JSON.stringify({ requestId, ...msg }));
  return responsePromise;
}
```

### 测试

- 单测：JWT 校验失败 401；sessionId 不匹配 401；revoked endpoint 401；无 owner → SERVER_OFFLINE；超时 → FORWARD_TIMEOUT；requestId 正确关联。
- Mock Redis 的收发对测（参考 `gateway.test.ts`）。

### 验收 Checklist

- [ ] 入口全部错误路径有明确 JSON-RPC error
- [ ] revoke 后第一个请求即 401（Redis 状态生效）

---

## Phase 4: 会话装配链路

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | `CreateSessionInput.mcpServerIds: [ID!]` |
| `servers/agent-api/src/services/session.ts` | 修改 | 勾选时装配 endpoint；关闭时吊销；重开时重签 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | `acp:start` 接收 `mcpEndpoint` |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | 注入 ACP `mcpServers` |
| `packages/agent-controller/src/commands/mcp.ts` | 修改 | stdio 桥默认指向网关地址（仅默认值调整） |

### 关键实现

- `SessionService.create()`：
  - `mcpServerIds` 为空/缺省 → 不签发、不下发（静默降级）；
  - 非空 → 校验均为该用户 `enabled=true` 的 server → 签发 endpoint（JWT payload 含 `serverNames` 快照）→ `acp:start` 携带 `mcpEndpoint`。
- `SessionService` 关闭/结束钩子：`mcpEndpointService.revoke(sessionId)`（Mongo status=revoked + 写 Redis）。
- 会话重开/恢复：重新签发新 endpoint，不复用旧令牌。
- `bridge.ts`：收到 `mcpEndpoint` 时构造 ACP mcpServers——Agent 支持 HTTP MCP 则直连 `{url, headers: {Authorization: Bearer token}}`；否则配置 stdio：`agent-gear mcp --endpoint <url> --token <token>`。

### 测试

- 单测：空勾选不签发；勾选非法 serverId 报错；关闭钩子调用 revoke；重开生成新 token。
- API 测试：createSession → acp:start 消息含 mcpEndpoint。

### 验收 Checklist

- [ ] 勾选非空时 Agent 收到可用 endpoint；空勾选时无 MCP
- [ ] 会话关闭后旧 endpoint 调用 401；重开后新 endpoint 可用

---

## Phase 5: agent-web — Registry 目录页 + 会话创建多选

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/McpRegistrySection.tsx` | 新增 | 目录视图（来源徽标/状态/启停用开关），替代 `McpServerSection` |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | `GET_MCP_SERVERS` 增加新字段；新增 `SET_MCP_SERVER_ENABLED` |
| `apps/agent-web/src/components/session/NewSessionDialog.tsx` | 修改 | MCP 分组多选（默认不勾选 + 搜索过滤） |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | `CREATE_SESSION` 携带 `mcpServerIds` |

### 要点

- 目录页分组：代理注册 / 远程绑定（P2）/ 平台内置（P2）；启停用开关调 `setMcpServerEnabled`。
- NewSessionDialog：仅列出 `enabled=true` 的 server；默认不勾选；>8 个时显示搜索框。

### 验收 Checklist

- [ ] 目录页状态与后端一致，开关即时生效
- [ ] 不勾选时 `createSession` 不带 `mcpServerIds`

---

## Phase 6: 移除 mcp-forwarder + 网关路由 + 编排收尾

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/mcp-forwarder/` | 删除 | 整个服务目录 |
| `contracts/gateway-proxy.openapi.yaml` | 修改 | `/mcp/{sessionId}` → agent-api（Phase 1 契约的实现核对） |
| `aspire/AgentGear.AppHost/` | 修改 | agent-api 增加 `MCP_ENDPOINT_JWT_SECRET` / `GATEWAY_URL` 配置 |
| `tests/e2e/src/settings-mcp-proxy.spec.ts` | 修改 | 适配目录页新结构 |

### 验收 Checklist

- [ ] `aspire start` 全量服务拉起，无 mcp-forwarder 残留引用
- [ ] 全局搜索 `MCP_FORWARDER_URL` / `mcp-forwarder` 无遗留

---

## Phase 7: P1 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/agent-api/mcp-entry.test.ts` | 新增 | 入口鉴权/状态/错误码 |
| `tests/api/src/agent-api/mcp-forward.test.ts` | 新增 | Redis 转发 + 双副本持有者应答 |
| `tests/api/src/controller-api/mcp.test.ts` | 修改 | owner 注册表、consumer 行为 |
| `tests/e2e/src/mcp-session.spec.ts` | 新增 | 注册→目录→勾选→会话内工具可用 |

### E2E 主链路

注册代理（mock stdio MCP）→ 目录页可见 → 创建会话勾选 → Agent `tools/list` 含该服务工具 → 调用成功 → 关闭会话 → 旧 endpoint 401。

### 验收 Checklist

- [ ] 新增代码单测覆盖率 ≥ 80%
- [ ] API / E2E 全部通过

---

## Phase 8+（P2 概要，另行细化）

| Phase | 内容 | 关键点 |
|-------|------|--------|
| 8 | 远程 HTTP MCP 绑定 | `bindRemoteMcpServer` Mutation + 连通性探测（initialize/tools/list）+ headers AES 加密 + agent-api 直连分流 |
| 9 | 平台内置 MCP | agent-api `/internal/mcp` 只读 tools（list_sessions/get_session_status）+ 启动幂等 upsert platform server |
| 10 | 工具清单与命名空间 | tools 快照抓取/刷新、`{serverName}__{tool}` 前缀改写、目录页工具清单展示 |

---

## 命令参考

```bash
# 单测（各服务目录下）
npm test                  # vitest run
npm run test:coverage

# API 测试
cd tests/api && npm test          # mock 模式
cd tests/api && npm run test:real # 真实服务

# E2E
cd tests/e2e && npm test

# 全量编排
aspire start
```

## 相关文档

- [[../proposals/20260804-feat-integrated-mcp-registry.md]] — 技术方案 v2.1
- [[../proposals/20260530-feat-mcp-proxy-config.md]] — 前置方案
- [[20260530-feat-mcp-proxy-config.md]] — 前序实现计划
