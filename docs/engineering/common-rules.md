# Common Development Rules

## Development Flow

1. **Skill-First**: Always check if a relevant skill exists before starting work. Load the skill first.
2. **Contract-First**: Define API contracts (GraphQL schema, OpenAPI spec) before implementation.
3. **TDD**: Write tests before implementation code where possible.
4. **Product Doc Review**: Load and review product documents before starting implementation.
5. **Code Review**: All code must be reviewed before merging to main.

## TDD Workflow

采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

### 1. 规划阶段
- 确认需要哪些接口变更
- 确认需要测试哪些行为（按优先级排序）
- 识别创建深模块的机会（小接口，深实现）
- 设计可测试的接口
- 列出要测试的行为（不是实现步骤）
- 获得用户对计划的批准

### 2. 示踪子弹
编写一个测试，验证系统的一个行为：
```
RED:   编写第一个行为的测试 → 测试失败
GREEN: 编写最少代码使测试通过 → 测试通过
```

### 3. 增量循环
对每个剩余行为：
```
RED:   编写下一个测试 → 失败
GREEN: 编写最少代码使测试通过 → 通过
```

规则：
- 一次只写一个测试
- 只写刚好能通过当前测试的代码
- 不要预测未来的测试
- 保持测试专注于可观察行为

### 4. 重构
所有测试通过后，寻找重构候选：
- 提取重复代码
- 深化模块（将复杂性移到简单接口后面）
- 在自然的地方应用SOLID原则
- 考虑新代码揭示了现有代码的什么问题
- 每个重构步骤后运行测试

**永远不要在RED状态时重构。先达到GREEN状态。**

详细指南请参考：[[../../.agents/skills/tdd/SKILL.md|tdd]]

## Branch Convention

- `main` — production-ready code
- `feat/<name>` — new features
- `fix/<name>` — bug fixes
- `refactor/<name>` — refactoring
- `docs/<name>` — documentation changes

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

feat: add agent connection management
fix: resolve websocket reconnection issue
docs: update API documentation
refactor: extract agent service
test: add agent resolver tests
```

## Code Quality

- All code must pass TypeScript strict mode checks.
- Maintain test coverage above 80%.
- Run lint and type checks before every commit.
- No commented-out code in production branches.

## Review Requirements

- At least one approval required for PR merge.
- All automated checks must pass.
- No direct pushes to `main` branch.

## Available Skills

| Skill | Description |
|-------|-------------|
| z-product | Product document creation and lifecycle management (PRD workflow) |
| z-project | Project creation and management (monorepo support, tech stack selection) |
| z-coding | Contract-based development workflow (proposal, contract, implementation) |
| z-git | Git workflow management (using worktree) |
| z-document | Documentation standards (Zettelkasten method, Mermaid diagrams) |
| z-aspire-orchestrator | Service orchestration with Microsoft Aspire |
| z-test | API testing and E2E testing workflow |
| z-debugging | Debugging methodology and troubleshooting |
| tdd | Test-driven development with red-green-refactor loop |
