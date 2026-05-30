# agent-web

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **GraphQL Client**: Apollo Client
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library

## Dev Commands

```bash
aspire start     # Start all services via Aspire orchestration
npm run build    # Production build
npm run preview  # Preview production build
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 agent-web 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)
