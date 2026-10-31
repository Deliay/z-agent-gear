# admin-api

管理后台后端：为 `admin-web` 提供管理员登录、全局 LLM 供应商/模型、云端容器与工作负载管理、租户只读管理与开户、费用中心（Credits 计费）等能力；经内部 REST 调用 agent-api / cloud-controller，不直连 K8s。

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + GraphQL-Yoga
- **ODM**: Mongoose (MongoDB)
- **Message Queue**: RabbitMQ（amqplib，计费事件 outbox → MQ）
- **Dev Runner**: tsx (watch mode)
- **Testing**: Vitest

## Architecture

```
src/
├── config/           # Environment configuration
├── graphql/
│   ├── schemas/      # GraphQL type definitions（auth/provider/model/base-image/cloud-container/cloud-workload/billing/tenant）
│   └── resolvers/    # GraphQL resolvers
├── models/           # Mongoose models（billing 计费集合、租户/工作区只读镜像、cloudcontainers/cloudworkloads 只读）
├── services/         # Business logic（billing/ 含 MQ 发布消费与对账、cloud-controller-client、llm-api）
├── routes/           # REST 内部端点（internal-billing、billing-openai）
├── middleware/       # Express middleware（管理员鉴权、billing key、client-ip）
├── migrations/       # 数据迁移（admin_migrations 账本）
└── index.ts          # Entry point（首行 import './observability/register.js'）
```

- **域划分**：admin-tenant（前台租户只读管理、开户/团队开通转发 agent-api `/internal/users|/internal/tenants`）/ llm（全局供应商、模型、基础镜像、模型来源）/ cloud-host（云端容器、工作负载、预制脚本，经 cloud-controller 内部 REST 操作）/ billing（费用中心：账户、账单、收据、API Key、对账、计费事件）/ auth（管理员登录、强制改密、守卫）。
- **只读镜像纪律**：`cloudcontainers`/`cloudworkloads`/`cloudhosts`/`tenants` 等为只读镜像，写方各自单一（cloud-controller / agent-api）；billing 集合写方仅本服务。

## 日志与可观测性

- **日志形态**：pino 单行 JSON（vendored `src/observability/`），字段字典与调用签名见 [`contracts/observability.md`](../../contracts/observability.md) §2 与 [`common-rules.md`](../../docs/engineering/common-rules.md)「日志与可观测性规范」。`httpContext()` 提供 `x-request-id` 归一化、HTTP SERVER span 与访问日志（`/health` 为 debug）。
- **span 清单**：
  - `messaging.process` — RabbitMQ 计费消费循环**批次 span**（属性 `messaging.batch.message_count`，不逐消息开 span；发布/消费由 amqplib 自动埋点覆盖）。
- **审计例外（契约 §6.2 唯一）**：`bootstrapAdminPassword` — 首次 seed 管理员时明文输出**一次**（`msg` 含「审计例外」标记），不进 `REDACT_PATHS`；其余 `password`/`token`/`secret` 类键一律脱敏（`T-OBS3b` 断言边界）。
- **`MqLogger` = pino 子集**：`services/billing/mq/connection.ts` 的 `MqLogger` 即共享模块 `ObservationLogger` 类型；billing 全部调用走 pino 原生签名（禁止 variadic 与字符串拼接）。
- **migration 例外**：`src/migrations/**` 不允许修改（历史不可变），迁移文件保留原 `console` 输出（`no-console` 守卫跳过 `migrations` 目录），见 `common-rules.md`「migration 例外」。
- **env 变量**：`LOG_LEVEL` / `LOG_PRETTY`（仅非生产）/ `OTEL_SDK_DISABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`（**空 = 零外发**）/ `OTEL_EXPORTER_OTLP_HEADERS`（**禁止出现在任何日志**）/ `OTEL_SERVICE_NAME` / `OTEL_TRACES_SAMPLER(+_ARG)` 等，完整契约见 [`contracts/observability.md`](../../contracts/observability.md) §3。
- **排障**：`LOG_PRETTY=1 npm run dev` 看人类可读输出；`LOG_LEVEL=debug` 看高频细节；`OTEL_SDK_DISABLED=true` 关追踪导出（日志不受影响）；JSON 单行日志可直接 `grep`（`grep '"level":"error"'`、`grep '"trace_id":"<trace-id>"'` 跨服务串链路、`grep '"requestId":"<id>"'` 串一次请求）。

## Dev Commands

```bash
aspire start             # Start all services via Aspire orchestration
npm run build            # Compile TypeScript (tsc)
npm test                 # vitest run
LOG_PRETTY=1 npm run dev # 单独启动（tsx watch），pretty 人类可读日志
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 admin-api 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)
- [可观测性契约](../../contracts/observability.md)
