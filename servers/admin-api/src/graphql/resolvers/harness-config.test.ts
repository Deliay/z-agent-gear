import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLObjectType, GraphQLEnumType } from 'graphql';

const h = vi.hoisted(() => ({
  service: {
    listConfigs: vi.fn(),
    upsertConfig: vi.fn(),
  },
}));

vi.mock('../../services/harness-config.js', () => ({ harnessConfigService: h.service }));

import { harnessConfigResolvers } from './harness-config.js';
import { typeDefs } from '../schemas/index.js';
import { resolvers } from './index.js';

const ADMIN = { id: 'a1', username: 'admin', mustChangePassword: false };
const CONTEXT = { currentAdmin: ADMIN };

const CONFIG = {
  harnessType: 'OPENCODE',
  compactCommand: '/compact',
  updatedAt: new Date(0).toISOString(),
};

describe('harness-config resolver 守卫与登记（T-HCA3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未认证 → Not authenticated / UNAUTHENTICATED（Query 与 Mutation 均拦截）', async () => {
    await expect(
      harnessConfigResolvers.Query.adminHarnessConfigs({}, {}, { currentAdmin: null }),
    ).rejects.toMatchObject({
      message: 'Not authenticated',
      extensions: { code: 'UNAUTHENTICATED' },
    });
    await expect(
      harnessConfigResolvers.Mutation.upsertHarnessConfig(
        {},
        { harnessType: 'OPENCODE', compactCommand: '/compact' },
        { currentAdmin: null },
      ),
    ).rejects.toMatchObject({
      message: 'Not authenticated',
      extensions: { code: 'UNAUTHENTICATED' },
    });
    expect(h.service.listConfigs).not.toHaveBeenCalled();
    expect(h.service.upsertConfig).not.toHaveBeenCalled();
  });

  it('mustChangePassword → MUST_CHANGE_PASSWORD', async () => {
    await expect(
      harnessConfigResolvers.Query.adminHarnessConfigs(
        {},
        {},
        { currentAdmin: { ...ADMIN, mustChangePassword: true } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'MUST_CHANGE_PASSWORD' } });
  });

  it('已认证 → 委托 service（查询全量 / 按 harnessType upsert）', async () => {
    h.service.listConfigs.mockResolvedValue([CONFIG]);
    h.service.upsertConfig.mockResolvedValue({ ...CONFIG, compactCommand: '/custom' });

    await expect(
      harnessConfigResolvers.Query.adminHarnessConfigs({}, {}, CONTEXT),
    ).resolves.toEqual([CONFIG]);
    await expect(
      harnessConfigResolvers.Mutation.upsertHarnessConfig(
        {},
        { harnessType: 'OPENCODE', compactCommand: '/custom' },
        CONTEXT,
      ),
    ).resolves.toEqual({ ...CONFIG, compactCommand: '/custom' });
    expect(h.service.upsertConfig).toHaveBeenCalledWith('OPENCODE', '/custom');
  });

  it('服务层文案逐字透传：invalid compact command', async () => {
    h.service.upsertConfig.mockRejectedValue(new Error('invalid compact command'));
    const call = harnessConfigResolvers.Mutation.upsertHarnessConfig(
      {},
      { harnessType: 'OPENCODE', compactCommand: 'nope' },
      CONTEXT,
    );
    await expect(call).rejects.toBeInstanceOf(GraphQLError);
    await expect(call).rejects.toThrow(/^invalid compact command$/);
  });

  it('服务层文案逐字透传：invalid harness type', async () => {
    h.service.upsertConfig.mockRejectedValue(new Error('invalid harness type'));
    await expect(
      harnessConfigResolvers.Mutation.upsertHarnessConfig(
        {},
        { harnessType: 'CLAUDE_CODE' as never, compactCommand: '/compact' },
        CONTEXT,
      ),
    ).rejects.toThrow(/^invalid harness type$/);
  });

  it('E11000 → 配置已存在', async () => {
    h.service.upsertConfig.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    await expect(
      harnessConfigResolvers.Mutation.upsertHarnessConfig(
        {},
        { harnessType: 'OPENCODE', compactCommand: '/compact' },
        CONTEXT,
      ),
    ).rejects.toThrow(/^配置已存在$/);
  });

  it('index 守卫：typeDefs 与 resolvers 均已登记（漏登记运行时无效）', () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });

    expect(Object.keys(schema.getQueryType()!.getFields())).toContain('adminHarnessConfigs');
    expect(Object.keys(schema.getMutationType()!.getFields())).toContain('upsertHarnessConfig');
    expect(resolvers.Query.adminHarnessConfigs).toBeTypeOf('function');
    expect(resolvers.Mutation.upsertHarnessConfig).toBeTypeOf('function');

    const config = schema.getType('HarnessConfig') as GraphQLObjectType;
    expect(Object.keys(config.getFields())).toEqual([
      'harnessType',
      'compactCommand',
      'updatedAt',
    ]);
    const harnessType = schema.getType('HarnessType') as GraphQLEnumType;
    expect(harnessType.getValues().map((value) => value.name)).toEqual([
      'OPENCODE',
      'KIMI_CODE',
      'DEEPSEEK_HARNESS',
    ]);
  });
});
