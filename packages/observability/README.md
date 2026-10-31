# packages/observability

规范化日志与全链路可观测性**单源共享模块**（见 `contracts/observability.md` 与 `docs/engineering/plan/20261030-feat-unified-logging-and-otel.md`）。

## 结构

```
src/
├── logger.ts        # pino 工厂（REDACT_PATHS / parseLogLevel / createLogger / 单例 logger）
├── log-context.ts   # AsyncLocalStorage<LogContext>（runWithLogContext / readContext）
├── trace.ts         # withSpan / injectTraceparent / extractTraceparent / publishJson
├── telemetry.ts     # OTel SDK 启停（未配置 endpoint 完全不启动）
├── register.ts      # 入口首个 import 的副作用（SDK + 进程兜底）
├── http-context.ts  # httpContext() 中间件（requestId / span / 访问日志）
└── testing.ts       # createTestLogger()（仅测试引用）
```

本目录**不提供 `package.json`**（避免被误当可安装包/触发发布）。服务名与版本由 vendored 副本所在包的 `package.json` 自解析，因此 7 个文件对 5 个运行时**逐字节全等**。

## vendor 流程（唯一合法同步方式）

```bash
node scripts/sync-observability.mjs          # 单源 → 5 包 src/observability/**
node scripts/sync-observability.mjs --check  # 只校验不写入（CI / 一致性测试复用）
```

生成物文件头为 `// GENERATED FROM packages/observability/src/<file> — DO NOT EDIT`。

**禁止直接改副本**。修改共享能力的正确姿势：

1. 改 `packages/observability/src/**`（唯一写方）；
2. 跑 `node scripts/sync-observability.mjs`；
3. 把单源与 5 份副本一起提交。

## 纪律

- 调用签名统一 pino 原生 `logger.<level>(objOrMsg, msg?)`；错误对象进 `err` 字段；禁止 variadic 与字符串拼接。
- `mixin()` 是上下文字段唯一注入点，业务代码不手工传 `requestId`/`trace_id`。
- 高频通道（`session:message` 等）不开逐条 span；Redis 发布一律经 `publishJson`。
- `src` 内 `console.*` 由每包 `src/observability/no-console.test.ts` 守卫（白名单：行内 `// no-console-allow: <原因>`）。
