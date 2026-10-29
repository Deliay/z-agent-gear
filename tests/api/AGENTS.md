# API Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed

## 测试步骤

> **注意**: 只允许使用 Aspire 编排服务，禁止直接使用 Docker 命令。

### 1. 启动服务

```bash
# 启动 Aspire 编排并等待服务就绪（在项目根目录）
aspire start && aspire wait agent-api
```

### 2. 获取 Endpoint

```bash
# 查看 agent-api 的地址
aspire describe agent-api
```

输出中查找 `agent-api` 的 URL，例如 `http://localhost:10001`。

### 3. 填入环境变量并执行测试

> **多租户一期（F4）**：前台注册已硬关闭，测试用户统一由 `src/support/front-users.ts` 的
> `createFrontUser()` 经 agent-api `POST /internal/users` 开户（Bearer `INTERNAL_API_TOKEN`）后登录。
> 因此 `INTERNAL_API_TOKEN` 是所有需要造用户套件的前置条件；缺失时用例显式报错。

```bash
# 查看各服务 endpoint
aspire describe agent-api
aspire describe controller-api
```

从输出中查找各服务的 `http://localhost:<port>` URL，例如:
- `agent-api`: `http://localhost:10001`
- `controller-api`: `http://localhost:35273`

填入实际端口后执行：

```bash
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
CONTROLLER_API_URL=http://localhost:35273 \
npm test
```

> admin 套件（`src/admin-api/**`）与 agent-api scope 回归需要 admin-api 就绪：`aspire start && aspire wait admin-api agent-api && aspire wait controller-api`。

### 4. 重新运行测试

如果需要重新运行测试，必须从**步骤 1** 开始，重新运行 Aspire 实例。

## 测试脚本

| 脚本 | 说明 |
|------|------|
| `npm test` | 运行全部常规测试文件（46 个：admin-api / agent-api / cloud-controller / controller-api；`fileParallelism: false` 串行，不含 `acp-real-*`） |
| `npm run test:real` | 仅运行 `acp-real-*` 测试（6 个，串行，超时 30s） |
| `npm run test:all` | 先运行 `acp-real-*` 再运行常规测试 |

> **注意**: `acp-real-*` 测试会启动真实的 agent-controller 进程，共享 PID 文件 `/tmp/agent-controller.pid` 和端口 34519，因此必须串行执行，且需要干净数据库状态。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_URL` | agent-api GraphQL 完整地址 | `http://localhost:10001/graphql` |
| `ADMIN_API_URL` | admin-api GraphQL 完整地址 | `http://localhost:10003/graphql` |
| `AGENT_API_URL` | admin-api → agent-api 内部地址（`adminCreateFrontUser` 转发 `POST /internal/users`；由 AppHost 注入 admin-api 侧，测试侧无需直连，仅当 admin-api 未注入时用于排查 `AGENT_API_UNAVAILABLE`） | -（admin-api 侧配置） |
| `MONGODB_URI` | 共享 MongoDB 连接串（T-A7 强制改密守卫、scope 隔离、**T-AC5 模型来源分组**等 DB 断言用）。Aspire 默认 `tls=true`，自签 dev cert 需追加 `tlsAllowInvalidCertificates=true`（或在 shell 中用单引号包裹避免 `&` 被截断）。**T-AC5 为模型来源分组唯一验收，缺参时用例显式失败（不再静默 skip）**；billing-events T-CC-B11、billing-gateway T-B24/T-B27/T-B28 同样缺参即失败；**T-PR16（READY 打回）需直写实例快照，缺参时该用例跳过**；其余历史用例缺省时仍跳过 | -（可 `aspire describe mongodb` 获取） |
| `CLOUD_CONTROLLER_INTERNAL_TOKEN` | cloud-controller 内部 API Bearer token。**无默认值**（问题 47）：须与 Aspire 注入的 `internal-api-token` 一致；**billing-events 全部用例缺参即失败（不再整套 skip）**，其余内部 API 套件未提供时跳过 | - |
| `ADMIN_INITIAL_PASSWORD` | admin-api 种子管理员初始密码。**无默认值**（问题 4/47）：Aspire 每次启动随机生成（admin-api 首次种子时一次性打印到启动日志），或经 `Parameters__admin-initial-password` 注入；测试须注入与服务一致的值 | - |
| `CONTROLLER_API_URL` | controller-api **基础地址**（Socket.IO 直连，**不要**带 `/graphql`；带路径会导致注册超时级联） | `http://localhost:35273` |
| `INTERNAL_API_TOKEN` | agent-api 内部 API Bearer token。**多租户一期起为测试用户开户的唯一引导**：`src/support/front-users.ts` 的 `createFrontUser()` 调 `POST /internal/users`（Bearer 本 token）再 `login` 取 token；缺失时所有需要造用户的套件显式报错（不再静默跳过）。云电脑 ready/terminal、cloud-host-callback、billing 内部 REST 同用 | - |
| `HARNESS_ENABLED` | 置 `true` 时运行云电脑 harness 套件；缺省/false 时走 feature-disabled 分支（会误跳过 T-CH2 等用例） | `false` |
| `REDIS_URL` | workflow 套件直连 Redis（断言 channel/缓存）；需与 agent-api `REDIS_URI` 同一实例 | `redis://localhost:6379` |
| `EVENT_CALLBACK_TOKEN` | 工作流 PR 联动事件回调平台凭据（T-PR* / T-CR* 用例；缺失时整套跳过） | - |
| `GITHUB_API_BASE` | Check Runs 出站用例（T-CR*）的 GitHub API 地址。需在启动 Aspire 前指向本地 mock（示例：`GITHUB_API_BASE=http://127.0.0.1:19418 aspire start`，端口即 `MOCK_GITHUB_PORT`）；缺失时整套跳过 | - |
| `GITHUB_WEBHOOK_SECRET` | 事件回调 / GitHub 原生 webhook（T-GHWH* / T-GHI* 整套依赖）HMAC-SHA256 验签密钥 | - |
| `CLOUD_HOST_CONTROLLER_ID` | 云电脑 Issues 联动配置套件（T-GHIL*）使用的 RUNNING 云电脑控制器 | - |
| `CLOUD_HOST_WORKFLOW_ID` | 上述控制器下含 HUMAN 节点的已配置工作流（T-GHIL*） | - |
| `GITHUB_TEST_REPO` | 已绑定 Github 账号的仓库（T-GHIL* 标签同步 / T-GHI* 全链路） | - |
| `CLOUD_HOST_ISSUES_LABEL` | T-GHI* 全链路使用的联动标签名（需已建配置并同步到仓库） | - |
| `CLOUD_CONTROLLER_URL` | cloud-controller 服务地址（cloud-controller 套件） | `http://localhost:10004` |

> 套件内含共享账号（admin）口令轮换与 `mustChangePassword` 翻转等用例，**禁止多 worker 并行**；默认 vitest 已串行于同一进程内，如需并行务必隔离环境。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 测试清单

### 工作流 Check Runs 同步 (`workflow-check-runs.test.ts`)

出站行为经 `src/mock-github-server.ts`（进程内 mock，端口 `MOCK_GITHUB_PORT`，默认 19418）验证；agent-api 以 `GITHUB_API_BASE` 指向该端口。mock 按真实 GitHub 行为拒绝 `conclusion=stale`（422，仅 GitHub 可置 stale），由 `src/mock-github-server.test.ts` 守卫。

| 测试 | 描述 |
|------|------|
| T-CR02 | 状态变化同 sha → PATCH 同一 check-run（completed/success），无新建 |
| T-CR03 | commit 前进 → 旧 check-run 仅 PATCH output（`已过期`，不写 stale）+ 新 sha 新建，登记记录新 commit |
| T-CR04 | 重复绑定同 PR → 零重复 create / PATCH |
| T-CR06 | plan 消息满足四条件刷新 `output.text`；非工作流会话零写入 |
| T-CR08 | mock 注入 403 → `lastSyncError=检查项写入权限不足`，节点仍正常完成 |
| T-CR09 | PR 已关闭 → 停止同步，`lastSyncError` 为空 |
| T-CR10 | 末节点完成触发注销后仍写入 DONE check-run（capture-then-execute） |
| T-CR11 | GraphQL `pullRequestLinks` 透出 checkRunUrl / lastSyncedCommitSha / ISO lastSyncAt |
| T-CR12 | 存量登记（同步字段为 null）首次状态变化自然补齐，无迁移 |

> T-CR01（绑定即首同步）的出站断言由 `servers/agent-api/src/services/workflow/tool-handlers.test.ts` 与 `pr-check-run-sync.test.ts` 覆盖（本套件不重复建 PR 工具链）。

### Commit 设置与提交身份 (`agent-api/github.test.ts`)

| 测试 | 描述 |
|------|------|
| T-CS-API1 | `commitSettings` 未认证拒绝；从未保存返回双 UNSET |
| T-CS-API2 | `updateCommitSettings` 保存 / 回读自定义提交人全字段（trim 归一） |
| T-CS-API3 | 白名单错误逐字：committer required / invalid github account / invalid custom committer |
| T-CS-API4 | 归一落库：mode=UNSET 不清提交人、type=UNSET 清空冗余字段 |
| T-CI-API1 | `POST /internal/cloud-hosts/:id/commit-identity` 无 / 非法凭据 401 |
| T-CI-API2 | `co_author` 返回提交人 + bot 全字段（需 `GITHUB_API_BASE` 指向 mock-github-server） |
| T-CI-API3 | 主机不存在 / 未保存设置均 200 `{mode:'unset'}`（永不 404） |
| T-CI-API4 | 帐号解绑 / 越权降级 unset |
| T-CI-API5 | unset 响应缺省字段（仅 mode） |

> `tests/api/src/mock-github-server.ts` 提供 `GET /app`（slug）与 `GET /users/{slug}[bot]`（id）mock，
> 并支持 `failNext` 注入失败（60s 失败 sentinel / 降级路径）。

### Auth API (`auth.test.ts`)

> 前台注册已硬关闭（多租户一期）：契约层无 `signup`，测试用户统一经 `src/support/front-users.ts` 的
> `createFrontUser()`（`POST /internal/users` 开户 + `login`）引导。

| 测试 | 描述 |
|------|------|
| 契约 - 无自助注册 | introspection 的 mutation 无 signup/register，仅保留 login |
| 契约 - User 字段 | `User` 暴露 `name` + `tenant`，不再暴露登录字段 `username` |
| login - 正确凭证 | 应返回 token 和用户信息；`user.name`=用户名、`tenant` 同名 personal、memberCount=1、tenant.id=user.id |
| login - 错误密码 | 应返回「Invalid username or password」 |
| login - 不存在的用户 | 应返回「Invalid username or password」 |
| me - 未认证 | 应返回 null |
| me - 已认证 | 应返回当前用户信息（id/name/createdAt + personal tenant） |

### 多租户一期验收 (`agent-api/multi-tenant.test.ts` T-MT*)

> 需要 agent-api + controller-api 就绪，且注入 `INTERNAL_API_TOKEN`（开户）；fake controller 走真实
> Socket.IO 握手（自动应答 `acp:check` / `acp:start`）。T-MT5 直读共享 Mongo，需要 `MONGODB_URI`（缺省跳过）。

| 测试 | 描述 |
|------|------|
| T-MT1 开户 → login → me | `me.name`=用户名、`me.tenant` 同名 personal、`memberCount=1`、tenant.id=user.id（personal 期 tenantId==userId） |
| T-MT2a 会话隔离 | B 查 A 的 `session(id)` 返回 null；B 的 `sessions` 列表不含 A 会话 |
| T-MT2b 工作区隔离 | B `controllerWorkspaces(A.controllerId)` 报 Not found（不泄露存在性）；B 的列表不含 A 工作区；B `deleteWorkspace(A)` 不生效 |
| T-MT2c MCP server 隔离 | B 查 A 的 `mcpServer(id)` 返回 null；B `setMcpServerEnabled` 拒绝；B 列表不含 |
| T-MT2d 待办隔离 | B 的 `getTodoList` 不含 A 的 todo；B `markTodoRead(A)` 返回 false |
| T-MT2e 工作流模板隔离 | B 列表不含 A 模板；B update 报「不存在或无权限」；B delete 不生效 |
| T-MT2f 列表抽查 | controllers / configuredWorkflows 跨租户列表不含 A 数据（其余集合由各 service 的 T-ISO-* 单测覆盖） |
| T-MT3 行为回归 | A 的会话/控制器/工作区/模板/MCP/待办列表仍能看到自己创建的数据 |
| T-MT5 迁移核对（需 `MONGODB_URI`） | users 三件套（name/tenantId/accountId、tenantId==userId）、accounts/tenants 关联、sessions tenantId==userId、billingaccounts 前台 ownerType=tenant 且无遗留 front_user 行、controllers/controllerworkspaces tenantId 回填 |

> 多租户二期扩展（同文件 `T-PROV`）：`POST /internal/users` 后个人全局工作区唯一、`tenantmembers{role:'admin'}`
> 齐备、重复开户 200 幂等；team 成员被移除后 `myWorkspaces` 立即不可见且显式 `x-workspace-id` 访问返回
> `workspace not found`。需要 `INTERNAL_API_TOKEN`。

### 多租户二期工作区 API (`agent-api/workspace.test.ts` T-WS-API)

> 契约 `contracts/workspace.graphql`（租户工作区 mutation 为 `*TenantWorkspace`，与项目工作区
> `createWorkspace` 区分）。需要 agent-api + controller-api 就绪、`INTERNAL_API_TOKEN`（造 team 租户/成员）；
> 共享供应商用例使用进程内 mock LLM（`src/mock-server.ts`，随机端口）。

| 测试 | 描述 |
|------|------|
| T-WS-API1 缺省上下文 | 无 `x-workspace-id` 回退个人租户全局工作区（`myWorkspaces` 唯一、role=admin、readOnly=false），providers/models 可直接查询（与一期一致）；显式发送个人全局 id 等价 |
| T-WS-API2 非法/不可达 | 非法 id / 非成员团队全局 / 非成员普通工作区均 `workspace not found`（不泄露存在性） |
| T-WS-API3 工作区 CRUD | developer 创建拒绝 `not a tenant admin`；重名 `workspace name already exists`；改名生效；global 改名/删除/加成员 `global workspace is immutable`；非本租户成员 `user is not a tenant member`；空工作区删除返回 true；写入资源（commit 设置）后删除 `workspace is not empty` |
| T-WS-API4 共享读/写口径 | 普通工作区 `providers`/`models` 含团队全局工作区共享资源（workspaceId=全局）；普通上下文删除全局供应商不生效；admin 在全局上下文删除后普通工作区不可见 |
| T-WS-API5 Commit 三段矩阵 | 本工作区未设 + 全局未设 → `source=UNSET`；全局设 → 普通工作区 `source=GLOBAL`；本工作区设 → `source=WORKSPACE` |
| T-WS-API6 developer 全局只读 | 团队全局上下文写共享资源（provider）被插件拦截 `global workspace is read-only`；创建工作区仍 `not a tenant admin` |
| T-WS-API7 personal 拒绝 | personal 租户全局上下文 `createTenantWorkspace` → `personal tenant cannot create workspaces` |
| T-WS-API8 租户成员管理 | `searchAccounts` admin 可搜（结果为 username/name/userId 最小集）、developer `not a tenant admin`；`addTenantMember` 指定/缺省 role、重复幂等不覆盖；`changeTenantMemberRole` 生效；加入工作区后 `removeTenantMember` 立即失去团队/工作区访问并级联清理 workspacemembers，资源保留 |
| T-WS-API9 last-admin / personal | 最后一名 admin 降级 `last admin cannot be demoted`、移除 `last admin cannot be removed`；personal 租户 add/remove/changeRole 均 `personal tenant is immutable` |

### 多租户二期工作区资源隔离 (`agent-api/workspace.test.ts` T-WS-ISO)

> 同一夹具（team 租户 + admin/developer/outsider 三用户 + 普通工作区）覆盖 8 个资源集合的
> 工作区隔离：同工作区 developer 可见/可操作他人创建的资源、非成员（其它租户）不可见、
> admin 切换到目标工作区后可见；「其它工作区」断言额外验证普通工作区资源不出现在团队全局上下文。
> controllers/controllerkeys/sessions 走真实 GraphQL + controller-api 注册；configuredWorkflows/
> workflowInstances 走真实模板 → 配置 → 实例化链路。**cloudhosts / githubaccounts 无前台创建 API**
> （云电脑需 HARNESS_ENABLED、GitHub 绑定需真实 App OAuth），改由 `MONGODB_URI` 直插夹具，
> 缺参时对应用例显式 `skipIf` 并在标题标注。

| 测试 | 描述 |
|------|------|
| T-WS-ISO1 sessions | developer 在普通工作区可见/可读 admin 创建会话（`sessions` + `session(id)`）；outsider 列表不含且 `session(id)` 为 null；admin 在团队全局上下文不可见、切到普通工作区可见 |
| T-WS-ISO2 controllers/controllerkeys | developer 可见 admin 注册控制器并**改名**（成员可操作他人资源）；outsider 列表不含且 `controller(id)` 为 null；admin 切换后可见；未绑定 key 同口径（developer 可重命名，非成员不可见） |
| T-WS-ISO3 cloudhosts（需 `MONGODB_URI`） | 直插 `cloudhosts`（`resourceWorkspaceId`=普通工作区）→ developer `myCloudHosts`/`cloudHost(id)` 可见；outsider 不可见；admin 切换可见；契约 `CloudHost.workspaceId`=租户工作区 id |
| T-WS-ISO4 githubaccounts（需 `MONGODB_URI`） | 直插 `githubaccounts`（`workspaceId`=普通工作区）→ developer 可见（共享读=本工作区∪全局）；outsider 不可见；普通工作区行不进入团队全局上下文 |
| T-WS-ISO5 configuredWorkflows | developer 可见 admin 配置的工作流（列表 + `configuredWorkflow(id)`），`resourceWorkspaceId`=普通工作区；outsider/团队全局上下文不可见；admin 切换可见 |
| T-WS-ISO6 workflowInstances | developer 可见 admin 实例化的实例，`resourceWorkspaceId`=租户工作区、`workspaceId`=项目工作区（语义互不影响）；outsider/团队全局上下文不可见；admin 切换可见 |
| T-WS-ISO7 workflowTemplates | 自定义模板仅本工作区可见且 `resourceWorkspaceId`=普通工作区；outsider/团队全局上下文不可见；内置模板在个人全局 / 团队全局 / 团队普通三种上下文均可见且 `resourceWorkspaceId=null` |


### Admin Team 租户 API (`admin-api/tenant-team.test.ts` T-TT-API)

> `contracts/admin-tenant.graphql`：admin-api 仅转发 agent-api `/internal/tenants*`。需要 admin-api + agent-api
> 就绪、`INTERNAL_API_TOKEN`（admin-api 侧 Bearer）与 `ADMIN_INITIAL_PASSWORD`（管理员登录归一化）。

| 测试 | 描述 |
|------|------|
| T-TT-API1 未鉴权 | 三个 team mutation 均「Not authenticated」 |
| T-TT-API2 创建 team | `adminCreateTeamTenant` → type=team、memberCount=0、余额 0/null；重名 409 `tenant name already exists` 且仅 1 条同名租户 |
| T-TT-API3 加成员 | 指定 role=admin、缺省 developer；重复添加幂等且不覆盖既有角色 |
| T-TT-API4 详情角色/工作区 | `adminTenant.users` 含 role；`workspaces` 只读且自动开通 global（memberCount=租户成员数）；introspection 无 workspace 写 mutation |
| T-TT-API5 登录/移出闭环 | 成员登录 `myWorkspaces` 即含团队工作区；last-admin 移除 409 `last admin cannot be removed`；移除 developer 成功后成员立即不可见且 header 访问 `workspace not found` |
| T-TT-API6 personal 全拒绝 | personal 租户 add/remove 成员均 `personal tenant is immutable`（INVALID_ARGUMENT） |
| T-B2 团队计费口径 | 团队工作区上下文 `cloudHostBillingQuote` 取 **team 租户**账户余额（充值 10 → 报价 10、`/internal/billing/charges` 扣 5 → 报价 5）；个人租户余额始终 0。为最小断言（不创建真实云电脑，需 Aspire + `INTERNAL_API_TOKEN`；完整扣费/退款/报价链路由 `cloud-host-charges` / `cloud-host-billing-quote` 覆盖） |

### LLM Provider & Model API (`llm.test.ts`)

| 测试 | 描述 |
|------|------|
| providers query - 无 token | 应返回「Not authenticated」 |
| models query - 无 token | 应返回「Not authenticated」 |
| providers query - 已认证 | 仅返回用户 scope，且包含 beforeAll 创建的种子供应商（非空） |
| models query - 已认证 | 返回非空模型列表，含种子供应商模型与已启用全局模型 |
| createProvider - 无效 endpoint | 应返回连通性测试失败 |
| createProvider - 空名称 | 应返回校验错误 |
| createProvider - 无 auth | 应返回「Not authenticated」 |
| batchEnable - 空列表 | 应返回 successCount=0 |
| batchDisable - 空列表 | 应返回 successCount=0 |
| batchDelete - 空列表 | 应返回 successCount=0 |
| batchEnable - 无 auth | 应返回「Not authenticated」 |
| toggleProvider - 不存在的 provider | 应返回「Provider not found」 |
| toggleProvider - 无 auth | 应返回「Not authenticated」 |
| deleteProvider - 不存在的 provider | 应返回 false |
| updateProvider - 不存在的 provider | 应返回「Provider not found」 |
| createCustomModel - 无 auth | 应返回「Not authenticated」 |
| toggleModel - 无 auth | 应返回「Not authenticated」 |
| updateModelSortOrder - 无 auth | 应返回「Not authenticated」 |

### Controller Key API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllerKeys query - 无 token | 应返回「Not authenticated」 |
| controllers query - 无 token | 应返回「Not authenticated」 |
| controller query - 无 token | 应返回「Not authenticated」 |
| createControllerKey - 无 auth | 应返回「Not authenticated」 |
| createControllerKey - 正常创建 | 应返回 key 和 rawKey（zag_k_ 前缀） |
| createControllerKey - 空名称 | 应返回校验错误 |
| createControllerKey - 替换未绑定 key | 生成新 key 时自动删除旧的未绑定 key |
| controllerKeys query - 已认证 | 应返回未绑定 key 列表（含 rawKey），不返回已绑定 key |
| renameControllerKey - 无 auth | 应返回「Not authenticated」 |
| renameControllerKey - 正常重命名 | 应返回新 name |
| renameControllerKey - 不存在的 key | 应返回错误 |

### Controller Management API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllers query - 已认证 | 应返回空列表 |
| controller query - 不存在 | 应返回 null |
| renameController - 无 auth | 应返回「Not authenticated」 |
| renameController - 不存在 | 应返回「Controller not found」 |
| unbindController - 无 auth | 应返回「Not authenticated」 |
| unbindController - 不存在 | 应返回 false |

### Controller Online Status (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| register 后查询 controller | status 应为 online，hostname/version 正确 |
| controllers 列表包含在线 controller | 应包含 status=online 的记录 |
| unregister 后 controller 和 key 应被删除 | 查询应返回 null |
| unbind 后 controller 和 key 应被删除 | GraphQL unbind 后查询应返回 null |
| register 后 controllerKeys.lastUsedAt | 应更新为非 null |

### Controller WebSocket API (`controller-api/websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| register - 有效 key | 应返回 controllerId |
| register - 无效 key | 应返回 INVALID_KEY 并断开 |
| register - 版本不匹配 | 应返回 VERSION_MISMATCH 并断开 |
| heartbeat - 已认证客户端 | 应接受心跳，连接保持在线 |
| unregister - 主动注销 | 应删除 key 和 controller 记录并断开 |
| session 独占 - 重复 key | 第二个连接应收到 KEY_ALREADY_ONLINE |

### Session API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| sessions query - 无 token | 应返回「Not authenticated」 |
| session query - 无 token | 应返回「Not authenticated」 |
| createSession - 无 auth | 应返回「Not authenticated」 |
| createSession - 正常创建（opencode） | 应返回 session（status=creating, acpServerType=opencode） |
| createSession - 正常创建（github_copilot） | 应返回 session（status=creating, acpServerType=github_copilot） |
| createSession - 正常创建（claude_code） | 应返回 session（status=creating, acpServerType=claude_code） |
| createSession - 正常创建（gemini_cli） | 应返回 session（status=creating, acpServerType=gemini_cli） |
| createSession - 正常创建（codex） | 应返回 session（status=creating, acpServerType=codex） |
| createSession - 无效 controllerId | 应返回「Controller not found」 |
| sessions query - 已认证 | 应返回 sessions 列表 |
| session query - 已存在的 session | 应返回 session 详情 |
| session query - 不存在的 session | 应返回 null |
| sendSessionMessage - 正常发送 | 应返回 input 方向消息 |
| sendSessionMessage - 不存在的 session | 应返回错误 |
| sessionMessages query - 已有消息 | 应返回消息列表 |
| sessionMessages query - 不存在的 session | 应返回错误 |
| closeSession - 正常关闭 | 应返回 true，status 变为 ended |
| deleteSession - 正常删除 | 应返回 true，session 不再存在 |
| acpCapabilities - 无 token | 应返回「Not authenticated」 |
| acpCapabilities - 已认证 | 应返回 capabilities 列表（含 checkedAt） |
| acpCapabilities - 不存在的 controller | 应返回错误 |
| refreshAcpCapabilities - 无 token | 应返回「Not authenticated」 |
| refreshAcpCapabilities - 不存在的 controller | 应返回错误 |
| refreshAcpCapabilities - 已认证 | 应返回 capabilities 列表（含 checkedAt） |
| acp:check:result - opencode | 普通 acp:check:result 响应（仅 opencode） |
| acp:check:result - 多 Server | acp:check:result 响应包含 opencode + github_copilot 两个 server |
| gc:start - github_copilot | 创建 session 时 acpServerType=github_copilot，验证 serverType 正确传递 |

### Session SSE API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| 未认证 SSE 连接 | 应返回 401 |
| 不存在的 session SSE | 应返回 404 |
| 正常 SSE 连接 | 应返回 200 + event-stream，发送 history |
| SSE modes - acp:start:result 含 modes | SSE 初始 status 事件包含 modes/currentModeId/currentModel |
| SSE 高频消息时序 | 高频连发 5 条消息，SSE 推送顺序应与到达顺序一致 |

### Controller ACP WebSocket (`controller-api/acp-websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| acp:check - opencode | 应请求检测并返回 opencode servers 列表 |
| acp:check - 全部 5 种 Server | 应请求检测并返回全部 5 种 Server（opencode + github_copilot + claude_code + gemini_cli + codex） |
| acp:start - opencode | 应发送 acp:start 请求（serverType=opencode），controller 响应 success |
| acp:start - github_copilot | 应发送 acp:start 请求（serverType=github_copilot），controller 响应 success |
| acp:start - claude_code | 应发送 acp:start 请求（serverType=claude_code），controller 响应 success |
| acp:start - gemini_cli | 应发送 acp:start 请求（serverType=gemini_cli），controller 响应 success |
| acp:start - codex | 应发送 acp:start 请求（serverType=codex），controller 响应 success |
| acp:start - failure | 应发送启动请求，controller 响应 failure，session status=ended |
| acp:message | 应转发 controller 输出消息并持久化到 DB |
| acp:stop | 应发送停止请求，controller 响应 stopped，session status=ended |

### End-to-End: Session 全链路 (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| gc:create → acp:start → verify serverType | 创建 github_copilot session → fake controller 收到 acp:start（serverType=github_copilot）→ 响应 success → 验证 acpServerType 和 status |
| create → acp:start → success → verify running | 创建 session → fake controller 收到 acp:start → 响应 success → 查询 session status=running |
| create → acp:start → failure → verify ended | 创建 session → fake controller 响应 failure → 查询 session status=ended |
| create → send message → controller receive → output persisted | 创建 session → GraphQL 发消息 → fake controller 收到 acp:message → 模拟输出 → 查询消息列表验证 input+output 都持久化 |
| resume → acp:resume → success → verify idling | 创建 session → 关闭 → resume → fake controller 收到 acp:resume → 响应 success → 验证 idling |
| resume → acp:resume → failure → verify ended | 创建 session → 关闭 → resume → fake controller 响应 failure → 验证 ended |

### History Session Sync API (`agent-api/history-session-sync.test.ts`)

| 测试 | 描述 |
|------|------|
| listHistorySessions - 无 token | 应返回「Not authenticated」 |
| listHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| listHistorySessions - 不存在的 workspace | 应返回「Workspace not found」 |
| listHistorySessions - 正常返回 | 通过 fake controller 响应返回 history session 列表 |
| listHistorySessions - 带 acpServerType 参数 | 使用 acpServerType=claude_code 调用 listHistorySessions，验证成功 |
| importHistorySessions - 无 token | 应返回「Not authenticated」 |
| importHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| importHistorySessions - 导入单个 session | 导入 1 个 session，验证 messageCount=2 |
| importHistorySessions - 导入多个 session | 导入 2 个 session，验证都存在并 status=ended |
| importHistorySessions - 去重过滤 | 先导入 acp_sync_sess_1，list 应返回 acp_sync_sess_2 但排除 s1 |
| importHistorySessions - 带 acpServerType 参数 | 使用 acpServerType=gemini_cli 调用 importHistorySessions，验证导入成功 |

### Worktree Session API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| createSession with enableWorktree - 上传分支后缀 | 创建 session（enableWorktree=true + worktreeBranchSuffix），等待 git:worktree:add，controller 响应成功，验证 worktreePath / worktreeBranch |
| createSession with enableWorktree - 默认分支后缀 | enableWorktree=true 无后缀，验证 git:worktree:add 的 branch 不包含 "undefined" |
| createSession with enableWorktree - 失败 | git:worktree:add 返回 failure，验证 session status=ended，worktreePath=null |

### Controller Worktree Dir API (`agent-api/controller.test.ts`)

| 测试 | 描述 |
|------|------|
| setControllerWorktreeDir - 无 auth | 应返回「Not authenticated」 |
| setControllerWorktreeDir - 不存在的 controller | 应返回「Controller not found」 |
| setControllerWorktreeDir - 正常设置 | 设置 /home/user/worktrees，验证 controller.worktreeDir 持久化 |

### Folder Creation API (`agent-api/workspace.test.ts`)

| 测试 | 描述 |
|------|------|
| createFolder - 无 auth | 应返回「Not authenticated」 |
| createFolder - 不存在的 controller | 应返回「Controller not found」 |
| createFolder - offline controller | 应返回「Controller is offline」 |
| createFolder - 成功 | 等待 fs:mkdir，controller 响应 success，验证 FolderEntry（name/path/isDirectory） |
| createFolder - 失败 | fs:mkdir 返回 failure(error)，应返回 GraphQL error |

### Folder Browse API (`agent-api/workspace.test.ts`)

| 测试 | 描述 |
|------|------|
| browseFolder - 无 auth | 应返回「Not authenticated」 |
| browseFolder - 不存在的 controller | 应返回「Controller not found」 |
| browseFolder - offline controller | 应返回「Controller is offline」 |
| browseFolder - 返回目录列表 | 等待 fs:browse，controller 响应 entries，验证 FolderEntry 列表 |
| browseFolder - 返回空列表 | controller 响应空 entries，验证返回 [] |
| browseFolder - path=null 使用 home | path 为 null 时 controller 收到 null path，验证透传 |
| browseFolder - path=/ 根目录 | path 为 / 时 controller 收到 / path，验证返回根目录 entries |
| getHomeDirectory - 无 auth | 应返回「Not authenticated」 |
| getHomeDirectory - 不存在的 controller | 应返回「Controller not found」 |
| getHomeDirectory - 成功 | 等待 fs:home，controller 响应 path，验证返回 home 路径 |

### Port Forward API (`agent-api/port-forward.test.ts`)

| 测试 | 描述 |
|------|------|
| portForwards query - 无 token | 应返回「Not authenticated」 |
| createPortForward - 无 auth | 应返回「Not authenticated」 |
| deletePortForward - 无 auth | 应返回「Not authenticated」 |
| createPortForward - 不存在的 controller | 应返回「Controller not found」 |
| createPortForward - controller 离线 | 应返回「Controller is not online」 |
| createPortForward - 成功创建 | 应返回端口转发记录（port/status/controllerId） |
| createPortForward - 端口重复 | 应返回「Port already forwarded」 |
| portForwards query - 已认证 | 应返回端口转发列表 |
| deletePortForward - 成功删除 | 应返回 true，列表中不再包含该端口 |
| deletePortForward - 不存在的端口 | 应返回 false |

### Agent Workflow API (`agent-api/workflow.test.ts`)

| 测试 | 描述 |
|------|------|
| A1 创建合法模板 | 创建成功，version=1，isBuiltin=false |
| A2 非法图拒绝 | 环 / 双首节点 / AI 首节点分别返回具体校验错误 |
| A3 内置模板只读 | 对 isBuiltin 模板 update/delete 拒绝（「内置模板不允许修改/删除」） |
| A4 version 自增 | 每次 update version+1 |
| A5 复制快照与隔离 | configureWorkflow 深拷贝节点并记录来源版本；改模板不影响副本 |
| A6 缺 agentConfig 拒绝 | AI 节点无 agentConfig 时报缺失节点 |
| A7 capabilities 校验 | acpServerType 不在 controller 可用列表内拒绝（fake controller 应答 acp:check） |
| A8 禁止增删节点 | updateConfiguredWorkflow 增/删 nodeKey 均拒绝 |
| A9 活跃实例删除约束 | 存在未终结实例时 deleteConfiguredWorkflow 拒绝；无引用时可删除 |
| A10 实例化 | 首节点（HUMAN）READY，其余 INITIALIZING |
| A11 非 git 工作区拒绝 | requiresWorktree+initNewWorktree 但工作区无 defaultBranch 时实例化拒绝 |
| A12 completeHumanNode 接力 | 产物写黑板（{nodeId}-{name}-产物-{title}），下游 AI 节点 RUNNING 且 fake controller 收到 acp:start（含 agent-workflow-tools 装配与节点作用域 token） |
| A13 rejectNode 打回留痕 | 节点 REJECT + rejectInfo，黑板写入「打回-{nodeId}-{序号}」记录，上游 REWORK 且 reworkCount+1 |
| A14 sessions 排除工作流会话 | 默认不含工作流会话；includeWorkflowSessions=true 含（带 workflowInstanceId/workflowNodeId） |
| A15 getCurrentNodeId 作用域 | 节点 token 返回当前 nodeId；普通会话 token 返回 UNAUTHORIZED |
| A16 非 RUNNING 状态提示 | REJECT 状态调用 completeCurrentNode 返回 INVALID_STATE 可读提示 |
| A17 removeBlackboardKey | 移除后黑板无、blackboardTrash 有 |
| A18 权限隔离 | 他人 workflowInstance 查询为 null、列表为空、mutation 报「不存在或无权限」 |

### 工作流 GitHub PR 联动回调 (`agent-api/workflow-pr-callback.test.ts` T-PR*)

> 需要 agent-api + controller-api 就绪且配置 `EVENT_CALLBACK_TOKEN`（缺失时整套跳过）；`GITHUB_WEBHOOK_SECRET` 用于 HMAC 用例（未配置时跳过 HMAC 断言）。T-PR4~18 通过 fake controller 走 MCP relay 注册/驱动，独立用户与实例避免脏数据。

| 测试 | 描述 |
|------|------|
| T-PR1 回调鉴权 | 无凭据/错误 token → 401；`X-Event-Token` / `Authorization: Bearer` / 正确 HMAC → 200；错误 HMAC → 401 |
| T-PR2 载荷非法 | 缺 `eventId` / `eventType` 非 pull_request → 400 且 detail 可读 |
| T-PR3 未登记 PR | 返回 `handled=false` + `reason=NO_HANDLER` + 空 `results` |
| T-PR4 注册与透出 | fake controller 调 `linkPullRequest`（只传 `pullRequestId`）→ `pullRequestLinks` 含 nodeId/nodeName/prUrl；`getNodeInfo.workflowInstanceId` 正确 |
| T-PR5 工具错误 | `workflowId`/`nodeId` 与作用域不符、非法 PR 标识 → `INVALID_PARAMS`；归档实例 → `INVALID_STATE` |
| T-PR6 同节点换 PR | 旧关联消失、新关联出现（同节点只保留最新） |
| T-PR7 approved 驱动 | 人类节点 DONE；下游 AI 首条提示词含「Pull Request审核通过」、comment、PR 地址、审核人/时间；`github-pr-review` 落库 |
| T-PR8 rejected 驱动 | 人类节点 REJECT、上游 REWORK；返工消息含 A.3 全量文案与 inline comment 提示 |
| T-PR9 重复投递 | 同一 `eventId` 第二次返回 `DUPLICATE_EVENT`，节点状态不变 |
| T-PR10 当前 AI | 当前节点为 AI → `CURRENT_NODE_NOT_HUMAN`，状态不变 |
| T-PR11 中间 HUMAN | 登记 AI 与当前 HUMAN 之间隔一个 HUMAN → `HUMAN_NODE_IN_BETWEEN` |
| T-PR12 并行分支 | 多个 READY/RUNNING 人类节点 → `CURRENT_NODE_AMBIGUOUS` |
| T-PR13 归档/完成注销 | 归档后 `pullRequestLinks=[]`、事件 `NO_HANDLER`；工作流完成后关联注销、事件不再驱动 |
| T-PR14 github-pr 注入 | 未勾选无该段；勾选后出现且仅一次；全部取消后移除 |
| T-PR15 三层透传 | 模板/配置/实例/`updateWorkflowNode` 字段一致；AI 节点传 true 被拒 |
| T-PR16 READY 打回 | rejected 事件驱动 READY 人类节点打回（内部走 start→reject 路径） |
| T-PR17 多实例 | 同一 PR 关联两个实例 → `results` 两条且各自完成 |
| T-PR18 标识归一 | URL / `owner/repo#n` / `owner/repo/pull/n` 归一为同一关联 |

> MCP 工具调用：MCP 传递重构一期后 agent-api 公网 `POST /mcp/*` 入口已下线，平台 MCP 统一经控制器 relay。fake controller 在主 WebSocket 上发 `mcp:request`（`{requestId, sessionId, serverName, token, body}`，body 为 JSON-RPC `tools/call`），按 requestId 匹配 `mcp:response`（带超时与监听器清理，参考 workflow.test.ts 的 `callWorkflowTool`）；token 从 fake controller 收到的 `acp:start.mcpEndpoint.token` 获取。

### GitHub 原生 Webhook 入口 (`agent-api/github-webhook.test.ts` T-GHWH*)

> 需要 agent-api + controller-api 就绪且配置 `GITHUB_WEBHOOK_SECRET`（缺失时整套跳过；CI 下缺参且未 `SKIP_GITHUB_WEBHOOK=1` 即红）。端点 `POST /api/events/github/webhook` 仅接受 `X-Hub-Signature-256` 验签（平台 token 无效），仅处理 `pull_request_review`（action=submitted），归一化后复用 PR 联动判定链；eventId 取 `gh:pull_request_review:{review.id}`。

| 测试 | 描述 |
|------|------|
| T-GHWH1 鉴权 | 无签名/错误签名 401；`X-Event-Token` 无效；正确 HMAC 200 |
| T-GHWH2 忽略 | ping / 其他事件类型 / 非 submitted action → 200 `UNSUPPORTED_EVENT` |
| T-GHWH3 载荷非法 | 缺 review.state / 非法 full_name / 非 JSON → 400 带 detail |
| T-GHWH4 未登记 PR | 返回 `handled=false` + `reason=NO_HANDLER` |
| T-GHWH5 approved 驱动 | fake controller 关联 PR 后 approved → 人类节点 DONE，下游 AI 提示词含 A.2 文案 |
| T-GHWH6 rejected 驱动 | changes_requested → 人类节点 REJECT、上游 REWORK，返工消息含 A.3 文案 |
| T-GHWH7 重复投递 | 同一 review.id 第二次返回 `DUPLICATE_EVENT`，节点状态只变化一次 |

### 云电脑 GitHub Issues 联动 (`agent-api/cloud-host-issues-linkage.test.ts` T-GHIL* / `agent-api/github-issues-webhook.test.ts` T-GHI*)

> 配置套件需要 `CLOUD_HOST_CONTROLLER_ID`（RUNNING 云电脑）与 `CLOUD_HOST_WORKFLOW_ID`（含 HUMAN 的已配置工作流），标签同步相关用例另需 `GITHUB_TEST_REPO`（已绑定仓库）；缺失时相关用例跳过。Webhook 套件需要 `GITHUB_WEBHOOK_SECRET`（缺失整套跳过），全链路用例另需 `GITHUB_TEST_REPO` / `CLOUD_HOST_ISSUES_LABEL`。

| 测试 | 描述 |
|------|------|
| T-GHIL0 鉴权 | 未认证查询返回 `Not authenticated` |
| T-GHIL1 创建与列表 | 创建配置 → 列表含工作流名/标签/仓库；标签同步到仓库 |
| T-GHIL2 校验矩阵 | 非云电脑 → `cloud host not found`；非法标签 → `invalid label name`；空仓库 → `at least one repo is required`；未授权仓库 → `repo not authorized: <fullName>` |
| T-GHIL3 同步失败汇总 | **未实现**（需可令标签同步失败的真实仓库）：`label sync failed: <repo>` 且配置已保存、幂等重发不建重复行的语义由 `servers/agent-api/src/services/cloud-host-issues-linkage.test.ts`「部分仓库同步失败汇总报错（配置已保存）」「同标签同工作流同仓库重发视为幂等重试（不重复建行）」覆盖 |
| T-GHIL4/5 修改删除与清理 | 改名不同步删旧标签；删除后标签保留；`cleanupCloudHostIssuesLabels` 返回 `deleted/failed` 清单并删除配置行 |
| T-GHIL6 级联 | **未实现**（需先创建并可删除真实云电脑）：`deleteCloudHost` 后配置行清空的语义由 `servers/agent-api/src/services/cloud-host-service.test.ts`「soft deletes…」用例断言 `deleteByController(controllerId)` 覆盖 |
| T-GHI1 鉴权与载荷 | 错误 HMAC → 401；非法载荷 → 400 detail；不受理 action → `UNSUPPORTED_EVENT`（`T-GHI1a~d`） |
| T-GHI2 判定链 | 仓库未启用 → `REPO_NOT_ENABLED`；标签不中 → `NO_MATCHING_LINKAGE`；命中 → `CREATE_TRIGGER`（`T-GHI2a~c`） |
| T-GHI3 全链路 | **未实现**：需真实 Github 仓库（App 已订阅 issues、标签可写），当前环境无法黑盒落地；工作区准备→实例化→回评→首人类节点自动完成的语义由 `servers/agent-api/src/services/workflow/issues-event-handler.runner.test.ts` 单测覆盖 |
| T-GHI4 幂等 | 同 Issue 同标签重投 → `ALREADY_TRIGGERED`，实例数不变 |
| T-GHI5 多配置 | **未实现**：同 T-GHI3 的环境依赖；多配置各自独立触发的判定语义由 `issues-event-handler.flow.test.ts`「多配置各自独立触发一次」与唯一索引单测覆盖 |

### ACP Permission Reminder API (`agent-api/permission.test.ts`)

| 测试 | 描述 |
|------|------|
| getTodoList - 无 auth | 应返回「Not authenticated」 |
| getUnreadTodoCount - 无 auth | 应返回「Not authenticated」 |
| getTodoList - 初始为空 | 应返回空数组 |
| getUnreadTodoCount - 初始为 0 | 应返回 0 |
| respondPermission - 无 auth | 应返回「Not authenticated」 |
| markTodoRead - 无 auth | 应返回「Not authenticated」 |
| markAllTodoRead - 无 auth | 应返回「Not authenticated」 |
| updatePermissionTimeout - 无 auth | 应返回「Not authenticated」 |
| updateGlobalPermissionTimeout - 无 auth | 应返回「Not authenticated」 |
| 权限请求流程 - 创建待办 | controller 发送 acp:permission → agent-api 创建待办 → 验证待办内容 |
| 权限请求流程 - 响应请求 | GraphQL respondPermission → controller 收到 acp:permission:response |
| 权限请求流程 - 超时处理 | 60秒未响应 → controller 收到 cancelled |
| 待办管理 - 标记已读 | markTodoRead → 验证 isRead=true |
| 待办管理 - 全部已读 | markAllTodoRead → 验证 unreadCount=0 |
| 超时设置 - 全局设置 | updateGlobalPermissionTimeout → 验证保存成功 |
| 超时设置 - Session 设置 | updatePermissionTimeout → 验证 session.permissionTimeoutAction |

### ACP 能力快照 API (`agent-api/session-capabilities.test.ts`)

| 测试 | 描述 |
|------|------|
| T-AC1 快照落库与读取 | fake controller `acp:start:result.capabilities` → `session.agentCapabilities` 原文 + `features` 20 项 |
| T-AC2 resume 更新快照 | close → resume 上报新 `agentInfo.version` → 会话快照更新、不残留旧值 |
| T-AC3 旧 controller 零退化 | 不带 `capabilities` → `agentCapabilities=null`、`features=[]`、其余字段不变 |
| T-AC4 features 抽样 | `session.load=supported`、`prompt.audio=unsupported`、`elicitation.form=supported` |
| T-AC5 模型来源分组 | 必须注入 `MONGODB_URI`（缺失即失败）：直写平台库（global/user）+ fake 上报 4 个模型 → 四组与 basis |
| T-AC6 问询 resolved(timeout) | fake controller 发 `acp:elicitation:resolved{reason:'timeout'}` → todo `resolution=expired`、`resolvedAt` 非空 |
| T-AC7 问询响应 | `respondElicitation(decline)` → controller 收到 decline、todo `resolution=declined` |
| T-AC11 初始配置失败 SSE 透传 | fake controller 发 `acp:initial-config:result{modelStatus:'failed'}` → SSE `status` 事件携带 `initialConfigError`（modelId/error/at） |
| T-AC12 初始配置落库与清除 | 需 `MONGODB_URI`（缺省 skip）：failed → Session 文档写 `initialConfigError`；全部 applied → `$unset` 清除 |
| T-AC13 初始配置非法 payload | 需 `MONGODB_URI`（缺省 skip）：缺 `sessionId` / status 越界被丢弃，Session 文档既有 `initialConfigError` 无变化 |

> `acp-real-capabilities.test.ts` 属 `test:real` 套件：真实 OpenCode 建会话后校验 `raw.agentCapabilities.sessionCapabilities` 与 `features` 状态（需要本机安装 OpenCode）。

### Admin Auth API (`admin-api/auth.test.ts`)

| 测试 | 描述 |
|------|------|
| 归一化管理员登录态 | ensureAdminLogin → adminMe username=admin、mustChangePassword=false |
| adminMe 无 token | 返回 null（不报错） |
| 伪造/user 侧 token | 返回 null（admin/user token 不可互认，T-A6） |
| 密码错误登录 | 返回「Invalid username or password」（T-A3） |
| 归一化密码登录 | 返回 token，mustChangePassword=false |
| 新密码过短 | 拒绝（T-A5） |
| 旧密码错误 | 拒绝 |
| 改密流程 | 改密成功、旧密码失效、新密码可登录、返回新 token（T-A4） |
| 无注册 mutation | introspection 无 signup/register，含 adminlogin |
| 业务 mutation 无 token | 「Not authenticated」 |

### Admin 租户与开户 API (`admin-api/tenant.test.ts` T-AT-API*)

> `contracts/admin-tenant.graphql`：租户/用户为只读镜像，`adminCreateFrontUser` 为唯一写操作
> （admin-api 转发 agent-api `POST /internal/users`）。需要 admin-api + agent-api 就绪、
> `INTERNAL_API_TOKEN`（上游开户 Bearer）与 `AGENT_API_URL`。

| 测试 | 描述 |
|------|------|
| T-AT-API1 未鉴权 | adminTenants / adminTenant / adminCreateFrontUser 均「Not authenticated」 |
| T-AT-API2 只读性 | introspection：租户相关写操作仅 adminCreateFrontUser，无 update/delete/disable mutation |
| T-AT-API3 开户闭环 | 开户 → `adminTenants(keyword)` 命中同名 personal（memberCount=1、balance=0）→ 新账户 `login` 的 tenant 与之一致 |
| T-AT-API4 详情成员 | `adminTenant(id)` 的 users 关联 `username`（取自其 account）与 name |
| T-AT-API5 检索分页 | `keyword` 过滤 + `page/pageSize` 生效（两页各 1 条且不重复） |
| T-AT-API6 重名 | 幂等返回既有三件套视图（或 409 `USERNAME_TAKEN`）；同名租户仅 1 条 |
| T-AT-API7 非法参数/未知 id | 用户名 2-20、密码 ≥6 逐字错误；未知/非法 id 的 `adminTenant` 返回 null |

### Admin Global LLM API (`admin-api/llm.test.ts`)

| 测试 | 描述 |
|------|------|
| adminProviders 无 auth | 「Not authenticated」 |
| 业务 mutation 无 auth | 「Not authenticated」 |
| 连通性失败不落库 | T-P1 |
| 创建全局供应商 | scope=global、凭据脱敏、**不自动导入模型**（T-P2） |
| 更新供应商不重同步 | 改 endpoint 后模型不增不减（T-P2b） |
| 手动导入链路 | 拉取清单 / 勾选导入 / 已导入标记 / 幂等返回 [] / 跨供应商重名拒绝（T-MI4）/ 上游不可用连通性文案且不写库（T-MI5） / 空名拒绝（T-MI6） |
| 删除后重新导入 | 删除导入模型同名可重新导入（T-MD1）；自定义模型重名拒绝（T-MU1） |
| 并发重名兜底 | 两供应商并发导入同名恰一成功一失败，库内仅 1 条（T-MU2） |
| 重名整理台账 | 条目与实际改名一一对应、字段完整（T-MR1，需库内已有迁移 005 台账；全新库的空集由迁移单测 T-MIG33/T-MIG34 锁定）；删除被改名模型后台账仍可查（T-MR2）；均需 MONGODB_URI |
| 全局同名冲突 | 「Provider name already exists」（T-P7） |
| 更新留空保留凭据 | T-P3 |
| 启停级联 + 删除级联 | T-P5 / T-P4 |
| 批量操作空列表 | successCount=0 |
| 全局模型管理 | 自定义模型添加/列表；任意全局模型可删；禁用供应商下 toggle 拒绝；全局模型名唯一（T-M1~T-M3） |
| 全局模型排序 | T-M4 |

### Admin Base Image API (`admin-api/base-image.test.ts`)

| 测试 | 描述 |
|------|------|
| 无 auth | baseImages / createBaseImage 均「Not authenticated」 |
| CRUD | Dockerfile 原样存取（T-B1） |
| 同名冲突 | 「Base image name already exists」（T-B2） |

### Agent API 自动同步回归 (`agent-api/llm.test.ts` T-SYNC*)

> 用户侧 `syncSyncedModels` 行为保持不变（本期零改动）：创建/更新用户供应商仍自动同步模型；后台仅在 admin-api 取消自动导入。

| 测试 | 描述 |
|------|------|
| T-SYNC1 | 创建用户供应商仍返回同步模型 |
| T-SYNC2 | 更新用户供应商（改 endpoint）后模型按新上游清单重同步（新增 synced-*、清理 gpt-4o 等旧模型），锁定 syncSyncedModels 行为 |
| T-UP1 | 更新用户供应商 credentialValue 留空时保留原凭据（不覆盖、不重置） |

### Agent API scope 回归 (`agent-api/llm.test.ts` T-SC*)

| 测试 | 描述 |
|------|------|
| 全局启用模型对用户可见 | models 查询包含 scope=global 且启用模型（T-SC1） |
| 全局供应商不在用户 providers | T-SC5 |
| 跨 scope 同名可并存 | 用户模型与全局模型可同名并存（T-SC7，验证 partial unique index 不误伤 user scope）；用户供应商与全局供应商也可同名 |
| 用户写全局模型/供应商 | 返回「全局配置请在管理后台修改」（T-SC3/T-SC4） |
| 管理员禁用全局供应商后 | 用户 models 不再返回（T-SC1 反向） |

### Cloud Controller 内部 API (`cloud-controller/internal-api.test.ts` T-IC*)

> 需要 cloud-controller 就绪：`aspire start && aspire wait cloud-controller`；服务以 `K8S_ENABLED=false`（InMemoryK8sClient）运行。
> `T-IC5`（合法 workloadIds 回显）、`T-IC6`（按执行顺序返回日志 + params/required）与 `T-ICC1~T-ICC8`（`workloadPlan` 校验/落库/兜底展开/失败映射/required 归一）直写共享 Mongo，需要 `MONGODB_URI`（缺省时 `skipIf` 跳过）。

| 测试 | 描述 |
|------|------|
| T-IC2 鉴权 | 缺失/错误 Bearer 返回 401 |
| T-IC3 非 idle | POST `{purpose: workflow}` 返回 400「该任务类型暂未开放」 |
| T-IC1 全生命周期 | GET 列表 / POST idle（201，`workloadIds: []`、`currentWorkloadName: null`）/ DELETE（200）符合契约附录 A |
| T-IC4 幂等 | DELETE 不存在返回 404；终态容器重复 DELETE 返回 200 |
| T-IC5 workloadIds 校验 | 非数组 / 未知 ID / 超 10 个 → 400 `INVALID_WORKLOAD`；合法已存在 ID → 201 且去重保序回显 |
| T-IC6 工作负载日志 | `GET /internal/containers/:id/workload-logs`：未知容器 404 `NOT_FOUND`；无记录返回 `[]`；直写 Mongo 后按 `createdAt` 升序返回 A.6 字段（含 `required`，历史缺省 `false`） |
| T-IC7 鉴权回归 | 新增 logs 端点缺失 Bearer → 401 |
| T-ICC1 workloadPlan 合法 | POST 携带 `workloadPlan`（含 `required`）→ 201，JSON 回显 `workloadPlan`，`workloadIds` 由 plan 派生 |
| T-ICC2 workloadPlan 非法 | 非数组 / 超 10 条 / 未知 `workloadId` / `params` 非对象 / `implicit` 非布尔 / `required` 非布尔 / 条目非对象 / `workloadId` 缺失或重复 → 400 `INVALID_WORKLOAD` |
| T-ICC3 仅 workloadIds 兜底展开 | 旧客户端仅传 `workloadIds` → 按只读定义后序 DFS 展开（依赖先于依赖方、`implicit=true`、参数取默认值且多选去重、`required=false`）；容器 `workloadIds` 按选择顺序落库（不含隐式依赖），plan 仅用于执行 |
| T-ICC4 plan 优先 | `workloadPlan` 与 `workloadIds` 同时下发 → 以 plan 派生的 `workloadIds` 为准 |
| T-ICC5 plan 条目缺省归一 | `workloadPlan` 条目缺省 `params`/`implicit`/`required` → 归一为 `{}`/`false`/`false`（201，不报错） |
| T-ICC6 兜底展开失败映射 | 仅 `workloadIds` 且展开遇环 / 依赖缺失 / 展开 > 10 → 400 `INVALID_WORKLOAD` |
| T-ICC7 required 归一与校验 | `required` 缺省/`null` → `false`、`true` 保留并回读；非布尔 → 400 `INVALID_WORKLOAD` |
| T-ICC8 兜底 required=false | 仅 `workloadIds` 兜底展开的 plan 条目 `required` 一律 `false` |
| T-IC-HARNESS | `harnessTypes:['kimi_code']` → 201 且回显；`['kimi_code','bogus']` → 400 `INVALID_HARNESS`；落库 `agentGearMinVersion` 按类型取最大（全局基线 2.10.0；kimi/deepseek/opencode 组合均为 2.10.0，需 `MONGODB_URI`） |
| T-IC-HARNESS3 tenantId | harness 创建落库 `cloudcontainers.tenantId`：显式下发=userId；缺省回退=userId（旧版调用方兼容）；显式空串 → 400 `INVALID_HARNESS`（需 `MONGODB_URI`） |
| T-IC6 日志 params | 直写 `cloudworkloadlogs.params`/`required` 后按记录返回参数快照与必须标记；历史无 `params` 归一为 `{}`、无 `required` 归一为 `false` |

### Admin Cloud Workload API (`admin-api/cloud-workload.test.ts` T-IA*)

> 需要 admin-api + cloud-controller 就绪：`aspire start && aspire wait admin-api cloud-controller`。
> 日志用例直写共享 Mongo，需要 `MONGODB_URI`（缺省时 `skipIf` 跳过）；控制面不可达的降级分支由 admin-api 单测 `graphql/resolvers/cloud-workload.test.ts` 锚定。

| 测试 | 描述 |
|------|------|
| T-IA 未认证 | 匿名 list/create/update/delete/logs 均「Not authenticated」 |
| T-IA CRUD | 仅 init / 仅 post / 两者创建；列表；编辑（`initScript: null` 清空）；删除；DTO 时间 ISO |
| T-IA 校验边界 | 空名 → `name is required`；超 64 字 → `name must be at most 64 characters`；双空脚本 → `at least one script is required`；脚本 >16 KiB → `initScript/postScript must be at most 16 KiB`；**接受侧**：恰好 64 字符名称 + 恰好 16 KiB 脚本可创建（防 `<`/`≤` 回归） |
| T-IA 重名/不存在 | 创建/改名重名 → `Workload name already exists`；更新不存在 id → `Workload not found`；删除不存在 id → `false` |
| T-IA 日志（控制面可用） | 无记录返回 `[]`；直写 `cloudworkloadlogs` 后按执行顺序返回大写枚举 + 脚本快照 + 输出 |
| T-IA 启动携带 workloadIds | 合法 ID 按选择顺序返回 `workloads`；未知 ID → 错误含 `INVALID_WORKLOAD`；缺省不挂载（`workloads: []`） |
| T-IA paramSchema CRUD | 四种类型（SELECT/MULTI_SELECT/TEXT/BOOLEAN）保存与回显；非下拉类型 `options` 归一为 `[]`；编辑改默认值；`paramSchema: []` 清空（空表单无配置） |
| T-IA paramSchema 校验边界 | key 非法/重复、label 空/超长、options 空/重复/超限、默认值不在 options/类型不符 → 字段路径错误（`paramSchema[i].xxx is invalid`）；参数 >20 → `too many parameters` |
| T-IA 依赖保存 | 正常（按配置顺序、去重）、自依赖 `workload cannot depend on itself`、依赖环 `dependency cycle detected`、依赖不存在 `dependency workload not found`、超 5 `too many dependencies` |
| T-IA 预制项存在性与幂等 | Docker/Node.js/.NET/Aspire/OpenCode（Harness）/Kimi Code（Harness）/Github 共 7 项存在且 `isPreset=true`；Kimi Code `workloadKind=HARNESS`/`harnessType=kimi_code`、`paramSchema=[]`、init 脚本固定 2.3.2 且不含 `harness prepare`；Aspire 依赖 `[Docker, .NET]`；Node.js 参数（`version` TEXT 默认 `22`、`package_manager` MULTI_SELECT 默认 `["npm"]`）；重复查询 ID 集合稳定（迁移不重复写入） |
| T-IA 预制 Aspire 代理下载 | 预制「Aspire」`paramSchema` 含 `aspire_cli_url`（TEXT 默认 = 内网缓存代理安装包直链 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`）；`initScript` 含 `curl -fsSL`/`tar -xzf` 直连下载解压，**不含** `install.sh`/`aspire.dev`/`aka.ms`/`ASPIRE_INSTALL_URL`（迁移 004 升级结果，脚本内不内置默认地址）；重复查询预制项 ID 集合稳定 |
| T-IA 日志 params | 直写 `cloudworkloadlogs.params` 后按执行顺序返回参数快照；历史无 `params` 归一为 `{}` |

### Cloud Controller Worker 握手 (`cloud-controller/worker-handshake.test.ts` T-IW*)

| 测试 | 描述 |
|------|------|
| T-IW1 缺失 token | 连接 `/worker` 无 token → `connect_error`（INVALID_TOKEN） |
| T-IW1 伪造 token | 携带伪 token → `connect_error`（INVALID_TOKEN） |

> 合法 token 的完整握手/注册/销毁由 cloud-controller 单测（真实 socket.io-client）与部署侧真实集群验收覆盖（合法 token 仅在进程内签发，外部不可取得）。

### Admin 云端容器 API (`admin-api/cloud-container.test.ts` T-IA*)

| 测试 | 描述 |
|------|------|
| T-IA5 未认证 | 匿名 list/start/destroy 均返回「Not authenticated」 |
| T-IA1 列表 | `adminCloudContainers` 经控制面代理返回数组 |
| T-IA6 非 idle | `adminStartCloudContainer(WORKFLOW)` 返回「该任务类型暂未开放」 |
| T-IA3/T-IA4 启停 | start idle → 列表可见 → destroy 返回 true 且状态收敛为 EXITED |
| T-IA7 workloadIds | start 携带 `workloadIds` → `workloads` 按提交顺序返回；列表同样返回 `workloads`/`currentWorkloadName` |
| T-IA8 未知 workloadId | start 携带不存在 ID → 错误含 `INVALID_WORKLOAD` |
| T-IA9 缺省不挂载 | start 不传 `workloadIds` → `workloads: []`、`currentWorkloadName: null` |
| T-IA10 隐式依赖展开 | 仅选依赖方 → `workloads` 依赖在前（后序 DFS）；落库 `workloadPlan` 隐式项取默认参数（`implicit=true`）、`workloadIds` 由 plan 派生 |
| T-IA11 显式参数优先 | 同时显式选择依赖与依赖方 → 依赖只出现一次且使用显式参数（`implicit=false`） |
| T-IA12 展开超限 | 链式依赖展开为 11 条 → 错误 `expanded workloads exceed 10` |
| T-IA13 非法参数 | 未知参数 → `unknown parameter: <key>`；类型/取值非法 → `invalid value for parameter <key>` |
| T-IA14 重复选择 | 同一 `workloadId` 重复 → `duplicate workload selection` |
| T-IA15 二选一 | `workloadIds` 与 `workloads` 同时非空 → `workloadIds and workloads cannot both be provided` |
| T-IA16 未知显式选择 | `workloads` 含不存在 ID → `workload not found` |
| T-IA17 依赖被删 | 依赖在配置后被删除 → 启动报 `dependency workload not found` |
| T-IA18 日志 params | 直写 `cloudworkloadlogs.params` 后经 `adminCloudContainerWorkloadLogs` 返回参数快照 |
| T-IA 预制 .NET apt | 预制 `.NET` 的 `initScript` 为 apt 版（含 `apt-get install`/`dotnet10`，不含 `dotnet-install.sh`；迁移 002 升级结果） |
| T-IA 日志 required | 直写 `cloudworkloadlogs.required` 后经 `adminCloudContainerWorkloadLogs` 返回必须标记；历史缺省 `false` |
| T-IA-REQ 启动 required 透传 | `adminStartCloudContainer(workloads[].required)` 透传并落库（缺省 `false`、非布尔容错）；仅 `workloadIds` 兼容路径 `required` 一律 `false` |

### Billing 计费 API（费用中心）

> 计费事件骨干经 RabbitMQ；`billing-events` 直断言 `billingoutbox`，需要 `CLOUD_CONTROLLER_INTERNAL_TOKEN` 与 `MONGODB_URI`（缺任一即失败，不再 `skipIf`）。
> 网关/前台计费套件需要 admin-api / agent-api / cloud-controller 就绪：`aspire start && aspire wait admin-api agent-api cloud-controller`。

#### Cloud Controller 计费事件 (`cloud-controller/billing-events.test.ts` T-CC-B*)

| 测试 | 描述 |
|------|------|
| T-CC-B4/B8 | 创建容器携带 `billingAccountId`，列表/详情 A.3 计费字段透出 |
| T-CC-B7 | DELETE 带 `reason` 写入 `exitReason` |
| T-CC-B11 | 已计费容器销毁后 `billingoutbox` 落一条 `container.destroyed`（需 `MONGODB_URI`） |

#### Admin 计费网关 (`admin-api/billing-gateway.test.ts` T-B2*)

| 测试 | 描述 |
|------|------|
| T-B21 | GET `/v1/models` 返回 OpenAI list 信封（形状） |
| T-B29 | 无效 Key 401 `invalid_api_key` |
| T-B26 | 缺参数 400、未知模型 404 |
| T-B27 | GET `/v1/models` 仅返回**计费且定价完整**的全局模型（过滤逻辑被断言，需 `MONGODB_URI` 直写模型） |
| T-B28 | 未定价（`pricing:null` 与全 0 档）模型 400 `model_not_priced`（需 `MONGODB_URI`） |
| T-B24 | 冻结账户调用非计费模型同样 402 `account_frozen` |

#### Admin 计费 GraphQL+内部 REST (`admin-api/billing.test.ts` T-B*)

| 测试 | 描述 |
|------|------|
| T-B* | 账户/账单/收据/充值/ApiKey 全链路与鉴权、幂等、错误映射 |
| T-B32 tenant owner | 开户即建零余额 tenant 账户；`adminBillingAccounts(ownerType: tenant)` 可检索；充值 10 credits 到账（invoice/receipt） |
| T-B33 admin_user 回归 | admin_user 账户查询/充值照旧，与 tenant 账户余额互不影响（双 owner 并存） |
| T-B34 front_user 兼容 | 读：`GET /internal/billing/account?ownerType=front_user` 解析到同 ownerId 的 tenant 行；写：`POST /internal/billing/api-keys` 携带 front_user → 201 且落库 `ownerType=tenant`（兼容归一，不产生 front_user 新行） |

### 前台云电脑（harness）

| 文件 | 说明 |
|------|------|
| `tests/api/src/admin-api/cloud-host-charges.test.ts` | 内部一次性扣费/退款/报价：401、扣费 5 credits 与账单/收据、余额不足 409 `INSUFFICIENT_BALANCE`（带 `available`）、退款幂等、`price-quote` 5/1（需 `INTERNAL_API_TOKEN` + `MONGODB_URI`） |
| `tests/api/src/agent-api/cloud-host-billing-quote.test.ts` | `cloudHostBillingQuote` 转发价目（创建 5 credits / 运行 1 credit/分钟；需 `ADMIN_API_URL`） |
| `tests/api/src/agent-api/cloud-host.test.ts` | `cloudHostCapabilities`（`HARNESS_ENABLED=true` 才运行）、创建/校验/多台并行/属主隔离/停止/删除/软删除/`Controller.cloudHost`/鉴权；KIMI_CODE 多选创建与逐容器 `agentGearMinVersion=2.10.0` |
| `tests/api/src/agent-api/cloud-host-callback.test.ts` | 内部 ready（单 harness 默认会话、多 harness 不建、幂等）、terminal（会话 ENDED/幂等、未 ready 自动退款留痕、已 ready 不退）、鉴权/404（需 `INTERNAL_API_TOKEN` + `MONGODB_URI`） |
| `tests/api/src/agent-api/session-readonly.test.ts` | 停止后 resume 返回 `session is ended`；非 RUNNING 云电脑 createSession 拒绝（需 `MONGODB_URI`） |
| `tests/api/src/agent-api/harness-login.test.ts` | Kimi Code 登录引导（fake controller 注入 `harness:login:required/succeeded/failed`）：todo 创建/链接与验证码逐字、`succeeded→accepted`、取消下发 + `cancelled`、重复 required 单条、`timeout→expired` 后可重试、归属隔离、无 auth、用户级 SSE（`?token=`）、`KIMI_CODE` 创建落库 `agentGearMinVersion=2.10.0`（需 `HARNESS_ENABLED=true` + `MONGODB_URI`；能力列表断言需 preset 009 已迁移） |

> `K8S_ENABLED=false` 下无法产生真实 RUNNING 容器；在线、OpenCode ACP、真实默认会话链路由单测 + 真实集群手工验收覆盖，不引入测试后门。

#### Agent 前台计费 (`agent-api/billing.test.ts` T-MB*)

| 测试 | 描述 |
|------|------|
| T-MB* | 我的费用：账户派生自登录主体、账单/收据/调用记录/汇总、API Key 管理 |


## 云主机工作负载 / Github 设置

- `src/agent-api/cloud-host-workload.test.ts`：需要 `MONGODB_URI` + `HARNESS_ENABLED=true`，直插 `controllers/controllerworkspaces/cloudhosts` 造一个在线云主机，覆盖 `cloudHostWorkloads` 归属校验、`cloudHostWorkloadCatalog`（鉴权 + standard 列表 + `installed=false`）、Github 帐号锁定（T-GH-API-L1 首绑落库 / L2 异帐号拒绝 `github account is locked` / L3 同帐号换仓库放行）与 Github setup 输入校验（前缀相对路径/`..`/仓库格式与 `~` 展开矩阵：`~/workspace`/`~`/`~//a` 接受并归一、`~abc` 以「前缀地址必须以 / 或 ~ 开头」拒绝、`~/a/../b` 拒绝，T-GH-API-P1~P4）；不调用真实 GitHub。
- `src/agent-api/cloud-host.test.ts`：新增创建期 `workloadIds` 用例（T-CH-API-W2/W3/W4：Docker 可创建、超 5 个 → `too many workloads (max 5)`、不存在 ID → `invalid workload`、harness ID → `workload is not installable`）；不传 `workloadIds` 的历史路径由既有创建用例覆盖。
- `src/admin-api/cloud-workload.test.ts`：`adminCloudWorkloads` 断言 `workloadKind`/`harnessType`（standard → `STANDARD`/null，harness → `HARNESS`/`opencode`，T-ADM-WL-API1）。
- 真实 token 签发由 `servers/agent-api/src/services/github.test.ts`（mock fetch）覆盖；凭据接口鉴权/归属/无绑定/状态由 `routes/internal-cloud-host.test.ts` 覆盖。
