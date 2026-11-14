import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { Account } from '../../models/account.js';
import { AuthProvider } from '../../models/auth-provider.js';
import { ExternalLogin } from '../../models/external-login.js';
import { Tenant } from '../../models/tenant.js';
import { TenantMember } from '../../models/tenant-member.js';
import { User } from '../../models/user.js';
import { verifyPassword, signToken } from '../../services/auth.js';
import {
  bumpPendingFailCount,
  consumeLoginTicket,
  consumePendingIdentity,
  getPendingIdentity,
  issueFrontBindTicket,
} from '../../services/oauth-flow.js';
import {
  bindExternalLoginToUser,
  ExternalLoginError,
  listExternalLogins,
  provisionExternalLogin as provisionExternalLoginService,
  unbindExternalLogin as unbindExternalLoginService,
  type ExternalIdentityInput,
} from '../../services/external-login.js';
import { ProvisioningError } from '../../services/provisioning.js';

export interface WorkspaceAccess {
  id: string;
  tenantId: string;
  type: 'global' | 'normal';
  role: 'admin' | 'developer';
  readOnly: boolean;
}

export interface AuthContext {
  currentUser: {
    id: string;
    tenantId?: string;
    name?: string;
    /** @deprecated 一期原登录字段已不对外暴露，仅兼容既有单测上下文构造。 */
    username?: string;
  } | null;
  /** 请求级租户上下文（= currentUser.tenantId；personal 期恒等于 userId）。 */
  tenantId?: string | null;
  /** 请求级租户工作区上下文（多租户二期；缺省回退个人全局工作区）。 */
  workspaceAccess?: WorkspaceAccess | null;
  /** 请求级可访问工作区惰性缓存（与 modelLibraryPromise 同模式）。 */
  accessibleWorkspacesPromise?: Promise<unknown[]>;
  /** 请求级平台模型库缓存（Session.availableModels 来源推断用，避免 N+1） */
  modelLibraryPromise?: Promise<Array<{ name: string; scope: 'user' | 'global' }>>;
}

export function requireTenantId(context: AuthContext): string {
  // 一级回退：personal 期 tenantId == userId，历史/半迁移行缺失 tenantId 时回退为 userId。
  const tenantId = context.tenantId ?? context.currentUser?.tenantId ?? context.currentUser?.id;
  if (!tenantId) {
    throw new GraphQLError('Not authenticated');
  }
  return tenantId;
}

/** 请求级工作区上下文（未登录/缺数据时回退个人租户口径）。 */
export function requireWorkspace(context: AuthContext): WorkspaceAccess {
  if (context.workspaceAccess) return context.workspaceAccess;
  const tenantId = requireTenantId(context);
  return { id: '', tenantId, type: 'global', role: 'admin', readOnly: false };
}

/** 服务层 admin 断言（工作区管理 / 租户成员管理入口）。 */
export function requireTenantAdmin(context: AuthContext): string {
  const access = requireWorkspace(context);
  if (access.role !== 'admin') {
    throw new GraphQLError('not a tenant admin');
  }
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

function toUserView(user: {
  _id: unknown;
  name?: string | null;
  username?: string | null;
  tenantId?: unknown;
  createdAt?: Date | null;
}) {
  return {
    id: String(user._id),
    // 半迁移/历史行兜底：name 缺失时回退原 username（迁移后两者同值）
    name: user.name ?? user.username ?? '',
    // personal 期 tenantId == userId；缺失时回退 userId，供 User.tenant 字段 resolver 使用
    tenantId: user.tenantId ? String(user.tenantId) : String(user._id),
    createdAt: user.createdAt ?? new Date(),
  };
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

interface ProviderMirror {
  _id: unknown;
  type: 'oidc' | 'github_oauth';
  displayName: string;
  enabled: boolean;
  enableFrontLogin: boolean;
}

async function loadProviderMirror(providerId: string): Promise<ProviderMirror | null> {
  if (!mongoose.Types.ObjectId.isValid(providerId)) return null;
  return (await AuthProvider.findById(providerId).lean()) as unknown as ProviderMirror | null;
}

function providerDisplayName(provider: ProviderMirror | null): string {
  if (!provider) return '未知登录方式';
  return provider.type === 'github_oauth' ? 'GitHub' : provider.displayName;
}

/** 外部身份绑定域错误 → 契约文案（BAD_USER_INPUT）。 */
function rethrowBindingError(err: unknown): never {
  if (err instanceof ExternalLoginError) {
    switch (err.code) {
      case 'IDENTITY_ALREADY_BOUND':
        throw badInput('identity already bound');
      case 'PROVIDER_ALREADY_BOUND':
        throw badInput('provider already bound');
      case 'EXTERNAL_LOGIN_NOT_FOUND':
        throw badInput('external login not found');
      case 'CANNOT_UNBIND_LAST_LOGIN_METHOD':
        throw badInput('cannot unbind last login method');
    }
  }
  if (err instanceof ProvisioningError) {
    throw badInput('provision failed');
  }
  throw err;
}

function requireCurrentUser(context: AuthContext): NonNullable<AuthContext['currentUser']> {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser;
}

function identityFromPending(pending: {
  providerId: string;
  issuer: string | null;
  subject: string;
  externalUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}): ExternalIdentityInput {
  return {
    providerId: pending.providerId,
    issuer: pending.issuer,
    subject: pending.subject,
    externalUsername: pending.externalUsername,
    displayName: pending.displayName ?? null,
    avatarUrl: pending.avatarUrl ?? null,
  };
}

async function requireEnabledFrontProvider(providerId: string): Promise<ProviderMirror> {
  const provider = await loadProviderMirror(providerId);
  if (!provider || !provider.enabled || !provider.enableFrontLogin) {
    throw badInput('provider unavailable');
  }
  return provider;
}

export const authResolvers = {
  Query: {
    me: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        return null;
      }
      const user = await User.findById(context.currentUser.id);
      return user ? toUserView(user) : null;
    },
    // 免登录：前台登录页第三方按钮前置查询
    authProviders: async () => {
      const docs = await AuthProvider.find({ enabled: true, enableFrontLogin: true })
        .sort({ createdAt: 1 })
        .lean() as Array<{ _id: unknown; type: string; displayName: string }>;
      return docs.map((doc) => ({
        id: String(doc._id),
        type: doc.type,
        displayName: doc.type === 'github_oauth' ? 'GitHub' : doc.displayName,
      }));
    },
    // 需登录：当前用户全部外部身份绑定
    myExternalLogins: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const user = requireCurrentUser(context);
      return listExternalLogins(user.id);
    },
    // 免登录：身份选择页摘要（不消费 pending ticket；过期返回 null）
    pendingExternalLoginInfo: async (
      _parent: unknown,
      args: { pendingToken: string },
    ) => {
      const pending = await getPendingIdentity(args.pendingToken);
      if (!pending) return null;
      const provider = await loadProviderMirror(pending.providerId);
      return {
        providerDisplayName: providerDisplayName(provider),
        externalUsername: pending.externalUsername,
      };
    },
  },
  Mutation: {
    login: async (_parent: unknown, args: { username: string; password: string }) => {
      // 登录走 accounts（账户承载凭据），经 users.accountId 定位身份主体。
      const account = await Account.findOne({ username: args.username });
      if (!account) {
        throw new GraphQLError('Invalid username or password');
      }

      const valid = await verifyPassword(args.password, account.passwordHash);
      if (!valid) {
        throw new GraphQLError('Invalid username or password');
      }

      const user = await User.findOne({ accountId: account._id });
      if (!user) {
        throw new GraphQLError('Invalid username or password');
      }

      const token = signToken(user._id.toString());
      return { token, user: toUserView(user) };
    },
    exchangeLoginTicket: async (_parent: unknown, args: { ticket: string }) => {
      const payload = await consumeLoginTicket(args.ticket);
      if (!payload || !payload.token || !payload.user) {
        throw new GraphQLError('invalid or expired ticket', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      return { token: payload.token, user: payload.user };
    },
    // 身份选择页：绑定已有帐号（验密 → 落绑定 → 签发 AuthPayload）
    bindExternalLoginWithPassword: async (
      _parent: unknown,
      args: { pendingToken: string; username: string; password: string },
    ) => {
      const pending = await getPendingIdentity(args.pendingToken);
      if (!pending) throw badInput('invalid or expired pending token');

      await requireEnabledFrontProvider(pending.providerId);

      const account = await Account.findOne({ username: args.username });
      const user = account ? await User.findOne({ accountId: account._id }) : null;
      let valid = false;
      if (account && user) {
        try {
          valid = await verifyPassword(args.password, account.passwordHash);
        } catch {
          valid = false;
        }
      }
      if (!account || !user || !valid) {
        // 验密失败不消费 pending，仅计次；≥5 次作废（文案与 login 逐字一致）
        await bumpPendingFailCount(args.pendingToken);
        throw badInput('Invalid username or password');
      }

      try {
        await bindExternalLoginToUser(
          {
            id: String(user._id),
            accountId: String(account._id),
            tenantId: String(user.tenantId ?? user._id),
          },
          identityFromPending(pending),
        );
      } catch (err) {
        rethrowBindingError(err);
      }

      await consumePendingIdentity(args.pendingToken);
      const token = signToken(String(user._id));
      return { token, user: toUserView(user) };
    },
    // 身份选择页：创建新帐号（沿用原自动开户）
    provisionExternalLogin: async (
      _parent: unknown,
      args: { pendingToken: string },
    ) => {
      const pending = await getPendingIdentity(args.pendingToken);
      if (!pending) throw badInput('invalid or expired pending token');

      await requireEnabledFrontProvider(pending.providerId);

      let result: Awaited<ReturnType<typeof provisionExternalLoginService>>;
      try {
        result = await provisionExternalLoginService(identityFromPending(pending));
      } catch (err) {
        rethrowBindingError(err);
      }

      await consumePendingIdentity(args.pendingToken);
      const token = signToken(result.user.id);
      return { token, user: result.user };
    },
    // 设置页：签发前台绑定票据（600s）；前端携 ticket 跳 front-bind authorize
    createFrontBindTicket: async (
      _parent: unknown,
      args: { providerId: string },
      context: AuthContext,
    ) => {
      const user = requireCurrentUser(context);
      const provider = await loadProviderMirror(args.providerId);
      if (!provider || !provider.enabled || !provider.enableFrontLogin) {
        throw badInput('provider unavailable');
      }
      const existing = await ExternalLogin.findOne({
        userId: user.id,
        providerId: args.providerId,
      }).lean();
      if (existing) throw badInput('provider already bound');
      return issueFrontBindTicket({ userId: user.id, providerId: args.providerId });
    },
    // 设置页：解绑本人一条绑定（服务端防呆）
    unbindExternalLogin: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const user = requireCurrentUser(context);
      try {
        return await unbindExternalLoginService(user.id, args.id);
      } catch (err) {
        rethrowBindingError(err);
      }
    },
  },
  User: {
    // 字段级 resolver：必须登记在 graphql/resolvers/index.ts 的 User 键（否则线上不生效）。
    tenant: async (parent: { id: string; tenantId?: string; name?: string }) => {
      // 以 users.tenantId 为准（team 租户下不再等价于 userId）；半迁移行回退 userId。
      const tenantId = parent.tenantId ?? parent.id;
      const tenant = await Tenant.findById(tenantId);
      if (!tenant) {
        // 半迁移/历史行兜底：personal 租户 _id 复用 userId，缺失文档时返回等价视图。
        return { id: tenantId, name: parent.name ?? '', type: 'personal', memberCount: 1 };
      }
      const memberCount = await TenantMember.countDocuments({ tenantId: tenant._id });
      return {
        id: tenant._id.toString(),
        name: tenant.name,
        type: tenant.type,
        memberCount,
      };
    },
  },
  // 字段级 resolver：必须登记在 graphql/resolvers/index.ts 的 ExternalLoginInfo 键。
  // provider 被删除/停用时回退绑定行快照，前端可继续展示「已停用」。
  ExternalLoginInfo: {
    providerType: async (parent: { providerId: string }) => {
      const provider = await loadProviderMirror(parent.providerId);
      return provider?.type ?? 'oidc';
    },
    providerDisplayName: async (parent: {
      providerId: string;
      externalUsername?: string;
    }) => {
      const provider = await loadProviderMirror(parent.providerId);
      return provider ? providerDisplayName(provider) : parent.externalUsername ?? '';
    },
    providerEnabled: async (parent: { providerId: string }) => {
      const provider = await loadProviderMirror(parent.providerId);
      return provider?.enabled ?? false;
    },
  },
};
