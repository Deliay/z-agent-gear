# agent-api

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + GraphQL-Yoga
- **ODM**: Mongoose (MongoDB)
- **Cache**: Redis (via Aspire)
- **Dev Runner**: tsx (watch mode)
- **Testing**: Vitest

## Architecture

```
src/
├── config/           # Environment configuration
├── graphql/
│   ├── schemas/      # GraphQL type definitions
│   └── resolvers/    # GraphQL resolvers
├── models/           # Mongoose models
├── services/         # Business logic
├── middleware/        # Express middleware
└── index.ts          # Entry point
```

## Dev Commands

```bash
aspire start    # Start all services via Aspire orchestration
npm run build   # Compile TypeScript
npm run start   # Start production server
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 agent-api 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)

## Lessons Learned

### 重构时断言所有关键副作用

当重构将链式操作拆解（如 `findOneAndDelete` → `findOne` + `deleteOne`），测试必须断言**所有的关键副作用**，不能只断言新调用而忽略旧行为中隐含的步骤。

具体检查清单：
1. 新调用的方法是否被正确调用 ✅
2. **旧调用中隐含的操作是否仍然存在** ❌（常见遗漏点）
3. 删除操作（`deleteOne`/`deleteMany`/`findOneAndDelete`）是否仍被执行
4. 不带返回值的方法（如 `deleteOne`）最容易被遗忘，必须显式 mock + 断言

### Mock 配置要与实际代码同步

- `vi.mock` 中列出的 mock 方法必须覆盖实际代码使用的所有方法，否则测试可能因"方法不存在"而静默失败。
- 重构增删了数据访问方法后，同步更新 `vi.mock` 工厂中的 mock 列表。
