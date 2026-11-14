import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Account } from '../models/account.js';
import { ExternalLogin } from '../models/external-login.js';
import { User } from '../models/user.js';
import { hashPassword } from './auth.js';
import { getRedisClient } from '../middleware/redis.js';
import { provisionUser, ProvisioningError } from './provisioning.js';

export type ExternalLoginErrorCode =
  | 'IDENTITY_ALREADY_BOUND'
  | 'PROVIDER_ALREADY_BOUND'
  | 'EXTERNAL_LOGIN_NOT_FOUND'
  | 'CANNOT_UNBIND_LAST_LOGIN_METHOD';

export class ExternalLoginError extends Error {
  readonly code: ExternalLoginErrorCode;

  constructor(code: ExternalLoginErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'ExternalLoginError';
  }
}

export interface ExternalIdentityInput {
  providerId: string;
  issuer?: string | null;
  subject: string;
  externalUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface ExternalLoginResult {
  user: { id: string; name: string; tenantId: string; createdAt: string };
  account: { id: string; username: string };
  created: boolean;
}

/** 绑定目标用户（GraphQL 会话已解析出 userId/accountId/tenantId）。 */
export interface BindTargetUser {
  id: string;
  accountId: string;
  tenantId: string;
}

export interface ExternalLoginBindingView {
  id: string;
  userId: string;
  tenantId: string;
  accountId: string;
  providerId: string;
  issuer: string | null;
  subject: string;
  externalUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
}

/**
 * 用户名派生（纯函数）：
 * 过滤 `[a-zA-Z0-9_-]` → 截断 20 → 不足 2 字符补 `u_`。
 */
export function deriveUsername(externalUsername: string): string {
  const filtered = (externalUsername || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (filtered.length >= 2) return filtered.slice(0, 20);
  return `u_${filtered}`.slice(0, 20).padEnd(2, '0');
}

/** 冲突重试的用户名：`{base}-{4 位随机}`，总长 ≤20。 */
function withSuffix(base: string): string {
  const suffix = `-${crypto.randomBytes(2).toString('hex').slice(0, 4)}`;
  return `${base.slice(0, 20 - suffix.length)}${suffix}`;
}

interface UserDoc {
  _id: { toString(): string };
  name?: string | null;
  tenantId?: { toString(): string } | null;
  createdAt?: Date | null;
}

function toUserView(user: UserDoc): ExternalLoginResult['user'] {
  return {
    id: String(user._id),
    name: user.name ?? '',
    tenantId: user.tenantId ? String(user.tenantId) : String(user._id),
    createdAt: (user.createdAt ?? new Date()).toISOString(),
  };
}

const RELEASE_LOCK_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 同一外部身份的并发首登串行化（单实例部署前提）。
 *
 * 仅开户路径保留身份锁；绑定路径由两个唯一索引作为唯一裁决（D8）。
 * 在 Redis 不可用时退化为无锁执行：`externallogins` 唯一索引 + 回滚仍是最终防线。
 */
async function withIdentityLock<T>(
  providerId: string,
  issuer: string | null,
  subject: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `oauth:identity-lock:${providerId}:${issuer ?? ''}:${subject}`;
  const token = crypto.randomBytes(16).toString('hex');
  let locked = false;
  try {
    const redis = getRedisClient();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const ok = await redis.set(key, token, 'PX', 10000, 'NX');
      if (ok === 'OK') {
        locked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    locked = false;
  }

  try {
    return await fn();
  } finally {
    if (locked) {
      try {
        await getRedisClient().eval(RELEASE_LOCK_SCRIPT, 1, key, token);
      } catch {
        // 释放失败仅等 TTL 自动过期
      }
    }
  }
}

async function resultFromExisting(userId: { toString(): string }, accountId: { toString(): string }) {
  const user = (await User.findById(userId).lean()) as UserDoc | null;
  if (!user) {
    throw new ProvisioningError('INTERNAL_ERROR', 'bound user missing');
  }
  const account = (await Account.findById(accountId).lean()) as {
    _id: { toString(): string };
    username: string;
  } | null;
  return {
    user: toUserView(user),
    account: { id: String(account?._id ?? accountId), username: account?.username ?? '' },
    created: false,
  } satisfies ExternalLoginResult;
}

function toBindingView(doc: Record<string, unknown>): ExternalLoginBindingView {
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    tenantId: String(doc.tenantId),
    accountId: String(doc.accountId),
    providerId: String(doc.providerId),
    issuer: (doc.issuer as string | null) ?? null,
    subject: String(doc.subject),
    externalUsername: String(doc.externalUsername),
    displayName: (doc.displayName as string | null) ?? null,
    avatarUrl: (doc.avatarUrl as string | null) ?? null,
    createdAt: date(doc.createdAt),
    lastLoginAt: date(doc.lastLoginAt),
  };
}

/**
 * 查询已绑定的外部身份（纯查询）。
 *
 * - 命中 → 更新 `lastLoginAt`/`externalUsername` 快照并返回绑定视图；
 * - 未命中 → 返回 null（由调用方签发 pending 凭证 / 走开户）。
 */
export async function findExternalLogin(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult | null> {
  const issuer = identity.issuer ?? null;
  const existing = (await ExternalLogin.findOne({
    providerId: identity.providerId,
    issuer,
    subject: identity.subject,
  }).lean()) as {
    _id: unknown;
    userId: { toString(): string };
    accountId: { toString(): string };
  } | null;

  if (!existing) return null;

  await ExternalLogin.updateOne(
    { _id: existing._id },
    { $set: { lastLoginAt: new Date(), externalUsername: identity.externalUsername } },
  );
  return resultFromExisting(existing.userId, existing.accountId);
}

async function provisionExternalLoginCore(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult> {
  const issuer = identity.issuer ?? null;
  const base = deriveUsername(identity.externalUsername);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = attempt === 0 ? base : withSuffix(base);
    let provisioned: Awaited<ReturnType<typeof provisionUser>> | null = null;
    try {
      const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
      provisioned = await provisionUser({ username, passwordHash, source: 'oauth' });
      await ExternalLogin.create({
        userId: provisioned.user.id,
        tenantId: provisioned.user.id,
        accountId: provisioned.account.id,
        providerId: identity.providerId,
        issuer,
        subject: identity.subject,
        externalUsername: identity.externalUsername,
        displayName: identity.displayName ?? null,
        avatarUrl: identity.avatarUrl ?? null,
        lastLoginAt: new Date(),
      });
      return {
        user: {
          id: provisioned.user.id,
          name: provisioned.user.name,
          tenantId: provisioned.user.id,
          createdAt: provisioned.user.createdAt,
        },
        account: provisioned.account,
        created: provisioned.created,
      };
    } catch (err) {
      // 落库失败（含并发唯一冲突）：回滚本次开户产物，避免孤儿账户/租户/计费账户。
      if (provisioned) {
        await Promise.resolve(provisioned.rollback()).catch(() => undefined);
      }
      if ((err as { code?: number }).code === 11000) {
        const raced = (await ExternalLogin.findOne({
          providerId: identity.providerId,
          issuer,
          subject: identity.subject,
        }).lean()) as { userId: { toString(): string } } | null;
        if (raced) {
          // D4：provision 不再幂等吞并为登录，身份已被占用需明确拒绝。
          throw new ExternalLoginError('IDENTITY_ALREADY_BOUND');
        }
        throw err;
      }
      if (err instanceof ProvisioningError && err.code === 'USERNAME_TAKEN') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new ProvisioningError('USERNAME_TAKEN');
}

/**
 * 新账户开户并建立外部身份绑定（原自动开户语义，仅「创建新帐号」提交 / 兼容入口调用）。
 *
 * 保留身份级 Redis 锁串行化并发开户；E11000 回读到既存身份时抛
 * `IDENTITY_ALREADY_BOUND`（不再幂等返回他人账户，D4）。
 */
export async function provisionExternalLogin(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult> {
  return withIdentityLock(identity.providerId, identity.issuer ?? null, identity.subject, () =>
    provisionExternalLoginCore(identity),
  );
}

/**
 * 把外部身份绑定到指定用户（绑定已有帐号 / front-bind 回调）。
 *
 * 两个唯一索引（身份全平台唯一 + 每账户每 Provider 唯一）是唯一裁决面：
 * 预检只用于输出稳定错误，最终以 E11000 回读判定；
 * 绑定路径**不引入身份锁**（提案实现点 1 / D8）。
 */
export async function bindExternalLoginToUser(
  user: BindTargetUser,
  identity: ExternalIdentityInput,
): Promise<ExternalLoginBindingView> {
  const issuer = identity.issuer ?? null;

  const identityTaken = await ExternalLogin.findOne({
    providerId: identity.providerId,
    issuer,
    subject: identity.subject,
  }).lean();
  if (identityTaken) {
    throw new ExternalLoginError('IDENTITY_ALREADY_BOUND');
  }

  const providerTaken = await ExternalLogin.findOne({
    userId: user.id,
    providerId: identity.providerId,
  }).lean();
  if (providerTaken) {
    throw new ExternalLoginError('PROVIDER_ALREADY_BOUND');
  }

  try {
    const created = await ExternalLogin.create({
      userId: user.id,
      tenantId: user.tenantId,
      accountId: user.accountId,
      providerId: identity.providerId,
      issuer,
      subject: identity.subject,
      externalUsername: identity.externalUsername,
      displayName: identity.displayName ?? null,
      avatarUrl: identity.avatarUrl ?? null,
      lastLoginAt: new Date(),
    });
    return toBindingView(created.toObject() as Record<string, unknown>);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const byIdentity = await ExternalLogin.findOne({
        providerId: identity.providerId,
        issuer,
        subject: identity.subject,
      }).lean();
      if (byIdentity) throw new ExternalLoginError('IDENTITY_ALREADY_BOUND');
      const byProvider = await ExternalLogin.findOne({
        userId: user.id,
        providerId: identity.providerId,
      }).lean();
      if (byProvider) throw new ExternalLoginError('PROVIDER_ALREADY_BOUND');
    }
    throw err;
  }
}

/** 当前用户全部外部身份绑定（按绑定时间升序）。 */
export async function listExternalLogins(userId: string): Promise<ExternalLoginBindingView[]> {
  const docs = (await ExternalLogin.find({ userId }).sort({ createdAt: 1 }).lean()) as Array<
    Record<string, unknown>
  >;
  return docs.map(toBindingView);
}

/**
 * 解绑本人一条外部身份。
 *
 * 防呆（服务端强制）：当前账户无可用密码（`accounts.passwordless === true`）
 * 且这是最后一条绑定时拒绝，避免账户永久失去登录能力。
 */
export async function unbindExternalLogin(userId: string, id: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ExternalLoginError('EXTERNAL_LOGIN_NOT_FOUND');
  }
  const binding = (await ExternalLogin.findOne({
    _id: id,
    userId,
  }).lean()) as { _id: unknown; accountId: { toString(): string } } | null;
  if (!binding) {
    throw new ExternalLoginError('EXTERNAL_LOGIN_NOT_FOUND');
  }

  const bindingCount = await ExternalLogin.countDocuments({ userId });
  if (bindingCount <= 1) {
    const account = (await Account.findById(binding.accountId).lean()) as {
      passwordless?: boolean;
    } | null;
    if (account?.passwordless === true) {
      throw new ExternalLoginError('CANNOT_UNBIND_LAST_LOGIN_METHOD');
    }
  }

  const result = await ExternalLogin.deleteOne({ _id: binding._id, userId });
  return result.deletedCount === 1;
}
