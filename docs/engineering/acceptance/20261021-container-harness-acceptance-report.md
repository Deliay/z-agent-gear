---
description: integration→release 集成验收报告（PR #248）——容器启动任务支持 harness 类型（OpenCode 云电脑）集成级 AI Review 两轮：首轮打回 2 × 🔴 + 7 × 🟠 + 27 × 🟡，返工 3627eda 二轮复核后再次打回——D-1 修复为运行时不生效的死代码（Session 类型 resolver 未登记，GET_SESSION controllerType/cloudHost 恒 null，软删会话仍可输入，测试假绿换层重现，运行时实证坐实）+ D-6 tests/api 显式断言与服务端真实行为不符把套件改红 + C-1 落库测试假绿 + D-2 自动进入竞态；其余 A-1/A-2/A-3/B-1/C-2/D-2 主体与 🟡×27 复核属实；七包单测 3310 passed、tests/api 484 passed/1 failed、合并预检 CLEAN
type: Permanent
---

# integration→release 集成验收报告（2026-10-21，AI Review）

> **状态**: 🔴 **二轮 AI Review 复核打回（REJECT）**——返工 `3627eda` 中 A-1/A-2/A-3/B-1/C-2 等首轮 🔴/🟠 复核属实已落地，但 **D-1 的修复是运行时不生效的死代码**（`sessionResolvers.Session` 未登记 `graphql/resolvers/index.ts`，运行时实证 `GET_SESSION.controllerType/cloudHost` 恒 null，首轮软删会话可输入的 🔴 缺陷原样存在，测试假绿换层重现）；另 **D-6 修复后的 tests/api 显式断言与服务端真实行为不符（实跑 1 failed）**、**新增 E2E T-AW2..T-AW9 选择器歧义从未跑绿（实跑 1 failed）**、C-1 落库测试假绿、D-2 自动进入竞态。二轮新问题 **1 × 🔴 + 4 × 🟠 + 10 × 🟡**（第九节），修复后重提三轮复核。

## 关联文档

- PRD：`docs/product/draft/20261020-container-harness-support.md`（v5.0：停止即销毁/会话只读/每用户 1 实例/harnessTypes 多选与单选默认会话/运行专用模型计费；会话导入导出与统一存储二期）
- 技术提案：`docs/engineering/proposals/20261020-feat-container-harness-support.md`
- 实现计划：`docs/engineering/plan/20261020-feat-container-harness-support.md`（v3.0，含计划期裁决 A1~A24 / B1~B20，要求验收报告逐条登记——见第五节）
- 契约：`contracts/cloud-host.graphql`（新增）+ `contracts/{agent-controller.graphql,agent-controller-websocket.md,cloud-controller-websocket.md,admin-billing.graphql,billing-openai.openapi.yaml}`（扩展）
- 分支：`integration` @ `8c2414a`（= `origin/main`），目标分支 `release`；PR #248 `OPEN / MERGEABLE`（integration→release，"Integration branch reset to latest main"，14 提交）
- 上游产物：① 节点「切出集成分支」——integration 重置基线 `origin/main @ 8c2414a`、PR #248 含 14 提交；② 节点「修复Review意见」——无人类 Review 意见（`reworkCount=0`、`rejectInfo=null`、PR `reviews=[]`/`comments=[]`）→ 本轮为**集成级首次 AI 代码评审**
- 验收方式：AI 代码评审（`git diff origin/release...integration`）+ 4 域并行深度评审（agent-api 云电脑域 / admin-api 计费域 / cloud-controller + agent-gear / agent-web + tests，逐文件通读非抽查）+ 主评交叉复核（全部 🔴/🟠 回读源码逐条确认）+ **本机独立实机验证**（不采信自报）
- 验收日期：2026-10-21

## 一、验收范围与方法

### 1.1 变更范围

| 特性 | 内容 | 主要落点 |
|---|---|---|
| 启动任务扩展 harness | `purpose=harness` 全链路；预置工作负载「OpenCode（Harness）」（migration 006：固定 `@opencode/cli@2.1.1` + `opencode --version` 硬校验 + `opencode.jsonc` 注入）；`workloadPlan` 展开；`HARNESS_ENABLED` 开关（Aspire dev 实测 `true`，publish 默认 `false`） | `servers/admin-api/src/migrations/006-preset-harness-opencode.ts`、`servers/cloud-controller`、`packages/agent-controller/src/harness/*` |
| 前台云电脑域 | `cloudHostCapabilities/myCloudHosts/cloudHostStopImpact` + `createCloudHost/stopCloudHost/deleteCloudHost`；创建编排（per-user 锁→1 实例校验→ControllerKey/Controller/Workspace 预创建→CLOUD_HOST 模型 Key→容器启动，逆序回滚）；停止即销毁（会话批量 ENDED→销毁容器→撤销 Key→STOPPED 终态）；软删除留档 | `servers/agent-api/src/{graphql/resolvers/cloud-host.ts,services/cloud-host-service.ts,routes/internal-cloud-host.ts,models/cloud-*.ts}` |
| 云电脑=「主机」同构 | `Controller(type=cloud)` 预创建（用户命名不被 register upsert 覆盖）；agent-gear 2.5.0 双连接（`/worker` + controller-api）；`initializing` 就绪门禁；默认会话规则（恰好 1 工具自动创建） | `packages/agent-controller/src/{cloud-host/supervisor.ts,commands/harness.ts}`、`servers/controller-api` |
| 运行专用模型计费 | `BillingApiKey.scope=CLOUD_HOST`（cloudHostId+expiresAt）；网关 `billingKeyAuth` 实时失效校验；自定义模型代转发不计费（`billable=false,cost=0`）；系统模型计费入用户账户；撤销三线+对账兜底 | `servers/admin-api/src/{middleware/billing-key-auth.ts,routes/billing-openai.ts,routes/internal-billing.ts,services/billing/*}` |
| 会话只读 | 停止批量 ENDED；`resume`/`createSession` 对云电脑终态/软删拒绝；前端无发送/继续入口 | `servers/agent-api/src/services/session.ts`、`apps/agent-web/src/components/session/*` |
| 前台体验 | 新建云电脑弹窗（命名+多选 ≥1+默认会话提示）；Sidebar 云图标/状态；停止告警逐字文案；删除仅限已销毁/失败 | `apps/agent-web/src/components/cloud-host/*`、`Sidebar.tsx` |
| 测试/部署 | 新增单测约 700+ 用例（五服务包+两前端+agent-gear）、tests/api 5 套、tests/e2e 2 套；worker 镜像/Aspire/K8s env；BUILD.md 校验清单 | `tests/*`、`deploy/*`、`aspire/*` |

### 1.2 评审与验证方法

1. **四域并行深度代码评审**（逐文件通读）：主评负责跨域交叉验证与全部 🔴/🟠 的源码复核（9/9 属实）。
2. **独立实机验证**：七包 `tsc`/`eslint`/全量单测本机复跑；`aspire start --isolated` 全新隔离栈实跑 `tests/api` 云电脑五套件（`cloud-host` / `cloud-host-callback` / `session-readonly` / `admin-api cloud-host-billing` / `cloud-controller internal-api`，含密钥不回显与生命周期状态门控）。**不采信自报数据与历史报告结论。**
3. **反向对照**：`release..integration` 14 提交全部为本期特性/文档提交；release 独有 21 提交（含上轮返工 `36e62dd`）经 `git merge-tree --write-tree` 预检 **CLEAN MERGE 无冲突**，唯一交集文件 `apps/agent-web/src/graphql/types.ts` 改动位于不同区域语义无冲突 → PR #248 合入 release 不回退上一轮 A-1/B-1/B-2 修复。
4. **安全扫描**：全量新增行 secret/凭据硬编码、XSS sink、敏感日志、范围红线扫描——无命中；范围红线全部合规（本期无 unified-storage/MinIO/quota-guard/会话导入导出任何代码/契约/依赖/入口；admin-web 与 `admin-cloud-container.graphql`/`admin-cloud-workload.graphql` 零改动；`MIN_WORKER_VERSION=2.2.0` 保持 + `MIN_HARNESS_WORKER_VERSION=2.5.0` 按 purpose 分流）。
5. **判定红线（与历轮一致）**：🔴 阻断 / 🟠 重要 → 打回返工（本轮命中 2 + 7）；🟡 建议 → 记录并随修复一并收口。

## 二、独立验证结果（本机实跑，不采信自报）

| 服务/包 | 类型检查 | Lint | 测试 | 备注 |
|---|---|---|---|---|
| servers/agent-api | ✅ build 0 | — | ✅ **545 passed**（46 文件） | 含 cloud-host-service/internal-cloud-host/session 新增用例 |
| servers/admin-api | ✅ build 0 | — | ⚠️ **600 passed / 1 failed / 1 skipped**（62 文件） | 唯一失败 `billing/review-fixes.test.ts` A-2/R2-1 水位用例 5s 超时——**实证为基线既有 flaky，非本 diff 引入**（见 2.1） |
| servers/cloud-controller | ✅ build 0 | — | ✅ **708 passed**（51 文件） | 含 harness-lifecycle/secret-store/agent-api-client 新增用例 |
| servers/controller-api | ✅ build 0 | — | ✅ **236 passed**（18 文件） | 本 diff 未触碰核心逻辑 |
| packages/agent-controller | ✅ build 0 | — | ✅ **432 passed**（38 文件） | 含 supervisor/harness/commands 新增用例 |
| apps/agent-web | ✅ `tsc -b` 0 | ✅ 0 error | ✅ **501 passed**（57 文件） | 含三个云电脑弹窗/SessionView.cloudHost/Sidebar 新增用例 |
| apps/admin-web | ✅ `tsc -b` 0 | ✅ 0 error | ✅ **220 passed**（29 文件） | 回归面（本 diff 零改动） |
| tests/api（Aspire `--isolated` 全新栈实跑） | — | — | ✅ **37 passed / 1 skipped（38）**，5/5 文件 | 云电脑五套件全绿：cloud-host / cloud-host-callback / session-readonly / admin-api cloud-host-billing / cloud-controller internal-api（含密钥不回显、生命周期状态门控、幂等） |
| 迁移 006-preset-harness-opencode | — | — | ✅ 随 Aspire 启动执行（单测 T-MIG5-1~4 含 `bash -n` 语法与脚本顺序锚定） | 原编号 005 与 `005-model-name-unique-global` 重复，已改名 006（见 🟡 B-6） |

### 2.1 执行环境备注

- **admin-api 唯一失败的定性**：`review-fixes.test.ts`（A-2/R2-1 崩溃残留水位重放不二扣）5000ms 超时。三项实证：① 本 diff **未触碰**该文件（`git diff --name-only` 为空）；② 单独复跑该文件 **12/12 全绿**（4.4s）——属并行负载下慢用例；③ release 侧已有 `71b01f1 test(billing): 放宽 A-2/R2-1 水位用例超时以适配 CI` 专门放宽该用例超时，PR #248 合并后 release 侧该修复保留（merge CLEAN）。结论：**基线既有 flaky，与本 diff 无关，合入后已被 release 侧既有修复覆盖**。
- **Aspire 全栈**：`aspire start --isolated` 全新隔离栈（随机端口+隔离 secrets），agent-api/admin-api/controller-api/cloud-controller/agent-web/admin-web 全部 `Running / Healthy`，MongoDB 7 + Redis + RabbitMQ 就绪；`HARNESS_ENABLED=true`（dev 编排，实测环境确认）；tests/api 端口按 `aspire describe` 实测值注入（agent-api `:39603`、admin-api `:39009`、controller-api `:34239`、cloud-controller `:46367`），规避历轮「同机双栈固定端口互踩」假红。
- **E2E 说明**：本轮 E2E（`cloud-host.spec.ts` / `cloud-host-readonly.spec.ts`）作为打回轮的补充证据视返工情况在二轮复核实跑；UI 面结论以单测（501 用例含云电脑弹窗/只读渲染/Sidebar）+ tests/api + 逐行代码评审为准（打回项 D-1/D-2 均为代码评审+单测复核发现，不依赖 E2E）。

## 三、已验证（✅，四域汇总要点）

| 项目 | 结果 | 证据 |
|---|---|---|
| 契约一致性 | ✅ | `cloud-host.graphql` ↔ schema ↔ resolver 13 字段/3 类型/Query/Mutation/`extend type Controller` 逐字段一致；错误文案 14 条与计划 §3 逐字命中；`admin-billing.graphql`/`billing-openai.openapi.yaml` ↔ 实现 ↔ 测试对齐 |
| 范围红线 | ✅ | 本期无 unified-storage/MinIO/quota-guard/会话导入导出任何代码/契约/依赖；admin-web 与 admin-cloud-container/admin-cloud-workload 契约零改动；无 `startCloudHost`/重启入口 |
| 版本门禁 | ✅ | agent-gear `2.5.0`；`MIN_WORKER_VERSION=2.2.0` 不变、`MIN_HARNESS_WORKER_VERSION=2.5.0` 按 purpose 分流；门禁先于注册副作用（T-CC9/10/18） |
| secret 红线 | ✅ | SecretStore 仅内存、不落库/不返回/不打印；模型 Key 不进 Job env（仅 `workload:run.env`）；`ZAG_HOST_KEY` 与 `/worker` token 分名分离；日志/错误输出统一脱敏（`redactSecrets`）；配置 0600/0700；终态立即清理 secret（T-CC14）；凭据不进 URL/query |
| 计费红线 | ✅ | 自定义模型（`scope=user`）不计费：无计量/outbox，仅 `billable=false,cost=0` 审计（T-BK12/13）；系统模型计费入用户账户并 `cloudHostId` 归因（T-BK11）；同名伪装系统模型优先被堵（T-BK14）；account Key 不能命中免费模型（T-BK15）；Key 明文仅铸造响应一次、库内仅 bcrypt+前缀（T-BK16） |
| 凭证失效 | ✅ | 停止/删除/terminal 三处显式 `revoke-by-host` + 网关按 `cloudhosts.status/expiresAt` 实时 401 + 对账兜底；`expiresAt` 同源写入 Key 与 Job `activeDeadlineSeconds`（T-CC22） |
| 属主隔离 | ✅ | 非属主统一 `Cloud host not found` 不泄露存在性；网关 `ownerId === host.userId` 校验（实现正确，反向用例缺失见 B-2） |
| 1 实例上限 | ✅（单实例部署） | `ACTIVE_STATUSES=[STARTING,RUNNING,STOPPING]`+`deletedAt:null` 计数；per-user 锁内并发创建恰一成功（测试断言 `startHarness` 仅一次）；多副本防线缺失见 A-5 |
| 停止即销毁 | ✅（骨架） | 无重启入口；STOPPED 终态 CAS；stop 失败保持 STOPPING 可重试幂等；删除仅 STOPPED/FAILED、软删留档（Controller/会话/消息保留） |
| 默认会话规则 | ✅（服务端） | `harnessTypes.length===1` 才建、失败容忍保持 RUNNING（T-CH19/21）；「自动进入」前端缺失见 D-2 |
| ready/terminal 回调 | ✅ | Bearer `INTERNAL_API_TOKEN` + `timingSafeEqual` fail-closed；4 次退避重试+幂等（ready 幂等不重复建会话）；未配置地址启动告警 |
| 初始化就绪门禁 | ✅ | `registered.initializing` + init 批次（含 cancelled/被打断）完成后才建 controller-api 标准连接；超时后迟到 registered 不重复等待 |
| 普通主机/既有回归 | ✅ | 全部分支改动以 `isCloud`/`type==='cloud'` 守卫；idle 容器 Job env 两项不变（T-CC1/8）；普通 ended 会话仍可 resume 回归对（session-readonly 用例） |
| 测试真实性（主体） | ✅ | 四域一致评价：断言具体行为/逐字文案/查库验证/时序副作用锚定，非 fake-green；唯二例外见 D-1（单测假绿）与 D-3（静默早退） |

## 四、验收问题清单

### A-1（🔴）create ⇄ stop 并发竞态：孤儿容器持续计费、containerId 被清零

- **问题描述**：`servers/agent-api/src/services/cloud-host-service.ts`——`CloudHost.create({status:'STARTING'})`（:202-212）在容器启动前即落库并可被用户停止；`startHarness`（:241-267，最长 30s）成功后 `findByIdAndUpdate` **无条件** `$set:{containerId}`（:269-273）。而 `stop()`（:360-411）持 `host:${id}` 锁、`create()` 持 `user:${userId}` 锁，**两者互不互斥**：`stop` 提前读取快照（:361），快照 `containerId=null` 时跳过 `destroyContainer`（:388-395），CAS 置 STOPPED 且 `containerId:null`（:401-411）；随后 `create` 继续把 `containerId` 写回 STOPPED 记录。结果：① 容器真实运行无人销毁，直到 `expiresAt`/`activeDeadlineSeconds`（默认 TTL 86400s）被 K8s 杀掉；② 该容器 `billingAccountId` 生效，`container.ready` 计费事件照常出账——用户对「已停止」的云电脑持续付费最长 24h；③ `cloudhosts.containerId` 被清零失去清理线索；④ 孤儿容器仍以 `ControllerKey(type=cloud)` 注册成 online 主机。
- **根因分析**：创建编排把「记录可见」置于「容器启动」之前，回写 `containerId` 不做状态 CAS；`stop` 用过期快照决定是否销毁。
- **修复方案**：`startHarness` 成功后以 CAS 回写 `findOneAndUpdate({_id, status:'STARTING'}, {$set:{containerId}})`，CAS 未命中（已被并发停止）立即 `destroyContainer`+`revokeApiKeysByHost`；或 `create` 全程持 `host:${id}` 锁、`stop` 持同一把锁并在 CAS 后重读 `containerId` 再决定销毁。补 create⇄stop 并发回归用例。
- **验证结果**：✅ 已修复（`3627eda`）——创建侧 CAS 未命中立即 `destroyContainer`+`revokeApiKeysByHost`；stop 使用 CAS 后最新快照销毁，拒绝时回滚状态；新增并发/孤儿回收/晚到 containerId 用例。

### D-1（🔴）软删除云电脑的会话回看不进入只读（输入框/「继续」重现），对应单测假绿

- **问题描述**：`apps/agent-web/src/components/session/SessionView.tsx:414-421` 只读判定 `readOnlyCloudHost = sessionController?.type === 'cloud' && (cloudHost == null || isReadOnlyCloudHost(...))` 依赖 `controllers.find(...)` 命中；但软删除后 `controllerService.findAllByUser`（`servers/agent-api/src/services/controller.ts:7-25`）把该 Controller **整条过滤**（`deletedAt != null`）→ `sessionController=undefined` → 只读失效，InputBox 与 SessionHeader「继续」按钮重现。而 `homeOverview.sessions` 独立于 controller 过滤，软删除后旧会话仍可从首页打开——用户对已删除云电脑的留档会话看到「发送/继续」入口，违反 PRD「只读展示历史，无发送/继续入口」。**假绿证据**：`SessionView.cloudHost.test.tsx:127-140` mock 的「controller 在列且 `cloudHost:null`」形态在软删除路径下真实服务端不会返回，绿灯误导；真实软删除路径（controller 缺失）零测试。
- **根因分析**：只读判定依赖会被删除操作破坏的数据源（列表命中）；测试 mock 与服务端真实响应形态脱节。
- **修复方案**：只读判定改为不依赖列表命中（如 `GET_SESSION` 带出 controller `type`/`cloudHost`，或对 session 的 controller 用 `findById` 不过滤软删；或 `sessionController` 缺失且 `session.status==='ended'` 时只读兜底渲染）；单测 mock 改为「GET_CONTROLLERS 不返回该 controller」的真实形态。服务端 `session.ts` 已有守卫（无数据风险），但 UI 与验收证据必须收口。
- **验证结果**：✅ 已修复（`3627eda`）——`Session.controllerType/cloudHost` 由 GET_SESSION 直接返回（cloudHost 含软删留档），SessionView 不再依赖 controllers 列表；单测改为「列表为空 + cloudHost 终态/软删/null」真实形态。

### A-2（🟠）会话只读只拦 `resume`/`createSession`，`sendSessionMessage` 未拦截——停止后仍可「继续对话」

- **问题描述**：守卫仅存在于 `session.ts:86-93`（create）与 `:355-374`（resume）；`resolvers/session.ts:149-166` `sendSessionMessage` 仅校验属主即调用 `sessionService.addMessage`（`session.ts:575-621` 无任何状态/云电脑校验）——停止后对只读会话发消息**成功写入历史留档并 SSE 推送**（留档被「续写」），只是对端无回复。违反 PRD 功能点 4「停止后会话仅只读可查看，无法继续对话」与计划 A18「服务端拒绝 `session:command`（`session is ended`）」。`cancelGeneration`（:333-343）同样无守卫。
- **根因分析**：只读被实现为「resume 拦截 + 前端隐藏」，漏掉真正承载「继续对话」的 mutation。
- **修复方案**：`sendSessionMessage`/`addMessage` 复用同一判定（cloud 控制器 + 云电脑终态/软删 → `session is ended`）；建议抽 `assertSessionWritable` 统一所有 `session:command` 发布路径；补「停止后 sendSessionMessage 拒绝」用例。
- **验证结果**：✅ 已修复（`3627eda`）——`assertSessionWritable` 收口 sendSessionMessage，cancelGeneration 同守卫；补「停止后 send/cancel 拒绝」「普通 ended 可写」用例。

### A-3（🟠）会话创建与 stop/terminal 无原子性 + `handleTerminal` 不持锁 → STOPPED 主机残留活跃会话

- **问题描述**：三条竞态同源——(a) `createSession` 通过 RUNNING 守卫后、`Session.create` 落库前（中间夹 worktree/MCP 流程最坏 ~30s，`session.ts:148-207`），`stop()`/`handleTerminal` 的 `updateMany→ENDED` 已执行完毕，新会话以 `creating` 落库永不结束；(b) `handleReady` 持 `hostMutex`（`cloud-host-service.ts:447-448`）而 `handleTerminal`（:500）**不持锁**，ready/terminal 并发时默认会话创建可漏网；(c) 残留会话计入 `activeSessionCount`/`cloudHostStopImpact`，叠加 A-2 后还能写消息。
- **根因分析**：状态守卫与落库非原子；终态回调绕过 per-host 串行锁。
- **修复方案**：`handleTerminal` 同样走 `hostMutex.runExclusive('host:'+id)`；`Session.create` 落库前复查 `CloudHost.status==='RUNNING'`，或 `endByController` 在终态 CAS 后再扫一次兜住晚到会话；补并发回归用例。
- **验证结果**：✅ 已修复（`3627eda`）——`handleTerminal` 纳入 `hostMutex`，`Session.create` 落库前复查 RUNNING，stop/terminal 终态 CAS 后再扫一次会话；补 keyed-mutex 串行化用例。

### B-1（🟠）对账线误杀 STARTING 窗口内的云电脑运行 Key，本期无重铸 → 云电脑模型永久不可用

- **问题描述**：`servers/admin-api/src/services/billing/reconciliation.ts:531`——`else if (host.status !== 'RUNNING') reason='cloud_host_not_running'` 即撤销 Key。但 Key 在宿主 `status='STARTING'` 期铸造（`cloud-host-service.ts:207→:224`），STARTING 窗口=K8s 调度+init（`npm install @opencode/cli`+`harness prepare`）分钟级；对账触发源为每日 cron + admin 手动 `runReconciliation`（`resolvers/billing.ts:365`）。命中即整台云电脑报废：容器内已注入的明文 Key 失效、所有模型调用 401，本期无重铸/无重启，只能销毁重建——击穿 PRD 功能点 5/6。与计划第 9 条「STARTING 窗口 Key 存活、由网关拒绝」的意图自相矛盾（`billing-key-auth.ts:61` 注释即此意图）。
- **根因分析**：计划 A16 兜底线表述「云电脑非 RUNNING 但 Key 仍 active」被照搬实现，未排除 STARTING 合法窗口。
- **修复方案**：撤销条件放行 STARTING（`status !== 'RUNNING' && status !== 'STARTING'`）或仅扫 STOPPING/STOPPED/FAILED + 过期/缺 expiry；补「STARTING 宿主 active Key 不得被对账撤销」用例；同步修订计划 A16/提案 §3.2.2 表述。
- **验证结果**：✅ 已修复（`3627eda`）——对账放行 `STARTING`；新增「STARTING 宿主 active Key 不得撤销」用例；计划 A16/提案 §3.2.2 已同步修订。

### C-1（🟠）启动/初始化失败被映射为「已销毁」且丢失失败原因——违反 PRD 3.5

- **问题描述**：必须工作负载初始化失败（OpenCode 安装失败、`harness prepare` 非零退出等主要「启动失败」场景）走 `workload-dispatcher.ts:501-508`（required failed → `markMustFailure`）→ `forceDestroy` → `container-service.ts:642-652`（终态固定写 `status:'exited'`，失败原因仅在 `exitReason`）→ `index.ts:42` `harnessTerminalStatus('exited')='stopped'` → agent-api `handleTerminal`：`target='STOPPED'` 且 `failureReason: target==='FAILED' ? reason : null`（`cloud-host-service.ts:507-515`）——**reason 被丢弃**。用户看到「已销毁」、`failureReason=null`，无法区分主动停止与启动失败。对照 secret 缺失路径走 `markFailed`→`failed`→FAILED 是正确的，两条失败路径口径分裂。
- **根因分析**：`harnessTerminalStatus` 只认容器 `status==='failed'`，而必须项失败走 destroy 链路终态恒为 `exited`。
- **修复方案**（任一）：必须失败路径先 `markFailed(containerId, reason)` 再 destroy（CAS 仅 ACTIVE 可安全先行）；或 `harnessTerminalStatus` 按 `exitReason` 判失败；或 agent-api 对 `stopped`+非空 reason+`readyAt` 空落 FAILED+`failureReason`。补「required init 失败 → FAILED + failureReason」端到端用例（现 `harness-lifecycle.test.ts:5-9` 把 `exited→stopped` 固化为预期，恰掩盖本缺陷）。
- **验证结果**：✅ 已修复（`3627eda`）——`harnessTerminalStatus(status, mustFailure)` 将 destroy 链路的 exited+mustFailure 映射为 failed，agent-api 落 FAILED+failureReason；补 harness-lifecycle 用例。

### C-2（🟠）agent-gear 云电脑模式错误路径 `exit(0)`：失败被掩盖为「正常退出」并绕过 entrypoint 自愈

- **问题描述**：`socketio-client.ts:429-452` 把 `VERSION_MISMATCH`、`REGISTER_FAILED` 及一切 `error` 事件改道 `options.onShutdown(...)`；`cloud-host/supervisor.ts:157-174` 的 `shutdown()` **无条件 `exit(0)`**（`supervisor.test.ts:294` 甚至把 `reason:'必须工作负载初始化失败'` 断言为 `exit(0)`）。后果：① Job 以 `succeeded` 结束 → 终态 `exited` → 显示「已销毁」（叠加 C-1）；② `entrypoint.sh:137-151` 只在「非零退出 + VERSION_MISMATCH 标记」时执行一次性 `agent-gear` 自愈升级——`exit(0)` 直接走「exited normally」，**自愈被完全绕过**（旧 worker 镜像跑 harness 容器会静默起不来）。本地单连接模式同场景仍 `process.exit(1)`，回归仅限云电脑模式。
- **根因分析**：`onShutdown` 混用「服务端主动 shutdown（应 exit 0）」与「错误/版本不兼容（应非零）」两类语义。
- **修复方案**：`shutdown(reason, code)` 显式分流——`shutdown`/SIGINT/SIGTERM → `exit(0)`；`version_mismatch:*`/`error:*` → `exit(1)`；补错误路径退出码测试（现仅 T-AG17 覆盖 shutdown→exit 0，C-2 因此逃逸）。
- **验证结果**：✅ 已修复（`3627eda`）——supervisor 按 reason 分流退出码：version_mismatch/error/初始化失败→1，正常 shutdown/信号→0；补错误路径退出码用例。

### D-2（🟠）「就绪后自动创建并进入会话」的「自动进入」未实现；默认会话失败提示缺失

- **问题描述**：PRD 成功标准/功能点 1 要求「恰好选 1 个工具时，就绪后自动创建**并自动进入**该工具的新会话」。自动创建在服务端实现（ready 回调写 `defaultSessionId`，T-CH19），但 `defaultSessionId` 在前端**零消费逻辑**（全仓仅 `types.ts`/`queries.ts`/`mutations.ts` 声明），创建后落点是主机配置页（`Sidebar.tsx:71-83`）；PRD 3.5「默认会话创建失败 → 提示可手动创建会话」也未实现。
- **根因分析**：字段拉取后无消费者；就绪→导航链路缺失。
- **修复方案**：HOME_OVERVIEW 数据流检测 STARTING→RUNNING 且 `defaultSessionId` 非空时一次性导航进会话（防重复）；`RUNNING && 单工具 && !defaultSessionId` 时提示「可手动创建会话」；补单测。
- **验证结果**：✅ 已修复（`3627eda`）——MainLayout 观测 STARTING→RUNNING + defaultSessionId 一次性导航；Sidebar 在 RUNNING+单 Harness+无默认会话时提示可手动创建；补单测。

### D-3（🟠）tests/api 新用例缺 `MONGODB_URI` 时静默假绿（含「密钥不回显」安全断言）

- **问题描述**：`tests/api/src/cloud-controller/internal-api.test.ts:103-104` 新增 `T-CC2/T-CC6/T-CC16: creates harness container and never echoes secrets` 用 `const db = await mongoDb(); if (!db) return;` 早退——无 Mongo 时零断言却显示 **passed**。同文件其余 11 处依赖 Mongo 的用例统一 `it.skipIf(!HAS_MONGO)` 显式跳过，文件头注释明确承诺「显式跳过而非静默假绿」。被静默跳过的恰含 `expect(raw).not.toContain(secrets.hostKey/modelApiKey)`（密钥不回显）这一安全验收点。
- **根因分析**：新用例未沿用既定 `it.skipIf(!HAS_MONGO)` 模式。
- **修复方案**：改 `it.skipIf(!HAS_MONGO)(...)`。
- **验证结果**：✅ 已修复（`3627eda`）——改用 `it.skipIf(!HAS_MONGO)`，Mongo 可用时密钥不回显断言必定执行，缺失时显式 skipped。

### 🟡 建议项（27 项，随本轮修复一并收口，不单独构成打回）

**A 组（agent-api，8 项）**

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| A-4 | terminal 回调早退跳过副作用收尾，重试不补做（endByController/revoke 抛错后重试命中早退分支） | `cloud-host-service.ts:503-505,523` | 早退分支也执行幂等的 `endByController`+`revokeApiKeysByHost` |
| A-5 | 1 实例上限仅进程内锁+countDocuments，多副本部署可突破 | `keyed-mutex.ts`、`models/cloud-host.ts:52-53` | 加部分唯一索引或 upsert 占位下沉 DB |
| A-6 | `toCloudHostGraphQLError` 透传任意内部错误消息（不满足 B19「不泄露 Mongo/驱动信息」） | `cloud-host-service.ts:573-576` | 白名单契约文案透传，未知统一 `internal error` |
| A-7 | 创建收尾非空断言 `(...)!` 边界抛 TypeError | `cloud-host-service.ts:274` | 随 A-1 改 CAS 回写，去 `!` |
| A-8 | 契约 `CloudHost.deletedAt` 注释与实现不符（软删后恒不可见） | `contracts/cloud-host.graphql:34-36` | 改注释或保留软删对象于 `Controller.cloudHost` |
| A-9 | `stopImpact`→`stop` 间微小 TOCTOU：告警后新建会话被静默结束 | `cloud-host-service.ts:366-386` | 锁内先 CAS STOPPING 再统计活动会话 |
| A-10 | 测试缺口：keyed-mutex 无单测、create⇄stop/ready⇄terminal 并发无用例 | `services/*` | 随 A-1/A-3 补 |
| A-11 | 会话工具范围未在服务端收敛（`acpServerType ∈ harnessTypes` 未校验） | `session.ts:67-207` | create 对 cloud 主机增加 harnessTypes 映射校验 |

**B 组（admin-api 计费，6 项）**

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| B-2 | 属主一致性校验（ownerId≠host.userId→401）零反向用例 | `billing-key-auth.ts:72-75` | 补「不一致→401」与 admin 豁免用例 |
| B-3 | 云电脑运行 Key 混入用户费用中心「API Key」列表无法区分 | `resolvers/billing.ts:92`、`contracts/billing.graphql` | 过滤 `scope=account` 或加字段标注 |
| B-4 | `createCloudHostScopedKey` 轮换非原子，并发下可能双双撤销 | `api-key-service.ts:136-150` | 同 cloudHostId 加锁或先撤后插+唯一索引 |
| B-5 | 内部铸造接口不校验 cloudHostId↔ownerId 绑定 | `internal-billing.ts:223-234` | 铸造时校验 `host.userId===ownerId && !deletedAt` |
| B-6 | 迁移编号 005 重复（`005-model-name-unique-global` 并存；功能安全，runner 按 name 记账） | `migrations/` | 改名 `006-preset-harness-opencode` 或文档声明编号仅装饰 |
| B-7 | cloud_host `/v1/models` 列表与解析口径三处不一致（未定价全局模型列出但调用 400、禁用供应商模型列出、存量缺 scope 模型） | `billing-openai.ts:180-196,221-253` | 列表联查 provider.isEnabled；边缘项登记 |

**C 组（cloud-controller/agent-gear，5 项）**

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| C-3 | `KEY_ALREADY_ONLINE` 后 `socket.disconnect()` 停止自动重连，supervisor 无兜底 → 主机永久离线 | `socketio-client.ts:441-445` | 云电脑模式退避重连或 supervisor 看门狗重建 |
| C-4 | `agentGearMinVersion` 仅格式校验后被静默忽略（门禁实为常量） | `internal-api.ts:220-224,409-420` | 落库生效 `max(常量,请求值)` 或契约标注「仅声明」 |
| C-5 | OpenCode「固定版本可重复执行」只保证首次安装，版本一致性无硬校验 | `006-preset-harness-opencode.ts:22-27`、`opencode-cli.ts:54-79` | 安装前比对版本、不一致强制重装 |
| C-6 | `ZAG_HOST_KEY` 进 Job env 且未设 `automountServiceAccountToken:false`（纵深防御） | `k8s-job-manager.ts:124-155` | Job manifest 加 `automountServiceAccountToken:false`；中期移入 `workload:run.env` |
| C-7 | `opencode.jsonc` 非原子写、已存在目录权限不收紧 | `opencode-config.ts:111,150-153` | 临时文件+rename 原子替换；写前 chmod 0700 |

**D 组（前端/tests，8 项）**

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| D-4 | 只读 E2E 输入框断言依赖 placeholder 文案（禁用态输入框探测不到）；「历史消息保留」宣称覆盖但无断言 | `cloud-host-readonly.spec.ts:90-91` | 改 `getByRole('textbox')` 计数；fixture 注入消息并断言 |
| D-5 | 1 实例上限服务端拒绝路径展示英文原文 `too many cloud hosts`，与 PRD 文案口径不一致 | `NewCloudHostDialog.tsx:100-105` | 前端错误码映射中文提示 |
| D-6 | `cloud-host.test.ts:212-216` 软删除断言含糊（`?? null` 双形态均通过） | `tests/api/src/agent-api/cloud-host.test.ts` | 显式断言列表移除或单查 cloudHost=null |
| D-7 | 多 harness「不自动创建会话」断言偏弱（未断言 sessions 计数 0/RUNNING） | `cloud-host-callback.test.ts:136-152` | 补 `countDocuments===0` 与状态断言 |
| D-8 | StopCloudHostDialog 会话摘要拉了不渲染；stop 返回空值时 UI 停滞 | `StopCloudHostDialog.tsx:79-83,128-131` | 渲染 sessions 摘要；finally 复位 |
| D-9 | NewSessionDialog 云电脑未运行提示常驻波及普通主机流程 | `NewSessionDialog.tsx:196-206,388` | 提示限定当前选中云电脑 |
| D-10 | ControllerConfigPage 移动端 tab 移入滚动区波及普通主机视觉行为 | `ControllerConfigPage.tsx:143-160` | 保持 tab 常驻或按 isCloud 分支 |
| D-11 | 测试清理不一致（部分用例无 cleanup；E2E 兜底清理不在 finally） | `session-readonly.test.ts`、`cloud-host-callback.test.ts`、`cloud-host.spec.ts` | try/finally 或 afterEach 兜底 |

## 五、计划期裁决逐条登记（计划 §3 要求）

### A. 事实校正（A1~A24）

| # | 裁决 | 落地情况 |
|---|---|---|
| A1 | agent-gear 2.5.0 / MIN_WORKER_VERSION 2.2.0 / MIN_HARNESS_WORKER_VERSION 2.5.0 分流 | ✅ 已落地（worker-version.ts:12-21，T-CC9/10/18） |
| A2 | worker 镜像不预装 @opencode/cli，init 固定安装+硬校验 | ✅ 落地（弱化点 C-5：版本一致性无校验） |
| A3 | `ZAG_CONTROLLER_KEY`/`ZAG_HOST_KEY` 分名 | ✅ 已落地（k8s-job-manager/entrypoint/契约 §4.3） |
| A4 | 「个人可用模型列表」= 启用模型集合；自定义模型不记账；ownerId 隔离二期 | ✅ 落地；二期遗留登记（B 域残余 1） |
| A5 | deleteCloudHost 软删留档、Controller 保留 | ✅ 落地（前端链路缺口 D-1） |
| A6 | 默认工作区 /root/workspace | ✅ 落地 |
| A7 | cloudcontainers 扩展 hostId/harnessTypes/controllerKeyId/containerApiKeyId/hostName/expiresAt | ✅ 落地 |
| A8 | agent-api 只读模型 + cloud-controller-client | ✅ 落地 |
| A9 | `registered.initializing` 就绪门禁 | ✅ 落地（T-CC11、T-AG3~4e） |
| A10 | BillingApiKey scope/cloudHostId/expiresAt，网关按 cloudhosts 状态校验 | ✅ 落地（对账口径缺陷 B-1） |
| A11 | tests/api+e2e 裁剪覆盖、真实集群手工验收、无测试后门 | ✅ 按裁决执行（手工验收项见 8.3） |
| A12 | cloudHostCapabilities 开关 | ✅ 落地 |
| A13 | jsonc-parser 合并保留注释、仅替换 provider.zag | ✅ 落地（T-AG9~12b；C-7 已补原子写/目录 0700） |
| A14 | 固定 OPENCODE_CLI_VERSION=2.1.1 | ✅ 落地（与提案 `OPENCODE_CLI_PIN` 命名差异按裁决为准；C-5 已补版本一致性校验） |
| A15 | CONTROLLER_API_PUBLIC_WS_ENDPOINT/CLOUD_HOST_MODEL_BASE_URL/CLOUD_HOST_DEFAULT_WORKSPACE 配置 | ✅ 落地（部署前置条件登记 8.3） |
| A16 | 撤销三线 + 对账兜底 | ✅ 返工修复（B-1）：对账放行 STARTING，表述已同步 |
| A17 | tests/api 继续 vitest+fetch | ✅ |
| A18 | resume/createSession 拦截、普通 ended 不变 | ✅ 返工修复（A-2）：sendSessionMessage/cancelGeneration 统一守卫 |
| A19 | ready/terminal 内部回调 + Bearer + 幂等 | ✅ 落地（A-4 已补早退分支幂等收尾） |
| A20 | 停止失败保持 STOPPING、会话不回滚 | ✅ 落地 |
| A21 | 删除软删+Controller offline+Key 撤销、幂等 | ✅ 落地 |
| A22 | ready 回调建默认会话、失败容忍 | ✅ 服务端落地；前端「自动进入/失败提示」见 D-2（已修复） |
| A23 | E2E 不断言 RUNNING/默认会话 | ✅ 按裁决执行 |
| A24 | expiresAt 双用（Key+activeDeadlineSeconds）、TTL/异常退出经 terminal 兜底 | ✅ 落地（回调丢失窗口见 C 域残余 2，有对账/过期兜底） |

### B. 设计裁决（B1~B20）

| # | 裁决 | 落地情况 |
|---|---|---|
| B1 | 创建编排顺序与逆序回滚 | ✅ 返工修复（A-1）：CAS 回写 + 未命中回收 |
| B2 | ControllerKey 不删未绑定 Key | ✅（T 断言 findOneAndDelete 未被调用） |
| B3 | Controller 预创建字段、register upsert 不覆盖命名 | ✅ |
| B4 | 状态映射（STARTING/RUNNING/STOPPING/STOPPED/FAILED） | ✅ 返工修复（C-1）：mustFailure→failed |
| B5 | cloudHostCapabilities 语义 | ✅ |
| B6 | Controller.cloudHost 扩展 | ✅（A-8 契约注释已修正） |
| B7 | 停止编排（锁内统计→STOPPING→ENDED→destroy→revoke→STOPPED） | ✅ 返工修复（A-1/A-3/A-9）：CAS 后快照销毁、终态锁、先 CAS 再统计 |
| B8 | 删除语义 | ✅ |
| B9 | 模型 Key 失效校验 | ✅ 网关侧；对账侧 STARTING 放行（B-1） |
| B10 | 自定义模型路由（系统优先、不记账仅审计） | ✅（T-BK12~15） |
| B11 | 模型列表快照 ZAG_MODEL_IDS | ✅（跨用户归属二期登记） |
| B12 | 初始化就绪门禁（initializing+超时） | ✅ |
| B13 | 容器 TTL | ✅ |
| B14 | ready/terminal 回调幂等 | ✅（重试续做缺口 A-4） |
| B15 | 会话只读（resume 拒绝+前端只读） | ✅ 返工修复（A-2/D-1） |
| B16 | OpenCode 环境（安装→硬校验→工作区→prepare） | ✅ 返工修复（C-5/C-2）：版本一致性与退出码 |
| B17 | 默认会话失败容忍 | ✅ 服务端；前端提示缺失 **D-2** |
| B18 | 1 实例校验 | ✅ 单实例（多副本防线 A-5） |
| B19 | 错误文案统一 GraphQLError | ✅ 返工修复（A-6）：白名单透传，未知统一 internal error |
| B20 | 软删除与历史 | ✅ 返工修复（D-1）：前端只读链路收口 |

## 六、修复总览（返工后回填）

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| A-1 | create⇄stop 并发孤儿容器/计费泄漏 | 记录可见先于启动+无 CAS 回写+快照销毁判定 | ✅ 已修复 | `3627eda` |
| D-1 | 软删会话只读失效+单测假绿 | 只读判定依赖列表命中 | ✅ 已修复 | `3627eda` |
| A-2 | sendSessionMessage 未拦只读 | 守卫漏 mutation | ✅ 已修复 | `3627eda` |
| A-3 | 幽灵会话/终态无锁 | 守卫与落库非原子 | ✅ 已修复 | `3627eda` |
| B-1 | 对账误杀 STARTING Key | A16 表述照搬未放行 STARTING | ✅ 已修复 | `3627eda` |
| C-1 | 启动失败映射「已销毁」丢原因 | exited→stopped 口径分裂 | ✅ 已修复 | `3627eda` |
| C-2 | 错误路径 exit(0) 掩盖失败 | onShutdown 语义混用 | ✅ 已修复 | `3627eda` |
| D-2 | 自动进入会话缺失 | defaultSessionId 零消费 | ✅ 已修复 | `3627eda` |
| D-3 | 静默假绿用例 | 未沿用 skipIf 模式 | ✅ 已修复 | `3627eda` |
| 🟡×27 | 见问题清单 | — | ✅ 随修复收口 | `3627eda` |

### 6.1 返工验证（2026-10-21，提交 `3627eda`）

| 验证项 | 结果 | 说明 |
|---|---|---|
| 七包 build / tsc | ✅ 0 error | agent-api / admin-api / cloud-controller / controller-api / agent-controller / agent-web / admin-web |
| 单测 | ✅ **3310 passed / 1 skipped** | agent-api 724、admin-api 608+1 skip、cloud-controller 240、controller-api 432、agent-controller 571、agent-web 515、admin-web 220 |
| eslint | ✅ 0 error（6 既有 warning） | agent-web / admin-web |
| 关键回归用例 | ✅ | A-1 CAS 未命中回收、A-2 send/cancel 拒绝、A-3 终态锁+二次扫会话、A-9 回滚、B-1 STARTING 不撤销、B-2 owner 401、B-4 并发轮换单 active、B-5 越权铸造 404、C-1 mustFailure→failed、C-2 错误退出码、C-5 版本不一致重装、C-7 原子写、D-2 自动进入一次、D-3 显式 skip、D-4 只读真实断言 |
| tests/api | ⏸ 二轮复核实跑 | 需 Aspire 隔离栈；本轮改动仅测试显式跳过与断言/清理，未改服务契约 |
| E2E | ⏸ 二轮复核实跑 | D-4/D-11 已改为 `getByRole('textbox')` + 历史消息断言 + finally 清理 |
| 静态检查 | ✅ | `git diff --check` 0；tests 改动文件等效 `tsc --noEmit --strict` 0 |

## 七、最终验证

| 层级 | 首轮 | 返工后（`3627eda`） |
|---|---|---|
| tsc/build（7 包） | ✅ 0 error | ✅ 0 error |
| eslint（2 前端） | ✅ 0 error | ✅ 0 error（6 既有 warning） |
| 单测 | ⚠️ 3012 passed / 1 failed / 1 skipped | ✅ **3310 passed / 1 skipped**（基线 flaky 未复现） |
| tests/api（Aspire --isolated 实跑） | ✅ 37 passed / 1 skipped（5/5 文件） | ⏸ 待二轮复核复跑（改动仅测试断言/跳过/清理） |
| E2E | 二轮复核实跑 | ⏸ 待二轮复核复跑 |
| 合并预检 | ✅ CLEAN | ✅ 待二轮复跑（本轮基于 `origin/integration` 快进提交，无 release 侧回退） |

## 八、经验总结

1. **「记录可见」必须晚于或原子于「资源启动」**：A-1 的本质是把用户可操作（可停止）的状态暴露在编排未完成之前；凡「预创建记录→长耗时启动→回写句柄」的编排，回写必须 CAS 且失败即清理，stop 侧不得用过期快照决定销毁。
2. **「只读」必须在数据层/服务层收口，且测试 mock 形态必须与服务端真实响应一致**：D-1 的假绿正是 mock 了一个服务端不产生的状态；凡「UI 遮罩 + 服务端守卫」双层语义，测试必须对真实数据形态（含软删/过滤后）断言。
3. **拦截型守卫要按「写路径」清点而非按「入口」清点**：A-2 漏掉的恰是真正写入留档的 mutation；建议统一 `assertSessionWritable` 收口所有 `session:command` 发布路径。
4. **兜底任务（对账/巡检）的撤销条件必须放行合法中间态**：B-1 说明「非终态即异常」的兜底口径会误杀 STARTING 窗口；兜底线要与状态机的合法中间态逐一对表。
5. **失败路径的状态映射与退出码同样是验收面**：C-1/C-2 都是「成功路径严谨、失败路径随手」——PRD「失败则启动失败并给出原因」需要 FAILED+failureReason 与非零退出码共同兑现，且失败路径必须有测试锚定（否则如 `harness-lifecycle.test.ts` 把错误口径固化成预期）。
6. **测试文件的「跳过模式」是一致性契约**：D-3 的静默早退让安全断言消失于无形；无 env 时必须显式 skipped，验收证据才可信。

## 九、二轮 AI Review 复核（2026-10-21，返工提交 `3627eda`）

> 裁决：**打回（REJECT）**。首轮 2×🔴/7×🟠/27×🟡 的主体修复真实落地，但 **D-1 的修复是运行时不生效的死代码**——首轮 🔴 阻断缺陷在运行时原样存在且测试假绿换层重现；另有 3×🟠（tests/api 实跑红、E2E 实跑红、C-1 落库测试假绿、D-2 竞态，其中前两项为返工直接引入/从未跑绿）。

### 9.1 复核方法（不采信自报）

1. 逐条回读 `3627eda` 修复代码与测试：B/C 组、D 组、返工回归风险三路并行深度复核 + 主评对 A-1/A-2/A-3/B-1/C-1/D-1 六条首轮 🔴/🟠 逐条交叉回读源码。
2. **独立回归实跑**：七包 `vitest`/`build`/`eslint` 本机复跑；`git merge-tree --write-tree origin/release integration` 合并预检 + 交集文件逐行核对；Aspire `--isolated` 全新隔离栈（`HARNESS_ENABLED=true`、MONGODB_URI、`admin-initial-password`、`internal-api-token` 全量注入）实跑 tests/api 全量 32 文件与 E2E 云电脑套件。
3. **运行时实证**（非静态推理）：向隔离栈真实 agent-api 注入「软删云电脑 + ended 会话」fixture，直接调 `GET_SESSION` 验证 `controllerType/cloudHost` 实际返回值（R2-1 铁证）。

### 9.2 首轮问题复核结论（逐条）

| 首轮问题 | 二轮结论 | 证据要点 |
|---|---|---|
| A-1 create⇄stop 并发孤儿容器 | ✅ 已修复 | CAS 回写 + 未命中 `reclaimStartedContainer`（destroy+revoke）、stop 用 CAS 后快照销毁；主评交叉回读属实 |
| **D-1 软删只读失效 + 单测假绿** | ❌ **未修复（运行时不生效）** | **R2-1**：`sessionResolvers.Session` 未登记，字段运行时恒 null |
| A-2 sendSessionMessage 未拦只读 | ✅ 已修复 | `assertSessionWritable` 收口 send/cancel；setMode/setModel/setConfigOption 另有 `status!=='idling'` 门禁 |
| A-3 幽灵会话/终态无锁 | ✅ 已修复（残留窗口 🟡 R2-14） | `handleTerminal` 纳入 hostMutex、落库前复查 + 终态后二次 `endByController` |
| B-1 对账误杀 STARTING | ✅ 已修复 | `reconciliation.ts:533` 放行 `STARTING`；全部撤销路径逐条核查无误杀；用例回读 DB 断言 |
| C-1 启动失败丢原因 | ✅ 实现已修复（测试假绿 **R2-4**） | `harnessTerminalStatus(status, mustFailure)` → agent-api 落 FAILED+failureReason，链路逐环属实 |
| C-2 错误路径 exit(0) | ✅ 已修复 | `isFailureShutdownReason` 分流退出码，测试断言 exit 1/0；本地单连接模式回归不受影响 |
| D-2 自动进入会话 | ✅ 已修复（竞态 **R2-5**） | MainLayout STARTING→RUNNING 一次性导航（Set 防重）+ Sidebar 失败提示，用例断言导航次数 |
| D-3 静默假绿 | ✅ 该文件已修复（同类残留 🟡 R2-6） | `it.skipIf(!HAS_MONGO)` + 密钥不回显断言真实执行（本轮实跑确认） |
| 🟡×27 | ✅ 主体收口属实 | A 组 8 项、B 组 5 项、C 组 5 项、D 组 7 项逐条回读落地；B-7 三类边缘项仅测两类（R2-7）、D-6 断言反而与真实行为不符（R2-2） |

### 9.3 二轮新发现问题

#### R2-1（🔴 阻断）D-1 修复为死代码：`Session` 类型 resolver 未注册，运行时只读判定仍依赖会被软删破坏的 controllers 列表

- **问题描述**：返工在 `servers/agent-api/src/graphql/resolvers/session.ts:12-38` 新增 `sessionResolvers.Session.controllerType/cloudHost`，契约（`contracts/agent-session.graphql:201-209`）、schema（`graphql/schemas/session.ts:88-96`）、前端查询（`apps/agent-web/src/graphql/queries.ts:90-100`）、SessionView（`SessionView.tsx:420-428`）全部接线完成——**但 `servers/agent-api/src/graphql/resolvers/index.ts`（17-72 行）没有 `Session:` 类型键**，该 resolver 从未进入 `makeExecutableSchema` 的 resolver map（`src/index.ts:37`）。运行时字段走 GraphQL 默认解析器，而 `mapSession`（`services/session.ts:790-825`）不含它们 → **恒返回 null**。`servers/agent-api/AGENTS.md` 明文要求「新增类型级 resolver 必须登记 graphql/resolvers/index.ts，否则线上不生效」。
- **运行时实证（Aspire --isolated 隔离栈真实服务）**：注入「type=cloud 控制器 + 软删云电脑（`deletedAt` 非空）+ ended 会话」fixture 后以属主 token 调 `session(id:){ controllerType cloudHost { id status deletedAt } }`：
  - 实际返回 `{"controllerType":null,"cloudHost":null,"status":"ended"}`（期望 `controllerType:"cloud"`、`cloudHost:{deletedAt:...}`）；
  - 同时 `controllers` 查询返回 **0** 条（软删云电脑 Controller 被 `controllerService.findAllByUser` 过滤，`services/controller.ts:12-27`）。
  → `SessionView` 的 `isCloudSession = controllerType==='cloud' || sessionController?.type==='cloud'` 两侧皆空 → `readOnlyCloudHost=false` → **输入框与「继续」按钮重现**——首轮 🔴 D-1 的缺陷在运行时**原样存在**（GET_CONTROLLERS 加载完成前另有短暂可输入窗口）。
- **测试假绿换层重现（与首轮 D-1 同类）**：① `SessionView.cloudHost.test.tsx:45-46` mock 的 GET_SESSION 含 `controllerType/cloudHost`，与真实响应（恒 null）不符，正是首轮「mock 形态与服务端真实响应脱节」的翻版；② `resolvers/session.test.ts:66-107` 直接调用 resolver 函数，不校验注册；③ tests/api 与 tests/e2e **无任何用例查询 `session{controllerType cloudHost{…}}`**（全仓 grep 证实），E2E 只读 fixture 用非软删 cloudhosts（`cloud-host-readonly.spec.ts:73` `deletedAt:null`）恰好走 controllers 列表 fallback 照绿。
- **修复要求**：① `resolvers/index.ts` 登记 `Session: { ...sessionResolvers.Session }`；② 补 tests/api 集成用例：软删场景断言 `session{controllerType cloudHost{deletedAt}}` 真实返回值 + 只读入口消失（以真实 GraphQL 响应断言，mock 不得替代）；③ 单测改为断言真实响应形态或加注册锚点（如断言 `resolvers.Session` 已进入 schema）。

#### R2-2（🟠 重要）D-6 修复后的 tests/api 显式断言与服务端真实行为不符——返工把套件从绿改红

- **问题描述**：D-6 将 `tests/api/src/agent-api/cloud-host.test.ts:211-218` 从含糊断言改为显式断言「软删后 `homeOverview.controllers` **仍包含**该 Controller 且 `cloudHost` 为 null」。但服务端真实行为是**整条过滤**：`homeOverview.controllers` 复用 `controllerService.findAllByUser`（`graphql/resolvers/home.ts:51-57` → `services/controller.ts:12-27`，软删云电脑 Controller 被移除）。本轮实跑该用例 **failed**：`expect(offlined).toBeTruthy()` 收到 `undefined`。该断言同时与 D-1 修复叙述（「软删后 Controller 被列表过滤」）自相矛盾——两个「修复」对同一服务端行为的认知互相冲突，且没有任何一路实跑校验。
- **修复要求**：统一软删后的列表语义（建议维持「列表过滤 + 详情留档」）并把 D-6 断言改为与之匹配的真实形态（断言列表移除 + `session.cloudHost` 留档）；tests/api 须实跑绿后随修复提交。

#### R2-3（🟠 重要）新增 E2E `T-AW2..T-AW9` 选择器歧义，从未跑绿——PR 自带 E2E 证据不成立

- **问题描述**：`tests/e2e/src/cloud-host.spec.ts:60` `page.getByRole('button', { name: '工作区' })` 在页面上同时命中两个按钮：Sidebar 计数按钮「工作区 1」（标签+计数）与控制器配置页 nav tab「工作区」（`ControllerConfigPage.tsx:186-188`）→ Playwright strict mode violation，`toBeVisible()` 必然失败。本轮实跑 **1 failed / 2 passed**（`cloud-host-readonly.spec.ts` T-AW10 ✅、`cloud-host.spec.ts` T-AW3/T-AW5 ✅、T-AW2..T-AW9 ✘）。该用例覆盖「create→starting→stop→stopped→delete」主链路，作为交付物声称的「tests/e2e 2 套」之一，提交前从未跑绿；与 D-4/D-11 的「E2E 收口」声明共同说明返工的 E2E 未实际验证。
- **修复要求**：选择器改 `exact: true`/限定配置页容器/补 `data-testid`；修复后实跑全绿并把结果回填报告。

#### R2-4（🟠 重要）C-1 落库口径测试假绿：`$set` 载荷零断言 + `mustFailure` 传递无锚

- **问题描述**：C-1 实现链路（dispatcher `markMustFailure` → destroy 保留 `exitReason` → `harnessTerminalStatus(status, mustFailure)` → agent-api 落 FAILED+failureReason）主评逐环回读属实，但**唯一相关测试是回声 mock**：`cloud-host-service.test.ts:649-661` 把 `CloudHost.findOneAndUpdate` mock 成无条件返回预置 `{status:'FAILED',failureReason:'job failed'}` 文档再 `toMatchObject`——**从未断言 `$set` 写入内容**；target 映射回归成 STOPPED/null 也全绿。`container-service.test.ts:725-758` 亦从不断言 `container.mustFailure` 传入 `onDestroyed`，端到端口径没有任何单一测试锚定。首轮正是因「把错误口径固化为预期」打回 C-1，本轮修复又留下「口径无锚」的同类缺口。
- **修复要求**：断言 `findOneAndUpdate` 的 `$set`（失败路径 `status:'FAILED'`+`failureReason===reason`；非失败路径 `failureReason:null`）；补 `mustFailure` 传入 terminal 回调的断言或端到端用例。

#### R2-5（🟠 重要）D-2 自动进入竞态：`RUNNING` 与 `defaultSessionId` 两次落库间的快照永久丢失自动进入

- **问题描述**：`handleReadyLocked` 先 CAS `status:'RUNNING'`（`cloud-host-service.ts:495-499`）再写 `defaultSessionId`（:517-520）；两写之间若前端取到 HOME_OVERVIEW 快照，`MainLayout.tsx:51` 会记录 previousStatus=RUNNING 且因 `!defaultSessionId` 跳过导航，此后 `STARTING→RUNNING` 迁移条件恒假、永不补跳；Sidebar 同时短暂误报「默认会话创建失败，可手动创建会话」。窗口毫秒级 vs 15s 轮询，概率低但结果是静默丢失 PRD「自动进入」并误报失败。
- **修复要求**：ready 回调将 `status`+`defaultSessionId` 合并为一次原子更新；或前端对 `RUNNING && 单 Harness && !defaultSessionId` 延迟一拍再判定失败提示；补竞态用例。

#### 🟡 二轮建议项（10 项，随下次修复一并收口）

| # | 问题 | 位置 |
|---|---|---|
| R2-6 | 「静默早退」假绿模式残留 6 处（D-3 只改了 internal-api.test.ts 一个文件） | `tests/api/src/admin-api/billing-gateway.test.ts:83,157,165,184,233`、`tests/api/src/cloud-controller/billing-events.test.ts:70` |
| R2-7 | B-7 三类边缘项仅测两类：缺 scope 存量模型无断言，且与 `servers/agent-api/src/services/model.ts:9-11`（缺 scope 当 user 可用）口径分裂——用户列表可见但网关 404 | `billing-openai.ts:185-186,252,256` |
| R2-8 | B-7 账号 Key 分支未联查 provider：禁用供应商的 global 模型仍列出、调用 404，「列出即可调用」仅对 cloud_host 分支成立 | `billing-openai.ts:230-237` |
| R2-9 | D-4 只读 E2E 只构造 STOPPED 终态，未覆盖 `deletedAt != null` 软删形态——恰是 R2-1 破坏的场景无 E2E 网 | `tests/e2e/src/cloud-host-readonly.spec.ts:58-76` |
| R2-10 | D-6 软删语义无 DB 级断言（软删留档仅由 resolver mock 锚定） | `tests/api/src/agent-api/cloud-host.test.ts` |
| R2-11 | D-8 异常路径无测试（`mockRejectedValue` 后 catch+finally 复位未验证） | `StopCloudHostDialog.test.tsx` |
| R2-12 | B-4 并发用例判别力概率性（删掉 mutex 可能仍绿）、无用例锚定 `cloudHostKeyMutex` 持锁；锁为进程内，多副本仍会互撤（已文档化） | `api-key-service.test.ts:188-203`、`keyed-mutex.ts:4-7` |
| R2-13 | B-2/B-5 口径不对称：mint 路由对 admin_user 亦强制 `host.userId===ownerId`，网关豁免 admin_user——豁免用例绕过铸造路由造数，与真实路径不一致 | `internal-billing.ts:243`、`billing-key-auth.ts:73-76` |
| R2-14 | C-3 退避定时器 `unref`+disconnect 停心跳：极端情况下重连触发前进程自然 exit(0)，把「永久离线」换成「提前干净退出」；A-3 残留窗口为「落库前复查→insert」毫秒级竞态 | `socketio-client.ts:436`、`session.ts:234-247` |
| R2-15 | 断言强度/命名小缺口：B-5 越权用例只断 404 未断「拒绝时无 Key 落库」；C-7 temp 写失败清理分支未执行到；B-6 测试 ID 仍为 `T-MIG5-*`；B-3 缺 scope 存量 Key 保留无显式用例 | 多处 |

### 9.4 二轮独立验证数据（本机实跑，2026-10-21）

| 层级 | 结果 |
|---|---|
| tsc/build（7 包） | ✅ 0 error（agent-api / admin-api / cloud-controller / controller-api / agent-controller / agent-web / admin-web 全部 exit 0） |
| eslint（2 前端） | ✅ 0 error（6 条既有 react-hooks warning） |
| 单测（7 包） | ✅ **3310 passed / 1 skipped**（agent-api 724、admin-api 608+1 skip、cloud-controller 240、controller-api 432、agent-controller 571、agent-web 515、admin-web 220）——逐包与返工自报一致 |
| tests/api（Aspire `--isolated` 全新栈，32 文件全量） | ❌ **484 passed / 1 skipped / 1 failed**——唯一失败即 **R2-2**（D-6 断言与真实行为不符）。环境注记：首轮环境注入缺 `HARNESS_ENABLED`/MONGODB_URI 时出现的 48 skip/1 fail 属环境问题（已甄别），全量注入后为上述真实结果 |
| E2E（云电脑套件，Aspire 栈实跑） | ❌ **2 passed / 1 failed**——T-AW10 只读 ✅、T-AW3/T-AW5 校验错误 ✅、**T-AW2..T-AW9 ✘（R2-3 选择器歧义）** |
| 合并预检 | ✅ `git merge-tree --write-tree origin/release integration` CLEAN（tree `4518fc65`）；8 个交集文件（types.ts / admin-billing.graphql / billing-openai.openapi.yaml / billing-openai(.test).ts / reconciliation(.test).ts / settings-controller-config.spec.ts）逐行核对 **release 侧改动 0 缺失**，不回退 `36e62dd`/`d3782e8`/`eee53d6` 既有修复 |
| 运行时实证 | ✅ R2-1 探针（软删 fixture + 真实 `GET_SESSION`）复现字段恒 null，详见 9.3 |

### 9.5 打回要求（修复后重提 AI Review 三轮复核）

1. **必修（🔴）R2-1**：登记 `Session` 类型 resolver，按真实响应形态补集成/单测锚点，重跑「软删云电脑会话回看」全链路（服务端拒绝 + 前端无输入框/继续）。
2. **必修（🟠）R2-2 / R2-3**：D-6 断言改为与真实列表语义一致；E2E 选择器修复后实跑全绿——**tests/api 与 E2E 必须随修复实跑绿并回填数据**。
3. **必修（🟠）R2-4 / R2-5**：C-1 落库 `$set`/`mustFailure` 补断言锚点；ready 回调原子写或前端延迟判定 + 竞态用例。
4. 🟡 R2-6~R2-15 随修复一并收口（R2-6 静默早退残留建议全仓清零）。
5. 回归基线：七包 build/单测全绿 + tests/api 全绿 + E2E 云电脑套件全绿 + 合并预检 CLEAN，缺一不得进入下一轮。
