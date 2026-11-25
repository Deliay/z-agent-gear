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
- **只读镜像纪律**：`cloudcontainers`/`cloudworkloads`/`cloudhosts`/`tenants` 等为只读镜像，写方各自单一（cloud-controller / agent-api）；billing 集合写方仅本服务。`accounts` 同为 agent-api 只读镜像，字段变更双服务同 PR（#510 已同步 `passwordless`，仅展示/查询，不参与写入）。

## 日志与可观测性

- **日志形态**：pino 单行 JSON（vendored `src/observability/`），字段字典与调用签名见 [`contracts/observability.md`](../../contracts/observability.md) §2 与 [`common-rules.md`](../../docs/engineering/common-rules.md)「日志与可观测性规范」。`httpContext()` 提供 `x-request-id` 归一化、HTTP SERVER span 与访问日志（`/health` 为 debug）。
- **span 清单**：
  - `messaging.process` — RabbitMQ 计费消费循环**逐消息一个 span**（metering/settlement 消费回调即「订阅回调入口一个 span」口径；`messaging.batch.message_count` 固定 `1`，批内不逐步骤开 span；发布/消费由 amqplib 自动埋点覆盖），登记见 `contracts/observability.md` §4。
- **审计例外（契约 §6.2 唯一）**：`bootstrapAdminPassword` — 首次 seed 管理员时明文输出**一次**（`msg` 含「审计例外」标记），不进 `REDACT_PATHS`；其余 `password`/`token`/`secret` 类键一律脱敏（`T-OBS3b` 断言边界）。
- **`MqLogger` = pino 子集**：`services/billing/mq/connection.ts` 的 `MqLogger` 即共享模块 `ObservationLogger` 类型；billing 全部调用走 pino 原生签名（禁止 variadic 与字符串拼接）。
- **migrations 结构化口径**：`src/migrations/**` 与其它源码同规格（`logger.child({ component: 'migration/<编号>-<名称>' })`，`no-console` 守卫扫描全部 `src` 含 `migrations`，任何新增 `console` 即红），见 `common-rules.md`「migrations 结构化口径」。
- **env 变量**：`LOG_LEVEL` / `LOG_PRETTY`（仅非生产）/ `OTEL_SDK_DISABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`（**空 = 零外发**）/ `OTEL_EXPORTER_OTLP_HEADERS`（**禁止出现在任何日志**）/ `OTEL_SERVICE_NAME` / `OTEL_TRACES_SAMPLER(+_ARG)` 等，完整契约见 [`contracts/observability.md`](../../contracts/observability.md) §3。
- **排障**：`LOG_PRETTY=1 pnpm run dev` 看人类可读输出；`LOG_LEVEL=debug` 看高频细节；`OTEL_SDK_DISABLED=true` 关追踪导出（日志不受影响）；JSON 单行日志可直接 `grep`（`grep '"level":"error"'`、`grep '"trace_id":"<trace-id>"'` 跨服务串链路、`grep '"requestId":"<id>"'` 串一次请求）。

## Dev Commands

```bash
aspire start             # Start all services via Aspire orchestration
pnpm run build            # Compile TypeScript (tsc)
pnpm test                 # vitest run
LOG_PRETTY=1 pnpm run dev # 单独启动（tsx watch），pretty 人类可读日志
```

本项目由 Aspire 编排启动，无需单独运行 `pnpm run dev`。使用 `aspire describe` 查看 admin-api 的 HTTP endpoint。

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

## 第三方登录配置与绑定（#503）

- **`authproviders` 唯一写方**：`models/auth-provider.ts` + `migrations/022-auth-providers.ts`（索引幂等创建）+ `services/auth-provider.ts`。OIDC 可多条；GitHub 通过 `{type:1}` 部分唯一索引保证全平台单条。agent-api 只读镜像，迁移索引声明必须逐字一致。
- **secret 红线**：入库前 `encrypt()`；一切出参经白名单装配，恒不含明文/密文 secret，以 `hasSecret` 表示已设置；更新省略 `clientSecret` = 保持不变。`OidcProvider/GithubOauthConfig` 均出参 `callbackUrl`（`AGENT_API_PUBLIC_URL` + `/api/auth/oauth/callback`）。
- **绑定域**：`models/admin-external-login.ts` + `services/admin-external-login.ts`（唯一写方）；`adminexternallogins` 两唯一索引 `{providerId,issuer,subject}`、`{adminUserId,providerId}`。
- **内部端点**：`routes/internal-auth.ts`（Bearer `INTERNAL_API_TOKEN` + `timingSafeEqual`）。`POST /internal/auth/admin-tickets` 校验绑定 → 签 admin JWT → Redis 一次性 ticket 60s（未绑定 403 `NOT_BOUND`）；`POST /internal/auth/admin-bind` GETDEL bindTicket → upsert（无效 400 `INVALID_BIND_TICKET`、身份已绑他人 409 `ALREADY_BOUND`）。
- **GraphQL**：`adminAuthProviders` / `adminExchangeLoginTicket` 免登录白名单；`adminExternalLogins` / `createAdminBindTicket` / `unbindAdminExternalLogin` 走 `assertAdmin`。契约见 `contracts/admin-auth-provider.graphql`、`contracts/auth-oauth.md`。
- **测试**：`services/auth-provider.service.test.ts`、`migrations/022-auth-providers.test.ts`、`services/admin-external-login.test.ts`、`routes/internal-auth.test.ts`、`graphql/resolvers/auth-provider.test.ts`、`graphql/schemas/auth.contract.test.ts`；API 全链路 `tests/api/src/admin-api/auth-provider.test.ts`。

## Harness 平台配置（#525）

- **`harnessconfigs` 唯一写方**：`models/harness-config.ts`（`HARNESS_CONFIG_TYPES = ['OPENCODE','KIMI_CODE','DEEPSEEK_HARNESS']`、集合名 `harnessconfigs`、唯一索引 `uniq_harness_config_type`）+ `services/harness-config.ts`。agent-api 只读镜像（工作流返工/复工恢复原始会话时解析压缩指令），写方变更须双服务同 PR。
- **迁移 023 幂等种子**：`migrations/023-harness-configs.ts`（`name = '023-harness-configs'`，已登记 `src/index.ts` 的 `runMigrations([...])`）。建唯一索引 + 对三 Harness `$setOnInsert` upsert 默认 `/compact`（已存在不覆盖用户配置，走原生 collection 避免 Mongoose `timestamps` 在重跑时改写 `updatedAt`）。
- **服务口径**：`DEFAULT_COMPACT_COMMAND = '/compact'`；`validateCompactCommand(raw)` trim 后长度 1~64 且以 `/` 开头，非法抛 `invalid compact command`；`validateHarnessType` 非法抛 `invalid harness type`；`listConfigs()` 恒返回三 Harness（未落库行以默认值归一，`updatedAt` 用稳定占位 `new Date(0).toISOString()`）；`upsertConfig()` = 校验 → `findOneAndUpdate` upsert（`returnDocument:'after'`，trim 后落库）→ 视图。
- **GraphQL 登记点**：`graphql/schemas/harness-config.ts`（`extend type Query/Mutation`，字段与 `contracts/admin-harness.graphql` 逐字一致）+ `graphql/resolvers/harness-config.ts`（`Query.adminHarnessConfigs` / `Mutation.upsertHarnessConfig`，均 `assertAdmin`；错误经 `mapError` 同 auth-provider 形态：GraphQLError 直抛、E11000 → `配置已存在`、其余 message 逐字透传）。两处**必须**在 `schemas/index.ts` 与 `resolvers/index.ts` 登记，漏登记运行时无效。
- **测试**：`services/harness-config.test.ts`（T-HCA1/2）、`graphql/resolvers/harness-config.test.ts`（T-HCA3 + index 守卫）、`migrations/023-harness-configs.test.ts`（T-MIG-HC1/2，MongoMemoryServer 真库）；API 全链路 `tests/api/src/admin-api/harness-config.test.ts`。

## 模型变更全局下发与网关显示口径（#533）

- **通知器**：`services/model-push-notifier.ts#notifyModelConfigChanged()`——未配置 `AGENT_API_URL`/`INTERNAL_API_TOKEN` 时
  warn 返回；否则 `POST {AGENT_API_URL}/internal/model-config/refresh`（body `{scope:'global'}`、Bearer token、5s 超时、
  fire-and-forget，异常只 warn）。调用点：所有 global 模型 mutation（创建/导入/删除/启停/排序/上下文）与全部 global
  供应商 mutation 的**成功路径**；失败/未命中零调用。
- **网关显示口径**：`routes/billing-openai.ts` 的 `toModelEntry(model, ownedBy)`——`scope=global` → `Agent Gear`，
  `scope=user`（含存量无 scope）→ 绑定供应商名称；account Key 列表恒 `Agent Gear`；供应商映射一次查询
  （`select({isEnabled:1,name:1})`），无 N+1；`/chat/completions` 仍是「global 优先 → user 回退 → 404
  `model_not_found`」，禁用即时生效、进行中请求不中断（仅测试锁定）。
- **上游上下文元数据**：`services/llm-api.ts#fetchModelCatalog` 与 agent-api 同口径白名单
  （`context_length/context_window/max_context_length/max_input_tokens/input_token_limit` → 正整数；
  `max_tokens`/`max_output_tokens` 不取；Anthropic 恒无；单条异常隔离）。`listProviderModels` 透出 `contextLength`；
  `importModels` 单次拉取同时做连通性门禁与 `name→contextLength` 写入（未提供保持 null），既有去重/错误文案不变。

## Github 预制脚本 V3（024，Issue #566）

- **迁移 024**：`migrations/024-github-gh-wrapper.ts`（`name = '024-github-gh-wrapper'`，已登记 `src/index.ts` 的 `runMigrations([...])`）把 Github 预制工作负载脚本从 V1/V2 收敛到 V3：安装 `/usr/local/bin/gh` wrapper（marker `# zag-gh-wrapper:v1` 位于第 2 行），按当前目录 git origin 经 `agent-gear github-token` 申请项目级 `GITHUB_TOKEN` 后 `exec` 原生 gh。
- **幂等口径**：真实 gh + 已是最新 wrapper → 锚点早退；安装脚本对「镜像预装 gh / 无 wrapper 旧容器 / 已是 V3」重复执行均收敛到同一份 wrapper；管理员定制脚本 `warn` 跳过不覆盖；安装期一律 `ZAG_GH_WRAPPER_SKIP_TOKEN=1 gh --version`（不触发项目识别/网络）。wrapper 自身的仅一非零退出场景是找不到真实 gh（127），token 获取失败只打一行 stderr 并照常执行原生 gh。
- **019 同步**：`019-workload-idempotent-anchors` 的 github 目标改为 `oldScripts:[V1,V2] / newScript:V3`，避免 DB 已是 V3 时每次启动误报「script modified by admin」。
- **测试**：`migrations/024-github-gh-wrapper.test.ts`（T-MIG-GW1~6）、`024-github-gh-wrapper.behavior.test.ts`（T-WRP1~10，真跑 bash + stub agent-gear/原生 gh）。

## 容器规格与规格分段计费（#574）

- **规格聚合（唯一写方）**：`models/cloud-host-spec.ts`（集合 `cloudhostspecs`）——`name` trim 1..64 unique、`cpu` 0..64 / `memoryGi` 0..256 / `ephemeralStorageGi` 0..512（整数）、`whitelistEnabled`、`allowedTenantIds`（String）、`isPreset`、`presetKey` partial unique（同 `cloudworkloads` F16）、`{whitelistEnabled,allowedTenantIds}` 索引。组合规则：全零（不限制）为唯一允许含 0 的组合，其余三项均 ≥1。错误文案逐字：`name is required` / `name is too long` / `spec name already exists` / `invalid spec resources` / `invalid tenant in whitelist`；白名单 ≤200，`whitelistEnabled=false` 保存时服务端置空名单（D10）。
- **迁移 025**：`migrations/025-preset-cloud-host-specs.ts` 播种 6 款预制规格（`8c16g-20g` / `8c8g-20g` / `4c8g-20g` / `2c4g-10g` / `1c2g-5g` / `unlimited-0c0g`），`unlimited-0c0g` 默认 `whitelistEnabled:true` + 空名单；`presetKey` → `name` 双查命中即跳过（不覆盖管理员修改；删除不重建由迁移账本单次执行保证），并显式 `CloudBillingCursor.createIndexes()` 兜底。
- **GraphQL**：`graphql/{schemas,resolvers}/cloud-host-spec.ts`（`adminCloudSpecs` / `adminCloudSpec` / CRUD，resolver 白名单透传错误文案）；必须在 `schemas/index.ts` 与 `resolvers/index.ts` 登记。
- **计价**：`services/billing/spec-pricing.ts#quoteSpecHourly` 七档超额累进（CPU 4 核分档、内存 4/8/16 四档、临时存储 >10GiB 计费；全零恒 0）；`pricing.ts` 播种七档 `cloud_spec.*` 价目（`$setOnInsert` 不覆盖调价），默认 8C 16G 20G = 820 credits/小时。
- **结算**：`models/cloud-billing-cursor.ts`（`cloudbillingcursors`，`resourceId` unique、`{closedAt,lastChargedAt}`）+ `services/billing/spec-tick.ts` 小时桶：桶锚点 `billingStartedAt`、活跃 `due=floor`、单次最多 24 桶、逐桶按桶末取价、幂等键 `cloud_host.spec.hour:<resourceId>:<bucketEndEpochHour>`；销毁写 `destroyedAt` 并结算全部未结整桶 + 尾段 `ceil(minutes)`（幂等键 `cloud_host.spec.tail:<resourceId>`）后 `closedAt`；失败记 `lastError` + `markInsufficient` 下个 tick 重试。调度 `SPEC_BILLING_TICK_MS`（默认 300000）。
- **出账**：`services/billing/spec-charge.ts` 复用 payment/invoice/receipt 幂等口径（`category=container`、`refType=cloud_host`、`refId=hostId`，items 为分档明细并按分钟折算分摊）；`/internal/billing/spec-quote?specId=` 或三元组实时报价（`{hourlyCredits,tiers,prices}`，不缓存）。
- **事件分流**：`services/billing/billing-service.ts#handleContainerReady` **只看 payload 是否携带 `spec`**——携带则 upsert 游标（`hostId` 由 `cloudcontainers` 只读镜像解析），不携带走既有 `container.minute` 预留路径逐字不变；0C 0G 同样走新路径但不出账（D11）。destroyed 有游标 → `specTickService.settleTail`；无游标 → 旧链路。防御日志：镜像含 `specId` 而事件无 spec → warn。
- **测试**：`spec-pricing.test.ts`（T-SPQ）、`spec-tick.test.ts`（T-SPT）、`spec-dispatch.test.ts`（T-SP-API5）、`cloud-host-spec.test.ts`（T-SPV）、`migrations/025-preset-cloud-host-specs.test.ts`（T-MIG-SP）；API 见 `tests/api/src/admin-api/cloud-host-spec.test.ts`。
