# Agent Session WebSocket Protocol v1

## 1. 概述

定义 Agent Session 相关的 WebSocket 通信契约，扩展 `agent-controller-websocket.md` 中的基础协议。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| Controller | 运行在用户机器上的守护进程（Socket.IO 客户端） |
| controller-api | 中央服务器的 Socket.IO 服务端 |

### 1.2 依赖

- 基于 `agent-controller-websocket.md` v1 协议
- 控制器必须先完成 `register` 认证后才能使用 ACP 事件

---

## 2. ACP 事件协议

### 2.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Server → Controller | `acp:check` | 请求检测 ACP 能力 |
| Controller → Server | `acp:check:result` | 返回检测结果 |
| Server → Controller | `acp:start` | 启动 ACP Session |
| Controller → Server | `acp:start:result` | 启动结果 |
| Server → Controller | `acp:resume` | 恢复已有 ACP Session |
| Controller → Server | `acp:resume:result` | 恢复结果 |
| Server → Controller | `acp:message` | 转发前端输入 |
| Controller → Server | `acp:message` | 转发 ACP 输出 |
| Server → Controller | `acp:cancel` | 取消当前生成（不结束 session） |
| Server → Controller | `acp:stop` | 停止 ACP Session |
| Controller → Server | `acp:stopped` | ACP Session 已停止 |

### 2.2 `acp:check`（Server → Controller）

请求检测控制器支持的 ACP Server。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |

**客户端行为：**

1. 检测本地支持的 ACP Server
2. 缓存检测结果（TTL 1小时）
3. 回复 `acp:check:result`

### 2.3 `acp:check:result`（Controller → Server）

返回 ACP 能力检测结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `servers` | `AcpServerInfo[]` | 是 | 可用的 ACP Server 列表 |

**AcpServerInfo 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 是 | ACP Server 类型（`opencode`） |
| `available` | `boolean` | 是 | 是否可用 |
| `version` | `string` | 否 | 版本号（可用时返回） |

**OpenCode 检测方式：** 执行 `opencode -v`，解析版本号。

### 2.4 `acp:start`（Server → Controller）

请求启动 ACP Session。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID |
| `sessionId` | `string` | 是 | Session ID（服务端分配） |
| `serverType` | `string` | 是 | ACP Server 类型（`opencode`） |
| `cwd` | `string` | 是 | 工作目录（绝对路径） |
| `mcpServers` | `McpServerConfig[]` | 否 | MCP Server 配置（预留） |

**McpServerConfig 结构（预留）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | Server 名称 |
| `command` | `string` | 是 | 启动命令 |
| `args` | `string[]` | 否 | 命令参数 |

**客户端行为：**

1. 拉起 `opencode acp` 进程
2. 建立 stdio JSON-RPC 通信
3. 回复 `acp:start:result`
4. 开始转发 ACP 消息

### 2.5 `acp:start:result`（Controller → Server）

返回 ACP Session 启动结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `sessionId` | `string` | 是 | Session ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string` | 否 | 失败原因 |
| `externalSessionId` | `string` | 否 | ACP 返回的 Session ID（ACP agent 侧会话标识） |

**服务端行为：**

成功时（`success: true`）：
1. 将 `externalSessionId` 持久化到 MongoDB Session 文档
2. 在 Redis 中缓存映射关系 `session:{sessionId}:acpSessionId = externalSessionId`（TTL 24h）
3. 注册 session WebSocket 映射
4. 发布 `session:status`（含 `externalSessionId`）

### 2.6 `acp:message`（Server → Controller）

转发前端输入到 Controller。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `message` | `AcpMessage` | 是 | 消息内容 |

**AcpMessage 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 是 | 消息类型（`text`） |
| `content` | `string` | 是 | 消息内容 |

**客户端行为：** 将消息写入 OpenCode 的 stdin（JSON-RPC 格式）。

### 2.7 `acp:message`（Controller → Server）

Controller 转发 ACP 输出。

**Payload:**

| 字段 | 类段 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `message` | `AcpMessage` | 是 | 消息内容 |

**AcpMessage 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 是 | 消息类型（`text`/`tool_call`/`tool_result`/`plan`/`error`） |
| `content` | `string` | 是 | 消息内容 |
| `metadata` | `object` | 否 | 额外数据（如 tool name、status） |

**服务端行为：**

1. 持久化消息到 MongoDB
2. 通过 Redis Pub/Sub 通知 agent-api
3. agent-api 推送到 SSE 连接

### 2.8 `acp:stop`（Server → Controller）

请求停止 ACP Session。与 `acp:cancel` 不同，此操作结束整个 session。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |

**客户端行为：**

1. 调用 SDK `connection.cancel()` — 取消当前生成（如有）
2. 调用 SDK `connection.closeSession()` — ACP 协议关闭 session
3. 发送 SIGTERM 到 OpenCode 进程
4. 等待进程退出（最多 5s）
5. 如果未退出，发送 SIGKILL
6. 清理资源
7. 回复 `acp:stopped`

### 2.9 `acp:stopped`（Controller → Server）

通知 ACP Session 已停止。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `reason` | `string` | 是 | 停止原因（`user_close`/`agent_exit`/`error`） |
| `exitCode` | `number` | 否 | 进程退出码（agent_exit/error 时返回） |

**服务端行为：**

1. 更新 Session status = ended
2. 通过 Redis Pub/Sub 通知 agent-api
3. 清理 WebSocket 映射

### 2.10 `acp:cancel`（Server → Controller）

请求取消当前生成。与 `acp:stop` 不同，此操作仅取消正在进行的 prompt，**不结束 session**。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |

**客户端行为：**

1. 调用 SDK `connection.cancel()` — 发送 `session/cancel` 通知
2. 拒绝当前正在进行的 `prompt()` promise
3. 保持 SIGTERM/SIGKILL，不关闭 session
4. **不回复任何事件**（cancel 是单向通知）

**服务端行为：**

1. 不修改 session 状态
2. 不清理 WebSocket 映射

### 2.11 `acp:resume`（Server → Controller）

请求恢复已有 ACP Session。用于断线重连后重新建立与已有 ACP session 的通信。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配结果 |
| `sessionId` | `string` | 是 | Session ID（服务端分配） |
| `externalSessionId` | `string` | 是 | ACP 返回的原始 Session ID |
| `cwd` | `string` | 是 | 工作目录（绝对路径） |

**客户端行为：**

1. 拉起 `opencode acp` 进程（如尚未运行）
2. 建立 stdio JSON-RPC 通信
3. 调用 SDK `connection.initialize()` — 不声明 `fs`/`terminal` 能力
4. 调用 SDK `connection.resumeSession({ sessionId: externalSessionId })`
5. 如果 agent 不支持 `session.resume`，fallback 到 `newSession`
6. 回复 `acp:resume:result`

### 2.12 `acp:resume:result`（Controller → Server）

返回 ACP Session 恢复结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `sessionId` | `string` | 是 | Session ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string` | 否 | 失败原因（`session.resume` 不支持时 fallback 到 `newSession`） |

**服务端行为：**

1. 成功时：注册 session mapping，更新 status = running
2. 失败时：fallback 到 `acp:start` 流程（创建新 ACP session）

---

## 3. 跨服务事件（Redis Pub/Sub）

### 3.1 频道定义

| 频道 | 方向 | 说明 |
|------|------|------|
| `session:message` | controller-api → agent-api | 新消息通知 |
| `session:status` | controller-api → agent-api | Session 状态变更 |
| `session:command` | agent-api → controller-api | 命令下发 |

### 3.2 `session:message`

新消息持久化后通知 agent-api 推送。

**Payload:**

```json
{
  "sessionId": "string",
  "message": {
    "id": "string",
    "direction": "input | output",
    "type": "text | tool_call | tool_result | plan | error",
    "content": "string",
    "metadata": "object | null",
    "createdAt": "ISO timestamp"
  }
}
```

### 3.3 `session:status`

Session 状态变更通知。

**Payload:**

```json
{
  "sessionId": "string",
  "status": "creating | connecting | running | disconnected | ended",
  "externalSessionId": "string | null",
  "endedAt": "ISO timestamp | null"
}
```

### 3.4 `session:command`

agent-api 通过此频道向 controller-api 下发命令。

#### `acp:cancel`

取消当前生成。

**Payload:**

```json
{
  "type": "acp:cancel",
  "sessionId": "string"
}
```

**服务端行为：**

1. 查找 session 对应的 controller socket
2. 发送 `acp:cancel` Socket.IO 事件
3. 不修改 session 状态，不清理映射

#### `acp:resume`

恢复已有 ACP Session。

**Payload:**

```json
{
  "type": "acp:resume",
  "sessionId": "string",
  "externalSessionId": "string",
  "cwd": "string"
}
```

**服务端行为：**

1. 查找 session 对应的 controller socket
2. 发送 `acp:resume` Socket.IO 事件（含 `externalSessionId`）
3. 等待 `acp:resume:result`（30s 超时）
4. 成功时：注册 session mapping，更新 status = running
5. 失败时：清理 session 映射，标记 status = ended

---

## 4. SSE 协议（agent-api → 前端）

SSE 端点定义见 `agent-session.openapi.yaml`。

---

## 5. ACP JSON-RPC 协议（Controller ↔ OpenCode）

### 5.1 传输层

- 传输方式：stdio
- 消息格式：JSON-RPC 2.0
- 消息分隔：换行符 `\n`
- 编码：UTF-8

### 5.2 核心方法

| 方法 | 方向 | 说明 |
|------|------|------|
| `initialize` | Client → Agent | 建立连接，协商版本和能力 |
| `session/new` | Client → Agent | 创建新会话 |
| `session/resume` | Client → Agent | 恢复已有会话（需 agent 支持 `session.resume`） |
| `session/prompt` | Client → Agent | 发送用户消息 |
| `session/update` | Agent → Client | 通知进度更新（流式输出） |
| `session/cancel` | Client → Agent | 取消操作 |
| `session/close` | Client → Agent | 关闭会话 |

### 5.3 消息示例

**initialize:**

Controller 代理不声明 `fs`/`terminal` 能力，文件系统和终端由 OpenCode 自身处理。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {},
    "clientInfo": {
      "name": "z-agent-gear",
      "version": "1.0.0"
    }
  }
}
```

**session/new:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project"
  }
}
```

**session/prompt:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [
      {
        "type": "text",
        "text": "Hello, how are you?"
      }
    ]
  }
}
```

**session/update（流式输出）:**

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "I'm doing well, thanks!"
      }
    }
  }
}
```

---

## 6. 错误处理

### 6.1 ACP 事件错误码

| 错误码 | 说明 | 处理方式 |
|--------|------|---------|
| `ACP_NOT_AVAILABLE` | 控制器不支持 ACP | 前端提示升级控制器 |
| `ACP_SERVER_NOT_FOUND` | 指定的 ACP Server 不存在 | 前端提示选择其他 Server |
| `ACP_START_FAILED` | ACP 进程启动失败 | 前端提示检查 OpenCode 安装 |
| `ACP_TIMEOUT` | ACP 操作超时 | 前端提示重试 |
| `ACP_SESSION_NOT_FOUND` | Session 不存在 | 前端提示刷新页面 |
| `ACP_PROCESS_CRASHED` | ACP 进程异常退出 | Session 状态更新为 ended |

### 6.2 重连策略

- WebSocket 断开：Socket.IO 自动重连（指数退避）
- SSE 断开：浏览器 EventSource 自动重连
- ACP 进程崩溃：通知前端，用户可手动重建 Session
