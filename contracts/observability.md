# 规范化日志与全链路可观测性契约 v1

## 1. 概述

定义全平台（`agent-api` / `controller-api` / `admin-api` / `cloud-controller` / `agent-gear`）统一的结构化日志契约、OpenTelemetry 环境变量契约、W3C Trace Context 传播规则、脱敏名单与降级语义。前端（`agent-web` / `admin-web`）日志为开发期排障输出，不适用本契约的字段要求。

本契约是日志字段字典 / env 名 / 传播位的**唯一裁决面**：5 个运行时、共享模块 `packages/observability` 与测试全部对齐本文件；变更须先改本文件再改实现。

### 1.1 术语

| 术语 | 说明 |
|------|------|
| 共享观测模块 | `packages/observability/src/`（唯一写方），经 `scripts/sync-observability.mjs` 生成 5 份逐字节全等副本 `src/observability/` |
| 结构化日志 | pino 单行 JSON 输出至 stdout（fd 1），容器运行时按行采集 |
| traceparent | W3C Trace Context `traceparent` 头（`00-<trace-id>-<span-id>-<flags>`） |

---

## 2. 日志记录契约

每条日志为**单行 JSON**，字段如下：

| 字段 | 类型 | 必填 | 来源 / 说明 |
|---|---|---|---|
| `level` | string | ✅ | pino `formatters.level`（字符串：`debug`\|`info`\|`warn`\|`error`\|`fatal`） |
| `time` | string | ✅ | `pino.stdTimeFunctions.isoTime`（ISO 8601，可 `Date.parse`） |
| `service` | string | ✅ | `OTEL_SERVICE_NAME` ?? `package.json.name`（`admin-api`/`agent-api`/`controller-api`/`cloud-controller`/`agent-gear`） |
| `serviceVersion` | string | ✅ | `package.json.version` |
| `env` | string | ✅ | `NODE_ENV`（缺省 `development`） |
| `hostname` | string | ✅ | pino 默认（K8s 下即 Pod 名） |
| `pid` | number | ✅ | pino 默认 |
| `msg` | string | ✅ | `messageKey: 'msg'`；描述「发生了什么」，变量一律进字段而非拼接 |
| `component` | string | ⬜ | `logger.child({ component })`（如 `socketio`、`session-command`、`migration/015`） |
| `trace_id` / `span_id` | string | ⬜ | `mixin()` 从活跃 span 自动注入；无活跃 span 时缺省 |
| `requestId` | string | ⬜ | `httpContext` → `runWithLogContext`（见 §5.2） |
| `userId` / `tenantId` / `workspaceId` / `sessionId` / `controllerId` / `cloudHostId` / `containerId` / `workflowInstanceId` / `nodeId` | string | ⬜ | `runWithLogContext` 上下文字段（见 §5.3） |
| `err` | object | ⬜ | 错误对象（`pino.stdSerializers.err`：`{ type, message, stack, code? }`）；错误一律进 `err` 字段 |
| `durationMs` | number | ⬜ | 访问日志与耗时事件 |

**调用签名**：统一 pino 原生签名 `logger.<level>(objOrMsg, msg?)`。禁止 variadic 兼容形态（如 `logger.warn('msg', err)`，第二参会当插值参数被静默丢弃）；禁止字符串拼接（`logger.info('a' + b)`），变量进 `obj` 字段。

**级别口径**：

| 原 console | 迁移目标 | 适用 |
|---|---|---|
| `console.log` | `info` | 生命周期 / 结果（一次操作至多一次） |
| `console.log` | `debug` | 高频细节（一次正常业务操作会打印多次：按消息 / 按分片 / 按轮询） |
| `console.error` | `error` | 错误对象一律进 `err` 字段 |
| `console.warn` | `warn` | — |
| `console.info` | `info` | — |

级别不得随手升级：`log` 全升 `info` 会让 debug 级别失去收敛能力。

---

## 3. 环境变量契约

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error`；非法值回落 `info` |
| `LOG_PRETTY` | 空 | `1` = 人类可读 pretty 输出（**仅 `NODE_ENV !== 'production'`**；生产忽略该值并 `warn` 一次，仍输出 JSON） |
| `OTEL_SDK_DISABLED` | 空 | `true` = 强制关闭 OTel SDK |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | **空 = 不启用导出**（SDK 完全不启动：不注册 exporter、不开线程、零外发） |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 固定 HTTP（gRPC 不支持） |
| `OTEL_EXPORTER_OTLP_HEADERS` | 空 | 采集端鉴权头（`k=v` 逗号分隔）；**禁止出现在任何日志**，仅经 env 传递 |
| `OTEL_SERVICE_NAME` | 包名 | 覆盖 `service` 字段 |
| `OTEL_RESOURCE_ATTRIBUTES` | 空 | 追加资源属性（`k=v` 逗号分隔） |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | 采样器 |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | 采样比例（`0`~`1`） |
| `OTEL_METRICS_ENABLED` | `true`（有 endpoint 时） | `false` = 关闭基础指标（只出 trace） |
| `OTEL_EXPORT_TIMEOUT_MS` | `5000` | 单次导出超时（毫秒），超时丢弃本批、不重试放大 |
| `ZAG_INIT_TRACEPARENT` | 空 | **非人工配置**：cloud-controller 创建云电脑 Job 时生成并注入，容器内 `agent-gear` 用于把 `startup` span 以 link 关联创建链路 |

---

## 4. 传播规则（W3C Trace Context）

链路上下游通过 `traceparent`（可选 `tracestate`）传递 trace 上下文，共四条通道：

| 通道 | 承载位 | 注入方 | 提取方 |
|---|---|---|---|
| HTTP | 请求头 `traceparent` | HTTP 客户端 / fetch 埋点 | `httpContext` 中间件 |
| Socket.IO | 握手 `auth.traceparent`；事件报文顶层 `_meta: { traceparent?: string }` | Socket.IO 客户端（`io(url, { auth: { traceparent } })`）；`emit` 统一注入 `_meta` | 握手 middleware / 事件处理器入口 |
| Redis 封套 | 频道报文顶层 `_meta: { traceparent?: string }` | `publishJson(publish, channel, payload)` | 订阅回调 `extractTraceparent(payload._meta)` |
| Job env | `ZAG_INIT_TRACEPARENT` | cloud-controller `buildHarnessJobEnv`（仅在 `container.start` span 存在时注入） | 容器内 `agent-gear`（`startup` span 以 link 关联，不作 parent） |

**通用约束**：

- `_meta` 为平台自定义保留位，**不写入 ACP payload**（ACP 协议自身的 `_meta` 字段与本契约无关，见 `agent-session-websocket.md`）。
- 所有消费者**必须容忍 `_meta` 缺失**（旧客户端 / 历史报文无 `_meta` 时行为不变）。
- 旧 worker / 旧容器忽略未知字段与未知 env，互不影响（向后兼容）。
- 无效 / 非法 `traceparent` 一律忽略（视为缺失），不得报错。

---

## 5. 共享观测模块（`packages/observability`）

### 5.1 文件与写方纪律

| 文件 | 职责 |
|---|---|
| `logger.ts` | pino 工厂（`createLogger`）、`REDACT_PATHS`、`parseLogLevel`、单例 `logger`、`ObservationLogger` 类型 |
| `log-context.ts` | `AsyncLocalStorage<LogContext>`：`runWithLogContext`（合并而非覆盖）/ `readContext`（空对象兜底） |
| `trace.ts` | `withSpan`（支持 `links`）/ `injectTraceparent` / `extractTraceparent` / `currentTraceIds` / `publishJson` |
| `telemetry.ts` | `startTelemetry`（未配置 endpoint 完全不启动）/ `shutdownTelemetry`（幂等，2s 上限） |
| `register.ts` | 入口**首个 import** 的副作用：启动 SDK + `uncaughtException` / `unhandledRejection` 兜底（不加载 dotenv） |
| `http-context.ts` | `httpContext()` 中间件：requestId 归一化、traceparent 提取、SERVER span、访问日志 |
| `testing.ts` | `createTestLogger()`：内存 sink + `records` 逐行 JSON 解析（仅测试引用） |

- `packages/observability/src/**` 是**唯一写方**；5 个运行时的 `src/observability/**` 为生成物（文件头 `// GENERATED FROM ... — DO NOT EDIT`），禁止手改。
- 修改共享模块流程：改 `packages/observability/src` → `node scripts/sync-observability.mjs` → 提交全部副本。

### 5.2 requestId 归一化（`x-request-id`）

- 入站 `x-request-id` 合法（`/^[A-Za-z0-9._:-]{8,128}$/`）则沿用；缺失生成 UUID v4；非法生成 UUID v4 并在日志中标注 `requestIdReplaced: true`（不静默替换）。
- 响应头回写 `x-request-id`。

### 5.3 日志上下文（`LogContext`）

`runWithLogContext(ctx, fn)` 合并入当前上下文（不覆盖已有键）；`mixin()` 自动注入，业务代码不手工传 `requestId`/`trace_id`。

### 5.4 访问日志降噪

- `/health` 与 K8s 探针路径以 `debug` 记录（默认级别不可见）；其余请求 `info`。
- `/api/session-stream`（SSE）**只在连接建立与断开各记一条**，不按事件记。

---

## 6. 脱敏名单与审计例外

### 6.1 `REDACT_PATHS`（全量，`censor: '[REDACTED]'`）

```
req.headers.authorization        req.headers.cookie
headers.authorization            headers.cookie
authorization                    cookie
token  accessToken  refreshToken  idToken
password  passwordHash  secret  clientSecret  privateKey
apiKey  modelApiKey
*.token  *.password  *.secret  *.apiKey
secrets  secrets.*
err.config.headers.authorization
```

### 6.2 审计例外（唯一）

| 键 | 位置 | 语义 |
|---|---|---|
| `bootstrapAdminPassword` | `admin-api` 首次初始化管理员 | 首次 seed 时明文输出**一次**，`msg` 必须含「审计例外」标记；`bootstrapAdminPassword` 不进入 `REDACT_PATHS` |

防扩散约束：其余 `*Password` / `password` 键**必脱敏**（`T-OBS3b` 断言）；新增例外必须先改本契约。

### 6.3 其他

- 既有 `sanitizeVersionForLog`（cloud-controller）、`sanitizeOperationError`（agent-api）、`SECRET_ENV_KEYS`+`REDACTED`（agent-gear `workload-executor.ts`）保持不变，日志层再兜一层。
- 请求体（body）与 `OTEL_EXPORTER_OTLP_HEADERS` 的值**禁止**出现在日志中。

---

## 7. 采样与降级语义

| 场景 | 行为 |
|---|---|
| 未配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `OTEL_SDK_DISABLED=true`） | SDK 完全不启动：无 exporter、无线程、零外发、`currentTraceIds()` 为空；日志完全不受影响 |
| 采样丢弃 | `parentbased_traceidratio`（父已采样则子跟随）；被丢弃的请求**仍输出完整日志**，仅无 `trace_id` 字段（日志与采样解耦） |
| 导出超时 | 5s 超时丢弃本批，只 `debug` 记一条，不重试放大 |
| 高频通道 | `session:message` / ACP `agent_message_chunk` / 工作负载日志轮询 / 心跳与 watch **不开逐条 span**；在「连接生命周期」「批次」「订阅回调入口」开一个 span 并以属性记录条数（`messaging.batch.message_count`） |
| pretty 降级 | 非生产 `LOG_PRETTY=1` 且 `pino-pretty` 不可 `require` 时降级 JSON 并 `warn` 一次 |
| 进程崩溃 | `uncaughtException`：`logger.fatal` 后 `exit(1)`；`unhandledRejection`：`logger.error` |

---

## 8. 云电脑 Job env 注入（摘要）

cloud-controller 创建 Job 时经 `buildHarnessJobEnv` 注入（详见 `cloud-controller-websocket.md` 附录 B）：

- 已配置采集端：`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_HEADERS`（如配置）/ `OTEL_SERVICE_NAME=agent-gear` / `OTEL_TRACES_SAMPLER` + `OTEL_TRACES_SAMPLER_ARG` / `OTEL_RESOURCE_ATTRIBUTES`（含 `zag.container.id`、`zag.cloud.host.id`、`zag.user.id`、`zag.tenant.id`、`zag.workspace.id`）/ `ZAG_INIT_TRACEPARENT`。
- 未配置采集端：仅注入 `OTEL_SDK_DISABLED=true`。

---

## 9. 兼容性

- 全部变更为可加性：`_meta` 缺失、env 缺失、旧容器均按旧行为工作。
- 不提升 worker / harness 版本门禁；旧容器仅日志为旧格式。
- 不新增 / 删除任何 GraphQL 字段。
