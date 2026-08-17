# Agent Controller WebSocket Protocol v1

## 1. 概述

定义 Agent 控制器守护进程与 controller-api 之间的 WebSocket 通信契约。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| Controller | 运行在用户机器上的守护进程（Socket.IO 客户端） |
| controller-api | 中央服务器的 Socket.IO 服务端 |

### 1.2 传输层

- 协议：Socket.IO v4+
- 传输：WebSocket（强制，不使用 HTTP 长轮询）
- 客户端自动重连：指数退避（初始 1s，最大 60s）

---

## 2. 事件协议

### 2.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Controller → Server | `register` | 连接后立即发送，用于身份认证 |
| Server → Controller | `registered` | 注册认证成功 |
| Server → Controller | `error` | 注册认证失败 |
| Controller → Server | `heartbeat` | 每 30s 发送一次，维持在线状态 |
| Controller → Server | `unregister` | 控制器主动注销 |
| Server → Controller | `unregistered` | 注销成功确认 |
| Server → Controller | `shutdown` | 服务器强制断开连接 |
| Server → Controller | `acp:reconcile` | 重连后下发权威存活 sessionId 列表 |

### 2.2 `register`（Controller → Server）

连接建立后客户端发送的第一个事件。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | `string` | 是 | 完整控制器 Key |
| `hostname` | `string` | 是 | 机器主机名 |
| `version` | `string` | 是 | 控制器 semver 版本号（如 `1.2.3`） |

### 2.3 `registered`（Server → Controller）

注册成功响应。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `controllerId` | `string` | 是 | 服务端分配的控制器 ID |

**客户端行为：** 收到后开始每 30s 发送 `heartbeat`。

### 2.4 `error`（Server → Controller）

注册失败响应。服务端发送后立即断开连接。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | `ErrorCode` | 是 | 错误码 |
| `message` | `string` | 是 | 错误描述 |

**ErrorCode 枚举：**

| 值 | 含义 |
|----|------|
| `INVALID_KEY` | Key 无效（缓存中不存在或 bcrypt 验证失败） |
| `KEY_ALREADY_ONLINE` | 该 Key 已有活跃 session |
| `VERSION_MISMATCH` | 控制器版本不兼容 |
| `RATE_LIMITED` | 注册频率超限 |

### 2.5 `heartbeat`（Controller → Server）

周期性心跳。

**Payload：** 空对象 `{}`

**服务端行为：** 刷新 session TTL。

### 2.6 `unregister`（Controller → Server）

控制器主动通知服务端即将断开。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | `string` | 是 | `user_detach` 或 `process_exit` |

**服务端行为：**

1. 删除 Controller 记录
2. 删除 Key 记录
3. 清理 session
4. 回复 `unregistered`

### 2.7 `unregistered`（Server → Controller）

注销成功确认。

**Payload：** 空对象 `{}`

**客户端行为：** 清除本地配置中的 Key，退出进程。

### 2.8 `shutdown`（Server → Controller）

服务端强制断开。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | `string` | 是 | `key_revoked` |

**客户端行为：** 清除本地配置中的 Key，退出进程。

---

## 3. 连接生命周期

```
Controller                 controller-api
    │                            │
    │──Socket.IO connect─────────│
    │                            │
    │──emit("register")─────────│
    │                            ├──验证 Key
    │                            ├──检查 session 独占
    │                            │
    │  ←──emit("registered")────│  成功
    │                            │
    │  ──emit("heartbeat")────→ │  每 30s
    │                            │
    │  ──emit("unregister")────→│  主动注销
    │  ←──emit("unregistered")──│
    │                            │
    │  ←──emit("shutdown")──────│  服务端强制
```

### 3.1 心跳超时检测

- 控制器每 30s 发送 `heartbeat`
- 服务端每 15s 扫描：超过 60s 未收到心跳的 online 控制器标记为 offline
- 60s = 2 次心跳间隔 + 缓冲

### 3.2 速率限制

| 事件 | 限制 | 依据 |
|------|------|------|
| `register` | 每分钟最多 10 次 | 按 IP |
| `heartbeat` | 每 15s 最多 1 次 | 按 keyId |

### 3.3 单 session 控制

- 注册时检查该 Key 是否已有活跃 session
- 已存在则拒绝新连接，返回 `KEY_ALREADY_ONLINE`
- 断开时清理 session

### 3.4 版本兼容

- 服务端校验 `version` major 字段
- major 不匹配时返回 `VERSION_MISMATCH`

### 3.5 Key 生命周期

- 每个帐号仅允许一个未绑定的 Key
- 生成新 Key 时自动替换旧的未绑定 Key
- Key 绑定到控制器后永久生效（无过期/撤销）
- 解绑或注销时，Key 和 Controller 记录均被永久删除

### 3.6 重连对账

Controller 重连注册后，Server 下发 `acp:reconcile` 事件，Controller 据此清理孤儿进程和待清理会话。

#### `acp:reconcile`（Server → Controller）

Controller 重连注册成功后，Server 立即下发此事件。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `activeSessionIds` | `string[]` | 是 | 当前该 Controller 下所有活跃 Session ID 列表（权威来源） |
| `pendingKillSessionIds` | `string[]` | 是 | 需要强制终止的 Session ID 列表（待清理） |

**客户端行为：**

1. 遍历本地进程注册表（`~/.zag/processes.json`）中的每个进程
2. 对 `pendingKillSessionIds` 中的每个 sessionId：按注册表 PID 强制 kill 进程组，然后注销
3. 对注册表中存在但不在 `activeSessionIds` 中的条目（孤儿进程）：kill 进程组并注销
4. 对注册表中存在且在 `activeSessionIds` 中的条目：保留（正常运行）
