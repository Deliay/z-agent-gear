import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
  account: { findOne: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
  user: {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
  tenant: { findById: vi.fn(), create: vi.fn(), deleteOne: vi.fn() },
  billing: { getAccount: vi.fn() },
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('../config/index.js', () => ({ config: h.config }));
vi.mock('../models/account.js', () => ({ Account: h.account }));
vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/tenant.js', () => ({ Tenant: h.tenant }));
vi.mock('../services/billing-client.js', () => ({ billingClient: h.billing }));
vi.mock('../services/auth.js', () => ({
  assertUsernamePasswordRules: (username: unknown, password: unknown) => {
    if (typeof username !== 'string' || username.length < 2 || username.length > 20) {
      throw new Error('Username must be between 2 and 20 characters');
    }
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
  },
  hashPassword: h.hashPassword,
  verifyPassword: h.verifyPassword,
}));

import { internalUsersRouter } from './internal-users.js';

const TOKEN = h.config.internalApiToken;

describe('POST /internal/users (front user provisioning)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.hashPassword.mockResolvedValue('hash');
    h.verifyPassword.mockResolvedValue(true);
    h.billing.getAccount.mockResolvedValue({ id: 'billing-1' });
    h.account.deleteOne.mockResolvedValue({});
    h.user.deleteOne.mockResolvedValue({});
    h.tenant.deleteOne.mockResolvedValue({});

    const app = express();
    app.use(express.json());
    app.use('/internal/users', internalUsersRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: unknown, token = TOKEN) {
    return fetch(`${baseUrl}/internal/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects missing/invalid internal token', async () => {
    const res = await post({ username: 'alice', password: 'secret1' }, '');
    expect(res.status).toBe(401);
  });

  it('validates username/password rules with the original messages', async () => {
    const shortName = await post({ username: 'a', password: 'secret1' });
    expect(shortName.status).toBe(400);
    expect((await shortName.json()).message).toBe('Username must be between 2 and 20 characters');

    const shortPassword = await post({ username: 'alice', password: '123' });
    expect(shortPassword.status).toBe(400);
    expect((await shortPassword.json()).message).toBe('Password must be at least 6 characters');
  });

  it('creates account + user + personal tenant + zero-balance tenant billing account (201)', async () => {
    h.account.findOne.mockResolvedValue(null);
    h.account.create.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'hash' });
    h.user.findOne.mockResolvedValue(null);
    h.user.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      ...doc,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    h.tenant.findById.mockResolvedValue(null);
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => doc);

    const res = await post({ username: 'alice', password: 'secret1' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.account).toEqual({ id: 'acc-1', username: 'alice' });
    expect(body.user.name).toBe('alice');
    expect(body.tenant.name).toBe('alice');
    expect(body.tenant.type).toBe('personal');

    const createdUser = h.user.create.mock.calls[0][0];
    expect(String(createdUser.tenantId)).toBe(String(createdUser._id));
    expect(String(createdUser.accountId)).toBe('acc-1');
    expect(h.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alice', type: 'personal' }),
    );
    expect(h.billing.getAccount).toHaveBeenCalledWith(
      'tenant',
      expect.any(String),
      'alice',
    );
  });

  it('is idempotent by username: fully provisioned user returns 200 without creates', async () => {
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'hash' });
    h.user.findOne.mockResolvedValue({
      _id: 'user-1',
      name: 'alice',
      tenantId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    h.tenant.findById.mockResolvedValue({ _id: 'user-1', name: 'alice', type: 'personal' });

    const res = await post({ username: 'alice', password: 'secret1' });
    expect(res.status).toBe(200);
    expect(h.verifyPassword).toHaveBeenCalledWith('secret1', 'hash');
    expect(h.account.create).not.toHaveBeenCalled();
    expect(h.user.create).not.toHaveBeenCalled();
    expect(h.tenant.create).not.toHaveBeenCalled();
    expect(h.billing.getAccount).toHaveBeenCalled();
  });

  it('returns 409 when the username is taken with a different password', async () => {
    h.account.findOne.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'other-hash' });
    h.verifyPassword.mockResolvedValue(false);

    const res = await post({ username: 'alice', password: 'new-secret' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'USERNAME_TAKEN' });
    expect(h.user.create).not.toHaveBeenCalled();
    expect(h.billing.getAccount).not.toHaveBeenCalled();
  });

  it('returns 409 USERNAME_TAKEN on unique conflict', async () => {
    h.account.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    h.account.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const res = await post({ username: 'alice', password: 'secret1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'USERNAME_TAKEN' });
  });

  it('rolls back newly created documents when billing is unavailable', async () => {
    h.account.findOne.mockResolvedValue(null);
    h.account.create.mockResolvedValue({ _id: 'acc-1', username: 'alice', passwordHash: 'hash' });
    h.user.findOne.mockResolvedValue(null);
    h.user.create.mockImplementation(async (doc: Record<string, unknown>) => doc);
    h.tenant.findById.mockResolvedValue(null);
    h.tenant.create.mockImplementation(async (doc: Record<string, unknown>) => doc);
    h.billing.getAccount.mockRejectedValue(new Error('billing down'));

    const res = await post({ username: 'alice', password: 'secret1' });
    expect(res.status).toBe(503);
    expect(h.account.deleteOne).toHaveBeenCalled();
    expect(h.user.deleteOne).toHaveBeenCalled();
    expect(h.tenant.deleteOne).toHaveBeenCalled();
  });
});
