import { GraphQLError } from 'graphql';
import { AdminUser } from '../../models/admin-user.js';
import { login, changePassword, signToken } from '../../services/auth.js';
import { loginRateLimiter, LoginRateLimitError } from '../../services/login-rate-limiter.js';

export interface AdminAuthContext {
  currentAdmin: {
    id: string;
    username: string;
    mustChangePassword: boolean;
  } | null;
  /** 客户端 IP（经 x-forwarded-for / x-real-ip 提取）；用于登录失败限速 key。 */
  clientIp?: string;
}

interface AdminRecord {
  _id: { toString(): string };
  username: string;
  mustChangePassword: boolean;
  passwordChangedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapAdmin(admin: AdminRecord) {
  return {
    id: admin._id.toString(),
    username: admin.username,
    mustChangePassword: admin.mustChangePassword,
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString(),
  };
}

export const authResolvers = {
  Query: {
    adminMe: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      if (!context.currentAdmin) {
        return null;
      }
      const admin = await AdminUser.findById(context.currentAdmin.id).lean() as AdminRecord | null;
      if (!admin) return null;
      return mapAdmin(admin);
    },
  },
  Mutation: {
    adminLogin: async (
      _parent: unknown,
      args: { username: string; password: string },
      context?: AdminAuthContext,
    ) => {
      // 按 IP + 用户名限速，降低在线暴力破解风险（问题 7）
      const rateLimitKey = `${context?.clientIp ?? 'unknown'}:${args.username}`;
      try {
        loginRateLimiter.assertAllowed(rateLimitKey);
      } catch (err) {
        if (err instanceof LoginRateLimitError) {
          throw new GraphQLError(err.message, { extensions: { code: err.code } });
        }
        throw err;
      }

      try {
        const admin = await login(args.username, args.password);
        loginRateLimiter.recordSuccess(rateLimitKey);
        const record = admin as unknown as AdminRecord;
        const token = signToken(admin._id.toString(), record.passwordChangedAt ?? null);
        return { token, admin: mapAdmin(record) };
      } catch (err) {
        loginRateLimiter.recordFailure(rateLimitKey);
        throw new GraphQLError((err as Error).message);
      }
    },
    changeAdminPassword: async (
      _parent: unknown,
      args: { oldPassword: string; newPassword: string },
      context: AdminAuthContext,
    ) => {
      if (!context.currentAdmin) {
        throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
      }
      try {
        const admin = await changePassword(context.currentAdmin.id, args.oldPassword, args.newPassword);
        const record = admin as unknown as AdminRecord;
        const token = signToken(admin._id.toString(), record.passwordChangedAt ?? null);
        return { token, admin: mapAdmin(record) };
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
};
