---
description: 会话消息历史优化 & 响应压缩 - 实现计划
type: Permanent
---

# 会话消息历史优化 & 响应压缩 - 实现计划

**关联 Proposal**: `proposals/20260524-feat-session-message-history-optimization.md`
**创建日期**: 2026-05-24

## 实现顺序

```
Phase 0: Contract 确认（已完成）
  └── Phase 1: 数据模型变更（agent-api + controller-api AcpMessage model）
       └── Phase 2: controller-api 写入端改造（acp-session-manager）
            └── Phase 3: agent-api 写入端改造（session.ts + session-import.ts）
                 └── Phase 4: agent-api sessionMessages 双阶段过滤
                      └── Phase 5: 迁移框架（runner + 001-unify-content-format）
                           └── Phase 6: Brotli 压缩中间件
                                └── Phase 7: 前端兼容改造（MessageList.tsx）
                                     └── Phase 8: API 测试 + 验收
```

依赖关系：Phase 1-7 可部分并行，但 Phase 4 依赖 Phase 1（content 变为 Mixed 后才能查询 `content.sessionUpdate`），Phase 5 依赖 Phase 1。Phase 6/7 与后端其余工作无强依赖。

---

## Phase 0: Contract 确认

### 状态: ✅ 已完成

| 文件 | 状态 |
|------|------|
| `contracts/agent-session.graphql` | `scalar JSON` 已添加，`AcpMessage.content: JSON!` 已更新 |
| `servers/agent-api/src/graphql/schemas/session.ts` | 同步更新 |
| `servers/agent-api/src/graphql/resolvers/index.ts` | `JSON: GraphQLJSON` 已添加 |
| `graphql-type-json` | 已安装 |

---

## Phase 1: 数据模型变更

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/acp-message.ts` | 修改 | `content: String` → `content: Mixed` |
| `servers/controller-api/src/models/acp-message.ts` | 修改 | `content: String` → `content: Mixed` |

### 修改要点

两个模型同步修改，保持 ODM 定义一致：

```typescript
// 修改前
content: { type: String, required: true }

// 修改后
content: { type: mongoose.Schema.Types.Mixed, required: true }
```

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit
cd servers/controller-api && npx tsc --noEmit
```

---

## Phase 2: controller-api 写入端改造

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | 写入端存 JSON 对象而非 JSON.stringify |

### 修改要点

**`sendMessage` 方法（~L161）**:
- `rawContent = JSON.stringify({ ... })` → `rawContent = { ... }`（直接存对象）

**`handleControllerMessage` 方法（~L229）**:
- `rawContent = JSON.stringify(message)` → `rawContent = message`（直接存对象）

**Redis publish（~L176-183, L264-271）**:
- Redis 消息仍需要序列化，content 需做分支处理：
  ```typescript
  content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
  ```

### 启动 & 验证

```bash
cd servers/controller-api && npx tsc --noEmit && npm run test
```

---

## Phase 3: agent-api 写入端改造

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/session.ts` | 修改 | `addMessage` content 写入前做 JSON.parse |
| `servers/agent-api/src/services/session-import.ts` | 修改 | 导入流程 content 直接存储（ACP 返回已是对象） |

### 修改要点

**`session.ts` — `addMessage` 方法（~L193）**:
```typescript
// 写入前解析
content: typeof message.content === 'string'
  ? JSON.parse(message.content)
  : message.content,
```

**`session.ts` — `mapMessage` 方法（~L323）**:
- content 字段直接透传，不再做额外处理

**`session-import.ts` — `importSessions`（~L117-122）**:
- ACP SDK 返回的 msg.content 已为对象，直接存储即可
- 保持 `content: msg.content` 不变（确认 SDK 类型）

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit && npm run test
```

---

## Phase 4: agent-api sessionMessages 双阶段过滤

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/session.ts` | 修改 | `getMessages` 实现 Query A + Query B 双阶段过滤 |

### 修改要点

**`getMessages` 方法替换为双阶段逻辑**:

1. **Query A**: `find({ sessionId, 'content.sessionUpdate': 'usage_update' }, { _id: 1 }).sort({ _id: -1 }).limit(3)`
2. 判断 `result.length === 3`，取 `result[2]._id` 作为截断点
3. **Query B**: 有截断点时 `find({ sessionId, _id: { $gt: cutoff } })`，否则 `find({ sessionId })`
4. 返回结果仍支持 `skip(offset).limit(limit)` 参数

**边界情况**：
- usage_update ≤ 3 条 → 直接返回全部消息，不过滤
- 所有消息均为 usage_update → 仅返回最后 2 条（截断后保留 ≤ 3）
- 过滤后返回 0 条 → 返回空数组
- 消息列表为空 → 返回空数组

### 新增索引（可选优化）

```javascript
// MongoDB 中创建，优化 Query A 性能
db.acpmessages.createIndex({ sessionId: 1, "content.sessionUpdate": 1 })
```

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit && npm run test
```

辅助验证：通过 GraphQL playground 查询 `sessionMessages(sessionId: "...")` 检查过滤结果。

---

## Phase 5: 迁移框架

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/migrations/models.ts` | 新建 | `migrations` 集合模型 |
| `servers/agent-api/src/migrations/runner.ts` | 新建 | 迁移框架（分布式锁 + 执行业务） |
| `servers/agent-api/src/migrations/001-unify-content-format.ts` | 新建 | content 格式统一迁移脚本 |
| `servers/agent-api/src/index.ts` | 修改 | MongoDB 连接后调用 `runMigrations` |

### `migrations/models.ts` 设计

```typescript
import mongoose from 'mongoose';

const migrationsSchema = new mongoose.Schema({
  name: { type: String, unique: true, sparse: true },
  executedAt: { type: Date },
  // 锁文档字段
  _lock: { type: String, sparse: true },
  acquired: { type: Date },
  expiresAt: { type: Date },
});

export const Migrations = mongoose.model('Migrations', migrationsSchema);
```

### `runner.ts` 逻辑

- `acquireLock()`: `findOneAndUpdate({ _lock: 'migration_lock' }, { $setOnInsert: ... }, { upsert: true })` — 通过 upsert 唯一键冲突检测分布式锁
- 锁获取成功 → 查询已执行列表 → 遍历迁移脚本 → 跳过已执行的 → 执行未执行的 → 记录执行记录 → 释放锁
- 锁获取失败 → 记录日志，正常启动
- 迁移失败 → 记录错误日志，不阻断启动

### `001-unify-content-format.ts` 逻辑

- 批量扫描 `type: 'text'` 且 `content` 为 `$type: 'string'` 的记录
- 每批 100 条，`JSON.parse(content)` → `bulkWrite` 更新为对象
- 分批直到无待处理记录

### `index.ts` 修改

```typescript
// MongoDB 连接成功后
import { runMigrations } from './migrations/runner.js';
import * as migration001 from './migrations/001-unify-content-format.js';

try {
  await runMigrations([migration001]);
} catch (err) {
  console.warn('[Migration] Runner failed:', (err as Error).message);
}
```

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit && npm run test
```

---

## Phase 6: Brotli 压缩中间件

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/middleware/compression.ts` | 新建 | Brotli 优先、gzip 回退的压缩中间件 |
| `servers/agent-api/src/index.ts` | 修改 | `app.use(compressionMiddleware())` |

### 中间件设计要点

- **非 SSE 响应**（GraphQL / REST）：缓冲整个响应体，> 1KB 时压缩，优先 Brotli 回退 gzip
- **SSE 流**（`text/event-stream`）：流式压缩，PassThrough pipeline 到 Brotli/Gzip，每块数据实时压缩输出
- 检测 SSE 方式：`req.headers.accept` 包含 `text/event-stream` 或 `res.getHeader('Content-Type') === 'text/event-stream'`
- 小响应（< 1KB）跳过压缩

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit
```

通过 curl 验证压缩头：
```bash
# Brotli
curl -H "Accept-Encoding: br" http://localhost:PORT/graphql -v 2>&1 | grep Content-Encoding
# gzip
curl -H "Accept-Encoding: gzip" http://localhost:PORT/graphql -v 2>&1 | grep Content-Encoding
```

---

## Phase 7: 前端兼容改造

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/MessageList.tsx` | 修改 | `AcpMessage.content` 类型改为 `string \| Record<string, unknown>`；`parseSessionUpdate` 兼容对象 |

### 修改要点

**`parseSessionUpdate` 函数**:

```typescript
function parseSessionUpdate(content: string | Record<string, unknown>): SessionUpdate | null {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as SessionUpdate;
    } catch {
      return null;
    }
  }
  return content as unknown as SessionUpdate;
}
```

**`AcpMessage` 接口**:

```typescript
interface AcpMessage {
  id: string;
  sessionId: string;
  messageId?: string | null;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}
```

**`mergeMessageChunks` 函数**:
- `parseSessionUpdate(msg.content)` 调用处的类型需对应调整

### 启动 & 验证

```bash
cd apps/agent-web && npx tsc --noEmit
```

---

## Phase 8: API 测试 + 验收

### 测试文件

| Phase | 测试文件 | 操作 | 说明 |
|-------|----------|------|------|
| Phase 1 | `servers/agent-api/src/models/__tests__/acp-message.test.ts` | 新建/修改 | content Mixed 类型读写测试 |
| Phase 4 | `servers/agent-api/src/services/__tests__/session.test.ts` | 修改 | `getMessages` 双阶段过滤测试 |
| Phase 4 | `servers/agent-api/src/services/__tests__/session-messages-filter.test.ts` | 新建 | 过滤逻辑边界测试 |
| Phase 5 | `servers/agent-api/src/migrations/__tests__/runner.test.ts` | 新建 | 分布式锁 + 幂等执行 |
| Phase 5 | `servers/agent-api/src/migrations/__tests__/001-unify-content-format.test.ts` | 新建 | 迁移脚本正确性 |
| Phase 6 | `servers/agent-api/src/middleware/__tests__/compression.test.ts` | 新建 | 压缩头 + 压缩率 |
| Phase 7 | `apps/agent-web/src/components/session/__tests__/MessageList.test.tsx` | 修改 | 兼容新旧格式 |

### API 测试场景（`sessionMessages` 过滤）

| 场景 | 预期 |
|------|------|
| usage_update = 0 条 | 全量返回，不过滤 |
| usage_update = 2 条 | 全量返回（≤ 3） |
| usage_update = 3 条 | 全量返回（= 3） |
| usage_update = 5 条 | 仅返回截断点之后的（保留最后 2 条 + 中间消息） |
| 全部是 usage_update（10 条） | 仅返回 2 条（截断后保留 2 条） |
| 过滤后返回 0 条 | 返回空数组 |
| 空消息列表 | 返回空数组 |

### 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npx tsc --noEmit` | 各子项目 | TypeScript 编译检查 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `npm run test -- --run` | `tests/` | 运行集成 API 测试 |
| `aspire start` | 根目录 | 启动全部服务 |

### 验收 Checklist

- [ ] **Phase 1**: agent-api + controller-api 模型编译通过
- [ ] **Phase 1**: content Mixed 类型支持对象/字符串双向写入读取
- [ ] **Phase 2**: controller-api 写入端存 JSON 对象（MongoDB 中 content 为对象类型）
- [ ] **Phase 2**: Redis 发布消息时 content 正确序列化为字符串
- [ ] **Phase 3**: agent-api `addMessage` 正确 parse 字符串为对象再存储
- [ ] **Phase 3**: session-import 导入流程 content 正确存储
- [ ] **Phase 4**: usage_update > 3 条时截断，≤ 3 条时全量返回
- [ ] **Phase 4**: 过滤后消息 _id 时间线连续无断层
- [ ] **Phase 4**: 非 usage_update 消息不受影响
- [ ] **Phase 5**: 迁移框架启动时自动执行，失败不影响启动
- [ ] **Phase 5**: 同名迁移仅执行一次
- [ ] **Phase 5**: 多实例并发场景下只有一个执行迁移
- [ ] **Phase 5**: content 字符串→对象批量转换完成
- [ ] **Phase 6**: GraphQL 响应 `Content-Encoding: br`（支持 Brotli 的客户端）
- [ ] **Phase 6**: SSE 流式压缩正常，浏览器 EventSource 可解码
- [ ] **Phase 6**: 不支持 Brotli 的客户端回退到 gzip
- [ ] **Phase 7**: 前端正常渲染新旧格式混排的消息
- [ ] **Phase 8**: 单元测试覆盖新增代码
- [ ] **Phase 8**: API 测试全部通过
