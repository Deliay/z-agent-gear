import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  redisUri: process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  gatewayMaxPerController: parseInt(process.env.GATEWAY_MAX_PER_CONTROLLER || '5', 10),
  githubAppId: process.env.GITHUB_APP_ID || '',
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:4000/api/github/callback',
  githubTokenEncryptionKey: process.env.GITHUB_TOKEN_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
};
