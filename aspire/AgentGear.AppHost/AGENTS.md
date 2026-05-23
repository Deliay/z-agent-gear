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
| controller-api  | Node.js    | controller-api  |
| mongodb         | Container  | mongodb         |
| redis           | Container  | redis           |

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
