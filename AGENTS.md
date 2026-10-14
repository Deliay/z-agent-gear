# ZeroAsh's Agent Gear

一站式个人多端管理 Agent 解决方案。

## 项目结构

```
z-agent-gear/
├── apps/
│   ├── admin-web/           # React + TypeScript + Vite 管理后台前端
│   └── agent-web/           # React + TypeScript + Vite 前端
├── servers/
│   ├── admin-api/           # Node.js + Express + GraphQL + Mongoose 管理后台后端
│   ├── agent-api/           # Node.js + Express + GraphQL + Mongoose 后端
│   └── controller-api/      # Node.js + Express + Socket.IO 后端
├── packages/
│   └── agent-controller/    # Node.js CLI 客户端
├── aspire/
│   ├── manifest/              # Docker Compose 部署产物（aspire publish 生成）
│   └── AgentGear.AppHost/   # .NET Aspire 服务编排
├── docs/
│   ├── product/              # 产品文档
│   │   ├── draft/
│   │   ├── reviewed/
│   │   ├── shipping/
│   │   └── released/
│   └── engineering/          # 开发规范
│       ├── acceptance/       # 验收报告
│       └── proposals/
├── contracts/                # API 契约文件
└── tests/                    # 集成/E2E 测试
```

## 启动项目

```bash
# 方式一：Aspire（默认）
aspire start    # 启动全部服务（agent-api + admin-api + controller-api + agent-web + admin-web + MongoDB + Redis）

# 方式二：Docker Compose
aspire publish -o aspire/manifest    # 生成 docker-compose.yaml
rm -f aspire/manifest/*.Dockerfile   # 清理不需要的 Dockerfile
docker compose -f aspire/manifest/docker-compose.yaml up -d
docker compose -f aspire/manifest/docker-compose.yaml down
```

## 开发流程

1. Always check and load relevant skills before starting work.
2. Follow contract-based development: define contracts first, then implement.
3. **采用TDD模式开发**：使用红-绿-重构循环，先写测试再写实现代码。
4. Reference rules in `docs/engineering/` before writing code.

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
| tdd | Test-driven development with red-green-refactor loop |
