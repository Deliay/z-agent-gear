import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { Account } from '../../models/account.js';
import { BillingAccount } from '../../models/billing-account.js';
import { Tenant } from '../../models/tenant.js';
import { User } from '../../models/user.js';
import { availableCents, centsToCredits } from '../../services/billing/money.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/**
 * 后台租户与账户管理（contracts/admin-tenant.graphql）。
 *
 * - 租户/用户为 **只读镜像**（写方仅 agent-api），后台不做多租户设计；
 * - 开户为唯一写操作：经 `POST {AGENT_API_URL}/internal/users`（Bearer INTERNAL_API_TOKEN）转发，
 *   不在 admin-api 侧直写 accounts/users/tenants。
 */
export interface AdminTenantUserView {
  id: string;
  name: string;
  username: string;
  createdAt: string;
}

type TenantErrorCode =
  | 'UNAUTHENTICATED'
  | 'MUST_CHANGE_PASSWORD'
  | 'INVALID_ARGUMENT'
  | 'CONFLICT'
  | 'AGENT_API_UNAVAILABLE'
  | 'INTERNAL_SERVER_ERROR';

function tenantError(message: string, code: TenantErrorCode): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** 分页参数整数校验 + 上界（与费用中心同口径，避免超大 skip 慢查询）。 */
function toPage(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(1, value));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toIso(value: unknown): string {
  // 只读镜像行可能缺 createdAt（半迁移/外部直写）：返回 epoch 而不是抛 RangeError 导致 500。
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

/** 租户列表的成员数聚合（tenant→users 一对多由 users.tenantId 承载）。 */
async function memberCounts(tenantIds: string[]): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map();
  const rows = (await User.aggregate([
    { $match: { tenantId: { $in: tenantIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$tenantId', count: { $sum: 1 } } },
  ])) as Array<{ _id: mongoose.Types.ObjectId; count: number }>;
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

/** 租户计费账户可用余额（credits；无账户为 null）。 */
async function tenantBalances(tenantIds: string[]): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map();
  const docs = await BillingAccount.find({ ownerType: 'tenant', ownerId: { $in: tenantIds } })
    .select({ ownerId: 1, cashBalance: 1, giftBalance: 1, creditLimit: 1, frozenAmount: 1 })
    .lean<Array<{
      ownerId: string;
      cashBalance: number;
      giftBalance?: number;
      creditLimit?: number;
      frozenAmount?: number;
    }>>();
  return new Map(docs.map((doc) => [doc.ownerId, centsToCredits(availableCents(doc))]));
}

interface FrontUserCreatedPayload {
  user?: { id?: string; name?: string; createdAt?: string };
  account?: { id?: string; username?: string };
  tenant?: { id?: string; name?: string; createdAt?: string };
}

/**
 * 开户转发：`POST {AGENT_API_URL}/internal/users`。
 * 契约错误：400 `INVALID_BODY`（规则非法）/ 409 `USERNAME_TAKEN`；401/403 视为上游不可用（配置错误）。
 */
async function forwardCreateFrontUser(
  username: string,
  password: string,
): Promise<AdminTenantUserView> {
  if (!config.agentApiUrl) {
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }
  if (!config.internalApiToken) {
    console.error('[admin-tenant] INTERNAL_API_TOKEN is not configured, cannot forward create user');
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }

  let response: Response;
  try {
    response = await fetch(`${config.agentApiUrl}/internal/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.internalApiToken}`,
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('[admin-tenant] forward /internal/users failed', (err as Error).message);
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }

  const payload = (await response.json().catch(() => null)) as
    | (FrontUserCreatedPayload & { error?: string; message?: string })
    | null;

  if (response.status === 200 || response.status === 201) {
    const created = payload ?? {};
    const id = created.user?.id ?? created.tenant?.id;
    const loginName = created.account?.username ?? username;
    if (!id) {
      console.error('[admin-tenant] /internal/users returned an unexpected payload');
      throw tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
    }
    return {
      id,
      name: created.user?.name ?? created.tenant?.name ?? loginName,
      username: loginName,
      createdAt: created.user?.createdAt ?? created.tenant?.createdAt ?? new Date().toISOString(),
    };
  }

  if (response.status === 409) {
    throw tenantError('USERNAME_TAKEN', 'CONFLICT');
  }
  if (response.status === 400) {
    throw tenantError(payload?.message ?? payload?.error ?? 'INVALID_BODY', 'INVALID_ARGUMENT');
  }
  if (response.status === 401 || response.status === 403) {
    console.error(
      `[admin-tenant] /internal/users rejected internal token (status ${response.status})`,
    );
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }
  console.error(`[admin-tenant] /internal/users failed with status ${response.status}`);
  throw tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
}

export const tenantResolvers = {
  Query: {
    adminTenants: async (
      _parent: unknown,
      args: { keyword?: string; page?: number; pageSize?: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const page = toPage(args.page, 1, 100_000);
      const pageSize = toPage(args.pageSize, 50, 200);
      const keyword = args.keyword?.trim();
      const filter: Record<string, unknown> = keyword
        ? { name: { $regex: escapeRegex(keyword), $options: 'i' } }
        : {};
      const docs = await Tenant.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean<Array<{ _id: mongoose.Types.ObjectId; name: string; type?: string; createdAt: Date }>>();
      const ids = docs.map((doc) => String(doc._id));
      const [counts, balances] = await Promise.all([memberCounts(ids), tenantBalances(ids)]);
      return docs.map((doc) => {
        const id = String(doc._id);
        return {
          id,
          name: doc.name,
          type: doc.type === 'team' ? 'team' : 'personal',
          memberCount: counts.get(id) ?? 0,
          balance: balances.get(id) ?? null,
          createdAt: toIso(doc.createdAt),
        };
      });
    },
    adminTenant: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // 契约返回可空：非法/不存在的 id 一律 null（不泄露存在性）
      if (!mongoose.isValidObjectId(args.id)) return null;
      const tenantId = new mongoose.Types.ObjectId(args.id);
      const tenant = await Tenant.findById(tenantId).lean<{
        _id: mongoose.Types.ObjectId;
        name: string;
        type?: string;
        createdAt: Date;
      } | null>();
      if (!tenant) return null;

      const users = await User.find({ tenantId })
        .sort({ createdAt: 1 })
        .lean<Array<{
          _id: mongoose.Types.ObjectId;
          name?: string;
          username?: string;
          accountId?: mongoose.Types.ObjectId | null;
          createdAt: Date;
        }>>();
      const accountIds = users
        .map((user) => user.accountId)
        .filter((id): id is mongoose.Types.ObjectId => !!id && mongoose.isValidObjectId(id));
      const accounts = await Account.find({ _id: { $in: accountIds } })
        .select({ username: 1 })
        .lean<Array<{ _id: mongoose.Types.ObjectId; username: string }>>();
      const loginNames = new Map(accounts.map((account) => [String(account._id), account.username]));

      return {
        id: String(tenant._id),
        name: tenant.name,
        type: tenant.type === 'team' ? 'team' : 'personal',
        users: users.map((user) => ({
          id: String(user._id),
          name: user.name || user.username || '',
          username:
            (user.accountId ? loginNames.get(String(user.accountId)) : undefined) ??
            user.username ??
            '',
          createdAt: toIso(user.createdAt),
        })),
        createdAt: toIso(tenant.createdAt),
      };
    },
  },
  Mutation: {
    adminCreateFrontUser: async (
      _parent: unknown,
      args: { username: string; password: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const username = args.username ?? '';
      const password = args.password ?? '';
      // 本地预校验与 agent-api `assertUsernamePasswordRules` 同口径（避免无谓转发）
      if (username.length < 2 || username.length > 20) {
        throw tenantError('Username must be between 2 and 20 characters', 'INVALID_ARGUMENT');
      }
      if (password.length < 6) {
        throw tenantError('Password must be at least 6 characters', 'INVALID_ARGUMENT');
      }
      return forwardCreateFrontUser(username, password);
    },
  },
};
