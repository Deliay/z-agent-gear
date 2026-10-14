---
description: 云控制器管理后台一期 - 实现计划，从技术提案拆解的契约先行分阶段任务（admin-api 管理员认证 + 全局供应商/模型 + 基础镜像 CRUD、admin-web 后台与可设置 endpoint、agent-api scope 改造、容器化与 CI）与测试覆盖计划
type: Permanent
---

# 云控制器管理后台一期 - 实现计划

**关联 Proposal**: `proposals/20261014-feat-admin-console.md`（v1.2）
**关联 PRD**: `docs/product/draft/20261014-admin-console.md`（v1.1）
**feat-branch**: `feat/admin-console`
**开发分支**: `servers/admin-console`、`apps/admin-console`、`tests/admin-console`（均基于 `feat/admin-console`，完成后各自提 PR 回 `feat/admin-console`）
**创建日期**: 2026-10-14
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约先行（contracts/ 三份新增 + llm.graphql 补 scope/ConfigScope）
  └── Phase 2: admin-api 项目骨架 + 管理员认证（种子/登录/强制改密/JWT/守卫）
       └── Phase 3: admin-api 全局供应商/模型 + 基础镜像（scope=global 全链路）
            └── Phase 4: agent-api scope 改造（全局模型对用户生效 + 写保护 + 索引迁移）
                 └── Phase 5: admin-web 骨架与认证链路（endpoint 四级解析 + 登录/改密 + 守卫布局）
                      └── Phase 6: admin-web 模型配置页 + 基础镜像页
                           └── Phase 7: 编排与容器化（Aspire + Dockerfile×2 + nginx + CI×2）
                                └── Phase 8: 测试补全（tests/api admin 套件 + agent-api 回归 + tests/e2e）
                                     └── Phase 9: 全量回归 + PRD 验收核对 + PR 回需求总分支
```

依赖说明：Phase 1 契约是全部实现的输入；Phase 2→3 为 admin-api 内部严格顺序（认证守卫是业务 resolver 的前置）；Phase 4 依赖 Phase 3 的 scope 语义定型（同一 `providers`/`models` 集合两处 schema 必须同步）；Phase 5 依赖 Phase 2 的认证契约即可先行开发，Phase 6 依赖 Phase 3 的业务契约；Phase 7 依赖 Phase 2/5 的项目骨架存在；Phase 8 在各实现分支覆盖单测（TDD 随行）的基础上收口集成/E2E；Phase 9 收口。按 `z-coding` 的子项目并行实现模式：`servers/admin-console` 承载 contracts + admin-api + agent-api + aspire + CI，`apps/admin-console` 承载 admin-web，`tests/admin-console` 承载 tests/api + tests/e2e（在两支实现合并后切出）。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写测试（RED）再实现（GREEN）；编码前加载 `docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端 Phase）与 `docs/engineering/frontend-rules.md`（前端 Phase）。

关键约束（提案 §5.2/§6.1，实现期不得回退）：

- **契约先行**：`contracts/admin-auth.graphql`、`admin-llm.graphql`、`admin-base-image.graphql` 先于实现独立提交，与提案 §3.1 逐字段对齐；`contracts/llm.graphql` 同步补 `ConfigScope` 与 `Provider.scope` / `Model.scope`。
- **resolver 合并清单登记**：admin-api 与 agent-api 新增的 Query/Mutation/类型级字段 resolver 必须登记进各自 `graphql/resolvers/index.ts`（`backend-rules.md` 显性陷阱：漏登记时单测直引 resolver 对象不报错，但线上不生效）。
- **前端 GraphQL 类型全手写**：admin-web 无 codegen，`graphql/` 下查询/变更/类型全部手写并与契约人工对齐（对齐 agent-web 模式）。
- **scope 机制语义固定**：admin-api 的 Provider/Model 全部读写强制 `scope: 'global'`；agent-api 读路径并入 `scope: 'global'` 且 `isEnabled: true` 的模型，写路径只允许 `scope: 'user'` 数据；Mongoose schema `scope` 默认 `user`，存量数据零迁移。
- **级联与校验行为与用户侧一致**（提案 §3.1）：保存供应商前连通性校验失败不保存（`llmApiService.fetchModels` 失败即中止）、凭据 AES-256-GCM 加密存储 + 前 3 后 4 脱敏返回、删除供应商级联删除其模型、禁用供应商级联禁用其模型、编辑时凭据留空保留旧值。
- **认证安全**：不开放任何注册 mutation；bcrypt `SALT_ROUNDS=10`；独立 `ADMIN_JWT_SECRET`（与用户 JWT 互不认）；JWT 有效期 7d；改密成功签发新 token。
- **强制改密双守卫**：前端 `ProtectedRoute` 锁定 + 后端业务 resolver 在 `mustChangePassword=true` 时拒绝（见计划期裁决 2）。
- **endpoint 可设置（提案 §5.2 实现点 7）**：`apps/admin-web/src/lib/api-base.ts` 四级优先级——① 登录页「服务器地址」设置（`/health` 探测通过才存 `localStorage`，可改回）→ ② 容器运行时 `window.__ADMIN_CONFIG__.apiUrl`（nginx `/docker-entrypoint.d/` 脚本按 `ADMIN_API_URL` 生成 `config.js`）→ ③ 构建期 `VITE_ADMIN_API_URL` → ④ 同源兜底（空串）；线上 `https://admin.zag.fffdan.com` 由部署侧反代 `/graphql` 至 admin-api，`CORS_ORIGIN` 配置为该域名。
- **admin-web 部署形态**：nginx 容器（`nginx:1.27-alpine`），`nginx.conf` 必须含 SPA history fallback（`try_files $uri $uri/ /index.html`）；nginx 不硬编码 `/graphql` 上游。
- **Apollo v4 轮询/加载陷阱**（`frontend-rules.md`）：加载分支一律 `loading && !data`，不得 `if (loading) return <Spinner/>`。
- **错误映射保持一致**：E11000 → `Provider name already exists` / `Model name already exists for this provider` / `Base image name already exists`；连通性失败 → 「供应商连通性测试失败…」；未认证 → `UNAUTHENTICATED`（`Not authenticated`）。
- **测试纪律**：单元测试覆盖率 ≥ 80%；API 与 E2E 套件串行执行（`common-rules.md` 测试陷阱：两套套件不并行共享服务）；测试服务只用 Aspire 编排（`tests/api`、`tests/e2e` AGENTS.md）。

计划期裁决（提案留白的实现细节，实现期按此执行）：

1. **`providers.name` 唯一性改为按 scope 唯一**：现状 `name` 为集合级唯一索引，全局与用户供应商同名会互相阻塞。两处 schema（admin-api `models/provider.ts`、agent-api `models/provider.ts`）同步把唯一声明改为复合唯一 `{ scope: 1, name: 1 }`；由 agent-api 现有迁移机制新增 `migrations/004-provider-scope-name-index.ts`（幂等：drop 旧 `name_1`，create `{scope:1,name:1}` unique）并在 `index.ts` 注册。`models` 的 `{providerId, name}` 复合唯一不变（providerId 已隐含 scope）。`base_images.name` 保持集合级唯一（PRD 明确同名禁止）。
2. **强制改密的后端拦截口径**：`mustChangePassword=true` 时仅放行 `adminLogin` / `changeAdminPassword` / `adminMe`，其余 Query/Mutation 返回 `MUST_CHANGE_PASSWORD` 错误（前端路由守卫之外的双保险，满足 PRD「完成修改前无法访问其他任何功能」）。
3. **`ConfigScope` enum 定义在 `contracts/llm.graphql`**（`enum ConfigScope { user global }`），`admin-llm.graphql` 复用；`Provider` / `Model` 类型统一增加 `scope: ConfigScope!`（用户侧与后台侧同形）。
4. **集合命名显式化**：`admin_users`、`base_images` 为提案指定集合名，Mongoose model 声明时显式传入 collection 名（默认推导为 `adminusers` 会与提案不符）。
5. **用户侧对全局模型的写操作返回明确文案**：agent-api 写路径拒绝 `scope: 'global'` 数据时返回「全局配置请在管理后台修改」（而非笼统 not found），降低用户侧困惑；本期不改 agent-web UI（范围外，提案 §7 修改清单不含 agent-web），global 模型在用户侧设置页只读展示（含 scope 标识字段，由前端自行决定展示）。
6. **改密后旧 token 不主动失效**：JWT 无状态，签发新 token 即可（与提案一致）；后续如需强制下线再引入黑名单。
7. **端口约定**：admin-api dev 端口 10003（Aspire 注入 `PORT`）、config 默认 4002、publish 8002；admin-web dev 为 Vite dev server（Aspire `AddViteApp`），publish 为 nginx 容器 80。
8. **admin-web 不引入 cookie/SSE**：token 仅存 `localStorage`（`admin_token` / `admin_user`），无需 agent-web 的 cookie 兜底。

---

## Phase 1: 契约变更（contracts/）

开发分支：`servers/admin-console`（基于 `feat/admin-console`）。本 Phase 变更独立提交（`docs(contracts): ...`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/admin-auth.graphql` | 新增 | `AdminUser { id, username, mustChangePassword, createdAt, updatedAt }`、`AdminAuthPayload { token, admin }`；`Query.adminMe: AdminUser`；`Mutation.adminLogin(username, password): AdminAuthPayload!`、`changeAdminPassword(oldPassword, newPassword): AdminAuthPayload!`（注释注明「不存在注册 mutation」），与提案 §3.1 逐字段一致 |
| `contracts/admin-llm.graphql` | 新增 | 复用 `llm.graphql` 的 Provider/Model/ProviderInput/CustomModelInput/ProviderBatchPayload 语义；`Query.adminProviders / adminModels / adminModelsByProvider(providerId)` 仅 `scope=global`；`Mutation.createGlobalProvider/updateGlobalProvider/deleteGlobalProvider/toggleGlobalProvider/batchEnableGlobalProviders/batchDisableGlobalProviders/batchDeleteGlobalProviders/createGlobalCustomModel/deleteGlobalCustomModel/toggleGlobalModel/updateGlobalModelSortOrder`；注释注明连通性校验、脱敏、级联规则 |
| `contracts/admin-base-image.graphql` | 新增 | `BaseImage { id, name, description, dockerfile, createdAt, updatedAt }`、`BaseImageInput`；`Query.baseImages / baseImage(id)`；`Mutation.createBaseImage/updateBaseImage/deleteBaseImage`（注释注明 name 唯一、重名报错） |
| `contracts/llm.graphql` | 修改 | 新增 `enum ConfigScope { user global }`；`Provider`、`Model` 类型增加 `scope: ConfigScope!`（注释：`user` 为用户侧配置、`global` 为管理后台全局配置，全局启用模型对所有用户可用） |

全部 admin-* 契约注明鉴权要求：所有 Query/Mutation 需 `Authorization: Bearer <admin JWT>`，未认证返回 `UNAUTHENTICATED`。

### 验收 checklist

- [ ] 三份新增契约与提案 §3.1 逐字段一致；`llm.graphql` 变更向后兼容（旧查询语法合法，仅增字段）
- [ ] 契约变更独立提交，后续 Phase 才动实现代码
- [ ] 无注册相关 mutation 出现在任何契约

---

## Phase 2: admin-api 骨架 + 管理员认证

开发分支：`servers/admin-console`。TDD 顺序：先写 `services/auth.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/package.json` | 新增 | `name: admin-api`、`"type": "module"`；依赖版本对齐 agent-api（express ^5、graphql-yoga ^5、mongoose ^9、@graphql-tools/schema、jsonwebtoken ^9、bcryptjs ^3、dotenv、cors、graphql ^16、graphql-type-json、openai、@anthropic-ai/sdk）；devDeps（typescript ~6、tsx、vitest、@vitest/coverage-v8、@types/*）；scripts：`dev`=tsx watch、`build`=tsc、`start`=node dist、`test`/`test:coverage` |
| `servers/admin-api/tsconfig.json` | 新增 | strict，ESM，对齐 agent-api |
| `servers/admin-api/src/config/index.ts` | 新增 | `port`←`PORT`（默认 4002）、`mongodbUri`←`MONGODB_URI`、`adminJwtSecret`←`ADMIN_JWT_SECRET`、`credentialEncryptionKey`←`CREDENTIAL_ENCRYPTION_KEY`、`corsOrigin`←`CORS_ORIGIN`（默认 `*`） |
| `servers/admin-api/src/models/admin-user.ts` | 新增 | 集合 `admin_users`（显式 collection 名）：`username` unique required、`passwordHash` required、`mustChangePassword` default `true`、timestamps |
| `servers/admin-api/src/middleware/auth.ts` | 新增 | `authenticateAdmin(request)`：Bearer token → `verifyToken`（`ADMIN_JWT_SECRET`）→ 查 `admin_users`，返回 `{ id, username, mustChangePassword }` 或 `null`（复刻 agent-api `authenticateUser` 模式） |
| `servers/admin-api/src/services/auth.ts` | 新增 | `seedAdmin()`（幂等：`admin_users` 非空跳过；插入 `admin`/`admin1234567` bcrypt 哈希、`mustChangePassword: true`）；`login(username, password)`；`changePassword(adminId, oldPassword, newPassword)`（新密码长度 ≥ 10，成功后 `mustChangePassword: false`）；`signToken`/`verifyToken`（7d）；bcrypt `SALT_ROUNDS=10` |
| `servers/admin-api/src/graphql/schemas/auth.ts`、`schemas/index.ts` | 新增 | 对齐 `contracts/admin-auth.graphql`；`baseTypeDefs` 空 `Query`/`Mutation` 扩展模式（对齐 agent-api） |
| `servers/admin-api/src/graphql/resolvers/auth.ts`、`resolvers/index.ts` | 新增 | `adminLogin`/`changeAdminPassword`/`adminMe`；错误映射（密码错误提示不泄露帐号存在性以外信息）；`resolvers/index.ts` 合并登记 |
| `servers/admin-api/src/index.ts` | 新增 | Express + `createYoga`（`/graphql`，context 注入 `currentAdmin`）+ `/health`；启动流程 `await seedAdmin()`；`app.listen` |
| `servers/admin-api/src/services/auth.test.ts` | 新增 | 单测 T-A*（vitest，mock mongoose 或内存库，与 agent-api 单测模式一致） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-A1 | `seedAdmin` 重复执行 | 幂等，仅一条 admin 记录，`mustChangePassword=true` |
| T-A2 | `adminLogin('admin','admin1234567')` | 返回 token + `mustChangePassword: true` |
| T-A3 | 密码错误登录 | 拒绝，错误信息不区分「帐号不存在/密码错误」以外的内容 |
| T-A4 | `changeAdminPassword` 成功 | `mustChangePassword=false`、旧密码失效、新密码可登录、返回新 token |
| T-A5 | 新密码长度 < 10 / 两次不一致（前端） | 拒绝并给出强度提示 |
| T-A6 | 无 token / 用户侧 JWT / 伪造 token | `UNAUTHENTICATED`（admin/user token 不可互认） |
| T-A7 | `mustChangePassword=true` 时调业务 mutation | `MUST_CHANGE_PASSWORD`；`adminMe`/`changeAdminPassword` 正常放行 |

### 命令参考

```bash
cd servers/admin-api && npx vitest run src/services/auth.test.ts
cd servers/admin-api && npm run build   # tsc strict 通过
```

### 验收 checklist

- [ ] T-A1 ~ T-A7 全部通过
- [ ] 无注册入口：schema 中无 signup/register 类 mutation
- [ ] 密码 bcrypt 存储、凭据不落明文；`ADMIN_JWT_SECRET` 未配置时启动即报错（不静默）
- [ ] `resolvers/index.ts` 已登记全部 resolver

---

## Phase 3: admin-api 全局供应商/模型 + 基础镜像

开发分支：`servers/admin-console`。TDD 顺序：先写 `services/provider.test.ts` / `model.test.ts` / `base-image.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/models/provider.ts` | 新增 | 复刻 agent-api schema（name/type/endpoint/credentialType/encryptedCredential/isEnabled + timestamps）+ `scope: { type: String, enum: ['user','global'], default: 'user', index: true }`；唯一约束改 `{scope:1, name:1}` 复合唯一（裁决 1） |
| `servers/admin-api/src/models/model.ts` | 新增 | 复刻 agent-api schema + `scope` 字段；`{providerId, name}` 复合唯一不变 |
| `servers/admin-api/src/models/base-image.ts` | 新增 | 集合 `base_images`（显式 collection 名）：`name` unique required、`description`、`dockerfile` required、timestamps |
| `servers/admin-api/src/services/crypto.ts` | 新增 | 复刻 agent-api `crypto.ts`（AES-256-GCM，`encrypt`/`decrypt`，`CREDENTIAL_ENCRYPTION_KEY`） |
| `servers/admin-api/src/services/llm-api.ts` | 新增 | 复刻 agent-api `LLMAPIService.fetchModels`（openai/@anthropic-ai/sdk，10s 超时） |
| `servers/admin-api/src/services/provider.ts` | 新增 | 复刻 agent-api `ProviderService`（create 连通性校验 + 同步模型、update 空凭据保留 + 变更后级联重同步、delete/toggle/batch* 级联、`maskCredential` 前 3 后 4），全部查询/写入强制 `scope: 'global'`，创建/同步的模型写 `scope: 'global'` |
| `servers/admin-api/src/services/model.ts` | 新增 | 复刻 `ModelService`（`findAll`/`findByProviderId`/`createCustom`/`delete` 仅自定义/`toggle` 拒绝禁用供应商下模型/`updateSortOrder`），强制 `scope: 'global'` |
| `servers/admin-api/src/services/base-image.ts` | 新增 | `list/get/create/update/delete`；重名 → `Base image name already exists` |
| `servers/admin-api/src/graphql/schemas/provider.ts`、`model.ts`、`base-image.ts`、`schemas/index.ts` | 新增 | 对齐 `contracts/admin-llm.graphql` / `admin-base-image.graphql`（含 `ConfigScope` 与 `scope` 字段） |
| `servers/admin-api/src/graphql/resolvers/provider.ts`、`model.ts`、`base-image.ts`、`resolvers/index.ts` | 新增 | 薄 resolver + `currentAdmin`/`MUST_CHANGE_PASSWORD` 守卫（裁决 2）+ 错误映射；`Provider.models`、`Model.provider` 类型级字段 resolver 登记 `resolvers/index.ts` |
| `servers/admin-api/src/services/*.test.ts` | 新增 | 单测 T-P* / T-M* / T-B* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-P1 | `createGlobalProvider` 连通性校验失败 | 不落库，返回连通性错误文案 |
| T-P2 | 创建成功 | 自动同步模型列表（`scope=global`、`isCustom=false`、`sortOrder` 连续）；返回凭据脱敏（前 3 后 4） |
| T-P3 | `updateGlobalProvider` 凭据留空 | 保留旧凭据；凭据/type/endpoint 变更触发模型级联重同步 |
| T-P4 | `deleteGlobalProvider` | 级联删除其下全部模型 |
| T-P5 | `toggleGlobalProvider` 禁用 | 级联禁用其模型；启用同理 |
| T-P6 | batch enable/disable/delete | 计数正确、级联正确 |
| T-P7 | 重名创建 | `Provider name already exists`（同 scope 内唯一；与 user 侧同名可并存，裁决 1） |
| T-M1 | `createGlobalCustomModel` | `isCustom=true`、`sortOrder` 追加；同 provider 重名报错 |
| T-M2 | `deleteGlobalCustomModel` 删同步模型 | 拒绝（仅自定义可删） |
| T-M3 | `toggleGlobalModel` 在供应商禁用时 | 拒绝 |
| T-M4 | `updateGlobalModelSortOrder` | 按序持久化 |
| T-B1 | `createBaseImage` / `updateBaseImage` / `deleteBaseImage` | CRUD 正常、Dockerfile 文本原样存取 |
| T-B2 | 重名创建 | `Base image name already exists`，不保存 |

### 命令参考

```bash
cd servers/admin-api && npx vitest run src/services
```

### 验收 checklist

- [ ] T-P* / T-M* / T-B* 全部通过
- [ ] 所有读写带 `scope: 'global'` 条件，单测覆盖「user 数据不出现在 admin 查询、admin 不写 user 数据」
- [ ] 凭据脱敏返回（全量单测断言不含明文）；连通性校验失败必不落库

---

## Phase 4: agent-api scope 改造（全局模型对用户生效 + 写保护）

开发分支：`servers/admin-console`。TDD 顺序：先写 `services/model.test.ts` / `tests/api` 增量用例（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/provider.ts` | 修改 | 增加 `scope` 字段（default `user`）；`name` unique → `{scope:1, name:1}` 复合唯一（裁决 1，与 admin-api 同步演进） |
| `servers/agent-api/src/models/model.ts` | 修改 | 增加 `scope` 字段（default `user`）；`{providerId, name}` 不变 |
| `servers/agent-api/src/migrations/004-provider-scope-name-index.ts` | 新增 | 幂等迁移：drop `providers.name_1`、create `{scope:1, name:1}` unique；`index.ts` 注册进 `runMigrations` |
| `servers/agent-api/src/graphql/schemas/provider.ts`、`model.ts` | 修改 | `Provider`/`Model` 类型补 `scope: ConfigScope!`，新增 `enum ConfigScope { user global }`（对齐 `contracts/llm.graphql`） |
| `servers/agent-api/src/services/model.ts` | 修改 | `findAll`/`findByProviderId`：用户侧返回 `scope: 'user'` 全量（维持现状）∪ `scope: 'global'` 且 `isEnabled: true`；写方法（`createCustom`/`delete`/`toggle`/`updateSortOrder`）校验目标 `scope === 'user'`，否则返回 null/报错「全局配置请在管理后台修改」（裁决 5） |
| `servers/agent-api/src/services/provider.ts` | 修改 | `create`/`update` 写入 `scope: 'user'`；写方法（update/delete/toggle/batch*）校验目标 `scope === 'user'`（用户不可改动全局供应商）；`findAll` 维持仅 user 供应商（现状语义，settings 页不展示全局供应商卡片） |
| `servers/agent-api/src/services/model.test.ts` 等 | 修改 | 增量单测：查询并入/排除逻辑、写保护 |
| `tests/api/src/agent-api/llm.test.ts` | 修改 | 增量 API 测试 T-SC*（真实 Mongo，混合 scope 数据） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-SC1 | 全局启用模型 + 用户模型混合 | `models` 返回两者；全局禁用模型不返回 |
| T-SC2 | `modelsByProvider`（全局 provider） | 仅返回该 provider 下启用的全局模型 |
| T-SC3 | 用户对全局模型 `toggleGlobalModel` 等价用户侧写操作 | 拒绝并返回「全局配置请在管理后台修改」 |
| T-SC4 | 用户对全局供应商 update/delete/toggle/batch | 拒绝 |
| T-SC5 | `providers` 查询 | 仅返回 `scope=user` 供应商（回归） |
| T-SC6 | 存量数据（无 scope 字段） | 默认按 `user` 处理，行为零变化（兼容锚点） |
| T-SC7 | 索引迁移后同名跨 scope | user 与 global 可同名并存；同 scope 重名仍报 `Provider name already exists` |
| T-SC8 | 用户侧 `createProvider` | 写入 `scope: 'user'` |

### 命令参考

```bash
cd servers/agent-api && npx vitest run src/services/model.test.ts
aspire start && aspire wait agent-api
cd tests/api && API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npm test -- llm
```

### 验收 checklist

- [ ] T-SC1 ~ T-SC8 全部通过
- [ ] 迁移 004 幂等可重复执行；`providers` 索引状态符合预期（`{scope,name}` unique，无 `name_1`）
- [ ] 存量用户侧行为零变化（T-SC6 回归锚点）；agent-api GraphQL 类型与 `contracts/llm.graphql` 一致

---

## Phase 5: admin-web 骨架与认证链路

开发分支：`apps/admin-console`。TDD 顺序：先写 `api-base.test.ts` 与路由守卫组件测试（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/admin-web/package.json` | 新增 | `name: admin-web`；依赖对齐 agent-web（react ^19、react-router-dom ^7、@apollo/client ^4、graphql、@base-ui/react、shadcn、lucide-react、sonner、@dnd-kit/*、clsx、tailwind-merge、class-variance-authority、tw-animate-css）；devDeps（vite ^8、typescript ~6、tailwindcss ^4 + @tailwindcss/vite、vitest、jsdom、@testing-library/react、eslint）；scripts：`dev`/`build`（tsc -b && vite build）/`lint`/`test`/`preview` |
| `apps/admin-web/tsconfig*.json`、`components.json`、`src/index.css` | 新增 | 对齐 agent-web（strict、`@` alias、Tailwind v4 CSS-first、shadcn `base-nova` 风格） |
| `apps/admin-web/vite.config.ts` | 新增 | dev 代理 `/graphql` → `http://localhost:10003`（Aspire 注入 `VITE_ADMIN_API_URL` 优先）；vitest 配置（jsdom） |
| `apps/admin-web/index.html` | 新增 | `<script src="/config.js"></script>` 先于入口脚本（运行时注入点，找不到时静默回落） |
| `apps/admin-web/src/lib/api-base.ts` | 新增 | 四级优先级解析 admin-api 地址（裁决 8 与关键约束）：① `localStorage['zag:admin-api-base']`（登录页设置、`/health` 探测通过才保存、可清除恢复）→ ② `window.__ADMIN_CONFIG__.apiUrl`（容器运行时注入）→ ③ `import.meta.env.VITE_ADMIN_API_URL` → ④ 同源 `''`；导出 `resolveAdminApiBase()` / `getAdminApiBase()` / `setAdminApiBase()` / `clearAdminApiBase()`；`probe(endpoint)` = `GET <endpoint>/health` 2s 超时 |
| `apps/admin-web/src/lib/api-base.test.ts` | 新增 | 四级优先级逐级断言、探测失败不保存、清除恢复默认 |
| `apps/admin-web/src/lib/apollo.ts` | 新增 | `createApolloClient(apiBase)`：`HttpLink ${apiBase}/graphql`、`authLink` 读 `localStorage['admin_token']`、`errorLink` 对 `UNAUTHENTICATED` 清登录态跳 `/login`、对 `MUST_CHANGE_PASSWORD` 跳 `/change-password` |
| `apps/admin-web/src/stores/auth.ts`、`stores/AuthProvider.tsx` | 新增 | Context 模式（对齐 agent-web）：`{ admin, token, mustChangePassword, login, logout }`，持久化 `admin_token`/`admin_user`（localStorage） |
| `apps/admin-web/src/pages/LoginPage.tsx` | 新增 | 帐号/密码登录（仅登录无注册）、「服务器地址」设置入口（`/health` 探测 → 保存/改回默认）、错误提示；登录成功按 `mustChangePassword` 分流 |
| `apps/admin-web/src/pages/ChangePasswordPage.tsx` | 新增 | 新密码 + 确认（前端校验一致 + 长度 ≥ 10），成功后换新 token 进入后台；不渲染侧边栏 |
| `apps/admin-web/src/components/AdminLayout.tsx` | 新增 | 左侧边栏（「模型配置」「基础镜像」入口 + 当前项高亮 + 退出登录）+ 右侧 `<Outlet>` |
| `apps/admin-web/src/components/ProtectedRoute.tsx` | 新增 | 未登录 → `/login`；`mustChangePassword` → `/change-password`（PRD 3.5 直接访问其他地址也被拉回） |
| `apps/admin-web/src/App.tsx`、`src/main.tsx` | 新增 | 路由：`/login`、`/change-password`、受保护 `AdminLayout` 下 `/models`（默认）、`/base-images`；`main.tsx` 先 `await resolveAdminApiBase()` 再建 ApolloClient |
| `apps/admin-web/src/graphql/` | 新增 | 手写 `queries.ts`/`mutations.ts`/`types.ts`（auth 部分先行，业务部分 Phase 6） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-F1 | api-base 四级优先级 | 逐级覆盖正确（localStorage > window config > env > 同源） |
| T-F2 | 登录页设置服务器地址 | 探测通过保存并生效；失败提示且不保存；可一键改回 |
| T-F3 | 未登录访问 `/models` | 重定向 `/login` |
| T-F4 | `mustChangePassword` 访问 `/models` | 重定向 `/change-password`，改密页无侧边栏 |
| T-F5 | 改密两次不一致 / 长度不足 | 不提交并提示；成功后进入 `/models` |
| T-F6 | 退出登录 | 清登录态回 `/login` |
| T-F7 | 登录页无任何注册入口 | 文案/元素断言 |

### 命令参考

```bash
cd apps/admin-web && npx vitest run && npm run build && npm run lint
```

### 验收 checklist

- [ ] T-F1 ~ T-F7 全部通过
- [ ] TypeScript strict 编译通过；无跨项目 import（组件从 agent-web 复制后独立演进）
- [ ] 加载态写法为 `loading && !data`（Apollo v4 陷阱）

---

## Phase 6: admin-web 模型配置页 + 基础镜像页

开发分支：`apps/admin-console`。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/admin-web/src/pages/ModelConfigPage.tsx` | 新增 | 「模型配置」页：供应商区 + 可用模型区（数据源 `adminProviders`/`adminModels`） |
| `apps/admin-web/src/components/providers/ProviderSection.tsx`、`ProviderItem.tsx`、`ProviderFormDialog.tsx`、`ProviderActionMenu.tsx`、`BatchActionBar.tsx` | 新增 | 复刻 agent-web `components/settings/` 同名交互（多选批量、表单校验、`maskCredential` 脱敏展示、删除 `window.confirm`），mutation 换 `createGlobalProvider` 等；空状态「暂无供应商，点击「添加供应商」开始配置」 |
| `apps/admin-web/src/components/models/ModelSection.tsx`、`ModelItem.tsx`、`CustomModelDialog.tsx` | 新增 | 复刻 agent-web 可用模型交互：@dnd-kit 拖拽排序（`updateGlobalModelSortOrder`）、启停（`toggleGlobalModel`）、自定义模型（`createGlobalCustomModel`/`deleteGlobalCustomModel`）、禁用供应商下模型开关禁用 |
| `apps/admin-web/src/pages/BaseImagePage.tsx` | 新增 | 「基础镜像」页：列表（名称/描述/更新时间）+ 新建/编辑表单对话框（Dockerfile 等宽字体 textarea，`whitespace-pre-wrap`/`min-w-0` 防溢出，`frontend-rules.md`）+ 删除二次确认；同名报错提示；空状态引导 |
| `apps/admin-web/src/components/base-images/BaseImageTable.tsx`、`BaseImageFormDialog.tsx`、`DeleteConfirmDialog.tsx` | 新增 | 列表/表单/确认对话框 |
| `apps/admin-web/src/lib/credential.ts` | 新增 | `maskCredential`（前 3 后 4，复刻 agent-web） |
| `apps/admin-web/src/graphql/queries.ts`、`mutations.ts`、`types.ts` | 修改 | 补齐 admin-llm / admin-base-image 手写文档与类型（含 `scope`） |
| `apps/admin-web/src/components/__tests__/*` | 新增 | 组件测试 T-W* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-W1 | 供应商 CRUD + 批量 | 保存前错误提示正确；凭据展示脱敏；级联提示（删除含模型的供应商） |
| T-W2 | 模型拖拽排序 | `updateGlobalModelSortOrder` 收到正确 ids 顺序 |
| T-W3 | 自定义模型添加/删除 | 仅自定义可删；重名报错展示 |
| T-W4 | 基础镜像 CRUD | 列表刷新、表单校验、重名错误、删除二次确认 |
| T-W5 | 空列表 | 三个区块均展示空状态与新增引导 |

### 命令参考

```bash
cd apps/admin-web && npx vitest run && npm run build && npm run lint
```

### 验收 checklist

- [ ] T-W1 ~ T-W5 全部通过
- [ ] 交互与 agent-web「供应商设置 / 可用模型」一致（PRD 功能点 3）；差异点仅数据为全局 scope
- [ ] 布局为经典「左侧边栏 + 右内容」，当前模块高亮（PRD 功能点 2）

---

## Phase 7: 编排与容器化（Aspire + Dockerfile + CI）

开发分支：`servers/admin-console`（aspire/ 与 `.github/workflows/` 归属该分支）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | 注册 `adminApi = AddNodeApp("admin-api", "../../servers/admin-api", "src/index.ts")`：引用 mongodb、注入 `ADMIN_JWT_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`、`CORS_ORIGIN`（参数化，线上 `https://admin.zag.fffdan.com`）、dev 端口 10003 / publish 8002；dev 模式 `AddViteApp("admin-web", "../../apps/admin-web")` 注入 `VITE_ADMIN_API_URL=adminApi 端点`；publish 模式 admin-api 与 admin-web 均以各自 Dockerfile 构建镜像注册为 compose 服务（admin-web nginx 容器 80），对齐 `z-aspire-orchestrator` 与现有 publish 行为 |
| `servers/admin-api/Dockerfile` | 新增 | 多阶段 `node:22-alpine`（build `npm ci` 缓存挂载 + runtime `USER node` + `ENTRYPOINT ["node","src/index.ts"]`），与提案 §9.2 / agent-api Dockerfile 同模式 |
| `apps/admin-web/Dockerfile` | 新增 | 阶段一 `node:24-alpine` 构建（`ARG VITE_ADMIN_API_URL` + `ENV` 透传给 `npm run build`）；阶段二 `nginx:1.27-alpine` 托管 `dist`，`COPY nginx.conf /etc/nginx/conf.d/default.conf`，`COPY docker-entrypoint.d/ /docker-entrypoint.d/`（脚本加执行位），`EXPOSE 80` |
| `apps/admin-web/nginx.conf` | 新增 | SPA history fallback（`try_files $uri $uri/ /index.html`）+ `/assets/` 长缓存；不硬编码 `/graphql` 上游 |
| `apps/admin-web/docker-entrypoint.d/40-generate-config-js.sh` | 新增 | 启动时按 `ADMIN_API_URL` 生成 `/usr/share/nginx/html/config.js`（`window.__ADMIN_CONFIG__ = { apiUrl }`）；未设置时生成空配置，前端回落构建期默认/同源 |
| `.github/workflows/build-admin-api-image.yml` | 新增 | 对齐 `build-agent-api-image.yml`：`release`/`release/**` + `paths: servers/admin-api/**` + `workflow_dispatch`；buildx 登录 `secrets.DOCKER_ENDPOINT`；推送 `zero-tools/admin-api:<sha>` + `:latest` |
| `.github/workflows/build-admin-web-image.yml` | 新增 | 同上，`paths: apps/admin-web/**`、镜像 `admin-web`，`build-args: VITE_ADMIN_API_URL=${{ vars.ADMIN_API_URL }}`（vars 可空，空则同源兜底） |
| `README.md`、根 `AGENTS.md` | 修改 | 项目结构与启动说明补 `servers/admin-api`、`apps/admin-web`；`aspire/AgentGear.AppHost/AGENTS.md` 资源表补两服务 |

### 验收 checklist

- [ ] `aspire start` 可拉起 admin-api（10003）与 admin-web（Vite dev），`/health` 与 `/graphql` 可用（本地开发路径）
- [ ] `aspire publish -o aspire/manifest` 产物含 admin-api 与 admin-web（nginx 容器）两个服务；`rm -f aspire/manifest/*.Dockerfile` 清理流程不受影响
- [ ] `docker build`（仅镜像构建验证，不起编排）两个镜像成功；admin-web 容器 SPA 路由刷新不 404、`config.js` 注入生效（提案 §10 验收项）
- [ ] 两条 CI workflow 语法正确、与 `build-agent-api-image.yml` 模式一致（release 分支 + 路径过滤 + 双标签）

---

## Phase 8: 测试补全（tests/api + tests/e2e）

开发分支：`tests/admin-console`（基于 `feat/admin-console`，在 Phase 2~7 实现合并后切出）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/admin-api/auth.test.ts` | 新增 | T-IA*：登录/改密/守卫/无注册（`gqlRequest` 模式对齐 `llm.test.ts`，`ADMIN_API_URL` 默认 `http://localhost:10003/graphql`） |
| `tests/api/src/admin-api/llm.test.ts` | 新增 | T-IP*/T-IM*：全局供应商与模型全部 query/mutation、脱敏、级联、批量、排序、连通性失败（`mock-server.ts` 复用）、scope 隔离（admin 不见 user 数据） |
| `tests/api/src/admin-api/base-image.test.ts` | 新增 | T-IB*：CRUD、重名冲突、鉴权 |
| `tests/api/src/agent-api/llm.test.ts` | 修改 | 补 agent-api 回归（T-SC* 中适合集成层的用例）：全局启用模型对用户可见、用户不可写全局数据 |
| `tests/api/src/agent-api/auth.test.ts` 等 | 修改 | 若需适配 `providers` 索引/`scope` 字段的存量断言，同步更新（`common-rules.md`：状态语义演进回填断言） |
| `tests/e2e/src/admin-auth.spec.ts` | 新增 | T-E*：默认密码登录 → 强制改密 → 进入后台；改密后旧密码失效；未登录跳转；退出登录；登录页服务器地址设置 |
| `tests/e2e/src/admin-model-config.spec.ts` | 新增 | 新增供应商（mock LLM 端点）→ 同步模型 → 启停/排序/自定义模型；侧边栏导航高亮 |
| `tests/e2e/src/admin-base-image.spec.ts` | 新增 | 基础镜像 CRUD 全流程 + 重名 + 删除二次确认 |
| `tests/e2e/src/helpers.ts` | 修改 | 增加 `adminLogin(page)` / `adminGqlRequest(...)`（`ADMIN_API_URL`）等 helper |
| `tests/api/AGENTS.md`、`tests/e2e/AGENTS.md` | 修改 | 补 `ADMIN_API_URL` / `ADMIN_WEB_URL`（或 `BASE_URL`）环境变量与 `aspire wait admin-api admin-web` 步骤 |

### 测试用例（E2E 增量）

| # | 用例 | 预期 |
|---|------|------|
| T-E1 | `admin/admin1234567` 首次登录 | 强制进入改密页；完成改密进入「模型配置」 |
| T-E2 | 未完成改密直接访问 `/base-images` | 被拉回改密页 |
| T-E3 | 改密后重新登录 | 新密码生效、旧密码失效 |
| T-E4 | 模型配置全流程 | 供应商保存（连通性通过）→ 模型同步 → 启用模型出现在用户侧 `models` 查询（与 agent-api 回归交叉验证） |
| T-E5 | 基础镜像 CRUD + 同名拒绝 + 删除确认 | 全部符合 PRD 功能点 4 验收标准 |
| T-E6 | 侧边栏导航/高亮/退出 | 符合 PRD 功能点 2 验收标准 |

### 命令参考

```bash
aspire start && aspire wait admin-api && aspire wait agent-api
cd tests/api && ADMIN_API_URL=http://localhost:10003/graphql API_URL=http://localhost:10001/graphql CONTROLLER_API_URL=http://localhost:33237 npm test
# E2E（与 API 套件串行，common-rules 测试陷阱）
aspire start && aspire wait admin-web && aspire wait admin-api && aspire wait agent-api
cd tests/e2e && ADMIN_WEB_URL=<aspire describe admin-web> BASE_URL=<...> API_URL=<...> ADMIN_API_URL=<...> npx playwright test admin-*.spec.ts
```

### 验收 checklist

- [ ] T-IA* / T-IP* / T-IM* / T-IB* / T-SC* / T-E* 全部通过
- [ ] API 与 E2E 串行执行；测试仅用 Aspire 编排服务
- [ ] 各实现分支单测覆盖率 ≥ 80%（admin-api services/crypto/auth 重点）

---

## Phase 9: 全量回归 + PRD 验收核对 + PR

### 命令参考

```bash
# 后端
cd servers/admin-api && npm run build && npx vitest run --coverage
cd servers/agent-api && npm run build && npx vitest run
# 前端
cd apps/admin-web && npm run build && npm run lint && npx vitest run
# API / E2E 全量（串行，见 tests/api、tests/e2e AGENTS.md）
```

### 总体验收 checklist

- [ ] 单元测试覆盖率 ≥ 80%（common-rules）
- [ ] API 测试通过（admin-api 全端点 + agent-api scope 回归）
- [ ] E2E 测试通过（首次改密、模型配置全局生效、基础镜像 CRUD）
- [ ] PRD 验收标准逐条核对（`docs/product/draft/20261014-admin-console.md` §1.3 + §3.2 各功能点）
  - [ ] 默认帐号可登录、首次强制改密、改密后旧密码失效（功能点 1）
  - [ ] 左侧边栏 + 右内容布局、模块高亮、退出登录（功能点 2）
  - [ ] 全局供应商/模型配置对所有用户可用模型列表生效、禁用即移除（功能点 3）
  - [ ] 基础镜像 Dockerfile CRUD、同名拒绝、删除二次确认（功能点 4）
- [ ] PRD 3.5 异常边界逐条核对（未改密访问其他地址、密码不一致/过弱、登录态过期、连通性失败、级联删除提示、空列表、服务器地址不可达）
- [ ] 提案 §10 验收标准逐条核对（含 Dockerfile 构建、endpoint 可设置三路径、CI 流水线、契约评审项）
- [ ] 三个开发分支 PR review 通过并合并回 `feat/admin-console`（需求总 PR #203 自动更新）

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| `providers.name` 索引迁移影响存量数据 | 迁移 004 幂等且仅动索引不动数据；两 schema 同步变更防 autoIndex 互相打架；失败时保留旧索引回滚（功能退化为全局重名限制，不丢数据） |
| 两处 schema（agent-api / admin-api）漂移 | 文件头注释互指「与对方同步演进」；API 测试同数据集交叉断言；后续抽公共包留待下期（提案风险点） |
| 用户侧对全局模型只读带来的 UX 落差 | `Model.scope` 字段返回 + 写操作明确文案（裁决 5）；agent-web UI 本期不动（范围外） |
| nginx `config.js` 注入失败或未设 `ADMIN_API_URL` | 生成空配置 → 前端回落构建期默认/同源兜底；登录页可手动设置服务器地址 |
| CI `secrets.DOCKER_*` / `vars.ADMIN_API_URL` 未配置 | build-args 允许为空（同源兜底）；workflow_dispatch 可手动重试；与现有 agent-api 流水线共用 secrets |
| 强制改密拦截误伤基础查询 | 白名单仅 `adminLogin`/`changeAdminPassword`/`adminMe`（裁决 2），API 测试覆盖 T-A7 |
| Aspire publish 下 admin-web（nginx 容器）与 agent-web（GitHub Pages）形态不同 | publish manifest 单独验证（Phase 7 checklist）；CI 镜像流水线为部署真源 |
| admin/user JWT 混用 | 独立 `ADMIN_JWT_SECRET` + T-A6 断言互不认 |

## 相关文档

- 关联 PRD：`docs/product/draft/20261014-admin-console.md`
- 关联 Proposal：`docs/engineering/proposals/20261014-feat-admin-console.md`
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
- 测试规范：`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`
- 参考实现范式：`docs/engineering/proposals/20260517-feat-llm-provider-settings.md`（供应商/模型交互）、`docs/engineering/plan/20261008-feat-domestic-api-acceleration.md`（api-base endpoint 解析）
