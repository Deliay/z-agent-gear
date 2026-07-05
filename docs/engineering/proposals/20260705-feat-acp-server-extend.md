---
description: 在现有 OpenCode、GitHub Copilot 基础上，增加 Claude Code、Gemini CLI、Codex 作为可选 ACP Server 的技术方案
type: Permanent
---

# ACP Server 支持扩展 — 技术提案

**功能名称**: ACP Server 支持扩展
**关联 PRD**: `20260705-acp-server-extend.md`
**技术提案版本**: v1.0
**创建日期**: 2026-07-05
**作者**: opencode
**feat-branch**: `feat/acp-server-extend`

## 1. 概述

### 1.1 背景

当前系统已支持 OpenCode 和 GitHub Copilot 两种 ACP Server。PRD 要求新增 **Claude Code**（Anthropic）、**Gemini CLI**（Google）、**Codex CLI**（OpenAI）三种 ACP Server。

三种新 CLI 工具均支持 ACP 模式（通过 `--acp --stdio` 或等效参数），通信协议均为 NDJSON over stdio。与现有 Server 的核心差异仅在于：启动命令不同、检测方式（CLI 名称）不同。系统架构已在首次多 ACP Server 支持中做好了扩展准备，新增 Server 类型不需要架构变更。

### 1.2 目标

- `enum AcpServerType` 增加 `claude_code`、`gemini_cli`、`codex` 三个值
- `AcpDetector` 扩展检测三种新 Server
- `AcpDetector.getSpawnerConfig()` 返回对应启动命令
- 前端 ACP Server 标签添加三个新类型的可读名称
- 所有测试覆盖新 Server 类型

### 1.3 范围

- **包含**：Contract（GraphQL enum）、Mongoose models（enum 扩展）、agent-controller（detector + spawner config）、controller-api（透传 serverType）、agent-api（透传）、前端（标签展示）
- **不包含**：各 CLI 工具的安装和认证流程、各 Server 特有的 ACP 能力适配（如 config options 差异）、Session 创建后切换 ACP Server 类型、session list/load 的 Server 差异处理（始终使用 OpenCode）

## 2. 技术架构

### 2.1 系统架构图

```mermaid
graph TD
    subgraph "agent-controller (Daemon)"
        DET[AcpDetector]
        SIO[Socket.IO Client]
        BR[AcpSessionBridge]
        SYNC[AcpSyncBridge]
        SPAWN[AcpSpawner]

        DET -->|detect| OC1[opencode -v]
        DET -->|detect| GC[copilot --version]
        DET -->|detect| CC[claude --version]
        DET -->|detect| GM[gemini --version]
        DET -->|detect| CX[codex --version]

        SIO --> BR
        BR --> SPAWN
        SYNC --> SPAWN

        SPAWN -->|opencode args=['acp']| OCPROC[opencode acp]
        SPAWN -->|copilot args=['--acp','--stdio']| CPROC[copilot --acp --stdio]
        SPAWN -->|claude args=['--acp','--stdio']| CCPROC[claude --acp --stdio]
        SPAWN -->|gemini args=['--acp','--stdio']| GMPROC[gemini --acp --stdio]
        SPAWN -->|codex args=['--acp','--stdio']| CXPROC[codex --acp --stdio]
    end

    subgraph "Contracts / Models"
        ENUM[enum AcpServerType { opencode, github_copilot, claude_code, gemini_cli, codex }]
    end

    ENUM -.->|type check| SPAWN
    ENUM -.->|type check| DET
```

### 2.2 架构决策

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| 启动命令到 Server 类型的映射方式 | AcpDetector 内部映射表 | controller-api 下发完整启动参数 | AcpDetector 内部映射表 | 启动命令是与 Agent 绑定的静态知识，不应由服务端控制 |
| 三种新 Server 检测失败的处理 | 静默返回 available=false | 抛出异常告警 | 静默返回 available=false | 与现有检测行为一致，某个 Server 未安装不影响其他 Server |
| session list/load 对新 Server 的支持 | 分别尝试各 Server | 始终使用 OpenCode | 始终使用 OpenCode | 只有 OpenCode 支持 session 持久化查询 |

### 2.3 模块划分

| 模块 | 职责 | 关键技术点 |
|------|------|-----------|
| Contract | 扩展 `enum AcpServerType` | 增加 `claude_code`、`gemini_cli`、`codex` |
| agent-controller (detector) | 多 ACP Server 检测 | 新增 `detectClaudeCode()`、`detectGeminiCli()`、`detectCodex()` |
| agent-controller (socketio-client) | 根据 serverType 选择 spawner | 已通过 `createSpawner()` 泛化，无改动 |
| agent-controller (spawner) | 无改动 | 已支持自定义 command/args |
| agent-controller (bridge) | 无改动 | 构造函数已接受可选 spawner 参数 |
| agent-controller (sync-bridge) | 无改动 | 始终使用 OpenCode |
| agent-api (model) | enum 扩展 | `enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex']` |
| agent-api (GraphQL) | enum 扩展 | `enum AcpServerType { opencode, github_copilot, claude_code, gemini_cli, codex }` |
| controller-api (model) | enum 扩展 | `enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex']` |
| controller-api (ACM) | 无改动 | 已使用 `serverType: string` |
| frontend (SessionHeader) | 标签可读展示 | 新增三个映射 |

## 3. API 设计

### 3.1 Contract 变更

`contracts/agent-session.graphql`:

```graphql
enum AcpServerType {
  opencode
  github_copilot
  claude_code
  gemini_cli
  codex
}
```

其他接口无需变更，`AcpServerType` 现有的使用位置（`Session.acpServerType`、`AcpCapability.type`、`CreateSessionInput.acpServerType`）均使用该 enum 类型，新增值自然生效。

### 3.2 Socket.IO 协议

无变更。`acp:start` payload 中的 `serverType: string` 字段已存在，仅传递新字符串值（`'claude_code'`、`'gemini_cli'`、`'codex'`）。

`acp:check` 响应中的 `servers` 数组自然包含新 Server 的检测结果。

### 3.3 Redis Pub/Sub

无变更。`session:command` 中的 `acpServerType` 字段已存在，透传不变。

## 4. 数据模型

### 4.1 MongoDB enum 扩展

```typescript
// agent-api/src/models/session.ts
acpServerType: {
  type: String,
  enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex'],
  required: true,
},

// controller-api/src/models/session.ts
acpServerType: {
  type: String,
  enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex'],
  required: true,
},
```

已有数据的 `acpServerType` 为 `'opencode'` 或 `'github_copilot'`，向后兼容，无需数据迁移。

## 5. 技术实现方案

### 5.1 核心流程

```mermaid
sequenceDiagram
    participant F as Frontend
    participant AA as agent-api
    participant CA as controller-api
    participant AC as agent-controller

    Note over F,AC: ACP 能力检测（5 种 Server）
    AC->>AC: acpDetector.detect()
    par 并行检测
      AC->>AC: opencode -v
      AC->>AC: copilot --version
      AC->>AC: claude --version
      AC->>AC: gemini --version
      AC->>AC: codex --version
    end
    AC-->>CA: acp:check:result { servers: [...] }
    CA-->>F: acpCapabilities (GraphQL)
    F->>F: 展示可用 Server 列表

    Note over F,AC: 创建 Session（选择 claude_code）
    F->>AA: createSession(acpServerType: "claude_code")
    AA->>CA: session:command { type: acp:start, serverType: "claude_code" }
    CA->>AC: acp:start { serverType: "claude_code", cwd, sessionId }
    AC->>AC: getSpawnerConfig('claude_code')
    Note right of AC: command='claude', args=['--acp','--stdio']
    AC->>AC: AcpSpawner.start()
    AC->>CP: claude --acp --stdio
    CP-->>AC: NDJSON stdio
    AC-->>CA: acp:start:result { success: true }
    CA-->>AA: session:status { status: 'idling' }
    AA-->>F: SSE status / GraphQL response
```

### 5.2 关键实现点

#### 实现点 1: AcpDetector 扩展三种新 Server 检测

**文件**: `packages/agent-controller/src/acp/detector.ts`

在现有 `detect()` 方法中增加三种新 Server 的并行检测：

```typescript
export class AcpDetector {
  async detect(): Promise<AcpServerInfo[]> {
    const [opencode, copilot, claudeCode, geminiCli, codex] = await Promise.all([
      this.detectOpenCode(),
      this.detectGitHubCopilot(),
      this.detectClaudeCode(),
      this.detectGeminiCli(),
      this.detectCodex(),
    ]);
    return [opencode, copilot, claudeCode, geminiCli, codex];
  }

  private async detectClaudeCode(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('claude --version');
      const version = this.parseVersion(stdout);
      return { type: 'claude_code', available: true, version };
    } catch {
      return { type: 'claude_code', available: false };
    }
  }

  private async detectGeminiCli(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('gemini --version');
      const version = this.parseVersion(stdout);
      return { type: 'gemini_cli', available: true, version };
    } catch {
      return { type: 'gemini_cli', available: false };
    }
  }

  private async detectCodex(): Promise<AcpServerInfo> {
    try {
      const { stdout } = await execAsync('codex --version');
      const version = this.parseVersion(stdout);
      return { type: 'codex', available: true, version };
    } catch {
      return { type: 'codex', available: false };
    }
  }

  getSpawnerConfig(serverType: string): { command: string; args: string[] } {
    switch (serverType) {
      case 'github_copilot':
        return { command: 'copilot', args: ['--acp', '--stdio'] };
      case 'claude_code':
        return { command: 'claude', args: ['--acp', '--stdio'] };
      case 'gemini_cli':
        return { command: 'gemini', args: ['--acp', '--stdio'] };
      case 'codex':
        return { command: 'codex', args: ['--acp', '--stdio'] };
      case 'opencode':
      default:
        return { command: 'opencode', args: ['acp'] };
    }
  }
}
```

#### 实现点 2: socketio-client.ts — 无改动

`createSpawner()` 函数和 `acp:start`/`acp:resume` handler 已经通过 `acpDetector.getSpawnerConfig()` 泛化，传入新 `serverType` 字符串即可自动选择正确命令。无需代码改动。

#### 实现点 3: controller-api — 无改动

`startSession` 和 `resumeSession` 已使用 `serverType: string` 透传，新增的 enum 值自然生效。无需代码改动。

#### 实现点 4: 前端 ACP Server 标签可读展示

**文件**: `apps/agent-web/src/components/session/SessionHeader.tsx`

```typescript
const acpServerTypeLabels: Record<string, string> = {
  opencode: 'OpenCode',
  github_copilot: 'GitHub Copilot',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  codex: 'Codex',
};
```

### 5.3 代码改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `contracts/agent-session.graphql` | 修改 | AcpServerType enum 增加 `claude_code`、`gemini_cli`、`codex` |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | 同步 GraphQL enum |
| `servers/agent-api/src/models/session.ts` | 修改 | enum 数组增加三个新值 |
| `servers/controller-api/src/models/session.ts` | 修改 | enum 数组增加三个新值 |
| `packages/agent-controller/src/acp/detector.ts` | 修改 | 新增三个 detect 方法 + getSpawnerConfig 新增三个 case |
| `apps/agent-web/src/components/session/SessionHeader.tsx` | 修改 | 标签映射新增三个条目 |

**无需改动的文件**：

- `packages/agent-controller/src/socketio-client.ts` — 已通过 `getSpawnerConfig()` 泛化
- `packages/agent-controller/src/acp/spawner.ts` — 已支持自定义 command/args
- `packages/agent-controller/src/acp/bridge.ts` — 已支持外部 spawner
- `packages/agent-controller/src/acp/sync-bridge.ts` — 始终使用 OpenCode
- `servers/controller-api/src/services/acp-session-manager.ts` — 已使用 `serverType: string`
- `servers/agent-api/src/services/session.ts` — 已使用字符串类型
- `apps/agent-web/src/components/session/NewSessionDialog.tsx` — 已自动渲染可用 Server 列表
- `apps/agent-web/src/components/Sidebar.tsx` — 已透传 acpServerType

## 6. 技术决策

### 6.1 决策列表

| 决策 | 选项 A | 选项 B | 最终选择 | 原因 |
|------|--------|--------|---------|------|
| 检测命令格式 | `cli --version` | `cli --acp --version` | `cli --version` | `--version` 是 CLI 工具的标准参数，轻量快速；ACP 模式启动重不适用于检测 |
| 启动命令的统一性 | 所有新 Server 使用 `--acp --stdio` | 各自可能不同的参数 | 统一使用 `--acp --stdio` | ACP 标准模式参数，三种 CLI 均支持 |
| session list/load 对新 Server 的支持 | 分别尝试各 Server | 始终使用 OpenCode | 始终使用 OpenCode | 只有 OpenCode ACP 支持 session 持久化方法 |
| 是否新增检测超时配置 | 统一超时 5s | 不加超时 | 不加超时 | `execAsync` 继承默认行为即可，CLI `--version` 响应通常在 1s 内 |

### 6.2 依赖与约束

| 类型 | 内容 | 说明 |
|------|------|------|
| 依赖 | Claude Code CLI 已安装 | 非本项目责任，用户自行安装 |
| 依赖 | Gemini CLI 已安装 | 非本项目责任，用户自行安装 |
| 依赖 | Codex CLI 已安装 | 非本项目责任，用户自行安装 |
| 约束 | 三种 CLI 的 ACP 模式支持成熟度不同 | 仅保证基础 ACP 消息通信可用，高级功能不做强制对齐 |
| 约束 | 检测命令可能因 CLI 版本差异而不同 | 若某个 CLI 的 `--version` 参数非标准，需单独适配 |

## 7. 项目结构

```
packages/agent-controller/src/acp/
├── detector.ts      # 修改：新增三个 detect 方法 + getSpawnerConfig 三个 case
├── spawner.ts       # 无改动
├── bridge.ts        # 无改动
├── sync-bridge.ts   # 无改动

packages/agent-controller/src/
├── socketio-client.ts  # 无改动（已泛化）

servers/agent-api/src/
├── graphql/schemas/session.ts  # 修改：enum 增加三个值
├── models/session.ts           # 修改：enum 增加三个值

servers/controller-api/src/
├── models/session.ts           # 修改：enum 增加三个值

apps/agent-web/src/components/session/
├── SessionHeader.tsx  # 修改：标签映射新增三个条目

contracts/
├── agent-session.graphql  # 修改：AcpServerType enum 增加三个值
```

## 8. 测试策略

### 8.1 测试覆盖要求

- 单元测试覆盖三种新 Server 的检测方法和 spawner config
- 不影响现有 opencode / github_copilot 的测试
- 不需要新增 API 测试（现有测试已覆盖 `serverType` 字符串传参，新增值自然生效）

### 8.2 测试类型

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Vitest | `detector.ts` 新增的三个 detect 方法 |
| 单元测试 | Vitest | `detector.ts` `getSpawnerConfig()` 新增三个 case |
| 单元测试 | Vitest | SessionHeader 组件显示三种新 Server 标签 |

### 8.3 测试文件变更

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/agent-controller/tests/acp-detector.test.ts` | 修改 | 新增三种 Server 的检测测试 + spawner config 测试 |
| `apps/agent-web/src/components/session/SessionHeader.test.tsx` | 修改 | 新增三种 Server 的标签展示测试 |

## 9. 验收标准

- [ ] 技术方案评审通过
- [ ] Contract 中 `AcpServerType` enum 包含 `claude_code`、`gemini_cli`、`codex`
- [ ] agent-controller `AcpDetector.detect()` 返回 5 个 Server 的检测结果
- [ ] `getSpawnerConfig('claude_code')` 返回 `{ command: 'claude', args: ['--acp', '--stdio'] }`
- [ ] `getSpawnerConfig('gemini_cli')` 返回 `{ command: 'gemini', args: ['--acp', '--stdio'] }`
- [ ] `getSpawnerConfig('codex')` 返回 `{ command: 'codex', args: ['--acp', '--stdio'] }`
- [ ] 前端 SessionHeader 显示 "Claude Code"、"Gemini CLI"、"Codex" 标签
- [ ] 现有 opencode / github_copilot Session 完全不受影响
- [ ] 所有测试通过

## 10. 相关文档

- [ACP Server 支持扩展 PRD](../../product/draft/20260705-acp-server-extend.md)
- [多 ACP Server 支持 PRD](../../product/released/20260526-multi-acp-server-support.md)
- [多 ACP Server 支持技术方案](./20260526-feat-multi-acp-server-support.md)
- [Agent Session GraphQL Contract](../../../contracts/agent-session.graphql)
