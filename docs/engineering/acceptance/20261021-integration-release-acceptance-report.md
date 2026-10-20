---
description: integration→release 集成验收报告（PR #245）——内建 API 渠道一期上线后修复（手动导入/分组折叠/模型删除/全局唯一重名）集成级 AI Review：首轮 3 项 🟠 重要问题打回（前台 API 泄漏后台供应商名称、导入成功误报失败、PRD 取消语义未落实）+ 15 项 🟡 收口；第二轮复核（返工 36e62dd）三项 🟠 全部闭环且经回退探针实证可证伪（A-1 实机回退红于 T-SC5 `expected { Object (id, name, ...) } to be null`、B-1 回退红于 T-W18、B-2 弹窗防护回退红于 T-W19、C-1 回退红于 T-W23），15 项 🟡 全部收口，独立复跑 tsc/lint 0 + 单测 2087/1 skipped + Aspire --isolated 全新栈 tests/api 463 passed/2 skipped/0 failed + E2E 20/20 + 迁移 005 实库执行，integration 集成验收通过（ACCEPT）
type: Permanent
---

# integration→release 集成验收报告（2026-10-21，AI Review）

> **状态**: ✅ **第二轮 AI Review 复核通过（ACCEPT）**——首轮打回的 3 × 🟠（A-1 前台 GraphQL 泄漏后台供应商名称 / B-1 导入成功误报「导入失败」/ B-2 取消语义未实现且零覆盖）在返工 `36e62dd` 中**全部闭环**，15 × 🟡（C-1~C-15）全部收口；本轮以**回退探针实证**确认修复为真且新回归可证伪（A-1 在实机栈回退数据层掩蔽 → T-SC5 红于 `expected { Object (id, name, ...) } to be null`，恢复后 agent-api/llm 36/36 绿；B-1 回退 refetch 异常通道 → T-W18 红；B-2 弹窗防护回退 → T-W19 红；C-1 拖拽顺序回退 → T-W23 红），并独立复跑 tsc/lint 0 error、单测 2087 passed/1 skipped、Aspire `--isolated` 全新栈 tests/api **463 passed / 2 skipped / 0 failed（465）**、E2E **20 passed / 0 failed**、迁移 005 实库执行成功，详见 [第八节](#八第二轮-ai-review-复核2026-10-21ai-review-节点通过)。历史结论存档：[第七节](#七经验总结) 之前为**首轮 AI Review 打回（REJECT）**（3 × 🟠 + 15 × 🟡，问题清单见 [第四节](#四验收问题清单)）。

## 关联文档

- PRD：`docs/product/draft/20261020-api-channel-model-fixes.md`（现 v1.2；首轮评审时为 v1.1，B-2 返工修订至 v1.2）
- 技术方案：`docs/engineering/proposals/20261020-fix-api-channel-model-fixes.md`（现 v1.2）
- 实现计划：`docs/engineering/plan/20261020-fix-api-channel-model-fixes.md`（现 v1.1，含计划期裁决 1~18，裁决 17 已回写 PRD）
- 分支：`integration` @ `c24c6a6`（= `origin/main`），目标分支 `release`；PR #245 `OPEN / MERGEABLE / CLEAN`（integration→release，"Integration branch reset to latest main"）
- 上游产物：① 节点「切出集成分支」——integration 重置基线 `origin/main @ c24c6a6`、PR 范围 55 文件 +5034/−621、force-with-lease 推送完成；② 节点「修复Review意见」——无人类 Review 意见（`rejectInfo` 为空）→ 本轮为**集成级首次 AI 代码评审**
- 验收方式：AI 代码评审（`git diff origin/release...integration`，9 提交 / 55 文件 / +5034 −621）+ 4 域并行深度评审（admin-web 前端 / agent-web + agent-api / tests+docs+contracts / admin-api 后端核心由主评逐行复核）+ **本机独立实机验证**（不采信自报：tsc/lint/单测五包复跑、Aspire 全栈实跑 API 集成套件、E2E 两套特性用例、迁移 005 实库执行核验）
- 验收日期：2026-10-21

## 一、验收范围与方法

### 1.1 变更范围

| 特性 | 内容 | 主要落点 |
|---|---|---|
| 供应商模型手动导入（仅后台） | 创建/更新供应商不再自动导入模型；`listGlobalProviderModels`（上游清单 + 已导入/已存在标记）+ `importGlobalModels`（幂等、`insertMany(ordered:false)`、E11000 兜底）；导入弹窗（勾选/全选/过滤/结果反馈/增量导入） | `servers/admin-api/src/services/{model,provider}.ts`、`apps/admin-web/src/components/models/ImportModelsDialog.tsx`、`ProviderActionMenu/Section` |
| 模型按供应商分组折叠 | 后台按供应商分组（悬空归「未知供应商」）；前台按 `scope==='global'` 归「系统内置」组排首、组内不显后台供应商名；默认全部折叠；跨组拖拽忽略 | `apps/admin-web/src/components/models/{ModelSection,ModelGroup,ModelItem,collapsible-group}`、`apps/agent-web/src/components/settings/*` |
| 可用模型删除 | `deleteGlobalModel` 放开到任意全局模型（原仅自定义）；前后台删除入口 + 二次确认与影响说明；调用侧已删模型 404「模型不存在」 | `servers/admin-api/src/{services/model.ts,graphql/*}`、两前端 ModelItem |
| 后台模型禁止重名 | `scope=global` 内模型名全局唯一：`assertNamesAvailable` + partial unique index `scope_global_name_unique`（迁移 005 唯一创建入口，规避 autoIndex 竞态）；迁移 005 一次性整理存量重名（保最早创建者、`<name>-N` 跳占用改名、`model_rename_records` 台账）；「重名整理记录」只读面板 | `servers/admin-api/src/migrations/005-*`、`models/model-rename-record.ts`、`services/model-rename-record.ts`、`ModelRenameRecordsPanel.tsx` |
| 契约 | `contracts/admin-llm.graphql` 新增 `ProviderModelOption`/`ModelRenameRecord`/`listGlobalProviderModels`/`importGlobalModels`/`modelRenameRecords`，`deleteGlobalCustomModel` → `deleteGlobalModel` | `contracts/admin-llm.graphql` ↔ `schemas/model.ts` ↔ 两前端 `graphql/*` ↔ tests |
| 测试/文档 | API 集成 2 套 + E2E 2 套 + 迁移/服务/组件单测新增；PRD/提案/计划与各 AGENTS.md 索引同步 | `tests/api`、`tests/e2e`、`servers/*/src/**/**.test.ts`、`apps/*/src/**/__tests__`、`docs/**` |

### 1.2 评审与验证方法

1. **四域并行深度代码评审**（逐文件通读非抽查）：① admin-web 前端 18 文件；② agent-web + agent-api；③ tests/api + tests/e2e + docs + contracts；④ admin-api 后端核心（services/model.ts、provider.ts、迁移 005、models、resolvers/schemas、model-rename-record）由主评逐行复核并交叉验证子评审结论。
2. **独立实机验证**：本机复跑五包 `tsc`/`eslint`/单测；`aspire start` 起全栈（agent-api/admin-api/controller-api/cloud-controller + MongoDB/Redis/RabbitMQ）实跑 `tests/api` 全量与 `tests/e2e` 特性用例（`admin-model-config.spec.ts`、`settings-llm.spec.ts`）；迁移 005 在实库执行日志与索引核验。**不采信自报数据与历史报告结论。**
3. **关键发现人工复核**：3 项 🟠 全部由主评回读源码逐条确认属实（含「泄漏行为被 T-SC5 断言锁定」「refetch 必败路径」「裁决 17 与 PRD §3.5 冲突」三点实证）。
4. **反向对照**：`release..integration` 9 提交全部为本期特性提交；release 侧无并行分叉内容；`Model.provider` 泄漏点经 `git show origin/release` 对照确认为存量行为，但本期 PRD §1.3/§4.2 明确将其列入验收标准 → 计入本轮问题。
5. **安全扫描**：全量新增行做 secret/凭据硬编码、`dangerouslySetInnerHTML`/`innerHTML`、敏感信息日志、TODO/FIXME 残留扫描（未命中）。

### 1.3 判定红线（与历轮一致）

- 🔴 阻断 / 🟠 重要 → **打回返工**（本轮命中 3 × 🟠）
- 🟡 建议 → 记录并随修复项一并收口，不单独构成打回

## 二、独立验证结果（本机实跑，不采信自报）

| 服务/包 | 类型检查 | Lint | 测试 | 备注 |
|---|---|---|---|---|
| servers/admin-api | ✅ `tsc --noEmit` 0 | — | ✅ **561 passed / 1 skipped**（57 文件） | 含迁移 005 七例（T-MIG30~37）、model service U-M1~U-M12、resolver R-M1~R-M7 |
| servers/agent-api | ✅ 0 | — | ✅ **658 passed** | — |
| servers/cloud-controller | ⚠️ 包内无独立 tsc 依赖（`npm run build` 用法见 CI） | — | ✅ **197 passed** | 本 diff 未触碰该包 |
| apps/admin-web | ✅ `tsc -b` 0 | ✅ 0 error | ✅ **220 passed** | 含 ImportModelsDialog/ModelRenameRecordsPanel/ModelSection 新增用例 |
| apps/agent-web | ✅ `tsc -b` 0 | ✅ 0 error / 6 warning（均为本 diff 外存量文件） | ✅ **438 passed** | — |
| 迁移 005 实库执行 | — | — | ✅ Aspire 全栈启动即执行：`[Migration 005] global model name unique index ensured` | fresh 库无重名 → 只建索引路径；重名整理路径由 T-MIG33/34/35 单测锁定 |
| tests/api（实机集成套件） | — | — | ✅ **447 passed / 18 failed（465）**，其中**本 diff 相关套件全绿** | Aspire 全栈实跑（见 2.1）：`admin-api/llm` 21/21、`agent-api/llm` 36/36、`admin-api/auth` 12/12 全绿（含 T-MR1/T-MR2/problem 53/issue 48/51 等直写型用例）；18 例失败全部落在 cloud-container(12)/cloud-workload(5)/agent-api-billing(1)，经实证为 2.1 所述端口冲突所致（服务间内联 URL `CLOUD_CONTROLLER_URL=10004`、`ADMIN_API_URL=10003` 指向另一栈 → 401/费用服务鉴权失败），与本 diff 无关 |
| tests/e2e（`admin-model-config.spec.ts` + `settings-llm.spec.ts`） | — | — | ✅ **20 passed / 0 failed（31.4s）** | 实机浏览器（Chromium）实跑（见 2.1 E2E 执行方式说明） |

### 2.1 执行环境备注

- Aspire 编排：agent-api / admin-api / controller-api / cloud-controller / admin-web / agent-web 全部 `Running / Healthy`，MongoDB 7 + Redis + RabbitMQ 4.2 容器就绪；迁移 005 随启动执行成功。
- **端口冲突排查（重要，测试红绿判定的关键前提）**：本机同时存在另一个工作流实例（`workflow-内建api渠道一期-2c729ccf`）的 Aspire 栈，其 dcp 进程持有 `10001/10003/10004` 三个固定代理端口。首轮集成套件按文档默认值指向这些端口，实际打到**另一栈的服务与另一套 MongoDB**（`localhost:36841`），而 `MONGODB_URI` 直写的测试数据落进**本栈 MongoDB**——造成「直写 DB → 服务读不到」的连锁假红（T-A7/T-MR2/problem 53/issue 51 四例直写型用例假红，另 12 个依赖 DB 预置的套件成片假红；`Register failed: Key not found` 等亦由此引发）。改用本栈服务真实监听端口后复跑即为真实结果。**以上假红均非代码缺陷**，但暴露了集成测试环境的真实风险：同机多工作流栈并存时，文档固定端口默认值会指向他人实例，建议 `tests/api`/`tests/e2e` 的 AGENTS.md 强调「必须取实际监听端口且核对服务进程归属」，或由测试脚本自动发现端口。
- **测试过程不得手工篡改共享状态**：排查期笔者曾用脚本直写 `admin_users`（翻转 `mustChangePassword`）与 `model_rename_records`（探针记录）定位问题，导致第三轮复跑出现二次假红（T-MR1 因两条同名探针台账断言失败；auth T-A7/normalized/T-A4 因管理员密码未按套件约定归一化到 `AdminTestPass123` 而连锁失败，并波及 cloud-container/cloud-workload 等依赖 `ensureAdminLogin` 的套件）。最终验证按 `tests/api/AGENTS.md` 要求**重启 Aspire 拿全新库**再跑（第四轮），全程不触碰共享状态。
- **E2E 执行方式说明**：前端 dev server 的 `/graphql` 代理目标由 `VITE_ADMIN_API_URL` / `VITE_API_URL` 决定，Aspire 注入的值是固定端口（`10003`/`10001`），在双栈并存下会代理到另一实例。为让 E2E 打到本栈后端，本轮用 `VITE_ADMIN_API_URL=http://localhost:38775` / `VITE_API_URL=http://localhost:33271` 另起 admin-web（`:5199`）/ agent-web（`:5198`）dev server（与 Aspire 版同源码同构建方式），Playwright 指向它们实跑两套特性用例 20/20 通过。建议 `tests/e2e/AGENTS.md` 同步补充「双栈并存时需核对前端代理目标指向本栈服务」的注意事项。

## 三、已验证（✅）

| 项目 | 结果 | 证据 |
|---|---|---|
| 后台添加供应商不再自动导入 | ✅ | `provider.ts` create/update 全部丢弃 `fetchModels` 结果、不写任何模型（原 `insertMany`/`bulkWrite` 重同步路径整体删除）；API T-P2（`models: []`）/T-P2b（更新不重同步）实测通过 |
| 导入幂等与并发兜底 | ✅ | `importModels` 先剔除「该供应商已存在」（重复导入返回 `[]` 且不访问上游），`insertMany(ordered:false)` + E11000 映射 `Model name already exists`；U-M5/M6/M9 + T-MU2 并发恰一胜一负 |
| 全局唯一口径一致 | ✅ | `assertNamesAvailable`（仅 `scope=global`）↔ partial unique index `scope_global_name_unique`（`partialFilterExpression: {scope:'global'}`）↔ 裁决 3 三方口径一致；user scope 同名不受影响（T-SC7） |
| 迁移 005 正确性 | ✅ | 保「createdAt 最小、_id 升序」最早者原名；`<name>-N` 跳全库占用名（T-MIG34 `gpt-4o-3/-4`）；供应商悬空留档「未知供应商」；`createIndex` 失败向上抛不静默降级（T-MIG36）；重跑无重复台账（T-MIG37）；schema 不声明索引规避 autoIndex 竞态（裁决 2） |
| 重名整理台账审计语义 | ✅ | `model_rename_records` 冗余 `providerName`、不随模型/供应商删除而删除（T-MR2 直写构造验证）；`modelRenameRecords` 只读、`renamedAt desc` |
| 删除放开与调用侧口径 | ✅ | `deleteGlobalModel` 任意全局模型可删；`billing-openai.ts:197` 已删模型 404 `模型不存在: <name>`；删除后同名可重导（T-MD1/E2E T-E25） |
| 后台鉴权与错误映射 | ✅ | 新增 Query/Mutation 全部 `assertAdmin` 首行守卫（R-M1）；`mapModelError` 统一出口（E11000→重名文案、连通性归一化文案、`Provider not found`） |
| 供应商删除级联 | ✅ | `provider.ts` delete/batchDelete 仍 `Model.deleteMany({providerId…})` 级联，本 diff 未破坏 |
| 前台 UI 不渲染后台供应商名 | ✅ | 「系统内置」组头固定文案 + `hideProviderName` 全量传入；E2E `getByText(providerName) count 0`（**API 层泄漏见 A-1**） |
| 前台既有能力不退化 | ✅ | 系统内置无删除/拖拽、开关置灰（裁决 13）；用户组拖拽只提交用户 id（裁决 14）；会话「切换模型」列表零改动（PRD §5.2） |
| 用户侧自动同步保持现状 | ✅ | T-SYNC1/T-SYNC2/T-UP1 实测：用户添加供应商仍自动同步模型、改 endpoint 重同步、留空保凭据 |
| 契约一致性 | ✅ | `contracts/admin-llm.graphql` ↔ `schemas/model.ts` ↔ `resolvers/model.ts` ↔ 两前端 `graphql/*` ↔ tests 逐字段对齐；`deleteGlobalCustomModel` 旧名全仓无残留 |
| 测试真实性（非假绿） | ✅ | 迁移/服务/resolver/组件单测断言具体行为（错误文案、insertMany 参数、sortOrder、aria 状态），回归会红；E2E 选择器与前端实现逐条对得上（`操作菜单`/`已导入`/`已存在`/`系统内置`/确认文案等）；无「永不命中」型断言（弱断言与缺口见 C 组） |
| 状态清理与串行性 | ✅ | API/E2E 用例 finally 清理（供应商级联删模型、台账自清）；Playwright `workers:1`；mock-server 改动向后兼容（默认 `FAKE_MODELS`） |
| 秘密信息 | ✅ | 全量新增行无硬编码凭据/无 XSS sink/无敏感日志/无 TODO 残留；`getDecryptedConnection` 仅服务端解密，摘要不含 endpoint/凭据 |

## 四、验收问题清单

### A-1（🟠）前台 GraphQL 仍向登录用户返回后台供应商名称 —— 违反 PRD §1.3/§4.2

- **问题描述**：前台任何登录用户执行 `query { models { provider { name } } }` 即可拿到全部**后台（global）供应商名称**（连带 `type/scope/id`）。`servers/agent-api/src/graphql/resolvers/model.ts:95-100` 的 `Model.provider` 对任意模型无条件返回 `providerService.findSummaryById(providerId)`，其摘要含 `name`（`services/provider.ts:36-46`）；`apps/agent-web/src/graphql/queries.ts:28-33` 的 `GET_MODELS` 实际请求 `provider { id name type isEnabled }`，名称**进入浏览器网络响应**（UI 只是不渲染）。更严重的是 `tests/api/src/agent-api/llm.test.ts:654-662`（T-SC5）把该泄漏**锁定为断言**（`Object.keys(found.provider)` 必须含 `name`），后续收口会被此用例误报为回归。
- **根因分析**：「系统内置」语义只在前端渲染层做了遮罩（分组 + `hideProviderName`），GraphQL 数据层没有按 `scope` 收口；`findSummaryById` 的注释声称「用户侧不可见全局供应商内部细节」，但本期 PRD §4.2 将供应商**名称**明确列为内部信息（"前台仅暴露面向用户的信息：模型名与「系统内置」标识，不暴露后台供应商名称、地址等内部信息"），§1.3 成功标准亦要求「前台任何位置都不出现后台供应商名称」。该行为为 release 存量（`git show origin/release` 对照确认），但本期 PRD 把它列入验收标准 → 本轮必须收口。
- **修复方案**：
  1. `servers/agent-api/src/graphql/resolvers/model.ts` `Model.provider`：`parent.scope === 'global'` 时返回 `null`（或不含 name/type 的中性摘要）；建议同时对 global 模型掩蔽 `providerId`（防按 id 反查）。
  2. `contracts/llm.graphql` `Model.provider` 注释补「global 模型返回 null」；`servers/agent-api/src/services/provider.ts` `findSummaryById` 注释同步真实口径。
  3. 改写 `tests/api/src/agent-api/llm.test.ts:654-662` T-SC5：断言 global 模型 `provider` 为 null/不含 `name`，user 模型仍返回自身供应商摘要（含 `name`）；E2E `settings-llm.spec.ts` 可加一条 API 层断言防回潮。
  4. agent-web 无需改动（分组按 `scope` 过滤，`provider?.name` 只用于用户组）。
- **验证结果**：待第二轮复核实测（修复后 `models` 查询响应中 global 模型无供应商名，T-SC5 改写后可证伪）。

### B-1（🟠）导入成功后 `refetch()` 失败被误报为「导入失败」，关闭弹窗场景必然触发

- **问题描述**：`apps/admin-web/src/components/models/ImportModelsDialog.tsx:104-126`——成功路径 `toast.success('成功导入 N 个模型')` 之后的 `await refetch()`（L116）与 `importModels` 同处一个 `try`，其 rejection 落入 L117-118 `catch` 直接 `toast.error(err.message)`。而 `ProviderSection.tsx:300-307` 关闭弹窗时把 `importTarget` 置 `null` → `providerId` prop 变 null → `useQuery` 的 `$providerId: ID!`（L42）`refetch()` **必然失败**。典型场景：导入进行中「关闭」按钮未禁用，用户关闭弹窗 → mutation 正常 resolve、导入实际成功，随后弹出误导性的「导入失败」错误。
- **根因分析**：成功反馈与「刷新清单」两个语义被包进同一异常通道；弹窗关闭后组件仍尝试用已失效的变量刷新。属「导入结果反馈」准确性缺陷（PRD 功能点 1 验收：「勾选导入后…导入结果有明确反馈」）。
- **修复方案**：① `refetch()` 移出主 `try/catch` 单独兜底（失败仅静默或 console.warn，不覆盖导入结果反馈）；② 发起导入时捕获 `providerId` 闭包值，或在弹窗已关闭（`!open`）时跳过 refetch；③ 补单测：导入 resolve + refetch reject → 仅出现成功反馈、无错误 toast。
- **验证结果**：待第二轮复核实测。

### B-2（🟠）PRD「导入过程中可取消，取消不影响已完成的导入」未实现且零测试覆盖

- **问题描述**：PRD 功能点 1 明确「导入过程中可取消，取消不影响已完成的导入」，§3.4 界面关键元素为「导入/**取消**按钮」，§3.5 边界表「导入过程中取消/关闭弹窗 | 已完成的导入保留，**未开始的不执行**」。实现侧：弹窗只有「关闭/导入」两个按钮（`ImportModelsDialog.tsx:207-214`），导入在途无任何取消语义；导入是**单次批量 mutation**（`mutations.ts:132-142`），「未开始的不执行」无从谈起（误触大批量导入后无法止损）；`tests/api` 与 `tests/e2e` 对取消语义**零覆盖**（全部用例均在导入成功后才点关闭）。
- **根因分析**：plan 裁决 17 单方面把口径收窄为「关闭弹窗不中止服务端写入、重开以服务端为准」，但 PRD 未同步修订（v1.1 修订未覆盖此项），导致「未开始的不执行」这一验收项既未实现也未在 PRD 层面声明裁剪；同时该语义没有任何测试锁定（连裁决 17 的实际行为「重开后以服务端『已导入』为准」也未测）。
- **修复方案**（二选一，需回写 PRD）：
  1. **对齐 PRD**：导入按小批量分片提交，提供明确「取消」入口（停止后续分片、已完成保留），补 E2E/API 用例；
  2. **修订 PRD v1.2**：如实收窄为「关闭弹窗不中止服务端写入；重新打开以服务端结果为准」，并补测试锁定裁决 17 的实际行为（导入中/后关闭弹窗 → 重开勾选清零、「已导入」标记以服务端为准；已完成项保留）。
  两条路线均须配合 B-1 修复（关闭弹窗不得误报失败）。
- **验证结果**：待第二轮复核实测。

### C 组（🟡 建议，随本轮修复一并收口，不单独构成打回）

| # | 问题 | 位置 | 修复建议 |
|---|---|---|---|
| C-1 | 组内拖拽保存时 `fullIds` 按组展示顺序拼接，会连带改写未操作组的全局相对顺序（PRD「分组不改变…顺序」边缘场景） | `apps/admin-web/.../ModelSection.tsx:166-169` | 保留其他模型原始全局位置，仅替换被拖拽组片段；补多组场景断言 |
| C-2 | `error && data`（加载成功后 refetch 失败）时导入按钮被 `!!error` 静默禁用，用户可见列表却点不了导入 | `ImportModelsDialog.tsx:211` | 禁用条件改 `error && !data`，或渲染内联错误横幅 + 重试 |
| C-3 | 导入失败明细只有一次性 toast（含原始英文错误），弹窗内无「成功与失败明细」持久反馈（PRD §3.5） | `ImportModelsDialog.tsx:114-125,199-203` | 结果区持久展示成功数 + 失败名列表/原因 |
| C-4 | 新建自定义模型后供应商行「N 个模型」计数不刷新（`refetchQueries` 缺 `ADMIN_PROVIDERS`） | `ModelSection.tsx:180-185` | 加入 `ADMIN_PROVIDERS` |
| C-5 | `ImportGlobalModelsMutation` 类型声明 `AdminModelData[]` 与实际选择集不符（类型谎报） | `apps/admin-web/src/graphql/types.ts:118-120` | 改 `AdminProviderModelData[]` 或补齐选择集 |
| C-6 | T-MR1 在全新/无重名环境空转假绿（空集断言全真通过），宣称「与实际改名数一致」但未验证 | `tests/api/src/admin-api/llm.test.ts:354-376` | 空集显式 skip/标注前提，或用例内自建重名→改名对照 |
| C-7 | T-E21 断言依赖约 4s 自动消失的 sonner toast，慢 CI 抖动 | `tests/e2e/src/admin-model-config.spec.ts:121` | 断言提前到保存成功后，或改断言持久文案 |
| C-8 | T-E23 靠 `waitForTimeout(50)` + `.first()` 隐式依赖 createdAt 排序 | `admin-model-config.spec.ts:328,339-340` | 按供应商名定位操作菜单，去 sleep |
| C-9 | `settings-llm.spec.ts:255` 恒真断言（导入模型本无删除入口，探测不到只读回归） | `tests/e2e/src/settings-llm.spec.ts:255` | 改为「系统内置组内无任何删除按钮」或删除该行 |
| C-10 | `importGlobalModels` 不校验 names 来自上游清单（`fetchModels` 仅作连通性门禁），契约措辞「导入上游模型」与行为有偏差；裁决 5 已声明该取舍但 PRD 未补口径 | `servers/admin-api/src/services/model.ts:159-210`、`contracts/admin-llm.graphql:138` | 收紧实现并改测试，或契约/PRD 如实声明「仅做连通性门禁」 |
| C-11 | 迁移 005 「先改名后写台账」间存在崩溃窗口：改名成功但台账缺失且重跑不补（改名对照「条目数与实际改名数一致」在该窗口下失守） | `servers/admin-api/src/migrations/005-model-name-unique-global.ts:83-97` | 先写台账待改名成功后补全，或改名+台账同批 `bulkWrite`/事务（副本集）；至少在日志中输出改名对照以留痕 |
| C-12 | 前端测试缺口：多组 `fullIds` 拼接、导入在途双击防护、导入后条目转「已导入」禁选、用户组既有能力（删除/拖拽/开关）正向断言、`groupsRef` 防陈旧闭包 | `apps/admin-web`、`apps/agent-web` 各 `__tests__` | 按 C-1/B-2 修复一并补用例 |
| C-13 | 前台空态文案「暂无可用模型，添加供应商后自动拉取」被改为「暂无可用模型」，与用户侧「添加供应商自动同步」现状不符 | `apps/agent-web/.../ModelSection.tsx:179` | 恢复「添加供应商后自动同步」类提示（避开后台「导入」措辞） |
| C-14 | mock-server Anthropic 分支不可达（既有死代码，本次未引入） | `tests/api/src/mock-server.ts:21,38` | 可选清理 |
| C-15 | E2E 多处断言 Base UI `aria-disabled` 渲染假设，待 CI 实证（若不渲染则为假红需改断言） | `admin-model-config.spec.ts:178,347-348`、`settings-llm.spec.ts:253` | 与单测同口径核对一次 |

## 五、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| A-1 | 前台 API 泄漏后台供应商名称 | 「系统内置」仅 UI 遮罩，GraphQL 数据层未按 scope 收口；T-SC5 锁定泄漏 | ✅ 已修复（数据层掩蔽 + T-SC5 改写，探针实证） | `36e62dd` |
| B-1 | 导入成功误报「导入失败」 | refetch 与导入同 try；弹窗关闭后变量失效必败 | ✅ 已修复（异常通道分离 + 关闭/切换跳过 refetch，T-W18/T-W20 锁定） | `36e62dd` |
| B-2 | 取消语义未实现且零覆盖 | 裁决 17 收窄 PRD 未回写；无测试锁定 | ✅ 已修复（PRD v1.2 如实收窄 + 提案/计划/裁决回写，T-W19 锁定） | `36e62dd` |
| C-1~C-15 | 建议项 | 见问题清单 | ✅ 15/15 全部收口（含 T-W23/T-W21/T-W22/T-W24/T-MIG38/T-AW9/T-AW10 等新回归） | `36e62dd` |

## 六、最终验证

| 层级 | 首轮 | 第二轮（返工 `36e62dd` 后） | 说明 |
|---|---|---|---|
| tsc（5 包） | ✅ 0 error | ✅ 0 error | 两轮均本机复跑（admin-api/agent-api/cloud-controller/admin-web/agent-web） |
| eslint（2 前端） | ✅ 0 error | ✅ 0 error | agent-web 6 warning 均为本 diff 外存量 |
| 单测/组件测试 | ✅ 2074 passed / 1 skipped | ✅ **2087 passed / 1 skipped**（562+661+197+227+440） | 新增 T-W18~24、T-AW9/10、T-MIG38、A-1 单测等 |
| tests/api 集成 | ⚠️ 447 passed / 18 failed（465，18 例为同机双栈端口冲突假红） | ✅ **463 passed / 2 skipped / 0 failed（465）** | Aspire `--isolated` 全新栈 + 显式注入本栈端口/MONGODB_URI/ADMIN_INITIAL_PASSWORD/INTERNAL token；2 skip = T-MR1 空台账显式 skip + 1 项需 `INTERNAL_API_TOKEN` 的环境跳过 |
| tests/e2e 特性 | ✅ 20 passed / 0 failed | ✅ **20 passed / 0 failed（32.3s）** | 本栈 Aspire 托管前端直连（isolated 端口注入正确） |
| 迁移 005 实库 | ✅ 执行成功 | ✅ 执行成功（`[Migration 005] global model name unique index ensured`） | 全新库只建索引路径；重名整理/台账路径由 T-MIG30~38 自建数据覆盖 |
| 回退探针 | — | ✅ 4/4 命中（A-1/B-1/B-2/C-1 各自回退均红） | 见 8.4 |
| 验收结论 | ❌ 打回（REJECT） | ✅ **通过（ACCEPT）** | 3 × 🟠 闭环、15 × 🟡 收口 |

## 七、经验总结

1. **「系统内置/匿名化」类需求必须在数据层收口**：UI 不渲染 ≠ 不暴露，GraphQL 响应本身就是「前台位置」；配套回归断言（T-SC5）要按新口径改写，否则测试会把泄漏固化成规格。
2. **计划裁决不得单方面收窄 PRD 验收项**：裁决 17 与 PRD §3.5 冲突未回写 PRD，导致行为缺口 + 零覆盖双重问题；裁剪需求范围必须回到 PRD 走版本修订（本次 PRD v1.1 已有成熟修订机制可循）。
3. **异步反馈链路要把「操作结果」与「刷新副作用」分离异常通道**：成功后的 refetch 失败误报为业务失败，是「导入结果反馈」类需求的常见回归点；组件卸载/变量失效后仍 refetch 也需显式防护。
4. **审计台账与数据改写要同批落库或留痕**：迁移 005 「先改名后记账」的崩溃窗口使「条目数与实际改名数一致」验收项在异常路径失守（同型问题历轮 R2-3/R5-1④ 已多次出现，属高频缺陷模式）。
5. **空集断言要显式声明前提**：T-MR1 型「空真通过」用例在 fresh 环境是假绿，验收门禁要么自建对照数据、要么 skip 标注，避免虚指兜底。
6. **同机多工作流栈并存是集成测试的新常态风险**：固定端口（`10001/10003/10004`）会被先起的实例占走，文档默认值与服务间内联 URL 会把测试与服务调用导向他人实例，产生大面积「直写 DB 读不到 / 401」假红；集成验证必须核对「服务进程归属 + 实际监听端口 + 前端代理目标」三件套，并把该注意事项沉淀进 `tests/api`、`tests/e2e` 的 AGENTS.md。
7. **「修好了」必须用回退探针证明**（第二轮经验）：新回归用例只有在「回退修复 → 用例红、恢复修复 → 用例绿」两个方向都实测过，才算具备证伪能力；否则空转回归（修复前照过）会连续多轮掩盖未修复缺陷（历轮 R4-2 三连空转即此模式）。本轮 4 个探针（A-1/B-1/B-2/C-1）全部双向命中。
8. **skip 计数要如实解释**（第二轮经验）：集成套件的 skipped 数随注入的环境变量变化（本轮注入 `MONGODB_URI`/`CLOUD_CONTROLLER_INTERNAL_TOKEN` 后 skip 由 22 降到 2），验收报告须逐个说明 skip 的成因与替代覆盖，避免「跳过 = 已验证」的虚指。

## 八、第二轮 AI Review 复核（2026-10-21，AI Review 节点·通过）

> **复核对象**：返工提交 `36e62dd`（`fix(api-channel): 收口前台供应商泄漏与导入反馈/取消语义（Review 返工）`，28 文件 / +564 −130），对账文档 `docs/engineering/acceptance/20261021-integration-release-review-fixes.md`。评审范围仍为 `integration..release`（PR #245，11 提交 / 63 文件 / +5685 −669，含本轮报告与返工对账文档）。
> **复核方法**：① 逐行复核返工 diff（非抽查），对照首轮 A-1/B-1/B-2 修复要求逐条核对；② C-1~C-15 逐项比对代码与测试落点；③ **回退探针实证**（4 项，见 8.4）；④ 独立复跑 tsc/lint/单测五包 + Aspire `--isolated` 全新栈 tests/api 全量 + E2E 两套特性用例 + 迁移 005 实库执行（**不采信自报**）。

### 8.1 🟠 三项闭环核对

| # | 首轮要求 | 返工落实 | 复核实证 | 结论 |
|---|---|---|---|---|
| A-1 | ① `Model.provider` 对 global 返回 null、建议掩蔽 `providerId`；② 契约/注释同步；③ T-SC5 改写为可证伪断言 | ① `resolvers/model.ts` `Model.provider` 对 `scope==='global'` 直接 `null`（不查库）、`Model.providerId` 同步返回 `null`；`services/provider.ts` `findSummaryById` 增加 global 兜底（纵深防御）；② `contracts/llm.graphql`/`schemas/model.ts` `providerId: ID!`→`ID` 并注明掩蔽口径；③ T-SC5 改写：global 断言 `provider===null && providerId===null`，同用例自建 user 供应商对照断言摘要含 `name` 且键集仅 `['id','isEnabled','name','scope','type']` | 掩蔽判定链路完整：`mapModel` 输出含 `scope`（`normalizeScope`），`providers` 查询仅 `USER_SCOPE_FILTER`，全仓无第二条泄漏路径；`agent-web` 仅类型改 `string \| null`，无需改渲染 | ✅ 真修复（探针 C·实机栈实证） |
| B-1 | ① refetch 移出主 try/catch；② 弹窗关闭/切换供应商时跳过 refetch；③ 补单测 | ① 导入主流程先落 `result`/toast，refetch 独立 `try/catch` 失败仅 `console.warn`；② `dialogRef` 持有 `{open, providerId}`，异步回包后校验「仍对同一供应商打开」才 refetch；③ `importingRef` 防在途双击 | 另核对 Apollo Client 4.3.3 源码：`awaitRefetchQueries:false` 时 `markMutationResult` 不 await refetch 结果，mutation promise 不会因 `refetchQueries` 失败而 reject——同类误报通道（`refetchQueries: [ADMIN_MODELS, ADMIN_PROVIDERS]`）亦不复现 | ✅ 真修复（探针 B/B2 实证） |
| B-2 | 路线①（对齐 PRD）或路线②（PRD v1.2 如实收窄 + 测试锁定），并回写 PRD | 选路线②：PRD v1.2 功能点 1/§3.4/§3.5/§4.2 同步改为「单次批量提交；关闭弹窗不中止服务端已开始的写入；重开以服务端结果为准（已导入标记、勾选清零）」，删除「未开始的不执行」承诺；提案 v1.2 / 计划 v1.1 / 裁决 17 回写；T-W19 锁定「导入中关闭 → 不 refetch、不误报；重开勾选清零且已导入禁选」 | 逐条比对 PRD §3.4（「导入/关闭按钮」+结果持久反馈）、§3.5（边界表新增「关闭弹窗」与「names 不在上游清单」两行）、§4.2（数据层收口声明）与实现一致，无残留「未开始的不执行」措辞；`ImportModelsDialog` 重开时 `useEffect` 清空 selected/keyword/importedNames/result | ✅ 真修复（探针 B2 实证） |

### 8.2 🟡 C 组收口核对（15/15）

| # | 复核落点 | 结论 |
|---|---|---|
| C-1 | `ModelSection.handleDragEnd` 改用 `modelsRef` 全局顺序原位替换被拖拽组片段（`groupIds` 槽位填充），T-W23 交错多组断言 `['b','x','a','y']` | ✅（探针 A 实证） |
| C-2 | 导入按钮禁用条件 `!!error` → `!!error && !data`，T-W21 | ✅ |
| C-3 | 结果区 `role={status\|alert}` 持久展示成功/失败明细（成功 `text-foreground`/失败 `text-destructive`），T-W22 断言持久文案 | ✅ |
| C-4 | `handleCustomSave` refetchQueries 增加 `ADMIN_PROVIDERS`，T-W24 断言两查询 | ✅ |
| C-5 | `ImportGlobalModelsMutation.importGlobalModels: AdminProviderModelData[]` 与选择集一致 | ✅ |
| C-6 | T-MR1 台账为空时 `ctx.skip()` 并注明前提与替代覆盖（迁移单测） | ✅（本轮实跑即走该 skip，行为符合设计） |
| C-7 | T-E21 删除 4s toast 断言，改持久文案「0 个模型」 | ✅ |
| C-8 | T-E23 按供应商名 `filter({has})` 定位行，去 `waitForTimeout(50)` 与 `.first()` | ✅ |
| C-9 | `settings-llm.spec.ts` 断言收敛到系统内置模型行（`systemRow`），消除全 section `count=0` 恒真 | ✅ |
| C-10 | `contracts/admin-llm.graphql` `importGlobalModels` 注释、`services/model.ts` JSDoc、PRD §3.5 三处一致声明「仅连通性门禁 + 全局重名校验，不按上游清单白名单校验」 | ✅ |
| C-11 | 迁移 005 先按 `(modelId,batchId)` 幂等 `updateOne` upsert 台账（`$setOnInsert`）再 `updateOne` 改名，T-MIG38 以 `invocationCallOrder` 锁定调用顺序 | ✅（残余窗口见 8.5-1） |
| C-12 | 新增 admin-web T-W18/20/21/22/24（双击/禁选/失败持久反馈/计数刷新）、agent-web T-AW9（用户组删除/开关/拖拽正向能力）、T-AW10（`groupsRef` 最新闭包） | ✅ |
| C-13 | agent-web 空态恢复「暂无可用模型，添加供应商后自动同步模型」，单测同步 | ✅ |
| C-14 | `mock-server.ts` 删除不可达 Anthropic `x-api-key` 分支与 `FAKE_ANTHROPIC_MODELS` 死常量（Anthropic 与 OpenAI 同走 `/v1/models`） | ✅ |
| C-15 | E2E 保持 `aria-disabled` 断言口径，本轮实机 Chromium 20/20 通过 | ✅ |

### 8.3 独立验证结果（第二轮本机实跑，不采信自报）

| 层级 | 结果 | 备注 |
|---|---|---|
| tsc | admin-api 0 / agent-api 0 / cloud-controller 0 / admin-web 0 / agent-web 0 | `--noEmit` / `tsc -b` |
| eslint | admin-web 0 error / agent-web 0 error | 6 条 warning 均为本 diff 外存量 |
| 单测/组件 | **2087 passed / 1 skipped**：admin-api 562（1 skipped）、agent-api 661、cloud-controller 197、admin-web 227、agent-web 440 | 与返工对账文档自报逐项一致 |
| tests/api（实机集成） | **463 passed / 2 skipped / 0 failed（465）**，28 文件全过 | Aspire `--isolated` 全新栈；2 skip 逐项核明：① T-MR1（`model_rename_records` 实查 0 条 → 按 C-6 设计显式 skip）；② `admin-api/billing` 1 项 `it.skipIf(!process.env.INTERNAL_API_TOKEN)`（本轮未注入该变量，非缺陷）。较自报 443/22 更少 skip，因本轮额外注入 `MONGODB_URI` 与 `CLOUD_CONTROLLER_INTERNAL_TOKEN` |
| tests/e2e（特性两套） | **20 passed / 0 failed（32.3s）** | `admin-model-config.spec.ts` 9 例 + `settings-llm.spec.ts` 11 例，Aspire 托管前端直连本栈（`VITE_ADMIN_API_URL=44773`、`VITE_API_URL=39957` 经进程环境核对） |
| 迁移 005 | 全新栈启动即执行：`[Migration 005] global model name unique index ensured` | 重名整理/台账写入路径由 T-MIG30~38 自建数据覆盖（含 T-MIG38 顺序锁定） |

**执行环境**：`aspire start --isolated`（服务/Mongo/Redis/RabbitMQ 随机端口，独立 user secrets），与同机另一工作流栈（`dcp` 持 `10001/10003/10004`）完全隔离；测试注入本栈实际端口 `agent-api:39957 / admin-api:44773 / controller-api:38525 / cloud-controller:42039` 与本栈 `MONGODB_URI`/`ADMIN_INITIAL_PASSWORD`/内部 token，全程未手工改写共享状态（与首轮「测试过程不得手工篡改共享状态」教训一致）。

### 8.4 回退探针实证（修复真伪与回归可证伪性）

| 探针 | 操作 | 预期 | 实测 | 判定 |
|---|---|---|---|---|
| A（C-1） | `ModelSection.handleDragEnd` 回退为按组拼接 `fullIds` | T-W23 红 | `× T-W23: preserves other groups relative order…`（1 failed / 16 passed） | ✅ 可证伪 |
| B（B-1） | refetch 失败改回 `toast.error`（误报通道） | T-W18 红 | `× T-W18: does not report a successful import as failed…`（1 failed / 11 passed） | ✅ 可证伪 |
| B2（B-2） | 删除 `dialogRef`「弹窗仍对同一供应商打开」守卫 | T-W19 红 | `× T-W19: closing while the import is in flight…`（1 failed / 11 passed） | ✅ 可证伪 |
| C（A-1） | **实机栈**回退 `Model.provider`/`providerId` 掩蔽与 `findSummaryById` global 兜底，`aspire resource agent-api restart` | T-SC5 红 | `× should hide the backend provider from global models via Model.provider (T-SC5)`，`AssertionError: expected { Object (id, name, ...) } to be null`（1 failed / 35 skipped）；恢复代码重启后 `agent-api/llm` **36/36 绿** | ✅ 可证伪 |

四个探针均为「回退即红、恢复即绿」双向命中，确认：① A-1 数据层掩蔽是 T-SC5 通过的**充要改动**（不是靠 mock/断言放水）；② B-1/B-2/C-1 的新回归具备真实证伪能力，不存在空转回归。

### 8.5 残余观察项（🟡，不构成打回，如实登记）

1. **迁移 005 台账与改名的顺序反转引入新的极窄残余窗口**：现为「先 upsert 台账（`(modelId,batchId)` `$setOnInsert`）→ 后改名」。若在两者之间崩溃，且重跑时该模型的改名目标重算为不同名（或已不再是重名组成员），台账 `newName` 可能与实际改名结果不符（甚至成为「从未发生」的台账条目）。该残余**有发现线**：`T-MR1` 对每条台账断言 `doc.name === record.newName`（模型未删时）可将其暴露；建议后续以 Mongo 事务包住「改名 + 台账」或以 `$set` 更新 `newName` 并在改名完成后二次核对，彻底闭合两个方向的窗口。
2. **`apps/admin-web/src/components/__tests__/ModelSection.test.tsx` 中 T-W9 用例声明被并成一行**（`it('T-W9: …', async () => {    let currentModels = …`，`36e62dd` 合并冲突式排版残留），纯格式瑕疵、不影响执行。
3. **`tests/api` 的 2 项 skip 依赖注入变量**（见 8.3）：验收/CI 如需全覆盖 `admin-api/billing` 内部 token 用例，需注入 `INTERNAL_API_TOKEN`；建议 `tests/api/AGENTS.md` 环境变量表补一行说明该变量与 `CLOUD_CONTROLLER_INTERNAL_TOKEN` 的区别。

### 8.6 复核结论

- 首轮 3 × 🟠（A-1/B-1/B-2）**全部闭环**：A-1 在 GraphQL 数据层收口（`provider`/`providerId` 双掩蔽 + `findSummaryById` 兜底 + T-SC5 改写为可证伪断言）；B-1 导入结果与 refetch 副作用分离异常通道并补齐关闭/切换/双击防护；B-2 以 PRD v1.2 如实收窄取消语义并经 T-W19 锁定，文档-实现-测试三方口径一致。
- 首轮 15 × 🟡（C-1~C-15）**全部收口**，其中 C-1/C-11/C-12 均补了可证伪回归（T-W23/T-MIG38/T-W18~24、T-AW9/10）。
- 独立复跑七层全绿（tsc/lint/单测 2087/tests/api 463-2-0/E2E 20-0/迁移 005/探针 4/4），与返工对账文档自报一致且 skip 更少（0 failed）。
- 残余 3 项 🟡 观察项（8.5）均已如实登记并给出发现线/后续建议，不构成打回。

**按验收红线「🟠 重要 → 打回返工；🟡 → 记录并随修复收口」，本轮无 🔴/🟠 问题，integration 集成验收通过（ACCEPT）**，可进入 release 合入流程。

## 相关文档

- [[20261021-integration-release-review-fixes|返工对账文档：首轮打回三项 + C 组收口（返工 36e62dd）]]
- [[20261019-integration-release-acceptance-report|上一轮 integration→release 集成验收报告（费用中心）]]
- [[../proposals/20261020-fix-api-channel-model-fixes|技术提案：内建 API 渠道一期上线后问题修复]]
