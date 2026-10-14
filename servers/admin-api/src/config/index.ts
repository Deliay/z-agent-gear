import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4002', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || '',
  // 不做静默兜底：缺失时启动 fail-fast（见 assertRuntimeConfig），避免用公开已知密钥加密凭据
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development',
};

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * 启动期配置校验（fail-fast，不静默降级）：
 * - ADMIN_JWT_SECRET 必填
 * - CREDENTIAL_ENCRYPTION_KEY 必填且为 64 位 hex（32 字节 AES-256 密钥）
 */
export function assertRuntimeConfig(): void {
  if (!config.adminJwtSecret) {
    throw new Error('ADMIN_JWT_SECRET is not configured');
  }
  if (!HEX_64.test(config.credentialEncryptionKey)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
}
