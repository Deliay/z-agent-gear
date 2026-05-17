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
