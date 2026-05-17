# E2E Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed
- Docker running (for MongoDB container)

## 启动服务

```bash
# 启动 Aspire 编排（在项目根目录）
aspire start --apphost aspire/AgentGear.AppHost

# 等待前后端服务就绪
aspire wait agent-api --apphost aspire/AgentGear.AppHost
aspire wait agent-web --apphost aspire/AgentGear.AppHost
```

## 获取前端地址

```bash
# 查看 agent-web 的地址
aspire describe agent-web --apphost aspire/AgentGear.AppHost
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
