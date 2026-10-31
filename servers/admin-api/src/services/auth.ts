import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config, ADMIN_USERNAME, MIN_PASSWORD_LENGTH, isWeakAdminPassword } from '../config/index.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { AdminUser } from '../models/admin-user.js';

const SALT_ROUNDS = 10;

const logger = rootLogger.child({ component: 'auth' });

/**
 * 帐号不存在时的恒定时间对照哈希（问题 7）。
 * `login()` 对不存在的用户也执行一次 `bcrypt.compare(password, DUMMY_PASSWORD_HASH)`，
 * 抹平「帐号存在（走真实 bcrypt.compare）vs 不存在（立即抛错）」的百毫秒级计时侧信道。
 */
export const DUMMY_PASSWORD_HASH = '$2b$10$JJ0AlZ0meqiqL1CAA7X3uumt9SC7wtHYZO1Kiu5ZFs/JSW3jl0sBa';

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface AdminTokenPayload {
  adminId: string;
  /** 签发时刻管理员的 passwordChangedAt（ms epoch）；0 表示从未改密。用于改密后使旧 token 失效。 */
  pwdAt: number;
}

export function signToken(adminId: string, passwordChangedAt: Date | null = null): string {
  const pwdAt = passwordChangedAt ? new Date(passwordChangedAt).getTime() : 0;
  return jwt.sign({ adminId, pwdAt }, config.adminJwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): AdminTokenPayload {
  return jwt.verify(token, config.adminJwtSecret) as AdminTokenPayload;
}

/** 生成强随机初始密码（CSPRNG，base64url 约 24 字符） */
export function generateInitialAdminPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * 幂等种子：admin_users 非空则跳过，否则插入管理员。
 * 初始密码来源（问题 4，已移除硬编码 `admin1234567`）：
 * - 配置了 `ADMIN_INITIAL_PASSWORD`：使用之（启动期 assertRuntimeConfig 已拒绝弱口令）；
 * - 未配置：生成强随机密码。
 * 两种来源均保留 `mustChangePassword: true`，并**每次种子时**一次性输出初始口令（问题 47），
 * 便于编排层注入随机口令后运维仍可获取。
 *
 * ⚠️ 安全提示（建议 J）：`bootstrapAdminPassword` 为 contracts/observability.md §6.2 **唯一审计例外**，
 * 首次 seed 时明文输出**一次**（`msg` 含「审计例外」标记）；其余 `password` 类键一律脱敏。
 * 日志聚合 / 采集系统（ELK、Loki、云日志等）**不得**将该记录持久化为可检索日志；请对 admin-api
 * 的 stdout 做脱敏/直连终端处理，或仅在需要时临时查看容器启动日志。
 */
export async function seedAdmin(log: ObservationLogger = logger): Promise<void> {
  const count = await AdminUser.countDocuments();
  if (count > 0) return;

  const configured = config.initialAdminPassword.trim();
  const generated = configured.length === 0;
  const password = generated ? generateInitialAdminPassword() : configured;

  const passwordHash = await hashPassword(password);
  const created = await AdminUser.create({
    username: ADMIN_USERNAME,
    passwordHash,
    mustChangePassword: true,
    passwordChangedAt: new Date(),
  });
  const userId = String((created as { _id?: unknown })._id ?? '');

  log.info(
    {
      userId,
      username: ADMIN_USERNAME,
      source: generated
        ? '随机生成（未配置 ADMIN_INITIAL_PASSWORD）'
        : 'ADMIN_INITIAL_PASSWORD 环境变量',
      mustChangePassword: true,
    },
    '已种入管理员初始口令（仅本次显示，首次登录强制改密）',
  );
  // 唯一审计例外（contracts/observability.md §6.2）：bootstrapAdminPassword 不脱敏，msg 含「审计例外」。
  log.warn(
    { bootstrapAdminPassword: password, userId },
    '初始管理员密码（仅首次初始化输出一次，请立即修改；审计例外）',
  );
}

export async function login(username: string, password: string) {
  const admin = await AdminUser.findOne({ username });
  // 不区分「帐号不存在」与「密码错误」，且对不存在帐号也执行一次 bcrypt.compare 恒定时间（问题 7）
  if (!admin) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
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
  if (isWeakAdminPassword(newPassword)) {
    throw new Error('Password is too weak');
  }

  const admin = await AdminUser.findById(adminId);
  if (!admin) {
    throw new Error('Admin not found');
  }

  const valid = await verifyPassword(oldPassword, admin.passwordHash);
  if (!valid) {
    throw new Error('Invalid old password');
  }

  if (oldPassword === newPassword) {
    throw new Error('New password must be different from the old password');
  }

  admin.passwordHash = await hashPassword(newPassword);
  admin.mustChangePassword = false;
  // 记录改密时间：签发时间早于该值的旧 token 将在 authenticateAdmin 中被拒绝（问题 6）
  admin.passwordChangedAt = new Date();
  await admin.save();

  return admin;
}
