# API Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed

## 启动服务

> **注意**: 只允许使用 Aspire 编排服务，禁止直接使用 Docker 命令。

```bash
# 启动 Aspire 编排（在项目根目录）
aspire start

# 等待后端服务就绪
aspire wait agent-api
```

## 获取 API 端点

```bash
# 查看 agent-api 的地址
aspire describe agent-api
```

输出中查找 `agent-api` 的 URL，例如 `http://localhost:4000`。

## 运行测试

```bash
# 获取各服务 endpoint
API_URL="$(aspire describe agent-api 2>/dev/null | tr -d '\000-\037\177-\237' | grep -oP 'http://localhost:\d+' | head -1)/graphql"
CONTROLLER_API_URL="$(aspire describe controller-api 2>/dev/null | tr -d '\000-\037\177-\237' | grep -oP 'http://localhost:\d+' | head -1)"

API_URL=$API_URL CONTROLLER_API_URL=$CONTROLLER_API_URL npm test

## 测试脚本

| 脚本 | 说明 |
|------|------|
| `npm test` | 运行 8 个常规测试文件（并行，不含 `acp-real-*`） |
| `npm run test:real` | 仅运行 `acp-real-*` 测试（串行，超时 30s） |
| `npm run test:all` | 先运行 `acp-real-*` 再运行常规测试 |

> **注意**: `acp-real-*` 测试会启动真实的 agent-controller 进程，共享 PID 文件 `/tmp/agent-controller.pid` 和端口 34519，因此必须串行执行，且需要干净数据库状态。
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_URL` | agent-api GraphQL 完整地址 | `http://localhost:4000/graphql` |
| `CONTROLLER_API_URL` | controller-api 服务地址 | `http://localhost:4001` |

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
