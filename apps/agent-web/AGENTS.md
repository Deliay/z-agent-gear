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
- `ElicitationDialog` 按 `resolution` / 已过期的 `expiresAt` 展示「已过期/已取消/已失效/已提交/已拒绝」并隐藏操作；到期用定时器就地重渲染（`now = Date.now()`，不得用 `useState` 快照冻结）。
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
- **新建表单**：名称 trim 后 1~64；Harness 多选且至少 1 个（一期仅 `OPENCODE`）；选 1 个提示「就绪后不会自动创建会话，需先创建或绑定工作区」，多选提示「不自动创建会话」；**不提供「创建默认工作区」勾选**（创建期不预置 `/home/worker/workspace`）；不提供存储/会话导入参数。**预装工作负载（可选）**来自 `cloudHostWorkloadCatalog`（无主机上下文，`installed` 恒 false）：列表展示名称 + `预制` 徽标 + 依赖名称，最多勾选 5 个；勾选任意项提示「勾选运行环境负载会延长首次就绪时间」；**未勾选时不传 `workloadIds`**（保持旧报文形状）；catalog 查询失败展示「负载列表加载失败，可仅创建基础云电脑」且不阻断提交。**Github 项目（可选）**区块复用 `hooks/useGithubProjectForm.ts`（账号/仓库/前缀/最终地址预览）；勾选后提交走 `hooks/useCloudHostProvisioning.ts` 编排：`createCloudHost(createDefaultSession:false)` → `GithubSetupProgressDialog` 轮询 `cloudHost(id)` 至 RUNNING → `setupCloudHostGithubProject(createSession = harnessTypes.length === 1)`；未选项目时请求体不含 `createDefaultSession`（与旧报文一致）。服务端错误文案原样展示（`name is required` / `name is too long` / `harness feature is disabled` / `at least one harness type is required` / `unsupported harness type: x`）；`insufficient balance` 映射为「账户余额不足，请联系管理员充值后重试」，`github account is locked` 映射为「云电脑已绑定其他 Github 帐号，不可修改」；`too many workloads (max 5)` / `invalid workload` / `workload is not installable` / 依赖缺失或成环映射为对应中文提示。
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
- **工作负载设置区**：云电脑配置页「工作负载」页签列出标准负载（预制/已安装徽标、参数表单 TEXT/SELECT/MULTI_SELECT/BOOLEAN 默认值），按 `workloadKind` 分组（standard 组标题「运行环境 / 工具」，harness 组「云电脑」，空组不渲染），每项展示依赖名称（依赖 ID 映射同列表名称，缺失回退 ID）；仅 RUNNING 可安装，已安装项禁用且**无卸载入口**；安装复用同一进度对话框（单步）。
- **测试入口**：`components/__tests__/Sidebar.test.tsx`、`pages/__tests__/ControllerConfigPage.test.tsx`、`components/cloud-host/__tests__/*`（含 `GithubProjectSetupDialog` / `GithubSetupProgressDialog` / `CloudHostWorkloadsSection`）、`components/session/NewSessionDialog.test.tsx`、`components/session/__tests__/SessionView.cloudHost.test.tsx`、`graphql/__tests__/home.test.ts`（覆盖 T-AW1..15 与 T-AW-G1..G14 关键项）。

## Commit 设置区块（设置页）

- 挂载：`pages/SettingsPage.tsx` 的 `#github-section` 内，紧接 `<GithubBindingSection />` 下方
  渲染 `<CommitSettingsSection />`；标题「Commit 设置」+ 常驻提示「设置只对云容器环境生效」。
- 数据：`GET_COMMIT_SETTINGS` / `UPDATE_COMMIT_SETTINGS` + `GET_GITHUB_ACCOUNTS`
  （帐号下拉；`GitHubAccount` 即 OAuth 用户身份，org 不会出现），类型手写于 `graphql/types.ts`。
- 交互：提交人模式（仅Agent / Co-Author / 仅人类 / 未设置）与提交人（Github帐号 / 自定义 / 未设置）
  两个单选组；`GITHUB_ACCOUNT` 条件渲染帐号下拉，`CUSTOM` 渲染用户名 + 邮箱输入；
  无绑定帐号提示「请先绑定 Github 帐号」并禁用保存；已选帐号被解绑提示重新选择。
- 校验：Co-Author / 仅人类 + 提交人未设置 → 「请先设置提交人」并禁用保存；自定义校验与服务端同源
  （trim 非空、≤100/≤254、禁换行/NUL、邮箱正则）；前端拦截不替代服务端权威校验。
- 错误映射（逐字）：`committer is required for the selected mode` →「请先设置提交人」；
  `invalid github account` →「Github 帐号无效，请重新选择」；
  `invalid custom committer` →「提交人用户名或邮箱格式不正确」。
- 保存成功 toast「对云容器环境生效，已运行的云电脑稍后自动更新」；加载分支用 `loading && !data`，
  后台刷新不覆盖用户编辑（dirty 保护）。
- 缓存：`GET_COMMIT_SETTINGS` 用 `fetchPolicy: 'cache-and-network'`，保存 mutation 带
  `refetchQueries: [GET_COMMIT_SETTINGS]`（`CommitSettings` 无 `id`，Apollo 无法归一化 mutation 结果），
  保证保存后离开设置页再返回不回显旧值；回归见 `CommitSettingsSection.cache.test.tsx`。
- 测试：`components/settings/__tests__/CommitSettingsSection.test.tsx`。

## 多租户一期（注册硬关闭与展示名）

- **前台注册已硬关闭**：注册页与注册路由、注册 mutation 均已在页面/路由/契约三层移除；开户仅由后台经 agent-api `POST /internal/users` 发起。登录页不提供任何注册入口。
- **登录响应形态**（`contracts/auth.graphql`）：`AuthPayload.user = User{ id, name, tenant }`，`Tenant{ id, name, type, memberCount }`。`stores/auth.ts` 的 `User` 类型以 `name` 作为展示名（`tenant` 可选，兼容升级前 localStorage 旧登录态）。
- **展示名消费点**：`Sidebar` 的 prop 为 `name`（`MainLayout` 传 `user?.name`）、`SettingsPage` 个人资料展示 `user?.name`；不再读写 `user.username`。登录表单的 `username` 输入只是登录凭据字段，与展示名无关。
- **计费**：`MyBillingAccountData.ownerType` 联合类型包含 `tenant`（`front_user` 仅历史兼容，`admin_user` 保持不变）；前端不展示 ownerType 文案，数值口径零改动。

## 会话渲染层（对话渲染重构一期）

> 纯前端渲染层，不改 ACP 协议、消息存储与后端契约。实现计划见 `docs/engineering/plan/20261028-refactor-conversation-rendering.md`。

- **工具调用视图模型合并**（`components/session/tool-call-state.ts`）：同一 `toolCallId` 的全部消息经 `mergeToolCallMessages` 合并为 `MergedToolCall`，三态语义——字段未携带（`undefined`）保留原值、显式 `null` 清除、有值替换。`MessageList` 在分组 memo 后统一合并，`ToolCallCard`/`ReadCard`/`FetchCard`/`SubAgentCard` 只消费合并结果（props 为 `toolCall`，不再接收 `messages[]`）；标题口径为合并后 `title ?? kindLabel(kind)`，保证「工具完成后标题/类型/参数不丢失」（禁止再退化为 `Tool Call: other`）。`group-messages.ts` 分组逻辑保持不变。
- **Markdown 管线**（`components/session/markdown/`）：代码块统一由 `MarkdownContent` 的 `pre` 覆写承接——`language-mermaid` 分流 `MermaidBlock`，其余（含无语言）走 `CodeBlock`（语言标签 + 复制 + 换行切换）；`code` 覆写仅保留行内代码样式。Mermaid 必须 `import('mermaid')` 动态导入（securityLevel=strict，失败回退 CodeBlock），不得改为静态引入。
- **差异与终端**：`lib/diff.ts` 先归一化换行（CRLF/CR→LF）再按纯行文本 `diffArrays` 输出带新旧行号的行序列（>2000 行截断提示，输入超限先裁剪）；`DiffView` 双行号列 + `lib/language-from-path.ts` 语言推断 + Prism 逐行高亮。`lib/ansi.ts` 仅保留 SGR（final byte `m`，ansi-to-html + escapeXML），冒号子参数归一化为分号；其余 CSI（光标移动/清屏/`?25l`/`?2004h` 等私有模式）、OSC（含 OSC-8 超链接）、DCS/APC/PM、8-bit C1、字符集切换序列全部剥离，未终结序列只裁到行尾不吞后续输出；`TerminalOutput` 经 `dangerouslySetInnerHTML` 注入已转义 HTML，空行由 `whitespace-pre-wrap` 自然保留。
- **工具卡片体系**：`tool-call-icons.tsx` 提供 `ToolKindIcon`（未识别类型回退 Hammer）；`AcpCard` 新增 `pending` 弱化样式（legacy 颜色键保留）；`ToolCallRawSection` 提供 rawInput/rawOutput 折叠（JSON，>500 行截断）；`ContentBlockRenderer` 覆盖 text/image/audio/resource_link/resource 以及 diff/terminal，未知类型降级提示不空白。
- **消息操作与导出**：`MessageActions` 在 agent 文本消息 hover 操作条提供「复制 Markdown」（与展示同源的合成文本）与「复制纯文本」（经 `lib/markdown-plain-text.ts` 从源 Markdown 去标记，不含代码块语言标签/Mermaid 工具栏等 UI chrome；非文本消息不挂操作条）；`SessionHeader` 的「导出对话」先经 `collectFullHistory` 按 `before` 游标拉全历史（>25 条也不会截断），再由 `lib/export-thread.ts` 生成 Markdown（用户/助手/思考/工具分节，流式分片按 messageId 合并，工具经合并口径并含 content 结果摘要）并 Blob 下载，文件名 `session-{id}-{date}.md`。
- **滚动跟随**：`MessageList` 以滚动事件的同步几何距离为主判定是否贴底，IntersectionObserver（threshold 0.9）为辅（内容增长期间的 IO 瞬时离底不丢失跟随）；append 仅在贴底时 `auto` 滚底，否则保持视口并显示「回到底部」+ 新消息圆点；初始加载/程序化滚动期间抑制自动 load-more，prepend 位置恢复用单一 `scrollStateRef` 所有权，SSE 整组替换不残留 prepend 状态。组件测试通过 `vitest.setup.ts` 的可控 IntersectionObserver stub 驱动（`(globalThis as any).__triggerIntersection(bool)`）。
- **计划展示**：`PlanCard`/`PlanFloatingCard` 摘要三态（全部完成 / x/y / N 项任务）由 `plan-summary.ts` 统一，完成条目内容 `line-through`。
- **测试入口**：`components/session/__tests__/`（tool-call-state / ToolCallCard / ToolCards / ContentBlockRenderer / MessageActions / ScrollToBottomButton / PlanCard / DiffView / AcpCard）、`components/session/markdown/__tests__/`、`src/lib/__tests__/`（diff/ansi/language-from-path/export-thread）、`tests/e2e/src/session-rendering.spec.ts`（E2E-CREN1~8）。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)

## 云容器优化二期（默认工作区 / 模型上下文 / 临时存储）

- **创建期不再预置 `/home/worker/workspace`**：「新建云电脑」**没有**「创建默认工作区」勾选项；默认工作区只在「Git 项目设置」初始化 Github 项目时由服务端按 `targetPath` 创建（`hasDefaultWorkspace` 反映 `workspaceId != null`）。
- 无默认工作区且该控制器尚无任何工作区（`CloudHost.hasDefaultWorkspace === false && controllerWorkspaces.length === 0`）时 Sidebar 展示 `未创建默认工作区，请先创建或绑定工作区`，并提供 Github 项目设置与新建工作区入口；用户添加/绑定工作区后该提示消失。有默认工作区且单 Harness 无会话时才保留「默认会话创建失败」提示。
- Git 项目设置前缀在有默认工作区时预填 `defaultWorkspace`，无默认工作区时预填 `~/workspace`（判定收口在 `hooks/useGithubProjectForm.ts` 的 `hasDefaultWorkspace === true` 分支；`~` 展开为 `/home/worker`，与服务端同源）。
