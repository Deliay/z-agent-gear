import { config } from 'dotenv';
config();

export const env = {
  port: parseInt(process.env.MCP_FORWARDER_PORT || '3002', 10),
  jwtSecret: process.env.MCP_ENDPOINT_JWT_SECRET || 'default-secret',
  controllerApiUrl: process.env.CONTROLLER_API_URL || 'http://localhost:4001',
  mongodbUri: process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/agent-gear',
};
