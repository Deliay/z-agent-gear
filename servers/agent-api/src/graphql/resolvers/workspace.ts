import { GraphQLError } from 'graphql';
import { Tenant } from '../../models/tenant.js';
import { Workspace } from '../../models/workspace.js';
import { workspaceService } from '../../services/workspace-service.js';
import { tenantMemberService } from '../../services/tenant-member-service.js';
import { requireTenantAdmin, requireWorkspace, type AuthContext } from './auth.js';
import type { TenantRole } from '../../services/workspace-context.js';

/** 白名单错误文案原样透传（其余按内部错误处理）。 */
const WORKSPACE_ERROR_MESSAGES = new Set([
  'workspace not found',
  'workspace name already exists',
  'global workspace is immutable',
  'global workspace is read-only',
  'personal tenant cannot create workspaces',
  'personal tenant is immutable',
  'workspace is not empty',
  'not a workspace member',
  'not a tenant admin',
  'user is not a tenant member',
  'account not found',
  'already a member',
  'not a member',
  'last admin cannot be removed',
  'last admin cannot be demoted',
]);

function toGraphQLError(err: unknown): never {
  const message = (err as Error).message ?? 'internal error';
  if (WORKSPACE_ERROR_MESSAGES.has(message)) throw new GraphQLError(message);
  throw err;
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

async function toWorkspaceView(
  workspace: Record<string, unknown>,
  viewerUserId: string,
  context: AuthContext,
) {
  const facets = await workspaceService.workspaceFacets(
    workspace as { _id: unknown; tenantId: unknown; type?: string },
    viewerUserId,
  );
  return {
    id: String(workspace._id),
    name: String(workspace.name),
    type: workspace.type === 'global' ? 'global' : 'normal',
    tenant: { ...facets.tenant, memberCount: facets.tenant.memberCount ?? 0 },
    memberCount: facets.memberCount,
    myRole: facets.myRole,
    readOnly: facets.readOnly,
    createdAt: ((workspace.createdAt as Date) ?? new Date()).toISOString(),
  };
}

export const workspaceResolvers = {
  Query: {
    myWorkspaces: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const userId = requireUser(context);
      const accessible = await workspaceService.accessibleWorkspaces(userId);
      return Promise.all(accessible.map((item) => toWorkspaceView(item.workspace as unknown as Record<string, unknown>, userId, context)));
    },
    myTenants: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const userId = requireUser(context);
      const accessible = await workspaceService.accessibleWorkspaces(userId);
      const seen = new Map<string, TenantRole>();
      for (const item of accessible) {
        const tenant = item.workspace.tenantId ? String(item.workspace.tenantId) : '';
        if (tenant && !seen.has(tenant)) seen.set(tenant, item.role);
      }
      const tenants = await Tenant.find({ _id: { $in: [...seen.keys()] } }).lean();
      return tenants.map((tenant) => ({
        tenant: {
          id: String(tenant._id),
          name: tenant.name,
          type: tenant.type,
          memberCount: 0,
        },
        role: seen.get(String(tenant._id)) ?? 'developer',
      }));
    },
    workspaceMembers: async (_parent: unknown, args: { workspaceId: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        return await workspaceService.workspaceMembers(args.workspaceId, userId);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    tenantMembers: async (_parent: unknown, args: { tenantId: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        return await workspaceService.tenantMembers(args.tenantId, userId);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    searchAccounts: async (_parent: unknown, args: { keyword: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        return await tenantMemberService.searchAccounts(userId, args.keyword);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
  },
  Mutation: {
    createTenantWorkspace: async (_parent: unknown, args: { name: string }, context: AuthContext) => {
      const access = requireWorkspace(context);
      requireTenantAdmin(context);
      const userId = requireUser(context);
      try {
        const created = await workspaceService.createWorkspace(userId, access.tenantId, args.name);
        const workspace = await Workspace.findById(created.id).lean();
        return toWorkspaceView(workspace as Record<string, unknown>, userId, context);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    renameTenantWorkspace: async (_parent: unknown, args: { id: string; name: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        const updated = await workspaceService.renameWorkspace(userId, args.id, args.name);
        const workspace = await Workspace.findById(updated.id).lean();
        return toWorkspaceView(workspace as Record<string, unknown>, userId, context);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    deleteTenantWorkspace: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        return await workspaceService.deleteWorkspace(userId, args.id);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    addTenantWorkspaceMember: async (
      _parent: unknown,
      args: { workspaceId: string; userId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        const updated = await workspaceService.addWorkspaceMember(userId, args.workspaceId, args.userId);
        const workspace = await Workspace.findById(updated.id).lean();
        return toWorkspaceView(workspace as Record<string, unknown>, userId, context);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    removeTenantWorkspaceMember: async (
      _parent: unknown,
      args: { workspaceId: string; userId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        const updated = await workspaceService.removeWorkspaceMember(userId, args.workspaceId, args.userId);
        const workspace = await Workspace.findById(updated.id).lean();
        return toWorkspaceView(workspace as Record<string, unknown>, userId, context);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    addTenantMember: async (
      _parent: unknown,
      args: { tenantId: string; username: string; role?: TenantRole },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await tenantMemberService.addTenantMember(userId, args.tenantId, args.username, args.role);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    removeTenantMember: async (
      _parent: unknown,
      args: { tenantId: string; userId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await tenantMemberService.removeTenantMember(userId, args.tenantId, args.userId);
      } catch (err) {
        return toGraphQLError(err);
      }
    },
    changeTenantMemberRole: async (
      _parent: unknown,
      args: { tenantId: string; userId: string; role: TenantRole },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await tenantMemberService.changeTenantMemberRole(
          userId,
          args.tenantId,
          args.userId,
          args.role,
        );
      } catch (err) {
        return toGraphQLError(err);
      }
    },
  },
  Workspace: {
    tenant: async (parent: { tenant?: { id: string } }) => parent.tenant,
  },
  WorkspaceMember: {
    role: (parent: { role?: TenantRole | null }) => parent.role ?? null,
  },
};
