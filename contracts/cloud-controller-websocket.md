# Cloud Controller WebSocket Protocol v1

## 1. 概述

定义云端工作容器（K8s Job 内运行的 `agent-gear`）与 `cloud-controller` 之间的通信契约，并附录 `cloud-controller` 面向 `admin-api` 的内部管理 HTTP API。

本契约复用 [`agent-controller-websocket.md`](./agent-controller-websocket.md) v1 的事件面（`register`/`heartbeat`/`unregister`/`shutdown` 等），仅在与本地 controller 接入不同的地方作出差异说明。

### 1.1 角色

| 角色 | 说明 |
|------|------|
| Worker | 部署在 K8s Job 中的工作容器，内置 `agent-gear`（本项目 Agent 控制器），作为 Socket.IO 客户端回连 |
| cloud-controller | 部署在 K8s 集群内的统一管控服务，作为 Socket.IO 服务端（namespace `/worker`） |

### 1.2 传输层

- 协议：Socket.IO v4+
- 传输：WebSocket（强制，不使用 HTTP 长轮询）
- **engine 路径**：Socket.IO 引擎（engine.io）握手/升级的 HTTP 路径固定为引擎默认 **`/socket.io/`**（服务端 `src/services/socketio-gateway.ts` 导出 `ENGINE_PATH`，`index.ts` 显式传入）。**`/worker` 是 Socket.IO namespace，不是 URL 路径**；namespace 只存在于协议握手内，无法在入口层按 URL 路由。
- **入口层路由**：反向代理 / Ingress 必须放行 `/socket.io/`（Prefix），否则握手请求 `GET /socket.io/?EIO=4&transport=websocket` 会被入口层 404，导致工作容器无法回连。`/internal`、`/health` 不对外暴露。
- 命名空间：`/worker`（与本地 controller 连接的默认 namespace 隔离，互不影响）
- 客户端自动重连：指数退避（初始 1s，最大 60s），重连后重新携带同一 token 握手

### 1.3 与 `agent-controller-websocket.md` 的差异

| 差异点 | 说明 |
|--------|------|
| 连接地址 | `wss://<cloud-controller-host>/worker`——即 **namespace `/worker` 承载于 Socket.IO engine 默认路径 `/socket.io/`** 之上（实际握手/升级 HTTP 请求打到 `/socket.io/?EIO=4...`，入口层/Ingress 必须放行 `/socket.io/`，而非 `/worker`）；一次性 token 在 Socket.IO 握手阶段经 **`auth.token`** 承载（不放入 URL query，避免进入 ingress/中间层 access log） |
| 鉴权方式 | 由握手 `auth.token`（遗留部署兼容 `handshake.query.token`）中的一次性 token 完成，`register` payload 的 `key` 字段**被忽略**（服务端不读取、不校验） |
| namespace | 固定 `/worker` |
| 握手失败 | 服务端拒绝连接并返回 `connect_error`，错误消息 `INVALID_TOKEN`；同时记录来源 IP 与原因日志（可追溯） |
| token 生命周期 | token 随容器签发，容器进入终态（`exited`/`destroying`/`failed`）即作废；同一容器在存活期间允许重复握手（覆盖断线自动重连） |

---

## 2. 事件协议

事件名、payload 语义与 [`agent-controller-websocket.md`](./agent-controller-websocket.md) v1 一致，本节仅列出 cloud-controller 场景下的关键约定。

### 2.1 事件总览

| 方向 | 事件名 | 说明 |
|------|--------|------|
| Worker → Server | `register` | 连接建立后立即发送；`key` 字段被忽略，由握手 token 替代 |
| Server → Worker | `registered` | 注册成功 |
| Server → Worker | `error` | 注册失败（本场景主要使用 `VERSION_MISMATCH`；token 失败发生在握手阶段，见 §3.1） |
| Worker → Server | `heartbeat` | 每 30s 发送一次，维持在线状态 |
| Worker → Server | `unregister` | 容器主动注销（清理退出） |
| Server → Worker | `unregistered` | 注销成功确认 |
| Server → Worker | `shutdown` | cloud-controller 通知容器退出；容器清理并退出进程 |

### 2.2 `register`（Worker → Server）

连接建立后发送的第一个事件。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hostname` | `string` | 是 | 容器主机名 |
| `version` | `string` | 是 | `agent-gear` semver 版本号（major 需为 `2`，见 §3.4） |
| `platform` | `string` | 否 | 容器平台标识（`linux`） |
| `key` | `string` | 否 | **兼容字段，服务端忽略**。容器鉴权由握手 token 完成（`agent-gear` 现有参数体系仍会发送该字段，不破坏既有握手） |
| `homeDir` | `string` | 否 | 容器内 `os.homedir()`，服务端忽略 |

**服务端行为：**

1. 从握手阶段已鉴权的 socket 上取得 `containerId`（见 §3.1），不读取 `key`。
2. 校验 `version` major（`2`），不匹配返回 `error`（`VERSION_MISMATCH`）并断开。
3. 将 socket 绑定到 `containerId`，容器状态置 `online` 并写入 `connectedAt`。
4. 回复 `registered`。

### 2.3 `registered`（Server → Worker）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `controllerId` | `string` | 是 | cloud-controller 为本次连接返回的标识（取 `containerId`） |

**客户端行为：** 收到后开始每 30s 发送 `heartbeat`。

### 2.4 `error`（Server → Worker）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | `ErrorCode` | 是 | 错误码 |
| `message` | `string` | 是 | 错误描述 |

**ErrorCode（本场景）：**

| 值 | 含义 |
|----|------|
| `VERSION_MISMATCH` | `agent-gear` major 版本不兼容；客户端输出升级指引后退出 |
| `INVALID_PAYLOAD` | `register` payload 缺少必填字段（如 `hostname`） |
| `INVALID_TOKEN` | 握手 token 校验失败（仅在 `connect_error` 中返回，不会进入 `register` 阶段） |
| `RATE_LIMITED` | 握手频率超限（按来源 IP 滑动窗口限速，仅在 `connect_error` 中返回） |

> `INVALID_KEY` / `KEY_ALREADY_ONLINE` 为本地 controller 场景错误码，本契约不使用。

### 2.5 `heartbeat`（Worker → Server）

**Payload：** 空对象 `{}`

**服务端行为：** 刷新该容器的在线心跳计时；连续 3 次（约 90s）未收到判定离线，状态退回 `connecting`（等待重连），不主动删除 Job。

### 2.6 `unregister`（Worker → Server）

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | `string` | 是 | 注销原因（`user_detach` / `process_exit`） |

**服务端行为：** 回复 `unregistered`；容器自身清理后退出。

### 2.7 `unregistered`（Server → Worker）

**Payload：** 空对象 `{}`

**客户端行为：** 容器清理本地状态并退出进程。

### 2.8 `shutdown`（Server → Worker）

cloud-controller 在强制销毁流程中通知容器退出。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | `string` | 是 | 退出原因（如 `强制销毁`） |

**客户端行为：** 停止心跳、清理并退出进程。服务端发送后宽限 10s 等待断开，随后删除 K8s Job。

---

## 3. 连接生命周期

```
Worker                              cloud-controller
  │                                      │
  │──Socket.IO connect /worker (auth.token=x)──│
  │                                      ├──校验握手 token（containerId + bcrypt secret）
  │                                      ├──失败 → connect_error(INVALID_TOKEN) + 日志
  │                                      │
  │──emit("register")───────────────────│  （key 字段被忽略）
  │                                      ├──校验 version major
  │                                      ├──绑定 containerId → 状态 online + connectedAt
  │  ←──emit("registered")──────────────│
  │                                      │
  │  ──emit("heartbeat")──────────────→ │  每 30s（连续 3 次丢失判离线 → connecting）
  │                                      │
  │  ──emit("unregister")─────────────→ │  容器主动清理退出
  │  ←──emit("unregistered")───────────│
  │                                      │
  │  ←──emit("shutdown")───────────────│  强制销毁：容器退出 → 服务端删除 Job
```

### 3.1 握手鉴权

- 传输路径：握手/升级请求走 engine 默认路径 **`/socket.io/`**（`ENGINE_PATH`），namespace `/worker`；入口层须放行 `/socket.io/`。鉴权发生在 Socket.IO 握手 middleware，token 经 `auth.token` 携带。
- token 格式：`<containerId>.<secret>`，`secret` 为随机字节（base64url）。
- 服务端 middleware 从 `handshake.auth.token` 读取 token（兼容遗留 `handshake.query.token`）：
  1. 按 `<containerId>` 定位 `cloudcontainers` 文档（**不做全表扫描**）；
  2. `bcrypt.compare(secret, tokenHash)` 比对；
  3. 文档不存在、`tokenHash` 为空、或容器已处于终态（`exited`/`destroying`/`failed`）→ 拒绝；
  4. 校验失败：`socket.emit('connect_error', 'INVALID_TOKEN')`，记录来源 IP 与原因日志后断开。
- 握手前先按来源 IP 滑动窗口限速，超限返回 `connect_error('RATE_LIMITED')`（缓解 bcrypt CPU 消耗型攻击）。
- 校验通过：将 `containerId` 写入 `socket.data`，供后续 `register`/`heartbeat`/`disconnect` 使用。

### 3.2 心跳超时检测

- 容器每 30s 发送 `heartbeat`。
- 服务端计时：连续 3 次（>60s + 缓冲）未收到心跳 → 判定离线，状态退回 `connecting`。
- 离线不自动删除 Job；管理员可通过强制销毁清理（见 PRD 3.5）。

### 3.3 重连

- 容器断线后按指数退避自动重连，使用注入的同一 token 重新握手。
- 同一容器在存活期间允许重复握手；`register` 成功后状态重新置 `online`。

### 3.4 版本兼容

- 服务端校验 `version` major 字段；不一致返回 `VERSION_MISMATCH`。
- 本期要求 major 为 `2`（与 `agent-controller-websocket.md` 一致）。

---

## 附录 A：内部管理 HTTP API（admin-api ↔ cloud-controller）

cloud-controller 暴露仅供集群内 `admin-api` 调用的内部 REST 接口（不对外）。Socket.IO 与 REST 复用同一 HTTP server。

### A.1 鉴权

所有内部接口需携带请求头：

```
Authorization: Bearer <INTERNAL_API_TOKEN>
```

`INTERNAL_API_TOKEN` 由环境变量配置，`admin-api` 与 `cloud-controller` 共享。缺失或错误返回 `401 Unauthorized`。

### A.2 接口

#### A.2.1 容器列表

```
GET /internal/containers
```

**响应 200：** `CloudContainer[]`（JSON 字段见 A.3，含 K8s 实时状态合并）。

#### A.2.2 启动容器

```
POST /internal/containers
Content-Type: application/json

{ "purpose": "idle" }
```

**响应 201：** 新建的 `CloudContainer`。

**错误：**
- `400` —— `purpose` 非法（本期仅接受 `idle`；其余用途返回明确错误文案「该任务类型暂未开放」）。
- `500` —— 创建 Job 失败（容器记录标记 `failed` 并保留，可被强制销毁清理）。

#### A.2.3 强制销毁

```
DELETE /internal/containers/:id
```

**响应 200：**

```json
{ "success": true, "deletedJob": true }
```

`deletedJob` 反映**本次调用是否真实执行了 Job 删除**（`false` 表示 Job 已不存在、未重复删除）。调用方据此观察残留 Job 清理是否发生。

**语义：** 在线容器会先收到 `shutdown` 并等待宽限期（约 10s）后删除 Job，再返回；调用方（admin-api）应使用大于「宽限期 + 删除重试上界」的超时。终态容器幂等处理：**Job 已不存在时不再重复删除（仍会核实并清理残留 Job）**。

**错误：**
- `404` —— 容器不存在。
- `200`（幂等）—— 对终态容器重复销毁仍返回成功；`deletedJob` 语义上反映本次是否真实删除了残留 Job。

### A.3 CloudContainer JSON 结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 容器 ID |
| `name` | `string` | K8s Job 名（`zag-worker-<suffix>`） |
| `namespace` | `string` | 所属命名空间 |
| `status` | `string` | 见 A.4 状态枚举 |
| `purpose` | `string` | 见 A.5 用途枚举 |
| `refId` | `string \| null` | 关联对象 ID（idle 为 `null`） |
| `userId` | `string \| null` | 关联用户（预留） |
| `image` | `string` | 使用的镜像地址 |
| `createdAt` | `string` | ISO 时间戳 |
| `connectedAt` | `string \| null` | 回连上线时间 |
| `exitedAt` | `string \| null` | 退出时间 |
| `exitReason` | `string \| null` | 退出/失败原因 |

### A.4 状态枚举

`creating` → `connecting` → `online` → `destroying` → `exited`，失败终态 `failed`。

| 值 | 说明 |
|----|------|
| `creating` | 已落库，Job 创建中 |
| `connecting` | Job 已创建，等待容器回连 |
| `online` | 容器已回连注册 |
| `destroying` | 销毁流程进行中（**瞬时态**，必然迁移到 `exited`） |
| `exited` | 容器已退出、Job 已回收 |
| `failed` | 启动失败或异常退出 |

**终态与巡检约定：**

- `destroying` 是瞬时态：销毁流程正常结束即写回 `exited`；若进程在销毁中途被 SIGTERM 打断而卡在 `destroying`，周期性巡检会回收残留 Job 并将记录迁移为 `exited`（`destroying → exited`，写入 `exitedAt`/`exitReason`），不会永久停留。
- `exited` 表示 Job 已回收：若销毁时 `deleteJob` 失败（记录仍标注「需人工清理」），巡检会持续重试删除残留 Job；`failed`/`exited`/`destroying` 记录均纳入残留 Job 对账兜底。

### A.5 用途枚举

| 值 | 说明 |
|----|------|
| `idle` | 空闲测试（本期唯一可启动用途） |
| `admin-task` | 管理后台任务（构建等，预留） |
| `workflow` | 用户工作流（预留） |
| `session` | 独立会话（预留） |
