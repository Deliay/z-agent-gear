import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4001', 10),
  mongodbUri: process.env.MONGODB_URI || process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
  redisUri: process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379',
  nodeEnv: process.env.NODE_ENV || 'development',
};
