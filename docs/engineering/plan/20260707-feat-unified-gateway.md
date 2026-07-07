---
description: 统一网关功能 - 实现计划
type: Permanent
---

# 统一网关功能 - 实现计划

**关联 Proposal**: `proposals/20260707-feat-unified-gateway.md`
**创建日期**: 2026-07-07
**更新日期**: 2026-07-07

## 核心原理

统一网关是对现有端口转发功能的**产品升级**：从"暴露端口"变为"暴露服务"。底层隧道机制（Socket.IO 反向隧道、Redis Pub/Sub 内部通信）保持不变，主要在 API 层和前端进行改造。

**请求链路**：`外部用户 → agent-api(代理, 按服务名查端口) → Redis Pub/Sub → controller-api(中继) → Socket.IO → agent-controller(隧道) → localhost:port`

## 关键设计变更

| 维度 | 旧（端口转发） | 新（统一网关） |
|------|---------------|---------------|
| 标识方式 | 端口号 | 服务名称 + 端口号 |
| GraphQL | `PortForward` / `createPortForward(port)` | `Gateway` / `createGateway(name, port)` |
| REST 代理 | `/api/forward/:cid/:port/*` | `/api/gateway/:cid/:name/*` |
| 删除标识 | 按 port 删除 | 按 name 删除 |
| 内部通信 | `port-forward:*`（事件/频道） | 保持原名，不改 |

## 实现顺序

```
Phase 1: 数据模型变更 (MongoDB + 迁移脚本)
  └── Phase 2: 更新 API 契约 (Gateway contract)
       └── Phase 3: agent-api 服务层 + GraphQL (gateway service + schema + resolver)
            └── Phase 4: agent-api 代理路由 (gateway-proxy route)
                 └── Phase 5: controller-api 中继服务重命名 (gateway-relay)
                      └── Phase 6: agent-controller 隧道管理器重命名 (gateway manager)
                           └── Phase 7: 前端组件重命名 + 升级 (gateway components)
                                └── Phase 8: 测试覆盖 (单元 + API + E2E)
```

## 命令参考

```bash
# 启动全部服务
aspire start

# 运行单元测试
cd servers/agent-api && npx vitest run --reporter=verbose
cd servers/controller-api && npx vitest run --reporter=verbose
cd packages/agent-controller && npx vitest run --reporter=verbose

# 运行 API 测试
cd tests/api && npx vitest run src/agent-api/gateway.test.ts

# 运行 E2E 测试
cd tests/e2e && npx playwright test src/gateway.spec.ts

# 类型检查
cd servers/agent-api && npx tsc --noEmit
cd servers/controller-api && npx tsc --noEmit
cd packages/agent-controller && npx tsc --noEmit
cd apps/agent-web && npx tsc --noEmit
```

---

## Phase 1: 数据模型变更

### 说明

将 `PortForward` model 改造为 `Gateway` model，增加 `name` 字段，变更唯一索引。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/port-forward.ts` | 删除 | 原模型 |
| `servers/agent-api/src/models/gateway.ts` | 新增 | 新模型，含 name 字段 |

### 模型变更要点

```typescript
// 新增字段
name: { type: String, required: true }

// 唯一索引变更
// 删除: { controllerId: 1, port: 1 }
// 新增: { controllerId: 1, name: 1 }, { unique: true }
```

### 数据迁移

```typescript
// 对现有 portforwards 集合执行迁移：
// 为每条记录生成 name = "port_${port}"
// 如有冲突则添加后缀 "port_${port}_${counter}"
```

### 验证

- [ ] 新模型编译通过
- [ ] 唯一索引 `{controllerId, name}` 正常

---

## Phase 2: 更新 API 契约

### 说明

更新 GraphQL 和 REST 契约文件。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/port-forward.graphql` | 删除 | 原契约 |
| `contracts/gateway.graphql` | 新增 | Gateway 管理契约 |
| `contracts/port-forward-proxy.openapi.yaml` | 删除 | 原代理契约 |
| `contracts/gateway-proxy.openapi.yaml` | 新增 | Gateway 代理契约 |

### GraphQL 契约

```graphql
type Gateway {
  id: ID!
  controllerId: ID!
  name: String!
  port: Int!
  status: String!
  createdAt: String!
}

type GatewayList {
  gateways: [Gateway!]!
  total: Int!
  limit: Int!
}

type Query {
  gateways(controllerId: ID!): GatewayList!
}

type Mutation {
  createGateway(controllerId: ID!, name: String!, port: Int!): Gateway!
  deleteGateway(controllerId: ID!, name: String!): Boolean!
}
```

### REST 代理契约

- 路径: `/api/gateway/{controllerId}/{name}/{path}`
- 方法: ANY
- 认证: Bearer token
- 响应: 透传本地服务响应

### 验证

- [ ] 契约文件评审通过

---

## Phase 3: agent-api 服务层 + GraphQL

### 说明

重命名 GraphQL 类型和操作，GatewayService 增加 name 相关逻辑。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/port-forward.ts` | 删除 | 原服务 |
| `servers/agent-api/src/services/gateway.ts` | 新增 | GatewayService |
| `servers/agent-api/src/graphql/schemas/port-forward.ts` | 删除 | 原 schema |
| `servers/agent-api/src/graphql/schemas/gateway.ts` | 新增 | Gateway schema |
| `servers/agent-api/src/graphql/resolvers/port-forward.ts` | 删除 | 原 resolver |
| `servers/agent-api/src/graphql/resolvers/gateway.ts` | 新增 | Gateway resolver |
| `servers/agent-api/src/graphql/schemas/index.ts` | 修改 | 更新 import |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 更新 import |

### GatewayService 业务逻辑

**createGateway(controllerId, userId, name, port, maxPerController)**：
1. 验证身份
2. 查询 Controller，验证存在且 `status === 'online'`
3. 查询 `Gateway.countDocuments({ controllerId }) < maxPerController`（数量限制）
4. 查询 `Gateway.findOne({ controllerId, name })` 是否已存在（名称唯一性）
5. 创建记录 `{ controllerId, userId, name, port, status: 'active' }`
6. Redis PUBLISH `port-forward:command` → `{ type: 'tunnel:create', controllerId, port }`

**deleteGateway(controllerId, userId, name)**：
1. 验证身份
2. 按 `{ controllerId, name }` 查找并删除
3. 从删除的记录中获取 `port`
4. Redis PUBLISH `port-forward:command` → `{ type: 'tunnel:close', controllerId, port }`

### 验证

- [ ] `createGateway` 创建成功，返回含 name 的记录
- [ ] 名称重复时返回错误
- [ ] 数量超限时返回错误
- [ ] `deleteGateway` 按名称删除成功
- [ ] 所有单元测试通过

---

## Phase 4: agent-api 代理路由

### 说明

将代理路由从 `/api/forward/:controllerId/:port/*` 改为 `/api/gateway/:controllerId/:name/*`。代理逻辑先按 name 查 port，后续流程不变。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/port-forward-proxy.ts` | 删除 | 原路由 |
| `servers/agent-api/src/routes/gateway-proxy.ts` | 新增 | Gateway 代理路由 |
| `servers/agent-api/src/index.ts` | 修改 | 更新 import |

### 代理路由逻辑

```typescript
router.all('/gateway/:controllerId/:name/*', async (req, res) => {
  // 1. 验证 Bearer token
  const user = await authenticateExpressUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  // 2. 按 controllerId + name 查询 Gateway 记录
  const record = await Gateway.findOne({ controllerId, name, status: 'active' });
  if (!record) { res.status(404).json({ error: 'Gateway not found' }); return; }

  // 3. 取出 port，后续流程不变（Redis Pub/Sub + 隧道）
  const port = record.port;
  // ... 原有代理逻辑 ...
});
```

### 验证

- [ ] `GET /api/gateway/:controllerId/:name/path` 正常代理
- [ ] 未认证返回 401
- [ ] 不存在返回 404

---

## Phase 5: controller-api 中继服务重命名

### 说明

`PortForwardRelayService` → `GatewayRelayService`，代码内部重命名。内部事件名和频道名不变。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/port-forward.ts` | 删除 | 原服务 |
| `servers/controller-api/src/services/gateway-relay.ts` | 新增 | GatewayRelayService |
| `servers/controller-api/src/services/socketio.ts` | 修改 | 更新 import + 方法名 |
| `servers/controller-api/src/index.ts` | 修改 | 更新 import |

### 变更要点

- Class 名: `PortForwardRelayService` → `GatewayRelayService`
- 方法、属性名同理
- Redis 频道 `port-forward:command` / `port-forward:response` **不变**
- Socket.IO 事件 `port-forward:*` **不变**

### 验证

- [ ] 重命名后编译通过
- [ ] 隧道创建/关闭功能正常
- [ ] 代理请求中继正常

---

## Phase 6: agent-controller 隧道管理器重命名

### 说明

`PortForwardManager` → `GatewayManager`，代码内部重命名。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/port-forward.ts` | 删除 | 原管理器 |
| `packages/agent-controller/src/gateway.ts` | 新增 | GatewayManager |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 更新 import |

### 变更要点

- Class 名: `PortForwardManager` → `GatewayManager`
- export 名: `portForwardManager` → `gatewayManager`
- Socket.IO 事件名 `port-forward:*` **不变**

### 验证

- [ ] 重命名后编译通过
- [ ] 隧道连接/数据传输正常

---

## Phase 7: 前端组件重命名 + 升级

### 说明

前端组件全部重命名，Dialog 增加服务名称输入，Sidebar 恢复入口并改为"统一网关"。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/PortForwardSection.tsx` | 删除 | 原组件 |
| `apps/agent-web/src/components/GatewaySection.tsx` | 新增 | 网关 section |
| `apps/agent-web/src/components/PortForwardDialog.tsx` | 删除 | 原组件 |
| `apps/agent-web/src/components/GatewayDialog.tsx` | 新增 | 网关 dialog（增加名称输入） |
| `apps/agent-web/src/components/PortForwardItem.tsx` | 删除 | 原组件 |
| `apps/agent-web/src/components/GatewayItem.tsx` | 新增 | 网关 item（展示名称 + 端口） |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 取消注释，引入 GatewaySection |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | `GET_PORT_FORWARDS` → `GET_GATEWAYS` |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 更新 mutation 名和变量 |
| `apps/agent-web/src/graphql/types.ts` | 修改 | `PortForwardData` → `GatewayData` |

### GatewayDialog 交互变更

```typescript
// 新增 name 输入
<input
  type="text"
  placeholder="服务名称 (如 my-api)"
  value={name}
  onChange={(e) => setName(e.target.value)}
/>

// 新增名称格式校验
if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
  setError('仅支持字母、数字、中划线和下划线');
  return;
}
if (name.length < 1 || name.length > 50) {
  setError('名称长度 1-50 字符');
  return;
}

// mutation 变更
createGateway({ variables: { controllerId, name, port: portNum } });
```

### GatewayItem 展示变更

```typescript
// 以名称为主展示
<span className="flex-1 truncate">{gateway.name}</span>
<span className="text-xs text-muted-foreground">:{gateway.port}</span>
```

### Sidebar.tsx 修改

```typescript
// 取消注释，替换为 GatewaySection
{controller.status === 'online' && (
  <li>
    <GatewaySection controllerId={controller.id} />
  </li>
)}
```

### 验证

- [ ] 侧边栏显示"统一网关"分类
- [ ] 创建对话框含名称输入 + 端口输入
- [ ] 列表项以服务名称为主展示
- [ ] 一键复制访问地址正常
- [ ] TypeScript 编译无错误

---

## Phase 8: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/port-forward.test.ts` | 删除 | 原测试 |
| `packages/agent-controller/src/gateway.test.ts` | 新增 | GatewayManager 测试 |
| `servers/agent-api/src/services/port-forward.test.ts` | 删除 | 原测试 |
| `servers/agent-api/src/services/gateway.test.ts` | 新增 | GatewayService 测试 |
| `servers/agent-api/src/graphql/resolvers/port-forward.test.ts` | 删除 | 原测试 |
| `servers/agent-api/src/graphql/resolvers/gateway.test.ts` | 新增 | Gateway resolver 测试 |
| `servers/controller-api/src/services/port-forward.test.ts` | 删除 | 原测试 |
| `servers/controller-api/src/services/gateway-relay.test.ts` | 新增 | GatewayRelayService 测试 |
| `tests/api/src/agent-api/port-forward.test.ts` | 删除 | 原测试 |
| `tests/api/src/agent-api/gateway.test.ts` | 新增 | 更新 API 测试 |
| `tests/e2e/src/port-forward.spec.ts` | 删除 | 原测试 |
| `tests/e2e/src/gateway.spec.ts` | 新增 | 更新 E2E 测试 |

### 单元测试覆盖

| 类型 | 文件 | 场景数 | 说明 |
|------|------|--------|------|
| 隧道管理 | `packages/agent-controller/src/gateway.test.ts` | 10 | create/close/error/data |
| 业务服务 | `servers/agent-api/src/services/gateway.test.ts` | 12 | CRUD + 名称唯一性 + 数量限制 + 格式校验 |
| GraphQL | `servers/agent-api/src/graphql/resolvers/gateway.test.ts` | 7 | 认证 + CRUD + 错误传播 |
| 中继服务 | `servers/controller-api/src/services/gateway-relay.test.ts` | 11 | 隧道创建/关闭 + 代理请求 |

### API 测试覆盖

| 类型 | 文件 | 场景数 | 说明 |
|------|------|--------|------|
| GraphQL API | `tests/api/src/agent-api/gateway.test.ts` | 12 | 未认证/不存在/离线/成功创建/名称重复/列表/删除/按名称删除 |

### E2E 测试覆盖

| 类型 | 文件 | 场景数 | 说明 |
|------|------|--------|------|
| Playwright | `tests/e2e/src/gateway.spec.ts` | 9 | 可见性/空状态/创建对话框/创建暴露/重复名称/删除/取消 |

### 新增测试场景

| 场景 | 验证点 |
|------|--------|
| 创建暴露含名称 | `createGateway(name, port)` 成功 |
| 名称重复 | 同一 controller 下重复名称返回错误 |
| 名称格式非法 | 特殊字符返回错误 |
| 按名称删除 | `deleteGateway(controllerId, name)` 成功 |
| 按名称代理 | `GET /api/gateway/:cid/:name/path` 正常返回 |

### 验证

- [ ] 所有单元测试通过
- [ ] 所有 API 测试通过
- [ ] E2E 测试通过

---

## 验收 Checklist

- [ ] Phase 1: 数据模型变更完成 + 迁移脚本
- [ ] Phase 2: 契约文件更新完成
- [ ] Phase 3: `createGateway(name, port)` 正常工作
- [ ] Phase 3: `deleteGateway(name)` 正常工作
- [ ] Phase 3: 名称唯一性和格式校验正常
- [ ] Phase 4: `GET /api/gateway/:cid/:name/*` 正常代理
- [ ] Phase 4: 代理路由鉴权正常
- [ ] Phase 5: controller-api 重命名后功能正常
- [ ] Phase 6: agent-controller 重命名后隧道正常
- [ ] Phase 7: 侧边栏"统一网关"入口正常显示
- [ ] Phase 7: Dialog 含名称输入框
- [ ] Phase 7: 列表展示服务名称
- [ ] Phase 8: 全部测试通过
