---
description: 在现有 OpenCode、GitHub Copilot 基础上，增加 Claude Code、Gemini CLI、Codex 作为可选 ACP Server
type: Permanent
---

# ACP Server 支持扩展 — Claude Code / Gemini CLI / Codex

**功能名称**: ACP Server 支持扩展
**PRD 版本**: v1.0
**创建日期**: 2026-07-05
**作者**: opencode

## 背景与目标

### 1.1 背景

z-agent-gear 目前已支持 OpenCode 和 GitHub Copilot 两种 ACP Server，用户在创建 Session 时可从中选择。然而，AI 编码助手生态正在快速扩张，越来越多的 CLI 工具开始支持 ACP 协议：

- **Claude Code**（Anthropic）：Claude 的命令行编码工具，支持 ACP 模式
- **Gemini CLI**（Google）：Gemini 的命令行工具，支持 ACP 模式
- **Codex CLI**（OpenAI）：OpenAI Codex 的命令行编码工具，支持 ACP 模式

用户希望在一个统一的 Web 界面中，根据任务需求灵活选择不同的 AI Agent，而不是绑定在特定的工具上。当前系统架构已经为多 ACP Server 做好了准备（基于 `AcpServerType` 枚举的检测、启动、展示流程），扩展新的 Server 类型不需要架构变更，仅在现有枚举和检测逻辑上增量添加。

### 1.2 目标

- 支持 Claude Code 作为新的可选 ACP Server
- 支持 Gemini CLI 作为新的可选 ACP Server
- 支持 Codex CLI 作为新的可选 ACP Server
- 三种新 Server 的检测、启动、消息通信、关闭等完整生命周期与现有 Server 保持一致
- 用户在创建 Session 时可从全部可用 ACP Server 中自由选择
- 已安装的 Server 自动检测并上报，无需用户手动配置

### 1.3 成功标准

- [ ] 控制器上安装了 Claude Code CLI 时，检测结果包含 `claude_code`，前端可看到该选项
- [ ] 控制器上安装了 Gemini CLI 时，检测结果包含 `gemini_cli`，前端可看到该选项
- [ ] 控制器上安装了 Codex CLI 时，检测结果包含 `codex`，前端可看到该选项
- [ ] 三种新 Server 的 Session 能够正常创建、收发消息、取消、关闭
- [ ] 旧 Session（opencode / github_copilot）兼容性不受任何影响
- [ ] 任意组合安装（1 个 / 2 个 / 多个 / 全部）时，前端只显示已安装的可用选项
- [ ] 三种新 Server 的版本号在检测结果中正常展示
- [ ] 历史会话导入功能支持在多个 ACP Server 中选择，不限于 OpenCode

## 用户分析

### 2.1 目标用户

- 已安装 Claude Code CLI 并希望从 z-agent-gear Web 界面调用的用户
- 已安装 Gemini CLI 并希望从 z-agent-gear Web 界面调用的用户
- 已安装 Codex CLI 并希望从 z-agent-gear Web 界面调用的用户
- 持有多款 AI 编码工具，希望在统一界面中根据任务需求灵活切换的用户
- 希望在同一环境中对比不同 Agent（OpenCode / Copilot / Claude / Gemini / Codex）表现的用户

### 2.2 用户场景

| 场景 | 用户角色 | 目标 | 痛点 |
|--|--|--|--|
| Claude Code 已有用户 | AI 应用开发者 | 在 Web 界面中继续使用 Claude Code 进行编码 | 被迫在终端中操作 Claude Code，无法享受 z-agent-gear Web 界面的便利 |
| 多 Agent 工作流 | 全栈开发者 | 重构用 OpenCode，生成样板代码用 Copilot，Code Review 用 Claude Code | 需要在多个终端窗口间切换不同 Agent，无法统一管理 |
| Agent 选型评估 | 技术负责人 | 在团队中评估哪个 AI Agent 最适合项目需求 | 缺乏在统一工作环境中对比不同 Agent 的能力 |
| Gemini 生态用户 | 云原生开发者 | 在 GCP 项目中使用 Gemini CLI 进行开发 | 只能在终端中使用 Gemini，无法集成到 Web 工作流 |
| Codex 用户 | Python 开发者 | 使用 Codex CLI 进行 Python 项目开发 | 无法在统一界面中管理和切换不同 Agent |

## 功能需求

### 3.1 功能概述

在已支持的 OpenCode 和 GitHub Copilot 基础上，新增 Claude Code、Gemini CLI、Codex CLI 三种 ACP Server。控制器端扩展检测逻辑，同时检测新 Server 是否可用；前端新建 Session 流程中自动展示所有可用选项；Session 生命周期行为与现有 Server 保持一致。

### 3.2 功能列表

#### 功能点 1: 新 ACP Server 检测

- **描述**: 在现有检测逻辑基础上，增加对 Claude Code、Gemini CLI、Codex CLI 的检测。检测方式为验证对应 CLI 是否已安装并可执行。检测结果包含版本号和可用状态，与现有检测机制共享同一个缓存策略。
- **用户价值**: 系统自动发现新安装的 AI 工具，用户无需任何配置即可使用
- **验收标准**:
  - [ ] 安装了 Claude Code 时，检测结果包含 `claude_code` 及版本号
  - [ ] 安装了 Gemini CLI 时，检测结果包含 `gemini_cli` 及版本号
  - [ ] 安装了 Codex CLI 时，检测结果包含 `codex` 及版本号
  - [ ] 未安装时，对应 Server 的 available 为 false，不向前端展示
  - [ ] 检测结果复用现有缓存机制（1h TTL）

#### 功能点 2: 新 ACP Server 的 Session 生命周期

- **描述**: 用户选择新 Server 创建的 Session，在控制器端启动对应 CLI 的 ACP 进程，通过 ACP 协议转发消息。消息发送/接收、取消生成、关闭 Session、Session 重连等行为与现有 OpenCode / GitHub Copilot Session 保持一致。
- **用户价值**: 用户获得与现有 Server 完全一致的 Web 交互体验
- **验收标准**:
  - [ ] acpServerType 为 `claude_code` 的 Session 正常启动对应进程
  - [ ] acpServerType 为 `gemini_cli` 的 Session 正常启动对应进程
  - [ ] acpServerType 为 `codex` 的 Session 正常启动对应进程
  - [ ] 三种新 Server 的消息发送和接收行为与现有 Server 一致
  - [ ] 取消生成、关闭 Session 等操作正常
  - [ ] Session 重连行为正常

#### 功能点 3: 历史会话导入支持多 ACP Server

- **描述**: 从工作目录导入历史会话时，用户可以选择使用哪个 ACP Server 来执行 `session/list` 和 `session/load` 操作。不同 ACP Server 可能在同一工作目录中持久化了不同格式的会话数据，导入时需使用对应的 Server 类型才能正确读取。
- **用户价值**: 用户可以从同一个工作目录导入任意 ACP Server 产生的历史会话数据，不限于 OpenCode
- **验收标准**:
  - [ ] 历史会话导入流程中支持指定 acpServerType
  - [ ] 使用 `claude_code` Server 能正确列出并导入其持久化的历史会话
  - [ ] 使用 `gemini_cli` Server 能正确列出并导入其持久化的历史会话
  - [ ] 使用 `codex` Server 能正确列出并导入其持久化的历史会话
  - [ ] 导入后的 Session 记录正确标记对应的 acpServerType
  - [ ] 向后兼容：不指定 acpServerType 时默认使用 opencode

#### 功能点 4: ACP Server 类型展示

- **描述**: 新建 Session 的 ACP Server 选择器中包含全部可用选项。Session 列表和详情页展示对应 ACP Server 类型的可读名称（"Claude Code" / "Gemini CLI" / "Codex" / "OpenCode" / "GitHub Copilot"）。
- **用户价值**: 用户随时了解每个 Session 正在使用的 Agent 类型，选择时一目了然
- **验收标准**:
  - [ ] 新建 Session 时 ACP Server 下拉列表包含全部可用 Server，每个选项显示名称和版本
  - [ ] Session 列表页每条记录显示 acpServerType 的可读标签
  - [ ] Session 详情页 Header 区域显示 acpServerType 可读标签

### 3.3 用户操作流程

```mermaid
flowchart LR
    A[点击 New Session] --> B[选择 Controller]
    B --> C{ACP 能力检测}
    C --> D[展示可用 ACP Server 列表]
    D --> E{可用数量}
    E -->|仅 1 个| F[自动选中]
    E -->|2 个以上| G[用户选择]
    F --> H[选择 Workspace]
    G --> H
    H --> I[创建 Session]
    I --> J{acpServerType}
    J -->|opencode| K[启动 opencode acp]
    J -->|github_copilot| L[启动 copilot --acp --stdio]
    J -->|claude_code| M[启动 claude 进程]
    J -->|gemini_cli| N[启动 gemini 进程]
    J -->|codex| O[启动 codex 进程]
    K --> P[Session 运行]
    L --> P
    M --> P
    N --> P
    O --> P
```

### 3.4 页面/界面描述

| 页面 | 描述 | 关键元素 |
|------|------|---------|
| 新建 Session 弹框 | 选择 Controller 后显示可用 ACP Server 下拉列表，包含全部已检测到的 Server | ACP Server 下拉选择器（显示名称+版本），默认选中第一个可用选项 |
| 历史会话导入弹框 | 选择 Workspace 后显示该目录下的历史会话，用户可通过 ACP Server 下拉筛选/指定导入来源 | ACP Server 下拉选择器（默认 opencode），会话列表，导入按钮 |
| Session 详情页 | 顶部 Header 区域显示 acpServerType 标签 | 在 Controller 名称旁显示小标签 "OpenCode" / "GitHub Copilot" / "Claude Code" / "Gemini CLI" / "Codex" |
| Session 列表页 | 每条 Session 记录显示 acpServerType | 列表每行显示 ACP Server 类型标签 |

### 3.5 异常与边界情况

| 情况 | 预期行为 |
|------|---------|
| 用户选择 Claude Code 但未安装 | 检测时 available=false，下拉列表中不出现，不会让用户选到 |
| 新 Server 进程启动失败或崩溃 | 与现有行为一致 — Session 状态变为 ended，前端提示错误 |
| 用户同时安装 5 种 ACP Server | 下拉列表完整显示 5 个选项，默认选中第一个 |
| 旧 Session（opencode / github_copilot）回看 | 完全不受影响，正常展示历史消息 |
| 新 Server 的 ACP 协议版本有差异 | 启动时 SDK 层协商版本，功能降级由 SDK 处理，不影响基础消息通信 |
| 控制器没有任何 ACP Server | 前端显示"无可用 Server"提示，无法创建 Session |

## 非功能需求

### 4.1 性能要求

- 单 Server 检测时间不超过 2s，新增 3 个 Server 后总检测时间不超过 6s（并行检测）
- Session 启动时间与现有 Server 一致，不超过 5s

### 4.2 安全性要求

- 各 CLI 工具的认证凭据由用户自行在本地管理，系统不存储任何第三方凭据
- ACP 协议通信加密与现有实现一致（WebSocket/SSE over HTTPS）

### 4.3 兼容性要求

- 现有 OpenCode、GitHub Copilot Session 完全不受影响
- 历史数据无需迁移
- 不支持 Session 创建后切换 acpServerType
- 新 Server 的协议能力差异不做对齐，仅保证基础 ACP 消息通信可用（文本消息的发送和接收）
- 历史会话导入的 acpServerType 不使用默认值时不向后兼容，前端需确认用户选择

## 依赖与约束

### 5.1 依赖

- Claude Code CLI 已在控制器上安装（Claude Code 需额外全局安装 ACP 适配器 `@agentclientprotocol/claude-agent-acp`）
- Gemini CLI 已在控制器上安装
- Codex CLI 已在控制器上安装（Codex 需额外全局安装 ACP 适配器 `@agentclientprotocol/codex-acp`）

### 5.2 约束

- 本项目不负责各 CLI 工具的安装和认证流程，这些由用户自行完成
- Claude Code 和 Codex 需通过独立的 ACP 适配器接入，适配器需用户额外安装
- 不同 ACP Server 的协议版本可能存在差异，基础消息通信保证可用，高级功能不做强制对齐
- 新增 ACP Server 类型需要定义对应的 enum 值并更新所有相关模块

## 相关文档

- [多 ACP Server 支持 PRD](./released/20260526-multi-acp-server-support.md)
- [Agent 拉起与交互 PRD](./released/20260518-agent-session-interaction.md)
- [Agent Client Protocol 官方文档](https://agentclientprotocol.com/)
