import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLError } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { tenantResolvers } from './tenant.js';
import type { AdminAuthContext } from './auth.js';
import { config } from '../../config/index.js';
import { Account } from '../../models/account.js';
import { BillingAccount } from '../../models/billing-account.js';
import { Tenant } from '../../models/tenant.js';
import { User } from '../../models/user.js';
import { typeDefs } from '../schemas/index.js';
import { resolvers } from './index.js';
import {
  connectTestDb,
  clearTestDb,
  disconnectTestDb,
} from '../../services/billing/testing/mongo.js';

function adminContext(): AdminAuthContext {
  return {
    currentAdmin: { id: 'admin-1', username: 'admin', mustChangePassword: false },
  } as AdminAuthContext;
}

const anonContext: AdminAuthContext = { currentAdmin: null };

const Query = tenantResolvers.Query as any;
const Mutation = tenantResolvers.Mutation as any;

function errorCode(err: unknown): string | undefined {
  return (err as GraphQLError).extensions?.code as string | undefined;
}

async function seedTenant(options: {
  name: string;
  type?: 'personal' | 'team';
  createdAt?: Date;
  members?: Array<{ name?: string; username: string }>;
  cashBalance?: number;
}): Promise<{ tenantId: mongoose.Types.ObjectId; userIds: mongoose.Types.ObjectId[] }> {
  const tenantId = new mongoose.Types.ObjectId();
  const createdAt = options.createdAt ?? new Date();
  await Tenant.create({
    _id: tenantId,
    name: options.name,
    type: options.type ?? 'personal',
    createdAt,
    updatedAt: createdAt,
  });
  const userIds: mongoose.Types.ObjectId[] = [];
  for (const [index, member] of (options.members ?? []).entries()) {
    const account = await Account.create({
      username: member.username,
      passwordHash: 'hash',
    });
    const user = await User.create({
      _id: new mongoose.Types.ObjectId(),
      name: member.name ?? member.username,
      username: member.username,
      tenantId,
      accountId: account._id,
      createdAt: new Date(createdAt.getTime() + index),
      updatedAt: createdAt,
    });
    userIds.push(user._id as mongoose.Types.ObjectId);
  }
  if (options.cashBalance !== undefined) {
    await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: String(tenantId),
      ownerName: options.name,
      cashBalance: options.cashBalance,
    });
  }
  return { tenantId, userIds };
}

describe('admin-tenant resolvers（T-AT1~8）', () => {
  const originalAgentApiUrl = config.agentApiUrl;
  const originalInternalToken = config.internalApiToken;

  beforeAll(async () => {
    await connectTestDb();
  }, 60000);

  afterAll(async () => {
    config.agentApiUrl = originalAgentApiUrl;
    config.internalApiToken = originalInternalToken;
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    config.agentApiUrl = 'http://agent-api:8000';
    config.internalApiToken = 'internal-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('T-AT1: 未鉴权一律 UNAUTHENTICATED（查询与开户）', async () => {
    for (const call of [
      () => Query.adminTenants({}, {}, anonContext),
      () => Query.adminTenant({}, { id: new mongoose.Types.ObjectId().toString() }, anonContext),
      () => Mutation.adminCreateFrontUser({}, { username: 'alice', password: 'secret1' }, anonContext),
    ]) {
      await expect(call()).rejects.toSatisfy((err) => errorCode(err) === 'UNAUTHENTICATED');
    }
  });

  it('T-AT2: 列表按名称检索 + 分页 + 成员数与余额聚合', async () => {
    const alice = await seedTenant({
      name: 'alice',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      members: [{ username: 'alice' }],
      cashBalance: 1234,
    });
    await seedTenant({
      name: 'bob',
      createdAt: new Date('2026-10-02T00:00:00Z'),
      members: [{ username: 'bob' }],
    });

    const all = await Query.adminTenants({}, {}, adminContext());
    expect(all.map((tenant: { name: string }) => tenant.name)).toEqual(['bob', 'alice']);
    expect(all[1]).toMatchObject({
      id: String(alice.tenantId),
      name: 'alice',
      type: 'personal',
      memberCount: 1,
      balance: 12.34,
    });
    // 无计费账户 → balance null
    expect(all[0]).toMatchObject({ name: 'bob', memberCount: 1, balance: null });

    const filtered = await Query.adminTenants({}, { keyword: 'ALI' }, adminContext());
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('alice');

    // keyword 正则元字符按字面量处理
    expect(await Query.adminTenants({}, { keyword: '.*' }, adminContext())).toEqual([]);

    const page2 = await Query.adminTenants({}, { page: 2, pageSize: 1 }, adminContext());
    expect(page2.map((tenant: { name: string }) => tenant.name)).toEqual(['alice']);
    // 非法分页回退默认值
    const fallback = await Query.adminTenants({}, { page: Number.NaN, pageSize: Number.NaN }, adminContext());
    expect(fallback).toHaveLength(2);
  });

  it('T-AT3: 详情返回租户成员，并经 users.accountId 关联 accounts 取登录名', async () => {
    const seeded = await seedTenant({
      name: 'carol',
      members: [{ name: 'Carol 展示名', username: 'carol-login' }],
    });

    const detail = await Query.adminTenant({}, { id: String(seeded.tenantId) }, adminContext());
    expect(detail).toMatchObject({
      id: String(seeded.tenantId),
      name: 'carol',
      type: 'personal',
    });
    expect(detail.users).toHaveLength(1);
    expect(detail.users[0]).toMatchObject({
      id: String(seeded.userIds[0]),
      name: 'Carol 展示名',
      username: 'carol-login',
    });

    // 非法/不存在 id → null（不泄露存在性）
    expect(await Query.adminTenant({}, { id: 'not-an-object-id' }, adminContext())).toBeNull();
    expect(
      await Query.adminTenant({}, { id: new mongoose.Types.ObjectId().toString() }, adminContext()),
    ).toBeNull();
  });

  it('T-AT4: 开户成功转发 POST /internal/users（Bearer INTERNAL_API_TOKEN）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'u-1', name: 'dave', createdAt: '2026-10-27T00:00:00.000Z' },
          account: { id: 'a-1', username: 'dave' },
          tenant: { id: 'u-1', name: 'dave', type: 'personal' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const created = await Mutation.adminCreateFrontUser(
      {},
      { username: 'dave', password: 'secret1' },
      adminContext(),
    );

    expect(created).toEqual({
      id: 'u-1',
      name: 'dave',
      username: 'dave',
      createdAt: '2026-10-27T00:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://agent-api:8000/internal/users');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer internal-token',
    );
    expect(JSON.parse(String(init.body))).toEqual({ username: 'dave', password: 'secret1' });
  });

  it('T-AT5: 重名（上游 409 USERNAME_TAKEN）→ CONFLICT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'USERNAME_TAKEN' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'taken', password: 'secret1' }, adminContext()),
    ).rejects.toSatisfy(
      (err) => errorCode(err) === 'CONFLICT' && (err as GraphQLError).message === 'USERNAME_TAKEN',
    );
  });

  it('T-AT6: 非法入参 → INVALID_ARGUMENT（本地预校验与上游 400 透传）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // 本地预校验：不发起转发
    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'a', password: 'secret1' }, adminContext()),
    ).rejects.toSatisfy((err) => errorCode(err) === 'INVALID_ARGUMENT');
    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'alice', password: '123' }, adminContext()),
    ).rejects.toSatisfy((err) => errorCode(err) === 'INVALID_ARGUMENT');
    expect(fetchMock).not.toHaveBeenCalled();

    // 上游 400 透传（message 优先，缺失回落 error 码）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'INVALID_BODY',
            message: 'Username must be between 2 and 20 characters',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'alice', password: 'secret1' }, adminContext()),
    ).rejects.toSatisfy(
      (err) =>
        errorCode(err) === 'INVALID_ARGUMENT' &&
        (err as GraphQLError).message === 'Username must be between 2 and 20 characters',
    );
  });

  it('T-AT7: 未配置 AGENT_API_URL（或 token）→ AGENT_API_UNAVAILABLE，不发起转发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    config.agentApiUrl = '';
    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'alice', password: 'secret1' }, adminContext()),
    ).rejects.toSatisfy((err) => errorCode(err) === 'AGENT_API_UNAVAILABLE');

    config.agentApiUrl = 'http://agent-api:8000';
    config.internalApiToken = '';
    await expect(
      Mutation.adminCreateFrontUser({}, { username: 'alice', password: 'secret1' }, adminContext()),
    ).rejects.toSatisfy((err) => errorCode(err) === 'AGENT_API_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T-AT9: 镜像行缺失 createdAt 时返回 epoch 而非 500', async () => {
    const tenantId = new mongoose.Types.ObjectId();
    // 绕过 timestamps 直写镜像集合，模拟半迁移/外部直写行
    await mongoose.connection.collection('tenants').insertOne({
      _id: tenantId,
      name: 'no-created-at',
      type: 'personal',
    });

    const detail = await Query.adminTenant({}, { id: String(tenantId) }, adminContext());
    expect(detail.createdAt).toBe(new Date(0).toISOString());
  });

  it('T-AT8: 只读性——租户无 update/delete mutation，仅开户一个写操作', () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    const mutationFields = Object.keys(schema.getMutationType()!.getFields());
    expect(mutationFields).toContain('adminCreateFrontUser');
    // 租户域不暴露任何 update/delete/remove mutation（只读视图 + 唯一开户写操作）
    expect(mutationFields.filter((field) => /tenant/i.test(field))).toEqual([]);
    expect(mutationFields.some((field) => /(update|delete|remove)tenant/i.test(field))).toBe(false);

    const queryFields = Object.keys(schema.getQueryType()!.getFields());
    expect(queryFields).toEqual(expect.arrayContaining(['adminTenants', 'adminTenant']));
    expect(resolvers.Query.adminTenants).toBeTypeOf('function');
    expect(resolvers.Query.adminTenant).toBeTypeOf('function');
    expect(resolvers.Mutation.adminCreateFrontUser).toBeTypeOf('function');
  });
});
