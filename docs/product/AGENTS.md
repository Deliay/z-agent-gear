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

- [[draft/20260521-acp-session-sync-PRD.md]] — 工作目录历史会话同步（草稿）
- [[released/20260517-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[released/20260518-agent-session-interaction.md]] — Agent 拉起与交互
- [[released/20260517-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[released/20260519-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[released/20260520-session-reopen-prd.md]] — Session Re-open
- [[released/20260517-user-auth-and-settings.md]] — 用户认证与设置页
