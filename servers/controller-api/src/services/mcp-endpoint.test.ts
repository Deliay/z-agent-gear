import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/mcp-session-endpoint.js', () => ({
  McpSessionEndpoint: {
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    find: vi.fn(),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('mock-jwt-token'),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-token'),
  },
}));

import { McpEndpointService } from './mcp-endpoint.js';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { McpServer } from '../models/mcp-server.js';

const mcpEndpointService = new McpEndpointService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('McpEndpointService', () => {
  describe('createEndpoint', () => {
    it('should create a session endpoint with JWT token', async () => {
      const mockServers = [
        { _id: 'server-1', name: 'github-mcp' },
        { _id: 'server-2', name: 'database-mcp' },
      ];
      vi.mocked(McpServer.find).mockResolvedValue(mockServers as never);
      vi.mocked(McpSessionEndpoint.create).mockResolvedValue({} as never);

      const result = await mcpEndpointService.createEndpoint('session-1', 'user-1', ['server-1', 'server-2']);

      expect(result.url).toContain('/mcp/session-1');
      expect(result.token).toBe('mock-jwt-token');
      expect(McpSessionEndpoint.create).toHaveBeenCalledWith({
        sessionId: 'session-1',
        userId: 'user-1',
        mcpServerIds: ['server-1', 'server-2'],
        tokenHash: 'hashed-token',
        status: 'active',
        expiresAt: expect.any(Date),
      });
    });
  });

  describe('revokeEndpoint', () => {
    it('should revoke a session endpoint', async () => {
      vi.mocked(McpSessionEndpoint.findOneAndUpdate).mockResolvedValue({} as never);

      await mcpEndpointService.revokeEndpoint('session-1');

      expect(McpSessionEndpoint.findOneAndUpdate).toHaveBeenCalledWith(
        { sessionId: 'session-1' },
        { status: 'revoked' },
      );
    });
  });

  describe('getEndpoint', () => {
    it('should return endpoint if active', async () => {
      vi.mocked(McpSessionEndpoint.findOne).mockResolvedValue({
        sessionId: 'session-1',
        status: 'active',
      } as never);

      const result = await mcpEndpointService.getEndpoint('session-1');

      expect(result).not.toBeNull();
      expect(result?.url).toContain('/mcp/session-1');
    });

    it('should return null if endpoint not found', async () => {
      vi.mocked(McpSessionEndpoint.findOne).mockResolvedValue(null as never);

      const result = await mcpEndpointService.getEndpoint('session-1');

      expect(result).toBeNull();
    });
  });
});
