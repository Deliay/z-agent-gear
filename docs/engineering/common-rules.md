# Common Development Rules

## Development Flow

1. **Skill-First**: Always check if a relevant skill exists before starting work. Load the skill first.
2. **Contract-First**: Define API contracts (GraphQL schema, OpenAPI spec) before implementation.
3. **TDD**: Write tests before implementation code where possible.
4. **Product Doc Review**: Load and review product documents before starting implementation.
5. **Code Review**: All code must be reviewed before merging to main.

## TDD Workflow

采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

### 1. 规划阶段
- 确认需要哪些接口变更
- 确认需要测试哪些行为（按优先级排序）
- 识别创建深模块的机会（小接口，深实现）
- 设计可测试的接口
- 列出要测试的行为（不是实现步骤）
- 获得用户对计划的批准

### 2. 示踪子弹
编写一个测试，验证系统的一个行为：
```
RED:   编写第一个行为的测试 → 测试失败
GREEN: 编写最少代码使测试通过 → 测试通过
```

### 3. 增量循环
对每个剩余行为：
```
RED:   编写下一个测试 → 失败
GREEN: 编写最少代码使测试通过 → 通过
```

规则：
- 一次只写一个测试
- 只写刚好能通过当前测试的代码
- 不要预测未来的测试
- 保持测试专注于可观察行为

### 4. 重构
所有测试通过后，寻找重构候选：
- 提取重复代码
- 深化模块（将复杂性移到简单接口后面）
- 在自然的地方应用SOLID原则
- 考虑新代码揭示了现有代码的什么问题
- 每个重构步骤后运行测试

**永远不要在RED状态时重构。先达到GREEN状态。**

详细指南请参考：[[../../.agents/skills/tdd/SKILL.md|tdd]]

## Branch Convention

- `main` — production-ready code
- `feat/<name>` — new features
- `fix/<name>` — bug fixes
- `refactor/<name>` — refactoring
- `docs/<name>` — documentation changes

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat: add agent connection management
fix: resolve websocket reconnection issue
docs: update API documentation
refactor: extract agent service
test: add agent resolver tests
```

## Code Quality

- All code must pass TypeScript strict mode checks.
- Maintain test coverage above 80%.
- Run lint and type checks before every commit.
- No commented-out code in production branches.

## Review Requirements

- At least one approval required for PR merge.
- All automated checks must pass.
- No direct pushes to `main` branch.

## 日志与可观测性规范

统一结构化日志与全链路追踪的**唯一裁决面**是契约 [`contracts/observability.md`](../../contracts/observability.md)（字段字典 / env 契约 / 传播规则 / 脱敏名单 / 审计例外）。本节是日常编码口径摘要；与契约冲突时以契约为准，变更须先改契约再改实现。

### 字段字典（与契约 §2 一致）

每条日志为**单行 JSON**（pino 输出 stdout，容器运行时按行采集）：

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

调用签名统一 pino 原生 `logger.<level>(objOrMsg, msg?)`：第一参为对象（字段）或字符串，`msg` 是固定短语；变量进 `obj` 字段，错误对象进 `err` 字段。

### `logger` 用法正反例

正例：

```ts
logger.info({ userId, sessionId }, 'session created');       // 变量进字段，msg 固定短语
logger.error({ err, controllerId }, 'workload dispatch failed'); // 错误对象进 err 字段
const log = logger.child({ component: 'session-command' });  // 组件名用 child 注入
log.debug({ sessionId, chunkCount }, 'message chunk batched'); // 高频细节用 debug
```

反例：

```ts
console.log('session created');                  // ❌ 禁止 console（src 内硬门禁，见下）
logger.info('user ' + id);                       // ❌ 字符串拼接：变量应进 obj 字段
logger.warn('msg', err);                         // ❌ 变参形态：第二参被当插值参数，错误对象被静默丢弃
logger.error('failed: ' + err.message);          // ❌ 双重错误：拼接 + 丢 stack；应 { err }
logger.info('session created', sessionId);       // ❌ 变参形态：sessionId 不会成为字段
```

级别口径（原 console 迁移对照，详见契约 §2）：生命周期/结果 → `info`（一次操作至多一次）；高频细节（按消息/按分片/按轮询）→ `debug`；错误对象 → `error` + `err` 字段；`console.warn` → `warn`。级别不得随手升级（`log` 全升 `info` 会让 debug 级别失去收敛能力）。

### 禁止事项

- **不用 `console`**：`src` 内 `console.*` 由每包 `no-console` 守卫硬门禁（测试命中即失败）。
- **不用 variadic 调用签名**：禁止 `logger.warn('msg', err)` 这类第二参当插值参数的形态（错误会被静默丢弃）。
- **高频通道不逐条开 span**：`session:message` / ACP `agent_message_chunk` / 工作负载日志轮询 / 心跳与 watch 只在「连接生命周期」「批次」「订阅回调入口」开一个 span 并以属性记条数（`messaging.batch.message_count`）。
- **不打印 headers / body / `OTEL_EXPORTER_OTLP_HEADERS`**：请求体与该 env 的值禁止出现在任何日志；鉴权头/cookie/token/password/secret/apiKey 一律走 `REDACT_PATHS` 脱敏（契约 §6）。

### `no-console` 守卫与白名单

- 守卫位置：每运行时包的 `src/observability/no-console.test.ts`（T-OBS7），递归扫描本包 `src` 下全部 `.ts`（含测试文件），命中 `console.<level>(` 即失败。
- 行内白名单：在该行末尾标注 `// no-console-allow: <原因>`（守卫会统计输出白名单条目）；新增白名单必须写明原因，禁止无理由豁免。
- **migrations 目录除外**（见下「migration 例外」）：`src/migrations/**` 不在守卫范围。

### vendor 修改流程（共享观测模块）

`packages/observability/src` 是共享观测模块的**唯一写方**；5 个运行时的 `src/observability/**` 是逐字节全等的生成物（文件头 `// GENERATED FROM ... — DO NOT EDIT`），**禁止手改副本**（T-OBS8 一致性测试会拦截漂移）。修改共享能力的唯一合法流程：

1. 改 `packages/observability/src/**`；
2. 跑 `node scripts/sync-observability.mjs`（校验用 `--check`）；
3. 把单源与 5 份副本一起提交。

详见 [`packages/observability/README.md`](../../packages/observability/README.md)。

### migration 例外（已知偏差登记）

**`src/migrations/**` 不允许修改**（历史不可变：已执行的迁移不得改写，避免账本与历史输出漂移）。因此迁移文件保留原 `console` 输出，`no-console` 守卫跳过 `migrations` 目录，新写迁移也不强制结构化。这与实现计划 `plan/20261030-feat-unified-logging-and-otel.md` §4.5/§4.6 的迁移条目（要求迁移改为 `logger.child({ component: 'migration/NNN' })`）是**已知偏差**，以本条为准。

## Test Pitfalls

- **API 测试能确定性复现分布式时序 bug**。fake 上游高频连发 + 真实 Mongo/Redis + SSE 接收的组合，把单测中需精心构造的竞态在集成环境直接暴露，是此类 bug 最有效的回归手段。
- **真实 agent 的确定性覆盖边界**。真实 opencode 的 initialize/session/new 可确定性验证（能力协商、握手回归），但触发 agent 主动发起动作需要 LLM 决策，不确定性部分用 wire 级 fake agent（同一协议字节流）补齐，形成「真实握手 + 协议字节流 + 全链路 stub」三层覆盖。
- **测试进程环境要隔离宿主 env**。spawn 真实进程做集成测试时，`{ ...process.env }` 会把宿主配置覆盖变量（如 `ZAG_CONTROLLER_KEY`）带进被测进程，config 优先级（CLI > env > file）会放大该问题。
- **状态机语义演进要回填测试断言**。状态语义变更（如拆出 `idling`）后，存量测试期望旧值会形成基线腐化；应全局检索测试断言同步更新。
- **E2E 与 API 套件不宜并行跑在同一套服务上**。二者共用 Mongo/Redis/服务进程，并行会造成超时型假失败；验收验证应串行执行或隔离环境。
- **fake controller 秒回响应会掩盖竞态**。API/E2E 测试中的假 controller 应有意识地引入延迟变体（如 `startDelayMs`），才能覆盖真实 harness 的慢启动场景（如「start 完成前发送的消息需排队补发」）。
- **动画中的元素尺寸断言会抖动**。入场 zoom 动画期间 `boundingBox()` 量到的是缩放后的尺寸，宽度断言应用 `clientWidth`（布局尺寸，不受 transform 影响）。
- **会话关闭后其 MCP scoped token 随之失效**。E2E/集成测试模拟「人类介入后 AI 调工具」时，需先恢复会话拿到新签发的 token 再调 MCP。

## Available Skills

| Skill | Description |
|-------|-------------|
| z-product | Product document creation and lifecycle management (PRD workflow) |
| z-project | Project creation and management (monorepo support, tech stack selection) |
| z-coding | Contract-based development workflow (proposal, contract, implementation) |
| z-git | Git workflow management (using worktree) |
| z-document | Documentation standards (Zettelkasten method, Mermaid diagrams) |
| z-aspire-orchestrator | Service orchestration with Microsoft Aspire |
| z-test | API testing and E2E testing workflow |
| z-debugging | Debugging methodology and troubleshooting |
| tdd | Test-driven development with red-green-refactor loop |
