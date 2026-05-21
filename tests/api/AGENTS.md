# API Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed
- Docker running (for MongoDB container)

## 启动服务

```bash
# 启动 Aspire 编排（在项目根目录）
aspire start

# 等待后端服务就绪
aspire wait agent-api
```

## 获取 API 端点

```bash
# 查看 agent-api 的地址
aspire describe agent-api
```

输出中查找 `agent-api` 的 URL，例如 `http://localhost:4000`。

## 运行测试

```bash
# 获取各服务 endpoint
API_URL=$(aspire describe agent-api --format Json 2>/dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).resources[0].urls.find(u=>u.name==='http').url+'/graphql')")
CONTROLLER_URL=$(aspire describe controller-api --format Json 2>/dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).resources[0].urls.find(u=>u.name==='http').url)")

API_URL=$API_URL CONTROLLER_API_URL=$CONTROLLER_URL npm test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_URL` | agent-api GraphQL 完整地址 | `http://localhost:4000/graphql` |
| `CONTROLLER_API_URL` | controller-api 服务地址 | `http://localhost:4001` |

## 测试清单

### Auth API (`auth.test.ts`)

| 测试 | 描述 |
|------|------|
| signup - 创建用户 | 应返回 token 和用户信息 |
| signup - 重复用户名 | 应返回错误「Username already taken」 |
| signup - 用户名过短 | 应返回用户名校验错误 |
| signup - 密码过短 | 应返回密码校验错误 |
| login - 正确凭证 | 应返回 token 和用户信息 |
| login - 错误密码 | 应返回「Invalid username or password」 |
| login - 不存在的用户 | 应返回「Invalid username or password」 |
| me - 未认证 | 应返回 null |
| me - 已认证 | 应返回当前用户信息 |

### LLM Provider & Model API (`llm.test.ts`)

| 测试 | 描述 |
|------|------|
| providers query - 无 token | 应返回「Not authenticated」 |
| models query - 无 token | 应返回「Not authenticated」 |
| providers query - 已认证 | 应返回空列表 |
| models query - 已认证 | 应返回空列表 |
| createProvider - 无效 endpoint | 应返回连通性测试失败 |
| createProvider - 空名称 | 应返回校验错误 |
| createProvider - 无 auth | 应返回「Not authenticated」 |
| batchEnable - 空列表 | 应返回 successCount=0 |
| batchDisable - 空列表 | 应返回 successCount=0 |
| batchDelete - 空列表 | 应返回 successCount=0 |
| batchEnable - 无 auth | 应返回「Not authenticated」 |
| toggleProvider - 不存在的 provider | 应返回「Provider not found」 |
| toggleProvider - 无 auth | 应返回「Not authenticated」 |
| deleteProvider - 不存在的 provider | 应返回 false |
| updateProvider - 不存在的 provider | 应返回「Provider not found」 |
| createCustomModel - 无 auth | 应返回「Not authenticated」 |
| toggleModel - 无 auth | 应返回「Not authenticated」 |
| updateModelSortOrder - 无 auth | 应返回「Not authenticated」 |

### Controller Key API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllerKeys query - 无 token | 应返回「Not authenticated」 |
| controllers query - 无 token | 应返回「Not authenticated」 |
| controller query - 无 token | 应返回「Not authenticated」 |
| createControllerKey - 无 auth | 应返回「Not authenticated」 |
| createControllerKey - 正常创建 | 应返回 key 和 rawKey（zag_k_ 前缀） |
| createControllerKey - 空名称 | 应返回校验错误 |
| createControllerKey - 替换未绑定 key | 生成新 key 时自动删除旧的未绑定 key |
| controllerKeys query - 已认证 | 应返回未绑定 key 列表（含 rawKey），不返回已绑定 key |
| renameControllerKey - 无 auth | 应返回「Not authenticated」 |
| renameControllerKey - 正常重命名 | 应返回新 name |
| renameControllerKey - 不存在的 key | 应返回错误 |

### Controller Management API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllers query - 已认证 | 应返回空列表 |
| controller query - 不存在 | 应返回 null |
| renameController - 无 auth | 应返回「Not authenticated」 |
| renameController - 不存在 | 应返回「Controller not found」 |
| unbindController - 无 auth | 应返回「Not authenticated」 |
| unbindController - 不存在 | 应返回 false |

### Controller Online Status (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| register 后查询 controller | status 应为 online，hostname/version 正确 |
| controllers 列表包含在线 controller | 应包含 status=online 的记录 |
| unregister 后 controller 和 key 应被删除 | 查询应返回 null |
| unbind 后 controller 和 key 应被删除 | GraphQL unbind 后查询应返回 null |
| register 后 controllerKeys.lastUsedAt | 应更新为非 null |

### Controller WebSocket API (`controller-api/websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| register - 有效 key | 应返回 controllerId |
| register - 无效 key | 应返回 INVALID_KEY 并断开 |
| register - 版本不匹配 | 应返回 VERSION_MISMATCH 并断开 |
| heartbeat - 已认证客户端 | 应接受心跳，连接保持在线 |
| unregister - 主动注销 | 应删除 key 和 controller 记录并断开 |
| session 独占 - 重复 key | 第二个连接应收到 KEY_ALREADY_ONLINE |

### Session API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| sessions query - 无 token | 应返回「Not authenticated」 |
| session query - 无 token | 应返回「Not authenticated」 |
| createSession - 无 auth | 应返回「Not authenticated」 |
| createSession - 正常创建 | 应返回 session（status=creating） |
| createSession - 无效 controllerId | 应返回「Controller not found」 |
| sessions query - 已认证 | 应返回 sessions 列表 |
| session query - 已存在的 session | 应返回 session 详情 |
| session query - 不存在的 session | 应返回 null |
| sendSessionMessage - 正常发送 | 应返回 input 方向消息 |
| sendSessionMessage - 不存在的 session | 应返回错误 |
| sessionMessages query - 已有消息 | 应返回消息列表 |
| sessionMessages query - 不存在的 session | 应返回错误 |
| closeSession - 正常关闭 | 应返回 true，status 变为 ended |
| deleteSession - 正常删除 | 应返回 true，session 不再存在 |
| acpCapabilities - 已认证 | 应返回 capabilities 列表 |
| acpCapabilities - 不存在的 controller | 应返回错误 |

### Session SSE API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| 未认证 SSE 连接 | 应返回 401 |
| 不存在的 session SSE | 应返回 404 |
| 正常 SSE 连接 | 应返回 200 + event-stream，发送 history |

### Controller ACP WebSocket (`controller-api/acp-websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| acp:check | 应请求检测并返回 servers 列表 |
| acp:start | 应发送启动请求，controller 响应 success |
| acp:message | 应转发 controller 输出消息 |
| acp:stop | 应发送停止请求，controller 响应 stopped |

### End-to-End: Session 全链路 (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| create → acp:start → success → verify running | 创建 session → fake controller 收到 acp:start → 响应 success → 查询 session status=running |
| create → acp:start → failure → verify ended | 创建 session → fake controller 响应 failure → 查询 session status=ended |
| create → send message → controller receive → output persisted | 创建 session → GraphQL 发消息 → fake controller 收到 acp:message → 模拟输出 → 查询消息列表验证 input+output 都持久化 |

### History Session Sync API (`agent-api/history-session-sync.test.ts`)

| 测试 | 描述 |
|------|------|
| listHistorySessions - 无 token | 应返回「Not authenticated」 |
| listHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| listHistorySessions - 不存在的 workspace | 应返回「Workspace not found」 |
| listHistorySessions - 正常返回 | 通过 fake controller 响应返回 history session 列表 |
| importHistorySessions - 无 token | 应返回「Not authenticated」 |
| importHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| importHistorySessions - 导入单个 session | 导入 1 个 session，验证 messageCount=2 |
| importHistorySessions - 导入多个 session | 导入 2 个 session，验证都存在并 status=ended |
| importHistorySessions - 去重过滤 | 先导入 acp_sync_sess_1，list 应返回 acp_sync_sess_2 但排除 s1 |
