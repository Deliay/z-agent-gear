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
- 会话内挂载 `PendingElicitationBanner`：消费首页聚合的 `todos`，筛选本会话未 resolved 的问询，保证移动端（Sidebar 未挂载）也能打开 `ElicitationDialog`。
- `ElicitationDialog` 按 `resolution` / 已过期的 `expiresAt` 展示「已过期/已取消/已失效/已提交/已拒绝」并隐藏操作；到期用定时器就地重渲染（`now = Date.now()`，不得用 `useState` 快照冻结）。
- `ElicitationDialog` 多选字段识别顺序为 `items.oneOf → items.anyOf → items.enum`，统一渲染勾选组（`role="group"`，选项说明为副行）；**仅** `type: 'array'` + `items.anyOf`（ACP question 工具多选题）在提交前经 `lib/elicitation-multi-select.ts#joinMultiSelectValues` 以逗号拼接为字符串回传（顺序 = 勾选顺序，空数组保持 `[]`），`items.enum` / `items.oneOf` 数组字段仍提交数组；`anyOf` 与 `enum`/`oneOf` 并存的字段（真实 question 报文不会产生）不参与拼接、提交保持数组；勾选状态始终以数组存于 edits（必答校验/草稿不变），`q*_custom` 仍为文本框。
- 问询弹窗打开权由 `stores/elicitationDialog.ts` 共享（`todoId + owner + 打开时快照`）：`PendingElicitationBanner`（owner=banner）与 `TodoListPanel`（owner=todo）互斥，同一时刻只渲染一个弹窗；弹窗数据按 todo id 从全量 todos 派生（不过滤 resolution），pending 清空后仍保留到终态展示，避免填表中被卸载；todo 被 TTL/limit 从列表移除时用快照渲染「已从待办移除」终态
  （stale 判定与 owner 无关，banner/todo 任一持有 stale 都不阻塞后续 immediate）；`close(owner)` 只允许持有方关闭；
  **真实卸载**时 cleanup 经微任务确认（排除 StrictMode 的 mount→cleanup→mount 模拟卸载）后关闭 `owner='todo'` 弹窗，
  切会话时 banner 侧同样清理自己持有的状态；表单草稿按 requestId 缓存（上限 50），owner 切换重挂载不丢已填内容。

## 新建会话与「+」列表刷新

- **工作区/工作流列表实时刷新**：`NewSessionDialog` 的 `GET_CONTROLLER_WORKSPACES_ENABLED`、`InstantiateWorkflowDialog` 的来源查询、`WorkflowSection` 的来源列表统一 `cache-and-network` + 打开/挂载 `refetch()`；加载分支只认 `loading && !data`，刷新期间不卸载表单、不清空输入，失败展示「刷新失败，可重试」并保留旧列表。
- **默认 MCP 预选**：按 `controller.defaultMcp` 在「打开 / 切换控制器」时计算一次（`useAllEnabled=false` 取 `serverIds` 与已启用集合交集，否则全部已启用）；用户调整后后台轮询不得覆盖。提交时**显式传数组**：`[]` = 不注入，`undefined` 才走服务端默认。
- **默认 MCP 设置**：控制器配置页「默认 MCP」页签（`McpDefaultSection`）保存 `SET_CONTROLLER_DEFAULT_MCP`；`MCP_SERVER_NOT_FOUND` 映射为「所选 MCP 已停用或不存在，请重新选择」，成功后提示「对后续新建会话生效」。移动端 tab 常驻滚动容器外。
- **模式/模型前置选择**：选定 ACP 工具后读 `acpServerOptions`（与工作流节点同源），下拉首项「默认」= 不传 `modeId/modelId`；「刷新」调 `refreshAcpServerOptions` 后就地替换选项，探测中/无选项不阻断提交。`onCreate` 为 9 个位置参数（`controllerId, acpServerType, workspaceId, enableWorktree?, worktreeBranchSuffix?, mcpServerIds?, existingWorktreePath?, modeId?, modelId?`），三个调用点 `Sidebar`、`SessionPage`、`WorktreeSidebarGroup` 必须同步透传全部参数（`WorktreeSidebarGroup` 的 `existingWorktreePath` 回退预选路径）；每个调用点保留映射单测，防止位置参数演进漏改。

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
  勾选后 Worktree 提交以成员为主作者、平台 bot 为共同作者（见 agent-api / agent-controller 段）。
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

- **侧边栏四分区**：`Sidebar` 顶层为「主机」「工作流」「会话」「网关」四个全宽折叠分区；默认展开工作流/会话、折叠主机/网关，展开态持久化在 `localStorage['sidebar-sections-expanded']`（`lib/sidebar-prefs.ts`）。工作流/会话/网关跨环境聚合（工作流含「已归档（N）」自折叠分组）；网关仅聚合**在线主机**的网关配置行（离线主机不渲染，与既有「UI 层按 status 自行隐藏该区块」口径一致）；主机分区保留「主机 → 工作区 → 会话」树与设置按钮；条目排序 `updatedAt` 倒序 + id tie-break，防轮询跳动。
- **空态收敛**：`TreeSection` 不再渲染 `emptyMessage` 占位文字（入参保留兼容），无内容时仅保留可展开空容器；层级缩进按 `level * 0.5rem`（≈2 空格）。
- **拖拽调宽**：`SidebarResizer` 4px 热区（pointer capture），clamp 15–28rem、默认 20rem，`pointerup` 写入 `localStorage['sidebar-width']`，双击恢复默认；`MainLayout` 桌面 grid 列使用 `var(--sidebar-width,20rem)`，移动端不渲染 Resizer（`lib/sidebar-width.ts` 为宽度口径单一来源）。
- **工作流卡片**：侧边栏条目不显示控制器名，第一行「名称 + 状态徽标」、第二行工作区；控制器名与执行中节点名走 tooltip（`WorkflowInstanceCard`）。
- **图表视图**：`graph-layout.ts` 以 dagre `rankdir:'TB'`（nodesep 40 / ranksep 70）布局，节点宽 280px、高度分档估算（120–220px）；连线 `strokeWidth:2` + `MarkerType.ArrowClosed`；画布 `h-full min-h-[480px]`，由 `WorkflowInstancePage` 视图区行填充；图表模式隐藏右栏 `BlackboardPanel`/`WorkflowContextPanel`（列表视图零变化）。
- **节点卡片**：`graph/WorkflowNodeCard.tsx` 自定义节点（状态色左脊 + 名称 + 类型/返工徽标 + Harness/模型 + 进行中动态行 + 完成态 token + PR/检查项徽标 + 资源小卡片 + 人类节点就地操作）；交互元素统一 `nodrag` + `stopPropagation`。
- **实时动态**：`hooks/useNodeSessionActivity.ts` 复用 `useSessionStream`（不自行创建 EventSource），复用 `group-messages.parseSessionUpdate` 与 `tool-call-state` 的 `mergeToolCallMessages`/`toolCallHeaderTitle` 口径；思考/文本结尾截断常量 `LIVE_ACTIVITY_TAIL_CHARS = 40`；进行中节点建立实时连接，转为 DONE 后关闭连接并保留已捕获的最后动态与用量；**首屏即为 DONE 的 AI 节点**以快照模式短连一次，收到 SSE history（含最后一条 `usage_update`）后立即断开，用于补全刷新后的 token 展示（不长期占用连接）。
- **资源上图**：`buildResourceOwnership` 纯函数负责归属——黑板 key 前缀 `{nodeId}-{nodeName}-产物-`（与列表视图 `lib/artifact-owners.ts` 同源）、PR 按 `nodeId`、追加提示词仅「恰好一个 RUNNING/REWORK 节点」时归属该节点，否则与无法解析的黑板条目一并进入画布顶部实例资源行；垃圾桶永不渲染；同节点最多 3 个可见小卡片 + 「+N」；小卡片限宽 12rem、标题最多 2 行（`line-clamp-2`）截断。
- **状态语义色单一来源**：`WorkflowNodeTreeConstants` 的 `NODE_STATUS_VISUAL`（`{spine, tint, badge}`）为唯一来源，`NODE_STATUS_BADGE` 重导出 `badge` 段保持兼容；REJECT 为静态琥珀、REWORK 为琥珀 + `animate-pulse`、FAILED 走 destructive；图表/列表/卡片/MiniMap 全部消费该映射或对应 `NODE_STATUS_COLOR_VAR`，禁止新增固定 hex 色值。
- **详情抽屉**：`components/ui/sheet.tsx`（Base UI 原语自实现，右侧滑出/全高/遮罩/Esc 关闭）+ `NodeDetailDrawer`（节点/资源两形态）；`WorkflowInstancePage` 提升抽屉状态，图表与列表视图共用；列表视图 `WorkflowNodeTree` 节点头部提供「详情」入口。
- **共享人类节点操作**：`hooks/useHumanNodeActions.ts` + `HumanNodeActions` 组件，列表/卡片/抽屉三处同源（草稿键 `workflow-node-draft:{instanceId}:{nodeId}`）。
- **测试入口**：`components/__tests__/Sidebar.test.tsx`（T-UI4-SEC/AGG）、`SidebarResizer.test.tsx`（T-UI4-RES）、`tree/__tests__/TreeSection.test.tsx`（T-UI4-TREE）、`workflow/__tests__/WorkflowInstanceCard.test.tsx`（T-UI4-IC）、`workflow/__tests__/WorkflowNodeTreeConstants.test.ts`（T-UI4-TC）、`workflow/graph/__tests__/*`（T-UI4-GL/NC/RC）、`workflow/__tests__/NodeDetailDrawer.test.tsx`（T-UI4-SH）、`hooks/useNodeSessionActivity.test.tsx`（T-UI4-NA）、`hooks/useHumanNodeActions.test.tsx`（T-UI4-HA）、`tests/e2e/src/sidebar-phase4.spec.ts`（E2E-UI4S1~S6）与 `tests/e2e/src/workflow-graph.spec.ts`（E2E-UI4G1~G10）。

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
- **失效回退**：`hooks/useWorkspaceContextSync.ts` 在 `myWorkspaces` 刷新后校验当前/持久化工作区；不在可见集（被移出团队/工作区已删除）时回退个人全局、清理持久化并 `resetStore()`，避免持续 `workspace not found`。
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
