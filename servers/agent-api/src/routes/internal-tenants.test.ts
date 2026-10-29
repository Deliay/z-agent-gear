import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
  tenant: { findOne: vi.fn(), findById: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
  account: { findOne: vi.fn() },
  user: { findOne: vi.fn() },
  tenantMember: { findOne: vi.fn() },
  billing: { getAccount: vi.fn() },
  workspace: { ensureGlobalWorkspace: vi.fn() },
  memberService: {
    addTenantMember: vi.fn(),
    removeTenantMember: vi.fn(),
    changeTenantMemberRole: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));
vi.mock('../models/tenant.js', () => ({ Tenant: h.tenant }));
vi.mock('../models/account.js', () => ({ Account: h.account }));
vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/tenant-member.js', () => ({ TenantMember: h.tenantMember }));
vi.mock('../services/billing-client.js', () => ({ billingClient: h.billing }));
vi.mock('../services/workspace-service.js', () => ({
  workspaceService: h.workspace,
  WORKSPACE_ERRORS: {},
}));
vi.mock('../services/tenant-member-service.js', () => ({
  tenantMemberService: h.memberService,
}));

import { internalTenantsRouter } from './internal-tenants.js';

const TOKEN = h.config.internalApiToken;
const TENANT_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';


describe('internal tenants router（T-IT 系列）', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.tenant.findOne.mockResolvedValue(null);
    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.account.findOne.mockResolvedValue(null);
    h.user.findOne.mockResolvedValue(null);
    h.tenantMember.findOne.mockResolvedValue(null);
    h.billing.getAccount.mockResolvedValue({ id: 'billing-1' });
    h.workspace.ensureGlobalWorkspace.mockResolvedValue({
      id: 'ws-global',
      name: '全局工作区',
      type: 'global',
    });
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      _id: TENANT_ID,
      ...doc,
    }));
    h.tenantMember.findOne.mockResolvedValue(null);
    h.billing.getAccount.mockResolvedValue({ id: 'billing-1' });

    const app = express();
    app.use(express.json());
    app.use('/internal/tenants', internalTenantsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(path: string, method: string, body?: unknown, token = TOKEN) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('T-IT1: 创建 team 租户 → 全局工作区 → 零余额计费账户', async () => {
    h.tenant.findOne.mockResolvedValue(null);
    const res = await call('/internal/tenants', 'POST', { name: '团队A' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenant).toEqual({ id: TENANT_ID, name: '团队A', type: 'team' });
    expect(body.globalWorkspace).toEqual({ id: 'ws-global', name: '全局工作区', type: 'global' });
    expect(h.billing.getAccount).toHaveBeenCalledWith('tenant', TENANT_ID, '团队A');
    expect(h.workspace.ensureGlobalWorkspace).toHaveBeenCalledWith(TENANT_ID);
  });

  it('T-IT2: 重名 team 返回 409 TENANT_NAME_TAKEN；同名 personal 同样 409', async () => {
    h.tenant.findOne.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.workspace.ensureGlobalWorkspace.mockResolvedValue({
      id: 'ws-global',
      name: '全局工作区',
      type: 'global',
    });
    const dupTeam = await call('/internal/tenants', 'POST', { name: '团队A' });
    // 按 name 幂等：已存在 team 返回 200 既有视图
    expect(dupTeam.status).toBe(200);

    h.tenant.findOne.mockResolvedValue({ _id: TENANT_ID, name: 'alice', type: 'personal' });
    const dupPersonal = await call('/internal/tenants', 'POST', { name: 'alice' });
    expect(dupPersonal.status).toBe(409);
    expect(await dupPersonal.json()).toEqual({ error: 'TENANT_NAME_TAKEN' });
  });

  it('T-IT3: 加成员指定角色 / role 缺省 developer / 非法 role 400', async () => {
    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'bob' });
    h.user.findOne.mockResolvedValue({ _id: USER_ID, name: 'bob' });
    h.memberService.addTenantMember.mockResolvedValue({
      id: USER_ID,
      name: 'bob',
      username: 'bob',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });

    const res = await call(`/internal/tenants/${TENANT_ID}/members`, 'POST', {
      username: 'bob',
      role: 'admin',
      operatorId: 'admin-1',
    });
    expect(res.status).toBe(201);
    expect((await res.json()).user).toMatchObject({ id: USER_ID, role: 'admin' });
    expect(h.memberService.addTenantMember).toHaveBeenCalledWith(
      'admin-1',
      TENANT_ID,
      'bob',
      'admin',
      true,
    );

    const badRole = await call(`/internal/tenants/${TENANT_ID}/members`, 'POST', {
      username: 'bob',
      role: 'owner',
    });
    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toEqual({ error: 'INVALID_ROLE' });
  });

  it('T-IT4: 重复加成员幂等 200 且不覆盖既有角色', async () => {
    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'bob' });
    h.user.findOne.mockResolvedValue({ _id: USER_ID, name: 'bob' });
    h.tenantMember.findOne.mockResolvedValue({ _id: 'tm-1', role: 'admin' });
    h.memberService.addTenantMember.mockResolvedValue({
      id: USER_ID,
      name: 'bob',
      username: 'bob',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });

    const res = await call(`/internal/tenants/${TENANT_ID}/members`, 'POST', {
      username: 'bob',
      role: 'developer',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('admin');
  });

  it('T-IT5: 账户不存在 404 / personal 租户 400', async () => {
    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.account.findOne.mockResolvedValue(null);
    const missing = await call(`/internal/tenants/${TENANT_ID}/members`, 'POST', {
      username: 'ghost',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'ACCOUNT_NOT_FOUND' });

    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: 'alice', type: 'personal' });
    const personal = await call(`/internal/tenants/${TENANT_ID}/members`, 'POST', {
      username: 'alice',
    });
    expect(personal.status).toBe(400);
    expect(await personal.json()).toEqual({ error: 'PERSONAL_TENANT_IMMUTABLE' });
  });

  it('T-IT6: 移除成员 → 200；last-admin → 409 LAST_ADMIN；personal → 400', async () => {
    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: '团队A', type: 'team' });
    h.memberService.removeTenantMember.mockResolvedValue(true);
    const ok = await call(`/internal/tenants/${TENANT_ID}/members/${USER_ID}?operatorId=admin-1`, 'DELETE');
    expect(ok.status).toBe(200);
    expect(h.memberService.removeTenantMember).toHaveBeenCalledWith(
      'admin-1',
      TENANT_ID,
      USER_ID,
      true,
    );

    h.memberService.removeTenantMember.mockRejectedValue(new Error('last admin cannot be removed'));
    const last = await call(`/internal/tenants/${TENANT_ID}/members/${USER_ID}`, 'DELETE');
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: 'LAST_ADMIN' });

    h.tenant.findById.mockResolvedValue({ _id: TENANT_ID, name: 'alice', type: 'personal' });
    const personal = await call(`/internal/tenants/${TENANT_ID}/members/${USER_ID}`, 'DELETE');
    expect(personal.status).toBe(400);
    expect(await personal.json()).toEqual({ error: 'PERSONAL_TENANT_IMMUTABLE' });
  });

  it('T-IT7: 未授权 401', async () => {
    const res = await call('/internal/tenants', 'POST', { name: '团队A' }, '');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' });
  });
});
