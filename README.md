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
│   ├── cloud-controller/    # Node.js + Express + Socket.IO + K8s 云端工作容器控制器
│   └── controller-api/      # Node.js + Express + Socket.IO 后端
├── packages/
│   └── agent-controller/    # Node.js CLI 客户端
├── deploy/                  # 部署产物
│   ├── images/worker/       # 默认工作容器镜像（Dockerfile / entrypoint / BUILD.md）
│   └── k8s/                 # cloud-controller K8s 部署 manifest
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
aspire start    # 启动全部服务（agent-api + admin-api + controller-api + cloud-controller + agent-web + admin-web + MongoDB + Redis）

# 方式二：Docker Compose
aspire publish -o aspire/manifest    # 生成 docker-compose.yaml
rm -f aspire/manifest/*.Dockerfile   # 清理不需要的 Dockerfile
# 编辑 aspire/manifest/.env，填入各镜像地址与环境参数（含 cloud-controller 的
# ADMIN_API_URL / INTERNAL_API_TOKEN / WORKER_IMAGE / PUBLIC_WS_ENDPOINT）
docker compose -f aspire/manifest/docker-compose.yaml up -d
docker compose -f aspire/manifest/docker-compose.yaml down
```

### 手动启动

```bash
# 安装依赖
cd servers/agent-api && npm install
cd servers/admin-api && npm install
cd servers/controller-api && npm install
cd servers/cloud-controller && npm install
cd apps/agent-web && npm install
cd apps/admin-web && npm install

# 启动服务
cd servers/agent-api && npm run dev
cd servers/admin-api && npm run dev
cd servers/controller-api && npm run dev
cd servers/cloud-controller && npm run dev
cd apps/agent-web && npm run dev
cd apps/admin-web && npm run dev
```