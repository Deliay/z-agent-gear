# ZeroAsh's Agent Gear

一站式个人多端管理 Agent 解决方案。

## 项目结构

```
z-agent-gear/
├── apps/
│   └── agent-web/           # React + TypeScript + Vite 前端
├── servers/
│   ├── agent-api/           # Node.js + Express + GraphQL + Mongoose 后端
│   └── controller-api/      # Node.js + Express + Socket.IO 后端
├── packages/
│   └── agent-controller/    # Node.js CLI 客户端
├── aspire/
│   └── AgentGear.AppHost/   # .NET Aspire 服务编排
├── docs/
│   ├── product/              # 产品文档
│   │   ├── draft/
│   │   ├── reviewed/
│   │   ├── shipping/
│   │   └── released/
│   └── engineering/          # 开发规范
│       └── proposals/
├── contracts/                # API 契约文件
└── tests/                    # 集成/E2E 测试
```

## 启动项目

```bash
aspire start    # 启动全部服务（agent-api + controller-api + agent-web + MongoDB + Redis）
```

## 开发流程

1. Always check and load relevant skills before starting work.
2. Follow contract-based development: define contracts first, then implement.
3. Reference rules in `docs/engineering/` before writing code.

## Skill References

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
