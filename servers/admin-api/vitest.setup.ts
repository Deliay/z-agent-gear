// vitest 全局前置：为单测配置合法的运行期密钥（生产启动由 assertRuntimeConfig 强校验）。
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret';
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'a'.repeat(64);
