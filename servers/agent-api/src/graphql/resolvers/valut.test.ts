import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../services/valut-service.js', () => ({
  valutService: {
    listGrouped: vi.fn(),
    listManualOptions: vi.fn(),
    createManualEntry: vi.fn(),
    updateValue: vi.fn(),
    deleteEntry: vi.fn(),
  },
}));

import { valutService } from '../../services/valut-service.js';
import { valutResolvers } from './valut.js';
import type { AuthContext } from './auth.js';

const authed: AuthContext = { currentUser: { id: 'user1', tenantId: 'tenant1', name: 'U' } };
const anonymous: AuthContext = { currentUser: null };

const GROUPS = [
  {
    namespace: { name: 'manual', displayName: '自定义密钥', managed: false },
    entries: [
      {
        id: 'e1',
        namespace: 'manual',
        namespaceDisplayName: '自定义密钥',
        key: 'api-key',
        editable: true,
        deletable: true,
        refs: [],
        createdBy: 'user1',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Valut resolvers', () => {
  describe('认证', () => {
    it.each([
      ['valutEntries', () => valutResolvers.Query.valutEntries({}, {}, anonymous)],
      [
        'valutManualOptions',
        () => valutResolvers.Query.valutManualOptions({}, {}, anonymous),
      ],
      [
        'createValutEntry',
        () =>
          valutResolvers.Mutation.createValutEntry(
            {},
            { input: { key: 'k', value: 'v' } },
            anonymous,
          ),
      ],
      [
        'updateValutEntry',
        () => valutResolvers.Mutation.updateValutEntry({}, { id: 'e1', value: 'v' }, anonymous),
      ],
      ['deleteValutEntry', () => valutResolvers.Mutation.deleteValutEntry({}, { id: 'e1' }, anonymous)],
    ])('%s 未认证抛 Not authenticated', async (_name, call) => {
      await expect(call()).rejects.toThrow('Not authenticated');
      expect(valutService.listGrouped).not.toHaveBeenCalled();
      expect(valutService.createManualEntry).not.toHaveBeenCalled();
    });
  });

  describe('白名单透传（契约错误表逐字）', () => {
    it.each([
      'valut entry not found',
      'valut key already exists',
      'invalid valut key',
      'invalid valut value',
      'valut entry is not editable',
      'valut entry is not deletable',
      'valut entry has refs',
      'global workspace is read-only',
      'Not found',
    ])('服务层错误 %s 原样透传', async (message) => {
      vi.mocked(valutService.createManualEntry).mockRejectedValue(new Error(message));
      await expect(
        valutResolvers.Mutation.createValutEntry(
          {},
          { input: { key: 'k', value: 'v' } },
          authed,
        ),
      ).rejects.toThrow(message);
    });

    it('非白名单错误收敛为 internal error（不泄露实现细节/明文）', async () => {
      vi.mocked(valutService.createManualEntry).mockRejectedValue(
        new Error('Mongo bulk write failed sk-plain-secret'),
      );
      await expect(
        valutResolvers.Mutation.createValutEntry(
          {},
          { input: { key: 'k', value: 'sk-plain-secret' } },
          authed,
        ),
      ).rejects.toThrow('internal error');
    });

    it('GraphQLError（如 Not authenticated）直接透传', async () => {
      const { GraphQLError } = await import('graphql');
      vi.mocked(valutService.updateValue).mockRejectedValue(new GraphQLError('Not found'));
      await expect(
        valutResolvers.Mutation.updateValutEntry({}, { id: 'e1', value: 'v' }, authed),
      ).rejects.toThrow('Not found');
    });
  });

  describe('委托与出参边界', () => {
    it('Query.valutEntries 委托 listGrouped 且装配体无 value 字段', async () => {
      vi.mocked(valutService.listGrouped).mockResolvedValue(GROUPS as never);
      const result = await valutResolvers.Query.valutEntries({}, {}, authed);
      expect(valutService.listGrouped).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('"value"');
      expect(result[0].entries[0].key).toBe('api-key');
    });

    it('Query.valutManualOptions 委托 listManualOptions（服务层强制当前工作区）', async () => {
      vi.mocked(valutService.listManualOptions).mockResolvedValue(GROUPS[0].entries as never);
      const result = await valutResolvers.Query.valutManualOptions({}, {}, authed);
      expect(valutService.listManualOptions).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('"value"');
    });

    it('createValutEntry 透传 key/value 入参并返回服务层视图', async () => {
      vi.mocked(valutService.createManualEntry).mockResolvedValue(GROUPS[0].entries[0] as never);
      const result = await valutResolvers.Mutation.createValutEntry(
        {},
        { input: { key: 'api-key', value: 'plain-secret' } },
        authed,
      );
      expect(valutService.createManualEntry).toHaveBeenCalledWith({
        key: 'api-key',
        value: 'plain-secret',
        createdBy: 'user1',
      });
      expect(JSON.stringify(result)).not.toContain('plain-secret');
    });

    it('updateValutEntry / deleteValutEntry 委托服务层', async () => {
      vi.mocked(valutService.updateValue).mockResolvedValue(GROUPS[0].entries[0] as never);
      vi.mocked(valutService.deleteEntry).mockResolvedValue(true);

      await valutResolvers.Mutation.updateValutEntry({}, { id: 'e1', value: 'new' }, authed);
      expect(valutService.updateValue).toHaveBeenCalledWith('e1', 'new');

      const deleted = await valutResolvers.Mutation.deleteValutEntry({}, { id: 'e1' }, authed);
      expect(valutService.deleteEntry).toHaveBeenCalledWith('e1');
      expect(deleted).toBe(true);
    });
  });

  describe('安全红线', () => {
    it('resolver 源码不引用 resolveValue（解密不出服务端内部）', () => {
      const dir = resolve(process.cwd(), 'src/graphql/resolvers');
      const files = readFileSync(resolve(dir, 'valut.ts'), 'utf-8');
      expect(files).not.toMatch(/resolveValue/);
      expect(files).not.toMatch(/decrypt/);
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
      expect(resolversIndex).toContain("from './valut.js'");
      expect(resolversIndex).toContain('...valutResolvers.Query');
      expect(resolversIndex).toContain('...valutResolvers.Mutation');
      expect(schemasIndex).toContain("from './valut.js'");
      expect(schemasIndex).toContain('valutTypeDefs');
    });
  });
});
