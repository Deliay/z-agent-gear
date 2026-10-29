import mongoose from 'mongoose';
import { Account } from '../models/account.js';
import { User } from '../models/user.js';
import { Tenant } from '../models/tenant.js';
import { TenantMember } from '../models/tenant-member.js';
import { Workspace, GLOBAL_WORKSPACE_NAME, type IWorkspace } from '../models/workspace.js';
import { WorkspaceMember } from '../models/workspace-member.js';
import { Session } from '../models/session.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { CloudHost } from '../models/cloud-host.js';
import { ConfiguredWorkflow } from '../models/configured-workflow.js';
import { WorkflowInstance } from '../models/workflow-instance.js';
import { WorkflowTemplate } from '../models/workflow-template.js';
import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { GitHubAccount } from '../models/github-account.js';
import { UserCommitSetting } from '../models/user-commit-setting.js';
import type { TenantRole, WorkspaceContext } from './workspace-context.js';

/** 错误文案白名单（提案 §3.1，逐字；不新增变体）。 */
export const WORKSPACE_ERRORS = {
  notFound: 'workspace not found',
  nameExists: 'workspace name already exists',
  globalImmutable: 'global workspace is immutable',
  readOnly: 'global workspace is read-only',
  personalCreate: 'personal tenant cannot create workspaces',
  personalImmutable: 'personal tenant is immutable',
  notEmpty: 'workspace is not empty',
  notMember: 'not a workspace member',
  notAdmin: 'not a tenant admin',
  notTenantMember: 'user is not a tenant member',
  accountNotFound: 'account not found',
  alreadyMember: 'already a member',
  notMemberRow: 'not a member',
  lastAdminRemoved: 'last admin cannot be removed',
  lastAdminDemoted: 'last admin cannot be demoted',
} as const;

export interface AccessibleWorkspace {
  workspace: IWorkspace & { _id: mongoose.Types.ObjectId };
  tenantName: string;
  role: TenantRole;
}

export interface WorkspaceView {
  id: string;
  name: string;
  type: 'global' | 'normal';
  tenantId: string;
  createdBy: string | null;
  createdAt: Date;
}

function toView(doc: Record<string, unknown>): WorkspaceView {
  return {
    id: String(doc._id),
    name: String(doc.name),
    type: doc.type === 'global' ? 'global' : 'normal',
    tenantId: String(doc.tenantId),
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    createdAt: (doc.createdAt as Date) ?? new Date(),
  };
}

function audit(action: string, operator: string, tenantId: string, target: string, role?: string): void {
  console.log(
    `[audit] action=${action} operator=${operator} tenant=${tenantId} target=${target} role=${role ?? '-'}`,
  );
}

export class WorkspaceService {
  /**
   * 确保租户的全局工作区与指定用户的 admin 成员行（幂等 upsert）。
   * 唯一语义入口：开户（/internal/users）、team 开通（/internal/tenants）、迁移 015 共用。
   */
  async ensureGlobalWorkspace(
    tenantId: string,
    options: { adminUserId?: string; createdBy?: string } = {},
  ): Promise<WorkspaceView> {
    const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
    let workspace;
    try {
      workspace = await Workspace.findOneAndUpdate(
        { tenantId: tenantObjectId, type: 'global' },
        {
          $setOnInsert: {
            tenantId: tenantObjectId,
            name: GLOBAL_WORKSPACE_NAME,
            type: 'global',
            createdBy: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      // 并发开户：部分唯一索引冲突视为已就绪
      if ((err as { code?: number }).code === 11000) {
        workspace = await Workspace.findOne({ tenantId: tenantObjectId, type: 'global' });
      } else {
        throw err;
      }
    }
    if (!workspace) throw new Error(WORKSPACE_ERRORS.notFound);

    if (options.adminUserId) {
      try {
        await TenantMember.updateOne(
          { tenantId: tenantObjectId, userId: new mongoose.Types.ObjectId(options.adminUserId) },
          {
            $setOnInsert: {
              tenantId: tenantObjectId,
              userId: new mongoose.Types.ObjectId(options.adminUserId),
              role: 'admin',
              createdBy: options.createdBy ?? 'provision',
            },
          },
          { upsert: true },
        );
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    return toView(workspace.toObject() as Record<string, unknown>);
  }

  async getGlobalWorkspace(tenantId: string): Promise<WorkspaceView | null> {
    if (!mongoose.isValidObjectId(tenantId)) return null;
    const workspace = await Workspace.findOne({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      type: 'global',
    }).lean();
    return workspace ? toView(workspace as Record<string, unknown>) : null;
  }

  /** `{userId, tenantId}` 的租户成员关系（含角色）；无行返回 null。 */
  async getMembership(userId: string, tenantId: string) {
    if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(tenantId)) return null;
    return TenantMember.findOne({ userId, tenantId }).lean();
  }

  /** 请求级可访问工作区（admin=租户全部；developer=全局+已加入 normal；personal=自身全局）。 */
  async accessibleWorkspaces(userId: string): Promise<AccessibleWorkspace[]> {
    if (!mongoose.isValidObjectId(userId)) return [];
    const memberships = await TenantMember.find({ userId }).lean();
    if (memberships.length === 0) return [];
    const tenantIds = memberships.map((m) => m.tenantId);
    const [tenants, workspaces, joins] = await Promise.all([
      Tenant.find({ _id: { $in: tenantIds } }).lean(),
      Workspace.find({ tenantId: { $in: tenantIds } }).sort({ type: -1, createdAt: 1 }).lean(),
      WorkspaceMember.find({ userId }).lean(),
    ]);
    const tenantName = new Map(tenants.map((t) => [String(t._id), String(t.name)]));
    const role = new Map(memberships.map((m) => [String(m.tenantId), m.role as TenantRole]));
    const joined = new Set(joins.map((j) => String(j.workspaceId)));

    const result: AccessibleWorkspace[] = [];
    for (const workspace of workspaces) {
      const tenantId = String(workspace.tenantId);
      const memberRole = role.get(tenantId);
      if (!memberRole) continue;
      const isGlobal = workspace.type === 'global';
      if (memberRole === 'admin' || isGlobal || joined.has(String(workspace._id))) {
        result.push({
          workspace: workspace as unknown as AccessibleWorkspace['workspace'],
          tenantName: tenantName.get(tenantId) ?? '',
          role: memberRole,
        });
      }
    }
    return result;
  }

  /** 当前用户对某工作区是否可访问（admin 直通；global 需租户成员；normal 需工作区成员）。 */
  async canAccess(userId: string, workspace: { _id: unknown; tenantId: unknown; type?: string }): Promise<boolean> {
    const membership = await TenantMember.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(String(workspace.tenantId)),
    }).lean();
    if (!membership) return false;
    if (membership.role === 'admin') return true;
    if (workspace.type === 'global') return true;
    const join = await WorkspaceMember.findOne({
      workspaceId: new mongoose.Types.ObjectId(String(workspace._id)),
      userId: new mongoose.Types.ObjectId(userId),
    }).lean();
    return !!join;
  }

  private async requireAdmin(userId: string, tenantId: string): Promise<TenantRole> {
    const membership = await this.getMembership(userId, tenantId);
    if (!membership || membership.role !== 'admin') {
      throw new Error(WORKSPACE_ERRORS.notAdmin);
    }
    return 'admin';
  }

  async createWorkspace(userId: string, tenantId: string, name: string): Promise<WorkspaceView> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error(WORKSPACE_ERRORS.nameExists);
    const tenant = mongoose.isValidObjectId(tenantId) ? await Tenant.findById(tenantId).lean() : null;
    if (!tenant) throw new Error(WORKSPACE_ERRORS.notFound);
    if (tenant.type !== 'team') throw new Error(WORKSPACE_ERRORS.personalCreate);
    await this.requireAdmin(userId, tenantId);
    // 重名前置校验（唯一索引可能尚未建立/关闭 autoIndex 的部署也返回稳定文案）
    const duplicated = await Workspace.findOne({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      name: trimmed,
    })
      .select('_id')
      .lean();
    if (duplicated) throw new Error(WORKSPACE_ERRORS.nameExists);
    try {
      const workspace = await Workspace.create({
        tenantId: new mongoose.Types.ObjectId(tenantId),
        name: trimmed,
        type: 'normal',
        createdBy: new mongoose.Types.ObjectId(userId),
      });
      audit('workspace.create', userId, tenantId, String(workspace._id), 'admin');
      return toView(workspace.toObject() as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error(WORKSPACE_ERRORS.nameExists);
      }
      throw err;
    }
  }

  private async loadWorkspace(id: string) {
    if (!mongoose.isValidObjectId(id)) throw new Error(WORKSPACE_ERRORS.notFound);
    const workspace = await Workspace.findById(id).lean();
    if (!workspace) throw new Error(WORKSPACE_ERRORS.notFound);
    return workspace;
  }

  async renameWorkspace(userId: string, id: string, name: string): Promise<WorkspaceView> {
    const workspace = await this.loadWorkspace(id);
    if (workspace.type === 'global') throw new Error(WORKSPACE_ERRORS.globalImmutable);
    await this.requireAdmin(userId, String(workspace.tenantId));
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new Error(WORKSPACE_ERRORS.nameExists);
    try {
      const updated = await Workspace.findByIdAndUpdate(
        id,
        { $set: { name: trimmed } },
        { new: true, lean: true },
      );
      if (!updated) throw new Error(WORKSPACE_ERRORS.notFound);
      audit('workspace.rename', userId, String(workspace.tenantId), id, 'admin');
      return toView(updated as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error(WORKSPACE_ERRORS.nameExists);
      }
      throw err;
    }
  }

  async deleteWorkspace(userId: string, id: string): Promise<boolean> {
    const workspace = await this.loadWorkspace(id);
    if (workspace.type === 'global') throw new Error(WORKSPACE_ERRORS.globalImmutable);
    await this.requireAdmin(userId, String(workspace.tenantId));
    if (await this.hasResources(id)) throw new Error(WORKSPACE_ERRORS.notEmpty);
    await WorkspaceMember.deleteMany({ workspaceId: id });
    const result = await Workspace.deleteOne({ _id: id, type: 'normal' });
    audit('workspace.delete', userId, String(workspace.tenantId), id, 'admin');
    return result.deletedCount > 0;
  }

  /** 删除保护：11 集合任一持有资源即拒绝（接受与资源创建的既有 TOCTOU 窗口）。 */
  async hasResources(workspaceId: string): Promise<boolean> {
    const objectId = new mongoose.Types.ObjectId(workspaceId);
    const counts = await Promise.all([
      Session.countDocuments({ workspaceId: objectId }),
      Controller.countDocuments({ workspaceId: objectId }),
      ControllerKey.countDocuments({ workspaceId: objectId }),
      CloudHost.countDocuments({ resourceWorkspaceId: objectId }),
      ConfiguredWorkflow.countDocuments({ resourceWorkspaceId: objectId }),
      WorkflowInstance.countDocuments({ resourceWorkspaceId: objectId }),
      WorkflowTemplate.countDocuments({ resourceWorkspaceId: objectId }),
      Provider.countDocuments({ workspaceId: objectId }),
      Model.countDocuments({ workspaceId: objectId }),
      GitHubAccount.countDocuments({ workspaceId }),
      UserCommitSetting.countDocuments({ workspaceId }),
    ]);
    return counts.some((count) => count > 0);
  }

  async addWorkspaceMember(userId: string, workspaceId: string, targetUserId: string): Promise<WorkspaceView> {
    const workspace = await this.loadWorkspace(workspaceId);
    if (workspace.type === 'global') throw new Error(WORKSPACE_ERRORS.globalImmutable);
    await this.requireAdmin(userId, String(workspace.tenantId));
    if (!mongoose.isValidObjectId(targetUserId)) throw new Error(WORKSPACE_ERRORS.notTenantMember);
    const membership = await this.getMembership(targetUserId, String(workspace.tenantId));
    if (!membership) throw new Error(WORKSPACE_ERRORS.notTenantMember);
    try {
      await WorkspaceMember.updateOne(
        { workspaceId: workspace._id, userId: new mongoose.Types.ObjectId(targetUserId) },
        {
          $setOnInsert: {
            workspaceId: workspace._id,
            tenantId: workspace.tenantId,
            userId: new mongoose.Types.ObjectId(targetUserId),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error(WORKSPACE_ERRORS.alreadyMember);
      }
      throw err;
    }
    audit('workspace.member.add', userId, String(workspace.tenantId), targetUserId, 'admin');
    return toView(workspace as Record<string, unknown>);
  }

  async removeWorkspaceMember(
    userId: string,
    workspaceId: string,
    targetUserId: string,
  ): Promise<WorkspaceView> {
    const workspace = await this.loadWorkspace(workspaceId);
    if (workspace.type === 'global') throw new Error(WORKSPACE_ERRORS.globalImmutable);
    await this.requireAdmin(userId, String(workspace.tenantId));
    const result = await WorkspaceMember.deleteOne({
      workspaceId: workspace._id,
      userId: new mongoose.Types.ObjectId(targetUserId),
    });
    if (result.deletedCount === 0) throw new Error(WORKSPACE_ERRORS.notMemberRow);
    audit('workspace.member.remove', userId, String(workspace.tenantId), targetUserId, 'admin');
    return toView(workspace as Record<string, unknown>);
  }

  async workspaceMembers(workspaceId: string, viewerUserId: string) {
    const workspace = await this.loadWorkspace(workspaceId);
    if (workspace.type === 'global') return [];
    if (!(await this.canAccess(viewerUserId, workspace))) {
      throw new Error(WORKSPACE_ERRORS.notMember);
    }
    const rows = await WorkspaceMember.find({ workspaceId: workspace._id })
      .sort({ createdAt: 1 })
      .lean();
    return this.toMemberViews(rows.map((row) => ({ userId: String(row.userId), createdAt: row.createdAt, role: null })));
  }

  async tenantMembers(tenantId: string, viewerUserId: string) {
    if (!mongoose.isValidObjectId(tenantId)) throw new Error(WORKSPACE_ERRORS.notFound);
    const membership = await this.getMembership(viewerUserId, tenantId);
    if (!membership) throw new Error(WORKSPACE_ERRORS.notMember);
    const rows = await TenantMember.find({ tenantId }).sort({ createdAt: 1 }).lean();
    return this.toMemberViews(
      rows.map((row) => ({
        userId: String(row.userId),
        createdAt: row.createdAt,
        role: row.role as TenantRole,
      })),
    );
  }

  private async toMemberViews(
    rows: Array<{ userId: string; createdAt?: Date; role: TenantRole | null }>,
  ) {
    if (rows.length === 0) return [];
    const users = await User.find({ _id: { $in: rows.map((row) => row.userId) } })
      .select('name accountId username')
      .lean();
    const accounts = await Account.find({
      _id: { $in: users.map((user) => user.accountId).filter(Boolean) },
    })
      .select('username')
      .lean();
    const loginByAccount = new Map(accounts.map((account) => [String(account._id), account.username]));
    const userById = new Map(users.map((user) => [String(user._id), user]));
    return rows.map((row) => {
      const user = userById.get(row.userId);
      return {
        id: row.userId,
        name: user?.name || (user as { username?: string } | undefined)?.username || '',
        username:
          (user?.accountId ? loginByAccount.get(String(user.accountId)) : undefined) ??
          (user as { username?: string } | undefined)?.username ??
          '',
        role: row.role,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
      };
    });
  }

  /** `Workspace.tenant/memberCount/myRole/readOnly` 字段 resolver 数据源。 */
  async workspaceFacets(workspace: { _id: unknown; tenantId: unknown; type?: string }, viewerUserId: string) {
    const tenantId = String(workspace.tenantId);
    const [tenant, membership] = await Promise.all([
      Tenant.findById(tenantId).lean(),
      this.getMembership(viewerUserId, tenantId),
    ]);
    const role: TenantRole = (membership?.role as TenantRole) ?? (tenant?.type === 'personal' ? 'admin' : 'developer');
    const isGlobal = workspace.type === 'global';
    const memberCount = isGlobal
      ? await TenantMember.countDocuments({
          tenantId: new mongoose.Types.ObjectId(tenantId),
        })
      : await WorkspaceMember.countDocuments({
          workspaceId: new mongoose.Types.ObjectId(String(workspace._id)),
        });
    return {
      tenant: tenant
        ? { id: String(tenant._id), name: tenant.name, type: tenant.type }
        : { id: tenantId, name: '', type: 'personal', memberCount: 0 },
      memberCount,
      myRole: role,
      readOnly: isGlobal && role === 'developer',
    };
  }

  /** 由 `x-workspace-id` 解析后的上下文访问对象（供 resolver 显式取用）。 */
  toAccess(context: WorkspaceContext) {
    return {
      id: context.id,
      tenantId: context.tenantId,
      type: context.type,
      role: context.role,
      readOnly: context.readOnly,
    };
  }

  /**
   * MCP / 内部链路：经 sessionId 反查会话所属租户工作区，构造请求级上下文（F11）。
   * 无会话/工作区/成员关系时返回 undefined（不注入、不校验，与无 store 口径一致）。
   */
  async buildSessionWorkspaceContext(
    sessionId: string | undefined,
    userId: string | undefined,
  ): Promise<WorkspaceContext | undefined> {
    if (!sessionId || !mongoose.isValidObjectId(sessionId) || !userId) return undefined;
    const session = await Session.findById(sessionId).select('workspaceId userId').lean();
    if (!session?.workspaceId) return undefined;
    const workspace = await Workspace.findById(session.workspaceId).lean();
    if (!workspace) return undefined;
    const tenantId = String(workspace.tenantId);
    const membership = await TenantMember.findOne({
      tenantId: workspace.tenantId,
      userId: new mongoose.Types.ObjectId(userId),
    }).lean();
    if (!membership) return undefined;
    const role = (membership.role as TenantRole) ?? 'developer';
    const type = workspace.type === 'global' ? 'global' : 'normal';
    if (role !== 'admin' && type === 'normal') {
      const join = await WorkspaceMember.findOne({
        workspaceId: workspace._id,
        userId: new mongoose.Types.ObjectId(userId),
      }).lean();
      if (!join) return undefined;
    }
    const global = await Workspace.findOne({ tenantId: workspace.tenantId, type: 'global' })
      .select('_id')
      .lean();
    return {
      id: String(workspace._id),
      tenantId,
      type,
      role,
      readOnly: type === 'global' && role === 'developer',
      globalWorkspaceId: global ? String(global._id) : String(workspace._id),
    };
  }
}

export const workspaceService = new WorkspaceService();
