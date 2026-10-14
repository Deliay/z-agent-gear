import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4002', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || 'dev-admin-secret-change-in-production',
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development',
};
