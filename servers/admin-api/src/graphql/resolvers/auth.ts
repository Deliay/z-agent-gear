import { GraphQLError } from 'graphql';
import { AdminUser } from '../../models/admin-user.js';
import { AuthProvider } from '../../models/auth-provider.js';
import { login, changePassword, signToken } from '../../services/auth.js';
import { authProviderService } from '../../services/auth-provider.js';
import { adminExternalLoginService } from '../../services/admin-external-login.js';
import { consumeLoginTicket, issueBindTicket } from '../../services/auth-ticket.js';
import { assertAdmin } from './guard.js';
import {
  loginRateLimiter,
  usernameLoginRateLimiter,
  LoginRateLimitError,
} from '../../services/login-rate-limiter.js';

export interface AdminAuthContext {
  currentAdmin: {
    id: string;
    username: string;
    mustChangePassword: boolean;
  } | null;
  /** 客户端 IP（默认取底层 socket 对端地址，TRUST_PROXY 时取受信代理末跳）；用于登录失败限速 key。 */
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
    // 免登录：登录页第三方按钮前置查询（仅 enabled 且 enableAdminLogin）
    adminAuthProviders: async () => authProviderService.listForSurface('admin'),
    // 需管理员登录：本人已绑定的外部身份
    adminExternalLogins: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return adminExternalLoginService.listByAdmin(context.currentAdmin!.id);
    },
  },
  Mutation: {
    adminLogin: async (
      _parent: unknown,
      args: { username: string; password: string },
      context?: AdminAuthContext,
    ) => {
      // 问题 49：双重限速——按 `ip:username`（阈值低）+ 按 `username` 全局（阈值高，兜底换 IP 绕过）。
      // clientIp 为空（无法确定对端）时跳过按 IP 限速，绝不使用共享 `unknown` 桶造成锁定 DoS。
      const username = args.username;
      const ip = context?.clientIp?.trim();
      const ipKey = ip ? `${ip}:${username}` : null;
      const usernameKey = `username:${username}`;
      try {
        if (ipKey) loginRateLimiter.assertAllowed(ipKey);
        usernameLoginRateLimiter.assertAllowed(usernameKey);
      } catch (err) {
        if (err instanceof LoginRateLimitError) {
          throw new GraphQLError(err.message, { extensions: { code: err.code } });
        }
        throw err;
      }

      try {
        const admin = await login(username, args.password);
        if (ipKey) loginRateLimiter.recordSuccess(ipKey);
        usernameLoginRateLimiter.recordSuccess(usernameKey);
        const record = admin as unknown as AdminRecord;
        const token = signToken(admin._id.toString(), record.passwordChangedAt ?? null);
        return { token, admin: mapAdmin(record) };
      } catch (err) {
        if (ipKey) loginRateLimiter.recordFailure(ipKey);
        usernameLoginRateLimiter.recordFailure(usernameKey);
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
    // 免登录：一次性登录票据兑换（GETDEL 60s）
    adminExchangeLoginTicket: async (_parent: unknown, args: { ticket: string }) => {
      const payload = await consumeLoginTicket(args.ticket);
      if (!payload || !payload.token || !payload.admin) {
        throw new GraphQLError('invalid or expired ticket', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      return { token: payload.token, admin: payload.admin };
    },
    createAdminBindTicket: async (
      _parent: unknown,
      args: { providerId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const provider = await AuthProvider.findById(args.providerId)
        .select('type enabled enableAdminLogin')
        .lean() as { enabled?: boolean; enableAdminLogin?: boolean } | null;
      if (!provider || !provider.enabled || !provider.enableAdminLogin) {
        throw new GraphQLError('该登录方式未启用后台登录', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      return issueBindTicket({
        adminUserId: context.currentAdmin!.id,
        providerId: args.providerId,
      });
    },
    unbindAdminExternalLogin: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return adminExternalLoginService.unbind(context.currentAdmin!.id, args.id);
    },
  },
};
