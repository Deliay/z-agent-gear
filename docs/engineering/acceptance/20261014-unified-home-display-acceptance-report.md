---
description: integration→release 集成验收报告——首页展示优化（PR #202）AI Review 轮次，记录代码审查结论、发现的问题、合并冲突解决指引与验证结果
type: Permanent
---

# 首页展示优化 integration 验收报告（2026-10-14）

> **状态**: 🔴 打回返工（docs-only）——代码正确性审查通过、全部测试绿（单测 608+414、API 集成 339/339、E2E 164 passed 且 26 项失败经基线对照证实为存量问题、本特性 E2E 5/5、试验合并通过），但发现 2 项文档/契约一致性问题（问题 1：`contracts/home.graphql` 契约注释与 `Controller.gateways` 实现不符；问题 2：实现计划对 MainLayout 加载态的描述与实现不符），需修复后重新提交 Review。另有 1 项**合并冲突解决指引**（问题 A）必须在合并节点遵守，否则合并后单测必挂；4 项建议（问题 3-6）不阻塞。

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

## 五、结论

**打回返工（docs-only）**——问题 1、2 均为文档/契约一致性问题，改动限于 `contracts/home.graphql`、`servers/agent-api/AGENTS.md`、`docs/engineering/plan/20261013-feat-unified-home-display.md` 数行注释/描述，**无需改动任何代码与单测**；代码层面无遗留问题（单测 608+414、API 集成 339/339、E2E 无新增失败——26 项失败为存量问题且基线 1:1 复现、本特性 E2E 5/5、试验合并复跑通过）。修复后重新提交 Review，预期下一轮直接闭环。

合并节点执行 PR #202 合并时，必须按「问题 A」指引解决两处冲突（尤其 `controller-key.test.ts` 的 `evictKeyById → mockResolvedValue(true)`），合并后请复跑 `servers/agent-api` 与 `apps/agent-web` 单测确认。
