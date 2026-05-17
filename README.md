# ZeroAsh's Agent Gear

一站式个人多端管理 Agent 解决方案。

## 项目结构

```
z-agent-gear/
├── apps/
│   └── agent-web/           # React + TypeScript + Vite 前端
├── servers/
│   └── agent-api/           # Node.js + Express + GraphQL + Mongoose 后端
├── aspire/
│   └── AgentGear.AppHost/   # .NET Aspire 服务编排
├── packages/                 # 公共包
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

## 技术栈

| 分类 | 选型 |
|------|------|
| 前端 | React + TypeScript + Vite + Tailwind CSS |
| 后端 | Node.js + Express + GraphQL-Yoga + Mongoose |
| 数据库 | MongoDB |
| 缓存 | Redis |
| 编排 | .NET Aspire |

## 快速开始

```bash
# 安装所有依赖
cd servers/agent-api && npm install
cd apps/agent-web && npm install

# 使用 Aspire 运行（推荐 - 自动管理 MongoDB/Redis 容器）
cd aspire/AgentGear.AppHost && dotnet run

# 或分别启动
cd servers/agent-api && npm run dev
cd apps/agent-web && npm run dev
```
