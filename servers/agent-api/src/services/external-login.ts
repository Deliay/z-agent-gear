import crypto from 'node:crypto';
import { Account } from '../models/account.js';
import { ExternalLogin } from '../models/external-login.js';
import { User } from '../models/user.js';
import { hashPassword } from './auth.js';
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

/**
 * 前台外部身份匹配与自动开户（agent-api 唯一写方）。
 *
 * - 命中 `{providerId, issuer, subject}` → 更新 lastLoginAt，返回同一账户；
 * - 未命中 → 派生唯一用户名（冲突 `-{4位随机}` 重试 ≤5）→ provisioning 开户 →
 *   落 `externallogins`（唯一索引 E11000 → 回读既有行幂等）；
 * - 开户失败（计费不可达等）→ 抛 `ProvisioningError`，路由映射 `provision_failed`。
 */
export async function resolveExternalLogin(
  identity: ExternalIdentityInput,
): Promise<ExternalLoginResult> {
  const issuer = identity.issuer ?? null;
  const existing = await ExternalLogin.findOne({
    providerId: identity.providerId,
    issuer,
    subject: identity.subject,
  }).lean() as {
    userId: { toString(): string };
    accountId: { toString(): string };
  } | null;

  if (existing) {
    await ExternalLogin.updateOne(
      { _id: (existing as unknown as { _id: unknown })._id },
      { $set: { lastLoginAt: new Date(), externalUsername: identity.externalUsername } },
    );
    const user = (await User.findById(existing.userId).lean()) as UserDoc | null;
    if (!user) {
      throw new ProvisioningError('INTERNAL_ERROR', 'bound user missing');
    }
    const account = await Account.findById(existing.accountId).lean() as {
      _id: { toString(): string };
      username: string;
    } | null;
    return {
      user: toUserView(user),
      account: { id: String(account?._id ?? existing.accountId), username: account?.username ?? '' },
      created: false,
    };
  }

  const base = deriveUsername(identity.externalUsername);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = attempt === 0 ? base : withSuffix(base);
    try {
      const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
      const provisioned = await provisionUser({ username, passwordHash, source: 'oauth' });
      try {
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
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          // 并发首登：另一请求已落库，回读既有行（幂等，不重复开户）。
          const raced = await ExternalLogin.findOne({
            providerId: identity.providerId,
            issuer,
            subject: identity.subject,
          }).lean() as { userId: { toString(): string } } | null;
          if (raced) {
            const racedUser = (await User.findById(raced.userId).lean()) as UserDoc | null;
            if (racedUser) {
              return {
                user: toUserView(racedUser),
                account: provisioned.account,
                created: false,
              };
            }
          }
        }
        throw err;
      }
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
      if (err instanceof ProvisioningError && err.code === 'USERNAME_TAKEN') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new ProvisioningError('USERNAME_TAKEN');
}
