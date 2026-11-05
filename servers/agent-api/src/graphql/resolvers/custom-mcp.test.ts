import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../services/custom-mcp-service.js', () => ({
  customMcpService: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { customMcpService } from '../../services/custom-mcp-service.js';
import { customMcpResolvers } from './custom-mcp.js';
import type { AuthContext } from './auth.js';

const authed: AuthContext = { currentUser: { id: 'user1', tenantId: 'tenant1', name: 'U' } };
const anonymous: AuthContext = { currentUser: null };

const SERVER = {
  id: 'm1',
  name: 'mcp-a',
  description: null,
  endpoint: 'https://mcp-a.example.com/mcp',
  authType: 'bearer' as const,
  customHeaders: [{ key: 'X-Api-Key', values: ['v1'] }],
  bearerEntryId: 'e1',
  bearerEntryManaged: true,
  workspaceId: 'w1',
  createdBy: 'user1',
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Custom MCP resolvers', () => {
  describe('认证', () => {
    it.each([
      ['customMcpServers', () => customMcpResolvers.Query.customMcpServers({}, {}, anonymous)],
      ['customMcpServer', () => customMcpResolvers.Query.customMcpServer({}, { id: 'm1' }, anonymous)],
      [
        'createCustomMcpServer',
        () =>
          customMcpResolvers.Mutation.createCustomMcpServer(
            {},
            { input: { name: 'a', endpoint: 'https://x', auth: { type: 'none' } } },
            anonymous,
          ),
      ],
      [
        'updateCustomMcpServer',
        () =>
          customMcpResolvers.Mutation.updateCustomMcpServer({}, { id: 'm1', input: {} }, anonymous),
      ],
      ['deleteCustomMcpServer', () => customMcpResolvers.Mutation.deleteCustomMcpServer({}, { id: 'm1' }, anonymous)],
    ])('%s 未认证抛 Not authenticated', async (_name, call) => {
      await expect(call()).rejects.toThrow('Not authenticated');
      expect(customMcpService.list).not.toHaveBeenCalled();
      expect(customMcpService.create).not.toHaveBeenCalled();
      expect(customMcpService.delete).not.toHaveBeenCalled();
    });
  });

  describe('白名单透传（契约错误表逐字）', () => {
    it.each([
      'custom mcp server not found',
      'invalid mcp name',
      'invalid mcp endpoint',
      'invalid custom headers',
      'bearer token is required',
      'bearer entry must be manual namespace',
      'bearer entry not editable in place',
      'global workspace is read-only',
      'Not found',
    ])('服务层错误 %s 原样透传', async (message) => {
      vi.mocked(customMcpService.create).mockRejectedValue(new Error(message));
      await expect(
        customMcpResolvers.Mutation.createCustomMcpServer(
          {},
          { input: { name: 'a', endpoint: 'https://x', auth: { type: 'none' } } },
          authed,
        ),
      ).rejects.toThrow(message);
    });

    it('非白名单错误收敛为 internal error（不泄露实现细节/token 明文）', async () => {
      vi.mocked(customMcpService.create).mockRejectedValue(
        new Error('Mongo bulk write failed sk-plain-secret'),
      );
      await expect(
        customMcpResolvers.Mutation.createCustomMcpServer(
          {},
          { input: { name: 'a', endpoint: 'https://x', auth: { type: 'bearer', newToken: 'sk-plain-secret' } } },
          authed,
        ),
      ).rejects.toThrow('internal error');
    });

    it('GraphQLError（如 Not authenticated）直接透传', async () => {
      const { GraphQLError } = await import('graphql');
      vi.mocked(customMcpService.update).mockRejectedValue(new GraphQLError('Not found'));
      await expect(
        customMcpResolvers.Mutation.updateCustomMcpServer({}, { id: 'm1', input: {} }, authed),
      ).rejects.toThrow('Not found');
    });
  });

  describe('委托与出参边界', () => {
    it('Query.customMcpServers 委托 list 且出参无 token 明文', async () => {
      vi.mocked(customMcpService.list).mockResolvedValue([SERVER] as never);
      const result = await customMcpResolvers.Query.customMcpServers({}, {}, authed);
      expect(customMcpService.list).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('newToken');
      expect(JSON.stringify(result)).not.toContain('"value"');
    });

    it('Query.customMcpServer 透传 id（不存在返回 null 由服务层承担）', async () => {
      vi.mocked(customMcpService.get).mockResolvedValue(null);
      await expect(customMcpResolvers.Query.customMcpServer({}, { id: 'missing' }, authed)).resolves.toBeNull();
      expect(customMcpService.get).toHaveBeenCalledWith('missing');
    });

    it('createCustomMcpServer 透传 input 与 createdBy，返回服务层视图', async () => {
      vi.mocked(customMcpService.create).mockResolvedValue(SERVER as never);
      const result = await customMcpResolvers.Mutation.createCustomMcpServer(
        {},
        {
          input: {
            name: 'mcp-a',
            description: 'd',
            endpoint: 'https://mcp-a.example.com/mcp',
            auth: { type: 'bearer', newToken: 'plain-token' },
            customHeaders: [{ key: 'X-Api-Key', values: ['v1'] }],
          },
        },
        authed,
      );
      expect(customMcpService.create).toHaveBeenCalledWith({
        name: 'mcp-a',
        description: 'd',
        endpoint: 'https://mcp-a.example.com/mcp',
        auth: { type: 'bearer', newToken: 'plain-token' },
        customHeaders: [{ key: 'X-Api-Key', values: ['v1'] }],
        createdBy: 'user1',
      });
      expect(JSON.stringify(result)).not.toContain('plain-token');
    });

    it('updateCustomMcpServer / deleteCustomMcpServer 委托服务层', async () => {
      vi.mocked(customMcpService.update).mockResolvedValue(SERVER as never);
      vi.mocked(customMcpService.delete).mockResolvedValue(true);

      await customMcpResolvers.Mutation.updateCustomMcpServer(
        {},
        { id: 'm1', input: { name: 'renamed', auth: { type: 'bearer', newToken: 't' } } },
        authed,
      );
      expect(customMcpService.update).toHaveBeenCalledWith('m1', {
        name: 'renamed',
        description: undefined,
        endpoint: undefined,
        auth: { type: 'bearer', newToken: 't' },
        customHeaders: undefined,
      });

      const deleted = await customMcpResolvers.Mutation.deleteCustomMcpServer({}, { id: 'm1' }, authed);
      expect(customMcpService.delete).toHaveBeenCalledWith('m1');
      expect(deleted).toBe(true);
    });
  });

  describe('安全红线与登记', () => {
    it('resolver 源码不引用 resolveValue/decrypt（解密不出服务端内部）', () => {
      const source = readFileSync(resolve(process.cwd(), 'src/graphql/resolvers/custom-mcp.ts'), 'utf-8');
      expect(source).not.toMatch(/resolveValue/);
      expect(source).not.toMatch(/decrypt/);
      expect(source).not.toMatch(/valueEncrypted/);
    });

    it('schemas/index.ts 与 resolvers/index.ts 已登记（漏登记运行时无效）', () => {
      const resolversIndex = readFileSync(
        resolve(process.cwd(), 'src/graphql/resolvers/index.ts'),
        'utf-8',
      );
      const schemasIndex = readFileSync(
        resolve(process.cwd(), 'src/graphql/schemas/index.ts'),
        'utf-8',
      );
      expect(resolversIndex).toContain("from './custom-mcp.js'");
      expect(resolversIndex).toContain('...customMcpResolvers.Query');
      expect(resolversIndex).toContain('...customMcpResolvers.Mutation');
      expect(schemasIndex).toContain("from './custom-mcp.js'");
      expect(schemasIndex).toContain('customMcpTypeDefs');
    });
  });
});
