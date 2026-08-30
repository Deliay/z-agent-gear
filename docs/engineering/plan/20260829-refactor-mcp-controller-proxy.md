---
description: MCP 传递重构一期 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# MCP 传递重构一期（MCP Controller Proxy）- 实现计划

**关联 Proposal**: `proposals/20260829-refactor-mcp-controller-proxy.md`（v1.0）
**关联 PRD**: `docs/product/draft/20260829-mcp-controller-proxy.md`（v1.0）
**feat-branch**: `feat/mcp-controller-proxy`
**创建日期**: 2026-08-29
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约更新（agent-session-websocket.md / agent-controller-websocket.md）
  ├── Phase 2: agent-controller（回环端点 + WebSocket Relay + 注入改写 + 版本 2.0.0）
  ├── Phase 3: controller-api（mcp:request 桥接 + 版本门禁升 major=2）
  └── Phase 4: agent-api（mcp-dispatch 抽取 + relay 消费 + 公网 /mcp 下线 + GATEWAY_URL 移除）
       └── Phase 5: 服务编排（AppHost.cs / docker-compose 移除 GATEWAY_URL）
            └── Phase 6: 服务编排手工验证（Aspire）
                 └── Phase 7: API 测试改造与回归（tests/api）
                      └── Phase 8: E2E 测试改造与回归（tests/e2e）
```

依赖说明：Phase 1 契约先行，是后续所有阶段的输入；Phase 2-4 契约对齐后可并行开发——按 `z-coding` 的子项目并行实现模式，各委托一个 subagent，分别基于 `feat/mcp-controller-proxy` 创建开发分支 `packages/mcp-controller-proxy`、`servers/mcp-controller-proxy-controller`、`servers/mcp-controller-proxy`，完成后各自提 PR 回 `feat/mcp-controller-proxy` 待 review；Phase 5 改动小，随 Phase 4 分支一并提交；测试阶段在全部实现合并后推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现，编码前加载 `docs/engineering/common-rules.md` 及 `backend-rules.md`。

关键约束（提案 §1.2/§5.2，实现期不得回退）：

- Agent 侧只注入 `http://127.0.0.1:{port}` 回环地址，**禁止出现任何指向 agent-api 公网地址的 MCP URL**；回环端点仅监听 `127.0.0.1`。
- MCP 转发必须复用主 WebSocket（不新增连接/namespace）；controller-api ↔ agent-api 走 Redis `mcp:relay:*` 请求-响应，不引入内网 HTTP 回调。
- 单次请求 60s 超时回 504；Controller 断线立即 503 失败全部 pending（不挂起）；会话清理（`acp:stop`/`acp:reconcile`）时失败该会话 pending（410）。
- Token 终验只在 agent-api（签发/吊销状态所在地），controller 本地仅做快速失败。
- 分发行为零回归：`routes/mcp.ts` 的鉴权与分发逻辑**原样**抽取到 `mcp-dispatch.ts`，测试用例平移，输入输出契约不变。
- 本期为 Break Change：版本门禁 major 升至 `2`，旧版控制器被 `VERSION_MISMATCH` 显式拒绝，不做双链路灰度。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session-websocket.md` | 修改 | ① McpEndpoint 结构表（`:120-126`）**移除 `url` 字段**，保留 `token`/`serverNames`（注明回环地址由 agent-controller 本机生成 `http://127.0.0.1:{port}/mcp/{sessionId}/{serverName}`）；② `acp:resume`（§2.11，`:344-371`）payload 表**补登 `mcpEndpoint` 字段**（现状实现已携带但未入契约，`acp-session-manager.ts:480-482`，顺带修正）；③ 新增小节 `mcp:request`（Controller → Server：`requestId/sessionId/serverName/token/body`）与 `mcp:response`（Server → Controller：`requestId/status/body`），含约束：sessionId 归属校验不符回 404、60s 超时 504、断线 503 快速失败、status 取值 200/401/404/410/502/503/504；④ 标注 Socket.IO 单帧体积上限（controller-api `maxHttpBufferSize` 调为 16MB，超限回 502） |
| `contracts/agent-controller-websocket.md` | 修改 | §3.4 版本兼容（`:172-175`）：要求版本由 major `1` 提升为 major `2`，注明一期 Break Change 原因（MCP 公网入口下线，旧版控制器无法提供 MCP 能力）；§2.4 error 表（`:82`）`VERSION_MISMATCH` 补充「客户端应输出升级指引后退出」 |

### 验证

- [ ] 契约与提案 §3.1/§3.2 一致，评审通过后进入 Phase 2-4

---

## Phase 2: agent-controller

开发分支：`packages/mcp-controller-proxy`（基于 `feat/mcp-controller-proxy`）。

TDD 顺序：先写 `local-server.test.ts` / `relay.test.ts` 与 `bridge` 注入改写用例（RED）→ 实现（GREEN）→ 重构清理。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/mcp/local-server.ts` | 新增 | 本机回环 HTTP MCP 端点：`node:http` 无新依赖；守护进程启动时 `server.listen(0, '127.0.0.1')`（ephemeral 端口，全守护进程共享一个端口）；仅支持 POST `/mcp/:sessionId/:serverName`，GET 回 405；请求校验：sessionId 已注册、serverName 在签发快照内、Authorization header 存在（token 正确性由 agent-api 终验，本地仅快速失败回 401/404）；校验通过转交 relay |
| `packages/agent-controller/src/mcp/relay.ts` | 新增 | 回环端点 ↔ 主 WebSocket 转发：生成 `mcpreq_*` requestId，`pendingRequests: Map<requestId, {resolve, timer}>`，60s 超时回 504；socket 断开/未注册完成时全部 pending 立即 503；`sessionEndpoints: Map<sessionId, {token, serverNames}>` 注册表；会话清理（`acp:stop`/`acp:reconcile`）时注销 endpoint 并失败该会话 pending（410） |
| `packages/agent-controller/src/mcp/local-server.test.ts` | 新增 | 用例 T-C1 ~ T-C5 |
| `packages/agent-controller/src/mcp/relay.test.ts` | 新增 | 用例 T-C6 ~ T-C10 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | `AcpBridgeOptions.mcpEndpoint`（`:13`）类型改为 `{ token, serverNames }`（移除 url）；`toMcpEndpointServers()`（`:79-97`）改为按 serverName 生成 `http://127.0.0.1:{port}/mcp/{sessionId}/{encodeURIComponent(name)}`（端口与 sessionId 由 relay/local-server 注册时提供），headers 透传 `Authorization: Bearer {token}` 不变 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | ① `CONTROLLER_VERSION`（`:20`）硬编码 `'1.1.1'` 与 package.json `1.3.0` 不一致——统一提升为 **`'2.0.0'`**（Break Change 新 major）；② `acp:start`（`:309-432`）/`acp:resume`（`:434-522`）收到 `mcpEndpoint` 后调用 relay 注册 sessionEndpoint 再把 `{token, serverNames}` 传入 bridge（`:326`、`:449`）；③ 注册 `mcp:response` handler 按 requestId 分发到 relay；④ `error` handler（`:247-258`）对 `VERSION_MISMATCH` 单独处理：CLI 输出明确升级指引（提示升级 agent-controller 至 2.x）后退出，其余错误行为不变；⑤ `acp:stop`（`:661-703`）/`acp:reconcile`（`:943-977`）触发 relay 会话清理；⑥ `disconnect`（`:1017-1023`）触发 relay 断线快速失败 |
| `packages/agent-controller/package.json` | 修改 | `version` 提升为 `2.0.0`（与 `CONTROLLER_VERSION` 对齐） |
| `packages/agent-controller/tests/`（既有 socketio-client / bridge 相关用例） | 修改 | mcpEndpoint 注入断言由公网 URL 改为 `http://127.0.0.1:*` 形态 |

### 测试用例

| # | 位置 | 用例 | 预期 |
|---|------|------|------|
| T-C1 | local-server.test.ts | POST 已注册 sessionId + 合法 serverName + Bearer header | 转交 relay 并回写响应 |
| T-C2 | local-server.test.ts | 未注册 sessionId / 快照外 serverName / 缺 Authorization | 分别快速失败 404 / 404 / 401 |
| T-C3 | local-server.test.ts | GET 请求 | 405 |
| T-C4 | local-server.test.ts | 监听地址 | 仅绑定 `127.0.0.1`，端口为 ephemeral（>0） |
| T-C5 | local-server.test.ts | 并发请求 | 多个 pending 互不影响，单请求超时不阻塞其他 |
| T-C6 | relay.test.ts | 正常请求-响应 | emit `mcp:request` 携带 `mcpreq_*` requestId，收到 `mcp:response` 按 requestId resolve |
| T-C7 | relay.test.ts | 60s 超时 | 回 504，pending 被清理，后续请求不受影响 |
| T-C8 | relay.test.ts | socket 断开时有 pending | 全部立即 503，不挂起 |
| T-C9 | relay.test.ts | 会话清理（stop/reconcile） | 注销 sessionEndpoint，该会话 pending 410；其他会话不受影响 |
| T-C10 | relay.test.ts | 未知 requestId 的 `mcp:response` | 忽略不抛错 |
| T-C11 | bridge 相关测试 | `toMcpEndpointServers()` 输出 | URL 均为 `http://127.0.0.1:{port}/mcp/{sessionId}/{serverName}`，无公网地址；headers 含 Bearer token |

### 命令参考

```bash
cd packages/agent-controller && npm run build && npm run test
```

### 验收 checklist

- [ ] T-C1 ~ T-C11 通过，既有单测无回归
- [ ] 注入 ACP `session/new.mcpServers` 的 URL 无任何公网地址（grep 验证）
- [ ] `CONTROLLER_VERSION` 与 package.json 均为 `2.0.0`
- [ ] `VERSION_MISMATCH` 时 CLI 输出升级指引

---

## Phase 3: controller-api

开发分支：`servers/mcp-controller-proxy-controller`（基于 `feat/mcp-controller-proxy`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/mcp-relay.ts` | 新增 | 主连接 `mcp:request` 桥接：① 校验 sessionId 归属该 Controller（经 `acp-session-manager` 的 sessions 内存映射 `controllerSocket/controllerId`，`:15-20`——现状无显式归属校验，本模块补齐），不符回 404；② publish Redis `mcp:relay:request` `{requestId, sessionId, serverName, token, body}`；③ `getRedisClient().duplicate()` 一次性订阅 `mcp:relay:response:{requestId}`，收到即回发 `mcp:response` 并退订（沿用 `mcp-forward-consumer.ts:17` 的 duplicate 模式）；④ 60s 超时回 504；⑤ Controller 断开时清理由 Socket.IO disconnect 统一处理，agent-api 侧超时兜底 |
| `servers/controller-api/src/services/mcp-relay.test.ts` | 新增 | 用例 T-S1 ~ T-S5 |
| `servers/controller-api/src/services/socketio.ts` | 修改 | ① 主连接注册 `mcp:request` handler 挂到 mcp-relay；② `CURRENT_MAJOR_VERSION`（`:21`）`'1'` → **`'2'`**（Break Change 门禁提升） |
| `servers/controller-api/src/index.ts` | 修改 | Socket.IO server 初始化 `maxHttpBufferSize` 调为 16MB（MCP 大体积响应，提案实现点 2） |
| `servers/controller-api/src/services/socketio.test.ts` | 修改 | 版本门禁用例（`:253-274`）更新：major `1` 被拒、major `2` 通过 |

### 测试用例

| # | 用例 | 预期 |
|---|------|------|
| T-S1 | `mcp:request` 正常转发 | publish `mcp:relay:request`；收到 `mcp:relay:response:{requestId}` 后向该 socket emit `mcp:response`，一次性订阅退订 |
| T-S2 | sessionId 不属于该 Controller | 直接回 404，不 publish |
| T-S3 | 60s 无响应 | 回 504，退订清理 |
| T-S4 | 并发请求 | 按 requestId 各自匹配，互不串扰 |
| T-S5 | register version major 为 `1` / `2` | `1.x` 收 `VERSION_MISMATCH` 并断开；`2.x` 注册成功 |

### 命令参考

```bash
cd servers/controller-api && npm run build && npm run test
```

### 验收 checklist

- [ ] T-S1 ~ T-S5 通过，既有单测无回归
- [ ] Redis 频道与 payload 与 Phase 1 契约一致

---

## Phase 4: agent-api（核心改造）

开发分支：`servers/mcp-controller-proxy`（基于 `feat/mcp-controller-proxy`）。

TDD 顺序：先将 `routes/mcp.test.ts` 用例**平移**为 `services/mcp-dispatch.test.ts`（输入由 HTTP 请求改为 `{sessionId, serverName, token, body}`，输出由 HTTP 响应改为 `{status, body}`，断言不变）（RED）→ 抽取实现（GREEN）→ 删除路由层。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/mcp-dispatch.ts` | 新增 | 自 `routes/mcp.ts:49-186` **原样抽取**：Bearer JWT 校验（`jwt.verify` + payload.sessionId 比对，失败 401 `ENDPOINT_REVOKED`）→ endpoint 状态校验（`getStatus !== 'active'` 回 401）→ 非 JSON-RPC 回 400 → serverName 解析（path > params.serverName > payload.serverNames[0]，快照外回 `SERVER_NOT_FOUND`）→ `McpServer` 查询 → `platform` 分支（`handleAdminPlatformMcpRequest` / `handlePlatformMcpRequest`，notification 202）→ `registered_proxy` 分支（Redis `mcp:proxy:owner:{serverId}` 无 owner 回 `SERVER_OFFLINE`，`mcpForwarder.request` 转发，`ForwardError` 透传）。签名：`dispatch(input: {sessionId, serverName?, token, body}): Promise<{status, body}>` |
| `servers/agent-api/src/services/mcp-dispatch.test.ts` | 新增 | 平移 `routes/mcp.test.ts` 全部用例（`:104-420`）：401 系列、400 系列、`SERVER_NOT_FOUND`、`SERVER_OFFLINE`、转发成功、`FORWARD_TIMEOUT`/`FORWARD_ERROR`、serverName 路由优先级、未装配拒绝、notification 202、platform server 子块全量 |
| `servers/agent-api/src/services/mcp-relay-consumer.ts` | 新增 | `getRedisClient().duplicate()` 订阅 `mcp:relay:request`，调用 `mcp-dispatch`，publish `mcp:relay:response:{requestId}` `{requestId, status, body}`；异常兜底 `{status: 502, body: FORWARD_ERROR}` |
| `servers/agent-api/src/services/mcp-relay-consumer.test.ts` | 新增 | 用例 T-A1 ~ T-A3 |
| `servers/agent-api/src/routes/mcp.ts` | **删除** | Break Change：公网入口整体下线（含 `:20-35` 请求级日志中间件） |
| `servers/agent-api/src/routes/mcp.test.ts` | **删除** | 用例已平移至 mcp-dispatch.test.ts |
| `servers/agent-api/src/index.ts` | 修改 | 移除 `mcpRouter` import（`:16`）与 `app.use('/mcp', mcpRouter)`（`:52`）；启动时注册 `mcpRelayConsumer.start()`（仿 `:90` `mcpEndpointRevokeSubscriber.start()`） |
| `servers/agent-api/src/services/mcp-endpoint.ts` | 修改 | `McpEndpointInfo`（`:11-15`）移除 `url`，改为 `{ token, serverNames }`；`createEndpoint` 删除 `:70` 的 url 生成；签发/重签/吊销/`getStatus` 逻辑不变（workflow 会话无 TTL 行为不变） |
| `servers/agent-api/src/config/index.ts` | 修改 | 移除 `gatewayUrl`（`:12`）——全仓唯一消费点为 MCP 签发，随之一并下线；`MCP_ENDPOINT_JWT_SECRET`、`mcpEndpointTokenTtl` 不变 |
| 引用 `mcpEndpoint.url` 的下游（`acp-session-manager` 组装 `acp:start`/`acp:resume` payload 处，如 `servers/controller-api/src/services/acp-session-manager.ts:480-482` 的 agent-api 侧来源） | 修改 | payload 不再携带 url；同步检查 GraphQL 契约/类型中 mcpEndpoint 相关字段 |
| 既有 `mcp-endpoint` 相关测试 | 修改 | 返回值断言移除 url |

### 测试用例（新增部分，平移部分不重复列）

| # | 位置 | 用例 | 预期 |
|---|------|------|------|
| T-A1 | mcp-relay-consumer.test.ts | 收到 `mcp:relay:request` | 调用 dispatch 并 publish 响应到 `mcp:relay:response:{requestId}`，payload 含 requestId/status/body |
| T-A2 | mcp-relay-consumer.test.ts | dispatch 抛非预期异常 | publish `{status: 502, body: FORWARD_ERROR}`，进程不崩 |
| T-A3 | mcp-relay-consumer.test.ts | platform 工具经 relay 链路（agent-workflow-tools / admin-tools） | 与平移用例结论一致（PRD 约束：工作流 MCP 能力不断链） |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] 平移用例全绿（分发行为零回归）+ T-A1 ~ T-A3 通过
- [ ] `grep -r "routes/mcp" servers/agent-api/src` 无残留；`/mcp` 挂载已移除（启动后 POST 返回 404）
- [ ] `grep -rn "gatewayUrl\|GATEWAY_URL" servers/agent-api/src` 无残留
- [ ] `createEndpoint`/`reissueEndpoint` 返回 `{token, serverNames}`，签发/吊销语义不变

---

## Phase 5: 服务编排（随 Phase 4 分支提交）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | 移除开发模式 `GATEWAY_URL` 注入（`:93`）与发布模式 `gateway-url` 参数（`:100`） |
| `aspire/manifest/docker-compose.yaml` | 修改 | `aspire publish` 重新生成，移除 `GATEWAY_URL: "${GATEWAY_URL}"`（`:81`） |

### 验收 checklist

- [ ] `aspire start` 全量服务正常启动，agent-api 无 GATEWAY_URL 依赖报错

---

## Phase 6: 服务编排手工验证（Aspire）

```bash
aspire start    # agent-api + controller-api + agent-web + MongoDB + Redis
# 启动 2.0.0 控制器：cd packages/agent-controller && npm run dev -- --key <rawKey> --server <controller-api-endpoint>
```

手工验证（对照 PRD §1.3 成功标准）：

1. 装配 MCP 服务创建会话 → Agent 侧 `session/new.mcpServers` URL 均为 `http://127.0.0.1:*`；工具列举/调用（platform 工具 + 用户注册 mcp-proxy 各一）正常
2. 抓包/防火墙只放行控制器 WebSocket、阻断其他外网 → MCP 调用仍正常
3. 直接 POST agent-api 原公网 `/mcp/{sessionId}` → 404（入口已下线）
4. 会话结束后再调用 → 410/401 明确错误；调用中途关闭控制器 → Agent 立即收到 503 而非挂起
5. 1.x 旧版控制器接入 → 被拒并提示 `VERSION_MISMATCH`，CLI 输出升级指引
6. 工作流实例流转 AI 节点 → 工作流 MCP 工具（agent-workflow-tools / admin-tools）正常（PRD §5.2 约束）

### 验收 checklist

- [ ] 上述 6 项全部符合预期

---

## Phase 7: API 测试改造与回归（tests/api）

按 `z-test` 规范，真实 Mongo/Redis + fake controller 环境。注意 `AGENTS.md` Lessons Learned：**跨服务协议必须有双向集成测试，fake controller 的 `mcp:request`/`mcp:response` 协议处理必须与真实 agent-controller 严格一致**（沿用真实实现的 payload 结构与状态码语义，禁止伪造简化）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/agent-api/mcp-entry.test.ts` | **删除** | 公网入口已下线，401 系列用例已被 mcp-dispatch 单测覆盖 |
| `tests/api/src/controller-api/acp-real-mcp-passthrough.test.ts` | 重写 | 全链路核心受冲击文件：fake controller 改为捕获 `acp:start` 后**模拟真实 agent-controller 行为**——本地起回环端点、经 `mcp:request`/`mcp:response` 转发；断言：mcpEndpoint 无 url 字段（原 `:217-224` 公网 URL 硬断言改为断言回环注入由 controller 生成）、initialize / notification / tools/list / tools/call（`:227-252`）经 WebSocket+Redis 链路全通；真实 opencode agent 端到端用例（`:335-372`）同步适配 |
| `tests/api/src/controller-api/acp-websocket.test.ts` | 修改 | `:226-276` mcpEndpoint 断言更新（无 url，token/serverNames 不变）；fake controller 补齐 `mcp:request` 处理 |
| `tests/api/src/agent-api/workflow.test.ts` | 回归 | 工作流 platform MCP 相关用例全绿 |

### 关键测试场景（对照提案 §8.3）

| 场景 | 预期 |
|------|------|
| 装配 MCP 创建会话 | acp:start 的 mcpEndpoint 仅含 token/serverNames |
| tools/call（platform） | 经 relay → Redis → mcp-dispatch 返回正确结果 |
| tools/call（registered_proxy） | 经 relay → mcp-dispatch → mcp:forward → mcp-proxy 返回正确结果 |
| 无效/过期 token、吊销后调用 | 401 / 410 沿链路透传 |
| sessionId 归属不符 | controller-api 回 404 |
| 60s 超时 | 504，后续请求不受影响 |
| 旧 major 版本 fake controller 注册 | `VERSION_MISMATCH` |

### 验收 checklist

- [ ] `tests/api` 全量通过

---

## Phase 8: E2E 测试改造与回归（tests/e2e）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/e2e/src/mcp-session.spec.ts` | 修改 | 移除「直接 POST `${GATEWAY_URL}/mcp/...` 未认证拒绝」用例（`:99-100`，公网入口已下线）；装配 MCP 创建会话 UI 链路（`:30-31`）保留并验证工具可用 |
| `tests/e2e/src/settings-mcp-proxy.spec.ts`、`workflow.spec.ts` | 回归 | 无改动预期，全量回归 |

### 验收 checklist

- [ ] `tests/e2e` 全量通过（Aspire 编排环境，与 API 套件串行执行）

---

## 总验收 checklist（对照提案 §10 / PRD §1.3）

- [ ] Agent 的 MCP 请求不再出现指向 agent-api 公网地址的流量（注入 URL 全为 `http://127.0.0.1:*`）
- [ ] 回环端点仅监听 `127.0.0.1`
- [ ] platform / registered_proxy 两类 MCP Server 工具调用全链路通过
- [ ] 平台公网 `/mcp` 入口下线（404），`GATEWAY_URL` 配置全仓移除
- [ ] 会话吊销（410/401）、60s 超时（504）、断线（503）、归属不符（404）等异常路径行为符合契约
- [ ] 旧版（major 1）控制器被版本门禁拒绝，CLI 输出明确升级指引
- [ ] 工作流 MCP 工具能力无回退
- [ ] 新增/修改模块单测覆盖率 ≥ 80%，单测 / API / E2E 全绿
- [ ] `packages/`、`servers/`（×2）三个开发分支 PR review 通过并合并回 `feat/mcp-controller-proxy`
