# MCP Forward Redis 请求-响应协议

## 1. 概述

定义 agent-api MCP 入口与 controller-api 副本之间通过 Redis 完成的 MCP 请求-响应转发契约。复用 `port-forward:command/response` 既有模式，解决 controller-api 多副本部署下请求落点与代理连接持有者解耦的问题。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| agent-api | MCP 入口，发布转发请求并匹配响应 |
| controller-api 副本 | 订阅请求频道，仅**本地持有目标代理活跃 socket** 的副本处理并响应 |

### 1.2 传输层

- 基于 Redis Pub/Sub
- 消息均为 JSON 序列化
- 每个 controller-api 副本启动时生成进程级 `instanceId`（crypto.randomUUID）

---

## 2. 频道

| 频道 | 发布者 | 订阅者 | 说明 |
|------|--------|--------|------|
| `mcp:forward:request` | agent-api | 全部 controller-api 副本 | 广播 MCP 请求 |
| `mcp:forward:response` | controller-api（持有连接者） | agent-api | 返回 MCP 响应 |

---

## 3. 消息结构

### 3.1 request（`mcp:forward:request`）

```json
{
  "requestId": "uuid",
  "serverId": "string",
  "sessionId": "string",
  "request": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {}
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于关联响应 |
| `serverId` | `string` | 是 | 目标 McpServer ID |
| `sessionId` | `string` | 是 | 会话 ID |
| `request` | `object` | 是 | JSON-RPC 请求体 |

### 3.2 response（`mcp:forward:response`）

```json
{
  "requestId": "uuid",
  "response": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {}
  }
}
```

或错误：

```json
{
  "requestId": "uuid",
  "error": {
    "code": "FORWARD_ERROR",
    "message": "string"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `response` | `object` | 否 | JSON-RPC 响应（成功时） |
| `error` | `object` | 否 | `{ code, message }` 错误信息（失败时） |

---

## 4. 多副本寻址规则

1. agent-api 先查询 Redis 所有权注册表 `mcp:proxy:owner:{serverId}`（值为副本 `instanceId`，TTL 45s，代理注册/心跳时刷新，断开时删除）。
2. **无 owner → 直接返回 `SERVER_OFFLINE`**（fail-fast，不广播，不等待超时）。
3. 有 owner → 广播 `mcp:forward:request`；各副本检查本地 `McpProxyRegistry` 是否持有该 `serverId` 的活跃 socket，**仅持有者**经 `/mcp-proxy` namespace 发 `proxy:request` 并等待 ack，随后 publish 响应。
4. agent-api 按 `requestId` 匹配响应，**30s 超时**返回 `FORWARD_TIMEOUT`。

---

## 5. 所有权注册表

| Key | 内容 | TTL | 写入时机 | 删除时机 |
|-----|------|-----|---------|---------|
| `mcp:proxy:owner:{serverId}` | 副本 instanceId | 45s | `proxy:register` / `proxy:heartbeat` | `proxy:unregister` / socket 断开 |

---

## 6. 错误码

| 错误码 | 含义 | 触发方 |
|--------|------|--------|
| `SERVER_OFFLINE` | 无 owner（代理离线） | agent-api（fail-fast） |
| `ENDPOINT_REVOKED` | endpoint 状态非 active | agent-api 入口 |
| `FORWARD_TIMEOUT` | 30s 内无匹配响应 | agent-api |
| `SERVER_NOT_FOUND` | server 不存在或已停用 | agent-api 入口 |
| `FORWARD_ERROR` | 持有者转发异常 | controller-api |

---

## 7. `_meta` 链路传播保留位

平台 Redis 频道报文允许携带顶层 `_meta` 字段，用于 W3C Trace Context 传播（详见 [`observability.md`](./observability.md) §4）：

```jsonc
{
  "…报文既有字段…": "…",
  "_meta": { "traceparent": "00-<trace-id>-<span-id>-<flags>" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_meta.traceparent` | `string` | 否 | W3C `traceparent`；无效 / 缺失时忽略，不得报错 |

- 发布方经共享模块 `publishJson`（`packages/observability`）统一注入；**消费者必须容忍 `_meta` 缺失**（历史报文兼容）。
- `_meta` 为平台保留位，不得与业务字段冲突；消费方不得把 `_meta` 转发进 ACP payload。
- 受影响频道清单：`session:command`、`session:message`、`session:status`、`permission:*`、`elicitation:*`、`harness:login:*`、`mcp:*`、`pr:check-run`。
