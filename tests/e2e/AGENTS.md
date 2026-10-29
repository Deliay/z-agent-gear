# E2E Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed

## 测试步骤

> **注意**: 只允许使用 Aspire 编排服务，禁止直接使用 Docker 命令。

### 1. 启动服务

```bash
# 启动 Aspire 编排并等待服务就绪（在项目根目录）
aspire start && aspire wait agent-api && aspire wait agent-web
```

### 2. 获取 Endpoint

```bash
# 查看 agent-web 的地址
aspire describe agent-web
```

输出中查找 `agent-web` 的 `http` URL，例如 `http://localhost:35273`。

### 3. 填入环境变量并执行测试

```bash
# 查看各服务 endpoint
aspire describe agent-web
aspire describe agent-api
aspire describe controller-api
```

从输出中查找各服务的 `http://localhost:<port>` URL，例如:
- `agent-web`: `http://localhost:35615`
- `agent-api`: `http://localhost:10001`
- `controller-api`: `http://localhost:35273`

填入实际端口后执行：

```bash
BASE_URL=http://localhost:35615 \
ADMIN_API_URL=http://localhost:10003/graphql \
ADMIN_WEB_URL=http://localhost:<admin-web-port> \
API_URL=http://localhost:10001/graphql \
CONTROLLER_API_URL=http://localhost:35273 \
npx playwright test
```

> admin 套件（`admin-*.spec.ts`）需要 admin-web 与 admin-api：`aspire start && aspire wait admin-web admin-api agent-api`。

### 4. 重新运行测试

如果需要重新运行测试，必须从**步骤 1** 开始，重新运行 Aspire 实例。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BASE_URL` | 前端应用地址 | `http://localhost:35273` |
| `ADMIN_WEB_URL` | admin-web 地址（admin 套件使用） | 回落到 `BASE_URL` |
| `API_URL` | agent-api GraphQL 地址 | `http://localhost:10001/graphql` |
| `ADMIN_API_URL` | admin-api GraphQL 地址 | `http://localhost:10003/graphql` |
| `MONGODB_URI` | 共享 MongoDB 连接串（T-E1 真实首登强制改密需据此重置种子管理员；缺省时该用例跳过） | -（可 `aspire describe mongodb` 获取） |
| `ADMIN_INITIAL_PASSWORD` | admin-api 种子管理员初始密码。**无默认值**（问题 4/47）。E2E 通过 `MONGODB_URI` 直接改写 Mongo 口令哈希，故通常无需设置；如需固定值排查可注入 | -（`MONGODB_URI` 提供时自动重置） |
| `INTERNAL_API_TOKEN` | agent-api 内部 Bearer token（前台账号开户 `POST /internal/users`、`E2E-1` 驱动 cloud host ready 回调；**缺省时开户回落 admin-api `adminCreateFrontUser`，E2E-1 显式 skip**） | -（与 Aspire 注入的 `internal-api-token` 一致） |
| `CONTROLLER_API_URL` | controller-api Socket.IO 地址 | `http://localhost:35273` |
| `EVENT_CALLBACK_TOKEN` | 工作流 PR 联动事件回调凭据（E2E-27~32 / E2E-CR*；缺失时该组用例跳过） | - |
| `GITHUB_API_BASE` | Check Runs 同步展示用例（E2E-CR*）不依赖出站调用；出站行为由 `tests/api` mock GitHub 覆盖 | - |
| `GITHUB_WEBHOOK_SECRET` | 事件回调 HMAC 验签密钥（可选，API 套件 HMAC 用例使用） | - |
| `CLOUD_CONTROLLER_URL` | cloud-controller 地址（admin-cloud-container 套件相关断言） | `http://localhost:10004` |

> 所有套件共享同一套服务与 Mongo：admin 套件会轮换共享管理员（admin）口令、清理全局供应商，因此**必须在 `playwright.config.ts` 中强制 `workers: 1`、`fullyParallel: false` 串行执行**（已写死，勿覆盖为并发），否则用例互相污染：

```bash
ADMIN_WEB_URL=<admin-web> ADMIN_API_URL=<admin-api>/graphql MONGODB_URI=<mongo-uri> \
  npx playwright test admin-*.spec.ts --workers=1
```

> 注意: 所有端口由 Aspire 动态分配，请在 `aspire describe` 输出中查看实际端口。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 测试清单

### Auth E2E (`auth.spec.ts`)

> 前台注册已硬关闭（无 `/register` 路由、登录页无注册入口、auth 契约删除 signup）：测试造用户统一经
> `helpers.createFrontUser`（`POST /internal/users`，需 `INTERNAL_API_TOKEN`；未注入时回落 admin-api
> `adminCreateFrontUser`，需 `MONGODB_URI` 归一化管理员口令）+ `login`。

| 测试 | 描述 |
|------|------|
| 登录页无注册入口 | 登录页无「注册」链接/按钮，也无「没有账号？去注册」文案（E2E-MT1） |
| `/register` 直达不可用 | 直达 `/register` 不渲染注册表单，重定向登录页或 404（E2E-MT1） |
| 登录后展示布局 | 正确凭证登录 → 2-column 布局，「我的费用」入口可见 |
| 侧边栏显示展示名 | 登录后侧边栏底部显示 `user.name`（迁移后=原用户名） |
| login/me 暴露 name + tenant | `me` 返回 `name` 与 personal 租户（`tenant.id == userId`、`memberCount=1`） |
| 错误密码提示 | 错误密码 → 显示错误信息 |
| 设置页导航 | 点击设置按钮 → 设置页显示退出登录按钮 |
| 设置页布局 | 设置页 2-column 布局，显示用户名 |
| 退出登录 | 点击退出登录 → 跳转回登录页 |
| 未登录重定向 | 直接访问 `/` → 重定向到登录页 |

### Admin Tenant E2E (`admin-tenant.spec.ts`)

> 需要 admin-web / admin-api / agent-api 就绪（`aspire start && aspire wait admin-web admin-api agent-api`）；
> 后台不做多租户设计：租户页只读，开户是唯一写操作（转发 `POST /internal/users`）。

| 测试 | 描述 |
|------|------|
| E2E-MT5 租户只读 | 租户列表/详情可见（新开户租户与成员用户名），无编辑/删除/停用/新建租户按钮；introspection 无租户写 mutation（仅 `adminCreateFrontUser`） |
| E2E-MT2 开户闭环 | 后台「租户管理」开户（用户名 + 初始密码）→ 租户列表可见同名租户 → 新账户前台登录 → 侧边栏展示名 |
| E2E-MT3 租户口径计费 | 后台按租户（ownerType=tenant）检索计费账户 → `rechargeBillingAccount` 充值 → 前台「我的费用」可用余额与账单明细可见 |
| E2E-MT4 双用户隔离（最小锚定） | A 创建 controller key 后 B 的 `controllerKeys` 为空（会话/工作区的完整隔离链路由 `tests/api` T-MT2 覆盖） |

### 多租户二期工作区 E2E (`workspace.spec.ts` E2E-WS)

> 数据经 admin-api `adminCreateTeamTenant` / `adminAddTenantMember` + agent-api GraphQL（`createTenantWorkspace`）
> 准备；需要 admin-web/admin-api/agent-api/agent-web 与 `INTERNAL_API_TOKEN`（或 `MONGODB_URI` 回落开户）。
> 每个用例使用独立 team 租户与全新用户，互不污染。

| 测试 | 描述 |
|------|------|
| E2E-WS1 切换器按角色过滤 | admin 见团队全部工作区（global+normal）并出现「工作区管理/租户成员」入口；developer 仅见团队全局、无管理入口（切到 global 后仍无） |
| E2E-WS2 选择持久化 | 选择普通工作区 → `localStorage['zag:current-workspace:<userId>']` 写入；刷新后切换器恢复该选择 |
| E2E-WS3 工作区管理仅 admin | admin 在 `/workspaces` 可新建工作区并即时出现在列表；developer 直达该页显示「仅租户管理员可访问工作区管理（开发角色无入口）」且无新建按钮 |
| E2E-WS4 租户成员管理 | admin 在 `/tenants/:id/members` 搜索帐号并添加（默认开发）→ 尝试移除唯一管理员提示「至少保留一名管理员」→ 变更角色为管理员；developer 直达显示无权限提示 |
| E2E-WS5 个人用户零感知 | 仅个人租户用户登录后无 `workspace-switcher`、无工作区管理入口 |
| E2E-WS6 developer 全局只读 | developer 选择团队全局工作区后，设置页 `workspace-context-banner` 展示「全局工作区 / 只读」与「编辑入口已隐藏」，Commit 设置提示不可修改 |
| E2E-WS2b 改名 / 非空删除 / 成员 | 工作区行「改名」→ 重命名后列表即时更新；「成员」弹窗添加 developer（列表出现 `@username`）→ 移除后消失；写入本工作区 Commit 设置后「删除」被拒并提示「工作区非空（仍持有资源），无法删除」，工作区保留 |
| E2E-WS3b 资源来源徽标 | 团队全局工作区创建的供应商在普通工作区设置页展示 `resource-source-badge`「全局工作区」；本工作区创建的供应商展示「本工作区」 |
| E2E-WS4b Commit 三态 | 普通工作区设置页 `commit-settings-source`：双未设置 →「未设置」；仅全局设置 →「继承自全局工作区」；本工作区设置 →「本工作区」 |

### 后台 team 租户 E2E (`admin-team-tenant.spec.ts` E2E-TT)

> 需要 admin-web / admin-api / agent-api / agent-web 就绪；开户 helper 依赖 `INTERNAL_API_TOKEN`（或 `MONGODB_URI` 回落）。

| 测试 | 描述 |
|------|------|
| E2E-TT1 创建 + 加成员 + 成员登录 | 后台「创建团队租户」→ 列表类型为团队 → 详情自动开通全局工作区（只读视图）→「添加成员」按登录名指定管理员 → 成员前台登录后切换器出现团队租户分组，切换团队全局后可见「工作区管理/租户成员」入口 |
| E2E-TT2 成员协作可见资源 | 后台 API 建 team + owner(admin)/member(developer) → owner 在团队全局创建普通工作区、把 member 加入并创建供应商（mock LLM 校验连通性）→ member 登录后切换器含该工作区，设置页可见 owner 创建的供应商且徽标「本工作区」 |
| E2E-TT3 团队计费口径 | 后台为 team 租户充值 10 credits → owner 在团队全局「我的费用」看到「可用余额 10.00」；切回个人工作区显示 0.00（个人余额不受团队扣费影响）。最小断言：真实创建云电脑扣费依赖 HARNESS_ENABLED，已由 tests/api T-B2 / cloud-host-charges / cloud-host-billing-quote 覆盖 |

### Settings Commit 作者 E2E (`settings-commit-author.spec.ts`)

> 仅前端交互与文案；`commitSettings` / `updateCommitSettings` / `githubAccounts` 经 `page.route` mock，
> 不依赖真实 GitHub 与云容器。容器内真实提交身份由 `agent-controller` 单测与人工验收覆盖。

| 测试 | 描述 |
|------|------|
| E2E-1 | 「GitHub 绑定」下方出现「Commit 设置」与常驻提示「设置只对云容器环境生效」；四模式 / 三提交人可切换并保存成功 toast |
| E2E-2 | Co-Author / 仅人类 + 提交人未设置 → 禁用保存并提示「请先设置提交人」；自定义空用户名 / 非法邮箱拦截 |
| E2E-3 | 提交人条件渲染：Github帐号下拉（org 不出现）、未绑定引导「请先绑定 Github 帐号」、自定义用户名 + 邮箱输入 |
| E2E-4 | 双未设置保存 / 刷新回显一致（未设置零回归） |

### Settings LLM E2E (`settings-llm.spec.ts`)

| 测试 | 描述 |
|------|------|
| 导航和 section 可见性 | 设置页显示模型设置导航和两个 section |
| 点击导航滚动到供应商 section | 点击「供应商设置」→ 滚动到供应商 section |
| 点击导航滚动到模型 section | 点击「可用模型」→ 滚动到模型 section |
| 供应商 section 含添加按钮和空状态 | 供应商设置 section 显示添加按钮和空状态文字 |
| 添加供应商对话框 | 点击添加供应商 → 弹出表单对话框 |
| 模型 section 含自定义按钮和空状态 | 模型 section 显示自定义按钮和空状态文字 |
| 系统内置分组 | 可用模型显示「系统内置」组（首位、默认折叠）；组内无后台供应商名、无删除/开关禁用但如实显示启用状态；用户供应商组可展开且自定义模型可删除（T-E28） |
| 自定义模型对话框 | 点击自定义模型 → 弹出表单对话框 |
| 表单校验 | 空表单保存按钮为禁用状态 |
| 关闭添加供应商对话框 | 点击取消 → 对话框关闭 |
| 关闭自定义模型对话框 | 点击取消 → 对话框关闭 |

### Settings Controller E2E (`settings-controller.spec.ts`)

| 测试 | 描述 |
|------|------|
| 后台开户用户并显示 controller section | 后台开户（无 signup）→ 登录 → 设置页显示 controller-section |
| 导航显示本地控制器管理 | 设置页导航显示「本地控制器」和「控制器管理」 |
| controller section 布局 | 显示「控制器管理」标题和「控制器」卡片 |
| controller section 空状态 | 显示「生成 Key」按钮和「暂无控制器」空状态文字 |
| controller 卡片空状态 | 显示「暂无控制器」空状态文字 |
| 生成 Key 并显示在列表 | 点击「生成 Key」→ 列表出现新 Key（等待连接 + local 标签） |
| 生成的 Key 显示复制按钮 | 生成 Key 后显示「复制」按钮 |
| 导航滚动到 controller section | 点击「控制器管理」→ 滚动到 controller section |

### Settings Controller Config Page E2E (`settings-controller-config.spec.ts`)

| 测试 | 描述 |
|------|------|
| 侧边栏齿轮跳转配置页 | 点击齿轮 → URL 包含 `?controllerId=` |
| 设置「配置」按钮跳转 | 点击「配置」→ URL 包含 `?controllerId=` |
| 配置页布局 | 显示返回按钮、控制器名称、工作区、Harness 导航 |
| 工作区/Harness 切换 | 点击「可用 Harness 工具」→ 显示刷新按钮；切回「工作区」→ 空状态 |
| Harness 工具列表（单 Server） | 显示 fake controller 返回的 opencode 能力（可用 + v1.0.0） |
| Harness 工具列表（多 Server） | 显示 opencode + github_copilot 两种能力 |
| 刷新按钮 | 点击刷新 → 按钮不 disabled |
| 返回设置页 | 点击 ← 返回 → URL 回到 `/settings`，controller-section 可见 |
| 齿轮不触发展开 | 点击齿轮导航到配置页，不展开侧边栏控制器节点 |

### Settings Workspace E2E (`settings-workspace.spec.ts`)

| 测试 | 描述 |
|------|------|
| 配置按钮可见 | 在线 controller 显示「配置」按钮 |
| 配置页工作区空状态 | 点击配置 → 配置页显示「暂无工作区」|
| 通过 API 添加工作区并显示 | GraphQL 创建工作区 → 配置页显示工作区路径 |
| 从配置页删除工作区 | 点击删除 → 工作区移除 |
| 清空所有工作区 | 点击清空 → 确认 → 全部移除 |
| New Session 对话框显示工作区 | 选择 controller → 显示工作区选项 |
| 侧边栏树状结构 | 创建 session 后侧边栏显示 controller → 工作区 → session |

### Session E2E (`session.spec.ts`)

| 测试 | 描述 |
|------|------|
| 空状态显示 | 会话列表页显示「暂无会话」空状态 |
| 无在线 controller | New Session dialog 显示「无在线控制器」 |
| 有在线 controller | 注册 controller → New Session dialog 显示在线 controller |
| 创建会话并跳转 | 选择 controller → 创建 → 跳转到会话详情页 |
| 会话详情页结构 | 显示会话状态、输入框、消息区域 |
| 状态未运行时禁用输入 | 会话状态非 running 时输入框禁用 |
| 显示状态 badge | 会话详情页显示状态 badge |
| 关闭会话 | 点击关闭 → 状态更新为已关闭 |
| 删除会话 | 点击删除 → 跳转回会话列表 |
| 未登录重定向 | 直接访问 `/sessions` → 重定向到登录页 |

### Settings History Session E2E (`settings-history-session.spec.ts`)

| 测试 | 描述 |
|------|------|
| 历史会话按钮可见且可用 | 在线 controller + 启用 workspace 显示「历史会话」按钮 |
| 列表展示和导入按钮 | 点击历史会话 → 显示 fake controller 返回的 2 个 session |
| 全选并导入成功 | 全选 → 导入 → 显示成功导入 2 个会话 |
| 空状态 | 无可用 session 时显示「没有未导入的历史会话」 |
| 历史会话 ACP Server 选择器 | 多 Server 可用时历史会话对话框显示 ACP Server 下拉框，默认 opencode |

### Session Mode Switch E2E (`session-mode-switch.spec.ts`)

| 测试 | 描述 |
|------|------|
| 模型 badge 可见性 | acp:start:result 含 currentModel → 紫色模型 badge |
| 非 idling 时 mode switcher 禁用 | running 状态时 mode switcher 可见但禁用 |
| idling 时 mode switcher 启用 | resume 到 idling 后 mode switcher 可用 |
| 对话框展示可用模式 | 点击 mode switcher → 对话框显示 modes |
| 选择模式并关闭 | 选择 → Confirm → acp:set-mode → 对话框关闭 |

### Session ACP Server 选择 E2E (`session-acp-server.spec.ts`)

| 测试 | 描述 |
|------|------|
| ACP Server 选择器 | 选择 controller 后出现 ACP Server 下拉框，包含全部 5 种类型 |
| GitHub Copilot badge | 选择 github_copilot 创建 session → 详情页显示「GitHub Copilot」徽章 |
| OpenCode badge | 默认 opencode 创建 session → 详情页显示「OpenCode」徽章 |
| Claude Code badge | 选择 claude_code 创建 session → 详情页显示「Claude Code」徽章 |
| Gemini CLI badge | 选择 gemini_cli 创建 session → 详情页显示「Gemini CLI」徽章 |
| Codex badge | 选择 codex 创建 session → 详情页显示「Codex」徽章 |

### Session Rendering E2E (`session-rendering.spec.ts`)

> fake controller 注入 ACP `SessionUpdate`（`socket.emit('acp:message')`），不依赖真实 Agent；串行执行。

| 测试 | 描述 |
|------|------|
| E2E-CREN1 代码块工具栏 | 注入围栏代码块 → 语言标签 + 复制成功 toast + 自动换行切换 |
| E2E-CREN2 Mermaid | 每条注入携带独立 `messageId` → 合法 mermaid 渲染 SVG；语法错误回退代码块且同页其余内容正常 |
| E2E-CREN3 差异渲染 | 注入 diff 工具内容 → 双行号列数值正确、插入行对齐不串位 |
| E2E-CREN4 终端 ANSI | 注入带颜色码输出 → 颜色 span 出现且文本可读 |
| E2E-CREN5 工具生命周期一致 | 创建（execute + title + rawInput）→ 稀疏完成更新后标题仍为命令名；负向断言「不出现 `Tool Call: Command` / 通用 `Tool Call`」可红，且可展开查看原始输入 |
| E2E-CREN6 滚动导航 | 长列表上翻后注入新消息 → `scrollTop` 保持原位 + 「回到底部」出现；点击后滚动到底并恢复自动跟随（再注入一条仍贴底） |
| E2E-CREN7 窄视口溢出 | 375px 下超长代码/差异 → `scrollWidth - clientWidth ≤ 1` |
| E2E-CREN8 导出 | 点击导出对话 → download 事件触发、文件名 `session-*.md` 且内容包含会话文本 |
| E2E-CREN9 长会话导出拉全历史 | 注入 30 条后重载（首帧仅 25 条）→ 导出文件包含全部 30 条，验证分页补历史 |

### Port Forward E2E (`port-forward.spec.ts`)

| 测试 | 描述 |
|------|------|
| 端口转发 section 可见性 | 在线 controller 展开后显示「端口转发」section |
| 空状态 | 展开端口转发列表显示「无端口转发」 |
| 新建对话框 | 点击「+」→ 弹出「新建端口转发」对话框 |
| 创建端口转发 | 输入端口号 → 创建 → 列表显示 :port + active 状态 |
| 端口重复 | 创建重复端口 → 显示错误信息 |
| 删除端口转发 | 点击「✕」→ 端口转发从列表移除 |
| 取消对话框 | 点击「取消」→ 对话框关闭 |
| 离线 controller | 离线 controller 不显示端口转发 section |

### Workflow E2E (`workflow.spec.ts`)

> 实用主义原则：实例准备用 GraphQL API 做 setup；Agent 行为（调 MCP 工具、结束会话）用 fake controller 捕获 socket 事件（acp:start/resume/stop/message）模拟；MCP 工具调用经 fake controller 主 WebSocket 走 relay 协议（`mcp:request` → `mcp:response`，按 requestId 匹配，参考 workflow.spec.ts 的 `callWorkflowTool`/`callAdminTool`）——MCP 传递重构一期后 agent-api 公网 `POST /mcp/*` 入口已下线；UI 只驱动关键路径。

| 测试 | 描述 |
|------|------|
| E2E-1 实例化 → 人类节点输入 → AI 节点拉起 | 侧边栏实例化对话框创建实例 → 实例页完成人类节点 → AI 节点状态推进为执行中；API 校验会话打标（workflowInstanceId/workflowNodeId）；侧边栏会话列表不可见工作流会话但实例入口可见 |
| E2E-2 AI 节点完成接力 | fake controller 用 acp:start 的 mcpEndpoint.token 调 completeCurrentNode → 下游会话收到 acp:start（首条消息提示词含上游产物）、上游会话收到 acp:stop 且状态 ended |
| E2E-3 打回 → 返工 → 复工 | rejectNode 打回 → UI 显示已打回/打回理由/返工中；原会话收到 acp:resume 且消息含打回原因；completeCurrentRework（resume 新 token）→ 下游 REJECT→RUNNING 并收到复工消息，旧产物入垃圾桶 |
| E2E-4 会话兜底 | closeSession 且节点未转移 → 会话被 resume 且收到兜底提示词；再次结束不再 resume（每节点仅 1 次） |
| E2E-5 实例视图 UI | 节点树按阶段分组、状态/类型 badge、黑板面板产物可见、点击「会话」打开侧面板（SessionView 渲染节点提示词） |
| E2E-6 设置页管理 UI | 工作流 section 可见；TemplateEditorDialog 创建模板；内置模板只读（查看对话框无保存按钮）；从内置模板「配置工作流」并显示「本配置复制自模板」文案；已配置工作流卡片显示「复制自模板 v1」 |
| P2-E2E-14 设置页已配置工作流图编辑 | 编辑已配置工作流完整节点图并保存；来源模板不变 |
| P2-E2E-15 从模板实例化 | 实例化对话框选「模板」来源 → 实例化前配置界面补齐 Agent 配置 → 确认实例化 |
| P2-E2E-16 从空白实例化 | 选「空白」来源 → 配置界面从零搭建节点图 → 确认实例化 |
| P2-E2E-17 实例视图编辑未开始节点 | 未开始节点展示「编辑」；保存生效；开始后编辑入口消失 |
| P2-E2E-18 AI 会话装配管理工具集 | AI 节点会话装配 agent-workflow-admin-tools；创建模板→配置→实例化全链路；删除人类资源被拒、AI 资源可删 |
| E2E-27 联动开关 → PR 关联 | 模板/实例勾选联动 → AI 节点提示词含 `## GitHub Pull Request 联动` → MCP relay 调 `linkPullRequest` → 实例页「关联 Pull Request」展示 PR 与所属节点 |
| E2E-28 approved 驱动 | 注入 approved 回调 → 人类「PR 审核」自动已完成 → 下游 AI 执行中，首条提示词含「Pull Request审核通过」+ comment/PR 地址；「追加提示词」展示 `github-pr-review` |
| E2E-29 rejected 驱动 | 注入 rejected 回调 → 人类「已打回」+ 上游「返工中」→ `acp:resume` 返工消息含「Pull Request审核被拒绝」与 inline comment 提示 |
| E2E-30 归档注销 | 归档实例 → 「关联 Pull Request」清空；再注入事件返回 `NO_HANDLER`/`INSTANCE_ARCHIVED`，人类节点状态不变 |
| E2E-31 零回归 | 未勾选联动 → AI 提示词无 PR 段；注入事件 → `NO_HANDLER` |
| E2E-32 实例页编辑开关 | 未开始 HUMAN 节点可编辑联动开关并落库；节点开始后编辑入口消失 |
| E2E-CR1 检查项展示 | 直写登记同步字段后：节点徽标区「检查项」外链（短 sha tooltip）+ 右栏最近同步/写入提交 |
| E2E-CR2 失败提示 | `lastSyncError` 在右栏红色副行展示，页面其它操作不受影响 |
| E2E-CR3 零回归 | 未绑定 PR 的实例：右栏「暂无关联」，无「检查项」元素 |

### Cloud Host Issues Linkage E2E (`cloud-host-issues-linkage.spec.ts`)

> fixture 驱动（`MONGODB_URI`）：直接写云电脑 / 已配置工作流 / 联动配置，不依赖真实 K8s 与 GitHub App；触发链路与标签同步由 `tests/api` T-GHIL/T-GHI 覆盖。

| 测试 | 描述 |
|------|------|
| E2E-33 配置列表与弹窗 | 「Github」tab → 列表展示工作流名/标签/仓库 → 加配置弹窗默认标签 `start-{工作流名字}` 与同步提示 |
| E2E-34 校验引导 | 无可用工作流 → 展示「配置工作流」入口且保存禁用 |
| E2E-35 触发链路 | **未实现**（需真实 Github App/仓库与云电脑）：状态机语义由 `issues-event-handler.runner.test.ts` 覆盖，webhook 判定链由 `tests/api` T-GHI1/2/4 覆盖 |
| E2E-36 幂等与多配置 | **未实现**（同 E2E-35 环境依赖）：多配置与幂等由 `issues-event-handler.flow.test.ts` 与唯一索引单测覆盖 |
| E2E-37 销毁清理 | 有配置的云电脑销毁时出现标签清理询问（1 条配置）；确认删除后云电脑从面板移除（实际标签删除依赖真实仓库，见 T-GHIL4/5） |
| E2E-38 零回归 | **未单独建用例**：未配置联动云电脑与 `pull_request_review` 联动（E2E-27..32）由既有套件回归，`pull_request_review` 分支代码未改动 |


### ACP Permission Reminder E2E (`permission.spec.ts`)

| 测试 | 描述 |
|------|------|
| 侧边栏显示待办铃铛图标 | 登录后侧边栏显示铃铛图标 |
| 初始未读数量为0 | 铃铛图标不显示badge |
| 点击铃铛打开待办列表 | 点击铃铛 → 弹出待办列表面板，显示「待办事项」标题 |
| 待办列表初始为空状态 | 打开待办列表 → 显示「暂无待办事项」 |
| 权限请求创建待办 | controller发送acp:permission → 待办列表显示权限审批待办 |
| 点击待办打开权限审批Dialog | 点击权限待办 → 打开Dialog，显示操作详情和审批选项 |
| 审批后返回结果给controller | 点击「Allow once」→ controller收到acp:permission:response |
| 立即优先级待办触发全局弹窗 | 权限请求 → 页面显示全局通知弹窗 |
| 审批后待办标记为已读 | 响应权限请求 → badge消失 |

### ACP 能力透明化 E2E (`session-capabilities.spec.ts`)

| 测试 | 描述 |
|------|------|
| T-E31 能力面板 | 打开会话 →「能力清单」→ 断言 `agent-capability-row-*` 计数 = 20、状态徽标、至少一行 detail 文本与 Agent 版本 |
| T-E32 旧会话面板提示 | fake controller 不带 `capabilities` → 显示「创建于能力快照上线前」 |
| T-E33 模型切换门控 | `config.model:unsupported` → 模型按钮禁用，title 含原因 |
| T-E34 模式切换门控 | `config.mode:unsupported` → 模式按钮禁用 |
| T-E35 继续按钮门控 | `resume`+`load` 均 unsupported → 禁用；仅 resume unsupported → 可用 |
| T-E36 模型来源分组 | 必须注入 `MONGODB_URI`（缺失即失败，不静默 skip）直写平台库；`model-group-*` DOM 顺序断言四组固定顺序、组头含判定依据 |
| T-E37 问询提示条 | fake controller 发 `acp:elicitation` → 会话内提示条可打开弹窗 |
| T-E38 问询过期 | 发 `acp:elicitation:resolved{timeout}` → 弹窗显示「已过期」且操作按钮隐藏 |
| T-E39 移动端问询 | 移动视口 → 提示条可见、可打开弹窗（Sidebar 未挂载场景） |
| T-E40 初始配置失败 toast | fake controller 发 `acp:initial-config:result{modelStatus:'failed',error}` → 会话页 toast「模式/模型设置未生效：<error>」+ 副行「当前生效模型」 |

### Kimi Code 登录引导 E2E (`harness-login.spec.ts`)

> 需要 `HARNESS_ENABLED=true` + Aspire 全量服务（agent-web / agent-api / controller-api / Redis）。fake controller 注入 `harness:login:required/succeeded/failed` 驱动全局弹窗（SSE 即时下发）；真实 `kimi login` 浏览器授权链路列部署侧手工验收（计划 §3 A20）。

| 测试 | 描述 |
|------|------|
| T-E-HL1/T-E-HL2 | 不刷新即时弹出：链接/验证码逐字、「复制链接/验证码」、`target=_blank rel=noreferrer`、倒计时；注入 `succeeded` → 自动关闭 + toast「Kimi Code 已登录」 |
| T-E-HL3 | 取消：fake controller 收到 `harness:login:cancel` → 注入 `failed(cancelled)` → toast「Kimi Code 未登录」；再次注入新 requestId 可重新弹出 |
| T-E-HL4 | 注入 `failed(timeout)` → toast「登录未完成，可重试」，弹窗与取消按钮隐藏 |
| T-E-HL5 | 移动视口（375px）弹窗可见、无横向溢出、取消可点 |
| T-E-HL6 | OpenCode 探测（`acpServerOptions`）零弹窗（零回归） |
| T-E-HL7 | 新建云电脑对话框 `Kimi Code` 与 `OpenCode` 均可见可勾选、多选提示「不自动创建会话」（见 `cloud-host.spec.ts`） |

### Admin Auth E2E (`admin-auth.spec.ts`)

| 测试 | 描述 |
|------|------|
| 未登录重定向 | 访问 `/models` → `/login`（T-F3） |
| 无注册入口 | 登录页无「注册」元素（T-F7） |
| 登录进入后台 | 归一化密码登录 → `/models`，侧边栏可见（T-E1） |
| 强制改密守卫 | mustChangePassword 时访问 `/base-images` → `/change-password`（T-F4/T-E2） |
| 改密表单校验 | 长度不足/两次不一致给出提示（T-F5） |
| 侧边栏导航/高亮 | 点击「基础镜像」「模型配置」切换（T-E6） |
| 退出登录 | 回 `/login`（T-F6） |
| 改密后旧密码失效 | 新密码可登录、旧密码报错（T-E3） |

### Admin Model Config E2E (`admin-model-config.spec.ts`)

| 测试 | 描述 |
|------|------|
| 区块与空状态 | 供应商设置 / 可用模型 空状态（T-W5） |
| 表单校验 | 空表单保存禁用（T-W1） |
| 供应商全流程 | UI 新增全局供应商 → **不自动导入模型**（toast 提示手动导入）→ 凭据脱敏展示 → 删除级联（T-E4/T-W1, T-E21） |
| 导入模型弹窗 | 「导入模型」拉取清单 → 勾选导入 → 成功提示 → 展开分组可见（T-E22）；已导入项禁选并标「已导入」（T-E23）；其他供应商已占用项标记「已存在」且禁选（T-E23） |
| 分组与折叠 | 多供应商 → 组头含名称与数量、默认折叠、点击展开后仅显示该组模型（T-E24） |
| 后台删除任意模型 | 删除导入模型 → 确认含影响说明 → 列表与组计数即时刷新 → 同名可重新导入（T-E25） |
| 自定义模型重名拦截 | 输入已存在名称 → 内联「模型名已存在」→ 保存禁用（T-E26） |
| 重名整理记录 | 展开面板逐行展示原名→新名/供应商/时间；空态提示（T-E27，需 MONGODB_URI） |
| 自定义模型 | UI 新增/删除全局自定义模型（T-W3） |

### Admin Base Image E2E (`admin-base-image.spec.ts`)

| 测试 | 描述 |
|------|------|
| 页面与空状态 | 「基础镜像」页空状态 |
| CRUD + 删除确认 | UI 新建 → 列表展示 → 删除二次确认（T-W4/T-E5） |
| 同名拒绝 | API 同名创建报错 `Base image name already exists`（T-E5） |

### Admin Billing E2E (`admin-billing.spec.ts`)

> 需要 admin-web / admin-api 就绪。多租户一期：`BillingOwnerType` 增 `tenant`，`admin_user` 原样保留；
> 前台租户计费账户以 `adminCreateFrontUser` 开户自动创建（零余额）。

| 测试 | 描述 |
|------|------|
| 费用中心可进入，充值后账单与收据可见 | 后台管理员账户（`admin_user`）充值 → 账单/收据/汇总可见（双 owner 回归基线） |
| 对账中心可进入并手动运行 | 运行全部对账 → 资金/计量/资源对账结果可见 |
| ownerType 支持 tenant 检索且可按租户充值 | API：`adminBillingAccounts(ownerType: tenant)` 命中开户租户（`ownerId == userId`）、`admin_user` 检索零回归；UI：类型下拉含「租户」→ 按租户检索 → 行内「充值」对话框可用 |

### Admin Cloud Container E2E (`admin-cloud-container.spec.ts`)

> 需要 admin-web / admin-api / cloud-controller 就绪：`aspire start && aspire wait admin-web admin-api cloud-controller`；cloud-controller 以 `K8S_ENABLED=false` 运行（无真实工作容器回连，容器停在 CREATING/CONNECTING）。
> T-E15 通过直写共享 Mongo（`cloudworkloadlogs`）构造参数快照，T-E19（日志必须标识）与 T-E20（退出原因）分别直写 `cloudworkloadlogs.required`/`cloudcontainers.exitReason`，均需要 `MONGODB_URI`（缺省时 `test.skip` 跳过）。

| 测试 | 描述 |
|------|------|
| 页面与启动对话框 | 「云端容器」页可见；启动对话框仅 idle（T-E1/PRD 3.4）+ 工作负载多选入口与上限提示（最多 10 个） |
| 启动 + 强制销毁 | UI 启动 idle → 列表出现 `zag-worker-*` → 强制销毁二次确认 → 状态收敛为已退出（T-E1/T-E3） |
| 工作负载列与日志空态 | 启动未挂载容器 → 「工作负载」列表头可见且行为 `-` → 打开「工作负载日志」展现「暂无执行记录」空态 |
| T-E5 非管理员访问 | 未登录访问 `/cloud-containers` 重定向 `/login` |
| T-E14 启动参数与依赖提示 | 选中带参数工作负载 → 参数表单预填默认值；未显式选择依赖时提示「将自动初始化 XXX（默认参数）」；初始化顺序预览（隐式依赖带「隐式」标记）；提交后容器行展示展开后的挂载顺序 |
| T-E15 日志参数快照 | 直写 `cloudworkloadlogs.params` → 打开日志对话框展示「参数快照」（`version: 20` / `package_manager: ["pnpm"]`） |
| T-E17 必须开关配置 | 仅「已勾选且含 `initScript`」的工作负载出现「必须」开关（默认关）；仅 `postScript` 的不出现；取消勾选清除、重新勾选回到默认；提交后落库 `workloadPlan[].required=true` |
| T-E18 顺序预览必须标识 | 必须项在预览有「必须」标识；隐式依赖仍带「隐式」标识且不受影响 |
| T-E19 日志必须标识 | 直写 `cloudworkloadlogs.required=true/false` 后对话框按记录展示「必须」标识；历史缺省不误标 |
| T-E20 退出原因展示 | 直写必须失败容器的 `exitReason`（含负载名）后列表可见 `必须工作负载「must-a」初始化失败` |

> 覆盖裁剪：T-E2（token 拒绝）由 `tests/api/src/cloud-controller/worker-handshake.test.ts` 覆盖；T-E4（异常退出/超时保留 `exitReason`、可强制销毁）与 T-E6（列表与 Job 对账）在 `K8S_ENABLED=false` 下无真实 Job 可对账，由 cloud-controller 单测锚定（`status-sync.test.ts` T-Y1/T-Y3/T-Y5 + reconcile、`container-service.test.ts` T-S4/T-S4b）；真实集群链路列为部署侧手工验收。

### Admin Cloud Workload E2E (`admin-cloud-workload.spec.ts`)

> 需要 admin-web / admin-api / cloud-controller 就绪：`aspire start && aspire wait admin-web admin-api cloud-controller`；cloud-controller 以 `K8S_ENABLED=false` 运行。
> T-E9/T-E10 通过直写共享 Mongo（`cloudcontainers` / `cloudworkloadlogs`）构造 `INITIALIZING`/`currentWorkloadName` 与执行记录，需要 `MONGODB_URI`（缺省时 `test.skip` 跳过）。
| 测试 | 描述 |
|------|------|
| T-E7 CRUD | 「工作负载」页新建（init+post）→ 编辑改名 → 删除二次确认后列表移除 |
| T-E7/T-E8 删除后消失 | 工作负载出现在启动选择列表 → 删除 → 启动选择列表不再出现 |
| T-E8 启动多选 | 启动对话框默认不选、按勾选顺序多选 → 容器列表行展示挂载的工作负载名称（顺序 = 勾选顺序） |
| T-E9 初始化中 | 直写 Mongo 置 `INITIALIZING` + `currentWorkloadName` → 页面展示「初始化中」徽章 + 当前脚本名 |
| T-E10 日志视图 | 直写 `cloudworkloadlogs` → 打开日志对话框展示阶段（初始化/清理）、状态（成功/失败）、脚本快照与输出，切换记录同步更新 |
| T-E11 非管理员 | 未登录访问 `/cloud-workloads` 重定向 `/login` |
| T-E12 参数配置全流程 | 新建工作负载配置四种参数类型（下拉单选/下拉多选/文本/布尔）与默认值 → 保存 → 列表展示参数数量（4）→ 编辑回显类型/默认值 |
| T-E12 非法值拦截 | 非法 key（数字开头）与下拉类型无可选项时给出提示且「保存」禁用 |
| T-E13 多依赖 | 勾选多个依赖 → 展示「已选依赖（按初始化顺序）」→ 列表展示依赖名称；依赖环 → 「检测到依赖环」提示且「保存」禁用 |
| T-E16 预制项展示 | 列表出现 Docker/Node.js/.NET/Aspire/OpenCode（Harness）/Kimi Code（Harness）/DeepSeek Harness（Harness）/Github/MongoDB/Playwright 与「预制」徽章（恰 10 个）；Aspire 行展示依赖 Docker/.NET；Node.js 展示 2 个参数；Playwright 行展示依赖 Node.js |

> 覆盖裁剪（计划裁决 17）：Aspire 以 `K8S_ENABLED=false` 启动、无真实工作容器回连，`INITIALIZING` 与脚本执行链路改由 cloud-controller/agent-controller 单测与 tests/api（直写 Mongo + 内部 API/GraphQL 查询）覆盖；E2E 只覆盖 CRUD、启动多选、状态/日志展示。真实集群链路（init/post 下发执行、超时保护、旧 worker 兼容、镜像重建）列部署侧手工验收。

### 前台云电脑 E2E (`cloud-host.spec.ts` / `cloud-host-readonly.spec.ts`)

> 需要 `HARNESS_ENABLED=true` 与 Aspire 全量服务；`K8S_ENABLED=false` 下容器只能停在 `STARTING`，E2E 覆盖到「启动中 → 停止 → 已销毁 → 删除」。
> 只读回看由 `cloud-host-readonly.spec.ts` 直写 Mongo（`cloudhosts` + `sessions`）构造终态 fixture，需要 `MONGODB_URI`（缺省时 skip）。

| 测试 | 描述 |
|------|------|
| T-AW2/T-AW3/T-AW4 | 新建入口、名称/harness 必填、无存储参数、选 1 提示「就绪后不会自动创建会话，需先创建或绑定工作区」、提交后 Sidebar 云图标 + 启动中 |
| E2E-1 | 普通创建不预置默认工作区、不自动建会话；ready 后展示无工作区提示，defaultSessionId/workspaceId 为 null |
| P10-CH1 | 未选 Github 项目 → 不弹四阶段进度框；ready 后 phase2 语义（无默认工作区/无默认会话，sessions=0） |
| P10-CH2 | 选 Github 项目 → 四阶段进度；成功后进入项目会话、回填 defaultSessionId、无空默认会话 |
| T-AW6/T-AW7/T-AW9 | 配置页状态/工作区+Harness 两栏；无活动会话直接停止；已销毁无再次启动；终态可删除并移出列表 |
| T-AW10 | 已销毁云电脑会话只读回看：无输入框/发送/继续，历史消息保留 |
| E2E-39/E2E-41 | 新建对话框展示「收费详情」（创建花费 / 运行消费 / 欠费强制销毁提示）；余额不足提示但**不前置禁用**创建 |
| E2E-40 | **未单独建用例**（需真实创建多台并各自启停）：数量放开语义由 `cloud-host-service.test.ts` T-CH-C7 与 `tests/api` 多台并行用例覆盖 |
| E2E-42 | **未单独建用例**（需真实 Github App 与云电脑）：帐号跟随/置灰由 `useGithubProjectForm.test.tsx`、`GithubProjectSetupDialog` 单测与 `T-CHG12..14` 覆盖 |

> RUNNING/默认会话/ACP 链路不在 E2E 断言（无真实 worker），由单测 + 真实集群手工验收覆盖。


## Github 工作负载

- `src/github-workload.spec.ts`：`HARNESS_ENABLED=true` 时通过 API 创建云主机，验证工作区 Github 图标、设置弹窗默认前缀 `~/workspace`（无默认工作区时预填，预览展开为 `/home/worker/workspace`）、前缀语义文案（最终地址 = `<前缀>/<owner>/<repo>`）、Github 工作负载固定勾选与未绑定账号引导；不调用真实 GitHub，成功 clone/凭据/会话链路依赖单测与部署侧手工验收。
- `src/cloud-host.spec.ts`：新建云电脑弹窗断言 `cloudHostWorkloadCatalog` 的真实数据（Aspire/Docker/.NET 可见、Aspire 依赖文案、勾选 Docker 出现耗时提示），再提交创建；K8S 关闭时只断言到「启动中」，不做就绪断言。
