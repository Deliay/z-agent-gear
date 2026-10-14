import { GraphQLError } from 'graphql';
import type { AdminAuthContext } from './auth.js';

/**
 * 业务 resolver 统一守卫：
 * - 未认证 -> Not authenticated
 * - 已认证但 mustChangePassword=true -> MUST_CHANGE_PASSWORD
 *
 * 白名单（adminLogin / changeAdminPassword / adminMe）位于 auth resolvers，不调用本守卫。
 */
export function assertAdmin(context: AdminAuthContext): void {
  if (!context.currentAdmin) {
    throw new GraphQLError('Not authenticated');
  }
  if (context.currentAdmin.mustChangePassword) {
    throw new GraphQLError('MUST_CHANGE_PASSWORD');
  }
}
