import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../models/user.js', () => ({
  User: {
    findById: vi.fn(),
  },
}));

import { verifyToken } from '../services/auth.js';
import { User } from '../models/user.js';
import { authenticateExpressUser } from './gateway-proxy.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  } as any;
}

describe('authenticateExpressUser', () => {
  it('should authenticate via Authorization header', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'user1' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'user1' }, username: 'testuser' }),
    } as never);

    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toEqual({ id: 'user1', username: 'testuser' });
    expect(verifyToken).toHaveBeenCalledWith('valid-jwt');
  });

  it('should authenticate via Cookie token', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'user2' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'user2' }, username: 'cookieuser' }),
    } as never);

    const req = mockReq({ cookies: { token: 'cookie-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toEqual({ id: 'user2', username: 'cookieuser' });
    expect(verifyToken).toHaveBeenCalledWith('cookie-jwt');
  });

  it('should prefer header over cookie when both present', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'header-user' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'header-user' }, username: 'header' }),
    } as never);

    const req = mockReq({
      headers: { authorization: 'Bearer header-jwt' },
      cookies: { token: 'cookie-jwt' },
    });
    const result = await authenticateExpressUser(req);

    expect(result?.id).toBe('header-user');
    expect(verifyToken).toHaveBeenCalledWith('header-jwt');
  });

  it('should return null when neither header nor cookie provided', async () => {
    const req = mockReq();
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('should return null when Authorization header is not Bearer format', async () => {
    const req = mockReq({ headers: { authorization: 'Basic somecreds' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('should return null when token is invalid', async () => {
    vi.mocked(verifyToken).mockImplementation(() => { throw new Error('jwt malformed'); });

    const req = mockReq({ headers: { authorization: 'Bearer bad-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
  });

  it('should return null when user not found', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'nonexistent' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue(null),
    } as never);

    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
  });
});
