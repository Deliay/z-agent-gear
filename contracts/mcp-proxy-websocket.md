# MCP Proxy 注册 WebSocket 协议

## 1. 概述

定义本地 MCP 代理（agent-gear mcp-proxy）与 controller-api 之间的 WebSocket 通信契约。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| Proxy | 运行在用户机器上的 mcp-proxy 进程（Socket.IO 客户端） |
| controller-api | 中央服务器的 Socket.IO 服务端 |

### 1.2 传输层

- 协议：Socket.IO v4+
- 传输：WebSocket（强制）
- 客户端自动重连：指数退避（初始 1s，最大 60s）

---

## 2. 事件协议

### 2.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Proxy → Server | `proxy:register` | 连接后立即发送，用于身份认证 |
| Server → Proxy | `proxy:registered` | 注册认证成功 |
| Server → Proxy | `proxy:error` | 注册认证失败 |
| Proxy → Server | `proxy:heartbeat` | 每 30s 发送一次，维持在线状态 |
| Server → Proxy | `proxy:request` | 转发 MCP 请求到本地代理 |
| Proxy → Server | `proxy:response` | 返回 MCP 响应 |
| Proxy → Server | `proxy:unregister` | 代理主动注销 |
| Server → Proxy | `proxy:unregistered` | 注销成功确认 |
| Server → Proxy | `proxy:shutdown` | 服务器强制断开连接 |

### 2.2 `proxy:register`（Proxy → Server）

连接建立后客户端发送的第一个事件。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxyId` | `string` | 是 | 注册时分配的代理 ID |
| `key` | `string` | 是 | MCP Proxy Key |

### 2.3 `proxy:registered`（Server → Proxy）

注册成功响应。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxyId` | `string` | 是 | 代理 ID |
| `serverId` | `string` | 是 | 关联的 McpServer ID |

### 2.4 `proxy:error`（Server → Proxy）

注册失败响应。服务端发送后立即断开连接。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | `string` | 是 | 错误码 |
| `message` | `string` | 是 | 错误描述 |

**ErrorCode 枚举：**

| 值 | 含义 |
|----|------|
| `INVALID_KEY` | Key 无效 |
| `PROXY_NOT_FOUND` | 代理 ID 不存在 |
| `ALREADY_REGISTERED` | 代理已注册 |

### 2.5 `proxy:heartbeat`（Proxy → Server）

周期性心跳。

**Payload：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxyId` | `string` | 是 | 代理 ID |

### 2.6 `proxy:request`（Server → Proxy）

转发 MCP 请求到本地代理。

**Payload：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID |
| `request` | `object` | 是 | JSON-RPC 请求 |

### 2.7 `proxy:response`（Proxy → Server）

返回 MCP 响应。

**Payload：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `response` | `object` | 是 | JSON-RPC 响应 |

### 2.8 `proxy:unregister`（Proxy → Server）

代理主动通知服务端即将断开。

**Payload：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxyId` | `string` | 是 | 代理 ID |

### 2.9 `proxy:unregistered`（Server → Proxy）

注销成功确认。

### 2.10 `proxy:shutdown`（Server → Proxy）

服务端强制断开。

---

## 3. 连接生命周期

```
Proxy                    controller-api
    │                            │
    │──Socket.IO connect─────────│
    │                            │
    │──emit("proxy:register")───│
    │                            ├──验证 Key
    │                            ├──查找 McpServer
    │                            │
    │  ←──emit("proxy:registered")──│  成功
    │                            │
    │  ──emit("proxy:heartbeat")──→ │  每 30s
    │                            │
    │  ←──emit("proxy:request")──│  MCP 请求
    │  ──emit("proxy:response")──→ │  MCP 响应
    │                            │
    │  ──emit("proxy:unregister")──→ │  主动注销
    │  ←──emit("proxy:unregistered")──│
    │                            │
    │  ←──emit("proxy:shutdown")──│  服务端强制
```
