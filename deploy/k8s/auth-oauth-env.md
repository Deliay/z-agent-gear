# 第三方登录（OIDC / GitHub OAuth）部署 env 增补（#503）

本仓库 `deploy/k8s/` 目前只提供 `cloud-controller.yaml` 与 `otel-collector.yaml` 示例；
agent-api / admin-api / admin-web 的 K8s Deployment 由部署侧维护。启用第三方登录时，
请按下表为对应工作负载补充环境变量（compose 产物 `aspire/manifest/docker-compose.yaml`
已由 `aspire publish` 自动生成同口径注入）。

## agent-api

| 变量 | 必填 | 说明 |
|------|------|------|
| `PUBLIC_BASE_URL` | 是 | 对外 HTTPS 基地址；`redirect_uri = {PUBLIC_BASE_URL}/api/auth/oauth/callback` 的唯一事实源 |
| `ADMIN_FRONTEND_URL` | 是 | 后台前端地址（后台登录/绑定 302 目标） |
| `CREDENTIAL_ENCRYPTION_KEY` | 是 | 与 admin-api 同值；解密 `authproviders.encryptedClientSecret`。缺省全零密钥时启用中的 OIDC Provider 会告警 |
| `FRONTEND_URL` | 是 | 前台前端地址（前台登录 302 目标，既有变量） |
| `ADMIN_API_URL` | 是 | admin-api 内部地址（`admin-tickets`/`admin-bind`） |
| `INTERNAL_API_TOKEN` | 是 | 与 admin-api 同值（Bearer 内部调用） |
| `GITHUB_OAUTH_AUTHORIZE_URL` / `GITHUB_OAUTH_TOKEN_URL` / `GITHUB_OAUTH_API_BASE` | 否 | 仅测试/私有化 GitHub 代理时覆盖；缺省官方地址 |

## admin-api

| 变量 | 必填 | 说明 |
|------|------|------|
| `CREDENTIAL_ENCRYPTION_KEY` | 是 | 与 agent-api 同值（secret 加密/解密） |
| `AGENT_API_PUBLIC_URL` | 是 | 配置页 `callbackUrl` 出参基地址（缺省回落 `AGENT_API_URL`） |
| `ADMIN_FRONTEND_URL` | 是 | 后台前端地址 |
| `INTERNAL_API_TOKEN` | 是 | 内部端点 Bearer（与 agent-api 同值） |

## admin-web

| 变量 | 必填 | 说明 |
|------|------|------|
| `AGENT_API_URL` | 是 | 容器启动脚本写入 `window.__ADMIN_CONFIG__.agentApiUrl`；浏览器据此拼 OAuth authorize 地址（也支持 localStorage `zag:agent-api-base` 运行时覆盖） |

## Secret 口径

- `CREDENTIAL_ENCRYPTION_KEY` 建议放入既有凭据 Secret（与 admin-api 同键源），不要写入 ConfigMap 明文。
- `INTERNAL_API_TOKEN` 复用既有内部令牌 Secret；未配置时内部端点一律 401。
- 回调地址只需在 IdP/GitHub OAuth App 登记一次：`https://<agent-api 对外域名>/api/auth/oauth/callback`。
