---
description: Session 对话滚动加载 - 实现计划
type: Permanent
---

# Session 对话滚动加载 - 实现计划

**关联 Proposal**: `proposals/20260723-feat-session-scroll-loading.md`
**关联 PRD**: `docs/product/draft/20260723-session-scroll-loading.md`
**创建日期**: 2026-07-23
**feat-branch**: `feat/session-scroll-loading`

## 实现顺序

```
Phase 0: Contract 更新（agent-session.graphql + agent-session.openapi.yaml）
  └── Phase 1: 后端游标查询重构（TDD: getMessages + SSE history 限量）
       └── Phase 2: 前端滚动加载接线（queries + SessionPage + MessageList）
            └── Phase 3: 编排服务 + API 测试
                 └── Phase 4: E2E 测试 + 验收
```

依赖关系：Phase 1 依赖 Phase 0（契约签名先行）；Phase 2 依赖 Phase 1 的契约实现（可并行开发，联调时对齐）；Phase 3/4 串行。

开发模式：全程 TDD（红-绿-重构），每个 Phase 先写失败测试再实现。Phase 1 与 Phase 2 在契约确定后可并行 subagent 开发。

---

## Phase 0: Contract 更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | `sessionMessages(sessionId: ID!, before: ID, limit: Int): [AcpMessage!]!`，移除 `offset` |
| `contracts/agent-session.openapi.yaml` | 修改 | `history` 事件描述更新为"最近最多 25 条消息"（现描述"最近 100 条"已过时） |

### 修改要点

- `before`：可选游标，仅返回该消息 `_id` 之前（更早）的消息；`limit`：默认 25，上限 100
- 契约中补充注释说明返回顺序为时间升序、`hasMore` 由"返回条数 == limit"推断

### 启动 & 验证

- 契约 diff review 通过即可，无需运行

---

## Phase 1: 后端游标查询重构（agent-api，TDD）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/session.ts` | 修改 | `getMessages` 移除 usage_update 双阶段截断（L338-352），改为游标查询 |
| `servers/agent-api/src/services/session-sse.ts` | 修改 | `addConnection` 中 history 调用改为 `getMessages(sessionId, userId, { limit: 25 })`（L33） |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | `sessionMessages` 签名同步契约（`before` 替换 `offset`） |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | 参数透传改为 `{ before, limit }` 对象（L21-35） |
| `servers/agent-api/src/services/__tests__/session.test.ts` | 修改 | 移除/改写旧截断断言，新增游标分页用例（先行失败） |

### 修改要点

**`getMessages` 新签名与逻辑**:

```typescript
async getMessages(
  sessionId: string,
  userId: string,
  options: { before?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]>
```

1. session 归属校验逻辑不变（`Session not found`）
2. `limit` 钳制到 [1, 100]，默认 25
3. `filter = { sessionId }`；`before` 为合法 ObjectId 时追加 `_id: { $lt: new ObjectId(before) }`，非法则忽略
4. `find(filter).sort({ _id: -1 }).limit(limit).lean()` 后 `reverse()`，返回时间升序
5. 删除 Query A/B usage_update 截断代码

### 单元测试场景（先写测试，红 → 绿）

| 场景 | 预期 |
|------|------|
| 消息总数 50，无参数 | 返回最近 25 条，升序 |
| 消息总数 10，无参数 | 返回全部 10 条 |
| 传入 `before` = 第 26 条 _id | 返回第 1-25 条 |
| 逐页翻页至第一页 | 合并结果与全量一致，无重复无遗漏 |
| `limit: 200` | 钳制为 100 |
| `before` 非法字符串 | 忽略游标，返回最近 25 条 |
| 他人 sessionId | 抛 `Session not found` |
| 空会话 | 返回空数组 |

### 启动 & 验证

```bash
cd servers/agent-api && npx tsc --noEmit && npm run test
```

---

## Phase 2: 前端滚动加载接线（agent-web）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/queries.ts` | 修改 | `GET_SESSION_MESSAGES` 改为 `($sessionId: ID!, $before: ID, $limit: Int)`（L120） |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 同步 query 变量类型 |
| `apps/agent-web/src/pages/SessionPage.tsx` | 修改 | 维护 `hasMore/loadingMore` 状态，实现 `handleLoadMore`，传入 MessageList |
| `apps/agent-web/src/components/session/MessageList.tsx` | 修改 | prepend 滚动位置保持 + 顶部加载/到底提示 |

### 修改要点

**SessionPage.tsx**:
- SSE `history` 到达时：`setMessages(data.data)` + `setHasMore(data.data.length >= 25)`
- `handleLoadMore`：以当前 `messages[0].id` 为 `before`，Apollo `client.query`（`fetchPolicy: 'network-only'`）拉取 25 条 → `setMessages(prev => dedupe([...older, ...prev]))`（按 `id` 去重）；返回条数 < 25 则 `setHasMore(false)`；`loadingMore` 防并发；失败时 catch 并保持可重试
- 将 `hasMore/onLoadMore/loadingMore` 传给 `<MessageList />`

**MessageList.tsx**:
- 滚动位置保持：`onLoadMore` 触发前由父组件记录 `listRef.scrollHeight/scrollTop`；prepend 渲染后 `useLayoutEffect` 中 `scrollTop = 新scrollHeight - 旧scrollHeight + 旧scrollTop`
- 区分 prepend 与 append：prepend 时不触发"自动滚到底部"（比较首条消息 id 变化或显式标记）
- 顶部区域：`loadingMore` 显示加载指示；`!hasMore && messages.length > 0` 显示"已加载全部历史"

### 启动 & 验证

```bash
cd apps/agent-web && npx tsc --noEmit && npm run test
```

---

## Phase 3: 编排服务 + API 测试

### 编排

```bash
aspire start    # agent-api + controller-api + agent-web + MongoDB + Redis
```

### API 测试（`tests/api`，TDD）

| 场景 | 预期 |
|------|------|
| GraphQL `sessionMessages` 无参数 | 返回最近 ≤ 25 条，升序 |
| 带 `before` 逐页翻页 | 遍历完整历史，无重复无遗漏 |
| SSE `/api/session/:id/stream` 连接 | `history` 事件 ≤ 25 条 |
| 未授权/他人会话 | 401/403/Session not found 行为不变 |

---

## Phase 4: E2E 测试 + 验收

### E2E 场景（`tests/e2e`）

| 场景 | 预期 |
|------|------|
| 打开 > 25 条消息的会话 | 初始渲染 ≤ 25 条，滚动在底部 |
| 上滚至顶部 | 自动加载更早消息，阅读位置不跳动 |
| 持续上滚至最早 | 显示"已加载全部历史"，不再发请求 |
| 加载历史时新消息到达 | 底部正常追加，历史拼接无重复 |

### 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npx tsc --noEmit` | 各子项目 | TypeScript 编译检查 |
| `npm run test` | 各子项目 | 单元测试 |
| `npm run test -- --run` | `tests/` | 集成 API 测试 |
| `aspire start` | 根目录 | 启动全部服务 |

### 验收 Checklist

- [ ] **Phase 0**: 契约 PR 合入 feat 分支
- [ ] **Phase 1**: `getMessages` 默认返回最近 25 条升序，`before` 游标翻页正确
- [ ] **Phase 1**: usage_update 截断代码已移除，旧断言已更新
- [ ] **Phase 1**: SSE `history` 事件 ≤ 25 条
- [ ] **Phase 2**: 上滚自动加载，位置不跳动，无重复消息
- [ ] **Phase 2**: 加载至最早后显示到底提示且不再请求
- [ ] **Phase 2**: 加载失败可重试，loadingMore 防并发
- [ ] **Phase 3**: API 测试全部通过
- [ ] **Phase 4**: E2E 场景全部通过
