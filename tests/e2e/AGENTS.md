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
# 获取各服务 endpoint
ASP_REM_BASE_URL=$(aspire describe agent-web 2>/dev/null | grep -oP 'http://localhost:\d+' | sort -u | head -1)
ASP_REM_AGENT_API=$(aspire describe agent-api 2>/dev/null | grep -oP 'http://localhost:\d+' | sort -u | head -1)
ASP_REM_CONTROLLER_API=$(aspire describe controller-api 2>/dev/null | grep -oP 'http://localhost:\d+' | sort -u | head -1)
API_URL="${ASP_REM_AGENT_API}/graphql"
CONTROLLER_API_URL="${ASP_REM_CONTROLLER_API}"
BASE_URL="${ASP_REM_BASE_URL}"

API_URL=$API_URL CONTROLLER_API_URL=$CONTROLLER_API_URL BASE_URL=$BASE_URL npx playwright test
```

### 4. 重新运行测试

如果需要重新运行测试，必须从**步骤 1** 开始，重新运行 Aspire 实例。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BASE_URL` | 前端应用地址 | `http://localhost:35273` |
| `API_URL` | agent-api GraphQL 地址 | `http://localhost:4000/graphql` |
| `CONTROLLER_API_URL` | controller-api Socket.IO 地址 | `http://localhost:4001` |

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
