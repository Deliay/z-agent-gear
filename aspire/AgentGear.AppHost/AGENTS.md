# AgentGear.AppHost

## Tech Stack

- **Orchestrator**: .NET Aspire 13.x
- **Runtime**: .NET 10
- **Infrastructure**: MongoDB (container), Redis (container)
- **Resources**: Node.js apps managed as executables

## Managed Resources

| Resource        | Type       | Compose Service |
|-----------------|------------|-----------------|
| agent-api       | Node.js    | agent-api       |
| agent-web       | Node.js    | (dev only)      |
| admin-api       | Node.js    | admin-api       |
| admin-web       | Node.js    | admin-web       |
| controller-api  | Node.js    | controller-api  |
| mongodb         | Container  | mongodb         |
| redis           | Container  | redis           |

> `admin-api` 注入 `ADMIN_JWT_SECRET` / `CREDENTIAL_ENCRYPTION_KEY` / `CORS_ORIGIN`，引用 `mongodb`，dev 端口 10003、publish 端口 8002。
> `admin-web` dev 模式为 Vite dev server（`AddViteApp`，注入 `VITE_ADMIN_API_URL`）；publish 模式注册为 nginx 容器（`zero-tools/admin-web`，端口 80，SPA history fallback）。

## Dev Commands

```bash
# Aspire orchestration (default)
aspire start        # Start all services
aspire stop         # Stop orchestration
aspire describe     # List resources and status

# Docker Compose (alternative)
aspire publish -o ../manifest    # Generate docker-compose.yaml
docker compose -f ../manifest/docker-compose.yaml up -d    # Start services
docker compose -f ../manifest/docker-compose.yaml down     # Stop services
```

## Docker Compose

```bash
# 生成 docker-compose.yaml（同时会生成 .Dockerfile，不需要则删除）
aspire publish -o ../manifest
rm -f ../manifest/*.Dockerfile

# 启动/停止
docker compose -f ../manifest/docker-compose.yaml up -d
docker compose -f ../manifest/docker-compose.yaml down
```

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Docker Compose Proposal](../../docs/engineering/proposals/20260524-feat-docker-compose-support.md)
