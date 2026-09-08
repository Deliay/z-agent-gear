---
description: 综合体验优化一期 - 实现计划（从技术提案拆解的分步可执行任务与测试覆盖计划）
type: Permanent
---

# 综合体验优化一期 - 实现计划

**关联 Proposal**: `proposals/20260907-feat-experience-optimization-phase1.md`（v1.0）
**关联 PRD**: `docs/product/draft/20260907-experience-optimization-phase1.md`
**feat-branch**: `feat/experience-optimization-phase1`
**创建日期**: 2026-09-07

## 实现顺序

```
Phase 1: agent-web（全部功能点，分 6 个 Step 推进）
  └── Phase 2: E2E 测试（tests/e2e）
```

依赖说明：本期无契约/后端/CLI 变更，唯一改动子项目是 `apps/agent-web`，另加 `tests/e2e` 测试覆盖。按 `z-coding` 的子项目实现模式，委托一个 subagent 基于 `feat/experience-optimization-phase1` 创建开发分支 `apps/experience-optimization-phase1`，完成后提 PR 回 `feat/experience-optimization-phase1` 待 review；E2E 测试在同一分支内随实现推进。开发模式采用 TDD（红-绿-重构）：每个 Step 先写/补测试再实现，编码前加载 `docs/engineering/common-rules.md` 与 `docs/engineering/frontend-rules.md`。

### 代码探查关键事实（实现时以现状为准）

- 会话对象**无 `workspaceId` 字段**（`types.ts` `SessionData` 仅有 `controllerId/cwd/worktreePath/worktreeBranch/workflowInstanceId`），「所属工作区」只能由 `Sidebar.tsx:58-68` 的 `getWorkspacePath`（`worktreePath` 目录名/`cwd` 匹配 `GET_WORKSPACES` 的 `name+controllerId`）推导；推导失败显示「未知工作区」置灰。
- 工作流实例有 `workspaceId`（`graphql/workflow.ts:117`），但 `GET_WORKFLOW_INSTANCES` 查询变量为单个 `workspaceId`（`WorkflowSidebarGroup.tsx:25-32`），控制器级平铺需对控制器下各 enabled 工作区分别查询后合并。
- `WorkflowSidebarGroup` 条目已是两行布局（第二行为状态文本），工作区辅助信息并入该行（`{工作区名} · {状态}`），不增加行高。
- `GET_WORKFLOW_INSTANCES` 轮询 15s，合并展示后保持各查询独立轮询即可。
- 新增/重新生成控制器 Key 的展示区域有两处：未绑定 Key 卡片（`ControllerListSection.tsx:216-241`）与重新生成 Dialog（`367-383`）；MCP Key 展示在 `McpProxyKeySection.tsx:103-121` Dialog。命令模板组件需覆盖以上全部 Key 展示处。
- `AddWorkspaceDialog` 只是 DirectoryPicker 包装，添加逻辑在 `WorkspaceSection.tsx:97-104` 的 `handleAdd`，且当前未读取 mutation 返回值——实现即时 Git 发现需取 `data.createWorkspace` 的工作区 id。
- `WorkspaceSection.tsx:156-177` 的 `refetchGitState` 为手写 fetch 包装，`handleExpand`（131-154）展开时按需调用并缓存到 `gitStates` state；即时发现复用该函数即可，无需引入新 query。

---

## Phase 1: agent-web

开发分支：`apps/experience-optimization-phase1`（基于 `feat/experience-optimization-phase1`）。

### Step 1: 命令模板纯函数（TDD 先行）

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/lib/command-template.ts` | 新增 | 按提案 §3.2 实现 `buildControllerCommand({ pm, region, key })`：npm/pnpm/bun 返回单行运行命令（`npx`/`pnpm dlx`/`bunx agent-gear --key <key> --server <endpoint>`）；pm2 返回结构化结果 `{ installHint, pm2ConfigJson }`——installHint 为当前选中包管理器的全局安装命令（`npm install -g`/`pnpm add -g`/`bun install -g agent-gear`），pm2ConfigJson 为 `{ "apps": [{ name, script: "agent-gear", env: { ZAG_CONTROLLER_KEY, ZAG_SERVER_ENDPOINT } }] }` 格式化 JSON 文本。端点：global `https://zag-ctrl-api.fffdan.com`，cn `https://ctrl.zag.cn.fffdan.com` |
| `apps/agent-web/src/lib/command-template.test.ts` | 新增 | 4 包管理器 × 2 服务器共 8 组组合断言；pm2 额外断言 installHint 与 JSON 片段 env 含 `ZAG_CONTROLLER_KEY`/`ZAG_SERVER_ENDPOINT` 且 JSON 可解析 |

### Step 2: CommandTemplate 组件与 Key 展示处接入

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/common/CommandTemplate.tsx` | 新增 | Props `{ keyValue: string }`；内部两个 Select（包管理器 npm/pnpm/bun/pm2 默认 npm；服务器 国内/全球 默认国内）+ 命令文本 + 一键复制按钮。pm2 模式改为两个复制块：全局安装提示 + pm2 配置 JSON 片段 |
| `apps/agent-web/src/components/common/__tests__/CommandTemplate.test.tsx` | 新增 | 默认选中 npm+国内；切换包管理器/服务器命令文本联动；pm2 渲染两个复制块；复制按钮写入剪贴板 |
| `apps/agent-web/src/components/settings/ControllerListSection.tsx` | 修改 | 未绑定 Key 卡片（216-241）与重新生成 Dialog（367-383）的 `<code>{rawKey}</code>` 下方挂载 `CommandTemplate` |
| `apps/agent-web/src/components/settings/McpProxyKeySection.tsx` | 修改 | 创建成功 Dialog（103-121）的 Key 展示下方挂载 `CommandTemplate`（Key 来源为 REST `createdKey`） |
| `apps/agent-web/src/components/settings/__tests__/` | 修改/新增 | 补两处 Key 展示区域渲染 CommandTemplate 的断言 |

### Step 3: 会话树重构（TreeSection + Sidebar）

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/tree/TreeSection.tsx` | 新增 | 分组容器组件：组头为 Label 折叠行，子内容 `ml-2` 窄缩进 + `border-l` 引导线；受控/非受控展开状态 |
| `apps/agent-web/src/components/tree/__tests__/TreeSection.test.tsx` | 新增 | 折叠/展开切换、引导线 class、子内容渲染 |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 树结构改为 控制器 → [工作流 \| 统一网关 \| 会话 \| 工作区] 四个 TreeSection：① 控制器行渲染为整宽 button（占满栏宽），移除右侧 Chevron 下拉 icon，点击整行切换 `expandedControllers`；② 工作流分组：对该控制器全部 enabled 工作区分别查询 `GET_WORKFLOW_INSTANCES` 合并平铺（复用 `WorkflowSidebarGroup` 条目样式，第二行改为 `{工作区名} · {状态}`，工作区名按 `instance.workspaceId` 匹配 `GET_WORKSPACES`，缺失显示「未知工作区」置灰），组头右侧保留新建按钮（ghost icon，打开 `InstantiateWorkflowDialog`，见 Step 5）；③ 统一网关分组：复用 `GatewaySection` 列表能力（迁入 TreeSection）；④ 会话分组：平铺该控制器全部会话 NavLink（自 275-318 迁移），条目两行——标题 + muted 小字所属工作区名（`getWorkspacePath` 推导，失败「未知工作区」置灰）；⑤ 工作区分组：按工作区聚簇展示 worktree 列表（复用 `WorktreeSidebarGroup`，保留 Git 状态标记）；⑥ 空分组展示空态提示与该分组新建入口；⑦ 拆除原 `sessionsByWorkspace` 按工作区包裹层级（230-324） |
| `apps/agent-web/src/components/workflow/WorkflowSidebarGroup.tsx` | 修改 | 抽取条目渲染与状态文本逻辑供控制器级平铺列表复用；原按工作区挂载形态保留给父组件迁移期使用或随 Sidebar 重构一并替换（以最小改动为准） |
| `apps/agent-web/src/components/__tests__/Sidebar.test.tsx` | 新增/修改 | 四个分组入口依次渲染；控制器整行可点击折叠且无下拉 icon；工作流/会话条目含所属工作区辅助行（含未知工作区置灰）；空分组空态 |

### Step 4: 侧边栏优化

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 删除顶部「会话」标题与新建按钮（169-175）；侧边栏底部（351-370 用户/设置行区域）新增仅图标（Plus）的新建会话按钮，仍 `setShowNewDialog(true)` 打开 `NewSessionDialog` |
| `apps/agent-web/src/pages/MainLayout.tsx` | 修改 | 第 23 行 `grid-cols-[240px_1fr]` 加宽为 `grid-cols-[280px_1fr]`（仅桌面端；移动端 `useIsMobile` 分支 46-50 全屏 Sidebar 不变） |
| `apps/agent-web/src/components/GatewaySection.tsx` | 修改 | 新增按钮（40-49）由 `buttonVariants({size:'xs'})` 实心按钮改为与 `WorkflowSidebarGroup.tsx:64-72` 相同的裸 ghost icon（Plus）按钮样式 |
| `apps/agent-web/src/components/__tests__/` | 修改/新增 | 侧边栏无「会话」标题；底部存在新建会话图标按钮且点击打开 NewSessionDialog；网关新增按钮 class 与工作流一致 |

### Step 5: 创建工作流支持选择工作区

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/workflow/InstantiateWorkflowDialog.tsx` | 修改 | 新增工作区 Select：数据源当前 `controllerId` 下 `GET_WORKSPACES`（enabled 工作区）；默认选中 props 传入的 `workspaceId`（保持 `WorkflowSidebarGroup`/`WorktreeSidebarGroup` 两处现有入口行为不变）；控制器级新建入口未传/无默认时选中第一个 enabled 工作区；用户改选后随 `InstantiateWorkflowInput.workspaceId` 提交（151-184 组装处改为使用选中值）。契约已必填 `workspaceId`，零后端改动 |
| `apps/agent-web/src/components/__tests__/InstantiateWorkflowDialog.test.tsx` | 修改/新增 | 下拉列出工作区、默认选中传入值、改选后提交 input.workspaceId 为选中值 |

### Step 6: 添加工作区即时 Git 发现

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | `handleAdd`（97-104）读取 `createWorkspace` mutation 返回的新工作区 id，成功后立即调用既有 `refetchGitState`（156-177）将结果写入 `gitStates`，工作区条目无需展开即展示 Git 状态/分支；发现失败（控制器离线、超时）不阻塞添加，条目维持「未发现」状态，展开时按现有逻辑可重试 |
| `apps/agent-web/src/components/settings/__tests__/WorkspaceSection.test.tsx` | 修改/新增 | 添加成功后触发 Git 发现并展示状态；发现失败不阻塞添加且可重试；非 Git 目录标记「非 Git 仓库」 |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 单测全绿；树结构为 控制器 → 工作流/统一网关/会话/工作区 四平级分组
- [ ] 控制器行整宽 Label 折叠、无下拉 icon；分组带引导线窄缩进
- [ ] 工作流/会话条目均有所属工作区辅助行（缺失置灰「未知工作区」）
- [ ] 创建工作流对话框可选工作区并正确归属；两处既有入口默认行为不变
- [ ] 侧边栏无「会话」标题、新建图标置底、桌面端栏体加宽、网关新增按钮与工作流一致
- [ ] 控制器（未绑定卡片 + 重新生成 Dialog）与 MCP 代理 Key 展示处均挂命令模板；默认 npm+国内；pm2 为全局安装提示 + 配置 JSON 片段两个复制块
- [ ] 添加工作区后无需进入即可见 Git 状态与分支；失败可重试不阻塞

---

## Phase 2: E2E 测试（tests/e2e）

沿用现有 Playwright 体系（`tests/e2e`，`testDir: './src'`，baseURL `http://localhost:35273`，需 Aspire 编排环境先行启动），在既有 spec 上扩充或新增 sidebar 相关 spec：

| # | 场景 | 验证点 | 建议落点 |
|---|------|--------|---------|
| E2E-1 | 树分组导航 | 控制器整行点击展开/折叠；四个分组依次展示；展开分组点击条目直达目标（≤3 次点击） | 新增 `sidebar-tree.spec.ts` |
| E2E-2 | 条目工作区辅助行 | 工作流/会话条目展示所属工作区名；工作区删除后置灰「未知工作区」 | 新增 `sidebar-tree.spec.ts` |
| E2E-3 | 创建工作流选工作区 | 对话框工作区下拉可选，创建后工作流归属所选工作区 | 扩充 `workflow.spec.ts` |
| E2E-4 | 侧边栏优化 | 无「会话」标题；底部新建会话图标可用；网关/工作流新增按钮样式一致 | 新增 `sidebar-tree.spec.ts` / 扩充 `responsive-layout.spec.ts`（移动端回归） |
| E2E-5 | 命令模板 | 新增控制器与 MCP 代理 Key 时展示模板；切换包管理器/服务器命令联动；pm2 展示安装提示 + JSON 片段；复制可用 | 扩充 `settings-controller.spec.ts`、`settings-mcp-proxy.spec.ts` |
| E2E-6 | 工作区即时 Git 发现 | 添加工作区后无需展开即展示 Git 状态/分支；非 Git 目录标记「非 Git 仓库」 | 扩充 `settings-workspace-git.spec.ts` |

### 验收 checklist

- [ ] E2E-1 ~ E2E-6 全部通过（Aspire 编排环境运行）
- [ ] 既有 e2e spec 无回归（重点：`responsive-layout.spec.ts` 移动端、`session` 相关 spec 的侧边栏入口）

---

## 总体验收

- [ ] 所有 Phase checklist 完成
- [ ] `apps/agent-web` build + lint + test 全绿
- [ ] E2E 测试 E2E-1~6 通过且既有用例无回归
- [ ] 提案 §9 验收标准逐项达成
- [ ] PRD §1.3 成功标准逐项达成（≤3 次点击定位、命令复制即用、添加工作区即见 Git 状态）
- [ ] `apps/experience-optimization-phase1` PR review 通过并合并回 `feat/experience-optimization-phase1`
- [ ] `apps/agent-web/AGENTS.md` 按本次改动同步更新（组件结构/约定变化部分）
