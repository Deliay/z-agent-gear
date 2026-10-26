---
description: 容器启动任务支持 harness 类型实现计划（v3.0 生命周期简化）：前台 agent-web 云电脑、harnessTypes 多选与单选默认会话、每用户 1 实例、stopCloudHost(force) 停止即销毁、会话只读、Controller(type=cloud) 主机同构、运行专用模型 Key；统一存储与会话导入导出二期
type: Permanent
---

# 容器启动任务支持 harness 类型（OpenCode 云电脑）- 实现计划

**关联 Proposal**: `docs/engineering/proposals/20261020-feat-container-harness-support.md`（v5.0）
**关联 PRD**: `docs/product/draft/20261020-container-harness-support.md`（v5.0）
**需求总分支（feat-branch）**: `feat/container-harness-support`（基于 `main`，需求总 PR #244）
**计划提交分支**: `feat/container-harness-support`（本文件随需求总分支提交）
**创建日期**: 2026-10-20
**计划版本**: v3.0

**版本说明**:

- v1.0（2026-10-20）首版，对应 PRD/提案 v1.0（后台启动 harness + 统一存储 + 会话导入导出）。
- v2.0（2026-10-20）按 PRD/提案 v3.0 整体重排：前台交付、云主机复用 `Controller(type=cloud)`、统一存储与会话存取移出本期。
- v3.0（2026-10-20）按 PRD/提案 **v5.0 整体重写**：云电脑**停止即销毁、不可重新运行**；每前台用户同时 **1 个实例**；`harnessTypes` 数组（≥1）与**恰好 1 个自动创建默认会话**；停止前活动会话告警（`force`）、停止后会话**只读**；Controller 销毁后保留、`ControllerKey` 撤销；运行专用模型 Key 改为 `scope=CLOUD_HOST + cloudHostId`。v3.0 **不是** v2.0 的局部修补，删除 `startCloudHost`、重启、Key 重铸、`EXITED/OFFLINE` 云主机状态等 v2.0 设计。

## 0. v2.0 → v3.0 变更摘要

| 维度 | v2.0（旧） | v3.0（本计划） |
|------|-----------|---------------|
| 云电脑生命周期 | 创建 → 运行 → 销毁；状态含 `PROVISIONING/ONLINE/OFFLINE/DESTROYING/EXITED` | **创建即启动 → 停止即销毁**；`STARTING/RUNNING/STOPPING/STOPPED/FAILED`，`STOPPED` 为终态；无 `startCloudHost` |
| 每用户实例数 | 默认 3 | **同时最多 1 个**（`CLOUD_HOST_MAX_PER_USER=1`） |
| 会话 | 一机多会话；销毁只影响主机 | 一机多会话保留；**停止时批量 ENDED 且只读**，消息留档可查看、不可继续 |
| harness 参数 | 单值 `harnessType` | **数组 `harnessTypes`（去重 ≥1）**；恰好 1 个就绪后自动创建默认会话，≥2 不创建 |
| 停止 | `destroyCloudHost(controllerId)` | **`stopCloudHost(id, force)`** + `cloudHostStopImpact`；有活动会话必须 `force=true`；无再次启动 |
| 删除 | 销毁即删除 | **仅 STOPPED/FAILED 可 `deleteCloudHost`**；软删除记录、Controller 与会话留档保留 |
| 主机标识 | 以 `controllerId` 作为云主机 ID | `CloudHost.id` 独立；`controllerId` 仅用于主机/会话归属 |
| 模型 Key | `scope=CONTAINER`、`containerId=controllerId` | **`scope=CLOUD_HOST`、`cloudHostId=CloudHost.id`**；停止/终态/删除撤销 |
| 标准连接凭据 | `ZAG_CONTROLLER_ENDPOINT/ZAG_CONTROLLER_KEY`，新增 `ZAG_WORKER_TOKEN` | **`/worker` 继续用 `ZAG_CONTROLLER_KEY` 一次性 token**；标准连接用 **`ZAG_HOST_ENDPOINT/ZAG_HOST_KEY`** |
| 就绪/终态 | agent-api 读容器状态降级 | **cloud-controller → agent-api 内部回调 `ready/terminal`**，驱动 `RUNNING`、默认会话、停止后会话只读 |
| 计划阶段 | 10 Phase | 10 Phase（契约 → Key/网关 → migration 005 → agent-api → cloud-controller → agent-gear → 镜像 → agent-web → tests → 文档） |

## 1. 实现顺序

```mermaid
flowchart TD
    P1["Phase 1 契约先行<br/>cloud-host.graphql 新增<br/>agent-controller / cloud-controller-websocket /<br/>admin-billing / billing-openai 扩展"] --> P2
    P1 --> P3
    P1 --> P6

    P2["Phase 2 admin-api<br/>CLOUD_HOST 模型 Key<br/>网关模型范围/分流/失效/对账"] --> P4
    P3["Phase 3 admin-api<br/>workloadKind/harnessType<br/>migration 005 OpenCode（Harness）"] --> P4

    P4["Phase 4 agent-api<br/>cloud-host 域 / 1 实例 / 停止编排 /<br/>默认会话 / ready+terminal 回调 / 会话只读"] --> P5
    P4 --> P8

    P5["Phase 5 cloud-controller<br/>purpose=harness / secrets / env /<br/>TTL / 门禁 / registered.initializing / 回调"] --> P7

    P6["Phase 6 agent-gear 2.5.0<br/>双连接 / init 后上线 /<br/>harness prepare / opencode.jsonc"] --> P7
    P7["Phase 7 worker 镜像 + Aspire/K8s<br/>agent-gear 2.5.x / BUILD.md / env"] --> P9
    P8["Phase 8 agent-web<br/>云图标 / 新建 / 停止告警 /<br/>只读回看 / 删除"] --> P9
    P9["Phase 9 tests/api + tests/e2e + 全量回归"] --> P10
    P10["Phase 10 文档收口 + 发布顺序 + 验收"]
```

依赖说明：

- **Phase 1 契约**是全部实现的输入，独立提交（`docs(contracts): ...`）；契约未合入前不写实现代码。
- **Phase 2（Key/网关）**与 **Phase 3（预置工作负载）**只依赖 Phase 1，可并行。
- **Phase 4（agent-api）**依赖 Phase 2（Key 铸造/撤销）与 Phase 3（harness preset 读取）；**Phase 5（cloud-controller）**与 **Phase 6（agent-gear）**只依赖 Phase 1，可与 Phase 4 并行开发（联调在 Phase 7/9）。
- **Phase 7** 依赖 Phase 5 的 env/门禁与 Phase 6 的 `agent-gear@2.5.0` 产物；**Phase 8** 依赖 Phase 4 的 GraphQL；**Phase 9** 在各实现分支合并回需求总分支后切出；**Phase 10** 收口。

### 开发分支与合并顺序

| 分支 | 范围 | 基于 | 合并目标 |
|------|------|------|---------|
| `feat/container-harness-support` | PRD / 提案 / 本计划 | `main` | 需求总 PR #244 |
| `contracts/harness-support` | `contracts/` 6 份 | 需求总分支 | 需求总分支 |
| `servers/harness-support` | admin-api + agent-api + cloud-controller | 需求总分支 | 需求总分支 |
| `packages/harness-support` | agent-gear + worker 镜像 + Aspire/K8s | 需求总分支 | 需求总分支 |
| `apps/harness-support` | agent-web | 需求总分支 | 需求总分支 |
| `tests/harness-support` | tests/api + tests/e2e | 需求总分支（其余已合入） | 需求总分支 |

合并顺序：契约 → servers → packages → apps → tests。**禁止 rebase/squash，只允许 merge**（z-git 规范）。

### 开发模式与规范加载

- 全部 Phase 采用 TDD（红-绿-重构）：先写测试（RED）→ 最小实现（GREEN）→ 重构。
- 编码前加载：`docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`（后端）、`docs/engineering/frontend-rules.md`（agent-web）。
- 目录级 `AGENTS.md`：`servers/agent-api/AGENTS.md`、`servers/controller-api/AGENTS.md`、`servers/cloud-controller/AGENTS.md`、`packages/agent-controller/AGENTS.md`、`apps/agent-web/AGENTS.md`、`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`、`aspire/AgentGear.AppHost/AGENTS.md`、`docs/engineering/plan/AGENTS.md`。
- `servers/admin-api` 无独立 `AGENTS.md`，沿用根 `AGENTS.md` 与 engineering 规范；**admin-web 本期零改动**。

## 2. 命令参考

```bash
# 服务编排（根目录；测试服务只用 Aspire，禁止直接 docker 命令）
aspire start
aspire wait agent-api cloud-controller controller-api agent-web
aspire describe agent-api
aspire describe controller-api
aspire stop

# 单服务单测 / 构建
cd servers/admin-api && npm ci && npm test && npm run build
cd servers/agent-api && npm ci && npm test && npm run build
cd servers/cloud-controller && npm ci && npm test && npm run build
cd servers/controller-api && npm ci && npm test && npm run build
cd packages/agent-controller && npm ci && npm test && npm run build
cd apps/agent-web && npm ci && npm test && npm run build && npm run lint

# 跨服务 API 测试（先 aspire start；地址按 aspire describe 替换）
cd tests/api
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
CONTROLLER_API_URL=http://localhost:<controller-api-port> \
CLOUD_CONTROLLER_URL=http://localhost:10004 \
CLOUD_CONTROLLER_INTERNAL_TOKEN=<与 internal-api-token 一致> \
MONGODB_URI=<aspire describe mongodb> \
npm test

# E2E（串行；地址按 aspire describe 替换）
cd tests/e2e
BASE_URL=http://localhost:<agent-web-port> \
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
CONTROLLER_API_URL=http://localhost:<controller-api-port> \
CLOUD_CONTROLLER_URL=http://localhost:10004 \
MONGODB_URI=<aspire describe mongodb> \
npx playwright test

# worker 镜像（内网构建，不属于服务编排）
cd deploy/images/worker
docker build -t core.harbor.internal.fffdan.com/zero-tools/worker:harness-local .
docker run --rm --entrypoint bash \
  core.harbor.internal.fffdan.com/zero-tools/worker:harness-local -lc \
  'agent-gear --version && agent-gear harness --help'
```

> `HARNESS_ENABLED` 在 Aspire dev 模式由 `AppHost.cs` 显式置 `true` 便于联调；publish 默认 `false`，验收/灰度时打开。API/E2E 用例在开关关闭时按 `test.skip` 跳过并在验收报告登记。

### 关键约束（提案 §1.3/§6，实现期不得回退）

- **契约先行**：6 份契约先于实现独立提交；字段、错误文案、状态码与提案 §3 对齐，偏差以 §3 计划期裁决为准。
- **单一事实源**：`cloudworkloads` 由 admin-api 写；`cloudcontainers` 由 cloud-controller 写；`cloudhosts`/`controllers`/`controllerkeys`/`sessions` 由 agent-api 写；admin-api 只读 `cloudhosts`/`cloudcontainers`（只读模型/内部 API）。
- **secret 不落库、不进日志**：模型 Key 与控制器 Key 明文只在创建/补发响应中出现一次；cloud-controller 仅内存持有；worker 只在进程环境持有；日志统一脱敏。
- **不上调全局 worker 门禁**：`MIN_WORKER_VERSION` 保持 `2.2.0`；harness 容器使用 `MIN_HARNESS_WORKER_VERSION=2.5.0` 按 purpose 分流。
- **后台零改动**：`adminStartCloudContainer` 维持仅 `IDLE`；`contracts/admin-cloud-container.graphql`、`contracts/admin-cloud-workload.graphql`、admin-web 页面均不改。
- **本期无存储/无会话导入导出**：不引入 S3/MinIO/`unified-storage`/`storage*`/`quota-guard`/`opencode session import|export` 任何代码、契约、依赖、入口。
- **停止即终态**：无 `startCloudHost`、无重启、无 Key 重铸；需要新云电脑时重新 `createCloudHost`。
- **既有 idle 行为不变**：`idle` 启动、工作负载参数/依赖/必须失败、计费全链路、普通主机/标准会话保持现状；新增字段对历史记录读取必须容忍缺失。
- **测试纪律**：新增代码单测覆盖率 ≥ 80%；API 与 E2E 串行执行；测试服务只用 Aspire 编排，禁止直接 `docker` 命令。

---

## 3. 计划期裁决（提案与代码事实偏差的落地口径）

> 以下裁决以**当前代码事实**为准。提案中与代码不一致的描述在实现期按本节执行，不再回改提案；验收报告需逐条登记。

### A. 事实校正（提案描述与仓库现状不符）

| # | 提案描述 | 代码事实 | 本计划口径 |
|---|---------|---------|-----------|
| A1 | §3.2.3/§6.2：agent-gear 2.5.0；`MIN_WORKER_VERSION` 保持 2.2.0 + harness 专用门禁 | `packages/agent-controller/src/socketio-client.ts:24` 硬编码 `2.4.0`；`package.json:3` 为 `2.4.0`；`cloud-controller/src/services/worker-version.ts` 为 `2.2.0` | agent-gear 升 **`2.5.0`**；`MIN_WORKER_VERSION` **保持 `2.2.0`**；新增 **`MIN_HARNESS_WORKER_VERSION='2.5.0'`**，`register` 时按容器 `purpose` 分流校验。普通容器不受影响。 |
| A2 | §5.3/§7：worker 镜像**未预装** `@opencode/cli`，由 init 安装；BUILD.md 校验清单 | `deploy/images/worker/Dockerfile:118-123` 只装 `agent-gear@2.4.x`、`claude-agent-acp`、`codex-acp`；`BUILD.md` 的「7 包」清单与 Dockerfile 不一致，`opencode --version \|\| true` 为软校验 | worker 镜像**不预装** `@opencode/cli`；init 脚本固定版本安装并 `opencode --version` 硬校验；BUILD.md 改为「镜像仅 agent-gear + OpenCode 由 harness 工作负载安装」，Claude Code / Codex 的 ACP 适配器不再预装（后续移除）。 |
| A3 | §3.2.3：`ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT` 维持 `/worker` 一次性 token；标准连接用 `ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT` | 现有 worker 的 `ZAG_CONTROLLER_KEY` **就是** cloud-controller 一次性 token（`k8s-job-manager.ts:117`、`entrypoint.sh:16`）；agent-gear 也把它当 `/worker` 握手 token | **采纳提案命名**：`ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT` 继续承载 `/worker`；标准 Controller 连接新增 `ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT`。**删除 v2.0 的 `ZAG_WORKER_TOKEN` 方案**；idle 容器完全不变。 |
| A4 | §3.1.3：容器 Key `/v1/models` 返回「Key 属主个人可用模型列表」；自定义模型代转发 | `Model`/`Provider` 只有 `scope: 'user' \| 'global'`，**无 `userId`/`ownerId`**；admin-api `billing-openai.ts` 当前只查 `scope:'global'`；agent-api `models` 查询口径是 `scope=user` 全量 ∪ `scope=global` 且启用 | 本期「用户个人可用模型列表」= **agent-web 设置页中启用的模型集合**（`scope=user,isEnabled=true` ∪ `scope=global,isEnabled=true`）；容器 Key 的 `/v1/models` 与 `chat/completions` 使用同一口径。自定义模型（`scope=user`）走网关代转发、不记账；**按用户 ownerId 隔离模型归属不在本期**，在验收报告登记为二期遗留。 |
| A5 | §3.1.2/§5.1.4：销毁后 Controller 保留；`deleteCloudHost` 移除主机条目但留档 | `homeOverview.controllers` 是 Sidebar 的唯一来源；删除 `Controller` 会让历史会话失去归属；`controllerService.unbind` 会删 Controller+Key | `deleteCloudHost` **软删除 `cloudhosts`（`deletedAt`）**，设置 `Controller.status='offline'` 并撤销 `ControllerKey`；`controllerService.findAllByUser`/`myCloudHosts` 过滤 `deletedAt != null` 的云电脑；**Controller 行与会话/消息永久保留**，历史可追溯。普通主机不受影响。 |
| A6 | §3.2.3：默认工作区 `ZAG_DEFAULT_WORKSPACE=/root/workspace` | worker 镜像未设置 `USER`，容器以 root 运行，`os.homedir()='/root'`；`entrypoint.sh` 以 PID 1 运行 | 默认工作区 **`/root/workspace`**（agent-api `CLOUD_HOST_DEFAULT_WORKSPACE`，可覆盖）；`ZAG_DEFAULT_WORKSPACE` 随 Job env 与 `workload:run env` 下发；`ControllerWorkspace.path` 与之一致。 |
| A7 | §4.1：`cloudcontainers` 扩展 `purpose/hostId/harnessTypes/controllerKeyId/containerApiKeyId` | 现有模型已有 `userId`、`purpose/refId/billingAccountId`，但无 `hostId/harnessTypes/controllerKeyId/containerApiKeyId/hostName/expiresAt`；`purpose` 枚举无 `harness` | 新增 `hostId`（云电脑 ID，索引）、`controllerKeyId`、`containerApiKeyId`、`hostName`、`harnessTypes`、`expiresAt`；`refId` 继续存 `controllerKeyId`（兼容既有语义）。写方仍只有 cloud-controller。 |
| A8 | §5.1.2：agent-api 把预制「OpenCode（Harness）」加入 `workloadPlan` | agent-api 当前**没有** `cloudworkloads`/`cloudcontainers` 模型，也没有 cloud-controller 客户端 | agent-api 新增**只读** `CloudWorkload`/`CloudContainer`/`CloudHost` Mongoose 模型（共享 Mongo，只读模型不写）与 `cloud-controller-client`；按 `presetKey='harness-opencode'` 读取 preset 并构造 `workloadPlan=[{workloadId, params:{}, implicit:false, required:true}]`。 |
| A9 | §5.1.1：worker 双连接、init 后才能建会话 | 现有 `registered` 事件只返回 `{controllerId}`；agent-gear 无法知道 init 批次何时结束，立即连 controller-api 会在 OpenCode 安装完成前显示在线 | cloud-controller 的 `registered` 增加可选 **`initializing: boolean`**；agent-gear harness supervisor 在 `initializing=true` 时等待 `workload:run` 批次完成（成功/失败）再建立 controller-api 标准连接；`false`/缺省时立即连接（向后兼容）。 |
| A10 | §3.1.3/§4.1：`BillingApiKey.cloudHostId` 关联云电脑 | Key 必须在容器创建**之前**铸造（Job env 需要模型 Key），此时 `cloudcontainers._id` 尚不存在，但 `cloudhosts._id` 已在创建编排中预生成 | `BillingApiKey` 增 `scope/cloudHostId/expiresAt`，`cloudHostId` 存 **CloudHost._id**；网关按只读 `cloudhosts.status` 校验，不再使用 v2.0 的 `containerId` 语义。 |
| A11 | §8.1：API/E2E 覆盖云电脑在线、标准会话、OpenCode ACP | Aspire dev 的 `K8S_ENABLED=false` 使用 `InMemoryK8sClient`，不会产生真实 worker；`createCloudHost` 返回的 ControllerKey 明文不通过 GraphQL 暴露 | **tests/api** 覆盖创建/校验/列表/停止/删除/回滚/回调；**tests/e2e** 覆盖新建对话框、云图标、启动中状态、停止确认、只读/删除入口；**在线 + OpenCode ACP + 默认会话**由 agent-gear/cloud-controller/agent-api 单测 + 真实集群手工验收覆盖（验收报告登记）。不引入测试专用后门。 |
| A12 | §3.1.1：云电脑 GraphQL 契约只有 `myCloudHosts`/`cloudHostStopImpact` | agent-web 无特性开关框架；`config.js` 只注入 `apiUrl`；PRD 要求未选 harness 不可提交 | 增加 **`cloudHostCapabilities: { enabled, supportedHarnesses }`** 查询；`HARNESS_ENABLED=false` 时 `enabled=false`、`supportedHarnesses=[]`；前端据此隐藏/禁用新建入口。开关关闭时 `create` 拒绝，但 `myCloudHosts`/`stopCloudHost`/`deleteCloudHost` 仍可用（便于回滚后清理存量）。 |
| A13 | §5.1.5：写 `opencode.jsonc`（custom provider） | `packages/agent-controller` 无 `jsonc-parser`；OpenCode 配置为 `opencode.jsonc`（`.json` 亦兼容） | 新增 `jsonc-parser` 依赖；默认写 `~/.config/opencode/opencode.jsonc`，若同目录只存在 `opencode.json` 则合并该文件；保留注释与既有 provider，仅替换 `provider.zag`。 |
| A14 | §5.3：`@opencode/cli@<pin>` | 内网 npm 代理可用版本在实施时确认；旧计划使用 `2.1.1` | 固定 `OPENCODE_CLI_VERSION`（默认 `2.1.1`，实施时以 `npm view @opencode/cli versions` 实测锁定并写入 BUILD.md）；init 脚本中硬编码默认值，可用同名 env 覆盖但**验收以固定版本为准**。 |
| A15 | §3.2.1：`secrets` 由 agent-api 下发 | agent-api 无 controller-api 对外地址配置；worker 在 K8s 内需可达 controller-api 与计费网关 | agent-api 新增 `CONTROLLER_API_PUBLIC_WS_ENDPOINT`、`CLOUD_HOST_MODEL_BASE_URL`、`CLOUD_HOST_DEFAULT_WORKSPACE` 配置；创建时校验非空，随内部请求下发（非 secret 的 baseURL 也放在 `secrets` 报文内，但不落库）。 |
| A16 | §3.2.2：cloud-controller 终态撤销 + `container.destroyed` 兜底 + admin-api 对账三线 | admin-api 与 cloud-controller 共享 Mongo；admin-api 已有 `cloudcontainers` 只读模型；cloud-controller 无 admin-api 客户端 | 三线落地为：① agent-api `stopCloudHost`/`deleteCloudHost` 显式 `revoke-by-host`；② cloud-controller `onDestroyed` 调 admin-api `revoke-by-host`（按 `hostId` 幂等）；③ 计费网关每次鉴权校验 `cloudhosts.status=RUNNING` 且未过期（实时失效）+ admin-api 每日对账扫描 `scope=cloud_host` 且宿主处于非合法态（`STOPPING`/`STOPPED`/`FAILED` 等）或过期/缺 expiry 的 Key。**`STARTING` 窗口 Key 必须存活**（Key 在 STARTING 期铸造、本期无重铸），由网关实时校验拒绝非 RUNNING 调用。不依赖 `container.destroyed` MQ 消费。 |
| A17 | §8.2：tests/api 使用 `vitest + supertest` | 仓库无 `supertest`；`tests/api` 用 `fetch` 打真实 Aspire 服务 | 继续 **vitest + fetch**；不引入 supertest。 |
| A18 | §3.1.1/§5.1.4：停止后会话 `ENDED` 且只读；服务端拒绝 `session:command`（`session is ended`） | 既有 `sessionService.resume` **允许** `ended` 会话恢复（`session.ts:328-331`）；普通「已结束」会话可 resume；`Session` 无只读字段 | **不新增 Session 字段/不改 `agent-session.graphql`**：`resume` 前按 `controllerId` 查 `cloudhosts`，若云电脑 `STOPPED/FAILED/deletedAt` 则返回 `session is ended`；普通 ended 会话行为不变。前端按 `cloudHost.status` 隐藏继续/发送入口，服务端拒绝为主。`createSession` 对 cloud Controller 校验云电脑必须 RUNNING（否则 `cloud host is not running`）。 |
| A19 | §5.1.1：`CC-->>AA: 就绪 → cloudhosts.status=RUNNING`；§5.1.4 停止/终态 | cloud-controller 只有计费 `onReady/onDestroyed` 钩子，**没有**通知 agent-api 的通道 | 新增 cloud-controller → agent-api 内部回调：`POST /internal/cloud-hosts/:id/ready`（首次 online）与 `POST /internal/cloud-hosts/:id/terminal`（exited/failed/destroyed，含 TTL 自然退出）。Bearer `INTERNAL_API_TOKEN`，幂等。 |
| A20 | §5.1.4：停止编排「会话 ENDED → 销毁容器 → 撤销 Key → STOPPED」 | 无现成云电脑停止流程；cloud-controller `destroy` 对终态幂等 | 停止失败（控制面不可达）时**保持 `STOPPING` 并抛 `control plane unavailable`**，会话已 ENDED 不回滚；重试 `stopCloudHost` 时活动会话为 0、无需 `force`，继续销毁。`STOPPING` 计入 1 实例上限，阻止新建直到收敛。 |
| A21 | §3.1.1：`deleteCloudHost` 仅 STOPPED/FAILED；移除主机条目 | `homeOverview.controllers` 会展示所有 Controller；直接删 Controller 会丢历史会话归属 | 软删除 `cloudhosts.deletedAt` + `Controller.status='offline'` + 撤销 ControllerKey；Controller/会话/消息保留。`deleteCloudHost` 幂等；运行中/停止中拒绝 `stop the cloud host before deleting`。 |
| A22 | §5.1.1：就绪后创建默认会话 | agent-api 无「容器就绪」事件；`createSession` 需要 `workspaceId` | `cloudhosts` 增加 `workspaceId`（创建时预置默认工作区）；`ready` 回调内按 `harnessTypes.length===1` 创建默认会话；失败只记录、`defaultSessionId=null`，主机保持 RUNNING。 |
| A23 | §8.3：E2E 无真实 worker | `K8S_ENABLED=false` 下 `createCloudHost` 只能停在 STARTING；没有真实 controller-api 注册 | E2E 不断言 RUNNING/默认会话/只读消息；这些由单测（ready/terminal 回调、默认会话编排、resume 拒绝）+ 真实集群手工验收覆盖。E2E 覆盖 STARTING → 停止（无会话）→ STOPPED → 删除。 |
| A24 | §3.1.1：`STOPPED` 为终态；§9.2 `HARNESS_INIT_TIMEOUT_MS` | 容器 TTL 由 Job `activeDeadlineSeconds` 控制；TTL 到期由 K8s 直接退出，cloud-controller 可能只收到 Job 退出/巡检 | `expiresAt` 同时用于模型 Key 与 Job `activeDeadlineSeconds`；TTL/异常退出经 `onDestroyed` → `terminal` 回调把云电脑置 `STOPPED`（失败置 `FAILED`）并批量结束会话；看门狗兜底沿用现有容器巡检。 |

### B. 设计裁决（提案留白/含混处）

1. **创建编排顺序**：按 `userId` 串行锁（防双击/并发超限）→ 校验开关/名称/`harnessTypes`/1 实例 → 取（或创建）前台计费账户 → 预生成 `cloudHostId`、`controllerId`（均为 `new mongoose.Types.ObjectId()`）→ 创建 `ControllerKey(type=cloud, boundControllerId=controllerId)` → 以预生成 `_id` 预创建 `Controller(type=cloud,status=registering,name,hostname=name,version='0.0.0')` → 创建默认 `ControllerWorkspace` → 创建 `CloudHost(STARTING, workspaceId)` → 铸造 `scope=CLOUD_HOST` 模型 Key（`cloudHostId`、`expiresAt`）→ 读取 harness preset 构造 plan → `POST /internal/containers`。任一步失败按逆序回滚；cloud-controller **成功返回后不再回滚**（后续异常由 `terminal`/TTL 兜底）；cloud-controller 失败统一抛 `control plane unavailable`。
2. **ControllerKey 创建**：**不得复用** `controllerKeyService.create`（它会删除用户现有的未绑定 Key）。新增 `createForCloudHost(userId, controllerId, name)`：不删除未绑定 Key、`boundControllerId` 直接写入预生成 `controllerId`；该 Key 不出现在设置页「未绑定 Key」列表。
3. **Controller 预创建字段**：`Controller` schema 的 `hostname`/`version` 必填；预创建 `hostname=name`、`version='0.0.0'`。controller-api `register` 的 `findOneAndUpdate` 使用 `$setOnInsert: { name: hostname }`，已存在文档不覆盖用户命名。
4. **状态映射**：`cloudhosts.status` 为生命周期事实源；`STARTING`（创建到 ready 回调前）、`RUNNING`（ready 回调后）、`STOPPING`（停止编排中）、`STOPPED`（终态/已销毁）、`FAILED`（启动/运行失败，`failureReason` 有值）。`Controller.status` 仅表示连接态（registering/online/offline），前端以 `CloudHost.status` 为主。
5. **`cloudHostCapabilities`**：返回 `{ enabled, supportedHarnesses }`；`enabled=true` 且 preset 存在时返回 `[OPENCODE]`；preset 缺失时返回空列表并让 create 报 `harness workload preset not found: opencode`。
6. **`Controller.cloudHost` 字段**：在 `cloud-host.graphql` 中 `extend type Controller { cloudHost: CloudHost }`；agent-api resolver 对 `type==='cloud'` 查 `cloudhosts`（按 `controllerId`，排除 `deletedAt`），普通主机返回 `null`。`HOME_OVERVIEW`/`GET_CONTROLLERS` 选择该字段后 Sidebar/配置页据此显示状态；`homeOverview` 的 `controllers` 过滤软删除云电脑。
7. **停止编排**：`stopCloudHost(id, force)` 的 `id=CloudHost.id`。per-host 锁内：已 `STOPPED/FAILED` 幂等返回 → 统计非 ENDED 会话，`>0 && force!==true` 拒绝 → `status=STOPPING` → `updateMany(sessions, status:{$ne:'ended'}, {status:'ended', endedAt})` → 有 `containerId` 调 cloud-controller `DELETE /internal/containers/:id` → `revoke-by-host` → `status=STOPPED, stoppedAt, containerId=null`。控制面失败保持 `STOPPING` 并抛错；重试幂等。**无 `startCloudHost`**。
8. **删除语义**：`deleteCloudHost(id)` 仅 `STOPPED/FAILED`；已 `deletedAt` 幂等 `true`。撤销模型 Key（`revoke-by-host`）→ 删除 `ControllerKey` + evict → `Controller.status='offline'` → `cloudhosts.deletedAt=now`。Controller/会话/消息保留；`myCloudHosts` 与 Sidebar 不再展示。运行中/停止中抛 `stop the cloud host before deleting`。
9. **模型 Key 失效**：admin-api `billingKeyAuth` 在 `verify` 成功后追加：`scope=CLOUD_HOST` 时若 `expiresAt < now`、`cloudHostId` 缺失、云电脑不存在、`deletedAt != null` 或 `status != RUNNING` → `401 invalid_api_key`。创建窗口（STARTING）内 worker 初始化不调用模型网关；`harness prepare` 只写配置，因此不会误伤。Key 铸造失败会回滚创建。
10. **自定义模型路由**：`/v1/chat/completions` 先查 `scope='global'`（系统模型，走既有计费）；未命中且 Key 为 `CLOUD_HOST` 时查 `scope='user'` 按 `sortOrder,createdAt` 取第一条（不要求 pricing）。自定义模型不写计量/outbox，`BillingApiCall` 记 `billable=false,cost=0` 作为调用审计（不计费）。同名时系统模型优先。
11. **模型列表快照**：agent-api 创建云电脑时用 `modelService.findAll()` 过滤 `isEnabled` 生成 `modelIds`（去空、去重），以 JSON 数组字符串 `ZAG_MODEL_IDS` 下发；agent-gear `harness prepare` 不额外请求 `/v1/models`，避免初始化期多一次网络依赖。`/v1/models` 仍按容器 Key 口径返回，供 OpenCode 运行时使用。
12. **初始化就绪门禁**：cloud-controller 在 `register` 时先判断 `hasInitScripts`；`registered` 携带 `initializing`。agent-gear 在 `initializing=true` 时等待首个 `workload:run` 批次结束（成功/失败）后再连 controller-api；等待超时（`HARNESS_INIT_WAIT_MS`，默认 10 分钟）则仍连接并由 cloud-controller 看门狗兜底。这样 Sidebar 不会在 OpenCode 装好前显示在线。
13. **容器 TTL**：agent-api `HARNESS_CONTAINER_TTL_SECONDS`（默认 `86400`）；`expiresAt=now+TTL` 同时用于模型 Key 与 Job `activeDeadlineSeconds`。cloud-controller 以 `max(60, floor((expiresAt-now)/1000))` 设置，缺省沿用 `JOB_ACTIVE_DEADLINE_SECONDS=86400`。
14. **ready/terminal 回调**：cloud-controller `onReady`（首次 online）与 `onDestroyed` 钩子中，若 `purpose=harness` 且有 `hostId`，分别调用 agent-api `POST /internal/cloud-hosts/:hostId/ready`、`POST /internal/cloud-hosts/:hostId/terminal`；Bearer `INTERNAL_API_TOKEN`、超时/失败只告警不阻断容器生命周期（与计费钩子同语义）。ready 幂等（已 RUNNING 不重复建默认会话）；terminal 幂等（已 STOPPED/FAILED 直接返回）。
15. **会话只读**：停止时 `updateMany` 置 ENDED；`resume` 先查 `cloudhosts`（按 controllerId），云电脑 `STOPPED/FAILED/deletedAt` → 返回 `{success:false,status:'ended',error:'session is ended'}`；前端 SessionPage 在云电脑终态时只读渲染（无输入框/发送/继续）。普通已结束会话仍可 resume。`createSession` 对 cloud Controller 校验 `CloudHost.status==='RUNNING'`，否则抛 `cloud host is not running`。
16. **OpenCode 环境**：init 脚本顺序固定为「安装固定版本 → `opencode --version` 硬校验 → `mkdir -p $ZAG_DEFAULT_WORKSPACE` → `agent-gear harness prepare`」；任一失败非零退出，依赖 `required=true` 触发容器强制注销。
17. **默认会话失败**：ready 回调内 `createSession` 抛错时只记录 warning，`defaultSessionId=null`，云电脑保持 RUNNING；前端提示「可手动创建会话」。已有 `defaultSessionId` 不重建。
18. **1 实例校验**：`create` 前在 per-user 锁内统计 `userId + status ∈ {STARTING,RUNNING,STOPPING} + deletedAt=null`；非零拒绝 `too many cloud hosts`。`STOPPED/FAILED` 不计入，可继续新建（未删除旧记录也不阻塞）。
19. **错误文案（服务端逐字）**：见 Phase 1 表格；GraphQL 层统一 `GraphQLError`，不泄露 Mongo/驱动信息。
20. **软删除与历史**：`deleteCloudHost` 不物理删除 `cloudhosts`；会话/消息/Controller 留档；`myCloudHosts`/`homeOverview.controllers` 不展示软删除云电脑；审计可通过 Mongo 追溯。

---

## Phase 1: 契约先行（contracts/）

开发分支：`contracts/harness-support`。本 Phase 独立提交（`docs(contracts): ...`），不写实现代码。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/cloud-host.graphql` | 新增 | 前台云电脑契约：`enum HarnessType { OPENCODE }`、`enum CloudHostStatus { STARTING RUNNING STOPPING STOPPED FAILED }`、`CloudHost`（`id/name/controllerId/status/harnessTypes/defaultSessionId/activeSessionCount/containerId/createdAt/readyAt/stoppedAt/failureReason`）、`CloudHostStopImpact`、`CloudHostSessionSummary`、`CreateCloudHostInput { name, harnessTypes }`、`CloudHostCapabilities`、Query `cloudHostCapabilities/myCloudHosts/cloudHostStopImpact`、Mutation `createCloudHost/stopCloudHost/deleteCloudHost`、`extend type Controller { cloudHost: CloudHost }` |
| `contracts/agent-controller.graphql` | 修改（注释/语义） | 明确 `ControllerType.cloud`：由 agent-api 预创建，`status=registering`，`name` 为用户命名，register upsert 不覆盖；云电脑停止/删除后保留 Controller 行并置 `offline`；无字段新增 |
| `contracts/agent-controller-websocket.md` | 修改 | 增补「云电脑注册约定」：标准连接使用 `ControllerKey(type=cloud)` + `ZAG_HOST_KEY`；**不发送 `unregister`**；容器销毁由 agent-api 编排；`register.version` 上报 2.5.0；Controller 状态口径 |
| `contracts/cloud-controller-websocket.md` | 修改 | 内部 API `purpose=idle\|harness`；请求增 `hostId/refId/harnessTypes/hostName/expiresAt/agentGearMinVersion/secrets/workloadPlan`；响应增 `hostId/harnessTypes/controllerKeyId/containerApiKeyId/hostName/expiresAt`；`GET /internal/containers?hostId=`；`registered` 增可选 `initializing`；`workload:run` 增容器级 `env`（`ZAG_*`）与脱敏；Job env 明确 `ZAG_CONTROLLER_KEY`（`/worker` token）与 `ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT`（标准连接）；版本门禁按 purpose 分流 |
| `contracts/admin-billing.graphql` | 修改 | `BillingApiKeyScope { ACCOUNT CLOUD_HOST }`；`BillingApiKey` 增 `scope/cloudHostId/expiresAt`；`BillingApiCall` 增 `cloudHostId/billable`（内部模型/GraphQL 映射保持字段一致；admin-web 不消费） |
| `contracts/billing-openai.openapi.yaml` | 修改 | CLOUD_HOST Key：`expiresAt`/云电脑非 RUNNING/已撤销 → `401 invalid_api_key`；`/v1/models` 对 CLOUD_HOST Key 返回系统启用模型 + 用户启用模型（含自定义）；`/v1/chat/completions` 自定义模型代转发不记账（无计量/outbox），系统模型走既有计费 |

**不在本期改动**：`contracts/admin-cloud-container.graphql`（admin 启动维持仅 `IDLE`）、`contracts/admin-cloud-workload.graphql`、`contracts/home.graphql`（`Controller.cloudHost` 由 `cloud-host.graphql` 扩展）、`contracts/agent-session.graphql`（标准会话零改动；只读由云电脑状态判定）。
**二期新增（本期不建）**：`contracts/unified-storage.openapi.yaml`、`contracts/admin-unified-storage.graphql`、会话导入导出契约（会话 ↔ harness JSON）。

### 云电脑错误文案（服务端逐字）

| 条件 | 错误 |
|------|------|
| `HARNESS_ENABLED=false` 且调用 `createCloudHost` | `harness feature is disabled` |
| `name` trim 后为空 | `name is required` |
| `name` 超 64 字符 | `name is too long` |
| `harnessTypes` 去重后为空 | `at least one harness type is required` |
| `harnessTypes` 含白名单外值 | `unsupported harness type: <type>` |
| 存在 STARTING/RUNNING/STOPPING 云电脑再创建 | `too many cloud hosts` |
| `stopCloudHost` 有活动会话且 `force !== true` | `stopping this cloud host will permanently lose all active sessions` |
| `stopCloudHost` 已 STOPPED/FAILED | 幂等返回当前状态（不报错） |
| `deleteCloudHost` 非 STOPPED/FAILED | `stop the cloud host before deleting` |
| 控制面不可达（创建/停止/删除） | `control plane unavailable` |
| 计费服务不可达（创建） | `billing service unavailable` |
| 控制器/模型网关配置缺失 | `cloud host is not configured` |
| 非属主访问/停止/删除 | `Cloud host not found`（不泄露存在性） |
| 对非 RUNNING 云电脑创建会话 | `cloud host is not running` |
| 对已停止云电脑恢复会话 | `session is ended` |

### 默认会话与停止语义（契约级）

- **默认会话**：`createCloudHost` 收到 `harnessTypes` 去重后**恰好 1 项**时，服务端在云电脑 `RUNNING`（ready 回调）后自动创建一个使用该 harness 对应 ACP 的标准会话并写入 `defaultSessionId`；**≥2 项不创建**。默认会话创建失败不影响云电脑可用（`defaultSessionId=null`，前端提示可手动创建）。
- **停止语义**：`stopCloudHost` 成功后容器运行销毁；该云电脑下所有非 `ENDED` 会话批量置 `ENDED`（**只读**：消息留档保留可查看，无「继续会话」路径，本期无恢复手段）；运行专用模型 Key 撤销；`cloudhosts.status=STOPPED`（终态，**不可重新运行**）；`Controller` 记录保留（心跳超时转 offline），云电脑条目继续展示（会话只读回看）。**无 `startCloudHost`**。
- **删除语义**：仅 `STOPPED/FAILED`；软删除、Controller 保留、Key/ControllerKey 撤销；不删除会话/消息。

### 验收 checklist

- [ ] 6 份契约与提案 §3/§4 逐字段一致；本计划 §3 的修正项已体现
- [ ] `CloudHostStatus` 无 `ONLINE/OFFLINE/EXITED/DESTROYING` 等 v2.0 状态；无 `startCloudHost`
- [ ] `harnessTypes` 为数组、≥1 校验、单选默认会话/多选不创建写明
- [ ] `cloudHostStopImpact`/`stopCloudHost(force)`/`deleteCloudHost` 与错误文案逐字一致
- [ ] `BillingApiKey.scope/cloudHostId/expiresAt` 与计费网关分流写明
- [ ] `purpose=harness` 内部请求/响应字段、secrets 字段、`env` 清单、`initializing` 写明
- [ ] `agent-session.graphql`、admin 两份契约零改动
- [ ] 契约变更独立提交，未夹带实现代码

---

## Phase 2: admin-api CLOUD_HOST 模型 Key 与计费网关

开发分支：`servers/harness-support`。TDD 先写/扩展 `api-key-service.test.ts`、`billing-key-auth.test.ts`（新增）、`internal-billing.test.ts`（新增）、`billing-openai.test.ts`、`cloud-host-read-model.test.ts`（新增）、`reconciliation.test.ts` → RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/models/billing-api-key.ts` | 修改 | 增 `scope: 'account'\|'cloud_host'`（默认 account）、`cloudHostId`（index）、`expiresAt`（Date/null） |
| `servers/admin-api/src/models/billing-api-call.ts` | 修改 | 增 `cloudHostId`（index）、`billable`（默认 true） |
| `servers/admin-api/src/models/cloud-host.ts` | 新增 | **只读** `cloudhosts` 模型：`userId/status/controllerId/deletedAt`；只用于 Key 鉴权与对账，不写 |
| `servers/admin-api/src/services/billing/api-key-service.ts` | 修改 | `create` 接受可选 `scope/cloudHostId/expiresAt`；新增 `createCloudHostScopedKey`（同 cloudHostId 先幂等撤销旧 active Key）、`revokeById(id)`（内部幂等，不要求 owner）、`revokeByCloudHost(cloudHostId)`；`verify` 返回 `scope/cloudHostId/expiresAt` |
| `servers/admin-api/src/middleware/billing-key-auth.ts` | 修改 | `scope=cloud_host` 时校验 `expiresAt` 与只读 `cloudhosts` 状态（不存在/已删除/非 RUNNING → 401）；把 `scope/cloudHostId` 放进 `req.billing` |
| `servers/admin-api/src/routes/internal-billing.ts` | 修改 | `POST /api-keys` body 增 `scope/cloudHostId/expiresAt`（cloud_host 必填/校验日期）；新增 `POST /api-keys/:id/revoke`（内部 token，幂等，未知 404）；新增 `POST /api-keys/revoke-by-host`（按 cloudHostId 撤销全部 active，幂等） |
| `servers/admin-api/src/routes/billing-openai.ts` | 修改 | `/models`：cloud_host scope 返回 `global enabled` ∪ `user enabled`（含无 pricing 的自定义模型），account scope 维持现状；`/chat/completions`：先查 global，cloud_host scope 未命中再查 user；自定义模型不要求 pricing、不写计量/outbox，`BillingApiCall.billable=false,cost=0`；系统模型写入 `cloudHostId` |
| `servers/admin-api/src/graphql/schemas/billing.ts` | 修改 | `BillingApiKeyScope`、`BillingApiKey.scope/cloudHostId/expiresAt`、`BillingApiCall.cloudHostId/billable`（与契约对齐；admin-web 不消费新字段） |
| `servers/admin-api/src/graphql/resolvers/billing.ts` | 修改 | `toApiKeyWire`/`BillingApiCall` 映射新字段；既有 create/revoke mutation 不变（云电脑 Key 不经 admin GraphQL 创建） |
| `servers/admin-api/src/services/billing/reconciliation.ts` | 修改 | 新增 `cloud-host-keys` 对账：扫描 `scope=cloud_host,status=active` 且宿主处于非合法态（`STOPPING`/`STOPPED`/`FAILED`，**放行 `STARTING` 创建窗口**）/已删除/过期的 Key，幂等撤销并登记报告 |
| `servers/admin-api/src/index.ts` | 修改 | `syncIndexes` 覆盖新字段/新只读模型；对账注册（沿用 BillingScheduler 每日 cron） |
| `servers/admin-api/src/services/billing/api-key-service.test.ts` | 修改 | 云电脑 Key 铸造/过期/撤销/幂等/同宿主轮换 |
| `servers/admin-api/src/middleware/billing-key-auth.test.ts` | 新增 | 过期/宿主非 RUNNING/已删除/正常/账号 Key 回归 |
| `servers/admin-api/src/routes/internal-billing.test.ts` | 新增 | 内部鉴权、云电脑 Key 参数校验、按 ID/宿主撤销幂等/404 |
| `servers/admin-api/src/routes/billing-openai.test.ts` | 修改 | 云电脑模型列表、系统模型计费、自定义模型不记账、`cloudHostId` 归因 |
| `servers/admin-api/src/models/cloud-host.test.ts` | 新增 | 只读模型集合名/字段/不写 |

### 关键语义

```mermaid
sequenceDiagram
    participant AA as agent-api
    participant AD as admin-api
    participant M as Mongo
    participant W as worker(OpenCode)

    AA->>AD: POST /internal/billing/api-keys {scope:cloud_host, cloudHostId, expiresAt}
    AD->>M: billingapikeys（哈希；明文仅响应一次）
    AD-->>AA: {apiKey, secret}
    W->>AD: POST /v1/chat/completions (zag_sk_)
    AD->>AD: verify（前缀+bcrypt+expiresAt）
    AD->>M: cloudhosts.status（cloudHostId）
    alt 非 RUNNING/已删除/过期
        AD-->>W: 401 invalid_api_key
    else 系统模型
        AD->>AD: 既有定价/预检/计量/outbox
        AD-->>W: 正常响应
    else 自定义模型
        AD->>AD: 服务端代转发（无 pricing/无计量/无 outbox）
        AD-->>W: 正常响应
    end
```

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-BK1 | 账号 Key 回归 | `scope=account`、`expiresAt=null`；既有列表/撤销测试全绿 |
| T-BK2 | `createCloudHostScopedKey` | `scope=cloud_host`、`cloudHostId/expiresAt` 落库；明文仅返回一次；哈希可验证 |
| T-BK3 | 同宿主重复铸造 | 旧 active Key 被撤销，只剩新 Key；旧明文 401 |
| T-BK4 | `verify` 过期 | `expiresAt < now` → 401/抛错 |
| T-BK5 | 宿主终态 | `cloudhosts.status` 非 RUNNING / 不存在 / `deletedAt` 非空 → 401；创建窗口 STARTING 也拒绝（初始化不调模型） |
| T-BK6 | `revokeById` 幂等 | 重复撤销 200；未知 id 404；不要求 owner |
| T-BK7 | `revokeByCloudHost` | 同宿主多枚 active 全部撤销；重复调用幂等 |
| T-BK8 | 内部撤销鉴权 | 无/错误 `INTERNAL_API_TOKEN` → 401 |
| T-BK9 | 云电脑 `/v1/models` | 含 global enabled + user enabled（含 `isCustom=true`）；不含禁用模型 |
| T-BK10 | 账号 `/v1/models` 回归 | 仍只返回计费完整的 global 模型 |
| T-BK11 | 系统模型调用 | 产生 `BillingApiCall` + 计量/outbox，`cloudHostId` 落库，`billable=true` |
| T-BK12 | 自定义模型调用 | 代转发成功、无计量/outbox、`BillingApiCall.billable=false,cost=0` |
| T-BK13 | 自定义模型无 pricing | 正常转发（不因缺定价报 `model_not_priced`） |
| T-BK14 | 同名系统/自定义模型 | 系统模型优先，走计费 |
| T-BK15 | 禁用/不存在模型 | `404 model_not_found` |
| T-BK16 | Key 明文不落库/不进日志 | Mongo 无明文；错误日志/响应脱敏 |
| T-BK17 | 对账 `cloud-host-keys` | 宿主终态（`STOPPING/STOPPED/FAILED`）/过期/删除的 active Key 被撤销；`RUNNING` 与 `STARTING` 窗口保留 |
| T-BK18 | 账号 Key 行为不受影响 | 既有 billing-flow/预留/账单回归全绿 |

### 验收 checklist

- [ ] 云电脑 Key 有效期=容器 TTL；宿主非 RUNNING 立即 401；停止/删除显式撤销双保险
- [ ] 系统模型计费、自定义模型不记账；账号 Key 行为不变
- [ ] 内部铸造/撤销幂等、鉴权正确；明文不落库/不进日志
- [ ] `/v1/models` 与 agent-web 设置页口径一致（`scope=user ∪ global enabled`）
- [ ] 对账只撤销云电脑 Key，不误伤账号 Key
- [ ] 新增模块单测覆盖率 ≥80%

---

## Phase 3: admin-api 预置「OpenCode（Harness）」工作负载

开发分支：`servers/harness-support`。TDD 先写 `006-preset-harness-opencode.test.ts`（新增）→ RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/admin-api/src/models/cloud-workload.ts` | 修改 | 增 `workloadKind: 'standard'\|'harness'`（默认 `standard`，index）、`harnessType: 'opencode'\|null`（默认 null）；不新增 `optionsSource`（会话参数二期） |
| `servers/admin-api/src/migrations/006-preset-harness-opencode.ts` | 新增 | 写入 `name='OpenCode（Harness）'`、`presetKey='harness-opencode'`、`workloadKind='harness'`、`harnessType='opencode'`、`isPreset=true`、`paramSchema=[]`、仅 `initScript`、无 `dependsOnWorkloadIds`（Node/npm 已在镜像） |
| `servers/admin-api/src/migrations/006-preset-harness-opencode.test.ts` | 新增 | 幂等、已存在不覆盖、字段完整、`bash -n`、脚本顺序 |
| `servers/admin-api/src/index.ts` | 修改 | 注册 `006` 到迁移数组 |

### init 脚本（migration 内置，示意）

```bash
#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装（镜像未预装；仅命令缺失时安装，保证幂等）
OPENCODE_CLI_VERSION="${OPENCODE_CLI_VERSION:-2.1.1}"
if ! command -v opencode >/dev/null 2>&1; then
  npm install -g "@opencode/cli@${OPENCODE_CLI_VERSION}"
fi
opencode --version   # 硬校验：安装返回 0 但不可用视为失败

# 2) 默认工作区 + 模型配置注入（opencode.jsonc，custom provider）
mkdir -p "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"
agent-gear harness prepare
```

> 二期追加会话导入/导出时，在 `paramSchema` 与脚本尾部扩展；本期保持 `paramSchema=[]`，不引入 `optionsSource`/存储依赖。多 harness 时由 agent-api 按 `harnessTypes` 逐个展开 preset，每个 preset 各自一条 init 项（本期仅 1 条）。

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-MIG5-1 | 005 首次执行 | 写入第 5 个预制项；`workloadKind=harness`、`harnessType=opencode`、`paramSchema=[]`、无 post |
| T-MIG5-2 | 005 二次执行 | 跳过，不覆盖管理员修改 |
| T-MIG5-3 | presetKey/name 已存在 | 保留现有并打 warning，不重复创建 |
| T-MIG5-4 | 脚本语法 | `bash -n` 通过；含固定版本安装、`opencode --version`、`mkdir`、`agent-gear harness prepare` |
| T-MIG5-5 | 存量工作负载兼容 | 无新字段的文档读取为 `standard/null`；admin 既有 4 个预制项不变 |

### 验收 checklist

- [ ] `cloudworkloads` 新增字段对存量文档默认为 `standard/null`
- [ ] migration 005 幂等、脚本可执行、无 post/参数
- [ ] `admin-cloud-workload.graphql`/admin-web 零改动（本期不让后台展示/编辑 harness 字段）
- [ ] 既有 4 个预制工作负载与工作负载 CRUD 回归全绿

---

## Phase 4: agent-api 前台云电脑域

开发分支：`servers/harness-support`。TDD 先写 `cloud-host-service.test.ts`、`cloud-controller-client.test.ts`、`cloud-host.resolver.test.ts`、`internal-cloud-host.test.ts`、扩展 `session.test.ts`/`controller-key.test.ts`/`controller.test.ts`/`billing-client.test.ts` → RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/config/index.ts` | 修改 | `harnessEnabled`（`HARNESS_ENABLED`，`toBool`）、`cloudHostMaxPerUser`（1）、`harnessContainerTtlSeconds`（86400）、`controllerApiPublicEndpoint`、`cloudHostModelBaseUrl`、`cloudHostDefaultWorkspace`（`/root/workspace`） |
| `servers/agent-api/src/models/cloud-host.ts` | 新增 | `cloudhosts`：`userId/name/harnessTypes/status/controllerId/keyId/workspaceId/containerId/defaultSessionId/startedAt/readyAt/stoppedAt/failureReason/deletedAt`；`userId+status`、`controllerId` 索引 |
| `servers/agent-api/src/models/cloud-container.ts` | 新增 | **只读** `cloudcontainers`：`hostId/controllerKeyId/containerApiKeyId/userId/status/purpose/harnessTypes/expiresAt/hostName/exitReason/connectedAt/exitedAt/billingAccountId`；`hostId` 索引 |
| `servers/agent-api/src/models/cloud-workload.ts` | 新增 | **只读** `cloudworkloads`：`name/presetKey/workloadKind/harnessType/initScript/postScript/paramSchema/dependsOnWorkloadIds` |
| `servers/agent-api/src/services/cloud-workload-reader.ts` | 新增 | `findHarnessPreset(type)`：按 `presetKey='harness-opencode'`、`workloadKind='harness'`、`harnessType` 精确匹配；缺失抛 `harness workload preset not found: opencode`；返回只读定义 |
| `servers/agent-api/src/services/cloud-controller-client.ts` | 新增 | 原生 fetch + AbortController：`startHarness(input)`（`POST /internal/containers`）、`listContainers({hostId,userId})`（`GET /internal/containers?hostId=`）、`destroyContainer(id)`（`DELETE /internal/containers/:id`）；Bearer `INTERNAL_API_TOKEN`；错误映射 `control plane unavailable` |
| `servers/agent-api/src/services/cloud-host-service.ts` | 新增 | `getCapabilities`、`create`、`list`（排除 `deletedAt`）、`stopImpact`、`stop`、`delete`、`handleReady`、`handleTerminal`、`mapCloudHost`、`assertFeature`；创建编排/回滚；1 实例锁；状态机；默认会话编排 |
| `servers/agent-api/src/services/keyed-mutex.ts` | 新增 | 极简 `KeyedMutex`（按 userId 串行 create、按 hostId 串行 stop/delete）；可参考 admin-api 同名实现，避免新增依赖 |
| `servers/agent-api/src/services/controller-key.ts` | 修改 | 新增 `createForCloudHost(userId, controllerId, name)`：**不删除**未绑定 Key；写入 `boundControllerId`；返回 `rawKey`；保留既有 `create/delete/regenerate` |
| `servers/agent-api/src/services/controller.ts` | 修改 | 新增 `createCloudHostController`（`type=cloud/status=registering/hostname=name/version='0.0.0'`）、`markCloudHostOffline`、`findCloudHostsByUser`；`findAllByUser` 过滤软删除云电脑（`type=cloud && cloudhosts.deletedAt != null`）；保留 `unbind` 供本地主机使用 |
| `servers/agent-api/src/services/controller-workspace.ts` | 修改 | 新增 `ensureCloudHostWorkspace(controllerId,userId,path)`：幂等 upsert（默认 `workspace`），不触发 10 个工作区上限 |
| `servers/agent-api/src/services/session.ts` | 修改 | 新增 `endByController(controllerId,userId)`（`updateMany` 非 ENDED → ENDED + `endedAt`）；`create` 对 cloud Controller 校验 `CloudHost.status==='RUNNING'`；`resume` 对云电脑终态返回 `session is ended`；普通会话行为不变 |
| `servers/agent-api/src/services/billing-client.ts` | 修改 | 新增 `createCloudHostApiKey({accountId,ownerType,ownerId,name,cloudHostId,expiresAt})`、`revokeApiKeyById(id)`、`revokeApiKeysByHost(cloudHostId)`；wire DTO 增 `scope/cloudHostId/expiresAt` |
| `servers/agent-api/src/graphql/schemas/cloud-host.ts` | 新增 | 严格对齐 `contracts/cloud-host.graphql`；注册 `cloudHostTypeDefs` |
| `servers/agent-api/src/graphql/resolvers/cloud-host.ts` | 新增 | `Query.cloudHostCapabilities/myCloudHosts/cloudHostStopImpact`、`Mutation.createCloudHost/stopCloudHost/deleteCloudHost`、`Controller.cloudHost` 子字段 |
| `servers/agent-api/src/graphql/schemas/index.ts` / `resolvers/index.ts` | 修改 | 注册新 schema/resolver；`Controller` 合并 `cloudHost` |
| `servers/agent-api/src/routes/internal-cloud-host.ts` | 新增 | `POST /internal/cloud-hosts/:id/ready`、`POST /internal/cloud-hosts/:id/terminal`（Bearer `INTERNAL_API_TOKEN`）：幂等驱动 RUNNING/defaultSessionId 或 STOPPED/FAILED + 会话 ENDED；未知 host 404；非 harness 404 |
| `servers/agent-api/src/index.ts` | 修改 | 挂载 `/internal/cloud-hosts`（在 `express.json()` 之后即可，无二进制） |
| 对应 `*.test.ts` | 新增/修改 | 见测试矩阵 |

### 创建流程

```mermaid
sequenceDiagram
    participant AW as agent-web
    participant AA as agent-api
    participant AD as admin-api
    participant CC as cloud-controller
    participant M as Mongo

    AW->>AA: createCloudHost{name, harnessTypes:[…]}
    AA->>AA: HARNESS_ENABLED / name / harnessTypes≥1 / 1 实例锁
    AA->>AA: 读 harness preset（cloudworkloads）
    AA->>AD: getAccount(front_user, userId)
    AA->>M: 预生成 cloudHostId/controllerId
    AA->>M: ControllerKey(type=cloud, boundControllerId)
    AA->>M: Controller(type=cloud, registering, name)
    AA->>M: ControllerWorkspace(workspace, /root/workspace)
    AA->>M: CloudHost(STARTING, workspaceId)
    AA->>AD: createCloudHostApiKey(scope=cloud_host, cloudHostId, expiresAt)
    AA->>CC: POST /internal/containers {purpose:harness, hostId, refId, harnessTypes, workloadPlan, billingAccountId, expiresAt, secrets, agentGearMinVersion:2.5.0}
    alt 失败
        AA->>AD: revokeApiKeyById / revokeApiKeysByHost
        AA->>M: 删除 workspace/Controller/ControllerKey/CloudHost + evict
        AA-->>AW: GraphQLError（control plane unavailable 等）
    else 成功
        AA->>M: CloudHost.containerId = 容器 ID
        AA-->>AW: CloudHost(STARTING)
    end
```

- `secrets`：`hostEndpoint`（`CONTROLLER_API_PUBLIC_WS_ENDPOINT`）、`hostKey`（raw `zag_k_1_...`）、`modelApiKey`（`zag_sk_...`）、`modelBaseUrl`（`CLOUD_HOST_MODEL_BASE_URL`）、`modelIds`（JSON 数组）、`defaultWorkspace`（`CLOUD_HOST_DEFAULT_WORKSPACE`）；仅随创建请求存在。
- `workloadPlan`：按 `harnessTypes` 顺序逐个 `[{workloadId: preset.id, params: {}, implicit: false, required: true}]`；本期仅 1 条。
- 失败回滚使用 `Promise.allSettled` 逐项 best-effort，但原始错误优先；回滚失败记日志（由 TTL/人工兜底）。

### 停止/删除/回调流程

```mermaid
sequenceDiagram
    participant AW as agent-web
    participant AA as agent-api
    participant CC as cloud-controller
    participant AD as admin-api

    AW->>AA: cloudHostStopImpact(id)
    AA-->>AW: {activeSessionCount, sessionsWillBeLost, sessions[]}
    alt 有活动会话且用户未确认
        AW->>AW: 弹窗「停止云主机会导致所有会话永久丢失，是否继续」
    end
    AW->>AA: stopCloudHost(id, force)
    AA->>AA: 服务端校验：活动会话>0 且 force!==true → 拒绝
    AA->>AA: status=STOPPING
    AA->>AA: updateMany(sessions → ENDED)
    AA->>CC: DELETE /internal/containers/:id
    CC-->>AA: destroyed
    AA->>AD: revoke-by-host（幂等）
    AA->>AA: status=STOPPED, stoppedAt, containerId=null
    AA-->>AW: CloudHost(STOPPED)——无再次启动入口，会话只读
```

```mermaid
sequenceDiagram
    participant CC as cloud-controller
    participant AA as agent-api
    participant AD as admin-api

    CC->>AA: POST /internal/cloud-hosts/:id/ready
    AA->>AA: STARTING→RUNNING, readyAt
    alt harnessTypes 恰好 1 项且 defaultSessionId 为空
        AA->>AA: 走既有 createSession（默认工作区）→ defaultSessionId
    end
    AA-->>CC: 200（幂等）

    CC->>AA: POST /internal/cloud-hosts/:id/terminal {status,reason}
    AA->>AA: RUNNING/STARTING/STOPPING→STOPPED 或 FAILED
    AA->>AA: updateMany(sessions → ENDED)
    AA->>AD: revoke-by-host（幂等）
    AA-->>CC: 200（幂等）
```

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-CH1 | `cloudHostCapabilities` 开关开+preset 存在 | `{enabled:true,supportedHarnesses:[OPENCODE]}` |
| T-CH2 | 开关关 | `{enabled:false,supportedHarnesses:[]}`；create 抛 `harness feature is disabled` |
| T-CH3 | 名称为空/空白/超长 | `name is required` / `name is too long`，不写任何记录 |
| T-CH4 | `harnessTypes` 为空/白名单外 | `at least one harness type is required` / `unsupported harness type: <type>` |
| T-CH5 | 1 实例上限 | 已有 STARTING/RUNNING/STOPPING → `too many cloud hosts`；STOPPED/FAILED/已删除不阻塞 |
| T-CH6 | 并发创建双开 | per-user 锁串行，最多 1 条成功 |
| T-CH7 | 创建成功 | Controller `type=cloud/status=registering/name=用户命名`；ControllerKey `type=cloud/boundControllerId=controllerId`；默认工作区路径正确；cloud-controller 请求体 `purpose=harness`、`hostId`、`harnessTypes`、plan 每项 `required=true`、`agentGearMinVersion=2.5.0`、secrets 齐全 |
| T-CH8 | 模型 Key 铸造失败 | 不调用 cloud-controller；不留下 Controller/Key/工作区/CloudHost |
| T-CH9 | cloud-controller 失败 | 撤销模型 Key；删除 Controller/Key/工作区/CloudHost 并 evict；GraphQL 报错 |
| T-CH10 | `myCloudHosts` 映射 | STARTING/RUNNING/STOPPING/STOPPED/FAILED 与裁决 B4 一致；`readyAt/stoppedAt/failureReason` 正确；不返回软删除 |
| T-CH11 | 属主隔离 | 用户 B 的 `myCloudHosts` 不含用户 A；B 停止/删除 A → `Cloud host not found` |
| T-CH12 | `cloudHostStopImpact` | 活动会话数/摘要正确；无活动会话 `sessionsWillBeLost=false` |
| T-CH13 | 停止有活动会话无 force | 抛 `stopping this cloud host will permanently lose all active sessions`；状态不变 |
| T-CH14 | 停止成功 | 先 ENDED 会话→销毁容器→撤销 Key→STOPPED；`containerId=null`；无 `startCloudHost` |
| T-CH15 | 停止幂等 | 已 STOPPED/FAILED 再次调用返回当前状态；不重复销毁 |
| T-CH16 | 停止控制面失败 | 状态保持 STOPPING；会话已 ENDED；抛 `control plane unavailable`；重试可继续 |
| T-CH17 | 删除约束 | 运行中/停止中抛 `stop the cloud host before deleting`；STOPPED/FAILED 成功；重复删除幂等 |
| T-CH18 | 删除留档 | ControllerKey 删除 + evict；Controller 保留 `offline`；CloudHost `deletedAt`；会话/消息保留；列表不再展示 |
| T-CH19 | ready 回调 | STARTING→RUNNING；单 harness 建默认会话并写 `defaultSessionId`；重复回调不重复建 |
| T-CH20 | ready 默认会话失败 | 云电脑仍 RUNNING；`defaultSessionId=null`；记录 warning |
| T-CH21 | ready 多 harness | ≥2 不创建默认会话 |
| T-CH22 | terminal 回调 | RUNNING→STOPPED/FAILED；批量 ENDED；撤销 Key；重复回调幂等 |
| T-CH23 | 会话创建守卫 | 非 RUNNING 云电脑 createSession → `cloud host is not running`；普通主机不受影响 |
| T-CH24 | 会话 resume 守卫 | 已停止云电脑会话 resume → `session is ended`；普通 ended 会话仍可 resume |
| T-CH25 | `Controller.cloudHost` | local 主机返回 null；cloud 主机返回最新映射；软删除返回 null |
| T-CH26 | 不删除未绑定 Key | 用户已有未绑定 local Key，创建云电脑后该 Key 仍存在 |
| T-CH27 | 配置缺失 | 缺 `CONTROLLER_API_PUBLIC_WS_ENDPOINT`/`CLOUD_HOST_MODEL_BASE_URL` → `cloud host is not configured`，不写记录 |
| T-CH28 | GraphQL 鉴权 | 未登录全部入口报 `Not authenticated` |

### 验收 checklist

- [ ] 前台可命名创建云电脑；名称/harness/开关/1 实例/配置错误文案齐全
- [ ] Controller 预创建、用户命名不被 register 覆盖、Key 不出现在未绑定 Key 列表
- [ ] 默认工作区随创建预置，路径与 worker `ZAG_DEFAULT_WORKSPACE` 一致
- [ ] 创建失败全量回滚；停止/删除幂等且留档
- [ ] 单 harness 默认会话、多 harness 不创建、失败不回滚
- [ ] 停止后会话只读（resume 拒绝）、普通会话不受影响
- [ ] ready/terminal 回调幂等；`Controller.cloudHost` 与 `myCloudHosts` 状态一致
- [ ] 新增模块单测覆盖率 ≥80%

---

## Phase 5: cloud-controller（purpose=harness / secrets / env / 门禁 / 回调）

开发分支：`servers/harness-support`。TDD 先写/扩展 `internal-api.test.ts`、`container-service.test.ts`、`workload-dispatcher.test.ts`、`worker-version.test.ts`、`socketio-gateway.test.ts`、`k8s-job-manager.test.ts`、`secret-store.test.ts`、`agent-api-client.test.ts`、`admin-billing-client.test.ts` → RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/cloud-controller/src/models/cloud-container.ts` | 修改 | `CONTAINER_PURPOSES` 增 `harness`；schema 增 `hostId/controllerKeyId/containerApiKeyId/hostName/harnessTypes/expiresAt` |
| `servers/cloud-controller/src/repositories/container-repository.ts` | 修改 | `CloudContainerEntity`/`CreateContainerInput`/`UpdateContainerInput` 同步新字段；Mongo 映射 |
| `servers/cloud-controller/src/config/index.ts` | 修改 | `MIN_HARNESS_WORKER_VERSION='2.5.0'`（代码常量）、`AGENT_API_URL`（回调用，可空）、`AGENT_API_TIMEOUT_MS`、`ADMIN_API_URL`（撤销用，可空） |
| `servers/cloud-controller/src/routes/internal-api.ts` | 修改 | `purpose` 白名单 `idle\|harness`；harness 校验 `hostId/refId/harnessTypes/hostName/expiresAt/agentGearMinVersion/secrets/workloadPlan`；**把 `purpose` 变量传给 `containerService.start`（移除硬编码 `'idle'`）**；`GET /containers?hostId=`/`?userId=` 过滤；响应增新字段（不含 secrets） |
| `servers/cloud-controller/src/services/container-service.ts` | 修改 | `start` 接收 `StartHarnessOptions`（purpose/hostId/hostName/harnessTypes/controllerKeyId/containerApiKeyId/expiresAt/secrets）；落库；`expiresAt` 传给 job manager；secretStore 写入；终态删除 secret；`onDestroyed` 回调 |
| `servers/cloud-controller/src/services/secret-store.ts` | 新增 | `Map<containerId, HarnessSecrets>`：`put/get/delete`；测试可注入；不落库/不打日志 |
| `servers/cloud-controller/src/services/agent-api-client.ts` | 新增 | `POST /internal/cloud-hosts/:hostId/ready`、`POST /internal/cloud-hosts/:hostId/terminal`（Bearer `INTERNAL_API_TOKEN`）；超时/错误映射；日志不打印 secret |
| `servers/cloud-controller/src/services/admin-billing-client.ts` | 新增 | `POST /internal/billing/api-keys/revoke-by-host`（Bearer `INTERNAL_API_TOKEN`）；幂等；失败只告警 |
| `servers/cloud-controller/src/services/workload-dispatcher.ts` | 修改 | `workload:run` payload 增 `env`；`buildHarnessEnv(container)` → 仅 harness 下发；日志不打印 env 值；idle 不携带 `env` |
| `servers/cloud-controller/src/services/socketio-gateway.ts` | 修改 | `register` 读取容器 `purpose`，按 purpose 选择版本门禁；`registered` 增 `initializing`（`hasInitScripts` 结果）；拒绝路径先于全部副作用 |
| `servers/cloud-controller/src/services/worker-version.ts` | 修改 | 保留 `MIN_WORKER_VERSION='2.2.0'`；新增 `MIN_HARNESS_WORKER_VERSION='2.5.0'`、`isSupportedHarnessWorkerVersion` |
| `servers/cloud-controller/src/services/k8s-job-manager.ts` | 修改 | `CreateJobInput` 增 `activeDeadlineSeconds?`、`env?: Record<string,string>`；harness Job env 追加 `ZAG_HOST_ENDPOINT/ZAG_HOST_KEY/ZAG_HOST_NAME/ZAG_HARNESS_TYPES/ZAG_DEFAULT_WORKSPACE/ZAG_USER_TYPE/ZAG_USER_ID`；`ZAG_CONTROLLER_KEY` 仍为一次性 token；idle 保持现状 |
| `servers/cloud-controller/src/index.ts` | 修改 | 注入 `secretStore`/`agentApiClient`/`adminBillingClient`；`onReady`/`onDestroyed` 钩子内按 purpose 回调；启动时读取 `AGENT_API_URL`/`ADMIN_API_URL` |
| `servers/cloud-controller/AGENTS.md` | 修改 | 更新 purpose、env、版本门禁、secret、初始化就绪、回调口径 |
| 对应 `*.test.ts` | 修改/新增 | 见测试矩阵 |

### `workload:run` env 清单（仅 harness）

```jsonc
{
  "phase": "init",
  "env": {
    "ZAG_HARNESS_TYPES": "opencode",
    "ZAG_CONTAINER_ID": "…",
    "ZAG_HOST_ID": "<cloudHostId>",
    "ZAG_HOST_NAME": "<用户命名>",
    "ZAG_HOST_ENDPOINT": "wss://<controller-api>",
    "ZAG_HOST_KEY": "zag_k_1_…",
    "ZAG_DEFAULT_WORKSPACE": "/root/workspace",
    "ZAG_USER_TYPE": "front_user",
    "ZAG_USER_ID": "<前台用户 ID>",
    "ZAG_MODEL_API_KEY": "zag_sk_…",
    "ZAG_MODEL_BASE_URL": "http://admin-api:8002/v1",
    "ZAG_MODEL_IDS": "[\"model-a\",\"model-b\"]"
  },
  "items": [/* 既有结构；本期 harness preset 仅 1 条 */]
}
```

- env 仅随下发报文存在；worker 内存持有；`ZAG_MODEL_API_KEY`/`ZAG_HOST_KEY`/`ZAG_CONTROLLER_KEY` 在 worker 日志与错误消息中脱敏为 `***`。
- 普通容器 `env` 字段缺省，行为不变。

### Job env（harness）

```jsonc
{
  "ZAG_SERVER_ENDPOINT": "wss://<cloud-controller>/worker",
  "ZAG_CONTROLLER_KEY": "<一次性容器 token>",
  "ZAG_HOST_ENDPOINT": "wss://<controller-api>",
  "ZAG_HOST_KEY": "zag_k_1_…",
  "ZAG_HOST_NAME": "<用户命名>",
  "ZAG_HARNESS_TYPES": "opencode",
  "ZAG_DEFAULT_WORKSPACE": "/root/workspace",
  "ZAG_USER_TYPE": "front_user",
  "ZAG_USER_ID": "<前台用户 ID>"
}
```

> idle 保持 `{ZAG_SERVER_ENDPOINT, ZAG_CONTROLLER_KEY=<token>}` 不变；harness 的 `ZAG_CONTROLLER_KEY` 仍是 `/worker` token，标准连接用 `ZAG_HOST_KEY`。

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-CC1 | `purpose=idle` 回归 | 行为/响应字段兼容；Job env 仍为旧两项 |
| T-CC2 | `purpose=harness` 创建 | 落库 `hostId/controllerKeyId/containerApiKeyId/hostName/harnessTypes/expiresAt`；Job `activeDeadlineSeconds` 由 `expiresAt` 计算 |
| T-CC3 | purpose 字面量修复 | `containerService.start` 收到 `harness` 而非 `idle`（spy 断言） |
| T-CC4 | 未开放 purpose | `admin-task/workflow/session` 仍 400 `UNSUPPORTED_PURPOSE` |
| T-CC5 | harness 缺字段/secrets | 400 `INVALID_HARNESS`；不创建 Job |
| T-CC6 | secrets 不落库/不返回 | Mongo 文档/响应无明文；日志无明文 |
| T-CC7 | harness Job env | 含 `ZAG_CONTROLLER_KEY`（token）`ZAG_HOST_ENDPOINT/ZAG_HOST_KEY/ZAG_HOST_NAME/ZAG_HARNESS_TYPES/ZAG_DEFAULT_WORKSPACE`；不含模型 Key（模型 Key 走 workload env） |
| T-CC8 | idle Job env | 仅 `ZAG_SERVER_ENDPOINT/ZAG_CONTROLLER_KEY`；无 `env` 扩展 |
| T-CC9 | harness 版本门禁 | 2.4.0 拒绝 `VERSION_MISMATCH`；2.5.0/2.6.0 通过；idle 2.2.0 通过 |
| T-CC10 | 门禁先于副作用 | 拒绝时未写 `registered/connectedAt`、未启动 init、未 markOnline |
| T-CC11 | `registered.initializing` | 有 init → true；无 init → false/缺省 |
| T-CC12 | workload env 注入 | init 批次 `env` 含全部 `ZAG_*`（含 `ZAG_HOST_KEY`/`ZAG_MODEL_API_KEY`）；普通容器无 `env` |
| T-CC13 | secret 缺失 | dispatcher 读取失败 → init 失败且不 online；不打印 secret |
| T-CC14 | 销毁 harness | 删除 Job、终态 exited、secretStore 清理；无 post 批次 |
| T-CC15 | 列表按 hostId/userId | 只返回匹配容器；无参数保持全量（admin 兼容） |
| T-CC16 | 响应字段 | 含 `hostId/harnessTypes/controllerKeyId/containerApiKeyId/hostName/expiresAt`；不含 secret |
| T-CC17 | 历史容器兼容 | 无新字段的旧记录读取/销毁正常；purpose 缺省按 idle |
| T-CC18 | 普通容器门禁回归 | `MIN_WORKER_VERSION` 仍 2.2.0；2.2.0 worker 正常 |
| T-CC19 | ready 回调 | `onReady` 首次 online 调 agent-api ready；重复 online 不重复；失败只告警 |
| T-CC20 | terminal 回调 | `onDestroyed` 调 agent-api terminal + admin revoke-by-host；失败只告警；幂等 |
| T-CC21 | 回调鉴权/超时 | `INTERNAL_API_TOKEN` 正确；超时不阻塞容器生命周期 |
| T-CC22 | TTL 到期 | `activeDeadlineSeconds` 与 `expiresAt` 一致；最小 60s；缺省 86400 |

### 验收 checklist

- [ ] purpose=harness 全链路（创建 → 初始化 → 就绪 → 终态）单测覆盖
- [ ] secrets 仅内存、不落库、不进日志
- [ ] 版本门禁只影响 harness 容器；普通容器仍兼容 2.2.0+
- [ ] Job env 与 contract/agent-gear 实现一致；idle 零变化
- [ ] `registered.initializing` 使 agent-gear 可在 init 完成后再上线
- [ ] ready/terminal 回调驱动 agent-api 状态、默认会话与会话只读化
- [ ] 历史容器与 idle 回归全绿

---

## Phase 6: agent-gear 2.5.0（云电脑双连接 + harness prepare）

开发分支：`packages/harness-support`。TDD 先写 `cloud-host/supervisor.test.ts`、`harness/*.test.ts`、扩展 `socketio-client.test.ts`/`workload-executor.test.ts` → RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/package.json` / lock | 修改 | 版本 `2.5.0`；新增 `jsonc-parser` |
| `packages/agent-controller/src/index.ts` | 修改 | 默认 action 检测云电脑模式（`ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY` + `ZAG_CONTROLLER_KEY`）→ `startCloudHostSupervisor`；否则保持单连接旧路径；注册 `harness` 命令组 |
| `packages/agent-controller/src/cloud-host/supervisor.ts` | 新增 | 双连接编排：先 `/worker`（`ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT`），`initializing=true` 时等待 init 批次完成再连 controller-api（`ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT`）；`mkdir -p ZAG_DEFAULT_WORKSPACE`；任一端 `shutdown` 统一退出；**不发 `unregister`** |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | `CONTROLLER_VERSION='2.5.0'`；`connectToServer` 增 `options`：`handshakeToken?: string \| false`、`onRegistered?`、`onWorkloadBatchComplete?`、`skipLocalMcpStart?`；`workload:run` 完成后回调；日志脱敏 |
| `packages/agent-controller/src/workload-executor.ts` | 修改 | `WorkloadRunPayload` 增 `env?: Record<string,string>`；`runBatch` 合并容器 env（item `WORKLOAD_PARAM_*` 优先）；`redactSecrets` 对 secret 值脱敏；批次完成回调 |
| `packages/agent-controller/src/harness/env.ts` | 新增 | `readHarnessEnv()`：校验 `ZAG_MODEL_BASE_URL/ZAG_MODEL_API_KEY/ZAG_MODEL_IDS/ZAG_DEFAULT_WORKSPACE`；解析 JSON 数组；缺失项明确报错 |
| `packages/agent-controller/src/harness/opencode-cli.ts` | 新增 | `opencode --version` 硬校验；`opencode -v` 兼容探测；错误包装 |
| `packages/agent-controller/src/harness/opencode-config.ts` | 新增 | 定位/合并 `opencode.jsonc`（存在 `.json` 时合并 `.json`）；`jsonc-parser` 保留注释；写 `provider.zag`；权限 0600 |
| `packages/agent-controller/src/harness/prepare.ts` | 新增 | 校验 env → `opencode --version` → 写配置 → 汇总；secret 不打印 |
| `packages/agent-controller/src/commands/harness.ts` | 新增 | `agent-gear harness prepare` 子命令；错误非零退出；`--help` |
| `packages/agent-controller/AGENTS.md` | 修改 | 版本 2.5.0、云电脑模式、harness 命令、env 注入、脱敏、OpenCode 配置约定 |
| 对应 `*.test.ts` | 新增/修改 | 见测试矩阵 |

### 云电脑模式状态机

```mermaid
stateDiagram-v2
    [*] --> Worker连接: ① /worker（ZAG_CONTROLLER_KEY）
    Worker连接 --> 初始化: registered(initializing=true) → workload:run(init)
    Worker连接 --> 标准连接: registered(initializing=false)
    初始化 --> 标准连接: 批次完成（成功/失败）
    初始化 --> 退出: shutdown（required 失败强制注销）
    标准连接 --> 会话服务: register key=ZAG_HOST_KEY / heartbeat / acp:*
    标准连接 --> 退出: shutdown / 进程信号
    退出 --> [*]: 不发送 unregister
```

### prepare 行为

```mermaid
flowchart TD
    A[agent-gear harness prepare] --> B{env 完整?}
    B -->|否| X[非零退出 + 明确缺失项]
    B -->|是| C[opencode --version 硬校验]
    C --> D[解析 ZAG_MODEL_IDS JSON 数组]
    D --> E[写/合并 opencode.jsonc 的 provider.zag]
    E --> F[chmod 0600]
    F --> G[输出汇总，不含 secret]
```

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-AG1 | 版本注册 | `register.version='2.5.0'`；`package.json` 同步；既有版本断言更新 |
| T-AG2 | 模式检测 | 同时有 `ZAG_HOST_ENDPOINT/ZAG_HOST_KEY/ZAG_CONTROLLER_KEY` → 云电脑 supervisor；否则旧单连接 |
| T-AG3 | 双连接启动顺序 | 先 worker；`initializing=false` 立即连 controller；`true` 等 init 批次 |
| T-AG4 | init 等待 | 批次完成（成功/失败）后连接；等待超时仍连接并记录 |
| T-AG5 | 不发 unregister | 进程退出/信号/`shutdown` 均不 emit `unregister` |
| T-AG6 | 默认工作区 | 启动时创建 `ZAG_DEFAULT_WORKSPACE`；已存在幂等 |
| T-AG7 | env 缺失 | 明确缺失项，非零；不泄漏其它 env |
| T-AG8 | `opencode --version` 失败 | 非零；错误含版本校验提示 |
| T-AG9 | 配置新建 | 生成 `.jsonc`，`provider.zag` 含 baseURL/apiKey/models；权限 0600 |
| T-AG10 | 配置合并 | 保留既有 provider/注释；只替换 `provider.zag` |
| T-AG11 | 模型列表 | JSON 数组去空/去重；空数组仍写 `models:{}` |
| T-AG12 | 配置候选 | 仅有 `opencode.json` 时合并该文件而非另建 `.jsonc` |
| T-AG13 | secret 脱敏 | 脚本输出/错误含 secret → 日志替换为 `***` |
| T-AG14 | workload env 合并 | 容器 `ZAG_*` 注入所有 item；`WORKLOAD_PARAM_*` 同名优先；普通容器行为不变 |
| T-AG15 | CLI 注册 | `agent-gear harness --help` 展示 prepare；未知子命令非零 |
| T-AG16 | 标准连接握手 | controller-api 连接不把 `ZAG_HOST_KEY` 放进 URL/query；worker 连接使用 `auth.token=ZAG_CONTROLLER_KEY` |
| T-AG17 | 双端 shutdown | 任一 socket 收到 shutdown → 关闭两端并退出 0；post 批次等待逻辑保留 |
| T-AG18 | 本地 MCP 单例 | 双连接只启动一个 local MCP server，不端口冲突 |
| T-AG19 | 单连接回归 | 普通本地控制器（仅 `ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT`）行为/日志不变 |

### 验收 checklist

- [ ] `agent-gear@2.5.0` 构建通过；云电脑模式与旧模式互不影响
- [ ] 双连接/init 等待/不发 unregister 有单测
- [ ] `harness prepare` 新建/合并不破坏用户配置，secret 不出现在日志/错误
- [ ] 普通 agent-gear（本地控制器）回归全绿

---

## Phase 7: worker 镜像与 Aspire/K8s 编排

开发分支：`packages/harness-support`。先改 `BUILD.md` 校验项，再改 Dockerfile/编排，最后跑镜像自验。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `deploy/images/worker/Dockerfile` | 修改 | `agent-gear@2.5.x`（替代 2.4.x）；保留 ACP 两包；**不安装 `@opencode/cli`**；注释说明 OpenCode 由 harness 工作负载安装 |
| `deploy/images/worker/BUILD.md` | 修改 | 删除「7 包」错误清单；实际包清单；`agent-gear --version >=2.5.0`、`agent-gear harness --help`；`opencode --version` 改为「harness 工作负载初始化后」自验；`OPENCODE_CLI_VERSION` 锁定说明 |
| `deploy/images/worker/entrypoint.sh` | 修改（注释） | 说明 `ZAG_CONTROLLER_KEY` 为 `/worker` 一次性 token；harness 标准连接为 `ZAG_HOST_KEY`/`ZAG_HOST_ENDPOINT`；运行逻辑不变 |
| `aspire/AgentGear.AppHost/AppHost.cs` | 修改 | agent-api 注入 `HARNESS_ENABLED`（dev true、publish 参数默认 false）、`CLOUD_HOST_MAX_PER_USER=1`、`HARNESS_CONTAINER_TTL_SECONDS`、`CONTROLLER_API_PUBLIC_WS_ENDPOINT`、`CLOUD_HOST_MODEL_BASE_URL`、`CLOUD_HOST_DEFAULT_WORKSPACE`；cloud-controller 注入 `AGENT_API_URL`、`AGENT_API_TIMEOUT_MS`、`ADMIN_API_URL`；不新增容器资源 |
| `aspire/manifest/docker-compose.yaml` | 重新生成 | `aspire publish -o aspire/manifest`；追加新 env；不手工编辑 |
| `deploy/k8s/cloud-controller.yaml` | 修改 | 增 `AGENT_API_URL`、`AGENT_API_TIMEOUT_MS`、`ADMIN_API_URL`；worker 镜像 tag 说明；不包含真实 secret |
| `aspire/AgentGear.AppHost/AGENTS.md` | 修改 | 更新 env 清单 |

### 测试/自验

| # | 用例 | 预期 |
|---|------|------|
| T-IMG1 | Dockerfile 静态检查 | 含 `agent-gear@2.5.x`；不含 `@opencode/cli` 预装；无硬编码公网 registry |
| T-IMG2 | 镜像内 `agent-gear --version` | ≥2.5.0 |
| T-IMG3 | 镜像内 `agent-gear harness --help` | 可见 prepare |
| T-IMG4 | 镜像自验 | `opencode --version` 在镜像内可失败（未安装）不阻断；BUILD.md 提供 harness 工作负载后的自验步骤 |
| T-IMG5 | Aspire 本地 | agent-api `/health` 正常；cloud-controller 正常；无新增资源 |
| T-IMG6 | Compose 发布 | `docker compose config` 通过；env 注入正确 |
| T-IMG7 | K8s manifest | YAML 合法；`AGENT_API_URL`/`ADMIN_API_URL` 指向可达内部服务 |
| T-IMG8 | idle 回归 | 用旧镜像/旧 env 启动 idle 容器，行为不变 |

### 验收 checklist

- [ ] worker 镜像可构建、agent-gear 版本满足 harness 门禁
- [ ] BUILD.md 与实际 Dockerfile 一致，软校验改硬校验（在 harness init 内）
- [ ] Aspire/Compose 本地可启动；publish 默认关闭 harness
- [ ] K8s env 示例完整，不含真实 secret

---

## Phase 8: agent-web 云电脑体验

开发分支：`apps/harness-support`。TDD 先写/改 `Sidebar.test.tsx`、`ControllerConfigPage.test.tsx`、新增 `NewCloudHostDialog.test.tsx`、`StopCloudHostDialog.test.tsx`、`DeleteCloudHostDialog.test.tsx`、`SessionPage.test.tsx` → RED。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/types.ts` | 修改 | `HarnessType`、`CloudHostStatus`、`CloudHostData`、`CloudHostCapabilitiesData`、`CloudHostStopImpactData`、`CreateCloudHostMutation`、`StopCloudHostMutation`、`DeleteCloudHostMutation`；`ControllerData` 增 `cloudHost?: CloudHostData \| null` |
| `apps/agent-web/src/graphql/home.ts` | 修改 | `HOME_OVERVIEW.controllers` 增 `cloudHost { id name status harnessTypes defaultSessionId activeSessionCount failureReason deletedAt }` |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | `GET_CONTROLLERS` 增 `cloudHost { ... }`；新增 `CLOUD_HOST_CAPABILITIES`、`MY_CLOUD_HOSTS`、`CLOUD_HOST_STOP_IMPACT` |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `CREATE_CLOUD_HOST`、`STOP_CLOUD_HOST`、`DELETE_CLOUD_HOST` |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 主机列表标题行新增「新建云电脑」入口（capabilities.enabled 且无活跃云电脑时可用）；`type==='cloud'` 渲染 `Cloud` 图标；状态映射「启动中/运行中/停止中/已销毁/失败」；已销毁条目仍可点入只读回看；普通主机展示不变；新建成功后 `refetch` + 进入主机页 |
| `apps/agent-web/src/components/cloud-host/NewCloudHostDialog.tsx` | 新增 | 名称（必填，trim 1~64）、harness 多选（≥1，一期 OpenCode）、默认会话提示（选 1 个将自动创建会话）、实例上限禁用态、错误映射；无存储/会话导入参数 |
| `apps/agent-web/src/components/cloud-host/StopCloudHostDialog.tsx` | 新增 | 打开时拉 `cloudHostStopImpact`；有活动会话时展示「停止云主机会导致所有会话永久丢失，是否继续」；确认调用 `stopCloudHost(id, force:true)`；无活动会话直接停止 |
| `apps/agent-web/src/components/cloud-host/DeleteCloudHostDialog.tsx` | 新增 | 仅 STOPPED/FAILED 可删除；二次确认；删除后列表移除 |
| `apps/agent-web/src/pages/ControllerConfigPage.tsx` | 修改 | `type==='cloud'` 时展示云电脑状态/失败原因/活动会话数/停止/删除按钮；工作区 + Harness 工具两栏与普通主机完全一致；普通主机不显示停止/删除 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | 云电脑 `STOPPED/FAILED/deletedAt` 时只读：隐藏输入框/发送/继续/恢复入口，保留历史消息；普通会话不变 |
| `apps/agent-web/src/components/session/NewSessionDialog.tsx` | 修改 | 云电脑仅 RUNNING 可选；STOPPED/FAILED 不出现新建会话入口（或禁用并提示）；普通主机不变 |
| 对应 `__tests__` | 新增/修改 | 见测试矩阵 |
| `apps/agent-web/AGENTS.md` | 修改 | 云电脑入口、云图标、状态映射、只读规则、测试清单 |

### 交互要点

- **入口**：Sidebar 主机列表标题行右侧 `Cloud +` 按钮，`aria-label="新建云电脑"`；`cloudHostCapabilities.enabled=false` 时隐藏；存在 STARTING/RUNNING/STOPPING 云电脑时禁用并提示「每用户同时最多 1 个云电脑实例」。
- **云图标**：`type==='cloud'` 时在主机名前渲染 `Cloud` 图标（`data-testid="cloud-host-icon"`）；普通主机保持现状。
- **状态**：`STARTING` →「启动中」；`RUNNING` →「运行中」；`STOPPING` →「停止中」；`STOPPED` →「已销毁」；`FAILED` →「失败」+ 原因。状态点颜色沿用 Sidebar 现有规则；已销毁条目置灰但仍可进入只读会话。
- **主机界面**：点击设置进入 `/settings?controllerId=`，工作区/Harness 工具两栏与普通主机一致；云电脑无额外差异（PRD「界面完全一致」）。
- **停止**：配置页/主机菜单显示停止按钮；打开时拉 impact；有活动会话必须弹窗确认，确认传 `force:true`；成功后状态「已销毁」、不显示再次启动。
- **删除**：仅 STOPPED/FAILED；配置页显示删除入口；确认后调用 mutation，成功 refetch home + 返回设置页/主机列表。
- **表单**：名称 trim 后 1~64；harness 未选/列表为空时禁用提交并提示；选 1 个显示「将自动创建会话」，选多个显示「不自动创建会话」。
- **只读回看**：云电脑终态时 SessionPage 保留消息流、隐藏输入/发送/继续；无「再次启动」入口；移动端输入区不渲染。
- **移动端**：新建按钮在 mobile Sidebar 同样可达；对话框/配置页无横向溢出（沿用现有 Dialog 宽度约束）。

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-AW1 | 云图标 | cloud 主机显示 `cloud-host-icon`；local 主机不显示 |
| T-AW2 | 新建入口 | capabilities.enabled=true 且无活跃云电脑显示；false 或已有活跃云电脑禁用/隐藏并提示 |
| T-AW3 | 对话框校验 | 名称为空/全空白禁用提交并提示；未选 harness 禁用 |
| T-AW4 | 提交成功 | mutation 变量 `{name, harnessTypes:['OPENCODE']}`；关闭对话框；refetch + 进入主机页 |
| T-AW5 | 提交失败 | 展示服务端文案（`name is too long`/`too many cloud hosts`/`harness feature is disabled`） |
| T-AW6 | 状态展示 | STARTING/RUNNING/STOPPING/STOPPED/FAILED 文案正确；已销毁无再次启动 |
| T-AW7 | 停止无活动会话 | 不弹告警，直接 `stopCloudHost(force:false)` |
| T-AW8 | 停止有活动会话 | 弹窗文案逐字；取消不调用；确认传 `force:true` |
| T-AW9 | 删除约束 | RUNNING/STOPPING 无删除入口；STOPPED/FAILED 有；确认调用 mutation |
| T-AW10 | 只读会话 | 云电脑终态时 SessionPage 无输入/发送/继续；历史消息仍展示 |
| T-AW11 | 普通会话回归 | 普通 ended 会话仍显示恢复入口；local 主机图标/分组/会话/工作区无变化 |
| T-AW12 | 主机同构 | 云电脑配置页显示「工作区」「可用 Harness 工具」两栏；切到 Harness 显示列表 |
| T-AW13 | 无存储参数 | 对话框不出现「存储会话」「恢复的会话」 |
| T-AW14 | 移动端 | 新建入口可见；对话框/配置页/只读会话无横向溢出 |
| T-AW15 | home 字段 | HOME_OVERVIEW 请求包含 `cloudHost`，轮询不卸载 Sidebar |

### 验收 checklist

- [ ] 前台可命名新建云电脑；名称/harness 必填校验、开关隐藏、1 实例禁用态、错误文案齐全
- [ ] 云电脑在 Sidebar 使用云图标，状态与普通主机同口径
- [ ] 云电脑界面与普通主机一致（工作区 + Harness 工具列表）
- [ ] 停止告警（有活动会话）/直接停止（无活动会话）、停止后无再次启动
- [ ] 停止后会话只读回看（无发送/继续），普通会话恢复不受影响
- [ ] 删除仅 STOPPED/FAILED，成功后列表移除
- [ ] 普通主机零视觉/行为变化；无存储/会话导入导出入口
- [ ] `npm run build` / `npm run lint` / `npm test` 全绿

---

## Phase 9: tests/api + tests/e2e + 全量回归

开发分支：`tests/harness-support`（基于已合入的 servers/packages/apps）。

### tests/api

| 文件 | 操作 | 覆盖 |
|------|------|------|
| `tests/api/src/agent-api/cloud-host.test.ts` | 新增 | `cloudHostCapabilities` 开关；`createCloudHost` 名称/harnessTypes 空/白名单外/单选/多选/1 实例拒绝/配置错误矩阵；创建成功（Controller type=cloud/registering、默认工作区、ControllerKey 不出现在 `controllerKeys`）；`myCloudHosts`；`cloudHostStopImpact`；`stopCloudHost` 无 force 拒绝文案/force 成功/幂等；`deleteCloudHost` 状态限制/幂等；非属主；`Controller.cloudHost` local=null；软删除不展示 |
| `tests/api/src/agent-api/cloud-host-callback.test.ts` | 新增 | 内部 ready（单 harness 默认会话/多 harness 不建/重复幂等）、terminal（STOPPED/FAILED、会话 ENDED、重复幂等）、鉴权 |
| `tests/api/src/agent-api/session-readonly.test.ts` | 新增 | 停止后 `resume` 返回 `session is ended`；普通 ended 会话仍可 resume；非 RUNNING 云电脑 createSession 拒绝 |
| `tests/api/src/agent-api/billing.test.ts` | 修改 | 内部铸造/撤销云电脑 Key 相关（如经 agent-api 入口） |
| `tests/api/src/admin-api/billing-gateway.test.ts` | 修改 | 云电脑 Key 模型范围、宿主非 RUNNING/过期/删除 401、自定义模型不记账、系统模型计费、`billable=false,cost=0` |
| `tests/api/src/admin-api/billing.test.ts` | 修改 | 内部铸造云电脑 Key、按 ID/宿主撤销幂等、`expiresAt` 校验、对账 |
| `tests/api/src/admin-api/cloud-workload.test.ts` | 修改 | 预制 4→5（数量/名称）；`workloadKind=harness/harnessType=opencode/paramSchema=[]` 由 migration 单测或 `MONGODB_URI` 直读断言（admin GraphQL 本期不暴露新字段） |
| `tests/api/src/cloud-controller/internal-api.test.ts` | 修改 | purpose=harness 创建/响应/secret 不回显/未开放 purpose 回归/`hostId`/`userId` 过滤 |
| `tests/api/src/cloud-controller/worker-handshake.test.ts` | 修改 | 版本门禁 purpose 分流、`registered.initializing`（可构造） |
| `tests/api/AGENTS.md` | 修改 | 新增 `HARNESS_ENABLED`/云电脑套件说明 |

### tests/e2e

| 文件 | 操作 | 覆盖 |
|------|------|------|
| `tests/e2e/src/cloud-host.spec.ts` | 新增 | 新建云电脑对话框（名称必填、harness 多选/必选、选 1 提示、无存储参数）→ 提交 → Sidebar 出现云图标 + 启动中 → 进入配置页（工作区/Harness 两栏）→ 停止（无活动会话直接确认）→ 已销毁（无再次启动）→ 删除 → 列表移除 |
| `tests/e2e/src/cloud-host-readonly.spec.ts` | 新增（fixture 驱动） | 已销毁云电脑的会话只读回看：无输入/发送/继续；删除入口仅终态 |
| `tests/e2e/src/admin-cloud-workload.spec.ts` | 修改 | 预制 4→5；预制徽章/名称集合加入 `OpenCode（Harness）`（admin-web 页面逻辑不变，仅断言随 migration 更新） |
| `tests/e2e/src/settings-controller-config.spec.ts` | 修改 | 普通主机配置页不出现云电脑停止/删除按钮；云电脑配置页出现（如复用 helper） |
| `tests/e2e/src/home.spec.ts` | 修改 | Sidebar 普通主机回归；如有云电脑 fixture，断言云图标不影响普通主机 |
| `tests/e2e/AGENTS.md` | 修改 | 新增云电脑套件说明与「无真实 worker 时只覆盖到 STARTING/停止/删除」边界 |

> E2E 的 RUNNING/默认会话/只读消息无法在 `K8S_ENABLED=false` 下真实产生；只读回看用 fixture/直写 Mongo 构造已停止云电脑与会话，断言前端只读渲染。真实 worker 链路由单测 + 真实集群手工验收覆盖。

### 回归清单

- [ ] `cd servers/admin-api && npm test` 全绿（含既有 billing 542+ 用例）
- [ ] `cd servers/agent-api && npm test && npm run build` 全绿
- [ ] `cd servers/cloud-controller && npm test && npm run build` 全绿
- [ ] `cd servers/controller-api && npm test` 全绿
- [ ] `cd packages/agent-controller && npm test && npm run build` 全绿
- [ ] `cd apps/agent-web && npm test && npm run build && npm run lint` 全绿
- [ ] `cd tests/api && npm test` 全绿
- [ ] `cd tests/e2e && npx playwright test` 全绿（串行）
- [ ] `idle` 启动、工作负载参数/依赖/必须失败、计费全链路、普通主机/标准会话回归通过
- [ ] 历史容器/历史会话（无新字段）读取/展示/停止/删除不报错
- [ ] 后台 admin-web/admin GraphQL 零改动（`adminStartCloudContainer` 仍仅 IDLE）
- [ ] 新增模块覆盖率 ≥80%

---

## Phase 10: 文档收口与发布

### 文档

| 文件 | 操作 |
|------|------|
| `docs/engineering/AGENTS.md` | 实现计划索引更新为本计划 v3.0 简介 |
| `docs/engineering/proposals/20261020-feat-container-harness-support.md` | 保持 v5.0；验收报告登记本计划 §3 的修正项（不回改提案） |
| `docs/product/draft/20261020-container-harness-support.md` | 保持 draft，待验收后按 product 生命周期归档 |
| `servers/agent-api/AGENTS.md` | 新增云电脑域/只读模型/ready+terminal 回调/开关/软删除说明 |
| `servers/cloud-controller/AGENTS.md` | purpose/env/secret/门禁/初始化就绪/回调说明 |
| `servers/controller-api/AGENTS.md` | 增补云电脑标准注册约定（无 `unregister`、用户命名保留） |
| `packages/agent-controller/AGENTS.md` | 2.5.0 云电脑模式/harness prepare/env 脱敏 |
| `apps/agent-web/AGENTS.md` | 云电脑入口/云图标/状态/只读/测试清单 |
| `tests/api/AGENTS.md` / `tests/e2e/AGENTS.md` | 新增套件/环境变量/边界 |
| `aspire/AgentGear.AppHost/AGENTS.md` | 新增 env 清单 |
| `deploy/images/worker/BUILD.md` | 版本/包清单/自验命令 |
| `deploy/k8s/cloud-controller.yaml` | `AGENT_API_URL`/`ADMIN_API_URL` 等 env 示例 |

### 发布顺序

```mermaid
flowchart LR
    A[1 契约合入] --> B[2 admin-api<br/>Key scope + 网关分流 + migration 005]
    B --> C[3 cloud-controller<br/>purpose/secrets/env/门禁/回调]
    C --> D[4 agent-gear 2.5.0 发布]
    D --> E[5 worker 镜像重建<br/>agent-gear 2.5.x]
    E --> F[6 agent-api<br/>HARNESS_ENABLED=false 可先发布]
    F --> G[7 agent-web<br/>入口由 capabilities 控制]
    G --> H[8 K8s/Aspire 配置<br/>CONTROLLER_API_PUBLIC_WS_ENDPOINT / CLOUD_HOST_MODEL_BASE_URL / AGENT_API_URL / ADMIN_API_URL]
    H --> I[9 打开 HARNESS_ENABLED<br/>按用户灰度]
    I --> J[10 验收 + 归档]
```

- **回滚**：`HARNESS_ENABLED=false` 立即隐藏新建入口并拒绝 create；存量云电脑仍可 `myCloudHosts`/`stopCloudHost`/`deleteCloudHost`；模型 Key 到期/宿主非 RUNNING/删除自动失效；worker 镜像可回退（普通容器门禁仍 2.2.0）；migration 006 不删除（幂等、无破坏性）。
- **配置清单**：`HARNESS_ENABLED`、`HARNESS_CONTAINER_TTL_SECONDS`、`CLOUD_HOST_MAX_PER_USER=1`、`CONTROLLER_API_PUBLIC_WS_ENDPOINT`、`CLOUD_HOST_MODEL_BASE_URL`、`CLOUD_HOST_DEFAULT_WORKSPACE`、`AGENT_API_URL`/`AGENT_API_TIMEOUT_MS`、`ADMIN_API_URL`（cloud-controller）、`MIN_HARNESS_WORKER_VERSION`（代码常量）、`OPENCODE_CLI_VERSION`（init 固定版本）。
- **监控/排障**：云电脑创建失败看 agent-api `cloud-host` 日志（回滚项）；worker 回连看 cloud-controller `/worker` 握手/`registered`；ready/terminal 回调看 agent-api `/internal/cloud-hosts` 日志；OpenCode 初始化看 `cloudworkloadlogs` 的 init 记录；Key 401 看 admin-api `billing-key-auth`（过期/宿主非 RUNNING/已删除）。

### 最终验收 checklist（对应 PRD v5.0）

- [ ] 前台「新建云电脑」可用：名称必填、harness 工具 ≥1（一期 OpenCode）、选 1 自动建会话/选多个不建、无存储/会话导入参数
- [ ] 每用户同时最多 1 个实例：已有 STARTING/RUNNING/STOPPING 时新建被拒（`too many cloud hosts`）；停止后可再新建
- [ ] 创建后左侧导航栏出现云电脑（云图标、用户命名、启动中/运行中/停止中/已销毁/失败）
- [ ] 云电脑界面与普通主机一致：工作区 + 支持的 Harness 工具（ACP）列表（含 OpenCode）
- [ ] 一机多会话：多会话并存/切换/结束不影响云电脑；零会话运行正常
- [ ] 停止即销毁：无再次启动入口；停止后状态终态；删除仅 STOPPED/FAILED，删除后留档可追溯、Key 撤销
- [ ] 停止告警：有活动会话时 `cloudHostStopImpact` + 弹窗「停止云主机会导致所有会话永久丢失，是否继续」；取消不停止；确认后全部会话 ENDED
- [ ] 会话只读：停止后会话仅只读回看（消息留档可查），服务端 resume 拒绝 `session is ended`，前端无发送/继续入口
- [ ] 运行专用 Key：创建铸造、停止/终态/删除撤销、过期/宿主非 RUNNING 失效、明文不落库不进日志
- [ ] 计费：系统模型计费入用户账户、自定义模型不计费；可用模型=用户个人模型列表
- [ ] 本期无任何统一存储/会话导入导出入口与依赖；二期口径（会话 ↔ harness JSON、状态差异）已在文档记录
- [ ] 后台零改动：admin 启动维持仅 `IDLE`，admin-web 无新增入口
- [ ] 单元/API/E2E 全绿，既有回归全绿（普通主机/多会话/计费/idle）
- [ ] worker 镜像自验、发布顺序、灰度开关、回滚路径文档完成
- [ ] 验收报告登记 §3 的 A4（模型归属二期）、A11/A23（无真实 worker 的测试边界）、A18（只读判定不新增 Session 字段）、A20（停止失败保持 STOPPING）等裁决

## 11. 相关文档

- [[../../product/draft/20261020-container-harness-support.md]] — 本期 PRD（v5.0）
- [[../proposals/20261020-feat-container-harness-support.md]] — 本期技术提案（v5.0）
- [[20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败）
- [[20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）
- [[20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- [[20261017-feat-controller-version-requirement.md]] — 云端工作容器控制器版本兼容与自动恢复
- contracts/：`cloud-host.graphql`、`agent-controller.graphql`、`agent-controller-websocket.md`、`cloud-controller-websocket.md`、`admin-billing.graphql`、`billing-openai.openapi.yaml`
- OpenCode custom provider：https://opencode.ai/v2/docs/providers/#custom
- 开发规范：`docs/engineering/common-rules.md`、`backend-rules.md`、`frontend-rules.md`
