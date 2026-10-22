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
| Server → Controller | `acp:list-sessions` | 请求拉取工作目录历史会话列表 |
| Controller → Server | `acp:list-sessions:result` | 返回历史会话列表 |
| Server → Controller | `acp:load-session` | 请求加载单个历史会话全量消息 |
| Controller → Server | `acp:load-session:result` | 返回历史会话全量消息 |
| Server → Controller | `acp:set-mode` | 请求切换 Agent 工作模式 |
| Server → Controller | `acp:set-model` | 请求切换 LLM 模型 |
| Server → Controller | `acp:set-config-option` | 请求设置会话配置项（含模式/模型 category） |
| Controller → Server | `acp:set-config-option:result` | 设置配置项结果（成功/失败回执） |
| Controller → Server | `acp:config-options` | 上报会话配置项全量快照（初始化与变更后） |
| Server → Controller | `acp:delete-history-session` | 请求删除 Agent 侧历史会话 |
| Controller → Server | `acp:delete-history-session:result` | 删除结果 |
| Server → Controller | `acp:authenticate` | 请求执行 Agent 认证 |
| Controller → Server | `acp:authenticate:result` | 认证结果 |
| Controller → Server | `acp:auth:required` | Agent 要求认证（initialize 返回 authMethods） |
| Server → Controller | `acp:logout` | 请求登出 |
| Controller → Server | `acp:logout:result` | 登出结果 |
| Controller → Server | `acp:protocol-version-mismatch` | Agent 协议版本不兼容告警 |
| Controller → Server | `acp:permission` | Agent请求用户权限审批 |
| Server → Controller | `acp:permission:response` | 返回用户权限审批结果 |
| Controller → Server | `acp:elicitation` | Agent请求用户结构化输入（Elicitation） |
| Server → Controller | `acp:elicitation:response` | 返回用户 Elicitation 响应 |
| Controller → Server | `acp:elicitation:complete` | 转发 Agent 的 URL 模式 Elicitation 完成通知 |
| Server → Controller | `git:check` | 请求检测 Git 仓库状态 |
| Controller → Server | `git:check:result` | 返回 Git 检测结果 |
| Server → Controller | `git:init` | 请求初始化 Git 仓库 |
| Controller → Server | `git:init:result` | 返回初始化结果 |

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
| `mcpEndpoint` | `McpEndpoint` | 否 | MCP 转发端点信息（仅用户勾选装配 MCP 时携带） |
| `additionalDirectories` | `string[]` | 否 | 附加工作目录（绝对路径，Agent 支持 `session.additionalDirectories` 时使用） |
| `modeId` | `string` | 否 | 初始工作模式 ID（工作流节点配置；不提供则使用 harness 默认） |
| `modelId` | `string` | 否 | 初始 LLM 模型 ID（工作流节点配置；不提供则使用 harness 默认） |

**McpEndpoint 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `token` | `string` | 是 | Bearer Token（会话级 JWT，会话关闭即吊销） |
| `serverNames` | `string[]` | 是 | MCP Server 名称列表（签发时快照） |

> **注**：MCP 转发不再携带 `url` 字段。回环地址由 agent-controller 本机生成，为每个装配的 server 生成独立端点 `http://127.0.0.1:{port}/mcp/{sessionId}/{serverName}`（`{port}` 为 agent-controller 守护进程共享的回环端口，仅监听 `127.0.0.1`）。

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
| `modes` | `AgentMode[]` | 否 | Agent 支持的可用工作模式列表 |
| `currentModeId` | `string` | 否 | 当前使用的工作模式 ID |
| `currentModel` | `AgentModelInfo` | 否 | 当前使用的 LLM 模型信息 |
| `availableModels` | `AgentModel[]` | 否 | Agent 支持的可用 LLM 模型列表 |
| `currentModelId` | `string` | 否 | 当前使用的 LLM 模型 ID |
| `configOptions` | `SessionConfigOption[]` | 否 | 会话配置项全量快照（Agent 提供时以配置项为准） |
| `promptCapabilities` | `PromptCapabilities` | 否 | Prompt 多模态能力（image/audio/embeddedContext） |
| `agentInfo` | `AgentInfo` | 否 | Agent 名称与版本 |
| `authMethods` | `AuthMethodInfo[]` | 否 | Agent 支持的认证方式（非空表示要求认证） |
| `supportsAdditionalDirectories` | `boolean` | 否 | Agent 是否支持附加工作目录 |
| `capabilities` | `AgentCapabilitySnapshot` | 否 | 能力快照（缺省 = 该 controller 版本未上报，服务端按旧行为处理） |

**AgentCapabilitySnapshot 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `protocolVersion` | `number \| null` | Agent 协商的协议版本 |
| `agentInfo` | `AgentInfo \| null` | Agent 名称与版本 |
| `features` | `AgentFeatureSupport[]` | 归一化后的能力清单（20 项） |
| `raw` | `object` | 对端声明原文：`agentCapabilities` / `authMethods` / `clientCapabilities` |

**AgentFeatureSupport 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 能力 ID（如 `config.model`、`elicitation.form`） |
| `status` | `"supported" \| "partial" \| "unsupported"` | Agent 声明 × 平台支持三档合并结果 |
| `detail` | `string \| null` | 可读说明（未声明字段 / 平台侧限制） |

**SessionConfigOption 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 配置项 ID |
| `name` | `string` | 显示名称 |
| `description` | `string \| null` | 描述 |
| `category` | `string \| null` | 语义分类（`mode`/`model`/`model_config`/`thought_level`/其他） |
| `type` | `"select" \| "boolean"` | 配置项类型 |
| `currentValue` | `string` | 当前值（boolean 序列化为 `"true"`/`"false"`） |
| `options` | `SessionConfigOptionValue[]` | select 类型的可选值 |

**PromptCapabilities 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `image` | `boolean` | 支持图片输入 |
| `audio` | `boolean` | 支持音频输入 |
| `embeddedContext` | `boolean` | 支持嵌入资源上下文 |

**AgentInfo 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Agent 名称 |
| `version` | `string \| null` | Agent 版本 |

**AuthMethodInfo 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 认证方式 ID |
| `kind` | `"env_var" \| "terminal" \| "agent" \| null` | 认证方式类型 |
| `description` | `string \| null` | 说明 |
| `url` | `string \| null` | 跳转链接（agent 类型时） |

**AgentMode 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 模式唯一标识（如 `code`、`architect`、`ask`、`debug`） |
| `name` | `string` | 是 | 模式显示名称（如 `Code`、`Architect`） |
| `description` | `string` | 否 | 模式描述 |

**AgentModelInfo 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 模型 ID |
| `name` | `string` | 是 | 模型显示名称 |
| `provider` | `string` | 否 | 模型供应商（如 `anthropic`、`openai`） |

**AgentModel 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 模型 ID |
| `name` | `string` | 是 | 模型显示名称 |
| `provider` | `string` | 否 | 模型供应商（如 `anthropic`、`openai`） |

**服务端行为：**

成功时（`success: true`）：
1. 将 `externalSessionId` 持久化到 MongoDB Session 文档
2. 缓存 `modes`、`currentModeId`、`currentModel` 到 Redis `session:{sessionId}:*`（Session 活跃期）
3. 在 Redis 中缓存映射关系 `session:{sessionId}:acpSessionId = externalSessionId`（TTL 24h）
4. 注册 session WebSocket 映射
5. 发布 `session:status`（含 `modes`、`currentModeId`、`currentModel`）

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
| `messageId` | `string` | 否 | ACP 消息 ID（Agent 提供时用于精确分组） |

**服务端行为：**

1. 持久化消息到 MongoDB（含 `messageId`，可选）
2. 通过 Redis Pub/Sub 通知 agent-api
3. agent-api 推送到 SSE 连接

### 2.8 `acp:stop`（Server → Controller）

请求停止 ACP Session。与 `acp:cancel` 不同，此操作结束整个 session。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `ackRequired` | `boolean` | 否 | 是否需要 ack 回执（默认 false）；`true` 时 Controller 处理完必须回复 `acp:stopped` |

**客户端行为：**

1. 调用 SDK `connection.cancel()` — 取消当前生成（如有）
2. 调用 SDK `connection.closeSession()` — ACP 协议关闭 session
3. 发送 SIGTERM 到 OpenCode 进程
4. 等待进程退出（最多 5s）
5. 如果未退出，发送 SIGKILL
6. 清理资源
7. 回复 `acp:stopped`（`ackRequired: true` 时必须回复；bridge 未命中时查注册表按 PID 强杀并回复 `acp:stopped { killed: true }`）

### 2.9 `acp:stopped`（Controller → Server）

通知 ACP Session 已停止。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `reason` | `string` | 是 | 停止原因（`user_close`/`agent_exit`/`error`） |
| `exitCode` | `number` | 否 | 进程退出码（agent_exit/error 时返回） |
| `killed` | `boolean` | 否 | 是否通过注册表 PID 强杀（bridge 未命中时的兜底路径） |

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
| `controllerId` | `string` | 是 | 控制器 ID |
| `userId` | `string` | 是 | 用户 ID |
| `cwd` | `string` | 是 | 工作目录（绝对路径） |
| `mcpEndpoint` | `McpEndpoint` | 否 | MCP 转发端点信息（仅用户勾选装配 MCP 时携带；仅含 `token`/`serverNames`，无 `url`） |
| `additionalDirectories` | `string[]` | 否 | 附加工作目录（绝对路径） |
| `modeId` | `string` | 否 | 初始工作模式 ID（工作流节点配置；不提供则使用 harness 默认） |
| `modelId` | `string` | 否 | 初始模型 ID（工作流节点配置；不提供则使用 harness 默认） |

**客户端行为：**

1. 拉起 `opencode acp` 进程（如尚未运行）
2. 建立 stdio JSON-RPC 通信
3. 调用 SDK `connection.initialize()` — 不声明 `fs`/`terminal` 能力
4. 调用 SDK `connection.resumeSession({ sessionId: externalSessionId })`
5. 如果 agent 不支持 `session.resume`，fallback 到 `newSession`
6. 若 payload 携带 `modeId`/`modelId`，在回复结果前应用初始工作模式/模型（同 `acp:start` §2.4：必须在 `acp:initialized`/`acp:resume:result` 之前完成，保证首条 prompt 以配置值执行）
7. 回复 `acp:resume:result`

### 2.12 `acp:resume:result`（Controller → Server）

返回 ACP Session 恢复结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `sessionId` | `string` | 是 | Session ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string` | 否 | 失败原因（`session.resume` 不支持时 fallback 到 `newSession`） |
| `modes` | `AgentMode[]` | 否 | Agent 支持的可用工作模式列表 |
| `currentModeId` | `string` | 否 | 当前使用的工作模式 ID |
| `currentModel` | `AgentModelInfo` | 否 | 当前使用的 LLM 模型信息 |
| `availableModels` | `AgentModel[]` | 否 | Agent 支持的可用 LLM 模型列表 |
| `currentModelId` | `string` | 否 | 当前使用的 LLM 模型 ID |
| `capabilities` | `AgentCapabilitySnapshot` | 否 | 能力快照（结构同 §2.5；缺省 = 旧 controller，不覆盖已落库快照） |

**服务端行为：**

1. 成功时：
   - 注册 session mapping
   - 缓存 `modes`、`currentModeId`、`currentModel` 到 Redis
   - 更新 status = idling
   - 发布 `session:status`（含 `idling` + 模式信息）
2. 失败时：更新 status = ended，发布 `session:status`（含 `ended` + `error`）

### 2.12.1 `mcp:request`（Controller → Server）

转发 Agent 侧 MCP 调用请求到 controller-api，由其桥接至 agent-api 分发（MCP 传递重构一期：公网入口下线，MCP 访问改由 controller 本机回环端点经主 WebSocket 代理）。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID（controller 侧 `mcpreq_*` 前缀，用于匹配响应） |
| `sessionId` | `string` | 是 | Session ID |
| `serverName` | `string` | 是 | MCP Server 名称 |
| `token` | `string` | 是 | Bearer Token（会话级 JWT） |
| `body` | `object` | 是 | JSON-RPC 请求体（`jsonrpc`/`method`/`id`/`params`） |

**约束：**

- sessionId 归属校验：若该 sessionId 不属于当前 Controller，直接回 404，不转发。
- 单次请求 60s 超时：无响应回 504。
- Controller 断线：全部 pending 立即 503 快速失败，不挂起。
- Socket.IO 单帧体积上限：controller-api `maxHttpBufferSize` 调为 16MB，超限回 502。

### 2.12.2 `mcp:response`（Server → Controller）

返回 MCP 调用结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `status` | `number` | 是 | HTTP 状态码（取值 `200`/`401`/`404`/`410`/`502`/`503`/`504`） |
| `body` | `object` | 是 | JSON-RPC 响应体 |

**客户端行为：**

1. 按 `requestId` 匹配 pending 请求并 resolve 回环端点的 HTTP 响应
2. 未知 `requestId` 的 `mcp:response` 忽略不抛错

### 2.13 `acp:list-sessions`（Server → Controller）

请求获取指定工作目录下的历史会话列表。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配结果 |
| `serverType` | `string` | 是 | Agent 类型（如 `opencode`） |
| `cwd` | `string` | 是 | 工作目录绝对路径 |
| `cursor` | `string \| null` | 否 | 分页游标（透传 ACP `session/list` 的 cursor） |

**客户端行为：**

1. 实例化临时 `AcpSyncBridge`，以 `cwd` 为参数
2. 连接 ACP Server（spawn `opencode acp`）
3. 调用 `connection.initialize()`
4. 调用 `connection.listSessions({ cwd, cursor? })`
5. 返回会话列表 → 关闭 ACP 连接
6. 回复 `acp:list-sessions:result`

### 2.14 `acp:list-sessions:result`（Controller → Server）

返回历史会话列表。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `sessions` | `SessionInfo[]` | 否 | 会话列表（成功时） |
| `nextCursor` | `string \| null` | 否 | 下一页游标（ACP 返回时透传） |
| `error` | `string` | 否 | 失败原因 |

> 取舍说明：当前 Server 端只消费第一页结果，忽略 `nextCursor`（不发起翻页请求）。后续如需完整列表可基于 `cursor`/`nextCursor` 扩展。

**SessionInfo 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | ACP 侧唯一标识 |
| `title` | `string \| null` | 会话标题 |
| `cwd` | `string` | 工作目录 |
| `updatedAt` | `string \| null` | ISO 8601 最后活动时间 |

### 2.15 `acp:load-session`（Server → Controller）

请求加载指定历史会话的全量消息。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID |
| `sessionId` | `string` | 是 | ACP 侧 session ID |
| `cwd` | `string` | 是 | 工作目录 |

**客户端行为：**

1. 实例化临时 `AcpSyncBridge`，以 `cwd` 为参数
2. 连接 ACP Server
3. 调用 `connection.initialize()`
4. 调用 `connection.loadSession({ cwd, sessionId, mcpServers: [] })`
5. `loadSession` 会通过 `session/update` 通知流式返回全量历史消息
6. 收集所有历史消息通知
7. 回复 `acp:load-session:result`（含所有消息）

### 2.16 `acp:load-session:result`（Controller → Server）

返回历史会话全量消息。

### 2.17 `acp:set-mode`（Server → Controller）

请求切换 Agent 工作模式。仅在 session 处于 idling 状态时发送。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `modeId` | `string` | 是 | 目标模式 ID（如 `code`、`architect`、`ask`、`debug`） |

**客户端行为：**

1. 查找对应 session 的 AcpSessionBridge
2. 调用 ACP `session/set_mode` JSON-RPC 方法
3. 切换结果通过 `session/update`（`current_mode_update`）异步通知
4. 不主动回复事件

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `sessionId` | `string` | 是 | ACP 侧 session ID |
| `title` | `string \| null` | 否 | 会话标题 |
| `messages` | `HistoryMessage[]` | 否 | 历史消息列表（成功时） |
| `error` | `string` | 否 | 失败原因 |

**HistoryMessage 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `direction` | `"input" \| "output"` | 消息方向 |
| `type` | `string` | 消息类型（同 AcpMessage.type） |
| `content` | `string` | JSON 序列化的消息内容 |

### 2.18 `acp:set-model`

请求切换 LLM 模型。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `modelId` | `string` | 是 | 模型配置 ID |

**客户端行为：**

1. 查找 `sessionId` 对应的 ACP Session Bridge
2. 调用 `bridge.setModel(modelId)`
3. 不等待结果（切换结果通过 `session/update` 的 `current_model_update` 通知）

### 2.19 `acp:permission`（Controller → Server）

当Agent发送`session/request_permission`时，Controller将权限请求转发给Server。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求ID，用于匹配响应 |
| `sessionId` | `string` | 是 | 当前Session ID |
| `toolCall` | `object` | 是 | 工具调用信息（ACP `ToolCall` 对象透传） |
| `toolCall.toolCallId` | `string` | 是 | 工具调用ID |
| `toolCall.title` | `string` | 否 | 工具调用标题（人类可读，如 `Bash: npm test`） |
| `toolCall.kind` | `string` | 否 | 工具类型（`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`switch_mode`/`other`） |
| `toolCall.rawInput` | `object` | 否 | 工具原始输入参数（如命令行、文件路径等） |
| `toolCall.locations` | `object[]` | 否 | 涉及的文件位置（`[{ path, line? }]`） |
| `options` | `PermissionOption[]` | 是 | 可选审批选项 |

**PermissionOption 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `optionId` | `string` | 选项ID |
| `name` | `string` | 显示名称 |
| `kind` | `PermissionOptionKind` | 选项类型 |

**PermissionOptionKind 枚举：**

| 值 | 说明 |
|------|------|
| `allow_once` | 允许一次 |
| `allow_always` | 始终允许 |
| `reject_once` | 拒绝一次 |
| `reject_always` | 始终拒绝 |

**客户端行为：**

1. AcpSessionBridge暂停等待用户响应（Promise）
2. 通过Socket.IO发送权限请求到Server
3. 等待`acp:permission:response`响应
4. 超时（65秒）自动返回`cancelled`

### 2.20 `acp:permission:response`（Server → Controller）

Server将用户审批结果返回给Controller。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求ID |
| `outcome` | `RequestPermissionOutcome` | 是 | 审批结果 |

**RequestPermissionOutcome 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `outcome` | `'selected' \| 'cancelled'` | 结果类型 |
| `optionId` | `string?` | 选择的选项ID（outcome=selected时） |

**客户端行为：**

1. 查找对应的pending permission Promise
2. resolve Promise，返回结果给Agent
3. Agent继续执行或取消

### 2.21 `acp:set-config-option`（Server → Controller）

请求设置会话配置项。Agent 提供 `configOptions` 时用于模式/模型/推理档位/开关等所有配置项。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 否 | 请求 ID（当前 Server 端未发送，保留用于匹配响应） |
| `sessionId` | `string` | 是 | Session ID |
| `configId` | `string` | 是 | 配置项 ID |
| `value` | `string` | 是 | 配置值（全程字符串；boolean 配置项传 `'true'`/`'false'`） |

**客户端行为：**

1. 查找对应 session 的 AcpSessionBridge
2. 调用 ACP `session/set_config_option` JSON-RPC 方法
3. 以响应中的全量快照更新内部 `configOptions`，回复 `acp:config-options`（全量配置项快照，唯一事实源，与 `config_option_update` 通知路径同源）
4. 同时回复 `acp:set-config-option:result` 回执（见 §2.21.1）；bridge 不存在时直接回复 `success: false`

### 2.21.1 `acp:set-config-option:result`（Controller → Server）

设置配置项的成功/失败回执。新值以 `acp:config-options` 快照为准，本事件仅表示调用结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `success` | `boolean` | 是 | 是否成功 |
| `configId` | `string` | 是 | 配置项 ID |
| `error` | `string` | 否 | 失败原因 |

### 2.22 `acp:config-options`（Controller → Server）

上报会话配置项全量快照。在会话初始化（`acp:start:result`/`acp:resume:result`）与配置变更（`set_config_option` 响应、`config_option_update` 通知）后推送。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `configOptions` | `SessionConfigOption[]` | 是 | 配置项全量快照 |

### 2.23 `acp:delete-history-session`（Server → Controller）

请求删除 Agent 侧历史会话（Agent 声明 `session.delete` capability 时）。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `sessionId` | `string` | 是 | Session ID（服务端） |
| `externalSessionId` | `string` | 是 | ACP 侧 session ID |
| `cwd` | `string` | 是 | 工作目录（绝对路径） |
| `serverType` | `string` | 否 | Agent 类型（缺省 `opencode`） |

**客户端行为：**

1. 实例化临时 `AcpSyncBridge` 并连接 ACP Server
2. 检查 `session.delete` capability，不支持时直接回复 `supported: false`
3. 调用 SDK `connection.deleteSession({ sessionId: externalSessionId })`
4. 回复 `acp:delete-history-session:result`

### 2.24 `acp:delete-history-session:result`（Controller → Server）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `sessionId` | `string` | 是 | Session ID（服务端） |
| `supported` | `boolean` | 否 | Agent 是否支持删除会话（`false` 表示 Agent 无 `session.delete` capability） |
| `error` | `string` | 否 | 失败原因 |

### 2.25 `acp:auth:required`（Controller → Server）

Agent 在 `initialize` 响应中返回非空 `authMethods` 时上报，表示该 Agent 要求认证。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `authMethods` | `AuthMethodInfo[]` | 是 | 支持的认证方式列表 |

### 2.26 `acp:authenticate`（Server → Controller）

请求执行 Agent 认证。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `sessionId` | `string` | 是 | Session ID |
| `methodId` | `string` | 是 | 认证方式 ID |
| `input` | `object` | 否 | 认证输入（如环境变量名/值） |

**客户端行为：**

1. 调用 SDK `connection.authenticate({ methodId, input })`
2. 回复 `acp:authenticate:result`
3. 凭据仅内存透传，不落库、不进日志

### 2.27 `acp:authenticate:result`（Controller → Server）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `sessionId` | `string` | 是 | Session ID |
| `error` | `string` | 否 | 失败原因 |

### 2.28 `acp:logout`（Server → Controller）

请求登出 Agent 认证。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `sessionId` | `string` | 是 | Session ID |

**客户端行为：**

1. 调用 SDK `connection.logout({})`
2. 回复 `acp:logout:result`

### 2.29 `acp:logout:result`（Controller → Server）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `sessionId` | `string` | 是 | Session ID |
| `error` | `string` | 否 | 失败原因 |

### 2.30 `acp:protocol-version-mismatch`（Controller → Server）

Agent 在 `initialize` 响应中返回的协议版本与客户端不兼容时上报。**不断连**，由上层提示用户。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `expectedVersion` | `number` | 是 | 客户端期望的协议版本（1） |
| `agentVersion` | `number` | 是 | Agent 返回的协议版本 |

### 2.31 `acp:elicitation`（Controller → Server）

当 Agent 发送 `elicitation/create`（ACP Elicitation，UNSTABLE）时，Controller 将请求转发给 Server。Elicitation 用于 Agent 向用户请求结构化输入，支持两种模式：

- **form**：表单模式，按 `requestedSchema`（受限 JSON Schema，仅原始类型与枚举）收集非敏感数据
- **url**：URL 模式，引导用户打开外部链接完成敏感/外部交互（如 OAuth）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求ID（Controller 生成，`elic_` 前缀），用于匹配响应 |
| `sessionId` | `string` | 是 | 当前Session ID |
| `mode` | `'form' \| 'url'` | 是 | Elicitation 模式 |
| `message` | `string` | 是 | 向用户展示的请求说明 |
| `toolCallId` | `string` | 否 | 关联的工具调用ID（session 范围内可关联 tool call） |
| `requestedSchema` | `object` | form 必填 | 表单 Schema：`{ type: 'object', properties: {...}, required?: string[], title?, description? }` |
| `elicitationId` | `string` | url 必填 | Agent 侧 Elicitation ID（URL 模式，用于匹配完成通知） |
| `url` | `string` | url 必填 | 引导用户打开的 URL |

**客户端行为：**

1. AcpSessionBridge 暂停等待用户响应（Promise）
2. 通过 Socket.IO 发送 Elicitation 请求到 Server
3. 等待 `acp:elicitation:response` 响应
4. 超时（65秒）自动返回 `{ action: 'cancel' }`

### 2.32 `acp:elicitation:response`（Server → Controller）

Server 将用户的 Elicitation 响应返回给 Controller。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求ID |
| `action` | `'accept' \| 'decline' \| 'cancel'` | 是 | 用户动作：提交 / 明确拒绝 / 取消 |
| `content` | `object` | 否 | 表单数据（`action=accept` 且 form 模式时），键值符合 `requestedSchema` |

**客户端行为：**

1. 查找对应的 pending elicitation Promise
2. resolve Promise，按 ACP `CreateElicitationResponse` 返回给 Agent
3. Agent 根据 `action` 继续执行、回退或取消

### 2.33 `acp:elicitation:complete`（Controller → Server）

当 Agent 发送 `elicitation/complete` 通知（URL 模式外部交互完成后）时，Controller 透传给 Server，用于关闭/更新用户侧的 Elicitation 待办。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | 当前Session ID |
| `elicitationId` | `string` | 是 | Agent 侧 Elicitation ID（与 `acp:elicitation` 中的 `elicitationId` 对应） |

**客户端行为：** 无需响应，收到后忽略未知或已完成的 `elicitationId`。

### 2.34 `acp:elicitation:resolved`（Controller → Server）

Agent 侧问询在到达用户之前已结束（模式不支持 / 超时 / 被 Agent 取消）。
仅用于可观测与待办状态收敛；用户已响应的情况走 `acp:elicitation:response`。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 否 | 平台侧请求 ID（模式不支持时可能没有） |
| `sessionId` | `string` | 是 | 会话 ID |
| `reason` | `"unsupported_mode" \| "timeout" \| "cancelled"` | 是 | 结束原因 |
| `detail` | `string` | 否 | 可读原因（如未知模式名） |

**服务端行为：** 发布 Redis `elicitation:resolved`（附 `userId`/`controllerId`），agent-api 据此把
对应待办标记为 `failed` / `expired` / `cancelled`，并记录 `resolvedAt`。

---

## 3. 文件系统与 Git 事件协议

### 3.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Server → Controller | `fs:browse` | 请求浏览目录 |
| Controller → Server | `fs:browse:result` | 返回目录列表 |
| Server → Controller | `fs:home` | 请求获取用户主目录 |
| Controller → Server | `fs:home:result` | 返回主目录路径 |
| Server → Controller | `fs:mkdir` | 请求创建文件夹 |
| Controller → Server | `fs:mkdir:result` | 返回创建结果 |
| Server → Controller | `git:check` | 请求检测 Git 仓库状态 |
| Controller → Server | `git:check:result` | 返回 Git 检测结果 |
| Server → Controller | `git:init` | 请求初始化 Git 仓库 |
| Controller → Server | `git:init:result` | 返回初始化结果 |
| Server → Controller | `git:worktree:add` | 请求创建 Git Worktree |
| Controller → Server | `git:worktree:add:result` | 返回创建结果 |
| Server → Controller | `git:worktree:remove` | 请求移除 Git Worktree |
| Controller → Server | `git:worktree:remove:result` | 返回移除结果 |
| Server → Controller | `git:worktree:list` | 请求列出 Git Worktree |
| Controller → Server | `git:worktree:list:result` | 返回 Worktree 列表 |
| Server → Controller | `fs:remove-dir` | 请求递归删除目录 |
| Controller → Server | `fs:remove-dir:result` | 返回删除结果 |
| Server → Controller | `git:status` | 请求检测 Git 工作区状态（clean/dirty） |
| Controller → Server | `git:status:result` | 返回工作区状态 |
| Server → Controller | `git:commit` | 请求在指定路径执行 Git 提交 |
| Controller → Server | `git:commit:result` | 返回提交结果 |

### 3.2 `fs:browse`（Server → Controller）

请求浏览指定目录下的文件和文件夹。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `path` | `string \| null` | 是 | 待浏览的目录绝对路径，null 时使用默认路径 |

**客户端行为：**

1. 读取指定目录内容
2. 过滤隐藏文件（`.` 开头）
3. 按目录优先、名称字母序排列
4. 回复 `fs:browse:result`

### 3.3 `fs:browse:result`（Controller → Server）

返回目录浏览结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `entries` | `FsEntry[]` | 是 | 目录条目列表 |

**`FsEntry` 结构:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 文件名 |
| `path` | `string` | 完整路径 |
| `isDirectory` | `boolean` | 是否为目录 |

### 3.4 `fs:home`（Server → Controller）

请求获取用户主目录路径。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID |

**客户端行为：** 返回当前用户的主目录绝对路径。

### 3.5 `fs:home:result`（Controller → Server）

返回主目录路径。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `path` | `string` | 是 | 主目录绝对路径 |

### 3.6 `git:check`（Server → Controller）

请求检测指定路径是否为合法 Git 仓库，并获取分支信息。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `path` | `string` | 是 | 待检测的目录绝对路径 |

**客户端行为：**

1. 执行 `git rev-parse --git-dir` 检测是否为合法仓库
2. 若是合法仓库，执行 `git branch --format="%(refname:short)"` 获取所有本地分支
3. 执行 `git rev-parse --abbrev-ref HEAD` 获取当前分支
4. 确定默认分支：优先 `main` > `master` > 按字母排序第一个
5. 回复 `git:check:result`

### 3.7 `git:check:result`（Controller → Server）

返回 Git 仓库检测结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `isGitRepo` | `boolean` | 是 | 是否为合法 Git 仓库 |
| `currentBranch` | `string \| null` | 否 | 当前分支名（合法仓库时） |
| `branches` | `string[] \| null` | 否 | 所有本地分支列表（合法仓库时） |
| `defaultBranch` | `string \| null` | 否 | 默认分支名（合法仓库时） |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.8 `git:init`（Server → Controller）

请求在指定目录初始化 Git 仓库，并设置默认分支为 `main`。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID |
| `path` | `string` | 是 | 待初始化目录绝对路径 |

**客户端行为：**

1. 执行 `git init`
2. 执行 `git branch -m main`
3. 回复 `git:init:result`

### 3.9 `git:init:result`（Controller → Server）

返回 Git 初始化结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.10 `fs:mkdir`（Server → Controller）

请求在指定父目录下创建文件夹。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `parentPath` | `string` | 是 | 父目录绝对路径 |
| `folderName` | `string` | 是 | 待创建的文件夹名称 |

**客户端行为：**

1. 在 `parentPath/folderName` 路径创建目录
2. 回复 `fs:mkdir:result`

### 3.11 `fs:mkdir:result`（Controller → Server）

返回文件夹创建结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `name` | `string` | 否 | 创建的文件夹名称（成功时） |
| `path` | `string` | 否 | 创建的文件夹完整路径（成功时） |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.12 `git:worktree:add`（Server → Controller）

请求为指定 Git 仓库创建 Worktree。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `repoPath` | `string` | 是 | 原始 Git 仓库绝对路径 |
| `worktreePath` | `string` | 是 | Worktree 目标目录绝对路径 |
| `branch` | `string` | 是 | 分支名称（如 `example-repo/test-branch`） |

**客户端行为：**

1. 创建 Worktree 目标目录（如目标目录不存在）
2. 执行 `git worktree add -b <branch> <worktreePath> <repoPath>`
3. 回复 `git:worktree:add:result`

### 3.13 `git:worktree:add:result`（Controller → Server）

返回 Worktree 创建结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `worktreePath` | `string` | 否 | Worktree 目标目录路径（成功时） |
| `branch` | `string` | 否 | 实际创建的分支名（成功时） |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.14 `git:worktree:remove`（Server → Controller）

请求移除指定 Worktree。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `repoPath` | `string` | 是 | 原始 Git 仓库绝对路径 |
| `worktreePath` | `string` | 是 | Worktree 目录绝对路径 |
| `force` | `boolean` | 否 | 是否强制移除（默认 false）；`force: true` 时执行 `git worktree remove --force`，不做 commit 暂存 |

**客户端行为：**

1. 执行 `git worktree remove [--force] <worktreePath>`
2. 删除 Worktree 目录（如移除后目录仍存在）
3. 回复 `git:worktree:remove:result`

### 3.15 `git:worktree:remove:result`（Controller → Server）

返回 Worktree 移除结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.16 `git:worktree:list`（Server → Controller）

请求列出指定 Git 仓库的全部 Worktree。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配结果 |
| `workspacePath` | `string` | 是 | Git 仓库根目录绝对路径 |

**客户端行为：**

1. 执行 `git worktree list --porcelain`
2. 解析输出为 `[{ path, branch, head }]` 数组
3. 回复 `git:worktree:list:result`

### 3.17 `git:worktree:list:result`（Controller → Server）

返回 Worktree 列表。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `worktrees` | `WorktreeInfo[]` | 否 | Worktree 列表（成功时） |
| `error` | `string \| null` | 否 | 失败原因 |

**WorktreeInfo 结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | `string` | Worktree 目录绝对路径 |
| `branch` | `string \| null` | 分支名（HEAD detached 时为 null） |
| `head` | `string` | HEAD commit hash |

### 3.18 `fs:remove-dir`（Server → Controller）

请求递归删除目录。

**安全模型**：Controller 端使用白名单校验路径——仅允许该 Controller 已注册/活跃会话持有的 worktree 路径及其子路径；显式拒绝 `/`、用户主目录、进程 cwd 及 Windows 系统关键路径（如 `C:\Windows`、`C:\Program Files`）。Agent-api 端（`worktreeService.deleteWorktree`）仅发送已知工作区下的 worktree 路径，通过上游控制进一步保证路径合法性。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配结果 |
| `path` | `string` | 是 | 待删除目录绝对路径 |

**客户端行为：**

1. 校验路径白名单（仅允许已注册/活跃会话持有的 worktree 路径及其子路径；显式拒绝 `/`、用户主目录、进程 cwd 及 Windows 系统关键路径）
2. 执行 `fs.rm(path, { recursive: true, force: true })`
3. 回复 `fs:remove-dir:result`

### 3.19 `fs:remove-dir:result`（Controller → Server）

返回目录删除结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.20 `git:status`（Server → Controller）

请求检测指定路径的 Git 工作区状态是否为 clean。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `path` | `string` | 是 | 待检测的目录绝对路径 |

**客户端行为：**

1. 执行 `git -C <path> status --porcelain`
2. 解析结果：输出为空则为 clean，否则为 dirty
3. 回复 `git:status:result`

### 3.21 `git:status:result`（Controller → Server）

返回 Git 工作区状态检测结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `isClean` | `boolean` | 是 | 工作区是否为 clean 状态 |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.22 `git:commit`（Server → Controller）

请求在指定路径执行 Git 提交。用于 Session 销毁时自动暂存未提交变更。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 请求 ID，用于匹配响应 |
| `path` | `string` | 是 | Git 仓库目录绝对路径 |
| `message` | `string` | 是 | 提交信息 |

**客户端行为：**

1. 执行 `git -C <path> add -A`
2. 执行 `git -C <path> commit -m "<message>"`
3. 如没有变更可提交，视为成功
4. 回复 `git:commit:result`

### 3.23 `git:commit:result`（Controller → Server）

返回 Git 提交结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | `string` | 是 | 对应的请求 ID |
| `success` | `boolean` | 是 | 是否成功 |
| `commitHash` | `string \| null` | 否 | 提交的 SHA（有实际提交时） |
| `error` | `string \| null` | 否 | 失败原因 |

### 3.24 服务端处理流程

agent-api 收到前端 GraphQL 请求后，按下述流程将事件转发给 Controller 并处理结果。

#### `acp:load-session`

加载单个历史会话的全量消息。

**Payload:**

```json
{
  "type": "acp:load-session",
  "requestId": "string",
  "controllerId": "string",
  "sessionId": "string",
  "cwd": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `acp:load-session` Socket.IO 事件（含 `requestId`, `sessionId`, `cwd`）
3. 等待 `acp:load-session:result`（300s 超时）
4. 成功时：缓存结果到 Redis `acp:load-session:{requestId}`（TTL 300s）
5. 失败时：缓存空结果

#### `git:check`

检测指定路径是否为合法 Git 仓库并获取分支信息。

**Payload:**

```json
{
  "type": "git:check",
  "requestId": "string",
  "controllerId": "string",
  "path": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:check` Socket.IO 事件（含 `requestId`, `path`）
3. 等待 `git:check:result`（30s 超时）
4. 成功时：缓存结果到 Redis `git:check:{requestId}`（TTL 60s）
5. 同时缓存分支列表到 `git:branches:{controllerId}:{pathMd5}`（TTL 60s）
6. 失败时：缓存空结果

#### `git:init`

在指定目录初始化 Git 仓库，并设置默认分支为 `main`。

**Payload:**

```json
{
  "type": "git:init",
  "requestId": "string",
  "controllerId": "string",
  "path": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:init` Socket.IO 事件（含 `requestId`, `path`）
3. 等待 `git:init:result`（30s 超时）
4. 成功时：清理 `git:branches:{controllerId}:{pathMd5}` 缓存
5. 失败时：缓存空结果到 Redis `git:init:{requestId}`（TTL 30s）

#### `fs:mkdir`

在指定父目录下创建文件夹。

**Payload:**

```json
{
  "type": "fs:mkdir",
  "requestId": "string",
  "controllerId": "string",
  "parentPath": "string",
  "folderName": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `fs:mkdir` Socket.IO 事件（含 `requestId`, `parentPath`, `folderName`）
3. 等待 `fs:mkdir:result`（30s 超时）
4. 成功时：返回 `name` + `path`
5. 失败时：缓存空结果到 Redis `fs:mkdir:{requestId}`（TTL 30s）

#### `git:worktree:add`

为指定 Git 仓库创建 Worktree。

**Payload:**

```json
{
  "type": "git:worktree:add",
  "requestId": "string",
  "controllerId": "string",
  "repoPath": "string",
  "worktreePath": "string",
  "branch": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:worktree:add` Socket.IO 事件（含 `requestId`, `repoPath`, `worktreePath`, `branch`）
3. 等待 `git:worktree:add:result`（30s 超时）
4. 成功时：缓存结果到 Redis `git:worktree:add:{requestId}`（TTL 60s）
5. 失败时：缓存空结果

#### `git:worktree:remove`

移除指定 Worktree。

**Payload:**

```json
{
  "type": "git:worktree:remove",
  "requestId": "string",
  "controllerId": "string",
  "repoPath": "string",
  "worktreePath": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:worktree:remove` Socket.IO 事件（含 `requestId`, `repoPath`, `worktreePath`）
3. 等待 `git:worktree:remove:result`（30s 超时）
4. 成功时：缓存结果
5. 失败时：缓存空结果

#### `git:status`

检测指定路径的 Git 工作区状态是否为 clean。

**Payload:**

```json
{
  "type": "git:status",
  "requestId": "string",
  "controllerId": "string",
  "path": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:status` Socket.IO 事件（含 `requestId`, `path`）
3. 等待 `git:status:result`（30s 超时）
4. 成功时：缓存结果到 Redis `git:status:{requestId}`（TTL 60s）
5. 失败时：缓存空结果

#### `git:commit`

在指定路径执行 Git 提交。

**Payload:**

```json
{
  "type": "git:commit",
  "requestId": "string",
  "controllerId": "string",
  "path": "string",
  "message": "string"
}
```

**服务端行为：**

1. 查找 controller socket
2. 发送 `git:commit` Socket.IO 事件（含 `requestId`, `path`, `message`）
3. 等待 `git:commit:result`（30s 超时）
4. 成功时：缓存结果到 Redis `git:commit:{requestId}`（TTL 60s）
5. 失败时：缓存空结果

---

## 4. SSE 协议（agent-api → 前端）

SSE 端点定义见 `agent-session.openapi.yaml`。

### 4.1 事件格式

#### `status` 事件

Session 状态变更时推送。恢复操作失败时携带 `error` 字段。Session 创建/恢复成功时携带 `modes`、`currentModeId`、`currentModel` 信息。

**Payload:**

```json
{
  "type": "status",
  "data": {
    "sessionId": "string",
    "status": "creating | connecting | idling | running | disconnected | ended",
    "error": "string | null",
    "modes": [
      {
        "id": "code",
        "name": "Code",
        "description": "Write and edit code"
      }
    ] | null,
    "currentModeId": "string | null",
    "currentModel": {
      "id": "string",
      "name": "string",
      "provider": "string | null"
    } | null,
    "availableModels": [
      {
        "id": "string",
        "name": "string",
        "provider": "string | null"
      }
    ] | null,
    "currentModelId": "string | null"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `status` | `string` | 是 | 当前状态 |
| `error` | `string` | 否 | 仅在 resume 失败时携带 |
| `modes` | `AgentMode[]` | 否 | 可用工作模式列表，Session 创建/恢复成功后携带 |
| `currentModeId` | `string` | 否 | 当前工作模式 ID |
| `currentModel` | `AgentModelInfo` | 否 | 当前 LLM 模型信息 |
| `availableModels` | `AgentModel[]` | 否 | 可用 LLM 模型列表，Session 创建/恢复成功后携带 |
| `currentModelId` | `string` | 否 | 当前 LLM 模型 ID |

#### `mode:changed` 事件

工作模式切换成功后推送。

**Payload:**

```json
{
  "type": "mode:changed",
  "data": {
    "sessionId": "string",
    "modeId": "string"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `modeId` | `string` | 是 | 切换后的新模式 ID |

#### `model:changed` 事件

LLM 模型切换成功后推送。

**Payload:**

```json
{
  "type": "model:changed",
  "data": {
    "sessionId": "string",
    "modelId": "string"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | Session ID |
| `modelId` | `string` | 是 | 切换后的新模型 ID |

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
| `session/set_mode` | Client → Agent | 切换工作模式（仅在 idling 时有效，旧 Agent 回退通道） |
| `session/set_config_option` | Client → Agent | 设置会话配置项（含模式/模型 category，配置项通道） |
| `session/delete` | Client → Agent | 删除历史会话（需 agent 支持 `session.delete`） |
| `authenticate` | Client → Agent | 执行 Agent 认证（需 agent 返回 `authMethods`） |
| `logout` | Client → Agent | 登出 Agent 认证 |
| `session/list` | Client → Agent | 列出历史会话（cursor 分页） |
| `session/request_permission` | Agent → Client | 请求用户权限审批 |
| `elicitation/create` | Agent → Client | 请求用户结构化输入（UNSTABLE，form/url 模式） |
| `elicitation/complete` | Agent → Client | URL 模式 Elicitation 完成通知（UNSTABLE） |

### 5.3 消息示例

**initialize:**

Controller 代理不声明 `fs`/`terminal` 能力，文件系统和终端由 OpenCode 自身处理；声明 `session.configOptions.boolean` 以支持布尔配置项（注意：`session.configOptions.boolean` 是扩展字段，非 ACP 官方 schema 属性）；声明 `elicitation.form`/`elicitation.url` 以支持 Elicitation 两种模式（ACP UNSTABLE 能力，仅显式声明的模式可被 Agent 使用）。

> 历史同步链路 `sync-bridge` 使用同一份 `CLIENT_CAPABILITIES` 声明（`session.configOptions.boolean` + `elicitation.form`/`url`）；因同步进程无用户交互通道，其 `elicitation/create` 一律返回 `cancel` 并记录告警（声明 + 立即取消是合法降级）。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "elicitation": {
        "form": {},
        "url": {}
      },
      "session": {
        "configOptions": {
          "boolean": {}
        }
      }
    },
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

**session/set_mode:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/set_mode",
  "params": {
    "sessionId": "sess_abc123",
    "modeId": "architect"
  }
}
```

**session/new 返回（扩展）:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "sess_abc123",
    "modes": [
      { "id": "code", "name": "Code", "description": "Write and edit code" },
      { "id": "architect", "name": "Architect", "description": "Design architecture" },
      { "id": "ask", "name": "Ask", "description": "Ask questions" },
      { "id": "debug", "name": "Debug", "description": "Debug issues" }
    ],
    "currentModeId": "code",
    "currentModel": {
      "id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4",
      "provider": "anthropic"
    }
  }
}
```

**current_mode_update（模式变更通知）:**

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123",
    "update": {
      "sessionUpdate": "current_mode_update",
      "modeId": "architect"
    }
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
| `CONTROLLER_OFFLINE` | 控制器不在线，无法发送 acp:resume | 前端提示检查控制器连接 |
| `ACP_SESSION_EXPIRED` | ACP Session ID 已过期，无法恢复 | 前端提示创建新会话 |
| `WORKSPACE_PATH_INVALID` | 工作目录在控制器上已不存在 | 前端提示检查工作目录 |
| `WORKTREE_ADD_FAILED` | Git Worktree 创建失败 | 前端提示检查分支名是否冲突或名称是否合法 |
| `WORKTREE_REMOVE_FAILED` | Git Worktree 移除失败 | 前端提示手动检查 Worktree 状态 |
| `WORKTREE_COMMIT_FAILED` | 自动提交失败（如缺少 Git 用户配置） | 前端提示配置 Git user.name/user.email |
| `WORKTREE_NOT_CLEAN` | Worktree 不是 clean 状态 | 自动触发提交后重试移除 |
| `FOLDER_CREATE_FAILED` | 文件夹创建失败 | 前端提示检查权限或路径合法性 |

### 6.2 重连策略

- WebSocket 断开：Socket.IO 自动重连（指数退避）
- SSE 断开：浏览器 EventSource 自动重连
- ACP 进程崩溃：通知前端，用户可手动重建 Session
