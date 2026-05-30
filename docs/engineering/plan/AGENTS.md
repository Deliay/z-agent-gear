# Plan 文档管理

本文档描述了 `docs/engineering/plan/` 目录下的实现计划管理规范。

## 目录结构

```
engineering/
├── AGENTS.md             # Engineering 目录规范
├── common-rules.md       # 通用开发规范
├── backend-rules.md      # 后端开发规范
├── frontend-rules.md     # 前端开发规范
├── proposals/            # 技术方案（评审后锁定）
└── plan/                 # 实现计划（从 proposal 拆解出的可执行任务）
```

## 文件命名规范

与 proposal 保持一致：

```
{YYYYMMDD}-{feat|fix|refactor}-{slug}.md
```

- **日期**: 与对应 proposal 日期一致
- **slug**: 与对应 proposal 一致

## Plan 文档用途

Plan 文件从已通过的 proposal 中拆解出具体的实现步骤，包含：

- **实现顺序**：子项目间的依赖关系，明确先做什么后做什么
- **子项目任务**：每个子项目（agent-api / controller-api / agent-controller / agent-web）的精确文件修改列表
- **命令参考**：启动、测试、lint 等命令
- **验收 checklist**：分阶段验证点

Plan 是开发阶段的核心参考文档，开发过程中可按实际情况更新。

## Skill 参考

| Skill | 用途 |
|-------|------|
| [[../../../.agents/skills/z-coding/SKILL.md\|z-coding]] | 契约式开发全流程 |
| [[../../../.agents/skills/z-test/SKILL.md\|z-test]] | API 测试与 E2E 测试 |
| [[../../../.agents/skills/z-aspire-orchestrator/SKILL.md\|z-aspire-orchestrator]] | 服务编排 |
| [[../../../.agents/skills/tdd/SKILL.md\|tdd]] | 测试驱动开发（红-绿-重构循环） |
