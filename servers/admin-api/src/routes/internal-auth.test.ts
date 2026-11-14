import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'internal-token-123456' },
  adminUser: { findById: vi.fn() },
  provider: { findById: vi.fn() },
  binding: { findBound: vi.fn(), bind: vi.fn() },
  tickets: { consumeBindTicket: vi.fn(), issueLoginTicket: vi.fn() },
  signToken: vi.fn(() => 'jwt-1'),
}));

vi.mock('../config/index.js', () => ({ config: h.config }));
vi.mock('../models/admin-user.js', () => ({ AdminUser: h.adminUser }));
vi.mock('../models/auth-provider.js', () => ({ AuthProvider: h.provider }));
vi.mock('../services/admin-external-login.js', () => ({ adminExternalLoginService: h.binding }));
vi.mock('../services/auth-ticket.js', () => ({
  consumeBindTicket: h.tickets.consumeBindTicket,
  issueLoginTicket: h.tickets.issueLoginTicket,
}));
vi.mock('../services/auth.js', () => ({ signToken: h.signToken }));

import { internalAuthRouter } from './internal-auth.js';

const ADMIN_ID = '507f1f77bcf86cd799439011';
const PROVIDER_ID = '507f1f77bcf86cd799439012';
const IDENTITY = {
  providerId: PROVIDER_ID,
  issuer: 'http://idp',
  subject: 'sub-1',
  profile: { externalUsername: 'octo' },
};

describe('routes/internal-auth（T-IA-AUTH）', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    app.use('/internal/auth', internalAuthRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, body: unknown, token: string | null = h.config.internalApiToken) {
    return fetch(`${baseUrl}/internal/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('T-IA-AUTH1: 未配置/缺失/错误 token 一律 401', async () => {
    expect((await post('/admin-tickets', IDENTITY, null)).status).toBe(401);
    expect((await post('/admin-tickets', IDENTITY, 'wrong')).status).toBe(401);
    h.config.internalApiToken = '';
    expect((await post('/admin-tickets', IDENTITY, '')).status).toBe(401);
    h.config.internalApiToken = 'internal-token-123456';
  });

  it('T-IA-AUTH2: 非法请求体 → 400', async () => {
    const res = await post('/admin-tickets', { providerId: PROVIDER_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'INVALID_BODY' });
  });

  it('T-IA-AUTH3: 未绑定 → 403 NOT_BOUND', async () => {
    h.binding.findBound.mockResolvedValue(null);
    const res = await post('/admin-tickets', IDENTITY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_BOUND' });
  });

  it('T-IA-AUTH4: 已绑定 → 签发 admin JWT 并返回一次性 ticket', async () => {
    h.binding.findBound.mockResolvedValue({ adminUserId: ADMIN_ID });
    h.adminUser.findById.mockReturnValue({
      lean: async () => ({
        _id: ADMIN_ID,
        username: 'admin',
        mustChangePassword: false,
        passwordChangedAt: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }),
    });
    h.tickets.issueLoginTicket.mockResolvedValue('ticket-1');

    const res = await post('/admin-tickets', IDENTITY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: 'ticket-1' });
    expect(h.signToken).toHaveBeenCalledWith(ADMIN_ID, null);
    expect(h.tickets.issueLoginTicket).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'jwt-1', admin: expect.objectContaining({ username: 'admin' }) }),
    );
  });

  it('T-IA-AUTH5: 绑定缺票据 → 400 INVALID_BODY', async () => {
    const res = await post('/admin-bind', { ...IDENTITY });
    expect(res.status).toBe(400);
  });

  it('T-IA-AUTH6: 绑定票据无效/provider 不匹配 → 400 INVALID_BIND_TICKET', async () => {
    h.tickets.consumeBindTicket.mockResolvedValue(null);
    let res = await post('/admin-bind', { ...IDENTITY, bindTicket: 'b1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'INVALID_BIND_TICKET' });

    h.tickets.consumeBindTicket.mockResolvedValue({ adminUserId: ADMIN_ID, providerId: 'other' });
    res = await post('/admin-bind', { ...IDENTITY, bindTicket: 'b1' });
    expect(res.status).toBe(400);
  });

  it('T-IA-AUTH7: provider 未启用 → 400 INVALID_BIND_TICKET', async () => {
    h.tickets.consumeBindTicket.mockResolvedValue({ adminUserId: ADMIN_ID, providerId: PROVIDER_ID });
    h.provider.findById.mockReturnValue({ lean: async () => ({ enabled: false }) });
    const res = await post('/admin-bind', { ...IDENTITY, bindTicket: 'b1' });
    expect(res.status).toBe(400);
  });

  it('T-IA-AUTH8: 绑定成功 → 200；身份已绑他人 → 409', async () => {
    h.tickets.consumeBindTicket.mockResolvedValue({ adminUserId: ADMIN_ID, providerId: PROVIDER_ID });
    h.provider.findById.mockReturnValue({ lean: async () => ({ enabled: true }) });
    h.binding.bind.mockResolvedValue({ _id: 'b1' });

    let res = await post('/admin-bind', { ...IDENTITY, bindTicket: 'b1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.binding.bind).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({ subject: 'sub-1' }));

    h.tickets.consumeBindTicket.mockResolvedValue({ adminUserId: ADMIN_ID, providerId: PROVIDER_ID });
    h.binding.bind.mockRejectedValue(new Error('EXTERNAL_IDENTITY_ALREADY_BOUND'));
    res = await post('/admin-bind', { ...IDENTITY, bindTicket: 'b1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ALREADY_BOUND' });
  });
});
