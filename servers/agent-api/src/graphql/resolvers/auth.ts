import { GraphQLError } from 'graphql';
import { Account } from '../../models/account.js';
import { Tenant } from '../../models/tenant.js';
import { TenantMember } from '../../models/tenant-member.js';
import { User } from '../../models/user.js';
import { verifyPassword, signToken } from '../../services/auth.js';

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

export const authResolvers = {
  Query: {
    me: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        return null;
      }
      const user = await User.findById(context.currentUser.id);
      return user ? toUserView(user) : null;
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
};
