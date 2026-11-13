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

## 会话交互卡片（sessioninteractions）

> 需求 #490；契约 `contracts/agent-session.graphql` / `workflow.graphql`；计划
> `docs/engineering/plan/20261112-feat-session-interaction-cards.md`。

- **集合**：`models/session-interaction.ts`（`sessioninteractions`，agent-api 唯一写方）——`tenantId` 声明 +
  `applyTenantScope`（与「新增带 userId 集合」双注册要求一致：`models/tenant-isolation.test.ts` 与
  迁移 013 的 `TENANT_ID_COLLECTIONS`，集合数 21）。索引由迁移 `025-session-interactions` 幂等创建：
  `interactionId` 唯一（幂等键）、`{sessionId,createdAt}`、`{sessionId,status,expiresAt}`、
  `{elicitationId}` sparse。**不设 TTL**（过期交互随会话留存回看）。
- **状态机**：`PENDING → {ACCEPTED, DECLINED, CANCELLED, EXPIRED, FAILED}`，仅允许从 PENDING 迁移；
  所有终态写入统一走 `SessionInteractionService`（CAS `{interactionId,userId,status:'PENDING'}`），禁止第二写入点。
  作答有效性以 `expiresAt`（= 事件到达 agent-api 时刻 + 60s，对齐 controller-api `TIMEOUT_MS`）为唯一口径；
  TodoItem 的 5 分钟 `expiresAt` 仅为通知 TTL，不再参与判定。
- **幂等**：`interactionId` 唯一索引；创建捕获 E11000 → 回读既有记录（`created=false`），subscriber 对
  重复触发不重复建待办/推 SSE。
- **respond\* 权威切换**：`respondElicitation` / `respondPermission` **先 CAS（未命中/已过期抛
  `Todo item not found or already handled`）→ publish response → TodoItem 标记已读**；签名与文案不变。
  `isRespondableTodo` 仅 harness login 链路继续使用。
- **resolved 订阅**：elicitation `timeout→EXPIRED / cancelled→CANCELLED / unsupported_mode→FAILED`（契约外收敛
  FAILED + warn）；permission `permission:resolved` 同口径（timeout/cancelled）。缺 `userId` 拒绝写入；
  `requestId` 缺失按 `sessionId` 会话级兜底。`elicitation:complete` 仅追加 history（不改 status）。
- **查询**：`sessionInteractions(sessionId)` 归属校验同 `sessionMessages`（只读会话允许），按 createdAt 升序；
  `WorkflowInstance.pendingInteractionSessionIds` 为实例级一次 `distinct`（空集合短路，避免 N+1）。
- **实时**：用户级 SSE `session_interaction` 事件（`{sessionId,interactionId,kind,status}`）驱动前端 refetch；
  创建时由订阅器推送 `PENDING`，用户作答成功由 `respond*` 在 CAS 命中后推送终态（`ACCEPTED/DECLINED/CANCELLED`），
  超时/断连由 resolved 订阅推送 `EXPIRED/CANCELLED`——同页 refetch 与跨标签页/工作流实例页双通道一致。
- **连带清理**：会话删除（`services/session.ts`）与导入覆盖（`services/session-import.ts`）在同点追加
  `SessionInteraction.deleteMany({sessionId})`。

## 默认 MCP 与 ACP 选项缓存

- **默认 MCP 口径**：`Controller.defaultMcp`（`{useAllEnabled, serverIds}`）为字段级 resolver，历史行归一为 `{useAllEnabled:true, serverIds:[]}`，并剔除已删除 MCP id。`setControllerDefaultMcp` 校验 `MCP_SERVER_NOT_FOUND` 后落库。
- **会话注入（`services/session.ts` 的 `resolveInitialMcpServerIds` 纯函数）**：`CreateSessionInput.mcpServerIds` **undefined 才走控制器默认**（`useAllEnabled` → 全部已启用；否则 `serverIds ∩ 已启用`）；显式 `[]` 表示不注入。云会话额外自动并入 `agent-cloud-host-tools`，与用户选择互不影响。
- **选项缓存**：controller-api `acp:options:<controllerId>:<serverType>` 成功 TTL 300s、失败 60s；`refreshAcpServerOptions` 主动清缓存并重探测（失败返回空选项，不阻断建会话）；`Model` mutation（增删改/排序/启停）经 `services/acp-options-cache.ts` 的 SCAN 失效当前用户全部控制器缓存；后台（系统内置 / global）模型变更不在 agent-api 作用域内，最长由 300s TTL 兜底（PRD v1.2 取舍），「刷新」按钮可立即重取。
- **云电脑创建/项目准备开关**：`createCloudHost(createDefaultSession:false)` 时 ready 不建默认会话（由 setup 的 session 步骤建项目会话）；`setupCloudHostGithubProject(createSession:false)` 时 session 步骤记 SKIPPED（多 Harness 场景）。

## Dev Commands

```bash
aspire start    # Start all services via Aspire orchestration
pnpm run build   # Compile TypeScript
pnpm run start   # Start production server
```

本项目由 Aspire 编排启动，无需单独运行 `pnpm run dev`。使用 `aspire describe` 查看 agent-api 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 首页聚合查询

`homeOverview`（`graphql/schemas/home.ts` + `graphql/resolvers/home.ts`）为薄聚合 resolver：用 `Promise.all` 并行组合既有 service，**不新增 service 层**；单分支失败降级为空值（数组/0），不拖垮整次查询。`Controller.gateways` 为嵌套惰性字段，仅查询语句选择时才执行，且是**纯 DB 查询**（`gatewayService.findAllByController`），不依赖控制器在线状态、离线不降级；`ControllerWorkspace.worktrees` 同样惰性，经 **Redis relay** 扇出，离线或失败/超时降级为空列表。

新增 Query/类型级 resolver（含 `WorkflowInstance.workspace` / `controller`）必须登记 `graphql/resolvers/index.ts`，否则线上不生效。

## 会话归档与只读

- **模型与迁移**：`Session.archivedAt`（Date|null，default null）与 `Session.controllerWorkspaceId`（ObjectId ref ControllerWorkspace，default null）+ 索引 `{userId,archivedAt,createdAt:-1}`、`{controllerId,controllerWorkspaceId}`；迁移 `022-session-archive-indexes`（幂等「先建后用」，生产 `autoIndex=false` 兜底，已登记 `index.ts` 的启动 runner）。存量零回填：`archivedAt` 缺省即未归档，`controllerWorkspaceId` 为 null 的旧会话走回退匹配（D3）。
- **落库点**：`controllerWorkspaceId` 仅两处写入——`sessionService.create`（存 `input.workspaceId`）与 `sessionImportService.importSessions`（循环内单点，含单条/批量导入）。
- **归档服务**：`setArchived(userId,id,archived)`（`actorFilter` 归属 → `Session not found`；`workflowInstanceId != null` → `ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED` 且不写库；`$set archivedAt` 幂等）；`findAllByUser({archived})` 追加 `archivedAt: archived ? {$ne:null} : null`（与 `includeWorkflowSessions` 排除口径正交，缺省 = 活跃）；`mapSession` 输出 `archived: Boolean(archivedAt)`（**不透出 `archivedAt` 原文**）。归档不发任何 acp 命令、不撤销 endpoint、不改状态机（D1）。
- **统一只读判定（三场景）**：`assertControllerWritable`（保留函数名）委托 `resolveReadOnlyReason` 返回四态 `null` / `CONTROLLER_MISSING`（`Controller.findOne` 空）/ `CLOUD_HOST_DESTROYED`（cloud 且 host 缺失/软删/STOPPING/STOPPED/FAILED，口径未变）/ `WORKSPACE_MISSING`（非 cloud：`controllerWorkspaceId` 非空 → `ControllerWorkspace.exists({_id})` 不存在即缺失；为空回退根目录 `cwd == ws.path` 或前缀 `ws.path + '/'` 匹配该控制器任一工作区；`worktreePath != null` 或无 cwd 无法判定 → 放行，D8）。接入点：`assertSessionWritable`（`sendSessionMessage`）、`cancelGeneration`、`resume`——`resume` 已删除重复云电脑判定收敛为同一判定（ended/disconnected 门禁与返回形状 `{success:false,status:'ended',error:'session is ended'}` 不变）。写路径统一文案 `session is ended`（D4）；原因展示由 `Session.readOnlyReason` 字段 resolver 调 `resolveSessionReadOnlyReason(session,userId)` 实时计算（D5，不落库），**必须落在 `sessionResolvers.Session` 内**（`resolvers/index.ts` spread 登记，`resolvers/index.test.ts` 守卫）。
- **工作区删除连带**：`matchWorkspaceSessions(workspace,userId)` 为匹配**唯一口径**（精确 `{controllerId, controllerWorkspaceId}`；旧数据根目录 cwd 等值/前缀、worktree 按 `worktreeScopePrefix` 前缀匹配，复用 `worktree-utils` 并保留 homeDir 缺失退化；查询层 `workflowInstanceId: null` 排除节点会话）——`archiveByWorkspace` 与 resolver `workspaceArchiveImpact` 共用（提示数量 = 实际归档数量）。`archiveByWorkspace`：匹配 → 非 ended 逐个 `close(suppressFallback:true, reason:'workspace_deleted')`（单会话失败仅记日志不阻断）→ `updateMany({_id:{$in}, archivedAt:null, ...actorFilter})` 幂等归档并返回数量；`controllerWorkspaceService.delete/clear` 删除前先连带（`clear` 逐个工作区执行），**归档失败抛错中止删除**（D7：工作区行保留，避免「工作区没了、会话未归档」中间态）。
- **首页聚合**：`homeOverview.archivedSessions` 分支（`findAllByUser({includeWorkflowSessions:false, archived:true})`，`degrade` 兜底 `[]`）与活跃 `sessions`（`archived:false`）互补，`sessionTotalCount` 为未归档口径。

## 前台云电脑（harness）

- 领域入口：`services/cloud-host-service.ts`；GraphQL：`graphql/schemas/cloud-host.ts` + `graphql/resolvers/cloud-host.ts`；契约 `contracts/cloud-host.graphql`。
- 生命周期：创建即启动 → 停止即销毁（`STARTING/RUNNING/STOPPING/STOPPED/FAILED`，无 `startCloudHost`）。数量无限制（PRD v1.0：创建收费 5 credits、失败退款；`userMutex` 仅串行化创建，需单实例部署）。
- 版本映射：`HARNESS_MIN_AGENT_GEAR_VERSION`（`OPENCODE: 2.6.0` / `KIMI_CODE: 2.8.0` / `DEEPSEEK_HARNESS: 2.17.1`——`cordis.patch.yml` 的 `header-masq` 注入自 2.11.0 起，2.17.1 起随基线提升以覆盖 `fs:read-file` 等会话预览能力）与基线 `CLOUD_HOST_AGENT_GEAR_MIN_VERSION='2.17.1'` 取**最大值**后随 `startHarness` 下发 `agentGearMinVersion`（0 harness 同样为基线 2.17.1）；cloud-controller 注册门禁再按 `harnessTypes` 取最大（与 2.17.1 基线取 max 后恒为 `2.17.1`）。
- 创建编排：校验开关/名称/harnessTypes/配置 → 读取 `cloudworkloads` preset → 计费账户 → 预生成 cloudHostId/controllerId → **`/internal/billing/charges` 先扣一次性创建费（幂等键 `cloud_host.create:<hostId>`）** → `ControllerKey(type=cloud)` → 预创建 `Controller(type=cloud,registering,name=用户命名)` → `CloudHost(STARTING)`（`githubAccountId` 可选锁定；创建期不预置默认工作区，`workspaceId` 留空）→ 铸造 `scope=cloud_host` 模型 Key（**无固定有效期，随容器回收**）→ `POST /internal/containers{purpose:harness}`。失败逆序回滚并 best-effort 退款（`cloud_host.create.refund:<hostId>`）；cloud-controller 成功后不再回滚。未 ready 即终态同样自动退款，已 ready 后销毁不退款。
- 只读模型：`models/cloud-container.ts`（cloudcontainers）、`models/cloud-workload.ts`（cloudworkloads）、admin-api 只读 `cloudhosts`；写方各自单一。
- 内部回调：`routes/internal-cloud-host.ts`（Bearer `INTERNAL_API_TOKEN`）。ready → **单 harness 默认会话在 STARTING 窗口创建后与 RUNNING/readyAt 合并为一次 CAS 落库**（避免 `RUNNING+defaultSessionId=null` 竞态；失败只告警）；`CreateCloudHostInput.createDefaultSession=false` 时跳过默认会话（由 Git 项目 setup 的 session 步骤建项目会话）；terminal → STOPPED/FAILED + 批量 ENDED + 撤销模型 Key；均幂等。
- 会话只读：停止时 `sessionService.endByController`；`resume`/`sendSessionMessage`/`cancelGeneration` 对云电脑非 RUNNING/软删返回 `session is ended`；`createSession` 对 cloud Controller 校验 `CloudHost.status===RUNNING` 且 `acpServerType` 必须在 `harnessTypes` 映射内，落库前后各复查一次（缩小与 stop/terminal 的竞态窗口）。`Session.controllerType`/`Session.cloudHost`（含软删除留档）由 `resolvers/session.ts` 的 `Session` 类型 resolver 提供，**必须在 `graphql/resolvers/index.ts` 登记 `Session` 键**（否则运行时恒 null）；前端只读判定不依赖 controllers 列表命中。
- 创建⇄停止并发：`startHarness` 成功后以 `{_id,status:'STARTING'}` CAS 回写 `containerId`；CAS 未命中（并发 stop 已推进）立即销毁容器并撤销模型 Key；stop 以 CAS 后的最新快照决定销毁，终态 CAS 后再扫一次会话。每用户数量无限制：`uniq_active_cloud_host_per_user` 由迁移 `011-drop-cloud-host-active-unique-index` 下线（schema 声明已移除，迁移 005 只读不回改）。
- `KeyedMutex` 非可重入：同异步上下文嵌套同 key 会立即抛错（`AsyncLocalStorage` 检测），避免永久挂起。
- 删除：仅 `STOPPED/FAILED`，软删除 `cloudhosts.deletedAt`、撤销 ControllerKey、`Controller.status=offline`；Controller/会话/消息保留，列表与首页过滤。`Controller.cloudHost` 对软删除返回 null，前端对 `type=cloud && cloudHost=null` 同样按只读渲染。`Controller.cloudHost` 与 `myCloudHosts` 同为**工作区成员口径**（`actorFilter`，团队工作区成员可见他人创建的云电脑；无工作区上下文的引擎/内部链路仍按 `userId` 归属校验）。
- 开关：`HARNESS_ENABLED=false` 时 capabilities 隐藏/禁用、create 返回 `harness feature is disabled`；存量仍可 list/stop/delete。

## SessionReview 与会话预览工具（#461）

- **领域**：`models/session-review.ts`（`sessionreviews`，`tenantId` 声明 + `applyTenantScope`，无唯一索引）+
  迁移 `023-session-reviews`（幂等建 `{userId,status,createdAt:-1}`、`{sessionId,status}`）；
  查询一律 `actorFilter(userId)`（多租户二期口径）。集合矩阵在 `models/tenant-isolation.test.ts`
  与 `TENANT_ID_COLLECTIONS`（迁移 013 的集合注册表，回填对新集合为 no-op）双注册（20 集合）。
- **状态机**：PENDING →（submit PENDING CAS）APPROVED/REJECTED/COMMENTED；→（超时/会话结束 CAS）
  CANCELLED（`cancelReason: timeout | session_closed`）。CAS 未命中抛 `Review not found or already resolved`。
- **等待器**（`services/session-review-service.ts`）：进程内 `Map<reviewId, {resolve, timer}>`，
  `timer.unref()`，30min 到点自行 CAS 取消（`MCP_REVIEW_TIMEOUT_MS` 默认 1_800_000，env 可调）；
  **单实例前提**（与 `KeyedMutex` / 中断重试调度器同前提）。会话 `ended/removed` 经
  `sessionService.onSessionStatus` 批量取消（index.ts 注册）。
- **平台 MCP**：`agent-session-preview-tools`（`services/session-preview-tools.ts`，`transport/source=platform`，
  唯一工具 `review`）——`sessionService.create` **公共路径恒装配**（普通/云/节点会话全覆盖，与 controller.type
  无关）并去重；「全部已启用」候选与 `setControllerDefaultMcp` 校验排除口径为
  `$nin: [agent-cloud-host-tools, agent-session-preview-tools]`（选平台服务报 `MCP_SERVER_NOT_SELECTABLE`）；
  `mcp-dispatch` platform 直发分支同名路由。review handler：归属校验（actorFilter）→ 文件解析
  （相对基于 `worktreePath ?? cwd`，越界剔除标 `skipped`、去重、≤50）→ `createForMcp`（SSE
  `session_review_requested`）→ `waitForResolution` → 终态回包 `{file_reviews, comment, status: Approve|Reject|Comment}`
  / 取消回包 `{cancelled:true, reason}`（isError=false）。MCP 转发超时按 serverName 放宽 30min（契约 §2.12.1）。
- **sessionFileContent**（resolver `resolvers/session.ts`）：归属校验（非归属 `Session not found`）+
  **只读会话允许** + 路径守卫（归一后必须以会话根为前缀否则 `BAD_USER_INPUT`，与 controller 白名单双保险）→
  发布 `session:command fs:read-file` → 轮询 Redis `fs:read-file:{requestId}` 500ms×30（≈15s）→
  超时 `Controller offline or file read timeout`；错误文案白名单 `file too large`/`binary file`/`not found`/
  `permission denied`/`Controller offline or file read timeout`。
- **addMessage parts**（裁决 6/8）：服务端再过滤 trim 空文本/无 data 图片，全空抛
  `BAD_USER_INPUT('empty prompt')`；合并文本（非空文本 `\n\n` 连接）写 `content`（标题取自合并文本）、
  `metadata=JSON.stringify({parts})`（全量含图片）、parts JSON >12MB 拒绝；Redis `session:message`
  载荷带 `parts`（controller-api 透传 `acp:message`）；无 parts 旧行为逐字不变。
- `express.json({ limit: '20mb' })`（图片片段 base64 放宽；webhook 路由保持在其前挂载）。
- 回归：`session-review-service.test.ts`（T-SR1~6）、`session-preview-tools.test.ts`（T-SPT1~7）、
  `session.test.ts`（T-PARTS1~5、T-SPT6 装配）、`023-session-reviews.test.ts`（T-MIG-SR1~3，真库）。

## 云主机工作负载与 Github 项目设置（本期）

- 工作负载目录：`services/cloud-workload-catalog.ts`（只读 `cloudworkloads`）：`listAll()` 返回 standard + harness（设置-工作负载与 MCP `workload_list`），`listStandard()` 仅 standard（创建期预装勾选，决策 10）；Github 预制项 `presetKey=github`，参数 `repoFullName`/`targetPath`。
- 创建期预装负载：`CreateCloudHostInput.workloadIds`（可选，去重后 ≤5）。`services/cloud-host-workload-plan.ts` 的纯函数 `resolveCreateWorkloadPlan` 做后序 DFS 展开（依赖先行、去重、环检测、`implicit` 由是否在显式集合中决定 = 显式优先于隐式；harness presets 在前 `required=false`（harness 为可选工作负载，安装失败不销毁容器，可事后在设置-工作负载补装），standard 项同样 `required=false`，展开后 ≤10 条）；默认参数归一与 cloud-controller `normalizeDefaultParamValue` 同口径（MULTI_SELECT 去重保留首序、TEXT ≤1024、SELECT 必须属于 options、未知类型报错）。agent-api 在**落库前**完成校验与展开，并随 `startHarness` 下发显式 `workloadPlan`——**允许为空数组**（契约 A.2.2 放宽：0 harness + 0 standard 场景，cloud-controller 无初始化脚本直接 online；`hadExplicitPlan` 仅用于 `workloadIds` 派生口径，空 plan 不再 400）。错误文案：`too many workloads (max 5)` / `invalid workload: <id>` / `workload is not installable: <name>` / `invalid workload parameter: <key>` / `dependency workload not found: <id>` / `dependency cycle detected` / `workloads exceed 10`（均在 `toCloudHostGraphQLError` 白名单内原样透传）。不传 `workloadIds` 时计划与历史完全一致。
- 创建弹窗数据源：`cloudHostWorkloadCatalog` 查询（`cloudHostWorkloadService.listCatalog()`）无主机上下文，返回全部 standard 且 `installed=false`；与 `cloudHostWorkloads` 共用 `CloudHostWorkloadItem`（含 `workloadKind`）；`cloudHostWorkloads` 返回 standard + harness 且按库内真实 `workloadKind` 映射（`STANDARD`/`HARNESS`），`cloudHostWorkloadCatalog` 固定 `STANDARD`。
- Github clone 路径：`SetupCloudHostGithubProjectInput.targetPath` 是**前缀地址（工作根目录）**，不是最终目录。`services/workspace-path.ts` 的 `normalizeWorkspacePrefix`（绝对路径或以 `~`/`~/` 开头（展开为容器主目录 `/home/worker`，仅首字符生效，`~abc` 拒绝）、拒绝 `..`/反斜杠/NUL、`path.posix.normalize` 规整）+ `resolveClonePath`（`path.posix.join`，repo 必须 `owner/repo` 且两段非 `.`/`..`）在 `CloudHostGithubService.createOperation` 内权威计算 finalPath；operation/binding/脚本参数/`ensureWorkspace` 一律使用 finalPath，旧绑定记录保持原值。`~` 展开矩阵见 `workspace-path.test.ts` 的 T-PATH8/T-PATH9。
- 编排：`services/cloud-host-workload-service.ts`（列表、单步安装、`cloud_host_setup_operations` runner、`pollBatch` 1s 轮询、单步超时 `CLOUD_HOST_SETUP_STEP_TIMEOUT_MS`）；`services/cloud-host-github-service.ts`（三步：Github 工作负载 → Git 项目设置 → 会话创建）。操作创建后立即返回，前端/ MCP 轮询终态；查询时 RUNNING 超过 `CLOUD_HOST_SETUP_STALE_MS` 标记 FAILED「操作已中断，请重试」。
- Git 项目设置幂等口径（`GITHUB_SETUP_SCRIPT`）：目标目录已是同一仓库（remote 归一后精确匹配，覆盖 https/ssh/凭据 URL/`.git`/尾斜杠形态）→ 直接复用、零目录改动、不拉取；空目录 `rmdir` 后克隆；异仓库 / 非空普通目录 / 同名文件 / `.git` 残骸统一提示「目标目录已存在其他项目，请修改前缀地址」且不改动内容；`.git` 为文件形态（linked worktree gitfile）保守判冲突；指向空目录的符号链接 `rmdir` 失败即非零退出，不删除链接或内容。行为矩阵见 `github-setup-script.behavior.test.ts` 的 T-GHS1~14。
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
  （`INTERNAL_API_TOKEN` 或本机 Controller key，401/403），**永不 404**，恒 200；**有效主机无视个人设置恒 bot**；
  主机不存在 / 已软删返回 `{mode:'unset'}` 且不解析 bot（无主机的容器不写身份）。
- 下发链：`git:worktree:add` 可选 `committer {name,email,coAuthorName?,coAuthorEmail?}`；
  `workflow/instance.ts` 实例化时解析一次并落 `WorkflowInstance.worktreeCommitterName/Email` +
  `worktreeCoAuthorName/Email` 快照（issue 触发人覆盖 > 创建者设置），实例级与节点级
  worktree（`orchestrator.startNodeSession → session.create`）复用同一快照；独立会话在 `session.create` 内
  实时解析创建者设置。缺省不写身份 = 沿用容器级 bot；旧 worker（<2.12.0）忽略未知字段优雅降级，
  <2.13.0 忽略 `coAuthor*`（仅缺失共同作者 trailer）。
- **已有 Worktree 共同作者同步（修复 #455）**：`existingWorktreePath` 会话不会重新走 `git:worktree:add`，
  因此在 `session.create` 中按当前成员设置再下发一次 `git:worktree:coauthor {worktreePath, coAuthor?}`
  （`coAuthor` 缺省 = 关闭）：启用时等待 ≤2s ack 后继续，关闭时只尽力下发清理不等 ack；超时/失败仅告警，不阻断建会话。新建 Worktree 仍由
  `git:worktree:add` 一次性写入，不受影响。
- Issue 触发人：`github-issues-webhook-payload` 解析 `sender {id,login}` → `IssueWorkflowTrigger`
  落 `triggerSenderId/triggerSenderLogin/triggerUserId`（`GitHubAccount.githubUserId` 匹配）；
  `IssuesTriggerRunner.createInstance` 身份优先级「触发人提交人 → sender 的 GitHub 身份
  （login + noreply）→ bot」。
- bot 身份：`githubService.resolveAppBotIdentity()`（`GET /app` → `GET /users/{slug}[bot]`，裸 fetch），
  Redis `github:app-bot-identity` 成功 24h、失败 sentinel 60s，进程内 Map 兜底。
- 仅云容器生效；本地控制器链路零改动；agent-gear ≥2.12.0 提供 worktree 身份能力（门禁见 cloud-controller）。

## 日志与可观测性

- **日志形态**：pino 单行 JSON（vendored `src/observability/`），字段字典与调用签名见 [`contracts/observability.md`](../../contracts/observability.md) §2 与 [`common-rules.md`](../../docs/engineering/common-rules.md)「日志与可观测性规范」。`httpContext()` 挂在既有 `runWithRequestAuth` ALS 外层（`x-request-id` 归一化 + 响应头回写 + HTTP SERVER span + 访问日志；`/health` 与 SSE 只在连接建立/断开各记一条）。
- **span 清单**：
  - `cloudhost.create` / `cloudhost.start` / `cloudhost.destroy` — 云电脑创建/启动/销毁编排（`cloud-host-service.ts`，属性含 `cloudHostId`/`userId` 等）；
  - `workflow.node.advance` — 工作流**每节点推进一个 span**（`workflow/orchestrator.ts`，属性 `workflowInstanceId`/`nodeId`）；
  - `issues-trigger.scan` — Issues 联动**每轮扫描一个 span**（属性 `candidateCount`；另有 `issues-event handle` / `pr-event handle` 事件入口 span）；
  - 订阅 `<channel> handle` — Redis 订阅回调入口各一个 span（`permission`/`elicitation`/`harness-login`/`mcp-endpoint`/`session-lifecycle`/`session-sse`，如 `<SESSION_STATUS_CHANNEL> handle`），父上下文取 `extractTraceparent(payload._meta)`；
  - **高频豁免**：`workflow/pr-check-run-subscriber` 订阅 `session:message`，按契约 §7 高频通道口径**不逐条开 span**（回调仅结构化日志，`component: 'pr-check-run-subscriber'`，不进 span 清单）。
- **Socket.IO / Redis `_meta` 封套位置**：Redis 频道报文顶层 `_meta: { traceparent? }` 见 [`contracts/mcp-forward-redis.md`](../../contracts/mcp-forward-redis.md) §7 与 [`contracts/agent-session-websocket.md`](../../contracts/agent-session-websocket.md) §7；39 处发布点一律经 `publishJson(publish, channel, payload)` 注入（`src/middleware/publish.ts`）。
- **env 变量**：`LOG_LEVEL` / `LOG_PRETTY`（仅非生产）/ `OTEL_SDK_DISABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`（**空 = 零外发**）/ `OTEL_EXPORTER_OTLP_HEADERS`（**禁止出现在任何日志**）/ `OTEL_SERVICE_NAME` / `OTEL_TRACES_SAMPLER(+_ARG)` 等，完整契约见 [`contracts/observability.md`](../../contracts/observability.md) §3。
- **排障**：`LOG_LEVEL=debug` 看高频细节（`session:message` 逐条为 debug）；`OTEL_SDK_DISABLED=true` 关追踪导出；JSON 单行日志可直接 `grep`（`grep '"requestId":"<id>"'` 串一次请求、`grep '"trace_id":"<trace-id>"'` 跨服务串链路、`grep '"level":"error"'`）。
- **审计例外**：`bootstrapAdminPassword` 为契约 §6.2 唯一明文例外（admin-api 首次 seed）；本服务其余 `password`/`token`/`secret` 类键一律经 `REDACT_PATHS` 脱敏，`sanitizeOperationError` 语义保持不变。

## 工作流节点中断自动重试

- **触发源**：`orchestrator.handleSessionEnded`（`session:status ended` 且节点仍 `RUNNING`）与 `handleSessionIdled`（turn 结束空闲且节点 `RUNNING/REWORK`）都只做一件事——`scheduleInterruptionRetry({ trigger })`（`services/workflow/interrupt-retry.ts`）。`ended` 有两个来源：① agent-api `closeSession`（人工关闭，close 回调）；② controller-api 直接写库并 publish（Agent 进程异常退出/控制器失败/断连超时）。**两者都必须经 `sessionService.onSessionStatus` 通用通道接入排期**（`orchestrator.register` 注册；只分流 `ended`），否则 PRD 功能点 1 的「会话被意外结束」不会触发重试。`removed` 仍是立即 `FAILED`（`SESSION_START_FAILED`，会话已删除无法 resume）。
- **去重**：close 回调、stop ack 重复事件、重试管线自身 `close(suppressFallback)` 引发的 ended 可能多次投递；排期 CAS（`retryPhase` 预期值 + `retryCount` 快照）与 `handleSessionEnded` 前置过滤（实例未删 / 节点 `RUNNING` / `sessionId` 匹配）保证只计一次。
- **预算与退避**：最多 10 次，`delay(N) = N===1 ? 0 : min(2^(N-2), 30) * 60_000` 分钟（0/1/2/4/8/16/30/30/30/30，总窗口约 2 小时）。10 次用尽 → 引擎 `retryExhausted` → `RETRY_FAILED` + `failInfo.source='RETRY_EXHAUSTED'` + immediate 人工介入待办。
- **节点字段**（替代旧 `fallbackSent`）：`retryCount`（本 episode 已排期次数）、`nextRetryAt`、`retryPhase`（`SCHEDULED`/`RECONNECTING`）、`retryDeadlineAt`、`retryTrigger`（`ENDED`/`IDLED`）。`complete/completeRework/reject/rework/resume/resumeFailed/restart` 复位全部 5 字段；`fail`/`retryExhausted` 只清调度字段、保留 `retryCount`。**重试成功发送提示词不复位 `retryCount`**（D1 防「提示词无效→再中断→计数归零」死循环）。
- **排期 CAS**：`{nodeId, sessionId, status∈RUNNING/REWORK, retryPhase=expectedPhase, retryCount=快照}` 字段级 `updateOne`；`expectedPhase` 为 `null`（首次）或 `'RECONNECTING'`（本次重试失败重排）。人工 restart/rework/删除后 CAS 自然不命中，绝不误发。
- **管线**：占位（`SCHEDULED→RECONNECTING`，`retryDeadlineAt=now+5m`）→ 会话非 ended/disconnected 才 `close(suppressFallback:true, reason:'workflow_interruption_retry')` → **先布防等待器再 resume** → `resume(带内 mode/model)` → 等 `idling` → 发送前双校验（未删除 / 状态 / sessionId / phase）→ `addMessage(FALLBACK_PROMPT | IDLE_NUDGE_PROMPT)` → 清调度字段。
- **空闲等待器**（`services/session-idle-waiter.ts`）：事件优先 + `ended.error` 快判 + 15s DB 心跳兜底，5 分钟截止；close 引起的不带 error 的 `ended` 在未见 `connecting` 前忽略（F11）；**心跳同口径**：DB 仍为 `ended/disconnected` 时，只有已见 `connecting/running` 或临近 deadline（≤30s）才判失败，避免 close→resume 间隙慢控制器误耗一次预算。
- **会话已丢失**：`sessionId` 缺失时按「本次失败」消耗一次重试预算后重排（不再直接 retryExhausted）。
- **调度器**（`services/workflow/interrupt-retry-scheduler.ts`）：30s 扫描 A（到期 `SCHEDULED` 执行）与扫描 B（`RECONNECTING` 且 `retryDeadlineAt` 过期 → 重排，兜底进程重启丢等待器）；`scanning` 互斥 + 每节点 `KeyedMutex` + `timer.unref()`。
- **单实例部署约束**：调度器与 `KeyedMutex` 同为进程内锁，多副本会重复执行同一节点的重试；必须单实例运行。
- **会话通用状态通道**：`sessionService.onSessionStatus/notifySessionStatus`（多监听者，注册返回注销函数）在 `session-lifecycle-subscriber` 的 `handled` 过滤**之前**透传全量 `session:status`；按高频豁免口径只记结构化日志、不逐条开 span。
- **人工入口**：`restartNode` 与 MCP `resumeFailedNode` 均接受 `RETRY_FAILED`；前端列表/抽屉提供重启入口，阻断 banner 与 toast 分档文案。
- **已知取舍（D9）**：人工在会话页点「关闭」仍计为一次中断并纳入自动重试（回调只带 sessionId，平台无法区分来源）；复用旧口径，仅次数放大。如需区分须另立提案。

## Valut 工作区密钥管理

> MCP+Valut 功能迭代 Phase 1；契约 `contracts/valut.graphql`；计划 `docs/engineering/plan/20261104-feat-mcp-valut-iteration.md`。

- **三集合**（agent-api 唯一写方，迁移 `023-valut-foundations` 随启动执行）：
  - `valutnamespaces`：全局注册表，`name`（`manual` | `service-{feature}`）**跨租户唯一索引**
    `uniq_valut_namespace_name`；**不挂任何 scope 插件**（D3）；`manual`（展示名「自定义密钥」）
    由迁移 023 播种，`service-*` 由 `valut-service.ensureNamespace` 启动自检幂等 upsert（managed=true、
    `$setOnInsert` 不覆盖存量）；不提供用户侧 namespace 管理入口。
  - `valutentries`：工作区归属（`tenantId` + `workspaceId` 挂 `applyWorkspaceScope` **独占型**；
    `applyTenantScope` 对无 `userId` 集合为 no-op，`tenantId` 由服务层显式写入）；唯一索引
    `uniq_valut_entry_workspace_namespace_key` `{workspaceId,namespace,key}`（与迁移同名）；
    `valueEncrypted{iv,ciphertext,tag}`（AES-256-GCM，复用 `services/crypto.ts` +
    `CREDENTIAL_ENCRYPTION_KEY`，未配置即抛错）；`editable`/`deletable` 默认 true；
    `key` trim 后 1..128 禁空白与控制字符。
  - `valutrefs`：独立关联集合（一条 entry 可多条 ref），`{feature,refId}` 唯一
    `uniq_valut_ref_feature_refid` + `{valutEntryId}` 索引 `valut_ref_entry`；
    `feature` 存功能点名（**不带 `service-` 前缀**）；挂 `applyTenantScope`、**不挂 workspace 插件**（D3，
    始终经 entry 归属校验）；`tenantId/workspaceId` 为冗余清扫维度。
- **明文边界（安全红线）**：GraphQL 契约无 value 出参；`encrypt` 仅在
  `createManualEntry`/`createManagedEntry`/`updateValue` 内调用；解密唯一入口
  `valut-service.resolveValue` **不被任何 resolver 引用**（本期唯一消费点 = custom-mcp-forwarder
  内存请求头组装）；所有 list/get 装配（`mapEntry`）显式不含 `valueEncrypted`；
  `REDACT_PATHS` 增补精确路径 `*.newToken`/`*.input.value`/`*.input.newToken`（**禁止裸 `*.value`**，
  会误伤计费/计量日志）。改共享日志模块走 `packages/observability/src` → `node scripts/sync-observability.mjs`。
- **服务与入口**：`services/valut-service.ts` 为**唯一读写口**
  （`ensureNamespace`/`listGrouped`/`listManualOptions`/`createManualEntry`/`updateValue`/
  `deleteEntry`/`createManagedEntry`/`resolveValue`/`removeRef`/`deleteEntryCascade`）；
  GraphQL：`graphql/schemas/valut.ts` + `graphql/resolvers/valut.ts`（均须登记
  `schemas/index.ts` / `resolvers/index.ts`，漏登记运行时无效）。`listGrouped` 的 refs 反查用
  `{valutEntryId:{$in:[...]}}` 一次查询；`createManagedEntry` 顺序写 entry→ref、失败补偿删 entry（D14）；
  `listManualOptions` 服务层强制 `workspaceId=当前工作区`（防跨工作区 id 猜测）。
- **权限口径（复用 workspaceAccess/workspace-scope，零新机制）**：读=独占型可见集（仅当前工作区）；
  写=每个变更方法入口 `assertWorkspaceWritable` + 插件写过滤/只读拦截——全局工作区 developer 写统一
  `global workspace is read-only`、admin 写通；普通工作区成员读写通；跨工作区 id → `Not found`
  （存在性探针区分）、不存在 id → `valut entry not found`；非成员/跨租户在 `resolveWorkspaceContext`
  即 `workspace not found`。
- **无工作区上下文守卫（租户隔离红线）**：`applyWorkspaceScope` 在无 ALS store 时静默不注入可见集
  过滤，故 `listGrouped`/`updateValue`/`deleteEntry`/`deleteEntryCascade` 入口 `requireContext()`
  一律抛 `workspace not found`（范式同 `cloud-storage-service.requireContext`；`createManualEntry`/
  `createRef` 的旧守卫已同步收敛到 `requireContext()` 同一文案——旧文案
  `valut workspace context is required` 仅剩 `createManagedEntry` 的 `!params.workspaceId`
  参数校验（`valut-service.ts`，内部编码期防漏）；**内部原语保留无上下文能力**
  ——`resolveValue`/`inspectEntry`/`loadEntryNamespaces`（custom-mcp-forwarder 转发链路
  `runWithWorkspace(undefined, …)` 依赖）、`listManualOptions` 无上下文返回空集。
  入口守卫文案 `workspace not found` **已列 `contracts/valut.graphql` 错误表**、
  `resolvers/valut.ts` 白名单逐字透传（非成员上下文与无上下文同一口径）；
  仅上述 `createManagedEntry` 参数校验文案未列契约，走 `internal error` 收敛例外。
- **错误文案（白名单逐字，resolver `wrap()` 透传，未命中收敛 `internal error`）**：
  `valut entry not found` / `valut key already exists` / `invalid valut key` / `invalid valut value` /
  `valut entry is not editable` / `valut entry is not deletable` / `valut entry has refs` /
  `global workspace is read-only` / `Not found` / `workspace not found` / `Not authenticated`。
- **启动自检（D13）**：`src/index.ts` 在迁移完成后、就绪之前调用
  `ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens')`，失败仅 `logger.warn` 告警、不阻塞就绪。

## 自定义 MCP（工作区）

> MCP+Valut 功能迭代 Phase 2；契约 `contracts/custom-mcp.graphql`；计划
> `docs/engineering/plan/20261104-feat-mcp-valut-iteration.md` Phase 2（关键实现要点 1~4 / D14）。

- **模型**：`models/custom-mcp-server.ts`（集合 `custommcpservers`，agent-api 唯一写方）——
  `tenantId`（`applyTenantScope` 对无 `userId` 集合为 no-op，`tenantId` 由服务层显式写入）+
  `workspaceId` 挂 `applyWorkspaceScope`（**独占型**）；`name` trim 后 1..64 工作区内唯一，唯一索引
  `uniq_custom_mcp_workspace_name` `{workspaceId,name}`（**与迁移 023 已建索引同名同键**）；
  `endpoint` 仅 `http://`/`https://` 且 ≤1024；`description?` ≤512（schema `maxlength` +
  服务层 `invalid mcp description`——契约错误表已列该文案，`wrap()` 白名单逐字透传）；
  `customHeaders` 为 `Map<String,[String]>` 同名多值（key 禁空白/冒号，并规避 Mongoose Map/BSON
  键限制：禁点号、`$` 与 `constructor/prototype/__proto__` 保留键名；单值 ≤4096、header 总数 ≤32）；
  `authType` none|bearer；`bearerValutEntryId` ref `ValutEntry`（bearer 必填、none 恒 null）。
  **本集合不存 bearer token**（token 只存 `valutentries.valueEncrypted`）。
- **服务**：`services/custom-mcp-service.ts` 为唯一读写口（`list/get/create/update/delete`）；
  全部入口 `requireContext()`（无 ALS 工作区上下文 → `workspace not found`，与 `valut-service`、
  `middleware/auth` 同一文案，已列 `contracts/custom-mcp.graphql` 错误表并经 `wrap()` 白名单
  逐字透传，封堵半迁移回退链路的跨租户读写面）：
  - **bearer 两路径（create）**：`newToken` → **预生成 MCP `_id` 一次成型**（计划要点 1 裁决）——
    **先** `valutService.createManagedEntry('mcp-bearer-tokens', refId=MCP id, refLabel=key=name,
    editable=true, deletable=false)` **再** 落 MCP（`bearerValutEntryId` 随首次 save 一并写入，
    无回写、无中间态）；落 MCP 失败补偿 `deleteEntryCascade`（entry+ref 同删，不留悬空行）。
    `existingEntryId` → **三分口径**校验（不存在 → `valut entry not found`；存在但跨工作区不可见 →
    `Not found`；非 manual → `bearer entry must be manual namespace`）→ 落 MCP →
    `valutService.createRef` 仅建 ref（失败补偿删 MCP）。两参数同时给出时 **`newToken` 优先**；
    均缺 → `bearer token is required`。
  - **删除（D14）**：读 MCP → 判条目**实际 namespace**（不以前端标记为准）→ **以 `_id` 删除
    `deletedCount===1` 为「执行级联」凭证**（并发输家不重复级联、只级联一次）→ 自建
    （`service-mcp-bearer-tokens`）级联 `deleteEntryCascade`（ref+entry 同删）、manual/悬空条目仅
    `removeRef`；MCP 已随 `deleteOne` 删除。
  - **编辑（穿透）**：name/description/endpoint/customHeaders 直改（校验先行、改名重名预检）；
    `auth` 省略/null = 不动。`bearer+newToken` → 仅自建条目走 `valutService.updateValue`
    **内部重写值路径**（不回显、不走 GraphQL），manual 引用拒绝 `bearer entry not editable in place`
    （前端 `bearerEntryManaged=false` 走「前往 Valut 编辑」穿透链接 D11）；
    `bearer+existingEntryId` → **换绑 = 先删旧 ref 再建新 ref**（旧关联按删除同口径：自建旧条目
    级联删、manual 旧引用仅删 ref），同目标幂等；`auth.type=none` 解绑同口径——**换绑两方向无孤儿**。
    **有副作用的步骤（删旧 ref / 建新 ref / 级联删旧条目 / 就地改值）一律放在 `updateOne`
    持久化确认之后**：持久化失败 → 旧关联从未被触碰（直接上抛，天然无孤儿）；副作用失败 →
    回滚本次 `$set` 到进入前快照并恢复旧 ref（「旧关联完好或已回滚」，换绑/解绑两方向均覆盖）。
  - **`bearerEntryManaged` 派生**（服务层批量 `valutService.loadEntryNamespaces` 一次 `$in` 查询防
    N+1）：namespace `service-mcp-bearer-tokens` → true；`manual` → false；无条目/悬空 → null。
- **与 Valut 联动不变量**：
  1. 自建条目恒落 `service-mcp-bearer-tokens`、`editable=true/deletable=false`、`key=MCP name`、
     ref `{feature:'mcp-bearer-tokens', refId:MCP _id}`（feature **不带 `service-` 前缀**）；
  2. 引用**仅限 manual**；多条 MCP 共引同一条目各自独立 ref（`{feature,refId}` 唯一）；
  3. 删除/解绑/换绑的旧关联一律按删除同口径回收（自建 entry+ref 级联、manual 仅删 ref）——
     MCP 与条目同生灭，不留孤儿 entry/ref；
  4. 改名**不同步**已建条目 key 与 refLabel（`key=name` 仅创建期锚定；改名后遗留旧 key 撞键由
     `mapBearerKeyError` 收敛为白名单 `invalid mcp name`，不外泄 Valut 内部文案）；
  5. bearer token 明文不出服务端：GraphQL 出参装配（`mapServer`）显式白名单字段、恒不含 token；
     resolver 不引用 `resolveValue`/`decrypt`（单测扫描断言）。
- **GraphQL**：`graphql/schemas/custom-mcp.ts` + `graphql/resolvers/custom-mcp.ts`（均须登记
  `schemas/index.ts` / `resolvers/index.ts`，**漏登记运行时无效**）；`wrap()` 白名单逐字透传契约
  错误表：`custom mcp server not found` / `invalid mcp name` / `invalid mcp endpoint` /
  `invalid custom headers` / `invalid mcp description` / `bearer token is required` /
  `valut entry not found`（`existingEntryId` 不存在）/ `bearer entry must be manual namespace` /
  `bearer entry not editable in place` / `global workspace is read-only` / `Not found` /
  `workspace not found`，未命中一律
  `internal error`；未认证 `Not authenticated`。`bearerEntryManaged` 由服务层派生，**无类型级 resolver**。
- **权限**：读=独占型可见集（`list`/`get` 随 `x-workspace-id` 切换）；写=入口
  `assertWorkspaceWritable` + 插件写过滤/只读拦截（全局工作区 developer →
  `global workspace is read-only`）；跨工作区 id → `Not found`（存在性探针区分）、不存在 id →
  `custom mcp server not found`；`customMcpServer(id)` 可空出参对不存在返回 `null`。
  无工作区上下文（半迁移回退）→ 全部入口 `requireContext()` 拒绝
  （`workspace not found`，已列契约错误表并经 `wrap()` 白名单逐字透传）。
- **测试**：`services/custom-mcp-service.test.ts`（T-CMCP1~5 真库：新建 entry/ref 落库与 editable/
  deletable、**落 MCP 失败 → entry/ref 回滚**、引用仅 manual 与多 MCP 共引独立 ref、删除级联与并发
  只级联一次、编辑就地改值不回显/manual 拒绝/换绑两方向无孤儿（含 `updateOne` 抛错与 `createRef`
  抛错的补偿回归）、校验矩阵逐字命中 + 权限矩阵 + 无工作区上下文拒绝）、`graphql/schemas/custom-mcp.test.ts`
  （契约逐字段对齐 + 出参无 token 字段）、`graphql/resolvers/custom-mcp.test.ts`（认证/白名单逐字/
  委托/登记）、`services/custom-mcp-forwarder.test.ts`（T-CF5 先脱敏后截断，secret 跨 300 边界不落明文）。

## 会话签发与代理转发（MCP+Valut Phase 3）

> 计划 `docs/engineering/plan/20261104-feat-mcp-valut-iteration.md` Phase 3（裁决 D1/D2/D6/D7/D8、
> 事实 F3/F4/F5/F10/F11/F15、关键实现要点 1~4）；契约 `contracts/agent-session.graphql`
> （`CreateSessionInput.customMcpServerIds`）+ `contracts/agent-session-websocket.md` §2.12.1 路由口径。

- **签发校验（D2 / T-CF1）**：`sessionService.create` 对 `customMcpServerIds` 去重 → ObjectId
  合法性 → `CustomMcpServer.find({_id:{$in}}).select('name').lean()` 命中数必须相等（可见集由
  workspace-scope 独占型插件注入；无 ALS 上下文的内部链路不注入，与既有口径一致）；**不可见 /
  不存在 / 非法 id 统一抛 `custom mcp server not found`，且在建会话之前拒绝（不建会话）**。
  命中后按入参顺序组装 `[{id,name}]` 快照。
- **签发触发与落库**：触发条件 `mcpServerIds.length > 0 || customMcpServers.length > 0`
  （**custom-only 会话同样签发**，否则只勾自定义 MCP 的会话拿不到代理地址，F5）；失败沿用既有
  fail-fast 形态（删会话 + `MCP endpoint 创建失败：…`）。`createEndpoint(sessionId, userId,
  mcpServerIds, workflow?, customMcpServers=[])`：
  - `serverNames` = 个人 MCP 名 ∪ custom 名（`Set` 去重，同名冲突由分流的 custom 优先裁决）；
  - `customMcpServers` 快照与 `tokenHash` **同一次 `findOneAndUpdate`**（沿用 upsert 形态）落
    `mcp_session_endpoints`（`_id:false` 子文档，缺省 `[]`；存量行缺省按空数组兜底）；
  - `acp:start` 载荷形态与既有完全一致（仅 serverNames 集合变大，F10）；TTL / revoke /
    `getStatus` 口径零改动；
  - `reissueEndpoint` 空判定 = **`mcpServerIds` 与 `customMcpServers` 均空**才返回 `null`，
    重签沿用两份快照与 workflow 作用域（T-CF2）。
- **分流（D1 / F3）**：`mcp-dispatch.dispatch()` 在 `payload.serverNames` 作用域校验通过后、
  `McpServer.findOne` **之前**读 `McpSessionEndpoint.findOne({sessionId}).lean()`（唯一索引、
  relay 请求路径每请求一次；不引入 Redis 快照缓存——删除即时失效优先于省一次查询）；快照 name
  命中 → `custom-mcp-forwarder`（**custom 优先于同名个人 MCP**），未命中走既有 platform /
  registered_proxy 路径零变化。`getStatus=active` 401 校验位置不动；诊断优先级
  `401 > 作用域 > 410 > 502`（D6）；name 不在作用域仍 `200 + SERVER_NOT_FOUND`（**不新增 403**）。
- **转发器（`services/custom-mcp-forwarder.ts`，入口 `forward({sessionId, snapshotEntry, body})`）**：
  按快照 id **每次请求实时** `CustomMcpServer.findById`（`runWithWorkspace(undefined, …)` 显式清空
  ALS 工作区上下文，绕过 `applyWorkspaceScope` 读过滤——服务端内部读的显式条件）→ 不存在/非法 id
  → `410`（**删除即全端点失效**，无需逐会话回收 key，D9）；存在则组装请求——customHeaders 同名
  多值 `Headers.append` 展开（Map 与 plain object 双形态归一）、`authType=bearer` →
  `Authorization: Bearer <valut-service.resolveValue(bearerValutEntryId)>`（**解密仅内存**，D8；
  托管凭据 `set` 覆盖同名自定义 authorization；条目加载失败 → `410` 同口径防御式）→ POST 真实
  endpoint（AbortController 30s，不可达/超时 → `502`，与 relay 60s 双层兜底）→ 回传
  `{status, body}`（真实状态码与响应体原样透传，`410/502` 亦然，F12 status 枚举已覆盖）。
- **改名/改配置实时生效（关键要点 4 / T-CF6）**：路由用**快照 name**、配置按**快照 id 实时加载**
  ——MCP 改名不影响存量会话路由；endpoint/headers/token 编辑后新调用立即用新值。
- **通知形态（D7）**：JSON-RPC body 无 `id` → 立即 `202` 并 fire-and-forget（不阻塞 MCP 握手），
  后台转发失败仅 `warn` 日志。
- **日志与明文红线（D4/D8）**：真实 endpoint 响应正文、错误正文、请求头、endpoint、token
  **一律不入日志**（错误信息对 endpoint/token **先替换敏感片段、再截断**后落——顺序不可颠倒，
  否则 secret 跨 300 边界时前半段明文会进日志）；只记
  `sessionId/mcpId/name/status/reason/errName` 白名单字段；会话文档与 relay 载荷均无凭据明文。
  自定义 MCP **不经 `mcp:forward:*` Redis 频道**（该频道仅 registered_proxy，F12）。
- **controller-api 镜像（F4）**：`servers/controller-api/src/models/mcp-session-endpoint.ts`
  仅同步增加 `customMcpServers` 只读镜像字段（本服务不读不写、无新端点）；**不得**借镜像改动
  `expiresAt` / TTL 索引语义。
- **测试**：`services/mcp-endpoint.test.ts`（T-CF1 签发合并/快照落库/custom-only、T-CF2 重签两快照
  含 workflow 作用域）、`services/mcp-dispatch.test.ts`（custom 优先于同名个人 MCP、未命中走既有、
  410 透传、通知 202、401 先于快照读、快照 name 路由）、`services/custom-mcp-forwarder.test.ts`
  （T-CF3 删除 410、T-CF4 bearer 注入/同名多值展开/不可达与超时 502、T-CF5 日志与返回无凭据明文、
  T-CF6 编辑即时生效/改名不影响）、`services/session.test.ts`（T-CF1 不可见 id 拒绝且不建会话）、
  `graphql/schemas/session.test.ts`（契约 `customMcpServerIds: [ID!]` 对齐）。

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
- Issue 触发复用已设置工作区（#452）：`IssuesTriggerRunner.prepareWorkspace` 先看 `CloudHost.workspaceId`（Git 项目设置成功后 CAS 回写），命中且 `ControllerWorkspace` 仍存在即直接 `PENDING_INSTANTIATE`，**不再 Git 初始化/重复设置工作区**——否则 `defaultWorkspace(host)` 返回的已是 repo 目录，再拼 `resolveClonePath` 会套出 `<repo>/<owner>/<repo>` 并重跑 setup。工作区行缺失时才回退「clonePath 路径判定 → createOperation」旧链路。
- 模型：`Model.contextLength`（Int，null=未设置）只读镜像 admin-api，经 `mapModel` 透出；上下文下发走两条通道：OpenAI 兼容 `/v1/models` 的 `context_length`（运行时网关），以及创建云电脑时 `secrets.modelContextLengths`（模型 ID → contextLength JSON object，仅启用且正整数；同名保留首个）经 cloud-controller `ZAG_MODEL_CONTEXT_LENGTHS` 写入 opencode 配置 `models.<id>.limit.context`（agent-gear ≥2.7.0，缺失优雅降级）。

## 多租户一期（三层帐号模型与租户隔离）

- **三层帐号模型**：`accounts`（登录凭据，不 ref User，username 唯一）→ `users`（身份主体，`accountId` 引用账户、`tenantId` 引用租户，保留原 `username/passwordHash` 一期不下线）→ `tenants`（`type=personal`，`_id` 复用 userId，无成员列表；成员关系由 `users.tenantId` 承载）。写方仅 agent-api；admin-api 为只读镜像。
- **认证**：`login` 走 `Account.findOne({username})` → bcrypt → `User.findOne({accountId})` → 签发 token（载荷仍是 userId，已发 token 不失效）；`me`/`AuthPayload.user` 返回 `{id,name,tenant}`；`User.tenant` 为**字段级 resolver（已登记 `graphql/resolvers/index.ts` 的 `User` 键）**，`memberCount=User.countDocuments({tenantId})`（一期恒 1）。前台注册已硬关闭（契约/resolver/前端三层移除）。
- **AuthContext**：`authenticateUser` 一次 `findById` 取 `{id,tenantId,name}`，`context.tenantId` 同步下发；`requireTenantId(context)` 回退链 `context.tenantId → currentUser.tenantId → currentUser.id`（personal 期恒等）。
- **租户隔离（双条件）**：带 `userId` 的 19 个集合均**复制新增**同值 `tenantId`（`userId` 字段与筛选全部保留）；`services/tenant-scope.ts` 的 Mongoose 插件在查询编译前为 `{userId}` 过滤注入 `tenantId`（显式 tenantId 不覆盖；递归处理 `$or`/`$and`/`$nor` 内的 userId 分支）、写入（save/insertMany/`$set.userId`）自动补齐 `tenantId`。**例外**：`userId` 为操作符对象（如 `$in`/`$nin`）时不复制（值语义不同；一期运行时无此类过滤点，二期放开 userId 维度前需显式处理）。T-ISO 矩阵（`models/tenant-isolation.test.ts`）对 19 集合逐一走真实 Mongoose 查询中间件（驱动层 `countDocuments` spy），并与 `TENANT_ID_COLLECTIONS` 的集合名互校；Mongoose v9 的查询/文档中间件必须写成**同步钩子（无 next 参数）**，否则运行期抛 `next is not a function`。新增带 userId 的模型必须声明 `tenantId` 并 `applyTenantScope(schema)`（**例外**：`user_commit_settings` 为成员级集合，`userId` 为全局成员主键、`tenantId` 仅留档，显式豁免插件，见「Commit 设置与提交身份」段）；唯一索引保留 userId 维度：`{tenantId,userId,name}` / `{tenantId,userId,githubUserId}` / `{tenantId,userId}`。
- **迁移**：`012-account-user-tenant` 逐 user 幂等拆分三件套（只复制不删除原登录字段）；`013-tenant-id-backfill` 19 集合复制清洗 + 索引（只新增不删除）。**集合名以模型 `model.collection.name` 为单一来源**（如 `issue_workflow_triggers`），由 T-ISO 互校 + `013-...real.test.ts` 真库兜底；历史环境若误建空集合 `issueworkflowtriggers`，确认无数据后可手工 drop。启动后 `services/tenant-self-check.ts` 以带索引 count + `limit(100)` 抽样异步自检，仅告警不阻塞。
- **计费**：`billing-client` ownerType 使用 `tenant`（ownerId=tenantId；`front_user` 仅兼容期旧调用方）；`startHarness` 下发 `tenantId`（=userId）。
- **待办通知租户归属**：订阅/引擎链路（permission / elicitation / harness login / workflow intervention）创建 `TodoItem` 时，必须经 `TodoService.resolveSessionTenantId` 显式继承会话所在租户工作区的 `tenantId`；缺省会由 tenant-scope 写成 `userId`（个人租户），导致团队工作区看不到待办、切到个人工作区反而可见。
- **开户**：`POST /internal/users`（Bearer `INTERNAL_API_TOKEN`）创建账户+用户+个人租户+零余额租户计费账户；按 username 幂等（200 既有视图 / 201 新建 / 400 规则 / 409 重名 / 503 计费不可达并回滚）。

## 工作流实例改名（工作流迭代）
- **契约**：`contracts/workflow.graphql` 的 `type Mutation` 新增 `renameWorkflowInstance(id: ID!, name: String!): WorkflowInstance!`；`graphql/schemas/workflow.ts` 为**手写 schema 串**，契约与 schema 必须双写（漏改即运行时 `Cannot query field`）。
- **服务**：`services/workflow/instance.ts` 的 `normalizeWorkflowName(raw)`（trim 后 1~64，非法抛 `invalid workflow name`）与 `workflowInstanceService.rename(userId, id, rawName)` 为**唯一名称规则来源**；归属口径与归档/删除一致（`actorFilter`），查询**不过滤 `deletedAt`** 以便区分「不存在/无权限」（`Workflow instance not found`）与「已删除」（`Workflow instance is deleted`）；更新带 `deletedAt:null` 并兜底 `matchedCount===0` 按已删除处理。名称规则仅作用于改名入口，实例化历史行为不变。
- **入口**：GraphQL `renameWorkflowInstance`（`graphql/resolvers/workflow.ts`，`wrap()` 原样透传文案）；平台 MCP `agent-workflow-tools.renameCurrentWorkflow`（`services/workflow/tool-handlers.ts`，工具总数 **14**）复用同一 service，错误映射 `invalid workflow name → INVALID_PARAMS`、`not found → NOT_FOUND`、其余（含已删除）→ `INVALID_STATE`。
- **已归档实例允许改名**（仅禁止已删除）；团队工作区非创建人场景与既有 13 个工具同口径，不在本期扩大范围。

## 多租户二期（工作区资源查询口径）

- **请求链路**：已归属工作区的资源（`sessions` / `controllers` / `controllerkeys` / `cloudhosts` / `cloudstorages` / `configuredworkflows` / `workflowinstances` / `workflowtemplates` / `githubaccounts` / `providers` / `models`）一律用 `actorFilter(userId)` 组合查询，**禁止显式写 `userId`**：工作区上下文存在时返回 `{}`，由 `applyWorkspaceScope` 注入可见集；无上下文（引擎/内部/迁移）才回退 `{userId}` 归属校验。典型回归：`Controller.cloudHost`、`sessionService.create` 的云电脑状态校验、云电脑创建时选择共享 GitHub 绑定、Issue 联动实例化时读取已配置工作流、会话级权限超时设置。
- **异步链路**：Issue/PR 回调、SSE 等无请求头链路先 `runWithWorkspace(...)` 建立上下文，再执行同样口径的查询。
- **写入继承（团队可见性）**：`sessionService.create` / `sessionImportService.importSessions` 的租户工作区归属按「显式传值 → 请求上下文 → 控制器（云电脑）归属」补齐并显式落 `workspaceId/tenantId`；云电脑 ready 默认会话与 Git 项目设置会话显式传 `resourceWorkspaceId`；`buildSessionWorkspaceContext` 在会话缺 `workspaceId` 时回退控制器（再回退 `CloudHost.resourceWorkspaceId`），保证后台会话里的 MCP 工具调用（如 `createConfiguredWorkflow`）仍落团队工作区。`configuredWorkflowService.configure/configureFromContent` 也显式写当前工作区/租户（插件之外的第二道保证）。存量空归属由迁移 `024-resource-workspace-backfill` 按控制器/已配置工作流补齐（opaque：无法推导的行不猜测）。
- **保留 `{userId}` 的例外**（按一期口径仍跟随成员本人）：个人 MCP 配置、待办通知、网关、未绑定 `ControllerKey` 的创建清理（避免误删他人 key）、`CloudHostSetupOperation` 等内部操作单、`CloudHostIssuesLinkage` 等个人联动配置。
- **项目工作区（ControllerWorkspace）跟随控制器成员口径（修复 B 看不到 A 的 working directory）**：`controllerWorkspaceService` 在请求工作区上下文内按「控制器可见集」查询/校验（`Controller.find/findOne` + `actorFilter`），不再用创建者 `userId`；`homeOverview.workspaces`、控制器设置-工作区、worktree 列表、会话创建/导入、工作流实例化与默认分支解析同步收敛。无 ALS 上下文（引擎/内部/迁移）仍沿用 `{controllerId,userId}` 旧口径，避免后台链路越权。项目工作区按 `{controllerId,path}` 在团队内幂等共享。

## 云存储归档优化（停止归档可选 + 归档/复原/fork）

> 需求 #434；契约 `contracts/cloud-host.graphql` / `contracts/cloud-storage.graphql` / 附录 A.2.10~A.2.13。

- **停止归档可选**：`stopCloudHost(id, force, archiveStorage)` 仅在「挂载存储 + 显式 false」时向 cloud-controller 下发 `destroyContainer(id,{storageArchive:false})`；true/缺省/未挂载保持旧报文（`destroyContainer` 单参数调用形态不变）。`CloudHostStopImpact.storage` 来自 `cloudStorageService.getSummary`（未挂载 null）。
- **terminal 联动顺序（D3）**：`syncStorageOnTerminal` 固定 ①`!host.readyAt → releaseStorage` ②`storage.archiveSkipped===true → detachToIdle` ③`archiveStatus=pending/running → markArchiving` ④既有 reconcile/release 兜底。`detachToIdle` 为 `{_id,status:'ATTACHED',attachedCloudHostId}` CAS → `IDLE + FULL`，清 attached*、保留 lastContainerId/usageBytes，不动 billingStartedAt。
- **状态机 + RESTORING**：`archive`（仅 IDLE）→ `ARCHIVING`（新 `currentArchive` 占位含 `operationId`，容器级 null）；同步失败回滚 `IDLE` 并**恢复旧 currentArchive**（D8）。`restoreToArchive`（IDLE+SUCCEEDED，或 RESTORING+FAILED 重试；权限创建人/管理员）→ `RESTORING` + `currentRestore` 占位；同步失败**保持 RESTORING**（初始置 `currentRestore=FAILED`、重试回写旧 FAILED 快照；`OPERATION_RUNNING`/`STORAGE_IN_USE` 保持 PENDING，D13 返工修订）。`fork`（源 IDLE/ARCHIVED + SUCCEEDED 归档；工作区可写）创建 `CREATING` 新记录（`sizeGi=源`、`forkedFromStorageId`、不写 `billingStartedAt`）并复用存储级 restore 端点。
- **回调**：`POST /internal/cloud-storages/:id/restores` → `handleRestoreCallback`，按 `currentRestore.operationId` 幂等、终态单调：SUCCEEDED `RESTORING→IDLE`（清 currentRestore、usageBytes=归档占用）/ fork `CREATING→IDLE`（写 `billingStartedAt`）；FAILED 复原保持 RESTORING + failureReason，fork 置 `CREATE_FAILED`（不计费，best-effort 删 PVC）。
- **重试/对账（D6/D7）**：`retryArchive` 以 `currentArchive.containerId` 判别来源（null=存储级 → `archiveStorageOperation` 新单；非空=容器级保持 `triggerArchive`），**不得用 lastContainerId**；`reconcileARCHIVING` 存储级按 `currentArchive.operationId` 查 `getStorageOperation`，容器级保持 `getArchive`；新增 `reconcileRESTORING`（`RESTORING/CREATING` 超 10 分钟按 operationId 补齐），`scheduleCloudStorageReconcile` 同 tick 串行调用。
- **销毁**：`RESTORING + currentRestore=FAILED` 允许销毁（`storage is restoring` 仅用于进行中）；错误白名单新增 `storage is not archivable/has no archive/is not restorable/is restoring/is not forkable/not allowed to restore storage`。
- **迁移**：`022-cloud-storage-fork` 幂等建 `{resourceWorkspaceId:1,forkedFromStorageId:1}` 部分索引（`forkedFromStorageId:{$type:'objectId'}`），不回填。

## 项目工作流模板持久化（#469）

- **扫描编排（`services/workflow/repo-templates.ts`）**：`repoTemplateService.scan(userId, workspaceId)` 先
  `controllerWorkspaceService.findById` 属主口径（不可见抛 `Workspace not found`），再 `Controller.findOne({_id, ...actorFilter})`；
  控制器离线 / `isRepoTemplateScanSupported(version)=false`（`compareVersions(version,'2.18.0') >= 0`，缺失/非法不支持）直接返回 `[]`。
  在线且版本支持时 `publish('session:command', {type:'workflow-templates:scan', requestId, controllerId, path})`，
  轮询 Redis `workflow-templates:scan:{requestId}`（500ms × 30），成功读后即删；超时/`success:false`/非法 JSON 均降级 `[]`。
- **逐文件解析（`parseRepoTemplate` 纯函数）**：JSON 语法 → 顶层形状（`name` 非空 string / `description` 可选 string /
  `nodes` 非空数组）→ 节点字段类型归一（`prompts/artifactTitles/dependsOn` 字符串数组等）→ `validateTemplateGraph`
  （错误文案原样透传）；逐文件隔离，输出按 `fileName` 排序。`RepoWorkflowTemplate` 追加 `nodes` 节点图（valid=true 时非空）。
- **`configureFromRepo`**：工作区可见性 → `controllerId` 推导 → **仅 `type='cloud'`**（否则 `repo workflow only supports cloud host`）
  → `fileName` 归一（trim 非空、`.json` 结尾、不含 `/`/`\`/`..`/NUL，否则 `invalid template file name`）→ `name` 1~64
  （否则 `invalid workflow name`）→ `normalizeConfiguredNodes` + `validateTemplateGraph` + `validateAgentConfigs`
  （与 `configureFromContent` 完全一致）→ 落库 `sourceKind:'REPO'`、`sourceRepoPath:'.zag/workflow/templates/<fileName>'`、
  `sourceWorkspaceId`；服务端**不回读仓库文件**（快照语义）。
- **来源字段（`ConfiguredWorkflow`）**：`sourceKind`（`PLATFORM` 默认 / `REPO`）、`sourceRepoPath`、`sourceWorkspaceId`
  全部可空/有默认，存量零迁移；`mapConfigured` 读取侧 `doc.sourceKind ?? 'PLATFORM'` 归一。
- **级联**：`cloudHostService.delete` 在同位追加 `configuredWorkflowService.deleteRepoScopedByController(controllerId)`
  （`deleteMany({controllerId, sourceKind:'REPO'})`，best-effort 失败仅 `logger.warn`）；PLATFORM 来源与实例历史不受影响。
- **版本工具**：`services/version.ts#compareVersions` 为单一来源（自 `cloud-host-service.ts` 逐字搬移）。
