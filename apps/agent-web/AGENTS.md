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
pnpm run build    # Production build
pnpm run preview  # Preview production build
```

本项目由 Aspire 编排启动，无需单独运行 `pnpm run dev`。使用 `aspire describe` 查看 agent-web 的 HTTP endpoint。

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
- 会话内挂载 `PendingElicitationBanner`：消费首页聚合的 `todos`，筛选本会话未 resolved 的问询；点击**滚动定位**到会话时间线中的对应卡片（`data-interaction-id` 锚点），不再打开弹窗。
- **会话交互卡片（需求 #490）**：`InteractionCard`（`components/session/InteractionCard.tsx`）按 `createdAt` 合入 `MessageList` 时间线（同刻消息组在前、交互在后固定 tie-break）；`data-interaction-id={interactionId}` 作为滚动定位锚点。PENDING 可作答 + 倒计时（`expiresAt` 唯一依据，归零本地立即禁用展示「已过期」）；ACCEPTED 禁用并按 schema 字段标签回显 `response.values` / 所选审批项徽标（`option.kind` 为 `reject_*` 时徽标与回显显示「已拒绝」）；其余终态禁用 + 状态徽标。elicitation 表单渲染自 `ElicitationDialog` 提取为共享组件 `components/session/elicitation-form.tsx`（纯函数在 `lib/elicitation-form.ts`），口径不变。
- `ElicitationDialog` / `PermissionDialog` 已降级为**通知视图**（类型摘要 + 剩余时限提示 + 「前往会话处理」→ `/sessions/{sessionId}#interaction-{interactionId}`），不再承载表单/审批按钮；打开入口（`TodoListPanel`）与 `stores/elicitationDialog` 互斥机制保持不变（状态展示保留）。
- `ElicitationDialog` 按 `resolution` / `stale` 展示「已过期/已取消/已失效/已提交/已拒绝」文案（`data-testid="elicitation-status"`），不再有定时器驱动的表单禁用。
- 多选字段识别顺序为 `items.oneOf → items.anyOf → items.enum`，统一渲染勾选组（`role="group"`，选项说明为副行）；**所有** `type: 'array'` 字段（含 ACP question 工具多选题的 `items.anyOf`）提交时保持字符串数组（顺序 = 勾选顺序，空数组保持 `[]`），**不得**转成逗号拼接字符串——OpenCode 会按 schema 校验表单回填，字符串会导致 `form.reply` 失败并被取消，最终表现为「The user dismissed this question」导致会话中断（Issue #511）。
- 用户级 SSE `session_interaction` 事件经 `useUserEventStream.onSessionInteraction` 分发：会话页命中当前 `sessionId` 则 refetch `GET_SESSION_INTERACTIONS`；工作流实例页收到任意事件触发 `GET_WORKFLOW_INSTANCE` refetch（5s 轮询兜底）。
- 工作流实例页列表/图形两视图：节点 `sessionId ∈ pendingInteractionSessionIds` 时渲染琥珀色感叹号（`AlertCircle`，`aria-label="有待处理的提问或审批"`），点击打开该节点会话（复用既有 `onOpenSession` / `SessionSidePanel` 链路）；列表视图 prop 由实例页下发，图形视图由 `graph-layout` 的 `hasPendingInteraction` 派生。
- 问询弹窗打开权由 `stores/elicitationDialog.ts` 共享（`todoId + owner + 打开时快照`）：`PendingElicitationBanner`（owner=banner）与 `TodoListPanel`（owner=todo）互斥，同一时刻只渲染一个弹窗；弹窗数据按 todo id 从全量 todos 派生（不过滤 resolution），pending 清空后仍保留到终态展示，避免填表中被卸载；todo 被 TTL/limit 从列表移除时用快照渲染「已从待办移除」终态
  （stale 判定与 owner 无关，banner/todo 任一持有 stale 都不阻塞后续 immediate）；`close(owner)` 只允许持有方关闭；
  **真实卸载**时 cleanup 经微任务确认（排除 StrictMode 的 mount→cleanup→mount 模拟卸载）后关闭 `owner='todo'` 弹窗，
  切会话时 banner 侧同样清理自己持有的状态；表单草稿按 requestId 缓存（上限 50），owner 切换重挂载不丢已填内容。

## 新建会话与「+」列表刷新

- **工作区/工作流列表实时刷新**：`NewSessionDialog` 的 `GET_CONTROLLER_WORKSPACES_ENABLED`、`InstantiateWorkflowDialog` 的来源查询、`WorkflowSection` 的来源列表统一 `cache-and-network` + 打开/挂载 `refetch()`；加载分支只认 `loading && !data`，刷新期间不卸载表单、不清空输入，失败展示「刷新失败，可重试」并保留旧列表。
- **默认 MCP 预选**：按 `controller.defaultMcp` 在「打开 / 切换控制器」时计算一次（`useAllEnabled=false` 取 `serverIds` 与已启用集合交集，否则全部已启用）；用户调整后后台轮询不得覆盖。提交时**显式传数组**：`[]` = 不注入，`undefined` 才走服务端默认。
- **默认 MCP 设置**：控制器配置页「默认 MCP」页签（`McpDefaultSection`）保存 `SET_CONTROLLER_DEFAULT_MCP`；`MCP_SERVER_NOT_FOUND` 映射为「所选 MCP 已停用或不存在，请重新选择」，成功后提示「对后续新建会话生效」。移动端 tab 常驻滚动容器外。
- **模式/模型前置选择**：选定 ACP 工具后读 `acpServerOptions`（与工作流节点同源），下拉首项「默认」= 不传 `modeId/modelId`；「刷新」调 `refreshAcpServerOptions` 后就地替换选项，探测中/无选项不阻断提交。`onCreate` 为 **10 个位置参数**（`controllerId, acpServerType, workspaceId, enableWorktree?, worktreeBranchSuffix?, mcpServerIds?, existingWorktreePath?, modeId?, modelId?, customMcpServerIds?`），三个调用点 `Sidebar`、`SessionPage`、`WorktreeSidebarGroup` 必须同步透传全部参数（`WorktreeSidebarGroup` 的 `existingWorktreePath` 回退预选路径）；每个调用点保留映射单测，防止位置参数演进漏改。
- **自定义 MCP 分组（D9）**：`NewSessionDialog` 的 MCP 选择分两组——「MCP 服务」组（`GET_MCP_SERVERS`，过滤口径 `enabled && name !== agent-cloud-host-tools` 不变）+「自定义 MCP（工作区）」组（`GET_CUSTOM_MCP_SERVERS`）；两组勾选状态独立，自定义组**无控制器默认注入语义、缺省不勾选**。第 10 参仅在勾选时携带；三调用点以条件展开注入 `input.customMcpServerIds`——`undefined`/`[]` 一律**不下发该键**，保持旧报文形状（服务端 `[]` 与缺省同义，均为不注入）。

## 云电脑（Cloud Host）约定

云电脑是 `Controller.type === 'cloud'` 的前台主机，生命周期契约见 `contracts/cloud-host.graphql`：创建即启动，停止即销毁，无再次启动。

- **数据来源**：Sidebar 的云电脑状态来自唯一 `HOME_OVERVIEW.controllers[].cloudHost`（`id/name/status/harnessTypes/defaultSessionId/activeSessionCount/failureReason/deletedAt`）；控制器配置页使用 `GET_CONTROLLERS.controllers[].cloudHost`；能力开关使用 `cloudHostCapabilities`（`enabled`、`supportedHarnesses`）。
- **入口**：Sidebar 主机列表标题行「新建云电脑」（`aria-label="新建云电脑"`，云 + 号图标）。`cloudHostCapabilities.enabled=false` 时隐藏；**数量无限制**：存在活跃云电脑时入口仍可点击（不再提示「每用户同时最多 1 个云电脑实例」）。
- **云图标与状态**：`type==='cloud'` 的主机名前置 `Cloud` 图标（`data-testid="cloud-host-icon"`），状态文案固定为 `STARTING 启动中 / RUNNING 运行中 / STOPPING 停止中 / STOPPED 已销毁 / FAILED 失败`（`FAILED` 附带 `failureReason`）。`STOPPED/FAILED` 条目置灰但可进入配置页与历史会话。
- **新建表单**：名称 trim 后 1~64；Harness 多选且**可选**（0 个可提交，展示「可不选，之后在设置-工作负载中补装」；`harnessTypes: []` 随创建报文提交）；选 1 个提示「就绪后不会自动创建会话，需先创建或绑定工作区」，多选提示「不自动创建会话」；**不提供「创建默认工作区」勾选**（创建期不预置 `/home/worker/workspace`）；不提供存储/会话导入参数。**预装工作负载（可选）**来自 `cloudHostWorkloadCatalog`（无主机上下文，`installed` 恒 false）：列表展示名称 + `预制` 徽标 + 依赖名称，最多勾选 5 个；勾选任意项提示「勾选运行环境负载会延长首次就绪时间」；**未勾选时不传 `workloadIds`**（保持旧报文形状）；catalog 查询失败展示「负载列表加载失败，可仅创建基础云电脑」且不阻断提交。**Github 项目（可选）**区块复用 `hooks/useGithubProjectForm.ts`（账号/仓库/前缀/最终地址预览）；勾选后提交走 `hooks/useCloudHostProvisioning.ts` 编排：`createCloudHost(createDefaultSession:false)` → `GithubSetupProgressDialog` 轮询 `cloudHost(id)` 至 RUNNING → `setupCloudHostGithubProject(createSession = harnessTypes.length === 1)`；未选项目时请求体不含 `createDefaultSession`（与旧报文一致）。服务端错误文案原样展示（`name is required` / `name is too long` / `harness feature is disabled` / `unsupported harness type: x`）；`insufficient balance` 映射为「账户余额不足，请联系管理员充值后重试」，`github account is locked` 映射为「云电脑已绑定其他 Github 帐号，不可修改」；`too many workloads (max 5)` / `invalid workload` / `workload is not installable` / 依赖缺失或成环映射为对应中文提示。
- **收费详情**：新建对话框展示「收费详情」区块（`cloudHostBillingQuote`，打开时 `cache-and-network`）：创建花费 {createCredits} credits（一次性）、运行消费 {perMinuteCredits} credit/分钟、余额不足持续 10 分钟强制销毁；`availableBalance < createCredits` 时提示当前余额与充值引导但**不前置禁用**提交；报价查询失败降级为「创建与运行将产生费用，详见账单」。勾选 Github 项目时 `createCloudHost` 报文携带 `githubAccountId`（未勾选保持旧报文形状）。
- **默认会话**：`HOME_OVERVIEW` 观测到云电脑 `STARTING→RUNNING` 且 `defaultSessionId` 非空时自动进入该会话（每台主机仅一次，首次加载已 `RUNNING` 的旧主机不跳转）；`RUNNING` 且单 Harness 但无 `defaultSessionId` 时 Sidebar 提示「默认会话创建失败，可手动创建会话」。
- **停止**：打开停止对话框先查 `cloudHostStopImpact`；有活动会话展示「停止云主机会导致所有会话永久丢失，是否继续」与各会话标题/状态摘要，确认后 `stopCloudHost(id, force:true)`；无活动会话直接 `stopCloudHost(id, force:false)`。取消不调用；`stop` 返回空值时退出「停止中」并展示可重试错误。
- **删除**：仅 `STOPPED/FAILED` 展示删除入口，二次确认后 `deleteCloudHost(id)`，成功 refetch HOME_OVERVIEW 并返回主机列表；软删除的 Controller/会话/消息保留。
- **会话只读**：云电脑 `STOPPED/FAILED` 或 `deletedAt != null` 时，`SessionView` 隐藏输入框/发送/继续/恢复入口，仅保留历史消息；普通已结束会话仍可恢复。只读判定读取 `GET_SESSION` 的 `controllerType`、`cloudHost`（含软删除留档），**不得依赖 `GET_CONTROLLERS` 列表命中**（软删除后该 Controller 会被过滤）。`NewSessionDialog` 仅允许 `RUNNING` 的云电脑创建会话，其余状态不出现选项并提示。
- **设置-控制器管理按钮收敛**：`ControllerListSection` 中云电脑条目（已绑定与未绑定两分组）仅展示「配置」按钮，不展示「重命名 / 重新生成Key / 解绑(删除)」（条件渲染 `ctrl.type !== 'cloud'`）；服务端同步拒绝三操作（见 agent-api 段）。测试入口 `components/settings/__tests__/ControllerListSection.test.tsx`（T-CCOP-WEB1~2）。
- **界面同构**：云电脑配置页保留「工作区」「可用 Harness 工具」两栏，与普通主机一致；仅额外展示云电脑状态/失败原因/活动会话数/停止/删除。普通主机不显示停止/删除。
- **移动端**：新建入口位于 Sidebar 列表标题行，mobile Sidebar 同样可达；对话框与配置页沿用现有宽度约束，禁止横向溢出。控制器配置页移动端 tab 常驻滚动容器外，内容滚动时仍可切换。
- **Github 项目设置入口**：仅 `controller.type==='cloud' && cloudHost.status==='RUNNING' && !deletedAt` 时，Sidebar「工作区」TreeSection actions 与云电脑配置页「Github」页签展示 Github 入口（`aria-label="Github 项目设置"`）；「工作负载」页签不再出现该入口，local/STOPPED 不出现。
- **Github 设置表单**：数据来自 `GET_GITHUB_ACCOUNTS` + `cloudHostWorkloads(controllerId)`；**帐号跟随云电脑**：`cloudHost.githubAccountId` 非空时帐号下拉置灰（说明「帐号跟随云电脑，选定后不可修改」），仓库列表仅该帐号；未锁定时首次设置选定即锁定；锁定帐号不在已绑定列表时展示「该帐号授权已失效、仓库不可用」并保持置灰；账号切换后仓库按 `installations[].repos` 合并并按 `fullName` 去重；Github 预制工作负载默认选中且不可取消；**前缀地址（工作根目录）**有默认工作区时预填 `cloudHost.defaultWorkspace`，无默认工作区（`hasDefaultWorkspace === false`）或新建云电脑流程（未传）预填 `~/workspace`（placeholder `例如：~/workspace`）；支持 `~`/`~/` 开头，前端按与服务端同规则展开为容器主目录 `/home/worker`（`lib/workspace-path.ts`，`~abc` 报「前缀地址必须以 / 或 ~ 开头」），仍拒绝 `..`/反斜杠；实时展示只读预览「最终 clone 地址：`<前缀>/<owner>/<repo>`」（纯展示，容错返回 null）；提交 `targetPath` 为**归一后的前缀**（不是最终目录，服务端负责拼接）；未绑定账号展示「前往设置页绑定 Github 帐号」并禁用确认。
- **设置进度**：`GithubSetupProgressDialog` 以 `pollInterval: 1500` 轮询 `cloudHostSetupOperation(id)`，默认三步固定为「工作负载设置 → Git 项目设置 → 会话创建」；传入可选 `hostId`（新建云电脑 + 项目编排）时前置「启动云电脑」阶段，同样 1.5s 轮询 `cloudHost(id)`，RUNNING 后回调一次发起 setup，启动 FAILED 展示 `failureReason` + 「重新创建」，setup 请求失败可「重新设置」重试；加载分支只认 `loading && !data`，轮询不卸载内容；失败可 `retryCloudHostSetupOperation`；成功且 `sessionId` 时 refetch `HOME_OVERVIEW` + `GetControllerWorkspacesEnabled` 后导航到会话，session 步骤失败展示「仓库已就绪，请手动创建会话」。旧入口（工作负载安装 / 手动 Git 设置）不传 `hostId`，三阶段与跳转逻辑零回归。界面不展示 token/命令。
- **工作负载设置区**：云电脑配置页「工作负载」页签列出标准负载（预制/已安装徽标、参数表单 TEXT/SELECT/MULTI_SELECT/BOOLEAN 默认值），按 `workloadKind` 分组（standard 组标题「运行环境 / 工具」，harness 组标题「云电脑（Harness）」且条目带「可选」徽标，空组不渲染），每项展示依赖名称（依赖 ID 映射同列表名称，缺失回退 ID）；仅 RUNNING 可安装，已安装项禁用且**无卸载入口**；安装复用同一进度对话框（单步）。
- **测试入口**：`components/__tests__/Sidebar.test.tsx`、`pages/__tests__/ControllerConfigPage.test.tsx`、`components/cloud-host/__tests__/*`（含 `GithubProjectSetupDialog` / `GithubSetupProgressDialog` / `CloudHostWorkloadsSection`）、`components/session/NewSessionDialog.test.tsx`、`components/session/__tests__/SessionView.cloudHost.test.tsx`、`graphql/__tests__/home.test.ts`（覆盖 T-AW1..15 与 T-AW-G1..G14 关键项）。

## Git 区块（设置页）

- 挂载：`pages/SettingsPage.tsx` 的独立 `#git-section`（NAV label「Git」，GitBranch 图标，紧随「GitHub 绑定」组），
  渲染 `<GitSettingsSection />`。`#github-section` 只保留 `<GithubBindingSection />`（旧「Commit 设置」区块已下线）。
- 数据：`GET_COMMIT_SETTINGS` / `UPDATE_COMMIT_SETTINGS`（仅 `committerType/customName/customEmail`）+
  `GET_PERSONAL_GITHUB_ACCOUNTS`（导入弹窗数据源）；类型手写于 `graphql/types.ts`
  （`CommitterType = 'CUSTOM' | 'UNSET'`，无 CommitterMode / source / readOnly）。
- 交互：标题「Git」+ 常驻提示「仅对云电脑环境生效」；「提交人」单选组二选一（自定义 / 未设置）；
  自定义时展示用户名、邮箱与「导入Github帐号信息」按钮（`ImportGithubAccountDialog`）；保存为**成员级**设置，
  与当前工作区无关（无共享/继承、无只读禁用）。
- 「与 bot 共同提交」：提交人下方的 checkbox，默认不勾选；仅 `committerType=CUSTOM` 可用，
  `UNSET` 时置灰并提示「设置提交人后可勾选」；保存随 `commitWithBot` 提交（`UNSET` 归一 `false`）。
  勾选后 Worktree 提交以成员为主作者、平台 bot 为共同作者；新建与已有 Worktree 均在成员新建会话时
  按当前设置同步（见 agent-api / agent-controller 段）。
- 导入弹窗：列出 `personalGithubAccounts`（头像 + 帐号名），选择后回填 `customName=githubLogin`、
  `customEmail=<githubUserId>+<githubLogin>@users.noreply.github.com`（可继续编辑）；空态引导
  「先到『GitHub 绑定』绑定帐号」。
- 校验：与服务端同源（trim 后非空且 ≤100、≤254、禁 `\n\r\0`、邮箱正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`），
  失败文案「提交人用户名或邮箱格式不正确」（服务端白名单 `invalid custom committer` 映射到同一条）；
  前端拦截不替代服务端权威校验。
- 保存成功 toast「对成员的会话/工作流 Worktree 生效」；加载分支用 `loading && !data`，后台刷新不覆盖用户编辑（dirty 保护）。
- 缓存：`GET_COMMIT_SETTINGS` 用 `fetchPolicy: 'cache-and-network'`，保存 mutation 带
  `refetchQueries: [GET_COMMIT_SETTINGS]`（`CommitSettings` 无 `id`，Apollo 无法归一化 mutation 结果）。
- 测试：`components/settings/__tests__/GitSettingsSection.test.tsx`、
  `components/settings/__tests__/ImportGithubAccountDialog.test.tsx`；
  E2E `tests/e2e/src/settings-git.spec.ts`。

## Valut / 自定义 MCP（设置页）

> 契约 `contracts/valut.graphql`、`contracts/custom-mcp.graphql`；实现计划见
> `docs/engineering/plan/20261104-feat-mcp-valut-iteration.md` Phase 4。

- **挂载与导航**：`pages/SettingsPage.tsx` 中 `<ValutSection />`、`<CustomMcpSection />` 紧随 `#mcp-section`
  之后（section id `valut-section` / `custom-mcp-section` 由组件自持）；NAV 组 label「MCP」组内项为
  「MCP 管理 / Valut / 自定义 MCP」，两区块标题后均带 `<Badge>工作区</Badge>`。
- **「MCP 代理」入口已移除（D5，仅前端）**：`components/settings/McpProxyKeySection.tsx` 与 `api/mcp-proxy.ts`
  （含其单测）已删除；`#mcp-section` 标题「MCP 代理」→「MCP 管理」、NAV 组名「MCP 代理」→「MCP」、
  `McpRegistrySection` 空态改为「暂无已注册的 MCP 服务」（去掉代理密钥引导）。
  **后端不动**：controller-api `/api/mcp-proxy*` 路由、`mcp-proxy-key` 模型与
  `tests/e2e/src/mcp-session.spec.ts`（直打 REST）零改动保留；`tests/e2e/src/settings-mcp-proxy.spec.ts` 随入口删除。
- **Valut 区块**：数据源 `GET_VALUT_ENTRIES`（namespace 聚合 + refs + editable/deletable，**选择集无 value 字段**）、
  `GET_VALUT_MANUAL_OPTIONS`（仅 manual）；增删改走 `CREATE/UPDATE/DELETE_VALUT_ENTRY`。
  按 namespace 分组展示（组头 displayName），**任何状态不回显明文值**；编辑对话框 key 只读、value 恒空
  （placeholder「输入新值（旧值不可见）」），提交 `updateValutEntry(id, value)`；
  行操作受 `editable/deletable` 收敛（`service-*` 条目 `deletable=false` 无删除入口，manual 有 refs 时服务端拒绝删除）；
  refs 行内展开查看；空态「暂无密钥条目」。
- **D11 穿透定位**：`ValutSection` 挂载时读 `searchParams`——`section=valut` 滚动到本区块、`entry=<id>` 命中且
  可编辑时自动展开该条目编辑对话框（每个 id 只处理一次，用户关闭后不回弹；只读上下文只滚动不弹窗）。
- **自定义 MCP 区块**：`GET_CUSTOM_MCP_SERVERS` 列表（名称 / endpoint / 验证方式）；新增/编辑对话框含名称、
  描述、endpoint、自定义请求头编辑器（key + 每行一个值 = 同名多值，≤32 条）与验证方式 `none|bearer` 二选一；
  Bearer 下「填写 token / 选择 token」二选一，选择态数据源 `GET_VALUT_MANUAL_OPTIONS`（仅 manual，
  仅对话框打开且选 Bearer 时拉取）。编辑时 `bearerEntryManaged=true` 就地重填 token（value 空待重填、不回显），
  `false` 默认落选择态并展示「前往 Valut 编辑」链接（react-router 导航 `/settings?section=valut&entry=<bearerEntryId>`）；
  删除二次确认，自建 token 额外提示联动删除 Valut 条目；空态「暂无自定义 MCP」。
- **auth 下发口径**：编辑时仅在验证方式发生变化（或填写了新 token / 改选了引用条目）时才带 `auth` 字段，
  **省略 = 不动**；`bearer → none` 显式下发 `{type:'none'}`；未改 token 的编辑报文不含 `auth` 键。
- **权限只是展示层收敛**：`useWorkspaceAccess().readOnly`（全局工作区 + developer）时隐藏两区块的
  新增/编辑/删除入口；服务端插件才是权威，兜底文案 `global workspace is read-only` 映射为中文提示。
  错误白名单映射单一来源：`lib/valut.ts`（`valut key already exists` 等）与 `lib/custom-mcp.ts`
  （`invalid mcp endpoint`、`bearer token is required` 等），未命中的文案原样展示。
- **工作区切换与刷新**：两区块数据随 `x-workspace-id` 上下文自动切换（既有 apollo `workspaceLink`），
  查询统一 `fetchPolicy: 'cache-and-network'` + mutation `refetchQueries`，沿用既有切工作区 `resetStore` 口径；
  加载分支只认 `loading && !data`。
- **测试入口**：`components/settings/__tests__/ValutSection.test.tsx`（T-WEB1）、
  `components/settings/__tests__/CustomMcpSection.test.tsx`（T-WEB2）、
  `pages/__tests__/SettingsPage.test.tsx`（T-WEB3：代理三处移除 / 新 NAV / 区块顺序）、
  `components/session/NewSessionDialog.test.tsx`（T-WEB4：两组独立勾选与第 10 参）与
  三调用点映射单测（`components/__tests__/Sidebar.test.tsx`、`pages/__tests__/SessionPage.test.tsx`、
  `components/worktree/WorktreeSidebarGroup.test.tsx`）。

## 多租户一期（注册硬关闭与展示名）

- **前台注册已硬关闭**：注册页与注册路由、注册 mutation 均已在页面/路由/契约三层移除；开户仅由后台经 agent-api `POST /internal/users` 发起。登录页不提供任何注册入口。
- **登录响应形态**（`contracts/auth.graphql`）：`AuthPayload.user = User{ id, name, tenant }`，`Tenant{ id, name, type, memberCount }`。`stores/auth.ts` 的 `User` 类型以 `name` 作为展示名（`tenant` 可选，兼容升级前 localStorage 旧登录态）。
- **展示名消费点**：`Sidebar` 的 prop 为 `name`（`MainLayout` 传 `user?.name`）、`SettingsPage` 个人资料展示 `user?.name`；不再读写 `user.username`。登录表单的 `username` 输入只是登录凭据字段，与展示名无关。
- **计费**：`MyBillingAccountData.ownerType` 联合类型包含 `tenant`（`front_user` 仅历史兼容，`admin_user` 保持不变）；前端不展示 ownerType 文案，数值口径零改动。

## 会话渲染层（对话渲染重构一期）

> 纯前端渲染层，不改 ACP 协议、消息存储与后端契约。实现计划见 `docs/engineering/plan/20261028-refactor-conversation-rendering.md`。

- **工具调用视图模型合并**（`components/session/tool-call-state.ts`）：同一 `toolCallId` 的全部消息经 `mergeToolCallMessages` 合并为 `MergedToolCall`，三态语义——字段未携带（`undefined`）保留原值、显式 `null` 清除、有值替换。`MessageList` 在分组 memo 后统一合并，`ToolCallCard`/`ReadCard`/`FetchCard`/`SubAgentCard` 只消费合并结果（props 为 `toolCall`，不再接收 `messages[]`）；标题口径为合并后 `title ?? kindLabel(kind)`，保证「工具完成后标题/类型/参数不丢失」（禁止再退化为 `Tool Call: other`）。`group-messages.ts` 分组逻辑保持不变。
- **Markdown 管线**（`components/session/markdown/`）：代码块统一由 `MarkdownContent` 的 `pre` 覆写承接——`language-mermaid` 分流 `MermaidBlock`，其余（含无语言）走 `CodeBlock`（语言标签 + 复制 + 换行切换）；`code` 覆写仅保留行内代码样式。Mermaid 必须 `import('mermaid')` 动态导入（securityLevel=strict，失败回退 CodeBlock），不得改为静态引入。
- **差异与终端**：`lib/diff.ts` 先归一化换行（CRLF/CR→LF）再按纯行文本 `diffArrays` 输出带新旧行号的行序列（>2000 行截断提示，输入超限先裁剪）；`DiffView` 双行号列 + `lib/language-from-path.ts` 语言推断 + Prism 逐行高亮。终端输出由 `lib/terminal-buffer.ts` 经 `@xterm/headless`（精确锁 `6.0.0`，动态 `import()` 懒加载）完整终端仿真解析：`convertEol: true`、80 列、scrollback 5000、`allowProposedApi`（仅读取 buffer）、`logLevel: 'off'`；`renderTerminalOutput` 为**异步**函数（`write` 回调 Promise），返回按同样式合并的最终画面行，输入上限 2MB（保留尾部）、渲染上限 2000 行（保留最后 N 行）并前置提示行；解析失败降级为 `stripTerminalSequences()` 纯文本（迁移自旧 `ansi.ts` 的 OSC/DCS/APC/PM/C1/截断序列剥离正则）。深黑主题配色唯一来源 `lib/terminal-theme.ts`（`#050505` 背景 + 16 色/256 色/真彩色/加粗亮色/inverse），与界面浅色/深色模式解耦。`TerminalOutput` 以 React 文本节点逐行渲染（**不使用 `dangerouslySetInnerHTML`**），行容器 `whitespace-pre` 不做二次折行，容器 `min-w-0` + 内层 `w-max` + `overflow-auto`。
- **工具卡片体系**：`tool-call-icons.tsx` 提供 `ToolKindIcon`（未识别类型回退 Hammer）；`AcpCard` 新增 `pending` 弱化样式（legacy 颜色键保留）；`ToolCallRawSection` 提供 rawInput/rawOutput 折叠（JSON，>500 行截断）；`ContentBlockRenderer` 覆盖 text/image/audio/resource_link/resource 以及 diff/terminal，未知类型降级提示不空白。
- **消息操作与导出**：`MessageActions` 在 agent 文本消息 hover 操作条提供「复制 Markdown」（与展示同源的合成文本）与「复制纯文本」（经 `lib/markdown-plain-text.ts` 从源 Markdown 去标记，不含代码块语言标签/Mermaid 工具栏等 UI chrome；非文本消息不挂操作条）；`SessionHeader` 的「导出对话」先经 `collectFullHistory` 按 `before` 游标拉全历史（>25 条也不会截断），再由 `lib/export-thread.ts` 生成 Markdown（用户/助手/思考/工具分节，流式分片按 messageId 合并，工具经合并口径并含 content 结果摘要）并 Blob 下载，文件名 `session-{id}-{date}.md`。
- **滚动跟随**：`MessageList` 以滚动事件的同步几何距离为主判定是否贴底，IntersectionObserver（threshold 0.9）为辅（内容增长期间的 IO 瞬时离底不丢失跟随）；append 仅在贴底时 `auto` 滚底，否则保持视口并显示「回到底部」+ 新消息圆点；初始加载/程序化滚动期间抑制自动 load-more，prepend 位置恢复用单一 `scrollStateRef` 所有权，SSE 整组替换不残留 prepend 状态。组件测试通过 `vitest.setup.ts` 的可控 IntersectionObserver stub 驱动（`(globalThis as any).__triggerIntersection(bool)`）。
- **计划展示**：`PlanCard`/`PlanFloatingCard` 摘要三态（全部完成 / x/y / N 项任务）由 `plan-summary.ts` 统一，完成条目内容 `line-through`。
- **测试入口**：`components/session/__tests__/`（tool-call-state / ToolCallCard / ToolCards / ContentBlockRenderer / MessageActions / ScrollToBottomButton / PlanCard / DiffView / AcpCard / TerminalOutput）、`components/session/markdown/__tests__/`、`src/lib/__tests__/`（diff/terminal-buffer/terminal-theme/language-from-path/export-thread）、`tests/e2e/src/session-rendering.spec.ts`（E2E-CREN1~10）。

## UI 优化四期（侧边栏与工作流视图）

> 纯前端展示层；计划见 `docs/engineering/plan/20261030-feat-ui-optimization-phase4.md`。

- **侧边栏折叠分区**：`Sidebar` 顶层为「主机」「工作流」「会话」「知识库」「网关」五个全宽折叠分区；默认展开工作流/会话、折叠主机/知识库/网关，展开态持久化在 `localStorage['sidebar-sections-expanded']`（`lib/sidebar-prefs.ts`，逐 key 读取，旧持久化缺 key 自动回退默认）。工作流/会话/网关跨环境聚合（工作流含「已归档（N）」自折叠分组）；网关仅聚合**在线主机**的网关配置行（离线主机不渲染，与既有「UI 层按 status 自行隐藏该区块」口径一致）；主机分区保留「主机 → 工作区 → 会话」树与设置按钮；条目排序 `updatedAt` 倒序 + id tie-break，防轮询跳动。
- **空态收敛**：`TreeSection` 不再渲染 `emptyMessage` 占位文字（入参保留兼容），无内容时仅保留可展开空容器；层级缩进按 `level * 0.5rem`（≈2 空格）。
- **拖拽调宽**：`SidebarResizer` 4px 热区（pointer capture），clamp 15–28rem、默认 20rem，`pointerup` 写入 `localStorage['sidebar-width']`，双击恢复默认；`MainLayout` 桌面 grid 列使用 `var(--sidebar-width,20rem)`，移动端不渲染 Resizer（`lib/sidebar-width.ts` 为宽度口径单一来源）。
- **工作流卡片**：侧边栏条目不显示控制器名，第一行「名称 + 状态徽标」、第二行工作区；控制器名与执行中节点名走 tooltip（`WorkflowInstanceCard`）。
- **分区 badge 口径**：工作流分区标题行 badge 仅统计活动实例数量（不含已归档），已归档数量由分区内「已归档（N）」自折叠分组承载；活动为 0 时 badge 照常显示 `0`，不引入隐藏形态（T-BDG1/T-BDG2）。其余分区 badge 口径不变（主机/会话/网关/工作区）。
- **图表视图**：`graph-layout.ts` 以 dagre `rankdir:'TB'`（nodesep 40 / ranksep 70）布局，节点宽 280px、高度分档估算（120–220px）；连线 `strokeWidth:2` + `MarkerType.ArrowClosed`；画布 `h-full min-h-[480px]`，由 `WorkflowInstancePage` 视图区行填充；图表模式隐藏右栏 `BlackboardPanel`/`WorkflowContextPanel`（列表视图零变化）。
- **节点卡片**：`graph/WorkflowNodeCard.tsx` 自定义节点（状态色左脊 + 名称 + 类型/返工徽标 + Harness/模型 + 进行中动态行 + 完成态 token + PR/检查项徽标 + 资源小卡片 + 人类节点就地操作）；交互元素统一 `nodrag` + `stopPropagation`。
- **实时动态**：`hooks/useNodeSessionActivity.ts` 复用 `useSessionStream`（不自行创建 EventSource），复用 `group-messages.parseSessionUpdate` 与 `tool-call-state` 的 `mergeToolCallMessages`/`toolCallHeaderTitle` 口径；思考/文本结尾截断常量 `LIVE_ACTIVITY_TAIL_CHARS = 40`；进行中节点建立实时连接，转为 DONE 后关闭连接并保留已捕获的最后动态与用量；**首屏即为 DONE 的 AI 节点**以快照模式短连一次，收到 SSE history（含最后一条 `usage_update`）后立即断开，用于补全刷新后的 token 展示（不长期占用连接）。
- **资源上图**：`buildResourceOwnership` 纯函数负责归属——黑板 key 前缀 `{nodeId}-{nodeName}-产物-`（与列表视图 `lib/artifact-owners.ts` 同源）、PR 按 `nodeId`、追加提示词仅「恰好一个 RUNNING/REWORK 节点」时归属该节点，否则与无法解析的黑板条目一并进入画布顶部实例资源行；垃圾桶永不渲染；同节点最多 3 个可见小卡片 + 「+N」；小卡片限宽 12rem、标题最多 2 行（`line-clamp-2`）截断。
- **状态语义色单一来源**：`WorkflowNodeTreeConstants` 的 `NODE_STATUS_VISUAL`（`{spine, tint, badge}`）为唯一来源，`NODE_STATUS_BADGE` 重导出 `badge` 段保持兼容；REJECT 为静态琥珀、REWORK 为琥珀 + `animate-pulse`、FAILED 走 destructive；图表/列表/卡片/MiniMap 全部消费该映射或对应 `NODE_STATUS_COLOR_VAR`，禁止新增固定 hex 色值。
- **详情抽屉**：`components/ui/sheet.tsx`（Base UI 原语自实现，右侧滑出/全高/遮罩/Esc 关闭）+ `NodeDetailDrawer`（节点/资源两形态）；`WorkflowInstancePage` 提升抽屉状态，图表与列表视图共用；列表视图 `WorkflowNodeTree` 节点头部提供「详情」入口。
- **共享人类节点操作**：`hooks/useHumanNodeActions.ts` + `HumanNodeActions` 组件，列表/卡片/抽屉三处同源（草稿键 `workflow-node-draft:{instanceId}:{nodeId}`）。
- **测试入口**：`components/__tests__/Sidebar.test.tsx`（T-UI4-SEC/AGG）、`SidebarResizer.test.tsx`（T-UI4-RES）、`tree/__tests__/TreeSection.test.tsx`（T-UI4-TREE）、`workflow/__tests__/WorkflowInstanceCard.test.tsx`（T-UI4-IC）、`workflow/__tests__/WorkflowNodeTreeConstants.test.ts`（T-UI4-TC）、`workflow/graph/__tests__/*`（T-UI4-GL/NC/RC）、`workflow/__tests__/NodeDetailDrawer.test.tsx`（T-UI4-SH）、`hooks/useNodeSessionActivity.test.tsx`（T-UI4-NA）、`hooks/useHumanNodeActions.test.tsx`（T-UI4-HA）、`tests/e2e/src/sidebar-phase4.spec.ts`（E2E-UI4S1~S6）与 `tests/e2e/src/workflow-graph.spec.ts`（E2E-UI4G1~G10）。

## 知识库（#495）

> 契约 `contracts/knowledge-base.graphql`；计划 `docs/engineering/plan/20261115-feat-knowledge-base.md` Phase 6。

- **侧边栏第五分区**：`components/knowledge-base/KnowledgeBaseSection.tsx` 挂在「会话」之后、「网关」之前（D8），`SidebarSectionKey` 新增 `knowledgeBases` 且**默认折叠**（D3）。树独立走 `knowledgeBaseTree` 查询（不进 `HOME_OVERVIEW`，D4），`cache-and-network` + mutation `refetchQueries`；工作区切换随既有 `resetStore` 自动刷新。
- **树与入口**：知识库按名称、文档按路径层级聚合（`lib/knowledge-base-path.ts#buildKnowledgeBaseTree`，同级按展示名字典序 + 路径稳定排序）；全局工作区来源展示「全局」徽标。分区「+」创建知识库**仅 `useWorkspaceAccess().isAdmin`** 渲染；条目「+」按服务端 `myAccess.canCreate` 渲染，**点击即持久化**子文档（`新文档-{4 位随机后缀}`、空内容，D9）并跳 `/knowledge-bases/{kbId}{path}?edit=1`；知识库条目齿轮打开设置对话框。
- **路由与页面族**：`App.tsx` 的 `knowledge-bases/:kbId/*`（splat = 文档路径）+ `?edit=1` 编辑模式（D7）；`pages/KnowledgeBasePage.tsx` 用 `knowledgeBaseTree` 取知识库元信息/`myAccess`、按需 `knowledgeBaseDocument` 取正文；不可见/不存在统一提示且不泄露内容（服务端对不可见/无权限/不存在统一 null）。移动端 `MainLayout` 将 `/knowledge-bases/` 视为详情页（不显示列表侧边栏）。
- **预览**：`KnowledgeBasePreview` 依次渲染面包屑/标题/描述（灰色小字）/标签/Markdown（复用 `MarkdownContent`）；内容区 `max-w-3xl` **靠左**（无 `mx-auto`）+ `min-w-0` + `wrap-anywhere` 防横向溢出；编辑/删除/历史按钮以服务端 `myAccess` 为准。
- **分栏编辑**：`KnowledgeBaseEditor` 左预览（同一份 `MarkdownContent`）右表单（路径 / 标题 / 标签 / 描述 / 内容，原生 textarea，D10）；输入防抖 300ms 写 `localStorage['kb-doc-draft:{kbId}:{path}']`，保存成功清除（同时取消在途计时器）；进入编辑检测到草稿弹「恢复未保存的内容？」（恢复/放弃）。草稿读写纯函数在 `lib/knowledge-base-draft.ts`（损坏 JSON/非法形状按无缓存），形状含可选 `editedPath`（旧草稿兼容，恢复时回退当前路径）。
- **路径可修改（#541）**：编辑表单「路径」输入（`font-mono`，预填当前 path，`normalizeDocumentPath` 客户端预校验仅体验层）；保存时已存在文档且归一后路径 ≠ 原路径 → 一次 `updateKnowledgeBaseDocument(..., newPath)` 原子「移动 + 更新」，成功后清旧键草稿、先 `onSaved`（父级清 `?edit=1`）再 `navigate(knowledgeBaseDocHref(kbId, newPath))` 回预览态（编辑器按 `key={kbId:path}` 重挂载）；文档不存在时以编辑后路径 `createKnowledgeBaseDocument`；占用/非法/越权保持编辑态并展示既有中文映射。
- **标签徽章编辑器（#541）**：`components/knowledge-base/TagBadgeInput.tsx`（自足实现，不引第三方 tag 库）——Enter / `,` / `，` / blur 提交（trim）、与既有徽章重复 → toast 且不添加、徽章 `×` 逐枚删除、空输入 Backspace 删末枚、粘贴含中英文逗号拆分为逐枚提交管线（去重 / 单枚 ≤32 / 总量 ≤16 汇总提示）、输入框 `maxLength=32`、16 枚上限禁用 + 提示、IME 组合态 Enter 不提交；编辑器 state 由 `tagsText: string` 改为 `tags: string[]`（草稿形状零迁移），实时预览直接渲染数组。
- **历史与设置**：`KnowledgeBaseHistoryDrawer` 用 `knowledgeBaseEvents(path, limit:50)` 下拉选择版本（服务端 `createdAt` 倒序，含已删除路径历史）只读预览；`KnowledgeBaseSettingsDialog` 重命名/权限四档（`NONE/READ_ONLY/UPDATE_ONLY/FULL_ACCESS`，改动即 mutation）/全库历史/删除二次确认；管理控件以 `myAccess.canManage` 收敛，非管理员仍可看全库历史。`EVENT_OP_LABELS` 增补 `MOVE: '移动'`，抽屉徽标行与设置页全库历史行对 MOVE 事件路径位展示 `fromPath → path`（下拉选项文案保持「移动 · 时间 · 操作人」）。
- **错误文案**：`lib/knowledge-base.ts` 集中映射契约 14 条白名单（未命中原样展示），创建/保存/权限变更失败均在对话框内展示或 toast。
- **测试入口**：`lib/__tests__/knowledge-base-path.test.ts`（T-KBP1~6）、`knowledge-base-draft.test.ts`（T-KBD1~5）、`components/knowledge-base/__tests__/*`（T-KBW1~10）、`components/__tests__/Sidebar.test.tsx`（五分区默认态）、E2E `tests/e2e/src/knowledge-base.spec.ts`（E2E-KB1~7）与 `sidebar-phase4.spec.ts`（五分区）。

## 仓库内建知识库（#545；二期 #559）

> 需求 #545 / #559；契约 `contracts/knowledge-base.graphql`；计划
> `docs/engineering/plan/20261116-feat-knowledge-base-repo-built-in.md` Phase 6、
> `docs/engineering/plan/20261117-feat-knowledge-base-optimization-phase2.md` Phase 4。

- **分组挂载与 hosts 上提**：`KnowledgeBaseSection` 平台库列表之后渲染 `<RepoKnowledgeBaseSection />`（D12），
  **不新增** `SidebarSectionKey`。hosts 查询上提到 `KnowledgeBaseSection`（`GET_REPO_KNOWLEDGE_BASE_HOSTS`，
  `cache-and-network`），以 props `{hosts, loading, error, onRetry}` 下发，避免二次请求；无候选云电脑时
  整个子分组不渲染。
- **「暂无知识库」双空口径（D9）**：仅当平台树为空、hosts 查询成功且已定态为空时才展示「暂无知识库」；
  平台空 + hosts 在途展示「加载中…」；hosts 查询失败不展示空态，由仓库分组自渲染「加载失败 + 重试」。
  平台非空行为不变。
- **折叠懒加载**：云电脑/知识库/目录全部默认折叠，展开云电脑才发 `GET_REPO_KNOWLEDGE_BASES(workspaceId)`
  （`skip: !expanded`），展开知识库/目录才发 `GET_REPO_KNOWLEDGE_BASE_CHILDREN(id, path)`；
  各节点独立 `loading && !data` / 失败 + 「重试」，失败不扩散兄弟节点。
- **版本门禁**：`scanSupported=false` 展示「升级云电脑工作组件后可加载」且不发起 bases 查询、不渲染刷新入口；
  `scanSupported=true` 且列表为空展示「未检测到仓库知识库」。
- **只读语义**：知识库/目录/文档条目无「+」、无设置齿轮、无编辑/删除/历史入口；不合法库灰显并展示
  `errors[0]`；来源 Badge 显示 `zag`/`docs`（title 为完整目录标识），并展示 `documentCount`（不含错误文档）。
- **「已截断」/「文件过大」标示（D11）**：库 `truncated=true` 渲染 `已截断` Badge
  （`data-testid="repo-kb-truncated-badge"`，title 说明单文件夹子项超 1000）；文档节点 `error` 非空时
  灰显不可点击并渲染「文件过大」Badge（`data-testid="repo-kb-document-error"`），正常文档仍可导航。
- **重新检测（D10）**：入口位于云电脑条目标题行尾部、**仅图标**（`aria-label`/`title`「重新检测」，
  `data-testid="repo-kb-refresh"`），与折叠切换按钮为兄弟节点（禁止按钮嵌套）；折叠态 `client.query`
  `{workspaceId, refresh:true}` + `fetchPolicy:'network-only'`（结果写缓存，展开时自然取到）；展开态走
  `refetch({workspaceId, refresh:true})`；随后 `client.cache.evict({fieldName:'repoKnowledgeBaseDocumentChildren'|'repoKnowledgeBaseDocument'})`；
  刷新中禁用 + `RefreshCw` 旋转，失败 toast「重新检测失败，请重试」。
- **预览页**：`KnowledgeBasePage` 的 `kbId` 命中 `repo:` 前缀走只读分支——`GET_REPO_KNOWLEDGE_BASE_DOCUMENT(id, path)`
  取正文，直达链接额外经 `GET_REPO_KNOWLEDGE_BASES(workspaceId)` 回源库名（id 自 `repo:` 三段解码）；
  平台 `knowledgeBaseTree`/文档查询在 repo 分支 `skip`。**只读**（无编辑/删除/历史按钮，`?edit=1` 忽略）；
  `document === null` 展示「知识库不存在或不可访问」（不泄露内容）。
- **front matter 表格**：`lib/front-matter.ts#splitFrontMatter`（`---\n` 开头 + 前 4KiB 内闭合、逐行
  `key: value`、块非法按无）拆出**全部键值**；`RepoKnowledgeBaseContent` 用
  `data-testid="repo-kb-front-matter-table"` 渲染键值表格（含三键以外的键），正文复用 `MarkdownContent`
  （**不改动会话渲染管线**）；无 front matter 不渲染表格。
- **纯函数层**：`lib/repo-knowledge-base.ts` 的 `isRepoKnowledgeBaseId` / `decodeRepoKnowledgeBaseId` /
  `sourceLabel`（与服务端同口径）。
- **测试入口**：`lib/__tests__/repo-knowledge-base.test.ts`、`lib/__tests__/front-matter.test.ts`、
  `components/knowledge-base/__tests__/RepoKnowledgeBaseSection.test.tsx`、`RepoKnowledgeBaseContent.test.tsx`、
  `pages/__tests__/KnowledgeBasePage.test.tsx`（repo 只读分支）；E2E `tests/e2e/src/repo-knowledge-base.spec.ts`。

## 会话内容预览子系统（#461）

- **布局**：`SessionView` 根容器为纵向 flex——标题栏（`SessionHeader` / 协议与只读提示）独占一行，
  下方 `session-split-body` 内容行再按模式切 CSS Grid（`chat` 单列 / `horizontal` `grid-cols-[4fr_6fr]` /
  `vertical` `grid-rows-[3fr_7fr]`），对话列（`MessageList` + `InputBox`）与预览列并排或上下；标题栏
  工具栏在宽度不足（完整工具栏自然宽度 > 标题栏宽 − 信息区最小 192px）时**整体**收成省略号按钮
  （`data-testid="session-header-overflow"`），点击展开 icon+文字下拉（能力清单/分屏/实况/导出/归档/
  关闭/继续/删除，与展开态同回调同门控），宽度恢复后自动展开；jsdom 无布局默认展开，测试经 stub
  `clientWidth`/`scrollWidth` + window resize 驱动测量；偏好
  `lib/split-prefs.ts`（`session-split-mode:{sessionId}`，
  非法回退 chat）；宽度门控 `matchMedia('(min-width: 1024px)')`：不足隐藏「左右分栏」入口，
  偏好 horizontal 但宽度不足**渲染 vertical 不改写偏好**；`?review=` 深链临时分屏（不写偏好），
  关闭最后一个 Review 标签回退 chat，消费后 `history.replaceState` 清参。
- **store（裁决 1，不引入 zustand）**：`stores/preview.ts`（`reduceTabs` 纯函数 +
  `usePreviewStore(sessionId)` 模块级 Map 工厂：读→单共享预览 tab 替换、写→pinned 就地更新、
  review 幂等、关闭激活回退）与 `stores/prompt-composer.ts`（批注回传片段，`origin` 徽标）；
  `SessionView` 卸载 `destroy(sessionId)`。`getSnapshot` 必须返回缓存引用（useSyncExternalStore）。
- **内容组件**：`CodePreview`（monaco-editor@0.57.0 精确锁版，`lib/preview/monaco-loader.ts` 唯一
  seam 动态加载、editor.api/vs 独立 chunk 首屏不加载；行定位高亮 3s 淡出、DiffEditor 首块聚焦、
  批注模式选行/Shift 连选/overlay/确认回传）；`HtmlPreview`（iframe `sandbox="allow-scripts"` 无
  allow-same-origin、srcDoc 注入随机令牌、postMessage 经 event.source+token 双校验）；
  `MarkdownPreview`（`MarkdownContent annotate` 通道注入 `data-sourcepos`（预览零开销）、选区→
  源文 offset 并集映射，复用 `group-messages`/`tool-call-state` 之外的 `lib/preview/markdown-sourcepos`）。
  三者「确认回传」产物为 `AnnotationBatch`（`lib/preview/types.ts`），经 `annotations-to-part.ts`
  转文本片段进 prompt-composer。
- **实况跟随**：`hooks/useLiveFileTracking.ts` 复用 `groupMessages` + `mergeToolCallMessages` 合并口径
  （禁止另写解析）；edit/diff→pinned tab + `computeDiff` 首 added 行聚焦、read→共享预览 tab；
  `toolCallId+内容指纹` 去重；仅跟踪开启后到达的调用。**开启分栏默认开启**：挂载偏好为分屏时默认开；
  之后每次点击分栏入口（左右/上下，含互切与重选当前模式）都默认开启实况跟随（覆盖 Review 深链
  临时分屏、手动关闭后再选），切回 chat 关闭；Review 深链临时分屏本身不开实况（临时分屏回退 chat
  时同步关闭）。
- **Review**：`ReviewPanel`（左目录树+批注计数徽标 / 右扩展名分流组件只读+批注、`sessionFileContent`
  懒加载三态——加载中骨架 / **失败态 `review-file-error` + 重试 `review-file-retry`**（`useSessionFileContent`
  统一收敛，空响应也按失败处理，禁止无限骨架）/ 通过/驳回/仅评论提交、成功只读化结论徽标、失败 toast 可重试）；标签四态色
  （PENDING 黄/APPROVED 绿/REJECTED 红/COMMENTED·CANCELLED 灰）；侧边栏 `components/sidebar/ReviewSection.tsx`
  （待 Review 默认展开 / 已 Review 默认折叠、空分区不渲染、点击深链 `?review=`）；
  用户级 SSE `session_review_*` 经 `useUserEventStream.onSessionReview` 触发 HOME_OVERVIEW refetch。
- **InputBox 片段化**：`onSend(parts: PromptPart[])`（裁决 6）；片段区（文本首行摘要 ≤80 字 +
  来源徽标 / 图片缩略 / 逐行删除）；粘贴与文件选择加图片（单图 5MB、合计 10MB，超限 toast）；
  发送组装 `[...parts, ...(trim(input) ? [textPart] : [])]`；草稿 `session_input_parts_{id}`
  （>2MB 不持久化）；`prompt.image` 能力门控（隐藏图片入口、发送时降级 `[图片 name]`）。
  `MessageItem` 读 `metadata.parts` 渲染图片缩略（点击放大）。
- 契约查询集中于 `graphql/preview.ts`（GET_SESSION_FILE_CONTENT/GET_SESSION_REVIEW/SUBMIT_SESSION_REVIEW），
  `SEND_SESSION_MESSAGE` 带 `$parts`。

## 日志

- `src/lib/logger.ts` 是全包**唯一 console 出口**：业务代码一律 `logger.debug/info/warn/error(objOrMsg, msg?)`（签名与后端 pino 一致，变量进对象字段、错误进 `err` 字段），禁止直接调用 `console.*`（`vite.config.ts` 的构建期提示为登记例外）。
- **DEV 或 `VITE_LOG_LEVEL` 门控**：仅当 `import.meta.env.DEV` 或显式设置 `VITE_LOG_LEVEL`（`debug|info|warn|error`，非法值回落 `info`；DEV 缺省 `debug`）时输出；**生产默认静默**（不设置 `VITE_LOG_LEVEL` 即零输出）。
- 前端日志为开发期排障输出，不适用后端契约的字段要求（见 [`contracts/observability.md`](../../contracts/observability.md) §1）；禁止在前端日志中打印 token/密码等敏感值。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)

## 云容器优化二期（默认工作区 / 模型上下文 / 临时存储）

- **创建期不再预置 `/home/worker/workspace`**：「新建云电脑」**没有**「创建默认工作区」勾选项；默认工作区只在「Git 项目设置」初始化 Github 项目时由服务端按 `targetPath` 创建（`hasDefaultWorkspace` 反映 `workspaceId != null`）。
- 无默认工作区且该控制器尚无任何工作区（`CloudHost.hasDefaultWorkspace === false && controllerWorkspaces.length === 0`）时 Sidebar 展示 `未创建默认工作区，请先创建或绑定工作区`，并提供 Github 项目设置与新建工作区入口；用户添加/绑定工作区后该提示消失。有默认工作区且单 Harness 无会话时才保留「默认会话创建失败」提示。
- Git 项目设置前缀在有默认工作区时预填 `defaultWorkspace`，无默认工作区时预填 `~/workspace`（判定收口在 `hooks/useGithubProjectForm.ts` 的 `hasDefaultWorkspace === true` 分支；`~` 展开为 `/home/worker`，与服务端同源）。

## 多租户二期（工作区切换器 / 管理页 / 来源徽标）

> 纯前端上下文与展示收敛；服务端为权限权威（契约见 `contracts/workspace.graphql`）。计划见 `docs/engineering/plan/20261028-feat-multi-tenant-phase2.md` Phase 8。

- **状态与持久化**：`stores/workspace.ts` 保存当前工作区 + `myWorkspaces`/`myTenants`（含角色）。选择写入 `localStorage['zag:current-workspace:<userId>']`（按 userId 隔离），刷新/重登恢复；缺省=个人租户全局工作区。
- **失效回退**：`hooks/useWorkspaceContextSync.ts` 在 `myWorkspaces` 刷新后校验当前/持久化工作区；不在可见集（被移出团队/工作区已删除）时回退个人全局、清理持久化并 `resetStore()`，避免持续 `workspace not found`。**上下文查询每 15s 轮询 + 窗口 focus/visibility 时立即刷新**（与首页 `HOME_OVERVIEW` 同节奏）：团队管理员新建工作区/把成员加入工作区后，已登录用户无需整页刷新即可在切换器看到并进入；持久化工作区已不可达（请求直接返回 `workspace not found`）时清空选择并重新拉取，避免 header 永久指向失效工作区导致所有请求失败。
- **上下文注入**：`lib/apollo.ts` 的 `workspaceLink` 注入 `x-workspace-id`（`stores/workspace.ts#getCurrentWorkspaceId`）；无选择时不发头 → 服务端回退个人全局（与一期等价）。
- **切换器**：`components/WorkspaceSwitcher.tsx` 挂在 `Sidebar` 顶部，按租户分组、按角色过滤；未加入任何 team（仅个人租户）不渲染；切换后 `client.resetStore()` 重拉 `HOME_OVERVIEW` 等活跃查询。管理入口：`/workspaces`（team admin）与 `/tenants/:tenantId/members`（本租户 admin）。
- **工作区管理页**：`pages/WorkspacePage.tsx` 仅 admin 可操作（developer 展示无权限提示、无入口）；列表展示名称/类型/成员数；创建/改名/删除（`workspace is not empty` 映射「工作区非空，无法删除」）/成员添加移除；全局工作区无改名/删除/成员入口；personal 租户无管理入口。
- **租户成员管理页**：`pages/TenantMembersPage.tsx` 仅本租户 admin；成员列表（展示名/用户名/角色）、`searchAccounts` 搜索添加并指定角色、变更角色、移除；`last admin cannot be removed/demoted` 映射「至少保留一名管理员」提示；personal 租户无入口。
- **共享资源来源与只读收敛**：`lib/workspace-source.ts` + `hooks/useResourceSource.ts` 判定本工作区/全局工作区/其他工作区；供应商/模型/GitHub 绑定展示 `ResourceSourceBadge`。普通上下文的全局工作区资源隐藏编辑/删除；全局工作区 + developer（`Workspace.readOnly`）整体只读（隐藏添加/编辑/解绑入口；成员级 Git 提交人设置不受影响）。旧数据未携带 `workspaceId` 时保持升级前行为（无徽标、可编辑）。
- **Git 区块**：提交人设置为成员级（键 `userId`），无 `source`/`readOnly` 口径，只读工作区不影响保存。
- **测试入口**：`stores/__tests__/workspace.test.tsx`、`components/__tests__/WorkspaceSwitcher.test.tsx`、`pages/__tests__/WorkspacePage.test.tsx`、`pages/__tests__/TenantMembersPage.test.tsx`、`lib/__tests__/workspace-source.test.ts`、`components/settings/__tests__/ProviderSection.readonly.test.tsx`。

## 工作流迭代（实例改名 / 卡片展示 / 图表自动定位）

> 纯前端展示层 + 一处新 mutation 调用；计划见 `docs/engineering/plan/20261103-feat-workflow-iteration.md`。

- **详情页改名入口**：`pages/WorkflowInstancePage.tsx` 标题 `h1` 后为「重命名」图标按钮（`aria-label="重命名实例"`），打开 `Dialog` 并预填当前名称；输入框 `aria-label="实例名称"`，前端校验 trim 后 1~64（提示「名称不能为空」/「名称最多 64 个字符」，非法时禁用「保存」），服务端文案（`invalid workflow name` 等）原样展示且对话框保持打开；成功 `toast.success('实例名称已更新')` 并关闭。mutation `RENAME_WORKFLOW_INSTANCE`（`graphql/workflow.ts`）返回 `{id,name}` 由 Apollo 按 id 归一化，标题/侧边栏随 `GET_WORKFLOW_INSTANCE`（5s）/`HOME_OVERVIEW`（15s）轮询兜底刷新。
- **卡片动态行**：`graph/WorkflowNodeCard.tsx` 的进行中动态行按 `useNodeSessionActivity` 的 `activity.kind` 展示——`thinking`（含尚无活动的默认态）→ spinner + 「思考中...」、`tool_call` → 「执行中: {工具标题}」、`text` → 「Concluding...」；不渲染思考/输出正文。工具调用的 `activity.text` 只保留标题（`useNodeSessionActivity` 复用 `toolCallTitle`，禁止另写一套标题逻辑）。
- **token 文案口径**：完成态为 `已完成 · ${tokenUsage} tokens`（**不含「消耗」**），容器 `title="该数值为会话当前上下文长度"`；无用量仅「已完成」。
- **Handle（勿删）**：卡片顶部 `Handle type="target" position={Position.Top}`、底部 `type="source" position={Position.Bottom}`，视觉透明（`!size-1 !bg-transparent !border-0`）+ `isConnectable={false}` + `pointer-events-none`。**缺 Handle 时 React Flow 无法解析连接点，依赖连线不渲染**（E2E-UI4G4 守卫）；`pointer-events-none` 保证卡片点击/人类节点操作不被拦截。组件测试需用 `ReactFlowProvider` 包裹。
- **卡片不透明**：`WorkflowNodeTreeConstants.NODE_STATUS_VISUAL[*].tint` 七态统一 `bg-card`（无透明度后缀），状态语义只由 `spine`/`badge` 承载；`NODE_STATUS_COLOR_VAR` 不变。仅图表卡片消费 tint，列表视图零影响。
- **详情抽屉排序**：`NodeDetailDrawer` 中「关联 Pull Request」区块在「产物」之前（其余结构不变）。
- **图表自动定位**：`graph/graph-layout.ts` 的纯函数 `pickFocusWindow(nodes, activeIds, before=2, after=2)` 按 `position.y` 升序（同 y 按 x）定位**第一个**执行中节点，返回「前 2 + 自身 + 后 2」id 窗口（越界收敛，无执行中返回 `[]`）。`WorkflowGraphView` 用 `onInit` 保存 React Flow 实例并置 `rfReady`，effect **仅依赖 `[rfReady, activeKey]`**（执行中 id 集合拼接；节点列表经 ref 读取），首次 `duration:0`、切换 `duration:300`；无执行中节点不主动 `fitView`（保留整图首屏）。**禁止把 `nodes`/`instance` 加入该 effect 依赖**：5s 轮询每轮重建节点对象，会导致反复 fitView 抖动。
- **测试入口**：`pages/__tests__/WorkflowInstancePage.test.tsx`（T-RNWEB1~4）、`components/workflow/graph/__tests__/WorkflowNodeCard.test.tsx`（T-WFI-NC1~3）、`components/workflow/__tests__/WorkflowNodeTreeConstants.test.ts`（T-WFI-TC1）、`components/workflow/__tests__/NodeDetailDrawer.test.tsx`（T-WFI-SH1）、`components/workflow/graph/__tests__/graph-layout.test.ts`（T-WFI1~5）、`components/workflow/__tests__/WorkflowGraphView.test.tsx`（T-WFI-V1~4，mock React Flow 断言窗口 fitView 与防抖动）、`tests/e2e/src/workflow-graph.spec.ts`（E2E-WFI1~3）。

## 已实例化工作流接续（#513）

> 契约 `contracts/workflow.graphql`；计划 `docs/engineering/plan/20261114-feat-workflow-instance-continuation.md`。

- **数据**：`WorkflowInstanceSummaryData/WorkflowInstanceData` 新增 `unavailableReason: 'CONTROLLER_OFFLINE' | 'CONTROLLER_DELETED' | null`（`GET_WORKFLOW_INSTANCES`、`GET_WORKFLOW_INSTANCE`、`HOME_WORKFLOW_INSTANCE_FIELDS` 均选择）；详情追加 `continuationHistory`（`from/toControllerId`、`from/toWorkspaceId`、`at`）。新增 `CONTINUE_WORKFLOW_INSTANCE` mutation 与 `ContinueWorkflowInstanceInput`/`NodeHarnessMappingInput` 类型。
- **列表入口（NavLink 嵌套禁令）**：`WorkflowInstanceCard` 仍是纯 `NavLink`；`unavailableReason` 非空时追加 destructive 徽标（`data-testid="workflow-instance-unavailable"`，离线/已删除两态文案）与**行内兄弟节点**「接续」图标按钮（`aria-label="接续工作流"`，`preventDefault()+stopPropagation()` → `navigate('/workflows/:id?continue=1')`），不得把按钮嵌进 NavLink。
- **详情页**：顶部 `data-testid="workflow-unavailable-notice"` 提示条（`role="alert"`，两态文案 + 「已完成节点与产物保留；接续后可选择新控制器与工作路径继续流转」+「原控制器上的残留 Worktree 平台不做远程清理，请自行处理」）与「接续」按钮；`?continue=1` 深链自动打开 `ContinueWorkflowDialog`，关闭时 `setSearchParams(..., {replace:true})` 清参。不可用时向 `WorkflowNodeTree`/`WorkflowGraphView`/`NodeDetailDrawer` 下发 `unavailable`：人类节点完成/打回（`HumanNodeActions disabled`）与「重启节点」置灰并提示「实例不可用，请先接续」；归档/删除/改名/查看保持可用。
- **接续对话框 `ContinueWorkflowDialog`**（四段）：新控制器（`GET_CONTROLLERS` 客户端过滤 `status==='online'`）→ 工作路径（`GET_WORKSPACES` 过滤 `controllerId+isEnabled`；「浏览目录新建…」复用 `AddWorkspaceDialog` + `CREATE_WORKSPACE` 后选中）→ 创建新 Worktree（默认勾选；`DETECT_GIT_REPO` 非 Git 时置灰并展示未勾选 + 提示「目标路径不是 Git 仓库，将不创建 Worktree 继续接续」）→ 逐节点 Harness 映射（列出全部未完成 AI 节点 `type==='AI' && status!=='DONE'`，原 Harness 在 `GET_ACP_CAPABILITIES` 可用清单内默认选中，否则留空并提示「原 Harness 不可用，请改选」）。
- **提交门控**：未选控制器/工作区、任一未完成 AI 节点未选 Harness → 禁用「确认接续」；非 Git 工作区**不阻断接续**：勾选框置灰且展示未勾选，提交时强制 `createWorkflowWorktree:false`（与实例化先例同口径）；提交中 spinner；成功 `toast.success('工作流已接续到新控制器')` + `refetchQueries:[GET_WORKFLOW_INSTANCE, HOME_OVERVIEW]`；服务层错误文案原样展示且对话框保持打开。切换控制器时重置工作路径与 Harness 覆盖值。
- **轮询口径**：不可用标识随详情 5s 轮询与首页聚合 15s 轮询自然出现/消失（控制器恢复在线即消失），不新增订阅。
- **测试入口**：`components/workflow/__tests__/WorkflowInstanceCard.test.tsx`（T-WEB1）、`components/workflow/__tests__/ContinueWorkflowDialog.test.tsx`（T-WEB2~4）、`pages/__tests__/WorkflowInstancePage.test.tsx`（T-WEB5）。

## 会话归档与只读（会话管理优化）

> 契约：`contracts/agent-session.graphql`（`Session.archived` / `SessionReadOnlyReason` / `archiveSession` / `workspaceArchiveImpact`）、`contracts/home.graphql`（`HomeOverview.archivedSessions`）。实现计划见 `docs/engineering/plan/20261104-feat-session-management-optimization.md` Phase 6~8。

- **归档入口**：`SessionHeader` 按钮组在「导出对话」之后渲染「归档/取消归档」图标按钮（lucide `Archive`/`ArchiveRestore`，对齐工作流实例页形态，`archiving` 期间禁用）；`onArchiveToggle` 不传即不渲染——`SessionView` 对工作流节点会话（`workflowInstanceId` 非空）不传该回调（服务端同样拒绝 `ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED`）。已归档会话在状态徽标旁展示「已归档」徽标（`data-testid="session-archived-badge"`），入口切换为「取消归档」。
- **归档接线**：`SessionView` 调 `ARCHIVE_SESSION`，归档成功 toast「会话已归档」并经 `onDeleted` 回调返回列表（`SessionPage` 传 `navigate('/sessions')`，对齐工作流实例归档后导航）；取消归档 toast「已取消归档」并 `refetchQueries: [GET_SESSION, HOME_OVERVIEW]` 就地生效（徽标与侧边栏同批刷新）。错误原样 toast，不吞错。
- **侧边栏已归档分组**：`Sidebar` 会话分区列表尾部的 `ArchivedSessionGroup` 复刻 `ArchivedWorkflowGroup` 自折叠交互（默认折叠、`Archive` 图标、「已归档（N）」、`aria-expanded`），数据源 `HOME_OVERVIEW.archivedSessions`（为空不渲染）；条目与活跃条目共用 `SessionListEntry`（状态点 + 标题 + 所属工作区，点击直达 `/sessions/{id}`），归档分组列表带 `data-testid="sidebar-archived-session-list"`。**活跃列表不含已归档由服务端保证**（D12：`GET_SESSIONS`/`HOME_OVERVIEW.sessions` 不加归档参数消费，活跃过滤走服务端默认口径）。
- **只读收敛（`readOnlyReason`）**：`SessionView` 只读判定唯一来源为 `GET_SESSION.readOnlyReason != null`，**替代旧 `readOnlyCloudHost` 计算**（`controllerType/cloudHost` 查询字段保留兼容，不再参与判定）。提示条按原因三态文案：`WORKSPACE_MISSING`「工作区已不存在，会话记录仅供只读回看。」/ `CONTROLLER_MISSING`「控制器已不存在，会话记录仅供只读回看。」/ `CLOUD_HOST_DESTROYED`「云电脑已销毁，会话记录仅供只读回看。」；统一 `data-testid="session-readonly-notice"`（附 `data-readonly-reason`），云电脑场景额外嵌套 `data-testid="cloud-host-readonly-notice"` 承载文案，保持 E2E 回归（D10）。只读时隐藏 `InputBox`，`SessionHeader`「继续」由统一 `readOnly` 门控隐藏；归档/取消归档/删除/导出对只读会话仍可用。
- **工作区删除确认（含连带数量）**：`WorkspaceSection` 单删点击「删除」先经 `WORKSPACE_ARCHIVE_IMPACT` 取数：N>0 弹确认框「删除工作区将同时归档其下 N 个会话，是否继续？」（确认才调 `deleteWorkspace`，取消不调用），N=0 与取数失败保持现状直接删除（D9，取数失败不阻断）；「清空」沿用既有内联确认面板并追加「将同时归档其下 N 个会话」合计——确认面板打开时按工作区渲染 `WorkspaceArchiveImpactProbe` 探针逐个取数求和，任一失败降级为不展示数量（确认本身不阻断）。
- **测试入口**：`components/session/SessionHeader.test.tsx`（T-WEB1 归档入口渲染/回调/徽标）、`components/session/__tests__/SessionView.archive.test.tsx`（T-WEB1 归档 mutation、归档后导航、取消归档就地、节点会话不渲染）、`components/session/__tests__/SessionView.readonly.test.tsx`（T-WEB3 三态文案与入口隐藏）、`components/__tests__/Sidebar.test.tsx`（T-WEB2 已归档分组折叠/计数/可打开/活跃列表不含已归档）、`components/settings/__tests__/WorkspaceSection.test.tsx`（T-WEB4 删除与清空确认数量）。

## 云存储归档优化（停止归档勾选 / 归档 / 复原到归档 / fork）

> 需求 #434；契约 `contracts/cloud-host.graphql`、`contracts/cloud-storage.graphql`。

- **停止对话框**：`cloudHostStopImpact.storage` 非空时渲染勾选项（`aria-label="归档云存储"`，默认勾选）与说明「勾选：归档后按半价计费；不勾选：存储回到待挂载并继续全价计费，数据原样保留」。**挂载存储时不自动停止**（`activeSessionCount===0 && !impact.storage` 才自动 `handleStop(false)`）；提交 `stopCloudHost(id, force, archiveStorage)`；`storage.status !== 'ATTACHED'` 时勾选禁用并提示「存储尚未挂载完成，停止后按原状态回滚（不归档）」且不下发该字段；未挂载存储不渲染、报文旧形状。
- **状态文案**：`RESTORING → 复原中`；`canArchiveStorage`（IDLE）、`canRestoreStorage`（IDLE+SUCCEEDED；RESTORING+FAILED 仅「重试」）、`canForkStorage`（IDLE/ARCHIVED+SUCCEEDED）、`hasFailedRestore`、`canDestroyCloudStorage` 含 `RESTORING+FAILED`（警示 `RESTORE_FAILED_DESTROY_WARNING`）。
- **列表/详情三操作**：`CloudStorageSection` 行操作与 `CloudStorageDetailDialog` 操作区按上述门槛展示「归档 / 复原到归档（失败时重试复原）/ fork」；归档与复原复用 `ConfirmDialog`（复原为 destructive 文案 `RESTORE_DESTRUCTIVE_WARNING`），成功后 `refetchAll`/`refetch`。归档卡片 `cloudHostName == null` 展示「手动归档」；详情展示 `currentRestore` 状态/失败原因。
- **ForkCloudStorageDialog**：名称输入（trim 1~64，服务端权威重名）、容量只读「与源一致：x Gi」、`cloudStorageBillingQuote(source.sizeGi)` 全价报价、「创建成功即开始计费」；成功 toast 并刷新列表。
- **文案映射**：`storage is not archivable / has no archive / is not restorable / is restoring / is not forkable / not allowed to restore storage` 等映射中文。
- **测试入口**：`components/cloud-host/__tests__/StopCloudHostDialog.test.tsx`（T-WEB1）、`lib/__tests__/cloud-storage.test.ts`（T-WEB2/T-WEB4）。

## 云电脑「工作流」区块（#469 项目模板持久化）

- **入口与区块**：`ControllerConfigPage` 仅 `controller.type==='cloud'` 时渲染 `config-tab-workflow`（移动端 + 桌面端双份）；
  `RepoWorkflowSection` 工作区下拉默认匹配 `cloudHost.defaultWorkspace`，经 `REPO_WORKFLOW_TEMPLATES` 扫描
  `.zag/workflow/templates/*.json`（`cache-and-network` + 「重新检测」refetch）。合法项展示名称/文件名/节点数 + 「配置」；
  不合法项灰色并展示 `errors[0]`；空态「未检测到项目工作流模板」。
- **状态提示**：云电脑非 RUNNING/已删除 →「云电脑运行中才可检测与配置」；控制器版本 `<2.18.0`（`lib/repo-workflow.ts`
  `isRepoTemplateScanSupported`，仅展示用）→「升级云电脑工作组件后可检测项目模板」。
- **配置弹窗**：`ConfigureRepoWorkflowDialog` 复用 `WorkflowGraphEditor` + `template-validation`，以扫描模板 `nodes` 预填
  （`templateNodeToEditable`，agentConfig 待选），名称默认模板名/文件名；提交 `CONFIGURE_REPO_WORKFLOW`
  `{workspaceId, fileName, name, nodes}`，`controllerId` 由云电脑上下文固定。
- **已配置列表**：`RepoWorkflowSection` 以 `GET_CONFIGURED_WORKFLOWS` 过滤 `sourceKind==='REPO'`，展示 `sourceRepoPath`，
  删除复用 `DELETE_CONFIGURED_WORKFLOW`；设置页 `WorkflowSection` 与 `InstantiateWorkflowDialog` 对 REPO 条目追加「项目模板」徽标。
- **检测提示接线**：`WorkspaceSection` 新增可选 `onWorkspaceCreated`（仅云电脑配置页传入，普通主机/设置页零行为变化）；
  `GithubProjectSetupDialog` 透传 `onFinished`，成功终态后 refetch `GET_CONTROLLER_WORKSPACES` 并按
  `path === cloudHost.defaultWorkspace` 定位工作区。两处均仅在「存在合法模板」时弹 `RepoWorkflowPromptDialog`；
  `stores/repo-workflow-prompt.ts` 模块级 `Set<workspaceId>` 保证同页面会话不再自动弹（取消/去配置均记入）。

## 自定义工具 / FragmentEditor（设置页，#449）

> 需求 #449；契约 `contracts/custom-tool.graphql` + `contracts/fragment-template.md`。

- **区块**：`components/settings/CustomToolSection.tsx`（`#custom-tool-section`，标题 + 「工作区」badge）——
  `GET_CUSTOM_TOOLS`（`cache-and-network`）+ 增删改 `refetchQueries`；空态「暂无自定义工具」、
  删除 `ConfirmDialog` 二次确认、`useWorkspaceAccess().readOnly` 收敛新增/编辑/删除入口
  （服务端插件为权威）。NAV「MCP」组追加「自定义工具」项（紧随「自定义 MCP」）。
- **对话框**：`components/settings/CustomToolDialog.tsx` —— 名称/描述/类型；`ArgsListEditor` 双类型复用；
  prompt → 提示文案 + 多行 FragmentEditor（Generic）；http → method（datalist 常用 + 自定义）/
  endpoint（单行 Uri）/ insecure / body（GET 类隐藏、切到 POST 类默认 JSON；text|json|form）/
  headers / queries（勾选展开按行编辑）。每处 FragmentEditor **独立受控 value**（禁止共享 store）。
- **FragmentEditor**：`components/common/fragment-editor/FragmentEditor.tsx` —— contentEditable + 原子 chip
  （`contentEditable=false`、`data-fragment-type` 区分 Valut/Parameter、Json/Uri 角标）；`$`/`#` 补全
  （`$` 仅已声明 params、`#` 仅 `GET_VALUT_MANUAL_OPTIONS` manual 名单）、IME 门控、单行拦截 Enter/粘贴换行、
  退格整体删除 chip。**不求值红线**：任何状态不请求/不展示密钥值。
- **纯函数层**：`lib/fragment-editor.ts`（`fragmentsToNodes`/`nodesToFragments`，相邻 Plain 合并、空 Plain 省略，
  与后端 `fragment-render` fixture 互锁）；`lib/custom-tool.ts`（契约错误文案中文映射、参数/header/query
  校验、暴露名 `ct-<id8>` 规则）；`graphql/custom-tool.ts` 域文件承载查询/变更与手写类型。
- **测试入口**：`lib/__tests__/fragment-editor.test.ts`（T-FE1）、
  `components/common/fragment-editor/__tests__/FragmentEditor.test.tsx`（T-FE2/T-FE3）、
  `components/common/args-list-editor/__tests__/ArgsListEditor.test.tsx`（T-ALE）、
  `components/settings/__tests__/CustomToolSection.test.tsx`（T-CTW1）、
  `components/settings/__tests__/CustomToolDialog.test.tsx`（T-CTW2）。

## 第三方登录入口与回调（#503 / #510）

- **登录页**：查询 `authProviders`（`fetchPolicy: cache-and-network`，失败静默降级为仅密码登录），按返回渲染「使用 {displayName} 登录」（GitHub 恒「使用 GitHub 登录」）；点击跳 `oauthAuthorizeUrl(id,'front')`。`?error=<code>` 经 `lib/auth-oauth.ts#mapOauthError` 映射友好文案，未识别 code 原样兜底。
- **回调页**：公开路由 `/login/callback`（`LoginCallbackPage`）。读 `ticket` → `exchangeLoginTicket` → `useAuth.login` → 首页；挂载后立即 `replaceState` 清除 URL。ticket 一次性，失败只提示「登录票据无效或已过期」，不循环重试；`error` 参数直接映射文案。
- **身份选择页（#510）**：公开路由 `/login/identity-choice`（`IdentityChoicePage`）。读 `pending` 并立即清除 URL；`pendingExternalLoginInfo`（免登录、不消费票据）展示登录方式与外部帐号名；「绑定已有帐号」提交 `bindExternalLoginWithPassword`（失败可重试，文案经 `mapIdentityChoiceError`：`Invalid username or password` 原样，「过期」引导回登录页），「创建新帐号」提交 `provisionExternalLogin`；成功 `useAuth.login` 进首页。查询返回 null → 显示「登录状态已过期，请重新登录」。
- **设置页「第三方登录绑定」**：`#account-section` 内挂载 `ExternalLoginBindingSection`（`GET_MY_EXTERNAL_LOGINS` + `GET_AUTH_PROVIDERS`）：列表展示登录方式/外部帐号名/绑定时间/最近登录时间，停用 provider 展示「已停用」；未绑定 provider 提供「绑定」→ `createFrontBindTicket(providerId)` → `oauthAuthorizeUrl(id,'front-bind',ticket)`；解绑复用 `UnbindConfirmDialog`（可传 title/description）→ `unbindExternalLogin`。无任何 provider 且无绑定时区块不渲染。
- **回跳结果**：`SettingsPage` 识别 `/settings?bind=success`（提示「第三方登录绑定成功」）与 `?bind=error&error=<code>`（`mapOauthError` 映射），处理后 `replaceState` 仅删除 `bind`/`error`，保留其它参数（如 `section=valut`）。
- **错误映射单一来源**：`lib/auth-oauth.ts` 的 `mapOauthError`（302 错误码；`already_bound` 前台文案「该身份已被其他账户绑定」+ `provider_already_bound`）与 `mapIdentityChoiceError`（GraphQL mutation message）。admin-web 有独立映射文件，不受影响。
- **测试**：`pages/LoginPage.test.tsx`、`pages/__tests__/LoginCallbackPage.test.tsx`、`pages/__tests__/IdentityChoicePage.test.tsx`（T-OBO-WEB）、`components/settings/__tests__/ExternalLoginBindingSection.test.tsx`、`pages/__tests__/SettingsPage.test.tsx`（`?bind` 处理）、`lib/__tests__/auth-oauth.test.ts`；E2E 见 `tests/e2e/src/auth-oidc-binding.spec.ts`。`App.tsx` 新增公开路由 `/login/identity-choice`。

## 工作流节点会话行为配置（#525）

> 契约 `contracts/workflow.graphql` 的 `WorkflowNodeSessionBehavior` 与节点 4 字段；计划 `docs/engineering/plan/20261115-feat-workflow-reject-rework-session-behavior.md` Phase 7。

- **组件单一来源**：`components/workflow/WorkflowGraphEditor.tsx` 导出 `SessionBehaviorFields`（同 `AgentConfigFields` 复用模式）——「会话行为」区含「返工时」「打回后」两组单选（新会话 / 原始会话）；各自选「原始会话」才展示对应「压缩原始上下文」勾选，切到「新会话」时隐藏并将该勾选重置为 `false`。仅 `type === 'AI'` 渲染，HUMAN/FLAG 返回 `null`。
- **三入口自然覆盖**：`WorkflowGraphEditor` 的节点项对 AI 节点统一渲染该区，因此模板编辑器（`TemplateEditorDialog`）、已配置编辑器（`ConfigureWorkflowDialog` / `ConfigureRepoWorkflowDialog`）与实例化对话框（`InstantiateWorkflowDialog`）无需各自接线；`EditInstanceNodeDialog` 编辑模式同样渲染（读实例节点快照经 `normalizeSessionBehavior` 归一），**重启模式不渲染**（重启仅编辑 agentConfig）。
- **类型与默认值**：`template-validation.ts` 的 `EditableNode extends SessionBehaviorForm`——`reworkSessionBehavior`（默认 `ORIGINAL_SESSION`）、`reworkCompactOriginalContext`（默认 `false`）、`resumeSessionBehavior`（默认 `NEW_SESSION`）、`resumeCompactOriginalContext`（默认 `false`），即服务端存量现状。`createEmptyNode` 写入同一默认值；`templateNodeToEditable` / `configuredNodeToEditable` 经 `normalizeSessionBehavior` 以 `??` 归一（新会话时 compact 恒 `false`）。
- **提交口径**：`toNodeInput` / `toConfiguredNodeInput` 仅 AI 节点携带 4 字段（经 `sessionBehaviorInput`，行为为 `NEW_SESSION` 时对应 compact 恒 `false`），HUMAN/FLAG **省略整组键**（保持旧报文形状）；`EditInstanceNodeDialog` 的 `UPDATE_WORKFLOW_NODE` 同口径。
- **校验**：「压缩原始上下文」仅在对应会话行为为「原始会话」时合法；`validateTemplateNodes`（`validateConfiguredNodes` 复用）给出中文前置错误「…为「新会话」时不可开启「压缩原始上下文」（仅原始会话可压缩）」。
- **查询选择集**：`TEMPLATE_NODE_FIELDS`、`CONFIGURED_NODE_FIELDS` 与 `GET_WORKFLOW_INSTANCE.nodes` 均追加 4 字段（`REPO_WORKFLOW_TEMPLATES` 复用模板 fragment）。
- **测试入口**：`components/workflow/__tests__/SessionBehaviorFields.test.tsx`（T-SB-WEB1~2）、`components/workflow/__tests__/template-validation.test.ts`（T-SB-WEB3）、`components/workflow/__tests__/EditInstanceNodeDialog.test.tsx`（T-SB-WEB4）、`graphql/__tests__/workflow.test.ts`（选择集守卫）。

## 工作流节点「立即失败」

> 契约 `contracts/workflow.graphql` 的 `failNode` 与 `WorkflowNodeFailInfo.source=MANUAL`；计划
> `docs/engineering/plan/20261116-feat-workflow-node-manual-fail.md` Phase 3。

- **按钮可见性**：`NodeDetailDrawer` 在「重启节点」旁新增 destructive「立即失败」按钮，可见性独立收窄——
  仅 `node.type === 'AI' && (status === 'RUNNING' || status === 'REWORK')`（与 `canRestart` 互不影响）；
  `unavailable=true` 时禁用并提示「实例不可用，请先接续」（与重启入口同口径）。
- **交互与 mutation**：`hooks/useFailNodeAction.ts` 承载二次确认与提交——点击打开 `ConfirmDialog`
  （文案含「中断会话 / 取消全部自动重试 / 阻断工作流」三项后果，确认按钮 destructive 文案「确认失败」）；
  取消零副作用；确认调 `FAIL_WORKFLOW_NODE`（`{instanceId, nodeId}`，不传 reason 走服务端缺省
  「人工标记失败」）。成功 `toast.success('节点已标记失败')`，失败文案原样 toast；**不本地伪造节点状态**
  （5s 轮询收敛徽标与来源行），不额外 refetch。
- **失败来源展示**：`WorkflowNodeTreeConstants.failSourceText` 六来源映射（`SESSION_STUCK→会话停滞` /
  `LLM_REPORTED→AI 主动标记` / `SESSION_START_FAILED→会话启动失败` / `RETRY_EXHAUSTED→中断重试用尽` /
  `CONTROLLER_UNAVAILABLE→控制器不可用` / `MANUAL→人工标记`，未知值原样返回）；FAILED/RETRY_FAILED
  失败信息块在原因行下新增「失败来源：…」（`data-testid="drawer-fail-source"`，对全部来源生效）。
- **重试进度**：`failNode` 清空 `nextRetryAt` 后 `retryProgressText` 自然返回 null，进度行随轮询消失（前端零额外逻辑）。
- **测试入口**：`components/workflow/__tests__/NodeDetailDrawer.test.tsx`（T-MNF-W1~W3）、
  `components/workflow/__tests__/WorkflowNodeTreeConstants.test.ts`（T-MNF-W3 映射）。

## 设置页模型下发提醒与上下文编辑（#533）

> 契约 `contracts/llm.graphql`；计划 `docs/engineering/plan/20261117-feat-cloud-host-model-config-sync.md` Phase 7。

- **统一提醒**：`src/lib/model-config-notice.ts` 是文案单一来源
  `MODEL_CONFIG_APPLIED_NOTICE`（「已保存并下发到运行中的云电脑；部分 Harness 运行时不会重载模型配置，
  已运行的会话可能需要重启后生效」）+ `notifyModelConfigApplied()`（`toast.success`）。
  **会触发下发的用户侧保存类操作**成功后统一调用：自定义模型新增/上下文编辑、启停、删除、排序，供应商创建/更新；
  供应商 toggle/delete/batch 保持静默（后台同理，无提醒）。
- **上下文展示/编辑**：`GET_MODELS` 选含 `contextLength`；`ModelItem` 行内展示「最长上下文：N tokens / 未设置」
  （`data-testid="model-context-length"`）；仅 `scope==='user' && !readOnly` 显示 PencilLine「编辑上下文」入口；
  编辑复用 `CustomModelDialog` 编辑模式（供应商/名称只读，仅上下文可改/清空）→ `UPDATE_MODEL_CONTEXT_LENGTH` →
  `refetchQueries: [GET_MODELS]`。
- **新增模型**：`CREATE_CUSTOM_MODEL` 携带 `contextLength`（数字或 null）；「最长上下文大小（token）」输入
  `inputMode="numeric"`、正整数校验（文案与 admin-web 逐字一致）、留空 = 未设置；选定供应商并输入模型名后
  400ms 去抖调 `PROVIDER_MODEL_OPTIONS` 按同名项预填（失败静默；用户已手改不覆盖；服务端不缓存清单）。
## 云电脑工作组件版本区块（需求 #551）

> 契约 `contracts/cloud-host.graphql`（`CloudHostAgentGearVersion` / `upgradeCloudHostAgentGear`）。

- **选择集单点扩展**：`CLOUD_HOST_FIELDS`（`graphql/queries.ts`）追加 `agentGearVersion { currentVersion latestVersion upgradeAvailable autoUpdateIntervalMinutes }`，`GET_CONTROLLERS` / `CLOUD_HOST` / `MY_CLOUD_HOSTS` 共用；手写类型 `CloudHostData.agentGearVersion?` 同步。
- **版本区块**：`ControllerConfigPage` 的 `CloudHostPanel` 内 `data-testid="cloud-host-agent-gear-version"`——`当前版本 {currentVersion ?? '—'}` / `最新版本 {latestVersion ?? '—'}`，「立即升级」按钮仅在 `upgradeAvailable && status==='RUNNING' && !deletedAt` 时渲染；小字 `自动升级每 {autoUpdateIntervalMinutes ?? 10} 分钟检查一次`（`text-xs text-muted-foreground`）。
- **升级流程（D14）**：点击 → `UPGRADE_CLOUD_HOST_AGENT_GEAR({ controllerId })` → 升级中态（按钮禁用 + spinner）→ 每 **2s** `CLOUD_HOST`（`fetchPolicy: network-only`）轮询 → `currentVersion === latestVersion` toast「工作组件已升级到 {version}」，**3 分钟**超时 toast 可重试/等待自动升级；组件卸载清理定时器不残留；成功后 `refetch` 控制器列表刷新版本信息。
- **错误文案单一来源**：`lib/cloud-host-agent-gear.ts` 的 `CLOUD_HOST_AGENT_GEAR_ERROR_MESSAGES`（契约六条 + `internal error` 兜底，未命中原样展示）；`isAgentGearUpgradeAvailable` 为按钮可见性纯函数。测试入口：`lib/__tests__/cloud-host-agent-gear.test.ts`（T-UPG-W-L）与 `pages/__tests__/ControllerConfigPage.test.tsx`（T-UPG-W1~W5）。
