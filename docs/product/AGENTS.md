# Product 文档管理

本文档描述了 `docs/product/` 目录下的产品文档管理规范。

## 生命周期

产品文档经历四个阶段，对应四个子目录：

| 阶段 | 目录 | 说明 |
|------|------|------|
| 草稿 | `draft/` | 新建或编辑中的产品文档，等待 Review |
| 已审 | `reviewed/` | 通过 Review，准备开始实现 |
| 实现中 | `shipping/` | 正在开发实现中的产品文档 |
| 已发布 | `released/` | 已成功上线验收的产品文档 |

## 文件命名规范

遵循 [[../../.agents/skills/z-document/SKILL.md|z-document]] 标准：

```
{ID}-{Title-With-Hyphens}.md
```

- **ID**: 使用创建日期作为唯一标识符，格式 `YYYYMMDD`（如 `20260521-`），仅用于排序和去重
- **标题**: ID 之后紧跟，使用连字符分隔

示例：`20260521-acp-session-sync-PRD.md`

## 文档结构

每个产品文档应包含 YAML front matter 及以下内容：

```markdown
---
description: 简短说明此文档的用途
type: Permanent
---

# 需求名称

**功能名称**: ...
**PRD 版本**: v1.0
**创建日期**: YYYY-MM-DD
**作者**: ...

## 背景与目标

### 1.1 背景
### 1.2 目标
### 1.3 成功标准

## 用户分析

### 2.1 目标用户
### 2.2 用户场景

## 功能需求

### 3.1 功能概述
### 3.2 功能列表
### 3.3 用户操作流程
### 3.4 页面/界面描述
### 3.5 异常与边界情况

## 四、非功能需求

## 五、依赖与约束

## 六、相关文档
```

产品文档中禁止提及技术细节，禁止提及项目结构、前端组件、后端 API 设计等内容。必须使用 Mermaid 图形描述流程。

## 工作流程

```mermaid
flowchart LR
    D[draft/] -->|Review 通过| R[reviewed/]
    R -->|开始实现| S[shipping/]
    S -->|上线验收| P[released/]
```

### 创建文档

1. 加载 `z-product` skill
2. 使用 `question` 工具澄清产品细节
3. 创建文件到 `draft/` 目录，以创建日期为 ID
4. 提交流程遵循项目 git 规范

### 修改文档

1. 确认文档所在阶段目录
2. 修改后保持文件名不变
3. 更新 PRD 版本号

### Review 文档

1. 确认内容无技术细节
2. 确认满足文档结构模板要求
3. 确认 YAML front matter 完整
4. 通过后移入 `reviewed/` 目录

## Skill 参考

| Skill | 用途 |
|-------|------|
| [[../../.agents/skills/z-product/SKILL.md\|z-product]] | 产品文档完整生命周期管理 |
| [[../../.agents/skills/z-document/SKILL.md\|z-document]] | 文档格式与命名规范 |

## 相关文档

### 草稿文档（`draft/`）

- [[draft/20260811-agent-workflow-phase2.md]] — Agent 工作流二期
- [[draft/20260817-session-lifecycle-and-worktree-management.md]] — 会话生命周期与 Worktree 管理
- [[draft/20260821-workflow-optimization.md]] — 工作流优化 0821
- [[draft/20260829-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复
- [[draft/20260907-experience-optimization-phase1.md]] — 综合体验优化一期
- [[draft/20261014-admin-console.md]] — 云控制器管理后台一期
- [[draft/20261014-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- [[draft/20261017-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[draft/20261018-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[draft/20261018-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）
- [[draft/20261018-workload-phase4.md]] — 工作负载四期（工作容器基础环境瘦身）
- [[draft/20261018-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）
- [[draft/20261019-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）
- [[draft/20261017-controller-version-requirement.md]] — 云端工作容器控制器版本兼容与自动恢复
- [[draft/20261018-credits-billing.md]] — 费用中心（Credits 计费）
- [[draft/20261020-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）
- [[draft/20261021-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）
- [[draft/20261021-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、云主机申请最小化凭据 clone 并自动建会话）
- [[draft/20261022-workload-optimization.md]] — 工作负载优化（云电脑支持 Aspire/Docker/.NET 负载展示与使用、MCP 列出与安装，Github 项目 clone 地址前缀拼接）
- [[draft/20261023-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区：仅「Git 项目设置」初始化 Github 项目时创建工作区并回写 workspaceId、后台模型设置支持模型最长上下文大小、云电脑模板 ephemeral-storage 上限 10Gi 仅 limits）
- [[draft/20261020-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v5.0 停止即销毁/会话只读/每用户 1 实例；会话导入导出与统一存储二期）
- [[draft/20261022-cloud-container-optimization-phase1.md]] — 云容器优化一期（会话/工作流「+」列表实时刷新、新建云电脑初始化 Github 项目、新建会话默认注入 MCP 与默认 MCP 设置、拉起会话前置选择模型与模式）
- [[draft/20261023-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（工作流关联 GitHub PR 并随完成/归档注销、人类节点「联动上游 Pull Request」由审核结果驱动完成/打回、工作流追加提示词与 PR 工具使用指引）
- [[draft/20261025-opencode-model-context-length.md]] — 云电脑 OpenCode 模型上下文长度下发修复（后台配置的模型最长上下文随模型清单写入云电脑内 OpenCode 配置）
- [[draft/20261025-kimi-code-harness.md]] — 增加工作负载「Kimi Code」（Harness）（与 OpenCode 同级的第二个 harness 工具、使用前登录确认与登录引导弹窗：按 stdio 登录链接授权后自动继续）
- [[draft/20261025-github-issues-workflow.md]] — 云电脑 GitHub Issues 联动工作流（云电脑设置「Github」区块以列表维护多条联动配置：先选含人类节点的已配置工作流、默认标签 start-{工作流名字}可改、多选仓库并同步标签；带标签 Issue 自动完成工作区准备、实例化工作流、回评工作流地址、首个人类节点自动完成；销毁云电脑时经确认清理已同步标签）
- [[draft/20261025-workflow-check-runs-sync.md]] — 工作流节点状态通过 GitHub Check Runs 同步（绑定 PR 的节点状态写入 PR 最新提交检查项、旧提交标记 stale、todo panel 同步为检查项子项）
- [[draft/20261025-deepseek-harness.md]] — 增加工作负载「DeepSeek Harness」（Harness）（与 OpenCode / Kimi Code 同级的第三个 harness 工具、启动时默认注入平台渠道模型：开箱即用无需登录、模型选择仅平台渠道一组）

### 实现中文档（`shipping/`）

- [[shipping/20261025-cloud-container-unlimited-lifetime.md]] — 云电脑取消最长运行时间限制（云端工作容器不再因到达时间上限被平台强制销毁）

### 已发布文档（`released/`）

- [[released/20260517-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[released/20260517-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[released/20260517-user-auth-and-settings.md]] — 用户认证与设置页
- [[released/20260518-agent-session-interaction.md]] — Agent 拉起与交互
- [[released/20260519-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[released/20260520-session-reopen-prd.md]] — Session Re-open
- [[released/20260521-acp-session-sync-history.md]] — 工作目录历史会话同步
- [[released/20260522-available-models-and-mode-switch.md]] — 可用模型与模式切换
- [[released/20260522-local-controller-config-page.md]] — 本地控制器配置页
- [[released/20260522-model-switch-support.md]] — 模型切换支持
- [[released/20260523-git-worktree-support-prd.md]] — Git Worktree 支持
- [[released/20260523-workspace-git-support-prd.md]] — 工作区 Git 支持
- [[released/20260524-session-message-history-optimization.md]] — 会话消息历史优化
- [[released/20260526-multi-acp-server-support.md]] — 多 ACP Server 支持
- [[released/20260526-ui-optimization.md]] — UI 优化一期
- [[released/20260526-ui-optimization-phase2.md]] — UI 优化二期
- [[released/20260527-mobile-layout.md]] — 移动端布局
- [[released/20260527-port-forwarding-for-local-agent-controller.md]] — 本地 Agent 控制器端口转发
- [[released/20260527-unified-agent-status.md]] — 统一 Agent 状态
- [[released/20260528-acp-permission-reminder.md]] — ACP 授权提醒
- [[released/20260528-frontend-ui-optimization.md]] — 前端界面优化三期
- [[released/20260529-command-mode.md]] — 命令模式
- [[released/20260529-dark-mode.md]] — 黑暗模式
- [[released/20260530-mcp-proxy-config.md]] — MCP 代理服务配置
- [[released/20260705-acp-server-extend.md]] — ACP Server 支持扩展
- [[released/20260707-unified-gateway.md]] — 统一网关功能
- [[released/20260709-github-account-binding.md]] — GitHub 帐号绑定
- [[released/20260721-acp-server-mimo-kimi.md]] — ACP Server 支持 MiMo Code / Kimi Code CLI
- [[released/20260721-frontend-design-overhaul.md]] — 整体前端设计优化
- [[released/20260723-session-scroll-loading.md]] — Session 对话滚动加载
- [[released/20260803-acp-v1-completion.md]] — ACP v1 协议补全与展示优化
- [[released/20260804-chat-interaction-optimization.md]] — 对话交互优化
- [[released/20260804-integrated-mcp-registry.md]] — 集成式 MCP 注册中心
- [[released/20260808-agent-workflow.md]] — Agent 工作流
