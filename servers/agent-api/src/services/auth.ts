import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const SALT_ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '7d' });
}

/**
 * 用户名/密码规则单一来源（原 signup 规则逐字）：
 * 用户名 2-20 字符、密码至少 6 字符。`/internal/users` 开户复用本函数。
 */
export function assertUsernamePasswordRules(username: unknown, password: unknown): void {
  if (typeof username !== 'string' || username.length < 2 || username.length > 20) {
    throw new Error('Username must be between 2 and 20 characters');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, config.jwtSecret) as { userId: string };
}
