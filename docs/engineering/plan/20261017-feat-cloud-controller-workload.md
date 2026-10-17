---
description: 云控制器工作负载功能实现计划：从技术提案拆解出的契约先行分阶段任务（admin-api 工作负载 CRUD、cloud-controller 脚本下发/状态机/日志留档、agent-gear 脚本执行器、admin-web 工作负载页与初始化进度/日志查看）与测试覆盖计划
type: Permanent
---

# 云控制器工作负载（Workload）功能 - 实现计划

**关联 Proposal**: `proposals/20261017-feat-cloud-controller-workload.md`（v1.1）
**关联 PRD**: `docs/product/draft/20261017-cloud-controller-workload.md`（v1.1）
**feat-branch**: `feat/cloud-controller-workload`（自 `prd/cloud-controller-workload` 切出）
**开发分支**: `servers/cloud-controller-workload`、`apps/cloud-controller-workload`、`packages/cloud-controller-workload`、`tests/cloud-controller-workload`（均基于 `feat/cloud-controller-workload`，完成后各自提 PR 回 feat 分支）
**创建日期**: 2026-10-17
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约先行（新增 admin-cloud-workload.graphql；扩展 admin-cloud-container.graphql / cloud-controller-websocket.md）
  ├── Phase 2: admin-api 工作负载 CRUD（模型/服务/resolver/降级只读模型）+ 容器 GraphQL 字段扩展
  ├── Phase 3: cloud-controller 数据模型 + 配置 + 状态机 initializing + 内部 API 扩展
  │     └── Phase 4: workload-dispatcher（下发/推进/看门狗/日志留档）+ gateway 接入 + destroy 清理脚本时序
  ├── Phase 5: agent-gear workload-executor（执行/超时/截断/重连重放）+ 版本 bump
  └── Phase 6: admin-web 工作负载页 + 启动多选 + 初始化中状态/当前脚本 + 日志查看
        └── Phase 7: 部署与编排收口（worker 镜像/BUILD.md、Aspire 变量、文档索引）
              └── Phase 8: 测试补全（tests/api + tests/e2e）
                    └── Phase 9: 全量回归 + PRD/提案验收核对 + PR 回需求总分支
```

依赖说明：Phase 1 契约是全部实现的输入。Phase 2（admin-api）与 Phase 3（cloud-controller 模型/状态机）仅依赖 Phase 1，可并行；Phase 4 依赖 Phase 3 的模型/状态机与 Phase 1 的 WS 协议；Phase 5（agent-gear）仅依赖 Phase 1 协议即可并行开发，但联调需 Phase 4；Phase 6 仅依赖 Phase 1/2 契约（admin-api 未就绪时以 mock 响应开发）；Phase 7 依赖 Phase 3~5 的配置项定型；Phase 8 在实现分支合并后切出；Phase 9 收口。

开发模式采用 TDD（红-绿-重构）：每个 Phase 先写测试（RED）再实现（GREEN）。编码前加载 `docs/engineering/common-rules.md`、`backend-rules.md`（后端 Phase）与 `frontend-rules.md`（前端 Phase），并遵循各子项目 `AGENTS.md`。

### 关键约束（提案 §5.2/§6.1，实现期不得回退）

- **契约先行**：三份契约先于实现独立提交（`docs(contracts): ...`），字段与提案 §3 逐项对齐。
- **脚本不经 K8s env 注入**：Job manifest 与现状完全一致；脚本只经 Socket.IO `/worker` 下发（`workload:run`），执行结果经 `workload:result` 回报。
- **脚本留档**：`cloudworkloadlogs.script` 在下发时写入当时脚本快照；工作负载后续编辑/删除不影响已产生记录。
- **单一事实源**：容器状态与执行日志由 cloud-controller 写入；admin-api 仅经内部 API 读写（日志查询降级直读 Mongo 只读，沿用容器列表降级口径）。
- **不加 K8s 权限**：不新增 pods/logs 权限，RBAC/manifest 不变。
- **旧 worker 兼容**：未升级的 worker 忽略 `workload:run`，由服务端看门狗将记录标 `TIMEOUT` 并继续推进；存量容器行为不变。
- **前端 GraphQL 类型手写**：admin-web 无 codegen，`graphql/` 下类型与契约人工对齐。
- **resolver 登记**：新增 schema/resolver 与 `CloudContainer.workloads` 类型级 resolver 必须登记进 `graphql/schemas/index.ts`、`graphql/resolvers/index.ts`（`backend-rules.md` 显性陷阱）。
- **Apollo v4 轮询陷阱**：加载分支一律 `loading && !data`；轮询刷新不得关闭用户正在操作的对话框（`frontend-rules.md`）。
- **测试纪律**：新增代码单测覆盖率 ≥ 80%；API 与 E2E 串行执行；测试服务只用 Aspire 编排。

## 计划期裁决（提案留白/含混处的实现口径）

1. **post 脚本与 shutdown 的时序**：post 批次一律走 `workload:run { phase: "post" }`，服务端等待最后一条 `workload:result`（或预算耗尽）后才 emit `shutdown { reason }`；`shutdown` 载荷不携带 items（仅允许追加 `graceMs` 供日志），旧 worker 行为零变化。
2. **脚本读取与快照时机**：dispatcher 在 register 接受后（init）与 destroy 开始时（post）从 `cloudworkloads` 读取脚本，并**在创建日志记录时写入 `script` 快照**；容器启动后对工作负载的编辑不影响本次执行（PRD 3.5）。
3. **工作负载在执行前被删除**：为缺失项创建一条 `FAILED` 记录（`script=""`、`log="工作负载已删除，跳过执行"`、`finishedAt=now`），继续后续条目，不阻断容器上线；容器列表的 `workloads` 字段省略已删除项，日志视图仍按快照名称展示。
4. **时间戳权威性**：`startedAt/finishedAt` 以 cloud-controller 服务端时间为准；worker 上报的时间仅拼入日志文本，不直接落库（避免容器时钟漂移污染数据）。
5. **init 完成后的状态**：所有 init 记录进入终态后，若该容器仍有活跃 socket → CAS 置 `online`；若已无活跃 socket（掉线/结果由看门狗收口）→ CAS 置 `connecting`；两条路径均清空 `currentWorkloadName`、写入 `connectedAt`（仅 online）。
6. **重连不重发**：socket 重连后 dispatcher 不重新下发 init 批次（worker 进程未重启，执行仍在内存中继续）；worker 将未确认结果保存在内存（上限 50 条）并在 `connect` 时重放，服务端按「记录已终态则忽略」幂等处理。真正丢失的结果由看门狗标 `TIMEOUT` 收口。
7. **销毁时 init 尚未结束**：先把该容器所有非终态 init 记录标 `TIMEOUT`（log 追加「容器销毁中断」），再进入 post 批次；worker 收到 post 批次时终止当前 init 子进程（杀进程组）后执行 post，服务端对迟到的 init 结果按终态幂等忽略。
8. **销毁时容器无活跃连接**：不等待 post 预算，post 记录直接标 `TIMEOUT`（log「容器未连接，未执行」），立即走既有 shutdown/删 Job 流程。
9. **宽限口径**：post 批次预算 `WORKLOAD_POST_BUDGET_MS`（默认 90s）在既有 `onShutdown` handler 内执行完毕，随后沿用既有 10s `shutdownGraceMs`；不新增 `postGraceMs` 配置（避免两套宽限语义）。admin-api 销毁超时从 30s 提升到 `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`（默认 180s，> 90s + 10s + 删 Job 重试）。
10. **初始化卡死兜底**：`StatusSyncService` 15s 巡检中，`RUNNING` 记录停留超过 `timeoutMs + 30s` → 标 `TIMEOUT` 并推进下一条；无 `RUNNING` 但有 `PENDING` 超过 60s → 推进；`initializing` 停留超过 `items × initTimeoutMs + 120s` → 剩余记录全部 `TIMEOUT` 并收口状态（online/connecting）。`initializing` 不再受 `CONNECT_TIMEOUT_MS` 回连超时巡检影响（避免长脚本被误判失败）。
11. **`currentWorkloadName` 语义**：仅 init 阶段维护，取值 = 当前正在执行的 `workloadName`；进入 `online`/`connecting`/`destroying`/终态时清空。post 阶段不回写（容器已是 `destroying`，日志视图可查）。
12. **校验上限**：名称 trim 后 1~64 字符且唯一；`initScript`/`postScript` 各自 ≤ 16 KiB 且至少其一非空；单次启动 `workloadIds` ≤ 10、去重且保持选择顺序、必须全部存在（否则内部 API 400 `INVALID_WORKLOAD`）。
13. **`workloads` 字段解析**：admin-api 按 `workloadIds` 顺序批量查 `cloudworkloads`（请求级缓存一次查询），已删除项省略；不做 N+1。
14. **日志查询**：按 `createdAt` 升序（执行顺序）返回，不分页（单容器条目 ≤ 2×10）；`adminCloudContainerWorkloadLogs(containerId)` 优先走内部 API，控制面不可达降级直读 Mongo 只读模型。
15. **日志截断**：worker 侧边执行边保留尾部 ≤ 256 KiB；服务端写入前再按 `WORKLOAD_LOG_MAX_BYTES` 截断（防伪造超大 payload）。
16. **执行环境**：`bash -c <script>`，cwd = `os.homedir()`，继承 agent-gear 进程环境；stdout 与 stderr 合并捕获；超时杀整个进程组（`detached: true` + `kill(-pid)`）。
17. **E2E 覆盖边界**：Aspire 以 `K8S_ENABLED=false` 启动、无真实工作容器回连，`INITIALIZING` 与脚本执行链路改由 cloud-controller/agent-controller 单测（真实 socket.io-client 连进程内 server）与 tests/api（直写 Mongo 日志 + 内部 API/GraphQL 查询）覆盖；E2E 只覆盖 CRUD、启动多选、状态/日志展示；真实集群链路列部署侧手工验收（与二期 T-E4/T-E6 口径一致）。
18. **枚举映射**：内部小写 `initializing` ↔ GraphQL `INITIALIZING` ↔ 前端「初始化中」；未知状态仍回落 `FAILED`（沿用 `mapCloudContainer` 防御）。
19. **agent-gear 版本**：minor bump 到 `2.2.0`（major 保持 2，不触发 `VERSION_MISMATCH`）；worker 镜像构建时安装最新版，`entrypoint.sh` 启动时 `npm install -g agent-gear` 的现有更新逻辑不变。
20. **启动接口兼容**：`adminStartCloudContainer(purpose, workloadIds)` 的 `workloadIds` 为可选参数，缺省/空数组行为与现状完全一致；不挂载工作负载的容器不出现 `INITIALIZING`。启动 mutation 在既有 `contracts/admin-cloud-container.graphql` 上扩展参数，不在新契约重复声明，避免同一 Mutation 两处定义。

---

## Phase 1: 契约变更（contracts/）

开发分支：`servers/cloud-controller-workload`。本 Phase 独立提交（`docs(contracts): ...`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/admin-cloud-workload.graphql` | 新增 | `type CloudWorkload { id name initScript postScript createdAt updatedAt }`；`CreateCloudWorkloadInput`/`UpdateCloudWorkloadInput`；`enum CloudWorkloadLogPhase { INIT POST }`、`enum CloudWorkloadLogStatus { PENDING RUNNING SUCCESS FAILED TIMEOUT }`；`type CloudWorkloadLog { id containerId workloadId workloadName phase status script exitCode log startedAt finishedAt }`；`Query.adminCloudWorkloads`、`Query.adminCloudContainerWorkloadLogs(containerId: ID!)`；`Mutation.adminCreateCloudWorkload/adminUpdateCloudWorkload/adminDeleteCloudWorkload`；注释注明 admin JWT 鉴权与校验上限（裁决 12） |
| `contracts/admin-cloud-container.graphql` | 修改 | `enum CloudContainerStatus` 增加 `INITIALIZING`；`CloudContainer` 增加 `workloads: [CloudWorkload!]!` 与 `currentWorkloadName: String`；`adminStartCloudContainer(purpose, workloadIds: [ID!])`；补充状态语义（initializing → online/connecting）与「已删除工作负载省略」说明 |
| `contracts/cloud-controller-websocket.md` | 修改 | §2.1 事件总览增加 `workload:run` / `workload:result`；新增 §2.9/§2.10 载荷表（phase/items/logId/timeoutMs/budgetMs；status/exitCode/log）；§2.8 `shutdown` 时序补充（post 批次完成后才发送）；§3 生命周期图补充 init/post 两段；附录 A.2.2 `POST /internal/containers` 请求体增加 `workloadIds`，新增 A.2.4 `GET /internal/containers/:id/workload-logs`；附录 A.3 JSON 增加 `workloadIds`/`currentWorkloadName`；附录 A.4 状态枚举增加 `initializing` |

### 验收 checklist

- [ ] 三份契约与提案 §3/§4 逐字段一致；`workload:run`/`workload:result` 载荷字段无歧义
- [ ] `shutdown` 时序明确「post 完成后发送」，旧 worker 兼容说明保留
- [ ] 契约变更独立提交，后续 Phase 才动实现代码

---

## Phase 2: admin-api 工作负载 CRUD + 容器字段扩展

开发分支：`servers/cloud-controller-workload`。TDD 顺序：先写 `services/cloud-workload.test.ts` / `graphql/resolvers/cloud-workload.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/models/cloud-workload.ts` | 新增 | 显式集合名 `cloudworkloads`：`name`（required/unique/trim）、`initScript`、`postScript`、timestamps；对齐契约 |
| `servers/admin-api/src/models/cloud-workload-log.ts` | 新增 | 降级只读模型，显式集合 `cloudworkloadlogs`（仅 `find`，不写）；字段与 cloud-controller 写入结构对齐 |
| `servers/admin-api/src/models/cloud-container.ts` | 修改 | 只读模型增加 `workloadIds: [String]`、`currentWorkloadName: String`，与 cloud-controller schema 对齐 |
| `servers/admin-api/src/services/cloud-workload.ts` | 新增 | CRUD + 校验（名称 trim/唯一/1~64、脚本 ≤16 KiB、至少其一非空）；`listByContainerLogs(containerId)` 直读降级；DTO 映射（enums 大写、ISO 时间） |
| `servers/admin-api/src/graphql/schemas/cloud-workload.ts` | 新增 | 逐字段对齐 `contracts/admin-cloud-workload.graphql` |
| `servers/admin-api/src/graphql/schemas/index.ts` | 修改 | 注册 `cloudWorkloadTypeDefs` |
| `servers/admin-api/src/graphql/resolvers/cloud-workload.ts` | 新增 | 薄 resolver + `assertAdmin`；重复名映射 `E11000` → 友好错误；`adminCloudContainerWorkloadLogs` 优先内部 API、`CONTROL_PLANE_UNAVAILABLE` 时降级直读 Mongo |
| `servers/admin-api/src/graphql/resolvers/index.ts` | 修改 | 登记 Query/Mutation 与 `CloudContainer.workloads` 类型级 resolver（backend-rules 显性陷阱） |
| `servers/admin-api/src/graphql/resolvers/cloud-container.ts` | 修改 | `adminStartCloudContainer` 透传 `workloadIds`（缺省 `[]`）；新增 `CloudContainer.workloads` field resolver（请求级批量查询、保持顺序、省略已删除） |
| `servers/admin-api/src/services/cloud-controller-client.ts` | 修改 | `CloudContainerDTO` 增加 `workloadIds`/`currentWorkloadName`；`start(purpose, workloadIds)`；新增 `listWorkloadLogs(containerId)`；`STATUS_TO_GQL` 增加 `initializing: INITIALIZING`；销毁超时改为可配置 `destroyTimeoutMs`（默认 180000，裁决 9） |
| `servers/admin-api/src/config/index.ts` | 修改 | 增加 `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`（默认 180000） |
| `servers/admin-api/src/graphql/schemas/cloud-container.ts` | 修改 | 增加 `INITIALIZING`、`workloads`、`currentWorkloadName`、`workloadIds` 参数 |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-W1 | 创建工作负载（仅 init / 仅 post / 两者） | 成功且 DTO 字段完整 |
| T-W2 | 名称空、脚本均空、脚本超 16 KiB | 抛明确校验错误 |
| T-W3 | 重名创建/改名 | 映射为友好错误（非裸 E11000） |
| T-W4 | 更新/删除不存在的 id | 明确「not found」错误 |
| T-W5 | 非管理员调用 CRUD | `UNAUTHENTICATED`（守卫回归） |
| T-W6 | `CloudContainer.workloads` 解析 | 按 `workloadIds` 顺序返回；已删除项省略；单次请求只查一次库 |
| T-W7 | `adminStartCloudContainer(IDLE, workloadIds)` | 内部 API 请求体携带数组；缺省时传 `[]` |
| T-W8 | 日志查询（控制面可用 / 不可达） | 正常返回大写枚举；不可达时降级直读 Mongo 且字段一致 |

### 命令参考

```bash
cd servers/admin-api && npx vitest run src/services/cloud-workload.test.ts src/graphql/resolvers/cloud-workload.test.ts src/graphql/resolvers/cloud-container.test.ts
cd servers/admin-api && npm run build
```

### 验收 checklist

- [ ] T-W* 全部通过；`npm run build` strict 通过
- [ ] schema/resolver 均已登记；GraphQL 类型与契约逐字段一致
- [ ] admin-api 对 `cloudworkloadlogs` 仅只读（降级路径），无任何写操作

---

## Phase 3: cloud-controller 数据模型 + 配置 + 状态机 initializing + 内部 API

开发分支：`servers/cloud-controller-workload`。TDD 顺序：先扩展 `container-service.test.ts` / `routes/internal-api.test.ts` / `config/index.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/models/cloud-container.ts` | 修改 | `CONTAINER_STATUSES` 增加 `'initializing'`；schema 增加 `workloadIds: [ObjectId]`（default `[]`）、`currentWorkloadName`（default null） |
| `servers/cloud-controller/src/models/cloud-workload.ts` | 新增 | 只读模型（集合 `cloudworkloads`），供 dispatcher 读取脚本 |
| `servers/cloud-controller/src/models/cloud-workload-log.ts` | 新增 | 集合 `cloudworkloadlogs`：containerId（index）、workloadId、workloadName、phase、status、script、exitCode、log、startedAt、finishedAt、timestamps |
| `servers/cloud-controller/src/repositories/container-repository.ts` | 修改 | Entity/Create/Update 增加 `workloadIds`、`currentWorkloadName`；InMemory 实现同步；`ACTIVE_STATUSES` 纳入 `initializing` |
| `servers/cloud-controller/src/repositories/workload-repository.ts` | 新增 | `WorkloadRepository`（`findByIds`/`findById`）+ Mongo/InMemory 实现（InMemory 供单测） |
| `servers/cloud-controller/src/repositories/workload-log-repository.ts` | 新增 | `WorkloadLogRepository`（`createMany`/`updateById`/`findByContainer`/`findActiveByContainer`）+ Mongo/InMemory 实现 |
| `servers/cloud-controller/src/config/index.ts` | 修改 | 新增 `workloadInitTimeoutMs`（`WORKLOAD_INIT_TIMEOUT_MS`，默认 300000）、`workloadPostBudgetMs`（`WORKLOAD_POST_BUDGET_MS`，默认 90000）、`workloadLogMaxBytes`（`WORKLOAD_LOG_MAX_BYTES`，默认 262144）；非法数值 fail-fast |
| `servers/cloud-controller/src/services/container-service.ts` | 修改 | `ACTIVE_STATUSES` 增加 `initializing`；新增 `markInitializing(id, currentWorkloadName)`；`markOnline`/`markConnecting`/`markExited`/`markFailed` 清空 `currentWorkloadName`；`start(purpose, refId, workloadIds)` 落库 `workloadIds`（保持顺序、去重） |
| `servers/cloud-controller/src/routes/internal-api.ts` | 修改 | `POST /internal/containers` 接收 `workloadIds`（校验存在/≤10/去重保序，非法 400 `INVALID_WORKLOAD`）；`CloudContainerJson` 增加 `workloadIds`/`currentWorkloadName`；新增 `GET /internal/containers/:id/workload-logs`（404 容器不存在，按 createdAt 升序返回日志 JSON） |
| `servers/cloud-controller/src/services/status-sync.ts` | 修改 | `scanTimeouts` 跳过 `initializing`（改由 dispatcher 看门狗负责）；`scanHeartbeats` 保持仅 online；`handleJobEvent`/`reconcile` 对 `initializing` 按既有逻辑处理（Job failed/succeeded 可迁移终态） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-CS1 | `start(idle, null, [a,b,a])` | 落库 `workloadIds` 去重保序；status/creating 流程不变 |
| T-CS2 | `markInitializing` + `markOnline` | `currentWorkloadName` 写入后清空；状态 CAS 正确 |
| T-CS3 | `initializing` 容器 destroy | 可进入 destroying（ACTIVE 集合包含 initializing） |
| T-CS4 | `initializing` 不受回连超时巡检影响 | 超过 `CONNECT_TIMEOUT_MS` 仍保持 initializing（看门狗接管） |
| T-IC5 | `POST /internal/containers { workloadIds }` | 合法返回 201 且 JSON 携带 workloadIds；未知 id / >10 / 非数组 → 400 `INVALID_WORKLOAD` |
| T-IC6 | `GET /internal/containers/:id/workload-logs` | 按执行顺序返回；不存在容器 404；无记录返回 `[]` |
| T-IC7 | 内部 API 鉴权回归 | 缺失/错误 Bearer → 401 |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/services/container-service.test.ts src/services/status-sync.test.ts src/routes/internal-api.test.ts src/config/index.test.ts
cd servers/cloud-controller && npm run build
```

### 验收 checklist

- [ ] T-CS*/T-IC* 全部通过
- [ ] 集合名显式（`cloudcontainers`/`cloudworkloads`/`cloudworkloadlogs`），字段与提案 §4.1 一致
- [ ] 存量容器（无 workloadIds）行为零变化；`initializing` 不会被回连超时误杀

---

## Phase 4: workload-dispatcher + gateway 接入 + destroy 清理时序

开发分支：`servers/cloud-controller-workload`。TDD 顺序：先写 `services/workload-dispatcher.test.ts` 与扩展 `socketio-gateway.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/services/workload-dispatcher.ts` | 新增 | 核心编排：`startInit(containerId, socket)`（读脚本→批量建日志[首条 RUNNING]→CAS initializing + currentWorkloadName→emit `workload:run`）；`handleResult(containerId, payload)`（校验 logId 归属、终态幂等、推进下一条/更新 currentWorkloadName、全部结束收口 online/connecting）；`runPostBatch(containerId)`（无活跃 socket 直接标 TIMEOUT；否则建 post 日志→emit→等待完成/预算）；`onWatchdog(now)`（超时推进/卡死收口）；`hasPostScripts(containerId)` |
| `servers/cloud-controller/src/services/socketio-gateway.ts` | 修改 | `register` 成功后：若有 init 脚本 → 调 `dispatcher.startInit`；否则维持 `markOnline`；新增 `workload:result` 监听（绑定 containerId，透传 dispatcher）；`onShutdown` handler 改为「await dispatcher.runPostBatch → emit shutdown」；disconnect 时 `initializing` 保持状态（等待重连），不退回 connecting |
| `servers/cloud-controller/src/services/container-service.ts` | 修改 | `notifyShutdown` 支持异步 post 批次（handler 已 await）；其余状态迁移按 Phase 3 |
| `servers/cloud-controller/src/services/status-sync.ts` | 修改 | 15s 巡检追加 `dispatcher.onWatchdog()`（看门狗与既有巡检同频，裁决 10） |
| `servers/cloud-controller/src/index.ts` | 修改 | 装配 workload/log repository + dispatcher；注入 config 超时/日志上限；dispatcher 依赖 gateway 的 `emitToContainer`/`isConnected`（回调注入，避免循环依赖） |
| `servers/cloud-controller/src/services/keyed-mutex.ts` | 复用 | 所有推进/收口操作按 containerId 串行化，与 start/destroy 不竞争 |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-WD1 | init 批次下发 | 只包含有 `initScript` 的工作负载，顺序与 `workloadIds` 一致；日志记录按序创建、首条 RUNNING、`script` 快照正确 |
| T-WD2 | 逐条结果推进 | 收到 result → 当前记录终态、下一条 RUNNING、`currentWorkloadName` 切换；全部终态 → online + 清空名称 |
| T-WD3 | 失败/超时后继续 | `failed`/`timeout` 不阻断后续条目，最终仍 online |
| T-WD4 | 工作负载已删除 | 生成 FAILED 记录（空 script + 说明），继续后续 |
| T-WD5 | 重复/串号 result | 终态记录忽略；logId 不属于该容器则拒绝并告警 |
| T-WD6 | 旧 worker 不响应 | 看门狗超时标 TIMEOUT 并推进，最终容器 online |
| T-WD7 | 无活跃 socket 的 destroy | post 记录全部 TIMEOUT（未执行），立即进入 shutdown/删 Job |
| T-WD8 | 有 post 脚本的 destroy | 先 emit post 批次 → 收到结果落库 → 再 emit shutdown；宽限后删 Job |
| T-WD9 | destroy 打断 init | init 非终态记录标 TIMEOUT；worker 收到 post 后终止 init 子进程 |
| T-WD10 | 掉线收口 | 全部 init 结束后无活跃 socket → connecting（非 online） |
| T-WG1 | gateway init 触发 | register 后确实 emit `workload:run`；无 init 脚本时直接 online（存量回归） |
| T-WG2 | gateway post 时序 | shutdown 在最后一条 post result 之后发出；容器 destroy 状态正确 |

### 命令参考

```bash
cd servers/cloud-controller && npx vitest run src/services/workload-dispatcher.test.ts src/services/socketio-gateway.test.ts src/services/container-service.test.ts src/services/status-sync.test.ts
cd servers/cloud-controller && npm run build
```

### 验收 checklist

- [ ] T-WD*/T-WG* 全部通过；dispatcher 覆盖率 ≥ 80%
- [ ] 旧 worker 兼容路径有测试锚定（看门狗收口）
- [ ] destroy 总耗时满足：post 预算 + 10s 宽限 < admin-api 180s 超时
- [ ] 无脚本容器注册→online 的行为与现状完全一致（回归用例）

---

## Phase 5: agent-gear 工作负载执行器 + 版本 bump

开发分支：`packages/cloud-controller-workload`。TDD 顺序：先写 `workload-executor.test.ts`（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/workload-executor.ts` | 新增 | `WorkloadExecutor`：串行执行 items；`spawn('bash', ['-c', script], { cwd: homedir(), detached: true, env: process.env })`；stdout/stderr 合并 + 尾部 256 KiB 环形截断；单条超时杀进程组并回报 `timeout`；非零退出回报 `failed` + exitCode；post 批次共享 `budgetMs`（剩余预算不足则后续条目直接 `timeout`）；未确认结果内存保留（≤50 条）供重连重放 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 监听 `workload:run` → `executor.runBatch(payload, result => socket.emit('workload:result', result))`；`connect` 时重放未确认结果（裁决 6）；`shutdown` 到达时若有 post 批次在跑，等待 ≤5s 后退出；模块级单实例（进程内串行） |
| `packages/agent-controller/src/workload-executor.test.ts` | 新增 | T-WE* |
| `packages/agent-controller/package.json` | 修改 | 版本 `2.2.0`（minor bump，major 保持 2） |
| `contracts/cloud-controller-websocket.md` | 修改 | 若 Phase 1 未写全，补 worker 侧执行语义（串行、超时、截断、重连重放） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-WE1 | 正常脚本（stdout+stderr） | 合并输出、`success`、exitCode=0、结果顺序与 items 一致 |
| T-WE2 | 非零退出 | `failed` + exitCode，继续下一条 |
| T-WE3 | 超时脚本（sleep） | `timeout`，进程组被杀死，继续下一条 |
| T-WE4 | 超大输出 | 截断保留尾部 ≤256 KiB |
| T-WE5 | post 共享预算耗尽 | 后续条目直接 `timeout`（不启动进程） |
| T-WE6 | 重连重放 | 未确认结果在 `connect` 后重新 emit；已确认（终态）由服务端忽略 |
| T-WE7 | 执行中收到新批次（post 打断 init） | 终止当前子进程并继续新批次 |
| T-WE8 | 空 script / 空 items | 不执行、不崩溃（空 script 回报 failed 文案） |

### 命令参考

```bash
cd packages/agent-controller && npx vitest run src/workload-executor.test.ts
cd packages/agent-controller && npm run build
cd packages/agent-controller && npm pack --dry-run   # 发版前检查产物
```

### 验收 checklist

- [ ] T-WE* 全部通过；`npm run build` 通过
- [ ] 对 controller-api 既有事件（register/heartbeat/shutdown/acp:*/fs:*/git:*）零行为变化
- [ ] 版本 2.2.0 已 bump，major 校验不受影响

---

## Phase 6: admin-web 工作负载页 + 启动多选 + 初始化进度/日志

开发分支：`apps/cloud-controller-workload`（仅依赖 Phase 1/2 契约，可并行）。TDD 顺序：先写组件/页面测试（RED）→ 实现（GREEN）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/admin-web/src/pages/CloudWorkloadsPage.tsx` | 新增 | 工作负载列表（名称、init/post 摘要、更新时间）+「新建」+ 行内「编辑」「删除」 |
| `apps/admin-web/src/components/cloud-workloads/WorkloadTable.tsx` | 新增 | 表格与空状态；脚本摘要单行截断 |
| `apps/admin-web/src/components/cloud-workloads/WorkloadFormDialog.tsx` | 新增 | 新建/编辑共用：名称输入、init/post 多行编辑、前端校验（名称必填、至少一个脚本非空）、保存错误展示 |
| `apps/admin-web/src/components/cloud-workloads/DeleteWorkloadDialog.tsx` | 新增 | 删除二次确认（展示名称） |
| `apps/admin-web/src/components/cloud-containers/StartContainerDialog.tsx` | 修改 | 增加工作负载多选（checkbox 列表，默认不选，保持勾选顺序）；`onStart(purpose, workloadIds)`；无工作负载时展示空提示 |
| `apps/admin-web/src/components/cloud-containers/ContainerStatusBadge.tsx` | 修改 | `INITIALIZING: 'secondary'` |
| `apps/admin-web/src/components/cloud-containers/labels.ts` | 修改 | `INITIALIZING: '初始化中'`；新增 phase/status 中文映射（初始化/清理、执行中/成功/失败/超时） |
| `apps/admin-web/src/components/cloud-containers/WorkloadLogsDialog.tsx` | 新增 | 按容器查看执行记录：列表（工作负载/阶段/状态/时间）+ 选中项的脚本内容与输出日志（`whitespace-pre-wrap break-all`，`min-w-0` 防溢出） |
| `apps/admin-web/src/pages/CloudContainersPage.tsx` | 修改 | 新增「工作负载」列（名称列表）；初始化中展示当前脚本（`currentWorkloadName`）；行内「工作负载日志」入口；轮询刷新不打断已打开对话框 |
| `apps/admin-web/src/graphql/queries.ts` | 修改 | 新增 `ADMIN_CLOUD_WORKLOADS`、`ADMIN_CLOUD_WORKLOAD_LOGS`；`ADMIN_CLOUD_CONTAINERS` 增加 `workloads { id name }`、`currentWorkloadName` |
| `apps/admin-web/src/graphql/mutations.ts` | 修改 | 新增创建/更新/删除工作负载；`ADMIN_START_CLOUD_CONTAINER` 增加 `$workloadIds: [ID!]` |
| `apps/admin-web/src/graphql/types.ts` | 修改 | 新增 `CloudWorkloadData`、`CloudWorkloadLogData`、枚举与查询/变更类型；`CloudContainerStatus` 增加 `INITIALIZING`；`CloudContainerData` 增加 `workloads`/`currentWorkloadName` |
| `apps/admin-web/src/App.tsx` | 修改 | 受保护路由 `/cloud-workloads` |
| `apps/admin-web/src/components/AdminLayout.tsx` | 修改 | 侧边栏加「工作负载」入口（图标复用 `Boxes`/`Package`），当前项高亮 |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-FW1 | 工作负载列表渲染 | 名称/摘要/更新时间正确；空状态有「新建」引导 |
| T-FW2 | 新建/编辑保存 | mutation 变量正确、列表刷新、表单校验拦截空名称/双空脚本 |
| T-FW3 | 删除二次确认 | 取消不删；确认后调用删除并刷新 |
| T-FW4 | 启动对话框多选 | 默认不选；勾选顺序即提交顺序；取消/关闭不提交 |
| T-FW5 | 初始化中展示 | 状态徽章「初始化中」；显示当前执行的工作负载名称 |
| T-FW6 | 容器挂载列表 | 显示 `workloads` 名称；已删除项不显示 |
| T-FW7 | 日志对话框 | 打开后按容器查询；展示脚本快照与输出；长文本无横向溢出（`scrollWidth - clientWidth ≤ 1`） |
| T-FW8 | 轮询不打断弹窗 | 10s 轮询刷新列表时已打开的启动/日志对话框保持 |

### 命令参考

```bash
cd apps/admin-web && npx vitest run src/pages/__tests__/CloudWorkloadsPage.test.tsx src/pages/__tests__/CloudContainersPage.test.tsx
cd apps/admin-web && npm run build && npm run lint
```

### 验收 checklist

- [ ] T-FW* 全部通过；build/lint 通过
- [ ] PRD §3.4 页面元素逐项核对（工作负载页、编辑对话框、删除确认、启动多选、列表状态/当前脚本、日志视图）
- [ ] 仅管理员可访问（`ProtectedRoute` 回归）；`loading && !data` 规则遵守
- [ ] 禁止跨项目 import；长文本/窄容器无横向溢出

---

## Phase 7: 部署与编排收口

开发分支：`servers/cloud-controller-workload`（deploy/、aspire/ 归该分支）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | cloud-controller 注入可选 `WORKLOAD_INIT_TIMEOUT_MS`/`WORKLOAD_POST_BUDGET_MS`/`WORKLOAD_LOG_MAX_BYTES`（本地可用默认值）；admin-api 注入 `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`（默认 180000） |
| `deploy/images/worker/Dockerfile` | 修改（如需） | 保持 `npm install -g agent-gear`（构建时取最新 2.x）；如 CI 需要可固定到 `2.2.x` |
| `deploy/images/worker/BUILD.md` | 修改 | 增加工作负载执行自验：`agent-gear` 版本 ≥2.2.0、`bash -c 'echo ok'`、超时/截断行为；注明镜像需重建发布 |
| `deploy/k8s/cloud-controller.yaml` | 修改（注释） | 仅补充新增环境变量说明，RBAC 与 Job manifest 不变 |
| `docs/engineering/AGENTS.md` | 修改 | 实现计划索引增加本文档 |
| `servers/cloud-controller/AGENTS.md`、`apps/admin-web/AGENTS.md` | 修改 | 架构/路由/环境变量表补充 workload 相关条目 |

### 验收 checklist

- [ ] `aspire start` 可拉起（`K8S_ENABLED=false`），新增环境变量有默认值不阻断启动
- [ ] `aspire publish -o aspire/manifest` 产物正常；cloud-controller 镜像可构建
- [ ] `BUILD.md` 自验步骤可执行；RBAC 未新增权限

---

## Phase 8: 测试补全（tests/api + tests/e2e）

开发分支：`tests/cloud-controller-workload`（基于 feat 分支，Phase 2~7 合并后切出）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/admin-api/cloud-workload.test.ts` | 新增 | T-IA*：CRUD 全量、校验边界、重名、非管理员拒绝、日志查询（控制面可用 + 直写 Mongo 后查询）、降级路径 |
| `tests/api/src/admin-api/cloud-container.test.ts` | 修改 | `adminStartCloudContainer` 携带 `workloadIds`（合法/未知 id 400 文案）、列表返回 `workloads`/`currentWorkloadName` |
| `tests/api/src/cloud-controller/internal-api.test.ts` | 修改 | `POST` 带 workloadIds 的校验分支；`GET /workload-logs` 顺序与 404；Bearer 401 回归 |
| `tests/e2e/src/admin-cloud-workload.spec.ts` | 新增 | T-E*：登录 → 工作负载页新建（init/post）→ 编辑 → 启动对话框多选 → 列表展示挂载与状态 → 删除 → 启动选择列表不再出现 |
| `tests/e2e/src/admin-cloud-container.spec.ts` | 修改 | 启动对话框多选交互回归；容器列表「工作负载」列展示；日志入口可打开（无记录空态） |
| `tests/api/AGENTS.md`、`tests/e2e/AGENTS.md` | 修改 | 补充工作负载相关测试说明与套件归属 |

### 测试用例（E2E 增量）

| # | 用例 | 预期 |
|---|------|------|
| T-E7 | 工作负载 CRUD 全流程 | 新建/编辑后列表同步；删除需确认且从启动选择列表消失 |
| T-E8 | 启动对话框多选 | 可多选、默认不选；确认后容器行展示所选工作负载名称 |
| T-E9 | 初始化中与当前脚本展示 | 通过 API 构造 `INITIALIZING` + `currentWorkloadName`（直写 Mongo）→ 页面展示「初始化中」与脚本名 |
| T-E10 | 日志视图 | 直写 `cloudworkloadlogs` 后打开日志对话框 → 展示阶段/状态/脚本快照/输出 |
| T-E11 | 非管理员/未登录 | 工作负载页与日志入口拒绝访问（重定向登录） |

### 命令参考

```bash
aspire start && aspire wait admin-api && aspire wait admin-web && aspire wait agent-api
cd tests/api && ADMIN_API_URL=http://localhost:10003/graphql MONGODB_URI=<aspire describe mongodb> CLOUD_CONTROLLER_URL=http://localhost:10004 CLOUD_CONTROLLER_INTERNAL_TOKEN=<...> npm test
# 与 API 套件串行
cd tests/e2e && ADMIN_WEB_URL=<aspire describe admin-web> ADMIN_API_URL=http://localhost:10003/graphql MONGODB_URI=<...> npx playwright test admin-cloud-workload.spec.ts admin-cloud-container.spec.ts
```

### 验收 checklist

- [ ] T-IA*/T-IC*/T-E* 全部通过；API 与 E2E 串行
- [ ] 各实现分支单测覆盖率 ≥ 80%（dispatcher/executor/状态机重点）
- [ ] E2E 不依赖真实 K8s；`INITIALIZING` 数据构造口径在测试文件中注明（裁决 17）

---

## Phase 9: 全量回归 + 验收核对 + PR

### 命令参考

```bash
# 后端
cd servers/cloud-controller && npm run build && npx vitest run --coverage
cd servers/admin-api && npm run build && npx vitest run
# agent-gear
cd packages/agent-controller && npm run build && npx vitest run
# 前端
cd apps/admin-web && npm run build && npm run lint && npx vitest run
# API / E2E 全量（串行）
```

### 总体验收 checklist

- [ ] 单元测试覆盖率 ≥ 80%（cloud-controller dispatcher/状态机、agent-gear executor、admin-api 校验）
- [ ] API 测试通过（工作负载 CRUD、启动携带 workloadIds、日志查询、内部 API 扩展）
- [ ] E2E 测试通过（CRUD → 启动多选 → 状态/日志展示）
- [ ] PRD §1.3/§3.2 逐条核对：
  - [ ] 工作负载列表/新建/编辑/删除（名称、init/post；至少一个脚本非空）（功能点 1）
  - [ ] 启动多选、按选择顺序执行、列表展示挂载（功能点 2）
  - [ ] `INITIALIZING` 状态、当前执行脚本实时切换、结束转 online、无 init 直接 online（功能点 3）
  - [ ] 销毁时按序执行 post、超时保护、无连接时不执行并如实记录（功能点 4）
  - [ ] 每条执行记录含容器/工作负载/阶段/状态/起止时间/脚本快照/输出日志，容器销毁后仍可查看（功能点 5）
- [ ] PRD §3.5 边界逐条核对（init 失败/超时继续、删工作负载不影响历史、编辑不影响本次、双空拒绝、非管理员拒绝）
- [ ] 提案 §10 验收标准逐条核对（契约评审、脚本由控制器下发、初始化状态可见、脚本/日志留档、不挂载行为一致）
- [ ] 四个开发分支 PR 合并回 `feat/cloud-controller-workload`，需求总 PR #215 自动更新；实现计划文档保留在需求总分支

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| post 批次拉长销毁耗时，admin-api 超时误报 | 预算 90s + 10s 宽限 < 180s 超时（裁决 9）；destroy 超时可配置 |
| 旧 worker 不响应 `workload:run` 导致容器卡在 initializing | 看门狗按 `timeoutMs+30s` 标 TIMEOUT 并收口 online；容器仍可用（T-WD6/T-WD10） |
| socket 断连期间结果丢失 | worker 内存重放（≤50 条）+ 服务端终态幂等 + 看门狗兜底（裁决 6） |
| 脚本快照过大/输出洪泛打爆 Mongo | 脚本 ≤16 KiB 校验；输出双端 256 KiB 尾部截断（裁决 15） |
| 工作负载在执行前被删除 | 缺失项生成 FAILED 记录并继续（裁决 3）；日志保留名称快照 |
| destroy 时 init 仍在跑，产生迟到结果/孤儿进程 | 先标 TIMEOUT，worker 收到 post 批次终止当前进程组，服务端忽略迟到结果（裁决 7） |
| `initializing` 新增枚举遗漏映射 | 契约/内部状态/GraphQL/admin-api 映射/前端徽章五处清单化，唯一回归用例 T-FW5/T-IA* |
| 轮询刷新打断多选/日志交互 | Apollo v4 `loading && !data`；对话框状态独立于列表条件渲染（T-FW8） |
| 真实集群脚本行为与测试环境差异 | 部署侧手工验收（init/post、超时、旧 worker、镜像重建），E2E 只覆盖可确定性链路（裁决 17） |

## 相关文档

- 关联 PRD：`docs/product/draft/20261017-cloud-controller-workload.md`
- 关联 Proposal：`docs/engineering/proposals/20261017-feat-cloud-controller-workload.md`
- 既有实现计划：`docs/engineering/plan/20261014-feat-cloud-agent-phase2.md`、`docs/engineering/plan/20261014-feat-admin-console.md`
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
- 契约：`contracts/admin-cloud-workload.graphql`、`contracts/admin-cloud-container.graphql`、`contracts/cloud-controller-websocket.md`
- 测试规范：`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`
