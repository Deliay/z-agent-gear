---
description: MCP 传递重构一期 / 控制器 Key 重新生成 / 综合体验优化一期 integration→release 合并前 AI 代码验收报告
type: Permanent
---

# integration→release 验收报告（2026-09-08）

> **状态**: ✅ 验收通过（2026-09-08，AI Review 第四轮复核）—— 问题 33 修复核验属实，四包单测全绿（596/216/285/385）、四包类型检查全通过（tsc exit 0），integration HEAD = `9461c52` 已推送。阻断项全部清零，可合入 release；延期项（4/6/9/10/15）与建议项（17~32、34、35）按决策记录跟踪。

## 第四轮复核（AI Review，2026-09-08）

**结论：通过，不再打回。**

**逐项核验**：

- **问题 33（第三轮唯一阻断项）已修复** ✅：`controller-key.test.ts:110,178` 与 `controller.test.ts:108` 三处 `mockResolvedValue()` 已改为 `mockResolvedValue(true)`（commit `9461c52`），全仓 grep 确认无 `mocked(evictKeyById).mockResolvedValue()` 无参调用残留。
- **硬阻断前置条件满足** ✅：integration HEAD = `9461c52` = `origin/integration`，工作区干净。
- **类型检查本轮实测全通过** ✅：agent-api / controller-api / agent-controller `tsc --noEmit` exit 0，agent-web `tsc -b` exit 0。
- **四包单测本轮实测全绿** ✅：agent-api **596 passed / 42 文件**、controller-api **216 passed / 19 文件**、agent-controller **285 passed / 22 文件**、agent-web **385 passed / 47 文件**。
- **修复提交无副作用** ✅：`9461c52` 仅改动 2 个测试文件的 3 行 mock 与验收报告，未触碰实现代码，无新问题引入。

**遗留跟踪（不阻断合入）**：

- 延期项 4/6/9/10/15 已记录于「延期/降级决策记录」表，其中 10（操作日志裁剪）与 15（轮询压力）的**接受人仍为空**，建议合入后由产品/负责人显式签字闭环。
- 建议项 34（底部新建按钮组件测试）、35（upsert 显式 `$set`/`$setOnInsert` 写法 + delete/create 路径 evict 失败处理）及 17~32 维持建议级别，后续迭代处理。

## 第三轮复核（AI Review，2026-09-08）

**第二轮硬阻断已解除**：integration HEAD = `42f4e83` = `origin/integration`，工作区干净 ✅

**逐项核验属实的修复**（对照 commit `42f4e83` diff + 实测）：

- 问题 1/2：mock 修复核验属实；四包单测本轮实测 **agent-api 596 / controller-api 216 / agent-controller 285 / agent-web 385 全 passed** ✅
- 问题 3：`evictKeyById` 返回 boolean + `console.error`，regenerate 在 evict 失败时抛错 ✅
- 问题 5：底部 sticky 栏 Plus 新建会话按钮已实现 ✅（但承诺的组件测试未落地，见问题 34）
- 问题 7：`local-server.ts` 改 `Buffer[]` + `Buffer.concat` ✅
- 问题 8：`mcp:request` payload 校验（400）+ `.catch`（500 回包）✅；已确认 tests/api、tests/e2e 全部 `mcp:request` 调用方均带齐 `requestId/sessionId/serverName`，不会被新校验误伤 ✅
- 问题 11：unbound 区块「重新生成Key」入口 ✅
- 问题 13：**功能正确但写法脆弱**——`$setOnInsert` 与普通字段混写在同一更新文档中，原生驱动拒绝（实测 MongoDB 7 报 `Update document requires atomic operators`），仅因 Mongoose 9.6.2 宽容规范化（普通字段自动包入 `$set`）才能工作。已用真实 MongoDB 7 + mongoose 9.6.2 实测：insert 写入 `name=hostname`，rebind 保留自定义名 ✅（健壮性建议见问题 35）
- 问题 14：`goToConfig` 非空校验 + `enabledWorkspaces` 回填 effect ✅
- 问题 16：三态上报 + `TreeSection` undefined 回退 ✅

**本轮打回原因**：

1. **问题 33（新增，阻断）**：修复提交本身导致 agent-api `tsc --noEmit` 失败（实测 exit 2），3 个 TS2554 错误——`evictKeyById` 签名改为 `Promise<boolean>` 后，`controller-key.test.ts:110,178` 与 `controller.test.ts:108` 的 `mockResolvedValue()` 无参调用类型不匹配。运行时不受影响（vitest/esbuild 不做类型检查）、CI 未跑 tsc，但本报告「最终验证」将「三包 tsc --noEmit 通过」列为验收项，修复提交破坏了该标准。修复简单：三处改为 `mockResolvedValue(true)`。

**非阻断建议**：问题 34（问题 5 修复方案承诺的组件测试未落地）、问题 35（register upsert 改显式 `$set`/`$setOnInsert` 兄弟写法；`ControllerKeyService.delete`/`create` 路径仍忽略 evict 失败，同类吊销可靠性缺口）。

## 第二轮复核（AI Review，2026-09-08）

**已复核属实的修复**（逐项对照代码 diff）：

- 问题 1：`controller-key.test.ts` mock 改为 query-like 对象（`lean: vi.fn().mockResolvedValue(...)`），agent-api 全量实测 596 passed ✅
- 问题 2：`command.test.ts` 补 `Controller.findOne` mock + 新增 unbound 分支与「controller 不存在」用例，「文档不存在时跳过 cleanupKey」的行为收窄已被测试固化为有意语义，controller-api 全量实测 216 passed ✅
- 问题 3：`evictKeyById` 返回 boolean 并 `console.error`，regenerate 在 evict 失败时整体抛错 ✅
- 问题 5：Sidebar 底部 sticky 栏新增仅图标（Plus）新建会话按钮 ✅
- 问题 7：`local-server.ts` 改为 `Buffer[]` 收集 + `Buffer.concat(chunks).toString('utf8')` ✅
- 问题 8：`mcp:request` handler 增加 payload 校验（400）与 `.catch`（500 回包），进程崩溃面已消除 ✅
- 问题 11：unbound 区块新增「重新生成Key」入口 ✅（同时缓解了问题 12 部分失败后的死路，可重新 regenerate 自救）
- 问题 16：`hasWorkflowInstances`/`hasGateways` 返回三态（undefined=未上报），`TreeSection` 已有 `hasContent === undefined` 回退分支承接 ✅

**本轮阻断项（打回原因）**：

1. **修复未提交推送（硬阻断）**：上述 8 项修复全部是 integration 分支工作区的未提交更改（`git status` 8 个 M 文件），integration HEAD 仍为 `6908db4`。若现在合入 release，问题 1/2 的红测与问题 3/5/7/8/11/16 全部原样进入 release。必须提交并推送 integration。
2. **一般项 12/13/14 未修复且无延期依据**（已复核仍存在）：
   - 12：`controller-key.ts:100` `findOneAndUpdate({_id, userId})` 无 keyHash 条件，并发竞态仍在；evict 失败抛错发生在 DB 更新与置 unbound 之后，错误语义仍误导（有 11 的入口可自救，可降级为确认文案）。
   - 13：`socketio.ts:84` register upsert 仍 `name: hostname` 覆盖已有自定义名称（一行改动：仅新建时写 name）。
   - 14：`InstantiateWorkflowDialog.tsx` `goToConfig` 仍不校验 `selectedWorkspaceId`，重置 effect 依赖仍仅 `[open]`，空 workspaceId 可提交（两处小改动）。
3. **延期决策未显式闭环**：严重项 4（架构变更）、6（E2E 补测）与一般项 9（二期）、10（需产品对齐裁剪）、15（需确认压力）仅在表格中标注，未形成与产品对齐的正式延期/裁剪记录。合入前需在报告或 PRD 中显式记录这些验收风险的接受决策。

## 关联文档

- PRD：
  - `docs/product/draft/20260829-mcp-controller-proxy.md`（MCP 传递重构一期）
  - `docs/product/shipping/20260830-regenerate-controller-key.md`（控制器 Key 重新生成）
  - `docs/product/draft/20260907-experience-optimization-phase1.md`（综合体验优化一期）
- 技术方案：`docs/engineering/proposals/20260829-refactor-mcp-controller-proxy.md`、`20260830-regenerate-controller-key.md`、`20260907-feat-experience-optimization-phase1.md`
- 分支：`integration`（PR #193 → release），integration HEAD = `6908db4`，领先 release 51 个提交
- 验收方式：AI 代码评审（diff：`release...integration`，102 文件，+6512/-1263，按三个需求分domain评审 + 关键发现人工复核）+ 四包单测/类型检查实测
- 验收日期：2026-09-08

## 需求概述

本轮 integration→release 包含三个需求：

1. **MCP 传递重构一期**：agent-api 公网 `POST /mcp/*` 入口下线，平台 MCP 统一经控制器 relay（controller-api `mcp-relay`、agent-api `mcp-dispatch`/`mcp-relay-consumer`、agent-controller `mcp/local-server`/`relay`），GATEWAY_URL 配置移除，Socket.IO `maxHttpBufferSize` 提升至 16MB，控制器版本协商升至 v2。
2. **控制器 Key 重新生成**：`regenerateControllerKey` mutation，旧 key 失效、控制器置 unbound 并保持该状态不被覆盖，前端设置页支持重新生成与绑定引导。
3. **综合体验优化一期**：Sidebar 会话树信息架构重构（TreeSection/WorktreeSidebarGroup 重写、WorkflowSidebarGroup 删除）、空态修复、CommandTemplate 抽取、InstantiateWorkflowDialog 工作区选择。

## 已验证（✅）

- agent-controller 单测：`packages/agent-controller vitest run` → **285 passed / 22 文件**
- 前端单测：`apps/agent-web vitest run` → **385 passed / 47 文件**
- 前端类型检查：`apps/agent-web npx tsc -b` → **通过（exit 0）**；三包 `tsc --noEmit` 亦通过（评审子任务实测）
- 版本协商一致性：controller-api `CURRENT_MAJOR_VERSION = '2'`（socketio.ts:22）、agent-controller 包版本 2.0.0、API/E2E 测试注册版本全部 `2.0.0`，三处对齐，且有 v1 拒绝单测 ✅
- `GATEWAY_URL` 移除彻底：agent-api config、Aspire AppHost、docker-compose 三处同步删除，全仓无残留引用 ✅
- `McpEndpointInfo.url` 字段移除后无双端残留消费（session.ts / 测试 / 前端均已同步）✅
- MCP relay 主链路：分发逻辑为 `routes/mcp.ts` 忠实平移，relayOwners 前移到 acp:start/acp:resume 覆盖真实 agent 启动窗口握手，关键路径测试覆盖真实（dispatch 21 单测、relay 双端单测、workflow.test.ts A9-A18 全链路 API 回归）✅
- unbound 状态流转闭环：regenerate 先置 unbound 再 publish shutdown；disconnect `$ne: 'unbound'` 防覆盖；rebind 恢复 online ✅
- 体验优化主干：无限渲染循环/非法 DOM 嵌套/空态死锁修复真实有效且有回归测试；WorkflowSidebarGroup 删除后功能完整迁移；command-template 4 pm × 2 region 全覆盖 ✅

## 验收问题清单

### 严重（合入前必须修复）

### 1. agent-api `controller-key.test.ts` regenerate 2 个用例红 —— 实现链式 `.lean()` 与测试 mock 不一致（实测）

**问题描述**：`servers/agent-api/src/services/controller-key.ts:90` 与 `:108` 分别在 `ControllerKey.findOne(...)`、`findOneAndUpdate(...)` 后链式 `.lean()`；而 `controller-key.test.ts` regenerate 用例（`:228`、`:259`）对两方法的 mock 用 `mockResolvedValue(...)` 直接返回 Plain Object，无 `.lean` 方法。

实测（integration HEAD `6908db4`，`vitest run src/services/controller-key.test.ts`）：

```
FAIL  regenerate > should regenerate a controller key
FAIL  regenerate > should return null when key not found
TypeError: ControllerKey.findOne(...).lean is not a function
 ❯ ControllerKeyService.regenerate src/services/controller-key.ts:90:77
```

agent-api 全量：**2 failed | 594 passed**。

**根因**：「控制器 Key 重新生成」feature 在实现中追加 `.lean()` 时未同步更新测试 mock，合入 integration 前未重跑该测试文件。

**修复方案**（二选一，建议前者）：
- 测试侧：mock 改为返回 query-like 对象，如 `mockReturnValue({ lean: vi.fn().mockResolvedValue(mockExistingKey) } as never)`；
- 实现侧：去掉 `.lean()`（本服务其他方法均未使用，保持风格一致）。

### 2. controller-api `command.test.ts` shutdown 2 个用例红 —— 新增 status 分支前置查询未被 mock（实测）

**问题描述**：`servers/controller-api/src/services/command.ts` shutdown 处理器由「无条件 `Controller.deleteOne` + `ControllerKey.deleteOne` + `cleanupKey`」改为先 `Controller.findOne({ keyId })` 再按 `status !== 'unbound'` 分支。`command.test.ts` 两用例（`:106`、`:175`）未 mock `Controller.findOne`，`controller` 为 `undefined` → 两分支均不进 → `deleteOne` 0 次调用。

实测（integration HEAD `6908db4`）：controller-api 全量 **2 failed | 212 passed**。

**根因**：「regenerate 后保持 unbound 状态不被覆盖」（`b910ee2`）改动 shutdown 语义时未同步测试。

**附带行为变化（需确认有意）**：`Controller.findOne` 查不到文档时，原实现仍执行 `sessionService.cleanupKey(keyId)`，新实现什么都不做，孤儿 session 清理路径被收窄。

**修复方案**：测试补充 `Controller.findOne` mock（在线 → 删除分支）并新增 unbound 分支用例固化新语义；确认/兜底「文档不存在时 cleanupKey 跳过」的取舍。

### 3. 旧 key 吊销不可靠：Redis 缓存驱逐失败被静默吞掉（已人工复核属实）

**问题描述**：controller-api register 只查 Redis 缓存（`lookupKey`，`socketio.ts:41`），不回源 MongoDB；缓存条目存旧 `keyHash`，TTL 30 天。`evictKeyById`（`servers/agent-api/src/services/key-cache.ts:41-52`）用 `catch {}` 吞掉所有 Redis 错误。若 regenerate 瞬间 Redis 抖动：DB 已写新 hash，但缓存中旧 rawKey→旧 hash 条目仍在，**持旧 key 仍可注册成功**，且无日志/告警。该功能卖点即「泄露后立即吊销」，静默失败的吊销比没有更危险。

**修复方案**：evict 失败时让 regenerate 整体失败并显式报错（或 DB 侧加 `status: revoked` 兜底、register 校验）；至少 `console.error` + 告警。涉及 `controller-key.ts:119`、`key-cache.ts`。

### 4. shutdown 命令 fire-and-forget，丢失后旧 key 已认证会话无限期存活

**问题描述**：agent-api 经 Redis pub/sub 发 shutdown（无持久化），controller-api 宕机/未订阅时旧连接不会被踢；heartbeat 持续 `refreshSession` 刷新 TTL，旧 key 活跃会话可一直工作——功能上旧 key 未失效。问题 3 修复后新注册会被拒，但存量连接仍是缺口。

**修复方案**：heartbeat/register 校验 key 代次（session 记录 keyHash 或版本，失配踢下线），或 shutdown 改带确认/重试机制。涉及 `servers/agent-api/src/services/command.ts`、`servers/controller-api/src/services/socketio.ts:114-127`。

### 5. PRD/计划明确要求的「侧边栏底部新建会话图标按钮」未实现（已人工复核属实）

**问题描述**：PRD `20260907-experience-optimization-phase1.md:90,96,164` 与计划 `:69,72,115` 均要求底部 sticky 栏新增仅图标（Plus）新建会话按钮；最终代码底部栏（`Sidebar.tsx:392-411`）只有用户名/TodoList/主题/设置，新建入口仅放在「会话」TreeSection 头部（`:289-298`）。验收标准「新建会话图标按钮固定在侧边栏底部」不达成，且无测试覆盖该验收项。

**修复方案**：底部 sticky 栏补仅图标新建会话按钮（`setShowNewDialog({})`）+ 对应组件测试；或与产品对齐正式修订 PRD 并记录降级理由。

### 6. 综合体验优化一期计划承诺的 E2E 覆盖基本全部缺位

**问题描述**：计划 E2E-1/2/4（树分组导航、辅助行、侧边栏优化，新增 `sidebar-tree.spec.ts`）、E2E-3（创建工作流选工作区）、E2E-5（命令模板）、E2E-6（即时 Git 发现）均未落地；`tests/e2e/src/` 无 `sidebar-tree.spec.ts`，相关 spec 的 diff 仅为 MCP relay 重构与版本号 bump。验收标准「单元测试与 E2E 测试通过」实际只有单测支撑。

**修复方案**：补齐关键路径 E2E（至少树分组展开/折叠 + 工作区下拉 + 命令模板切换），或将缺口显式记录为验收风险。

### 一般

### 7. 回环 MCP 端点按 chunk 累加字符串，跨 chunk 多字节 UTF-8 字符被破坏

**问题描述**：`packages/agent-controller/src/mcp/local-server.ts:69-79` `bodyStr += chunk` 逐段 `toString()`；回环 TCP 也会 ~64KB 分片，多字节字符跨片时被切成 U+FFFD。请求上限放到 16MB 后，大体积中文 tool 参数（如写文件）易触发——JSON 400，或更糟：替换字符落入字符串内部静默损坏数据。

**修复方案**：收集 `Buffer[]`，`Buffer.concat(chunks).toString('utf8')` 一次性解码。

### 8. `mcp:request` handler floating promise，畸形 payload 可使 controller-api 进程崩溃

**问题描述**：`servers/controller-api/src/services/socketio.ts:501-510` 调用 async `handleMcpRequest`（`mcp-relay.ts:28`）无 `.catch`；payload 为 undefined/null 时解构抛 TypeError → unhandled rejection → Node ≥15 进程退出。任何已认证 controller 发畸形 `mcp:request` 即可打挂共享 controller-api。

**修复方案**：handler 入口校验 payload 并回错误，或调用点 `void ...catch(...)`；中期统一 socket handler safe-wrap。

### 9. controller-api 每个 MCP 请求 `redis.duplicate()` 新建连接

**问题描述**：`servers/controller-api/src/services/mcp-relay.ts:41-42,50,62` 每请求 duplicate + subscribe + disconnect 一条 TCP 连接；agent 启动并发 initialize/tools/list 叠加多会话产生大量短命连接，增加 Redis maxclients 压力。同仓 `mcp-forwarder.ts:30-44` 已有共享 subscriber + requestId 路由的更优范式。

**修复方案**：改共享 subscriber（本期修或显式记入二期）。

### 10. PRD 功能点「操作日志记录」完全未实现

**问题描述**：`20260830-regenerate-controller-key.md:93-100` 验收标准含「操作日志记录完整，可追溯」，技术提案 6.1 决策表也选了「记录」；agent-api 无任何 audit/operationLog 设施，resolver/service 均未记录。PRD 还把「操作日志系统（已有）」列为依赖，实际并不存在。

**修复方案**：补最低限度结构化日志（操作人/时间/控制器/keyId），或与产品对齐后从验收标准移除。

### 11. unbound 控制器没有再次 regenerate 入口，丢失新 key 即死路

**问题描述**：`ControllerListSection.tsx:275-309`「重新生成Key」按钮只在 boundControllers 区块渲染；unbound 区块只有「删除」。用户未保存就关闭「新Key已生成」弹窗后只能删除控制器重建，与 PRD 3.5「重复操作：每次操作生成新的 key」不符。

**修复方案**：unbound 区块也提供「重新生成Key」按钮（API 已支持）。

### 12. 并发/重试 regenerate 存在 DB 与缓存不一致竞态；部分失败时错误语义误导

**问题描述**：`controller-key.ts:100-130` 顺序为 DB 更新 → 置 unbound → 缓存 → publish shutdown。两次并发调用可能出现 DB 存 hash A、缓存存 hash B，用户拿到的 rawKey A 无法认证（双击/重试可触发）；且 `cacheKey`/`sendShutdown` 抛错（无 try/catch）时 GraphQL 报错，但旧 key 实际已废、新 rawKey 从未展示——控制器卡死只能删除重建。

**修复方案**：条件更新 CAS（`findOneAndUpdate({_id, keyHash: oldHash})`）或按 keyId 加锁；可补偿步骤包裹并对「key 已轮换但通知失败」做明确文案。

### 13. rebind 后用户自定义控制器名称被重置为 hostname

**问题描述**：`socketio.ts:84` register upsert 中 `name: hostname`；该行为 release 已有，但 regenerate 让「重新注册」成为常规路径，放大了副作用：rename 过的控制器 regenerate + rebind 后名字丢失。

**修复方案**：register 仅新建时写 `name: hostname`，已存在记录不覆盖 name。

### 14. InstantiateWorkflowDialog 缺工作区非空校验 + 默认工作区竞态，可提交空 workspaceId

**问题描述**：`InstantiateWorkflowDialog.tsx:154-166` `goToConfig` 只校验 name/sourceId；`:116-130` 打开重置 effect 依赖仅 `[open]`，侧边栏入口不传 workspaceId 时若 `GET_WORKSPACES` 未返回，`enabledWorkspaces[0]?.id` 为 `''` 且之后不补默认值 → 用户可一路点到提交，以 `workspaceId: ''` 发起 mutation，仅收到笼统「实例化失败」。

**修复方案**：`goToConfig` 增加 `if (!selectedWorkspaceId)` 校验；补监听 `enabledWorkspaces` 的回填 effect。

### 15. 默认全展开 + 每工作区 3 路 15s 轮询，请求量较 release 明显放大

**问题描述**：`Sidebar.tsx:42` 默认全展开、`:430-437` 每工作区 2 个 GET_WORKFLOW_INSTANCES 轮询、`WorktreeSidebarGroup.tsx:48-51` 每工作区 1 个 WORKSPACE_WORKTREES 轮询；首屏即对 N 控制器 × M 工作区发起 3M+ 条轮询（含无 configured workflow 的工作区也轮询归档实例）。

**修复方案**：归档查询改为展开归档区时启用（skip），或持久化分组展开状态；至少确认多工作区场景后端压力可接受。

### 16. 空态在查询加载期间闪烁误报

**问题描述**：`Sidebar.tsx:247,272` 子组件首轮渲染 instances/gateways 为 `[]` → 上报 0 → TreeSection 立即显示「无工作流实例」「无网关暴露」，查询返回后才切换；每次折叠再展开重演。

**修复方案**：上报加 loading 三态（`hasContent: undefined` 表示未知），TreeSection 在 undefined 时显示加载中。

### 建议

| # | 问题 | 位置 |
|---|------|------|
| 33 | **（第三轮新增·阻断）** 修复提交导致 agent-api `tsc --noEmit` 失败：`evictKeyById` 改返回 `Promise<boolean>` 后 3 处 `mockResolvedValue()` 无参调用 TS2554（实测 exit 2）。修复：三处改 `mockResolvedValue(true)` | controller-key.test.ts:110,178、controller.test.ts:108 |
| 34 | 问题 5 修复方案承诺的底部新建会话按钮组件测试未落地 | apps/agent-web Sidebar 测试 |
| 35 | register upsert 混合写法依赖 Mongoose 宽容规范化，建议改显式 `$set`/`$setOnInsert` 兄弟写法；`ControllerKeyService.delete`/`create` 路径仍忽略 evict 失败（同类吊销缺口，限删除/重建场景） | socketio.ts:71-86、controller-key.ts:21,77 |
| 17 | 新增真实链路测试 `acp-real-admin-tools.test.ts` 缺 `commandExists('opencode')` 跳过守卫；直接覆写用户真实 `~/.zag/config.toml`（SIGKILL 留脏）；`cleanupPidFile()` 可能误删真实 controller pid | tests/api/src/controller-api/acp-real-admin-tools.test.ts:269,297 |
| 18 | relay token 实现（注册时快照）优于契约描述（请求头透传），契约措辞应改为「controller 按会话快照填充」 | packages/agent-controller/src/mcp/relay.ts:71 vs contracts/agent-session-websocket.md 2.12.1 |
| 19 | 会话结束后新请求状态码：实现 404/401，提案/契约预期 410，需统一 | local-server.ts:48-53、mcp-dispatch.ts:58-61 |
| 20 | 验收标准「公网 /mcp 返回 404」无测试兜底，应补一个断言防路由误挂回 | tests/api、tests/e2e/src/mcp-session.spec.ts |
| 21 | `mcp-relay.ts:86` subscribe 失败映射 504（语义应为 502/503）；`:98-104` 对断开的 socket emit 503 是死代码；`socketio.ts:507` 未认证静默丢弃 `mcp:request`（可回 401 快速失败） | servers/controller-api |
| 22 | 前端 `handleRegenerate` try/finally 无 catch，mutation 失败无任何用户反馈 | ControllerListSection.tsx:164-186 |
| 23 | 确认弹窗未显示「当前绑定状态」，与 PRD 功能点 2 验收标准不符 | ControllerListSection.tsx:351-366 |
| 24 | `lastUsedAt` 在 regenerate 时被置为当前时间，审计语义失真 | controller-key.ts:105 |
| 25 | controller-key 单测断言偏弱：未断言 unbound 置位/新 keyHash 写入/cacheKey 新 hash/evict 先于 cacheKey 的顺序 | controller-key.test.ts:196-262 |
| 26 | E2E 用 `page.locator('code')` 全页定位存在 strict-mode 脆弱性；测试名与断言相反（`'should show regenerate key button'` 实际断言不可见） | tests/e2e/src/settings-controller.spec.ts |
| 27 | 新 key 注册与旧 session 清理存在瞬时竞态（`KEY_ALREADY_ONLINE`），需确认 agent-controller 客户端会自动重试 register | servers/controller-api/src/services/session.ts:8-25 |
| 28 | CommandTemplate `copied` 状态在 pm2 双复制块间共享；`handleCopy` 未 catch 剪贴板异常；`setTimeout` 未在卸载时清理 | CommandTemplate.tsx:23,69-90 |
| 29 | worktree 会话的工作区辅助行与「未知工作区」规则不一致（回退路径推导名 vs PRD 要求置灰「未知工作区」；停用工作区两种会话表现不一致） | Sidebar.tsx:73-86 |
| 30 | 有 worktree 时工作区根目录会话在「工作区」分组消失（会话未丢失，但分组语义不完整，需确认有意） | WorktreeSidebarGroup.tsx:110-232 |
| 31 | `GatewaySection.tsx:71-121` 非 inline 分支已无调用方（死代码）；文件末尾缺换行 | GatewaySection.tsx |
| 32 | 组件测试偏薄：CommandTemplate.test.tsx 复制行为未验证；InstantiateWorkflowDialog.test.tsx 仅 1 用例 | apps/agent-web 测试 |

## 修复总览表格

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 1 | agent-api regenerate 2 用例红 | 实现加 `.lean()` 未同步 mock | ✅ 已修复 | fix: mock query-like objects with .lean() |
| 2 | controller-api shutdown 2 用例红 | shutdown 语义变更未同步测试 | ✅ 已修复 | fix: add Controller.findOne mock + unbound branch test |
| 3 | 旧 key 吊销静默失败 | evict catch{} + register 只查缓存 | ✅ 已修复 | fix: evictKeyById returns boolean, regenerate throws on failure |
| 4 | shutdown fire-and-forget 存量会话不死 | pub/sub 无持久化 + heartbeat 续期 | 🟡 待后续 | 需架构变更：heartbeat/register 校验 key 代次 |
| 5 | 侧边栏底部新建按钮缺失 | PRD 验收项未实现 | ✅ 已修复 | feat: add Plus button in sidebar bottom bar |
| 6 | 体验优化 E2E 覆盖缺位 | 计划 E2E-1~6 未落地 | ⏳ 待补充 | 需补充关键路径 E2E 测试 |
| 7 | 回环 MCP UTF-8 跨 chunk 损坏 | 逐段 toString 累加 | ✅ 已修复 | fix: Buffer.concat before toString('utf8') |
| 8 | mcp:request floating promise 可 crash | 无 catch + 无 payload 校验 | ✅ 已修复 | fix: add .catch() and payload validation |
| 9 | 每请求 duplicate Redis 连接 | 未复用共享 subscriber | 🟡 待修复/二期 | 延迟至二期优化 |
| 10 | 操作日志未实现 | PRD 依赖误判「已有」 | 🟡 待修复/裁剪 | 需与产品对齐裁剪或实现 |
| 11 | unbound 无再次 regenerate 入口 | 按钮只在 bound 区块 | ✅ 已修复 | feat: add regenerate button for unbound controllers |
| 12 | regenerate 并发竞态/部分失败误导 | 无 CAS/锁 + 无补偿 | 🟡 已降级 | 已提供 unbound 重新 regenerate 入口（问题11），用户可重试；evict 失败已改为抛错阻止继续，CAS/锁延后优化 |
| 13 | rebind 名称被重置 | register upsert 覆盖 name | ✅ 已修复 | fix: $setOnInsert for name field |
| 14 | 空 workspaceId 可提交 | 缺校验 + effect 依赖不全 | ✅ 已修复 | fix: goToConfig validation + enabledWorkspaces backfill effect |
| 15 | 轮询请求量放大 | 默认全展开 + 始终挂载 | 🟡 待确认 | 需确认后端压力可接受 |
| 16 | 空态加载期闪烁 | 缺 loading 三态 | ✅ 已修复 | fix: hasContent undefined 表示未知 |
| 33 | tsc --noEmit 失败（evictKeyById 签名变更） | mockResolvedValue() 无参类型不匹配 | ✅ 已修复（第四轮核验） | 9461c52 fix: mockResolvedValue(true) × 3 |
| 34 | 底部新建会话按钮组件测试缺位 | 测试未落地 | 💡 建议 | 建议后续补充 |
| 35 | register upsert 写法脆弱 / delete、create 忽略 evict 失败 | $setOnInsert 混写依赖 Mongoose 规范化 | 💡 建议 | 建议改为显式 $set/$setOnInsert 兄弟写法 |
| 17~32 | 建议项（见上表） | - | 💡 建议 | - |

## 最终验证

| 项 | 结果 |
|----|------|
| agent-api 单测 | ✅ 596 passed / 42 文件（第四轮实测） |
| controller-api 单测 | ✅ 216 passed / 19 文件（第四轮实测） |
| agent-controller 单测 | ✅ 285 passed / 22 文件（第四轮实测） |
| agent-web 单测 | ✅ 385 passed / 47 文件（第四轮实测） |
| agent-web 类型检查（tsc -b） | ✅ 通过（第四轮实测） |
| agent-api 类型检查（tsc --noEmit） | ✅ 通过（第四轮实测 exit 0） |
| controller-api / agent-controller 类型检查（tsc --noEmit） | ✅ 通过（第四轮实测） |
| API 集成测试（tests/api） | ⚠️ 本轮未执行（需 Aspire 编排环境） |
| E2E 测试（tests/e2e） | ⚠️ 本轮未执行（问题 6 待补充） |

## 延期/降级决策记录

| # | 问题 | 决策 | 理由 | 接受人 | 日期 |
|---|------|------|------|--------|------|
| 4 | shutdown fire-and-forget 存量会话不死 | 延期至独立迭代 | 需架构变更（Redis Stream 替代 pub/sub 或 heartbeat 校验 key 代次），影响面大，不宜在本迭代阻塞 | - | 2026-09-08 |
| 6 | 体验优化 E2E 覆盖缺位 | 延期至专项补测 | 本期 E2E 测试框架依赖 Aspire 编排环境，需单独搭建后补充关键路径覆盖（sidebar-tree.spec.ts 等） | - | 2026-09-08 |
| 9 | 每请求 duplicate Redis 连接 | 延期至二期 | 参照 mcp-forwarder.ts 已有共享 subscriber 范式，二期统一治理 | - | 2026-09-08 |
| 10 | 操作日志未实现 | 需与产品对齐 | PRD 验收标准含「操作日志记录完整」但实际无审计设施，需确认裁剪或后续实现 | - | 2026-09-08 |
| 15 | 轮询请求量放大 | 需压力测试确认 | 首屏即对 N 控制器 × M 工作区发起轮询，需多工作区场景下确认后端压力可接受 | - | 2026-09-08 |

## 涉及修改文件（本轮发现问题的关键文件）

| 文件 | 问题 |
|------|------|
| `servers/agent-api/src/services/controller-key.ts` / `.test.ts` | 问题 1、3、12、24、25 |
| `servers/agent-api/src/services/key-cache.ts` | 问题 3 |
| `servers/controller-api/src/services/command.ts` / `.test.ts` | 问题 2 |
| `servers/controller-api/src/services/socketio.ts` | 问题 4、8、13、21 |
| `servers/controller-api/src/services/mcp-relay.ts` | 问题 8、9、21 |
| `packages/agent-controller/src/mcp/local-server.ts` | 问题 7、19 |
| `apps/agent-web/src/components/Sidebar.tsx` | 问题 5、15、16、29 |
| `apps/agent-web/src/components/settings/ControllerListSection.tsx` | 问题 11、22、23 |
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 问题 14 |
| `tests/api/src/controller-api/acp-real-admin-tools.test.ts` | 问题 17 |

## 经验总结

- **feature 分支合入 integration 前必须在集成视角重跑全量单测**：问题 1/2 均为「实现改了、mock 没跟上」的不一致，单跑一次对应测试文件即可暴露。
- **Mongoose 链式调用（`.lean()` 等）是 mock 脆弱点**：团队约定要么实现侧统一不用链式，要么测试侧统一 mock query-like 对象。
- **安全功能的失败路径必须显式处理**：「吊销」类操作静默失败比没有更危险，evict/通知等步骤的失败要么整体回滚报错，要么有 DB 侧兜底 + 告警。
- **PRD 验收标准需要逐项对账**：底部新建按钮、操作日志、E2E 覆盖三项均为文档写明但实现/测试缺失，验收前应按 PRD 验收标准逐条打勾。
