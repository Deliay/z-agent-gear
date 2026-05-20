# E2E Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed
- Docker running (for MongoDB container)

## 启动服务

```bash
# 启动 Aspire 编排（在项目根目录）
aspire start

# 等待前后端服务就绪
aspire wait agent-api
aspire wait agent-web
```

## 获取前端地址

```bash
# 查看 agent-web 的地址
aspire describe agent-web
```

输出中查找 `agent-web` 的 `http` URL，例如 `http://localhost:35273`。

## 运行测试

```bash
BASE_URL=http://localhost:35273 npx playwright test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BASE_URL` | 前端应用地址 | `http://localhost:35273` |
| `API_URL` | agent-api GraphQL 地址 | `http://localhost:4000/graphql` |
| `CONTROLLER_API_URL` | controller-api Socket.IO 地址 | `http://localhost:4001` |

> 注意: 所有端口由 Aspire 动态分配，请在 `aspire describe` 输出中查看实际端口。

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
| 导航显示控制器管理 | 设置页导航显示「控制器」和「控制器管理」 |
| controller section 布局 | 显示「控制器管理」标题和「控制器」卡片 |
| controller section 空状态 | 显示「生成 Key」按钮和「暂无控制器」空状态文字 |
| controller 卡片空状态 | 显示「暂无控制器」空状态文字 |
| 生成 Key 并显示在列表 | 点击「生成 Key」→ 列表出现新 Key（等待连接 + local 标签） |
| 生成的 Key 显示复制按钮 | 生成 Key 后显示「复制」按钮 |
| 导航滚动到 controller section | 点击「控制器管理」→ 滚动到 controller section |

### Settings Workspace E2E (`settings-workspace.spec.ts`)

| 测试 | 描述 |
|------|------|
| 管理工作区按钮可见 | 在线 controller 显示「管理工作区」按钮 |
| 打开工作区管理对话框空状态 | 点击按钮 → 对话框显示「暂无工作区」|
| 通过 API 添加工作区并显示 | GraphQL 创建工作区 → 对话框显示工作区路径 |
| 从对话框删除工作区 | 点击删除 → 工作区移除 |
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
