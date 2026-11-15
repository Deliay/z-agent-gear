import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLObjectType } from 'graphql';

vi.mock('../../services/custom-tool-service.js', () => ({
  customToolService: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { customToolService } from '../../services/custom-tool-service.js';
import { customToolResolvers } from './custom-tool.js';
import { customToolTypeDefs } from '../schemas/custom-tool.js';
import { typeDefs } from '../schemas/index.js';
import { resolvers } from './index.js';
import type { AuthContext } from './auth.js';

const context = { currentUser: { id: 'u1' } } as unknown as AuthContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('custom-tool resolvers', () => {
  it('未认证 → Not authenticated', async () => {
    await expect(
      customToolResolvers.Query.customTools({}, {}, {} as AuthContext),
    ).rejects.toThrow('Not authenticated');
  });

  it('白名单错误逐字透传，未命中收敛 internal error', async () => {
    vi.mocked(customToolService.list).mockRejectedValueOnce(new Error('duplicate custom tool name'));
    await expect(
      customToolResolvers.Query.customTools({}, {}, context),
    ).rejects.toThrow('duplicate custom tool name');

    vi.mocked(customToolService.list).mockRejectedValueOnce(new Error('driver detail'));
    await expect(customToolResolvers.Query.customTools({}, {}, context)).rejects.toThrow(
      'internal error',
    );
  });

  it('GraphQLError 原样透传；Mutation 委托 service', async () => {
    vi.mocked(customToolService.delete).mockRejectedValueOnce(new GraphQLError('boom'));
    await expect(
      customToolResolvers.Mutation.deleteCustomTool({}, { id: 'x' }, context),
    ).rejects.toThrow('boom');

    vi.mocked(customToolService.delete).mockResolvedValueOnce(true);
    await expect(
      customToolResolvers.Mutation.deleteCustomTool({}, { id: 'x' }, context),
    ).resolves.toBe(true);
    expect(customToolService.delete).toHaveBeenCalledWith('x');
  });

  it('Query/Mutation 已登记到 resolvers/index.ts 的可执行 schema', () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    const query = schema.getType('Query') as GraphQLObjectType;
    const mutation = schema.getType('Mutation') as GraphQLObjectType;
    expect(query.getFields().customTools).toBeTruthy();
    expect(query.getFields().customTool).toBeTruthy();
    expect(mutation.getFields().createCustomTool).toBeTruthy();
    expect(mutation.getFields().updateCustomTool).toBeTruthy();
    expect(mutation.getFields().deleteCustomTool).toBeTruthy();
    // 独立 schema 校验（避免 index 聚合掩盖契约缺失）
    expect(() =>
      makeExecutableSchema({
        typeDefs: ['type Query { _empty: Boolean }', 'type Mutation { _empty: Boolean }', customToolTypeDefs],
        resolvers: {},
      }),
    ).not.toThrow();
  });
});
