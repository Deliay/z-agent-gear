---
description: 多租户二期实现计划 v1.2（v1.1 评审返工：增加租户成员管理与角色体系）：契约先行（workspace 新增含 TenantRole/租户成员管理、admin-tenant team 开通与成员管理含角色、llm/github/cloud-host/workflow 补工作区维度、cloud-controller-websocket 附录 A +workspaceId）；agent-api tenantmembers（含 role）/workspaces/workspacemembers 三集合与迁移 015（全局工作区→成员回填 personal 恒 admin→11 集合 backfill→providers/models 按租户复制（计数门禁）→user_commit_settings 键改与索引切换）；x-workspace-id 工作区上下文（AsyncLocalStorage + 角色感知 workspace-scope 插件，global+developer 写拦截）与工作区 CRUD/成员管理（仅 admin）+ 租户成员管理（searchAccounts/增删/角色变更，last-admin 保护）；11 集合可见性切工作区+角色判定（共享型资源读=本工作区∪全局、Commit 设置三段继承）；计费 owner=workspace.tenantId；/internal/tenants 内部端点；admin-api 只读镜像与转发；cloud-controller cloudcontainers +workspaceId 迁移 002；agent-web 工作区切换器/管理页/租户成员管理页/来源徽标；admin-web team 租户管理；T-WS 角色两档隔离矩阵与回归收口；v1.2 计划期补强：新开户租户运行时初始化（`/internal/users` 补全局工作区 + admin 成员行）、providers/models 无 `scope` 存量行同口径复制、成员/角色变更审计留痕、失效当前工作区前端回退
type: Permanent
---

# 多租户二期（Team 租户与租户内工作区共享） - 实现计划

**关联 Proposal**: `docs/engineering/proposals/20261028-feat-multi-tenant-phase2.md`（v1.1，随需求总 PR #339 提交，review 审核通过）
**关联 PRD**: `docs/product/draft/20261028-multi-tenant-phase2.md`（v1.1）
**需求总分支（feat-branch）**: `feat/multi-tenant-phase2`（基于 `origin/main`，需求总 PR #339）
**计划提交分支**: `feat/multi-tenant-phase2`（本文件随需求总分支提交）
**创建日期**: 2026-10-28
**计划版本**: v1.2

**版本说明**：

- v1.3（2026-10-29，实现期事实校正）F12-F14：① 租户工作区 mutation 加 `Tenant` 前缀（`createWorkspace/deleteWorkspace` 已被项目工作区 ControllerWorkspace 占用）；② `cloudhosts` 已有 `workspaceId`（项目工作区语义），租户工作区维度改用 `resourceWorkspaceId`（与 F1 同型），契约 `CloudHost.workspaceId` 由 resolver 映射；③ controller-api 控制器注册从 `controllerkeys` 继承 `tenantId/workspaceId`（最小改动，实现点 4 落地必需）。其余口径不变。
- v1.2（2026-10-28，计划期补强；PRD/提案仍为 v1.1，不改变需求与架构口径）补齐实现落点：① 新增 `POST /internal/users` 新开户运行时初始化——补「全局工作区 + `tenantmembers{role:'admin'}`」，保证「每个新建租户创建时自动拥有全局工作区」（PRD 功能点 3）；② providers/models 复制范围与 `USER_SCOPE_FILTER` / `AVAILABLE_MODELS_FILTER` 对齐——**`scope` 缺失的存量行视同 user 域参与复制**，避免迁移后孤儿行；③ 成员/角色变更补结构化审计留痕（PRD §4.2）；④ agent-web 当前工作区失效（被移出团队/工作区已删除）自动回退个人全局并清理持久化；⑤ 同步 T-PROV 测试矩阵、验收 checklist、风险与附录（v1.1 及以前内容除上述补强外不变）。
- v1.1（2026-10-28，评审返工）按 PR #339 评审意见「增加租户成员管理和角色」（管理员/开发）随 PRD/提案 v1.1 重排：① `tenantmembers` 增 `role`（admin/developer，personal 恒 admin）与 **last-admin 保护**；② 新增租户成员管理契约与服务（`searchAccounts`/`addTenantMember`/`removeTenantMember`/`changeTenantMemberRole`/`myTenants` + `tenant-member-service`，仅 admin）；③ 权限模型由 v1.0 的「工作区成员平权 + 0 成员认领」改为**角色判定**——admin 管理租户全部资源、全部工作区可见可管、可建工作区、可变更成员角色，developer 仅读写删除所在普通工作区资源、对全局工作区只读（`context.workspaceAccess.readOnly` 一次判定 + workspace-scope 插件统一写拦截 `global workspace is read-only`），**移除 v1.0 的 0 成员认领机制**（0 成员工作区由 admin 直管，提案决策 D7）；④ 契约（错误口径白名单 7→15 条）/迁移 015（personal 回填 role=admin）/内部端点（role 入参、`LAST_ADMIN` 409）/admin-api 转发/前端（租户成员管理页、切换器按角色过滤、全局上下文只读收敛）/测试矩阵（T-WS 扩角色两档、新增 T-TM 系列）全链路补角色口径；⑤ §3.1 事实校正 F1-F11 与附录 B 核对记录沿用 v1.0（与角色体系无冲突，B.13 补记）。
- v1.0（2026-10-28）首版。对应 PRD v1.0 / 提案 v1.0（审核通过、无附加修改意见）。§3 计划期裁决以**当前需求总分支代码事实**为准（2026-10-28，88d104f1）：重点校正 ① `workflowinstances.workspaceId`（=ControllerWorkspace 项目工作区）与提案新增租户工作区维度 `workspaceId` 直接冲突（F1，工作流域改用 `resourceWorkspaceId`）；② 提案 §1.3 contracts 范围漏列 `contracts/cloud-controller-websocket.md` 附录 A（F2，与一期 F8 同型）；③ providers/models 现状**无 userId/tenantId**（仅 `scope` 区分）且 `providers.{scope,name}` 唯一索引与「先建后删」复制顺序冲突（F3）；④ `user_commit_settings` 存在**三处唯一索引声明**，键改 workspaceId 的切换口径（F4）；⑤ 计费调用面现状不一致（`cloud-host-service` 传 `userId`、`resolvers/billing.ts` 传 `user.tenantId`，F5）；⑥ tenantmembers/workspaces/workspacemembers **不可挂** tenant-scope/workspace-scope 插件（F6）；⑦ workspace-scope 插件需请求级上下文载体 AsyncLocalStorage（F7）；⑧ githubaccounts/user_commit_settings 为 String 口径（F8）；⑨ workflowtemplates 内置行可见性特例（F9）；⑩ admin-api 只读镜像同步声明 `providers.{scope,name}` 唯一索引，须与 agent-api 索引切换同发布（F10）；⑪ MCP 工具与 homeOverview 的工作区口径落点（F11）。

## 1. 实现顺序

```mermaid
flowchart TD
    P1["Phase 1 契约变更<br/>workspace.graphql 新增<br/>admin-tenant/llm/github/cloud-host/workflow 变更<br/>cloud-controller-websocket 附录A +workspaceId"] --> P2
    P1 --> P8
    P2["Phase 2 agent-api 三集合模型与迁移 015<br/>tenantmembers（含 role）/workspaces/workspacemembers<br/>全局工作区+成员回填（personal 恒 admin）+11 集合 backfill<br/>providers/models 按租户复制+user_commit_settings 键改"] --> P3
    P2 --> P4
    P3["Phase 3 agent-api 工作区上下文与工作区服务<br/>x-workspace-id 解析（角色/只读判定，AsyncLocalStorage）<br/>workspace-scope 插件 + workspace-service（仅 admin 写）<br/>workspace GraphQL（CRUD/成员管理）+ tenant-member-service<br/>（searchAccounts/租户成员增删/角色变更，last-admin 保护）"] --> P4
    P4["Phase 4 agent-api 11 集合工作区化与共享/继承口径<br/>可见性切工作区成员判定（T-WS 矩阵）<br/>providers/models/githubaccounts 共享读<br/>Commit 三段继承 + 计费 owner 切换<br/>controller/session workspaceId 继承链"] --> P5
    P5["Phase 5 agent-api 内部端点与聚合口径<br/>POST /internal/tenants + members<br/>/internal/users 开户补全局工作区+admin 成员<br/>homeOverview 工作区过滤<br/>MCP 工具（sessionId→会话工作区）"] --> P7
    P1 --> P6
    P5 --> P6
    P6["Phase 6 admin-api 只读镜像与 team 转发<br/>tenantmembers（含 role）/workspaces/workspacemembers 镜像<br/>adminCreateTeamTenant/adminAdd|RemoveTenantMember（含角色）<br/>adminTenantDetail 经 tenantmembers + 工作区只读视图"] --> P10
    P1 --> P7
    P4 --> P7
    P7["Phase 7 cloud-controller cloudcontainers +workspaceId<br/>迁移 002 回填 + parseHarnessRequest 下发<br/>agent-api 镜像/StartHarnessInput 同步"] --> P10
    P3 --> P8
    P4 --> P8
    P8["Phase 8 agent-web 工作区切换器与上下文<br/>x-workspace-id Apollo Link 注入（按角色过滤切换器）<br/>工作区管理页 + 租户成员管理页（仅 admin）<br/>设置页来源徽标 + 全局上下文只读收敛"] --> P10
    P6 --> P9
    P9["Phase 9 admin-web team 租户管理<br/>类型列 + 创建团队租户<br/>成员添加（指定角色）/移除 + 工作区只读列表"] --> P10
    P10["Phase 10 测试收口与回归<br/>T-WS/T-MIG15/T-TT 系列 + tests/api + tests/e2e<br/>缺省上下文兼容回归 + AGENTS.md 索引收口"]
```

依赖说明：

- **Phase 1 契约**是全部实现的唯一裁决面，独立提交（`docs(contracts): ...`）；契约未合入前不开始实现 Phase。
- **Phase 2（模型与迁移 015）**只依赖契约，是数据层地基；**Phase 3（上下文与工作区服务）**依赖 Phase 2 的三集合模型与全局工作区数据；**Phase 4（11 集合工作区化）**依赖 Phase 3 的 workspace-scope 插件与 `AuthContext.workspace`，工作量最大，可按集合族拆并行子分支。
- **Phase 5（内部端点/新开户初始化/聚合/工具口径）**依赖 Phase 4（会话/工作流的工作区字段就位）与 Phase 3（`ensureGlobalWorkspace`）；**Phase 6（admin-api）**与 Phase 4/5 并行（不同服务），联调依赖 Phase 5 的 `/internal/tenants*`。
- **Phase 7（cloud-controller）**依赖 Phase 1（附录 A）与 Phase 4 的 `startHarness` 下发对齐；与 Phase 5/6 并行。
- **Phase 8（agent-web）**依赖 Phase 1 契约与 Phase 3（`myWorkspaces`/切换器）+ Phase 4（资源随工作区过滤）；**Phase 9（admin-web）**依赖 Phase 6。
- **Phase 10** 在各实现合并回主实现分支后收口；迁移 015/002 的 `.test.ts` 随 Phase 2/7 同提交（TDD 红-绿-重构），不推迟到收口。
- 发布顺序约束（提案 §9.1）：**admin-api（镜像先行，F10 索引声明同步）→ agent-api（迁移 015）→ cloud-controller（迁移 002）→ 前端**。

### 1.1 开发分支与合并顺序

| 分支 | 范围 | 基于 | 合并目标 |
|------|------|------|---------|
| `feat/multi-tenant-phase2` | PRD / 提案 / 本计划（需求总分支） | `origin/main` | 需求总 PR #339 |
| `feat/multi-tenant-phase2-impl` | 契约 + 全部实现 + 测试（主实现分支） | 需求总分支 | 需求总分支（评审通过后随需求总 PR 入 main） |
| `impl/mt2-<子项目>`（可选） | 单 Phase 并行开发分支 | `feat/multi-tenant-phase2-impl` | `feat/multi-tenant-phase2-impl` |

- 主实现分支内按 Phase 顺序分提交：`docs(contracts)` → `feat(agent-api)`（模型迁移 → 上下文 → 工作区化 → 内部端点）→ `feat(admin-api)` → `feat(cloud-controller)` → `feat(agent-web)` / `feat(admin-web)` → `test:`。
- 并行子项目分支（z-coding「编写实现并行 subagent」）：`servers/agent-api`（Phase 2-5）、`servers/admin-api`（Phase 6）、`servers/cloud-controller`（Phase 7）、`apps/*`（Phase 8-9）可各自从主实现分支切出，完成后 merge 回主实现分支。
- **禁止 rebase/squash，只允许 merge**（z-git 规范）。合并顺序：**契约 → agent-api → admin-api → cloud-controller → apps → tests**。

### 1.2 开发模式与规范加载

- 全部 Phase 采用 TDD（红-绿-重构）：先写测试（RED）→ 最小实现（GREEN）→ 重构；迁移 015/002 先落 `.test.ts`（幂等重跑、半完成补齐、计数门禁）再写迁移体。
- 编码前加载：`docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端 Phase）、`docs/engineering/frontend-rules.md`（Phase 8/9）。
- 目录级 `AGENTS.md`：`servers/agent-api/AGENTS.md`、`servers/cloud-controller/AGENTS.md`、`apps/agent-web/AGENTS.md`、`apps/admin-web/AGENTS.md`、`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`、`docs/engineering/plan/AGENTS.md`。
- `servers/admin-api` 无独立 `AGENTS.md`，沿用根 `AGENTS.md` 与 engineering 规范；`servers/controller-api` 本期**零改动**（工作区边界在 agent-api 查询层承担，`controllers/sessions/controllerkeys` 的工作区归属由 agent-api 写方推导落库，controller-api 共写路径不新增字段——见 §3.2 裁决 10）；`packages/agent-controller`、`aspire/AgentGear.AppHost` 本期零改动（无新增环境变量，`INTERNAL_API_TOKEN`/`AGENT_API_URL` 复用一期配置）。
- **写方纪律**：`tenantmembers`（含 `role`）/`workspaces`/`workspacemembers` 写方仅 agent-api（含 `/internal/tenants*` 与 `/internal/users` 开户；租户成员与角色的唯一写方为 `tenant-member-service`，裁决 12；全局工作区创建的唯一语义入口为 `workspace-service.ensureGlobalWorkspace`，开户/team 开通均调用，迁移 015 走等价原子操作，裁决 16），admin-api 只读镜像；`cloudcontainers.workspaceId` 写方仅 cloud-controller（经 `startHarness` 下发）；`providers`/`models` 写方仅 agent-api（admin-api 镜像只读 + 管理后台既有全局域写操作不变）。
- **字段级 resolver 纪律**（backend-rules 陷阱）：`Workspace.tenant/memberCount/myRole/readOnly` 等新增字段级 resolver **必须登记** `graphql/resolvers/index.ts`。

## 2. 命令参考

```bash
# 服务编排（根目录；测试服务只用 Aspire，禁止直接 docker 命令）
aspire start
aspire wait agent-api admin-api cloud-controller
aspire describe agent-api
aspire stop

# 单服务单测 / 构建
cd servers/agent-api && npm ci && npm test && npm run build
cd servers/admin-api && npm ci && npm test && npm run build
cd servers/cloud-controller && npm ci && npm test && npm run build
cd apps/agent-web && npm ci && npm test && npm run build
cd apps/admin-web && npm ci && npm test && npm run lint && npm run build

# 跨服务 API 测试（先 aspire start；地址按 aspire describe 替换）
cd tests/api
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
CONTROLLER_API_URL=http://localhost:<controller-api-port> \
CLOUD_CONTROLLER_URL=http://localhost:10004 \
INTERNAL_API_TOKEN=<与 internal-api-token 一致> \
CLOUD_CONTROLLER_INTERNAL_TOKEN=<同上> \
ADMIN_INITIAL_PASSWORD=<aspire 启动日志或 Parameters 注入> \
MONGODB_URI=<aspire describe mongodb；自签 dev cert 追加 tlsAllowInvalidCertificates=true> \
npm test

# E2E（串行，workers=1 已写死；地址按 aspire describe 替换）
cd tests/e2e
BASE_URL=http://localhost:<agent-web-port> \
ADMIN_WEB_URL=http://localhost:<admin-web-port> \
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
INTERNAL_API_TOKEN=<与 internal-api-token 一致> \
MONGODB_URI=<aspire describe mongodb> \
npx playwright test

# 迁移手工核对（Aspire Mongo）
mongosh "<MONGODB_URI>" --eval '
  db.workspaces.find({}, {tenantId:1,name:1,type:1}).limit(5);
  db.tenantmembers.countDocuments({}); db.workspacemembers.countDocuments({});
  db.cloudhosts.findOne({}, {userId:1,tenantId:1,workspaceId:1});
  db.providers.find({scope:"user"}, {tenantId:1,workspaceId:1,name:1}).limit(5);
  db.user_commit_settings.findOne({}, {userId:1,tenantId:1,workspaceId:1});
  db.workflowinstances.findOne({}, {resourceWorkspaceId:1,workspaceId:1});'
```

## 3. 计划期裁决（提案与代码事实偏差的落地口径）

> 以下裁决以**当前需求总分支代码事实**为准（§3.1/裁决 1-11 基于 88d104f1，v1.1 增补裁决 12/13/15 基于 6d5860cd，v1.2 增补裁决 16/17 基于 3ff0ffa8；角色体系为新增集合字段与新增服务，无既有代码冲突，见附录 B.13-B.15）。提案中与之不一致或含混的描述在实现期按本节执行，**不回改提案**；验收报告逐条登记。

### 3.1 事实校正（提案描述与代码事实的偏差）

| # | 提案描述 | 代码事实 | 本计划口径 |
|---|---------|----------|-----------|
| F1 | §3.1 契约 6 / §4.1：`workflowinstances` 等「复制新增 `workspaceId`」，`WorkflowInstance` 新增 `workspaceId: ID!` | `workflowinstances` **已有 `workspaceId`**（`models/workflow-instance.ts:77` `ref: 'ControllerWorkspace'`，required；索引 `{userId,workspaceId,createdAt:-1}`），且契约/前端/工具面已按「项目工作区」语义消费：`contracts/workflow.graphql:194`（`WorkflowInstance.workspaceId`）、`:287`（`InstantiateWorkflowInput.workspaceId`）、`:320`（`workflowInstances(workspaceId:…)` 入参）、`services/workflow/admin-tools.ts:135/150/165`（MCP 实例化入参 `workspaceId`）、`apps/agent-web/src/graphql/workflow.ts:315-340`、`home.ts:13`；`CreateSessionInput.workspaceId`、`controller-workspace.graphql` 一批入参亦为项目工作区语义 | **工作流域（`workflowtemplates`/`configuredworkflows`/`workflowinstances` 三集合与 `contracts/workflow.graphql` 三类型）的租户工作区维度统一命名 `resourceWorkspaceId`**，`workspaceId` 保留「项目工作区（ControllerWorkspace）」语义零改动；其余 8 集合（cloudhosts/sessions/controllers/controllerkeys/providers/models/githubaccounts/user_commit_settings）沿用提案 `workspaceId`。`applyWorkspaceScope(schema, { workspaceField })` 支持按集合指定字段名（默认 `workspaceId`）。**备选（重命名旧字段为 `controllerWorkspaceId`）弃用**：MCP 工具入参/存量工作流节点提示词与前端强消费，违反「零破坏/零感知」口径；跨域命名统一留待后续期次（登记验收报告） |
| F2 | §1.3 contracts 范围（workspace / admin-tenant / llm / github / cloud-host / workflow 六文件） | `startHarness` 的 harness 参数面在 `contracts/cloud-controller-websocket.md` 附录 A（一期 F8 同型遗漏）；`cloudcontainers` 写入口径 +workspaceId 依赖它 | Phase 1 契约增补**包含 `contracts/cloud-controller-websocket.md`**：附录 A harness 参数表新增 `workspaceId`（可选，String；缺失回退按 `tenantId` 查 `workspaces{type:'global'}` 解析、解析不到置 null + warn）与落库口径句 |
| F3 | §4.1：「providers/models 仅 `scope='user'` 行加 `tenantId+workspaceId`；唯一索引 `providers.{scope,name}` → user 域改为 `{tenantId,workspaceId,name}`」 | providers/models **现无 userId/tenantId**（仅 `scope: 'user'\|'global'`，`services/provider.ts:8-10` 按 `$or:[{scope:'user'},{scope:{$exists:false}}]` 过滤全体前台共享行）；`providers` 存在唯一索引 `{scope,name}`（`models/provider.ts:21`，迁移 004 命名 `scope_1_name_1`）；`models` 唯一索引 `{providerId,name}` + admin-api 迁移 005 `scope_global_name_unique`（partial `{scope:'global'}`） | 索引与复制的**执行顺序**固定为：① 建新索引（user 域 `{tenantId,workspaceId,name}` 唯一 + global 域 `{name}` partial `{scope:'global'}` 唯一）→ ② 删旧 `scope_1_name_1` → ③ 按租户复制 → ④ 计数核对 → ⑤ 删原共享行（复制行同名跨租户并存会撞旧唯一索引，旧索引必须先删）；`models.{providerId,name}` 不变（provider 已带工作区维度）；复制行显式 `scope:'user'`；**复制范围与 `services/provider.ts` 的 `USER_SCOPE_FILTER`、`services/model.ts` 的 `AVAILABLE_MODELS_FILTER` 完全同口径——`scope:'user'` 与 `scope` 缺失的存量行均视同 user 域参与复制**（否则无 scope 行迁移后成为无 workspaceId 孤儿，新查询口径下不可见）；计数门禁的基线同口径 |
| F4 | §4.1：`user_commit_settings`「唯一索引 `{tenantId,userId}` → `{workspaceId}` 唯一」 | 该集合存在**三处唯一声明**：字段级 `userId: {unique:true}`（`models/user-commit-setting.ts:20`，autoIndex 生成 `userId_1`）、schema `index({tenantId,userId},{unique:true})`（:44）、迁移 011 命名 `uniq_user_commit_setting`（`{userId:1}` 唯一，防 autoIndex 关闭） | 键改切换口径：建 `{workspaceId:1}` 唯一（命名 `uniq_workspace_commit_setting`）→ 验证 → 删 `uniq_user_commit_setting`、`userId_1` 唯一、`{tenantId,userId}` 唯一；`userId` 降级为普通索引（最近编辑者审计，保留字段）；`tenantId` 保留。存量 personal 租户恒单行（一期单成员），键改无同 workspaceId 冲突（§3.2 裁决 5） |
| F5 | §5.2 实现点 3：「billing-client 签名由隐式 tenantId 改为显式 ownerTenantId 入参」 | 调用面现状不一致：`services/cloud-host-service.ts:255` `getAccount('tenant', userId)`（ownerId 传 **userId**，一期 tenantId==userId 恒等）、`:338-341` `createCloudHostApiKey({ownerType:'tenant', ownerId: userId})`；`graphql/resolvers/billing.ts:45/101/122/131` 传 `user.tenantId` | 全部收敛为**工作区所属租户**（`context.workspaceAccess.tenantId`；服务内部链路经「host → workspaceId → Workspace.tenantId」解析）；`billing-client` 各方法保持 `(ownerType, ownerId)` 形参名，语义注释标注 `ownerId=ownerTenantId`；「我的费用」随当前工作区所属租户口径（PRD 功能点 8） |
| F6 | §4.1：三集合建模与 11 集合统一「复制新增 workspaceId」 | `tenantmembers`/`workspacemembers` 自身带 `userId`+`tenantId` 字段，若挂 `applyTenantScope`（`services/tenant-scope.ts:126` guard：userId 与 tenantId 同在即生效）会在 `find({userId})` 类查询注入 `tenantId=userId`——与「用户可属个人租户+多团队」语义直接冲突 | **三集合一律不挂 `applyTenantScope`/`applyWorkspaceScope`**（§3.2 裁决 2）；成员关系/工作区自身查询一律显式条件（`accessibleWorkspaces` 等跨租户查询不受插件干扰） |
| F7 | §4.2/§5.2：workspace-scope 插件「读注入 workspaceId 可见集」 | 一期 `tenant-scope.ts` 无需请求级上下文（tenantId 由 filter 的 userId 推导）；工作区可见集**依赖当前请求的工作区**，Mongoose 插件无法直接拿到 GraphQL context；工作流引擎/内部调用不走 GraphQL 上下文 | 新增 `services/workspace-context.ts`（`AsyncLocalStorage<WorkspaceContext>`）：`middleware/auth.ts` 解析成功后 `als.run(...)` 包裹请求；插件 pre 钩子读 store，**无 store（引擎/内部/迁移）不注入、写校验跳过**，内部链路显式传 `workspaceId`（§3.2 裁决 1/10） |
| F8 | §4.1 表：`githubaccounts`/`user_commit_settings` 复制新增 workspaceId | 两集合 `userId`/`tenantId` 为 **String** 口径（`models/github-account.ts:5-6`、`models/user-commit-setting.ts:20-21`），其余集合为 ObjectId | `workspaceId` 类型**对齐各集合既有 tenantId 口径**：githubaccounts/user_commit_settings 用 String（= `workspace._id.toString()`），其余用 ObjectId ref 'Workspace'；写路径由 Mongoose 统一 cast |
| F9 | §3.1 契约 6：`WorkflowTemplate` 新增 `workspaceId`（内置行恒 null 全局可见） | `workflowtemplates.userId` 可空（内置模板 `userId=null`、`isBuiltin=true`，`models/workflow-template.ts:33-41`）；`services/workflow/template.ts:180-233` 现以 `$or:[{userId},{isBuiltin:true}]` 保证内置可见 | `resourceWorkspaceId` 可空（内置行恒 null）；workspace-scope 读过滤注入 `$or:[{resourceWorkspaceId:{$in:可见集}},{isBuiltin:true}]`（插件 `builtinVisible` 选项，仅 workflowtemplates 启用）；内置模板写操作仍拒绝 |
| F10 | §2.3：admin-api「provider/model 镜像模型补 workspaceId/tenantId 可选字段」 | admin-api `models/provider.ts:21` **镜像侧声明了同一 `providers` 集合的 `index({scope,name},{unique:true})`**；admin-api 迁移 005 亦管理 `models` 集合索引 | 镜像 schema 的**索引声明必须与 agent-api 索引切换同 PR 更新**（改声明 user 域 `{tenantId,workspaceId,name}` + global 域 partial，删 `{scope,name}`），否则 admin-api `autoIndex` 会复活旧唯一索引导致复制/写入失败；`models` 镜像同理核对 |
| F11 | §5.2 实现点 6：「MCP 工具经 sessionId 反查 Session.workspaceId」「homeOverview 改按当前工作区过滤」 | `services/mcp-dispatch.ts:95-112` 平台工具入口给 admin-tools `{userId,sessionId}`、给 node tools `{userId,workflow}`；`services/workflow/admin-tools.ts` 各列表按 `userId` 过滤（`template.ts:180`/`configured.ts:121`）；node tools 归属校验 `instance.userId !== scope.userId`（`tool-handlers.ts:180`）；`graphql/resolvers/home.ts:50` `const userId = context.currentUser.id` | MCP 工具过滤口径 = `sessionId → Session.workspaceId`（会话所属租户工作区）；node tools 归属校验改为「instance.resourceWorkspaceId === 会话工作区」（工作区成员可操作本工作区资源，PRD 功能点 3）；`homeOverview` 各聚合分支随 `context.workspace` 过滤（仍为薄 `Promise.all` 聚合，不新增 service 层） |
| F12 | Phase 1 契约 1：`Mutation.createWorkspace/renameWorkspace/deleteWorkspace/addWorkspaceMember/removeWorkspaceMember` | `contracts/controller-workspace.graphql` 已占用 `createWorkspace(input)` / `deleteWorkspace(id)`（项目工作区 ControllerWorkspace），GraphQL 同名 mutation 无法合并 | 租户工作区 mutation 统一加 `Tenant` 前缀：`createTenantWorkspace` / `renameTenantWorkspace` / `deleteTenantWorkspace` / `addTenantWorkspaceMember` / `removeTenantWorkspaceMember`（租户成员 mutation `addTenantMember/removeTenantMember/changeTenantMemberRole` 不变）；`contracts/workspace.graphql`、agent-api schema/resolver、agent-web GraphQL 文档同步；`deleteWorkspace` 项目工作区语义零改动 |
| F13 | Phase 2/4 表：`cloudhosts` 复制新增 `workspaceId`；契约 5 `CloudHost.workspaceId` | `models/cloud-host.ts:46` **已有 `workspaceId`**（ref `ControllerWorkspace`，默认工作区路径链路强消费） | 与 F1 同型裁决：cloudhosts 租户工作区维度使用 `resourceWorkspaceId`（ref `Workspace`），契约 `CloudHost.workspaceId` 由 `cloudHostService.mapCloudHost` 映射 `resourceWorkspaceId`；`applyWorkspaceScope(cloudHostSchema,{workspaceField:'resourceWorkspaceId'})`；默认工作区 `workspaceId` 零改动 |
| F14 | §1.2：`servers/controller-api` 本期零改动；实现点 4「控制器注册从 key 继承 workspaceId」 | controller-api `services/socketio.ts:105` 直接 upsert `controllers`（agent-api 无注册写入口），不改则本地控制器无 `workspaceId`，工作区过滤下不可见 | controller-api 注册时从 `controllerkeys` 读取并写入 `tenantId/workspaceId`（1 处最小改动 + `controller-api` Controller 镜像字段），其余零改动；契约语义「控制器注册从 key 继承」保持不变 |

### 3.2 设计裁决（提案留白/含混处）

1. **工作区上下文载体**：`services/workspace-context.ts` 提供 `AsyncLocalStorage<{id, tenantId, type, role, readOnly, visibleIds}>` + `runWithWorkspace(ctx, fn)`；`middleware/auth.ts` 解析 `x-workspace-id` 成功后包裹；同时回填 `AuthContext.workspaceAccess`（提案 §2.3 口径：`{id, tenantId, type, role, readOnly}`，GraphQL resolver 显式取用）。`readOnly = type==='global' && role==='developer'`（提案决策 D12，一次判定、插件统一写拦截）。`visibleIds` 请求级缓存一次（共享型读过滤用 `[当前, 本租户全局]` 二元集，切换器数据源 `accessibleWorkspaces(userId)` 按角色展开（admin=租户全部工作区、developer=全局+已加入 normal）挂 `AuthContext` 惰性 Promise，与 `modelLibraryPromise` 同模式）。
2. **三集合不挂作用域插件**（F6）：`tenantmembers`/`workspaces`/`workspacemembers` 查询一律显式 `{tenantId,userId}`/`{workspaceId,userId}` 条件；`workspace-service` 是唯一写方。
3. **workspaceId 类型口径**（F8）：对齐各集合既有 `tenantId` 类型；`Workspace._id` 独立 ObjectId 生成（global 行 `createdBy=null`）。
4. **providers/models 复制与索引顺序**（F3）：固定「建新索引 → 删旧唯一索引 → 按租户复制 → 每租户计数核对（复制数 == 原共享行数）→ 删原共享行」；计数不等即**中止不删**并抛错（迁移失败可重跑）；发布前对 `providers`/`models` mongodump 快照（提案 §9.2）。复制含 `models.providerId` 重映射；`scope='global'` 行全程不动。
5. **user_commit_settings 键改无冲突论证**（F4）：存量仅 personal 租户（一期单成员）⇒ 每租户至多 1 行，`workspaceId=本租户全局工作区` 后 `{workspaceId}` 唯一成立；team 租户上线后经 `updateCommitSettings` 按 `workspaceId` upsert（每工作区一行）。
6. **共享型/独占型读写口径**（提案 §5.2 实现点 1）：独占型（cloudhosts/sessions/controllers/controllerkeys/workflowinstances/configuredworkflows/workflowtemplates 自定义行）读=当前工作区、写强制归属当前工作区；共享型（providers/models/githubaccounts）读=`$in:[当前,本租户全局]`、写仅当前（改/删全局行在普通工作区上下文抛 `Not found`，不泄露存在性）；`user_commit_settings` 独占型 + service 层三段继承。跨工作区访问统一 `Not found`（不泄露存在性）。**只读拦截**（v1.1）：`context.workspaceAccess.readOnly===true`（全局工作区+developer）时一切写（save/insertMany/update/delete）在 workspace-scope 插件层拒绝 `global workspace is read-only`。
7. **global 工作区上下文语义**：当前工作区=全局时，独占型资源=全局工作区自身；共享型 `$in:[global,global]` 等价全局自身——「全局工作区资源的维护入口仅管理员」（PRD 功能点 7）：admin 在全局上下文可维护，developer 只读（readOnly 拦截）。
8. **工作流域命名**（F1）：`resourceWorkspaceId` 只出现在工作流域三集合/三类型与 `applyWorkspaceScope` 的 `workspaceField` 选项；`workspaceId` 在 workflow 契约与 `CreateSessionInput`/`controller-workspace` 入参保持「项目工作区」语义；`contracts/controller-workspace.graphql`、`agent-session.graphql` 补注释澄清，本期不改名。
9. **计费 owner 解析收敛**（F5）：GraphQL 链路 `context.workspaceAccess.tenantId`；服务内部链路（退款/Key 铸造/用量）经 `Workspace.findById(host.workspaceId).tenantId`，缓存于请求级上下文；缺省上下文（无头）= 个人租户全局工作区 ⇒ owner=个人租户，与一期口径完全等价。
10. **归属推导链**（提案 §5.2 实现点 4）：`controllerkeys.workspaceId`=创建 key 时当前工作区 → 控制器注册从 key 继承；云电脑类型控制器/云电脑=创建时当前工作区；`sessions.workspaceId`=其控制器/云电脑（落库前后各复查一次，对齐既有竞态口径）；工作流节点会话=instance.resourceWorkspaceId（引擎无 ALS，显式传值）。
11. **工作区服务权限口径**（提案 §5.2 实现点 5，v1.1 重写）：workspace-service 一切变更入口先判 `role==='admin'`（否则 `not a tenant admin`）——**工作区创建/改名/删除/成员管理均为 admin 专属，developer 无入口**；global 一切变更入口先判 `type==='global'` 抛 `global workspace is immutable`（含 `addWorkspaceMember`/`removeWorkspaceMember`，global 恒无成员行）；`createWorkspace` 要求调用者租户 `type==='team'`（personal 抛 `personal tenant cannot create workspaces`）且**创建者不占用成员行**（admin 天然可管，提案契约 1 注释）；**v1.0 的「0 成员认领」机制移除**（提案决策 D7）：0 成员工作区由 admin 直管并补充成员，`addWorkspaceMember` 仅 admin 可调、成员须为本租户成员（`user is not a tenant member`）；`deleteWorkspace` 并行计数 11 集合（含 workflow 三集合 `resourceWorkspaceId`）任一 >0 拒绝 `workspace is not empty`（接受 TOCTOU 窗口，与既有删除口径一致）。错误文案白名单沿用提案 §3.1（v1.1 共 15 条，逐字，不新增变体）。
12. **租户成员管理与 last-admin 保护**（提案 §5.2 实现点 5/决策 D11/D13，v1.1 新增）：`tenant-member-service` 是租户成员与角色唯一写方——`searchAccounts`（按 username 模糊搜索 `accounts`，鉴权=在任一 team 租户为 admin，结果仅 `username/name/userId` 最小集）；`addTenantMember(tenantId, username, role)`（`Account.findOne({username})`→`User.findOne({accountId})`→upsert，role 缺省 developer）；`removeTenantMember`/`changeTenantMemberRole` 前置 `countDocuments({tenantId, role:'admin'})>1`，否则抛 `last admin cannot be removed`/`last admin cannot be demoted`；personal 租户一切写操作抛 `personal tenant is immutable`（唯一成员恒 admin、无角色变更入口）；资源读写拦截以 workspace-scope 插件（D12）+ service 入口 role 判定双层为准，前端仅展示收敛。last-admin 并发兜底：`findOneAndUpdate` 条件预查 + 变更后复检（若导致 adminCount=0 则回滚并抛错），接受极端并发下的最终一致（提案实现点 5）。
13. **工作区切换器数据源**（v1.1 按角色过滤）：`myWorkspaces` 由 tenantmembers ⨝ workspaces ⨝ workspacemembers 按角色展开（admin=个人全局+各团队**全部**工作区；developer=个人全局+各团队全局+已加入的 normal）；`myTenants` 透出各租户 `role`（切换器/权限渲染数据源）；选择持久化 `localStorage['zag:current-workspace']`（按 userId 隔离存取），刷新/重登恢复；未加入任何团队的用户隐藏切换器（PRD 功能点 6 退化形态）。
14. **admin-api 镜像同步面**：`tenantmembers`（含 `role`）/`workspaces`/`workspacemembers`/provider/model 镜像 schema 注释「与 agent-api 同步演进」（沿用 `cloud-host.ts` 镜像惯例）；F10 索引声明同发布。
15. **AGENTS.md 同步面**（随各 Phase 同提交）：`servers/agent-api/AGENTS.md`（三集合/角色与只读口径/工作区上下文/workspace-scope/T-WS 口径、**新开户运行时初始化与 last-admin 保护**）、`servers/cloud-controller/AGENTS.md`（cloudcontainers workspaceId 与迁移 002）、`apps/agent-web/AGENTS.md`（切换器/工作区管理页/租户成员管理页/来源徽标与只读收敛、**失效工作区回退**）、`apps/admin-web/AGENTS.md`（team 租户管理含角色）、`tests/api/AGENTS.md` + `tests/e2e/AGENTS.md`（新套件清单）、`docs/engineering/AGENTS.md`（plan 索引，随本文件提交完成）。
16. **新开户租户运行时初始化**（v1.2 补强，PRD 功能点 3「每个新建租户（personal/team）创建时自动拥有全局工作区」）：`POST /internal/users` 在既有「accounts → users → tenants → 计费账户 get-or-create」之后新增**确保全局工作区 + `tenantmembers{tenantId,userId,role:'admin'}`**一步（置于计费 get-or-create 成功之后，避免额外回滚面）：`workspace-service.ensureGlobalWorkspace(tenantId, { adminUserId })` 幂等 upsert——`workspaces.findOneAndUpdate({tenantId,type:'global'}, {$setOnInsert:{name:'全局工作区',type:'global',createdBy:null}}, {upsert:true,new:true})` + `tenantmembers.updateOne({tenantId,userId}, {$setOnInsert:{role:'admin',createdBy:'provision'}}, {upsert:true})`；半完成开户（已有 account/user/tenant 但缺工作区/成员行）逐项补齐；并发由 `{tenantId,name}`、`{tenantId}` partial、`{tenantId,userId}` 唯一索引兜底（E11000 视为已就绪）。`/internal/tenants`（team 开通）复用同一 helper 创建 global 行，迁移 015 以等价原子操作保证同一语义（迁移不依赖 Phase 3 服务层）。**缺此步新开户用户将无全局工作区，缺头回退与切换器均失效**，列入 Phase 5、T-PROV 与兼容回归必测。
17. **成员/角色操作留痕**（v1.2 补强，PRD §4.2「角色变更、成员增删保留操作记录，可追溯操作人与时间」）：`tenant-member-service` 的 add/remove/changeRole 与 `workspace-service` 的成员增删/工作区 CRUD 统一写结构化审计日志（`[audit] action=tenant.member.add|tenant.member.remove|tenant.member.role_change|workspace.member.add|workspace.member.remove operator=<id> tenant=<id> target=<id|name> role=<admin|developer|->`，不含凭据等敏感信息）；`tenantmembers.createdBy` 记录首次操作来源（admin 用户 id / 租户管理员 userId / `migration` / `provision`）、`updatedAt` 记录最后变更时间。后台链路在内部请求体透传可选 `operatorId`（admin 用户 id，仅审计、不参与业务校验；缺省 `admin_api`），前台链路取 `context.currentUser.id`；本期不新增审计集合（最小实现，持久化审计表留待后续期次）。


## 4. 关键约束（提案 §1.3/§5/§6 + PRD §5，实现期不得回退）

- **契约先行**：全部 GraphQL/内部 REST 口径以 Phase 1 契约文件为准；实现期发现偏差按 §3 裁决登记，不回改提案。
- **工作区可见性与角色权限是安全红线**（PRD §4.2）：任何对普通工作区资源的访问以成员资格**或管理员角色**为前提；global 写操作以 admin 角色为前提（developer 只读），禁止任何形式的绕过；非成员访问一律 `Not found`，不泄露存在性；global 可见性以租户成员资格为前提，移出租户立即失效。
- **角色口径**（v1.1）：租户角色仅两级（admin/developer，`tenantmembers.role`）；**不做工作区级角色**（工作区成员无角色之分，管理能力收归租户 admin）；admin=管理租户全部资源/全部工作区可见可管/可建工作区/可增删租户成员与变更角色/可按帐号名搜索账户；developer=不可建工作区/不可成员管理/仅读写删除所在普通工作区资源/全局工作区只读；**每租户至少保留一名 admin（last-admin 保护）**；personal 租户唯一成员恒 admin（无角色变更入口）。
- **userId 保留为创建者**：11 集合 `userId` 字段与写入语义全部保留（展示/审计/创建者筛选）；可见性过滤切 `workspaceId`（D5）。`tenantId` 注入保留（与 tenant-scope 共存，冗余隔离维度与既有索引复用）。
- **每租户恰一个全局工作区**：部分唯一索引（`{tenantId}` partial `{type:'global'}`）+ 服务层硬约束双保险；名称恒为「全局工作区」，不可改名/删除/无成员行。
- **个人用户零感知**：personal 租户有且仅有全局工作区（无创建/改名/删除入口）；缺 `x-workspace-id` 头时行为与一期完全等价；已签发 JWT/API Key 继续有效。
- **系统内置工作流模板不属于工作区**：`isBuiltin=true` 行 `resourceWorkspaceId` 恒 null、全工作区可见可用、不可编辑删除。
- **迁移只增不删为例外管理**：仅 providers/models 原共享行删除 + 三处旧唯一索引删除，须计数门禁 + 快照兜底；其余步骤只增不删，代码回滚即安全。
- **后台不做多租户设计**：admin_users 无租户不隔离（同一期口径）；仅新增 team 租户创建与成员管理转发，操作留痕（`createdBy` 记 admin 用户 id）。
- **本期不做**：更细粒度的自定义权限/角色与**工作区级角色**（租户角色仅 admin/developer 两级，PRD §5.2 约束）、资源跨工作区移动、租户删除、personal 租户多工作区/加成员/角色变更、未列入清单集合（mcp_servers/gateways/controllerworkspaces/todoitems/acpmessages/cloud_host_* 族/workflowprhandlers/issueworkflowtriggers 等）的工作区化（维持一期 `tenantId+userId` 口径）。
- **测试纪律**：新增代码单测覆盖率 ≥ 80%；API 与 E2E 串行执行；测试服务只用 Aspire 编排；11 集合每集合至少一条工作区隔离 API 用例；缺省上下文兼容回归必过。

## 5. Phase 计划

### Phase 1：契约变更（0.5d）

| 文件 | 变更 |
|------|------|
| `contracts/workspace.graphql` | **新增**（提案 §3.1 契约 1 逐字）：`WorkspaceType`/`TenantRole`/`Workspace`（含 `myRole`/`readOnly`）/`WorkspaceMember`/`TenantMembership`/`AccountSummary`、`Query.myWorkspaces/myTenants/workspaceMembers/tenantMembers/searchAccounts`、`Mutation.createWorkspace/renameWorkspace/deleteWorkspace/addWorkspaceMember/removeWorkspaceMember`（工作区管理**仅 admin**）/`addTenantMember/removeTenantMember/changeTenantMemberRole`（租户成员管理仅 admin，last-admin 保护）；错误口径白名单逐字（v1.1 共 **15 条**：`workspace not found`/`workspace name already exists`/`global workspace is immutable`/`global workspace is read-only`/`personal tenant cannot create workspaces`/`personal tenant is immutable`/`workspace is not empty`/`not a workspace member`/`not a tenant admin`/`user is not a tenant member`/`account not found`/`already a member`/`not a member`/`last admin cannot be removed`/`last admin cannot be demoted`）；头部注释写明「项目工作区（ControllerWorkspace）是另一概念」 |
| `contracts/admin-tenant.graphql` | 变更（提案契约 2）：`AdminWorkspace`、`AdminTenantUser.role`（`TenantRole` 新增）；`AdminTenantDetail.workspaces`（users 口径改经 tenantmembers 展开含 role，注释注明）；`Mutation.adminCreateTeamTenant/adminAddTenantMember(tenantId, username, role)/adminRemoveTenantMember`；错误口径 `tenant name already exists`/`account not found`/`already a member`/`not a member`/`personal tenant is immutable`/`last admin cannot be removed` |
| `contracts/llm.graphql` | 变更（提案契约 3）：`Provider`/`Model` 新增 `workspaceId: ID`（`scope=global` 恒 null）；注释写明读口径 = 当前 ∪ 本租户全局、写口径 = 仅当前且全局工作区上下文要求 admin（developer 被 `global workspace is read-only` 拦截）；`(workspaceId,name)` 唯一、跨工作区同名并存以来源徽标区分 |
| `contracts/github.graphql` | 变更（提案契约 4）：`CommitSettingsSource` 枚举（WORKSPACE/GLOBAL/UNSET）+ `CommitSettings.source`/`CommitSettings.readOnly`；`GitHubAccount.workspaceId: ID!`；绑定列表读=当前 ∪ 全局、写仅当前（只读拦截同上） |
| `contracts/cloud-host.graphql` | 变更（提案契约 5）：`CloudHost.workspaceId: ID!`；`createCloudHost` 归属当前工作区（不入参，developer 在全局上下文创建被只读拦截）；列表/详情/停止/删除随当前工作区过滤 |
| `contracts/workflow.graphql` | 变更（提案契约 6 + F1 裁决）：`WorkflowTemplate.resourceWorkspaceId: ID`（内置恒 null）、`ConfiguredWorkflow.resourceWorkspaceId: ID!`（跟随其控制器的工作区）、`WorkflowInstance.resourceWorkspaceId: ID!`（继承自已配置工作流）；`WorkflowInstance.workspaceId`/`workspace: ControllerWorkspace`/`InstantiateWorkflowInput.workspaceId`/`workflowInstances(workspaceId:…)` **零改动**，注释标注「项目工作区（ControllerWorkspace）语义，勿与租户工作区混淆」；列表随当前工作区过滤、内置模板例外全局可见 |
| `contracts/cloud-controller-websocket.md`（F2） | 附录 A harness 参数表新增 `workspaceId`（可选，String；缺失回退按 tenantId 解析 global 工作区、解析不到 null+warn）；落库口径句补 `cloudcontainers.workspaceId` |
| `contracts/controller-workspace.graphql` / `contracts/agent-session.graphql` | 注释澄清（F1/裁决 8）：既有 `workspaceId` 入参为「项目工作区（ControllerWorkspace）」语义，本期不改名 |

**完成判据**：契约 8 文件口径与提案 §3 + §3 裁决一致、命名冲突零残留歧义、角色口径（TenantRole/只读/last-admin）与 15 条错误文案逐字；单次提交 `docs(contracts): multi-tenant phase2 workspace/admin-tenant/llm/github/cloud-host/workflow/cloud-controller 契约变更`。

### Phase 2：agent-api 三集合模型与迁移 015（2d，核心）

| 文件 | 变更 |
|------|------|
| `servers/agent-api/src/models/tenant-member.ts` | **新增** `tenantmembers`：`tenantId`（ObjectId ref Tenant，index）/`userId`（ObjectId ref User，index）/**`role`（String：`admin`\|`developer`，personal 恒 `admin`，缺省 `developer`）**/`createdBy`（String：admin 用户 id / 租户管理员 userId / `'migration'`）；唯一索引 `{tenantId,userId}`；timestamps；**不挂作用域插件**（裁决 2）；成员数/成员列表/角色判定的唯一事实源 |
| `servers/agent-api/src/models/workspace.ts` | **新增** `workspaces`：`tenantId`（index）/`name`（global 恒「全局工作区」）/`type`（`global\|normal`）/`createdBy`（ObjectId ref User，global 为 null）；索引 `{tenantId,name}` 唯一 + **`{tenantId:1}` 部分唯一（`partialFilterExpression:{type:'global'}`，命名 `uniq_global_workspace_per_tenant`）**；不挂插件 |
| `servers/agent-api/src/models/workspace-member.ts` | **新增** `workspacemembers`：`workspaceId`（index）/`tenantId`（冗余，index）/`userId`（index）；唯一索引 `{workspaceId,userId}`；**global 工作区恒无成员行**（语义=租户全员）；不挂插件 |
| `servers/agent-api/src/models/*.ts`（11 集合） | 复制新增工作区维度（required after migration，`userId` 保留）：cloudhosts/sessions/controllers/controllerkeys/githubaccounts/user_commit_settings/workflowinstances/configuredworkflows 为 `workspaceId`（workflow 三集合为 `resourceWorkspaceId`，F1）；providers/models/workflowtemplates 可空（global/builtin 行 null）；类型按 F8；新增 `{tenantId,workspaceId}`（workflow 域 `{tenantId,resourceWorkspaceId}`）复合索引；**本 Phase 只落字段与索引声明，插件挂载与过滤口径在 Phase 4** |
| `servers/agent-api/src/migrations/015-team-workspaces.ts` | **新增**步骤链（每步以目标状态存在性为幂等判据，批处理 500 + 进度日志，可重跑）：① 每租户建全局工作区（含存量 personal 与半完成补齐）→ ② `tenantmembers` 回填（逐 `users` 行 upsert `{tenantId:users.tenantId,userId:_id,role:…}`——**personal 租户行恒 `role:'admin'`**，`createdBy:'migration'`）→ ③ 11 集合 backfill 工作区维度 = 本租户全局工作区（缺字段行；workflow 域写 `resourceWorkspaceId`）→ ④ 索引切换（F3/F4/F8 顺序：providers 建新删旧、user_commit_settings 建 `{workspaceId}` 删三处旧唯一、githubaccounts 建 `{tenantId,workspaceId,githubUserId}` 删 `{tenantId,userId,githubUserId}`）→ ⑤ providers/models 按租户复制（含 `providerId` 重映射；**复制范围=`scope:'user'` ∪ `scope` 缺失行**，见 F3）+ 每租户计数核对 → 一致才删原共享行，不等即中止不删 → ⑥ 完成校验（缺工作区维度行数=0、每租户 global 数=1、tenantmembers 覆盖全部 user 且缺 role 行数=0、每租户 admin 数≥1）。导出 `WORKSPACE_ID_COLLECTIONS`（`{collection, model, field, uniqueIndex?}`）供测试与自检互校（对照 013 `TENANT_ID_COLLECTIONS` 模式） |
| `servers/agent-api/src/migrations/015-team-workspaces.test.ts` | **新增** T-MIG15a~h：三集合建模与索引、tenantmembers 回填（personal 恒 1 行且 role=admin、缺 role=0）、11 集合 backfill 无遗漏（workflow 域字段名正确）、索引切换清单断言（含旧索引已删）、providers/models 复制计数门禁（不等不删/一致删除/幂等重跑零变更；**`scope` 缺失行同口径复制、复制后无孤儿**）、user_commit_settings 键改后查询等价、半完成补齐、批处理多页 |
| `servers/agent-api/src/services/tenant-self-check.ts`（扩展） | 启动后轻量异步自检补工作区维度（沿用一期口径）：带索引 count（缺工作区维度行数=0、每租户 global 工作区数=1、tenantmembers 缺 role 行数=0、**users 所属租户无 global 工作区数=0**）+ `limit(100)` 抽样；异常仅 warn 不阻塞 |
| `servers/agent-api/src/index.ts` | 迁移数组登记 015（014 之后） |

**完成判据**：单测全绿；Aspire 冷启动（含存量数据夹具）后每租户恰一个「全局工作区」、11 集合工作区维度回填齐全、tenantmembers 回填齐全且 personal 行恒 `role=admin`、providers/models 复制计数一致且原件已删（**含 `scope` 缺失行、无 workspaceId 孤儿**）、`user_commit_settings` `{workspaceId}` 唯一生效且旧唯一已删；自检无计数异常。

### Phase 3：agent-api 工作区上下文与工作区服务（1.5d，核心）

| 文件 | 变更 |
|------|------|
| `servers/agent-api/src/services/workspace-context.ts` | **新增**（F7/裁决 1）：`AsyncLocalStorage<WorkspaceContext>`（`{id, tenantId, type, role, readOnly, visibleIds, accessibleIds?}`）+ `runWithWorkspace`/`getWorkspaceContext`；`readOnly = type==='global' && role==='developer'`；`visibleIds` 共享型= `[当前,本租户全局]`，独占型= `[当前]` |
| `servers/agent-api/src/middleware/auth.ts` | 解析 `x-workspace-id`（F7）：`Workspace.findById` → 取 `tenantmembers.role` → 可访问性校验（**admin 直通全部工作区**；global 需 `tenantmembers` 含 `{userId,tenantId}`；normal 需 `workspacemembers` 含 `{userId,workspaceId}`）→ `AuthContext.workspaceAccess={id,tenantId,type,role,readOnly}` 并 `als.run` 包裹；缺省/缺头回退「个人租户全局工作区」（`users.tenantId → workspaces{type:'global'}` 一次查询，**role=admin、readOnly=false**，与一期等价）；非法/不可达 id 一律 `workspace not found`（不泄露存在性） |
| `servers/agent-api/src/services/workspace-scope.ts` | **新增** Mongoose 插件 `applyWorkspaceScope(schema, { workspaceField='workspaceId', shared=false, builtinVisible=false })`（对照 `tenant-scope.ts` 同步钩子写法，Mongoose v9 同步无 next）：读注入 `workspaceField ∈ visibleIds`（shared 型 `[当前,全局]`；`builtinVisible` 合并 `$or:[…,{isBuiltin:true}]`）；写（save/insertMany/`$set.workspaceField`）强制存在且 ∈ 当前工作区，**`readOnly===true` 时一律拒绝 `global workspace is read-only`**（D12 统一写拦截）；无 ALS store 不注入/不校验（引擎与内部链路显式传值）；与 `applyTenantScope` 共存（tenantId 注入保留） |
| `servers/agent-api/src/services/workspace-service.ts` | **新增**：`ensureGlobalWorkspace(tenantId, {adminUserId?})`（**幂等 upsert**：global 行 + `tenantmembers{role:'admin'}`；开户/team 开通/半完成补齐共用，裁决 16）；`accessibleWorkspaces(userId)`（tenantmembers ⨝ workspaces ⨝ workspacemembers 按角色展开，请求级缓存）；`createWorkspace`（**仅 admin**（`not a tenant admin`）+ team 租户限定 + 创建者不占用成员行 + `{tenantId,name}` 唯一冲突 `workspace name already exists`）；`renameWorkspace`/`deleteWorkspace`（**仅 admin** + global 硬约束 + 11 集合计数删除保护 + personal 拒绝）；`addWorkspaceMember`/`removeWorkspaceMember`（**仅 admin**（裁决 12）；成员须为本租户成员 `user is not a tenant member`；global 拒绝；**无认领逻辑**）；工作区/成员变更写结构化审计日志（裁决 17）；错误文案白名单逐字（裁决 11） |
| `servers/agent-api/src/services/tenant-member-service.ts` | **新增**（裁决 12）：`searchAccounts(keyword)`（按登录名模糊搜索 `accounts`，限任一 team 租户 admin，结果仅 `username/name/userId` 最小集，D13）；`addTenantMember(tenantId, username, role)`（账户不存在 `account not found`、重复 `already a member`、role 缺省 developer）；`removeTenantMember`/`changeTenantMemberRole`（**last-admin 保护**：admin 计数≤1 时 `last admin cannot be removed`/`last admin cannot be demoted`；变更后复检回滚兜底）；personal 租户一切写操作 `personal tenant is immutable`；移除成员级联清理其本租户全部 `workspacemembers` 行（资源保留原工作区）；**add/remove/changeRole 写结构化审计日志**（`operator`=前台 `context.currentUser.id` / 后台透传 `operatorId`，裁决 17） |
| `servers/agent-api/src/graphql/schemas/workspace.ts` | **新增**（同步 Phase 1 契约 1：含 `TenantRole`/`TenantMembership`/`AccountSummary` 与租户成员管理三 mutation） |
| `servers/agent-api/src/graphql/resolvers/workspace.ts` + `resolvers/index.ts` | **新增** resolvers（工作区 CRUD/成员管理 + 租户成员管理/searchAccounts）；**`Workspace.tenant/memberCount/myRole/readOnly`、`WorkspaceMember.username` 等字段级 resolver 登记 `resolvers/index.ts`**（backend-rules 陷阱）；`workspaceMembers(global)` 恒返回 `[]` |
| `servers/agent-api/src/graphql/resolvers/auth.ts` | 新增 `requireWorkspace(context)` 与 `requireTenantAdmin(context)`（对齐 `requireTenantId` 模式）；`Tenant.memberCount` 口径切 `tenantmembers` 计数（一期 `User.countDocuments({tenantId})` 等价，统一走单一事实源） |
| `servers/agent-api/src/models/workspace-isolation.test.ts`（新建骨架） | T-WS 矩阵载体（Phase 4 填满，**× admin/developer 角色两档**）：CASES 与 `WORKSPACE_ID_COLLECTIONS` 互校 |

**完成判据**：单测全绿（T-CTX*/T-WSP*/T-TM*/T-SCOPE*）；`x-workspace-id` 解析/回退/拒绝路径与角色/只读判定全绿；global 硬约束、仅 admin 写、last-admin 保护、删除保护行为与错误文案逐字一致。

### Phase 4：agent-api 11 集合工作区化与共享/继承口径（2.5d，核心）

| 文件 | 变更 |
|------|------|
| `servers/agent-api/src/models/*.ts`（11 集合） | 挂载 `applyWorkspaceScope`（cloudhosts/sessions/controllers/controllerkeys/workflowinstances/configuredworkflows 独占；workflowtemplates `builtinVisible`（F9）；providers/models/githubaccounts `shared`；user_commit_settings 独占） |
| `servers/agent-api/src/services/{session,controller,controller-key,cloud-host*}.ts` | 逐集合 checklist 过滤口径切换（`userId` 过滤 → 工作区过滤，写入保留 userId=创建者）；归属推导链落 `workspaceId`（裁决 10：key 创建 → 控制器注册继承 → 云电脑/会话继承，落库前后复查） |
| `servers/agent-api/src/services/{provider,model}.ts` | `scope='user'` 行读过滤 = 当前 ∪ 全局（合并展示来源可区分：`workspaceId===当前 ? 本工作区 : 全局`）；写（增删改/排序/启停/batch*）仅当前工作区行；唯一性按 `(workspaceId,name)`（迁移 015 已切索引） |
| `servers/agent-api/src/services/github.ts` | `getAccounts`/bind/unbind/refresh：读 = 当前 ∪ 全局；绑定/解绑写仅当前工作区；唯一性 `{tenantId,workspaceId,githubUserId}` |
| `servers/agent-api/src/services/commit-settings-service.ts` | 查询键 `userId`→`workspaceId`（upsert 当前工作区行，`userId` 留最近编辑者）；`resolveCommitIdentity` 链（提案 §3.2）：云电脑 → 其 `workspaceId` → 本工作区设置 →（unset/缺行）本租户全局工作区设置 → unset，`source` 三段透出；`updateCommitSettings` 写操作受 `readOnly` 拦截（全局上下文 developer 抛 `global workspace is read-only`）；`resolveCommitter` 的 `GitHubAccount` 校验改共享读口径（account ∈ 当前 ∪ 全局）；既有五步门控/bot 降级/错误文案零改动 |
| `servers/agent-api/src/services/billing-client.ts` + `cloud-host-service.ts` + `graphql/resolvers/{billing,cloud-host}.ts` | 计费 owner 切换（F5/裁决 9）：`ownerId=workspace.tenantId`；云电脑创建扣费、`cloudHostBillingQuote`、API Key 铸造、退款全链路同口径；「我的费用」随当前工作区所属租户 |
| `servers/agent-api/src/services/cloud-controller-client.ts` + `cloud-host-service.ts` | `StartHarnessInput` 增 `workspaceId` 并随 `startHarness` 下发（与 tenantId 并列，对齐 Phase 7） |
| `servers/agent-api/src/services/workflow/{template,configured,instance,engine}.ts` | 工作流三集合过滤切 `resourceWorkspaceId`（`listForUser` → 工作区口径；`findOne({_id,resourceWorkspaceId})`）；内置模板例外（`$or:[…,{isBuiltin:true}]`）；实例化落 `resourceWorkspaceId`（自 configured/模板继承）；引擎建节点会话显式继承 instance.resourceWorkspaceId |
| `servers/agent-api/src/models/workspace-isolation.test.ts` + 各 `.test.ts` | T-WS 矩阵填满（11 集合 × 真实 Mongoose 查询中间件 × **admin/developer 角色两档**）：普通工作区非成员开发读/写 `Not found`、成员开发可达、admin 任意工作区可达、global 租户全员可达（developer 只读、写 `global workspace is read-only`，admin 可写）、跨租户不可达；独占/共享读写口径；personal 期（缺头）结果集与改造前一致 |

**完成判据**：`grep -rn "userId" servers/agent-api/src/{services,graphql}` 过滤点逐一登记 checklist 并全部切换（userId 仅剩创建者写入/审计）；T-WS 角色两档全绿；既有单测零回归；Commit 三段矩阵通过；team 工作区扣 team 租户、个人余额不变（单测 + Phase 10 API 双覆盖）。

### Phase 5：agent-api 内部端点、新开户初始化与聚合/工具口径（1.5d）

| 文件 | 变更 |
|------|------|
| `servers/agent-api/src/routes/internal-tenants.ts` | **新增**（错误体 `{ error: '<UPPER_CODE>' }` 沿用 `internal-users.ts` 口径）：`POST /internal/tenants`（创建 team 租户 + 全局工作区 + 零余额计费账户 get-or-create，失败向前回滚，按 name 幂等 200/201，409 `TENANT_NAME_TAKEN`）；`POST /internal/tenants/:tenantId/members`（`{username, role, operatorId?}`，role 缺省 `developer`、`operatorId` 仅审计（裁决 17）；`Account.findOne({username})` → `User.findOne({accountId})` → `tenantmembers` upsert；400 `PERSONAL_TENANT_IMMUTABLE`/`INVALID_ROLE`、404 `ACCOUNT_NOT_FOUND`/`TENANT_NOT_FOUND`、幂等 200 不覆盖既有角色）；`DELETE /internal/tenants/:tenantId/members/:userId`（删 tenantmembers 行 + 该用户本租户全部 workspacemembers 行；资源保留原工作区；404 `NOT_MEMBER`、**409 `LAST_ADMIN`（last-admin 保护，前后台通道同口径）**；`operatorId?` 经查询参数透传、仅审计）；全部 Bearer `INTERNAL_API_TOKEN` |
| `servers/agent-api/src/routes/internal-users.ts` | **变更**（裁决 16）：现有「accounts → users → tenants → 计费账户 get-or-create」成功后，调用 `workspace-service.ensureGlobalWorkspace(tenantId,{adminUserId:userId})` 确保**全局工作区 + `tenantmembers{role:'admin'}`**；按 username 幂等与半完成态逐项补齐（已有 user/tenant 但缺工作区/成员行同样修复）；响应体追加 `globalWorkspace:{id,name}`（向后兼容，旧调用方忽略即可）；E11000 并发冲突视为已就绪 |
| `servers/agent-api/src/index.ts` | 挂载 `app.use('/internal/tenants', internalTenantsRouter)`（与 `/internal/users` 同位置） |
| `servers/agent-api/src/graphql/resolvers/home.ts` | `homeOverview` 各聚合分支随 `context.workspace` 过滤（F11；仍薄 `Promise.all` 聚合、降级 helper 不动） |
| `servers/agent-api/src/services/mcp-dispatch.ts` + `services/workflow/admin-tools.ts` + `tool-handlers.ts` | MCP 口径（F11/裁决）：admin-tools 过滤 = `sessionId → Session.workspaceId`（模板/已配置/实例/控制器列表同步收敛，内置模板例外）；node tools 归属校验 `instance.resourceWorkspaceId === 会话工作区`；工具 schema 注释补「工作区上下文=会话所属工作区」 |
| `servers/agent-api/src/routes/internal-tenants.test.ts` | **新增** T-IT1~8：创建成功/重名 409/幂等、加成员（不存在账户 404、重复幂等不覆盖角色、role 缺省 developer/非法 `INVALID_ROLE`、personal 400）、移成员（立即失去访问、资源保留、重新加入不自动恢复工作区成员、**last-admin 409 `LAST_ADMIN`**）、鉴权 401、审计日志携带 operatorId（裁决 17） |
| `servers/agent-api/src/routes/internal-users.test.ts`（扩展） | **新增 T-PROV1~4**：新开户（201）后恰有 1 个 global 工作区 + 1 行 `tenantmembers{role:'admin'}`；重复开户（200）幂等零新增；半完成态（已有 account/user/tenant 缺工作区/成员行）逐项补齐；计费不可达 503 时不残留工作区（初始化置于计费成功之后）；并发开户 E11000 视为已就绪 |

**完成判据**：单测全绿（T-IT*/T-PROV*）；**新开户用户立即可用（全局工作区 + admin 成员关系齐备，缺头回退/切换器正常）**；审计日志可追溯操作人/时间；tests/api 黑盒「后台转发口径」闭环在 Phase 6 联调验证；MCP 工具在普通工作区会话下只见本工作区 + 内置模板。

### Phase 6：admin-api 只读镜像与 team 转发（1d）

| 文件 | 变更 |
|------|------|
| `servers/admin-api/src/models/{tenant-member,workspace,workspace-member}.ts` | **新增**只读镜像（schema 注释「与 agent-api 同步演进」，沿用 `cloud-host.ts` 镜像惯例） |
| `servers/admin-api/src/models/{provider,model}.ts` | 镜像补 `workspaceId/tenantId` 可选字段；**索引声明同步 agent-api 切换后形态**（F10：user 域 `{tenantId,workspaceId,name}` + global 域 partial，删 `{scope,name}`） |
| `servers/admin-api/src/graphql/schemas/tenant.ts` | 同步 Phase 1 契约：`AdminWorkspace`、`AdminTenantUser.role`、`adminCreateTeamTenant/adminAddTenantMember(tenantId, username, role)/adminRemoveTenantMember`、`AdminTenantDetail.workspaces` |
| `servers/admin-api/src/graphql/resolvers/tenant.ts` | 新增三个 mutation 转发 `POST /internal/tenants`、`POST/DELETE /internal/tenants/:id/members[/:userId]`（`adminAddTenantMember` 透传 role，缺省 developer；**`operatorId` 透传当前 admin 用户 id 供审计**（裁决 17）；沿用 `forwardCreateFrontUser` 的 fetch/超时/错误映射模式，409→CONFLICT（含 `LAST_ADMIN`/`TENANT_NAME_TAKEN`）、400→INVALID_ARGUMENT（含 `INVALID_ROLE`）、404→NOT_FOUND、`AGENT_API_UNAVAILABLE`）；`adminTenant` 成员列表改经 `tenantmembers` 展开（+ accounts 登录名 + **role**）；`workspaces` 只读视图（memberCount 经 workspacemembers 计数、global 取租户成员数）；既有 `adminTenants` 列表补类型列数据（`type` 已有） |
| `servers/admin-api/src/graphql/resolvers/tenant.test.ts` | 扩展 T-TT1~8：创建 team（重名/非法/鉴权）、按登录名加成员指定角色（不存在账户/重复幂等不覆盖角色/role 缺省 developer）、移成员（**last-admin 409**）、personal 全部拒绝、详情成员经 tenantmembers 含 role、工作区只读（introspection 无编辑入口） |

**完成判据**：单测全绿；tests/api `admin-api/tenant-team.test.ts` 黑盒通过（含「adminCreateTeamTenant → 成员登录前台即见团队空间」闭环）；admin_user/既有租户只读链路零回归。

### Phase 7：cloud-controller cloudcontainers +workspaceId（0.5d）

| 文件 | 变更 |
|------|------|
| `servers/cloud-controller/src/models/cloud-container.ts` | 新增 `workspaceId: { type: String, default: null, index: true }`（F8 String 口径，与 tenantId 并列） |
| `servers/cloud-controller/src/routes/internal-api.ts` | `parseHarnessRequest` 增 `workspaceId`（F2/裁决）：缺失回退按 `tenantId` 查同库 `workspaces{type:'global'}` 解析、解析不到置 null + warn；`StartHarnessOptions` 落库 `workspaceId` |
| `servers/cloud-controller/src/migrations/002-cloudcontainers-workspace-id.ts(+test)` | **新增**：`workspaceId` 缺失行经同库 `workspaces` 解析 `tenantId→global 工作区` 回填（解析不到置 null + 日志）+ `{workspaceId:1}` 索引；幂等可重跑（T-MIG002a~c：回填/幂等/解析不到跳过） |
| `servers/agent-api/src/models/cloud-container.ts` | 只读镜像同步 +workspaceId（一期 F10 同款纪律） |
| `servers/agent-api/src/services/cloud-controller-client.ts` | `StartHarnessInput.workspaceId`（Phase 4 已接线，本 Phase 联调） |
| `servers/cloud-controller/AGENTS.md` | 补 workspaceId 口径段 |

**完成判据**：单测全绿；`POST /internal/containers{purpose:harness}` 落库 `workspaceId` 与下发一致；缺失回退解析生效；存量容器回填完成；agent-api 读侧 `CloudContainer.workspaceId` 可见。

### Phase 8：agent-web 工作区切换器与工作区上下文（1.5d）

| 文件 | 变更 |
|------|------|
| `apps/agent-web/src/stores/workspace.ts` | **新增**：当前工作区状态 + `myWorkspaces`/`myTenants`（含 role）缓存；`localStorage['zag:current-workspace']` 按 userId 隔离持久化（裁决 13）；缺省=个人租户全局工作区；单工作区（未加入团队）隐藏切换器；**`myWorkspaces` 刷新后若当前/持久化工作区不在可见集（被移出团队、工作区已删除），自动回退个人全局并清理 `zag:current-workspace`**（避免请求持续 `workspace not found`） |
| `apps/agent-web/src/lib/apollo.ts` | Apollo Link 注入 `x-workspace-id`（当前工作区 id；无选择时不发头→服务端回退） |
| `apps/agent-web/src/components/Sidebar.tsx` / `pages/MainLayout.tsx` | 工作区切换器（**按租户分组 + 按角色过滤**：admin=个人全局+各团队全部工作区；developer=个人全局+各团队全局+已加入的 normal；当前项标识）；切换后 `HOME_OVERVIEW` 等 refetch（沿用单一 HOME_OVERVIEW 纪律，不新增组件级 info 查询） |
| `apps/agent-web/src/pages/WorkspacePage.tsx`（新增）+ `App.tsx` | 工作区管理页（**仅 admin 可操作，developer 只读/无入口**；列表：名称/类型/成员数、创建、改名、删除（非空拦截提示）、成员管理添加/移除；**无认领入口**（v1.1 移除，0 成员工作区 admin 直管））；路由 `/workspaces` |
| `apps/agent-web/src/pages/TenantMembersPage.tsx`（新增）+ `App.tsx` | **租户成员管理页（仅 admin 可见）**：成员列表（用户名/展示名/角色/加入时间）、`searchAccounts` 按帐号名搜索添加成员并指定角色、变更角色、移除成员；last-admin 保护提示（`last admin cannot be removed/demoted`）；personal 租户无入口；路由 `/tenants/:id/members`（或团队设置内嵌入口） |
| `apps/agent-web/src/pages/SettingsPage.tsx` + `components/settings/*` | 供应商/模型/Github 绑定/Commit 设置随当前工作区；共享资源来源徽标（本工作区 / 全局工作区）；全局资源在普通上下文只读（编辑/删除入口隐藏）；**全局工作区上下文对 developer 整体只读（按 `readOnly` 收敛编辑入口）**；`CommitSettingsSection` 展示 `source`（本工作区 / 继承自全局工作区 / 未设置） |
| `apps/agent-web/src/graphql/{queries,mutations,types,workflow}.ts` | `myWorkspaces/myTenants/workspaceMembers/tenantMembers/searchAccounts` 与工作区 CRUD/租户成员管理文档；`Workspace.myRole/readOnly`、`TenantRole`、`Provider/Model/GitHubAccount/CloudHost.workspaceId`、`WorkflowInstance/ConfiguredWorkflow/WorkflowTemplate.resourceWorkspaceId`、`CommitSettings.source/readOnly` 类型同步；工作流模块注释澄清 `workspaceId`=项目工作区（零改动） |
| `apps/agent-web/src/**/__tests__` | 切换器（按角色过滤）/管理页（仅 admin）/租户成员管理页/来源徽标/继承展示/只读收敛断言；developer 无管理入口断言；个人用户单工作区无切换器断言；**失效当前工作区（不在可见集）自动回退并清理持久化** |

**完成判据**：`npm run build` 通过；单测全绿；E2E-WS 套件通过；切换器按角色过滤正确（admin 全景/developer 仅加入）、全局上下文对 developer 只读收敛；刷新/重登当前工作区恢复；**被移出团队/工作区已删时当前工作区自动回退个人全局**；个人用户体验与升级前一致。

### Phase 9：admin-web team 租户管理（0.5d）

| 文件 | 变更 |
|------|------|
| `apps/admin-web/src/pages/TenantsPage.tsx` | 租户列表补类型列（personal/team）+「创建团队租户」对话框（`adminCreateTeamTenant`，重名/非法错误映射） |
| `apps/admin-web/src/pages/TenantDetailPage.tsx` | team 租户：成员列表（经 tenantmembers，**含角色列**）、按登录名添加成员并**指定角色**（`adminAddTenantMember`，缺省开发）、变更/移除成员（`adminRemoveTenantMember`，二次确认；last-admin 保护提示）；工作区只读列表（名称/类型/成员数）；personal 租户维持只读、无成员管理入口 |
| `apps/admin-web/src/graphql/*.ts` | admin-tenant 文档与类型同步（AdminWorkspace、`AdminTenantUser.role`、三 mutation） |
| `apps/admin-web/src/pages/__tests__/*` | 创建团队租户表单校验、成员管理交互（含角色选择）、last-admin 拦截提示、personal 无入口断言、工作区只读断言 |

**完成判据**：单测全绿（含 `npm run lint`）；E2E-TT 套件通过；界面无任何租户删除/编辑成员之外的越权入口。

### Phase 10：测试收口与回归（2d）

| 文件 | 变更 |
|------|------|
| `tests/api/src/agent-api/workspace.test.ts` | **新增** T-WS-API 系列（核心验收）：`x-workspace-id` 上下文解析/缺省回退（**无头行为与一期一致**）/非法 id `workspace not found`；11 集合每集合至少一条隔离用例（非成员开发 `Not found`、成员开发可达、admin 任意工作区可达、global 全员可达、跨租户不可达）；**角色权限（developer 创建工作区/成员管理/角色变更/searchAccounts 拒绝 `not a tenant admin`、全局工作区写拒绝 `global workspace is read-only`）**；共享读口径（普通上下文模型/绑定 = 本 ∪ 全局、普通上下文写全局被拒）；Commit 三段继承矩阵（含 `source`）；删除保护/重名；内置模板全工作区可用 |
| `tests/api/src/agent-api/multi-tenant.test.ts`（扩展） | T-MT3 系列：个人用户零感知回归（缺头全链路与一期一致）；移出租户立即失效、资源保留 |
| `tests/api/src/admin-api/tenant-team.test.ts` | **新增** T-TT 系列：adminCreateTeamTenant（含 409）→ 加成员指定角色（缺省 developer）→ 成员登录见团队空间 → 团队工作区消费扣 team 租户（与 `billing` 套件交叉断言：个人余额不变）→ 移成员失效；**last-admin 移除 409**；personal 全拒绝 |
| `tests/api/src/admin-api/billing.test.ts`（扩展） | T-B2：team 租户充值到账即消费、账单/收据按租户检索、余额不足拦截口径不变 |
| `tests/api/src/{agent-api,llm,github,cloud-host,workflow}*.test.ts`（扩展） | 契约字段（workspaceId/resourceWorkspaceId/source）与读写口径断言；`tests/api/src/cloud-controller/internal-api.test.ts` 扩展 harness workspaceId 落库/回退 |
| `tests/e2e/src/workspace.spec.ts`（新增） | E2E-WS1~6：切换器按租户分组**按角色过滤**与持久化、工作区管理（创建/改名/删除拦截/成员添加移除，仅 admin）、设置页来源徽标与 Commit 来源、普通工作区用全局模型/绑定、个人用户无切换器零感知、**租户成员管理（admin 搜索添加/变更角色/last-admin 提示；developer 无入口；全局工作区对 developer 只读）** |
| `tests/e2e/src/admin-team-tenant.spec.ts`（新增） | E2E-TT1~3：后台创建团队租户 + 加成员、成员登录协作可见、团队计费口径 |
| `docs/engineering/AGENTS.md` + 各目录 AGENTS.md | §3.2 裁决 14 同步面收口 |

**完成判据**：tests/api、tests/e2e 串行全绿；既有套件零回归；缺省上下文兼容回归必过；AGENTS.md 无过期口径。

## 6. 测试矩阵

### 6.1 单元测试（Vitest）

| 用例 | 文件 | 断言要点 |
|------|------|---------|
| T-MIG15a 三集合与索引 | `015-team-workspaces.test.ts` | 全局工作区每租户恰一个（部分唯一索引生效）、tenantmembers personal 恒 1 行且 **role=admin**、workspacemembers 空 |
| T-MIG15b 11 集合 backfill | 同上 | 工作区维度=本租户全局工作区；workflow 域字段名 `resourceWorkspaceId`；`userId` 保留 |
| T-MIG15c 索引切换 | 同上 | providers/user_commit_settings/githubaccounts 新索引就位、旧唯一索引已删（F3/F4） |
| T-MIG15d 复制计数门禁 | 同上 | 每租户复制数核对（**含 `scope` 缺失行**）；不等中止不删原件；一致删除；`providerId` 重映射正确；复制后无 workspaceId 孤儿 |
| T-MIG15e 键改等价 | 同上 | user_commit_settings 查询等价（源字段保留）；`{workspaceId}` 唯一 |
| T-MIG15f 幂等/半完成 | 同上 | 二次 run 零变更；缺步骤各自补齐 |
| T-MIG002a~c | `002-cloudcontainers-workspace-id.test.ts` | 回填解析/幂等/解析不到跳过 + 索引 |
| T-CTX1~5 | `middleware/auth` 相关测试 | 头解析/角色与只读判定（admin 直通、global 需租户成员、normal 需工作区成员、`readOnly=global&&developer`）/缺省回退个人全局（role=admin）/非法与不可达 `workspace not found`/请求级缓存一次 |
| T-SCOPE1~6 | `services/workspace-scope.test.ts` | 读注入独占/共享两口径、写强制归属、**readOnly 写拦截 `global workspace is read-only`**、builtinVisible 例外、无 ALS 不注入、与 tenant-scope 共存、跨工作区 `Not found` |
| T-WSP1~9 | `services/workspace-service.test.ts` | global 硬约束（改名/删除/成员）、**一切变更仅 admin（developer `not a tenant admin`）**、personal 拒绝创建、重名、成员须租户成员、删除保护 11 集合计数、移出租户级联删 workspacemembers（**无认领路径**）、**`ensureGlobalWorkspace` 幂等/半完成补齐/并发唯一索引兜底** |
| T-TM1~8 | `services/tenant-member-service.test.ts` | searchAccounts 鉴权（非 admin 拒绝）与结果最小集；add（账户不存在/重复幂等不覆盖角色/role 缺省 developer）；**last-admin 移除/降级拒绝**（变更后复检回滚）；personal 一切写拒绝；移除级联清理 workspacemembers、资源保留 |
| T-CSI2 三段矩阵 | `services/commit-settings-service.test.ts` | 本设/全局设/均未设 ×（云电脑归属 normal/global）；`source` 透出；GitHubAccount 共享读校验；五步门控零回归 |
| T-BILL2 | `services/billing-client.test.ts` + `cloud-host-service.test.ts` | owner=workspace.tenantId（创建扣费/退款/Key 铸造/报价）；缺省上下文=个人租户 |
| T-IT1~8 | `routes/internal-tenants.test.ts` | 见 Phase 5（含 role 入参、`LAST_ADMIN` 409、审计 operatorId） |
| T-PROV1~4 | `routes/internal-users.test.ts` | 新开户生成全局工作区 + `tenantmembers{role:'admin'}`；重复开户幂等；半完成补齐；计费失败不残留工作区 |
| T-AT-TT1~8 | admin-api `resolvers/tenant.test.ts` | 见 Phase 6（含角色透出与 last-admin 409） |
| T-WS（互校） | `models/workspace-isolation.test.ts` | CASES 与 `WORKSPACE_ID_COLLECTIONS` 逐一相等（对照 T-ISO 模式），**× admin/developer 角色两档** |

### 6.2 API 测试（tests/api，Vitest + Aspire 编排）

| 用例 | 断言要点 |
|------|---------|
| T-WS-API 上下文 | `x-workspace-id` 解析/切换/回退；**缺头全链路与一期一致**（兼容回归，必过） |
| T-PROV-API 新开户 | `/internal/users` 开户后立即登录即用：个人全局工作区唯一、admin 成员关系、切换器隐藏、既有能力零差异；重复开户幂等 |
| T-WS-API 逐集合隔离 | 11 集合每集合至少一条：非成员开发列表/详情/修改/删除统一 `Not found`；成员开发可达（含他人创建资源）；**admin 任意工作区可达**；global 租户全员可达（developer 只读） |
| T-WS-API 共享与继承 | 普通上下文模型/供应商/绑定 = 本 ∪ 全局（来源可区分）；写全局被拒（普通上下文 `Not found`、全局上下文 developer `global workspace is read-only`）；全局删除后入口随即不可用；Commit 三段矩阵 + `source` |
| T-WS-API 工作区管理 | 创建/重名/改名/删除保护/成员管理（**仅 admin，developer 拒绝 `not a tenant admin`**）/personal 拒绝/global 拒绝（**无认领用例**） |
| T-TM-API 租户成员管理 | searchAccounts（admin 可搜、developer 拒绝、结果最小集）→ addTenantMember（指定/缺省 role、不存在账户、重复幂等不覆盖角色）→ changeTenantMemberRole → **last-admin 移除/降级拒绝** → removeTenantMember 立即失效、资源保留、重加不自动恢复工作区成员；personal 全拒绝 |
| T-TT team 管理闭环 | 后台创建 → 加成员指定角色（不存在账户 404/重复幂等）→ 成员登录见团队空间 → 移除立即失效、资源保留、重加不自动恢复工作区成员（**last-admin 409**） |
| T-B2 团队计费 | team 工作区消费扣 team 租户、个人余额不变；充值即时可用；余额不足拦截不变 |
| 契约字段 | workspaceId/resourceWorkspaceId/source 透出与默认值（global/builtin 行 null） |
| T-IC-HARNESS2 | harness 创建落库 workspaceId；缺失回退解析 + warn |

### 6.3 E2E 测试（tests/e2e，Playwright，串行）

| 用例 | 断言要点 |
|------|---------|
| E2E-WS1 切换器 | 按租户分组展示（admin=个人+各团队全部工作区；developer=个人+各团队全局+加入的 normal）；切换后列表/设置/新建作用于新上下文并按角色决定可写性；刷新恢复选择 |
| E2E-WS2 工作区管理 | 创建/改名/删除（非空拦截）/成员添加移除（仅 admin，developer 无入口） |
| E2E-WS3 共享与来源 | 普通工作区拉会话可选全局模型、Git 项目可选全局绑定（来源徽标）；普通上下文不可改全局资源；**developer 在全局工作区上下文只读** |
| E2E-WS4 继承展示 | Commit 设置生效来源三态展示（本工作区/继承自全局/未设置） |
| E2E-WS5 个人零感知 | 未加入团队用户无切换器，数据/余额/设置与升级前一致（恒 admin） |
| E2E-WS6 租户成员管理 | admin 按帐号名搜索添加成员/变更角色/移除（last-admin 提示）；developer 无入口、非常规尝试被拒 |
| E2E-TT1~3 | 后台创建团队租户 + 加成员（指定角色）→ 成员协作可见 → 团队计费口径 |

### 6.4 实机/部署侧手工验收（登记验收报告）

- 存量库（生产快照脱敏）冷启动：015/002 迁移耗时与结果、providers/models 复制计数一致、原件删除、自检异步无阻塞。
- **mongodump 快照**（providers/models，迁移唯一删除步骤兜底）先行；回滚演练：代码回滚 + 快照恢复。
- 发布窗口演练：admin-api 新版（F10 索引声明）→ agent-api 新版（迁移 015）→ cloud-controller 新版（迁移 002）→ 前端；旧前端无 `x-workspace-id` 头全程可用（回退个人全局）。
- 团队场景实测：team 开通 → 成员协作 → 团队消费对账；已签发 JWT/模型 API Key 升级后继续有效。

## 7. 验收 checklist（分阶段）

**Phase 1**

- [ ] 契约 8 文件与提案 §3 + F1/F2 裁决一致；`resourceWorkspaceId` 与「项目工作区」`workspaceId` 注释边界清晰；角色契约（TenantRole/myRole/readOnly/searchAccounts/成员管理）与 15 条错误文案逐字

**Phase 2/3**

- [ ] 迁移 015 幂等可重跑：每租户恰一个「全局工作区」、tenantmembers 回填齐全（personal 恒 role=admin、缺 role=0）+11 集合工作区维度 100% 归入全局工作区、providers/models 复制计数一致且原件删除、user_commit_settings 键改等价
- [ ] 索引切换完成（F3/F4）：新唯一索引就位、旧唯一索引已删、admin-api 镜像声明同步（F10）
- [ ] `x-workspace-id` 解析/校验/回退与角色/只读判定全绿；workspace-scope 插件 T-SCOPE 全绿（含 readOnly 写拦截）；global 硬约束、仅 admin 写、last-admin 保护与删除保护错误文案逐字

**Phase 4/5**

- [ ] T-WS 逐集合矩阵 × 角色两档通过；跨工作区统一 `Not found`；userId 仅剩创建者语义
- [ ] 角色权限通过：developer 无法创建工作区/成员管理/角色变更/搜索账户；admin 全部可行；last-admin 保护生效；全局工作区对 developer 只读
- [ ] 共享读口径（本 ∪ 全局）与 Commit 三段继承按矩阵通过
- [ ] 计费 owner=workspace.tenantId 全链路；`/internal/tenants*` 全绿；MCP 工具与 homeOverview 口径切换
- [ ] **新开户（`/internal/users`）自动创建全局工作区与 `tenantmembers{role:'admin'}`，重复/半完成开户幂等补齐；成员/角色变更审计可追溯**

**Phase 6/7/8/9**

- [ ] 后台创建 team 租户/成员管理（指定角色）闭环；personal 租户一切成员/多工作区/角色操作被拒绝
- [ ] cloudcontainers workspaceId 落库与回填；startHarness 下发一致
- [ ] 工作区切换器（按角色过滤）/管理页/租户成员管理页/来源徽标/继承展示/全局只读收敛就位；个人用户零感知（无切换器、恒 admin）
- [ ] admin-web team 管理入口正确（含角色指定）、工作区只读

**Phase 10**

- [ ] tests/api、tests/e2e 串行全绿；缺省上下文兼容回归通过；单测覆盖率 ≥80%；AGENTS.md 无过期口径

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| 工作区过滤遗漏/绕过 | 越权、跨工作区泄露（安全红线） | 逐集合 checklist + T-WS 真实查询中间件矩阵 + 每集合一条隔离 API 用例；跨工作区统一 `Not found`；评审 PR 逐文件核对 |
| 角色判定遗漏/越权管理（v1.1） | developer 越权管理工作区/成员/角色、全局资源被误改 | role 判定收敛单一路径（middleware 一次判定 `readOnly` + workspace-scope 插件统一写拦截 + service 入口 `requireTenantAdmin`）；T-TM/T-WS 角色两档用例；前端隐藏入口仅展示收敛（服务端强制为准） |
| last-admin 保护被并发绕过 | 租户失去全部管理员 | admin 计数前置预查 + 变更后复检回滚（裁决 12）；`LAST_ADMIN` 前后台通道同口径用例；接受极端并发最终一致 |
| providers/models 复制差错 | 供应商/模型丢失（唯一删除步骤） | 计数门禁（不等不删、中止可重跑）+ mongodump 快照 + 迁移日志计数；T-MIG15d 双向断言 |
| 索引切换顺序错误 | 迁移中途失败/写入撞唯一索引 | F3/F4 固定顺序（建新→删旧→复制）；先落 `.test.ts` 断言索引清单；admin-api 镜像声明同发布防复活（F10） |
| 命名冲突处理不当 | workflow 域数据错挂工作区 | F1 `resourceWorkspaceId` 单一命名 + 迁移断言 workflow 域字段名 + T-WS 矩阵单列；契约注释边界 |
| 共享资源被误改 | 全局配置被普通工作区破坏 | 共享型读写分离（写仅当前）+ API 用例「写全局被拒」+ 前端隐藏编辑入口 |
| 计费错扣 | 团队消费扣个人/个人扣团队 | owner 收敛 workspace.tenantId 一处 + T-BILL2/T-B2 双层断言 + 手工对账验收 |
| 缺省上下文破坏兼容 | 旧客户端/内部调用大面积红 | 缺头回退个人全局（与一期等价）+ 兼容回归用例必过 + 发布顺序约束 |
| 迁移窗口期写入 | 半完成数据 | 各步幂等判据可重跑补齐 + 启动自检异步告警（缺工作区维度计数）+ 迁移在 listen 前执行 |
| workspace-scope 无上下文误注入 | 引擎/内部链路查询被错误过滤 | 无 ALS store 不注入/不校验；引擎显式传值（裁决 10）；引擎建会话用例覆盖 |
| 新开户缺全局工作区/成员行 | 新用户登录后缺头回退失败、切换器为空、资源无法创建 | `/internal/users` 运行时 ensureGlobalWorkspace（裁决 16）+ 启动自检补「users 无 global 工作区」计数 + T-PROV 单测/API 用例 + 开户幂等半完成补齐 |
| 成员/角色变更无留痕 | 审计追溯缺失（PRD §4.2） | 统一结构化审计日志（action/operator/tenant/target/role）+ `createdBy`/`updatedAt`；后台透传 admin 用户 id（裁决 17） |
| admin-api 镜像漂移 | 后台数据失真/索引打架 | schema 注释「同步演进」+ F10 索引声明同 PR + PR review checklist |

**回滚策略**：

1. **代码层**：迁移除 providers/models 复制与旧索引删除外只增不删——回滚代码即回到一期口径，新增集合/字段闲置无副作用。
2. **数据层**：providers/models 由快照恢复（唯一删除步骤）；user_commit_settings 键改保留原 `userId/tenantId` 字段，回滚可按 `userId` 重建旧索引。
3. **契约层**：按「前端 → 服务 → 契约」逆序回退；`x-workspace-id` 头为可选头，旧前端零感知。

## 9. 相关文档

- [[../proposals/20261028-feat-multi-tenant-phase2.md]] — 本期技术提案（v1.1，含决策 D1-D13）
- [[../../product/draft/20261028-multi-tenant-phase2.md]] — 本期 PRD（v1.1）
- [[20261027-feat-multi-tenant-phase1.md]] — 多租户一期实现计划（三层帐号模型、tenant-scope、迁移 012/013/014 的直接前置）
- [[20261027-feat-commit-author-settings.md]] — Commit 设置实现计划（三段继承的扩展基座）
- [[20261018-feat-credits-billing.md]] — 费用中心实现计划（团队计费基础）
- 需求来源：[GitHub Issue #338 — 多租户二期](https://github.com/Deliay/z-agent-gear/issues/338)
- 需求总 PR：[PR #339](https://github.com/Deliay/z-agent-gear/pull/339)（base: main，本计划随该 PR 提交）
- 开发规范：[[../common-rules.md]]、[[../backend-rules.md]]、[[../frontend-rules.md]]

---

## 附录 A：文件变更总览

```text
contracts/
├── workspace.graphql                   # 新增（Workspace/TenantRole/CRUD/成员管理/租户成员管理/searchAccounts）
├── admin-tenant.graphql                # AdminWorkspace + team 创建/成员管理（含角色）
├── llm.graphql                         # Provider/Model +workspaceId（读写口径注释）
├── github.graphql                      # CommitSettingsSource + source；GitHubAccount +workspaceId
├── cloud-host.graphql                  # CloudHost +workspaceId
├── workflow.graphql                    # 三类型 +resourceWorkspaceId（F1）；项目工作区注释澄清
├── cloud-controller-websocket.md       # 附录 A harness 参数 +workspaceId（F2）
└── controller-workspace.graphql / agent-session.graphql  # 注释澄清（不改名）

servers/agent-api/src/
├── models/tenant-member.ts             # 新增 tenantmembers（含 role，last-admin 保护事实源）
├── models/workspace.ts                 # 新增 workspaces（global/normal + 部分唯一索引）
├── models/workspace-member.ts          # 新增 workspacemembers（global 恒无行）
├── models/*.ts（11 集合）               # +workspaceId（workflow 域 resourceWorkspaceId，F1/F8）
├── models/cloud-container.ts           # 只读镜像 +workspaceId
├── models/workspace-isolation.test.ts  # T-WS 矩阵 × 角色两档（对照 tenant-isolation）
├── middleware/auth.ts                  # x-workspace-id 解析 + 角色/只读判定 + AuthContext.workspaceAccess + ALS
├── services/workspace-context.ts       # 新增 AsyncLocalStorage 上下文（F7，含 role/readOnly）
├── services/workspace-scope.ts         # 新增 Mongoose 插件（角色感知/独占/共享/builtinVisible/只读写拦截/字段名选项）
├── services/workspace-service.ts       # 新增 CRUD/成员管理（仅 admin）/可见集/删除保护（无认领）
├── services/tenant-member-service.ts   # 新增 searchAccounts/租户成员增删/角色变更/last-admin 保护
├── services/commit-settings-service.ts # 键改 workspaceId + 三段继承 + source + 只读拦截
├── services/billing-client.ts          # owner=workspace.tenantId（F5）
├── services/cloud-host-service.ts      # 归属推导链 + startHarness 下发 workspaceId
├── services/{provider,model,github}.ts # 共享读口径（本 ∪ 全局）、写仅当前（只读拦截）
├── services/workflow/{template,configured,instance,engine}.ts  # resourceWorkspaceId 过滤
├── services/mcp-dispatch.ts / workflow/{admin-tools,tool-handlers}.ts  # 会话工作区口径（F11）
├── graphql/{schemas,resolvers}/workspace.ts  # 新增（工作区+租户成员管理；字段级 resolver 登记 index.ts）
├── graphql/resolvers/{auth,home,billing,cloud-host,...}.ts  # 上下文过滤与 owner 切换
├── routes/internal-tenants.ts          # 新增（+index.ts 挂载；含 role/operatorId 审计）
├── routes/internal-users.ts            # 变更：新开户补全局工作区 + tenantmembers(role=admin)（裁决 16）
├── migrations/015-team-workspaces.ts(+test)  # 工作区化迁移（含索引切换与复制门禁、scope 缺失行同口径复制）
├── services/tenant-self-check.ts       # 自检扩展工作区维度
└── AGENTS.md                           # 工作区模型与隔离口径段

servers/admin-api/src/
├── models/{tenant-member,workspace,workspace-member}.ts  # 只读镜像（新增）
├── models/{provider,model}.ts          # 镜像补字段 + 索引声明同步（F10）
├── graphql/schemas/tenant.ts           # AdminWorkspace + 三 mutation
├── graphql/resolvers/tenant.ts         # team 创建/成员管理转发 + tenantmembers 展开 + 工作区只读
└── graphql/resolvers/tenant.test.ts    # T-TT 系列

servers/cloud-controller/src/
├── models/cloud-container.ts           # +workspaceId
├── migrations/002-cloudcontainers-workspace-id.ts(+test)
├── routes/internal-api.ts              # parseHarnessRequest +workspaceId 回退解析（F2）
└── AGENTS.md                           # workspaceId 口径段

apps/agent-web/src/
├── stores/workspace.ts                 # 新增（当前工作区 + myTenants 角色 + zag:current-workspace 持久化）
├── lib/apollo.ts                       # x-workspace-id 注入
├── components/Sidebar.tsx / pages/MainLayout.tsx  # 工作区切换器（按角色过滤）
├── pages/WorkspacePage.tsx + App.tsx   # 工作区管理页与路由（仅 admin）
├── pages/TenantMembersPage.tsx + App.tsx  # 租户成员管理页（仅 admin，searchAccounts/角色变更/last-admin 提示）
├── pages/SettingsPage.tsx / components/settings/*  # 来源徽标 + Commit source + 全局只读收敛
└── graphql/*.ts + __tests__            # 契约同步与断言

apps/admin-web/src/
├── pages/TenantsPage.tsx               # 类型列 + 创建团队租户
├── pages/TenantDetailPage.tsx          # 成员管理（指定角色）+ 工作区只读列表
└── graphql/*.ts + pages/__tests__/*

tests/api/src/
├── agent-api/workspace.test.ts         # 新增 T-WS-API 系列（核心验收）
├── agent-api/multi-tenant.test.ts      # 扩展 T-MT3 兼容回归
├── admin-api/tenant-team.test.ts       # 新增 T-TT 系列
├── admin-api/billing.test.ts           # T-B2 团队计费
└── cloud-controller/internal-api.test.ts  # harness workspaceId

tests/e2e/src/
├── workspace.spec.ts                   # 新增 E2E-WS1~6（含租户成员管理与角色）
└── admin-team-tenant.spec.ts           # 新增 E2E-TT1~3

docs/engineering/AGENTS.md              # plan 索引追加（随本文件提交）
各目录 AGENTS.md                         # 同步面收口（§3.2 裁决 14）
```

## 附录 B：计划期核对记录

### B.1 代码事实核对（2026-10-28；B-1~B-12 基于需求总分支 88d104f1，B-13 基于 6d5860cd，B-14/B-15 基于 3ff0ffa8）

| # | 核对点 | 观测 | 结论 |
|---|--------|------|------|
| B-1 | 迁移编号占用 | agent-api 001-014（011 双占用先例，最新 012/013/014）；cloud-controller 001 | 015 / 002 无冲突 |
| B-2 | `workflowinstances.workspaceId` | `models/workflow-instance.ts:77` ref 'ControllerWorkspace' required；契约/前端/MCP 工具强消费 | F1 命名冲突定稿（工作流域 `resourceWorkspaceId`） |
| B-3 | providers/models 现状 | 无 userId/tenantId，仅 `scope`；`services/provider.ts:8-10` 全体前台共享行；`models/provider.ts:21` `{scope,name}` 唯一 | F3 索引/复制顺序定稿 |
| B-4 | `user_commit_settings` 唯一声明 | 字段级 `userId unique` + schema `{tenantId,userId}` 唯一 + 迁移 011 `uniq_user_commit_setting` 三处 | F4 切换口径定稿 |
| B-5 | 计费调用面 | `cloud-host-service.ts:255/338` ownerId=userId；`resolvers/billing.ts:45/101/122/131` user.tenantId | F5 收敛 workspace.tenantId |
| B-6 | 作用域插件 guard | `tenant-scope.ts:126` userId+tenantId 同在即生效 | F6 三集合不挂插件 |
| B-7 | 工作流模板内置行 | `workflow-template.ts:33-41` userId 可空 + isBuiltin；`template.ts:180-233` `$or:[{userId},{isBuiltin:true}]` | F9 builtinVisible 特例 |
| B-8 | String 口径集合 | `github-account.ts:5-6`、`user-commit-setting.ts:20-21` userId/tenantId 为 String | F8 类型对齐 |
| B-9 | admin-api 镜像索引 | `admin-api models/provider.ts:21` 声明同集合 `{scope,name}` 唯一 | F10 同发布同步 |
| B-10 | MCP/首页口径 | `mcp-dispatch.ts:95-112`、`tool-handlers.ts:180` userId 归属校验、`home.ts:50` userId 聚合 | F11 切换落点 |
| B-11 | cloudcontainers | `cloud-container.ts:97/100` userId/tenantId 均 String default null；`internal-api.ts:242-264` parseHarnessRequest tenantId 回退=userId 先例 | Phase 7 回退解析同款口径 |
| B-12 | 三集合计数语义 | 现 `Tenant.memberCount`=`User.countDocuments({tenantId})`（`resolvers/auth.ts:89`） | 统一走 tenantmembers 单一事实源（等价） |
| B-13 | 角色体系增补（v1.1） | `tenantmembers` 为本期新增集合（role 字段随建模落地）；`searchAccounts` 依赖 `accounts.username`（一期迁移 012 后登录名在 accounts）；`tenant-member-service` 无既有同名服务 | 无新增事实校正，按提案 v1.1 §2.3/§3.1/决策 D11-D13 落地 |
| B-14 | 新开户链路（v1.2） | `routes/internal-users.ts:120-168` 创建 accounts/users/tenants + 计费账户，**无工作区/成员行写入**；`Tenant.create` 仅此一处与迁移 012 出现 | 补 `ensureGlobalWorkspace`（裁决 16），否则二期上线后新开户用户无全局工作区 |
| B-15 | providers/models scope 缺失（v1.2） | `services/provider.ts:8-10` `USER_SCOPE_FILTER` 与 `services/model.ts:8-11` `AVAILABLE_MODELS_FILTER` 均以 `$exists:false` 兼容无 scope 存量行 | 迁移 015 复制范围同口径（F3），避免孤儿行 |
