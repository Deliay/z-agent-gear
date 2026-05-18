# Agent Session PRD 需求差距分析

**关联 PRD**: `docs/product/reviewed/agent-session-interaction.md`
**关联提案**: `docs/engineering/proposals/20260518-proposal-agent-session.md`
**日期**: 2026-05-19

## 1. 功能点逐条对照

### 功能点 1: 新建 Session 弹框

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| 侧边栏设置区域显示「新建 Session」按钮 | `Sidebar.tsx` NavLink to `/sessions` + "New Session" button | E2E: auth.spec.ts | ✅ |
| 点击按钮弹出新建 Session 弹框 | `NewSessionDialog.tsx` | E2E: session.spec.ts | ✅ |
| 弹框显示用户已绑定的控制器列表 | `GET_CONTROLLERS` query | E2E: session.spec.ts | ✅ |
| 选择控制器后，获取该控制器支持的 ACP Server 列表 | `GET_ACP_CAPABILITIES` query + `getAcpCapabilities` resolver | E2E: session.spec.ts | ✅ |
| 本期仅支持 OpenCode，检测方式为执行 `opencode -v` | `packages/agent-controller/src/acp/detector.ts` | Unit: acp-detector.test.ts | ✅ |
| 用户确认后创建 Session 并建立 ACP 连接 | `createSession` mutation → Redis `session:command` → `acp:start` | API: session.test.ts, E2E: session.spec.ts | ✅ |

### 功能点 2: Controller ACP 能力检测

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| Controller-API 通过 WebSocket 向 Controller 发送检测请求 | `acp:check` event in `socketio.ts` | API: acp-websocket.test.ts | ✅ |
| Controller 检测支持的 ACP Server 列表 | `acp-detector.ts` 执行 `opencode -v` | Unit: acp-detector.test.ts | ✅ |
| Controller 返回检测结果和可用的 ACP Server 列表 | `acp:check:result` event | API: acp-websocket.test.ts | ✅ |
| 检测结果缓存，避免重复检测 | `acp-capability-detector.ts` Redis + memory cache | Unit: acp-capability-detector.test.ts | ✅ |

### 功能点 3: ACP 协议转发

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| Controller 拉起 OpenCode ACP 模式（`opencode acp`）| `acp-spawner.ts` spawn('opencode', ['acp']) | Unit: acp-spawner.test.ts | ✅ |
| Controller 与 OpenCode 通过 stdio 进行 JSON-RPC 通信 | `acp-spawner.ts` stdin/stdout pipe | Unit: acp-spawner.test.ts | ✅ |
| Controller 通过 WebSocket 将 ACP 消息转发到 Controller-API | `acp:message` event | API: acp-websocket.test.ts | ✅ |
| 输入路径：前端 → Agent-API → Controller-API → Controller → OpenCode | `sendSessionMessage` → Redis `session:message` → `forwardToController` → `acp:message` | API: session.test.ts + acp-websocket.test.ts | ✅ |
| 输出路径：OpenCode → Controller → Controller-API → Agent-API → 前端 | `acp:message` → `handleControllerMessage` → Redis `session:message` → SSE push | API: session.test.ts + acp-websocket.test.ts | ✅ |

### 功能点 4: 内容持久化

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| Controller-API 将 ACP 消息存储到数据库 | `acp-session-manager.ts` → `AcpMessage.create()` | Unit: acp-session-manager.test.ts | ✅ |
| 消息包含：Session ID、消息类型、内容、时间戳、方向 | `AcpMessage` Mongoose schema | Unit: acp-session-manager.test.ts | ✅ |
| 存储格式支持后续查询和展示 | `sessionMessages` GraphQL query | API: session.test.ts | ✅ |
| 持久化完成后通知 Agent-API 内容有更新 | Redis Pub/Sub `session:message` channel | API: acp-websocket.test.ts | ✅ |

### 功能点 5: Agent-API SSE 接口

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| Agent-API 提供 `/session/{id}` SSE 端点 | `session-stream.ts` router | Unit: session-sse.test.ts | ✅ |
| 连接时返回该 Session 的历史消息 | `session-sse.ts` `addConnection()` sends history | Unit: session-sse.test.ts | ✅ |
| 有新消息时实时推送 | Redis Pub/Sub subscribe → `res.write()` | Unit: session-sse.test.ts | ✅ |
| 推送内容包含消息类型、内容、时间戳 | Message format: `{ id, direction, type, content, metadata, createdAt }` | Unit: session-sse.test.ts | ✅ |
| 支持连接断开后自动重连 | `EventSource` built-in auto-reconnect | ⚠️ 无显式测试 | ⚠️ |

### 功能点 6: Session 展示

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| 显示 ACP 消息列表（用户输入和 Agent 输出）| `MessageList.tsx` + `MessageItem.tsx` | E2E: session.spec.ts | ✅ |
| 显示 Session 状态（创建中、连接中、运行中、断开、已结束）| `SessionHeader.tsx` status badge | E2E: session.spec.ts | ✅ |
| 显示 Session 元信息（创建时间、关联控制器、ACP Server 类型）| `SessionHeader.tsx` 仅显示 controllerName + status | ❌ 缺失 | ❌ |
| 消息内容支持 Markdown 渲染和代码高亮 | `MessageItem.tsx` 使用 `whitespace-pre-wrap` 纯文本 | ❌ 缺失 | ❌ |
| 支持消息滚动加载历史记录 | `MessageList.tsx` 一次加载全部消息 | ❌ 缺失 | ❌ |

### 功能点 7: 前端 ACP 请求发送

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| Session 页面底部显示输入框 | `InputBox.tsx` textarea + Send button | E2E: session.spec.ts | ✅ |
| 用户输入后发送 `session/prompt` 请求到 Agent-API | `sendSessionMessage` mutation | E2E: session.spec.ts | ✅ |
| Agent-API 转发请求到 Controller-API | Redis Pub/Sub `session:message` | API: session.test.ts | ✅ |
| Controller 将请求写入 OpenCode 的 stdin | `acp-spawner.ts` `send()` | Unit: acp-spawner.test.ts | ✅ |
| 支持发送文本内容和资源引用（如文件路径）| 仅支持纯文本 | ⚠️ v1 仅文本可接受 | ⚠️ |
| 发送后等待 Agent 响应，显示处理状态 | 无 loading 指示器 | ❌ 缺失 | ❌ |

### 功能点 8: Session 生命周期管理

| 验收标准 | 实现 | 测试 | 状态 |
|---------|------|------|------|
| 用户可手动关闭 Session | `closeSession` mutation | E2E: session.spec.ts | ✅ |
| 用户可删除 Session 及其历史记录 | `deleteSession` mutation | E2E: session.spec.ts | ✅ |
| Session 断开后支持重新连接 | EventSource auto-reconnect + SSE 重连 | ⚠️ 依赖 EventSource | ⚠️ |
| Agent 异常退出时 Session 状态自动更新 | `acp:stopped` → `handleControllerStopped` | API: acp-websocket.test.ts | ✅ |
| ACP 是多 Session 的，不同 Session 独立管理 | `ACPSessionManager.sessions` Map | Unit: acp-session-manager.test.ts | ✅ |

## 2. 差距汇总

### 必须修复（PRD 明确要求）

| # | 差距 | PRD 引用 | 优先级 |
|---|------|---------|--------|
| G1 | 消息内容不支持 Markdown 渲染和代码高亮 | 功能点 6: "消息内容支持 Markdown 渲染和代码高亮" | High |
| G2 | Session 元信息不完整（缺 createdAt、acpServerType）| 功能点 6: "显示 Session 元信息（创建时间、关联控制器、ACP Server 类型）" | High |
| G3 | 无 Agent 处理状态指示器 | 功能点 7: "发送后等待 Agent 响应，显示处理状态" | High |
| G4 | 消息历史不支持分页加载 | 功能点 6: "支持消息滚动加载历史记录" | Medium |

### 可接受（v1 简化）

| # | 差距 | 说明 |
|---|------|------|
| G5 | 不支持资源引用发送 | v1 仅文本可接受 |
| G6 | Session 重连无显式按钮 | EventSource 自动重连，用户刷新页面即可 |

## 3. 修复计划

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1 | 安装 react-markdown + react-syntax-highlighter | `apps/agent-web/package.json` |
| 2 | MessageItem 支持 Markdown 渲染 + 代码高亮 | `MessageItem.tsx` |
| 3 | SessionHeader 显示完整元信息 | `SessionHeader.tsx` |
| 4 | InputBox 发送后显示 loading 状态 | `InputBox.tsx`, `SessionPage.tsx` |
| 5 | MessageList 支持分页加载 | `MessageList.tsx`, `session-sse.ts` |
| 6 | 补充 E2E 测试 | `tests/e2e/src/session.spec.ts` |
| 7 | 运行全部测试验证 | — |
