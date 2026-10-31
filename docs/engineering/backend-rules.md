# Backend Development Rules

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode)
- **Framework**: Express (v5) with GraphQL-Yoga
- **ORM/ODM**: Mongoose (MongoDB ODM)
- **API Style**: GraphQL (primary) + REST health endpoints
- **Testing**: Vitest
- **Package Manager**: npm
- **Module System**: ESM (`"type": "module"`)
- **Formatter**: Prettier
- **Dev Runner**: tsx (watch mode)

## Project Structure

```
servers/agent-api/
├── src/
│   ├── config/           # Configuration (env, db, etc.)
│   ├── graphql/
│   │   ├── schemas/      # GraphQL type definitions
│   │   └── resolvers/    # GraphQL resolvers
│   ├── models/           # Mongoose models
│   ├── services/         # Business logic layer
│   ├── middleware/       # Express middleware
│   └── index.ts          # Entry point
├── tests/
├── contracts/            # GraphQL schema files (referenced from root)
├── tsconfig.json
└── package.json
```

## GraphQL Conventions

- Define schema and resolvers in separate files.
- Use `@graphql-tools/schema` for schema stitching.
- Keep resolvers thin; delegate business logic to services.

## Naming Conventions

- **Files**: `kebab-case` (e.g., `agent-resolver.ts`)
- **Classes**: `PascalCase`
- **Functions/Variables**: `camelCase`
- **GraphQL Types**: `PascalCase`
- **Environment Variables**: `UPPER_SNAKE_CASE`

## Pitfalls & Lessons

### 并发与顺序

- **「落库后推送」的并发写入必须用序字段或串行化兜底**。`create` 时同步生成 ObjectId、`await` 之后再 publish 的写法，在并发下必然导致「推送序 ≠ `_id` 序」。凡依赖推送顺序的链路（SSE 直推、chunk 拼接），写入方应针对同一 key（如 sessionId）做 per-key 串行化，保证落库序 = 到达序 = 推送序。
- **跨频道异步链路必须假设乱序**。经 Redis pub/sub 分发的「命令」与「消息」在接收端不保证处理顺序，凡「先启动会话再发消息」的模式都要在接收端做排队补发（按 sessionId 入队，就绪后按序补发）；「发送失败」不允许静默 return，至少要记日志。

### 状态机

- **组合操作要考虑自动状态机**。引擎会自动推进节点/会话状态（如 READY→RUNNING），人工操作接口不能假设起始状态，应按当前状态幂等处理（例如 `completeHumanNode` 需区分「待开始补 start」与「已 RUNNING 直接 complete」）。
- **状态机放宽要配全链路检查**。放宽转移源状态（如 `resume` 允许 `disconnected`）看似一行改动，但需逐一确认下游每个环节对该状态兼容（队列、前端按钮解锁、轮询新鲜度），并跑通「断连→重连→恢复」全流程 E2E 才算闭环。

### 能力探测

- **能力数据的获取时机要区分**。CLI 版本检查（`--version`）≠ 会话能力：`modes`/`availableModels` 只在真实 `session/new` 响应中存在，配置阶段没有会话可查。需要「按类型空实例探测」这类按需懒加载链路，并按 `controllerId+type` 缓存避免重复拉起。

### 兜底策略

- **「兜底 N 次后静默」等于隐性死节点**。防御性兜底（防死循环）必须配升级路径（失败状态 + 通知），否则最坏情况恰是最需要感知的情况。

### Mongoose

- **嵌套子文档必须考虑 Mongoose 空对象物化**。schema 声明的 nested subdocument 即使从未赋值也会以 `{}` 出现，GraphQL 非空字段会直接崩查询。新增嵌套结构时应同步添加字段 resolver 归一化（空为 null），并用 API 测试覆盖「混合类型列表 + 消费方真实查询字段」。
- **resolver 合并清单是隐性陷阱**。`resolvers/index.ts` 手工枚举合并键，新增类型级 resolver（非 Query/Mutation）时必须登记，否则单元测试（直接引用 resolver 对象）无法发现未生效。

### 聚合信息

- **聚合信息应尽早沉淀到持久层**。用户在客户端「现查现配」不可靠（存在时序竞争与窗口限制）；在 agent-api 落库时聚合透传后，前端展示链路自然简化且可测试。

### 日志与可观测性

- **`mixin` 与 AsyncLocalStorage 的生效边界**。日志上下文（`requestId`/`trace_id`/`userId` 等）经 `runWithLogContext` + pino `mixin()` 自动注入，但它只在 AsyncLocalStorage 能延续的异步链内生效：Socket.IO 的 `emit` 回调与事件回调、`setTimeout`/事件发射器跨界处**不会自动延续上下文**，必须在处理器入口显式 `runWithLogContext({ ... })` 再执行业务；`httpContext()` 的访问日志回调（响应回调）同样不是天然在请求上下文中，需手动恢复上下文后再记日志，否则访问日志丢 `requestId`/`trace_id`。
- **pino 第二参数是插值参数，`logger.warn('msg', err)` 会静默丢错误**。pino 原生签名 `logger.<level>(objOrMsg, msg?)` 的第二参是格式化插值参数，不是附加对象——`logger.warn('msg', err)` 里的 `err` 被当作插值参数消费（无占位符即被丢弃），排障时只剩一条无堆栈的 msg（比不改还差）。错误对象一律进 `err` 字段：`logger.warn({ err }, 'msg')`。全仓迁移判据：grep 逐条确认无「第二参数为 Error/对象」残留的 variadic 调用。
- **OTel SDK 必须作为入口首个 import**。`src/index.ts`（agent-gear 为 `src/index.ts`）首行 `import './observability/register.js'` 必须先于 express/mongoose/socket.io 等一切依赖加载：Node 模块只被 patch 一次，若 SDK 启动前 express/mongoose 已加载，自动埋点静默失效（手工 span 与日志仍正常，链路缺入口 span 极难察觉）。新增入口/脚本进程同样遵守；测试与 CLI 子命令无需启动 SDK（未配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 时 SDK 完全不启动）。
- **migration 例外（已知偏差登记）**。`src/migrations/**` 不允许修改（历史不可变），迁移文件保留原 `console` 输出、`no-console` 守卫跳过 `migrations` 目录、新写迁移不强制结构化。这与实现计划 §4.5/§4.6 的迁移条目是已知偏差，以 `common-rules.md`「日志与可观测性规范」的 migration 例外条目为准。
