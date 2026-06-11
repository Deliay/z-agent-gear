import { config } from 'dotenv';
config();

const jwtSecret = process.env.MCP_ENDPOINT_JWT_SECRET;
if (!jwtSecret) {
  throw new Error('MCP_ENDPOINT_JWT_SECRET environment variable is required');
}

export const env = {
  port: parseInt(process.env.MCP_FORWARDER_PORT || '3002', 10),
  jwtSecret,
  controllerApiUrl: process.env.CONTROLLER_API_URL || 'http://localhost:4001',
};
