import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { McpServer } from '../models/mcp-server.js';

const JWT_SECRET = process.env.MCP_ENDPOINT_JWT_SECRET || 'default-secret';
const SALT_ROUNDS = 10;

export class McpEndpointService {
  async createEndpoint(
    sessionId: string,
    userId: string,
    mcpServerIds: string[],
  ): Promise<{ url: string; token: string }> {
    const servers = await McpServer.find({ _id: { $in: mcpServerIds }, userId });
    const serverNames = servers.map(s => s.name);

    const token = jwt.sign(
      { sessionId, userId, serverNames },
      JWT_SECRET,
      { expiresIn: '24h' },
    );
    const tokenHash = await bcrypt.hash(token, SALT_ROUNDS);

    await McpSessionEndpoint.create({
      sessionId,
      userId,
      mcpServerIds,
      tokenHash,
      status: 'active',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const forwarderUrl = process.env.MCP_FORWARDER_URL || 'http://localhost:3002';
    return {
      url: `${forwarderUrl}/mcp/${sessionId}`,
      token,
    };
  }

  async revokeEndpoint(sessionId: string): Promise<void> {
    await McpSessionEndpoint.findOneAndUpdate(
      { sessionId },
      { status: 'revoked' },
    );
  }

  async getEndpoint(sessionId: string): Promise<{ url: string; token: string } | null> {
    const endpoint = await McpSessionEndpoint.findOne({ sessionId, status: 'active' });
    if (!endpoint) return null;

    const forwarderUrl = process.env.MCP_FORWARDER_URL || 'http://localhost:3002';
    return {
      url: `${forwarderUrl}/mcp/${sessionId}`,
      token: '', // Token is only available at creation time
    };
  }
}

export const mcpEndpointService = new McpEndpointService();
