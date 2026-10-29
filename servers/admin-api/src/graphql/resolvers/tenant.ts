import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { Account } from '../../models/account.js';
import { BillingAccount } from '../../models/billing-account.js';
import { Tenant } from '../../models/tenant.js';
import { TenantMember } from '../../models/tenant-member.js';
import { User } from '../../models/user.js';
import { Workspace } from '../../models/workspace.js';
import { WorkspaceMember } from '../../models/workspace-member.js';
import { availableCents, centsToCredits } from '../../services/billing/money.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/**
 * 后台租户与账户管理（contracts/admin-tenant.graphql）。
 *
 * - 租户/用户/工作区为 **只读镜像**（写方仅 agent-api，含 tenantmembers/workspaces/workspacemembers），
 *   后台不做多租户设计；
 * - 写操作一律转发 agent-api 内部端点（Bearer INTERNAL_API_TOKEN），不在 admin-api 侧直写：
 *   开户 `POST /internal/users`、team 开通 `POST /internal/tenants`、
 *   成员初始化 `POST /internal/tenants/:id/members`、移除 `DELETE /internal/tenants/:id/members/:userId`；
 * - 租户成员口径（多租户二期）：成员列表/成员数经 `tenantmembers` 展开（含 role）；
 *   personal 老数据无 tenantmembers 行时回退 `users.tenantId`（role 恒 admin），避免后台显示 0。
 */
export type TenantRoleValue = 'admin' | 'developer';

export interface AdminTenantUserView {
  id: string;
  name: string;
  username: string;
  role: TenantRoleValue;
  createdAt: string;
}

export interface AdminTenantView {
  id: string;
  name: string;
  type: 'personal' | 'team';
  memberCount: number;
  balance: number | null;
  createdAt: string;
}

export interface AdminWorkspaceView {
  id: string;
  name: string;
  type: 'global' | 'normal';
  memberCount: number;
  createdAt: string;
}

type TenantErrorCode =
  | 'UNAUTHENTICATED'
  | 'MUST_CHANGE_PASSWORD'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
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

/**
 * 租户成员数聚合：单一事实源 `tenantmembers`（多租户二期）。
 *
 * personal 老数据（迁移 015 前）无 tenantmembers 行时回退 `users.tenantId` 计数，
 * 避免后台租户列表显示 0；team 租户的 users.tenantId 指向成员各自的个人租户，
 * 回退计数恒为 0，不影响 team 成员口径。
 */
async function memberCounts(tenantIds: string[]): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map();
  const objectIds = tenantIds.map((id) => new mongoose.Types.ObjectId(id));
  const rows = (await TenantMember.aggregate([
    { $match: { tenantId: { $in: objectIds } } },
    { $group: { _id: '$tenantId', count: { $sum: 1 } } },
  ])) as Array<{ _id: mongoose.Types.ObjectId; count: number }>;
  const counts = new Map(rows.map((row) => [String(row._id), row.count]));

  const missing = objectIds.filter((id) => !counts.has(String(id)));
  if (missing.length > 0) {
    const fallback = (await User.aggregate([
      { $match: { tenantId: { $in: missing } } },
      { $group: { _id: '$tenantId', count: { $sum: 1 } } },
    ])) as Array<{ _id: mongoose.Types.ObjectId; count: number }>;
    for (const row of fallback) counts.set(String(row._id), row.count);
  }
  return counts;
}

/** 工作区成员数聚合（normal 工作区成员行；global 恒无行）。 */
async function workspaceMemberCounts(workspaceIds: string[]): Promise<Map<string, number>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = (await WorkspaceMember.aggregate([
    { $match: { workspaceId: { $in: workspaceIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$workspaceId', count: { $sum: 1 } } },
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

interface TenantDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  type?: string;
  createdAt: Date;
}

function tenantView(doc: TenantDoc, counts: Map<string, number>, balances: Map<string, number>): AdminTenantView {
  const id = String(doc._id);
  return {
    id,
    name: doc.name,
    type: doc.type === 'team' ? 'team' : 'personal',
    memberCount: counts.get(id) ?? 0,
    balance: balances.get(id) ?? null,
    createdAt: toIso(doc.createdAt),
  };
}

/** 单租户视图（team 开通后回读镜像，复用列表同口径的成员数与余额聚合）。 */
async function tenantSummaryById(id: string): Promise<AdminTenantView | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Tenant.findById(id).lean<TenantDoc | null>();
  if (!doc) return null;
  const [counts, balances] = await Promise.all([memberCounts([id]), tenantBalances([id])]);
  return tenantView(doc, counts, balances);
}

/** 内部端点错误码 → 后台契约错误文案白名单（逐字，不新增变体）。 */
const INTERNAL_ERROR_TEXT: Record<string, string> = {
  TENANT_NAME_TAKEN: 'tenant name already exists',
  ACCOUNT_NOT_FOUND: 'account not found',
  ALREADY_MEMBER: 'already a member',
  NOT_MEMBER: 'not a member',
  PERSONAL_TENANT_IMMUTABLE: 'personal tenant is immutable',
  LAST_ADMIN: 'last admin cannot be removed',
  INVALID_ROLE: 'invalid tenant role',
  TENANT_NOT_FOUND: 'tenant not found',
};

interface InternalErrorPayload {
  error?: string;
  message?: string;
}

function errorText(payload: InternalErrorPayload | null, fallback: string): string {
  if (!payload) return fallback;
  if (payload.message) return payload.message;
  if (payload.error) return INTERNAL_ERROR_TEXT[payload.error] ?? payload.error;
  return fallback;
}

/**
 * 内部端点状态码映射（沿用 forwardCreateFrontUser 口径）：
 * - 400 → INVALID_ARGUMENT（含 `PERSONAL_TENANT_IMMUTABLE`/`INVALID_ROLE`）
 * - 404 → NOT_FOUND（含 `ACCOUNT_NOT_FOUND`/`NOT_MEMBER`）
 * - 409 → CONFLICT（含 `TENANT_NAME_TAKEN`/`LAST_ADMIN`）
 * - 401/403（内部 token 配置错误）/502/503/504/网络异常 → AGENT_API_UNAVAILABLE
 */
function upstreamError(
  status: number,
  payload: InternalErrorPayload | null,
  label: string,
): GraphQLError {
  if (status === 400) {
    return tenantError(errorText(payload, 'INVALID_BODY'), 'INVALID_ARGUMENT');
  }
  if (status === 404) {
    return tenantError(errorText(payload, 'not found'), 'NOT_FOUND');
  }
  if (status === 409) {
    return tenantError(errorText(payload, 'CONFLICT'), 'CONFLICT');
  }
  if (status === 401 || status === 403) {
    console.error(`[admin-tenant] ${label} rejected internal token (status ${status})`);
    return tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }
  if (status === 502 || status === 503 || status === 504) {
    console.error(`[admin-tenant] ${label} failed with status ${status}`);
    return tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }
  console.error(`[admin-tenant] ${label} failed with status ${status}`);
  return tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
}

/** 转发 agent-api 内部端点（Bearer INTERNAL_API_TOKEN + 10s 超时）。 */
async function callInternalApi(
  method: 'POST' | 'DELETE',
  path: string,
  label: string,
  body?: unknown,
): Promise<{ status: number; payload: InternalErrorPayload | null }> {
  if (!config.agentApiUrl) {
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }
  if (!config.internalApiToken) {
    console.error(`[admin-tenant] INTERNAL_API_TOKEN is not configured, cannot forward ${label}`);
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }

  let response: Response;
  try {
    response = await fetch(`${config.agentApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.internalApiToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`[admin-tenant] forward ${label} failed`, (err as Error).message);
    throw tenantError('AGENT_API_UNAVAILABLE', 'AGENT_API_UNAVAILABLE');
  }

  const payload = (await response.json().catch(() => null)) as InternalErrorPayload | null;
  return { status: response.status, payload };
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
  const { status, payload } = await callInternalApi(
    'POST',
    '/internal/users',
    '/internal/users',
    { username, password },
  );
  const created = (payload ?? {}) as FrontUserCreatedPayload & InternalErrorPayload;

  if (status === 200 || status === 201) {
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
      // 开户产物=个人专属租户的唯一成员，恒为 admin（多租户二期角色口径）
      role: 'admin',
      createdAt: created.user?.createdAt ?? created.tenant?.createdAt ?? new Date().toISOString(),
    };
  }

  if (status === 409) {
    throw tenantError('USERNAME_TAKEN', 'CONFLICT');
  }
  throw upstreamError(status, created, '/internal/users');
}

interface TeamTenantPayload extends InternalErrorPayload {
  tenant?: { id?: string; name?: string; type?: string; createdAt?: string };
  globalWorkspace?: { id?: string; name?: string; type?: string };
}

/** team 租户开通转发：`POST {AGENT_API_URL}/internal/tenants`（按 name 幂等 200/201）。 */
async function forwardCreateTeamTenant(name: string): Promise<AdminTenantView> {
  const { status, payload } = await callInternalApi('POST', '/internal/tenants', '/internal/tenants', {
    name,
  });
  if (status !== 200 && status !== 201) {
    throw upstreamError(status, payload, '/internal/tenants');
  }
  const created = (payload ?? {}) as TeamTenantPayload;
  let tenantId = created.tenant?.id;
  if (!tenantId) {
    const existing = await Tenant.findOne({ name: name.trim() }).lean<{ _id: mongoose.Types.ObjectId } | null>();
    tenantId = existing ? String(existing._id) : undefined;
  }
  if (!tenantId) {
    console.error('[admin-tenant] /internal/tenants returned an unexpected payload');
    throw tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
  }
  const summary = await tenantSummaryById(tenantId);
  if (!summary) {
    console.error(`[admin-tenant] team tenant ${tenantId} not visible in mirror after creation`);
    throw tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
  }
  return summary;
}

interface MemberPayload extends InternalErrorPayload {
  user?: { id?: string; name?: string; username?: string; role?: string };
}

/** 成员视图：id/name/username/role 取上游响应，createdAt 回读镜像（新成员行刚写入）。 */
async function memberViewFromPayload(
  payload: MemberPayload | null,
  fallbackUsername: string,
  fallbackRole: TenantRoleValue,
): Promise<AdminTenantUserView> {
  const user = payload?.user;
  const id = user?.id;
  if (!id || !mongoose.isValidObjectId(id)) {
    console.error('[admin-tenant] /internal/tenants/:id/members returned an unexpected payload');
    throw tenantError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
  }
  const doc = await User.findById(id).lean<{ name?: string; createdAt?: Date } | null>();
  const role: TenantRoleValue = user?.role === 'admin' || user?.role === 'developer'
    ? user.role
    : fallbackRole;
  return {
    id,
    name: user?.name ?? doc?.name ?? fallbackUsername,
    username: user?.username ?? fallbackUsername,
    role,
    createdAt: doc?.createdAt ? toIso(doc.createdAt) : new Date().toISOString(),
  };
}

/**
 * 成员初始化转发：`POST {AGENT_API_URL}/internal/tenants/:id/members`。
 * body `{username, role, operatorId}`；`operatorId`=当前 admin 用户 id（仅审计，不参与业务校验）。
 * role 缺省 developer；重复添加为幂等 200（不覆盖既有角色）。
 */
async function forwardAddTenantMember(
  operatorId: string,
  tenantId: string,
  username: string,
  role: TenantRoleValue,
): Promise<AdminTenantUserView> {
  if (!mongoose.isValidObjectId(tenantId)) {
    throw tenantError('tenant not found', 'NOT_FOUND');
  }
  const { status, payload } = await callInternalApi(
    'POST',
    `/internal/tenants/${tenantId}/members`,
    '/internal/tenants/:id/members',
    { username, role, operatorId },
  );
  if (status !== 200 && status !== 201) {
    throw upstreamError(status, payload, '/internal/tenants/:id/members');
  }
  return memberViewFromPayload(payload as MemberPayload | null, username, role);
}

/** 成员移除转发：`DELETE {AGENT_API_URL}/internal/tenants/:id/members/:userId?operatorId=`。 */
async function forwardRemoveTenantMember(
  operatorId: string,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(tenantId) || !mongoose.isValidObjectId(userId)) {
    throw tenantError('not a member', 'NOT_FOUND');
  }
  const query = `?operatorId=${encodeURIComponent(operatorId)}`;
  const { status, payload } = await callInternalApi(
    'DELETE',
    `/internal/tenants/${tenantId}/members/${userId}${query}`,
    '/internal/tenants/:id/members/:userId',
  );
  if (status === 200 || status === 204) return true;
  throw upstreamError(status, payload, '/internal/tenants/:id/members/:userId');
}

interface MirrorUserDoc {
  _id: mongoose.Types.ObjectId;
  name?: string;
  username?: string;
  accountId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

interface MemberRow {
  userId: mongoose.Types.ObjectId;
  role?: string;
  createdAt: Date;
}

/** 租户成员（经 tenantmembers 展开；personal 老数据无成员行时回退 users.tenantId，role 恒 admin）。 */
async function tenantMemberViews(tenantId: string, isTeam: boolean): Promise<AdminTenantUserView[]> {
  const members = await TenantMember.find({ tenantId })
    .sort({ createdAt: 1 })
    .lean<Array<MemberRow & { tenantId: mongoose.Types.ObjectId }>>();

  let rows: MemberRow[] = members.map((member) => ({
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt,
  }));

  if (rows.length === 0 && !isTeam) {
    const legacyUsers = await User.find({ tenantId })
      .sort({ createdAt: 1 })
      .lean<MirrorUserDoc[]>();
    rows = legacyUsers.map((user) => ({ userId: user._id, role: 'admin', createdAt: user.createdAt }));
  }
  if (rows.length === 0) return [];

  const userIds = rows.map((row) => row.userId).filter((id) => mongoose.isValidObjectId(id));
  const users = await User.find({ _id: { $in: userIds } }).lean<MirrorUserDoc[]>();
  const userMap = new Map(users.map((user) => [String(user._id), user]));

  const accountIds = users
    .map((user) => user.accountId)
    .filter((id): id is mongoose.Types.ObjectId => !!id && mongoose.isValidObjectId(id));
  const accounts = await Account.find({ _id: { $in: accountIds } })
    .select({ username: 1 })
    .lean<Array<{ _id: mongoose.Types.ObjectId; username: string }>>();
  const loginNames = new Map(accounts.map((account) => [String(account._id), account.username]));

  return rows.map((row) => {
    const user = userMap.get(String(row.userId));
    return {
      id: String(row.userId),
      name: user?.name || user?.username || '',
      username: (user?.accountId ? loginNames.get(String(user.accountId)) : undefined) ?? user?.username ?? '',
      role: row.role === 'admin' ? 'admin' : 'developer',
      createdAt: toIso(row.createdAt ?? user?.createdAt),
    };
  });
}

/** 工作区只读视图（normal=workspacemembers 计数；global=租户成员数，语义=全员）。 */
async function tenantWorkspaceViews(tenantId: string): Promise<AdminWorkspaceView[]> {
  const workspaces = await Workspace.find({ tenantId })
    .sort({ createdAt: 1 })
    .lean<Array<{
      _id: mongoose.Types.ObjectId;
      name: string;
      type?: string;
      createdAt: Date;
    }>>();
  if (workspaces.length === 0) return [];

  const normalIds = workspaces
    .filter((workspace) => workspace.type !== 'global')
    .map((workspace) => String(workspace._id));
  const [normalCounts, counts] = await Promise.all([
    workspaceMemberCounts(normalIds),
    memberCounts([tenantId]),
  ]);
  const tenantMemberCount = counts.get(tenantId) ?? 0;

  return workspaces.map((workspace) => {
    const id = String(workspace._id);
    const isGlobal = workspace.type === 'global';
    return {
      id,
      name: workspace.name,
      type: isGlobal ? 'global' : 'normal',
      memberCount: isGlobal ? tenantMemberCount : normalCounts.get(id) ?? 0,
      createdAt: toIso(workspace.createdAt),
    };
  });
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
        .lean<TenantDoc[]>();
      const ids = docs.map((doc) => String(doc._id));
      const [counts, balances] = await Promise.all([memberCounts(ids), tenantBalances(ids)]);
      return docs.map((doc) => tenantView(doc, counts, balances));
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
      const tenant = await Tenant.findById(tenantId).lean<TenantDoc | null>();
      if (!tenant) return null;

      const id = String(tenant._id);
      const isTeam = tenant.type === 'team';
      const [users, workspaces] = await Promise.all([
        tenantMemberViews(id, isTeam),
        tenantWorkspaceViews(id),
      ]);

      return {
        id,
        name: tenant.name,
        type: isTeam ? 'team' : 'personal',
        users,
        workspaces,
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
    adminCreateTeamTenant: async (
      _parent: unknown,
      args: { name: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return forwardCreateTeamTenant(args.name ?? '');
    },
    adminAddTenantMember: async (
      _parent: unknown,
      args: { tenantId: string; username: string; role?: TenantRoleValue },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const operatorId = context.currentAdmin!.id;
      const role: TenantRoleValue = args.role ?? 'developer';
      return forwardAddTenantMember(operatorId, args.tenantId, args.username ?? '', role);
    },
    adminRemoveTenantMember: async (
      _parent: unknown,
      args: { tenantId: string; userId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const operatorId = context.currentAdmin!.id;
      return forwardRemoveTenantMember(operatorId, args.tenantId, args.userId);
    },
  },
};
