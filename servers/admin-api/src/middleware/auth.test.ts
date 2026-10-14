import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminUser } from '../models/admin-user.js';
import { verifyToken } from '../services/auth.js';
import { authenticateAdmin } from './auth';

vi.mock('../models/admin-user.js');
vi.mock('../services/auth.js', () => ({
  verifyToken: vi.fn(),
}));

function requestWith(header?: string): Request {
  return new Request('http://localhost/graphql', {
    headers: header ? { authorization: header } : {},
  });
}

describe('authenticateAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-A6: returns null without an Authorization header', async () => {
    expect(await authenticateAdmin(requestWith())).toBeNull();
  });

  it('T-A6: returns null for a non-Bearer scheme', async () => {
    expect(await authenticateAdmin(requestWith('Basic abc'))).toBeNull();
  });

  it('T-A6: returns null for an empty Bearer token', async () => {
    expect(await authenticateAdmin(requestWith('Bearer '))).toBeNull();
  });

  it('T-A6: returns null when token verification throws (forged or user token)', async () => {
    (verifyToken as any).mockImplementation(() => {
      throw new Error('invalid token');
    });

    expect(await authenticateAdmin(requestWith('Bearer forged'))).toBeNull();
  });

  it('returns the admin profile for a valid token', async () => {
    (verifyToken as any).mockReturnValue({ adminId: 'admin-1' });
    const select = vi.fn().mockResolvedValue({
      _id: { toString: () => 'admin-1' },
      username: 'admin',
      mustChangePassword: false,
    });
    (AdminUser.findById as any).mockReturnValue({ select });

    const result = await authenticateAdmin(requestWith('Bearer valid'));

    expect(verifyToken).toHaveBeenCalledWith('valid');
    expect(AdminUser.findById).toHaveBeenCalledWith('admin-1');
    expect(select).toHaveBeenCalledWith('username mustChangePassword');
    expect(result).toEqual({ id: 'admin-1', username: 'admin', mustChangePassword: false });
  });

  it('returns null when the admin no longer exists', async () => {
    (verifyToken as any).mockReturnValue({ adminId: 'ghost' });
    (AdminUser.findById as any).mockReturnValue({ select: vi.fn().mockResolvedValue(null) });

    expect(await authenticateAdmin(requestWith('Bearer valid'))).toBeNull();
  });
});
