import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/mcp-proxy-key.js', () => ({
  McpProxyKey: {
    create: vi.fn(),
    find: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-key'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('crypto', () => ({
  default: {
    randomBytes: vi.fn().mockReturnValue(Buffer.from('test-random-bytes')),
  },
}));

import { McpProxyKeyService } from './mcp-proxy-key.js';
import { McpProxyKey } from '../models/mcp-proxy-key.js';

const mcpProxyKeyService = new McpProxyKeyService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('McpProxyKeyService', () => {
  describe('createKey', () => {
    it('should create a new MCP proxy key', async () => {
      const mockKey = {
        _id: 'key-1',
        userId: 'user-1',
        name: 'Test Key',
        keyHash: 'hashed-key',
        keyPrefix: 'mcp_te...test',
        status: 'active',
        createdAt: new Date(),
      };
      vi.mocked(McpProxyKey.create).mockResolvedValue(mockKey as never);

      const result = await mcpProxyKeyService.createKey('user-1', 'Test Key');

      expect(result.key).toBe(mockKey);
      expect(result.rawKey).toMatch(/^mcp_/);
      expect(McpProxyKey.create).toHaveBeenCalledWith({
        userId: 'user-1',
        name: 'Test Key',
        keyHash: 'hashed-key',
        keyPrefix: expect.any(String),
        status: 'active',
      });
    });
  });

  describe('verifyKey', () => {
    it('should verify a valid key', async () => {
      const mockKeys = [{
        _id: 'key-1',
        userId: 'user-1',
        keyHash: 'hashed-key',
        status: 'active',
      }];
      vi.mocked(McpProxyKey.find).mockResolvedValue(mockKeys as never);
      vi.mocked(McpProxyKey.findByIdAndUpdate).mockResolvedValue({} as never);

      const result = await mcpProxyKeyService.verifyKey('mcp_test-key');

      expect(result.valid).toBe(true);
      expect(result.keyId).toBe('key-1');
      expect(result.userId).toBe('user-1');
    });

    it('should reject an invalid key', async () => {
      vi.mocked(McpProxyKey.find).mockResolvedValue([] as never);

      const result = await mcpProxyKeyService.verifyKey('invalid-key');

      expect(result.valid).toBe(false);
    });
  });

  describe('revokeKey', () => {
    it('should revoke a key', async () => {
      vi.mocked(McpProxyKey.findOneAndUpdate).mockResolvedValue({ _id: 'key-1' } as never);

      const result = await mcpProxyKeyService.revokeKey('user-1', 'key-1');

      expect(result).toBe(true);
      expect(McpProxyKey.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'key-1', userId: 'user-1' },
        { status: 'revoked' },
      );
    });

    it('should return false if key not found', async () => {
      vi.mocked(McpProxyKey.findOneAndUpdate).mockResolvedValue(null as never);

      const result = await mcpProxyKeyService.revokeKey('user-1', 'nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('listKeys', () => {
    it('should list keys for a user', async () => {
      const mockKeys = [
        { _id: 'key-1', name: 'Key 1', status: 'active' },
        { _id: 'key-2', name: 'Key 2', status: 'revoked' },
      ];
      vi.mocked(McpProxyKey.find).mockReturnValue({
        sort: vi.fn().mockResolvedValue(mockKeys),
      } as never);

      const result = await mcpProxyKeyService.listKeys('user-1');

      expect(result).toEqual(mockKeys);
      expect(McpProxyKey.find).toHaveBeenCalledWith({ userId: 'user-1' });
    });
  });
});
