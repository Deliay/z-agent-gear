---
description: 云Agent二期 - 实现计划，从技术提案拆解的契约先行分阶段任务（cloud-controller 服务、K8s Job 管理、工作容器回连鉴权、默认工作镜像、admin 云端容器管理页、agent-gear 兼容改造）与测试覆盖计划
type: Permanent
---

# 云Agent二期（K8s 云端工作容器） - 实现计划

**关联 Proposal**: `proposals/20261014-feat-cloud-agent-phase2.md`（v1.0）
**关联 PRD**: `docs/product/draft/20261014-cloud-agent-phase2.md`（v1.0）
**feat-branch**: `feat/cloud-agent-phase2`
**开发分支**: `servers/cloud-agent-phase2`、`apps/cloud-agent-phase2`、`packages/cloud-agent-phase2`、`tests/cloud-agent-phase2`（均基于 `feat/cloud-agent-phase2`，完成后各自提 PR 回 `feat/cloud-agent-phase2`）
**创建日期**: 2026-10-14
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约先行（cloud-controller-websocket.md + admin-cloud-container.graphql）
  └── Phase 2: cloud-controller 骨架 + CloudContainer 模型 + token-service + k8s-job-manager（K8s client 可注入）
       └── Phase 3: container-service 状态机 + status-sync（watch/对账/超时巡检）
            └── Phase 4: socketio-gateway 容器接入鉴权 + agent-gear 兼容改造（并行分支 packages/）
                 └── Phase 5: cloud-controller 内部 API + admin-api 代理（GraphQL cloud-container）
                      └── Phase 6: admin-web 云端容器管理页（列表/启动 idle/强制销毁，并行分支 apps/）
                           └── Phase 7: 默认工作镜像 + K8s 部署 manifest + cloud-controller 镜像 + Aspire + CI
                                └── Phase 8: 测试补全（tests/api cloud-controller 套件 + tests/e2e 全链路）
                                     └── Phase 9: 全量回归 + PRD 验收核对 + PR 回需求总分支
```

依赖说明：Phase 1 契约是全部实现的输入；Phase 2→3→4 为 cloud-controller 内部严格顺序（模型/token 是状态机前置、状态机是网关回调前置）；Phase 4 的 agent-gear 兼容改造（`packages/agent-controller`）与 Phase 2/3 并行推进，仅需 Phase 1 契约定型；Phase 5 依赖 Phase 2/3 的内部服务接口与 Phase 1 的 GraphQL 契约；Phase 6 仅依赖 Phase 1 契约即可先行开发（admin-api 未就绪时以 mock 响应联调）；Phase 7 依赖 Phase 2 骨架与 Phase 4 启动命令定型；Phase 8 在各实现分支覆盖单测（TDD 随行）的基础上收口集成/E2E；Phase 9 收口。按 `z-coding` 的子项目并行实现模式：`servers/cloud-agent-phase2` 承载 contracts + servers/cloud-controller + servers/admin-api + deploy/ + aspire + CI，`apps/cloud-agent-phase2` 承载 admin-web，`packages/cloud-agent-phase2` 承载 agent-controller 兼容改造，`tests/cloud-agent-phase2` 承载 tests/api + tests/e2e（在各实现分支合并后切出）。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写测试（RED）再实现（GREEN）；编码前加载 `docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端 Phase）与 `docs/engineering/frontend-rules.md`（前端 Phase）。

关键约束（提案 §5.2/§6.1，实现期不得回退）：

- **契约先行**：`contracts/cloud-controller-websocket.md`、`contracts/admin-cloud-container.graphql` 先于实现独立提交（`docs(contracts): ...`），与提案 §3.1 逐字段对齐。
- **单一事实源在 cloud-controller**：admin-api 不直连 K8s、不双写 Mongo（降级路径只读除外，见裁决 12）；容器状态、生命周期全部经 cloud-controller 内部 API（`Bearer INTERNAL_API_TOKEN`）。
- **容器鉴权为独立一次性 token**：格式 `<containerId>.<secret>`，bcrypt 哈希存 `cloudcontainers.tokenHash`，不复用 ControllerKey（提案 §4.1/§6.1）；token 随容器销毁即作废。
- **工作负载仅 Job**：`restartPolicy: Never`、`backoffLimit: 0`、`ttlSecondsAfterFinished: 600`、label `app=zag-worker` + `zag.cloud/container-id=<id>`，`runtimeClassName` 可配置（默认 `sysbox-runc`）；不引入 Deployment/Pod 等其他负载。
- **env 注入双通道**：`ZAG_SERVER_ENDPOINT=wss://<PUBLIC_WS_ENDPOINT>/worker?token=<token>` 与 `ZAG_CONTROLLER_KEY=<token>` 同时注入，后者为 agent-gear 现有参数体系兜底。
- **K8s 权限最小化**：仅配置命名空间内 Job 的 get/list/watch/create/delete；`deploy/k8s/cloud-controller.yaml` 以 ServiceAccount + Role + RoleBinding 表达。
- **agent-gear 对 controller-api 旧行为零变化**：兼容改造仅限 endpoint（带 path/query）解析与 namespace 支持，`register`/`heartbeat`/`shutdown` 事件面不变（`key` 字段保留发送、cloud-controller 侧忽略），回归锚定旧 endpoint 行为。
- **本期 purpose 仅 idle**：数据模型保留 `admin-task/workflow/session` 枚举与 `refId`/`userId` 关联字段（PRD 约束：调度入口后续迭代），服务端对非 idle 的启动请求明确拒绝。
- **resolver 合并清单登记**：admin-api 新增 Query/Mutation resolver 必须登记进 `graphql/resolvers/index.ts`（`backend-rules.md` 显性陷阱：漏登记时单测直引 resolver 对象不报错，但线上不生效）。
- **前端 GraphQL 类型全手写**：admin-web 无 codegen，`graphql/` 下查询/变更/类型全部手写并与契约人工对齐。
- **Apollo v4 轮询/加载陷阱**（`frontend-rules.md`）：加载分支一律 `loading && !data`；轮询刷新不得闪烁覆盖用户操作中的对话框。
- **测试纪律**：单元测试覆盖率 ≥ 80%（cloud-controller 核心服务）；API 与 E2E 套件串行执行（`common-rules.md` 测试陷阱）；测试服务只用 Aspire 编排（`tests/api`、`tests/e2e` AGENTS.md）。

计划期裁决（提案留白/含混的实现细节，实现期按此执行）：

1. **token 事实源以 §4.1/§6.1 为准**：提案 §2.3 模块表中 token-service「复用 ControllerKey 模型（type: cloud）」与 §4.1「不回用」矛盾，按数据模型与决策表裁决——token 直接存 `cloudcontainers.tokenHash`，全程不触碰 `controllerkeys` 集合；契约与实现文档不出现 ControllerKey。
2. **「一次性」语义 = 随容器销毁即作废**：同一容器允许用同一 token 重复握手（覆盖 agent-gear 断线自动重连），仅当容器进入终态（exited/destroying/failed）或 `tokenHash` 已清空时拒绝；校验先按 `containerId` 定位文档再 bcrypt 比对 secret，避免全表扫描。
3. **落库顺序**：`container-service.start()` ① 生成 Job 名 `zag-worker-<suffix>`（随机 6 位）并落库 CloudContainer（含 `tokenHash`、`image`、`status=creating`）取得 `_id` → ② `token-service.issue(_id)` 签发明文 token → ③ `k8s-job-manager.createJob()`（label `zag.cloud/container-id=<id>`、注入 env）→ ④ 创建失败置 `status=failed` + `exitReason`，记录保留供强制销毁清理。
4. **状态机固定为** `creating → connecting → online → destroying → exited`，失败路径终态 `failed`：Job 创建成功即 `connecting`；握手成功 `online`（写 `connectedAt`）；断线或心跳连续 3 次丢失退回 `connecting`（等待重连）；Job `Succeeded/Failed` → `exited/failed` 并写 `exitReason`。前端展示映射：创建中/连接中/在线/销毁中/已退出/失败。
5. **连接超时巡检**：`connecting` 超过 `CONNECT_TIMEOUT_MS`（默认 5 分钟，需大于 PRD 3 分钟成功目标）未回连 → `failed` + `exitReason="回连超时"`；**不自动删 Job**（PRD 异常边界：管理员可强制销毁）。
6. **destroy 幂等与强制回收**：`destroy(id)` 对在线容器 emit `shutdown`（宽限 10s 等待断开）→ `deleteJob(propagationPolicy=Foreground)` → `destroying`→`exited`（`exitReason="强制销毁"`、`tokenHash` 置空）；容器无响应或 Job 删除失败时重试 2 次后强制删除（回退 Background），确保资源回收；对终态容器重复 destroy 幂等返回成功。
7. **K8s 客户端可注入**：`K8sClient` 接口（`createJob/getJob/deleteJob/watchJobs`）+ `RealK8sClient`（`@kubernetes/client-node`）与 `InMemoryK8sClient`（本地/测试）工厂选择（`K8S_ENABLED=false` 用 mock）；tests/api 与 tests/e2e 全程 mock，不依赖真实集群，真实集群链路列为部署侧手工验收。
8. **E2E 全链路模拟工作容器**：`K8S_ENABLED=false` 下 InMemoryK8sClient 记录 Job spec，测试 harness 读取其 env（`ZAG_SERVER_ENDPOINT`/`ZAG_CONTROLLER_KEY`）拉起本地 agent-gear 进程模拟工作容器，完成「启动 idle → 回连在线 → 强制销毁 → 进程退出」确定性验证。
9. **agent-gear 兼容口径**：先实测 socket.io-client 对 `wss://host/worker?token=x` 的解析（pathname→namespace、query→handshake query）；原生支持则仅补回归测试与契约说明，不支持则在 `connectToServer` 内显式拆解 URL。改动随 `agent-gear` npm 发版（版本 minor bump + `publish-agent-gear.yml`），镜像内安装该版本。
10. **非 idle 启动请求拒绝**：`adminStartCloudContainer(purpose)` 服务端仅接受 `IDLE`，其余 purpose 返回明确错误文案（「该任务类型暂未开放」），契约字段保留为后续迭代。
11. **内网 worker 镜像不建 CI**：GitHub runner 不可达内网 Nexus/Harbor mirror，以 `deploy/images/worker/BUILD.md` 提供内网构建与自验命令；cloud-controller 镜像（`node:22-alpine`，无内网依赖）走 `build-cloud-controller-image.yml`（对齐 `build-admin-api-image.yml` 模式）。
12. **控制面离线降级为只读**：admin-api 调 cloud-controller 不可达时，`adminCloudContainers` 降级直读 Mongo `cloudcontainers` 落库状态并携带「控制面离线」提示；启动/销毁等写操作不降级，返回明确错误（`CONTROL_PLANE_UNAVAILABLE`）。
13. **端口约定**：cloud-controller dev 端口 10004（Aspire 注入 `PORT`）、config 默认 4003、publish 8003；Socket.IO 与 REST 复用同一 HTTP server（`/health`、`/internal/*`、`/worker` namespace）。
14. **内部 REST 契约不新增文件**：admin-api ↔ cloud-controller 内部 HTTP API 规范以附录形式写入 `contracts/cloud-controller-websocket.md`（与提案 §1.3 契约范围一致，不引入第三份契约文件）。
15. **在线时长不入契约**：GraphQL 不新增字段，前端以 `connectedAt` / `exitedAt` 计算（在线中 = now − `connectedAt`，已退出 = `exitedAt` − `connectedAt`）。

---

## Phase 1: 契约变更（contracts/）

开发分支：`servers/cloud-agent-phase2`（基于 `feat/cloud-agent-phase2`）。本 Phase 变更独立提交（`docs(contracts): ...`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/cloud-controller-websocket.md` | 新增 | 容器 ↔ cloud-controller 协议：复用 `agent-controller-websocket.md` v1 事件面；差异点——连接地址 `wss://<host>/worker?token=<one-time-token>`（Socket.IO namespace `/worker`）、握手 token 校验失败返回 `connect_error`（`INVALID_TOKEN`）并记录日志、`register` payload 仅需 `{hostname, version, platform}`（`key` 字段服务端忽略，由握手 token 替代）、`shutdown` 通知容器清理退出、心跳 30s 一次连续 3 次丢失判定离线；附录 A：内部管理 HTTP API（`GET/POST /internal/containers`、`DELETE /internal/containers/:id`，`Bearer INTERNAL_API_TOKEN`，裁决 14） |
| `contracts/admin-cloud-container.graphql` | 新增 | `type CloudContainer { id, name, status, purpose, refId, createdAt, connectedAt, exitedAt, exitReason }`（与提案 §3.1 逐字段一致）；`enum CloudContainerStatus { CREATING CONNECTING ONLINE EXITED DESTROYING FAILED }`、`enum CloudContainerPurpose { IDLE ADMIN_TASK WORKFLOW SESSION }`；`Query.adminCloudContainers: [CloudContainer!]!`；`Mutation.adminStartCloudContainer(purpose: CloudContainerPurpose!): CloudContainer!`、`adminDestroyCloudContainer(id: ID!): Boolean!`；注释注明 admin JWT 鉴权（`UNAUTHENTICATED`）、本期仅 `IDLE`（裁决 10）、状态语义（裁决 4） |

两份契约注明鉴权要求：GraphQL 操作需 `Authorization: Bearer <admin JWT>`；WebSocket 握手需合法一次性 token。

### 验收 checklist

- [ ] 两份契约与提案 §3.1 逐字段一致；状态/用途枚举与裁决 4/10 语义注释完整
- [ ] 契约变更独立提交，后续 Phase 才动实现代码
- [ ] `cloud-controller-websocket.md` 明确「key 字段忽略、token 由握手 query 承载」的兼容口径（裁决 2/9）

---

## Phase 2: cloud-controller 骨架 + 模型 + token + K8s Job 管理

开发分支：`servers/cloud-agent-phase2`。TDD 顺序：先写 `services/token-service.test.ts` / `services/k8s-job-manager.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/package.json` | 新增 | `name: cloud-controller`、`"type": "module"`；依赖对齐 controller-api（express ^5、socket.io ^4、mongoose ^9、dotenv、cors）+ `@kubernetes/client-node`、`bcryptjs`；devDeps（typescript ~6、tsx、vitest、@vitest/coverage-v8、@types/*、socket.io-client 供协议测试）；scripts：`dev`=tsx watch、`build`=tsc、`start`=node dist、`test`/`test:coverage` |
| `servers/cloud-controller/tsconfig.json` | 新增 | strict，ESM，对齐 controller-api |
| `servers/cloud-controller/src/config/index.ts` | 新增 | `port`←`PORT`（默认 4003）、`mongodbUri`←`MONGODB_URI`、`internalApiToken`←`INTERNAL_API_TOKEN`、`k8sNamespace`←`K8S_NAMESPACE`、`workerImage`←`WORKER_IMAGE`、`publicWsEndpoint`←`PUBLIC_WS_ENDPOINT`、`connectTimeoutMs`←`CONNECT_TIMEOUT_MS`（默认 300000）、`k8sEnabled`←`K8S_ENABLED`（默认 `true`）、`runtimeClassName`←`RUNTIME_CLASS_NAME`（默认 `sysbox-runc`）；关键配置缺失启动即报错不静默 |
| `servers/cloud-controller/src/models/cloud-container.ts` | 新增 | 显式集合名 `cloudcontainers`：`name` unique required（`zag-worker-<suffix>`）、`namespace`、`status` enum `creating/connecting/online/exited/destroying/failed`（default `creating`）、`purpose` enum `idle/admin-task/workflow/session`、`refId`、`userId`、`tokenHash`、`image`、`connectedAt`/`exitedAt`、`exitReason`、timestamps（裁决 3/4） |
| `servers/cloud-controller/src/services/token-service.ts` | 新增 | `issue(containerId)` → `<containerId>.<secret>`（`crypto.randomBytes(32)` base64url）+ bcrypt 哈希（`SALT_ROUNDS=10`）；`verify(token)`：解析 containerId 定位文档 → `bcrypt.compare`，终态容器或 `tokenHash` 空拒绝（裁决 2） |
| `servers/cloud-controller/src/services/k8s-client.ts` | 新增 | `K8sClient` 接口（`createJob/getJob/deleteJob/watchJobs`）；`RealK8sClient`（`@kubernetes/client-node` BatchV1Api + Watch）与 `InMemoryK8sClient`（本地/测试，记录 Job spec 供 E2E 取 env，裁决 7/8）；工厂按 `k8sEnabled` 选择 |
| `servers/cloud-controller/src/services/k8s-job-manager.ts` | 新增 | Job manifest 生成与 CRUD：namespace 取配置、镜像 `WORKER_IMAGE`、`runtimeClassName`、`restartPolicy: Never`、`backoffLimit: 0`、`ttlSecondsAfterFinished: 600`、labels `app=zag-worker` + `zag.cloud/container-id`、env `ZAG_SERVER_ENDPOINT=wss://<PUBLIC_WS_ENDPOINT>/worker?token=<token>` 与 `ZAG_CONTROLLER_KEY=<token>`（URL 编码正确）；`deleteJob` 默认 `propagationPolicy: Foreground`（失败重试回退 Background，裁决 6） |
| `servers/cloud-controller/src/services/token-service.test.ts`、`k8s-job-manager.test.ts` | 新增 | 单测 T-T* / T-K* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-T1 | `issue` → `verify` roundtrip | 通过，返回 containerId |
| T-T2 | 篡改 secret / 缺失 containerId | 拒绝 |
| T-T3 | 未知 containerId | 拒绝且无 bcrypt 全表扫描（定位先行） |
| T-T4 | 终态容器 / `tokenHash` 已清空 | 拒绝（token 随销毁作废） |
| T-K1 | manifest 生成 | namespace/image/labels/runtimeClassName/restartPolicy/backoffLimit/ttl 逐项断言 |
| T-K2 | env 注入 | `ZAG_SERVER_ENDPOINT` 带 `/worker?token=` 且编码正确；`ZAG_CONTROLLER_KEY` 双通道一致 |
| T-K3 | `createJob` 失败 | 抛错上抛（供 start 回滚置 failed） |
| T-K4 | `deleteJob` | Foreground 参数正确；失败重试后回退 Background |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/services/token-service.test.ts src/services/k8s-job-manager.test.ts
cd servers/cloud-controller && npm run build   # tsc strict 通过
```

### 验收 checklist

- [ ] T-T* / T-K* 全部通过
- [ ] `cloudcontainers` 显式集合名、字段与提案 §4.1 一致；无任何 `controllerkeys` 读写（裁决 1）
- [ ] `INTERNAL_API_TOKEN`/`K8S_NAMESPACE` 等关键配置缺失启动即报错
- [ ] K8s 交互全部经 `K8sClient` 接口，单测不依赖真实集群

---

## Phase 3: container-service 状态机 + status-sync

开发分支：`servers/cloud-agent-phase2`。TDD 顺序：先写 `services/container-service.test.ts` / `services/status-sync.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/services/container-service.ts` | 新增 | 生命周期编排（裁决 3/4/6）：`start(purpose, refId?)`（落库→issue→createJob→失败置 failed）、`markConnecting`/`markOnline`（写 `connectedAt`）、`markExited(exitReason)`、`destroy(id)`（回调 gateway 发 `shutdown` → deleteJob → `destroying`→`exited` + `tokenHash` 置空）、`list()`（落库状态合并 K8s 实时状态） |
| `servers/cloud-controller/src/services/status-sync.ts` | 新增 | watch Jobs（label `app=zag-worker`）：`Failed`→`failed`、`Succeeded`→`exited`、Job 被删（非销毁流程）→ `exited`/`failed` + `exitReason`；watch 断开自动重连 + 全量对账（list 比对）；超时巡检（`connecting` 超时→`failed`「回连超时」，裁决 5）；心跳丢失 3 次→`connecting`（裁决 4） |
| `servers/cloud-controller/src/services/container-service.test.ts`、`status-sync.test.ts` | 新增 | 单测 T-S* / T-Y* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-S1 | `start(idle)` | 落库顺序与状态正确（creating→connecting），token 双通道注入 |
| T-S2 | `createJob` 失败 | `failed` + `exitReason`，记录保留可强制销毁 |
| T-S3 | `destroy` 在线容器 | `shutdown` 通知 → deleteJob → `exited`，`tokenHash` 清空后握手被拒 |
| T-S4 | `destroy` 离线/无响应容器 | 仍强制删 Job 回收资源（裁决 6 重试与回退） |
| T-S5 | `destroy` 终态容器（幂等） | 返回成功不报错、不重复删 Job |
| T-Y1 | Job `Failed` 事件 | `failed` + `exitReason` 保留（OOM 等异常退出可追溯） |
| T-Y2 | Job `Succeeded` 事件 | `exited` |
| T-Y3 | `connecting` 超时 | `failed` + `exitReason="回连超时"`，Job 不自动删 |
| T-Y4 | 心跳连续丢失 3 次 / 重连 | 退回 `connecting` / 回到 `online` |
| T-Y5 | watch 断开重连 | 全量对账后状态与 K8s 实际一致 |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/services/container-service.test.ts src/services/status-sync.test.ts
```

### 验收 checklist

- [ ] T-S* / T-Y* 全部通过
- [ ] 状态机全部转移有单测锚定（裁决 4），状态语义与契约枚举一致
- [ ] 销毁路径满足 PRD「容器退出 + Job 删除 + 列表状态同步」；超时容器可被强制销毁清理

---

## Phase 4: socketio-gateway 容器接入 + agent-gear 兼容改造

开发分支：`servers/cloud-agent-phase2`（gateway）与 `packages/cloud-agent-phase2`（agent-controller，**并行**）。TDD 顺序：先写 `services/socketio-gateway.test.ts`（RED）→ 实现（GREEN）；agent-controller 先写 endpoint 解析回归测试（RED）→ 兼容实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/services/socketio-gateway.ts` | 新增 | Socket.IO namespace `/worker`：middleware 读 `handshake.query.token` → `token-service.verify`，失败 `connect_error`（`INVALID_TOKEN`）并记录日志（PRD 非法 token 拒绝可追溯）；`register` 忽略 `key`、取 `hostname/version/platform`、绑定 containerId → `online` + `connectedAt`（回调 container-service）；`heartbeat` 计时（30s 期望、3 次丢失回调判离线）；`shutdown` emit + 10s 宽限；`disconnect` 回调状态机 |
| `servers/cloud-controller/src/index.ts` | 新增 | Express + http server + Socket.IO 装配（gateway + internal routes + `/health`）+ mongoose 连接 + status-sync 启动；启动流程幂等可重复（测试与本地开发） |
| `servers/cloud-controller/src/services/socketio-gateway.test.ts` | 新增 | 协议测试 T-G*（socket.io-client 真连，mock K8s） |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | `connectToServer(endpoint, key)` 兼容带 path/query 的 endpoint（裁决 9：实测 socket.io-client 解析，必要时显式拆解 URL——pathname→namespace、query→handshake query）；对 controller-api 旧行为零变化 |
| `packages/agent-controller/src/socketio-client.test.ts`（或 `endpoint-compat.test.ts`） | 新增 | endpoint 解析回归：旧 `http://host:port` → 默认 namespace 无 query（兼容锚点）；新 `wss://host/worker?token=x` → namespace `/worker` + handshake query |
| `packages/agent-controller/package.json` | 修改 | 版本 minor bump（随 npm 发版供镜像预装，裁决 9） |
| `contracts/agent-controller-websocket.md` | 修改 | 补充「cloud-controller 接入场景」说明：token 由握手 query 承载、`key` 字段被忽略（不破坏既有握手，向后兼容注释） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-G1 | 无 token / 伪 token / 已销毁容器 token 握手 | `connect_error`（`INVALID_TOKEN`），日志记录来源 |
| T-G2 | 合法 token 握手 + `register` | `registered`，状态 `online`、`connectedAt` 写入 |
| T-G3 | `register` 携带 `key` 字段 | 被忽略，不影响绑定（协议兼容） |
| T-G4 | emit `shutdown` | 客户端收到事件并退出（断言进程清理路径被触发） |
| T-G5 | 心跳连续缺失 3 次 | 判离线回调触发（状态退回 `connecting`） |
| T-P1 | agent-gear 旧 endpoint 连接 controller-api | 行为零变化（回归锚点） |
| T-P2 | agent-gear 新 endpoint（`/worker` + token） | namespace/query 解析正确、握手成功 |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/services/socketio-gateway.test.ts
cd packages/agent-controller && npx vitest run
```

### 验收 checklist

- [ ] T-G* / T-P* 全部通过
- [ ] 非法 token 拒绝 + 日志（PRD 功能点 2 / 异常边界）；`key` 校验逻辑不引入（由 token 替代）
- [ ] agent-gear 对 controller-api 旧行为回归通过后才合入；`agent-controller-websocket.md` 兼容说明同步

---

## Phase 5: cloud-controller 内部 API + admin-api 代理

开发分支：`servers/cloud-agent-phase2`。TDD 顺序：先写 `routes/internal-api.test.ts` 与 admin-api `services/cloud-controller-client.test.ts` / `resolvers/cloud-container.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/middleware/internal-auth.ts` | 新增 | `Authorization: Bearer <INTERNAL_API_TOKEN>` 校验，失败 401（时序安全比较） |
| `servers/cloud-controller/src/routes/internal-api.ts` | 新增 | `GET /internal/containers`（含 K8s 实时状态合并）、`POST /internal/containers`（`{purpose}`，裁决 10 仅 IDLE）、`DELETE /internal/containers/:id`（幂等）；错误映射（404/409/500） |
| `servers/admin-api/src/config/index.ts` | 修改 | 新增 `cloudControllerUrl`←`CLOUD_CONTROLLER_URL`、`internalApiToken`←`INTERNAL_API_TOKEN` |
| `servers/admin-api/src/services/cloud-controller-client.ts` | 新增 | `list/start/destroy`（fetch + Bearer + 5s 超时）；不可达抛 `CONTROL_PLANE_UNAVAILABLE`（裁决 12） |
| `servers/admin-api/src/models/cloud-container.ts` | 新增 | 降级只读 Mongoose 模型（对齐 cloud-controller schema，仅 `find`，不写） |
| `servers/admin-api/src/graphql/schemas/cloud-container.ts`、`schemas/index.ts` | 新增/修改 | 对齐 `contracts/admin-cloud-container.graphql`（enums + 三操作） |
| `servers/admin-api/src/graphql/resolvers/cloud-container.ts`、`resolvers/index.ts` | 新增/修改 | 薄 resolver + `assertAdmin` 守卫（复用 `guard.ts`）；list 走 client、不可达降级只读 Mongo + 「控制面离线」提示；写操作不降级 |
| `servers/cloud-controller/src/routes/internal-api.test.ts`、`servers/admin-api/src/services/cloud-controller-client.test.ts`、`resolvers/cloud-container.test.ts` | 新增 | 单测 T-R* / T-IA* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-R1 | `GET/POST/DELETE /internal/containers*`（mock K8s） | 状态码与响应体符合契约附录 A |
| T-R2 | Bearer token 缺失/错误 | 401 |
| T-R3 | `POST {purpose: WORKFLOW}` 等非 idle | 明确错误文案「该任务类型暂未开放」（裁决 10） |
| T-R4 | `DELETE` 不存在/终态容器 | 404 / 幂等成功（裁决 6） |
| T-IA1 | `adminCloudContainers` | 经内部 API 代理返回，字段与契约一致 |
| T-IA2 | cloud-controller 不可达 | 降级 Mongo 落库状态 + 控制面离线提示 |
| T-IA3 | `adminStartCloudContainer(IDLE)` | POST 代理成功并返回容器 |
| T-IA4 | `adminDestroyCloudContainer(id)` | DELETE 代理成功返回 `true` |
| T-IA5 | 非管理员 / 未改密调用 | `UNAUTHENTICATED` / `MUST_CHANGE_PASSWORD`（守卫回归） |
| T-IA6 | 写操作在控制面离线时 | `CONTROL_PLANE_UNAVAILABLE`（不降级写） |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/routes
cd servers/admin-api && npx vitest run src/services/cloud-controller-client.test.ts src/graphql/resolvers/cloud-container.test.ts
```

### 验收 checklist

- [ ] T-R* / T-IA* 全部通过
- [ ] `resolvers/index.ts` 已登记全部 resolver（backend-rules 陷阱）
- [ ] admin-api 无任何 K8s 依赖、无双写 Mongo（降级仅只读）；GraphQL 类型与契约逐字段一致

---

## Phase 6: admin-web 云端容器管理页

开发分支：`apps/cloud-agent-phase2`（可与 Phase 2~5 并行，仅依赖 Phase 1 契约）。TDD 顺序：先写组件测试（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/admin-web/src/pages/CloudContainersPage.tsx` | 新增 | 「云端容器」页：列表（名称/状态/用途/关联对象/创建时间/在线时长，裁决 15）+ 10s 轮询 + 「启动」按钮 + 行内「强制销毁」 |
| `apps/admin-web/src/components/cloud-containers/StartContainerDialog.tsx` | 新增 | 启动对话框：任务下拉（本期仅「idle」）+ 确认/取消（PRD 3.4） |
| `apps/admin-web/src/components/cloud-containers/DestroyConfirmDialog.tsx` | 新增 | 强制销毁二次确认：容器名称提示 + 确认/取消 |
| `apps/admin-web/src/components/cloud-containers/ContainerStatusBadge.tsx` | 新增 | 状态徽标（创建中/连接中/在线/销毁中/已退出/失败，裁决 4 映射） |
| `apps/admin-web/src/components/AdminLayout.tsx` | 修改 | 侧边栏加「云端容器」入口 + 当前项高亮 |
| `apps/admin-web/src/App.tsx` | 修改 | 受保护路由 `/cloud-containers` |
| `apps/admin-web/src/graphql/queries.ts`、`mutations.ts`、`types.ts` | 修改 | 手写 `adminCloudContainers`/`adminStartCloudContainer`/`adminDestroyCloudContainer` 文档与类型（enums 全量） |
| `apps/admin-web/src/lib/format.ts` | 修改 | 在线时长格式化（`connectedAt`→now 或 `exitedAt`，裁决 15） |
| `apps/admin-web/src/components/__tests__/cloud-containers.test.tsx`（或 `pages/__tests__/CloudContainersPage.test.tsx`） | 新增 | 组件测试 T-W* |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-W1 | 列表渲染 + 轮询 | 字段齐全、轮询刷新不打断对话框 |
| T-W2 | 启动对话框选 idle → 确认 | `adminStartCloudContainer(IDLE)` 发出、列表刷新 |
| T-W3 | 强制销毁 | 二次确认后 `adminDestroyCloudContainer(id)`、状态同步 |
| T-W4 | 状态与在线时长 | 各状态徽标正确、时长按裁决 15 计算 |
| T-W5 | 控制面离线 | 展示降级数据 + 「控制面离线」提示 |
| T-W6 | 空列表 | 空状态与「启动」引导 |

### 命令参考

```bash
cd apps/admin-web && npx vitest run && npm run build && npm run lint
```

### 验收 checklist

- [ ] T-W* 全部通过
- [ ] PRD 3.4 页面/对话框元素逐项核对（列表字段、启动对话框仅 idle、销毁确认框）
- [ ] 仅管理员可访问（`ProtectedRoute` 回归）；加载态 `loading && !data`（Apollo v4 陷阱）
- [ ] TypeScript strict 编译通过、无跨项目 import

---

## Phase 7: 默认工作镜像 + K8s 部署 + 编排 + CI

开发分支：`servers/cloud-agent-phase2`（deploy/、aspire/ 与 `.github/workflows/` 归属该分支）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `deploy/images/worker/Dockerfile` | 新增 | `FROM ubuntu:24.04`；`/etc/apt/sources.list.d/ubuntu.sources` → `https://nexus.internal.fffdan.com/repository/ubuntu-proxy/`；安装 nodejs（apt 优先，NodeSource 地址 ARG 参数化）、git、`gh`（GitHub CLI）、`docker-ce-cli` + `docker-buildx-plugin`、containerd、sysbox 运行依赖；`npm config set registry https://nexus.internal.fffdan.com/repository/npm-proxy/`；`npm install -g agent-gear @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp @opencode/cli @openai/codex @anthropic-ai/claude-code @google/gemini-cli`（PRD 功能点 3 全量 7 包）；COPY `entrypoint.sh` |
| `deploy/images/worker/entrypoint.sh` | 新增 | 启动容器内 dockerd（dind，sysbox 环境）；镜像引用规范化 shim（`ubuntu:latest`→`core.harbor.internal.fffdan.com/docker-hub-proxy/ubuntu:latest`、`ghcr.io/{image}`→`core.harbor.internal.fffdan.com/ghcr/{image}`，其余原样，提案 §6.1 前缀规范化决策）；`exec agent-gear`（参数取 `ZAG_SERVER_ENDPOINT`/`ZAG_CONTROLLER_KEY`）；SIGTERM/SIGINT 优雅退出（agent-gear 现有 shutdown 处理） |
| `deploy/images/worker/BUILD.md` | 新增 | 内网构建与自验命令：`docker build`、`node/git/gh/docker buildx` 可用、7 个 npm 包可执行、Docker Hub/ghcr 拉取走代理（裁决 11） |
| `deploy/k8s/cloud-controller.yaml` | 新增 | ServiceAccount + Role（单命名空间 Job get/list/watch/create/delete）+ RoleBinding + Deployment + Service + Ingress（wss）示例；注释前置条件：sysbox runtimeClass 节点预装、内网 mirror 可达、RBAC 收敛（提案 §5.2 实现点 1 风险点） |
| `servers/cloud-controller/Dockerfile` | 新增 | 多阶段 `node:22-alpine`（build `npm ci` 缓存挂载 + runtime `USER node` + ENTRYPOINT），对齐 admin-api Dockerfile |
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | 注册 `cloudController = AddNodeApp("cloud-controller", "../../servers/cloud-controller", "src/index.ts")`：`WithReference(mongodb)`、注入 `INTERNAL_API_TOKEN`、`K8S_NAMESPACE`、`WORKER_IMAGE`、`PUBLIC_WS_ENDPOINT`、`K8S_ENABLED=false`（本地 mock，裁决 7）；dev 端口 10004 / publish 8003；publish 以自身 Dockerfile 构建镜像注册 compose 服务 |
| `.github/workflows/build-cloud-controller-image.yml` | 新增 | 对齐 `build-admin-api-image.yml`：`release`/`release/**` + `paths: servers/cloud-controller/**` + `workflow_dispatch`；buildx 推送 `zero-tools/cloud-controller:<sha>` + `:latest` |
| `README.md`、根 `AGENTS.md`、`aspire/AgentGear.AppHost/AGENTS.md` | 修改 | 项目结构与启动说明补 `servers/cloud-controller`、`deploy/`；AppHost 资源表补 cloud-controller |

### 验收 checklist

- [ ] `aspire start` 拉起 cloud-controller（10004），`/health` 可用；`K8S_ENABLED=false` 下内部 API 可跑通 mock 链路
- [ ] `aspire publish -o aspire/manifest` 产物含 cloud-controller；清理 `*.Dockerfile` 流程不受影响
- [ ] `docker build servers/cloud-controller` 成功；worker 镜像在内网构建成功且 7 个包可执行（有内网环境时按 `BUILD.md` 执行，否则留待部署侧验收）
- [ ] `deploy/k8s/cloud-controller.yaml` 语法正确、RBAC 仅限单命名空间 Job；CI workflow 与既有流水线模式一致

---

## Phase 8: 测试补全（tests/api + tests/e2e）

开发分支：`tests/cloud-agent-phase2`（基于 `feat/cloud-agent-phase2`，在 Phase 2~7 实现合并后切出）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/cloud-controller/internal-api.test.ts` | 新增 | T-IC*：内部 REST 三端点全量、Bearer 401、非 idle 拒绝、幂等销毁（mock K8s） |
| `tests/api/src/cloud-controller/worker-handshake.test.ts` | 新增 | T-IW*：socket.io-client 真连 cloud-controller——token 拒绝/通过、`register` 绑定、`shutdown` 触发退出（真实 agent-gear 进程断言，`common-rules.md` spawn 环境隔离陷阱：不透传宿主 `ZAG_*`） |
| `tests/api/src/admin-api/cloud-container.test.ts` | 新增 | T-IA*：admin GraphQL 三操作、非管理员拒绝、控制面离线降级（`gqlRequest` 模式对齐 `admin-api/helpers.ts`） |
| `tests/e2e/src/admin-cloud-container.spec.ts` | 新增 | T-E*：登录 → 云端容器页 → 启动 idle → 模拟工作容器回连在线 → 强制销毁 → 进程退出/Job 删除/列表状态同步（裁决 8） |
| `tests/e2e/src/helpers.ts` | 修改 | 增加 `adminGqlRequest`/云端容器相关 helper（如缺） |
| `tests/api/AGENTS.md`、`tests/e2e/AGENTS.md` | 修改 | 补 `CLOUD_CONTROLLER_URL`、`CLOUD_CONTROLLER_INTERNAL_TOKEN` 等环境变量与 `aspire wait cloud-controller` 步骤 |

### 测试用例（E2E 增量）

| # | 用例 | 预期 |
|---|------|------|
| T-E1 | 启动 idle 容器 | 列表出现 creating→connecting→online，3 分钟内回连（PRD 成功标准） |
| T-E2 | 未带 token / 伪 token 连接 | 拒绝（PRD 成功标准/功能点 2） |
| T-E3 | 强制销毁 | 二次确认 → 容器进程退出 + Job 删除 + 列表状态同步（PRD 功能点 4） |
| T-E4 | 异常退出/超时 | 状态失败并保留 `exitReason`，可强制销毁清理（PRD 3.5） |
| T-E5 | 非管理员访问 | 拒绝访问（PRD 3.5） |
| T-E6 | 列表与实际 Job 一致 | mock K8s 对账断言（PRD 成功标准） |

### 命令参考

```bash
aspire start && aspire wait cloud-controller && aspire wait admin-api
cd tests/api && API_URL=http://localhost:10001/graphql ADMIN_API_URL=http://localhost:10003/graphql CONTROLLER_API_URL=http://localhost:33237 CLOUD_CONTROLLER_URL=http://localhost:10004 npm test
# E2E（与 API 套件串行，common-rules 测试陷阱）
aspire start && aspire wait admin-web && aspire wait admin-api && aspire wait cloud-controller
cd tests/e2e && ADMIN_WEB_URL=<aspire describe admin-web> CLOUD_CONTROLLER_URL=<...> npx playwright test admin-cloud-container.spec.ts
```

### 验收 checklist

- [ ] T-IC* / T-IW* / T-IA* / T-E* 全部通过
- [ ] API 与 E2E 串行执行；测试仅用 Aspire 编排服务、K8s 全 mock（裁决 7/8）
- [ ] 各实现分支单测覆盖率 ≥ 80%（token/状态机/job-manager 重点）

---

## Phase 9: 全量回归 + PRD 验收核对 + PR

### 命令参考

```bash
# 后端
cd servers/cloud-controller && npm run build && npx vitest run --coverage
cd servers/admin-api && npm run build && npx vitest run
# agent-controller 兼容回归
cd packages/agent-controller && npm run build && npx vitest run
# 前端
cd apps/admin-web && npm run build && npm run lint && npx vitest run
# API / E2E 全量（串行，见 tests/api、tests/e2e AGENTS.md）
```

### 总体验收 checklist

- [ ] 单元测试覆盖率 ≥ 80%（common-rules）
- [ ] API 测试通过（内部 REST 全端点 + admin GraphQL + 协议握手）
- [ ] E2E 测试通过（启动 idle → 在线 → 强制销毁全链路）
- [ ] PRD 验收标准逐条核对（`docs/product/draft/20261014-cloud-agent-phase2.md` §1.3 + §3.2 各功能点）
  - [ ] cloud-controller 单命名空间 Job 增删查、用途/关联记录（功能点 1）
  - [ ] 回连注册、token 鉴权拒绝伪造连接、销毁后进程退出 Job 回收、空闲在线不自动退出（功能点 2）
  - [ ] 镜像内网构建、`node/git/gh/docker buildx` 与 7 个 npm 包可用、拉镜像走内网代理、默认启动即回连（功能点 3）
  - [ ] 容器列表状态/用途/关联展示、启动对话框仅 idle、强制销毁二次确认与状态同步、仅管理员（功能点 4）
- [ ] PRD 3.5 异常边界逐条核对（启动失败、回连超时、销毁无响应强制删 Job、异常退出保留原因、非法 token 拒绝留日志、非管理员拒绝）
- [ ] 提案 §10 验收标准逐条核对（契约评审、单元/API/E2E、镜像构建、token 鉴权）
- [ ] 四个开发分支 PR review 通过并合并回 `feat/cloud-agent-phase2`（需求总 PR #205 自动更新）

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| socket.io-client 对带 path/query endpoint 的解析与预期不符 | 先实测再改造（裁决 9）；兼容改动以旧 endpoint 回归测试锚定（T-P1），agent-gear 发版前用旧版验证 controller-api 链路零变化，异常即回退该 commit |
| 一次性 token 与 agent-gear 自动重连冲突 | 裁决 2：同容器重连允许重复握手，仅终态作废；T-G2/T-S3 覆盖 |
| token 出现在 Job env 可被同 namespace describe 权限者看到 | RBAC 收敛到单命名空间 + token 随容器销毁即作废（提案风险点）；泄露面限于可控命名空间 |
| sysbox 为节点级 runtime，集群未预装则 Pod 无法调度 | `deploy/k8s` 文档列为前置条件；本地/CI 全 mock 不阻塞开发（裁决 7） |
| 内网 Nexus/Harbor mirror 不可达导致 worker 镜像构建失败 | Dockerfile 源地址 ARG 参数化；`BUILD.md` 提供构建与自验命令；不影响代码合入与 mock 链路测试 |
| K8s watch 断连导致状态漂移 | watch 自动重连 + 全量对账（T-Y5）；列表请求实时合并 K8s 状态兜底 |
| agent-gear npm 发版滞后于镜像构建 | 镜像内安装兼容版本（固定版本号）；本地 `npm pack` 验证后再发版（裁决 9） |
| cloud-controller 不可达 | admin-api 列表降级只读 + 「控制面离线」提示；写操作明确报错不静默（裁决 12） |
| 销毁无响应导致 Job/容器残留 | 重试 + Foreground→Background 强制删除（裁决 6）；退出原因记录、可重复强制销毁 |
| `createJob` 成功但落库/回写失败产生孤儿 Job | status-sync 全量对账识别无主 Job 并标记 failed；label `zag.cloud/container-id` 支持人工清理 |

## 相关文档

- 关联 PRD：`docs/product/draft/20261014-cloud-agent-phase2.md`
- 关联 Proposal：`docs/engineering/proposals/20261014-feat-cloud-agent-phase2.md`
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
- 测试规范：`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`
- 参考实现范式：`docs/engineering/plan/20261014-feat-admin-console.md`（admin-api/admin-web 集成模式）、`contracts/agent-controller-websocket.md`（事件面复用基准）
