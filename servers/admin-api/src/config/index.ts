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
  // 首次种子的管理员初始密码（可选）。未配置时首次种子随机生成并一次性输出到启动日志。
  // 配置了弱口令/已知默认值会在 assertRuntimeConfig 中 fail-fast（CWE-798）。
  initialAdminPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  // cloud-controller 内部管理 API（单一事实源在 cloud-controller，admin-api 仅经此代理，见裁决 12）。
  // 缺失时不在启动期 fail-fast；调用写操作会因不可达返回明确错误（CONTROL_PLANE_UNAVAILABLE）。
  cloudControllerUrl: process.env.CLOUD_CONTROLLER_URL || '',
  internalApiToken: process.env.INTERNAL_API_TOKEN || '',
};

const HEX_64 = /^[0-9a-fA-F]{64}$/;

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
 * - ADMIN_JWT_SECRET 必填
 * - CREDENTIAL_ENCRYPTION_KEY 必填且为 64 位 hex（32 字节 AES-256 密钥）
 * - ADMIN_INITIAL_PASSWORD 若显式配置，则必须为非弱口令（拒绝公开默认值与过短口令）
 */
export function assertRuntimeConfig(): void {
  if (!config.adminJwtSecret) {
    throw new Error('ADMIN_JWT_SECRET is not configured');
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
