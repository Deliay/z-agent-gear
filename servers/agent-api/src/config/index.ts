import dotenv from 'dotenv';

dotenv.config();

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  redisUri: process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  mcpEndpointJwtSecret: process.env.MCP_ENDPOINT_JWT_SECRET || 'default-dev-secret-key-for-testing',
  mcpEndpointTokenTtl: parseInt(process.env.MCP_ENDPOINT_TOKEN_TTL || '86400', 10),
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  gatewayMaxPerController: parseInt(process.env.GATEWAY_MAX_PER_CONTROLLER || '5', 10),
  githubAppId: process.env.GITHUB_APP_ID || '',
  githubAppUrl: process.env.GITHUB_APP_URL || '',
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
  githubSetupUrl: process.env.GITHUB_SETUP_URL || 'http://localhost:4000/api/github/setup',
  githubTokenEncryptionKey: process.env.GITHUB_TOKEN_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
  // GitHub API base（测试指向本地 mock；默认官方 API）
  githubApiBaseUrl: process.env.GITHUB_API_BASE || 'https://api.github.com',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  // agent-api 对外基地址：拼 OAuth redirect_uri 的唯一事实源（`{PUBLIC_BASE_URL}/api/auth/oauth/callback`）。
  // 缺省 dev 回退 `http://localhost:10001`（与 AppHost dev 端口一致）。
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:10001').replace(/\/+$/, ''),
  // 后台前端地址（后台 OAuth 登录/绑定 302 目标）
  adminFrontendUrl: (process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174').replace(/\/+$/, ''),
  // GitHub OAuth 三端点（测试可覆盖指向 fake；缺省官方地址）
  githubOauthAuthorizeUrl:
    process.env.GITHUB_OAUTH_AUTHORIZE_URL || 'https://github.com/login/oauth/authorize',
  githubOauthTokenUrl:
    process.env.GITHUB_OAUTH_TOKEN_URL || 'https://github.com/login/oauth/access_token',
  githubOauthApiBase: (process.env.GITHUB_OAUTH_API_BASE || 'https://api.github.com').replace(/\/+$/, ''),
  // 费用中心：agent-api 不直写计费库，经 admin-api `/internal/billing/*` 转发（缺失时不 fail-fast）
  adminApiUrl: process.env.ADMIN_API_URL || '',
  internalApiToken: process.env.INTERNAL_API_TOKEN || '',
  // 前台云电脑（harness）：默认关闭，由发布参数/灰度打开
  harnessEnabled: toBool(process.env.HARNESS_ENABLED, false),
  // 云存储能力开关：默认开启；关闭时隐藏入口并拦截创建/挂载（存量仍可只读展示）
  cloudStorageEnabled: toBool(process.env.CLOUD_STORAGE_ENABLED, true),
  // ARCHIVING 对账周期（回调最终丢失兜底），默认 5 分钟
  cloudStorageReconcileMs: toPositiveInt(process.env.CLOUD_STORAGE_RECONCILE_MS, 300_000),
  harnessContainerTtlSeconds: toPositiveInt(process.env.HARNESS_CONTAINER_TTL_SECONDS, 86400),
  // cloud-controller 内部 API
  cloudControllerUrl: process.env.CLOUD_CONTROLLER_URL || '',
  // 容器内标准连接地址与模型网关地址（随创建请求下发，不落库）
  controllerApiPublicEndpoint: process.env.CONTROLLER_API_PUBLIC_WS_ENDPOINT || '',
  cloudHostModelBaseUrl: process.env.CLOUD_HOST_MODEL_BASE_URL || '',
  cloudHostDefaultWorkspace: process.env.CLOUD_HOST_DEFAULT_WORKSPACE || '/home/worker/workspace',
  // 云主机操作单步超时（等待工作负载执行完成，默认 10 分钟）
  cloudHostSetupStepTimeoutMs: toPositiveInt(
    process.env.CLOUD_HOST_SETUP_STEP_TIMEOUT_MS,
    600_000,
  ),
  // 操作 RUNNING 超过该时长视为中断（查询时标记 FAILED，默认 30 分钟）
  cloudHostSetupStaleMs: toPositiveInt(process.env.CLOUD_HOST_SETUP_STALE_MS, 1_800_000),
  // Issues 联动：首个人类节点自动完成等待上限（默认 24 小时）
  issuesTriggerHumanNodeTimeoutMs: toPositiveInt(
    process.env.ISSUES_TRIGGER_HUMAN_NODE_TIMEOUT_MS,
    86_400_000,
  ),
  // 事件回调鉴权（两者都未配置时回调端点一律 401，默认拒绝）
  eventCallbackToken: process.env.EVENT_CALLBACK_TOKEN || '',
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
};
