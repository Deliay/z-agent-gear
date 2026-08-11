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

## Test Pitfalls

- **API 测试能确定性复现分布式时序 bug**。fake 上游高频连发 + 真实 Mongo/Redis + SSE 接收的组合，把单测中需精心构造的竞态在集成环境直接暴露，是此类 bug 最有效的回归手段。
- **真实 agent 的确定性覆盖边界**。真实 opencode 的 initialize/session/new 可确定性验证（能力协商、握手回归），但触发 agent 主动发起动作需要 LLM 决策，不确定性部分用 wire 级 fake agent（同一协议字节流）补齐，形成「真实握手 + 协议字节流 + 全链路 stub」三层覆盖。
- **测试进程环境要隔离宿主 env**。spawn 真实进程做集成测试时，`{ ...process.env }` 会把宿主配置覆盖变量（如 `ZAG_CONTROLLER_KEY`）带进被测进程，config 优先级（CLI > env > file）会放大该问题。
- **状态机语义演进要回填测试断言**。状态语义变更（如拆出 `idling`）后，存量测试期望旧值会形成基线腐化；应全局检索测试断言同步更新。
- **E2E 与 API 套件不宜并行跑在同一套服务上**。二者共用 Mongo/Redis/服务进程，并行会造成超时型假失败；验收验证应串行执行或隔离环境。
- **fake controller 秒回响应会掩盖竞态**。API/E2E 测试中的假 controller 应有意识地引入延迟变体（如 `startDelayMs`），才能覆盖真实 harness 的慢启动场景（如「start 完成前发送的消息需排队补发」）。
- **动画中的元素尺寸断言会抖动**。入场 zoom 动画期间 `boundingBox()` 量到的是缩放后的尺寸，宽度断言应用 `clientWidth`（布局尺寸，不受 transform 影响）。
- **会话关闭后其 MCP scoped token 随之失效**。E2E/集成测试模拟「人类介入后 AI 调工具」时，需先恢复会话拿到新签发的 token 再调 MCP。

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
