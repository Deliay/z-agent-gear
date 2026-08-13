---
description: Agent 工作流 phase2（图编辑/统一实例化/节点编辑/admin 工具集）integration→release 合并前 AI 代码验收报告
type: Permanent
---

# Agent 工作流 Phase2 验收报告（2026-08-12）

> **状态**: ❌ 验收不通过 —— 发现 3 个阻塞、5 个严重问题，建议修复后再合入 release

## 关联文档

- PRD：[[20260811-agent-workflow-phase2]]（docs/product/draft/20260811-agent-workflow-phase2.md）
- 技术方案：[[20260811-feat-agent-workflow-phase2]]（docs/engineering/proposals/20260811-feat-agent-workflow-phase2.md）
- 实现方案（plan）：docs/engineering/plan/20260811-feat-agent-workflow-phase2.md
- 分支：`integration`（PR #168 → release）
- 验收方式：AI 代码评审（diff：`origin/release..integration`，17 commits，41 文件，+4650/-827）+ 单测执行
- 验收日期：2026-08-12

## 需求概述

工作流 phase2：模板图编辑（graph editing）、统一实例化（TEMPLATE/CONFIGURED/BLANK 三来源）、实例节点编辑（updateWorkflowNode）、admin-tools MCP 工具集（AI 可管理工作流资源）、orchestrator 快照与 rework/resume 重挂 mode/model、前端 WorkflowGraphEditor/EditInstanceNodeDialog/InstantiateWorkflowDialog 重构。

## 验收问题清单

### 阻塞（合入前必须修复）

### 1. TEMPLATE/BLANK 来源实例必然触发 GraphQL 非空违规

**问题描述**：`WorkflowInstance.configuredWorkflowId` 在契约（`contracts/workflow.graphql:152`）与服务端 schema（`servers/agent-api/src/graphql/schemas/workflow.ts:134`）中均声明为 `ID!`（非空），但统一实例化对 `source=TEMPLATE/BLANK` 的实例落库 `configuredWorkflowId: null`（`services/workflow/instance.ts:159`），而 `mapInstance` 用 `toId(doc.configuredWorkflowId)` 原样返回 `null`（`resolvers/workflow.ts:124`，`toId(null)` 返回 null）。

**触发场景**：任何 TEMPLATE/BLANK 来源实例化后，`instantiateWorkflow` 响应即抛 "Cannot return null for non-nullable field" 并沿 `WorkflowInstance!` 向上传播使整次 mutation 报错——实例实际已创建，客户端误判失败重试还会产生重复实例；此后 `workflowInstances`/`workflowInstance` 查询包含该实例时整个查询报错。

**修复方向**：契约与 schema 把 `configuredWorkflowId` 改为 `ID`（可空），三来源实例化下它本来就不保证存在。

### 2. E2E `instantiate` 辅助函数仍用已删除的旧 mutation 签名，整套 workflow.spec.ts 跑不起来

**问题描述**：`tests/e2e/src/workflow.spec.ts:219-230` 的 helper 仍发送 `instantiateWorkflow(configuredWorkflowId:..., workspaceId:..., name:...)`。服务端 schema 已把签名替换为 `instantiateWorkflow(input: InstantiateWorkflowInput!)`（`schemas/workflow.ts:237`，契约同步），旧参数在 GraphQL 校验阶段即报 "Unknown argument"。

**触发场景**：`instantiate()` 被 `advanceToExecRunning` 及 E2E-2/3/4/7/8/10、P2-E2E-17/18 等几乎所有用例依赖，helper 内 `if (body.errors) throw` 直接抛出，整套 workflow.spec.ts 无法运行。api 测试的 `INSTANTIATE_WORKFLOW` 已改成 input 形式，e2e 漏改——说明这套 E2E 在本分支未被真实执行过。

**修复方向**：helper 改为 input 形式（`source: 'CONFIGURED'` + `nodes`），仿照 `tests/api/src/agent-api/workflow.test.ts` 的 `instantiateInput()`。

### 3. E2E-18 调用 `instantiateWorkflowFromConfigured` 缺少必填 `nodes`，断言必失败

**问题描述**：`tests/e2e/src/workflow.spec.ts:1489-1495` 未传 `nodes`，但工具实现 `servers/agent-api/src/services/workflow/admin-tools.ts:360` 对该工具 `requireArgs([... 'name', 'nodes'])`，缺参抛 `INVALID_PARAMS` → `isError: true` → `expect(instantiated.isError).toBe(false)` 失败。根源疑似 proposal 时序图（`docs/engineering/proposals/20260811-feat-agent-workflow-phase2.md:274`）写的也是无 nodes 的调用，与实现/ADMIN_TOOL_SCHEMAS 不一致，测试照抄了文档。

**修复方向**：二选一——测试补齐完整 `nodes`；或工具在缺省 `nodes` 时自动加载已配置工作流的图（并同步改 schema required 与 proposal 时序图）。无论哪种，proposal 时序图需修正。

### 严重

### 4. 新实例的 HUMAN/FLAG 节点被误判为「旧实例」，编辑必然报错

**问题描述**：实例化快照时 HUMAN/FLAG 节点按图校验不允许有 `prompts`/`agentConfig`，落库后两字段恒为 `undefined`（`instance.ts:144-146`）。`updateNode` 用 `node.prompts === undefined && node.agentConfig === undefined` 判断旧实例并触发 `backfillSnapshotFromConfigured`（`instance.ts:203-208`），于是**所有新实例的 HUMAN/FLAG 节点都会走回查**；回查 `ConfiguredWorkflow.findById(instance.configuredWorkflowId)`，TEMPLATE/BLANK 来源实例该值为 `null`，直接抛「实例引用的已配置工作流不存在：null」（`instance.ts:248-250`）；CONFIGURED 来源配置被删除（本 PR 放开了删除限制）同样抛错。

**触发场景**：前端 EditInstanceNodeDialog 修改任意模板/内容直建实例的人类节点名称/描述——100% 失败。

**修复方向**：判旧逻辑考虑 `type`（仅 AI 节点需要回查），或快照落库时 HUMAN/FLAG 节点写入标记值；回查前判 `configuredWorkflowId` 非空。现有测试 N3 只覆盖 AI 旧节点，需补该路径测试。

### 5. instantiate 不再校验 templateId/configuredWorkflowId 的存在性与归属

**问题描述**：旧实现 `ConfiguredWorkflow.findOne({ _id, userId })` 找不到即拒绝；新实现只校验非空（`instance.ts:99-100`），随后把 ID 原样存进实例（`instance.ts:159`）。可传入他人或不存在的 configuredWorkflowId/templateId，来源溯源数据不可信；回查路径与 `orchestrator.loadConfiguredNode` 均按 `findById` 无 userId 过滤读配置，存在跨用户引用口子。

**修复方向**：CONFIGURED 时校验配置存在且属当前用户；TEMPLATE 时校验模板存在且可见（自有或 isBuiltin）。

### 6. updateNode 完全绕过内容校验，可把节点改成运行时必挂的状态

**问题描述**：`updateNode`（`instance.ts:193-200`）对所有字段直接 `$set`：不调用 `validateAgentConfigs`（acpServerType 可改为控制器能力之外的类型）；`agentConfig` 置 null / `prompts` 置 `[]` 可绕过「AI 节点至少 1 条提示词/必须有 agentConfig」的图校验；`requiresWorktree`/`initNewWorktree` 改 true 时不重做实例外化时的 git 校验。错误只在节点启动时以「流程卡死」形式暴露。

**修复方向**：updateNode 内对 AI 节点补 `validateAgentConfigs`（按实例 controllerId 读 capabilities）及 prompts 非空校验，worktree 变更补 git 校验。

### 7. updateWorkflowNode 可将 name/stage 显式置 null，污染实例并打挂查询

**问题描述**：`WorkflowNodeUpdateInput` 的 `name: String`、`stage: String` 可空，客户端可显式传 `null`；服务层用 `!== undefined` 判断（`instance.ts:194-196`），null 通过并被 `$set` 写入（`findOneAndUpdate` 默认不跑校验器），而输出类型 `WorkflowNode.name/stage` 是 `String!`——之后任何返回该实例的查询抛非空违规，且数据已被污染。

**修复方向**：服务层对 `name === null`/`stage === null` 拒绝或忽略。

### 8. 只读「查看模板」模式下节点详情完全不可见（功能回归）

**问题描述**：`WorkflowGraphEditor.tsx:286` 节点默认全部折叠，而 `:360` 折叠/展开按钮 `disabled={readOnly}`。`TemplateEditorDialog` 只读模式（内置模板「查看」入口）现在只能看到节点类型按钮和节点名，提示词、产物标题、依赖、Worktree 配置等详情永远无法展开。旧版行为是所有字段以 disabled 形式展示，本次重构引入回归。

**修复方向**：readOnly 时不要禁用折叠切换按钮，或 readOnly 时默认全部展开。

### 一般

### 9. collapsed 状态以索引为键、仅 mount 时初始化、删除节点不重编号

`WorkflowGraphEditor.tsx:286,310-317`：(a) 父组件异步载入节点（useQuery/useEffect）时「默认全部折叠」失效——mount 时 `nodes=[]`，collapsed 初始化为空集，节点载入后全部展开；(b) 删除中间节点后 collapsed 中索引不重排，后续节点折叠状态错位。**修复方向**：折叠状态改以稳定 nodeKey 为键；删除时重建集合。

### 10. updateNode 与引擎 start 转移存在 TOCTOU 竞态

引擎对 AI 节点先 `await onNodeStart`（创建会话，慢操作）再置 RUNNING/startedAt 并 `save()`；会话创建期间节点在 DB 中仍是 READY+startedAt=null，updateNode 的原子过滤条件仍匹配——配置修改落库成功但会话已按旧配置创建；且 `findOneAndUpdate`（不递增 `__v`）与引擎 `save()`（乐观锁）并发写同一文档可能 VersionError 或互相覆盖。**修复方向**：引擎拉起会话前先落库中间态，或 updateNode 过滤条件加「启动中」标记。

### 11. setMode/setModel 乐观写 Session 文档，可能与真实状态永久不一致

`session.ts:201,217`：`redis.publish` fire-and-forget，控制器离线或 ACP 侧拒绝时无回执，但 Session 文档已写入新值；`updateOne` 不带 `status: 'idling'` 条件，竞态下仍覆写；SSE 事件流只广播不回写文档，错误值不会被纠正。**修复方向**：updateOne 加 `{ status: 'idling' }` 条件。

### 12. 实例化对话框 TEMPLATE 来源无空态提示

`InstantiateWorkflowDialog.tsx` step 1：CONFIGURED 来源列表为空时有引导文案，TEMPLATE 来源没有——无模板时用户面对空白区域，无法区分加载中还是无数据。

### 13. api A2「三来源实例化，节点快照完整」断言空转（假阳性）

`tests/api/src/agent-api/workflow.test.ts` A2：服务端 `instantiate()` 完全不读取来源（见问题 5），节点图全部来自客户端提交的 `input.nodes`，断言的 prompts 正是测试自己提交的值——即使来源加载逻辑整体缺失该断言也照过；且无用例覆盖「source=CONFIGURED 但 configuredWorkflowId 不存在/属于他人」的负向路径。**修复方向**：补负向用例（配合问题 5 修复）。

### 建议

| # | 问题 | 位置 |
|---|------|------|
| 14 | `redis.del('workflow:instance:${id}')` 是死代码（全库无人写该 key），测试断言与实现一起断言了不存在的缓存 | instance.ts:242 |
| 15 | 编辑节点 name 后实例级冗余字段 `lastNodeName`/`currentNodeNames` 不同步，下一次转移前展示旧名字 | instance.ts:194 |
| 16 | 每个 AI 节点会话默认挂载 admin 管理工具集（可创建/删除任意 AI 归属资源），提示注入面需确认是有意设计并在文档中明确边界 | orchestrator.ts:81-84 |
| 17 | `ensureAdminToolsServer` 用 `$setOnInsert`，工具定义变更后已存在 server 文档的 tools 摘要过期 | admin-tools.ts:455-468 |
| 18 | 用正则匹配服务端中文错误文案分支处理（`/已开始\|已启动\|状态/`），文案一改即失效且会误归类；命中后仅 toast、弹窗表单为过期数据 | EditInstanceNodeDialog.tsx:131 |
| 19 | 旧实例 AI 节点只想改名称/描述时被前端强制补全提示词与 Harness 工具（快照缺失时保存被阻断），若非有意借编辑补全快照应仅在字段被修改时校验 | EditInstanceNodeDialog.tsx:91-100 |
| 20 | 实例化对话框「上一步→下一步」静默丢弃 step 2 的节点编辑（来源未变时也重新覆盖） | InstantiateWorkflowDialog.tsx |
| 21 | tests/e2e/AGENTS.md:214 声称 P2-E2E-14 覆盖「来源模板不变」，实际从未查询来源模板（仅 api A1 覆盖） | tests/e2e/AGENTS.md |
| 22 | E2E-15 注释声称验证快照内容，实际只断言节点状态；`getInstance` 未取 agentConfig，快照核心行为 e2e 零断言 | workflow.spec.ts P2-E2E-15 |
| 23 | api A3 用固定 `sleep(500)` 等节点 RUNNING，存在时序脆弱性，建议轮询 | workflow.test.ts A3 |
| 24 | A9-A18 组顺序依赖注释未包含会删除共享 configuredId 的 A9 | workflow.test.ts:692 |

## 验证结果

| 项目 | 结果 |
|------|------|
| agent-api build/单测 | ✅ vitest 513/513（37 文件，含 admin-tools/configured/instance/orchestrator 新增用例） |
| agent-web lint/单测 | ✅ vitest 342/342（40 文件，含 ConfigureWorkflowDialog/TemplateEditorDialog/WorkflowNodeTree 新增用例） |
| API 测试（tests/api） | ⚠️ 本地未执行（需 MongoDB/Redis 环境）；静态评审发现 A2 断言空转（问题 13） |
| E2E 测试（tests/e2e） | ❌ 不可运行——instantiate helper 签名未同步（问题 2）、E2E-18 缺必填参数（问题 3） |

## 结论

**验收不通过。** 3 个阻塞问题（非空违规导致 TEMPLATE/BLANK 实例查询必炸、E2E 套件不可运行）与 5 个严重问题（新实例人类节点编辑必失败、来源归属校验缺失、updateNode 校验绕过、null 污染、只读模式回归）必须在合入 release 前修复；一般与建议项可随修复轮次一并处理。修复后需补跑 E2E 全套与 API 测试方可验收通过。

## 经验总结

- **契约可空性要与三来源语义对齐**：统一实例化引入「可能没有 configuredWorkflowId」的语义后，契约/schema 的非空声明必须同步放宽，否则运行期数据直接违反类型声明，且错误沿 `WorkflowInstance!` 传播放大为整查询失败。
- **「旧数据兼容」判断要按类型分派**：用「字段是否缺失」判断旧实例时，必须考虑新数据中本来就合法缺失该字段的类型（HUMAN/FLAG 无 prompts/agentConfig），否则兼容路径变成新数据的必炸路径。
- **Mutation 签名变更必须全仓同步**：GraphQL 签名改动后，e2e/api 测试 helper、proposal 文档时序图、MCP 工具 required 参数是三个独立副本，任何一个漏改都会留下「永远跑不到」或「必然失败」的测试；签名变更的提交应包含对全仓调用点的搜索证据。
- **编辑路径要与创建路径同等校验**：updateNode 只判「节点是否开始」而跳过内容校验，等于给所有实例化时的校验规则开了后门；「可编辑」与「编辑后仍合法」是两个独立约束。

---

## 人类验收问题修复（2026-08-13）

> 人类验收反馈两个问题，连同 AI 报告阻塞项 #1/#2/#3 一并修复。方案见 [[20260813-fix-workflow-acceptance]]。

### 问题 H1：多节点打回回流卡死（人类 a → AI b → 人类 c，c 打回 b、b 打回 a、a 重新提供后 b 无法继续，报「c 没有配置 agent」）

**根因**：引擎 `complete`/`completeRework` 对「下游 REJECT 节点」执行 `resume` 转移，无条件触发 `onNodeResume` → orchestrator `resumeNodeSession`，后者对所有节点执行 `startNodeSession`；HUMAN/FLAG 节点无 `agentConfig`，抛「节点「c」缺少 Agent 配置」→ 流程卡死。

**修复**：`orchestrator.ts` 的 `resumeNodeSession` 增加类型守卫——非 AI 节点复工仅由引擎置 RUNNING，不拉起会话。

**验证**：
- 单测：orchestrator.test.ts 新增 HUMAN/FLAG resume 不调用 create/close 用例（✅）
- API：A31 三节点全链路打回回流，review 复工 RUNNING（✅）
- E2E：E2E-19 同场景（✅）

### 问题 H2：工作流 MCP 失效（长任务/反复验收时关闭会话导致下发 MCP 失效）

**根因**：`mcp-endpoint.ts` 对所有 endpoint 一视同仁——JWT 带 `expiresIn`（默认 24h）、`getStatus` 按 `expiresAt` 判过期、`session.close()` 无条件 `revokeEndpoint`。工作流节点会话的平台 MCP 工具服务（`agent-workflow-tools` / `agent-workflow-admin-tools`）应随工作流实例共存亡，而非随会话 TTL/关闭失效。

**修复**：
- `mcp-session-endpoint.ts`：新增 `workflowInstanceId`，`expiresAt` 改可空。
- `mcp-endpoint.ts`：工作流作用域 endpoint 不设 JWT exp、`expiresAt=null`、Redis `active` 不设 TTL；`getStatus` 对工作流 endpoint 直接返回 active。
- `session.ts`：`close()` 对工作流节点会话（`workflowInstanceId != null`）不撤销 endpoint；`delete()` 仍撤销（实例删除时兜底）。

**验证**：
- 单测：mcp-endpoint.test.ts / session.test.ts 新增工作流 endpoint 无 TTL、close 不撤销用例（✅）
- API：A32 断言工作流 token 无 `exp`、普通会话 token 有 `exp`（✅）
- E2E：E2E-20 同断言（✅）

### 连带修复（AI 报告阻塞项）

| # | 修复 | 验证 |
|---|------|------|
| 阻塞 #1 | `WorkflowInstance.configuredWorkflowId: ID!` → `ID`（contracts + schema + 前端类型） | TEMPLATE/BLANK 实例查询不再非空违规 |
| 阻塞 #2 | E2E `instantiate` helper 改用 `instantiateWorkflow(input)` | E2E 套件可运行 |
| 阻塞 #3 | E2E-18 `instantiateWorkflowFromConfigured` 补齐 `nodes` | E2E-18 通过 |

### 测试数据修复（契约全量化后测试副本未同步）

`configureWorkflow` 入参 `ConfiguredWorkflowNodeInput` 已全量化，但 API/E2E 测试仍传部分节点，导致整套 API/E2E 不可运行。修复：API 测试新增 `configureNodes` 助手并替换全部部分节点调用；E2E 新增 `threeNodeConfigureNodes` 并补齐各场景全量节点。同时修复多个陈旧测试断言（A19/A22/A24/A25/A27 的实例化入参节点数与断言不匹配、E2E-3 `verifyRestart` 误匹配、E2E-15 缺 verify 节点 Harness 配置、admin 工具删除归属错误未转为工具级 isError）。

## 最终验证结果（2026-08-13）

| 项目 | 结果 |
|------|------|
| agent-api build | ✅ tsc 通过 |
| agent-api 单测 | ✅ 525/525（37 文件） |
| agent-web build | ✅ vite 通过 |
| agent-web 单测 | ✅ 342/342（40 文件） |
| API 测试（tests/api） | ✅ 300/300（16 文件，含 A31/A32/A33） |
| E2E 测试（tests/e2e workflow） | ✅ 21/21（含 E2E-19/E2E-20/E2E-21） |

## 返工补充：节点重启机制（2026-08-13 第二轮）

> 集成反馈：节点会话失败时缺少重试机制，需在节点「执行中、返工中、失败」状态提供「重启节点」按钮。

**修复**：
- 引擎新增 `restart` 事件（RUNNING/REWORK/FAILED → RUNNING，清 failInfo/rejectInfo/fallbackSent，触发 `onNodeRestart`）。
- orchestrator `onNodeRestart → resumeNodeSession`（关闭旧会话拉起全新会话，HUMAN/FLAG 类型守卫沿用）。
- 服务层 `restartNode` + GraphQL `restartNode(instanceId, nodeId)` mutation（契约/schema/resolver）。
- 前端 `WorkflowNodeTree` 为 AI 节点 RUNNING/REWORK/FAILED 展示「重启」按钮。

**验证**：engine/orchestrator 单测 R1–R3、API A33/A33b、E2E E2E-21 全部通过。
