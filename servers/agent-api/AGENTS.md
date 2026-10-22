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

- `Session.agentCapabilities` 读取 controller-api 落库的 `sessions.agentCapabilities`；`Session.features` 由 `services/agent-capabilities.ts` 的 `featuresFromSnapshot()` 输出（无快照返回 `[]`，不复制 FeatureId 矩阵）。
- `Session.availableModels` 为字段级 resolver：按平台模型库（`ModelService.listSourceLibrary()`，`AVAILABLE_MODELS_FILTER` 同口径）三档推断来源（`services/model-source.ts`：库比对 → 标识前缀 → 兜底），同一 GraphQL 请求只查一次库（`AuthContext.modelLibraryPromise`）。
- `TodoItem.resolution/resolvedAt/expiresAt`：`respondElicitation` 写 `accepted|declined|cancelled`；订阅 `elicitation:resolved` 后 `timeout→expired`、`unsupported_mode→failed`、`cancelled→cancelled`。TTL（5 分钟）保持不变。
- 新增或修改 `Session` 字段级 resolver 时，必须在 `graphql/resolvers/index.ts` 的 `Session` 键登记，否则线上字段不生效（backend-rules 陷阱）。

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
- 创建编排：校验开关/名称/harnessTypes/配置 → 读取 `cloudworkloads` preset → 计费账户 → 预生成 cloudHostId/controllerId → `ControllerKey(type=cloud)` → 预创建 `Controller(type=cloud,registering,name=用户命名)` → 默认工作区（`/root/workspace`）→ `CloudHost(STARTING)` → 铸造 `scope=cloud_host` 模型 Key → `POST /internal/containers{purpose:harness}`。失败逆序回滚；cloud-controller 成功后不再回滚。
- 只读模型：`models/cloud-container.ts`（cloudcontainers）、`models/cloud-workload.ts`（cloudworkloads）、admin-api 只读 `cloudhosts`；写方各自单一。
- 内部回调：`routes/internal-cloud-host.ts`（Bearer `INTERNAL_API_TOKEN`）。ready → RUNNING + 单 harness 默认会话（失败只告警）；terminal → STOPPED/FAILED + 批量 ENDED + 撤销模型 Key；均幂等。
- 会话只读：停止时 `sessionService.endByController`；`resume` 对云电脑 `STOPPING/STOPPED/FAILED` 返回 `session is ended`；`createSession` 对 cloud Controller 校验 `CloudHost.status===RUNNING`（不新增 Session 字段）。
- 删除：仅 `STOPPED/FAILED`，软删除 `cloudhosts.deletedAt`、撤销 ControllerKey、`Controller.status=offline`；Controller/会话/消息保留，列表与首页过滤。`Controller.cloudHost` 对软删除返回 null，前端对 `type=cloud && cloudHost=null` 同样按只读渲染。
- 开关：`HARNESS_ENABLED=false` 时 capabilities 隐藏/禁用、create 返回 `harness feature is disabled`；存量仍可 list/stop/delete。

## 云主机工作负载与 Github 项目设置（本期）

- 工作负载目录：`services/cloud-workload-catalog.ts`（只读 `cloudworkloads`，`listStandard` 排除 harness）；Github 预制项 `presetKey=github`，参数 `repoFullName`/`targetPath`。
- 编排：`services/cloud-host-workload-service.ts`（列表、单步安装、`cloud_host_setup_operations` runner、`pollBatch` 1s 轮询、单步超时 `CLOUD_HOST_SETUP_STEP_TIMEOUT_MS`）；`services/cloud-host-github-service.ts`（三步：Github 工作负载 → Git 项目设置 → 会话创建）。操作创建后立即返回，前端/ MCP 轮询终态；查询时 RUNNING 超过 `CLOUD_HOST_SETUP_STALE_MS` 标记 FAILED「操作已中断，请重试」。
- 凭据：`POST /internal/cloud-hosts/:controllerId/github-credential` 双鉴权（`INTERNAL_API_TOKEN` 或 Controller key），仅返回本机 `cloud_host_github_bindings` 绑定仓库的 `{token,expiresAt}`；`GitHubService.createRepoScopedToken` 使用 installation token + `repositories` + `contents:write`。token 不落库/不写日志/不进 operation error（统一 `sanitizeOperationError`）。
- GraphQL：`cloudHostWorkloads`、`cloudHostSetupOperation`、`installCloudHostWorkload`、`setupCloudHostGithubProject`、`retryCloudHostSetupOperation`；`CloudHost.defaultWorkspace/workloadInstalling` 为类型级 resolver（已登记 `resolvers/index.ts`）。
- MCP：平台服务 `agent-cloud-host-tools`（`transport/source=platform`），工具 `workload_list`/`workload_install`；云会话 `sessionService.create` 自动装配，非云会话不装配；`workload_install` 等待终态（上限 10 分钟），执行记录 `source=mcp`。
- 会话：`controllerWorkspaceService.ensureWorkspace` 按路径幂等 upsert（不触发 10 个工作区上限）；Git 设置成功后自动建会话，失败仅 session 步骤 FAILED、operation 仍 SUCCEEDED 并提示手动建会话。

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
