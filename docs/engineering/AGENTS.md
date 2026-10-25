# Engineering 文档管理

本文档描述了 `docs/engineering/` 目录下的技术文档管理规范。

## 目录结构

```
engineering/
├── AGENTS.md             # 本文件：目录规范说明
├── common-rules.md       # 通用开发规范
├── backend-rules.md      # 后端开发规范
├── frontend-rules.md     # 前端开发规范
├── proposals/            # 技术提案（评审后锁定）
├── plan/                 # 实现计划（从 proposal 拆解出的可执行任务）
└── acceptance/           # 验收报告（含 archived/ 归档子目录，规范见 acceptance/AGENTS.md）
```

## 文件命名规范

遵循 [[../../.agents/skills/z-document/SKILL.md|z-document]] 标准：

```
{YYYYMMDD}-{feat|fix|refactor}-{slug}.md
```

- **日期**: 使用创建日期，格式 `YYYYMMDD`（如 `20260521-`）
- **类型**: 类型前缀，`feat`（新功能）、`fix`（修复）、`refactor`（重构）
- **标题**: 类型之后紧跟，使用连字符分隔

示例：`20260521-feat-acp-session-sync.md`

## 文档结构

每个技术提案（proposal）应包含 YAML front matter：

```markdown
---
description: 简短说明此技术提案的用途
type: Permanent
---

# 标题 - 技术提案

**功能名称**: ...
**关联 PRD**: ...
**技术提案版本**: v1.0
**创建日期**: YYYY-MM-DD
**作者**: ...
**feat-branch**: `feat/<slug>`

## 1. 概述

### 1.1 背景
### 1.2 目标
### 1.3 范围

## 2. 技术架构

### 2.1 系统架构图
### 2.2 技术栈
### 2.3 模块划分

## 3. API 设计

### 3.1 API 契约
### 3.2 内部接口

## 4. 数据模型

### 4.1 数据库设计
### 4.2 缓存设计

## 5. 技术实现方案

### 5.1 核心流程
### 5.2 关键实现点

## 6. 技术决策

### 6.1 决策列表
### 6.2 依赖与约束

## 7. 项目结构

## 8. 测试策略

## 9. 验收标准

## 10. 相关文档
```

技术提案中允许包含详细的技术细节（项目结构、API 设计、数据模型等），必须使用 Mermaid 图形描述流程和架构。

## 工作流程

```mermaid
flowchart LR
    P[产品 PRD Review 通过] --> T[编写技术提案]
    T --> R[Review 技术提案]
    R -->|通过| C[更新 API Contract]
    C --> I[编码实现]
    I --> E[编排 + 测试]
    E --> M[合并入主干]
```

### 创建提案

1. 加载 `z-coding` skill
2. 加载产品文档，理解需求
3. 创建文件到 `proposals/` 目录，以创建日期为 ID
4. 完成后发起 Review

### 修改提案

1. 直接编辑对应文件
2. 更新版本号
3. 记录变更原因

## Skill 参考

| Skill | 用途 |
|-------|------|
| [[../../.agents/skills/z-coding/SKILL.md\|z-coding]] | 契约式开发全流程 |
| [[../../.agents/skills/z-document/SKILL.md\|z-document]] | 文档格式与命名规范 |
| [[../../.agents/skills/z-test/SKILL.md\|z-test]] | API 测试与 E2E 测试 |
| [[../../.agents/skills/z-aspire-orchestrator/SKILL.md\|z-aspire-orchestrator]] | 服务编排 |
| [[../../.agents/skills/tdd/SKILL.md\|tdd]] | 测试驱动开发（红-绿-重构循环） |

## 相关文档

### 规范文件

- [[common-rules.md]] — 通用开发规范
- [[backend-rules.md]] — 后端开发规范
- [[frontend-rules.md]] — 前端开发规范

### 技术提案（`proposals/`）

- [[proposals/20260517-feat-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[proposals/20260517-feat-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[proposals/20260517-feat-user-auth-and-settings.md]] — 用户认证与设置页
- [[proposals/20260518-feat-agent-session.md]] — Agent 拉起与交互
- [[proposals/20260519-feat-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[proposals/20260519-feat-test-coverage-agent-session.md]] — Session 测试覆盖
- [[proposals/20260519-fix-acceptance-issues.md]] — 验收问题分析与修复
- [[proposals/20260519-fix-acp-rendering.md]] — ACP 消息渲染改造
- [[proposals/20260519-fix-acp-session-init.md]] — ACP Session 初始化修复
- [[proposals/20260519-fix-frontend-acp-response.md]] — 前端 ACP 会话修复
- [[proposals/20260520-feat-session-reopen.md]] — Session Re-open
- [[proposals/20260520-refactor-controller-acp-sdk.md]] — ACP SDK 重构
- [[proposals/20260521-feat-acp-session-sync.md]] — 工作目录历史会话同步
- [[proposals/20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换
- [[proposals/20260522-feat-local-controller-config-page.md]] — 本地控制器配置页
- [[proposals/20260522-feat-model-switch-support.md]] — 模型切换支持
- [[proposals/20260523-feat-git-worktree-support.md]] — Git Worktree 支持
- [[proposals/20260523-feat-workspace-git-support.md]] — 工作区 Git 支持
- [[proposals/20260524-feat-docker-compose-support.md]] — Aspire Docker Compose 集成
- [[proposals/20260524-feat-session-message-history-optimization.md]] — 会话消息历史优化
- [[proposals/20260526-feat-multi-acp-server-support.md]] — 多 ACP Server 支持
- [[proposals/20260526-fix-acceptance-session-state.md]] — 验收 Session 状态修复
- [[proposals/20260526-proposal-ui-optimization.md]] — UI 优化一期
- [[proposals/20260526-proposal-ui-optimization-phase2.md]] — UI 优化二期
- [[proposals/20260527-feat-mobile-layout.md]] — 移动端布局
- [[proposals/20260527-feat-port-forwarding.md]] — 本地 Agent 控制器端口转发
- [[proposals/20260527-feat-unified-agent-status.md]] — 统一 Agent 状态
- [[proposals/20260527-fix-acp-server-windows-launch.md]] — ACP Server Windows 启动修复
- [[proposals/20260528-feat-acp-permission-reminder.md]] — ACP 授权提醒
- [[proposals/20260528-proposal-ui-optimization-phase3.md]] — UI 优化三期
- [[proposals/20260529-command-mode.md]] — 命令模式
- [[proposals/20260529-feat-dark-mode.md]] — 黑暗模式
- [[proposals/20260530-feat-mcp-proxy-config.md]] — MCP 代理服务配置
- [[proposals/20260705-feat-acp-server-extend.md]] — ACP Server 支持扩展
- [[proposals/20260721-refactor-frontend-design-overhaul.md]] — 整体前端设计优化（设计语言升级与视觉重构）
- [[proposals/20260803-feat-acp-v1-completion.md]] — ACP v1 协议补全与展示优化
- [[proposals/20260829-fix-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复
- [[proposals/20260907-feat-experience-optimization-phase1.md]] — 综合体验优化一期
- [[proposals/20260908-feat-frontend-auto-select-server.md]] — 前端支持服务器自动选择
- [[proposals/20260829-refactor-mcp-controller-proxy.md]] — MCP 传递重构一期（控制器代理 MCP 访问）
- [[proposals/20261008-feat-domestic-api-acceleration.md]] — Web 国内加速 API 接入（Controller API 自动选择）
- [[proposals/20261013-feat-unified-home-display.md]] — 首页展示优化
- [[proposals/20261014-feat-admin-console.md]] — 云控制器管理后台一期
- [[proposals/20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- [[proposals/20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[proposals/20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[proposals/20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）
- [[proposals/20261018-feat-workload-phase4.md]] — 工作负载四期（worker 基础镜像瘦身）
- [[proposals/20261018-fix-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）
- [[proposals/20261019-feat-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）
- [[proposals/20261017-feat-controller-version-requirement.md]] — 云端工作容器控制器版本门禁与自升级
- [[proposals/20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）
- [[proposals/20261020-fix-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）
- [[proposals/20261021-feat-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）
- [[proposals/20261021-feat-acp-protocol-enhancement-opencode-support.md]] — ACP 协议增强调研附录：OpenCode ACP 支持清单
- [[proposals/20261021-feat-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、最小化凭据 clone 并自动建会话）
- [[proposals/20261020-feat-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v5.0 停止即销毁/会话只读/每用户 1 实例；会话导入导出与统一存储二期）
- [[proposals/20261022-feat-workload-optimization.md]] — 工作负载优化（云电脑创建/展示支持 standard 负载与 MCP 列出安装，Github 项目 clone 地址前缀拼接）
- [[proposals/20261022-feat-cloud-container-optimization-phase1.md]] — 云容器优化一期（会话/工作流「+」列表实时刷新、云电脑创建前端编排 Github 项目准备并复用工作负载进度框、默认 MCP 注入与控制器默认 MCP、CreateSessionInput 前置 modeId/modelId 与选项 5 分钟缓存/失效/刷新）
- [[proposals/20261023-feat-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（linkPullRequest MCP 工具与 PR Handler Registry、人类节点「联动上游 Pull Request」、工作流追加提示词 key 去重、事件回调按 review 状态驱动人类节点完成/打回）
- [[proposals/20261023-feat-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区：仅「Git 项目设置」初始化 Github 项目才创建工作区、Model.contextLength 后台模型最长上下文并经 OpenAI 兼容 /v1/models 的 context_length 下发、云电脑 Job 模板 ephemeral-storage 上限 10Gi）
- [[proposals/20261025-fix-opencode-model-context-length.md]] — 云电脑 OpenCode 模型上下文长度下发修复（secrets.modelContextLengths → ZAG_MODEL_CONTEXT_LENGTHS → opencode models.limit.context）
- [[proposals/20261025-feat-kimi-code-harness.md]] — 增加工作负载「Kimi Code」（Harness）（harnessTypes 扩展 kimi_code 与预置工作负载 009、agent-gear 2.8.0 kimi 登录闸门 `kimi login` stdio 判定、harness:login 事件族与登录引导弹窗、按 harnessTypes 细分版本门禁）
- [[proposals/20261025-feat-github-native-webhook.md]] — GitHub 原生 Webhook 入口（POST /api/events/github/webhook 直连 pull_request_review，HMAC-SHA256 验签后归一化复用 PR 联动判定链）
- [[proposals/20261025-fix-cloud-container-active-deadline.md]] — 云电脑取消 Job 最长运行时间限制（移除 activeDeadlineSeconds，expiresAt 仅落库留存）

### 实现计划（`plan/`）

- [[plan/20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换实现计划
- [[plan/20260522-feat-local-controller-config-page.md]] — 本地控制器配置页实现计划
- [[plan/20260523-feat-git-worktree-support.md]] — Git Worktree 支持实现计划
- [[plan/20260523-feat-workspace-git-support.md]] — 工作区 Git 支持实现计划
- [[plan/20260524-feat-session-message-history-optimization.md]] — 会话消息历史优化实现计划
- [[plan/20260526-feat-multi-acp-server-support.md]] — 多 ACP Server 支持实现计划
- [[plan/20260526-fix-acceptance-session-state.md]] — 验收 Session 状态修复实现计划
- [[plan/20260526-plan-ui-optimization.md]] — UI 优化一期实现计划
- [[plan/20260526-plan-ui-optimization-phase2.md]] — UI 优化二期实现计划
- [[plan/20260527-feat-port-forwarding.md]] — 本地 Agent 控制器端口转发实现计划
- [[plan/20260527-fix-acp-server-windows-launch.md]] — ACP Server Windows 启动修复实现计划
- [[plan/20260527-mobile-layout.md]] — 移动端布局实现计划
- [[plan/20260527-unified-agent-status.md]] — 统一 Agent 状态实现计划
- [[plan/20260528-feat-acp-permission-reminder.md]] — ACP 授权提醒实现计划
- [[plan/20260528-plan-ui-optimization-phase3.md]] — UI 优化三期实现计划
- [[plan/20260529-command-mode-implementation.md]] — 命令模式实现计划
- [[plan/20260529-feat-dark-mode.md]] — 黑暗模式实现计划
- [[plan/20260530-feat-mcp-proxy-config.md]] — MCP 代理服务配置实现计划
- [[plan/20260707-feat-unified-gateway.md]] — 统一网关实现计划
- [[plan/20260709-feat-github-account-binding.md]] — GitHub 帐号绑定实现计划
- [[plan/20260710-fix-gateway-dual-auth.md]] — 网关双重认证修复实现计划
- [[plan/20260721-feat-acp-mimo-kimi.md]] — ACP Server 支持 MiMo Code / Kimi Code CLI 实现计划
- [[plan/20260721-refactor-frontend-design-overhaul.md]] — 整体前端设计优化实现计划
- [[plan/20260723-feat-session-scroll-loading.md]] — Session 对话滚动加载实现计划
- [[plan/20260803-feat-acp-v1-completion.md]] — ACP v1 协议补全与展示优化实现计划
- [[plan/20260811-feat-agent-workflow-phase2.md]] — Agent 工作流二期（工作流管理与实例化机制完善）实现计划
- [[plan/20260817-feat-session-lifecycle-and-worktree-management.md]] — 会话生命周期与 Worktree 管理增强实现计划
- [[plan/20260821-feat-workflow-optimization.md]] — 工作流优化 0821 实现计划
- [[plan/20260829-fix-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复实现计划
- [[plan/20260829-refactor-mcp-controller-proxy.md]] — MCP 传递重构一期（控制器代理 MCP 访问）实现计划
- [[plan/20260907-feat-experience-optimization-phase1.md]] — 综合体验优化一期实现计划
- [[plan/20260908-feat-frontend-auto-select-server.md]] — 前端支持服务器自动选择实现计划
- [[plan/20261008-feat-domestic-api-acceleration.md]] — Web 国内加速 API 接入（Controller API 自动选择）实现计划
- [[plan/20261013-feat-unified-home-display.md]] — 首页展示优化实现计划
- [[plan/20261014-feat-admin-console.md]] — 云控制器管理后台一期实现计划
- [[plan/20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）实现计划
- [[plan/20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能实现计划
- [[plan/20261017-feat-controller-version-requirement.md]] — 云端工作容器控制器版本门禁与自升级实现计划
- [[plan/20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）实现计划
- [[plan/20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）实现计划
- [[plan/20261018-feat-workload-phase4.md]] — 工作负载四期（工作容器基础环境瘦身）实现计划
- [[plan/20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）实现计划
- [[plan/20261018-fix-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）实现计划
- [[plan/20261019-feat-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）实现计划
- [[plan/20261020-fix-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）实现计划
- [[plan/20261021-feat-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）实现计划
- [[plan/20261020-feat-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v3.0：前台交付/停止即销毁/会话只读/每用户 1 实例/harnessTypes 多选）实现计划
- [[plan/20261021-feat-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、云主机凭据管理器 clone 并自动建会话）实现计划
- [[plan/20261022-feat-workload-optimization.md]] — 工作负载优化（创建/展示支持 Aspire/Docker/.NET 与 MCP 列出安装，Github 项目 clone 地址前缀拼接）实现计划
- [[plan/20261022-feat-cloud-container-optimization-phase1.md]] — 云容器优化一期（「+」列表实时刷新、云电脑创建前端编排 Github 项目并复用进度框、默认 MCP 注入与控制器默认 MCP、前置 modeId/modelId 与选项 300s 缓存/失效/刷新）实现计划
- [[plan/20261023-feat-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（契约、PR Handler Registry 与迁移、追加提示词 key 去重、人类节点联动字段、linkPullRequest MCP 工具与生命周期注销、事件回调判定链与 review 驱动）实现计划
- [[plan/20261023-feat-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区、Model.contextLength 经 OpenAI 兼容 /v1/models 的 context_length 下发、ephemeral-storage 10Gi）实现计划
