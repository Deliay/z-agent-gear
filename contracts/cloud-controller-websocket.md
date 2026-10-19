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
| Server → Worker | `workload:run` | 下发工作负载脚本批次（初始化 / 清理）；见 §2.9 |
| Worker → Server | `workload:result` | 回报单条脚本执行结果；见 §2.10 |
| Server → Worker | `shutdown` | cloud-controller 通知容器退出；容器清理并退出进程（有清理脚本时在 post 批次完成后发送，见 §2.8） |

### 2.2 `register`（Worker → Server）

连接建立后发送的第一个事件。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hostname` | `string` | 是 | 容器主机名 |
| `version` | `string` | 是 | `agent-gear` semver 版本号，须为三段数字且 `>=2.2.0`、major 为 `2`（见 §3.4） |
| `platform` | `string` | 否 | 容器平台标识（`linux`） |
| `key` | `string` | 否 | **兼容字段，服务端忽略**。容器鉴权由握手 token 完成（`agent-gear` 现有参数体系仍会发送该字段，不破坏既有握手） |
| `homeDir` | `string` | 否 | 容器内 `os.homedir()`，服务端忽略 |

**服务端行为：**

1. 从握手阶段已鉴权的 socket 上取得 `containerId`（见 §3.1），不读取 `key`。
2. 校验 `version` 完整版本（三段数字、`>=2.2.0` 且 major 为 `2`，见 §3.4）；缺失、非法、低于最低版本或 major 不符时返回 `error`（`VERSION_MISMATCH`，载荷含当前/最低版本元数据）并断开。
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
| `currentVersion` | `string` | 否 | 客户端上报的 `version` 原始值；缺失/非法时为原始值或 `unknown`，不含凭据（仅 `VERSION_MISMATCH`） |
| `minimumVersion` | `string` | 否 | 服务端最低兼容版本（本期 `2.2.0`，仅 `VERSION_MISMATCH`） |
| `supportedMajor` | `number` | 否 | 服务端支持的 major（本期 `2`，仅 `VERSION_MISMATCH`） |

**`VERSION_MISMATCH` 示例：**

```json
{
  "code": "VERSION_MISMATCH",
  "message": "agent-gear 版本不兼容，当前版本 2.1.0，最低版本 2.2.0（supported major: 2）",
  "currentVersion": "2.1.0",
  "minimumVersion": "2.2.0",
  "supportedMajor": 2
}
```

> 旧客户端忽略新增字段，按既有路径打印错误并退出；worker 入口只依赖稳定错误码 `VERSION_MISMATCH` 触发一次自动升级（不解析本地化 `message`）。

**ErrorCode（本场景）：**

| 值 | 含义 |
|----|------|
| `VERSION_MISMATCH` | `agent-gear` 版本不在兼容范围（低于最低版本或 major 不符，含版本缺失/格式非法）；客户端输出升级指引后退出 |
| `INVALID_PAYLOAD` | `register` payload 缺少必填字段（如 `hostname`） |
| `INVALID_TOKEN` | 握手 token 校验失败（仅在 `connect_error` 中返回，不会进入 `register` 阶段） |
| `RATE_LIMITED` | 握手频率超限（按一次性 token 的 `containerId` 前缀滑动窗口限速，无 token 时回退来源 IP；另有更高上限的 per-IP 兜底桶，仅在 `connect_error` 中返回） |

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
| `graceMs` | `number` | 否 | 客户端退出前可用的宽限时间（仅追加提示，缺省行为与现状一致） |

**客户端行为：** 停止心跳、清理并退出进程。服务端发送后宽限 10s 等待断开，随后删除 K8s Job。

**发送时序（工作负载清理脚本）：** 若容器挂载了带 `postScript` 的工作负载，cloud-controller 在销毁流程中**先**通过 `workload:run { phase: "post" }` 下发清理脚本批次并等待全部结果（或 post 预算耗尽），**再**发送 `shutdown`。无 post 脚本时，`shutdown` 的发送时机与载荷与现状完全一致（向后兼容）。

---

### 2.9 `workload:run`（Server → Worker）

cloud-controller 下发一组工作负载脚本，由容器按 `items` 顺序依次执行。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phase` | `"init" \| "post"` | 是 | `init`：容器回连注册后下发的初始化批次；`post`：销毁流程中下发的清理批次 |
| `items` | `WorkloadItem[]` | 是 | 按执行顺序排列的脚本条目；`init`/`post` 各自最多 10 条 |
| `items[].logId` | `string` | 是 | 服务端预创建的执行记录 ID，回报 `workload:result` 时回填 |
| `items[].workloadId` | `string` | 是 | 工作负载 ID（便于排查/扩展） |
| `items[].workloadName` | `string` | 是 | 工作负载名称（仅用于日志/展示） |
| `items[].script` | `string` | 是 | 待执行的脚本内容（可能为空字符串，表示该条为已删除工作负载的占位记录） |
| `items[].params` | `object` | 是 | 本次执行参数，键为参数标识；值类型见下方「参数注入约定」（缺省为 `{}`） |
| `items[].required` | `boolean` | 否 | 该项是否为本次初始化的「必须」项；缺省 `false`（兼容旧服务端/旧服务端配置） |
| `items[].timeoutMs` | `number` | 是 | 单条脚本超时（init 默认 `WORKLOAD_INIT_TIMEOUT_MS=300000`） |
| `budgetMs` | `number` | 否 | `post` 批次共享总预算（默认 `WORKLOAD_POST_BUDGET_MS=90000`）；`init` 不携带 |

**必须失败语义（`required`，本期新增）：**

- `required=true` 仅取自**显式选择**的条目；隐式依赖永远为 `false`。等价地，`post` 批次的 `required` 固定为 `false`（清理阶段不参与必须判定）。
- **裁决权在服务端**：`required` 项的失败判定与容器注销由 cloud-controller 独占。worker 只做省时短路（`phase=init` 且 `item.required === true` 且本条结果为 `failed`/`timeout` 时，上报后不再启动后续条目）；旧 worker 忽略该字段不影响正确性。
- **服务端裁决**：`init` 记录 `required=true` 且结果为 `failed`/`timeout`（含看门狗判定、执行前被删除的 `failed` 占位）时，服务端**不推进**后续初始化，并把该容器剩余非终态 `init` 记录标 `timeout` 并追加中断说明，随后复用既有销毁链路**强制注销**容器（先 CAS `destroying` 使一次性 token 失效 → 清理批次 → `shutdown` → 删除 Job → `exited`）；**不重试、不退避**。`exitReason` 记为 `必须工作负载「<workloadName>」初始化失败`。
- 容器一旦被注销不会因迟到的 `workload:result` 回到 `online`（终态幂等忽略 + `finishInit` 对非 `initializing` 直接返回）。
- **注销失败兜底**：服务端在判定必须失败时即持久化 `mustFailure` 标记（容器收口路径据此拒绝置 `online`/`connecting`）；若强制注销调用失败（瞬时故障），容器会被置为终态 `failed`（保留必须失败 `exitReason`，残留 Job 由巡检回收），或由看门狗重试注销——决不把残缺容器置为可用。
- `.NET` 等预制脚本不含 `required`：未标记的失败行为与现状一致（容器仍可上线）。

**参数注入约定：** worker 对每个 item 以 `process.env` 为基础注入参数环境变量后执行 `bash -c <script>`：

| 环境变量 | 值 |
|---------|----|
| `WORKLOAD_PARAMS` | 完整参数 JSON 字符串（如 `{"version":"22","package_manager":["pnpm"]}`；无参数为 `{}`） |
| `WORKLOAD_PARAM_<KEY_UPPER>` | 单个参数值：字符串原样；布尔为 `"true"`/`"false"`；多选为 JSON 数组字符串（如 `["pnpm"]`） |

- 其中 `KEY_UPPER = key.toUpperCase()`；参数 env 仅对当前 item 生效，不污染后续脚本；
- 不修改脚本文本、不做字符串替换（避免注入）；参数不得改变执行边界、超时与权限；
- `params` 缺省为 `{}` 时行为与旧版一致（仅注入 `WORKLOAD_PARAMS={}`）。

**服务端行为：** 在 emit 之前已于 `cloudworkloadlogs` 批量创建记录（首条 `running`、其余 `pending`，并写入当时脚本快照）；`init` 批次下发同时将容器 CAS 置 `initializing` 并写 `currentWorkloadName`。

**客户端行为：**
- 按 `items` 顺序**串行**执行，每执行完一条立即 emit 一条 `workload:result`；
- 执行方式 `bash -c <script>`（stdout/stderr 合并捕获）；
- 单条超过 `timeoutMs` 时终止整个进程组并回报 `timeout`；
- `post` 批次共享 `budgetMs`：剩余预算耗尽时后续条目直接回报 `timeout`（不启动进程）；
- 单条输出按尾部 ≤ 256 KiB 截断后回报；
- 失败的脚本（非零退出）回报 `failed` 并继续后续条目，不中断批次；**例外**：`phase=init` 且该条 `required === true` 时，回报 `failed`/`timeout` 后不再启动后续条目（服务端仍会中断剩余记录并注销容器）。
- 收到 `post` 批次时若仍有 `init` 子进程在运行，先终止该进程组再执行 `post`；
- 执行期间心跳照常发送；
- **旧版 worker**：不认识 `workload:run` 时直接忽略（无回报），由服务端看门狗兜底将记录标 `timeout`。

**重连重放：** worker 将未被服务端确认的结果保存在内存（上限 50 条），在 Socket 重新 `connect` 后重新 emit；服务端对已进入终态的记录按幂等忽略。

### 2.10 `workload:result`（Worker → Server）

容器回报单条脚本的执行结果。

**Payload:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `logId` | `string` | 是 | 对应 `workload:run` 中 `items[].logId` |
| `status` | `"success" \| "failed" \| "timeout"` | 是 | 执行结果 |
| `exitCode` | `number` | 否 | 进程退出码（`timeout` 时可为 `null`） |
| `log` | `string` | 是 | 合并捕获的 stdout+stderr（尾部 ≤ 256 KiB） |
| `startedAt` | `string` | 是 | 客户端记录的开始时间（ISO；仅并入日志文本，服务端时间戳为准） |
| `finishedAt` | `string` | 是 | 客户端记录的结束时间 |

**服务端行为：**
1. 校验 `logId` 属于该 socket 绑定的容器（防串号），否则拒绝并告警；
2. 记录已进入终态则忽略（幂等）；
3. 更新该记录（`status`/`exitCode`/`log`/`finishedAt`），并将下一条 `pending` 置 `running`、更新容器 `currentWorkloadName`；
4. `init` 批次全部终态后：若容器仍有活跃 socket → CAS 置 `online` 并清空 `currentWorkloadName`；否则置 `connecting`。

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
  │                                      ├──校验 version（>=2.2.0 且 major=2）
  │                                      ├──无 init 脚本 → 绑定 containerId → 状态 online + connectedAt
  │                                      ├──有 init 脚本 → 建执行记录 + 状态 initializing + currentWorkloadName
  │  ←──emit("registered")──────────────│
  │  ←──emit("workload:run"{phase:init})│
  │  ──emit("workload:result")──────────→│  逐条执行并回报
  │                                      ├──推进下一条 / 全部结束 → online（或掉线 → connecting）
  │  ──emit("heartbeat")──────────────→ │  每 30s（连续 3 次丢失判离线 → connecting）
  │                                      │
  │  ──emit("unregister")─────────────→ │  容器主动清理退出
  │  ←──emit("unregistered")───────────│
  │                                      │
  │  ←──emit("workload:run"{phase:post})│  强制销毁（有 post 脚本）：先下发清理批次
  │  ──emit("workload:result")──────────→│  逐条执行并回报（共享 budgetMs）
  │  ←──emit("shutdown")───────────────│  post 完成/预算耗尽后：容器退出 → 服务端删除 Job
```

> **必须项失败分支（本期新增）：** 上述 `init` 批次中，若某条 `required=true` 且结果为 `failed`/`timeout`（含执行前被删除的占位失败、看门狗判定超时），服务端**不推进**剩余 `init`（把剩余非终态记录标 `timeout`），改为走既有销毁链路强制注销容器：CAS `destroying`（token 立即失效）→ 有 post 脚本则下发 `post` 批次 → `shutdown` → 删除 Job → `exited`，`exitReason` 记为 `必须工作负载「<workloadName>」初始化失败`。

### 3.1 握手鉴权

- 传输路径：握手/升级请求走 engine 默认路径 **`/socket.io/`**（`ENGINE_PATH`），namespace `/worker`；入口层须放行 `/socket.io/`。鉴权发生在 Socket.IO 握手 middleware，token 经 `auth.token` 携带。
- token 格式：`<containerId>.<secret>`，`secret` 为随机字节（base64url）。
- 服务端 middleware 从 `handshake.auth.token` 读取 token（兼容遗留 `handshake.query.token`）：
  1. 按 `<containerId>` 定位 `cloudcontainers` 文档（**不做全表扫描**）；
  2. `bcrypt.compare(secret, tokenHash)` 比对；
  3. 文档不存在、`tokenHash` 为空、或容器已处于终态（`exited`/`destroying`/`failed`）→ 拒绝；
  4. 校验失败：`socket.emit('connect_error', 'INVALID_TOKEN')`，记录来源 IP 与原因日志后断开。
- 握手前先按一次性 token 的 `containerId` 前缀（`token` 中首个 `.` 之前的部分，**不运行 bcrypt**）做滑动窗口限速；无 token 时回退来源 IP。另保留一个更高上限的 per-IP 兜底桶，避免 worker 经共享 Ingress IP 回连时被全局限流（缓解 bcrypt CPU 消耗型攻击的同时不误伤批量重连）。
- 校验通过：将 `containerId` 写入 `socket.data`，供后续 `register`/`heartbeat`/`disconnect` 使用。

### 3.2 心跳超时检测

- 容器每 30s 发送 `heartbeat`。
- 服务端计时：连续 3 次（>60s + 缓冲）未收到心跳 → 判定离线，状态退回 `connecting`。
- 离线不自动删除 Job；管理员可通过强制销毁清理（见 PRD 3.5）。
- **`initializing` 例外**：初始化脚本执行期间不受回连超时巡检影响（避免长脚本被误判失败），由工作负载看门狗按「单条超时 + 容差」收口；状态停留在 `initializing` 时也不因心跳缺口直接退回 `connecting`（结果由看门狗推进）。

### 3.3 重连

- 容器断线后按指数退避自动重连，使用注入的同一 token 重新握手。
- 同一容器在存活期间允许重复握手；`register` 成功后状态重新置 `online`。

### 3.4 版本兼容

- 服务端在 `register` 阶段校验完整 `version`（parse → major → 最低版本）：
  1. **形态**：严格三段数字 `^\d+\.\d+\.\d+$`，每段 1~9 位且无前导零；缺失、前后空白、`v` 前缀、缺段/多段、prerelease/build 后缀、非字符串或超长（> 64 字符）均视为不兼容。
  2. **major**：须等于当前支持的 major（本期 `2`）。
  3. **最低版本**：完整版本须 `>=2.2.0`（按数字段比较，`2.10.0 > 2.2.0`）。
- 最低版本与 supported major 是与服务端协议能力绑定的代码常量（`MIN_WORKER_VERSION = '2.2.0'`、`SUPPORTED_MAJOR = 2`），不通过环境变量配置。
- 任一条件不满足返回 `VERSION_MISMATCH`（§2.4，含 `currentVersion`/`minimumVersion`/`supportedMajor`）并 `disconnect(true)`。
- **拒绝副作用约束**：版本校验必须位于所有注册副作用之前——不设置 `socket.data.registered`，不调用心跳计时、初始化脚本查询/下发、`online`/`initializing` 状态迁移，不写入 `connectedAt`，不下发 `workload:run`。因此被拒绝的容器销毁时按「从未完成兼容注册」处理：不发送 shutdown、不等待宽限，直接删除 Job。
- 兼容 worker（`>=2.2.0` 且 major 为 `2`）的注册、心跳、工作负载、重连与销毁协议不变。

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

{
  "purpose": "idle",
  "billingAccountId": "<billingAccountId>",
  "workloadIds": ["<objectId>", "..."],
  "workloadPlan": [
    { "workloadId": "<objectId>", "params": { "version": "22" }, "implicit": false, "required": true },
    { "workloadId": "<objectId>", "params": {}, "implicit": true, "required": false }
  ]
}
```

- `billingAccountId` 可选（费用中心）：非空时容器参与计费，`markOnline` 首次就绪写入 `billingStartedAt` 并经 outbox 投递 `container.ready`；为空表示不计费（存量/未接入计费调用方），不投递计费事件。
- `workloadIds` 可选（缺省或空数组行为与现状一致）。传入时服务端校验：必须为字符串数组、**数组长度（去重前）≤ 10**、去重且保持选择顺序、每个 ID 均为已存在的 `cloudworkloads` 记录；校验通过后按选择顺序落库到容器 `workloadIds`。
- `workloadPlan` 可选，为**已展开、已排序、已去重**的最终执行计划，数组顺序即执行顺序。服务端校验：必须为数组、**长度 ≤ 10**、`workloadId` 去重且全部存在、`params` 为对象（缺省归一为 `{}`）、`implicit` 为布尔（缺省归一为 `false`）、`required` 为布尔（缺省或 `null` 归一为 `false`；非布尔返回 `400` `INVALID_WORKLOAD`）；非法返回 `400` `INVALID_WORKLOAD`。
- `workloadPlan[].required`（可选）语义：本次启动该条是否为「必须」；缺省/`null` 归一 `false`，仅 `true` 生效；仅对含初始化脚本的工作负载产生硬失败语义（见 §2.9「必须失败语义」）。
- 新版 cloud-controller 优先使用 `workloadPlan`：落库到容器 `workloadPlan`，并由 plan 派生出 `workloadIds`（保序），`workloadIds` 字段与 plan 同时下发时为滚动升级兼容。
- 若请求只有 `workloadIds`（旧版 admin-api），cloud-controller 以只读定义做依赖展开与默认参数归一兜底（含隐式依赖），行为与新 admin-api 一致（依赖先于依赖方、去重、参数取默认值；非法默认值返回 `400` `INVALID_WORKLOAD`）。此时容器 `workloadIds` **按选择顺序落库**（不含隐式依赖），兜底展开得到的 `workloadPlan` 仅用于执行——旧版调用方读回 `workloadIds` 时不会看到选择之外的 ID。

**响应 201：** 新建的 `CloudContainer`。

**错误：**
- `400` —— `purpose` 非法（本期仅接受 `idle`；其余用途返回明确错误文案「该任务类型暂未开放」）。
- `400` `INVALID_WORKLOAD` —— `workloadIds` 非数组 / 超过 10 个 / 含不存在的 ID；或 `workloadPlan` 非数组 / 超过 10 个 / `workloadId` 重复或不存在 / `params` 非对象 / `implicit` 非布尔 / `required` 非布尔。
- `500` —— 创建 Job 失败（容器记录标记 `failed` 并保留，可被强制销毁清理）。

#### A.2.3 强制销毁

```
DELETE /internal/containers/:id?reason=<url-encoded reason>
```

**响应 200：**

```json
{ "success": true, "deletedJob": true }
```

`reason`（可选，费用中心强拆）：可直接作为 query 参数，或在 JSON body 中提供 `{ "reason": "..." }`（body 优先）。缺省为「强制销毁」；强拆 reason 固定为「余额不足超过 10 分钟，强制销毁」，写入容器 `exitReason` 可审计。

`deletedJob` 反映**本次调用是否真实执行了 Job 删除**（`false` 表示 Job 已不存在、未重复删除）。调用方据此观察残留 Job 清理是否发生。

**语义：** 在线容器会先收到 `shutdown` 并等待宽限期（约 10s）后删除 Job，再返回；调用方（admin-api）应使用大于「宽限期 + 删除重试上界」的超时。终态容器幂等处理：**Job 已不存在时不再重复删除（仍会核实并清理残留 Job）**。

**错误：**
- `404` —— 容器不存在。
- `200`（幂等）—— 对终态容器重复销毁仍返回成功；`deletedJob` 语义上反映本次是否真实删除了残留 Job。

#### A.2.4 工作负载执行日志

```
GET /internal/containers/:id/workload-logs
```

**响应 200：** `CloudWorkloadLog[]`（JSON 字段见 A.6，按 `createdAt` 升序 = 执行顺序）。

**错误：**
- `404` `NOT_FOUND` —— 容器不存在（容器存在但无记录时返回空数组 `[]`）。

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
| `workloadIds` | `string[]` | 启动时挂载的工作负载 ID，按选择顺序（缺省为 `[]`） |
| `workloadPlan` | `object[]` | 本次启动最终执行计划，顺序即执行顺序；每项 `{ workloadId, params, implicit, required }`（缺省为 `[]`） |
| `currentWorkloadName` | `string \| null` | 初始化中当前正在执行的工作负载脚本名称；非初始化中为 `null` |
| `billingAccountId` | `string \| null` | 计费账户 ID；`null` 表示不计费（存量/未接入计费） |
| `billingStartedAt` | `string \| null` | 就绪计费起点（首次 `markOnline` 的时刻，ISO 时间戳）；`null` 表示未就绪/不计费 |

### A.3.1 容器生命周期计费事件（outbox → RabbitMQ）

cloud-controller 在容器生命周期节点写入集合 `billingoutbox`（与 admin-api 共享，`producer = "cloud-controller"`），
由进程内 relay 经 RabbitMQ publisher confirm 发布到 `zag.billing.events`（topic）。事件写入为
「CAS 状态写成功 → 同步调用 outbox 写入」两步（非同一事务），失败时钩子按 200/500/1000ms 重试 3 次，
SIGTERM 前由 `drainBillingHooks()` 排空在途写入；发布失败的 outbox 行保留 `published=false` 由下一轮按
`createdAt` 顺序重试（**失败即停止本轮**，避免 broker 抖动翻转 ready/destroyed 顺序）。

**事件丢失的兜底覆盖（与实现口径一致）**：
- `container.ready` 单丢：admin-api 反向对账线 `events` 扫描 `billingStartedAt≠null` 且无
  `container.ready` 事件/outbox 的容器补投（消费端按 `eventId` 去重）；即便未补投，`container.destroyed`
  仍可按 `billingStartedAt` 走 legacy 全额计费。
- `container.destroyed` 单丢：`resources` 资源对账线以「ACTIVE 预留 × 存活容器」兜底最终结算（终点推迟一个
  对账间隔）；`events` 线同时扫描终态容器补投 destroyed。
- 两者都丢：`events` 线同时命中（补投 ready + destroyed），不会静默漏计费。
- 消费端按 `resourceId` 做时序门控：`destroyed` 先到且无预留时按 legacy 计费，迟到的 `ready` 不再建预留，
  保证同一会话只产生一笔计费。

| 事件 | routing key | 触发条件 | payload |
|------|-------------|----------|---------|
| 就绪 | `container.ready` | 首次进入 `online`（含初始化完成与无脚本 register 直通两条路径） | `{ billingStartedAt }` |
| 销毁 | `container.destroyed` | `destroying → exited` 成功，且 `billingAccountId` 与 `billingStartedAt` 均非空 | `{ billingStartedAt, exitedAt, minutes? }` |

消息体（与 `contracts/billing-events.asyncapi.yaml` 一致）：

```jsonc
{ "eventId": "container.ready:<containerId>", "eventType": "container.ready",
  "occurredAt": "<billingStartedAt ISO>", "accountId": "<billingAccountId>",
  "resourceId": "<containerId>", "payload": { "billingStartedAt": "<ISO>" } }

{ "eventId": "container.destroyed:<containerId>", "eventType": "container.destroyed",
  "occurredAt": "<exitedAt ISO>", "accountId": "<billingAccountId>",
  "resourceId": "<containerId>", "payload": { "billingStartedAt": "<ISO>", "exitedAt": "<ISO>" } }
```

重复 `markOnline` 不重置 `billingStartedAt`、不重复投递；未就绪即销毁不投递 `container.destroyed`。

### A.4 状态枚举

`creating` → `connecting` →（有初始化脚本则 `initializing`）→ `online` → `destroying` → `exited`，失败终态 `failed`。

| 值 | 说明 |
|----|------|
| `creating` | 已落库，Job 创建中 |
| `connecting` | Job 已创建，等待容器回连 |
| `initializing` | 容器已回连，正在按序执行挂载工作负载的初始化脚本（`currentWorkloadName` 为当前脚本名） |
| `online` | 容器已回连注册（初始化已完成或未挂载初始化脚本） |
| `destroying` | 销毁流程进行中（**瞬时态**，必然迁移到 `exited`） |
| `exited` | 容器已退出、Job 已回收 |
| `failed` | 启动失败或异常退出 |

**终态与巡检约定：**

- `destroying` 是瞬时态：销毁流程正常结束即写回 `exited`；若进程在销毁中途被 SIGTERM 打断而卡在 `destroying`，周期性巡检会回收残留 Job 并将记录迁移为 `exited`（`destroying → exited`，写入 `exitedAt`/`exitReason`），不会永久停留。
- `exited` 表示 Job 已回收：若销毁时 `deleteJob` 失败（记录仍标注「需人工清理」），巡检会持续重试删除残留 Job；`failed`/`exited`/`destroying` 记录均纳入残留 Job 对账兜底。
- `creating` 记录进行中（`start()` 已落库、`createJob` 尚未完成）时，watch 断连对账在宽限期内跳过不判定失败；若长时间（超过回连超时阈值）仍未推进，超时巡检会兜底迁移 `failed`（`exitReason「Job 创建超时」`），避免进程在落库后崩溃留下永久 `creating` 孤儿。

### A.5 用途枚举

| 值 | 说明 |
|----|------|
| `idle` | 空闲测试（本期唯一可启动用途） |
| `admin-task` | 管理后台任务（构建等，预留） |
| `workflow` | 用户工作流（预留） |
| `session` | 独立会话（预留） |

### A.6 CloudWorkloadLog JSON 结构

`GET /internal/containers/:id/workload-logs` 返回的每条记录结构（与 `contracts/admin-cloud-workload.graphql` 的 `CloudWorkloadLog` 对齐；枚举值小写）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 记录 ID |
| `containerId` | `string` | 所属容器 ID |
| `workloadId` | `string` | 工作负载 ID |
| `workloadName` | `string` | 名称快照（工作负载被编辑/删除后仍可读） |
| `phase` | `string` | `init` \| `post` |
| `status` | `string` | `pending` \| `running` \| `success` \| `failed` \| `timeout` |
| `script` | `string` | 当时实际执行的脚本内容快照（留档） |
| `params` | `object` | 本次执行实际使用的参数值快照（已归一，含默认值）；历史记录缺省为 `{}` |
| `required` | `boolean` | 本次启动该项是否为「必须」（快照）；历史记录缺省为 `false` |
| `exitCode` | `number \| null` | 进程退出码 |
| `log` | `string` | 合并捕获的输出（尾部 ≤ 256 KiB） |
| `startedAt` | `string \| null` | 开始时间（ISO） |
| `finishedAt` | `string \| null` | 结束时间（ISO） |
| `createdAt` | `string` | 记录创建时间（ISO，用于排序） |
