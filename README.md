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
│   ├── manifest/            # Docker Compose 部署产物
│   └── AgentGear.AppHost/   # .NET Aspire 服务编排
├── docs/
│   ├── product/             # 产品文档
│   │   ├── draft/
│   │   ├── reviewed/
│   │   ├── shipping/
│   │   └── released/
│   └── engineering/          # 开发规范
│       └── proposals/
├── contracts/               # API 契约文件
└── tests/                   # 集成/E2E 测试
```

## 技术栈

| 分类 | 选型 |
|------|------|
| 前端 | React + TypeScript + Vite + Tailwind CSS |
| 后端 | Node.js + Express + GraphQL + Mongoose |
| 数据库 | MongoDB |
| 缓存 | Redis |
| 编排 | .NET Aspire |

## 快速开始

### 启动项目

```bash
# 方式一：Aspire（默认）
aspire start    # 启动全部服务（agent-api + controller-api + agent-web + MongoDB + Redis）

# 方式二：Docker Compose
aspire publish -o aspire/manifest    # 生成 docker-compose.yaml
rm -f aspire/manifest/*.Dockerfile   # 清理不需要的 Dockerfile
docker compose -f aspire/manifest/docker-compose.yaml up -d
docker compose -f aspire/manifest/docker-compose.yaml down
```

### 手动启动

```bash
# 安装依赖
cd servers/agent-api && npm install
cd servers/controller-api && npm install
cd apps/agent-web && npm install

# 启动服务
cd servers/agent-api && npm run dev
cd servers/controller-api && npm run dev
cd apps/agent-web && npm run dev
```