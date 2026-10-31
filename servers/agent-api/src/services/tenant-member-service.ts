import mongoose from 'mongoose';
import { logger as rootLogger } from '../observability/logger.js';
import { Account } from '../models/account.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';
import { TenantMember } from '../models/tenant-member.js';
import { WorkspaceMember } from '../models/workspace-member.js';
import { TENANT_ROLES, type TenantRole } from './workspace-context.js';
import { WORKSPACE_ERRORS, workspaceService } from './workspace-service.js';

export interface AccountSummaryView {
  username: string;
  name: string;
  userId: string;
}

export interface TenantMemberView {
  id: string;
  name: string;
  username: string;
  role: TenantRole;
  createdAt: string;
}

function audit(action: string, operator: string, tenantId: string, target: string, role?: string): void {
  rootLogger.info(
    { component: 'audit', action, operator, tenantId, target, role: role ?? null },
    'tenant member audit',
  );
}

function normalizeRole(value: unknown): TenantRole {
  if (value === undefined || value === null) return 'developer';
  if (typeof value !== 'string' || !(TENANT_ROLES as readonly string[]).includes(value)) {
    throw new Error('invalid tenant role');
  }
  return value as TenantRole;
}

/**
 * 租户成员与角色的唯一写方（多租户二期，裁决 12）。
 *
 * - `searchAccounts`：按登录名模糊搜索 accounts，限「在任一 team 租户为 admin」的用户，
 *   结果仅 `username/name/userId` 最小集（D13）；
 * - `addTenantMember` / `removeTenantMember` / `changeTenantMemberRole`：仅本租户 admin，
 *   personal 租户一切写操作拒绝，last-admin 保护（前置计数 + 变更后复检回滚兜底）；
 * - 移除成员级联清理其本租户全部 workspacemembers 行（资源保留原工作区）；
 * - 结构化审计日志（裁决 17）。
 */
export class TenantMemberService {
  private async requireAdmin(operatorId: string, tenantId: string): Promise<void> {
    const membership = await workspaceService.getMembership(operatorId, tenantId);
    if (!membership || membership.role !== 'admin') {
      throw new Error(WORKSPACE_ERRORS.notAdmin);
    }
  }

  private async requireTeamTenant(tenantId: string) {
    if (!mongoose.isValidObjectId(tenantId)) throw new Error(WORKSPACE_ERRORS.notFound);
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) throw new Error(WORKSPACE_ERRORS.notFound);
    if (tenant.type !== 'team') throw new Error(WORKSPACE_ERRORS.personalImmutable);
    return tenant;
  }

  async searchAccounts(operatorId: string, keyword: string): Promise<AccountSummaryView[]> {
    const memberships = await TenantMember.find({ userId: operatorId, role: 'admin' }).lean();
    const adminTeamIds = memberships.map((m) => m.tenantId);
    const teams = adminTeamIds.length
      ? await Tenant.find({ _id: { $in: adminTeamIds }, type: 'team' }).select('_id').lean()
      : [];
    if (teams.length === 0) throw new Error(WORKSPACE_ERRORS.notAdmin);

    const trimmed = (keyword ?? '').trim();
    if (!trimmed) return [];
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const accounts = await Account.find({ username: { $regex: escaped, $options: 'i' } })
      .limit(20)
      .lean();
    if (accounts.length === 0) return [];
    const users = await User.find({ accountId: { $in: accounts.map((account) => account._id) } })
      .select('name accountId username')
      .lean();
    const userByAccount = new Map(users.map((user) => [String(user.accountId), user]));
    return accounts
      .map((account) => {
        const user = userByAccount.get(String(account._id));
        if (!user) return null;
        return {
          username: account.username,
          name: user.name || (user as { username?: string }).username || '',
          userId: String(user._id),
        };
      })
      .filter((row): row is AccountSummaryView => !!row);
  }

  async addTenantMember(
    operatorId: string,
    tenantId: string,
    username: string,
    role?: TenantRole | string | null,
    skipPermissionCheck = false,
  ): Promise<TenantMemberView> {
    await this.requireTeamTenant(tenantId);
    if (!skipPermissionCheck) await this.requireAdmin(operatorId, tenantId);
    const normalizedRole = normalizeRole(role);

    const account = await Account.findOne({ username: (username ?? '').trim() }).lean();
    if (!account) throw new Error(WORKSPACE_ERRORS.accountNotFound);
    const user = await User.findOne({ accountId: account._id }).lean();
    if (!user) throw new Error(WORKSPACE_ERRORS.accountNotFound);

    const existing = await TenantMember.findOne({ tenantId, userId: user._id }).lean();
    if (existing) {
      // 幂等：已是成员不覆盖既有角色
      return this.toMemberView(user._id, account.username, user.name ?? '', existing.role as TenantRole);
    }

    try {
      await TenantMember.create({
        tenantId: new mongoose.Types.ObjectId(tenantId),
        userId: user._id,
        role: normalizedRole,
        createdBy: operatorId,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error(WORKSPACE_ERRORS.alreadyMember);
      }
      throw err;
    }
    audit('tenant.member.add', operatorId, tenantId, String(user._id), normalizedRole);
    return this.toMemberView(user._id, account.username, user.name ?? '', normalizedRole);
  }

  async removeTenantMember(
    operatorId: string,
    tenantId: string,
    targetUserId: string,
    skipPermissionCheck = false,
  ): Promise<boolean> {
    await this.requireTeamTenant(tenantId);
    if (!skipPermissionCheck) await this.requireAdmin(operatorId, tenantId);
    if (!mongoose.isValidObjectId(targetUserId)) throw new Error(WORKSPACE_ERRORS.notMemberRow);
    const target = await TenantMember.findOne({ tenantId, userId: targetUserId }).lean();
    if (!target) throw new Error(WORKSPACE_ERRORS.notMemberRow);

    if (target.role === 'admin') {
      const adminCount = await TenantMember.countDocuments({ tenantId, role: 'admin' });
      if (adminCount <= 1) throw new Error(WORKSPACE_ERRORS.lastAdminRemoved);
    }

    const result = await TenantMember.deleteOne({ _id: target._id });
    if (result.deletedCount === 0) throw new Error(WORKSPACE_ERRORS.notMemberRow);
    // 级联清理本租户全部工作区成员行；资源保留原工作区
    await WorkspaceMember.deleteMany({ tenantId, userId: targetUserId });
    // 并发兜底：仅在移除管理员时复检（若已无 admin 则回滚）
    if (target.role === 'admin') {
      const adminLeft = await TenantMember.countDocuments({ tenantId, role: 'admin' });
      if (adminLeft === 0) {
        await TenantMember.create({
          tenantId: new mongoose.Types.ObjectId(tenantId),
          userId: target.userId,
          role: 'admin',
          createdBy: 'rollback',
        });
        throw new Error(WORKSPACE_ERRORS.lastAdminRemoved);
      }
    }
    audit('tenant.member.remove', operatorId, tenantId, targetUserId);
    return true;
  }

  async changeTenantMemberRole(
    operatorId: string,
    tenantId: string,
    targetUserId: string,
    role: TenantRole | string,
    skipPermissionCheck = false,
  ): Promise<TenantMemberView> {
    await this.requireTeamTenant(tenantId);
    if (!skipPermissionCheck) await this.requireAdmin(operatorId, tenantId);
    const normalizedRole = normalizeRole(role);
    if (!mongoose.isValidObjectId(targetUserId)) throw new Error(WORKSPACE_ERRORS.notMemberRow);

    const target = await TenantMember.findOne({ tenantId, userId: targetUserId }).lean();
    if (!target) throw new Error(WORKSPACE_ERRORS.notMemberRow);

    if (target.role === 'admin' && normalizedRole === 'developer') {
      const adminCount = await TenantMember.countDocuments({ tenantId, role: 'admin' });
      if (adminCount <= 1) throw new Error(WORKSPACE_ERRORS.lastAdminDemoted);
    }

    await TenantMember.updateOne(
      { _id: target._id },
      { $set: { role: normalizedRole, createdBy: operatorId } },
    );
    const adminLeft = await TenantMember.countDocuments({ tenantId, role: 'admin' });
    if (adminLeft === 0) {
      await TenantMember.updateOne({ _id: target._id }, { $set: { role: 'admin' } });
      throw new Error(WORKSPACE_ERRORS.lastAdminDemoted);
    }

    const user = await User.findById(targetUserId).select('name accountId username').lean();
    const account = user?.accountId ? await Account.findById(user.accountId).select('username').lean() : null;
    audit('tenant.member.role_change', operatorId, tenantId, targetUserId, normalizedRole);
    return this.toMemberView(
      target.userId,
      account?.username ?? (user as { username?: string } | null)?.username ?? '',
      user?.name ?? '',
      normalizedRole,
    );
  }

  private toMemberView(
    userId: unknown,
    username: string,
    name: string,
    role: TenantRole,
  ): TenantMemberView {
    return {
      id: String(userId),
      name,
      username,
      role,
      createdAt: new Date().toISOString(),
    };
  }
}

export const tenantMemberService = new TenantMemberService();
