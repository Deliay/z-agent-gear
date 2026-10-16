import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AdminUser } from '../models/admin-user.js';
import { config } from '../config/index.js';
import {
  seedAdmin,
  login,
  changePassword,
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  generateInitialAdminPassword,
} from './auth';

vi.mock('../models/admin-user.js');

const LEGACY_DEFAULT_PASSWORD = 'admin1234567';
const STRONG_PASSWORD = 'ConfiguredStrongPass123';

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('seedAdmin', () => {
    const originalInitialPassword = config.initialAdminPassword;
    afterEach(() => {
      config.initialAdminPassword = originalInitialPassword;
    });

    it('T-A1: is idempotent and skips seeding when admin_users is not empty', async () => {
      (AdminUser.countDocuments as any).mockResolvedValue(3);

      await seedAdmin();

      expect(AdminUser.create).not.toHaveBeenCalled();
    });

    it('T-A1: creates admin from the configured password, never the public default', async () => {
      config.initialAdminPassword = STRONG_PASSWORD;
      (AdminUser.countDocuments as any).mockResolvedValue(0);
      const create = vi.fn().mockResolvedValue({});
      (AdminUser.create as any) = create;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await seedAdmin();

      expect(create).toHaveBeenCalledTimes(1);
      const arg = create.mock.calls[0][0];
      expect(arg.username).toBe('admin');
      expect(arg.mustChangePassword).toBe(true);
      expect(arg.passwordChangedAt).toBeInstanceOf(Date);
      expect(await verifyPassword(STRONG_PASSWORD, arg.passwordHash)).toBe(true);
      // 硬编码默认口令已移除（问题 4）
      expect(await verifyPassword(LEGACY_DEFAULT_PASSWORD, arg.passwordHash)).toBe(false);

      // 问题 47：来自 env 的初始口令也必须一次性输出，运维可获取
      const banner = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(banner).toContain('初始密码');
      expect(banner).toContain(STRONG_PASSWORD);
      logSpy.mockRestore();
    });

    it('T-A1 (问题 4): generates a random password and prints it once when unset', async () => {
      config.initialAdminPassword = '';
      (AdminUser.countDocuments as any).mockResolvedValue(0);
      const create = vi.fn().mockResolvedValue({});
      (AdminUser.create as any) = create;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await seedAdmin();

      const arg = create.mock.calls[0][0];
      expect(arg.mustChangePassword).toBe(true);
      expect(await verifyPassword(LEGACY_DEFAULT_PASSWORD, arg.passwordHash)).toBe(false);

      const banner = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(banner).toContain('ADMIN_INITIAL_PASSWORD');
      expect(banner).toContain('初始密码');
      logSpy.mockRestore();
    });
  });

  describe('password generation', () => {
    it('generates a strong random password (enough entropy, not the legacy default)', () => {
      const a = generateInitialAdminPassword();
      const b = generateInitialAdminPassword();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(20);
      expect(a).not.toBe(LEGACY_DEFAULT_PASSWORD);
    });
  });

  describe('login', () => {
    it('T-A2: returns admin for valid credentials', async () => {
      const passwordHash = await hashPassword('admin1234567');
      (AdminUser.findOne as any).mockResolvedValue({
        _id: { toString: () => 'admin-1' },
        username: 'admin',
        passwordHash,
        mustChangePassword: true,
      });

      const admin = await login('admin', 'admin1234567');

      expect(admin.username).toBe('admin');
      expect(admin.mustChangePassword).toBe(true);
    });

    it('T-A3: rejects unknown username', async () => {
      (AdminUser.findOne as any).mockResolvedValue(null);

      await expect(login('ghost', 'whatever')).rejects.toThrow('Invalid username or password');
    });

    it('T-A3 (问题 7): still runs a bcrypt compare for unknown users to equalize timing', async () => {
      (AdminUser.findOne as any).mockResolvedValue(null);
      const compareSpy = vi.spyOn(bcrypt, 'compare');

      await expect(login('ghost', 'whatever')).rejects.toThrow('Invalid username or password');

      // 帐号不存在也必须执行一次 compare，抹平计时侧信道
      expect(compareSpy).toHaveBeenCalledTimes(1);
      compareSpy.mockRestore();
    });

    it('T-A3: rejects wrong password with the same message', async () => {
      const passwordHash = await hashPassword('admin1234567');
      (AdminUser.findOne as any).mockResolvedValue({
        _id: { toString: () => 'admin-1' },
        username: 'admin',
        passwordHash,
        mustChangePassword: true,
      });

      await expect(login('admin', 'wrong-password')).rejects.toThrow('Invalid username or password');
    });
  });

  describe('changePassword', () => {
    it('T-A5: rejects new password shorter than 10 characters', async () => {
      await expect(changePassword('admin-1', 'admin1234567', 'short')).rejects.toThrow(
        'Password must be at least 10 characters',
      );
    });

    it('rejects a known weak/default new password (问题 26)', async () => {
      const oldHash = await hashPassword(STRONG_PASSWORD);
      (AdminUser.findById as any).mockResolvedValue({
        _id: { toString: () => 'admin-1' },
        passwordHash: oldHash,
        mustChangePassword: false,
        save: vi.fn(),
      });

      await expect(changePassword('admin-1', STRONG_PASSWORD, 'admin1234567')).rejects.toThrow('Password is too weak');
    });

    it('T-A5: rejects invalid old password and does not save', async () => {
      const passwordHash = await hashPassword('admin1234567');
      const doc = {
        _id: { toString: () => 'admin-1' },
        passwordHash,
        mustChangePassword: true,
        save: vi.fn(),
      };
      (AdminUser.findById as any).mockResolvedValue(doc);

      await expect(changePassword('admin-1', 'wrong-old', 'newpassword123')).rejects.toThrow(
        'Invalid old password',
      );
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('rejects a new password identical to the old one (问题 26)', async () => {
      const oldHash = await hashPassword(STRONG_PASSWORD);
      const doc = {
        _id: { toString: () => 'admin-1' },
        passwordHash: oldHash,
        mustChangePassword: true,
        save: vi.fn(),
      };
      (AdminUser.findById as any).mockResolvedValue(doc);

      await expect(changePassword('admin-1', STRONG_PASSWORD, STRONG_PASSWORD)).rejects.toThrow(
        'New password must be different from the old password',
      );
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('T-A4 (问题 6): updates password, stamps passwordChangedAt and returns document', async () => {
      const oldHash = await hashPassword('admin1234567');
      const doc = {
        _id: { toString: () => 'admin-1' },
        username: 'admin',
        passwordHash: oldHash,
        mustChangePassword: true,
        passwordChangedAt: null as Date | null,
        save: vi.fn().mockResolvedValue(undefined),
      };
      (AdminUser.findById as any).mockResolvedValue(doc);

      const result = await changePassword('admin-1', 'admin1234567', 'newpassword123');

      expect(result.mustChangePassword).toBe(false);
      expect(doc.passwordHash).not.toBe(oldHash);
      expect(await verifyPassword('newpassword123', doc.passwordHash)).toBe(true);
      expect(doc.passwordChangedAt).toBeInstanceOf(Date);
      expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('rejects when admin does not exist', async () => {
      (AdminUser.findById as any).mockResolvedValue(null);
      await expect(changePassword('missing', 'old-password', 'newpassword123')).rejects.toThrow('Admin not found');
    });
  });

  describe('tokens', () => {
    it('T-A2/T-A4: signs and verifies an admin token', () => {
      const token = signToken('admin-1');
      expect(verifyToken(token)).toMatchObject({ adminId: 'admin-1' });
    });

    it('T-A4 (问题 6): embeds passwordChangedAt so post-change tokens can be told apart', () => {
      const changedAt = new Date('2026-01-02T03:04:05.000Z');
      const token = signToken('admin-1', changedAt);
      expect(verifyToken(token)).toMatchObject({ adminId: 'admin-1', pwdAt: changedAt.getTime() });
    });

    it('T-A6: rejects a user-side token signed with the user secret', () => {
      const userToken = jwt.sign({ userId: 'u1' }, 'dev-secret-change-in-production', { expiresIn: '7d' });
      expect(() => verifyToken(userToken)).toThrow();
    });

    it('T-A6: rejects a forged token', () => {
      expect(() => verifyToken('not-a-token')).toThrow();
    });
  });
});
