import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  redis: {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(),
    del: vi.fn(),
    getdel: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({ getRedisClient: () => h.redis }));

import {
  bumpPendingFailCount,
  consumeFrontBindTicket,
  consumeLoginTicket,
  consumePendingIdentity,
  consumeState,
  FRONT_BIND_TICKET_TTL_SECONDS,
  frontBindTicketKey,
  getPendingIdentity,
  issueFrontBindTicket,
  issueLoginTicket,
  issuePendingIdentity,
  issueState,
  OAUTH_STATE_TTL_SECONDS,
  PENDING_IDENTITY_TTL_SECONDS,
  pendingKey,
  randomToken,
} from './oauth-flow.js';

describe('oauth-flow（T-FLOW）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-FLOW1: state 写入 600s 且 GETDEL 一次性消费', async () => {
    const payload = { providerId: 'p1', surface: 'front' as const, nonce: 'n1' };
    h.redis.getdel.mockResolvedValueOnce(JSON.stringify(payload));

    const state = await issueState(payload);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(h.redis.set).toHaveBeenCalledWith(
      `oauth:state:${state}`,
      JSON.stringify(payload),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    await expect(consumeState(state)).resolves.toEqual(payload);
    h.redis.getdel.mockResolvedValueOnce(null);
    await expect(consumeState(state)).resolves.toBeNull();
  });

  it('T-FLOW2: 过期/重放 state 返回 null', async () => {
    h.redis.getdel.mockResolvedValue(null);
    await expect(consumeState('missing')).resolves.toBeNull();
    await expect(consumeState('')).resolves.toBeNull();
    expect(h.redis.getdel).toHaveBeenCalledTimes(1);
  });

  it('T-FLOW3: 损坏 JSON 视为无效 state', async () => {
    h.redis.getdel.mockResolvedValue('{not-json');
    await expect(consumeState('bad')).resolves.toBeNull();
  });

  it('T-FLOW4: ticket 60s TTL 且一次性消费', async () => {
    h.redis.getdel.mockResolvedValueOnce(JSON.stringify({ token: 'jwt', user: { id: 'u1' } }));
    const ticket = await issueLoginTicket({ token: 'jwt', user: { id: 'u1' } });
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(h.redis.set).toHaveBeenCalledWith(
      `oauth:ticket:${ticket}`,
      JSON.stringify({ token: 'jwt', user: { id: 'u1' } }),
      'EX',
      60,
    );
    await expect(consumeLoginTicket(ticket)).resolves.toEqual({
      token: 'jwt',
      user: { id: 'u1' },
    });
  });

  it('T-FLOW5: 不存在/损坏 ticket 返回 null', async () => {
    h.redis.getdel.mockResolvedValueOnce(null).mockResolvedValueOnce('{bad');
    await expect(consumeLoginTicket('missing')).resolves.toBeNull();
    await expect(consumeLoginTicket('bad')).resolves.toBeNull();
  });

  it('randomToken 为 32 字节随机 hex', () => {
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

const IDENTITY = {
  providerId: 'p1',
  issuer: 'http://idp',
  subject: 'sub-1',
  externalUsername: 'octo',
  displayName: 'Octo',
  avatarUrl: null,
};

describe('oauth-flow pending 身份凭证（T-PEND）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.redis.set.mockResolvedValue('OK');
  });

  it('T-PEND1: 签发 600s 且载荷含 failCount=0', async () => {
    const token = await issuePendingIdentity(IDENTITY);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(h.redis.set).toHaveBeenCalledWith(
      pendingKey(token),
      JSON.stringify({ ...IDENTITY, failCount: 0 }),
      'EX',
      PENDING_IDENTITY_TTL_SECONDS,
    );
  });

  it('T-PEND2: get 不消费（仅 GET）', async () => {
    h.redis.get.mockResolvedValue(JSON.stringify({ ...IDENTITY, failCount: 0 }));
    await expect(getPendingIdentity('t1')).resolves.toMatchObject({ subject: 'sub-1' });
    expect(h.redis.getdel).not.toHaveBeenCalled();
  });

  it('T-PEND3: consume 一次性 GETDEL', async () => {
    h.redis.getdel.mockResolvedValue(JSON.stringify({ ...IDENTITY, failCount: 0 }));
    await expect(consumePendingIdentity('t1')).resolves.toMatchObject({ subject: 'sub-1' });
    expect(h.redis.getdel).toHaveBeenCalledWith(pendingKey('t1'));
  });

  it('T-PEND4: 验密失败计次使用 SET KEEPTTL', async () => {
    h.redis.get.mockResolvedValue(JSON.stringify({ ...IDENTITY, failCount: 1 }));
    const next = await bumpPendingFailCount('t1');
    expect(next?.failCount).toBe(2);
    expect(h.redis.set).toHaveBeenCalledWith(
      pendingKey('t1'),
      expect.stringContaining('"failCount":2'),
      'KEEPTTL',
    );
    expect(h.redis.del).not.toHaveBeenCalled();
  });

  it('T-PEND5: 第 5 次失败作废（DEL）', async () => {
    h.redis.get.mockResolvedValue(JSON.stringify({ ...IDENTITY, failCount: 4 }));
    await expect(bumpPendingFailCount('t1')).resolves.toBeNull();
    expect(h.redis.del).toHaveBeenCalledWith(pendingKey('t1'));
    expect(h.redis.set).not.toHaveBeenCalled();
  });

  it('T-PEND6: 不存在/损坏载荷返回 null', async () => {
    h.redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce('{bad');
    await expect(getPendingIdentity('x')).resolves.toBeNull();
    await expect(bumpPendingFailCount('x')).resolves.toBeNull();
    await expect(getPendingIdentity('')).resolves.toBeNull();
  });
});

describe('oauth-flow 前台绑定票据（T-FBT）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-FBT1: 签发 600s 且消费一次性', async () => {
    const ticket = await issueFrontBindTicket({ userId: 'u1', providerId: 'p1' });
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(h.redis.set).toHaveBeenCalledWith(
      frontBindTicketKey(ticket),
      JSON.stringify({ userId: 'u1', providerId: 'p1' }),
      'EX',
      FRONT_BIND_TICKET_TTL_SECONDS,
    );
    h.redis.getdel.mockResolvedValue(
      JSON.stringify({ userId: 'u1', providerId: 'p1' }),
    );
    await expect(consumeFrontBindTicket(ticket)).resolves.toEqual({
      userId: 'u1',
      providerId: 'p1',
    });
  });

  it('T-FBT2: 过期/损坏返回 null', async () => {
    h.redis.getdel.mockResolvedValueOnce(null).mockResolvedValueOnce('{bad');
    await expect(consumeFrontBindTicket('missing')).resolves.toBeNull();
    await expect(consumeFrontBindTicket('bad')).resolves.toBeNull();
    await expect(consumeFrontBindTicket('')).resolves.toBeNull();
  });
});
