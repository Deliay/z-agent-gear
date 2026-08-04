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

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { McpProxyRegistry } from './mcp-proxy-registry.js';
import { McpServer } from '../models/mcp-server.js';
import { McpProxyKey } from '../models/mcp-proxy-key.js';
import { getRedisClient } from '../middleware/redis.js';

function makeSocket() {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  return {
    id: 'socket-1',
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      handlers[event] = cb;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    _trigger: (event: string, data: unknown) => handlers[event]?.(data),
    _handlers: handlers,
  };
}

function createTestContext() {
  const mockRedis = {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

  const io = {
    of: vi.fn().mockReturnValue({
      on: vi.fn(),
    }),
  };

  const registry = new McpProxyRegistry(io as never, mockRedis as never);

  // Capture connection handler
  registry.setupNamespace();
  const nspOn = vi.mocked(io.of).mock.results[0].value.on;
  const connectionHandler = nspOn.mock.calls.find((c: [string, unknown]) => c[0] === 'connection')![1] as (socket: ReturnType<typeof makeSocket>) => void;

  const connectSocket = () => {
    const s = makeSocket();
    connectionHandler(s as never);
    return s;
  };
  const socket = connectSocket();

  return { registry, mockRedis, socket, connectSocket };
}

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

      const result = await createTestContext().registry.register(
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

      const result = await createTestContext().registry.register(
        'invalid-key',
        'user-machine',
        'npx @modelcontextprotocol/server-github',
        'github-mcp',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid key');
    });
  });

  describe('owner registry (mcp:proxy:owner:{serverId})', () => {
    it('should write owner with 45s TTL on proxy:register', async () => {
      const { registry, mockRedis, socket } = createTestContext();
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        command: 'cmd',
      } as never);

      await socket._trigger('proxy:register', { proxyId: 'proxy_server-1', key: 'key' });

      expect(mockRedis.set).toHaveBeenCalledWith('mcp:proxy:owner:server-1', expect.any(String), 'EX', 45);
      expect(registry.hasActiveProxy('server-1')).toBe(true);
    });

    it('should refresh owner TTL on proxy:heartbeat', async () => {
      const { mockRedis, socket } = createTestContext();
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        command: 'cmd',
      } as never);
      await socket._trigger('proxy:register', { proxyId: 'proxy_server-1', key: 'key' });

      vi.clearAllMocks();
      await socket._trigger('proxy:heartbeat', { proxyId: 'proxy_server-1' });

      expect(McpServer.findByIdAndUpdate).toHaveBeenCalledWith('server-1', { lastHeartbeatAt: expect.any(Date) });
      expect(mockRedis.set).toHaveBeenCalledWith('mcp:proxy:owner:server-1', expect.any(String), 'EX', 45);
    });

    it('should delete owner on proxy:unregister', async () => {
      const { registry, mockRedis, socket } = createTestContext();
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        command: 'cmd',
      } as never);
      await socket._trigger('proxy:register', { proxyId: 'proxy_server-1', key: 'key' });

      await socket._trigger('proxy:unregister', { proxyId: 'proxy_server-1' });

      expect(mockRedis.del).toHaveBeenCalledWith('mcp:proxy:owner:server-1');
      expect(registry.hasActiveProxy('server-1')).toBe(false);
    });

    it('should delete owner on socket disconnect', async () => {
      const { registry, mockRedis, socket } = createTestContext();
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        command: 'cmd',
      } as never);
      await socket._trigger('proxy:register', { proxyId: 'proxy_server-1', key: 'key' });

      await socket._trigger('disconnect', {});

      expect(mockRedis.del).toHaveBeenCalledWith('mcp:proxy:owner:server-1');
      expect(registry.hasActiveProxy('server-1')).toBe(false);
    });
  });

  describe('forwardRequest', () => {
    it('should throw error if proxy not connected', async () => {
      await expect(
        createTestContext().registry.forwardRequest('proxy_nonexistent', { method: 'tools/list' }),
      ).rejects.toThrow('Proxy not connected');
    });

    it('should reject only the disconnected proxy\'s pending requests', async () => {
      const { registry, socket, connectSocket } = createTestContext();
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-1',
        userId: 'user-1',
        command: 'cmd',
      } as never);
      await socket._trigger('proxy:register', { proxyId: 'proxy_server-1', key: 'key' });

      const socket2 = connectSocket();
      socket2.id = 'socket-2';
      vi.mocked(McpServer.findByIdAndUpdate).mockResolvedValue({
        _id: 'server-2',
        userId: 'user-1',
        command: 'cmd',
      } as never);
      await socket2._trigger('proxy:register', { proxyId: 'proxy_server-2', key: 'key' });

      const p1 = registry.forwardRequest('proxy_server-1', { method: 'tools/list' });
      const p1Rejected = expect(p1).rejects.toThrow('Proxy disconnected');
      const p2 = registry.forwardRequest('proxy_server-2', { method: 'tools/list' });

      // Disconnecting proxy 1 must not interrupt proxy 2's in-flight request.
      await socket._trigger('disconnect', {});
      await p1Rejected;

      const proxyRequestCall = vi.mocked(socket2.emit).mock.calls.find((c) => c[0] === 'proxy:request');
      const { requestId } = proxyRequestCall![1] as { requestId: string };
      await socket2._trigger('proxy:response', { requestId, response: { ok: true } });
      await expect(p2).resolves.toEqual({ ok: true });
    });
  });
});
