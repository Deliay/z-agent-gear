---
description: MCP 代理服务管理与配置下发技术方案
type: Permanent
---

# MCP 代理服务管理与配置下发 - 技术提案

**功能名称**: MCP 代理服务与配置下发
**关联 PRD**: `docs/product/draft/20260530-mcp-proxy-config.md`
**技术提案版本**: v4.0
**创建日期**: 2026-05-30
**作者**: ZeroAsh
**feat-branch**: `feat/mcp-proxy-config`

## 1. 概述

### 1.1 背景

ACP 协议支持在 `acp:start` 时传递 `mcpServers` 参数，当前该字段为预留状态（仅支持 stdio 结构）。PRD 要求：

1. 用户可在平台管理 HTTP 类型的 MCP Server 配置（含鉴权）
2. 创建 Session 时可选择 MCP Servers
3. 通过服务端转发服务，将用户选择的 MCP Servers 聚合为单一 HTTP 端点
4. Agent 支持 HTTP MCP 时直接使用 HTTP 端点；不支持时通过 agent-gear 内置的 stdio 代理转换
5. 用户可将本地 MCP 命令注册为平台可用的 MCP Server

**核心设计原则**：
- 用户的 MCP Server 配置（含鉴权信息）不下发到 Controller，由服务端转发服务统一管理
- Controller 仅接收转发端点 URL + Token
- agent-gear 支持三种模式：controller 守护进程、stdio MCP 代理、本地 MCP 命令注册代理

### 1.2 目标

- 新增 `McpServer` Mongoose Model，支持 HTTP 传输和加密鉴权存储
- 新增 GraphQL Schema/Resolver 实现 MCP Server CRUD
- 新增 `McpSessionEndpoint` 模型，为每个 Session 创建独立的转发端点
- 实现 MCP 转发服务（mcp-forwarder），聚合多个 MCP Server 为单一 HTTP 端点
- agent-gear 新增 `mcp` 子命令，将 HTTP MCP 转为 stdio（供不支持 HTTP 的 Agent 使用）
- agent-gear 新增 `mcp-proxy` 子命令，将本地 MCP 命令注册为平台可用的 Server
- 更新 Session 创建流程，集成 MCP Server 选择和能力检测

### 1.3 范围

- **包含**：agent-api（GraphQL CRUD + 加密存储）、controller-api（转发端点管理 + Token 签发 + 代理注册）、mcp-forwarder 转发服务、agent-controller（三种模式）、contracts（GraphQL + WebSocket 契约更新）、前端（MCP Server 管理 UI + Session 创建选择 + 代理 Key 管理）
- **不包含**：MCP Server 的 OAuth 交互式认证流程、MCP Server 市场/推荐

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    subgraph "前端 (agent-web)"
        UI_MCP[MCP Server 管理页]
        UI_SESSION[Session 创建页]
        UI_KEY[MCP Proxy Key 管理]
    end

    subgraph "agent-api (GraphQL)"
        RES[McpServer Resolver]
        SVC[McpServer Service]
        ENC[Encryption Service]
        MOD[(MongoDB McpServer)]
    end

    subgraph "controller-api (Socket.IO + HTTP)"
        CAPI[Session Service]
        EP[MCP Endpoint Manager]
        PROXY_REG[MCP Proxy Registry]
    end

    subgraph "mcp-forwarder (HTTP)"
        FWD[MCP Forwarder Service]
        ROUTE["/mcp/:sessionId/*"]
    end

    subgraph "agent-gear 三种模式"
        MODE1["① controller 守护进程<br/>agent-gear --key --server"]
        MODE2["② stdio MCP 代理<br/>agent-gear mcp --endpoint --token"]
        MODE3["③ 本地 MCP 注册代理<br/>agent-gear mcp-proxy --server --key --command"]
    end

    subgraph "本地 MCP 命令"
        LOCAL_MCP[npx @modelcontextprotocol/server-github]
    end

    subgraph "外部"
        MCP_EXT[远程 HTTP MCP Server]
    end

    UI_MCP -->|CRUD| RES
    UI_SESSION -->|选择 MCP Servers| RES
    UI_KEY -->|生成代理 Key| PROXY_REG
    RES --> SVC
    SVC --> ENC
    SVC --> MOD

    CAPI -->|创建 Session| EP
    EP -->|生成转发端点 + Token| FWD
    CAPI -->|下发 endpoint URL + token| MODE1

    MODE1 -->|支持 HTTP| FWD
    MODE1 -->|不支持 HTTP| MODE2
    MODE2 -->|HTTP + Token| FWD

    MODE3 -->|注册到服务器| PROXY_REG
    MODE3 -->|stdio| LOCAL_MCP
    PROXY_REG -->|注册成功| MOD

    FWD -->|HTTP + MCP Auth Headers| MCP_EXT
    FWD -->|通过注册代理转发| MODE3
```

### 2.2 核心概念

**转发端点（Session Endpoint）**：
- 每个 Session 创建时，为其选中的 MCP Servers 生成一个独立的 HTTP 端点
- 端点格式：`POST /mcp/:sessionId`
- 该端点聚合了该 Session 选择的所有 MCP Server
- Controller 通过此单一端点访问所有 MCP 功能

**端点鉴权**：
- 每个端点生成独立的 Bearer Token（JWT）
- Token 与 Session 绑定，Session 结束后 Token 失效

**本地 MCP 代理注册**：
- 用户在设置中生成 MCP Proxy Key
- 用户在本地运行 `agent-gear mcp-proxy --server <server> --key <key> --command "cmd"`
- agent-gear 启动本地命令，向服务器注册，建立双向通信
- 注册后的 MCP Server 可在创建 Session 时被选择

### 2.3 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | React + TypeScript | MCP Server 管理 UI |
| agent-api | GraphQL-Yoga + Mongoose | MCP Server CRUD + 加密存储 |
| controller-api | Socket.IO + Express | 转发端点管理、Token 签发、代理注册 |
| mcp-forwarder | Express | MCP 请求转发服务 |
| agent-controller | Node.js | 三种模式实现 |
| 加密 | Node.js crypto (AES-256-GCM) | 鉴权信息加密存储 |
| Token | JWT | 端点访问鉴权 |

### 2.4 模块划分

```mermaid
graph LR
    A[agent-api<br/>McpServer CRUD] --> B[controller-api<br/>端点管理 + Token + 代理注册]
    B --> C[mcp-forwarder<br/>请求转发]
    D["agent-gear ① controller"] -->|HTTP + Token| C
    E["agent-gear ② mcp"] -->|HTTP + Token| C
    F["agent-gear ③ mcp-proxy"] -->|注册| B
    F -->|stdio| G[本地 MCP 命令]
    C -->|HTTP + MCP Auth| H[远程 MCP Server]
    C -->|通过注册代理| F
```

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| agent-api | MCP Server CRUD、加密存储、GraphQL API | AES-256-GCM 加密、Mongoose Model |
| controller-api | Session 端点管理、Token 签发、代理注册 | JWT 签发、端点生命周期、代理注册协议 |
| mcp-forwarder | 接收请求、解密鉴权、转发到 MCP Server | 动态路由、鉴权注入、请求转发 |
| agent-gear ① controller | 守护进程，检测 Agent 能力，选择下发方式 | 能力检测、进程管理 |
| agent-gear ② mcp | stdio MCP 代理，HTTP 转 stdio | JSON-RPC stdio、HTTP fetch |
| agent-gear ③ mcp-proxy | 本地 MCP 命令注册代理 | 进程管理、注册协议、stdio 桥接 |

## 3. API 设计

### 3.1 GraphQL Schema（agent-api）

```graphql
enum McpServerTransport {
  http
  registered_proxy
}

enum McpServerAuthType {
  none
  api_key
  bearer_token
  custom_headers
}

enum McpServerStatus {
  active
  disabled
}

type McpServer {
  id: ID!
  name: String!
  url: String!
  transport: McpServerTransport!
  authType: McpServerAuthType!
  status: McpServerStatus!
  createdAt: String!
  updatedAt: String!
}

type McpServerDetail {
  id: ID!
  name: String!
  url: String!
  transport: McpServerTransport!
  authType: McpServerAuthType!
  authConfig: JSON
  status: McpServerStatus!
  createdAt: String!
  updatedAt: String!
}

input CreateMcpServerInput {
  name: String!
  url: String!
  authType: McpServerAuthType! = none
  authConfig: JSON
}

input UpdateMcpServerInput {
  id: ID!
  name: String
  url: String
  authType: McpServerAuthType
  authConfig: JSON
  status: McpServerStatus
}

type Query {
  mcpServers: [McpServer!]!
  mcpServer(id: ID!): McpServerDetail
}

type Mutation {
  createMcpServer(input: CreateMcpServerInput!): McpServer!
  updateMcpServer(input: UpdateMcpServerInput!): McpServer!
  deleteMcpServer(id: ID!): Boolean!
  toggleMcpServer(id: ID!): McpServer!
}
```

**authConfig JSON 结构：**

| authType | authConfig 结构 |
|----------|----------------|
| `none` | `null` |
| `api_key` | `{ "keyName": "X-API-Key", "keyValue": "sk-xxx" }` |
| `bearer_token` | `{ "token": "eyJhbG..." }` |
| `custom_headers` | `{ "headers": [{ "name": "Authorization", "value": "Basic xxx" }] }` |

### 3.2 GraphQL Schema（controller-api）— MCP Proxy Key 管理

```graphql
type McpProxyKey {
  id: ID!
  name: String!
  keyPrefix: String!
  status: McpProxyKeyStatus!
  lastUsedAt: String
  createdAt: String!
}

enum McpProxyKeyStatus {
  active
  revoked
}

type CreateMcpProxyKeyPayload {
  key: McpProxyKey!
  rawKey: String!
}

type Query {
  mcpProxyKeys: [McpProxyKey!]!
}

type Mutation {
  createMcpProxyKey(name: String!): CreateMcpProxyKeyPayload!
  revokeMcpProxyKey(id: ID!): Boolean!
}
```

### 3.3 REST API（controller-api）— MCP Proxy 注册

#### 3.3.1 注册端点

```
POST /api/mcp-proxy/register
Content-Type: application/json
```

**请求 Body：**

```json
{
  "key": "<register_key>",
  "hostname": "user-machine",
  "command": "npx @modelcontextprotocol/server-github",
  "serverName": "github-mcp"
}
```

**响应：**

```json
{
  "success": true,
  "proxyId": "xxx",
  "serverId": "yyy"
}
```

**行为：**
1. 验证 register_key（bcrypt hash 比对）
2. 创建 McpServer 记录（transport: `registered_proxy`）
3. 建立 WebSocket 连接用于后续通信
4. 返回 proxyId 和 serverId

#### 3.3.2 代理通信（WebSocket）

注册成功后，通过 WebSocket 保持连接：

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Proxy → Server | `proxy:heartbeat` | 心跳（30s） |
| Server → Proxy | `proxy:request` | 转发 MCP 请求 |
| Proxy → Server | `proxy:response` | 返回 MCP 响应 |
| Proxy → Server | `proxy:unregister` | 注销 |
| Server → Proxy | `proxy:shutdown` | 强制断开 |

### 3.4 REST API（mcp-forwarder）

#### 3.4.1 MCP 转发端点

```
POST /mcp/:sessionId
Authorization: Bearer <session-endpoint-token>
Content-Type: application/json
```

**行为：**
1. 验证 Bearer Token（JWT），确认 sessionId 匹配且 Session 有效
2. 查找该 Session 绑定的 MCP Server 列表
3. 解密各 MCP Server 的鉴权信息
4. 根据请求中的 MCP 方法和目标 Server，转发到对应的 HTTP MCP Server
5. 返回响应

**请求 Body：** 标准 JSON-RPC 格式

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "serverName": "github",
    "name": "create_pr",
    "arguments": { ... }
  }
}
```

**特殊处理：**
- `serverName` 字段用于指定转发到哪个 MCP Server
- 如果未指定 `serverName`，默认转发到第一个 MCP Server
- `tools/list` 方法返回所有 MCP Server 的工具聚合列表
- 对于 `registered_proxy` 类型的 MCP Server，通过 WebSocket 转发到本地代理

### 3.5 WebSocket 契约更新（controller-api ↔ agent-controller）

#### 3.5.1 `acp:check:result` 扩展

在 `AcpServerInfo` 中新增 `mcpCapabilities` 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mcpCapabilities` | `McpCapabilities` | 否 | MCP 传输能力 |

**McpCapabilities 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `http` | `boolean` | 是 | 是否支持 HTTP MCP |
| `sse` | `boolean` | 否 | 是否支持 SSE MCP |

#### 3.5.2 `acp:start` 扩展

新增 `mcpEndpoint` 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mcpEndpoint` | `McpEndpoint` | 否 | MCP 转发端点信息 |

**McpEndpoint 结构：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | `string` | 是 | 转发端点 URL（如 `https://api.example.com/mcp/:sessionId`） |
| `token` | `string` | 是 | Bearer Token（用于访问转发端点） |
| `serverNames` | `string[]` | 是 | 该端点聚合的 MCP Server 名称列表 |

#### 3.5.3 新增 `mcp:endpoint:revoke` 事件

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Server → Controller | `mcp:endpoint:revoke` | 撤销端点 Token（Session 结束时） |

**Payload：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | 关联的 Session ID |

## 4. 数据模型

### 4.1 MongoDB Collection: `mcpservers`

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | 主键 |
| `userId` | ObjectId | 所属用户 |
| `name` | String | MCP Server 名称 |
| `url` | String | HTTP URL（http 类型）或代理标识（registered_proxy 类型） |
| `transport` | String | 传输类型：`http` / `registered_proxy` |
| `authType` | String | 认证类型：`none` / `api_key` / `bearer_token` / `custom_headers` |
| `authConfig` | String | AES-256-GCM 加密后的认证配置 JSON |
| `authConfigIv` | String | 加密 IV（初始化向量） |
| `authConfigTag` | String | GCM 认证标签 |
| `proxyConnectionId` | String | 注册代理的 WebSocket 连接 ID（registered_proxy 类型） |
| `status` | String | 状态：`active` / `disabled` / `offline` |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |

**索引：**
- `{ userId: 1, name: 1 }` — 唯一索引，同一用户下名称不可重复
- `{ userId: 1, status: 1 }` — 查询优化
- `{ proxyConnectionId: 1 }` — 注册代理查询优化

### 4.2 MongoDB Collection: `mcpsessionendpoints`

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | 主键 |
| `sessionId` | ObjectId | 关联的 Session |
| `userId` | ObjectId | 所属用户 |
| `mcpServerIds` | [ObjectId] | 绑定的 MCP Server ID 列表 |
| `tokenHash` | String | Token 的 bcrypt hash（用于验证） |
| `status` | String | 状态：`active` / `revoked` |
| `expiresAt` | Date | Token 过期时间 |
| `createdAt` | Date | 创建时间 |

**索引：**
- `{ sessionId: 1 }` — 唯一索引
- `{ status: 1, expiresAt: 1 }` — TTL 索引，自动清理过期记录

### 4.3 MongoDB Collection: `mcpproxykeys`

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | ObjectId | 主键 |
| `userId` | ObjectId | 所属用户 |
| `name` | String | Key 名称（用户自定义） |
| `keyHash` | String | Key 的 bcrypt hash |
| `keyPrefix` | String | Key 前缀（用于展示，如 `mcp-****1234`） |
| `status` | String | 状态：`active` / `revoked` |
| `lastUsedAt` | Date | 最后使用时间 |
| `createdAt` | Date | 创建时间 |

**索引：**
- `{ userId: 1, name: 1 }` — 唯一索引

### 4.4 加密方案

```
密钥来源: 环境变量 MCP_SERVER_ENCRYPTION_KEY (32 bytes hex)
算法: AES-256-GCM
IV: 每次加密随机生成 16 bytes
存储: authConfig (密文) + authConfigIv (IV) + authConfigTag (GCM Tag)
```

### 4.5 Token 方案

```
密钥来源: 环境变量 MCP_ENDPOINT_JWT_SECRET
算法: HS256
Payload: { sessionId, userId, serverNames, exp }
有效期: Session 生命周期（默认 24 小时）
存储: 仅存储 tokenHash (bcrypt)，用于服务端验证
```

## 5. 技术实现方案

### 5.1 agent-gear 三种模式

#### 5.1.1 模式 ①：Controller 守护进程（已有）

```bash
agent-gear --key <controller-key> --server
```

- 启动 Socket.IO 守护进程
- 注册到 controller-api
- 等待 `acp:start` 等事件
- 管理 ACP Session 生命周期

#### 5.1.2 模式 ②：stdio MCP 代理（新增）

```bash
agent-gear mcp --endpoint <转发端点URL> --token <bearer-token>
```

- 启动 stdio JSON-RPC 服务
- 从 stdin 读取 JSON-RPC 请求
- 将请求通过 HTTP 转发到 `--endpoint` 指定的转发端点
- 请求携带 `Authorization: Bearer <token>` Header
- 将 HTTP 响应写回 stdout
- Agent 通过 stdio 与此进程通信

#### 5.1.3 模式 ③：本地 MCP 注册代理（新增）

```bash
agent-gear mcp-proxy --server <server-url> --key <register_key> --command "npx @modelcontextprotocol/server-github"
```

- 启动本地 MCP 命令作为子进程
- 向服务器注册（使用 register_key）
- 建立 WebSocket 连接保持心跳
- 桥接服务器请求与本地 MCP 命令的 stdio
- 进程退出时自动注销

### 5.2 入口文件设计

```typescript
// packages/agent-controller/src/index.ts
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    key: { type: 'string' },
    server: { type: 'boolean' },
  },
  strict: false,
  allowPositionals: true,
});

const command = args.positionals[0];

if (command === 'mcp') {
  // 模式 ②: stdio MCP 代理
  const mcpArgs = parseArgs({
    args: args.positionals.slice(1),
    options: {
      endpoint: { type: 'string' },
      token: { type: 'string' },
    },
  });
  await startMcpProxy(mcpArgs.values.endpoint, mcpArgs.values.token);
} else if (command === 'mcp-proxy') {
  // 模式 ③: 本地 MCP 注册代理
  const proxyArgs = parseArgs({
    args: args.positionals.slice(1),
    options: {
      server: { type: 'string' },
      key: { type: 'string' },
      command: { type: 'string' },
    },
  });
  await startMcpRegistration(proxyArgs.values.server, proxyArgs.values.key, proxyArgs.values.command);
} else if (args.values.server) {
  // 模式 ①: controller 守护进程
  await startController(args.values.key);
} else {
  showHelp();
}
```

### 5.3 核心流程

#### 5.3.1 Session 创建与 MCP 下发

```mermaid
sequenceDiagram
    participant U as 用户
    participant FE as 前端
    participant API as agent-api
    participant CAPI as controller-api
    participant FWD as mcp-forwarder
    participant CTRL as agent-gear controller
    participant MCP代理 as agent-gear mcp
    participant MCP as HTTP MCP Server

    U->>FE: 创建 Session，选择 MCP Servers
    FE->>API: createSession(input.mcpServerIds)
    API->>CAPI: 创建 Session + mcpServerIds

    CAPI->>CAPI: 创建 Mcpsessionendpoint 记录
    CAPI->>CAPI: 签发 JWT Token
    CAPI->>FWD: 注册端点路由（/mcp/:sessionId）
    CAPI->>CTRL: acp:start + mcpEndpoint(url + token + serverNames)

    CTRL->>CTRL: 检测 Agent MCP 能力

    alt Agent 支持 HTTP MCP
        CTRL->>FWD: Agent 直接 HTTP 请求 (Bearer Token)
        FWD->>MCP: 转发（携带 MCP Server 鉴权 Headers）
        MCP->>FWD: 响应
        FWD->>CTRL: 响应
    else Agent 不支持 HTTP MCP
        CTRL->>MCP代理: spawn agent-gear mcp --endpoint <url> --token <token>
        Note over MCP代理: stdio 模式启动
        MCP代理->>FWD: HTTP 请求 (Bearer Token)
        FWD->>MCP: 转发（携带 MCP Server 鉴权 Headers）
        MCP->>FWD: 响应
        FWD->>MCP代理: 响应
        MCP代理->>CTRL: stdio JSON-RPC 响应
    end
```

#### 5.3.2 本地 MCP 命令注册流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant UI as 前端设置页
    participant CAPI as controller-api
    participant CTRL as agent-gear mcp-proxy
    participant CMD as 本地 MCP 命令

    U->>UI: 生成 MCP Proxy Key
    UI->>CAPI: createMcpProxyKey(name)
    CAPI->>CAPI: 生成 Key + bcrypt hash 存储
    CAPI->>UI: 返回 rawKey (mcp_xxxxx)

    U->>CTRL: agent-gear mcp-proxy --server <url> --key <key> --command "npx ..."
    CTRL->>CAPI: POST /api/mcp-proxy/register {key, hostname, command, serverName}
    CAPI->>CAPI: 验证 Key (bcrypt)
    CAPI->>CAPI: 创建 McpServer (transport: registered_proxy)
    CAPI->>CTRL: 返回 {proxyId, serverId}

    CTRL->>CMD: spawn 子进程 (npx ...)
    CTRL->>CAPI: WebSocket 连接 (proxyId)
    CTRL->>CAPI: proxy:heartbeat (每 30s)

    Note over CAPI,FWD: 当 Session 需要使用此 MCP Server 时
    CAPI->>FWD: 注册端点（含 registered_proxy 类型）
    FWD->>CAPI: proxy:request (转发 MCP 请求)
    CAPI->>CTRL: proxy:request (通过 WebSocket)
    CTRL->>CMD: stdio JSON-RPC
    CMD->>CTRL: stdio 响应
    CTRL->>CAPI: proxy:response
    CAPI->>FWD: proxy:response
    FWD->>CTRL: HTTP 响应
```

### 5.4 关键实现点

#### 实现点 1: McpServer Service（agent-api）

- **描述**: 实现 MCP Server CRUD 业务逻辑，包含加密/解密鉴权信息
- **技术细节**:
  - `createMcpServer`: 加密 authConfig 后存储
  - `getMcpServersByIds`: 批量查询并解密，返回用于转发的格式
  - 支持 `http` 和 `registered_proxy` 两种 transport 类型
- **风险点**: 密钥管理，需确保 MCP_SERVER_ENCRYPTION_KEY 环境变量安全

#### 实现点 2: MCP Endpoint Manager（controller-api）

- **描述**: 管理 Session 级别的 MCP 转发端点生命周期
- **技术细节**:
  - `createEndpoint(sessionId, userId, mcpServerIds)`: 创建端点记录 + 签发 JWT + 注册路由
  - `revokeEndpoint(sessionId)`: 撤销 Token + 标记端点为 revoked
  - JWT Payload: `{ sessionId, userId, serverNames, exp }`
- **风险点**: 需确保 Session 结束时端点被正确撤销

#### 实现点 3: MCP Proxy Registry（controller-api）

- **描述**: 管理本地 MCP 代理注册
- **技术细节**:
  - `registerProxy(key, hostname, command, serverName)`: 验证 Key + 创建 McpServer + 建立 WebSocket
  - `handleProxyMessage(proxyId, request)`: 转发 MCP 请求到本地代理
  - `unregisterProxy(proxyId)`: 注销代理，标记 McpServer 为 offline
  - Key 管理：生成、验证（bcrypt）、撤销
- **风险点**: WebSocket 连接稳定性、代理异常退出处理

#### 实现点 4: MCP Forwarder Service（mcp-forwarder）

- **描述**: 独立的 HTTP 服务，负责接收请求并转发到目标 MCP Server
- **技术细节**:
  - 路由：`POST /mcp/:sessionId`
  - 中间件：验证 JWT Token、检查 Session 有效性
  - 转发逻辑：
    1. 从 JWT 获取 serverNames
    2. 从数据库查询对应 MCP Server 配置
    3. 解密鉴权信息
    4. 根据 transport 类型选择转发方式：
       - `http` → 直接 HTTP 转发
       - `registered_proxy` → 通过 WebSocket 转发到 controller-api，再转到本地代理
  - `tools/list` 聚合：返回所有绑定 MCP Server 的工具列表
- **风险点**: 需处理 MCP Server 不可达、鉴权失败、代理离线等异常

#### 实现点 5: agent-gear mcp 子命令

- **描述**: stdio MCP 代理，将 HTTP MCP 转为 stdio
- **技术细节**:
  - 入口：`packages/agent-controller/src/commands/mcp.ts`
  - 通过 `--endpoint` 和 `--token` 参数接收转发端点信息
  - stdio 读取 JSON-RPC → HTTP POST 到 endpoint → 响应写回 stdio
- **风险点**: 需处理 HTTP 超时、连接错误、Token 过期等异常

#### 实现点 6: agent-gear mcp-proxy 子命令

- **描述**: 本地 MCP 命令注册代理
- **技术细节**:
  - 入口：`packages/agent-controller/src/commands/mcp-proxy.ts`
  - 启动本地命令（`--command`）作为子进程
  - 向服务器注册（`--server` + `--key`）
  - 建立 WebSocket 连接
  - 桥接：服务器 `proxy:request` → 子进程 stdio → 子进程响应 → 服务器 `proxy:response`
  - 心跳：每 30s 发送 `proxy:heartbeat`
  - 注销：进程退出时发送 `proxy:unregister`
- **风险点**: 子进程管理、WebSocket 重连、异常清理

### 5.5 转发端点生命周期

```mermaid
stateDiagram-v2
    [*] --> Created: Session 创建时
    Created --> Active: Token 签发成功
    Active --> Revoked: Session 结束
    Active --> Expired: Token 过期（24h）
    Revoked --> [*]
    Expired --> [*]

    note right of Active
        Controller 可通过
        Bearer Token 访问
    end note

    note right of Revoked
        Token 失效
        路由移除
    end note
```

### 5.6 注册代理生命周期

```mermaid
stateDiagram-v2
    [*] --> KeyCreated: 用户生成 Proxy Key
    KeyCreated --> Registering: 运行 agent-gear mcp-proxy
    Registering --> Registered: 注册成功 + WebSocket 连接
    Registered --> Active: 心跳保持
    Active --> Offline: WebSocket 断开
    Offline --> Active: 重连成功
    Active --> Unregistered: 进程退出 / 用户撤销 Key
    Unregistered --> [*]

    note right of Registered
        McpServer 创建
        transport: registered_proxy
        status: active
    end note

    note right of Offline
        status: offline
        等待重连
    end note
```

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| MCP 转发位置 | Controller 端独立程序 | 服务端 mcp-forwarder | 服务端 mcp-forwarder | 鉴权信息不下发到 Controller，安全性更高 |
| stdio 代理位置 | 独立 mcp-proxy 包 | 集成到 agent-gear | 集成到 agent-gear | 统一工具链，减少依赖 |
| 注册代理通信 | HTTP 长轮询 | WebSocket | WebSocket | 实时性好，双向通信 |
| 注册 Key 格式 | UUID | 自定义前缀 | `mcp_` + 随机字符串 | 易识别、易区分 |
| 端点粒度 | 全局共享端点 | 每 Session 独立端点 | 每 Session 独立端点 | 隔离性好，便于权限控制 |
| 端点鉴权方式 | API Key | JWT Bearer Token | JWT Bearer Token | 自包含、无状态、可携带元数据 |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | ACP 协议 v1 | `acp:start` 的 `mcpEndpoint` 参数 |
| 依赖 | JWT 库 | `jsonwebtoken` 用于 Token 签发和验证 |
| 依赖 | bcrypt | 用于 Token Hash 和 Proxy Key Hash 存储 |
| 约束 | MCP_SERVER_ENCRYPTION_KEY | 必须在环境变量中配置 32 bytes hex 密钥 |
| 约束 | MCP_ENDPOINT_JWT_SECRET | 必须在环境变量中配置 JWT 签名密钥 |
| 约束 | mcp-forwarder 可用性 | 转发服务必须对 Controller 可达 |

## 7. 项目结构

```
z-agent-gear/
├── contracts/
│   ├── mcp-server.graphql          # 新增：MCP Server GraphQL Schema
│   ├── mcp-proxy.graphql           # 新增：MCP Proxy Key GraphQL Schema
│   ├── mcp-proxy-websocket.md      # 新增：MCP Proxy 注册 WebSocket 协议
│   └── agent-session-websocket.md  # 更新：新增 mcpEndpoint 字段
├── packages/
│   └── agent-controller/
│       └── src/
│           ├── index.ts            # 更新：新增 mcp / mcp-proxy 子命令入口
│           └── commands/
│               ├── mcp.ts          # 新增：stdio MCP 代理逻辑
│               └── mcp-proxy.ts    # 新增：本地 MCP 注册代理逻辑
├── servers/
│   ├── agent-api/
│   │   └── src/
│   │       ├── graphql/
│   │       │   ├── schemas/mcp-server.ts   # 新增
│   │       │   └── resolvers/mcp-server.ts # 新增
│   │       ├── models/mcp-server.ts        # 新增
│   │       └── services/mcp-server.ts      # 新增
│   ├── controller-api/
│   │   └── src/
│   │       ├── services/
│   │       │   ├── mcp-endpoint.ts         # 新增：端点管理
│   │       │   ├── mcp-proxy-registry.ts   # 新增：代理注册管理
│   │       │   └── session.ts              # 更新：集成端点创建
│   │       └── routes/
│   │           └── mcp-proxy.ts            # 新增：代理注册 REST API
│   └── mcp-forwarder/                      # 新增：MCP 转发服务
│       ├── src/
│       │   ├── index.ts
│       │   ├── routes/mcp.ts
│       │   ├── middleware/auth.ts
│       │   └── services/
│       │       ├── endpoint.ts
│       │       ├── decrypt.ts
│       │       └── forwarder.ts
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
└── apps/
    └── agent-web/
        └── src/
            └── pages/settings/
                ├── mcp-servers/            # 新增：MCP Server 管理页
                └── mcp-proxy-keys/         # 新增：MCP Proxy Key 管理页
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 单元测试覆盖率: >= 80%
- API 测试覆盖的端点: MCP Server CRUD + 转发端点访问 + Proxy 注册

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Vitest | McpServer Service、Endpoint Manager、Proxy Registry、Forwarder、mcp/mcp-proxy 命令 |
| API 测试 | Vitest + GraphQL | MCP Server CRUD、Session 端点创建、Proxy 注册 |
| E2E 测试 | Playwright | MCP Server 管理 UI、Proxy Key 管理、Session 创建 |

### 8.3 关键测试场景

| 场景 | 预期结果 |
|------|---------|
| 创建 MCP Server（HTTP 类型，无认证） | 成功存储 |
| 创建 MCP Server（HTTP 类型，各种认证） | authConfig 加密存储 |
| 生成 MCP Proxy Key | 返回 rawKey，hash 存储 |
| agent-gear mcp-proxy 注册 | 创建 McpServer (registered_proxy) |
| agent-gear mcp-proxy 心跳 | WebSocket 保持连接 |
| agent-gear mcp-proxy 断开 | McpServer 状态变为 offline |
| Session 创建 + 选择 HTTP MCP Server | 端点创建、Token 签发 |
| Session 创建 + 选择 registered_proxy MCP Server | 端点创建、通过 WebSocket 转发 |
| Agent 支持 HTTP → 直接访问转发端点 | 请求成功转发 |
| Agent 不支持 HTTP → agent-gear mcp 代理 | stdio 正确转换 |
| 访问转发端点（无效 Token） | 返回 401 |
| Session 结束 | Token 撤销 |
| 撤销 Proxy Key | 对应 McpServer 删除 |

## 9. 部署方案

### 9.1 环境规划

| 环境 | 用途 | 部署方式 |
|------|------|---------|
| 开发 | 本地开发测试 | Aspire 编排 |
| 生产 | 线上服务 | Docker Compose |

### 9.2 配置管理

| 配置项 | 说明 | 必填 |
|--------|------|------|
| `MCP_SERVER_ENCRYPTION_KEY` | AES-256-GCM 加密密钥（32 bytes hex） | 是 |
| `MCP_ENDPOINT_JWT_SECRET` | JWT 签名密钥 | 是 |
| `MCP_FORWARDER_PORT` | 转发服务端口 | 否，默认 3002 |
| `MCP_FORWARDER_URL` | 转发服务外部 URL（Controller 可达） | 是 |

### 9.3 Aspire 编排

```yaml
# 需新增 mcp-forwarder 服务
services:
  mcp-forwarder:
    build: ./servers/mcp-forwarder
    ports:
      - "3002:3002"
    environment:
      - MCP_SERVER_ENCRYPTION_KEY
      - MCP_ENDPOINT_JWT_SECRET
      - MONGODB_CONNECTION_STRING
```

## 10. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract（GraphQL + WebSocket）评审通过
- [ ] MCP Server CRUD 功能完成（HTTP 类型）
- [ ] MCP Proxy Key 生成/撤销功能完成
- [ ] agent-gear mcp-proxy 注册功能完成
- [ ] agent-gear mcp-proxy 心跳/注销功能完成
- [ ] 注册代理的 MCP 请求转发正常
- [ ] 鉴权信息加密存储/解密读取正常
- [ ] Session 创建时端点创建 + Token 签发正常
- [ ] Agent 支持 HTTP 时直接访问转发端点正常
- [ ] Agent 不支持 HTTP 时 agent-gear mcp 代理正常
- [ ] Session 结束时 Token 撤销正常
- [ ] 单元测试覆盖达标
- [ ] API 测试通过
- [ ] E2E 测试通过

## 11. 相关文档

- [PRD: MCP 代理服务管理与配置下发](docs/product/draft/20260530-mcp-proxy-config.md)
- [Contract: agent-session.graphql](contracts/agent-session.graphql)
- [Contract: agent-session-websocket.md](contracts/agent-session-websocket.md)
- [Proposal: 多 ACP Server 支持](docs/engineering/proposals/20260526-feat-multi-acp-server-support.md)
- [ACP 协议: Session Setup - MCP Servers](https://agentclientprotocol.com/protocol/session-setup#mcp-servers)
