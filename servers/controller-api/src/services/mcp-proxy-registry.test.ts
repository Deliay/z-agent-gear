import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    create: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('../models/mcp-proxy-key.js', () => ({
  McpProxyKey: {
    find: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
  },
}));

import { McpProxyRegistry } from './mcp-proxy-registry.js';
import { McpServer } from '../models/mcp-server.js';
import { McpProxyKey } from '../models/mcp-proxy-key.js';

const mockIo = {
  of: vi.fn().mockReturnValue({
    on: vi.fn(),
  }),
};

const mcpProxyRegistry = new McpProxyRegistry(mockIo as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('McpProxyRegistry', () => {
  describe('register', () => {
    it('should register a proxy with valid key', async () => {
      const mockKeys = [{
        _id: 'key-1',
        userId: 'user-1',
        keyHash: 'hashed-key',
        status: 'active',
      }];
      vi.mocked(McpProxyKey.find).mockResolvedValue(mockKeys as never);
      vi.mocked(McpProxyKey.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(McpServer.create).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        name: 'github-mcp',
        transport: 'registered_proxy',
        command: 'npx @modelcontextprotocol/server-github',
        status: 'active',
      } as never);

      const result = await mcpProxyRegistry.register(
        'mcp_test-key',
        'user-machine',
        'npx @modelcontextprotocol/server-github',
        'github-mcp',
      );

      expect(result.success).toBe(true);
      expect(result.proxyId).toBe('proxy_server-1');
      expect(result.serverId).toBe('server-1');
    });

    it('should reject registration with invalid key', async () => {
      vi.mocked(McpProxyKey.find).mockResolvedValue([] as never);

      const result = await mcpProxyRegistry.register(
        'invalid-key',
        'user-machine',
        'npx @modelcontextprotocol/server-github',
        'github-mcp',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid key');
    });
  });

  describe('forwardRequest', () => {
    it('should throw error if proxy not connected', async () => {
      await expect(
        mcpProxyRegistry.forwardRequest('proxy_nonexistent', { method: 'tools/list' }),
      ).rejects.toThrow('Proxy not connected');
    });
  });
});
