# Engineering 文档管理

本文档描述了 `docs/engineering/` 目录下的技术文档管理规范。

## 目录结构

```
engineering/
├── AGENTS.md             # 本文件：目录规范说明
├── common-rules.md       # 通用开发规范
├── backend-rules.md      # 后端开发规范
├── frontend-rules.md     # 前端开发规范
└── proposals/            # 技术提案
```

## 文件命名规范

遵循 [[../../.agents/skills/z-document/SKILL.md|z-document]] 标准：

```
{ID}-{Title-With-Hyphens}.md
```

- **ID**: 使用创建日期作为唯一标识符，格式 `YYYYMMDD`（如 `20260521-`），仅用于排序和去重
- **标题**: ID 之后紧跟，使用连字符分隔

示例：`20260521-proposal-acp-session-sync.md`

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

## 相关文档

- [[common-rules.md]] — 通用开发规范
- [[backend-rules.md]] — 后端开发规范
- [[frontend-rules.md]] — 前端开发规范
- [[proposals/20260517-proposal-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[proposals/20260518-proposal-agent-session.md]] — Agent 拉起与交互
- [[proposals/20260518-test-coverage-agent-session.md]] — Session 测试覆盖
- [[proposals/20260519-proposal-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[proposals/20260520-proposal-controller-acp-sdk-refactor.md]] — ACP SDK 重构
- [[proposals/20260520-proposal-session-reopen.md]] — Session Re-open
- [[proposals/20260521-proposal-acp-session-sync.md]] — 工作目录历史会话同步
- [[proposals/20260517-proposal-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[proposals/20260517-proposal-user-auth-and-settings.md]] — 用户认证与设置页
