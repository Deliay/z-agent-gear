import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { AdminUser } from '../models/admin-user.js';
import {
  seedAdmin,
  login,
  changePassword,
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
} from './auth';

vi.mock('../models/admin-user.js');

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('seedAdmin', () => {
    it('T-A1: is idempotent and skips seeding when admin_users is not empty', async () => {
      (AdminUser.countDocuments as any).mockResolvedValue(3);

      await seedAdmin();

      expect(AdminUser.create).not.toHaveBeenCalled();
    });

    it('T-A1: creates default admin with hashed password and mustChangePassword=true when empty', async () => {
      (AdminUser.countDocuments as any).mockResolvedValue(0);
      const create = vi.fn().mockResolvedValue({});
      (AdminUser.create as any) = create;

      await seedAdmin();

      expect(create).toHaveBeenCalledTimes(1);
      const arg = create.mock.calls[0][0];
      expect(arg.username).toBe('admin');
      expect(arg.mustChangePassword).toBe(true);
      expect(arg.passwordHash).not.toBe('admin1234567');
      expect(await verifyPassword('admin1234567', arg.passwordHash)).toBe(true);
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

    it('T-A4: updates password, clears mustChangePassword and returns document', async () => {
      const oldHash = await hashPassword('admin1234567');
      const doc = {
        _id: { toString: () => 'admin-1' },
        username: 'admin',
        passwordHash: oldHash,
        mustChangePassword: true,
        save: vi.fn().mockResolvedValue(undefined),
      };
      (AdminUser.findById as any).mockResolvedValue(doc);

      const result = await changePassword('admin-1', 'admin1234567', 'newpassword123');

      expect(result.mustChangePassword).toBe(false);
      expect(doc.passwordHash).not.toBe(oldHash);
      expect(await verifyPassword('newpassword123', doc.passwordHash)).toBe(true);
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

    it('T-A6: rejects a user-side token signed with the user secret', () => {
      const userToken = jwt.sign({ userId: 'u1' }, 'dev-secret-change-in-production', { expiresIn: '7d' });
      expect(() => verifyToken(userToken)).toThrow();
    });

    it('T-A6: rejects a forged token', () => {
      expect(() => verifyToken('not-a-token')).toThrow();
    });
  });
});
