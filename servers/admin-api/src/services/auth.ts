import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AdminUser } from '../models/admin-user.js';

const SALT_ROUNDS = 10;
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin1234567';
const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(adminId: string): string {
  return jwt.sign({ adminId }, config.adminJwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): { adminId: string } {
  return jwt.verify(token, config.adminJwtSecret) as { adminId: string };
}

/**
 * 幂等种子：admin_users 非空则跳过，否则插入默认管理员。
 */
export async function seedAdmin(): Promise<void> {
  const count = await AdminUser.countDocuments();
  if (count > 0) return;

  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  await AdminUser.create({
    username: DEFAULT_ADMIN_USERNAME,
    passwordHash,
    mustChangePassword: true,
  });
}

export async function login(username: string, password: string) {
  const admin = await AdminUser.findOne({ username });
  // 不区分「帐号不存在」与「密码错误」，避免泄露帐号存在性
  if (!admin) {
    throw new Error('Invalid username or password');
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    throw new Error('Invalid username or password');
  }

  return admin;
}

export async function changePassword(adminId: string, oldPassword: string, newPassword: string) {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error('Password must be at least 10 characters');
  }

  const admin = await AdminUser.findById(adminId);
  if (!admin) {
    throw new Error('Admin not found');
  }

  const valid = await verifyPassword(oldPassword, admin.passwordHash);
  if (!valid) {
    throw new Error('Invalid old password');
  }

  admin.passwordHash = await hashPassword(newPassword);
  admin.mustChangePassword = false;
  await admin.save();

  return admin;
}
