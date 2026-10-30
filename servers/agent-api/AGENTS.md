# agent-api

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + GraphQL-Yoga
- **ODM**: Mongoose (MongoDB)
- **Cache**: Redis (via Aspire)
- **Dev Runner**: tsx (watch mode)
- **Testing**: Vitest

## Architecture

```
src/
├── config/           # Environment configuration
├── graphql/
│   ├── schemas/      # GraphQL type definitions
│   └── resolvers/    # GraphQL resolvers
├── models/           # Mongoose models
├── services/         # Business logic
├── middleware/        # Express middleware
└── index.ts          # Entry point
```

## 会话能力快照与模型来源

- **PR 联动事件入口**：`routes/event-callback.ts`（`POST /api/events/callback`，平台 token 或 GitHub 验签双通道）与 `routes/github-webhook.ts`（`POST /api/events/github/webhook`，GitHub 原生 webhook 直连，仅 `X-Hub-Signature-256` 验签 + `GITHUB_WEBHOOK_SECRET`，仅处理 `pull_request_review` submitted，经 `services/workflow/github-webhook-payload.ts` 归一化）都必须在全局 `express.json()` 之前挂载（验签需要原始字节）；两者共用 `handlePullRequestEvent` 判定链。
- `Session.agentCapabilities` 读取 controller-api 落库的 `sessions.agentCapabilities`；`Session.features` 由 `services/agent-capabilities.ts` 的 `featuresFromSnapshot()` 输出（无快照返回 `[]`，不复制 FeatureId 矩阵）。
- `Session.availableModels` 为字段级 resolver：按平台模型库（`ModelService.listSourceLibrary()`，`AVAILABLE_MODELS_FILTER` 同口径）三档推断来源（`services/model-source.ts`：库比对 → 标识前缀 → 兜底），同一 GraphQL 请求只查一次库（`AuthContext.modelLibraryPromise`）。
- `TodoItem.resolution/resolvedAt/expiresAt`：`respondElicitation` 写 `accepted|declined|cancelled`；订阅 `elicitation:resolved` 后 `timeout→expired`、`unsupported_mode→failed`、`cancelled→cancelled`。TTL（5 分钟）保持不变。
- **终态写入不变量（`TodoService.markElicitationResolved`）**：filter 必须同时包含 `userId` 与 `resolution: null`——
  前者做租户隔离（缺 `userId` 直接拒绝写入），后者保证终态单调（迟到的 timeout 不得覆盖已 accepted/declined）。
  事件缺 `requestId` 时按 `sessionId + userId` 会话级兜底；契约外 `reason` 收敛为 `failed` 并告警。
  `todoitems` 上为 `elicitationData.requestId` 建了索引（迁移 006 显式创建，避免关闭 autoIndex 时缺失），避免全集合扫描。
- **响应动作归属校验**：`respondPermission` / `respondElicitation` 先调 `isRespondableTodo(userId, requestId, type)`
  （问询还要求 `resolution: null`），未命中直接抛 `Todo item not found or already handled`，**不向 Agent publish**；
  `markTodoAsResponded` / `markElicitationCompleted` 缺 `userId` 直接返回 false（Mongoose 会剥离 undefined 条件，必须显式拒绝）。
- 新增或修改 `Session` 字段级 resolver 时，必须在 `graphql/resolvers/index.ts` 的 `Session` 键登记，否则线上字段不生效（backend-rules 陷阱）。

## 默认 MCP 与 ACP 选项缓存

- **默认 MCP 口径**：`Controller.defaultMcp`（`{useAllEnabled, serverIds}`）为字段级 resolver，历史行归一为 `{useAllEnabled:true, serverIds:[]}`，并剔除已删除 MCP id。`setControllerDefaultMcp` 校验 `MCP_SERVER_NOT_FOUND` 后落库。
- **会话注入（`services/session.ts` 的 `resolveInitialMcpServerIds` 纯函数）**：`CreateSessionInput.mcpServerIds` **undefined 才走控制器默认**（`useAllEnabled` → 全部已启用；否则 `serverIds ∩ 已启用`）；显式 `[]` 表示不注入。云会话额外自动并入 `agent-cloud-host-tools`，与用户选择互不影响。
- **选项缓存**：controller-api `acp:options:<controllerId>:<serverType>` 成功 TTL 300s、失败 60s；`refreshAcpServerOptions` 主动清缓存并重探测（失败返回空选项，不阻断建会话）；`Model` mutation（增删改/排序/启停）经 `services/acp-options-cache.ts` 的 SCAN 失效当前用户全部控制器缓存；后台（系统内置 / global）模型变更不在 agent-api 作用域内，最长由 300s TTL 兜底（PRD v1.2 取舍），「刷新」按钮可立即重取。
- **云电脑创建/项目准备开关**：`createCloudHost(createDefaultSession:false)` 时 ready 不建默认会话（由 setup 的 session 步骤建项目会话）；`setupCloudHostGithubProject(createSession:false)` 时 session 步骤记 SKIPPED（多 Harness 场景）。

## Dev Commands

```bash
aspire start    # Start all services via Aspire orchestration
npm run build   # Compile TypeScript
npm run start   # Start production server
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 agent-api 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 首页聚合查询

`homeOverview`（`graphql/schemas/home.ts` + `graphql/resolvers/home.ts`）为薄聚合 resolver：用 `Promise.all` 并行组合既有 service，**不新增 service 层**；单分支失败降级为空值（数组/0），不拖垮整次查询。`Controller.gateways` 为嵌套惰性字段，仅查询语句选择时才执行，且是**纯 DB 查询**（`gatewayService.findAllByController`），不依赖控制器在线状态、离线不降级；`ControllerWorkspace.worktrees` 同样惰性，经 **Redis relay** 扇出，离线或失败/超时降级为空列表。

新增 Query/类型级 resolver（含 `WorkflowInstance.workspace` / `controller`）必须登记 `graphql/resolvers/index.ts`，否则线上不生效。

## 前台云电脑（harness）

- 领域入口：`services/cloud-host-service.ts`；GraphQL：`graphql/schemas/cloud-host.ts` + `graphql/resolvers/cloud-host.ts`；契约 `contracts/cloud-host.graphql`。
- 生命周期：创建即启动 → 停止即销毁（`STARTING/RUNNING/STOPPING/STOPPED/FAILED`，无 `startCloudHost`）。数量无限制（PRD v1.0：创建收费 5 credits、失败退款；`userMutex` 仅串行化创建，需单实例部署）。
- 版本映射：`HARNESS_MIN_AGENT_GEAR_VERSION`（`OPENCODE: 2.6.0` / `KIMI_CODE: 2.8.0` / `DEEPSEEK_HARNESS: 2.11.0`——`cordis.patch.yml` 的 `header-masq` 会话标识配置注入自 agent-gear 2.11.0 起）与基线 `CLOUD_HOST_AGENT_GEAR_MIN_VERSION='2.10.0'` 取**最大值**后随 `startHarness` 下发 `agentGearMinVersion`；cloud-controller 注册门禁再按 `harnessTypes` 取最大（含 `deepseek_harness` → `2.11.0`）。
- 创建编排：校验开关/名称/harnessTypes/配置 → 读取 `cloudworkloads` preset → 计费账户 → 预生成 cloudHostId/controllerId → **`/internal/billing/charges` 先扣一次性创建费（幂等键 `cloud_host.create:<hostId>`）** → `ControllerKey(type=cloud)` → 预创建 `Controller(type=cloud,registering,name=用户命名)` → `CloudHost(STARTING)`（`githubAccountId` 可选锁定；创建期不预置默认工作区，`workspaceId` 留空）→ 铸造 `scope=cloud_host` 模型 Key（**无固定有效期，随容器回收**）→ `POST /internal/containers{purpose:harness}`。失败逆序回滚并 best-effort 退款（`cloud_host.create.refund:<hostId>`）；cloud-controller 成功后不再回滚。未 ready 即终态同样自动退款，已 ready 后销毁不退款。
- 只读模型：`models/cloud-container.ts`（cloudcontainers）、`models/cloud-workload.ts`（cloudworkloads）、admin-api 只读 `cloudhosts`；写方各自单一。
- 内部回调：`routes/internal-cloud-host.ts`（Bearer `INTERNAL_API_TOKEN`）。ready → **单 harness 默认会话在 STARTING 窗口创建后与 RUNNING/readyAt 合并为一次 CAS 落库**（避免 `RUNNING+defaultSessionId=null` 竞态；失败只告警）；`CreateCloudHostInput.createDefaultSession=false` 时跳过默认会话（由 Git 项目 setup 的 session 步骤建项目会话）；terminal → STOPPED/FAILED + 批量 ENDED + 撤销模型 Key；均幂等。
- 会话只读：停止时 `sessionService.endByController`；`resume`/`sendSessionMessage`/`cancelGeneration` 对云电脑非 RUNNING/软删返回 `session is ended`；`createSession` 对 cloud Controller 校验 `CloudHost.status===RUNNING` 且 `acpServerType` 必须在 `harnessTypes` 映射内，落库前后各复查一次（缩小与 stop/terminal 的竞态窗口）。`Session.controllerType`/`Session.cloudHost`（含软删除留档）由 `resolvers/session.ts` 的 `Session` 类型 resolver 提供，**必须在 `graphql/resolvers/index.ts` 登记 `Session` 键**（否则运行时恒 null）；前端只读判定不依赖 controllers 列表命中。
- 创建⇄停止并发：`startHarness` 成功后以 `{_id,status:'STARTING'}` CAS 回写 `containerId`；CAS 未命中（并发 stop 已推进）立即销毁容器并撤销模型 Key；stop 以 CAS 后的最新快照决定销毁，终态 CAS 后再扫一次会话。每用户数量无限制：`uniq_active_cloud_host_per_user` 由迁移 `011-drop-cloud-host-active-unique-index` 下线（schema 声明已移除，迁移 005 只读不回改）。
- `KeyedMutex` 非可重入：同异步上下文嵌套同 key 会立即抛错（`AsyncLocalStorage` 检测），避免永久挂起。
- 删除：仅 `STOPPED/FAILED`，软删除 `cloudhosts.deletedAt`、撤销 ControllerKey、`Controller.status=offline`；Controller/会话/消息保留，列表与首页过滤。`Controller.cloudHost` 对软删除返回 null，前端对 `type=cloud && cloudHost=null` 同样按只读渲染。
- 开关：`HARNESS_ENABLED=false` 时 capabilities 隐藏/禁用、create 返回 `harness feature is disabled`；存量仍可 list/stop/delete。

## 云主机工作负载与 Github 项目设置（本期）

- 工作负载目录：`services/cloud-workload-catalog.ts`（只读 `cloudworkloads`，`listStandard` 排除 harness）；Github 预制项 `presetKey=github`，参数 `repoFullName`/`targetPath`。
- 创建期预装负载：`CreateCloudHostInput.workloadIds`（可选，去重后 ≤5）。`services/cloud-host-workload-plan.ts` 的纯函数 `resolveCreateWorkloadPlan` 做后序 DFS 展开（依赖先行、去重、环检测、`implicit` 由是否在显式集合中决定 = 显式优先于隐式；harness presets 在前 `required=true`，standard 项 `required=false`，展开后 ≤10 条）；默认参数归一与 cloud-controller `normalizeDefaultParamValue` 同口径（MULTI_SELECT 去重保留首序、TEXT ≤1024、SELECT 必须属于 options、未知类型报错）。agent-api 在**落库前**完成校验与展开，并随 `startHarness` 下发**非空显式 workloadPlan**（cloud-controller 的 `hadExplicitPlan` 校验）。错误文案：`too many workloads (max 5)` / `invalid workload: <id>` / `workload is not installable: <name>` / `invalid workload parameter: <key>` / `dependency workload not found: <id>` / `dependency cycle detected` / `workloads exceed 10`（均在 `toCloudHostGraphQLError` 白名单内原样透传）。不传 `workloadIds` 时计划与历史完全一致。
- 创建弹窗数据源：`cloudHostWorkloadCatalog` 查询（`cloudHostWorkloadService.listCatalog()`）无主机上下文，返回全部 standard 且 `installed=false`；与 `cloudHostWorkloads` 共用 `CloudHostWorkloadItem`（含 `workloadKind`，standard 固定 `STANDARD`）。
- Github clone 路径：`SetupCloudHostGithubProjectInput.targetPath` 是**前缀地址（工作根目录）**，不是最终目录。`services/workspace-path.ts` 的 `normalizeWorkspacePrefix`（绝对路径或以 `~`/`~/` 开头（展开为容器主目录 `/home/worker`，仅首字符生效，`~abc` 拒绝）、拒绝 `..`/反斜杠/NUL、`path.posix.normalize` 规整）+ `resolveClonePath`（`path.posix.join`，repo 必须 `owner/repo` 且两段非 `.`/`..`）在 `CloudHostGithubService.createOperation` 内权威计算 finalPath；operation/binding/脚本参数/`ensureWorkspace` 一律使用 finalPath，旧绑定记录保持原值。`~` 展开矩阵见 `workspace-path.test.ts` 的 T-PATH8/T-PATH9。
- 编排：`services/cloud-host-workload-service.ts`（列表、单步安装、`cloud_host_setup_operations` runner、`pollBatch` 1s 轮询、单步超时 `CLOUD_HOST_SETUP_STEP_TIMEOUT_MS`）；`services/cloud-host-github-service.ts`（三步：Github 工作负载 → Git 项目设置 → 会话创建）。操作创建后立即返回，前端/ MCP 轮询终态；查询时 RUNNING 超过 `CLOUD_HOST_SETUP_STALE_MS` 标记 FAILED「操作已中断，请重试」。
- 凭据：`POST /internal/cloud-hosts/:controllerId/github-credential` 双鉴权（`INTERNAL_API_TOKEN` 或 Controller key），仅返回本机 `cloud_host_github_bindings` 绑定仓库的 `{token,expiresAt}`；`GitHubService.createRepoScopedToken` 使用 installation token + `repositories`，权限对齐 App 安装授权（actions/contents/deployments/environments/issues/pull_requests/workflows 均 write）。token 不落库/不写日志/不进 operation error（统一 `sanitizeOperationError`）。
- **凭据缓存最小剩余有效期（修复：Github 凭据不再自动续期）**：`createRepoScopedToken(accountId, repo, options?: { minRemainingMs })`，进程内 `repoTokenCache` 命中要求 `expiresAt - now > minRemainingMs`（缺省 `TOKEN_EXPIRY_MARGIN_MS` 5min，Check Runs / Issues 同步语义不变）；未达要求但仍在 5min 硬余量之上**只 miss 不删除**（小余量调用方仍可复用）。凭据端点固定传 `CONTAINER_CREDENTIAL_MIN_REMAINING_MS = 55min`（`internal-cloud-host.ts`，= agent-gear `REFRESH_INTERVAL_MS` 50min + `EXPIRY_SKEW_MS` 10min 的安全下限，留 5min 时钟余量），否则容器第 50 分钟续期会命中仅剩 10min 的缓存 token。回归：`T-GH9`、`T-ICG2`。
- GraphQL：`cloudHostWorkloads`、`cloudHostSetupOperation`、`installCloudHostWorkload`、`setupCloudHostGithubProject`、`retryCloudHostSetupOperation`；`CloudHost.defaultWorkspace/workloadInstalling` 为类型级 resolver（已登记 `resolvers/index.ts`）。
- 报价与 Github 帐号锁定：`cloudHostBillingQuote`（`createCredits`/`perMinuteCredits`/`availableBalance`，金额 credits）聚合 `/internal/billing/price-quote` 与账户余额，计费不可用时余额为 null、价格回退 5/1；`CloudHost.githubAccountId` 创建时可选锁定，首次 Git 项目设置 CAS `{githubAccountId:null}` 绑定一次，已锁定异帐号抛 `github account is locked`（不提供解绑换绑）。
- MCP：平台服务 `agent-cloud-host-tools`（`transport/source=platform`），工具 `workload_list`/`workload_install`；云会话 `sessionService.create` 自动装配，非云会话不装配；`workload_install` 等待终态（上限 10 分钟），执行记录 `source=mcp`。
- 会话：`controllerWorkspaceService.ensureWorkspace` 按路径幂等 upsert（不触发 10 个工作区上限）；Git 设置成功后自动建会话，失败仅 session 步骤 FAILED、operation 仍 SUCCEEDED 并提示手动建会话；`createSession=false` 时 session 步骤记 SKIPPED（多 Harness 不自动建会话）。

## Commit 设置与提交身份（成员级）

- 数据：`models/user-commit-setting.ts`（集合 `user_commit_settings`，`userId` String 唯一键
  `uniq_user_commit_setting`）；**成员独立、无共享/继承**，任何工作区下同一份设置。
  字段仅 `userId / tenantId（留档）/ committerType(custom|unset) / customName / customEmail /
  commitWithBot`（布尔，默认 false，仅 custom 生效）；`committerMode` / `githubAccountId` / `workspaceId` 已下线。
- **作用域插件豁免（返工修正）**：该集合**既不挂 `applyWorkspaceScope` 也不挂 `applyTenantScope`**。
  `applyTenantScope` 会在查询编译期把 `tenantId` 注入为当前 ALS 工作区租户，导致同一成员
  「团队工作区保存 / 个人工作区读取」互相不可见、二次保存撞 `uniq_user_commit_setting` 后回读落空
  而**静默丢失**、Issue 链路（无 ALS）解析不到——与「成员独立、任何工作区同一份」矛盾。
  跨租户泄漏不成立（`userId` 是全局唯一主键）；`models/tenant-isolation.test.ts` 对该集合显式豁免
  并断言「查询不注入 tenantId」，`services/commit-settings-service.real.test.ts` 用真库 + 真实插件
  覆盖跨上下文读写（T-CS-R1~R4）。
- 读写口径：一律 `{ userId }` 点查/upsert，**不读取 ALS 工作区上下文**；`tenantId` 恒写成员归属租户
  （`users.tenantId`，personal 租户 `_id`=userId），与迁移 019 `cleanFields` 的刷新口径一致。
- 迁移：`019-commit-settings-per-member`（编号 017/018 已被占用）：`github_account` → `custom`
  等价转换（`login` + `<githubUserId>+<login>@users.noreply.github.com`，帐号缺失 → unset）、
  归属重键（personal → tenantId=owner userId；team → 行内 userId；碰撞保留最新非 unset）、
  字段清洗（` committerMode/githubAccountId/workspaceId`）、索引「先建后删」。
  注意顺序：**先建新唯一索引再删旧索引，最后才 ` workspaceId`**（旧唯一索引下多行置空会撞键）。
  归属判定按**租户**`type`（`workspaces.type` 只有 global/normal，不是归属依据）。
- 契约：`contracts/github.graphql` 的 `CommitterType { CUSTOM UNSET }` / `CommitSettings` /
  `CommitSettingsInput` / `commitSettings` / `updateCommitSettings` / `personalGithubAccounts`
  （`schemas/github.ts` + `resolvers/github.ts`，未登录 `Not authenticated`）。
  服务端校验白名单**仅一条** `invalid custom committer`（trim 后 name ∈ (0,100]、email ≤254、
  禁 `\n\r\0`、邮箱正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`）。
- `personalGithubAccounts`：`User.accountId` → 同账户 users → personal 租户 id（`_id` 复用 userId）
  → `GitHubAccount` 按 `tenantId ∈ personal` 且 `workspaceId ∈ {null, 本租户全局工作区}` 过滤
  （排除普通工作区副本）；实现为 `githubService.getPersonalAccounts`（直查 collection，绕 workspace-scope）。
- `commit-settings-service`：`getCommitSettings/updateCommitSettings`（userId upsert，`UNSET` 归一
  `commitWithBot=false`）、`resolveWorktreeCommitter(userId) → {name,email,coAuthorName?,coAuthorEmail?}|null`
  （custom 且合法才返回；`commitWithBot=true` 时解析 `resolveAppBotIdentity` 追加 bot 身份，失败降级为
  仅成员署名）、`resolveCloudHostIdentity()` = **恒 bot**（`resolveAppBotIdentity` → `{mode:'agent_only'}`；
  bot 失败 `{mode:'unset'}`）。`mode` 包络仅为兼容 2.11.x 容器 `consume()`，不再有 co_author/human_only。
- 内部端点：`POST /internal/cloud-hosts/:controllerId/commit-identity` 与 `github-credential` 双鉴权一致
  （`INTERNAL_API_TOKEN` 或本机 Controller key，401/403），**永不 404**，恒 200；**无视个人设置恒 bot**。
- 下发链：`git:worktree:add` 可选 `committer {name,email,coAuthorName?,coAuthorEmail?}`；
  `workflow/instance.ts` 实例化时解析一次并落 `WorkflowInstance.worktreeCommitterName/Email` +
  `worktreeCoAuthorName/Email` 快照（issue 触发人覆盖 > 创建者设置），实例级与节点级
  worktree（`orchestrator.startNodeSession → session.create`）复用同一快照；独立会话在 `session.create` 内
  实时解析创建者设置。缺省不写身份 = 沿用容器级 bot；旧 worker（<2.12.0）忽略未知字段优雅降级，
  <2.13.0 忽略 `coAuthor*`（仅缺失共同作者 trailer）。
- Issue 触发人：`github-issues-webhook-payload` 解析 `sender {id,login}` → `IssueWorkflowTrigger`
  落 `triggerSenderId/triggerSenderLogin/triggerUserId`（`GitHubAccount.githubUserId` 匹配）；
  `IssuesTriggerRunner.createInstance` 身份优先级「触发人提交人 → sender 的 GitHub 身份
  （login + noreply）→ bot」。
- bot 身份：`githubService.resolveAppBotIdentity()`（`GET /app` → `GET /users/{slug}[bot]`，裸 fetch），
  Redis `github:app-bot-identity` 成功 24h、失败 sentinel 60s，进程内 Map 兜底。
- 仅云容器生效；本地控制器链路零改动；agent-gear ≥2.12.0 提供 worktree 身份能力（门禁见 cloud-controller）。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)

## Lessons Learned

### 重构时断言所有关键副作用

当重构将链式操作拆解（如 `findOneAndDelete` → `findOne` + `deleteOne`），测试必须断言**所有的关键副作用**，不能只断言新调用而忽略旧行为中隐含的步骤。

具体检查清单：
1. 新调用的方法是否被正确调用 ✅
2. **旧调用中隐含的操作是否仍然存在** ❌（常见遗漏点）
3. 删除操作（`deleteOne`/`deleteMany`/`findOneAndDelete`）是否仍被执行
4. 不带返回值的方法（如 `deleteOne`）最容易被遗忘，必须显式 mock + 断言

### Mock 配置要与实际代码同步

- `vi.mock` 中列出的 mock 方法必须覆盖实际代码使用的所有方法，否则测试可能因"方法不存在"而静默失败。
- 重构增删了数据访问方法后，同步更新 `vi.mock` 工厂中的 mock 列表。

## 云容器优化二期（默认工作区与模型上下文）

- 创建：`CreateCloudHostInput` 仅保留 `createDefaultSession`（缺省 `true`）；**创建期不再预置 `/home/worker/workspace`**（`CloudHost.workspaceId` 恒 `null` 落库，`required:false, default:null`），默认工作区只在「Git 项目设置」clone 成功后由 `cloud-host-github-service` 幂等 `ensureWorkspace` 按 finalPath 创建，并 CAS（`{_id, workspaceId:null}`）回写 `workspaceId`——与 `createSession` 开关及会话创建成败无关（多 Harness 不建会话场景同样初始化，Issue #304-1）。`gitSetup` 收尾为主落点，`runSessionStep` 内同逻辑为幂等兜底。`CloudHost.hasDefaultWorkspace`（`Boolean(workspaceId)`）为只读展示字段。
- ready：`handleReadyLocked` 的 STARTING 与重复 ready 两处建默认会话均要求 `createDefaultSession !== false && host.workspaceId`（两开关同时允许才建）；无工作区只记 info（日志区分 `createDefaultSession=false` / `no default workspace`），不建会话、不写 `defaultSessionId`。
- 模型：`Model.contextLength`（Int，null=未设置）只读镜像 admin-api，经 `mapModel` 透出；上下文下发走两条通道：OpenAI 兼容 `/v1/models` 的 `context_length`（运行时网关），以及创建云电脑时 `secrets.modelContextLengths`（模型 ID → contextLength JSON object，仅启用且正整数；同名保留首个）经 cloud-controller `ZAG_MODEL_CONTEXT_LENGTHS` 写入 opencode 配置 `models.<id>.limit.context`（agent-gear ≥2.7.0，缺失优雅降级）。

## 多租户一期（三层帐号模型与租户隔离）

- **三层帐号模型**：`accounts`（登录凭据，不 ref User，username 唯一）→ `users`（身份主体，`accountId` 引用账户、`tenantId` 引用租户，保留原 `username/passwordHash` 一期不下线）→ `tenants`（`type=personal`，`_id` 复用 userId，无成员列表；成员关系由 `users.tenantId` 承载）。写方仅 agent-api；admin-api 为只读镜像。
- **认证**：`login` 走 `Account.findOne({username})` → bcrypt → `User.findOne({accountId})` → 签发 token（载荷仍是 userId，已发 token 不失效）；`me`/`AuthPayload.user` 返回 `{id,name,tenant}`；`User.tenant` 为**字段级 resolver（已登记 `graphql/resolvers/index.ts` 的 `User` 键）**，`memberCount=User.countDocuments({tenantId})`（一期恒 1）。前台注册已硬关闭（契约/resolver/前端三层移除）。
- **AuthContext**：`authenticateUser` 一次 `findById` 取 `{id,tenantId,name}`，`context.tenantId` 同步下发；`requireTenantId(context)` 回退链 `context.tenantId → currentUser.tenantId → currentUser.id`（personal 期恒等）。
- **租户隔离（双条件）**：带 `userId` 的 19 个集合均**复制新增**同值 `tenantId`（`userId` 字段与筛选全部保留）；`services/tenant-scope.ts` 的 Mongoose 插件在查询编译前为 `{userId}` 过滤注入 `tenantId`（显式 tenantId 不覆盖；递归处理 `$or`/`$and`/`$nor` 内的 userId 分支）、写入（save/insertMany/`$set.userId`）自动补齐 `tenantId`。**例外**：`userId` 为操作符对象（如 `$in`/`$nin`）时不复制（值语义不同；一期运行时无此类过滤点，二期放开 userId 维度前需显式处理）。T-ISO 矩阵（`models/tenant-isolation.test.ts`）对 19 集合逐一走真实 Mongoose 查询中间件（驱动层 `countDocuments` spy），并与 `TENANT_ID_COLLECTIONS` 的集合名互校；Mongoose v9 的查询/文档中间件必须写成**同步钩子（无 next 参数）**，否则运行期抛 `next is not a function`。新增带 userId 的模型必须声明 `tenantId` 并 `applyTenantScope(schema)`（**例外**：`user_commit_settings` 为成员级集合，`userId` 为全局成员主键、`tenantId` 仅留档，显式豁免插件，见「Commit 设置与提交身份」段）；唯一索引保留 userId 维度：`{tenantId,userId,name}` / `{tenantId,userId,githubUserId}` / `{tenantId,userId}`。
- **迁移**：`012-account-user-tenant` 逐 user 幂等拆分三件套（只复制不删除原登录字段）；`013-tenant-id-backfill` 19 集合复制清洗 + 索引（只新增不删除）。**集合名以模型 `model.collection.name` 为单一来源**（如 `issue_workflow_triggers`），由 T-ISO 互校 + `013-...real.test.ts` 真库兜底；历史环境若误建空集合 `issueworkflowtriggers`，确认无数据后可手工 drop。启动后 `services/tenant-self-check.ts` 以带索引 count + `limit(100)` 抽样异步自检，仅告警不阻塞。
- **计费**：`billing-client` ownerType 使用 `tenant`（ownerId=tenantId；`front_user` 仅兼容期旧调用方）；`startHarness` 下发 `tenantId`（=userId）。
- **开户**：`POST /internal/users`（Bearer `INTERNAL_API_TOKEN`）创建账户+用户+个人租户+零余额租户计费账户；按 username 幂等（200 既有视图 / 201 新建 / 400 规则 / 409 重名 / 503 计费不可达并回滚）。
