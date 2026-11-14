import crypto from 'node:crypto';
import { Account } from '../models/account.js';
import { ExternalLogin } from '../models/external-login.js';
import { User } from '../models/user.js';
import { hashPassword } from './auth.js';
import { getRedisClient } from '../middleware/redis.js';
import { provisionUser, ProvisioningError } from './provisioning.js';

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

async function resolveExternalLoginCore(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult> {
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

  if (existing) {
    await ExternalLogin.updateOne(
      { _id: existing._id },
      { $set: { lastLoginAt: new Date(), externalUsername: identity.externalUsername } },
    );
    return resultFromExisting(existing.userId, existing.accountId);
  }

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
        }).lean()) as {
          userId: { toString(): string };
          accountId: { toString(): string };
        } | null;
        if (raced) {
          return resultFromExisting(raced.userId, raced.accountId);
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
 * 前台外部身份匹配与自动开户（agent-api 唯一写方）。
 *
 * - 命中 `{providerId, issuer, subject}` → 更新 lastLoginAt，返回同一账户；
 * - 未命中 → 身份级 Redis 锁串行化（并发首登不重复开户）→ 派生唯一用户名
 *   （冲突 `-{4位随机}` 重试 ≤5）→ provisioning 开户 → 落 `externallogins`；
 * - 落库失败（唯一冲突/异常）→ 回滚本次开户产物，E11000 回读胜方幂等返回。
 */
export async function resolveExternalLogin(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult> {
  return withIdentityLock(identity.providerId, identity.issuer ?? null, identity.subject, () =>
    resolveExternalLoginCore(identity),
  );
}
