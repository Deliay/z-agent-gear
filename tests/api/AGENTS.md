# API Tests

## Prerequisites

- [Aspire CLI](https://aspire.dev) installed
- Docker running (for MongoDB container)

## 启动服务

```bash
# 启动 Aspire 编排（在项目根目录）
aspire start --apphost aspire/AgentGear.AppHost

# 等待后端服务就绪
aspire wait agent-api --apphost aspire/AgentGear.AppHost
```

## 获取 API 端点

```bash
# 查看 agent-api 的地址
aspire describe agent-api --apphost aspire/AgentGear.AppHost
```

输出中查找 `agent-api` 的 URL，例如 `http://localhost:4000`。

## 运行测试

```bash
API_URL=http://localhost:4000/graphql npm test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_URL` | GraphQL API 完整地址 | `http://localhost:4000/graphql` |

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
