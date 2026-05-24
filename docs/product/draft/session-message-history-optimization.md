# 会话消息历史优化

**功能名称**: 会话消息历史优化 & 响应压缩
**PRD 版本**: v1.0
**创建日期**: 2026-05-24
**作者**: ZeroAsh

## 背景与目标

### 1.1 背景

在 Agent 长时间运行后，会话消息数量会急剧增长。当前系统会将所有消息（包括大量系统自动生成的 usage_update 消息）全部返回给前端，导致：

1. 前端接收大量无用数据，渲染性能下降
2. SSE 重连时全量历史拉取耗时过长，带宽浪费
3. 用户实际关心的对话消息被淹没在系统消息中

同时，agent-api 服务目前所有响应均为明文 JSON 传输，未启用任何压缩。在长会话场景下，GraphQL 响应体动辄数 MB，进一步加剧了网络传输延迟。

### 1.2 目标

- 消息历史返回中，usage_update 消息不超过 3 条，从尾部（最新）开始保留
- agent-api 所有 API 响应开启 Brotli 压缩，减少传输体积

### 1.3 成功标准

| 指标 | 目标 |
|------|------|
| 单次消息历史响应中 usage_update 数量 | ≤ 3 条 |
| 压缩后响应体体积 | 降低 ≥ 70%（实测） |
| 后端处理耗时 | 不因过滤逻辑显著增加（< 50ms） |
| 前端消息列表渲染性能（长会话 1000+ 条） | 无明显卡顿 |

## 用户分析

### 2.1 目标用户

所有使用 Web 端与 Agent 对话的用户，尤其是长时间会话的重度用户。

### 2.2 用户场景

| 场景 | 用户角色 | 目标 | 痛点 |
|--|--|--|--|
| 打开已有长会话的历史记录 | 日常用户 | 快速加载历史，继续对话 | 加载慢，浏览器卡顿 |
| SSE 断线重连 | 日常用户 | 快速恢复会话状态 | 重连耗时久，等待时间长 |
| 查看会话中的用量信息 | 开发者用户 | 了解本次会话 token 消耗趋势 | 希望看到最近的几次用量，而非全部 |

## 功能需求

### 3.1 功能概述

在后端消息查询服务中增加 usage_update 智能过滤逻辑，并在 agent-api 整体响应链路中启用 Brotli 压缩，在不影响用户正常查看用量信息的前提下，显著减少传输数据量和前端渲染压力。

### 3.2 功能列表

#### 功能点 1: 消息历史 usage_update 过滤

- **描述**: 消息保存时 `type` 字段保持不变（仍为 `text`），content 以 JSON 对象存储（非字符串），usage_update 的识别通过直接查询 `content.sessionUpdate` 属性实现。查询时先查出最近的 3 条 usage_update，再根据结果决定是否需要截断。老数据通过迁移脚本将 content 从 JSON 字符串转换为 JSON 对象后，与新数据统一处理。
- **用户价值**: 历史消息加载速度显著提升，UI 不再因为大量用量卡片导致渲染卡顿；用户仍可看到最近几次用量趋势。
- **验收标准**:
  - [ ] ≤ 3 条 usage_update 时，返回所有消息不变
  - [ ] > 3 条 usage_update 时，从倒数第 3 条之后的消息开始返回
  - [ ] 过滤后返回的消息时间线连续（序号/时间无断层）
  - [ ] 非 usage_update 类型的消息不受影响

**过滤规则详细说明**：

usage_update 消息的识别方式：通过 MongoDB 直接查询 content 对象的 `sessionUpdate` 属性，即 `"content.sessionUpdate": "usage_update"`。

**过滤流程**（content 已迁移为 JSON 对象后）：

```
// Query A: 查询最近的 3 条 usage_update
db.acpmessages.find(
  { sessionId: <sessionId>, "content.sessionUpdate": "usage_update" },
  { _id: 1 }
).sort({ _id: -1 }).limit(3)
→ 返回 result[]（最多 3 条，仅含 _id）

if result.length === 3:
  cutoff = result[2]._id  // 倒数第 3 条
  // Query B: 截断点之后的所有消息
  db.acpmessages.find(
    { sessionId: <sessionId>, _id: { $gt: cutoff } }
  ).sort({ _id: 1 })

if result.length < 3:
  // 返回全部消息，不过滤
  db.acpmessages.find({ sessionId: <sessionId> }).sort({ _id: 1 })
```

**例**：500 条消息，usage_update 在 _id 序列 [id0, id100, id200, id300, id400]
- Query A 倒序返回 [id400, id300, id200]，result.length === 3
- 截断点 = id200（result[2]）
- Query B: `find({ sessionId, _id: { $gt: id200 } }).sort({ _id: 1 })`
- 返回 id200 之后的消息（即 201 - 500 条）
- 最终包含 2 条 usage_update（id300, id400），≤ 3 ✓

```mermaid
flowchart TD
    A[客户端请求 sessionMessages] --> B[Query A: find content.sessionUpdate=usage_update<br>sort _id -1 limit 3]
    B --> C{result.length === 3?}
    C -->|否| D[返回全部消息<br>不过滤]
    C -->|是| E[截断点 = 第3条的 _id]
    E --> F[Query B: find _id gt 截断点<br>返回该范围所有消息]
    D --> G[Brotli 压缩响应]
    F --> G
    G --> H[返回给前端]
```

#### 功能点 2: 响应 Brotli 压缩

- **描述**: 在 Express 中间件层增加 Brotli 压缩（`brotli` 或 `compression` 库），对所有 API 响应（GraphQL 查询/变更、REST SSE、健康检查）进行压缩。优先使用 Brotli，回退到 gzip。
- **用户价值**: API 响应体积大幅减小，网络传输时间缩短，页面加载/数据刷新更快。
- **验收标准**:
  - [ ] 浏览器收到 `Content-Encoding: br` 响应头
  - [ ] 压缩率 ≥ 70%（实测 1MB JSON 压缩后 < 300KB）
  - [ ] 不支持 Brotli 的客户端正常回退到 gzip 或 identity
  - [ ] SSE 事件流是否压缩按流式传输特性单独评估

#### 功能点 3: 老数据迁移框架

- **描述**: agent-api 服务启动时自动执行数据迁移。迁移脚本需支持幂等性（同名脚本不重复执行），并利用 MongoDB 分布式锁防止多实例并发冲突。
- **用户价值**: 老数据可逐步转换到新格式，无感知。
- **验收标准**:
  - [ ] 启动时自动检查未运行的迁移并执行
  - [ ] 同名迁移仅执行一次（幂等）
  - [ ] 多实例同时启动时只有一个执行迁移（分布式锁）
  - [ ] 迁移失败不影响服务正常启动
  - [ ] 迁移执行有日志记录

**迁移框架设计**：

```mermaid
flowchart TD
    A[agent-api 启动] --> B[尝试获取分布式锁]
    B --> C{锁获取成功?}
    C -->|否| D[跳过迁移，正常启动]
    C -->|是| E[查询 migrations 表<br>获取已执行的 name 列表]
    E --> F[遍历所有迁移脚本]
    F --> G{name 是否已执行?}
    G -->|是| H[跳过]
    G -->|否| I[执行 run 函数]
    I --> J[记录到 migrations 表]
    J --> K[有更多脚本?]
    K -->|是| F
    K -->|否| L[释放锁]
    L --> M[正常启动完成]
```

- **迁移脚本结构**: 每个迁移脚本导出一个固定结构 `{ name: string, run: () => Promise<void> }`
- **`migrations` 表**: MongoDB 集合，记录已执行过的迁移 name，结构为 `{ name: string, executedAt: Date }`
- **分布式锁**: 利用 MongoDB 的 `findOneAndUpdate` 实现（`_lock` 文档 + TTL 索引），锁定后其他实例等待或跳过
- **具体迁移脚本（消息 content 格式统一）**: 扫描所有 `type: "text"` 且 content 为字符串类型的 acp_messages 记录，执行以下转换：
  - 如果 `direction: "output"`：直接将 content JSON 字符串 `parse` 为 JSON 对象
  - 如果 `direction: "input"`：将 content JSON 字符串 `parse` 后重组为 ACP 结构数据（`{ sessionUpdate: "user_message_chunk", content: { type: "text", text: ... } }`）
  - 迁移后所有 `type: "text"` 消息的 content 统一为 JSON 对象类型，Query A 可直接使用 `"content.sessionUpdate": "usage_update"` 查询

### 3.3 消息处理流程

```mermaid
sequenceDiagram
    participant Client as Web 前端
    participant API as agent-api
    participant DB as MongoDB

    Client->>API: GraphQL query sessionMessages
    API->>DB: Query A: find content.sessionUpdate=usage_update<br>sort _id -1 limit 3, 仅返回 _id
    DB-->>API: 最多 3 条 usage_update _id
    API->>API: result.length === 3?
    alt result.length === 3
        API->>DB: Query B: find _id gt 第3条_id, 返回全部
    else
        API->>DB: Query B: 返回全部消息（不过滤）
    end
    DB-->>API: 消息列表（usage_update ≤ 3）
    API->>API: Brotli 压缩响应
    API-->>Client: 压缩后的消息列表
```

### 3.4 异常与边界情况

| 情况 | 预期行为 |
|------|---------|
| 消息不足 3 条 | 直接返回，不过滤 |
| 消息中无 usage_update | 直接返回，不过滤 |
| 所有消息均为 usage_update | 仅返回最后 2 条（截断后保留 ≤ 3） |
| 过滤后返回 0 条消息 | 返回空数组 |
| 客户端不支持 Brotli | 自动降级为 gzip 或不压缩 |
| SSE 长连接 | 按流式响应评估是否压缩，视实现方式决定 |

## 四、非功能需求

### 4.1 性能要求

- Query A（查最近 3 条 usage_update）仅返回 `_id` 字段 + limit 3，避免全表扫描，控制在单次查询 < 20ms
- 压缩中间件仅压缩响应体，不缓存，不影响 GraphQL resolve 本身
- Brotli 选择合适压缩级别（建议 level 4-6），平衡 CPU 开销与压缩率

### 4.2 兼容性要求

- Brotli 压缩在所有现代浏览器中支持（Chrome/Firefox/Safari/Edge 近 5 个主要版本）
- Node.js 原生支持 Brotli（>= v11.7，当前项目 Node 版本应满足）

### 4.3 可观测性

- 建议在响应头中添加 `x-compression-ratio` 或日志中记录压缩前后体积和压缩耗时，方便调试

## 五、依赖与约束

### 5.1 依赖

- `express-brotli` 或 `compression` npm 包（或 Node.js 原生 `zlib` 中间件封装）

### 5.2 约束

- usage_update 消息的识别统一通过查询 `content.sessionUpdate` 属性判断，不新增 `AcpMessageType` 枚举值
- Query A 中通过 `{ "content.sessionUpdate": "usage_update" }` 直接查询，content 为 JSON 对象（非字符串）
- GraphQL schema 中 `AcpMessage.content` 类型改为 `Mixed`（JSON 对象），由 resolver 层直接返回
- 写入端：usage_update 写为 `type: "text"` + content 为 JSON 对象（`{ sessionUpdate: "usage_update", ... }`），非 JSON 字符串

## 六、相关文档

- [ACP SDK types - UsageUpdate](https://github.com/anomalyco/agent-client-protocol)
