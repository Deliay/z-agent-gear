import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    find: vi.fn(),
  },
}));

vi.mock('../models/mcp-session-endpoint.js', () => ({
  McpSessionEndpoint: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { McpServer } from '../models/mcp-server.js';
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';

const mockRedis = {
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  duplicate: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('McpEndpointService', () => {
  describe('createEndpoint', () => {
    it('should sign JWT with serverNames, return url, upsert endpoint and write redis status', async () => {
      vi.mocked(McpServer.find).mockResolvedValue([
        { _id: 'server-1', name: 'github-mcp' },
        { _id: 'server-2', name: 'database-mcp' },
      ] as never);
      vi.mocked(McpSessionEndpoint.findOneAndUpdate).mockResolvedValue({} as never);

      const result = await mcpEndpointService.createEndpoint('session-1', 'user-1', ['server-1', 'server-2']);

      expect(McpServer.find).toHaveBeenCalledWith({
        _id: { $in: ['server-1', 'server-2'] },
        userId: 'user-1',
        enabled: true,
      });
      expect(result.url).toBe('http://localhost:10001/mcp/session-1');
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);

      const payload = jwt.decode(result.token) as { sessionId: string; userId: string; serverNames: string[] };
      expect(payload.sessionId).toBe('session-1');
      expect(payload.userId).toBe('user-1');
      expect(payload.serverNames).toEqual(['github-mcp', 'database-mcp']);

      expect(McpSessionEndpoint.findOneAndUpdate).toHaveBeenCalledWith(
        { sessionId: 'session-1' },
        {
          $set: {
            userId: 'user-1',
            mcpServerIds: ['server-1', 'server-2'],
            tokenHash: expect.any(String),
            status: 'active',
            expiresAt: expect.any(Date),
          },
        },
        { upsert: true },
      );
      expect(mockRedis.set).toHaveBeenCalledWith('mcp:endpoint:session-1', 'active', 'EX', 86400);
    });

    it('should throw SERVER_NOT_FOUND when a selected server is missing or disabled', async () => {
      vi.mocked(McpServer.find).mockResolvedValue([
        { _id: 'server-1', name: 'github-mcp' },
      ] as never);

      await expect(
        mcpEndpointService.createEndpoint('session-1', 'user-1', ['server-1', 'server-2']),
      ).rejects.toThrow('SERVER_NOT_FOUND');

      expect(McpSessionEndpoint.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('revokeEndpoint', () => {
    it('should set mongo status revoked and persist redis status', async () => {
      vi.mocked(McpSessionEndpoint.findOneAndUpdate).mockResolvedValue({} as never);

      await mcpEndpointService.revokeEndpoint('session-1');

      expect(McpSessionEndpoint.findOneAndUpdate).toHaveBeenCalledWith(
        { sessionId: 'session-1' },
        { $set: { status: 'revoked' } },
      );
      expect(mockRedis.set).toHaveBeenCalledWith('mcp:endpoint:session-1', 'revoked');
    });
  });

  describe('getStatus', () => {
    it('should return redis status when cached', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue('active');

      const status = await mcpEndpointService.getStatus('session-1');

      expect(status).toBe('active');
      expect(mockRedis.get).toHaveBeenCalledWith('mcp:endpoint:session-1');
      expect(McpSessionEndpoint.findOne).not.toHaveBeenCalled();
    });

    it('should fall back to mongo when redis is empty and return active', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(McpSessionEndpoint.findOne).mockResolvedValue({ status: 'active' } as never);

      const status = await mcpEndpointService.getStatus('session-1');

      expect(status).toBe('active');
      expect(McpSessionEndpoint.findOne).toHaveBeenCalledWith({ sessionId: 'session-1', status: 'active' });
    });

    it('should fall back to mongo and return revoked when no active endpoint', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(McpSessionEndpoint.findOne).mockResolvedValue(null as never);

      const status = await mcpEndpointService.getStatus('session-1');

      expect(status).toBe('revoked');
    });
  });
});
