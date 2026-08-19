import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mcpServerResolvers } from './mcp-server.js';

vi.mock('../../models/mcp-server.js', () => ({
  McpServer: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../services/workflow/admin-tools.js', () => ({
  ensureAdminToolsServer: vi.fn().mockResolvedValue('mcp-admin-1'),
  ADMIN_PLATFORM_SERVER_NAME: 'agent-workflow-admin-tools',
}));

import { McpServer } from '../../models/mcp-server.js';
import { ensureAdminToolsServer } from '../../services/workflow/admin-tools.js';

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
};

const emptyContext = {
  currentUser: null,
};

function mockDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'server-1' },
    name: 'github-mcp',
    transport: 'registered_proxy',
    source: 'proxy',
    enabled: true,
    command: 'npx -y @modelcontextprotocol/server-github',
    url: null,
    hostname: null,
    status: 'active',
    tools: [{ name: 'search', description: 'Search repositories' }],
    toolsSyncedAt: new Date('2024-01-01T00:00:00.000Z'),
    lastHeartbeatAt: new Date('2024-01-02T00:00:00.000Z'),
    createdAt: new Date('2024-01-03T00:00:00.000Z'),
    updatedAt: new Date('2024-01-04T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('McpServer Resolvers', () => {
  describe('Query.mcpServers', () => {
    it('should map all new fields', async () => {
      const docs = [mockDoc()];
      vi.mocked(McpServer.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(docs) }),
      } as never);

      const result = await mcpServerResolvers.Query.mcpServers({}, {}, mockContext);

      expect(McpServer.find).toHaveBeenCalledWith({ userId: 'user1' });
      expect(result).toEqual([{
        id: 'server-1',
        name: 'github-mcp',
        transport: 'registered_proxy',
        source: 'proxy',
        enabled: true,
        command: 'npx -y @modelcontextprotocol/server-github',
        url: null,
        hostname: null,
        status: 'active',
        tools: [{ name: 'search', description: 'Search repositories' }],
        toolsSyncedAt: docs[0].toolsSyncedAt,
        lastHeartbeatAt: docs[0].lastHeartbeatAt,
        createdAt: docs[0].createdAt,
        updatedAt: docs[0].updatedAt,
      }]);
    });

    it('should default tools to empty array when missing', async () => {
      const docs = [mockDoc({ tools: undefined })];
      vi.mocked(McpServer.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(docs) }),
      } as never);

      const result = await mcpServerResolvers.Query.mcpServers({}, {}, mockContext);

      expect(result[0].tools).toEqual([]);
    });

    it('should ensure the platform admin-tools server is registered before listing', async () => {
      vi.mocked(McpServer.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      } as never);

      await mcpServerResolvers.Query.mcpServers({}, {}, mockContext);

      // 平台内置「工作流管理工具集」默认启用、可装配到任意会话：
      // 读路径幂等 upsert，覆盖从未跑过工作流的用户
      expect(ensureAdminToolsServer).toHaveBeenCalledWith('user1');
      expect(McpServer.find).toHaveBeenCalledWith({ userId: 'user1' });
    });

    it('should throw when not authenticated', async () => {
      await expect(
        mcpServerResolvers.Query.mcpServers({}, {}, emptyContext),
      ).rejects.toThrow('Not authenticated');
      expect(ensureAdminToolsServer).not.toHaveBeenCalled();
    });
  });

  describe('Query.mcpServer', () => {
    it('should return a mapped server', async () => {
      const doc = mockDoc();
      vi.mocked(McpServer.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(doc),
      } as never);

      const result = await mcpServerResolvers.Query.mcpServer({}, { id: 'server-1' }, mockContext);

      expect(McpServer.findOne).toHaveBeenCalledWith({ _id: 'server-1', userId: 'user1' });
      expect(result).toEqual({
        id: 'server-1',
        name: 'github-mcp',
        transport: 'registered_proxy',
        source: 'proxy',
        enabled: true,
        command: 'npx -y @modelcontextprotocol/server-github',
        url: null,
        hostname: null,
        status: 'active',
        tools: [{ name: 'search', description: 'Search repositories' }],
        toolsSyncedAt: doc.toolsSyncedAt,
        lastHeartbeatAt: doc.lastHeartbeatAt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    });

    it('should return null when not found', async () => {
      vi.mocked(McpServer.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await mcpServerResolvers.Query.mcpServer({}, { id: 'missing' }, mockContext);

      expect(result).toBeNull();
    });

    it('should throw when not authenticated', async () => {
      await expect(
        mcpServerResolvers.Query.mcpServer({}, { id: 'server-1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.setMcpServerEnabled', () => {
    it('should update enabled and return the mapped server', async () => {
      const doc = mockDoc({ enabled: false });
      vi.mocked(McpServer.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue(doc),
      } as never);

      const result = await mcpServerResolvers.Mutation.setMcpServerEnabled(
        {},
        { id: 'server-1', enabled: false },
        mockContext,
      );

      expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'server-1', userId: 'user1' },
        { $set: { enabled: false } },
        { new: true },
      );
      expect(result.enabled).toBe(false);
      expect(result.id).toBe('server-1');
    });

    it('should throw Server not found when no matching server', async () => {
      vi.mocked(McpServer.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        mcpServerResolvers.Mutation.setMcpServerEnabled({}, { id: 'missing', enabled: true }, mockContext),
      ).rejects.toThrow('Server not found');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        mcpServerResolvers.Mutation.setMcpServerEnabled({}, { id: 'server-1', enabled: true }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });
});
