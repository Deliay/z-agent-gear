# cloud-controller

部署在 K8s 集群内的云端工作容器控制器：通过 K8s API 在指定命名空间以 **Job** 形式拉起工作容器，工作容器内 `agent-gear` 经 Socket.IO（namespace `/worker`）回连并接受控制；同时对外暴露供 `admin-api` 调用的内部管理 REST。

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + Socket.IO v4
- **ODM**: Mongoose（MongoDB 共享库，集合 `cloudcontainers`）
- **K8s 客户端**: `@kubernetes/client-node`（BatchV1Api + Watch）
- **测试**: Vitest
- **Dev Runner**: tsx (watch mode)

## Architecture

```
src/
├── config/                     # 环境配置 + assertRuntimeConfig（fail-fast）
├── models/cloud-container.ts   # CloudContainer schema（集合 cloudcontainers）
├── repositories/
│   └── container-repository.ts # ContainerRepository 接口 + Mongo/InMemory 实现
├── services/
│   ├── token-service.ts        # 一次性 token 签发/校验（bcrypt，tokenHash）
│   ├── k8s-client.ts           # K8sClient 接口 + Real/InMemory 实现 + 工厂
│   ├── k8s-job-manager.ts      # Job manifest + CRUD + Foreground→Background 回退
│   ├── container-service.ts    # 生命周期状态机（creating→connecting→online→destroying→exited/failed）
│   ├── status-sync.ts          # watch + 断线重连对账 + 超时巡检 + 心跳离线巡检
│   ├── heartbeat-tracker.ts    # 心跳计时（30s × 3 次判离线）
│   └── socketio-gateway.ts     # /worker namespace 接入与鉴权
├── middleware/internal-auth.ts # Bearer INTERNAL_API_TOKEN
├── routes/internal-api.ts      # /internal/containers*
└── index.ts                    # createCloudControllerApp + 入口
```

## 关键约束

- **单一事实源**：容器状态/生命周期全部由本服务持有；`admin-api` 不直连 K8s、不双写 Mongo（降级只读除外）。
- **鉴权**：容器经 Socket.IO 握手 `auth.token`（遗留 query 兼容）的一次性 token（`<containerId>.<secret>`，bcrypt 哈希存 `cloudcontainers.tokenHash`）鉴权，`register` 的 `key` 字段被忽略；握手限速按 token 的 `containerId` 前缀（无 token 回退 peer IP），另有更高上限的 per-IP 兜底桶——worker 经共享 Ingress IP 回连时不共享同一令牌桶；内部 REST 走 `Bearer INTERNAL_API_TOKEN`。**绝不读写 `controllerkeys` 集合**。
- **工作负载仅 Job**：`restartPolicy: Never`、`backoffLimit: 0`、`ttlSecondsAfterFinished: 600`、label `app=zag-worker` + `zag.cloud/container-id=<id>`；另含资源 requests/limits 与 `activeDeadlineSeconds` 兜底。
- **runtimeClass + hostUsers**：配置了 `RUNTIME_CLASS_NAME`（默认 `sysbox-runc`）时，同时下发 `hostUsers: false`——sysbox 要求 Pod 停用宿主 user namespace，否则 sandbox 创建失败（写 `net.ipv4.ip_unprivileged_port_start` 被拒）；未配置 runtimeClass 时不设置该字段。
- **env 通道**：`ZAG_SERVER_ENDPOINT=wss://<host>/worker`（**不含 token**）与 `ZAG_CONTROLLER_KEY=<token>`（agent-gear 连接时经握手 `auth.token` 携带）。
- **K8s 客户端可注入**：`K8S_ENABLED=false` 时使用 `InMemoryK8sClient`（本地/测试/E2E 全 mock，不依赖真实集群）。
- **本期 purpose 仅 idle**：服务端对非 idle 启动请求返回明确错误「该任务类型暂未开放」。
- 契约：`contracts/cloud-controller-websocket.md`（含内部 HTTP API 附录 A）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口（dev 默认 4003；Aspire dev 10004 / publish 8003） |
| `MONGODB_URI` | 共享 MongoDB |
| `INTERNAL_API_TOKEN` | admin-api ↔ cloud-controller 共享令牌（必填，fail-fast） |
| `K8S_NAMESPACE` | 管理的工作负载命名空间（必填） |
| `WORKER_IMAGE` | 默认工作容器镜像地址（必填） |
| `PUBLIC_WS_ENDPOINT` | 注入容器的对外 wss 地址（必填，**仅 host(:port)**，不得带路径；`/worker` namespace 自动追加，带路径启动即 fail-fast） |
| `CONNECT_TIMEOUT_MS` | 回连超时（默认 300000） |
| `K8S_ENABLED` | 是否使用真实 K8s 客户端（默认 `true`；本地/测试设 `false`） |
| `RUNTIME_CLASS_NAME` | 容器 runtimeClass（默认 `sysbox-runc`） |

## Dev Commands

```bash
aspire start        # Aspire 编排（注入 K8S_ENABLED=false）
npm run build       # tsc strict
npm test            # vitest run
npm run test:coverage
```

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环。详细指南参考 [TDD Skill](../../.agents/skills/tdd/SKILL.md)。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)
- [WS 契约](../../contracts/cloud-controller-websocket.md)
