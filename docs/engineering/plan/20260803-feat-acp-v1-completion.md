---
description: ACP v1 协议补全与展示优化 - 实现计划（P0 协议对齐 / P1 能力补全 / P2 前沿跟进）
type: Permanent
---

# ACP v1 协议补全与展示优化 - 实现计划

**关联 Proposal**: `proposals/20260803-feat-acp-v1-completion.md`
**关联 PRD**: `../product/reviewed/20260803-acp-v1-completion.md`
**feat-branch**: `feat/acp-v1-completion`
**创建日期**: 2026-08-03

## 实现顺序

```
P0 协议对齐（feat/acp-v1-completion-p0 或按阶段拆分 PR）
  Phase 1: Contract 增量
  └── Phase 2: SDK 1.x 升级（并行 subagent：agent-controller 适配 / 类型同步方验证）
       └── Phase 3: Config Options 双轨（后端 + 前端并行 subagent）
            └── Phase 4: messageId 分组（后端 + 前端并行 subagent）
                 └── Phase 5: session/delete + session/list cursor
                      └── Phase 6: 工具 kind/diff 展示 + 版本协商提示
                           └── Phase 7: P0 测试覆盖（API + E2E 回归）
P1 能力补全
  Phase 8: 多模态输入输出（后端 + 前端并行 subagent）
  └── Phase 9: 认证 authenticate/logout
       └── Phase 10: additionalDirectories
            └── Phase 11: P1 测试覆盖
P2 前沿跟进
  Phase 12: $/cancel_request + Elicitation + agentInfo + ACP v2 评估
```

> 全程遵循 TDD 红-绿-重构：每个 Phase 先写失败测试，再写实现。每阶段独立可验收、可发布。
> **范围红线**：不实施 terminal 能力；不触碰 MCP 链路（含 mcpEndpoint 透传）；不开放 fs capability。

---

# P0 协议对齐

## Phase 1: Contract 增量

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | 新增 `SessionConfigOption` 类型、`PromptCapabilities` 类型；`Session` 增加 `configOptions`/`agentInfo`/`authRequired`/`promptCapabilities`/`supportsAdditionalDirectories`；Mutation 增加 `setSessionConfigOption`、`deleteHistorySession` |
| `contracts/agent-session-websocket.md` | 修改 | 新增 `acp:set-config-option`/`acp:config-options`/`acp:delete-session` 事件；`acp:message` 增加可选 `messageId`；`acp:initialized` 增加能力全量上报字段 |
| `contracts/agent-session.openapi.yaml` | 修改 | SSE 新增 `config:changed` 事件类型 |

### 变更要点

```graphql
type SessionConfigOption {
  id: String!
  name: String!
  description: String
  category: String
  type: String!          # select | boolean
  currentValue: String   # boolean 类型时序列化为 "true"/"false"
  options: [SessionConfigOptionValue!]
}

type PromptCapabilities {
  image: Boolean!
  audio: Boolean!
  embeddedContext: Boolean!
}
```

- 所有新字段可空/有默认值，旧客户端查询不受影响（契约只增不改）。

### 验证

- Contract 评审通过（reviewer 对照 Proposal §4.1）。

---

## Phase 2: SDK 1.x 升级

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/package.json` | 修改 | `@agentclientprotocol/sdk` `^0.22.1` → `^1.x` |
| `servers/controller-api/package.json` | 修改 | 类型导入同步升级 |
| `apps/agent-web/package.json` | 修改 | 类型导入同步升级 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | 适配 SDK 1.x breaking changes；**移除 `unstable_setSessionModel` 调用**（暂由 Phase 3 的 set_config_option 替代，Phase 3 前先回退为"不支持模型切换"并记录 TODO，不得保留 unstable 调用） |
| `packages/agent-controller/src/acp/sync-bridge.ts` | 修改 | 类型适配 |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 类型适配 |

### TDD 要点（先红后绿）

- `packages/agent-controller/tests/acp-bridge.test.ts`：升级后全量重跑；新增"initialize 使用 SDK 1.x 类型声明 clientCapabilities"用例。
- 编译即验证：SDK 1.x 移除的 API 在编译期暴露，逐一适配。

### 验证

```bash
cd packages/agent-controller && npm install && npm run build && npm run test
cd servers/controller-api && npm install && npm run build && npm run test
cd apps/agent-web && npm install && npm run build && npm run test
```

---

## Phase 3: Config Options 双轨

### 文件修改（后端 / 前端并行 subagent）

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | `clientCapabilities` 声明 `session.configOptions.boolean`；新增 `setConfigOption(configId, value)` 调 `session/set_config_option`；`acp:initialized` 上报 `configOptions`；会话响应含 configOptions 时以 configOptions 为准（忽略 modes） |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 新增 `acp:set-config-option` 事件处理 |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | configOptions 落库/Redis 缓存；`config_option_update` 为唯一事实源；set 路由：有 configOptions → 新事件，无 → 旧 `acp:set-mode`/`acp:set-model` |
| `servers/agent-api/src/graphql/schemas/session.ts` + `resolvers/session.ts` | 修改 | `setSessionConfigOption` mutation；`Session.configOptions` 解析 |
| `apps/agent-web/src/components/session/ConfigOptionCard.tsx` | 重构 | 按 category 分组（mode/model/model_config/thought_level/其他），尊重数组顺序；select → 下拉、boolean → 开关；响应全量替换 |
| `apps/agent-web/src/components/session/ModeSwitcher.tsx` / `ModelSwitcher.tsx` | 修改 | 适配层：有 configOptions 时取对应 category 并路由 `setSessionConfigOption`，否则走现有逻辑（UI 不变） |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增 mutation 与 Session 字段查询 |

### TDD 要点

- 后端：agent 返回 configOptions 时 `setSessionConfigOption` 走 `session/set_config_option`；无 configOptions 时回退旧通道；boolean capability 在 initialize 中声明。
- 前端：`ConfigOptionCard` 分组渲染、boolean 开关切换触发 mutation、全量替换更新；`ModeSwitcher` 双轨路由用例。

### 验证

```bash
cd packages/agent-controller && npm run test
cd servers/controller-api && npm run test
cd servers/agent-api && npm run test
cd apps/agent-web && npm run test
```

---

## Phase 4: messageId 分组

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | chunk 透传可选 `messageId`；有 ID 时跳过 50ms debounce 猜测（按 ID 边界 flush） |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | `AcpMessage` 落库携带 `messageId`；分组键 messageId 优先、时间窗兜底 |
| `servers/controller-api/src/models/session.ts` / `servers/agent-api/src/models/session.ts` | 修改 | `AcpMessage` 增加可选 `messageId`（索引） |
| `apps/agent-web/src/components/session/MessageList.tsx` | 修改 | 分组逻辑 messageId 优先，缺失走现有逻辑 |

### TDD 要点

- 同 messageId 多 chunk 聚合为一条消息；不同 messageId 不粘连；无 messageId 时行为与现状一致（快照回归）。

### 验证

```bash
cd packages/agent-controller && npm run test
cd servers/controller-api && npm run test
cd apps/agent-web && npm run test
```

---

## Phase 5: session/delete + session/list cursor

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/sync-bridge.ts` | 修改 | `listSessions` 透传 cursor/nextCursor；新增 `deleteSession(sessionId)`（capability 门控） |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | 新增 `acp:delete-session` 事件；list 请求/响应携带 cursor |
| `servers/controller-api/src/services/acp-session-sync.ts` | 修改 | 删除转发与 capability 判断 |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | `deleteHistorySession(sessionId, syncAgent)`：支持时同步删除 agent 侧，不支持时仅本地删除并在响应中标识 |
| 历史会话页组件 | 修改 | 删除按钮按能力显示"同步删除 Agent 侧"标识与结果反馈 |

### TDD 要点

- agent 声明 delete capability → 转发并等待结果；未声明 → 仅本地删除且响应 `syncedToAgent=false`。
- cursor 透传：请求携带 cursor、响应返回 nextCursor。

### 验证

```bash
cd packages/agent-controller && npm run test
cd servers/controller-api && npm run test
cd servers/agent-api && npm run test
```

---

## Phase 6: 工具 kind/diff 展示 + 版本协商提示

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/ToolCallCard.tsx` | 修改 | kind 映射补全：`delete`（删除图标+红色标识）、`move`（路径 A→B）、`search`（查询词）、`think`（折叠思考块）；terminal 内容维持现状降级展示 |
| `apps/agent-web/src/components/session/DiffView.tsx` | 修改 | `oldText=null` 渲染"新建文件"全文新增模式 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | initialize 响应版本 ≠ 1 时上报告警事件（不断连，由上层提示） |
| `apps/agent-web`（会话页） | 修改 | 版本不兼容提示条 |

### TDD 要点

- 各 kind 渲染快照；new-file diff 渲染；版本不匹配事件触发提示条。

### 验证

```bash
cd apps/agent-web && npm run test && npm run build
cd packages/agent-controller && npm run test
```

---

## Phase 7: P0 测试覆盖（API + E2E 回归）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/controller-api/acp-websocket.test.ts` | 修改 | 新增 set-config-option/delete-session/cursor 用例；7 种 Server 既有用例全量回归 |
| `tests/api/src/agent-api/session.test.ts` | 修改 | `setSessionConfigOption`/`deleteHistorySession` 用例 |
| `tests/e2e/src/session-acp-server.spec.ts` | 修改 | 配置面板分组/开关、历史会话删除标识（按 capability mock） |

### 验证

```bash
aspire start   # 编排全部服务
cd tests/api && npm run test
cd tests/e2e && npm run test
```

### P0 验收门槛

- 7 种 ACP Server 会话链路（创建/恢复/对话/取消/权限/模式切换/模型切换）零回退。
- 代码中不存在任何 `unstable_` 前缀 API 调用。

---

# P1 能力补全

## Phase 8: 多模态输入输出（后端 / 前端并行 subagent）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | `sendSessionMessage` 输入增加 `attachments: [MessageAttachment!]` |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | prompt 按 `promptCapabilities` 组装 image/audio/resource/resource_link 块；非 text chunk 原样透传（不再丢弃） |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | `contentBlocks` 落库（可选字段） |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | 附件大小校验 + capability 门控（未声明拒绝并提示） |
| `apps/agent-web/src/components/session/InputBox.tsx` | 修改 | 附件按钮与 chip 列表，按 `promptCapabilities` 显隐；本地预览、超限阻止 |
| `apps/agent-web/src/components/session/MessageItem.tsx` | 修改 | image 放大预览、audio 内联播放、resource 折叠卡片（mimeType 高亮）、resource_link 链接卡片 |

### TDD 要点

- capability 未声明 image → InputBox 不渲染图片入口、agent-api 拒绝 image 附件。
- 非 text chunk 透传落库并可被查询渲染。

---

## Phase 9: 认证 authenticate/logout

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | initialize 响应 `authMethods` 非空 → `acp:auth:required`；实现 `authenticate`/`logout` 调用 |
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | 认证状态并入会话状态机；凭据仅内存透传不落库 |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | `Session.authRequired`、认证 mutation；SSE `auth:required` |
| `apps/agent-web/src/components/session/AuthPromptDialog.tsx` | 新增 | 认证引导（凭据输入/跳转、失败重试）；`authRequired=true` 会话页顶部提示条 |

### TDD 要点

- authMethods 为空 → 无认证事件、流程不变；认证失败 → 错误提示 + 重试；凭据不出现在落库数据与日志。

---

## Phase 10: additionalDirectories

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | `createSession`/`resumeSession` 输入增加 `additionalDirectories` |
| `packages/agent-controller/src/acp/bridge.ts` / `sync-bridge.ts` | 修改 | `session/new`/`session/load` 请求附加目录（capability 门控） |
| `apps/agent-web/src/components/session/NewSessionDialog.tsx` | 修改 | "附加工作目录"多选（复用目录浏览），`supportsAdditionalDirectories=true` 时显示 |

---

## Phase 11: P1 测试覆盖

| 文件 | 操作 | 说明 |
|------|------|------|
| `tests/api/src/controller-api/acp-websocket.test.ts` | 修改 | 多模态 prompt/认证/附加目录用例（mock agent capability） |
| `tests/e2e/src/session.spec.ts` / `session-acp-server.spec.ts` | 修改 | 附件入口显隐、认证引导、附加目录选择器 E2E |

---

# P2 前沿跟进

## Phase 12: $/cancel_request + Elicitation + agentInfo + v2 评估

> **状态更新（2026-08-08）**：Elicitation 部分已随验收修复落地（契约 → bridge → controller-api → agent-api → web 全链路 + 单测/API/E2E/真实 opencode 握手覆盖），见 [[../acceptance/20260807-acp-permission-elicitation-acceptance-report.md]]。`$/cancel_request`、agentInfo 展示与 v2 评估仍未实施。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | `$/cancel_request` 支持；Elicitation client 方法与 capability 声明 |
| `servers/agent-api` / `apps/agent-web` | 修改 | Elicitation 透传与表单/URL 引导 UI；`SessionHeader` 展示 agentInfo |
| `docs/engineering/` | 新增 | ACP v2 影响评估报告（草案差距、迁移窗口、风险评估） |

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 单元测试 |
| `aspire start` | 根目录 | 编排全部服务（API/E2E 前置） |
| `npm run test` | `tests/api` | API 集成测试 |
| `npm run test` | `tests/e2e` | E2E 测试 |

---

## 验收 Checklist

### P0

- [ ] Phase 1: Contract 增量评审通过（只增不改）
- [ ] Phase 2: SDK 1.x 升级完成，三处依赖编译/测试通过
- [ ] Phase 2: 代码中无 `unstable_` API 调用
- [ ] Phase 3: 有 configOptions 的 agent 走 `session/set_config_option`；无则回退旧通道
- [ ] Phase 3: boolean capability 已声明，开关类配置可改
- [ ] Phase 4: 有 messageId 时按 ID 分组；无 ID 行为与现状一致
- [ ] Phase 5: 支持 delete 的 agent 同步删除；不支持仅本地删除且有标识
- [ ] Phase 6: 全部工具 kind 差异化展示；新文件 diff 正确渲染；版本不兼容有提示
- [ ] Phase 7: API/E2E 全量通过，7 种 Server 零回退

### P1

- [ ] Phase 8: 附件入口按 promptCapabilities 显隐；非 text chunk 可渲染
- [ ] Phase 9: 认证流程可用，无认证 agent 流程不变
- [ ] Phase 10: 附加目录按 capability 显隐并生效
- [ ] Phase 11: API/E2E 通过

### P2

- [ ] Phase 12: `$/cancel_request`、Elicitation 可用；agentInfo 展示；输出 ACP v2 评估报告

### 兼容性总闸（每个 Phase 必检）

- [ ] 契约只增不改；新字段均可空
- [ ] 旧 controller 不产生新事件时各端表现与现状一致
- [ ] 旧会话历史消息渲染无变化
- [ ] 未触碰 MCP 链路；未声明 terminal/fs capability
