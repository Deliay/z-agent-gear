---
description: integration→release 集成验收报告——管理后台（admin console）+ 云 Agent 二期（cloud-controller 云端工作容器）（PR #207）AI Review 轮次，记录代码审查结论、4 项严重问题与 16 项一般问题的根因与修复要求
type: Permanent
---

# 管理后台 + 云 Agent 二期 integration 验收报告（2026-10-16）

> **状态**: 🔴 打回返工——AI 代码评审（diff `origin/release...origin/integration`，34 commits，225 文件 +35045/-145；不含锁文件 219 文件 +18322/-143）+ 四套单测实测，发现 **4 项严重问题（合入前必须修复）**、**16 项一般问题**、24 项建议。严重问题集中在：① cloud-controller / admin-api 镜像入口不可用（CI 构建的镜像部署即崩溃）；② Docker Compose 部署产物缺整个 cloud-controller 服务与接线；③ 终态容器 Job 无清理路径（资源泄漏且与契约矛盾）；④ 硬编码默认管理员口令可被接管。**已打回「修复Review意见」节点返工，严重问题与一般问题全部修复后重新提交 Review。**

## 关联文档

- PRD：`docs/product/draft/20261014-admin-console.md`、`docs/product/draft/20261014-cloud-agent-phase2.md`
- 技术方案：`docs/engineering/proposals/20261014-feat-admin-console.md`、`docs/engineering/proposals/20261014-feat-cloud-agent-phase2.md`
- 实现计划：`docs/engineering/plan/20261014-feat-admin-console.md`、`docs/engineering/plan/20261014-feat-cloud-agent-phase2.md`
- 契约：`contracts/admin-auth.graphql`、`contracts/admin-llm.graphql`、`contracts/admin-base-image.graphql`、`contracts/admin-cloud-container.graphql`、`contracts/cloud-controller-websocket.md`
- 分支：`integration`（@ `0e2d4ff`，PR #207 → release）
- 验收方式：AI 代码评审（diff：`origin/release...origin/integration`，34 commits，225 文件，+35045/-145）+ 单测执行（四套）+ 镜像入口实测
- 验收日期：2026-10-16

## 一、验收范围与方法

本 PR 集成两大特性（含实现期返工修复）：

1. **管理后台（admin console）**：新增 `servers/admin-api`（管理员 JWT 认证 / 全局 LLM Provider·Model / 基础镜像 CRUD / 云端容器管理代理）、新增 `apps/admin-web`（登录强制改密 / 模型配置 / 基础镜像 / 云端容器管理页）、`servers/agent-api` Provider/Model 引入 `scope`（user/global）机制与写保护、迁移回填、CI 镜像构建流水线 ×3。
2. **云 Agent 二期（cloud-controller）**：新增 `servers/cloud-controller`（Express + Socket.IO + K8s Job 控制器、一次性握手 token、状态同步/心跳巡检/孤儿 Job 对账）、`deploy/images/worker` 工作容器镜像、`deploy/k8s` 部署 manifest、admin 侧云端容器 GraphQL 代理与降级语义。
3. **测试**：`tests/api`（admin-api/auth·llm·base-image·cloud-container、agent-api llm scope 回归、cloud-controller 内部 API / worker 握手）、`tests/e2e`（admin-auth·model-config·base-image·cloud-container 真实 UI 链路）。

审查方法：按 admin-api / admin-web / cloud-controller / agent-api+测试+编排 四路并行评审，覆盖安全（鉴权、越权、密钥、注入）、正确性（竞态、超时、资源泄漏、错误处理）、契约一致性（`contracts/` 逐字段核对）、规范一致性（`docs/engineering/*-rules.md`、各 `AGENTS.md`）与测试有效性；本报告收录的严重问题均经人工复核复现（镜像入口崩溃、compose 服务清单、终态早退代码路径已逐一实证）。

## 二、已验证（✅）

| 项目 | 结果 | 说明 |
|---|---|---|
| admin-api 单测 | ✅ 157 passed / 15 文件 | `servers/admin-api npx vitest run`；`tsc --noEmit`（strict）零错误 |
| cloud-controller 单测 | ✅ 34 passed / 7 文件 | `servers/cloud-controller npx vitest run`（需 `npx npm@10 ci`，见建议 30） |
| agent-api 单测 | ✅ 629 passed / 44 文件 | `servers/agent-api npx vitest run`（含 scope/迁移新增用例）；`tsc --noEmit` 干净 |
| admin-web 单测 + lint | ✅ 76 passed / 14 文件，lint 零告警 | `apps/admin-web npx vitest run`、`npm run lint` |
| scope 写保护主路径 | ✅ | createCustom / delete / toggle / batch\* / updateSortOrder 均有 global 拦截，T-SC5 反向用例真实覆盖；legacy 无 scope 文档归为 user |
| 凭据安全（admin-api） | ✅ | AES-256-GCM 加密存储、GraphQL 一律脱敏；`ADMIN_JWT_SECRET` 与用户 `JWT_SECRET` 双 secret 隔离（单测 + tests/api 双层验证） |
| cloud-controller token/鉴权 | ✅ | 一次性 token（CSPRNG + bcrypt 只存哈希、终态作废）、内部 API `timingSafeEqual` 鉴权、K8s RBAC 收敛命名空间内 Job 五动词；Job 参数（Never / backoffLimit 0 / TTL 600）与 AGENTS.md 约束一致 |
| 契约一致性（主体） | ✅ | `admin-*.graphql` / `cloud-controller-websocket.md` 附录 A 字段、错误文案、幂等语义与实现逐项核对基本吻合（个别缝隙见建议 26） |
| tests/api、tests/e2e 套件 | ⚠️ 本轮未执行 | 需 Aspire 编排环境；套件本身的问题见问题 15-17，返工修复后随复验执行全量 |
| 镜像启动冒烟 | ❌ | cloud-controller 镜像入口实测 `ERR_MODULE_NOT_FOUND`（问题 1） |

## 三、验收问题清单

### 🔴 严重（合入前必须修复）

#### 问题 1（🔴 严重）cloud-controller / admin-api 镜像入口不可用：Dockerfile 未构建、ENTRYPOINT 直接执行 TS 源码

**问题描述**：

- `servers/cloud-controller/Dockerfile:17` `ENTRYPOINT ["node", "src/index.ts"]`，构建阶段仅 `npm ci` + `COPY . .`，**从未执行 `npm run build`**；源码 ESM 导入使用编译期 `.js` 后缀（如 `src/index.ts:7` `from './config/index.js'`，实际文件是 `.ts`），Node 原生 TS 类型剥离**不改写 import 说明符**，启动即 `ERR_MODULE_NOT_FOUND`（已在 Node 24 最小复现实证）。`deploy/k8s/cloud-controller.yaml:73` 不覆盖 command，直接使用该 ENTRYPOINT → `.github/workflows/build-cloud-controller-image.yml` 构建推送的镜像在 K8s 中 **CrashLoopBackOff**，整条云端工作容器链路不可用。
- `servers/admin-api/Dockerfile:17` 同样 `ENTRYPOINT ["node", "src/index.ts"]`，实测 `node src/index.ts` 立即 `ERR_MODULE_NOT_FOUND`；当前仅因 `aspire/manifest/docker-compose.yaml:90` 注入 `NODE_OPTIONS: "--import tsx"` 才能启动——**镜像脱离 compose 环境变量即不可用**（K8s / 手工 docker run 直接失败），且运行时依赖 build 阶段装入的 devDependency `tsx`，与 `package.json` 的 `build`/`start`（tsc→dist）路径完全脱节，一旦有人 `npm ci --omit=dev` 优化镜像即崩。
- 两份 Dockerfile `FROM node:22-alpine` 与 `docs/engineering/backend-rules.md` 声明的「Node.js 24+」不一致。

**根因**：Dockerfile 照搬了「本地 tsx 直跑 TS 源码」的开发路径，但没有把构建步骤或 tsx 运行时带进镜像，入口与 `package.json` 声明的构建产物脱节；发布流水线无镜像启动冒烟门禁。

**修复要求**：

1. 两份 Dockerfile 构建阶段增加 `RUN npm run build`，`ENTRYPOINT ["node", "dist/index.js"]`（若坚持 TS 直跑则需 `ENV NODE_OPTIONS=--import tsx` 且把 `tsx` 移入 `dependencies`，并把 import 说明符与解析方式打通）。
2. base image 对齐 Node 24（或修订 `backend-rules.md` 并说明取舍）。
3. 补「镜像启动冒烟」验证（参照 `deploy/images/worker/BUILD.md` 风格），CI 构建后至少验证容器能起来并响应 `/health`。

#### 问题 2（🔴 严重）`aspire publish` manifest 与 AppHost 脱节：Docker Compose 部署缺整个 cloud-controller 服务与 admin 接线

**问题描述**：`aspire/manifest/docker-compose.yaml` 只有 `mongodb / redis / controller-api / agent-api / admin-api / admin-web` 六个服务（+aspire），**没有 cloud-controller**；`admin-api` 服务环境变量缺 `CLOUD_CONTROLLER_URL` / `INTERNAL_API_TOKEN`（而 `aspire/AgentGear.AppHost/AppHost.cs:104-113` 明明做了接线），`admin-web` 缺 `ADMIN_API_URL` 接线（`docker-entrypoint.d/40-generate-config-js.sh` 依赖），`.env` 也没有 `CLOUD_CONTROLLER_IMAGE` / `INTERNAL_API_TOKEN` / `WORKER_IMAGE` 等占位。git 历史佐证：`5381a31`（重新生成 manifest）早于 `3d4de34`（cloud-controller 编排提交），manifest 此后再未重新生成。

**影响**：按 README「方式二：Docker Compose」部署的环境没有 cloud-controller，`servers/admin-api/src/services/cloud-controller-client.ts:174-177` 因 `CLOUD_CONTROLLER_URL` 未配置恒抛 `CONTROL_PLANE_UNAVAILABLE`——本次合并的核心新功能（云端工作容器）在该部署路径**完全不可用**；合入 release 即发布一个残缺部署物。

**根因**：`aspire publish` 产物未随 AppHost 变更重新生成，发布产物与编排声明脱节且无校验。

**修复要求**：在集成分支最新 AppHost 上重跑 `aspire publish -o aspire/manifest`（按 README 流程清理多余 `*.Dockerfile`），确认 cloud-controller 服务、admin-api 的 `CLOUD_CONTROLLER_URL`/`INTERNAL_API_TOKEN`、admin-web 的 `ADMIN_API_URL` 与 `.env` 占位齐全，并按「方式二」实际拉起验证云端容器管理可用。

#### 问题 3（🔴 严重）终态容器（`failed`/`destroying`）强制销毁幂等早退、不删 Job：资源泄漏且无 API 恢复路径（与契约矛盾）

**问题描述**：`servers/cloud-controller/src/services/container-service.ts:189-191` 对 `isTerminalStatus`（含 `failed`、`destroying`，见 `src/models/cloud-container.ts:21-25`）直接 `return { success: true, deletedJob: false }`——**不检查也不删除 Job**。而：

- `src/services/status-sync.ts:182-183` 注释明确「connecting 超时 → failed……**不自动删除 Job（等待管理员强制销毁）**」，但强制销毁正是上面那条早退路径，自相矛盾；
- 契约 `contracts/cloud-controller-websocket.md:172、:223`（「容器记录标记 failed 并保留，**可被强制销毁清理**」）承诺的清理通道实际不存在；
- 「回连超时 → failed」时 Job 仍处 active（agent-gear 按契约指数退避持续重连、token 已作废永远握手失败），`ttlSecondsAfterFinished: 600` 只对**已完成**的 Job 生效，无法回收；
- 同根另一路径：`destroy()` 先置 `destroying`（:193）再等 10s 宽限（:197-199），期间进程被 SIGTERM/重启（滚动发布窗口），记录卡在 `destroying`；`status-sync.ts:116、:150` 对 `destroying` 一律跳过，`destroy()` 重试又幂等早退 → **Job 永久残留**。

**影响**：失败/超时容器的 Pod 持续占用节点资源；管理员调 `DELETE /internal/containers/:id` 拿到 `success:true` 却清不掉 Job，运维只能手工 `kubectl delete job`。

**根因**：幂等语义被实现成「终态即跳过一切动作」，而契约语义是「Job 已不存在时不再重复删除」；缺少终态对账兜底。

**修复要求**：

1. `destroy()` 对终态记录也应确认 Job 是否仍存在并删除（幂等保留在响应上，`deletedJob` 反映真实动作）。
2. 为 `failed`/`destroying` 增加巡检兜底（reconcile 发现终态记录仍有关联 Job 时删除）。
3. 同步修订契约 A.2.3「不重复删除 Job」措辞为「Job 已不存在时不再重复删除」。
4. 补单测：failed 记录强制销毁删除 Job、destroying 卡死记录可被巡检回收。

#### 问题 4（🔴 严重）硬编码默认管理员口令 `admin1234567`，锁定态可凭默认口令改密接管账号（CWE-798）

**问题描述**：`servers/admin-api/src/services/auth.ts:8、30-37` `DEFAULT_ADMIN_PASSWORD = 'admin1234567'`，`seedAdmin()` 在 `admin_users` 为空时种入 `admin/admin1234567`。`mustChangePassword=true` 虽通过 `assertAdmin` 挡住业务操作，但 `changeAdminPassword`（`src/graphql/resolvers/auth.ts:46`）**在锁定态放行且仅校验 `oldPassword`**——攻击者用公开已知的默认口令登录并改密即永久接管账号。admin-api 在两条部署路径均对外暴露（compose 发布 8002；AppHost `WithExternalHttpEndpoints`），从部署完成到真实管理员首次改密的窗口期（可能无限长）内任何人可接管管理后台，进而读取/篡改全局 LLM 凭据、销毁云端容器。

**根因**：口令为 PRD（`docs/product/draft/20261014-admin-console.md:57`）明文指定的固定值并硬编码进源码；同服务的 `CREDENTIAL_ENCRYPTION_KEY` 有 `assertRuntimeConfig` fail-fast，口令却没有同等保护。

**修复要求**（需产品/安全侧裁决后执行）：

1. 种子口令改为环境变量注入（复用 `assertRuntimeConfig` fail-fast，拒绝弱默认值），或首次种子时随机生成并输出到启动日志一次性可见。
2. 至少在部署文档中强制「部署后立即改密 + 网络层限制可达性」作为补偿控制（若裁决保留默认口令）。

### 🟡 一般（应修复，返工一并处理）

#### 问题 5（🟡 一般·数据丢失）admin-api 更新供应商重同步会连同自定义模型一起删除，且多步写无事务

`servers/admin-api/src/services/provider.ts:126`：`update` 在凭据/type/endpoint 变更时 `Model.deleteMany({ providerId: id, scope: GLOBAL_SCOPE })` 后 `insertMany` 仅重建 API 同步模型——`isCustom: true` 的自定义模型被**静默删除且不可恢复**，契约 `admin-llm.graphql` 未声明此级联语义。另 `create`（:57-72）、`delete`（:144-145）多步写无事务，任一步失败留下中间态（provider 在而模型全空）。与 agent-api `ProviderService.update` 行为一致（复刻要求），属数据丢失语义，建议两侧一起修：`deleteMany` 加 `isCustom: false` 过滤（或先备份恢复），多写用 Mongo 事务，契约补全语义。

#### 问题 6（🟡 一般·安全）admin-api 改密后旧 JWT 不失效，7 天内持续有效

`servers/admin-api/src/services/auth.ts:20-26、58-77`：`signToken` 只签 `{ adminId }`、`expiresIn: '7d'`，无 token 版本/jti；`changePassword` 后旧 token 依然通过 `verifyToken`。口令泄漏后改密并不能把攻击者已持有的 token 踢下线；`tests/api/src/admin-api/auth.test.ts:152` 标题「invalidate the old one」实际只验证旧*密码*不能登录，掩盖缺口。修复：payload 加 `passwordChangedAt`/`tokenVersion`，`authenticateAdmin` 校验签发时间晚于最近改密。

#### 问题 7（🟡 一般·安全）admin-api 登录无速率限制/锁定，且存在用户名枚举计时侧信道

`servers/admin-api/src/services/auth.ts:43-52`：对不存在用户立即抛错、对存在用户走 `bcrypt.compare`（百毫秒级），响应时间可区分；无任何频率限制/失败锁定。管理后台登录可被在线暴力破解（叠加问题 4 放大）。修复：不存在用户也跑 dummy `bcrypt.compare` 恒定时间；按 IP/用户名限速或失败锁定。

#### 问题 8（🟡 一般·竞态）cloud-controller 状态写回无 CAS，多链路交错存在竞态

`src/repositories/container-repository.ts:128-139` 的 `findByIdAndUpdate(id, { $set: patch })` 无状态前置条件，配合 `container-service.ts:139-174`：① destroy 置 `destroying` 后宽限期内旧 socket 仍可 `register → markOnline` 盲写 `online`，落在终态写回之后则显示 `online` 但 Job 已删、tokenHash 已清，靠心跳巡检 5 分钟+ 才纠正；② `start()` 与并发 `destroy()` 交错可产生**永久孤儿 Job**（`status-sync.handleJobEvent:116` 因记录终态跳过、reconcile 因 `knownIds.has` 不判孤儿）；③ `start()` 落库 `creating` 与 `createJob` 之间，并发 `list()`（:229-240）会误判「Job 已回收」置 `failed`。修复：状态转移改条件更新（`findOneAndUpdate({ _id, status: { $nin: terminal } }, ...)`），失败转移重读；destroy/start 间加 per-container 串行化（与 `backend-rules.md`「状态机」条目一致）。

#### 问题 9（🟡 一般·可靠性）cloud-controller `status-sync` fire-and-forget 未捕获 rejection，可致进程崩溃/watch 断链

`src/services/status-sync.ts:44-45、54、57、85-91`：`void this.scanTimeouts()`、`void this.handleJobEvent(event)`、`void this.handleWatchDisconnect(error)` 等无 `.catch`；`handleWatchDisconnect` 内 `await this.startWatch()`（:90）若拒绝（API server 不可达/403），Node 15+ 默认 `--unhandled-rejections=throw` 直接退出进程，watch 重连链彻底断掉。可恢复故障（Mongo 瞬断、watch 建立失败）会打挂整个 cloud-controller 且无自动恢复。修复：所有 `void` 链加 `.catch` 记日志；`startWatch` 失败纳入指数退避重试。

#### 问题 10（🟡 一般·安全）deploy/k8s 示例 Secret 内置公开默认令牌 + Ingress `path: /` 把 `/internal` 一并对外暴露

`deploy/k8s/cloud-controller.yaml:42-51` `INTERNAL_API_TOKEN: 'change-me-internal-token'`（文件头 :10 直接给出 `kubectl apply` 落地命令），`config/index.ts:54-58` fail-fast 只校验非空、默认值可通过；`:127-148` Ingress `path: /`（Prefix）覆盖 `/worker`、`/health`、`/internal` 全部路径，仅注释「建议限制来源」未强制。按示例落地即形成「入口可达 + 令牌公开」的内部 API，可任意拉起/销毁容器。修复：Ingress 排除 `/internal`（另建集群内 Service + NetworkPolicy）；`assertRuntimeConfig` 拒绝已知默认令牌；文档改为先 `kubectl create secret` 再 apply。

#### 问题 11（🟡 一般·安全）worker token 经 URL query 承载会进中间层访问日志，且明文写入 Job env

契约 `contracts/cloud-controller-websocket.md:27` 将连接地址定为 `wss://.../worker?token=<one-time-token>`，`k8s-job-manager.ts:48、89-92` 据此生成；nginx ingress 默认 access log 的 `$request` 含 query string，而该 token 在容器进入终态前**可重复握手有效**（契约 §3.3 断线重连复用，寿命可达数小时）。`deploy/images/worker/entrypoint.sh:86` 特意剥离 query 再打印，说明团队已意识到泄漏面，但入口层日志不受其控制；token 明文写入 Job env，`kubectl get job -o yaml` 即可读取。修复：改用 Socket.IO handshake `auth` 承载 token；短期至少在部署文档明确 ingress 日志脱敏，并用 K8s Secret 引用注入。

#### 问题 12（🟡 一般·发布）CI 推送镜像路径与部署 manifest 引用不一致，且构建流水线无测试门禁

`build-cloud-controller-image.yml:29-33` 推送 `${{ secrets.DOCKER_ENDPOINT }}/zero-tools/cloud-controller:*`，而 `deploy/k8s/cloud-controller.yaml:73、:84` 引用 `core.harbor.internal.fffdan.com/zag/{cloud-controller,worker}:latest`——`zero-tools/` 与 `zag/` 两套仓库路径需人工搬运，易部署旧镜像；三个 `build-*-image.yml` 均为 checkout→build→push，**无 `npm test` 步骤**，带红测试也能推成 `latest`。修复：统一镜像命名空间；build 前加 `npm ci && npm test` 门禁。

#### 问题 13（🟡 一般·信息泄露）agent-api `Model.provider` 无 scope 过滤，用户可读全局供应商明细

`servers/agent-api/src/services/provider.ts:23-27`：`Query.providers` 有 `USER_SCOPE_FILTER`，但 `models` 按设计返回 global 模型，`Model.provider` 解析器走 `findById(id)`（无 scope 条件），返回含 `endpoint` 与部分掩码凭据（first3+last4）的完整 Provider——与 T-SC5「全局供应商不出现在用户侧」意图不一致，任意登录用户可见全局供应商内部 endpoint 与凭据片段。修复：`Model.provider` 走不含凭据的投影（`select('-encryptedCredential')` + global scope `credentialValue: ''`），或拆 `ProviderSummary` 类型；tests/api 补断言。

#### 问题 14（🟡 一般·纵深防御）agent-api 写保护级联过滤不一致

`servers/agent-api/src/services/provider.ts:97、135、151-153`：`update`/`delete` 的 `Model.deleteMany({ providerId: id })`、`toggle` 的 `Model.updateMany` 均无 scope 过滤，而 `batch*`（:167、:183、:194）带 `scope: { $ne: 'global' }`。当前不可利用（global 模型只能挂 global 供应商，写路径在 provider 层已拦截），但数据不变量一旦被破坏（手工改库、未来能力扩展）就会连带删改全局模型。修复：三处补 `scope: { $ne: 'global' }` 与 batch\* 对齐 + 单测锁定。

#### 问题 15（🟡 一般·测试有效性）tests/api 关键用例缺环境变量时静默 `return` 显示绿灯，且 P0-1 早退残留容器

`tests/api/src/admin-api/cloud-container.test.ts:133-135`（P0-1 在线销毁宽限期端到端）与 `tests/api/src/admin-api/auth.test.ts:86-89`（T-A7 强制改密守卫）在 `MONGODB_URI` 缺失/不支持时 `console.warn + return`，**用例仍报告 PASS**——虚假全绿掩盖回归；P0-1 早退路径不销毁已 START 的容器，反复执行积累残留、影响后续列表断言。对比 `tests/e2e/src/admin-auth.spec.ts:27` 的 `test.skip` 是正确做法。修复：改 `it.skipIf(...)` / `ctx.skip()` 显式跳过，跳过/失败路径兜底销毁已启动容器。

#### 问题 16（🟡 一般·测试稳定性）tests/e2e 未强制 `workers: 1`，与 AGENTS.md 串行要求矛盾，admin 套件并行必 flaky

`tests/e2e/playwright.config.ts:1-13` 无 `workers` 配置（Playwright 默认 50% 逻辑核并行），而 `tests/e2e/AGENTS.md` 写「默认即单 worker」（与实际行为不符）且主命令未带 `--workers=1`。`admin-auth.spec.ts` T-E3 会轮换共享管理员密码、`admin-model-config.spec.ts` `cleanupProviders` 会删光所有全局供应商（还与 tests/api 共享 DB）——多 worker 下互踩。修复：config 写死 `workers: 1` 并修正文档；理想情况下 per-worker 数据隔离。

#### 问题 17（🟡 一般·测试有效性）tests/api llm.test 用 `every(...)` 弱化的断言在空数组时恒真

`tests/api/src/agent-api/llm.test.ts:176、186`：原 `toEqual([])` 断言被改为 `providers.every(p => p.scope === 'user')` / `models.every(m => m.scope !== 'global' || m.isEnabled)`，**数组为空时恒真**，失去回归检测力（共享 DB 下列表很可能为空）。修复：断言前先经 admin 造 global 数据再验证过滤，或同时断言非空 + 过滤条件。

#### 问题 18（🟡 一般·可用性）admin-web 所有列表页吞 `useQuery` error，故障伪装「暂无数据」空态

`src/components/providers/ProviderSection.tsx:21`、`src/components/models/ModelSection.tsx:29-30`、`src/pages/BaseImagePage.tsx:17`、`src/pages/CloudContainersPage.tsx:25-27` 只解构 `{ data, loading }`，GraphQL 错误/网络失败时落入「暂无供应商」空态——管理员无法区分「没数据」与「接口故障」，可能基于假空态误建/误删。修复：读取 `error` 渲染错误态（含重试）或 `toast.error`。

#### 问题 19（🟡 一般·可用性）admin-web 批量/写操作无 in-flight 防护、无成功反馈，`successCount` 不可见

`src/components/providers/ProviderSection.tsx:127-161`、`BatchActionBar.tsx:26-34`：`handleBatchEnable/Disable/Delete` 无 busy 状态，双击连发两次批量 mutation；`ProviderBatchPayload.successCount` 未展示；成功无 `toast.success`——部分失败被静默吞掉。修复：请求期间禁用按钮、成功 toast 并回显 `successCount`。

#### 问题 20（🟡 一般·安全）admin-web 配置注入：`ADMIN_API_URL` 未转义直接拼入 JS 字符串

`docker-entrypoint.d/40-generate-config-js.sh:10` `printf 'window.__ADMIN_CONFIG__ = { apiUrl: "%s" }' "${ADMIN_API_URL}"`——值含 `"`、`\`、换行即可破坏字符串字面量向 `config.js` 注入任意 JS（`index.html:8` 同步加载，注入代码同源执行）。需控制部署环境变量才可利用，但一旦变量被污染即成持久化 XSS 载体。修复：启动脚本校验 URL 形态（非法拒绝启动）或 `jq -n --arg` JSON 转义。

### 🟢 建议（不阻塞，可随返工或后续处理）

| # | 模块 | 建议 |
|---|---|---|
| 21 | admin-api | `provider.update` 不校验 `name` 非空/trim（`create` 有校验），可写入空名供应商 |
| 22 | admin-api | `cloud-controller-client.ts:103-107` 错误信息取 `body.error` 丢弃 `body.message` 真实细节，排障困难 |
| 23 | admin-api | `cloud-controller-client.ts:85-86` 未知 status 映射出非法 GraphQL 枚举值会打挂整条查询，建议未知值回落 `FAILED` |
| 24 | admin-api | 契约缝隙：`adminMe` 未认证返回 `null` 与契约「UNAUTHENTICATED」不符；`MUST_CHANGE_PASSWORD` 未入契约；`adminDestroyCloudContainer` 返回 `false` 语义未定义；短凭据整体掩码与「前3后4」差异未注记 |
| 25 | admin-api | `resolvers/provider.ts:104-108` / `model.ts:105-109` N+1 且无查询深度/复杂度限制，可无限嵌套放大查询 |
| 26 | admin-api | 生产面加固：`graphiql: true` 无条件开启、CORS 默认 `'*'`、密码策略仅长度≥10 且允许新旧相同 |
| 27 | admin-api | 杂项：`graphql-type-json` 未使用；GCM 用 16 字节 IV（NIST 推荐 12）；非法 ObjectId 透出 `CastError`；`createCustom` maxSort+1 并发可重复；`updateSortOrder` 对非 global id 静默跳过 |
| 28 | admin-api | `provider.update` 重同步删自定义模型与 agent-api 行为一致（问题 5），修复时两侧统一 |
| 29 | cloud-controller | `package-lock.json` 与 package.json 不同步：npm 11 `npm ci` 直接 `EUSAGE` 失败（缺 `@rolldown/binding-*-x64` 平台 optional binding），npm 10 可过；Node 24 开发环境会踩坑，建议重新生成完整 lock |
| 30 | cloud-controller | `k8s-job-manager.ts:78-97` Job manifest 无资源 requests/limits 与 `activeDeadlineSeconds`，工作容器含 dockerd 可吃满节点资源 |
| 31 | cloud-controller | `container-service.ts:195-199` destroy 对 online 容器固定阻塞满 10s 宽限，即使 worker 立即断开也不提前结束 |
| 32 | cloud-controller | `markFailed`（:164-174）未清 `tokenHash`（`markExited`/destroy 都清了），建议一致置 null 纵深防御 |
| 33 | cloud-controller | 握手无速率限制（`socketio-gateway.ts:50-69` + bcrypt.compare），得知 containerId 可做 CPU 消耗型攻击 |
| 34 | cloud-controller | 同 containerId 多连接时任一断开即 `heartbeatTracker.remove`（:115-116）误判离线；`register` 未按契约 §2.2 校验 `hostname` 必填 |
| 35 | cloud-controller | 测试盲区：`RealK8sClient` 整段 `c8 ignore` 零覆盖（watch done 回调分支疑似死代码）；`list()` N+1；`heartbeat-tracker` 无独立单测 |
| 36 | admin-web | `LoginPage.tsx:38-40` 网络错误判定正则过宽（含 "fetch"/"network"/"timeout" 即判连接失败），真实错误被掩盖 |
| 37 | admin-web | `lib/apollo.ts:22、29` 跳转路径硬编码 `/login`、`/change-password` 未用 `basename`，子路径部署失效（agent-web 同模式存量问题） |
| 38 | admin-web | `stores/AuthProvider.tsx:5-14` 恢复态无字段形状校验；`main.tsx` bootstrap 无错误兜底，localStorage 受限环境白屏 |
| 39 | admin-web | 破坏性操作确认交互分裂：`window.confirm`（供应商/自定义模型删除）vs 自绘 Dialog（基础镜像/容器销毁），建议统一 Dialog |
| 40 | admin-web | `ModelSection.tsx:66-87` 拖拽排序基于闭包旧数据发全量 ids，与后端 `updateSortOrder` 遗漏项语义叠加可产生排序错乱 |
| 41 | admin-web | 测试缺口：`lib/apollo.ts` errorLink（UNAUTHENTICATED 清态跳登录、MUST_CHANGE_PASSWORD 跳改密）零测试；LoginPage 提交链路/业务错误分支未断言；列表失败分支无测试 |
| 42 | admin-web | `nginx.conf` 缺 `index.html`/`config.js` 缓存控制（发版后旧入口驻留）与 CSP / X-Frame-Options / X-Content-Type-Options |
| 43 | agent-api | `migrations/004-provider-scope-name-index.ts:16-22` 先 `dropIndex` 再 `createIndex`，失败窗口 name 无唯一约束；建议先建后删 |
| 44 | agent-api | 入参校验：`createCustomModel` `input.name` 无 trim/非空校验；`updateModelSortOrder` 对重复/不存在 id 无校验 |
| 45 | 测试/CI | `tests/api/AGENTS.md:58、75` 文档漂移（「8 个文件并行」与 `vitest.config.ts` `fileParallelism: false` 及实际文件数不符、自相矛盾）；三个 build-\*-image.yml 未声明 `permissions: contents: read`、无 GHA 构建缓存 |

## 四、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 1 | 镜像入口不可用（cloud-controller 必崩 / admin-api 仅 compose 可用） | Dockerfile 未构建、ENTRYPOINT 指向 TS 源码 | ⏳ 待修复 | |
| 2 | compose manifest 缺 cloud-controller 与 admin 接线 | `aspire publish` 产物未随 AppHost 重新生成 | ⏳ 待修复 | |
| 3 | 终态容器 Job 无清理路径（资源泄漏、与契约矛盾） | 幂等早退跳过删 Job + 无终态对账 | ⏳ 待修复 | |
| 4 | 硬编码默认管理员口令可接管 | PRD 指定固定口令硬编码进源码 | ⏳ 待修复（需产品裁决） | |
| 5 | 更新供应商静默删除自定义模型 | 同步重拉取无 `isCustom` 过滤、多写无事务 | ⏳ 待修复 | |
| 6 | 改密后旧 JWT 7 天有效 | token 无版本/签发时间校验 | ⏳ 待修复 | |
| 7 | 登录无速率限制 + 用户名枚举计时侧信道 | 无 dummy compare、无限速 | ⏳ 待修复 | |
| 8 | cloud-controller 状态写回无 CAS 竞态 | 盲 `$set` 无状态前置条件 | ⏳ 待修复 | |
| 9 | status-sync 未捕获 rejection 可致进程崩溃 | fire-and-forget `void` 链无 `.catch` | ⏳ 待修复 | |
| 10 | k8s 示例默认令牌 + Ingress 暴露 `/internal` | 示例即落地、Ingress `path: /` | ⏳ 待修复 | |
| 11 | token 走 URL query 进日志、明文进 Job env | 契约握手设计 + env 注入方式 | ⏳ 待修复 | |
| 12 | CI 镜像路径与 manifest 不一致、无测试门禁 | 两套命名空间、流水线缺 `npm test` | ⏳ 待修复 | |
| 13 | `Model.provider` 泄露全局供应商明细 | `findById` 无 scope 过滤 | ⏳ 待修复 | |
| 14 | 写保护级联过滤不一致（纵深防御缺口） | `update/delete/toggle` 级联缺 scope 过滤 | ⏳ 待修复 | |
| 15 | tests/api 关键用例静默 skip 显示绿灯 | `if (!x) return` 而非 skip API | ⏳ 待修复 | |
| 16 | E2E 未强制 `workers: 1` | config 未配置、文档表述失实 | ⏳ 待修复 | |
| 17 | llm.test `every()` 空洞断言 | 空数组恒真 | ⏳ 待修复 | |
| 18 | admin-web 列表页吞 error 伪装空态 | 未读取 `useQuery` error | ⏳ 待修复 | |
| 19 | 批量操作无防抖/无反馈 | 无 busy 态、`successCount` 不展示 | ⏳ 待修复 | |
| 20 | `ADMIN_API_URL` 未转义注入 config.js | printf 直拼 JS 字符串 | ⏳ 待修复 | |

> 建议项 21-45 不阻塞合并，可在返工中择要处理；处理情况请在下一轮 Review 时说明。

## 五、最终验证（本轮实测）

| 项目 | 结果 | 说明 |
|---|---|---|
| 单测 admin-api | ✅ 157 passed / 15 文件 | `npx vitest run` |
| 单测 cloud-controller | ✅ 34 passed / 7 文件 | `npx vitest run`（`npx npm@10 ci` 安装） |
| 单测 agent-api | ✅ 629 passed / 44 文件 | `npx vitest run` |
| 单测 admin-web | ✅ 76 passed / 14 文件 | `npx vitest run` |
| 类型检查 | ✅ | admin-api / agent-api `tsc --noEmit` 零错误 |
| lint | ✅ | admin-web `npm run lint` 零告警 |
| 镜像启动冒烟 | ❌ | cloud-controller `node src/index.ts` → `ERR_MODULE_NOT_FOUND`（问题 1） |
| tests/api（API 集成） | ⏸ 本轮未执行 | 需 Aspire 编排环境；返工修复后随复验全量执行 |
| tests/e2e（E2E） | ⏸ 本轮未执行 | 同上；执行时注意问题 16 的 workers 约束 |

## 六、结论

**打回返工**——问题 1-4 为严重问题（部署产物不可用 / 核心功能部署缺失 / 资源泄漏 / 安全接管窗口），问题 5-20 为一般问题（数据丢失、鉴权缺口、竞态、测试有效性、信息泄露等），**必须全部修复并附验证证据后重新提交 Review**。修复优先级建议：先 1-4（其中问题 4 需产品/安全裁决），再 5-20；问题 5 与 28、问题 1 与 29 建议同批联动修复。

返工提交后请同步回填本报告「四、修复总览」的修复 commit 与各问题验证结果，重新进入 AI Review 复核。

## 经验总结

- **发布产物必须冒烟**：Dockerfile/manifest 属于交付物，「本地能跑」不等于「镜像能跑」；CI 构建流水线应加镜像启动冒烟与 `npm test` 门禁，`aspire publish` 产物需随 AppHost 变更强制再生成。
- **幂等语义要对齐契约**：「不重复删除」≠「终态跳过删除」；终态资源需有对账兜底路径，否则重启窗口即永久泄漏。
- **默认凭据零容忍**：种子口令应环境注入 + fail-fast，与加密密钥同等对待；改密必须使旧 token 失效。
- **测试绿灯要真**：静默 `return` 与空数组 `every()` 都会让套件虚假全绿，环境缺失用显式 skip 报告。
- **前端错误态不可省**：查询失败渲染成空态会误导操作决策，`useQuery` 的 `error` 必须被消费。
