import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { McpServer } from '../models/mcp-server.js';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { config } from '../config/index.js';
import { getRedisClient } from '../middleware/redis.js';

const SALT_ROUNDS = 10;

export class McpEndpointService {
  async createEndpoint(
    sessionId: string,
    userId: string,
    mcpServerIds: string[],
  ): Promise<{ url: string; token: string }> {
    const servers = await McpServer.find({ _id: { $in: mcpServerIds }, userId, enabled: true });
    if (servers.length !== mcpServerIds.length) {
      throw new Error('SERVER_NOT_FOUND');
    }

    const serverNames = servers.map(s => s.name);
    const ttl = config.mcpEndpointTokenTtl;

    const token = jwt.sign(
      { sessionId, userId, serverNames },
      config.mcpEndpointJwtSecret,
      { expiresIn: `${ttl}s` },
    );
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);

    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          userId,
          mcpServerIds,
          tokenHash,
          status: 'active',
          expiresAt: new Date(Date.now() + ttl * 1000),
        },
      },
      { upsert: true },
    );

    const redis = getRedisClient();
    await redis.set(`mcp:endpoint:${sessionId}`, 'active', 'EX', ttl);

    return {
      url: `${config.gatewayUrl}/mcp/${sessionId}`,
      token,
    };
  }

  async revokeEndpoint(sessionId: string): Promise<void> {
    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      { $set: { status: 'revoked' } },
    );
    const redis = getRedisClient();
    await redis.set(`mcp:endpoint:${sessionId}`, 'revoked');
  }

  async getStatus(sessionId: string): Promise<string> {
    const redis = getRedisClient();
    const cached = await redis.get(`mcp:endpoint:${sessionId}`);
    if (cached === 'active' || cached === 'revoked') {
      return cached;
    }
    const endpoint = await McpSessionEndpoint.findOne({ sessionId, status: 'active' });
    return endpoint ? 'active' : 'revoked';
  }
}

export const mcpEndpointService = new McpEndpointService();
