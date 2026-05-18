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

> 注意: `agent-web` 端口由 Aspire 动态分配，请在 `aspire describe` 输出中查看实际端口。

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
| 导航显示控制器管理 | 设置页导航显示「控制器」和「控制器管理」 |
| controller section 布局 | 显示「控制器管理」标题、「控制器 Key」和「控制器列表」两个卡片 |
| Key 卡片空状态 | 显示「生成 Key」按钮和空状态文字 |
| 控制器卡片空状态 | 显示「暂无控制器连接」空状态文字 |
| 打开生成 Key 对话框 | 点击「生成 Key」→ 弹出对话框，显示名称输入 |
| 空名称时生成按钮禁用 | 对话框中名称为空时「生成」按钮为 disabled |
| 取消关闭生成对话框 | 点击取消 → 对话框关闭 |
| 生成 Key 并显示 rawKey | 输入名称 → 点击生成 → 显示「Key 已生成」对话框 |
| 生成后 Key 出现在列表 | 生成后列表显示新 Key（名称、活跃状态、local 类型） |
| 活跃 Key 显示撤销按钮 | 活跃状态的 Key 显示「撤销」按钮 |
| Key 显示重命名按钮 | 每个 Key 显示「重命名」按钮 |
| 导航滚动到 controller section | 点击「控制器管理」→ 滚动到 controller section |
| 侧边栏导航到设置页 | 点击侧边栏设置链接 → 显示 controller section |
