import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authResolvers } from './auth';

vi.mock('../../services/auth.js', () => ({
  login: vi.fn(),
  changePassword: vi.fn(),
  signToken: vi.fn(() => 'signed-token'),
}));

vi.mock('../../models/admin-user.js', () => ({
  AdminUser: { findById: vi.fn() },
}));

import { login, changePassword, signToken } from '../../services/auth.js';
import { AdminUser } from '../../models/admin-user.js';
import { loginRateLimiter } from '../../services/login-rate-limiter.js';
import type { AdminAuthContext } from './auth.js';

function adminDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'admin-1' },
    username: 'admin',
    mustChangePassword: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

const good: AdminAuthContext = { currentAdmin: { id: 'admin-1', username: 'admin', mustChangePassword: false } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = authResolvers.Query as any;
const Mutation = authResolvers.Mutation as any;

describe('authResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginRateLimiter.reset();
  });

  describe('adminMe', () => {
    it('returns null when unauthenticated', async () => {
      await expect(Query.adminMe({}, {}, anon)).resolves.toBeNull();
    });

    it('returns the full admin record when authenticated (whitelisted even while locked)', async () => {
      (AdminUser.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(adminDoc()) });

      const result = await Query.adminMe({}, {}, { currentAdmin: { id: 'admin-1', username: 'admin', mustChangePassword: true } });

      expect(result).toEqual({
        id: 'admin-1',
        username: 'admin',
        mustChangePassword: true,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date('2026-01-02').toISOString(),
      });
    });

    it('returns null when the admin does not exist', async () => {
      (AdminUser.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      await expect(Query.adminMe({}, {}, good)).resolves.toBeNull();
    });
  });

  describe('adminLogin', () => {
    it('returns token and mapped admin', async () => {
      (login as any).mockResolvedValue(adminDoc());

      const result = await Mutation.adminLogin({}, { username: 'admin', password: 'admin1234567' });

      expect(login).toHaveBeenCalledWith('admin', 'admin1234567');
      expect(signToken).toHaveBeenCalledWith('admin-1', null);
      expect(result.token).toBe('signed-token');
      expect(result.admin.mustChangePassword).toBe(true);
    });

    it('maps service errors to GraphQL errors', async () => {
      (login as any).mockRejectedValue(new Error('Invalid username or password'));
      await expect(Mutation.adminLogin({}, { username: 'admin', password: 'bad' })).rejects.toThrow(
        'Invalid username or password',
      );
    });

    it('T-A7 (问题 7): rejects with TOO_MANY_REQUESTS after repeated failures from the same ip+username', async () => {
      (login as any).mockRejectedValue(new Error('Invalid username or password'));
      const context: AdminAuthContext = { currentAdmin: null, clientIp: '203.0.113.7' };

      // 默认阈值 5 次失败后锁定
      for (let i = 0; i < 5; i += 1) {
        await expect(
          Mutation.adminLogin({}, { username: 'admin', password: 'bad' }, context),
        ).rejects.toThrow('Invalid username or password');
      }

      let captured: any;
      try {
        await Mutation.adminLogin({}, { username: 'admin', password: 'bad' }, context);
      } catch (err) {
        captured = err;
      }
      expect(captured?.extensions?.code).toBe('TOO_MANY_REQUESTS');
      // 被限速后不再调用 login（避免继续做 bcrypt 消耗）
      expect(login).toHaveBeenCalledTimes(5);
    });

    it('T-A7 (问题 7): a different username is not affected by another username lockout', async () => {
      (login as any).mockRejectedValue(new Error('Invalid username or password'));
      const locked: AdminAuthContext = { currentAdmin: null, clientIp: '203.0.113.7' };
      for (let i = 0; i < 6; i += 1) {
        await Mutation.adminLogin({}, { username: 'admin', password: 'bad' }, locked).catch(() => {});
      }

      (login as any).mockResolvedValue(adminDoc());
      const other: AdminAuthContext = { currentAdmin: null, clientIp: '203.0.113.7' };
      await expect(
        Mutation.adminLogin({}, { username: 'other', password: 'whatever' }, other),
      ).resolves.toMatchObject({ token: 'signed-token' });
    });
  });

  describe('changeAdminPassword', () => {
    it('requires authentication', async () => {
      await expect(
        Mutation.changeAdminPassword({}, { oldPassword: 'a', newPassword: 'newpassword123' }, anon),
      ).rejects.toThrow('Not authenticated');
    });

    it('returns a fresh token and clears mustChangePassword', async () => {
      (changePassword as any).mockResolvedValue(adminDoc({ mustChangePassword: false }));

      const result = await Mutation.changeAdminPassword(
        {},
        { oldPassword: 'admin1234567', newPassword: 'newpassword123' },
        good,
      );

      expect(changePassword).toHaveBeenCalledWith('admin-1', 'admin1234567', 'newpassword123');
      expect(result.token).toBe('signed-token');
      expect(result.admin.mustChangePassword).toBe(false);
    });

    it('maps service errors', async () => {
      (changePassword as any).mockRejectedValue(new Error('Invalid old password'));
      await expect(
        Mutation.changeAdminPassword({}, { oldPassword: 'bad', newPassword: 'newpassword123' }, good),
      ).rejects.toThrow('Invalid old password');
    });
  });
});
