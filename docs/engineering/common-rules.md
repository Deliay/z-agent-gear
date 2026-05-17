# Common Development Rules

## Development Flow

1. **Skill-First**: Always check if a relevant skill exists before starting work. Load the skill first.
2. **Contract-First**: Define API contracts (GraphQL schema, OpenAPI spec) before implementation.
3. **TDD**: Write tests before implementation code where possible.
4. **Product Doc Review**: Load and review product documents before starting implementation.
5. **Code Review**: All code must be reviewed before merging to main.

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
