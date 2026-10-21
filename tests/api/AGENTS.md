# API Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed

## 测试步骤

> **注意**: 只允许使用 Aspire 编排服务，禁止直接使用 Docker 命令。

### 1. 启动服务

```bash
# 启动 Aspire 编排并等待服务就绪（在项目根目录）
aspire start && aspire wait agent-api
```

### 2. 获取 Endpoint

```bash
# 查看 agent-api 的地址
aspire describe agent-api
```

输出中查找 `agent-api` 的 URL，例如 `http://localhost:4000`。

### 3. 填入环境变量并执行测试

```bash
# 查看各服务 endpoint
aspire describe agent-api
aspire describe controller-api
```

从输出中查找各服务的 `http://localhost:<port>` URL，例如:
- `agent-api`: `http://localhost:10001`
- `controller-api`: `http://localhost:33237`

填入实际端口后执行：

```bash
API_URL=http://localhost:10001/graphql \
ADMIN_API_URL=http://localhost:10003/graphql \
CONTROLLER_API_URL=http://localhost:33237 \
npm test
```

> admin 套件（`src/admin-api/**`）与 agent-api scope 回归需要 admin-api 就绪：`aspire start && aspire wait admin-api agent-api && aspire wait controller-api`。

### 4. 重新运行测试

如果需要重新运行测试，必须从**步骤 1** 开始，重新运行 Aspire 实例。

## 测试脚本

| 脚本 | 说明 |
|------|------|
| `npm test` | 运行全部常规测试文件（24 个：admin-api / agent-api / cloud-controller / controller-api；`fileParallelism: false` 串行，不含 `acp-real-*`） |
| `npm run test:real` | 仅运行 `acp-real-*` 测试（5 个，串行，超时 30s） |
| `npm run test:all` | 先运行 `acp-real-*` 再运行常规测试 |

> **注意**: `acp-real-*` 测试会启动真实的 agent-controller 进程，共享 PID 文件 `/tmp/agent-controller.pid` 和端口 34519，因此必须串行执行，且需要干净数据库状态。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_URL` | agent-api GraphQL 完整地址 | `http://localhost:4000/graphql` |
| `ADMIN_API_URL` | admin-api GraphQL 完整地址 | `http://localhost:10003/graphql` |
| `MONGODB_URI` | 共享 MongoDB 连接串（T-A7 强制改密守卫、scope 隔离等 DB 断言用；缺省时相关用例自动跳过） | -（可 `aspire describe mongodb` 获取） |
| `ADMIN_INITIAL_PASSWORD` | admin-api 种子管理员初始密码。**无默认值**（问题 4/47）：Aspire 每次启动随机生成（admin-api 首次种子时一次性打印到启动日志），或经 `Parameters__admin-initial-password` 注入；测试须注入与服务一致的值 | - |
| `CONTROLLER_API_URL` | controller-api 服务地址 | `http://localhost:4001` |
| `CLOUD_CONTROLLER_URL` | cloud-controller 服务地址（cloud-controller 套件） | `http://localhost:10004` |
| `CLOUD_CONTROLLER_INTERNAL_TOKEN` | cloud-controller 内部 API Bearer token。**无默认值**（问题 47）：须与 Aspire 注入的 `internal-api-token` 一致（`Parameters__internal-api-token` 注入）；未提供时 cloud-controller 内部 API 套件显式跳过 | - |

> 套件内含共享账号（admin）口令轮换与 `mustChangePassword` 翻转等用例，**禁止多 worker 并行**；默认 vitest 已串行于同一进程内，如需并行务必隔离环境。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## 测试清单

### Auth API (`auth.test.ts`)

| 测试 | 描述 |
|------|------|
| signup - 创建用户 | 应返回 token 和用户信息 |
| signup - 重复用户名 | 应返回错误「Username already taken」 |
| signup - 用户名过短 | 应返回用户名校验错误 |
| signup - 密码过短 | 应返回密码校验错误 |
| login - 正确凭证 | 应返回 token 和用户信息 |
| login - 错误密码 | 应返回「Invalid username or password」 |
| login - 不存在的用户 | 应返回「Invalid username or password」 |
| me - 未认证 | 应返回 null |
| me - 已认证 | 应返回当前用户信息 |

### LLM Provider & Model API (`llm.test.ts`)

| 测试 | 描述 |
|------|------|
| providers query - 无 token | 应返回「Not authenticated」 |
| models query - 无 token | 应返回「Not authenticated」 |
| providers query - 已认证 | 应返回空列表 |
| models query - 已认证 | 应返回空列表 |
| createProvider - 无效 endpoint | 应返回连通性测试失败 |
| createProvider - 空名称 | 应返回校验错误 |
| createProvider - 无 auth | 应返回「Not authenticated」 |
| batchEnable - 空列表 | 应返回 successCount=0 |
| batchDisable - 空列表 | 应返回 successCount=0 |
| batchDelete - 空列表 | 应返回 successCount=0 |
| batchEnable - 无 auth | 应返回「Not authenticated」 |
| toggleProvider - 不存在的 provider | 应返回「Provider not found」 |
| toggleProvider - 无 auth | 应返回「Not authenticated」 |
| deleteProvider - 不存在的 provider | 应返回 false |
| updateProvider - 不存在的 provider | 应返回「Provider not found」 |
| createCustomModel - 无 auth | 应返回「Not authenticated」 |
| toggleModel - 无 auth | 应返回「Not authenticated」 |
| updateModelSortOrder - 无 auth | 应返回「Not authenticated」 |

### Controller Key API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllerKeys query - 无 token | 应返回「Not authenticated」 |
| controllers query - 无 token | 应返回「Not authenticated」 |
| controller query - 无 token | 应返回「Not authenticated」 |
| createControllerKey - 无 auth | 应返回「Not authenticated」 |
| createControllerKey - 正常创建 | 应返回 key 和 rawKey（zag_k_ 前缀） |
| createControllerKey - 空名称 | 应返回校验错误 |
| createControllerKey - 替换未绑定 key | 生成新 key 时自动删除旧的未绑定 key |
| controllerKeys query - 已认证 | 应返回未绑定 key 列表（含 rawKey），不返回已绑定 key |
| renameControllerKey - 无 auth | 应返回「Not authenticated」 |
| renameControllerKey - 正常重命名 | 应返回新 name |
| renameControllerKey - 不存在的 key | 应返回错误 |

### Controller Management API (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| controllers query - 已认证 | 应返回空列表 |
| controller query - 不存在 | 应返回 null |
| renameController - 无 auth | 应返回「Not authenticated」 |
| renameController - 不存在 | 应返回「Controller not found」 |
| unbindController - 无 auth | 应返回「Not authenticated」 |
| unbindController - 不存在 | 应返回 false |

### Controller Online Status (`controller.test.ts`)

| 测试 | 描述 |
|------|------|
| register 后查询 controller | status 应为 online，hostname/version 正确 |
| controllers 列表包含在线 controller | 应包含 status=online 的记录 |
| unregister 后 controller 和 key 应被删除 | 查询应返回 null |
| unbind 后 controller 和 key 应被删除 | GraphQL unbind 后查询应返回 null |
| register 后 controllerKeys.lastUsedAt | 应更新为非 null |

### Controller WebSocket API (`controller-api/websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| register - 有效 key | 应返回 controllerId |
| register - 无效 key | 应返回 INVALID_KEY 并断开 |
| register - 版本不匹配 | 应返回 VERSION_MISMATCH 并断开 |
| heartbeat - 已认证客户端 | 应接受心跳，连接保持在线 |
| unregister - 主动注销 | 应删除 key 和 controller 记录并断开 |
| session 独占 - 重复 key | 第二个连接应收到 KEY_ALREADY_ONLINE |

### Session API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| sessions query - 无 token | 应返回「Not authenticated」 |
| session query - 无 token | 应返回「Not authenticated」 |
| createSession - 无 auth | 应返回「Not authenticated」 |
| createSession - 正常创建（opencode） | 应返回 session（status=creating, acpServerType=opencode） |
| createSession - 正常创建（github_copilot） | 应返回 session（status=creating, acpServerType=github_copilot） |
| createSession - 正常创建（claude_code） | 应返回 session（status=creating, acpServerType=claude_code） |
| createSession - 正常创建（gemini_cli） | 应返回 session（status=creating, acpServerType=gemini_cli） |
| createSession - 正常创建（codex） | 应返回 session（status=creating, acpServerType=codex） |
| createSession - 无效 controllerId | 应返回「Controller not found」 |
| sessions query - 已认证 | 应返回 sessions 列表 |
| session query - 已存在的 session | 应返回 session 详情 |
| session query - 不存在的 session | 应返回 null |
| sendSessionMessage - 正常发送 | 应返回 input 方向消息 |
| sendSessionMessage - 不存在的 session | 应返回错误 |
| sessionMessages query - 已有消息 | 应返回消息列表 |
| sessionMessages query - 不存在的 session | 应返回错误 |
| closeSession - 正常关闭 | 应返回 true，status 变为 ended |
| deleteSession - 正常删除 | 应返回 true，session 不再存在 |
| acpCapabilities - 无 token | 应返回「Not authenticated」 |
| acpCapabilities - 已认证 | 应返回 capabilities 列表（含 checkedAt） |
| acpCapabilities - 不存在的 controller | 应返回错误 |
| refreshAcpCapabilities - 无 token | 应返回「Not authenticated」 |
| refreshAcpCapabilities - 不存在的 controller | 应返回错误 |
| refreshAcpCapabilities - 已认证 | 应返回 capabilities 列表（含 checkedAt） |
| acp:check:result - opencode | 普通 acp:check:result 响应（仅 opencode） |
| acp:check:result - 多 Server | acp:check:result 响应包含 opencode + github_copilot 两个 server |
| gc:start - github_copilot | 创建 session 时 acpServerType=github_copilot，验证 serverType 正确传递 |

### Session SSE API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| 未认证 SSE 连接 | 应返回 401 |
| 不存在的 session SSE | 应返回 404 |
| 正常 SSE 连接 | 应返回 200 + event-stream，发送 history |
| SSE modes - acp:start:result 含 modes | SSE 初始 status 事件包含 modes/currentModeId/currentModel |
| SSE 高频消息时序 | 高频连发 5 条消息，SSE 推送顺序应与到达顺序一致 |

### Controller ACP WebSocket (`controller-api/acp-websocket.test.ts`)

| 测试 | 描述 |
|------|------|
| acp:check - opencode | 应请求检测并返回 opencode servers 列表 |
| acp:check - 全部 5 种 Server | 应请求检测并返回全部 5 种 Server（opencode + github_copilot + claude_code + gemini_cli + codex） |
| acp:start - opencode | 应发送 acp:start 请求（serverType=opencode），controller 响应 success |
| acp:start - github_copilot | 应发送 acp:start 请求（serverType=github_copilot），controller 响应 success |
| acp:start - claude_code | 应发送 acp:start 请求（serverType=claude_code），controller 响应 success |
| acp:start - gemini_cli | 应发送 acp:start 请求（serverType=gemini_cli），controller 响应 success |
| acp:start - codex | 应发送 acp:start 请求（serverType=codex），controller 响应 success |
| acp:start - failure | 应发送启动请求，controller 响应 failure，session status=ended |
| acp:message | 应转发 controller 输出消息并持久化到 DB |
| acp:stop | 应发送停止请求，controller 响应 stopped，session status=ended |

### End-to-End: Session 全链路 (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| gc:create → acp:start → verify serverType | 创建 github_copilot session → fake controller 收到 acp:start（serverType=github_copilot）→ 响应 success → 验证 acpServerType 和 status |
| create → acp:start → success → verify running | 创建 session → fake controller 收到 acp:start → 响应 success → 查询 session status=running |
| create → acp:start → failure → verify ended | 创建 session → fake controller 响应 failure → 查询 session status=ended |
| create → send message → controller receive → output persisted | 创建 session → GraphQL 发消息 → fake controller 收到 acp:message → 模拟输出 → 查询消息列表验证 input+output 都持久化 |
| resume → acp:resume → success → verify idling | 创建 session → 关闭 → resume → fake controller 收到 acp:resume → 响应 success → 验证 idling |
| resume → acp:resume → failure → verify ended | 创建 session → 关闭 → resume → fake controller 响应 failure → 验证 ended |

### History Session Sync API (`agent-api/history-session-sync.test.ts`)

| 测试 | 描述 |
|------|------|
| listHistorySessions - 无 token | 应返回「Not authenticated」 |
| listHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| listHistorySessions - 不存在的 workspace | 应返回「Workspace not found」 |
| listHistorySessions - 正常返回 | 通过 fake controller 响应返回 history session 列表 |
| listHistorySessions - 带 acpServerType 参数 | 使用 acpServerType=claude_code 调用 listHistorySessions，验证成功 |
| importHistorySessions - 无 token | 应返回「Not authenticated」 |
| importHistorySessions - 不存在的 controller | 应返回「Controller not found」 |
| importHistorySessions - 导入单个 session | 导入 1 个 session，验证 messageCount=2 |
| importHistorySessions - 导入多个 session | 导入 2 个 session，验证都存在并 status=ended |
| importHistorySessions - 去重过滤 | 先导入 acp_sync_sess_1，list 应返回 acp_sync_sess_2 但排除 s1 |
| importHistorySessions - 带 acpServerType 参数 | 使用 acpServerType=gemini_cli 调用 importHistorySessions，验证导入成功 |

### Worktree Session API (`agent-api/session.test.ts`)

| 测试 | 描述 |
|------|------|
| createSession with enableWorktree - 上传分支后缀 | 创建 session（enableWorktree=true + worktreeBranchSuffix），等待 git:worktree:add，controller 响应成功，验证 worktreePath / worktreeBranch |
| createSession with enableWorktree - 默认分支后缀 | enableWorktree=true 无后缀，验证 git:worktree:add 的 branch 不包含 "undefined" |
| createSession with enableWorktree - 失败 | git:worktree:add 返回 failure，验证 session status=ended，worktreePath=null |

### Controller Worktree Dir API (`agent-api/controller.test.ts`)

| 测试 | 描述 |
|------|------|
| setControllerWorktreeDir - 无 auth | 应返回「Not authenticated」 |
| setControllerWorktreeDir - 不存在的 controller | 应返回「Controller not found」 |
| setControllerWorktreeDir - 正常设置 | 设置 /home/user/worktrees，验证 controller.worktreeDir 持久化 |

### Folder Creation API (`agent-api/workspace.test.ts`)

| 测试 | 描述 |
|------|------|
| createFolder - 无 auth | 应返回「Not authenticated」 |
| createFolder - 不存在的 controller | 应返回「Controller not found」 |
| createFolder - offline controller | 应返回「Controller is offline」 |
| createFolder - 成功 | 等待 fs:mkdir，controller 响应 success，验证 FolderEntry（name/path/isDirectory） |
| createFolder - 失败 | fs:mkdir 返回 failure(error)，应返回 GraphQL error |

### Folder Browse API (`agent-api/workspace.test.ts`)

| 测试 | 描述 |
|------|------|
| browseFolder - 无 auth | 应返回「Not authenticated」 |
| browseFolder - 不存在的 controller | 应返回「Controller not found」 |
| browseFolder - offline controller | 应返回「Controller is offline」 |
| browseFolder - 返回目录列表 | 等待 fs:browse，controller 响应 entries，验证 FolderEntry 列表 |
| browseFolder - 返回空列表 | controller 响应空 entries，验证返回 [] |
| browseFolder - path=null 使用 home | path 为 null 时 controller 收到 null path，验证透传 |
| browseFolder - path=/ 根目录 | path 为 / 时 controller 收到 / path，验证返回根目录 entries |
| getHomeDirectory - 无 auth | 应返回「Not authenticated」 |
| getHomeDirectory - 不存在的 controller | 应返回「Controller not found」 |
| getHomeDirectory - 成功 | 等待 fs:home，controller 响应 path，验证返回 home 路径 |

### Port Forward API (`agent-api/port-forward.test.ts`)

| 测试 | 描述 |
|------|------|
| portForwards query - 无 token | 应返回「Not authenticated」 |
| createPortForward - 无 auth | 应返回「Not authenticated」 |
| deletePortForward - 无 auth | 应返回「Not authenticated」 |
| createPortForward - 不存在的 controller | 应返回「Controller not found」 |
| createPortForward - controller 离线 | 应返回「Controller is not online」 |
| createPortForward - 成功创建 | 应返回端口转发记录（port/status/controllerId） |
| createPortForward - 端口重复 | 应返回「Port already forwarded」 |
| portForwards query - 已认证 | 应返回端口转发列表 |
| deletePortForward - 成功删除 | 应返回 true，列表中不再包含该端口 |
| deletePortForward - 不存在的端口 | 应返回 false |

### Agent Workflow API (`agent-api/workflow.test.ts`)

| 测试 | 描述 |
|------|------|
| A1 创建合法模板 | 创建成功，version=1，isBuiltin=false |
| A2 非法图拒绝 | 环 / 双首节点 / AI 首节点分别返回具体校验错误 |
| A3 内置模板只读 | 对 isBuiltin 模板 update/delete 拒绝（「内置模板不允许修改/删除」） |
| A4 version 自增 | 每次 update version+1 |
| A5 复制快照与隔离 | configureWorkflow 深拷贝节点并记录来源版本；改模板不影响副本 |
| A6 缺 agentConfig 拒绝 | AI 节点无 agentConfig 时报缺失节点 |
| A7 capabilities 校验 | acpServerType 不在 controller 可用列表内拒绝（fake controller 应答 acp:check） |
| A8 禁止增删节点 | updateConfiguredWorkflow 增/删 nodeKey 均拒绝 |
| A9 活跃实例删除约束 | 存在未终结实例时 deleteConfiguredWorkflow 拒绝；无引用时可删除 |
| A10 实例化 | 首节点（HUMAN）READY，其余 INITIALIZING |
| A11 非 git 工作区拒绝 | requiresWorktree+initNewWorktree 但工作区无 defaultBranch 时实例化拒绝 |
| A12 completeHumanNode 接力 | 产物写黑板（{nodeId}-{name}-产物-{title}），下游 AI 节点 RUNNING 且 fake controller 收到 acp:start（含 agent-workflow-tools 装配与节点作用域 token） |
| A13 rejectNode 打回留痕 | 节点 REJECT + rejectInfo，黑板写入「打回-{nodeId}-{序号}」记录，上游 REWORK 且 reworkCount+1 |
| A14 sessions 排除工作流会话 | 默认不含工作流会话；includeWorkflowSessions=true 含（带 workflowInstanceId/workflowNodeId） |
| A15 getCurrentNodeId 作用域 | 节点 token 返回当前 nodeId；普通会话 token 返回 UNAUTHORIZED |
| A16 非 RUNNING 状态提示 | REJECT 状态调用 completeCurrentNode 返回 INVALID_STATE 可读提示 |
| A17 removeBlackboardKey | 移除后黑板无、blackboardTrash 有 |
| A18 权限隔离 | 他人 workflowInstance 查询为 null、列表为空、mutation 报「不存在或无权限」 |

> MCP 工具调用：MCP 传递重构一期后 agent-api 公网 `POST /mcp/*` 入口已下线，平台 MCP 统一经控制器 relay。fake controller 在主 WebSocket 上发 `mcp:request`（`{requestId, sessionId, serverName, token, body}`，body 为 JSON-RPC `tools/call`），按 requestId 匹配 `mcp:response`（带超时与监听器清理，参考 workflow.test.ts 的 `callWorkflowTool`）；token 从 fake controller 收到的 `acp:start.mcpEndpoint.token` 获取。

### ACP Permission Reminder API (`agent-api/permission.test.ts`)

| 测试 | 描述 |
|------|------|
| getTodoList - 无 auth | 应返回「Not authenticated」 |
| getUnreadTodoCount - 无 auth | 应返回「Not authenticated」 |
| getTodoList - 初始为空 | 应返回空数组 |
| getUnreadTodoCount - 初始为 0 | 应返回 0 |
| respondPermission - 无 auth | 应返回「Not authenticated」 |
| markTodoRead - 无 auth | 应返回「Not authenticated」 |
| markAllTodoRead - 无 auth | 应返回「Not authenticated」 |
| updatePermissionTimeout - 无 auth | 应返回「Not authenticated」 |
| updateGlobalPermissionTimeout - 无 auth | 应返回「Not authenticated」 |
| 权限请求流程 - 创建待办 | controller 发送 acp:permission → agent-api 创建待办 → 验证待办内容 |
| 权限请求流程 - 响应请求 | GraphQL respondPermission → controller 收到 acp:permission:response |
| 权限请求流程 - 超时处理 | 60秒未响应 → controller 收到 cancelled |
| 待办管理 - 标记已读 | markTodoRead → 验证 isRead=true |
| 待办管理 - 全部已读 | markAllTodoRead → 验证 unreadCount=0 |
| 超时设置 - 全局设置 | updateGlobalPermissionTimeout → 验证保存成功 |
| 超时设置 - Session 设置 | updatePermissionTimeout → 验证 session.permissionTimeoutAction |

### Admin Auth API (`admin-api/auth.test.ts`)

| 测试 | 描述 |
|------|------|
| 归一化管理员登录态 | ensureAdminLogin → adminMe username=admin、mustChangePassword=false |
| adminMe 无 token | 返回 null（不报错） |
| 伪造/user 侧 token | 返回 null（admin/user token 不可互认，T-A6） |
| 密码错误登录 | 返回「Invalid username or password」（T-A3） |
| 归一化密码登录 | 返回 token，mustChangePassword=false |
| 新密码过短 | 拒绝（T-A5） |
| 旧密码错误 | 拒绝 |
| 改密流程 | 改密成功、旧密码失效、新密码可登录、返回新 token（T-A4） |
| 无注册 mutation | introspection 无 signup/register，含 adminlogin |
| 业务 mutation 无 token | 「Not authenticated」 |

### Admin Global LLM API (`admin-api/llm.test.ts`)

| 测试 | 描述 |
|------|------|
| adminProviders 无 auth | 「Not authenticated」 |
| 业务 mutation 无 auth | 「Not authenticated」 |
| 连通性失败不落库 | T-P1 |
| 创建全局供应商 | scope=global、凭据脱敏、同步 scope=global 模型（T-P2） |
| 全局同名冲突 | 「Provider name already exists」（T-P7） |
| 更新留空保留凭据 | T-P3 |
| 启停级联 + 删除级联 | T-P5 / T-P4 |
| 批量操作空列表 | successCount=0 |
| 全局自定义模型 | 添加/列表/仅自定义可删/禁用供应商下 toggle 拒绝（T-M1~T-M3） |
| 全局模型排序 | T-M4 |

### Admin Base Image API (`admin-api/base-image.test.ts`)

| 测试 | 描述 |
|------|------|
| 无 auth | baseImages / createBaseImage 均「Not authenticated」 |
| CRUD | Dockerfile 原样存取（T-B1） |
| 同名冲突 | 「Base image name already exists」（T-B2） |

### Agent API scope 回归 (`agent-api/llm.test.ts` T-SC*)

| 测试 | 描述 |
|------|------|
| 全局启用模型对用户可见 | models 查询包含 scope=global 且启用模型（T-SC1） |
| 全局供应商不在用户 providers | T-SC5 |
| 跨 scope 同名可并存 | T-SC7 |
| 用户写全局模型/供应商 | 返回「全局配置请在管理后台修改」（T-SC3/T-SC4） |
| 管理员禁用全局供应商后 | 用户 models 不再返回（T-SC1 反向） |

### Cloud Controller 内部 API (`cloud-controller/internal-api.test.ts` T-IC*)

> 需要 cloud-controller 就绪：`aspire start && aspire wait cloud-controller`；服务以 `K8S_ENABLED=false`（InMemoryK8sClient）运行。
> `T-IC5`（合法 workloadIds 回显）、`T-IC6`（按执行顺序返回日志 + params/required）与 `T-ICC1~T-ICC8`（`workloadPlan` 校验/落库/兜底展开/失败映射/required 归一）直写共享 Mongo，需要 `MONGODB_URI`（缺省时 `skipIf` 跳过）。

| 测试 | 描述 |
|------|------|
| T-IC2 鉴权 | 缺失/错误 Bearer 返回 401 |
| T-IC3 非 idle | POST `{purpose: workflow}` 返回 400「该任务类型暂未开放」 |
| T-IC1 全生命周期 | GET 列表 / POST idle（201，`workloadIds: []`、`currentWorkloadName: null`）/ DELETE（200）符合契约附录 A |
| T-IC4 幂等 | DELETE 不存在返回 404；终态容器重复 DELETE 返回 200 |
| T-IC5 workloadIds 校验 | 非数组 / 未知 ID / 超 10 个 → 400 `INVALID_WORKLOAD`；合法已存在 ID → 201 且去重保序回显 |
| T-IC6 工作负载日志 | `GET /internal/containers/:id/workload-logs`：未知容器 404 `NOT_FOUND`；无记录返回 `[]`；直写 Mongo 后按 `createdAt` 升序返回 A.6 字段（含 `required`，历史缺省 `false`） |
| T-IC7 鉴权回归 | 新增 logs 端点缺失 Bearer → 401 |
| T-ICC1 workloadPlan 合法 | POST 携带 `workloadPlan`（含 `required`）→ 201，JSON 回显 `workloadPlan`，`workloadIds` 由 plan 派生 |
| T-ICC2 workloadPlan 非法 | 非数组 / 超 10 条 / 未知 `workloadId` / `params` 非对象 / `implicit` 非布尔 / `required` 非布尔 / 条目非对象 / `workloadId` 缺失或重复 → 400 `INVALID_WORKLOAD` |
| T-ICC3 仅 workloadIds 兜底展开 | 旧客户端仅传 `workloadIds` → 按只读定义后序 DFS 展开（依赖先于依赖方、`implicit=true`、参数取默认值且多选去重、`required=false`）；容器 `workloadIds` 按选择顺序落库（不含隐式依赖），plan 仅用于执行 |
| T-ICC4 plan 优先 | `workloadPlan` 与 `workloadIds` 同时下发 → 以 plan 派生的 `workloadIds` 为准 |
| T-ICC5 plan 条目缺省归一 | `workloadPlan` 条目缺省 `params`/`implicit`/`required` → 归一为 `{}`/`false`/`false`（201，不报错） |
| T-ICC6 兜底展开失败映射 | 仅 `workloadIds` 且展开遇环 / 依赖缺失 / 展开 > 10 → 400 `INVALID_WORKLOAD` |
| T-ICC7 required 归一与校验 | `required` 缺省/`null` → `false`、`true` 保留并回读；非布尔 → 400 `INVALID_WORKLOAD` |
| T-ICC8 兜底 required=false | 仅 `workloadIds` 兜底展开的 plan 条目 `required` 一律 `false` |
| T-IC6 日志 params | 直写 `cloudworkloadlogs.params`/`required` 后按记录返回参数快照与必须标记；历史无 `params` 归一为 `{}`、无 `required` 归一为 `false` |

### Admin Cloud Workload API (`admin-api/cloud-workload.test.ts` T-IA*)

> 需要 admin-api + cloud-controller 就绪：`aspire start && aspire wait admin-api cloud-controller`。
> 日志用例直写共享 Mongo，需要 `MONGODB_URI`（缺省时 `skipIf` 跳过）；控制面不可达的降级分支由 admin-api 单测 `graphql/resolvers/cloud-workload.test.ts` 锚定。

| 测试 | 描述 |
|------|------|
| T-IA 未认证 | 匿名 list/create/update/delete/logs 均「Not authenticated」 |
| T-IA CRUD | 仅 init / 仅 post / 两者创建；列表；编辑（`initScript: null` 清空）；删除；DTO 时间 ISO |
| T-IA 校验边界 | 空名 → `name is required`；超 64 字 → `name must be at most 64 characters`；双空脚本 → `at least one script is required`；脚本 >16 KiB → `initScript/postScript must be at most 16 KiB`；**接受侧**：恰好 64 字符名称 + 恰好 16 KiB 脚本可创建（防 `<`/`≤` 回归） |
| T-IA 重名/不存在 | 创建/改名重名 → `Workload name already exists`；更新不存在 id → `Workload not found`；删除不存在 id → `false` |
| T-IA 日志（控制面可用） | 无记录返回 `[]`；直写 `cloudworkloadlogs` 后按执行顺序返回大写枚举 + 脚本快照 + 输出 |
| T-IA 启动携带 workloadIds | 合法 ID 按选择顺序返回 `workloads`；未知 ID → 错误含 `INVALID_WORKLOAD`；缺省不挂载（`workloads: []`） |
| T-IA paramSchema CRUD | 四种类型（SELECT/MULTI_SELECT/TEXT/BOOLEAN）保存与回显；非下拉类型 `options` 归一为 `[]`；编辑改默认值；`paramSchema: []` 清空（空表单无配置） |
| T-IA paramSchema 校验边界 | key 非法/重复、label 空/超长、options 空/重复/超限、默认值不在 options/类型不符 → 字段路径错误（`paramSchema[i].xxx is invalid`）；参数 >20 → `too many parameters` |
| T-IA 依赖保存 | 正常（按配置顺序、去重）、自依赖 `workload cannot depend on itself`、依赖环 `dependency cycle detected`、依赖不存在 `dependency workload not found`、超 5 `too many dependencies` |
| T-IA 预制项存在性与幂等 | Docker/Node.js/.NET/Aspire 存在且 `isPreset=true`；Aspire 依赖 `[Docker, .NET]`；Node.js 参数（`version` TEXT 默认 `22`、`package_manager` MULTI_SELECT 默认 `["npm"]`）；重复查询 ID 集合稳定（迁移不重复写入） |
| T-IA 预制 Aspire 代理下载 | 预制「Aspire」`paramSchema` 含 `aspire_cli_url`（TEXT 默认 = 内网缓存代理安装包直链 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`）；`initScript` 含 `curl -fsSL`/`tar -xzf` 直连下载解压，**不含** `install.sh`/`aspire.dev`/`aka.ms`/`ASPIRE_INSTALL_URL`（迁移 004 升级结果，脚本内不内置默认地址）；重复查询预制项 ID 集合稳定 |
| T-IA 日志 params | 直写 `cloudworkloadlogs.params` 后按执行顺序返回参数快照；历史无 `params` 归一为 `{}` |

### Cloud Controller Worker 握手 (`cloud-controller/worker-handshake.test.ts` T-IW*)

| 测试 | 描述 |
|------|------|
| T-IW1 缺失 token | 连接 `/worker` 无 token → `connect_error`（INVALID_TOKEN） |
| T-IW1 伪造 token | 携带伪 token → `connect_error`（INVALID_TOKEN） |

> 合法 token 的完整握手/注册/销毁由 cloud-controller 单测（真实 socket.io-client）与部署侧真实集群验收覆盖（合法 token 仅在进程内签发，外部不可取得）。

### Admin 云端容器 API (`admin-api/cloud-container.test.ts` T-IA*)

| 测试 | 描述 |
|------|------|
| T-IA5 未认证 | 匿名 list/start/destroy 均返回「Not authenticated」 |
| T-IA1 列表 | `adminCloudContainers` 经控制面代理返回数组 |
| T-IA6 非 idle | `adminStartCloudContainer(WORKFLOW)` 返回「该任务类型暂未开放」 |
| T-IA3/T-IA4 启停 | start idle → 列表可见 → destroy 返回 true 且状态收敛为 EXITED |
| T-IA7 workloadIds | start 携带 `workloadIds` → `workloads` 按提交顺序返回；列表同样返回 `workloads`/`currentWorkloadName` |
| T-IA8 未知 workloadId | start 携带不存在 ID → 错误含 `INVALID_WORKLOAD` |
| T-IA9 缺省不挂载 | start 不传 `workloadIds` → `workloads: []`、`currentWorkloadName: null` |
| T-IA10 隐式依赖展开 | 仅选依赖方 → `workloads` 依赖在前（后序 DFS）；落库 `workloadPlan` 隐式项取默认参数（`implicit=true`）、`workloadIds` 由 plan 派生 |
| T-IA11 显式参数优先 | 同时显式选择依赖与依赖方 → 依赖只出现一次且使用显式参数（`implicit=false`） |
| T-IA12 展开超限 | 链式依赖展开为 11 条 → 错误 `expanded workloads exceed 10` |
| T-IA13 非法参数 | 未知参数 → `unknown parameter: <key>`；类型/取值非法 → `invalid value for parameter <key>` |
| T-IA14 重复选择 | 同一 `workloadId` 重复 → `duplicate workload selection` |
| T-IA15 二选一 | `workloadIds` 与 `workloads` 同时非空 → `workloadIds and workloads cannot both be provided` |
| T-IA16 未知显式选择 | `workloads` 含不存在 ID → `workload not found` |
| T-IA17 依赖被删 | 依赖在配置后被删除 → 启动报 `dependency workload not found` |
| T-IA18 日志 params | 直写 `cloudworkloadlogs.params` 后经 `adminCloudContainerWorkloadLogs` 返回参数快照 |
| T-IA 预制 .NET apt | 预制 `.NET` 的 `initScript` 为 apt 版（含 `apt-get install`/`dotnet10`，不含 `dotnet-install.sh`；迁移 002 升级结果） |
| T-IA 日志 required | 直写 `cloudworkloadlogs.required` 后经 `adminCloudContainerWorkloadLogs` 返回必须标记；历史缺省 `false` |
| T-IA-REQ 启动 required 透传 | `adminStartCloudContainer(workloads[].required)` 透传并落库（缺省 `false`、非布尔容错）；仅 `workloadIds` 兼容路径 `required` 一律 `false` |

### Billing 计费 API（费用中心）

> 计费事件骨干经 RabbitMQ；`billing-events` 直断言 `billingoutbox`，需要 `MONGODB_URI`（缺省时 `skipIf` 跳过）。
> 网关/前台计费套件需要 admin-api / agent-api / cloud-controller 就绪：`aspire start && aspire wait admin-api agent-api cloud-controller`。

#### Cloud Controller 计费事件 (`cloud-controller/billing-events.test.ts` T-CC-B*)

| 测试 | 描述 |
|------|------|
| T-CC-B4/B8 | 创建容器携带 `billingAccountId`，列表/详情 A.3 计费字段透出 |
| T-CC-B7 | DELETE 带 `reason` 写入 `exitReason` |
| T-CC-B11 | 已计费容器销毁后 `billingoutbox` 落一条 `container.destroyed`（需 `MONGODB_URI`） |

#### Admin 计费网关 (`admin-api/billing-gateway.test.ts` T-B2*)

| 测试 | 描述 |
|------|------|
| T-B21 | GET `/v1/models` 返回 OpenAI list 信封（形状） |
| T-B29 | 无效 Key 401 `invalid_api_key` |
| T-B26 | 缺参数 400、未知模型 404 |
| T-B27 | GET `/v1/models` 仅返回**计费且定价完整**的全局模型（过滤逻辑被断言，需 `MONGODB_URI` 直写模型） |
| T-B28 | 未定价（`pricing:null` 与全 0 档）模型 400 `model_not_priced`（需 `MONGODB_URI`） |
| T-B24 | 冻结账户调用非计费模型同样 402 `account_frozen` |

#### Admin 计费 GraphQL+内部 REST (`admin-api/billing.test.ts` T-B*)

| 测试 | 描述 |
|------|------|
| T-B* | 账户/账单/收据/充值/ApiKey 全链路与鉴权、幂等、错误映射 |

### 前台云电脑（harness）

| 文件 | 说明 |
|------|------|
| `tests/api/src/agent-api/cloud-host.test.ts` | `cloudHostCapabilities`（`HARNESS_ENABLED=true` 才运行）、创建/校验/1 实例/属主隔离/停止/删除/软删除/`Controller.cloudHost`/鉴权 |
| `tests/api/src/agent-api/cloud-host-callback.test.ts` | 内部 ready（单 harness 默认会话、多 harness 不建、幂等）、terminal（会话 ENDED/幂等）、鉴权/404（需 `INTERNAL_API_TOKEN` + `MONGODB_URI`） |
| `tests/api/src/agent-api/session-readonly.test.ts` | 停止后 resume 返回 `session is ended`；非 RUNNING 云电脑 createSession 拒绝（需 `MONGODB_URI`） |

> `K8S_ENABLED=false` 下无法产生真实 RUNNING 容器；在线、OpenCode ACP、真实默认会话链路由单测 + 真实集群手工验收覆盖，不引入测试后门。

#### Agent 前台计费 (`agent-api/billing.test.ts` T-MB*)

| 测试 | 描述 |
|------|------|
| T-MB* | 我的费用：账户派生自登录主体、账单/收据/调用记录/汇总、API Key 管理 |
