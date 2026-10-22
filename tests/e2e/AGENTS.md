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
- `controller-api`: `http://localhost:33237`

填入实际端口后执行：

```bash
BASE_URL=http://localhost:35615 \
ADMIN_API_URL=http://localhost:10003/graphql \
ADMIN_WEB_URL=http://localhost:<admin-web-port> \
API_URL=http://localhost:10001/graphql \
CONTROLLER_API_URL=http://localhost:33237 \
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
| `API_URL` | agent-api GraphQL 地址 | `http://localhost:4000/graphql` |
| `ADMIN_API_URL` | admin-api GraphQL 地址 | `http://localhost:10003/graphql` |
| `MONGODB_URI` | 共享 MongoDB 连接串（T-E1 真实首登强制改密需据此重置种子管理员；缺省时该用例跳过） | -（可 `aspire describe mongodb` 获取） |
| `ADMIN_INITIAL_PASSWORD` | admin-api 种子管理员初始密码。**无默认值**（问题 4/47）。E2E 通过 `MONGODB_URI` 直接改写 Mongo 口令哈希，故通常无需设置；如需固定值排查可注入 | -（`MONGODB_URI` 提供时自动重置） |
| `CONTROLLER_API_URL` | controller-api Socket.IO 地址 | `http://localhost:4001` |
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

| 测试 | 描述 |
|------|------|
| 注册新用户 | 填写注册表单 → 跳转到主界面，侧边栏可见 |
| 登录后展示布局 | 正确凭证登录 → 2-column 布局，Sessions 可见 |
| 侧边栏显示用户名 | 登录后侧边栏底部显示当前用户 |
| 错误密码提示 | 错误密码 → 显示错误信息 |
| 设置页导航 | 点击设置按钮 → 设置页显示退出登录按钮 |
| 设置页布局 | 设置页 2-column 布局，显示用户名 |
| 退出登录 | 点击退出登录 → 跳转回登录页 |
| 未登录重定向 | 直接访问 `/` → 重定向到登录页 |

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
| 注册用户并显示 controller section | API 注册用户 → 登录 → 设置页显示 controller-section |
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
| T-E16 预制项展示 | 列表出现 Docker/Node.js/.NET/Aspire/OpenCode（Harness）与「预制」徽章（恰 5 个）；Aspire 行展示依赖 Docker/.NET；Node.js 展示 2 个参数 |

> 覆盖裁剪（计划裁决 17）：Aspire 以 `K8S_ENABLED=false` 启动、无真实工作容器回连，`INITIALIZING` 与脚本执行链路改由 cloud-controller/agent-controller 单测与 tests/api（直写 Mongo + 内部 API/GraphQL 查询）覆盖；E2E 只覆盖 CRUD、启动多选、状态/日志展示。真实集群链路（init/post 下发执行、超时保护、旧 worker 兼容、镜像重建）列部署侧手工验收。

### 前台云电脑 E2E (`cloud-host.spec.ts` / `cloud-host-readonly.spec.ts`)

> 需要 `HARNESS_ENABLED=true` 与 Aspire 全量服务；`K8S_ENABLED=false` 下容器只能停在 `STARTING`，E2E 覆盖到「启动中 → 停止 → 已销毁 → 删除」。
> 只读回看由 `cloud-host-readonly.spec.ts` 直写 Mongo（`cloudhosts` + `sessions`）构造终态 fixture，需要 `MONGODB_URI`（缺省时 skip）。

| 测试 | 描述 |
|------|------|
| T-AW2/T-AW3/T-AW4 | 新建入口、名称/harness 必填、无存储参数、选 1 提示自动建会话、提交后 Sidebar 云图标 + 启动中 |
| T-AW6/T-AW7/T-AW9 | 配置页状态/工作区+Harness 两栏；无活动会话直接停止；已销毁无再次启动；终态可删除并移出列表 |
| T-AW10 | 已销毁云电脑会话只读回看：无输入框/发送/继续，历史消息保留 |

> RUNNING/默认会话/ACP 链路不在 E2E 断言（无真实 worker），由单测 + 真实集群手工验收覆盖。
