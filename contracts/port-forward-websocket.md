# Port Forward WebSocket Protocol v1

## 1. 概述

定义端口转发功能中 controller-api 与 agent-controller 之间的 Socket.IO 通信契约。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| controller-api | 中央服务器的 Socket.IO 服务端 |
| agent-controller | 运行在用户机器上的 Socket.IO 客户端 |

### 1.2 传输层

- 协议：Socket.IO v4+
- 传输：WebSocket（强制）
- 数据编码：Buffer（二进制中继）

---

## 2. 事件协议

### 2.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Server → Controller | `port-forward:create` | 请求建立到本地端口的隧道 |
| Controller → Server | `port-forward:created` | 隧道建立结果 |
| 双向 | `port-forward:data` | 隧道数据传输 |
| 双向 | `port-forward:close` | 关闭隧道 |
| Controller → Server | `port-forward:error` | 隧道错误 |

### 2.2 `port-forward:create`（Server → Controller）

请求 agent-controller 建立到本地端口的 TCP 连接隧道。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tunnelId` | `string` | 是 | 隧道唯一标识（格式：`{controllerId}:{port}:{uuid}`） |
| `port` | `number` | 是 | 目标本地端口号（1-65535） |

**客户端行为：**

1. 使用 `net.connect({ host: '127.0.0.1', port })` 连接本地端口
2. 连接成功：存储隧道，回复 `port-forward:created`（success: true）
3. 连接失败：回复 `port-forward:created`（success: false, error: 错误描述）
4. 本地 socket 收到数据：发送 `port-forward:data` 到服务端
5. 服务端发来 `port-forward:data`：写入本地 socket

### 2.3 `port-forward:created`（Controller → Server）

隧道建立结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tunnelId` | `string` | 是 | 隧道唯一标识 |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string` | 否 | 失败原因（success=false 时） |

### 2.4 `port-forward:data`（双向）

隧道数据传输。在 controller-api 和 agent-controller 之间双向中继。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tunnelId` | `string` | 是 | 隧道唯一标识 |
| `data` | `Buffer` | 是 | 原始字节数据 |

**行为：**

- **agent-controller → controller-api**：本地 socket 收到的数据，原样中继
- **controller-api → agent-controller**：外部请求的数据，写入本地 socket
- controller-api 收到数据后，匹配到对应的代理请求上下文，返回响应

### 2.5 `port-forward:close`（双向）

关闭隧道。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tunnelId` | `string` | 是 | 隧道唯一标识 |

**行为：**

- 任意一方发送后，双方清理对应隧道资源
- agent-controller：关闭本地 socket，从隧道 Map 中移除
- controller-api：清理代理请求上下文

### 2.6 `port-forward:error`（Controller → Server）

隧道错误通知。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tunnelId` | `string` | 是 | 隧道唯一标识 |
| `error` | `string` | 是 | 错误描述 |

**触发场景：**

- 本地 socket 读写错误
- 本地 socket 异常关闭

**服务端行为：** 清理对应隧道的代理请求上下文，返回 502 给代理请求方。

---

## 3. 隧道生命周期

```
controller-api                     agent-controller
    │                                    │
    │──emit("port-forward:create")──────→│
    │                                    ├──net.connect(localhost:port)
    │  ←──emit("port-forward:created")───│  成功
    │                                    │
    │  ══双向数据中继 (port-forward:data)══│
    │                                    │
    │──emit("port-forward:close")───────→│  主动关闭
    │  或                                 │
    │  ←──emit("port-forward:close")─────│  本地关闭
    │  或                                 │
    │  ←──emit("port-forward:error")─────│  错误
```

### 3.1 隧道 ID 规范

格式：`{controllerId}:{port}:{uuid}`

- `controllerId`：Controller 的 ObjectId
- `port`：目标本地端口号
- `uuid`：随机 UUID v4，确保唯一性

### 3.2 资源清理

- agent-controller 断开连接时：关闭所有活跃隧道
- controller-api 收到 `port-forward:close` 或 `port-forward:error`：清理代理请求上下文
- 代理请求超时（30s）：自动关闭隧道

### 3.3 错误处理

| 场景 | agent-controller 行为 | controller-api 行为 |
|------|----------------------|---------------------|
| 本地端口无服务 | 回复 created(success=false, error="ECONNREFUSED") | 返回 502 |
| 本地 socket 异常关闭 | 发送 close 或 error | 清理上下文，返回 502 |
| 隧道不存在 | 忽略 data 事件 | 忽略 |
