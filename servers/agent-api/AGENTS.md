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
- 生命周期：创建即启动 → 停止即销毁（`STARTING/RUNNING/STOPPING/STOPPED/FAILED`，无 `startCloudHost`）。每用户同时最多 1 个 `STARTING/RUNNING/STOPPING` 实例（`KeyedMutex` 进程内串行，需单实例部署）。
- 创建编排：校验开关/名称/harnessTypes/配置 → 读取 `cloudworkloads` preset → 计费账户 → 预生成 cloudHostId/controllerId → `ControllerKey(type=cloud)` → 预创建 `Controller(type=cloud,registering,name=用户命名)` → 默认工作区（`/root/workspace`）→ `CloudHost(STARTING)` → 铸造 `scope=cloud_host` 模型 Key（**无固定有效期，随容器回收**）→ `POST /internal/containers{purpose:harness}`。失败逆序回滚；cloud-controller 成功后不再回滚。
- 只读模型：`models/cloud-container.ts`（cloudcontainers）、`models/cloud-workload.ts`（cloudworkloads）、admin-api 只读 `cloudhosts`；写方各自单一。
- 内部回调：`routes/internal-cloud-host.ts`（Bearer `INTERNAL_API_TOKEN`）。ready → **单 harness 默认会话在 STARTING 窗口创建后与 RUNNING/readyAt 合并为一次 CAS 落库**（避免 `RUNNING+defaultSessionId=null` 竞态；失败只告警）；`CreateCloudHostInput.createDefaultSession=false` 时跳过默认会话（由 Git 项目 setup 的 session 步骤建项目会话）；terminal → STOPPED/FAILED + 批量 ENDED + 撤销模型 Key；均幂等。
- 会话只读：停止时 `sessionService.endByController`；`resume`/`sendSessionMessage`/`cancelGeneration` 对云电脑非 RUNNING/软删返回 `session is ended`；`createSession` 对 cloud Controller 校验 `CloudHost.status===RUNNING` 且 `acpServerType` 必须在 `harnessTypes` 映射内，落库前后各复查一次（缩小与 stop/terminal 的竞态窗口）。`Session.controllerType`/`Session.cloudHost`（含软删除留档）由 `resolvers/session.ts` 的 `Session` 类型 resolver 提供，**必须在 `graphql/resolvers/index.ts` 登记 `Session` 键**（否则运行时恒 null）；前端只读判定不依赖 controllers 列表命中。
- 创建⇄停止并发：`startHarness` 成功后以 `{_id,status:'STARTING'}` CAS 回写 `containerId`；CAS 未命中（并发 stop 已推进）立即销毁容器并撤销模型 Key；stop 以 CAS 后的最新快照决定销毁，终态 CAS 后再扫一次会话。每用户 1 实例另有 DB 部分唯一索引兜底（多副本），索引由迁移 `005-cloud-host-active-unique-index` 显式创建；仅该索引名的 11000 冲突映射为 `too many cloud hosts`。
- `KeyedMutex` 非可重入：同异步上下文嵌套同 key 会立即抛错（`AsyncLocalStorage` 检测），避免永久挂起。
- 删除：仅 `STOPPED/FAILED`，软删除 `cloudhosts.deletedAt`、撤销 ControllerKey、`Controller.status=offline`；Controller/会话/消息保留，列表与首页过滤。`Controller.cloudHost` 对软删除返回 null，前端对 `type=cloud && cloudHost=null` 同样按只读渲染。
- 开关：`HARNESS_ENABLED=false` 时 capabilities 隐藏/禁用、create 返回 `harness feature is disabled`；存量仍可 list/stop/delete。

## 云主机工作负载与 Github 项目设置（本期）

- 工作负载目录：`services/cloud-workload-catalog.ts`（只读 `cloudworkloads`，`listStandard` 排除 harness）；Github 预制项 `presetKey=github`，参数 `repoFullName`/`targetPath`。
- 创建期预装负载：`CreateCloudHostInput.workloadIds`（可选，去重后 ≤5）。`services/cloud-host-workload-plan.ts` 的纯函数 `resolveCreateWorkloadPlan` 做后序 DFS 展开（依赖先行、去重、环检测、`implicit` 由是否在显式集合中决定 = 显式优先于隐式；harness presets 在前 `required=true`，standard 项 `required=false`，展开后 ≤10 条）；默认参数归一与 cloud-controller `normalizeDefaultParamValue` 同口径（MULTI_SELECT 去重保留首序、TEXT ≤1024、SELECT 必须属于 options、未知类型报错）。agent-api 在**落库前**完成校验与展开，并随 `startHarness` 下发**非空显式 workloadPlan**（cloud-controller 的 `hadExplicitPlan` 校验）。错误文案：`too many workloads (max 5)` / `invalid workload: <id>` / `workload is not installable: <name>` / `invalid workload parameter: <key>` / `dependency workload not found: <id>` / `dependency cycle detected` / `workloads exceed 10`（均在 `toCloudHostGraphQLError` 白名单内原样透传）。不传 `workloadIds` 时计划与历史完全一致。
- 创建弹窗数据源：`cloudHostWorkloadCatalog` 查询（`cloudHostWorkloadService.listCatalog()`）无主机上下文，返回全部 standard 且 `installed=false`；与 `cloudHostWorkloads` 共用 `CloudHostWorkloadItem`（含 `workloadKind`，standard 固定 `STANDARD`）。
- Github clone 路径：`SetupCloudHostGithubProjectInput.targetPath` 是**前缀地址（工作根目录）**，不是最终目录。`services/workspace-path.ts` 的 `normalizeWorkspacePrefix`（绝对路径、拒绝 `..`/反斜杠/NUL、`path.posix.normalize` 规整）+ `resolveClonePath`（`path.posix.join`，repo 必须 `owner/repo` 且两段非 `.`/`..`）在 `CloudHostGithubService.createOperation` 内权威计算 finalPath；operation/binding/脚本参数/`ensureWorkspace` 一律使用 finalPath，旧绑定记录保持原值。
- 编排：`services/cloud-host-workload-service.ts`（列表、单步安装、`cloud_host_setup_operations` runner、`pollBatch` 1s 轮询、单步超时 `CLOUD_HOST_SETUP_STEP_TIMEOUT_MS`）；`services/cloud-host-github-service.ts`（三步：Github 工作负载 → Git 项目设置 → 会话创建）。操作创建后立即返回，前端/ MCP 轮询终态；查询时 RUNNING 超过 `CLOUD_HOST_SETUP_STALE_MS` 标记 FAILED「操作已中断，请重试」。
- 凭据：`POST /internal/cloud-hosts/:controllerId/github-credential` 双鉴权（`INTERNAL_API_TOKEN` 或 Controller key），仅返回本机 `cloud_host_github_bindings` 绑定仓库的 `{token,expiresAt}`；`GitHubService.createRepoScopedToken` 使用 installation token + `repositories`，权限对齐 App 安装授权（actions/contents/deployments/environments/issues/pull_requests/workflows 均 write）。token 不落库/不写日志/不进 operation error（统一 `sanitizeOperationError`）。
- GraphQL：`cloudHostWorkloads`、`cloudHostSetupOperation`、`installCloudHostWorkload`、`setupCloudHostGithubProject`、`retryCloudHostSetupOperation`；`CloudHost.defaultWorkspace/workloadInstalling` 为类型级 resolver（已登记 `resolvers/index.ts`）。
- MCP：平台服务 `agent-cloud-host-tools`（`transport/source=platform`），工具 `workload_list`/`workload_install`；云会话 `sessionService.create` 自动装配，非云会话不装配；`workload_install` 等待终态（上限 10 分钟），执行记录 `source=mcp`。
- 会话：`controllerWorkspaceService.ensureWorkspace` 按路径幂等 upsert（不触发 10 个工作区上限）；Git 设置成功后自动建会话，失败仅 session 步骤 FAILED、operation 仍 SUCCEEDED 并提示手动建会话；`createSession=false` 时 session 步骤记 SKIPPED（多 Harness 不自动建会话）。

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

- 创建：`CreateCloudHostInput` 仅保留 `createDefaultSession`（缺省 `true`）；**创建期不再预置 `/root/workspace`**（`CloudHost.workspaceId` 恒 `null` 落库，`required:false, default:null`），默认工作区只在「Git 项目设置」初始化 Github 项目时由 `cloud-host-github-service.ensureWorkspace` 按 `targetPath` 幂等创建。`CloudHost.hasDefaultWorkspace`（`Boolean(workspaceId)`）为只读展示字段。
- ready：`handleReadyLocked` 的 STARTING 与重复 ready 两处建默认会话均要求 `createDefaultSession !== false && host.workspaceId`（两开关同时允许才建）；无工作区只记 info（日志区分 `createDefaultSession=false` / `no default workspace`），不建会话、不写 `defaultSessionId`。
- 模型：`Model.contextLength`（Int，null=未设置）只读镜像 admin-api，经 `mapModel` 透出；上下文下发走两条通道：OpenAI 兼容 `/v1/models` 的 `context_length`（运行时网关），以及创建云电脑时 `secrets.modelContextLengths`（模型 ID → contextLength JSON object，仅启用且正整数；同名保留首个）经 cloud-controller `ZAG_MODEL_CONTEXT_LENGTHS` 写入 opencode 配置 `models.<id>.limit.context`（agent-gear ≥2.7.0，缺失优雅降级）。
