import { GraphQLError } from 'graphql';
import { sessionService } from '../../services/session.js';
import { sessionImportService } from '../../services/session-import.js';
import { modelService } from '../../services/model.js';
import { featuresFromSnapshot } from '../../services/agent-capabilities.js';
import { inferModelSource } from '../../services/model-source.js';
import { cloudHostService } from '../../services/cloud-host-service.js';
import { Controller } from '../../models/controller.js';
import { CloudHost } from '../../models/cloud-host.js';
import { actorFilter } from '../../services/workspace-context.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

export const sessionResolvers = {
  Session: {
    /** D-1：只读判定不依赖 controllers 列表命中（软删除后列表会过滤该 Controller）。 */
    controllerType: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const userId = context.currentUser?.id;
      if (!userId) return null;
      // 工作区上下文内按工作区可见集查询（团队租户可查看他人创建的控制器）；
      // 无上下文（引擎/内部/迁移）仍回退 userId 归属校验。
      const controller = await Controller.findOne({
        _id: parent.controllerId,
        ...actorFilter(userId),
      }).lean();
      return controller?.type ?? null;
    },
    cloudHost: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const userId = context.currentUser?.id;
      if (!userId) return null;
      const controller = await Controller.findOne({
        _id: parent.controllerId,
        ...actorFilter(userId),
      }).lean();
      if (controller?.type !== 'cloud') return null;
      // 不过滤 deletedAt：软删除后仍需返回留档对象供前端只读判定。
      const host = await CloudHost.findOne({
        controllerId: String(parent.controllerId),
        ...actorFilter(userId),
      }).lean();
      if (!host) return null;
      return cloudHostService.mapCloudHost(host as Doc, 0);
    },
    agentCapabilities: (session: Record<string, unknown>) => session.agentCapabilities ?? null,
    features: (session: Record<string, unknown>) => featuresFromSnapshot(session.agentCapabilities),
    availableModels: async (
      session: Record<string, unknown>,
      _args: unknown,
      context: AuthContext,
    ) => {
      const models = (session.availableModels ?? []) as Array<{
        id: string;
        name: string;
        provider?: string | null;
      }>;
      if (models.length === 0) return [];
      // 同一 GraphQL 请求内只查一次平台库（sessions 列表 N 条会话共享）
      context.modelLibraryPromise ??= modelService.listSourceLibrary();
      const library = await context.modelLibraryPromise;
      return models.map((model) => ({
        ...model,
        provider: model.provider ?? null,
        ...inferModelSource(model, library),
      }));
    },
  },
  Query: {
    sessions: async (
      _parent: unknown,
      args: { controllerId?: string; includeWorkflowSessions?: boolean },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.findAllByUser(context.currentUser.id, {
        controllerId: args.controllerId,
        includeWorkflowSessions: args.includeWorkflowSessions,
      });
    },
    session: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.findById(args.id, context.currentUser.id);
    },
    sessionMessages: async (
      _parent: unknown,
      args: { sessionId: string; before?: string; limit?: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getMessages(
        args.sessionId,
        context.currentUser.id,
        { before: args.before, limit: args.limit },
      );
    },
    acpCapabilities: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getAcpCapabilities(args.controllerId, context.currentUser.id);
    },
    acpServerOptions: async (
      _parent: unknown,
      args: { controllerId: string; acpServerType: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getAcpServerOptions(
        args.controllerId,
        args.acpServerType,
        context.currentUser.id,
      );
    },
    listHistorySessions: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string; acpServerType?: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionImportService.listHistorySessions(
          context.currentUser.id,
          args.controllerId,
          args.workspaceId,
          args.acpServerType ?? 'opencode',
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
  Mutation: {
    createSession: async (
      _parent: unknown,
      args: { input: { controllerId: string; acpServerType: string; workspaceId: string; enableWorktree?: boolean; worktreeBranchSuffix?: string; existingWorktreePath?: string; mcpServerIds?: string[] | null; modeId?: string | null; modelId?: string | null } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        // D7：显式传 mcpServerIds（含 []）由调用方决定；未传/传 null 时按控制器 defaultMcp 解析。
        const explicitMcpServerIds =
          Object.prototype.hasOwnProperty.call(args.input, 'mcpServerIds') &&
          args.input.mcpServerIds !== null &&
          args.input.mcpServerIds !== undefined
            ? args.input.mcpServerIds
            : undefined;
        const session = await sessionService.create(context.currentUser.id, {
          controllerId: args.input.controllerId,
          acpServerType: args.input.acpServerType,
          workspaceId: args.input.workspaceId,
          enableWorktree: args.input.enableWorktree,
          worktreeBranchSuffix: args.input.worktreeBranchSuffix ?? undefined,
          existingWorktreePath: args.input.existingWorktreePath ?? undefined,
          mcpServerIds: explicitMcpServerIds,
          modeId: args.input.modeId ?? undefined,
          modelId: args.input.modelId ?? undefined,
        });
        return { session };
      } catch (err) {
        if (err instanceof GraphQLError) {
          throw err;
        }
        if ((err as Error).message === 'Controller not found') {
          throw new GraphQLError('Controller not found');
        }
        if ((err as Error).message === 'Workspace not found') {
          throw new GraphQLError('Workspace not found');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    closeSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.close(args.id, context.currentUser.id);
    },
    deleteSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.delete(args.id, context.currentUser.id);
    },
    deleteHistorySession: async (
      _parent: unknown,
      args: { sessionId: string; syncAgent?: boolean },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionImportService.deleteHistorySession(
          context.currentUser.id,
          args.sessionId,
          args.syncAgent ?? true,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    sendSessionMessage: async (
      _parent: unknown,
      args: { sessionId: string; content: string; type: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      // Verify session belongs to user
      const session = await sessionService.findById(args.sessionId, context.currentUser.id);
      if (!session) {
        throw new GraphQLError('Session not found');
      }
      // A-2/B15：云电脑停止/软删除后会话只读，拒绝续写消息。
      try {
        await sessionService.assertSessionWritable(args.sessionId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
      return sessionService.addMessage(args.sessionId, {
        direction: 'input',
        type: args.type,
        content: args.content,
      });
    },
    cancelGeneration: async (
      _parent: unknown,
      args: { sessionId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.cancelGeneration(args.sessionId, context.currentUser.id);
    },
    resumeSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.resume(args.id, context.currentUser.id);
    },
    setSessionMode: async (
      _parent: unknown,
      args: { sessionId: string; modeId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setMode(args.sessionId, context.currentUser.id, args.modeId);
    },
    setSessionModel: async (
      _parent: unknown,
      args: { sessionId: string; modelId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setModel(args.sessionId, context.currentUser.id, args.modelId);
    },
    setSessionConfigOption: async (
      _parent: unknown,
      args: { sessionId: string; configId: string; value: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setConfigOption(args.sessionId, context.currentUser.id, args.configId, args.value);
    },
    importHistorySessions: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string; acpServerType?: string; sessionIds: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const controller = await Controller.findOne({ _id: args.controllerId, ...actorFilter(context.currentUser.id) }).lean();
        const controllerName = controller?.name || 'Unknown';

        return await sessionImportService.importSessions(
          context.currentUser.id,
          args.controllerId,
          controllerName,
          args.workspaceId,
          args.sessionIds,
          args.acpServerType ?? 'opencode',
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    refreshAcpCapabilities: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionService.refreshAcpCapabilities(args.controllerId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    refreshAcpServerOptions: async (
      _parent: unknown,
      args: { controllerId: string; acpServerType: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionService.refreshAcpServerOptions(
          args.controllerId,
          args.acpServerType,
          context.currentUser.id,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
};
