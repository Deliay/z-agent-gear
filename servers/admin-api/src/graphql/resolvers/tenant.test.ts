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
import { TenantMember } from '../../models/tenant-member.js';
import { User } from '../../models/user.js';
import { Workspace } from '../../models/workspace.js';
import { WorkspaceMember } from '../../models/workspace-member.js';
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

interface SeedMember {
  name?: string;
  username: string;
  role?: 'admin' | 'developer';
}

async function seedTenant(options: {
  name: string;
  type?: 'personal' | 'team';
  createdAt?: Date;
  members?: SeedMember[];
  /** 是否写 tenantmembers 行（缺省 false：模拟迁移 015 前的 personal 老数据） */
  withTenantMembers?: boolean;
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
    if (options.withTenantMembers) {
      await TenantMember.create({
        tenantId,
        userId: user._id,
        role: member.role ?? 'admin',
        createdBy: 'migration',
        createdAt: new Date(createdAt.getTime() + index),
        updatedAt: createdAt,
      });
    }
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

async function seedWorkspace(options: {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  type?: 'global' | 'normal';
  memberUserIds?: mongoose.Types.ObjectId[];
  createdAt?: Date;
}): Promise<mongoose.Types.ObjectId> {
  const createdAt = options.createdAt ?? new Date();
  const workspace = await Workspace.create({
    tenantId: options.tenantId,
    name: options.name,
    type: options.type ?? 'normal',
    createdAt,
    updatedAt: createdAt,
  });
  for (const userId of options.memberUserIds ?? []) {
    await WorkspaceMember.create({
      workspaceId: workspace._id,
      tenantId: options.tenantId,
      userId,
    });
  }
  return workspace._id as mongoose.Types.ObjectId;
}

describe('admin-tenant resolvers（T-AT1~9）', () => {
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
      role: 'admin',
    });
    expect(detail.workspaces).toEqual([]);

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
      role: 'admin',
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

  it('T-AT8: 只读性——租户域仅开户/team 开通/成员初始化写入口，无编辑/删除', () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    const mutationFields = Object.keys(schema.getMutationType()!.getFields());
    expect(mutationFields).toEqual(
      expect.arrayContaining([
        'adminCreateFrontUser',
        'adminCreateTeamTenant',
        'adminAddTenantMember',
        'adminRemoveTenantMember',
      ]),
    );
    // 租户域不暴露任何租户/工作区编辑或删除 mutation（只读视图 + 内部端点转发写操作）
    expect(mutationFields.some((field) => /(update|delete)(tenant|workspace)/i.test(field))).toBe(false);
    expect(mutationFields.some((field) => /workspace/i.test(field))).toBe(false);

    const queryFields = Object.keys(schema.getQueryType()!.getFields());
    expect(queryFields).toEqual(expect.arrayContaining(['adminTenants', 'adminTenant']));
    expect(resolvers.Query.adminTenants).toBeTypeOf('function');
    expect(resolvers.Query.adminTenant).toBeTypeOf('function');
    expect(resolvers.Mutation.adminCreateFrontUser).toBeTypeOf('function');
  });
});

describe('admin-tenant team 开通与成员初始化（T-TT1~12）', () => {
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

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('T-TT1: adminCreateTeamTenant 转发 POST /internal/tenants 并回读镜像摘要', async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const createdAt = new Date('2026-10-28T00:00:00Z');
    await Tenant.create({ _id: tenantId, name: 'acme', type: 'team', createdAt, updatedAt: createdAt });
    const { userIds } = await seedTenant({
      name: 'owner-personal',
      members: [{ username: 'owner', role: 'admin' }],
      withTenantMembers: true,
    });
    await TenantMember.create({ tenantId, userId: userIds[0], role: 'admin', createdBy: 'admin-1' });
    await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: String(tenantId),
      ownerName: 'acme',
      cashBalance: 250,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        tenant: { id: String(tenantId), name: 'acme', type: 'team' },
        globalWorkspace: { id: new mongoose.Types.ObjectId().toString(), name: '全局工作区', type: 'global' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const created = await Mutation.adminCreateTeamTenant({}, { name: 'acme' }, adminContext());
    expect(created).toMatchObject({
      id: String(tenantId),
      name: 'acme',
      type: 'team',
      memberCount: 1,
      balance: 2.5,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://agent-api:8000/internal/tenants');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer internal-token');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'acme' });
  });

  it('T-TT2: 创建 team 重名（上游 409 TENANT_NAME_TAKEN）→ CONFLICT tenant name already exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'TENANT_NAME_TAKEN' })));

    await expect(
      Mutation.adminCreateTeamTenant({}, { name: 'taken' }, adminContext()),
    ).rejects.toSatisfy(
      (err) =>
        errorCode(err) === 'CONFLICT' &&
        (err as GraphQLError).message === 'tenant name already exists',
    );
  });

  it('T-TT3: team 三 mutation 未鉴权一律 UNAUTHENTICATED，不发起转发', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tenantId = new mongoose.Types.ObjectId().toString();
    const userId = new mongoose.Types.ObjectId().toString();

    for (const call of [
      () => Mutation.adminCreateTeamTenant({}, { name: 'acme' }, anonContext),
      () => Mutation.adminAddTenantMember({}, { tenantId, username: 'alice' }, anonContext),
      () => Mutation.adminRemoveTenantMember({}, { tenantId, userId }, anonContext),
    ]) {
      await expect(call()).rejects.toSatisfy((err) => errorCode(err) === 'UNAUTHENTICATED');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T-TT4: 加成员指定角色——body 含 role 与 operatorId（当前 admin id）', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      members: [{ name: 'Alice', username: 'alice', role: 'admin' }],
      withTenantMembers: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        user: { id: String(seeded.userIds[0]), name: 'Alice', username: 'alice', role: 'admin' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const member = await Mutation.adminAddTenantMember(
      {},
      { tenantId: String(seeded.tenantId), username: 'alice', role: 'admin' },
      adminContext(),
    );
    expect(member).toMatchObject({
      id: String(seeded.userIds[0]),
      name: 'Alice',
      username: 'alice',
      role: 'admin',
    });
    expect(member.createdAt).toBeTypeOf('string');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://agent-api:8000/internal/tenants/${seeded.tenantId}/members`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      username: 'alice',
      role: 'admin',
      operatorId: 'admin-1',
    });
  });

  it('T-TT5: 未指定角色时缺省 developer', async () => {
    const seeded = await seedTenant({ name: 'acme', type: 'team' });
    const devUserId = new mongoose.Types.ObjectId().toString();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { user: { id: devUserId, name: 'dev', username: 'dev', role: 'developer' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const member = await Mutation.adminAddTenantMember(
      {},
      { tenantId: String(seeded.tenantId), username: 'dev' },
      adminContext(),
    );
    expect(member.role).toBe('developer');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      username: 'dev',
      role: 'developer',
      operatorId: 'admin-1',
    });
  });

  it('T-TT6: 重复添加为幂等 200，不覆盖既有角色', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      members: [{ name: 'Alice', username: 'alice', role: 'admin' }],
      withTenantMembers: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          user: { id: String(seeded.userIds[0]), name: 'Alice', username: 'alice', role: 'admin' },
        }),
      ),
    );

    const member = await Mutation.adminAddTenantMember(
      {},
      { tenantId: String(seeded.tenantId), username: 'alice', role: 'developer' },
      adminContext(),
    );
    // 上游幂等返回既有角色 admin（不因本次请求的 developer 覆盖）
    expect(member.role).toBe('admin');
  });

  it('T-TT7: 移除最后一名管理员（上游 409 LAST_ADMIN）→ CONFLICT last admin cannot be removed', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      members: [{ username: 'alice', role: 'admin' }],
      withTenantMembers: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, { error: 'LAST_ADMIN' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      Mutation.adminRemoveTenantMember(
        {},
        { tenantId: String(seeded.tenantId), userId: String(seeded.userIds[0]) },
        adminContext(),
      ),
    ).rejects.toSatisfy(
      (err) =>
        errorCode(err) === 'CONFLICT' &&
        (err as GraphQLError).message === 'last admin cannot be removed',
    );
  });

  it('T-TT8: personal 租户拒绝加/移成员 → INVALID_ARGUMENT personal tenant is immutable', async () => {
    const seeded = await seedTenant({ name: 'personal', members: [{ username: 'alice' }] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(400, { error: 'PERSONAL_TENANT_IMMUTABLE' })),
    );

    for (const call of [
      () =>
        Mutation.adminAddTenantMember(
          {},
          { tenantId: String(seeded.tenantId), username: 'bob' },
          adminContext(),
        ),
      () =>
        Mutation.adminRemoveTenantMember(
          {},
          { tenantId: String(seeded.tenantId), userId: String(seeded.userIds[0]) },
          adminContext(),
        ),
    ]) {
      await expect(call()).rejects.toSatisfy(
        (err) =>
          errorCode(err) === 'INVALID_ARGUMENT' &&
          (err as GraphQLError).message === 'personal tenant is immutable',
      );
    }
  });

  it('T-TT9: 账户不存在/非成员 → NOT_FOUND（account not found / not a member）', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      members: [{ username: 'alice', role: 'admin' }],
      withTenantMembers: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'ACCOUNT_NOT_FOUND' })));
    await expect(
      Mutation.adminAddTenantMember(
        {},
        { tenantId: String(seeded.tenantId), username: 'missing' },
        adminContext(),
      ),
    ).rejects.toSatisfy(
      (err) =>
        errorCode(err) === 'NOT_FOUND' && (err as GraphQLError).message === 'account not found',
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'NOT_MEMBER' })));
    await expect(
      Mutation.adminRemoveTenantMember(
        {},
        { tenantId: String(seeded.tenantId), userId: new mongoose.Types.ObjectId().toString() },
        adminContext(),
      ),
    ).rejects.toSatisfy(
      (err) => errorCode(err) === 'NOT_FOUND' && (err as GraphQLError).message === 'not a member',
    );
  });

  it('T-TT10: 成员移除成功——DELETE 带 operatorId 查询参（审计），返回 true', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      members: [{ username: 'alice', role: 'admin' }],
      withTenantMembers: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const removed = await Mutation.adminRemoveTenantMember(
      {},
      { tenantId: String(seeded.tenantId), userId: String(seeded.userIds[0]) },
      adminContext(),
    );
    expect(removed).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://agent-api:8000/internal/tenants/${seeded.tenantId}/members/${seeded.userIds[0]}?operatorId=admin-1`,
    );
    expect(init.method).toBe('DELETE');
  });

  it('T-TT11: 详情成员经 tenantmembers 展开（含 role）+ 工作区只读视图与成员数', async () => {
    const seeded = await seedTenant({
      name: 'acme',
      type: 'team',
      createdAt: new Date('2026-10-20T00:00:00Z'),
      members: [
        { name: 'Admin 展示名', username: 'admin-login', role: 'admin' },
        { name: 'Dev 展示名', username: 'dev-login', role: 'developer' },
      ],
      withTenantMembers: true,
    });
    const globalWorkspaceId = await seedWorkspace({
      tenantId: seeded.tenantId,
      name: '全局工作区',
      type: 'global',
      createdAt: new Date('2026-10-20T00:00:00Z'),
    });
    const normalWorkspaceId = await seedWorkspace({
      tenantId: seeded.tenantId,
      name: '前端组',
      type: 'normal',
      memberUserIds: [seeded.userIds[0]],
      createdAt: new Date('2026-10-21T00:00:00Z'),
    });

    const detail = await Query.adminTenant({}, { id: String(seeded.tenantId) }, adminContext());
    expect(detail.type).toBe('team');
    expect(detail.users).toHaveLength(2);
    expect(detail.users[0]).toMatchObject({
      id: String(seeded.userIds[0]),
      name: 'Admin 展示名',
      username: 'admin-login',
      role: 'admin',
    });
    expect(detail.users[1]).toMatchObject({
      id: String(seeded.userIds[1]),
      name: 'Dev 展示名',
      username: 'dev-login',
      role: 'developer',
    });

    expect(detail.workspaces).toHaveLength(2);
    expect(detail.workspaces[0]).toMatchObject({
      id: String(globalWorkspaceId),
      name: '全局工作区',
      type: 'global',
      // global 语义=租户全员，取 tenantmembers 计数
      memberCount: 2,
    });
    expect(detail.workspaces[1]).toMatchObject({
      id: String(normalWorkspaceId),
      name: '前端组',
      type: 'normal',
      // normal 取 workspacemembers 计数
      memberCount: 1,
    });
  });

  it('T-TT12: personal 老数据无 tenantmembers 行时回退 users 计数与 role=admin', async () => {
    const seeded = await seedTenant({ name: 'legacy', members: [{ username: 'legacy' }] });

    const list = await Query.adminTenants({}, {}, adminContext());
    expect(list).toHaveLength(1);
    expect(list[0].memberCount).toBe(1);

    const detail = await Query.adminTenant({}, { id: String(seeded.tenantId) }, adminContext());
    expect(detail.users).toHaveLength(1);
    expect(detail.users[0]).toMatchObject({ role: 'admin', username: 'legacy' });
    expect(detail.workspaces).toEqual([]);
  });

  it('T-TT13: 上游不可达（网络异常/502）→ AGENT_API_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(
      Mutation.adminCreateTeamTenant({}, { name: 'acme' }, adminContext()),
    ).rejects.toSatisfy((err) => errorCode(err) === 'AGENT_API_UNAVAILABLE');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'BAD_GATEWAY' })));
    await expect(
      Mutation.adminAddTenantMember(
        {},
        { tenantId: new mongoose.Types.ObjectId().toString(), username: 'alice' },
        adminContext(),
      ),
    ).rejects.toSatisfy((err) => errorCode(err) === 'AGENT_API_UNAVAILABLE');
  });

  it('T-TT14: 契约类型面——AdminWorkspace/AdminTenantUser.role/AdminTenantDetail.workspaces/TenantRole', () => {
    const schema = makeExecutableSchema({ typeDefs, resolvers });
    const adminWorkspace = schema.getType('AdminWorkspace') as any;
    expect(Object.keys(adminWorkspace.getFields())).toEqual([
      'id',
      'name',
      'type',
      'memberCount',
      'createdAt',
    ]);
    const userType = schema.getType('AdminTenantUser') as any;
    expect(Object.keys(userType.getFields())).toContain('role');
    const detail = schema.getType('AdminTenantDetail') as any;
    expect(Object.keys(detail.getFields())).toContain('workspaces');
    const roleEnum = schema.getType('TenantRole') as any;
    expect(roleEnum.getValues().map((value: { name: string }) => value.name)).toEqual([
      'admin',
      'developer',
    ]);
    const workspaceType = schema.getType('WorkspaceType') as any;
    expect(workspaceType.getValues().map((value: { name: string }) => value.name)).toEqual([
      'global',
      'normal',
    ]);
  });
});
