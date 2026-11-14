import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  redis: {
    set: vi.fn(async () => 'OK'),
    getdel: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({ getRedisClient: () => h.redis }));

import {
  consumeLoginTicket,
  consumeState,
  issueLoginTicket,
  issueState,
  OAUTH_STATE_TTL_SECONDS,
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
