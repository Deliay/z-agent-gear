# Agent Session PRD 需求差距分析 V2

**基于**: V1 gap analysis + 子代理独立审查
**日期**: 2026-05-19

## V1 已修复（仅实现，无测试覆盖）

| Gap | 实现 | 测试状态 |
|-----|------|---------|
| G1: Markdown 渲染 + 代码高亮 | ✅ `MessageItem.tsx` | ❌ 无单元测试 |
| G2: Session 元信息显示 | ✅ `SessionHeader.tsx` | ❌ 无单元测试 |
| G3: 发送/处理状态指示 | ✅ `InputBox.tsx` + `SessionPage.tsx` | ❌ 无单元测试 |
| G4: 消息历史分页加载 | ✅ `MessageList.tsx` + `SessionPage.tsx` | ❌ 无单元测试 |

## V2 新增缺口

### 1. 前端组件单元测试（High）

**当前状态**: 所有前端 session 组件零 Vitest + RTL 测试

| 组件 | 文件 | 需要的测试 |
|------|------|-----------|
| MessageItem | `apps/agent-web/src/components/session/MessageItem.tsx` | 渲染用户消息（蓝色气泡）、渲染 Agent 消息（白色气泡）、Markdown 渲染、代码块高亮、不同消息类型样式 |
| SessionHeader | `apps/agent-web/src/components/session/SessionHeader.tsx` | 状态 badge 颜色、显示 acpServerType、显示 createdAt、Close/Delete 按钮 |
| InputBox | `apps/agent-web/src/components/session/InputBox.tsx` | 输入提交、Enter 发送、disabled 状态、sending 状态显示 spinner |
| MessageList | `apps/agent-web/src/components/session/MessageList.tsx` | 空状态显示、消息列表渲染、滚动加载触发、loadingMore 指示器 |
| NewSessionDialog | `apps/agent-web/src/components/session/NewSessionDialog.tsx` | 控制器列表显示、ACP Server 查询、默认 opencode 选项、禁用按钮状态 |
| SessionPage | `apps/agent-web/src/pages/SessionPage.tsx` | 路由渲染、SSE 连接、创建/关闭/删除 session 流程 |

### 2. agent-controller 包单元测试（High）

**当前状态**: `packages/agent-controller/tests/` 仅有 `acp-detector.test.ts` 和 `acp-spawner.test.ts`，但 `bridge.ts` 无测试

| 模块 | 文件 | 需要的测试 |
|------|------|-----------|
| ACP Bridge | `packages/agent-controller/src/acp/bridge.ts` | stdio-WebSocket 桥接、JSON-RPC 消息转换、双向数据转发 |

### 3. E2E 验证 G1-G4（Medium）

**当前状态**: G1-G4 实现已完成，但 E2E 测试未验证这些具体功能

| Gap | 需要的 E2E 验证 |
|-----|----------------|
| G1: Markdown | 创建 session → 发送含 markdown 的消息 → 验证渲染（代码块、列表等）|
| G2: 元信息 | 创建 session → 验证 header 显示 acpServerType + createdAt |
| G3: 状态指示 | 创建 session → 发送消息 → 验证 sending spinner 出现 → 收到响应后消失 |
| G4: 分页 | 创建 session → 验证 "Load earlier messages" 按钮或滚动加载 |

## 修复计划

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| 1 | 创建前端组件单元测试（6 个组件）| High |
| 2 | 创建 acp-bridge 单元测试 | High |
| 3 | 补充 E2E 验证 G1-G4 | Medium |
| 4 | 运行全部测试验证 | High |
