---
description: integration→release 集成验收报告——管理后台（admin console）+ 云 Agent 二期（cloud-controller 云端工作容器）（PR #207）AI Review 各轮次结论：首轮 4 严重 + 16 一般问题与修复回填、第二轮复验 2 严重 + 5 一般新问题（含 2 项修复回归）与打回返工要求、第三轮复验问题 46-52 修复确认但 51 修复不完整并新增 6 项一般问题（53-58）再次打回
type: Permanent
---

# 管理后台 + 云 Agent 二期 integration 验收报告（2026-10-16）

> **状态**: ✅ 第三轮返工完成（待重启 AI Review 复验）——第三轮问题 53-59 **全部修复**（修复提交 `028436c`），建议 F-K 择要处理。复验证据：admin-api 242、cloud-controller 73、agent-api 653、admin-web 119 单测通过，`tsc`/lint 干净，`tests/api` 390 通过，admin 套件 E2E 20 通过。详见第八节 8.7。
>
> <details><summary>历史轮次（第三轮复验 / 第二轮返工 / 第二轮复验 / 首轮返工 / 首轮 Review）</summary>
>
> 🔴 第三轮复验（2026-10-16）：打回返工——第二轮 46/47 与 48/49/50/52 修复确认属实，但问题 51 只修一半（admin-api 侧非空契约残留）＋新发现 53-58 六项一般问题。
>
> ✅ 第二轮返工完成（2026-10-16）：问题 46/47（严重回归）与 48-52（一般）全部修复（修复提交 `25e7c89`），建议项 A/C/D/E 择要处理。复验证据：六套单测全绿、`tsc`/lint 干净、`tests/api` 388 通过、admin 套件 E2E 20 通过。详见第七节 7.7。
>
> 🔴 第二轮复验（2026-10-16）：打回返工——首轮 1-20 修复确认属实，但发现 2 项严重 + 5 项一般新问题（问题 46：Ingress `path: /worker` 破坏 Socket.IO worker 回连；问题 47：AppHost 默认口令 `dev-admin-init-password` 重建问题 4 接管窗口；48-52 见第七节）。
>
> ✅ 返工完成（2026-10-16）：首轮 4 项严重问题与 16 项一般问题全部修复（修复提交 `5159589`，回填 `10d673f`）。
>
> 🔴 首轮验收结论（2026-10-16）：打回返工——AI 代码评审（diff `origin/release...origin/integration`，34 commits，225 文件 +35045/-145；不含锁文件 219 文件 +18322/-143）+ 四套单测实测，发现 **4 项严重问题（合入前必须修复）**、**16 项一般问题**、24 项建议。严重问题集中在：① cloud-controller / admin-api 镜像入口不可用（CI 构建的镜像部署即崩溃）；② Docker Compose 部署产物缺整个 cloud-controller 服务与接线；③ 终态容器 Job 无清理路径（资源泄漏且与契约矛盾）；④ 硬编码默认管理员口令可被接管。**已打回「修复Review意见」节点返工。**
>
> </details>

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

> 修复提交：`5159589`（`fix(review): 修复 PR #207 AI Review 的 4 项严重 + 16 项一般问题`）。下列各问题均含于该提交；验证结果见第五节。

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 1 | 镜像入口不可用（cloud-controller 必崩 / admin-api 仅 compose 可用） | Dockerfile 未构建、ENTRYPOINT 指向 TS 源码 | ✅ 已修复 | `5159589` |
| 2 | compose manifest 缺 cloud-controller 与 admin 接线 | `aspire publish` 产物未随 AppHost 重新生成 | ✅ 已修复 | `5159589` |
| 3 | 终态容器 Job 无清理路径（资源泄漏、与契约矛盾） | 幂等早退跳过删 Job + 无终态对账 | ✅ 已修复 | `5159589` |
| 4 | 硬编码默认管理员口令可接管 | PRD 指定固定口令硬编码进源码 | ✅ 已修复（改环境注入/随机 + fail-fast） | `5159589` |
| 5 | 更新供应商静默删除自定义模型 | 同步重拉取无 `isCustom` 过滤、多写无事务 | ✅ 已修复 | `5159589` |
| 6 | 改密后旧 JWT 7 天有效 | token 无版本/签发时间校验 | ✅ 已修复 | `5159589` |
| 7 | 登录无速率限制 + 用户名枚举计时侧信道 | 无 dummy compare、无限速 | ✅ 已修复 | `5159589` |
| 8 | cloud-controller 状态写回无 CAS 竞态 | 盲 `$set` 无状态前置条件 | ✅ 已修复 | `5159589` |
| 9 | status-sync 未捕获 rejection 可致进程崩溃 | fire-and-forget `void` 链无 `.catch` | ✅ 已修复 | `5159589` |
| 10 | k8s 示例默认令牌 + Ingress 暴露 `/internal` | 示例即落地、Ingress `path: /` | ✅ 已修复 | `5159589` |
| 11 | token 走 URL query 进日志、明文进 Job env | 契约握手设计 + env 注入方式 | ✅ 已修复（改握手 `auth.token`） | `5159589` |
| 12 | CI 镜像路径与 manifest 不一致、无测试门禁 | 两套命名空间、流水线缺 `npm test` | ✅ 已修复 | `5159589` |
| 13 | `Model.provider` 泄露全局供应商明细 | `findById` 无 scope 过滤 | ✅ 已修复（改 `ProviderSummary`） | `5159589` |
| 14 | 写保护级联过滤不一致（纵深防御缺口） | `update/delete/toggle` 级联缺 scope 过滤 | ✅ 已修复 | `5159589` |
| 15 | tests/api 关键用例静默 skip 显示绿灯 | `if (!x) return` 而非 skip API | ✅ 已修复 | `5159589` |
| 16 | E2E 未强制 `workers: 1` | config 未配置、文档表述失实 | ✅ 已修复 | `5159589` |
| 17 | llm.test `every()` 空洞断言 | 空数组恒真 | ✅ 已修复 | `5159589` |
| 18 | admin-web 列表页吞 error 伪装空态 | 未读取 `useQuery` error | ✅ 已修复 | `5159589` |
| 19 | 批量操作无防抖/无反馈 | 无 busy 态、`successCount` 不展示 | ✅ 已修复 | `5159589` |
| 20 | `ADMIN_API_URL` 未转义注入 config.js | printf 直拼 JS 字符串 | ✅ 已修复 | `5159589` |

> 建议项 21-45 中：21/22/23/24/26/27、30、32-35、36-42、43、44 已随本次返工处理（详见第五节与提交 diff）；25、29（lock 已重生成）、31、45 部分处理或记录为后续项。

## 五、最终验证（返工后复验实测，2026-10-16）

| 项目 | 结果 | 说明 |
|---|---|---|
| 单测 admin-api | ✅ 193 passed / 17 文件 | `servers/admin-api npx vitest run`；`tsc --noEmit` 零错误（`dist` 已排除测试文件） |
| 单测 cloud-controller | ✅ 57 passed / 10 文件 | `servers/cloud-controller npx vitest run`；`tsc --noEmit` 干净 |
| 单测 agent-api | ✅ 642 passed / 45 文件 | `servers/agent-api npx vitest run`；`tsc --noEmit` 干净 |
| 单测 admin-web | ✅ 111 passed / 19 文件 | `apps/admin-web npx vitest run` |
| 单测 agent-controller | ✅ 292 passed / 23 文件 | `packages/agent-controller npx vitest run`（问题 11 握手 auth 变更） |
| 类型检查 | ✅ | admin-api / agent-api / cloud-controller / agent-controller `tsc --noEmit` 零错误 |
| lint | ✅ | admin-web `npm run lint` 零告警 |
| 镜像 `dist` 入口冒烟 | ✅ | cloud-controller / admin-api `npm run build` 后 `node dist/index.js` 导入解析正常（无 `ERR_MODULE_NOT_FOUND`）；CI 新增镜像 `/health` 冒烟步骤（问题 1） |
| tests/api（API 集成） | ✅ 386 passed / 23 文件 | Aspire 编排 + 共享 Mongo 实测；关键用例改为显式 `skipIf`（问题 15） |
| tests/e2e（E2E） | ⚠️ 交付范围全绿（admin 套件 20 passed） | admin-auth / base-image / cloud-container / model-config 全通过；`workers: 1` 已强制（问题 16）。agent-web 存量套件（gateway/worktree/workflow 等）在本环境存在与本轮变更无关的既有失败（`apps/agent-web`、`servers/controller-api` 本次零改动，`gateway` 单跑亦失败） |

> 说明：本轮修复不涉及 `apps/agent-web` 与 `servers/controller-api`（`git diff` 可证），agent-web 存量 E2E 失败为环境/存量状态问题，非本次回归；已记录，建议后续单独治理。

## 六、结论

**返工完成**——问题 1-4（严重）与问题 5-20（一般）**已全部修复**，修复提交 `5159589`；建议项 21-45 择要处理。复验证据见第五节：五套单测全绿、类型检查/lint 干净、`tests/api` 386 通过、admin E2E 套件 20 通过、镜像 `dist` 入口冒烟通过。请重启 AI Review 复核。

> 遗留：agent-web 存量 E2E（gateway/worktree/workflow/session-mobile 等）在本环境存在与本轮变更无关的既有失败（相关目录本次零改动），建议后续单独立项治理，不阻塞本次合入评审。

> 首轮结论（历史）——**打回返工**：问题 1-4 为严重问题，问题 5-20 为一般问题，必须全部修复并附验证证据后重新提交 Review。

## 七、第二轮 AI Review（复验轮，2026-10-16）

### 7.1 复验范围与方法

复验对象：`origin/release...origin/integration` @ `10d673f`（PR #207，返工修复提交 `5159589` + 报告回填 `10d673f`）。方法：按 cloud-controller / admin-api+agent-api / admin-web+tests+CI 三路并行逐项复核首轮问题 1-20 的修复真实性（不采信 commit message，全部落到代码实证），再排查修复引入的回归；五套单测由本轮独立重跑核对。首轮问题 1-20 的修复**逐项确认属实**（问题 1/4/6/9/13/14/15/16/17/20 完整闭环，3/5/7/8/10/11/12/18/19 实质修复但有残留或回归，见下）。

### 7.2 首轮问题修复复核结论

| 首轮问题 | 复核结论 | 残留/回归 |
|---|---|---|
| 1 镜像入口 | ✅ 确认修复 | Dockerfile `node:24` + `npm run build` + `ENTRYPOINT node dist/index.js` + 运行时 `npm ci --omit=dev`，CI 增加容器 `/health` 冒烟 |
| 2 compose 编排 | ✅ 确认修复 | cloud-controller 服务与 admin-api/admin-web 接线、`.env` 占位齐全 |
| 3 终态 Job 泄漏 | ✅ 实质修复 | 残留见问题 50（`exited` 停摆 Job 不被巡检、`destroying` 卡死、`deletedJob` 丢字段、一处终态写回无 CAS） |
| 4 硬编码口令 | ✅ 源码层确认修复 | 回归见问题 47（AppHost 默认口令重建接管窗口） |
| 5 重同步删自定义模型 | ✅ 实质修复 | 回归见问题 48（同名冲突导致同步模型丢失、重同步永久失败） |
| 6 改密旧 JWT | ✅ 确认修复 | `pwdAt` 签发/校验链路完整，tests/api 实证旧 token 失效 |
| 7 登录限速 | ✅ 实质修复 | 残留见问题 49（XFF 伪造绕过、锁定 DoS、Map 无界增长） |
| 8 状态 CAS | ✅ 实质修复 | `destroyLocked` 终态写回无 `fromStatuses`（并入问题 50）；`markX` 未持锁仅靠 CAS（可接受） |
| 9 status-sync rejection | ✅ 确认修复 | 全部 `void` 链带 `.catch`，watch 建立失败指数退避 |
| 10 k8s 令牌/Ingress | ⚠️ 部分修复 | 令牌/Secret/`assertRuntimeConfig` 修复到位；**Ingress 收紧引入新回归（问题 46）** |
| 11 token 进日志 | ✅ 实质修复 | 握手 `auth.token` 承载、URL/日志无 token；Job env 明文注入残留（建议 B） |
| 12 CI 门禁 | ⚠️ 部分修复 | 3 条流水线加固到位；agent-api/controller-api 缺门禁、命名空间仍两套（问题 52） |
| 13 ProviderSummary | ✅ 确认修复 | 非空契约 vs 可空解析器残留（问题 51） |
| 14 级联 scope 过滤 | ✅ 确认修复 | update/delete/toggle/batch* 全部对齐 |
| 15 静默 skip | ✅ 确认修复 | 显式 `it.skipIf` + 兜底销毁已启动容器 |
| 16 E2E workers | ✅ 确认修复 | `workers: 1` + `fullyParallel: false` 写死并修正文档 |
| 17 空洞断言 | ✅ 确认修复 | 先造数再断言非空 + 成员断言 |
| 18 列表 error 态 | ✅ 确认修复 | 4 个面消费 `error` + `QueryError` 重试；`error && !data` 门残留（建议 A） |
| 19 批量 in-flight | ✅ 确认修复 | 批量路径防抖 + toast + `successCount`；单个 toggle 无防护（建议 A） |
| 20 config.js 转义 | ✅ 确认修复 | 字符集白名单 + 换行拒绝 + sed 兜底，注入向量逐一验证被拦 |

### 7.3 验收问题清单（第二轮新增，编号接续）

### 🔴 严重（合入前必须修复）

#### 问题 46（🔴 严重·功能阻断·修复回归）Ingress `path: /worker` 与 Socket.IO 传输路径不匹配，K8s 部署路径下 worker 无法回连

**问题描述**：

- `deploy/k8s/cloud-controller.yaml:139` Ingress 仅路由 `path: /worker`（Prefix），注释意图是「只暴露 Worker 回连、不暴露 /internal」。但 Socket.IO 的 `/worker` 是**命名空间（namespace）而不是 URL 路径**：客户端 `packages/agent-controller/src/socketio-client.ts:274-280` `io()` 只传 `auth`、**未设置 `path` 选项**（该文件 :221-222 自己的注释写明「pathname→namespace」的解析口径）；服务端 `servers/cloud-controller/src/index.ts:40-44` `new SocketIOServer(httpServer, { cors, transports })` 同样未设置 `path`。因此握手 HTTP 请求实际打到 **`/socket.io/?EIO=4&transport=websocket`**（engine 默认 path），Ingress 无此路由 → 404。
- 生效后果：`k8s-job-manager.ts:37-65` 由 `PUBLIC_WS_ENDPOINT`（`cloud-controller.yaml:82-83`，值为 `wss://cloud-controller.example.internal/worker`，即 Ingress 主机）生成的连接地址下发给每个 Job 的 worker——**所有经部署 manifest 拉起的云端工作容器都无法回连**，握手永不完成、容器进入 `connecting` 超时 `failed`，云端工作容器核心链路在目标 K8s 环境不可用。本地测试直连 Service（不经 Ingress）故五套单测/E2E 全绿无法发现。
- 这是问题 10 修复引入的**新回归**：把 `path: /` 收紧为 `path: /worker` 时把「命名空间」误当作「URL 路径」。Ingress 注解中也无任何 rewrite 可以弥合。

**根因**：Socket.IO 两层路径概念（engine `path` 默认 `/socket.io/` vs namespace `/worker`）被混为一谈；暴露面收紧缺少入口层连通性验证。

**修复要求**（二选一 + 验证）：

1. 方案 A（推荐）：Ingress 改为 `path: /socket.io`（Prefix）——engine 握手/升级请求放行，`/internal`、`/health` 继续不对外暴露；
2. 方案 B：服务端 `new SocketIOServer(..., { path: '/worker' })` 与客户端 `io(url, { path: '/worker' })` 显式把 engine path 设为 `/worker`，命名空间回归 `/`，并同步契约 `cloud-controller-websocket.md` 的连接地址说明；
3. 验证：至少补「client/server engine path 一致」的单测锚定 + 部署文档/冒烟步骤中明确经 Ingress 的 wss 连通性检查（如 kind + nginx-ingress 演练），避免同类回归再次靠代码评审兜底。

#### 问题 47（🔴 严重·安全·修复回归）Aspire 默认编排仍注入公开已知的初始口令与内部令牌，问题 4 的接管窗口在 Aspire 路径重现（CWE-798）

**问题描述**：

- `aspire/AgentGear.AppHost/AppHost.cs:40` `admin-initial-password` 参数带字面量默认值 `"dev-admin-init-password"`（该字面量正是问题 4 修复提交 `5159589` 引入，`git log -S` 可证）；同文件 `:36` `admin-jwt-secret` 默认 `"dev-admin-secret-change-in-production"`、`:80` `internal-api-token` 默认 `"dev-internal-token-change-in-production"`。
- `dev-admin-init-password` 不在 `servers/admin-api/src/config/index.ts:38-62` `WEAK_ADMIN_PASSWORDS` 名单中，且满足「长度 ≥ 10」，`isWeakAdminPassword` 放行 → `assertRuntimeConfig` 不拦截。而该值在 `tests/api/AGENTS.md:71`、`tests/e2e/AGENTS.md:67` **公开成文**。按 README「方式一：Aspire」默认启动（admin-api 对外暴露）的任何环境，任何读过仓库/文档的人均可 `admin / dev-admin-init-password` 登录并在强制改密态 `changeAdminPassword` **永久接管管理后台**——与首轮问题 4 的漏洞等价，仅换了取值位置。
- 同理 `dev-internal-token-change-in-production` 是 `tests/api/src/cloud-controller/internal-api.test.ts:5` 的兜底默认值，可直接以 Bearer 调用 cloud-controller 内部 API 任意拉起/销毁云端容器（`assertRuntimeConfig` 弱令牌名单不含它，长度 33 通过）。

**根因**：问题 4 只治理了 admin-api 源码硬编码，编排层（AppHost 参数默认值）、文档、测试注入链路没有一起治理；「弱口令」防线只看长度与小写精确匹配 deny-list，拦不住「足够长但公开」的默认值。

**修复要求**：

1. AppHost 中 `admin-initial-password` / `internal-api-token` / `admin-jwt-secret` 等敏感参数去掉字面量默认值（无默认 + 启动缺失即失败，或每次启动随机生成并一次性输出）；
2. `isWeakAdminPassword` 与 cloud-controller `assertRuntimeConfig` 的拒绝名单纳入已公开的 dev 默认值（`dev-admin-init-password`、`dev-internal-token-change-in-production`、`dev-admin-secret-change-in-production` 等）；
3. 测试改由环境注入取值（`tests/api`/`tests/e2e` helper 已支持 env），文档删除「默认值」记载，`tests/e2e/AGENTS.md:67` 的「回落 admin1234567」表述一并修正。

### 🟡 一般（应修复，返工一并处理）

#### 问题 48（🟡 一般·数据丢失·修复回归）重同步保留自定义模型后与 API 模型同名冲突：`deleteMany` 已提交、`insertMany` E11000，同步模型丢失且重同步永久失败

`servers/admin-api/src/services/provider.ts:218-238`：问题 5 的修复改为 `Model.deleteMany({ providerId, scope: GLOBAL_SCOPE, isCustom: false })` 后按 fetch 结果 `insertMany` 全量模型名。唯一索引 `(providerId, name)`（`servers/admin-api/src/models/model.ts:13`）**不含 `isCustom` 维度**：当保留的自定义模型与 API 返回模型同名（如自定义 `gpt-4o`），`insertMany` 抛 E11000。compose/Aspire 默认 Mongo 为 standalone（无副本集），`runWithOptionalTransaction`（`provider.ts:56-84`）自动降级为无事务直写——`deleteMany` 已生效且不回滚 → **所有同步模型被删、供应商更新报错、此后每次重同步都撞名永久失败**（修复前 `deleteMany` 全删反而不会撞唯一键，属修复引入的新故障模式）。agent-api 侧更早暴露：`servers/agent-api/src/services/provider.ts:99-116` 模型同步在 provider 写入**之前**且完全无事务，同样冲突即丢失。修复要求：重拉取模型名与存活自定义模型去重（跳过/合并同名）或改 upsert 语义替代 delete+insert；admin-api/agent-api 两侧统一；补「自定义模型与 API 模型同名」的重同步单测与 tests/api 用例。

#### 问题 49（🟡 一般·安全）登录限速可被伪造 `X-Forwarded-For` 绕过，并存在锁定 DoS 与 Map 无界增长

`servers/admin-api/src/index.ts:20-27` `clientIpFrom` 无受信代理限制地取 XFF 首项 / `x-real-ip`；`graphql/resolvers/auth.ts:53` 限速键为 `ip:username`。① 轮换 XFF 头即每个请求换新键，限速永不触发，在线暴力破解依旧可行；② 每次失败留存 Map entry（`login-rate-limiter.ts:72`），仅成功或锁定过期才清除，伪造键可无限堆积内存；③ 无转发头时键退化为 `unknown:admin` 全站共享，5 次失败即锁死唯一管理员账号（锁定 DoS）。修复要求：IP 取 socket remote address 或受信代理末跳；增加每用户名全局失败上限；定期清理过期 entry；补伪造头对抗性单测。

#### 问题 50（🟡 一般·可靠性/契约）问题 3 修复残留：Job 删除失败的 `exited` 记录永不被巡检重试，`destroying` 卡死不迁移 `exited`

- `servers/cloud-controller/src/services/container-service.ts:299-314`：destroy 时 `deleteJob` 失败仍写 `status: 'exited'`（exitReason 标注「需人工清理」），但 `sweepTerminalJobs`（`status-sync.ts:248`）与 `reclaimResidualJob`（`container-service.ts:327`）**只扫 `failed`/`destroying`**——该 Job 不再有任何自动回收路径，只剩 `activeDeadlineSeconds: 86400`（24h）兜底，且与契约 A.4「exited = Job 已回收」矛盾，等于首轮问题 3 的一条残留泄漏路径。
- destroy 中途进程重启留下的 `destroying` 记录：`destroy()` 终态分支（`container-service.ts:274-280`）与巡检都只删 Job 不写状态（`status-sync.test.ts:184` 还把「停留在 destroying」锁进断言），记录永远停在 `destroying`，违反契约 `destroying → exited` 状态机。
- `DELETE /internal/containers/:id`（`internal-api.ts:87`）丢弃契约 A.2.3 承诺的 `deletedJob` 字段，调用方无法观察清理是否真实发生。
- `destroyLocked` 最终 `exited` 写回无 `fromStatuses` CAS（`container-service.ts:309-314`），是全部状态转移中唯一裸写，`replicas: 1` 时安全，扩副本后 CAS 保证失效。

修复要求：巡检覆盖 `exited`（发现残留 Job 即重删）；`destroying` 兜底迁移 `exited`；DELETE 响应透出 `deletedJob`；终态写回补 `fromStatuses: ['destroying']`；契约 A.2.3/A.4 同步修订并补单测。

#### 问题 51（🟡 一般·契约/可用性）agent-api `Model.provider: ProviderSummary!` 非空契约 vs 可空解析器，悬空 providerId 打挂整条查询

`servers/agent-api/src/graphql/schemas/model.ts:5` 声明 `ProviderSummary!`（非空），但 `graphql/resolvers/model.ts:95-99` 走 `findSummaryById`（`services/provider.ts:28-32`）对缺失/悬空 provider 返回 `null`（`graphql/resolvers/model.test.ts:70-73` 还把 `null` 行为锁进断言）——GraphQL 非空违规会使整个 `models`/`modelsByProvider` 查询失败。悬空 `providerId` 可达：模型级联删除带 `scope: { $ne: 'global' }` 过滤（问题 14 修复），存在「global 模型挂在 user 供应商、供应商被删而模型孤儿」的组合产生悬空引用。修复要求：字段改可空或行级容错降级（占位 summary），补悬空引用测试。

#### 问题 52（🟡 一般·发布）CI 加固不完整：agent-api / controller-api 流水线无测试门禁与最小权限，镜像命名空间仍两套

问题 12 只修了 3 条流水线：`.github/workflows/build-agent-api-image.yml`、`build-controller-api-image.yml` 仍无 `npm ci && npm test` 门禁、无 `permissions: contents: read`、命名空间硬编码 `zero-tools`；而 cloud-controller 用 `zag`（`build-cloud-controller-image.yml:18`，`deploy/k8s/cloud-controller.yaml:70` 引 `core.harbor.internal.fffdan.com/zag/...`），admin-api/admin-web 也仍是 `zero-tools`——「统一镜像命名空间」未达成，带红测试仍可推 `agent-api`/`controller-api` 的 `latest`。修复要求：全部 `build-*-image.yml` 统一加测试门禁 + `permissions: contents: read` + `IMAGE_NAMESPACE` 参数化，命名空间与部署引用对齐（或文档固化搬运步骤）。

### 🟢 建议（本轮新增，不阻塞，可随返工择要处理）

| # | 模块 | 建议 |
|---|---|---|
| A | admin-web | 单个 `handleToggle` 无 in-flight 防护、开关不禁用（`ProviderSection.tsx:103-113`、`ModelSection.tsx:58-68`），双击两次 toggle 相互抵消；`runBatch` 的 `?? ids.length` 在 `successCount` 缺失时报全成功（`ProviderSection.tsx:164`）；`error && !data` 门使数据加载后的刷新失败静默（ModelSection/ProviderSection/BaseImagePage），`ModelSection` 的 `ADMIN_PROVIDERS` 查询完全不读 `error` |
| B | cloud-controller | worker token 仍明文写入 Job env（`k8s-job-manager.ts:107` `value: input.token`），`get/list jobs` 权限即可读取；`register` 事件载荷仍携带 `key`（`socketio-client.ts:305-312`）。建议改 K8s Secret 引用注入 |
| C | cloud-controller | `start()` CAS 未命中即删 Job 的兜底（`container-service.ts:196-200`）在极端 `markOnline` 竞态下会误删活 Job；watch 断线重连为固定延迟而非指数退避（`status-sync.ts:142-145`）；禁令牌名单为小写精确匹配（`config/index.ts:79`），同源变体可绕过 |
| D | 测试/CI | `k8s-client.ts` `RealK8sClient` 零覆盖（`c8 ignore`）；admin-web `/assets/` 双 `Cache-Control` 头（`nginx.conf:31-38`）；admin-web 冒烟只查 `/config.js` 可达不校验内容（`build-admin-web-image.yml:61-74`）；`generate-config-js.test.ts` 缺 `</script>` 拒绝用例 |
| E | agent-api | `batchEnable/Disable/Delete` 原始 id 直入 `$in` 未做 `ObjectId.isValid`（`services/provider.ts:167-205`），CastError 冒泡为通用错误，与 admin-api 问题 27 的处理不一致 |

### 7.4 第二轮问题总览

> 修复提交：`25e7c89`。7 项问题全部修复，验证见 7.7。

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 46 | Ingress `path: /worker` 破坏 Socket.IO 回连，K8s 路径 worker 不可用 | namespace 与 engine path 概念混用（问题 10 修复回归） | ✅ 已修复（Ingress 改 `/socket.io` + 服务端显式 engine path + 握手锚定测试） | `25e7c89` |
| 47 | AppHost 公开默认口令/令牌重建接管窗口 | 问题 4 只修源码层，编排/文档/测试链路未治理（修复回归） | ✅ 已修复（去字面量默认 + 随机/配置注入 + deny-list + 一次性日志） | `25e7c89` |
| 48 | 重同步同名冲突致同步模型丢失、重同步永久失败 | 唯一键不含 `isCustom`，delete+insert 无去重（问题 5 修复回归） | ✅ 已修复（upsert 语义 + 同名跳过，admin/agent 两侧统一） | `25e7c89` |
| 49 | 登录限速可被伪造 XFF 绕过 + 锁定 DoS + Map 无界 | 限速键取自不可信请求头 | ✅ 已修复（远端地址/受信末跳 + per-username 上限 + prune） | `25e7c89` |
| 50 | 终态 Job 清理残留路径 + `destroying` 卡死 + 契约缝隙 | 巡检未覆盖 `exited`、终态分支不迁移状态 | ✅ 已修复（巡检覆盖 exited、destroying→exited、deletedJob、CAS） | `25e7c89` |
| 51 | `ProviderSummary!` 非空契约 vs 可空解析器 | 悬空 providerId 触发非空违规 | ✅ 已修复（改可空 + 悬空引用测试） | `25e7c89` |
| 52 | CI 加固不完整（两条流水线缺门禁、命名空间两套） | 问题 12 修复范围不完整 | ✅ 已修复（五条流水线统一门禁/最小权限/命名空间） | `25e7c89` |

### 7.5 第二轮验证（复验实测，2026-10-16）

| 项目 | 结果 | 说明 |
|---|---|---|
| 单测 admin-api | ✅ 193 passed / 17 文件 | 本轮独立重跑 `npx vitest run` |
| 单测 cloud-controller | ✅ 57 passed / 10 文件 | 本轮独立重跑 |
| 单测 agent-api | ✅ 642 passed / 45 文件 | 本轮独立重跑 |
| 单测 admin-web | ✅ 111 passed / 19 文件 | 本轮独立重跑 |
| 单测 agent-controller | ✅ 292 passed / 23 文件 | 本轮独立重跑（握手 auth 变更回归） |
| 首轮问题 1-20 修复复核 | ✅ 全部属实 | 逐项代码实证，无虚假修复；残留/回归见 7.2 表 |
| Ingress → worker wss 连通性 | ❌ 不可用 | 静态实证：`/socket.io/` 无路由（问题 46），单测/E2E 不经 Ingress 故未暴露 |
| Aspire 默认凭据 | ❌ 不安全 | `dev-admin-init-password` 通过弱口令校验且文档公开（问题 47） |
| tests/api / tests/e2e | ⚠️ 未重跑 | 需 Aspire 编排环境，采信返工证据（386 / 20 passed）；不阻塞本轮结论 |

### 7.6 第二轮结论

🔴 **打回返工**——首轮 1-20 修复确认属实，但问题 46、47 为严重问题（均为修复引入的回归：部署路径核心链路不可用 / 默认凭据接管窗口重现），问题 48-52 为一般问题（含数据丢失回归），按「有问题即打回」的验收准则不予通过。请按 7.3 修复要求逐项修复（46/47 合入前必须闭环），回填修复 commit 与验证结果后重新提交 AI Review；建议项 A-E 择要处理。

### 7.7 第二轮问题修复与复验（返工轮，修复提交 `25e7c89`）

**修复要点（逐项对应 7.3）**

| # | 修复 | 关键文件 |
|---|---|---|
| 46 | 采用方案 A：Ingress 由 `/worker` 改为 `/socket.io`（Prefix）；服务端显式 `path = ENGINE_PATH('/socket.io/')`；新增真实握手锚定测试（`/socket.io/?EIO=4&transport=polling`→200、`/worker?...`→404）；契约 §1.2/§1.3/§3.1 同步 | `deploy/k8s/cloud-controller.yaml`、`servers/cloud-controller/src/{index.ts,services/socketio-gateway.ts}`、`contracts/cloud-controller-websocket.md` |
| 47 | AppHost 敏感参数（admin-initial-password / internal-api-token / admin-jwt-secret / jwt-secret / mcp-jwt-secret）去除字面量默认值 → 配置注入或每次启动随机生成；admin-api 拒绝 `dev-admin-init-password`/`dev-admin-secret-change-in-production`；cloud-controller 拒绝 `dev-internal-token-change-in-production`（大小写/空白变体归一化）；`seedAdmin` 首次种子一次性打印初始口令（标注来源）；测试/文档改为环境注入 | `aspire/AgentGear.AppHost/AppHost.cs`、`servers/admin-api/src/{config,services/auth.ts}`、`servers/cloud-controller/src/config/index.ts`、`README.md`、`tests/*/AGENTS.md` |
| 48 | admin-api/agent-api 重同步统一为 upsert 语义：与存活自定义模型同名则跳过，其余按 `(providerId,name)` upsert，仅删除过期 API 同步模型；agent-api 将模型同步移到 provider 写之后 | `servers/{admin-api,agent-api}/src/services/provider.ts` |
| 49 | IP 取 socket 远端地址/受信代理末跳（新增 `middleware/client-ip.ts` + `TRUST_PROXY`）；增加 per-username 全局失败上限；限速 Map `prune()` + `maxEntries` 上限；补伪造头对抗性单测 | `servers/admin-api/src/{index.ts,middleware/client-ip.ts,services/login-rate-limiter.ts,graphql/resolvers/auth.ts}` |
| 50 | 巡检覆盖 `exited` 残留 Job（单次 `listJobs` 索引）、`destroying` 卡死兜底迁移 `exited`；`DELETE /internal/containers/:id` 透出 `deletedJob`；`destroyLocked` 终态写回补 CAS；契约 A.2.3/A.4 同步 | `servers/cloud-controller/src/{services/container-service.ts,services/status-sync.ts,routes/internal-api.ts}`、`contracts/cloud-controller-websocket.md` |
| 51 | `Model.provider` 由 `ProviderSummary!` 改为可空 `ProviderSummary`；补悬空 `providerId` 的真实 SDL 执行测试 | `servers/agent-api/src/graphql/schemas/model.ts`、`contracts/llm.graphql` |
| 52 | 五条 `build-*-image.yml` 统一 `permissions: contents: read` + `npm ci && npm test` 门禁 + `IMAGE_NAMESPACE=zero-tools`；`deploy/k8s` 与 worker BUILD.md 命名空间对齐 | `.github/workflows/*`、`deploy/k8s/cloud-controller.yaml`、`deploy/images/worker/BUILD.md` |

建议项：A（admin-web 单 toggle in-flight/error 提示/`successCount` 缺失）、C（cloud-controller watch 指数退避、deny-list 归一化）、D（nginx 单 Cache-Control、config.js `</script>` 用例）已处理；B（worker token 进 Job env 改 Secret）保留为后续项。

**复验实测（本轮）**

| 项目 | 结果 | 说明 |
|---|---|---|
| 单测 admin-api | ✅ 210 passed / 18 文件 | `npx vitest run`；`tsc --noEmit` 干净 |
| 单测 cloud-controller | ✅ 66 passed / 10 文件 | `npx vitest run`；含 engine path 握手锚定测试 |
| 单测 agent-api | ✅ 648 passed / 45 文件 | `npx vitest run`；`tsc --noEmit` 干净 |
| 单测 admin-web | ✅ 119 passed / 19 文件 | `npx vitest run`；lint 零告警 |
| 单测 controller-api | ✅ 214 passed / 19 文件 | 顺带修正 `command.test.ts` 两个既有失败（mock `Controller.findOne`），使 CI 门禁可行 |
| 单测 agent-controller | ✅ 292 passed / 23 文件 | 本轮未改，回归确认 |
| tests/api | ✅ 388 passed / 23 文件 | Aspire 编排 + 共享 Mongo；`INTERNAL_API_TOKEN` 环境注入、`ADMIN_INITIAL_PASSWORD` 注入 |
| tests/e2e admin 套件 | ✅ 20 passed | admin-auth / base-image / cloud-container / model-config |
| AppHost 默认凭据 | ✅ 已去除 | 敏感参数随机/注入；admin-api 首次种子一次性打印初始口令 |

> 说明：问题 46 的入口层连通性由「client/server engine path 一致」单测锚定（`/socket.io/` 200、`/worker` 404）；真实 Ingress 演练仍建议在部署环境按 `deploy/k8s` 补一次 wss 冒烟（本地无 ingress 控制器）。

### 7.6-补 第二轮结论（返工后）

✅ **返工完成**——问题 46/47（严重）与 48-52（一般）已全部修复（`25e7c89`），建议项 A/C/D/E 择要处理；复验证据见 7.7。请重启 AI Review 复核。

## 八、第三轮 AI Review（复验轮，2026-10-16）

### 8.1 复验范围与方法

复验对象：`origin/release...origin/integration` @ `260b54e`（PR #207，第二轮返工修复提交 `25e7c89` + 报告回填 `260b54e`）。方法：三路并行逐项复核问题 46-52 的修复真实性（全部落到代码实证，不采信 commit message），并专项排查 `25e7c89` 修复引入的回归；问题 46 的 Ingress/engine path 修复按「Ingress → 服务端 → 客户端 → worker 入口」四层做了端到端握手追踪（socket.io/engine.io 路径归一化语义对照上游源码确认）；AppHost / CI 五条流水线逐行核对。**问题 46、47、48、49、50、52 修复确认属实**；**问题 51 仅修复 agent-api 一半**；新发现 6 项一般问题（53-58）与 8 项建议。本轮无 🔴 严重问题。

### 8.2 第二轮问题修复复核结论

| 第二轮问题 | 复核结论 | 证据 / 残留 |
|---|---|---|
| 46 Ingress `/worker` 破坏握手 | ✅ 确认修复 | Ingress `path: /socket.io`（Prefix）（`deploy/k8s/cloud-controller.yaml:145-146`）；服务端显式 `ENGINE_PATH='/socket.io/'`（`socketio-gateway.ts:15`、`index.ts:40-46`）；客户端 `io()` 未显式传 `path` 但库默认 `/socket.io` 归一化后与服务端收敛一致（engine.io-client `addTrailingSlash`、engine 服务端 `_computePath` 均落 `/socket.io/`）；worker 连接 URL 中的 `/worker` 仅为 namespace（`io.of('/worker')`），握手打 `/socket.io/` 可过 Ingress；锚定测试 T-G10（`/socket.io/`→200、`/worker`→404）；契约 §1.2/§1.3/§3.1 已同步。残留：客户端未显式钉死 `path`（依赖库默认值）；`buildServerEndpoint` 对带路径 `PUBLIC_WS_ENDPOINT` 的「支持」是陷阱（见 58 建议项） |
| 47 AppHost 公开默认凭据 | ✅ 确认修复 | `AppHost.cs:5-12` `SecretOrDefault` 用 `RandomNumberGenerator.GetBytes` 每次启动随机或 `Parameters:*` 配置注入，全部敏感参数（admin-initial-password / internal-api-token / admin-jwt-secret / jwt-secret / mcp-jwt-secret / github-token-encryption-key）无字面量默认；`seedAdmin`（`admin-api/services/auth.ts:52-77`）仅首次种子、`crypto.randomBytes(18)` 生成、一次性打印；deny-list 含 `dev-admin-init-password`/`dev-admin-secret-change-in-production`（trim+lowercase 归一）与 `dev-internal-token-change-in-production`（含大小写/内部空白变体）；`tests/*/AGENTS.md` 已删默认值记载。残留：`docs/engineering/plan/20261014-feat-admin-console.md` 等历史设计文档仍记载 `admin1234567` 种子行为（见建议项） |
| 48 重同步同名冲突数据丢失 | ✅ 确认修复（update 路径） | admin-api `provider.ts:220-276`：先取存活自定义模型名→fetched 名去重剔除同名→按 `(providerId,name)` upsert（恰为唯一索引键，不可能 E11000）→**之后**才删陈旧（filter 带 `isCustom:false + $nin`，不误删自定义）；无事务路径无「先删后失败丢数据」窗口；agent-api 同语义且模型同步移到 provider 写之后（`provider.ts:114-130,142-175`）；测试 T-P8/T-P9 真实断言。**残留：`create()` 路径未修（问题 54）** |
| 49 登录限速绕过 | ✅ 确认修复 | `middleware/client-ip.ts` 默认只取 socket 对端、`TRUST_PROXY` 严格 opt-in（`'true'/'1'`）后取 XFF **末跳**；限速键 `usernameKey` 恒执行、IP 维度可选，无 `unknown` 共享桶（消除锁死 DoS）；`prune()` + `maxEntries=10000` 有界；对抗测试覆盖伪造头/换 IP/换用户名。加固缺口见 56、57 |
| 50 终态 Job 清理残留 | ✅ 确认修复 | `reclaimResidualJob` 纳入 `exited`（`container-service.ts:372-409`）、`sweepTerminalJobs` 对 `failed/exited` 存活 Job 回收、`destroying` 卡死兜底迁移 `exited`（不做存在性前置过滤）；DELETE 透出 `deletedJob`（`internal-api.ts:84-89`）且契约 A.2.3 同步；`destroyLocked` 终态写回 `fromStatuses:['destroying']` CAS；全状态机转移已带 CAS，无死循环。残留见 58 |
| 51 `Model.provider` 非空契约 | ⚠️ **仅修复一半** | agent-api 侧完整：`contracts/llm.graphql:45` 与 `schemas/model.ts:7` 均改可空、resolver null 安全、真实 SDL 悬空测试、前端判空消费。**admin-api 侧未改**：`contracts/admin-llm.graphql:49`、`servers/admin-api/src/graphql/schemas/model.ts:5` 仍 `provider: Provider!`，而 `resolvers/model.ts:76-77` 走 `findById`（`services/provider.ts:92-96`）可返回 `null`——悬空 providerId 时整条 `adminModels` 打挂，原故障模式在管理侧复现（问题 53） |
| 52 CI 加固不完整 | ✅ 确认修复 | 五条 `build-*-image.yml` 全部具备 `permissions: contents: read`（:12-13）+ `npm ci && npm test` 门禁（:33，admin-web 为 `npm run lint && npx vitest run`）+ `IMAGE_NAMESPACE: zero-tools`（:16-17）；`deploy/k8s/cloud-controller.yaml` 与 `deploy/images/worker/BUILD.md` 命名空间已对齐，无 `zag` 残留 |
| 建议 A（admin-web） | ✅ 已处理 | 单 toggle in-flight 防护 + error 提示 + `successCount` 兜底、`error && !data` 门放开 |
| 建议 B（worker token 进 Job env） | ⏸ 保留 | `k8s-job-manager.ts:107` 仍明文 env 注入一次性 token，按约定留作后续项 |
| 建议 C | ⚠️ 部分处理 | watch 指数退避（`status-sync.ts:89-106`）、deny-list 归一化（`config/index.ts:72-74,90-93`）✅；**`start()` CAS-miss 无条件删 Job 的误杀风险未修（并入 58）** |
| 建议 D | ✅ 处理 | nginx 单 Cache-Control、`config.js` `</script>` 拒绝用例补齐 |
| 建议 E | ⚠️ 部分处理 | agent-api `batch*` 已做 `ObjectId` 校验；**admin-api 同名路径未修（问题 55）** |

### 8.3 验收问题清单（第三轮新增，编号接续）

### 🟡 一般（应修复，返工一并处理；本轮无 🔴 严重问题）

#### 问题 53（🟡 一般·契约/可用性·问题 51 修复不完整）admin-api `Model.provider: Provider!` 非空契约 vs 可空解析器，悬空 providerId 打挂整条 `adminModels` 查询

问题 51 的修复只覆盖 agent-api：`contracts/admin-llm.graphql:49` 与 `servers/admin-api/src/graphql/schemas/model.ts:5` 仍是 `provider: Provider!`，而 `graphql/resolvers/model.ts:76-77` 调 `providerService.findById`（`services/provider.ts:92-96`，非法 id / 不存在均返回 `null`）。悬空 providerId 在 admin 侧可达：`createCustom`（`services/model.ts`）「存在性检查→创建」无事务，与供应商删除并发即产生孤儿；旧数据/手工改库同理。一旦出现，GraphQL 非空违规使 `adminModels: [Model!]!` **整体报错**——与问题 51 原始故障模式完全相同，仅换了服务。admin 侧无任何悬空测试。修复要求：与 agent 侧对齐改可空（`ProviderSummary`/`Provider` 可空）或行级容错降级（占位 summary），补 admin 侧悬空引用测试，契约 `admin-llm.graphql` 同步。

#### 问题 54（🟡 一般·数据丢失·问题 48 同类残留）`create()` 对上游模型名不去重直接 `insertMany`，重复名 E11000 → 孤儿供应商 + 创建报错

`services/provider.ts:139-152`（admin-api）：`create()` 将 `fetchModels` 结果直接 `Model.insertMany(modelDocs)`，**未做 `Set` 去重**（update/resync 路径已修，create 路径漏网）；agent-api `create()` 同类（`servers/agent-api/src/services/provider.ts`）。上游（网关/代理）返回重复模型名即 E11000；admin-api 非事务路径下供应商已创建、请求报错 → 孤儿供应商，且此后每次创建同名供应商都失败。修复要求：create 与 resync 统一走 `[...new Set(names)]` 去重（或复用 upsert 逻辑），两侧同步，补「上游返回重复模型名」测试。

#### 问题 55（🟡 一般·一致性）admin-api `batchEnable/Disable/Delete` 未做 `ObjectId` 校验，非法 id 抛 CastError 透传 GraphQL

`servers/admin-api/src/services/provider.ts:314-346` 把原始 `ids` 直入 `$in`，非法 ObjectId 抛原始 CastError；同文件 `findById/update/delete/toggle` 均已按「非法 id 视为不存在」处理（问题 27 口径），且 agent-api `batch*` 已修（建议 E）。修复要求：照搬 agent-api `validObjectIds` 过滤 + 空集短路，补测试。

#### 问题 56（🟡 一般·安全加固）限速 Map 满员驱逐不跳过锁定中 entry，可被轮换用户名灌满逐出管理员锁定记录

`servers/admin-api/src/services/login-rate-limiter.ts:83-86`：`maxEntries` 兜底驱逐按插入序取 `oldest`，**不区分 entry 是否仍在锁定期**。攻击者用 1 万个垃圾用户名灌满 Map，即可逐出 `username:admin` 的锁定/计数 entry，把全局上限从「30 次失败」重置为「约 1 万请求换 30 次新猜测」。修复要求：驱逐时跳过 `lockedUntil > now`（或对已达 `maxAttempts` 的 key 永不驱逐），补「锁定 entry 不被驱逐」测试。

#### 问题 57（🟡 一般·安全加固）`TRUST_PROXY=true` 无条件信任转发头，未校验 socket 对端是否为受信代理

`servers/admin-api/src/middleware/client-ip.ts:39-48`：开启 `TRUST_PROXY` 后无条件取 XFF 末跳，未校验 TCP 对端是否属于受信代理。若 admin-api 端口直连可达（部署误配/端口暴露），攻击者直接带 `X-Forwarded-For: x, <任意>` 自选末跳、轮换 IP 维度限速 key（仅剩用户名上限兜底，即问题 56 的 30 次）。修复要求：仅当对端属于受信代理列表（`TRUST_PROXY` 支持 CIDR/列表）时才采纳转发头；至少在文档显著标注「必须保证仅代理可达」。

#### 问题 58（🟡 一般·可靠性·问题 50/C 残留）cloud-controller `reconcile()` 缺 `creating` 守卫 + `start()` CAS-miss 无条件删 Job：健康启动可被误判失败并删活 Job

两个相邻缺口叠加（`servers/cloud-controller/src/`）：

1. `services/status-sync.ts:222-227` `reconcile()` 对非终态记录「Job 不存在 → `markFailed('Job 已回收')`」，**缺少 `list()` 已有的 `creating` 跳过守卫**（T-S11 锚定了 list 侧）。`start()` 进行中（记录已落库、`createJob` 未完成）恰逢 watch 断连触发 reconcile，即被误判失败。
2. `services/container-service.ts:196-205` `start()` 的 `creating→connecting` CAS 未命中时**无条件** `deleteResidualJob(name)`。CAS 未命中除「记录被并发销毁/终态」外还有第三种可能：`markOnline` 允许 `creating→online`（网关 register 即调用），worker 先注册、`start()` 后写 `connecting` 时 CAS 失败 → 兜底**删掉一个已注册健康容器的存活 Job**，而 `start()` 仍返回 201。

修复要求：reconcile 与 `list()` 口径对齐（跳过 `creating` 或按 `updatedAt` 年龄阈值）；CAS-miss 后回读记录，仅当状态 ∈ {destroying, exited, failed} 才回收 Job；补「creating 记录 + 并发 register」竞态测试。

#### 问题 59（🟡 一般·可用性）握手限速按 `socket.handshake.address` 计数，经 Ingress 后全部 worker 共享一个令牌桶

`servers/cloud-controller/src/services/socketio-gateway.ts:106-112` 按 TCP 对端计数（60 次/60s）。部署形态是 worker 经 nginx Ingress 回连（`deploy/k8s/cloud-controller.yaml:130-151`），TCP 对端是 Ingress controller IP——**所有 worker 共享同一个桶**，退化为全局限流；cloud-controller 重启后 worker 全量重连或批量 Job 重建时，合法 worker 会被 `RATE_LIMITED` 拒绝。单 IP 防护对真实攻击者（同样走 Ingress）也形同虚设。修复要求：按 containerId/token 前缀限流或取可信转发头首跳，并上调/分级 `max`；补批量重连场景测试。

### 🟢 建议（本轮新增，不阻塞，可随返工择要处理）

| # | 模块 | 建议 |
|---|---|---|
| F | cloud-controller | `buildServerEndpoint`（`k8s-job-manager.ts:55-62`）对带路径的 `PUBLIC_WS_ENDPOINT`（如 `host/gateway`）会拼出 `wss://host/gateway/worker`，namespace 变 `/gateway/worker` 永远注册不上且静默失败——「支持已有路径」分支是陷阱，建议 fail-fast 或文档限定 host(:port) |
| G | cloud-controller | `destroy()` 用 CAS 前快照判断 `online`（`container-service.ts:323`）决定是否发 shutdown，与 `markOnline` 并发时会跳过优雅停机；`startWatch()` 在 `await watchJobs` 后才赋值 `unwatch`（`status-sync.ts:108-122`），`stop()` 落在 await 期间时新 watch 不被 abort；`scanTimeouts` 只扫 `connecting`，`creating` 孤儿无超时兜底（`status-sync.ts:296-307`） |
| H | cloud-controller | 握手限速/测试夹具与生产传输配置不一致：`socketio-gateway.test.ts:135` 建服务端时未加 `transports:['websocket']`，T-G10 的 polling 200 在生产配置下是 400（不影响路径锚定结论） |
| I | admin-api/agent-api | resync upsert `$set isEnabled:true` 会把管理员手动禁用的同步模型重新启用（旧行为相同，非回归，可顺手保留）；upsert filter 可加 `isCustom:{$ne:true}` 防御 TOCTOU 窄窗口；名称校验策略两侧不对称（admin `createCustom` 不 trim/拒空名，agent `update` 不校验 name 非空） |
| J | admin-api | `seedAdmin` 一次性打印明文初始口令进 stdout（有意权衡，`mustChangePassword` 强制改密），如日志被采集即入持久日志，可在文档标注日志脱敏要求 |
| K | 文档 | `docs/engineering/plan/20261014-feat-admin-console.md:95,106,366` 与 `proposals/20261014-feat-admin-console.md:258,303` 仍记载 `admin/admin1234567` 种子行为，与现实现（随机生成+一次性打印）不符，建议加注「已被随机初始口令取代」 |

### 8.4 第三轮问题总览

> 修复提交：`028436c`。7 项问题全部修复，验证见 8.7。

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 53 | admin-api `Model.provider` 非空 vs 可空解析器，悬空打挂 `adminModels` | 问题 51 修复范围只覆盖 agent-api | ✅ 已修复（改可空 + 悬空测试） | `028436c` |
| 54 | `create()` 模型名不去重 `insertMany`，重复名 E11000 → 孤儿供应商 | 问题 48 修复只覆盖 update/resync 路径 | ✅ 已修复（create 去重 + 回滚，两侧统一） | `028436c` |
| 55 | admin-api `batch*` 无 ObjectId 校验，CastError 透传 | 建议 E 修复只覆盖 agent-api | ✅ 已修复（validObjectIds 过滤） | `028436c` |
| 56 | 限速 Map 驱逐不跳过锁定 entry，可重置管理员锁定 | 问题 49 加固的驱逐策略未区分锁定态 | ✅ 已修复（仅驱逐未锁定 entry） | `028436c` |
| 57 | `TRUST_PROXY` 无条件信任转发头 | 受信代理边界未校验 | ✅ 已修复（受信代理 IP/CIDR 列表 + 对端校验） | `028436c` |
| 58 | `reconcile()` 缺 `creating` 守卫 + CAS-miss 无条件删 Job，可误杀活容器 | 问题 50/建议 C 残留竞态 | ✅ 已修复（reconcile 宽限守卫 + CAS-miss 回读判定） | `028436c` |
| 59 | 握手限速共享 Ingress IP 令牌桶，批量重连被误限 | 限速维度与部署拓扑不匹配 | ✅ 已修复（按 containerId 限速 + per-IP 高上限兜底） | `028436c` |

### 8.5 第三轮验证（复验实测，2026-10-16）

| 项目 | 结果 | 说明 |
|---|---|---|
| 问题 46 端到端握手追踪 | ✅ 可用 | Ingress `/socket.io`（Prefix）→ 服务端 `ENGINE_PATH` → 客户端默认 path 归一化收敛 → worker URL `/worker` 仅作 namespace，逐层实证 |
| 问题 47 AppHost 凭据 | ✅ 已去除 | `SecretOrDefault` = 配置注入或 `RandomNumberGenerator` 每次启动随机；`seedAdmin` 首次种子一次性打印；deny-list 归一化含变体 |
| 问题 52 CI 五流水线 | ✅ 全部加固 | `permissions: contents: read` + `npm ci && npm test` 门禁 + `IMAGE_NAMESPACE=zero-tools`，部署引用对齐 |
| 问题 51 契约一致性 | ❌ 不一致 | `llm.graphql:45` 可空 vs `admin-llm.graphql:49` 非空，admin 侧解析器可返回 null（问题 53） |
| 问题 48 create 路径 | ❌ 残留 | `provider.ts:139-152` `insertMany` 无去重（问题 54） |
| 单测/CI 复跑 | ⚠️ 未重跑 | 本轮执行环境 shell 受限，采信上游复验证据（六套单测全绿、`tsc`/lint 干净、tests/api 388、admin E2E 20）；结论基于静态代码实证，不受影响 |

### 8.6 第三轮结论

🔴 **打回返工**——第二轮问题 46/47（严重）与 48/49/50/52 修复逐项确认属实，本轮无新增严重问题；但问题 51 修复不完整（admin-api 侧非空契约 vs 可空解析器原样复现，问题 53），且新发现 6 项一般问题（53-58，其中 54 为问题 48 同类数据丢失残留、58 可误杀健康容器）。按「有问题即打回」的验收准则不予通过。

**返工要求**（范围已收敛，逐项修复后即可重新提交）：

1. **53、54 必修**：契约一致性与数据完整性（与已修问题同类，不得再残留半边）；
2. **55、56、57、58、59 一并修复**：均为小改动（校验/驱逐策略/受信代理边界/两个守卫/限速维度），每项补对应测试；
3. 🟢 建议 F-K 择要处理，不阻塞；
4. 回填修复 commit 与验证结果至 8.4/8.5 后重新提交 AI Review。

> 收敛提示：本轮问题全部为加固/边界类，无核心链路阻断。建议返工时优先保证 53/54 闭环，55-59 可一次性小步修复，避免再次触发「修复引入新问题」的循环（本轮 54/55/58 均属「修复只覆盖一半路径」）。

### 8.7 第三轮问题修复与复验（返工轮，修复提交 `028436c`）

**修复要点**

| # | 修复 | 关键文件 |
|---|---|---|
| 53 | `Model.provider` 改可空（`Provider`），补真实 SDL 悬空 providerId 执行测试与 tests/api 用例 | `contracts/admin-llm.graphql`、`servers/admin-api/src/graphql/{schemas/model.ts,resolvers/model.test.ts}`、`tests/api/src/admin-api/llm.test.ts` |
| 54 | create 复用去重 upsert（`dedupeModelNames` / `syncSyncedModels`），跳过空名；非事务路径失败回滚刚建供应商 | `servers/{admin-api,agent-api}/src/services/provider.ts` |
| 55 | 新增 `validObjectIds` 过滤 + 空集短路 | `servers/admin-api/src/services/provider.ts` |
| 56 | `evictOldestUnlocked`：仅驱逐未锁定 entry；全部锁定时拒绝新增 key | `servers/admin-api/src/services/login-rate-limiter.ts` |
| 57 | `TRUST_PROXY` 改为受信代理 IP/CIDR 列表（`normalizeTrustProxy`/`ipMatchesCidr`/`isTrustedProxy`），仅当 socket 对端命中才采纳转发头 | `servers/admin-api/src/{config/index.ts,middleware/client-ip.ts}` |
| 58 | reconcile 跳过宽限期内 `creating`；start CAS-miss 回读后仅终态才回收 Job | `servers/cloud-controller/src/services/{status-sync.ts,container-service.ts}` |
| 59 | 限速主键改为一次性 token 的 containerId 前缀（免 bcrypt），回退 peer IP + per-IP 高上限兜底 | `servers/cloud-controller/src/services/socketio-gateway.ts` |

建议项 F/G/H/I/J/K 择要处理：`buildServerEndpoint` 带路径 fail-fast；`destroy` 用 CAS 后状态判定优雅停机、`startWatch` 竞态中止、`creating` 超时兜底；测试夹具 websocket 传输对齐生产；admin `createCustom` trim/空名校验 + upsert `isCustom` 过滤；`seedAdmin` 明文口令日志脱敏标注（README）；历史设计文档（plan/proposal）标注旧种子口令已被随机初始口令取代。

**复验实测（本轮）**

| 项目 | 结果 | 说明 |
|---|---|---|
| 单测 admin-api | ✅ 242 passed / 18 文件 | `npx vitest run`；`tsc --noEmit` 干净 |
| 单测 cloud-controller | ✅ 73 passed / 10 文件 | `npx vitest run`；含 per-container 限速、CAS 竞态、reconcile creating 守卫测试 |
| 单测 agent-api | ✅ 653 passed / 45 文件 | `npx vitest run`；`tsc --noEmit` 干净 |
| 单测 admin-web | ✅ 119 passed / 19 文件 | `npx vitest run` |
| tests/api | ✅ 390 passed / 23 文件 | Aspire 编排 + 共享 Mongo（干净 DB + 服务重启重建索引） |
| tests/e2e admin 套件 | ✅ 20 passed | admin-auth / base-image / cloud-container / model-config |
| 镜像/CI | ✅ | 五条流水线门禁与命名空间（前一轮）；本轮无 CI 改动 |

### 8.6-补 第三轮结论（返工后）

✅ **返工完成**——问题 53-59 已全部修复（`028436c`），建议 F-K 择要处理；复验证据见 8.7。请重启 AI Review 复核。

## 经验总结

- **发布产物必须冒烟**：Dockerfile/manifest 属于交付物，「本地能跑」不等于「镜像能跑」；CI 构建流水线应加镜像启动冒烟与 `npm test` 门禁，`aspire publish` 产物需随 AppHost 变更强制再生成。
- **幂等语义要对齐契约**：「不重复删除」≠「终态跳过删除」；终态资源需有对账兜底路径，否则重启窗口即永久泄漏。
- **默认凭据零容忍**：种子口令应环境注入 + fail-fast，与加密密钥同等对待；改密必须使旧 token 失效。
- **测试绿灯要真**：静默 `return` 与空数组 `every()` 都会让套件虚假全绿，环境缺失用显式 skip 报告。
- **前端错误态不可省**：查询失败渲染成空态会误导操作决策，`useQuery` 的 `error` 必须被消费。
- **修复回归要单列检查**：「收紧暴露面」这类改动（Ingress 路径、过滤条件、白名单）必须连带验证主链路可用性——本轮问题 46/47/48 全部是修复本身引入的新故障。
- **Socket.IO namespace ≠ URL path**：入口层路由按 engine path（默认 `/socket.io/`）放行，命名空间只存在于协议握手里；本地直连测试覆盖不到 Ingress，需入口层冒烟。
- **默认凭据零容忍要覆盖全链路**：源码、编排默认值（AppHost 参数）、文档、测试兜底值都在泄漏面上，deny-list + 长度校验拦不住「足够长但公开」的默认值。
- **保留数据的重建要注意唯一键**：delete+insert 式重建必须把「被保留的集合」纳入去重，否则唯一索引冲突会在无事务路径下放大成数据丢失。
- **修复必须覆盖同一故障模式的全部路径**：改了 update/resync 忘 create、改了 agent-api 忘 admin-api，等于没修——每条修复应列出该故障模式的全部入口逐一核对（第三轮问题 53/54/55 均为「修一半」）。
- **加固策略自身要对抗建模**：限速驱逐、受信代理、按 IP 限流这类防护，要假设攻击者知道规则（灌满 Map 逐出锁定项、伪造转发头、共享 Ingress IP），否则防护只对老实人有效。
