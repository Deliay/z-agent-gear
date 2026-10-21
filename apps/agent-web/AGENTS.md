# agent-web

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **GraphQL Client**: Apollo Client
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library

## Dev Commands

```bash
aspire start     # Start all services via Aspire orchestration
npm run build    # Production build
npm run preview  # Preview production build
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 agent-web 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 首页数据流

首页（`HomePage`）与桌面端侧边栏（`Sidebar`）的全部信息流由 `pages/MainLayout.tsx` 挂载的唯一一次 `HOME_OVERVIEW` 查询（`graphql/home.ts`，`pollInterval: 15000`）统一下发，子组件通过 `stores/homeOverview.ts` 的 `useHomeOverview()` 消费，**不得各自发起信息流查询**（会话/控制器/工作区/工作流/待办/网关/Worktree 均随聚合查询下发）。

- 首屏不阻塞布局外壳：`MainLayout` 先渲染侧边栏/页面外壳，聚合数据到达后各区块同批填充；任何需要 loading 兜底的判断必须写成 `loading && !data`，避免轮询时卸载整页（见 `frontend-rules.md` Apollo v4 轮询陷阱）。
- 归属字段（`WorkflowInstance.workspace` / `controller`）可能已被删除，消费方须判空，回退显示「未知工作区」。
- 网关/Worktree 为嵌套惰性字段：网关为纯 DB 查询、不随控制器在线状态降级（离线控制器仍返回其网关配置行，UI 层按 `status` 自行隐藏该区块）；Worktree 经 Redis relay 扇出，离线或失败/超时后端降级为空列表。
- 设置「可用模型」按组展示并默认折叠：「系统内置」组（`scope=global`）固定排首位、只读（无拖拽/无删除/开关置灰并提示「系统内置模型不可修改」），组内不展示后台供应商名；用户供应商组按 `providerId` 分组，仅组内可拖拽，排序只提交用户模型 id（不含 global）；跨组拖拽忽略。
- 会话内「切换模型」按来源分组：组序固定「平台内置 → Agent 自带 → 自定义 → 来源未知」，组头展示数量与判定依据（`availabilityModels[].basis` 去重后以「；」连接），组内保持原顺序；`group` 缺失归入「来源未知」。

## 会话能力门控与能力面板

- 能力清单由会话级快照（`session.features`）驱动，`SessionHeader` 右侧「能力清单」按钮打开 `AgentCapabilityPanel`（20 项固定顺序 + status/detail + Agent 版本）；无快照时显示「该会话创建于能力快照上线前，继续会话后可获取能力清单」。
- 门控语义集中在 `hooks/useAgentCapabilities.ts`：**只有「有快照且明确 unsupported」才拦截**，旧会话/旧 Agent（无快照）与 `partial` 一律放行（零退化）。
- 生效入口：模型切换（`config.model`）、模式切换（`config.mode`）、布尔配置项（`config.boolean`）、会话「继续」（`session.resume` 与 `session.load` 同时 unsupported 才禁用）；命令列表、历史导入/删除不门控。
- 会话内挂载 `PendingElicitationBanner`：消费首页聚合的 `todos`，筛选本会话未 resolved 的问询，保证移动端（Sidebar 未挂载）也能打开 `ElicitationDialog`。
- `ElicitationDialog` 按 `resolution` / 已过期的 `expiresAt` 展示「已过期/已取消/已失效/已提交/已拒绝」并隐藏操作；`TodoListPanel` 按 todo id 跟踪弹窗数据，轮询后自动收敛为终态。

## 云电脑（Cloud Host）约定

云电脑是 `Controller.type === 'cloud'` 的前台主机，生命周期契约见 `contracts/cloud-host.graphql`：创建即启动，停止即销毁，无再次启动。

- **数据来源**：Sidebar 的云电脑状态来自唯一 `HOME_OVERVIEW.controllers[].cloudHost`（`id/name/status/harnessTypes/defaultSessionId/activeSessionCount/failureReason/deletedAt`）；控制器配置页使用 `GET_CONTROLLERS.controllers[].cloudHost`；能力开关使用 `cloudHostCapabilities`（`enabled`、`supportedHarnesses`）。
- **入口**：Sidebar 主机列表标题行「新建云电脑」（`aria-label="新建云电脑"`，云 + 号图标）。`cloudHostCapabilities.enabled=false` 时隐藏；存在 `STARTING/RUNNING/STOPPING` 云电脑时禁用并提示「每用户同时最多 1 个云电脑实例」。
- **云图标与状态**：`type==='cloud'` 的主机名前置 `Cloud` 图标（`data-testid="cloud-host-icon"`），状态文案固定为 `STARTING 启动中 / RUNNING 运行中 / STOPPING 停止中 / STOPPED 已销毁 / FAILED 失败`（`FAILED` 附带 `failureReason`）。`STOPPED/FAILED` 条目置灰但可进入配置页与历史会话。
- **新建表单**：名称 trim 后 1~64；Harness 多选且至少 1 个（一期仅 `OPENCODE`）；选 1 个提示「将自动创建会话」，多选提示「不自动创建会话」；不提供存储/会话导入参数。服务端错误文案原样展示（`name is required` / `name is too long` / `too many cloud hosts` / `harness feature is disabled` / `at least one harness type is required` / `unsupported harness type: x`）。
- **停止**：打开停止对话框先查 `cloudHostStopImpact`；有活动会话展示「停止云主机会导致所有会话永久丢失，是否继续」，确认后 `stopCloudHost(id, force:true)`；无活动会话直接 `stopCloudHost(id, force:false)`。取消不调用。
- **删除**：仅 `STOPPED/FAILED` 展示删除入口，二次确认后 `deleteCloudHost(id)`，成功 refetch HOME_OVERVIEW 并返回主机列表；软删除的 Controller/会话/消息保留。
- **会话只读**：云电脑 `STOPPED/FAILED` 或 `deletedAt != null` 时，`SessionView` 隐藏输入框/发送/继续/恢复入口，仅保留历史消息；普通已结束会话仍可恢复。`NewSessionDialog` 仅允许 `RUNNING` 的云电脑创建会话，其余状态不出现选项并提示。
- **界面同构**：云电脑配置页保留「工作区」「可用 Harness 工具」两栏，与普通主机一致；仅额外展示云电脑状态/失败原因/活动会话数/停止/删除。普通主机不显示停止/删除。
- **移动端**：新建入口位于 Sidebar 列表标题行，mobile Sidebar 同样可达；对话框与配置页沿用现有宽度约束，禁止横向溢出。
- **Github 项目设置入口**：仅 `controller.type==='cloud' && cloudHost.status==='RUNNING' && !deletedAt` 时，Sidebar「工作区」TreeSection actions 与云电脑配置页「工作负载」页签展示 Github 入口（`aria-label="Github 项目设置"`）；local/STOPPED 不出现。
- **Github 设置表单**：数据来自 `GET_GITHUB_ACCOUNTS` + `cloudHostWorkloads(controllerId)`；账号切换后仓库按 `installations[].repos` 合并并按 `fullName` 去重；Github 预制工作负载默认选中且不可取消；目标路径默认 `cloudHost.defaultWorkspace`、必须绝对路径；未绑定账号展示「前往设置页绑定 Github 帐号」并禁用确认。
- **设置进度**：`GithubSetupProgressDialog` 以 `pollInterval: 1500` 轮询 `cloudHostSetupOperation(id)`，三步固定为「工作负载设置 → Git 项目设置 → 会话创建」；加载分支只认 `loading && !data`，轮询不卸载内容；失败可 `retryCloudHostSetupOperation`；成功且 `sessionId` 时 refetch `HOME_OVERVIEW` 后导航到会话，session 步骤失败展示「仓库已就绪，请手动创建会话」。界面不展示 token/命令。
- **工作负载设置区**：云电脑配置页「工作负载」页签列出标准负载（预制/已安装徽标、参数表单 TEXT/SELECT/MULTI_SELECT/BOOLEAN 默认值），仅 RUNNING 可安装，已安装项禁用且**无卸载入口**；安装复用同一进度对话框（单步）。
- **测试入口**：`components/__tests__/Sidebar.test.tsx`、`pages/__tests__/ControllerConfigPage.test.tsx`、`components/cloud-host/__tests__/*`（含 `GithubProjectSetupDialog` / `GithubSetupProgressDialog` / `CloudHostWorkloadsSection`）、`components/session/NewSessionDialog.test.tsx`、`components/session/__tests__/SessionView.cloudHost.test.tsx`、`graphql/__tests__/home.test.ts`（覆盖 T-AW1..15 与 T-AW-G1..G14 关键项）。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
