# cloud-controller

部署在 K8s 集群内的云端工作容器控制器：通过 K8s API 在指定命名空间以 **Job** 形式拉起工作容器，工作容器内 `agent-gear` 经 Socket.IO（namespace `/worker`）回连并接受控制；同时对外暴露供 `admin-api` 调用的内部管理 REST。

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + Socket.IO v4
- **ODM**: Mongoose（MongoDB 共享库，集合 `cloudcontainers`）
- **K8s 客户端**: `@kubernetes/client-node`（BatchV1Api + Watch）
- **测试**: Vitest
- **Dev Runner**: tsx (watch mode)

## Architecture

```
src/
├── config/                     # 环境配置 + assertRuntimeConfig（fail-fast）
├── models/
│   ├── cloud-container.ts      # CloudContainer schema（集合 cloudcontainers，状态含 initializing，含 workloadPlan）
│   ├── cloud-workload.ts       # 工作负载只读模型（集合 cloudworkloads，含 paramSchema/dependsOnWorkloadIds，供兜底展开与脚本读取）
│   └── cloud-workload-log.ts   # 执行记录模型（集合 cloudworkloadlogs，含 script/params/required 快照）
├── repositories/
│   ├── container-repository.ts # ContainerRepository 接口 + Mongo/InMemory 实现
│   ├── workload-repository.ts  # WorkloadRepository（findByIds/findById）+ Mongo/InMemory
│   └── workload-log-repository.ts # WorkloadLogRepository（createMany/updateById/findByContainer/findActiveByContainer）
├── services/
│   ├── token-service.ts        # 一次性 token 签发/校验（bcrypt，tokenHash）
│   ├── k8s-client.ts           # K8sClient 接口 + Real/InMemory 实现 + 工厂
│   ├── k8s-job-manager.ts      # Job manifest + CRUD + Foreground→Background 回退
│   ├── container-service.ts    # 生命周期状态机（creating→connecting→initializing?→online→destroying→exited/failed），落库 workloadPlan；显式下发 plan 时由其派生 workloadIds，仅 workloadIds 的旧版请求按选择顺序落库
│   ├── workload-dispatcher.ts  # 工作负载编排：按 workloadPlan（无 plan 回退 workloadIds）下发脚本与参数/required/结果落库/当前脚本/看门狗/post 批次 + 必须失败裁决（中断 + 锁外强制注销）
│   ├── workload-plan.ts        # 兜底展开纯函数（仅无 workloadPlan 时用 workloadIds + 只读定义做后序 DFS + 默认参数归一，校验口径镜像 admin-api）
│   ├── secret-store.ts         # 云电脑运行期 secret 内存仓库（put/get/delete；不落库、不打印）
│   ├── agent-api-client.ts     # 云电脑 ready/terminal 回调（Bearer INTERNAL_API_TOKEN，AbortController 超时）
│   ├── admin-billing-client.ts # 按 cloudHostId 撤销模型 Key（幂等，失败只告警）
│   ├── status-sync.ts          # watch + 断线重连对账 + 超时巡检 + 心跳离线巡检 + 工作负载看门狗
│   ├── heartbeat-tracker.ts    # 心跳计时（30s × 3 次判离线）
│   ├── worker-version.ts       # worker 版本解析/最低版本门禁（纯函数，MIN_WORKER_VERSION/SUPPORTED_MAJOR）
│   └── socketio-gateway.ts     # /worker namespace 接入与鉴权（含注册版本门禁、workload:run/result）
├── middleware/internal-auth.ts # Bearer INTERNAL_API_TOKEN
├── routes/internal-api.ts      # /internal/containers*（启动接收/校验 workloadPlan、含 workload-logs）
└── index.ts                    # createCloudControllerApp + 入口
```

## 关键约束

- **单一事实源**：容器状态/生命周期全部由本服务持有；`admin-api` 不直连 K8s、不双写 Mongo（降级只读除外）。
- **鉴权**：容器经 Socket.IO 握手 `auth.token`（遗留 query 兼容）的一次性 token（`<containerId>.<secret>`，bcrypt 哈希存 `cloudcontainers.tokenHash`）鉴权，`register` 的 `key` 字段被忽略；握手限速按 token 的 `containerId` 前缀（无 token 回退 peer IP），另有更高上限的 per-IP 兜底桶——worker 经共享 Ingress IP 回连时不共享同一令牌桶；内部 REST 走 `Bearer INTERNAL_API_TOKEN`。**绝不读写 `controllerkeys` 集合**。
- **工作负载仅 Job**：`restartPolicy: Never`、`backoffLimit: 0`、`ttlSecondsAfterFinished: 600`、label `app=zag-worker` + `zag.cloud/container-id=<id>`；另含资源 limits（4 vCPU / 16Gi，不设置 requests）。**不设置 `activeDeadlineSeconds`**：最长运行时间无限制，避免活跃容器被 K8s 到期强杀。
- **工作负载脚本经 Socket.IO 下发（不经 K8s env / manifest 注入）**：`cloudworkloads` 由 admin-api 管理、本服务只读；启动请求可携带已展开的 `workloadPlan:[{workloadId,params,implicit,required}]`（落库到容器并由 plan 派生 `workloadIds`；缺省 `params`/`implicit`/`required` 归一为 `{}`/`false`/`false`），无 plan 时以只读定义对 `workloadIds` 做兜底展开（依赖先于依赖方、去重、参数取默认值；默认参数校验口径镜像 admin-api，非法默认值 → 400 `INVALID_WORKLOAD`），此时容器 `workloadIds` 按选择顺序落库、兜底展开的 plan 仅用于执行（`required` 一律 `false`）。容器 register 后由 `workload-dispatcher` 按计划顺序下发 `workload:run{phase:"init"}`（items 携带 `workloadId`/`params`/`required`，同时建 `cloudworkloadlogs` 记录并写入脚本与参数快照、CAS 置 `initializing`、写 `currentWorkloadName`），逐条 `workload:result` 推进，全部终态后收口 `online`（有活跃 socket）或 `connecting`。销毁时先下发 `workload:run{phase:"post"}` 并等待结果/预算耗尽，再发 `shutdown`。旧 worker 忽略新事件，由看门狗标 `TIMEOUT` 兜底；旧容器无 plan 时回退 `workloadIds → {workloadId,params:{},implicit:false,required:false}`。
- **工作流只初始化一次**：起始 `init` 批次收口（首次 `markOnline`）时落库 `initCompletedAt`；此后 `online → connecting → 再次 register` 的断线重连（含 agent-gear 进程重启）由 `hasSettledInit` 拦截，`hasInitScripts=false`（`registered.initializing=false`）且 `startInit` 不下发批次。历史容器无该字段时，以 `connectedAt` 非空的 `connecting` 状态兜底识别为已初始化；`initializing` 期间掉线保持原状态、由看门狗收口，同样不重放。单测 T-WD13b/T-WD13c/T-WG1d 锚定。
- **工作负载「必须」失败裁决（工作负载三期）**：`required` 缺省 `false`、仅 `=== true` 生效（非布尔 `400 INVALID_WORKLOAD`）；`init` 阶段必须项结果为 `failed`/`timeout`（含看门狗判定、执行前被删除的 `failed` 占位）时，`workload-dispatcher` **不 advance**，把该容器剩余非终态 `init` 记录标 `timeout` 并追加说明「必须工作负载初始化失败，已中断」，随后**在容器互斥锁外**调用注入的 `forceDestroy(containerId, '必须工作负载「<name>」初始化失败')` 复用既有销毁链路强制注销（先 CAS `destroying` 使一次性 token 失效 → post 批次 + `shutdown` → 删除 Job → `exited`），**不重试、不退避**；`KeyedMutex` 非可重入，注销会触发 gateway 的 `runPostBatch`（需同一把锁），故必须锁外消费信号（单测 T-WD23 锚定防自锁）。`post` 批次与新占位日志 `required` 固定 `false`；注销后 `finishInit` 对非 `initializing` 直接返回，迟到结果按终态幂等忽略，不会回到 `online`。
- **必须失败标记与注销失败兜底**：产生必须失败信号时，dispatcher **在容器互斥锁内**先落持久化标记 `cloudcontainers.mustFailure=true` 并写入 `exitReason`（关闭「锁外销毁前被看门狗收口为 online/connecting」的窗口）；`finishInit` 对 `mustFailure` 容器拒绝收口。锁外 `forceDestroy` 失败（如瞬时 Mongo/网络故障）时，把容器 CAS 为终态 `failed` 并保留必须失败 `exitReason`（残留 Job 交由既有巡检回收），`mustFailure` 使看门狗也绝不将其置 `online`；若注销仍未完成（容器停在 `initializing` 且 `mustFailure`），`onWatchdog` 会**重试销毁**（重试的是销毁而非初始化，不构成 backoff）。单测 T-WD26/T-WD27/T-WD28 锚定。
- **带原因的销毁**：`ContainerService.destroy(containerId, options?: { reason?: string })`，活跃路径 `exitReason = options?.reason ?? '强制销毁'`（Job 删除失败再追加「（Job 删除失败，需人工清理）」）；`forceDestroy(id, reason)` 为 `destroy(id, {reason})` 的语义封装（spi `WorkloadContainerStatePort.forceDestroy`），不新增独立删除路径。`adminDestroyCloudContainer` 不传 reason，行为与现状一致。销毁时 `shutdown` 事件透传真实 reason（必须失败 = `mustFailure` 写入的 `exitReason`），worker 据此非零退出，不得硬编码「强制销毁」。
- **worker 参数注入版本要求**：`MIN_WORKER_VERSION` 保持 `2.2.0`（2.2.0 worker 仍可执行不带参数的脚本）；参数注入（`WORKLOAD_PARAMS`/`WORKLOAD_PARAM_*`）需 worker 镜像内 agent-gear `>=2.3.0`。
- **worker 注册版本门禁**：`register.version` 必须是严格三段数字且 `>=2.2.0`、major 为 `2`（代码常量 `MIN_WORKER_VERSION`/`SUPPORTED_MAJOR`，见 `services/worker-version.ts`，不通过环境变量配置）。**按 purpose 分流**：`purpose=harness` 使用 `MIN_HARNESS_WORKER_VERSION='2.5.0'`（云电脑双连接 / `harness prepare`），普通容器维持 `2.2.0`；`register` 先读取容器 purpose 再校验。校验必须位于**全部注册副作用之前**：拒绝路径只 `emit('error', { code: 'VERSION_MISMATCH', currentVersion, minimumVersion, supportedMajor })` + `disconnect(true)`，不写 `socket.data.registered`、不 `heartbeatTracker.record`、不 `hasInitScripts`/`startInit`、不 `markOnline`/`markInitializing`，也不写 `connectedAt`。因此版本被拒的容器销毁时走「未完成兼容注册」路径：不发送 shutdown、不等待宽限，直接删除 Job。版本串写日志前须经 `sanitizeVersionForLog`（去控制字符、截断 64）。`registered` 携带 `initializing`（= `hasInitScripts` 结果），agent-gear 据此在 init 完成后才建立标准连接（缺省/false 立即连接，向后兼容）。
- **runtimeClass + hostUsers**：配置了 `RUNTIME_CLASS_NAME`（默认 `sysbox-runc`）时，同时下发 `hostUsers: false`——sysbox 要求 Pod 停用宿主 user namespace，否则 sandbox 创建失败（写 `net.ipv4.ip_unprivileged_port_start` 被拒）；未配置 runtimeClass 时不设置该字段。
- **env 通道**：`ZAG_SERVER_ENDPOINT=wss://<host>/worker`（**不含 token**）与 `ZAG_CONTROLLER_KEY=<token>`（agent-gear 连接时经握手 `auth.token` 携带）。
- **K8s 客户端可注入**：`K8S_ENABLED=false` 时使用 `InMemoryK8sClient`（本地/测试/E2E 全 mock，不依赖真实集群）。
- **用途白名单**：`POST /internal/containers` 仅接受 `idle|harness`；其余用途返回 400「该任务类型暂未开放」。`purpose=harness` 必填 `hostId/refId(controllerKeyId)/userId/hostName/harnessTypes(非空、白名单)/expiresAt/agentGearMinVersion(三段版本)/secrets/workloadPlan`，且 **workloadPlan 必须显式下发**（不允许仅 workloadIds 兜底展开）；缺失或非法返回 `400 INVALID_HARNESS` 且不创建 Job；`GET /containers?hostId=&userId=` 可选过滤（无参数保持全量）。
- **云电脑 secret 与 TTL**：`secrets{hostEndpoint,hostKey,modelApiKey,modelBaseUrl,modelIds,defaultWorkspace}` 仅存入 `SecretStore`（进程内 Map，不落库、不返回、不打印），容器终态时删除；可选 `secrets.modelContextLengths`（模型 ID → 最长上下文 JSON object 字符串，不参与必填校验），携带时经 `workload:run.env` 的 `ZAG_MODEL_CONTEXT_LENGTHS` 透传；`expiresAt` 仅落库留存（容器 TTL 留档，**不再关联模型 Key 有效期**——模型 Key 随容器回收：宿主非 `RUNNING`/删除/缺失由网关拒绝并对账撤销），**不再换算 Job 硬截止**（Job 不设 `activeDeadlineSeconds`，最长运行时间无限制）。
- **云电脑 env**：Job env 仅追加 `ZAG_HOST_ENDPOINT/ZAG_HOST_KEY/ZAG_HOST_NAME/ZAG_HARNESS_TYPES/ZAG_DEFAULT_WORKSPACE/ZAG_USER_TYPE/ZAG_USER_ID`（`ZAG_CONTROLLER_KEY` 仍为 `/worker` 一次性 token）；模型 Key/BaseURL/模型列表仅经 `workload:run.env` 下发（仅 harness，idle 不携带 `env`）。harness secret/模型配置缺失时 dispatcher 判 init 失败、容器不 online。
- **云电脑生命周期回调**：`onReady` 对 harness（首次 online）与计费事件共用时机，调用 agent-api `POST /internal/cloud-hosts/:hostId/ready`；`onDestroyed` 对 harness 终态调用 `/terminal`（exited→stopped、failed→failed）并按 hostId 调 admin-api `revoke-by-host`。回调均 Bearer `INTERNAL_API_TOKEN`，单次回调内置 4 次退避重试（0/250ms/1s/3s），外层容器钩子再重试 3 次；最终失败记录 error 日志（降级：agent-api 可用过期/对账与容器状态兜底，不阻断容器回收）。`AGENT_API_URL`/`ADMIN_API_URL` 未配置时启动即告警，回调 no-op。**SecretStore 为进程内存**：cloud-controller 重启会丢失在途 harness 的 secrets（该容器初始化将失败/不 online），需通过巡检/重建云电脑恢复；本期不引入持久化 secret。
- 契约：`contracts/cloud-controller-websocket.md`（含内部 HTTP API 附录 A）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口（dev 默认 4003；Aspire dev 10004 / publish 8003） |
| `MONGODB_URI` | 共享 MongoDB |
| `INTERNAL_API_TOKEN` | admin-api ↔ cloud-controller 共享令牌（必填，fail-fast） |
| `K8S_NAMESPACE` | 管理的工作负载命名空间（必填） |
| `WORKER_IMAGE` | 默认工作容器镜像地址（必填） |
| `PUBLIC_WS_ENDPOINT` | 注入容器的对外 wss 地址（必填，**仅 host(:port)**，不得带路径；`/worker` namespace 自动追加，带路径启动即 fail-fast） |
| `CONNECT_TIMEOUT_MS` | 回连超时（默认 300000） |
| `WORKLOAD_INIT_TIMEOUT_MS` | 单条初始化脚本超时（默认 300000，随 `workload:run` 下发，同时作看门狗基准） |
| `WORKLOAD_POST_BUDGET_MS` | 清理脚本批次总预算（默认 90000；预算内执行完再发 shutdown，随后沿用 10s 宽限） |
| `WORKLOAD_LOG_MAX_BYTES` | 单条执行日志存储上限（默认 262144，写入前尾部截断） |
| `K8S_ENABLED` | 是否使用真实 K8s 客户端（默认 `true`；本地/测试设 `false`） |
| `RUNTIME_CLASS_NAME` | 容器 runtimeClass（默认 `sysbox-runc`） |
| `LOG_LEVEL` | 日志级别（`debug`/`info`/`warn`/`error`，默认 `info`）。排查 worker 回连时设 `debug` 看逐请求日志 |
| `AGENT_API_URL` | agent-api 内部地址（可空；配置后启用云电脑 ready/terminal 回调） |
| `AGENT_API_TIMEOUT_MS` | 内部回调超时（默认 5000，正数） |
| `ADMIN_API_URL` | admin-api 内部地址（可空；配置后启用云电脑模型 Key `revoke-by-host`） |

## 回连失败排查（worker 连不上 cloud-controller）

worker 侧报 `Connection error: websocket error` 而 cloud-controller「无日志」时，按下面顺序定位（`LOG_LEVEL=info` 即可，无需改代码）：

1. **确认 cloud-controller 在跑且日志可见**：`kubectl -n zag-cloud logs deploy/cloud-controller`。进程启动必定打印 `cloud-controller listening on :<port> (engine path /socket.io/ ...)` 与一条 worker 回连提示；若这条都没有，说明看错了 Pod/容器，或服务未启动。
2. **请求是否到达 Pod**：websocket 握手走 HTTP **upgrade**，不经过 express；命中时会打印
   `[ws] upgrade accepted path=/socket.io/ ... host=... xfp=... xff=...`。
   - 完全没有该行 → 请求没到 Pod，问题在入口层（Ingress 路径/TLS/host/DNS/Service）。看 Ingress 控制器日志：`kubectl -n <ingress-ns> logs <ingress-pod>`。
   - 出现 `[ws] upgrade path mismatch: got "/worker", expected "/socket.io/"` → Ingress 误配成 `/worker`（`/worker` 是 namespace，不是路径）；把 Ingress `spec.rules[].http.paths[].path` 改为 `/socket.io`（Prefix）。
   - 出现 `[ws] engine connection_error code=... message=...` → 到 Pod 了但被 engine 拒绝（协议版本/CORS/传输不匹配），按 message 处理。
3. **握手鉴权是否通过**：到达后依次打印 `[worker] handshake attempt ... token=present|MISSING` → `handshake accepted/rejected (INVALID_TOKEN)` → `connected` → `registered`。卡在哪一步即问题所在（token 失效/版本不兼容/register 失败等）。
4. **worker 侧细节**：`Connection error: websocket error` 现在会追加 `(type=... description=... context=...)`，其中 `context` 常含真实 HTTP 状态（如 `unexpected server response (404)`），据此判断是入口层 404 还是 TLS 问题。

> 说明：`/worker` 是 Socket.IO **namespace**，握手实际打 engine path `/socket.io/`；`ZAG_SERVER_ENDPOINT=wss://<host>/worker` 是本仓库既定约定，**不是**让 Ingress 暴露 `/worker`（见契约 `contracts/cloud-controller-websocket.md` §1.2）。

## 在线容器 runtime 工作负载（本期）

- 新增内部端点：`POST /internal/containers/:id/workloads`（依赖展开 + 参数校验 + 单批次安装）与 `POST /internal/containers/:id/runtime-scripts`（系统内联单脚本，Git 设置用）。错误码：`404 NOT_FOUND`、`409 CONTAINER_NOT_ONLINE|CONTAINER_BUSY`、`400 INVALID_WORKLOAD|INVALID_SCRIPT`。
- `WorkloadDispatcher.startRuntimeBatch`：入口要求 `online`，CAS 到 `initializing` 并写 `initTrigger='runtime'`；完成后直接 `markOnline`，不回 `connecting`；同一容器同时只允许一个 runtime 批次。`workload:run` 仅在该批次携带 `githubAuth:true`，普通批次报文形状不变。
- 已安装集合：`cloudcontainers.installedWorkloads[{workloadId,name,installedAt,source}]` 只在 `success` 时回填（start→`start`，runtime→`user|mcp`），按 workloadId 去重保留首次；`source=system` 的 Git 脚本不写。失败不注销容器（`required=false`）。
- 日志：`cloudworkloadlogs.trigger`（`start|runtime`）与 `source`（`admin|user|mcp|system`），历史记录读取缺省 `start/admin`。
- 门禁：harness `MIN_HARNESS_WORKER_VERSION=2.6.0`（凭据管理器）；普通容器仍 `2.2.0`。harness Job env 新增 `ZAG_AGENT_API_ENDPOINT`（`AGENT_API_URL`）与 `ZAG_CONTROLLER_ID`（请求可选 `controllerId`）；缺失 `AGENT_API_URL` 仅告警。

## Dev Commands

```bash
aspire start        # Aspire 编排（注入 K8S_ENABLED=false）
npm run build       # tsc strict
npm test            # vitest run
npm run test:coverage
```

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环。详细指南参考 [TDD Skill](../../.agents/skills/tdd/SKILL.md)。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)
- [WS 契约](../../contracts/cloud-controller-websocket.md)

## 云容器优化二期（ephemeral-storage）

- Job pod 模板 `resources.limits` 增加 `ephemeral-storage`，默认 `10Gi`，可由 `JOB_EPHEMERAL_STORAGE` 覆盖（`JobManagerConfig.ephemeralStorage`）；**不设置 `requests`**（与既有 CPU/内存口径一致）；`K8sResourceList` 已扩展该可选字段。
- 部署 env 同步：`deploy/k8s/cloud-controller.yaml`、`aspire/AgentGear.AppHost/AppHost.cs`、`aspire/manifest/docker-compose.yaml`。
