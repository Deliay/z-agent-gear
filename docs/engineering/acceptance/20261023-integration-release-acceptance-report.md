---
description: integration→release 集成验收报告（PR #273）——云容器优化一期/二期 + 工作流 GitHub PR 联动三特性集成验收闭环：首轮打回 3×🔴+7×🟠+28×🟡（第四节）；第二轮逐条复核返工提交 939936b：R-1/R-2/R-3/R-4/R-5/R-8/R-9/R-10 修复属实（含回退探针实证），但发现修复引入 1×🔴（N-1 R-9 锁内 hook 嵌套流转抛 re-entrant，restart(RUNNING) 会话兜底链路确定性失败并留死会话）+ 2×🟠（N-2 C-18 dirtyRef 永不复位且自报与代码不符、N-3 C-17 终态停轮询后重试冻结）+ 2×🟠 首轮问题未闭环（U-1 R-7 失败路径不回写 workspaceId、U-2 R-6 提案 §9/§8.1 残留与 v1.2 矛盾）+ 8×🟡 残留；独立验证 tsc×5/lint×2/单测五包 986/656+1skip/254/235/657/tests-e2e-typecheck/T-IC-EPH 全绿（不采信自报，含反证探针），Aspire 全栈 tests/api+tests/e2e 未跑，第二轮打回（REJECT）
type: Permanent
---

# integration→release 集成验收报告（2026-10-23，AI Review）

> **状态**: ❌ **第二轮打回（REJECT）**——返工提交 `939936b`+`051cabf` 对首轮 3×🔴+7×🟠+28×🟡 的修复经逐条复核：**8 项属实**（R-1/R-2/R-3 断言侧/R-4/R-5/R-8/R-9 主体/R-10，均经回退探针或反证实证有区分力），但**修复引入 1×🔴 + 2×🟠 新问题**（🔴 N-1：R-9 把 KeyedMutex 下沉 `engine.transition` 后，引擎 hook 在锁内 `sessionService.close` 同步触发 `handleSessionEnded` 兜底链路，restart（RUNNING 节点重启，恰是「会话卡住」主场景）必误触发——fallbackSent=true 时嵌套 `transition('fail')` 抛 `KeyedMutex re-entrant lock detected` 整个重启失败并留死会话、false 时复活幽灵会话并发兜底提示词，已做引擎级最小复现；🟠 N-2：C-18 `dirtyRef` 保存成功不清除（自报「保存成功清除 dirty」与代码不符）；🟠 N-3：C-17 `pollStopped` 终态后不复位，重试/重新设置后进度框冻结），**2 项首轮 🟠 未闭环**（🟠 U-1：R-7 仅成功路径回写 `workspaceId`，失败路径不回写，恰是契约声称要区分的「默认会话创建失败」场景；🟠 U-2：R-6 方案②要求「修订 PRD/提案如实收窄」，提案 §9 验收项/§8.1/风险点仍写「立即失效」与 v1.2 TTL 口径矛盾），另有 8×🟡 残留（AppHost.cs stale 注释、C-22 断言允许 0/负、C-24 e2e 侧无哨兵、C-26 文档端口 stale 等）。**按节点定义立即打回**：修复 N-1~N-3、闭环 U-1/U-2、清理 🟡 残留，并以 Aspire 全栈实跑 tests/api 全量 + tests/e2e 随修复一并提交证据（两轮均未执行）。详见[第九节](#九第二轮验收记录2026-10-23)。
>
> 首轮背景（已修复项详见[第四节](#四验收问题清单)与[第八节](#八返工修复记录2026-10-23-第二轮)）：首轮对 `git diff origin/release...integration`（32 提交 / 167 文件 / +14794 −332，含云容器优化一期、二期、工作流 GitHub PR 联动三特性）做集成级代码评审 + 本机独立验证，发现 3 × 🔴 + 7 × 🟠 + 28 × 🟡 并打回。

## 关联文档

- PRD：`docs/product/draft/20261022-cloud-container-optimization-phase1.md`（v1.1）、`docs/product/draft/20261023-cloud-container-optimization-phase2.md`（v1.2）、`docs/product/draft/20261023-workflow-github-pr-callback.md`
- 技术方案：`docs/engineering/proposals/20261022-feat-cloud-container-optimization-phase1.md`、`20261023-feat-cloud-container-optimization-phase2.md`、`20261023-feat-workflow-github-pr-callback.md`
- 实现计划：`docs/engineering/plan/20261022-feat-cloud-container-optimization-phase1.md`、`20261023-feat-cloud-container-optimization-phase2.md`、`20261023-feat-workflow-github-pr-callback.md`
- 分支：`integration` @ `e129894`（= `origin/main`），目标分支 `release`；PR #273 `OPEN / MERGEABLE / CLEAN`（integration→release，"Integration branch reset to latest main"）
- 上游产物：① 节点「切出集成分支」——integration 重置基线 `origin/main @ e129894`、PR #273 创建完成；② 节点「修复Review意见」——核查 PR #273 无人类 Review 意见（reviews/行内评论/issue comments 均 0 条，`rejectInfo` 为空）→ 本轮为**集成级首次 AI 代码评审**
- 验收方式：AI 代码评审（`git diff origin/release...integration`）+ 4 域并行深度评审（① agent-api workflow PR 联动链路；② agent-api/admin-api/cloud-controller 后端；③ admin-web/agent-web 前端；④ contracts + tests/api + tests/e2e + docs）+ 主评对全部 🔴/🟠 逐条回读源码复核 + **本机独立验证**（tsc/lint/单测五包复跑、tests/e2e typecheck、tests/api 套件实跑；不采信自报）
- 验收日期：2026-10-23

## 一、验收范围与方法

### 1.1 变更范围

| 特性 | 内容 | 主要落点 |
|---|---|---|
| 云容器优化一期 | 默认 MCP 注入（`defaultMcp`/`useAllEnabled`/子集、平台云工具排除）、ACP 选项缓存 300s + 手动刷新/失效、新建会话前置选择 modeId/modelId、云电脑创建与 GitHub 项目准备开关、cloudHost 查询 | `servers/agent-api/src/services/{session,controller,model,acp-options-cache}.ts`、`graphql/*`、`apps/agent-web/src/components/{session,settings,cloud-host}` |
| 云容器优化二期 | 创建期不再预置默认工作区（`workspaceId` 改为可空、就绪不自动建会话）、后台模型最长上下文（`contextLength` 经 OpenAI 兼容 `/v1/models` `context_length` 下发）、云电脑模板 ephemeral-storage 10Gi 硬上限（仅 limits） | `servers/{agent-api,admin-api,cloud-controller}`、`apps/admin-web/src/components/models`、`deploy/k8s/cloud-controller.yaml` |
| 工作流 GitHub PR 联动 | `linkUpstreamPullRequest` 节点标记 + `pullRequestLinks` 登记、`additionalPrompts` 系统/用户提示词、`/api/event-callback`（HMAC/Bearer 双鉴权）驱动 HUMAN 节点 approved→complete / rejected→reject、迁移 007 索引 | `servers/agent-api/src/services/workflow/pr-*`、`routes/event-callback.ts`、`models/workflow-pr-handler.ts`、`contracts/{event-callback.openapi.yaml,workflow.graphql}` |
| 契约/测试/文档 | 7 个契约文件变更、tests/api 新增 workflow-pr-callback 等 8 个套件（+1028 行单文件）、tests/e2e 6 个 spec 扩写 + 新增 typecheck、PRD/提案/计划与 AGENTS.md 索引 | `contracts/`、`tests/`、`docs/` |

### 1.2 评审与验证方法

1. **四域并行深度代码评审**（逐文件通读）：workflow PR 联动链路 / 三后端 / 双前端 / contracts+tests+docs，各域对照 PRD 与技术方案逐条核对验收标准。
2. **主评交叉复核**：全部 🔴/🟠 由主评回读源码逐条确认（R-1~R-9 均附 file:line 证据；R-2/R-3 另有实跑红证）。
3. **本机独立验证**：五包 `tsc`/`eslint`/单测复跑、`tests/e2e` typecheck、`tests/api` 套件实跑。**不采信自报数据**。
4. **反向对照**：`release..integration` 32 提交逐条归属三特性；`git show origin/release` 对照确认存量行为边界。
5. **安全扫描**：回调路由鉴权（默认拒绝、timing-safe、raw-bytes HMAC）、prompt 注入面、秘密硬编码、XSS sink 扫描（见 [第三节](#三已验证-)\)。

### 1.3 判定红线（与历轮一致）

- 🔴 阻断 / 🟠 重要 → **打回返工**（本轮命中 3 × 🔴 + 7 × 🟠）
- 🟡 建议 → 记录并随修复项一并收口，不单独构成打回

## 二、独立验证结果（本机实跑，不采信自报）

| 服务/包 | 类型检查 | Lint | 测试 | 备注 |
|---|---|---|---|---|
| servers/agent-api | ✅ `tsc --noEmit` 0 | — | ✅ **976 passed**（70 文件） | 含 pr-event-handler/pr-handler-registry/pr-prompts/tool-handlers/instance/engine 新增单测 |
| servers/admin-api | ✅ 0 | — | ✅ **656 passed / 1 skipped**（64 文件） | 含 contextLength 校验与 resolver 用例 |
| servers/cloud-controller | ✅ 0 | — | ✅ **254 passed**（18 文件） | 含 k8s-job-manager limits-only 断言（T-K5b） |
| apps/admin-web | ✅ `tsc -b` 0 | ✅ 0 error | ✅ **234 passed**（29 文件） | 含 ModelSection/CustomModelDialog contextLength 用例 |
| apps/agent-web | ✅ `tsc -b` 0 | ✅ 0 error | ✅ **654 passed**（68 文件） | 含 NewSessionDialog 9 参位置契约、Sidebar、useCloudHostProvisioning 等用例 |
| **tests/e2e typecheck** | ❌ **3 error（TS18047）** | — | — | **本 diff 新增 `tsconfig.json` + `npm run typecheck` 门禁，对本 diff 新增的 `src/workflow.spec.ts` 报 3 处 `'…' is possibly 'null'`（:645 `execNode` / :2471 `promptText` / :2504 `inst`）→ 🔴 R-2** |
| tests/api（套件实跑） | — | — | ⚠️ 35 failed / 77 passed / 436 skipped | 33 例为缺实栈/缺环境变量的「缺参即红」「fetch failed」型环境失败（workflow/workspace/session 等套件需活服务）；**T-IC-EPH1/2 为确定性红**（`TypeError: Cannot read properties of undefined (reading 'ephemeral-storage')`，纯 buildManifest 单测、无环境依赖）→ 🔴 R-3 |

> 说明：首轮单测并行复跑时 admin-api 1 例（billing review-fixes 1001 笔灌数）、admin-web 1 例、agent-web 3 例出现 5s/60s 超时，串行复跑**全部转绿**（656/234/654），确认为并发资源争抢所致的环境抖动，不计入问题清单。

## 三、已验证（✅）

| 项目 | 结果 | 证据 |
|---|---|---|
| 回调路由鉴权 | ✅ | 未配置 secret 时默认拒绝 401；`X-Event-Token` timing-safe 比较；HMAC 对 raw bytes（router 先于 `express.json()` 挂载，`index.ts:39-42`）；不落日志敏感信息；1MB body 上限；非 JSON → 400 |
| 契约一致性（workflow） | ✅ | `contracts/workflow.graphql` ↔ `schemas/workflow.ts` ↔ resolvers 逐字段对齐；`linkUpstreamPullRequest` 仅 HUMAN 可写、三层透传；`contracts/event-callback.openapi.yaml` 的 reason 枚举与实现一一对应 |
| 状态机流转 | ✅ | 事件驱动复用 `completeHumanNode`/`rejectNode`（含 READY→start 组合）；REJECT→上游 REWORK→`completeRework`→恢复闭环与 `TRANSITIONS` 一致；`finishedAt` 单次写入、级联单触发有单测锁定 |
| 生命周期注销 | ✅ | 工作流完成/归档/删除三路 `unregister`；`onWorkflowFinished` hook 合并不覆盖 orchestrator hook |
| Prompt 键卫生与去重 | ✅ | `assertUserPromptKey` 拦截 `.`/`$` 键注入；系统键与用户键双向隔离有单测；`readAdditionalPrompts` 排序去重 |
| `linkPullRequest` 作用域 | ✅ | workflowId/nodeId 必须匹配 token 作用域；实例删除/归档/完成态拒绝；PR id 归一化错误映射 `INVALID_PARAMS` |
| 默认 MCP 解析 | ✅ | 显式 `[]`=不注入、缺省=控制器默认、`useAllEnabled`=动态全量、子集剔除停用项、平台云工具仅云会话合并、工作流节点会话不受影响（`session.ts:28-51,176-198`） |
| 缓存 TTL 与键格式 | ✅ | 300s（失败 60s）与 PRD「分钟级」一致；`acp:options:<controllerId>:<serverType>` 写（controller-api）读删（agent-api）两侧一致；SCAN 批删、分页失败隔离 |
| contextLength 全链路 | ✅ | 校验拒绝 0/负/浮点/字符串（admin `services/model.ts:53-62`）；`/v1/models` 未设不输出、设置输出 `>=1`（account 与 cloud_host 双 key）；OpenAPI `integer, minimum: 1` 一致；agent-api 只读镜像 |
| ephemeral-storage 实现 | ✅ | 仅 `limits`、默认 `10Gi`、`JOB_EPHEMERAL_STORAGE` 覆盖、三处部署面（AppHost/docker-compose/cloud-controller.yaml）齐备、存量不追溯（**注释残留见 R-3**） |
| 开关默认值与竞态 | ✅ | `createDefaultSession`/`createSession` 缺省 true、legacy 行按 `!== false` 归一；STARTING 窗口建会话并入 CAS；`defaultSessionId` 回填 CAS + catch 兜底 |
| 鉴权（新增 GraphQL） | ✅ | `updateModelContextLength`/`createGlobalCustomModel` 均 `assertAdmin` 首行；`refreshAcpServerOptions`/`setControllerDefaultMcp`/`cloudHost`/`Controller.defaultMcp` 按 userId 作用域；非法 id 短路 null |
| 前端 GraphQL 一致性 | ✅ | 双前端 `graphql/*` 变量类型与契约逐字段对齐；`mcpServerIds` null-vs-`[]` 语义两调用点一致；`loading && !data` 轮询不卸载表单；列表 key 稳定 |
| T-PR 套件真实性 | ✅ | `tests/api/src/agent-api/workflow-pr-callback.test.ts`（T-PR1~18）为真实 GraphQL + WS fake controller + MCP relay 黑盒断言，含负路径与 PRD 附录 A 文案逐字断言；单测 pr-event-handler 断言调用序（非同义反复） |
| 秘密与 XSS | ✅ | 全量新增行无硬编码凭据（`sk-test-fake-key` 等均为 fake）、无 `dangerouslySetInnerHTML`/`innerHTML` sink、无敏感日志、无 TODO 残留 |

## 四、验收问题清单

### R-1（🔴）`SessionPage.handleCreateSession` 位置参数错位：所选「模式」被当 `modelId` 提交，所选「模型」被丢弃

- **问题描述**：`apps/agent-web/src/components/session/NewSessionDialog.tsx:274-285` 以 **9 个位置参数**回调 `onCreate`（…, `mcpServerIds`, `existingWorktreePath`, `modeId`, `modelId`）；`apps/agent-web/src/pages/SessionPage.tsx:19-28` 的处理器只声明 **8 个参数**（缺 `existingWorktreePath`），导致 arg#7（`existingWorktreePath`）落入 `modeId`、arg#8（真实 `modeId`）落入 `modelId`、arg#9（`modelId`）被丢弃，最终 `SessionPage.tsx:40-41` 提交 `modeId: null, modelId: <mode-id>`。**在 `/sessions` 页面「新建会话」里选模式 = 把模式 id 当模型 id 建会话；选模型 = 完全不生效**。`Sidebar.tsx:124-152` 的 9 参实现是正确参照。
- **根因分析**：`apps/agent-web/AGENTS.md:59` 声称「`onCreate` 在既有 7 个位置参数后追加 `modeId?/modelId?`，`Sidebar` 与 `SessionPage` 两个调用点同步透传」——签名演进采用位置参数却漏改一个调用点，且 AGENTS.md 描述与实际（3 个调用点、含 `existingWorktreePath` 共 9 参）均不符；`NewSessionDialog.test.tsx` 钉住了 9 位契约，但 `SessionPage` 无任何测试。
- **修复方案**：① `SessionPage.handleCreateSession` 补第 7 参 `existingWorktreePath?: string`，并在 mutation input 中透传 `existingWorktreePath: existingWorktreePath || null`（对齐 `Sidebar.tsx:136-152`）；② 建议把 `onCreate` 改为对象参数（或导出共享类型）从根上消除位置错位；③ 补 `SessionPage` 单测断言 `modeId/modelId/existingWorktreePath` 三者映射；④ 修正 `apps/agent-web/AGENTS.md:59` 的调用点与签名描述。
- **验证结果**：待第二轮复核实测（回退探针：去掉第 7 参应使新单测红）。

### R-2（🔴）本 diff 新增的 `tests/e2e` typecheck 门禁对本 diff 新代码报 3 个 TS18047，门禁自身不过

- **问题描述**：本 diff 新增 `tests/e2e/tsconfig.json` 与 `npm run typecheck`（严格模式门禁），实跑 `npm run typecheck` **exit=2**：`src/workflow.spec.ts:645`（`'execNode' is possibly 'null'`）、`:2471`（`'promptText'`）、`:2504`（`'inst'`）。三处**全部位于本 diff 新增的 PR 联动 E2E 段**（`startPrExec`、github-pr prompt 断言、after 节点断言）。
- **根因分析**：新增门禁未在合入前自检通过，违反 `docs/engineering/common-rules.md`「All code must pass TypeScript strict mode checks」；`waitFor(...)` 返回可空值后未做非空收敛即 `.match`/`.nodes` 访问。
- **修复方案**：① 三处补非空收敛（`!` 断言 + 前置 `expect(x).toBeTruthy()`，或 `waitFor` 泛型返回非空重载）；② 修复后 `npm run typecheck` 必须 exit=0；③ 后续 PR 将 `tests/e2e typecheck` 纳入自检清单。
- **验证结果**：待第二轮复核实测。

### R-3（🔴）T-IC-EPH1/2 断言 `resources.requests`，而实现只声明 `limits`——两条用例确定性失败且与 PRD/单测/E2E 三方矛盾

- **问题描述**：`tests/api/src/cloud-controller/internal-api.test.ts:669-678` 断言 `resources.requests['ephemeral-storage']` 为 `10Gi`/`5Gi`；而 `servers/cloud-controller/src/services/k8s-job-manager.ts:144-149` 只输出 `resources.limits`（`requests` 为 `undefined`）。实跑 `TypeError: Cannot read properties of undefined (reading 'ephemeral-storage')`，**两条用例必红**（纯 buildManifest 单测，无环境依赖）。同时与 PRD v1.2 功能点 3 验收「**不设置 requests**」（`docs/product/draft/20261023-cloud-container-optimization-phase2.md:91`）、单测 `k8s-job-manager.test.ts:93`（`limits` 精确断言）、E2E `tests/e2e/src/admin-cloud-container.spec.ts:524`（`expect(resources.requests).toBeUndefined()`）三方矛盾。
- **根因分析**：测试与注释写于「requests=limits」旧口径，v1.2 修订为「仅 limits」后未回归对齐；`k8s-job-manager.ts:90` JSDoc 与 `deploy/k8s/cloud-controller.yaml:108` 注释至今仍写「requests=limits」，是错误口径的源头。
- **修复方案**：① 改写 T-IC-EPH1/2：断言 `resources.requests` 为 `undefined`、`limits['ephemeral-storage']` 为 `10Gi`/`5Gi`（标题同步改「仅 limits」）；② 修正 `k8s-job-manager.ts:90`、`cloud-controller.yaml:108` 两处注释为「仅 limits（不设 requests），默认 10Gi」；③ 复跑 `tests/api` cloud-controller 套件转绿。
- **验证结果**：待第二轮复核实测。

### R-4（🟠）`WorktreeSidebarGroup` 静默丢弃 `modeId`/`modelId`：worktree 预选建会话不带上用户所选模式/模型

- **问题描述**：`apps/agent-web/src/components/worktree/WorktreeSidebarGroup.tsx:31` 的 `onCreate` prop 类型与 `:174-176` 的转发 wrapper 都只声明/透传 **7 个参数**（止于 `existingWorktreePath`），`NewSessionDialog` 传入的 `modeId`/`modelId` 在 wrapper 处被丢弃。该路径是「预选 worktree 建会话」的唯一入口（`existingWorktreePath={newSessionWorktreePath}`、`isPreselected`），用户在对话框里选的模式/模型**界面显示已生效但从未到达 `createSession`**。
- **根因分析**：prop 签名未随 `onCreate` 9 参演进同步扩展（与 R-1 同源：位置参数 API 演进无编译期保障）。
- **修复方案**：prop 类型与 wrapper 均扩到 9 参并透传 `modeId`/`modelId`（`existingWorktreePath` 保留 `?? newSessionWorktreePath` 回退）；补 `WorktreeSidebarGroup.test.tsx` 透传断言。建议与 R-1 一并改为对象参数。
- **验证结果**：待第二轮复核实测。

### R-5（🟠）E2E 与 phase2 语义脱节：旧文案断言必红、P10-CH1 断言已过时且 spec 自相矛盾

- **问题描述**：① `tests/e2e/src/cloud-host.spec.ts:74`、`:466` 断言 `getByText('将自动创建会话')` 可见，而 `NewCloudHostDialog.tsx:328` 已改为「就绪后不会自动创建会话，需先创建或绑定工作区」（新文案不含旧子串），同文件 `:184` 又断言旧文案 `toHaveCount(0)`——**同一 spec 对同一文案断言相反**；② P10-CH1（`:453`，断言 `:487-495`）仍要求 ready 回调后自动创建默认会话（`defaultSessionId` truthy、`sessions === 1`），而 phase2 后端在 `workspaceId` 为 null 时**跳过**默认会话（`cloud-host-service.ts:563-588`），phase2 新用例（`:194,:218`）已断言 `defaultSessionId` 为 null。
- **根因分析**：phase2（`d01b3d0`/`cdd06ff`）改行为与文案时只更新新增的 phase2 段，未回归既有断言段与 phase1 P10 段。
- **修复方案**：① `:74`/`:466` 改断言新提示文案；② P10-CH1 重写为 phase2 语义（不预置默认工作区 → 就绪后无默认会话，或先建工作区再触发 ready），或删除并由 phase2 段覆盖；③ 同一文案只保留一处权威断言。
- **验证结果**：待第二轮复核实测。

### R-6（🟠）后台（global）模型变更不失效 ACP 选项缓存——违反 phase1 提案与 PRD「立即失效」

- **问题描述**：PRD v1.1 明确「模型库新增/启用/禁用/删除后**立即失效重取**、重新打开选择器即为最新选项」（`20261022-...phase1.md:13,97,164`），提案失效策略表要求「用户级模型变更删该用户全部控制器的 key；**系统内置模型变更删全部用户的 key**」（提案 :286,:389）。实现侧 `servers/admin-api` **零处**调用失效（grep `acp:options|invalidate` 0 命中），agent-api 仅用户级模型 mutation 失效当前用户（`graphql/resolvers/model.ts:47,69,88`）；`acp-options-cache.ts:48` 注释自认「系统内置模型的全局变更由 5 分钟 TTL 兜底」。global 模型进入每个用户的 `/v1/models`（`billing-openai.ts:355-390`），后台增删/启停后用户最长 5 分钟拿到陈旧选项。
- **根因分析**：跨服务失效钩子被有意裁剪为 TTL 兜底，但未回写 PRD/提案 → 与已批准 spec 无声偏离（PRD 验收勾选项 `- [ ]` 亦未落）。
- **修复方案**（二选一，需回写文档）：① **对齐 spec**：admin-api 模型 mutation 成功后对共享 Redis SCAN 删除 `acp:options:*`（或发失效事件由 agent-api 消费），补「模型变更→选项立即失效」API 用例（R-21）；② **修订 PRD/提案**：如实收窄为「系统内置模型变更 5 分钟 TTL 兜底」并注明取舍。无论哪条，`updateModelSortOrder` 的失效口径一并对齐（见 C-10）。
- **验证结果**：待第二轮复核实测。

### R-7（🟠）`hasDefaultWorkspace` 语义失效：新云电脑恒 `false`，「默认会话创建失败」提示永不可达

- **问题描述**：契约注释定义「是否已创建默认工作区（workspaceId != null）；用于区分『未创建工作区』与『默认会话创建失败』」（`contracts/cloud-host.graphql:47-48`）。但 phase2 后创建期 `workspaceId` 恒落 `null`（`cloud-host-service.ts:220-246`），**全仓无任何后续写入**——「Git 项目设置」创建默认工作区后只回填 `defaultSessionId`（`cloud-host-github-service.ts:344-365`），从不写 `workspaceId`。结果：① 新云电脑 `hasDefaultWorkspace` 永远 `false`，`Sidebar.tsx:262-272` 的「默认会话创建失败」分支（要求 `hasDefaultWorkspace !== false`）**不可达**；② Git 设置创建默认工作区后，`defaultWorkspace()` 仍回退配置默认值 `/root/workspace`（`cloud-host-service.ts:712-717`），与 PRD 功能点 1「默认工作区只在 Git 项目设置时按前缀创建」的语义不一致。
- **根因分析**：phase2 把 `workspaceId` 改为「创建期一次性值」，但字段语义仍是「当前是否有默认工作区」，且新流程没有写入方。
- **修复方案**（二选一）：① workspace 创建/绑定时 CAS 回写 `CloudHost.workspaceId`（`runSessionStep` 的 `ensureWorkspace` 之后、手动建工作区路径同样处理）；② 重定义字段为读取期计算（如「已创建工作区数 > 0」）并同步改契约注释与 `defaultWorkspace()` 回退逻辑。补「Git 项目设置后 `hasDefaultWorkspace` 翻转」的测试。
- **验证结果**：待第二轮复核实测。

### R-8（🟠）PR 事件幂等是 TOCTOU：并发重复投递不能得到 `DUPLICATE_EVENT`，误报 `HANDLER_FAILED`

- **问题描述**：`pr-event-handler.ts:248-252` 在锁外一次性拉取 handler 快照传入锁内 `processHandler`（`:259-261`），幂等判断 `handler.lastEventId === event.eventId`（`:178`）用的是**陈旧快照**。同一 `eventId` 并发重复投递时两次都看到 `lastEventId=null`，第二次在 `completeHumanNode` 处被状态机 `from` 守卫抛错，以 `HANDLER_FAILED` 收场（`:271-277`），违反 `contracts/event-callback.openapi.yaml`「重复…安全忽略…可追溯原因」与 PRD 3.5「同一 review 事件重复投递｜幂等」。当前正确性依赖状态机兜底而非幂等机制本身。
- **根因分析**：去重读（`findByPullRequestId`）与标记写（`markEventHandled`）不是原子 claim，且读发生在互斥锁之外。
- **修复方案**：在 `instanceMutex.runExclusive` 内重读 handler 行再做去重判断；或改为原子 claim（`findOneAndUpdate({_id, lastEventId: {$ne: eventId}}, {$set:{lastEventId: eventId}})`，胜者驱动流转）；补并发重复投递用例（同一 eventId 连发两次，断言恰一次 `COMPLETE_HUMAN_NODE`、一次 `DUPLICATE_EVENT`、无 `HANDLER_FAILED`）。
- **验证结果**：待第二轮复核实测。

### R-9（🟠）事件驱动流转与人工流转不互斥，违反提案实现点 5 明确要求

- **问题描述**：提案实现点 5 要求「`completeHumanNode`…必须与人工操作互斥（串行化）」。实现的 `KeyedMutex` 只覆盖**事件路径**（`pr-event-handler.ts:259`），GraphQL `completeHumanNode`/`rejectNode`/`updateNode`（`instance.ts:502-545`）与 MCP `callWorkflowTool` 流转无锁；`engine.transition` 是 `findById → mutate → save()` 读-改-写（`engine.ts:151-172`，`complete` 还在级联中途 `save()` `:217`）。人工完成与 webhook 完成并发时可互覆节点更新或双触发级联（`onNodeStart` 拉起会话是不可回滚副作用）。
- **根因分析**：锁放在传输层而非领域入口；单实例部署下当前触发概率低，但互斥是提案明文验收点。
- **修复方案**：把按 `instanceId` 的 `KeyedMutex` 提升到 `workflowInstanceService.completeHumanNode/rejectNode/updateNode`（或 `workflowEngine.transition`）统一持有；补并发用例（事件完成 + 人工完成同节点并发，断言恰一次级联）；并在文档注明单实例假设。
- **验证结果**：待第二轮复核实测。

### R-10（🟠）`CustomModelDialog` 编辑中表单被父组件重渲染重置（含新的「最长上下文」输入）

- **问题描述**：`apps/admin-web/src/components/models/CustomModelDialog.tsx:59-69` 的重置 effect 依赖 `[open, providers, model]`，而 `ModelSection.tsx:211-213` 的 `enabledProviders` 每次渲染新建数组（未 memo）→ 弹窗打开期间父组件任何重渲染（`refetchQueries` 落地、toast effect 等）都会触发 effect 重跑，把用户在填的 `name`/`contextLength` 重置回初值。编辑模式下静默丢失已输入的上下文长度。
- **根因分析**：effect 依赖不稳定派生数组而非稳定标识。
- **修复方案**：`enabledProviders` 用 `useMemo`（依赖 `providersData`）；重置 effect 改 `[open, model?.id]` 驱动；补「弹窗打开期间父级重渲染不重置表单」单测。
- **验证结果**：待第二轮复核实测。

### C 组（🟡 建议，随本轮修复一并收口，不单独构成打回）

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| C-1 | registry 合并让内存索引行覆盖 DB 行，已删登记可「复活」（多副本/rebuild 后） | `pr-handler-registry.ts:179-186` | DB 优先合并或去掉内存索引（集合很小） |
| C-2 | 大小写不敏感 regex 查询绕过 `pullRequestId` 索引，事件入口全表扫描 | `pr-handler-registry.ts:173-177`、迁移 007 | 写入时归一化小写字段并索引精确匹配（或 collation） |
| C-3 | approved 分支先写 system prompt 后 `completeHumanNode`，部分失败留脏 prompt；`markEventHandled` 失败误报 `HANDLER_FAILED` | `pr-event-handler.ts:194-227` | 完成成功后再写 prompt（失败 `$unset` 回滚）；`markEventHandled` 失败单独归类 |
| C-4 | 事件载荷字段未限长/未校验：`prUrl` 不核对登记值、`reviewer`/`prUrl` 无长度上限（prompt/黑板膨胀面） | `pr-prompts.ts:42-54` | 优先用登记的 `handler.prUrl`，三字段限长 |
| C-5 | 空 `X-Event-Token` 头遮蔽有效 `Authorization: Bearer`（`??` 不跳空串） | `routes/event-callback.ts:30-31` | 改 `\|\|` 或过滤空串 |
| C-6 | `register()` delete-then-upsert 并发可双存活，违反「以最后一次为准」 | `pr-handler-registry.ts:122-160` | 同锁内执行或单次有序 upsert |
| C-7 | `linkPullRequest` 与提案 §3.1 的 required/错误码（`INVALID_ARGUMENT`）不一致 | `tool-handlers.ts:351-402`、提案 | 回写提案与实现对齐（实现符合 PRD） |
| C-8 | 并行分支下事件不驱动（`CURRENT_NODE_AMBIGUOUS`）、REWORK 态人类节点不驱动，口径未记录 | `pr-event-handler.ts:112-120` | PRD 记录口径，或放宽为「唯一 HUMAN 节点 + 链接校验」 |
| C-9 | `refreshAcpServerOptions` del→重探无 fencing，可能返回陈旧探测结果；del 失败静默回退缓存 | `session.ts:858-876` | 读侧按 `probedAt` 过滤刷新前结果；del 失败显式报错 |
| C-10 | `invalidateAcpOptionsForController` 死代码；`updateModelSortOrder` 不失效但 AGENTS.md 宣称失效 | `acp-options-cache.ts:42`、`graphql/resolvers/model.ts:94-107` | 接线或删除；AGENTS.md 对齐 |
| C-11 | `setControllerDefaultMcp` 隐式排除平台云工具却报 `MCP_SERVER_NOT_FOUND`，读写口径不一致、契约未记录 | `controller.ts:138`、`agent-controller.graphql:88-90` | 契约补注、专用错误文案、显示过滤与保存校验同口径 |
| C-12 | `updateModelContextLength` 缺省即清空，与契约「传 null 表示清空」不符 | `admin-llm.graphql:150-152` | 改「缺省或 null 均清空」或缺省 no-op |
| C-13 | 测试 ID 重复 `T-CHG-P1b`、个别 `it(...)` 合并行格式残留 | `cloud-host-github-service.test.ts:299,336` 等 | 重编号、格式整理 |
| C-14 | `session.test.ts` 缺 `refreshAcpServerOptions` 服务层覆盖（del→重探链路、del 失败、Controller not found） | `servers/agent-api/src/services/session.test.ts` | 补服务层单测 |
| C-15 | 文案「新 MCP 上线后自动注入」与实现（提交快照数组）不符；停用服务仍随显式数组提交 | `NewSessionDialog.tsx:546-548,231-242` | `useAllEnabled` 且用户未改动时不传 `mcpServerIds`，或改文案 |
| C-16 | workspaces refetch 触发 effect 重置 Worktree 开关/分支后缀（违反「刷新不打断已填内容」） | `NewSessionDialog.tsx:248-269` | effect 只依赖 `selectedWorkspace/selectedController`；`branchSuffix` 用户已编辑不覆盖 |
| C-17 | `GithubSetupProgressDialog`：`refetchHome` 未捕获 rejection、终态后 1.5s 轮询不停、「重新创建」不删不重建（文案过度承诺） | `GithubSetupProgressDialog.tsx:127-142,183-189,333-343` | 补 catch、终态停轮询、按钮语义与文案对齐 |
| C-18 | `McpDefaultSection` 未保存编辑被 controller 数据刷新覆盖 | `McpDefaultSection.tsx:68-74` | 仅 `controller.id` 变化时同步，或 dirty 期间跳过 |
| C-19 | 会话创建失败静默（仅 `console.error`），弹窗先关、所选 MCP/模式/模型全丢 | `Sidebar.tsx:157-159`、`SessionPage.tsx:49-51` | `toast.error` + 成功才关弹窗（`onCreate` 返回 Promise） |
| C-20 | PR 徽标在 `prUrl` 为空时渲染无 `href` 的 `<a>`（a11y 死元素） | `WorkflowNodeTree.tsx:236-249` | 无链接时渲染 `<span>` |
| C-21 | PRD 验收项缺覆盖：模型变更→选项立即失效、工作流节点配置处「刷新」按钮、磁盘超限终止/同节点隔离/存量不受影响（phase2 功能点 3）等 | `tests/api`、`tests/e2e`、plan 验收段 | 补 API 可测部分；集群侧项在 plan 登记人工验收项 |
| C-22 | 契约字段 `llm.graphql Model.contextLength`（用户侧）零测试 | `tests/api/src/agent-api/llm.test.ts` | 补「admin 设置→前台可见、未设为 null」断言 |
| C-23 | P10-CH3「可重试」断言在点击前即成立，验证不了重试生效 | `tests/e2e/src/cloud-host.spec.ts:596-600` | 点击后断言操作重新进入 RUNNING/新 `updatedAt` |
| C-24 | PR 联动用例缺参即整段 skip（`skipIf(!EVENT_TOKEN)`/`test.skip(!PR_CALLBACK_TOKEN)`），CI 可静默全绿 | `workflow-pr-callback.test.ts:571,640`、`workflow.spec.ts` 多处 | 加 fail-fast 哨兵用例（缺参即红）或显式 `SKIP_PR_CALLBACK=1` 才跳过 |
| C-25 | 弱断言：T-CH-API-CS2 断言 `.not.toBe('SKIPPED')`、T-PR13/E2E-30 reason 用 allowlist、`toHaveProperty` 噪声断言、固定 200ms sleep | `cloud-host.test.ts:721,743`、`workflow-pr-callback.test.ts:582,899`、`session.test.ts:1343` | 钉死精确值/单一 reason；改轮询等待 |
| C-26 | 测试卫生：硬编码默认端口两套不一致（4000/4001 vs 10001/35273）、PR id 序列同公式可撞、MCP 启停无 finally、T-CH-DW1 清理不在 finally | `tests/api`、`tests/e2e` 多处 | 缺环境变量 fail-fast、序列加套件名盐、补 finally 清理 |
| C-27 | 契约注释 stale：`workflow.graphql:296`「true 时开启」（实际支持 false）、`cloud-host.graphql:124`「软删除仍返回」与 `dependsOn` 均未测 | `contracts/` | 注释对齐；补两条断言 |
| C-28 | 文档索引腐化：`docs/product/AGENTS.md:133` 仍写「可选创建默认工作区」、`tests/api/AGENTS.md`「34 个」实为 35 且缺 `INTERNAL_API_TOKEN` 环境行、Phase 9/10 用例未入索引、E2E-1/3/4 编号与 workflow 用例冲突、plan 风险表「显式勾选即等价」stale、plan:683 T-PR13 口径 drift | `docs/`、`tests/*/AGENTS.md` | 一次性索引清理 + 用例重编号（如 `E2E-CH-1`） |

## 五、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| R-1 | SessionPage `onCreate` 位置参数错位（模式当模型、模型丢弃） | 9 参签名演进漏改调用点 | ✅ 已修复（补第 7 参 + 映射单测，第二轮探针实证） | `939936b` |
| R-2 | tests/e2e 新增 typecheck 门禁对本 diff 新代码报 3 × TS18047 | 门禁未自检、可空值未收敛 | ✅ 已修复（typecheck exit=0，反证探针确认） | `939936b` |
| R-3 | T-IC-EPH1/2 断言 `requests` 而实现仅 `limits`，确定性红 | 测试/JSDoc 残留旧口径 | ⚠️ 断言侧已修复（2 用例实跑绿）；`AppHost.cs:160` stale 注释残留 → U-3 | `939936b` |
| R-4 | WorktreeSidebarGroup 丢弃 modeId/modelId | prop 签名未同步扩展 | ✅ 已修复（9 参透传单测，探针实证） | `939936b` |
| R-5 | E2E 旧文案断言与 P10-CH1 过时语义 | phase2 改口径未回归旧断言 | ✅ 已修复（文案对齐 + P10-CH1 重写为强断言） | `939936b` |
| R-6 | 后台模型变更不失效 ACP 选项缓存 | 跨服务失效被裁剪未回写 spec | ⚠️ 部分修复：PRD v1.2 已收窄，提案 §9/§8.1/风险点残留矛盾 → U-2 | `939936b` |
| R-7 | `hasDefaultWorkspace` 恒 false、语义失效 | 字段无写入方 | ⚠️ 部分修复：仅成功路径回写，失败路径不回写 → U-1 | `939936b` |
| R-8 | PR 事件幂等 TOCTOU | 去重读在锁外、非原子 claim | ✅ 已修复（锁内重读 + 并发用例有区分力） | `939936b` |
| R-9 | 事件流转与人工流转不互斥 | 锁在传输层非领域层 | ⚠️ 主体已修复（engine.transition 串行化 + 并发用例）；**但引入 re-entrant 回归 → N-1（🔴）** | `939936b` |
| R-10 | CustomModelDialog 编辑中被重置 | effect 依赖不稳定数组 | ✅ 已修复（useMemo + 稳定依赖 + 回归测试，探针实证） | `939936b` |
| C-1~C-28 | 🟡 收口项（见 C 组表） | — | ⚠️ 大部分收口；C-18 引入新缺陷 → N-2（🟠）、C-17 引入新缺陷 → N-3（🟠），另 8 项残留 → U-3~U-6 | `939936b` |

## 六、最终验证

### 6.1 首轮（打回时）

| 项目 | 首轮结果 |
|---|---|
| tsc（agent-api/admin-api/cloud-controller/admin-web/agent-web） | ✅ 全 0 error |
| lint（admin-web/agent-web） | ✅ 0 error |
| tests/e2e typecheck | ❌ 3 error（R-2） |
| 单测（五包） | ✅ 976 / 656+1skip / 254 / 234 / 654 全绿 |
| tests/api | ⚠️ T-IC-EPH1/2 确定性红（R-3）；其余失败为缺实栈环境型 |
| tests/e2e（实机浏览器） | 未执行 |
| 结论 | ❌ **REJECT**（3 × 🔴 + 7 × 🟠） |

### 6.2 返工修复后（2026-10-23，修复提交 `939936b`）

| 项目 | 复验结果 |
|---|---|
| tsc（agent-api/admin-api/cloud-controller/admin-web/agent-web） | ✅ 全 0 error（5 包逐个实跑） |
| lint（admin-web/agent-web） | ✅ 0 error（仅存量 exhaustive-deps warning） |
| tests/e2e typecheck | ✅ exit=0（R-2 三处 TS18047 已消除） |
| 单测五包 | ✅ **986**（agent-api，+10）/ **656+1skip**（admin-api）/ **254**（cloud-controller）/ **235**（admin-web，+1）/ **657**（agent-web，+3） |
| tests/api T-IC-EPH1/2 | ✅ 2 passed（`src/cloud-controller/internal-api.test.ts` 实跑） |
| tests/api 其余 | ⏳ 需 Aspire 全栈实跑（本机未起完整栈；端口默认值已统一为 10001/35273） |
| tests/e2e（实机浏览器） | ⏳ 需 Aspire 全栈实跑（用例语义已按 phase2 重写） |
| 结论 | 🔄 **修复完成，待第二轮集成验收** |

### 6.3 第二轮独立复核（2026-10-23，AI Review 实跑，不采信自报）

| 项目 | 复核结果 |
|---|---|
| tsc（agent-api/admin-api/cloud-controller） | ✅ 全 0 error（逐包实跑） |
| tsc -b（admin-web/agent-web） | ✅ 全 0 error |
| lint（admin-web/agent-web） | ✅ 0 error（agent-web 5 存量 exhaustive-deps warning） |
| 单测五包 | ✅ **986** / **656+1skip** / **254** / **235** / **657** 全绿（与自报一致） |
| tests/e2e typecheck | ✅ exit=0；**反证探针**：换回 `74af2cb` 版 `workflow.spec.ts` 复跑 exit=2（恰 3×TS18047 @645/2471/2504），证明 R-2 修复真实改变行为 |
| tests/api T-IC-EPH1/2 | ✅ 2 passed（`internal-api.test.ts` 实跑）；`k8s-job-manager.test.ts` 14 passed，三方口径（断言/单测/E2E）一致 |
| tests/api PR 联动哨兵 | ✅ 三态实证：本地无 token 绿（1 passed/20 skipped）、`CI=1` 缺参确定性红、`CI=1 SKIP_PR_CALLBACK=1` 显式跳过绿 |
| 回退探针（区分力检查） | ✅ R-1/R-4/R-10 修复回退后对应新单测确定性变红（3/3）；C-15 文案断言探针回退不红（弱断言 → U-5） |
| R-9 回归复现 | ❌ 引擎级最小复现确定性抛 `KeyedMutex re-entrant lock detected`（见 9.3 N-1） |
| tests/api（Aspire 全栈全量） | ⏳ 未执行（代码即将返工变更；随下轮修复一并提交证据） |
| tests/e2e（实机浏览器） | ⏳ 同上 |
| 结论 | ❌ **REJECT（第二轮）**：1 × 🔴（N-1）+ 4 × 🟠（N-2/N-3/U-1/U-2） |

## 七、经验总结

- **位置参数 API 演进必须有编译期保障**：`onCreate` 从 7 参扩到 9 参靠约定同步 3 个调用点，漏改 2 处（R-1/R-4）且 AGENTS.md 描述失真；回调签名应改对象参数或导出共享类型，并为每个调用点留映射测试。
- **语义口径变更必须回归「测试 + 注释 + 文档」三件套**：`requests=limits`→仅 limits（R-3）、默认工作区取消（R-5/R-7）两处口径变更都留下了旧断言/旧注释，其中一处直接变确定性红。
- **新增质量门禁先自检再合入**：`tests/e2e typecheck` 与被检代码同 PR 引入却未跑通（R-2），门禁应作为 PR 自检清单的第 0 项。
- **跨服务失效/钩子若裁剪，必须回写 PRD 与提案**：TTL 兜底 ≠ 「立即失效」（R-6）；spec 与实现二选一，但不能沉默偏离。
- **状态机并发入口必须共锁**：事件驱动与人工入口共享迁移语义时，锁应落在领域层（R-8/R-9）；传输层局部锁只保护了自己那条路。
- **事件幂等要做原子 claim**：「读-判-写」三步放锁外/锁内混用会产生 TOCTOU，重复投递的响应语义（DUPLICATE vs HANDLER_FAILED）本身就是契约承诺。

## 八、返工修复记录（2026-10-23 第二轮）

> 修复分支：`integration`；修复提交：`939936b`。以下均为本轮实际改动与验证证据。

### 8.1 阻断项（🔴）

| # | 修复内容 | 验证 |
|---|---|---|
| R-1 | `SessionPage.handleCreateSession` 补齐第 7 参 `existingWorktreePath`，并按 `Sidebar` 口径透传 `existingWorktreePath`（有预选 worktree 时 `enableWorktree=false`）；`apps/agent-web/AGENTS.md` 更新为 9 参 + 3 个调用点说明；新增 `apps/agent-web/src/pages/__tests__/SessionPage.test.tsx` 钉住 9 参→CreateSessionInput 映射 | 新增 2 例；agent-web 657 passed |
| R-2 | `tests/e2e/src/workflow.spec.ts`：`waitForNodeStatus` 显式返回 `Promise<InstanceNode>` 并在成功分支非空收敛；`promptText`/`inst` 改用非空断言 | `cd tests/e2e && npm run typecheck` exit=0 |
| R-3 | `tests/api/.../internal-api.test.ts` T-IC-EPH1/2 改为断言 `resources.requests === undefined` + `limits['ephemeral-storage']`；`k8s-job-manager.ts` JSDoc 与 `deploy/k8s/cloud-controller.yaml` 注释改为「仅 limits（不设 requests），默认 10Gi」 | 该套件实跑 2 passed |

### 8.2 重要项（🟠）

| # | 修复内容 | 验证 |
|---|---|---|
| R-4 | `WorktreeSidebarGroup` 的 `onCreate` prop 与转发 wrapper 扩到 9 参，透传 `modeId/modelId`，`existingWorktreePath` 保留预选回退；新增透传单测 | 单测 6 passed（含新用例） |
| R-5 | `cloud-host.spec.ts` 旧文案断言改为「就绪后不会自动创建会话，需先创建或绑定工作区」，删除同 spec 自相矛盾断言；P10-CH1 重写为 phase2 语义（ready 后 workspaceId/defaultSessionId 均为 null、sessions=0、展示无工作区提示） | tests/e2e typecheck 绿；语义与 `cloud-host-service.ts` 一致 |
| R-6 | 采用报告方案②：PRD v1.2 / 提案 v1.2 明确「用户级模型变更立即失效；后台（系统内置/global）变更由 300s TTL 兜底 + 刷新按钮立即重取」；`updateModelSortOrder` 补失效调用；`acp-options-cache.ts` 与 `servers/agent-api/AGENTS.md` 同步口径 | agent-api 单测 986 passed |
| R-7 | Git 项目设置创建默认工作区后 CAS 回写 `CloudHost.workspaceId`（仅空时），`hasDefaultWorkspace`/`defaultWorkspace` 恢复真实语义；契约注释同步；`T-CHG1` 增补回写断言 | cloud-host-github-service.test 通过 |
| R-8 | `prHandlerRegistry.findById` + `processHandler` 在实例锁内重读登记行判重；新增「同一 eventId 并发重复投递」用例（1×COMPLETE、1×DUPLICATE_EVENT、0×HANDLER_FAILED） | pr-event-handler.test 19 passed |
| R-9 | `KeyedMutex` 下沉到 `workflowEngine.transition`，按 `instanceId` 串行化 GraphQL/MCP/事件/兜底全部入口；新增并发 complete 用例（恰一次成功、一次拒绝） | engine.test 通过 |
| R-10 | `ModelSection.enabledProviders` 改 `useMemo`；`CustomModelDialog` 重置 effect 依赖改为 `[open, model?.id]`；新增「父级重渲染不重置在填表单」回归用例 | admin-web 235 passed |

### 8.3 C 组收口

| # | 处理 |
|---|---|
| C-1 | `findByPullRequestId` 合并顺序改为「索引先入、DB 后入」，DB 行覆盖陈旧内存行 |
| C-2 | 新增 `pullRequestIdLower` 字段 + `findByPullRequestId` 精确匹配 + 迁移 `008-workflow-pr-handler-lower-id`（回填 + 索引） |
| C-3 | approved 分支流转失败回滚 `github-pr-review`（新增 `removeSystemAdditionalPrompt`）；`markEventHandled` 失败仅告警，不误报 HANDLER_FAILED |
| C-4 | 载荷字段限长（eventId 200 / PR id 512 / prUrl 2048 / reviewer 256 / comment 64k 等）；提示词优先使用登记 `prUrl` |
| C-5 | `X-Event-Token` 空值改用 `||`，不再遮蔽有效 Bearer |
| C-6 | `register()` 按实例+节点加 `KeyedMutex`，消除 delete-then-upsert 并发双存活 |
| C-7 | 提案 §3.1 对齐实现：`workflowId/nodeId` 可选、错误码 `INVALID_PARAMS`/`INVALID_STATE` |
| C-8 | PRD 3.5 增补「并行分支 `CURRENT_NODE_AMBIGUOUS`」与「REWORK 态事件不驱动」口径 |
| C-9 | `refreshAcpServerOptions` 删除失败显式报错；读侧按 `probedAt >= 删除时刻-5s` 过滤陈旧探测结果；补服务层单测 |
| C-10 | `updateModelSortOrder` 接到 `invalidateAcpOptionsForUser`；AGENTS.md 与实现一致（`invalidateAcpOptionsForController` 保留为可复用工具函数） |
| C-11 | `setControllerDefaultMcp` 契约补注：平台云工具服务不可选、显式提交返回 `MCP_SERVER_NOT_FOUND` |
| C-12 | 契约改为「缺省或 null 均清空」，与 resolver 行为一致 |
| C-13 | 重复用例 ID `T-CHG-P1b` 拆分为 `T-CHG-P1d` 并整理合并行格式 |
| C-14 | 新增 `refreshAcpServerOptions` 服务层覆盖（缓存命中/删除重探/删除失败/陈旧结果过滤/Controller not found） |
| C-15 | 去掉「新 MCP 上线后自动注入」的不实文案，改为「默认注入全部已启用的 MCP」 |
| C-16 | 分支后缀改为 `setBranchSuffix(prev => prev || defaultSuffix)`，effect 移除 `workspaces` 依赖，避免列表刷新覆盖用户编辑 |
| C-17 | `refetchHome` 失败兜底；操作终态停止 1.5s 轮询（`pollStopped`） |
| C-18 | `McpDefaultSection` 增加 `dirtyRef`，未保存编辑不被后台刷新覆盖；保存成功清除 dirty |
| C-19 | `Sidebar`/`SessionPage` 创建会话失败增加 `toast.error`（不再仅 console） |
| C-20 | `WorkflowNodeTree` 在 `prUrl` 为空时渲染 `<span>`，消除无 href 死链接 |
| C-21 | 集群侧验收项仍按 plan 手工验收；可测部分由 C-22/C-23 与 R-3 覆盖 |
| C-22 | `llm.test.ts` models 查询增加 `contextLength` 并断言 null/正整数 |
| C-23 | P10-CH3 重试后断言「进行中」可见，验证重试真的重新进入 RUNNING |
| C-24 | `workflow-pr-callback.test.ts` 增加 CI 哨兵：CI 下缺 `EVENT_CALLBACK_TOKEN` 且未 `SKIP_PR_CALLBACK=1` 即红 |
| C-25 | T-CH-API-CS2 改精确 `PENDING`；T-PR13 reason 改精确 `NO_HANDLER`；T-PR1 去 `toHaveProperty` 噪声断言 |
| C-26 | tests/api 默认端口统一为 Aspire 实际值（agent-api 10001 / controller-api 35273） |
| C-27 | 契约注释修正：`linkUpstreamPullRequest` true/false 语义、`cloudHost(id)` 软删除返回 null |
| C-28 | 文档索引修正：产品索引 phase2 语义、tests/api 文件数 34→41、补 `INTERNAL_API_TOKEN` 环境行、E2E 索引补 E2E-1/P10-CH1/P10-CH2 |

> 保留说明：C-19 仍保留「提交即关闭弹窗」，失败通过 toast 提示（未改为 Promise 回调成功后再关闭）；C-24 哨兵仅在 CI 生效，避免本地无栈环境误红；C-21 集群侧（磁盘超限终止/同节点隔离/存量不受影响）仍为手工验收项。

### 8.4 复验结论

- 五包 `tsc` 0 error、双前端 lint 0 error。
- 单测：agent-api **986**、admin-api **656+1skip**、cloud-controller **254**、admin-web **235**、agent-web **657** 全绿。
- `tests/e2e` typecheck exit=0；`tests/api` T-IC-EPH1/2 实跑绿。
- 待第二轮以 Aspire 全栈实跑 `tests/api` 全量与 `tests/e2e`，完成集成验收。

## 九、第二轮验收记录（2026-10-23）

> 复核对象：`origin/integration @ 051cabf`（返工修复 `939936b` + 报告回填 `051cabf`）；复核方式：三域并行逐条复核（前端 / 测试 / 后端契约文档）+ 主评对全部新发现回读源码交叉复核 + 独立实跑（见 [6.3](#63-第二轮独立复核2026-10-23ai-review-实跑不采信自报)）+ 回退探针与引擎级最小复现。**不采信自报**。

### 9.1 首轮修复项逐条复核结论

| # | 复核结论 | 关键证据 |
|---|---|---|
| R-1 | ✅ 属实 | `SessionPage.tsx:20-30` 9 参逐参对照 `NewSessionDialog.tsx:273-284` 实传完全一致，mutation 映射正确；`SessionPage.test.tsx` 2 例有区分力（回退探针：`modeId/modelId` 互换即红） |
| R-2 | ✅ 属实 | `npm run typecheck` exit=0；反证探针（换回旧 `workflow.spec.ts`）exit=2 恰 3×TS18047，修复真实 |
| R-3 | ⚠️ 部分属实 | 断言改 `requests===undefined` + `limits` 精确值、2 passed；三方口径一致；**但 `aspire/AgentGear.AppHost/AppHost.cs:160` 注释仍「requests=limits」**（→ U-3） |
| R-4 | ✅ 属实 | prop/wrapper 9 参透传 + `WorktreeSidebarGroup.test.tsx` 全参断言，回退探针红 |
| R-5 | ✅ 属实 | spec 文案与 `NewCloudHostDialog.tsx:327-329` 逐字一致、矛盾断言已删；P10-CH1 为强断言（`workspaceId/defaultSessionId` null、`sessions=0`、提示文案精确匹配），与 `cloud-host-service.ts:565-588` 行为对应 |
| R-6 | ⚠️ 部分属实 | PRD v1.2 收窄完整（含验收项拆分 `:105-107`）；`updateModelSortOrder` 已接失效（`model.ts:105`）；**提案 §9 `:497` 仍写「立即失效」、§8.1 `:477` 声称有不存在的失效范围判定单测、`:394` 风险点与 `:453` 函数名 stale**（→ U-2） |
| R-7 | ⚠️ 部分属实 | 成功路径 CAS 回写属实（`cloud-host-github-service.ts:357-367`）；**失败路径（`createSession` 抛错）不回写**，恰为契约声称要区分的场景（→ U-1） |
| R-8 | ✅ 属实 | 锁内 `findById` 重读判重（`pr-event-handler.ts:161-166,194`）；并发用例 `Promise.all` 双投递断言 1×COMPLETE/1×DUPLICATE/0×HANDLER_FAILED，mock 共享 `lastEventId` 有区分力 |
| R-9 | ⚠️ 主体属实但引入回归 | `transitionMutex` 覆盖 `transitionUnlocked` 全程含级联 save（`engine.ts:155-163`）；并发 complete 用例有区分力；双锁（`instanceMutex`/`transitionMutex`）顺序单向无静态死锁环；**但 hook 在锁内执行 + `close()` 同步触发兜底回调 → re-entrant 抛错回归**（→ N-1，🔴） |
| R-10 | ✅ 属实 | `enabledProviders` `useMemo`（`ModelSection.tsx:211-218`）、effect 依赖 `[open, model?.id]`（`CustomModelDialog.tsx:59-73`）；回归用例以新数组字面量 rerender 复现，回退探针红 |
| C-1~C-28 | ⚠️ 大部分收口 | C-2/C-3/C-5/C-6/C-9/C-10/C-12/C-14 等属实；**C-17/C-18 修复引入新缺陷**（→ N-3/N-2）；残留 8 项（→ U-3~U-6） |

### 9.2 第二轮问题清单

#### N-1（🔴，修复引入）R-9 锁内 hook 嵌套流转抛 `re-entrant`：重启 RUNNING 节点必误触发会话兜底链路，确定性失败并留死会话

- **问题描述**：`engine.transition` 经 R-9 下沉 `transitionMutex` 后，**引擎 hook 在锁内同步执行**（`engine.ts` `apply` 内 `await this.hooks.onNode*`）。而 `orchestrator.handleSessionEnded` 兜底链路由 `sessionService.close()` **同步 await 触发**（`session.ts:565` `await this.sessionEndedCallback?.(id)`），且该回调按 `nodes.sessionId` **重读 DB**（`orchestrator.ts:258-266`）判断 `node.status === 'RUNNING'`。`restart` 事件合法来源含 `RUNNING`（`engine.ts:119` `restart: { from: ['RUNNING','REWORK','FAILED'] }`），其 hook `restartNodeSession` 在锁内 `close` 旧会话（`orchestrator.ts:235-240`）——此时外层转移**尚未 save**，DB 仍是转移前状态（`status='RUNNING'`、`sessionId`=旧会话），兜底逻辑必然误判「会话意外终止」，分两支：
  - **A 支（DB `fallbackSent=true`）**：`handleSessionEnded` 调 `workflowEngine.transition(..., 'fail')`（`orchestrator.ts:267-270`）→ 同 `instanceId` 嵌套 `transitionMutex.runExclusive` → **抛 `KeyedMutex re-entrant lock detected`**（`keyed-mutex.ts:15-20` 非可重入）→ 整个 restart 失败；而旧会话在 close 中已被置 `ended`，新会话未拉起 → 节点卡死 RUNNING 配死会话。**触发场景恰是 restart 的主用例**：「会话卡住→发过一次兜底提醒→再卡住→人工重启」。
  - **B 支（DB `fallbackSent=false`）**：兜底逻辑把**人为关闭**的旧会话当意外终止：置 `fallbackSent=true` 并 `instance.save()`（独立 findOne 文档，与外层转移 save 竞争，可能互覆/VersionError）、`sessionService.resume` **复活旧会话**并发送「系统提醒」兜底提示词（`orchestrator.ts:275` 之后）→ 同一节点出现幽灵会话。
- **复现（引擎级最小复现，确定性）**：在 `engine.test.ts` 同型 mock 下注册 `onNodeRestart` hook 内嵌套 `workflowEngine.transition(同 instanceId, nodeId, 'fail')`（模拟 `handleSessionEnded` A 支），`transition('inst-1','n1','restart',{})`（节点 RUNNING）**必抛 `/re-entrant/`**（本轮已实证，1 passed）。真实链路可达性由上述 file:line 逐步确认。
- **根因分析**：R-9 把锁下沉到 `engine.transition` 但 **hooks 仍在锁内执行**，而 hook→`sessionService.close`→`sessionEndedCallback` 是同步回调链，兜底逻辑又会**回环调用 `engine.transition`**；同时兜底逻辑按「DB 快照」判断，与「转移未持久化就 close 会话」的 hook 时序组合必然误判（`complete`/`completeRework` 分支已通过「先 save 再 onNodeDone」规避，`restart`/`resume` 分支未做同等处理）。修复 R-9 时未回归「hook 内是否还有流转入口」。
- **修复方案**：① 消除锁内回环：hooks 移到锁外执行（`transitionUnlocked` 返回待执行 hook 队列、`runExclusive` 释放后逐一触发），或 `handleSessionEnded` 改为**延迟出队**（`setImmediate`/任务队列）在锁外再取锁流转，禁止同步嵌套；② 修正兜底误判时序：`restart`/`resume` hook 关闭旧会话前先持久化转移结果（对齐 `complete` 分支「先落库再关会话」注释口径），或 close 时带 `skipFallback`/`deliberate` 标记让 `handleSessionEnded` 直接短路；③ 补回归用例：restart（RUNNING+fallbackSent=true）不断言抛错且恰拉起一个新会话、restart（RUNNING+fallbackSent=false）不复活旧会话不发兜底提示词；④ 评估 `handleSessionEnded` 独立文档 `instance.save()` 与外层转移的互覆（一并用锁保护或改为字段级 `$set`）。
- **验证结果**：❌ 第二轮实证（引擎级复现 + 链路 file:line 逐步确认）；待第三轮复验。

#### N-2（🟠，修复引入且自报与代码不符）C-18 `dirtyRef` 保存成功不清除：保存后服务端权威值永不回同步，自报「保存成功清除 dirty」不实

- **问题描述**：`McpDefaultSection.tsx` 新增 `dirtyRef` 防覆盖（`:67,72,89,125`），但 `handleSave`（`:96-108`）**全程没有** `dirtyRef.current = false`；同步 effect（`:73-80`）首行 `if (dirtyRef.current) return` → 保存成功后即使后台刷新带回服务端权威值也被跳过，本地表单永远停留在用户手改值；切换控制器（`controller.id` 变化）同样被 dirty 跳过，`ControllerConfigPage` 挂载无 `key` 不重挂载 → **脏值/旧 error 串台到另一控制器**。第八节 8.3 C-18 行自述「保存成功清除 dirty」与代码不符（051cabf 报告失真）。
- **根因分析**：dirty 生命周期只有置位没有复位；保存成功路径漏接 `dirtyRef.current = false`（或 mutation 结果驱动的权威值回写）。
- **修复方案**：① `handleSave` 成功后 `dirtyRef.current = false` 并以 mutation 返回值/`refetch` 结果同步表单；② 评估 `McpDefaultSection` 挂载加 `key={controller.id}` 或 `controller.id` 变化时强制重置 dirty/表单；③ 补用例「保存成功后服务端值变更可回同步」「切换控制器不携带脏值」；④ 返工自报须与代码一致（回填失真描述）。
- **验证结果**：❌ 第二轮实证（`McpDefaultSection.tsx:96-108` 无复位）；待第三轮复验。

#### N-3（🟠，修复引入）C-17 终态停轮询后 `pollStopped` 永不复位：点「重试/重新设置」进度对话框冻结不再刷新

- **问题描述**：`GithubSetupProgressDialog.tsx` 新增 `pollStopped`（`:123,134,142,177`）在操作终态停掉 1.5s 轮询（符合 C-17 意图），但 `pollStopped` **只在 `[open]` 重置**（`:152-156`）；终态后点「重试」（`handleRetry` `:203-213`，仅单次 `refetch()`）或「重新设置」重发 setup，`pollInterval` 恒为 0 → **进度框冻结**，除非关闭重开对话框。修复把「持续轮询」问题改成了「重试后不轮询」问题。
- **根因分析**：停轮询与重试/重发动作之间缺少状态恢复；`pollStopped` 生命周期与操作生命周期未对齐。
- **修复方案**：① `handleRetry`/重发 setup 成功后 `setPollStopped(false)` 恢复轮询（或按操作状态派生 `pollInterval` 而非手动开关）；② 顺带落实 C-17 原始尾项：「重新创建」按钮语义与文案对齐（当前文案过度承诺，第二轮复核确认未改）；③ 补用例「终态→重试→进度恢复刷新」。
- **验证结果**：❌ 第二轮实证；待第三轮复验。

#### U-1（🟠，首轮 R-7 未闭环）失败路径不回写 `workspaceId`：恰是契约声称要区分的「默认会话创建失败」场景

- **问题描述**：`cloud-host-github-service.ts` `runSessionStep` 的 CAS 回写位于 `createSession` 成功之后（`:357-367`）；`createSession` 抛错走 catch（`:383-395`）时 **`ensureWorkspace` 已创建的默认工作区不回写** → `hasDefaultWorkspace` 仍 `false`。而契约注释（`contracts/cloud-host.graphql:47-48`）明确该字段用于「区分『未创建工作区』与『默认会话创建失败』」——失败场景正是需要 `true` 的场景，R-7 修复只覆盖成功路径，语义失效在失败路径上原样保留。
- **根因分析**：回写时机挂在会话创建成功之后，而非「默认工作区创建/绑定」这个语义事件之后。
- **修复方案**：① `ensureWorkspace` 成功后立即 CAS 回写 `workspaceId`（成功失败路径共享）；② 补失败路径用例（mock `createSession` 抛错，断言 `workspaceId` 已回写、步骤状态 FAILED/SUCCEEDED-with-error 与现状一致）；③ 多 harness（`createSession=false` 不建工作区）分支口径在契约注释中注明。
- **验证结果**：❌ 第二轮实证（`:357-367` 在 try 内、catch 无回写）；待第三轮复验。

#### U-2（🟠，首轮 R-6 未闭环）提案收窄不完整：§9 验收项/§8.1/风险点仍与 v1.2 TTL 口径矛盾

- **问题描述**：R-6 采用方案②「修订 PRD/提案如实收窄」，PRD 侧已完成（含验收项拆分 `20261022-...phase1.md:105-107`），但提案 `20261022-feat-cloud-container-optimization-phase1.md` 残留自相矛盾：① `:497` §9 验收项仍写「模型列表新增/启用/禁用/删除后**立即失效**」（未按用户级/global 拆分，与 v1.2 `:15` 直接矛盾）；② `:477` §8.1 声称单测覆盖「`invalidateAcpOptionsCache` 的失效范围判定（用户级/系统内置全局）」——该测试不存在且函数名 stale（实际 `invalidateAcpOptionsForUser/ForController`）；③ `:394` 风险点仍按「全局失效漏掉」旧口径书写；④ `:453` 目录注释 stale。收窄的目的是 spec 与实现一致，矛盾残留使收窄未完成。
- **根因分析**：方案②回写只改了 PRD 与提案的「说明段」，未回归验收清单/测试清单/风险表的旧口径。
- **修复方案**：提案 `:497` 按 v1.2 拆分口径（用户级立即失效 / global TTL 5 分钟+刷新）、`:477` 删除或改写不存在的失效范围判定单测描述并更正函数名、`:394`/`:453` 同步；改后全仓 grep「立即失效」「invalidateAcpOptionsCache」应零残留矛盾。
- **验证结果**：❌ 第二轮实证（grep 复现 4 处）；待第三轮复验。

#### U-3~U-6（🟡 残留，随本轮修复一并清理）

| # | 残留项 | 位置 | 要求 |
|---|---|---|---|
| U-3 | 「requests=limits」stale 注释残留（R-3 尾巴） | `aspire/AgentGear.AppHost/AppHost.cs:160` | 改「仅 limits（不设 requests）」 |
| U-4 | 测试精度/覆盖面残留：C-4 `pr-event-payload` 限长零测试；C-22 `contextLength` 断言 `Number.isInteger` 放行 0/负；C-24 `workflow.spec.ts` 6 处 `skip(!PR_CALLBACK_TOKEN)` 无 CI 哨兵；C-25 E2E-30 reason 仍 allowlist、`session.test.ts:1343` 固定 200ms sleep；C-27 要求的「软删除返回 null」「dependsOn 返回值」两断言未补；C-1 合并注释言过其实（index-only 残留行仍进 merged）；C-11 专用错误文案未做 | `tests/`、`pr-event-payload.ts`、`pr-handler-registry.ts` | 逐项收口或在报告中如实降级说明 |
| U-5 | 测试不设防/文档失真：C-15 文案断言弱（探针回退不红，`NewSessionDialog.test.tsx:304`）；`apps/agent-web/AGENTS.md` 称「每个调用点保留映射单测」但 `Sidebar` 调用点无映射单测；`SessionPage.test` 对 `existingWorktreePath→enableWorktree=false` 覆写钉得不死 | `tests`、`apps/agent-web/AGENTS.md` | 强化断言或修正文档口径 |
| U-6 | 文档端口 stale（C-26 尾巴）：代码默认已统一 10001/35273，但 `tests/api/AGENTS.md:73`（及 `:37/:44`）、`tests/e2e/AGENTS.md:69` 仍写 4001/33237 | `tests/*/AGENTS.md` | 与代码默认对齐 |

### 9.3 修复总览（第二轮回填）

| # | 问题 | 级别 | 性质 | 状态 | 修复 commit |
|---|---|---|---|---|---|
| N-1 | R-9 锁内 hook 嵌套流转抛 re-entrant，restart(RUNNING) 兜底误触发 | 🔴 | 修复引入 | ❌ 待修复 | — |
| N-2 | C-18 dirtyRef 保存成功不清除（自报与代码不符） | 🟠 | 修复引入 | ❌ 待修复 | — |
| N-3 | C-17 pollStopped 后重试/重发进度框冻结 | 🟠 | 修复引入 | ❌ 待修复 | — |
| U-1 | R-7 失败路径不回写 workspaceId | 🟠 | 首轮未闭环 | ❌ 待修复 | — |
| U-2 | R-6 提案 §9/§8.1/风险点残留矛盾 | 🟠 | 首轮未闭环 | ❌ 待修复 | — |
| U-3~U-6 | 🟡 残留 8 项（见 9.2 表） | 🟡 | 首轮未闭环/新发现 | ❌ 待清理 | — |

### 9.4 第二轮判定

- **结论：❌ REJECT（第二轮打回）**。命中判定红线：1 × 🔴（N-1）+ 4 × 🟠（N-2/N-3/U-1/U-2）。
- 已闭环确认：R-1/R-2/R-4/R-5/R-8/R-10 全闭环，R-3/R-6/R-7/R-9 主体修复属实但有尾巴/回归。
- **下轮要求**：① 修复 N-1~N-3、闭环 U-1/U-2、清理 U-3~U-6；② **以 Aspire 全栈实跑 `tests/api` 全量与 `tests/e2e` 并提交结果证据**（两轮均未执行，第三轮必须随修复交付）；③ 返工自报须与代码逐条一致（N-2 已发现自报失真，下轮将抽查自报与代码的一致性）；④ 修复 N-1 时补「restart/兜底」回归用例并评估 hook 出锁的时序影响面。

## 十、经验总结（第二轮追加）

- **锁下沉到领域层时必须审计「锁内回调是否回环取锁」**：R-9 把互斥下沉 `engine.transition` 是对的，但 hooks 在锁内执行且 `sessionService.close` 同步触发兜底回调、兜底回调又回环 `transition`——非可重入锁把隐蔽竞态变成确定性抛错。任何「锁内 await 外部回调」的结构都要假设回调会回环。
- **「先落库再关会话」的时序约定要覆盖所有关会话路径**：`complete` 分支为规避兜底误判特意先 save 再 hook，`restart`/`resume` 分支未对齐，同一陷阱踩第二次（N-1）。
- **防护性修复要连状态生命周期一起补**：C-17 停轮询、C-18 dirty 保护都只做了「置位」没做「复位」，把一类缺陷换成另一类（N-3/N-2）。
- **修复覆盖要包含失败路径**：R-7 只在成功路径回写，恰好漏掉字段语义所服务的失败场景（U-1）。
- **spec 收窄要一次改完全口径**：R-6 只改说明段不改验收/测试/风险清单，矛盾残留使收窄不成立（U-2）。
- **返工自报须可抽查**：本轮发现自报「保存成功清除 dirty」与代码不符（N-2）；验收已将「自报↔代码一致性」纳入抽查项。
