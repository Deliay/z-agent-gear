import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  port: parseInt(process.env.PORT || '4002', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || '',
  // 不做静默兜底：缺失时启动 fail-fast（见 assertRuntimeConfig），避免用公开已知密钥加密凭据
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
  // 生产环境不默认放开 `*`：未显式配置 CORS_ORIGIN 时回落到空串，index.ts 以 origin:false 只允许同源
  corsOrigin: process.env.CORS_ORIGIN || (nodeEnv === 'production' ? '' : '*'),
  nodeEnv,
  // 受信反向代理（问题 49/57）：逗号分隔的 IP/CIDR 列表，**仅当底层 socket 对端命中列表时**才信任
  // `x-forwarded-for`/`x-real-ip`（取受信代理追加的末跳）。默认空串=不信任，登录限速取 socket 对端。
  // 兼容历史 `TRUST_PROXY=true|1`：等价于「仅信任回环」。
  trustedProxies: normalizeTrustProxy(process.env.TRUST_PROXY),
  // 首次种子的管理员初始密码（可选）。未配置时首次种子随机生成并一次性输出到启动日志。
  // 配置了弱口令/已知默认值会在 assertRuntimeConfig 中 fail-fast（CWE-798）。
  initialAdminPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  // cloud-controller 内部管理 API（单一事实源在 cloud-controller，admin-api 仅经此代理，见裁决 12）。
  // 缺失时不在启动期 fail-fast；调用写操作会因不可达返回明确错误（CONTROL_PLANE_UNAVAILABLE）。
  cloudControllerUrl: process.env.CLOUD_CONTROLLER_URL || '',
  internalApiToken: process.env.INTERNAL_API_TOKEN || '',
  // 强制销毁专用超时（裁决 9）：需大于 cloud-controller 的 post 预算（默认 90s）+ shutdown 宽限（10s）+ 删 Job 重试，
  // 默认 180000（180s）。非法/缺省回落默认值，避免 NaN 让 AbortController 立即中断。
  cloudControllerDestroyTimeoutMs: parsePositiveInt(
    process.env.CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS,
    180000,
  ),
  // ===== 费用中心（Credits 计费）=====
  // RabbitMQ 事件骨干
  rabbitmqUrl: process.env.RABBITMQ_URL || process.env.ConnectionStrings__rabbitmq || 'amqp://guest:guest@localhost:5672',
  rabbitmqPrefetch: parsePositiveInt(process.env.RABBITMQ_PREFETCH, 10),
  rabbitmqRetryMax: parsePositiveInt(process.env.RABBITMQ_RETRY_MAX, 5),
  outboxRelayIntervalMs: parsePositiveInt(process.env.OUTBOX_RELAY_INTERVAL_MS, 2000),
  // 容器计费：周期（秒，默认 60）、保证金（credits，默认 5）
  billingCycleSeconds: parsePositiveInt(process.env.BILLING_CYCLE_SECONDS, 60),
  containerDepositCredits: parsePositiveInt(process.env.CONTAINER_DEPOSIT_CREDITS, 5),
  // 欠费宽限（毫秒，默认 10 分钟）
  billingArrearsGraceMs: parsePositiveInt(process.env.BILLING_ARREARS_GRACE_MS, 600000),
  // 计量缺失兜底：输出 token 估算上限
  modelDefaultMaxOutputTokens: parsePositiveInt(process.env.MODEL_DEFAULT_MAX_OUTPUT_TOKENS, 1024),
  // 网关预检输入估算（R10-1）：按 UTF-8 字节数 / 该倍率估算 token。
  // 默认 1（1 token/字节）是保守上界；调大只会降低保守程度，不得低于 1。
  modelTokenEstimateBytesPerToken: Math.max(
    1,
    Number.parseInt(process.env.MODEL_TOKEN_ESTIMATE_BYTES_PER_TOKEN || '1', 10) || 1,
  ),
  // 非文本内容块固定高估 token（图片/音频/文件/工具调用），确保多模态请求预检不为 0。
  modelEstimateImageTokens: parsePositiveInt(process.env.MODEL_ESTIMATE_IMAGE_TOKENS, 8192),
  modelEstimateAudioTokens: parsePositiveInt(process.env.MODEL_ESTIMATE_AUDIO_TOKENS, 16384),
  modelEstimateFileTokens: parsePositiveInt(process.env.MODEL_ESTIMATE_FILE_TOKENS, 16384),
  modelEstimateToolTokens: parsePositiveInt(process.env.MODEL_ESTIMATE_TOOL_TOKENS, 4096),
  // 每日对账最大间隔（R10-11：错过 cron 分钟时按「距上次成功 ≥ 24h」补跑；R11-5 移除旧 BILLING_RECON_CRON）
  billingReconIntervalMs: parsePositiveInt(
    process.env.BILLING_RECON_INTERVAL_MS,
    24 * 60 * 60 * 1000,
  ),
  reservationStaleMs: parsePositiveInt(process.env.RESERVATION_STALE_MS, 15 * 60 * 1000),
  // `started/failed` 模型调用孤儿判定阈值（R10-4）
  billingApiCallOrphanMs: parsePositiveInt(
    process.env.BILLING_API_CALL_ORPHAN_MS,
    30 * 60 * 1000,
  ),
};

/** 解析正整数环境变量；缺失/非法（NaN/≤0）均回落默认值。 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** 规范化 TRUST_PROXY：空/false/0 → 不信任；true/1 → 仅信任回环；其余按逗号列表原样使用。 */
export function normalizeTrustProxy(value: string | undefined): string {
  if (!value) return '';
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'false' || v === '0') return '';
  if (v.toLowerCase() === 'true' || v === '1') return '127.0.0.1/8,::1/128';
  return v;
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const b = Number(part);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = n * 256 + b;
  }
  return n >>> 0;
}

/** IP 是否命中某个 IP/CIDR 表达式（IPv4 支持 CIDR；IPv6 支持精确匹配或 /128）。 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const [baseRaw = '', lenRaw] = cidr.split('/');
  const base = normalizeIp(baseRaw);
  if (!base) return false;

  const ipInt = ipv4ToInt(normalizedIp);
  const baseInt = ipv4ToInt(base);
  if (ipInt !== null && baseInt !== null) {
    const len = lenRaw === undefined || lenRaw === '' ? 32 : Number(lenRaw);
    if (!Number.isInteger(len) || len < 0 || len > 32) return false;
    if (len === 0) return true;
    const mask = len === 32 ? 0xffffffff : (~(0xffffffff >>> len)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  if (lenRaw !== undefined && lenRaw !== '' && Number(lenRaw) !== 128) return false;
  return normalizedIp === base;
}

/**
 * 判断对端 IP 是否为受信代理（问题 57）。仅当对端命中 `trustedProxies` 时才允许采纳转发头，
 * 避免端口直连时攻击者伪造 `x-forwarded-for` 末跳绕过 IP 维度限速。
 */
export function isTrustedProxy(ip: string | undefined | null, list = config.trustedProxies): boolean {
  if (!ip || !list) return false;
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => ipMatchesCidr(ip, entry));
}

/** 管理员初始密码最短长度（与 auth 服务的改密策略一致） */
export const MIN_PASSWORD_LENGTH = 10;

/** 管理员用户名（种子帐号，禁止用作初始密码） */
export const ADMIN_USERNAME = 'admin';

/**
 * 已知公开默认 / 弱口令集合：`ADMIN_INITIAL_PASSWORD` 命中即拒绝启动。
 * 这是问题 4 的防线——历史上 `admin1234567` 被硬编码进源码并由 PRD 公开，绝不允许再作为种子口令。
 */
const WEAK_ADMIN_PASSWORDS = new Set([
  'admin1234567',
  // 问题 47：AppHost 曾以字面量默认值公开注入的 dev 初始口令，绝不允许再作为种子口令
  'dev-admin-init-password',
  'admin123456',
  'admin12345',
  'admin1234',
  'admin123',
  'admin',
  'administrator',
  'password',
  'password123',
  'password1234',
  'changeme',
  'change-me',
  'change_me',
  'letmein',
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'admin@123',
  'root',
  'secret',
]);

/**
 * 已知公开默认 / 弱 `ADMIN_JWT_SECRET`（问题 47）：命中即拒绝启动。
 * 历史编排层（AppHost 参数默认值）以字面量公开注入这些值，长度校验拦不住「足够长但公开」的默认值，
 * 必须显式 deny-list。
 */
const WEAK_ADMIN_JWT_SECRETS = new Set([
  'dev-admin-secret-change-in-production',
  'dev-secret-change-in-production',
  'dev-admin-secret',
  'admin-secret-change-in-production',
  'admin-secret',
  'changeme',
  'change-me-in-production',
  'secret',
  'jwt-secret',
  'your-secret-key',
]);

/**
 * 管理员密码强度判定（用于初始密码 fail-fast 与改密策略）：
 * 长度不足、等于用户名、或命中已知弱口令集合均视为弱密码。
 */
export function isWeakAdminPassword(password: string): boolean {
  const value = password.trim();
  if (value.length < MIN_PASSWORD_LENGTH) return true;
  const lowered = value.toLowerCase();
  if (lowered === ADMIN_USERNAME) return true;
  return WEAK_ADMIN_PASSWORDS.has(lowered);
}

/**
 * 启动期配置校验（fail-fast，不静默降级）：
 * - ADMIN_JWT_SECRET 必填且不得为已知公开默认值（问题 47）
 * - CREDENTIAL_ENCRYPTION_KEY 必填且为 64 位 hex（32 字节 AES-256 密钥）
 * - ADMIN_INITIAL_PASSWORD 若显式配置，则必须为非弱口令（拒绝公开默认值与过短口令）
 */
export function assertRuntimeConfig(): void {
  if (!config.adminJwtSecret) {
    throw new Error('ADMIN_JWT_SECRET is not configured');
  }
  if (WEAK_ADMIN_JWT_SECRETS.has(config.adminJwtSecret.trim().toLowerCase())) {
    throw new Error(
      'ADMIN_JWT_SECRET is a known default/weak secret; generate a strong random value (CWE-798)',
    );
  }
  if (!HEX_64.test(config.credentialEncryptionKey)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  if (config.initialAdminPassword) {
    if (isWeakAdminPassword(config.initialAdminPassword)) {
      throw new Error(
        'ADMIN_INITIAL_PASSWORD is too weak: it must be at least 10 characters, not equal to the admin username, and not a known default/weak password',
      );
    }
  }
}
