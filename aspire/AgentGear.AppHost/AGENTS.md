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
| cloud-controller| Node.js    | cloud-controller|
| controller-api  | Node.js    | controller-api  |
| mongodb         | Container  | mongodb         |
| redis           | Container  | redis           |
| rabbitmq        | Container  | rabbitmq        |

> `admin-api` 注入 `ADMIN_JWT_SECRET` / `CREDENTIAL_ENCRYPTION_KEY` / `ADMIN_INITIAL_PASSWORD` / `CORS_ORIGIN` / `CLOUD_CONTROLLER_URL` / `INTERNAL_API_TOKEN` / `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`（默认 180000，需覆盖工作负载 post 预算 90s + 宽限 10s），引用 `mongodb` / `rabbitmq`（`ConnectionStrings__rabbitmq`，计费事件骨干），dev 端口 10003、publish 端口 8002。
> `cloud-controller` 注入 `INTERNAL_API_TOKEN` / `K8S_NAMESPACE` / `WORKER_IMAGE` / `PUBLIC_WS_ENDPOINT` / `K8S_ENABLED`（dev 为 `false`，publish 为 `true`）/ `WORKLOAD_INIT_TIMEOUT_MS` / `WORKLOAD_POST_BUDGET_MS` / `WORKLOAD_LOG_MAX_BYTES`（有内置默认值），引用 `mongodb` / `rabbitmq`（计费事件 outbox relay），dev 端口 10004、publish 端口 8003。
> `agent-api` 注入 `ADMIN_API_URL`（admin-api 内部 REST）与 `INTERNAL_API_TOKEN`（`/internal/billing/*` Bearer），用于前台「我的费用」转发。
> `admin-web` dev 模式为 Vite dev server（`AddViteApp`，注入 `VITE_ADMIN_API_URL`）；publish 模式注册为 nginx 容器（`${ADMIN_WEB_IMAGE}`，端口 80，SPA history fallback），并注入 `ADMIN_API_URL`（容器运行时生成 `config.js`）。
>
> 安全（问题 4/47）：`admin-jwt-secret` / `internal-api-token` / `admin-initial-password` 等敏感参数**不提交任何字面量默认值**，每次启动随机生成（或经配置 `Parameters:<name>` / 环境变量 `Parameters__<name>` 注入）；admin-api 首次种子时会把管理员初始密码一次性打印到日志。
>
> RabbitMQ 镜像与逃生门（问题 23/D-5）：`rabbitmq` 默认走内网镜像源
> `registry.cn-hangzhou.aliyuncs.com/zero-tools/rabbitmq:3-management`，可用环境变量 `RABBITMQ_IMAGE` 覆盖；
> 受限环境无镜像时可设 `RABBITMQ_DISABLED=true` 跳过 RabbitMQ 资源（其余服务照常启动，MQ 客户端自行重试并降级，
> 计费事件保留在 outbox 待恢复后补投）。compose 部署需在 `.env` 提供 `RABBITMQ_PASSWORD`。

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
