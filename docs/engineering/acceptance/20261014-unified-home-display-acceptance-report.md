---
description: integration→release 集成验收报告——首页展示优化（PR #202）AI Review 轮次（含第二、三轮返工复核，第三轮复核通过），记录代码审查结论、发现的问题、合并冲突解决指引与验证结果
type: Permanent
---

# 首页展示优化 integration 验收报告（2026-10-14）

> **状态**: 🟢 **第三轮复核通过（AI Review 闭环）**——第二轮打回项（问题 7：`gateways` 旧口径注释残留 3 处）返工 `f3d367e` **全部修复并经全仓扫描确认零残留**（含追加修复的同缺陷类第 4 处 `apps/agent-web/AGENTS.md:38`）；建议项问题 8 已落实（plan T-H 表重排为 T-H0~T-H3 并与实际用例 ID 对齐），问题 9 按 proposals 锁定惯例保留。代码正确性与全部测试结论不变（单测 608+414、API 集成 339/339、E2E 无新增失败、试验合并通过），自 `56b4d6f` 起代码/测试零变更。遗留：**合并冲突解决指引（问题 A）留待合并节点执行**；建议项问题 3-6、9、10 不阻塞。详见「七、第三轮复核」。

## 关联文档

- PRD：`docs/product/draft/20261013-unified-home-display.md`
- 技术方案：`docs/engineering/proposals/20261013-feat-unified-home-display.md`
- 实现计划：`docs/engineering/plan/20261013-feat-unified-home-display.md`
- 分支：`integration`（@ `56b4d6f`，PR #202 → release）
- 验收方式：AI 代码评审（diff：`origin/release...origin/integration`，16 commits，60 文件，+2927/-657）+ 单测/API 集成测试/E2E 执行 + 试验合并验证
- 验收日期：2026-10-14

## 一、验收范围与方法

本 PR 的核心变更（首页展示优化）：

1. **契约先行**：新增 `contracts/home.graphql`（`homeOverview` 聚合查询 + `Controller.gateways` / `ControllerWorkspace.worktrees` 嵌套惰性字段）；`workflow.graphql`（`workflowInstances` 过滤参数放宽 `workspaceId` 必传 → 可选并新增 `controllerId`；`WorkflowInstance` 新增 `workspace`/`controller` 归属字段）；`agent-session.graphql`（`sessions` 新增 `controllerId` 过滤）。
2. **后端**：`home.ts` 薄聚合 resolver（`Promise.all` 组合既有 service、单分支失败降级、`worktrees` 扇出 5s 超时兜底）；`workflow.ts`/`session.ts` resolver 与 `workflow/instance.ts`/`session.ts` service 放宽过滤；`workflow-instance.ts` 新增 2 个复合索引。
3. **前端**：`MainLayout` 挂载唯一一次 `HOME_OVERVIEW` 查询（`pollInterval: 15000`），经 `stores/homeOverview.ts` Context 下发 `HomePage`/`Sidebar`/`TodoListPanel`；`Sidebar` 工作流改为按控制器集中列表（含归属标注、归档折叠）；各 mutation 的 `refetchQueries` 统一指向 `HOME_OVERVIEW`。
4. **测试**：API 集成（`tests/api/src/agent-api/home.test.ts` 新增 T-H0-H3 / T-W1-W7 / T-S1-S4）、E2E（`tests/e2e/src/home.spec.ts` 新增 T-E1-T-E5）、单测（`home.test.ts`、`workflow.test.ts`、`instance.test.ts`、`Sidebar.test.tsx`、`MainLayout.test.tsx` 等）。

## 二、已验证（✅）

| 项目 | 结果 | 说明 |
|---|---|---|
| 契约/实现一致性（逐字段核对） | ✅ | `contracts/*.graphql` 与 `schemas/*.ts`、resolver 返回 shape、前端 `graphql/*.ts` 查询与 TS 类型三方一致；归属字段可空语义（`workspace`/`controller` 可为 null）在契约/类型/UI 回退（「未知工作区/未知控制器」）贯通 |
| 后端单测（integration） | ✅ 608 passed / 43 文件 | `servers/agent-api npx vitest run` |
| 前端单测 + 类型检查 | ✅ 414 passed / 50 文件，`tsc -b` 通过 | `apps/agent-web` |
| API 集成测试（全量） | ✅ 339 passed / 17 文件 | `tests/api npx vitest run`，含新增 home.test.ts 全部用例（归属字段、归档过滤、交集过滤、跨用户隔离、workspace 删除降级、sessions 口径叠加） |
| E2E（全量） | ✅ 无回归：164 passed / 26 failed，26 项失败经基线对照证实为存量问题 | `tests/e2e npx playwright test`；本特性新增 `home.spec.ts` T-E1-T-E5 **5/5 通过**（首屏仅一次 HomeOverview 请求、轮询每轮一次、集中列表+归属标注+跳转、按控制器浏览、空态展示）。26 项失败（auth/gateway/worktree/session-mobile/workflow 等）用**同一套测试**跑 merge-base（`77b4a21`）前端得到 **1:1 相同的 26 项失败**（见「五、E2E 失败项归因」），与本 diff 无关 |
| 试验合并（integration → release） | ✅ | 按「问题 A」指引解决 2 处冲突后：`agent-api` 608 passed、`agent-web` `tsc -b` 通过 + 425 passed（含 release 侧存量用例），两侧测试共存无回归 |

代码审查要点（全部通过）：

- **鉴权与隔离**：`homeOverview` 及嵌套字段均有 `currentUser` 校验；service 层查询一律携带 `userId` 过滤（T-H0/T-S4/T-W6 覆盖跨用户隔离）。
- **降级语义**：聚合单分支失败降级空值不拖垮整次查询（`degrade`）；`worktrees` 扇出 5s 超时兜底（`withTimeout`）；归属对象已删除返回 null（T-W7）。
- **Apollo v4 轮询陷阱**：布局不以 `loading` 卸载子页面（`frontend-rules.md` 约束），MainLayout 有专门断言（T-F2）。
- **索引**：`{userId, archivedAt, createdAt}` 与 `{userId, controllerId, archivedAt, createdAt}` 覆盖新查询形态，避免全表扫描。
- **兼容性**：`workflowInstances(workspaceId: ID!, ...)` → `(workspaceId: ID, ...)` 为放宽式变更，旧调用方语义零变化（`listForWorkspace` 兼容垫片保留）。

## 三、验收问题清单

### 问题 A（⚠️ 合并节点必须遵守的冲突解决指引，不构成对 integration 的打回）

PR #202 与 release 存在 2 处文本冲突（上游产物已注明留待合并节点解决）。经试验合并（`git merge-tree` + 手工按下列方式解决 + 全量复跑测试）验证，**必须按下述方式解决**，否则合并后测试失败：

1. **`servers/agent-api/src/services/controller-key.test.ts`**（⚠️ 解错必挂）：两侧都改写了 `regenerate` 用例的 mock。
   - 保留 **release 侧** `vi.mocked(evictKeyById).mockResolvedValue(true)`，**不要**采用 integration 侧的 `mockResolvedValue()`（void）：release 的 `controller-key.ts`（PR #199 问题 3 修复）在 `evictKeyById` 返回 falsy 时 `throw 'Failed to revoke old key from cache'`，void mock 会使合并后该用例必失败。
   - 两侧各自的 `vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({} as never)` 保留一份即可（integration 侧另有 `ControllerKey.findOne`/`findOneAndUpdate` 的 `.lean()` mock 链，全部保留）。
2. **`apps/agent-web/src/components/Sidebar.tsx`**：冲突块为 release 侧旧的 `handleInstancesChange`/`handleGatewaysChange`/`hasWorkflowInstances`/`hasGateways` 上报逻辑 vs integration 侧删除——**取 integration 侧**（数据已由 `homeOverview` 统一下发，上报机制整体移除）。同时注意 release 侧底栏新增的「新建会话」`Plus` 按钮（`42f4e83` issue 5）不在冲突块内、已被自动合并保留，**不得误删**。

### 问题 1（🟡 一般·文档/契约一致性）`contracts/home.graphql` 契约注释与 `Controller.gateways` 实现不符

**问题描述**：`contracts/home.graphql:5-7` 头注释称两个嵌套字段「仅当查询语句选择时才按控制器/工作区扇出（**经 Redis relay 调用在线控制器**），**离线**或扇出失败时**降级为空列表**」。但实现中：

- `Controller.gateways` → `gatewayService.findAllByController`（`servers/agent-api/src/services/gateway.ts:9`）是**纯 DB 查询**（`Gateway.find`），不经 Redis relay，也不依赖控制器在线状态——控制器离线时仍返回其网关配置行（前端 `Sidebar` 以 `status === 'online'` 自行隐藏该区块，属 UI 层行为，非字段降级）。
- 仅 `ControllerWorkspace.worktrees` → `worktreeService.list` 才是经 Redis relay 的扇出（`git:worktree:list`），且离线/失败降级为空列表。

`servers/agent-api/AGENTS.md:48` 重复了同一表述（「（Redis relay）」套在两个字段上）。契约是契约式开发的权威来源，注释把 DB 查询描述为 relay 扇出、把「离线不降级」描述为「离线降级」，会误导后续实现/排障（例如误以为网关列表依赖控制器在线）。

**修复要求**：修正 `contracts/home.graphql` 头注释（与 `servers/agent-api/AGENTS.md`）：明确 `gateways` 为 DB 查询、不随在线状态降级；`worktrees` 为 Redis relay 扇出、离线/失败降级为空列表。docs-only。

> **第二轮核验（`ff79b22`）**：⚠️ 部分修复——`contracts/home.graphql`（头注释 + `extend type Controller` 注释）、`servers/agent-api/AGENTS.md:48`、plan 同步处均已改为「`gateways` 纯 DB 查询、不随在线状态降级」，与实现一致；但同 diff 内 3 处同源注释漏改（见问题 7），本问题**未完全闭环**。
>
> **第三轮核验（`f3d367e`）**：✅ **完全闭环**——3 处残留注释全部修正（并追加修复同缺陷类第 4 处 `apps/agent-web/AGENTS.md:38`），全仓扫描零错误口径残留（见「七、第三轮复核」）。

### 问题 2（🟡 一般·文档一致性）实现计划对 MainLayout 加载态的描述与实现不符

**问题描述**：`docs/engineering/plan/20261013-feat-unified-home-display.md:201` 写 MainLayout「以 props/context 下传 `HomePage` 与 `Sidebar`（含 **`loading && !data` 加载态**与整体错误 + 重试入口）」，但实现（`apps/agent-web/src/pages/MainLayout.tsx`）有意采用了「首屏不阻塞布局外壳」策略（commit `4fd78a4`、`9d275a8`）：**不存在任何 `loading && !data` 加载分支**，聚合数据未就绪时以空数据渲染外壳、数据到达后同批填充。该偏离已写入 `apps/agent-web/AGENTS.md`「首页数据流」小节，但实现计划未同步，两份文档对同一行为描述不一致。

**修复要求**：同步 `plan/20261013-feat-unified-home-display.md:201`（及 3.2 节 T-F2 附近措辞若涉及）为「首屏不阻塞布局外壳、无加载分支；整体错误 + 重试入口」，与 `apps/agent-web/AGENTS.md` 口径一致。docs-only。

### 问题 3（🟢 建议）`WorkflowInstance.workspace`/`controller` 惰性解析逐条查库（N+1）

`homeOverview.workflowInstances` 每个实例选择归属字段时各触发 1 次 `findById`（`resolvers/workflow.ts:330-342`），实例数 N 时首屏多 2N 次查询。当前个人规模可接受；后续可批量预取或引入 Dataloader。

### 问题 4（🟢 建议）`worktrees` 扇出 5s 超时推迟整批首屏数据返回

GraphQL 需全部所选字段就绪才返回响应：`workspaces.worktrees` 任一工作区扇出慢（超时上限 5s）会推迟**全部**首屏数据一次性到达（与 PRD「首屏一次到达」目标有张力）。可考虑 worktrees 独立二次加载或缩短超时（如 2-3s）。

### 问题 5（🟢 建议）待办轮询 5s → 15s（已接受的取舍，留痕）

计划期已裁决接受（`plan:47`）：权限/elicitation 即时待办弹窗最迟 15s 出现（此前 5s）。E2E 已相应放宽等待窗口。建议后续以推送/订阅兜底即时性。

### 问题 6（🟢 建议）`GET_TODO_LIST` / `GET_UNREAD_TODO_COUNT` 成为死代码

`apps/agent-web/src/graphql/queries.ts:301,342` 两个查询已无生产消费方（待办并入 `HOME_OVERVIEW`），建议清理或注明保留原因。

## 四、E2E 失败项归因（存量问题，非本 PR 引入）

全量 E2E 190 项中 26 项失败（auth ×1、gateway ×7、worktree ×4、session-mobile ×4、responsive-layout ×1、workflow ×5、session ×1、settings ×2、session-acp-server ×1）。归因实验：

| 轮次 | 环境 | 结果 |
|---|---|---|
| integration 全量 | 本 PR 前端（`56b4d6f`）+ integration 后端 | 164 passed / **26 failed**（含 `home.spec.ts` T-E1-T-E5 全过） |
| 基线对照 | **merge-base（`77b4a21`）前端** + 同一后端、同一套测试 | **同样 26 项失败（与上表 1:1 完全一致，0 项翻绿、0 项新增）** |

结论：这 26 项在本 PR 之前的代码上就已失败，属**存量 E2E 问题**（失败形态多为侧边栏展开/折叠点击语义与断言不匹配、`getByRole`/`getByText` 定位歧义等，例如 `expandController()` 点击控制器按钮实际是「折叠」默认展开的分组，`auth.spec` 对无控制器用户的侧边栏断言 `getByText('会话')` 在两版渲染中均不存在），与首页展示优化 diff 无关。**本 PR 未引入任何新增 E2E 失败**。建议另立维护任务修复这批存量用例（或按现状标注 known-failures），不阻塞本 PR。

> 备注：本轮首轮执行曾出现 89 项 API 失败 + 48 项 E2E 失败，经排查为**测试环境问题**（本机并存两个 Aspire 会话，`agent-api` 固定端口 10001 被另一会话占用，测试打到另一会话的 agent-api + 本会话 controller-api，跨 Redis 导致注册 `INVALID_KEY`；另 `VITE_API_URL` 需为 origin 形态、不带 `/graphql` 后缀，否则 SSE 消息流 404）。环境修正后 API 339/339 全绿、E2E 恢复上述结果。记录备查。

## 五、结论（第一轮，历史记录）

**打回返工（docs-only）**——问题 1、2 均为文档/契约一致性问题，改动限于 `contracts/home.graphql`、`servers/agent-api/AGENTS.md`、`docs/engineering/plan/20261013-feat-unified-home-display.md` 数行注释/描述，**无需改动任何代码与单测**；代码层面无遗留问题（单测 608+414、API 集成 339/339、E2E 无新增失败——26 项失败为存量问题且基线 1:1 复现、本特性 E2E 5/5、试验合并复跑通过）。修复后重新提交 Review，预期下一轮直接闭环。

合并节点执行 PR #202 合并时，必须按「问题 A」指引解决两处冲突（尤其 `controller-key.test.ts` 的 `evictKeyById → mockResolvedValue(true)`），合并后请复跑 `servers/agent-api` 与 `apps/agent-web` 单测确认。

---

## 六、第二轮复核（2026-10-14，返工 `ff79b22` 核验）

### 6.1 核验范围与方法

- 代码差距：`origin/release...integration`（17 commits，61 文件，+3037/-657；较首轮新增 2 个 docs commit：`53dcbe8` 首轮验收报告、`ff79b22` 返工修复）。
- 核验方法：
  1. 逐条比对返工说明与 `ff79b22` 实际 diff（`git show ff79b22`）；
  2. 以**实现为基准**复核注释/文档口径：`gatewayService.findAllByController`（`services/gateway.ts:9`，`Gateway.find` 纯 DB）、`worktreeService.list` + `withTimeout`（`resolvers/home.ts:123-136`，Redis relay 扇出）、`MainLayout.tsx`（仅 auth `loading` 整页 spinner + `error && !data` 重试，home 数据无加载分支）；
  3. 全仓 grep 扫描「扇出/离线/降级/relay + gateways」同源表述，排查旧口径残留；
  4. 定向单测复跑。
- 自首轮（`56b4d6f`）以来**代码/测试零变更**（`ff79b22` 为 docs-only，3 文件 15+/13-），首轮全量测试结论（后端单测 608、前端单测 414 + `tsc -b`、API 集成 339/339、E2E 164 passed 且 26 项失败经 merge-base 基线 1:1 复现证实为存量、本特性 E2E 5/5、试验合并复跑通过）继续有效，本轮未重复全量执行。

### 6.2 返工修复核验

| # | 问题 | 核验结果 | 说明 |
|---|---|---|---|
| 1 | `Controller.gateways` 契约/文档口径 | ⚠️ 部分修复 | `contracts/home.graphql` 头注释与 `extend type Controller` 注释、`servers/agent-api/AGENTS.md`、plan（关键约束/Phase1 契约表/Phase4 resolver 表/T-H2/T-H3/checklist）均已改为「`gateways` 纯 DB 查询、不随在线状态降级；仅 `worktrees` Redis relay 扇出、离线/失败/超时降级为空列表」，与实现逐条一致 ✅；但同一错误口径在 3 处注释残留（问题 7），未达「注释与实现一致」的修复目标 |
| 2 | plan 对 MainLayout 加载态的描述 | ✅ 修复通过 | plan `:201` 已改为「首屏不阻塞布局外壳、无独立加载分支…整体错误 `error && !data` + 重试入口」，T-F2 措辞同步；与 `apps/agent-web/src/pages/MainLayout.tsx` 实现逐条一致（无 `loading && !data` home 加载分支，仅 auth `loading` 与 `error && !data`） |

返工 commit 与说明一致：`git show ff79b22 --stat` = `contracts/home.graphql`、`docs/engineering/plan/20261013-feat-unified-home-display.md`、`servers/agent-api/AGENTS.md` 3 文件 15+/13-，确为 docs-only。

### 6.3 问题 7（🟡 一般·文档/契约一致性，阻塞）问题 1 修复不完整——`gateways` 旧口径注释残留 3 处

**问题描述**：`ff79b22` 修正了 contracts/plan/`servers/agent-api/AGENTS.md` 的 `Controller.gateways` 口径，但本 diff 引入的以下 3 处注释仍保留「按控制器扇出 / 离线降级为空列表」的旧口径，与实现（`services/gateway.ts:9` `Gateway.find` 纯 DB 查询，**离线控制器仍返回其网关配置行**）以及已修正的契约相互矛盾：

1. `servers/agent-api/src/graphql/schemas/home.ts:23`（SDL 注释）：「嵌套惰性解析：仅查询语句选择时按控制器扇出网关；离线或失败返回空列表」——「按控制器扇出网关」「离线…返回空列表」均不实。
2. `servers/agent-api/src/graphql/resolvers/home.ts:108`（resolver 注释）：「嵌套惰性解析：仅查询语句选择 gateways 时执行；离线或失败降级为空列表」——「失败降级为空列表」属实（`degrade`），但「离线…降级」不实。
3. `apps/agent-web/src/graphql/types.ts:584`（`HomeOverviewControllerData.gateways` JSDoc）：「嵌套惰性字段：离线或扇出失败为空列表」——`gateways` 无扇出、离线不降级（仅异常降级）。

**根因分析**：首轮问题 1 的修复要求点名了 `contracts/home.graphql` 与 `servers/agent-api/AGENTS.md`（plan 为返工自行扩展），返工按清单逐点修改，未对同类表述做全仓扫描，导致同一 diff 内 3 处同源注释漏改。这 3 处恰是开发者读代码时最先看到的位置（schema 注释、resolver 注释、前端类型 JSDoc），误导风险不低于首轮点名的两处。

**修复要求**（docs-only，仅注释，无代码/测试改动）：按已修正的契约口径统一上述 3 处措辞——`gateways` 为「仅查询语句选择时执行的纯 DB 查询，不随控制器在线状态降级（异常时 `degrade` 空列表）」，不得套用「扇出 / 离线降级」；`types.ts:589`（`worktrees`）如需对齐可补「超时」字样（可选）。修改后全仓 grep「扇出/离线/降级 + gateways」确认零残留（当前已知残留即上述 3 处）。

**验证结果**：✅ **第三轮（`f3d367e`）修复通过**——4 处注释（3 处点名 + `apps/agent-web/AGENTS.md:38` 同缺陷类残留）全部改为「`gateways` 纯 DB 查询、不随控制器在线状态降级；仅 `worktrees` 经 Redis relay 扇出、离线/失败/超时降级为空列表」口径，与实现逐条一致；全仓 grep 扫描（命令与结果见「七、第三轮复核」）零错误口径残留；`git show f3d367e --stat` 5 文件 12+/12- 确为 docs/comment-only。

### 6.4 问题 8、9（🟢 建议，不阻塞）

**问题 8**：plan T-H 用例表与 API 测试用例 ID 不对应——plan 列 T-H1~T-H6（其中 T-H2「未选择不触发嵌套解析（mock/计数断言）」、T-H3「含 `controllers.gateways`…不随在线状态降级」），实际 `tests/api/src/agent-api/home.test.ts` 为 T-H0~T-H3 + T-W*/T-S*，无同 ID 对应用例，plan 验收 checklist「T-H1 ~ T-H6 全部通过」无法字面核销。建议：按实际用例重排 plan T-H 表，或补一条「离线控制器仍返回网关配置行」断言，把新口径固化为测试（TDD 取向推荐后者）。

**问题 9**：锁定的技术方案 `docs/engineering/proposals/20261013-feat-unified-home-display.md:169,235` 仍为「`gateways`/`worktrees` 经 Redis relay…离线返回空列表」的旧设计表述。按 `docs/engineering/AGENTS.md`「proposals 评审后锁定」惯例可不改；如需消除歧义，建议加一行「实现偏离记录：`gateways` 最终为纯 DB 查询、不随在线状态降级」。

### 6.5 修复总览（第二轮）

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 1 | `Controller.gateways` 契约/文档口径 | 注释描述与实现不符 | ⚠️ 部分修复（残留见问题 7） | `ff79b22` |
| 2 | plan 对 MainLayout 加载态的描述 | 实现有意偏离、plan 未同步 | ✅ 已修复 | `ff79b22` |
| 7 | `gateways` 旧口径注释残留 3 处 | 返工未做全仓同源表述扫描 | ✅ 已修复（第三轮核验通过，另追加修复同类残留 1 处） | `f3d367e` |
| 8 | plan T-H 用例表与测试 ID 不对应 | 计划期用例表与实施期命名漂移 | 🟢 建议（不阻塞） | — |
| 9 | 锁定 proposal 保留旧设计表述 | proposals 锁定惯例 | 🟢 建议（不阻塞） | — |

### 6.6 最终验证（第二轮）

| 项目 | 结果 | 说明 |
|---|---|---|
| 返工 diff 审查 | ✅ | `ff79b22` 3 文件 15+/13-，与返工说明逐条一致，确为 docs-only |
| 定向单测复跑 | ✅ | `servers/agent-api` `src/graphql/resolvers/home.test.ts` **5 passed**；`apps/agent-web` `src/pages/__tests__/MainLayout.test.tsx` **3 passed** |
| 首轮全量测试结论 | ✅ 继续有效 | 自 `56b4d6f` 后仅新增 docs commit（`53dcbe8`、`ff79b22`），代码/测试零变更 |
| 合并冲突指引（问题 A） | ⏳ 留待合并节点 | 内容不变，继续有效 |

### 6.7 结论（第二轮）

**打回返工（docs-only）**——问题 2 修复通过；问题 1 修复不完整，`gateways` 旧口径注释残留 3 处（问题 7），与已修正契约及实现矛盾，属首轮问题 1 的同一缺陷类别，按同一标准继续阻塞。修复范围明确：**仅 3 处注释措辞**（`schemas/home.ts:23`、`resolvers/home.ts:108`、`graphql/types.ts:584`），无代码与测试改动；修复后重新提交 Review，预期下一轮直接闭环。问题 8、9 为建议，不阻塞；问题 A 合并指引不变。

### 6.8 经验总结

- 文档/注释口径修复必须做**全仓同源表述扫描**（关键词组合 grep），而非只改问题描述点名的文件。
- 同一语义的四处描述（contracts 注释、schema SDL 注释、resolver 注释、前端类型 JSDoc）应一次性对齐，避免修复碎片化。
- 「文档描述与实现不符」类问题的验收标准应为「全仓零残留」，修复说明中应附扫描证据（grep 命令与结果）。

---

## 七、第三轮复核（2026-10-14，返工 `f3d367e` 核验）

### 7.1 核验范围与方法

- 代码差距：`origin/release...integration`（19 commits，61 文件，+3111/-657；较第二轮新增 2 个 docs commit：`65038bf` 第二轮验收报告、`f3d367e` 返工修复）。
- 核验方法：
  1. 逐条比对返工说明与 `f3d367e` 实际 diff（`git show f3d367e`）；
  2. 以**实现为基准**复核 4 处注释口径：`GatewayService.findAllByController`（`servers/agent-api/src/services/gateway.ts:8-15`，`Gateway.find` 纯 DB 查询、无在线状态检查）→ `Controller.gateways` resolver（`resolvers/home.ts:108-118`，仅 `degrade` 异常降级）；`ControllerWorkspace.worktrees` resolver（`resolvers/home.ts:120-136`，`worktreeService.list` + `withTimeout` Redis relay 扇出、离线/失败/超时降级）；
  3. 全仓 grep 扫描「扇出/离线/降级 + gateways/网关」同源表述（含中文「网关」变体），排查错误口径残留；
  4. 核对 plan T-H 用例表与 `tests/api/src/agent-api/home.test.ts` 实际用例 ID 一一对应；
  5. 定向单测复跑。
- 自 `56b4d6f` 以来**代码/测试零变更**：`56b4d6f..HEAD` 全部 diff（8 文件）中仅 `types.ts`/`schemas/home.ts`/`resolvers/home.ts` 3 处为源文件，逐行为注释/JSDoc/SDL 注释改动，无任何逻辑变化；`origin/release` 自 `bb06f51`（2026-10-08）未移动，试验合并结论继续有效。首轮全量测试结论（后端单测 608、前端单测 414 + `tsc -b`、API 集成 339/339、E2E 164 passed 且 26 项失败经 merge-base 基线 1:1 复现证实为存量、本特性 E2E 5/5、试验合并复跑通过）继续有效，本轮未重复全量执行。

### 7.2 返工修复核验（问题 7，✅ 全部通过）

| # | 修复点（返工清单） | 核验结果 | 说明 |
|---|---|---|---|
| 1 | `servers/agent-api/src/graphql/schemas/home.ts:23` SDL 注释 | ✅ | 已改为「仅查询语句选择时执行（纯 DB 查询，不随控制器在线状态降级；异常时降级空列表）」，与 `gateway.ts:9` 纯 DB 查询实现一致 |
| 2 | `servers/agent-api/src/graphql/resolvers/home.ts:108` resolver 注释 | ✅ | 已去掉「离线」：「（纯 DB 查询，不随控制器在线状态降级）；失败降级为空列表」，与 `degrade` 行为一致 |
| 3 | `apps/agent-web/src/graphql/types.ts:584/589` JSDoc | ✅ | `gateways` 改为「纯 DB 查询，不随控制器在线状态降级；失败为空列表」；`worktrees` 补「经 Redis relay 扇出，离线或失败/超时为空列表」（含可选的「超时」字样） |
| 4 | `apps/agent-web/AGENTS.md:38`（同缺陷类追加修复） | ✅ | 中文「网关」表述的同类残留（英文关键字 grep 未覆盖），返工方主动发现并修复，口径与契约一致 |

**建议项处理核验**：

- 问题 8（plan T-H 用例表）：✅ 已按 `tests/api/src/agent-api/home.test.ts` 实际用例 ID 重排为 T-H0~T-H3（实际用例位置逐一核对：`:299` T-H0 未认证、`:305` T-H1 全字段+跨用户隔离、`:332` T-H2 嵌套 gateways、`:340` T-H3 嵌套 worktrees），并加注实际用例位置；验收 checklist 同步「T-H0 ~ T-H3 全部通过」。T-H2 表述保留「在线控制器」限定，离线语义由契约注释与 resolver 单测（`home.test.ts:127`）覆盖——可接受。
- 问题 9（锁定 proposal）：按 `docs/engineering/AGENTS.md` proposals 锁定惯例保留不改，与第二轮判定一致，可接受。

### 7.3 全仓扫描证据复核（零错误口径残留）

复跑返工方提供的扫描命令（排除 acceptance 历史记录与锁定 proposal）：

```bash
grep -rn --include='*.ts' --include='*.tsx' --include='*.graphql' --include='*.md' \
  -E '(gateways|网关).*(扇出|离线|降级)|(扇出|离线|降级).*(gateways|网关)|按控制器扇出网关|离线或扇出失败|离线或失败返回空列表' . \
  | grep -v acceptance | grep -v proposals/20261013
```

独立复核结果：全部命中行均为**正确口径**——`servers/agent-api/AGENTS.md:48`、`contracts/home.graphql:7-8`、`resolvers/home.ts:108`、plan `:36-37,62,172,175` 均明确「`gateways` 纯 DB 查询、不随在线状态降级；仅 `worktrees` Redis relay 扇出、离线/失败/超时降级」；`schemas/home.ts:28`、`contracts/home.graphql:36`、`resolvers/home.test.ts:127` 的命中均为 `worktrees`（扇出+降级属实）或 `gateways` 失败降级（属实）的正确描述。**无一处**将 `gateways` 描述为扇出或离线降级。与返工方扫描证据一致。

### 7.4 问题 10（🟢 建议，不阻塞）`worktrees` 注释未列「超时」降级

`schemas/home.ts:28` 与 `contracts/home.graphql:36` 的 `worktrees` 注释为「离线或失败返回空列表」，未列「超时」（实现含 5s `withTimeout` 超时降级；`types.ts:589` 已含「超时」）。表述不错误（超时可归入「失败」），仅列举不完备、三处措辞略不一致。建议后续顺手统一为「离线或失败/超时返回空列表」，不阻塞闭环。

### 7.5 修复总览（第三轮）

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|---|---|---|---|
| 7 | `gateways` 旧口径注释残留 3 处 | 返工未做全仓同源表述扫描 | ✅ 已修复（含追加修复同类残留 1 处，第三轮核验通过） | `f3d367e` |
| 8 | plan T-H 用例表与测试 ID 不对应 | 计划期用例表与实施期命名漂移 | ✅ 建议已落实（重排 T-H0~T-H3 并加注） | `f3d367e` |
| 9 | 锁定 proposal 保留旧设计表述 | proposals 锁定惯例 | 🟢 按惯例保留（闭环） | — |
| 10 | `worktrees` 注释未列「超时」降级 | 列举不完备 | 🟢 建议（不阻塞，留待后续顺手统一） | — |

### 7.6 最终验证（第三轮）

| 项目 | 结果 | 说明 |
|---|---|---|
| 返工 diff 审查 | ✅ | `f3d367e` 5 文件 12+/12-，与返工说明逐条一致，确为 docs/comment-only（含 plan T-H 表重排），无逻辑、无测试改动 |
| 注释/实现一致性 | ✅ | 4 处修复点逐一对照 `gateway.ts:8-15`（纯 DB）、`resolvers/home.ts:108-136`（gateways 仅异常降级 / worktrees 扇出降级）核实一致 |
| 全仓残留扫描 | ✅ 零残留 | 见「7.3」，命中行均为正确口径 |
| 定向单测复跑 | ✅ | `servers/agent-api` `src/graphql/resolvers/home.test.ts` **5 passed**；`apps/agent-web` `tsc -b` 通过 + `src/pages/__tests__/MainLayout.test.tsx` **3 passed**（本轮独立复跑核实） |
| 首轮全量测试结论 | ✅ 继续有效 | 自 `56b4d6f` 后仅新增 docs/注释 commit（`53dcbe8`、`ff79b22`、`65038bf`、`f3d367e`），代码/测试零变更；`origin/release` 未移动 |
| 合并冲突指引（问题 A） | ⏳ 留待合并节点 | 内容不变，继续有效：`controller-key.test.ts` 保留 release 侧 `evictKeyById → mockResolvedValue(true)`；`Sidebar.tsx` 取 integration 侧 |

### 7.7 结论（第三轮）

**✅ 复核通过，AI Review 闭环**——第二轮打回项（问题 7）返工 `f3d367e` 全部修复，4 处注释（3 处点名 + 1 处同缺陷类追加）与实现及契约口径逐条一致，全仓扫描零错误口径残留；建议项问题 8 已落实、问题 9 按锁定惯例闭环。代码正确性与测试结论自首轮起零变更（单测 608+414、API 集成 339/339、E2E 无新增失败、试验合并通过），integration 分支（@ `f3d367e`）**准予进入合并节点**。合并时必须按「问题 A」指引解决两处冲突（尤其 `controller-key.test.ts` 的 `evictKeyById → mockResolvedValue(true)`），合并后复跑 `servers/agent-api` 与 `apps/agent-web` 单测确认。建议项问题 3-6、9、10 留档不阻塞，可另立维护任务。

### 7.8 经验总结

- 返工修复「文档口径」类问题时，除英文关键词外需覆盖**中文同义词**（如「网关」vs `gateways`）的扫描变体；本轮返工方主动发现并修复中文残留，是全仓扫描应成为返工标准动作的正面例证。
- 多轮 Review 闭环中，每轮应核验「代码/测试零变更」与「上游分支未移动」两个前提，前提成立则历史全量测试结论可继承，避免重复全量执行。
- 计划期用例表与实施期用例 ID 漂移（问题 8）应在实现合入前对齐，避免验收 checklist 无法字面核销。
