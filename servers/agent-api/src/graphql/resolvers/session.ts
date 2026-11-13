import { GraphQLError } from 'graphql';
import path from 'path';
import { sessionService } from '../../services/session.js';
import { sessionImportService } from '../../services/session-import.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { modelService } from '../../services/model.js';
import { featuresFromSnapshot } from '../../services/agent-capabilities.js';
import { inferModelSource } from '../../services/model-source.js';
import { cloudHostService } from '../../services/cloud-host-service.js';
import { sessionReviewService } from '../../services/session-review-service.js';
import { sessionInteractionService } from '../../services/session-interaction-service.js';
import { Controller } from '../../models/controller.js';
import { CloudHost } from '../../models/cloud-host.js';
import { Session } from '../../models/session.js';
import { actorFilter } from '../../services/workspace-context.js';
import { getRedisClient } from '../../middleware/redis.js';
import { publish } from '../../middleware/publish.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

/** sessionFileContent 轮询口径（裁决 4）：500ms × 30 ≈ 15s */
const FILE_CONTENT_POLL_INTERVAL_MS = 500;
const FILE_CONTENT_POLL_ATTEMPTS = 30;
const FILE_CONTENT_TIMEOUT_MESSAGE = 'Controller offline or file read timeout';
/** 错误文案白名单（裁决 12） */
const FILE_CONTENT_ERROR_WHITELIST = new Set([
  'file too large',
  'binary file',
  'not found',
  'permission denied',
]);

/**
 * 会话文件读取（fs:read-file relay）：路径守卫（裁决 12，与 controller 白名单双保险）+
 * 发布 session:command + 轮询 Redis `fs:read-file:{requestId}`。只读会话允许读取。
 */
async function fetchSessionFileContent(
  session: Doc,
  rawPath: string,
): Promise<{ path: string; content: string; truncated: boolean; sizeBytes: number }> {
  const root = path.resolve(String(session.worktreePath ?? session.cwd ?? ''));
  const absPath = path.resolve(root, rawPath);
  const rel = path.relative(root, absPath);
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (outside) {
    throw new GraphQLError('path out of session workspace', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const display = rel.split(path.sep).join('/');
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const redis = getRedisClient();
  await publish('session:command', {
    type: 'fs:read-file',
    requestId,
    controllerId: String(session.controllerId),
    path: absPath,
  });
  for (let i = 0; i < FILE_CONTENT_POLL_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, FILE_CONTENT_POLL_INTERVAL_MS));
    const raw = await redis.get(`fs:read-file:${requestId}`);
    if (!raw) continue;
    let parsed: {
      success?: boolean;
      content?: string;
      truncated?: boolean;
      sizeBytes?: number;
      error?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      break;
    }
    if (parsed.success) {
      return {
        path: display,
        content: parsed.content ?? '',
        truncated: Boolean(parsed.truncated),
        sizeBytes: Number(parsed.sizeBytes ?? 0),
      };
    }
    const message = typeof parsed.error === 'string' && FILE_CONTENT_ERROR_WHITELIST.has(parsed.error)
      ? parsed.error
      : 'not found';
    throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  throw new GraphQLError(FILE_CONTENT_TIMEOUT_MESSAGE, { extensions: { code: 'BAD_USER_INPUT' } });
}

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
    /**
     * 统一只读原因（D5：与写路径同一判定函数的只读版，实时计算不落库）。
     * 三场景：控制器缺失 / 项目工作区缺失 / 云电脑终态；null=可写。
     * **必须落在 `sessionResolvers.Session` 内**（`resolvers/index.ts` spread 登记，backend-rules 陷阱）。
     */
    readOnlyReason: async (
      parent: Doc,
      _args: unknown,
      context: AuthContext,
    ) => {
      const userId = context.currentUser?.id;
      if (!userId) return null;
      return sessionService.resolveSessionReadOnlyReason(parent, userId);
    },
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
      args: { controllerId?: string; includeWorkflowSessions?: boolean; archived?: boolean },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.findAllByUser(context.currentUser.id, {
        controllerId: args.controllerId,
        includeWorkflowSessions: args.includeWorkflowSessions,
        archived: args.archived,
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
    sessionInteractions: async (
      _parent: unknown,
      args: { sessionId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      // 归属校验与 sessionMessages 同口径（sessionService 内 actorFilter）；只读会话允许查看
      const session = await sessionService.findById(args.sessionId, context.currentUser.id);
      if (!session) {
        throw new GraphQLError('Session not found');
      }
      return sessionInteractionService.listBySession(args.sessionId);
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
    sessionReview: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionReviewService.findById(context.currentUser.id, args.id);
    },
    sessionReviews: async (
      _parent: unknown,
      args: { status?: string; sessionId?: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionReviewService.listByUser(context.currentUser.id, {
        status: args.status,
        sessionId: args.sessionId,
      });
    },
    sessionFileContent: async (
      _parent: unknown,
      args: { sessionId: string; path: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const userId = context.currentUser.id;
      // 归属校验（非归属 Session not found）；只读会话允许读取（预览场景）
      const session = await Session.findOne({ _id: args.sessionId, ...actorFilter(userId) }).lean();
      if (!session) {
        throw new GraphQLError('Session not found');
      }
      return fetchSessionFileContent(session as unknown as Doc, args.path);
    },
  },
  Mutation: {
    createSession: async (
      _parent: unknown,
      args: { input: { controllerId: string; acpServerType: string; workspaceId: string; enableWorktree?: boolean; worktreeBranchSuffix?: string; existingWorktreePath?: string; mcpServerIds?: string[] | null; customMcpServerIds?: string[] | null; modeId?: string | null; modelId?: string | null } },
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
          // 自定义 MCP：与 mcpServerIds 正交（缺省/[]均不注入，null 归一 undefined）
          customMcpServerIds: args.input.customMcpServerIds ?? undefined,
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
    // 归档/取消归档（D1：仅分组展示差异；工作流节点会话拒绝 ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED）
    archiveSession: async (
      _parent: unknown,
      args: { id: string; archived: boolean },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionService.setArchived(context.currentUser.id, args.id, args.archived);
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        throw new GraphQLError((err as Error).message);
      }
    },
    // 删除工作区影响预查询：连带归档的普通会话数（与实际连带归档共用同一匹配函数）
    workspaceArchiveImpact: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const userId = context.currentUser.id;
      const workspace = await controllerWorkspaceService.findById(args.id, userId);
      if (!workspace) {
        throw new GraphQLError('Workspace not found');
      }
      const matched = await sessionService.matchWorkspaceSessions(
        {
          _id: workspace.id,
          controllerId: workspace.controllerId,
          path: workspace.path,
          name: workspace.name,
        },
        userId,
      );
      return { sessionCount: matched.filter((doc) => !doc.archivedAt).length };
    },
    sendSessionMessage: async (
      _parent: unknown,
      args: {
        sessionId: string;
        content: string;
        type: string;
        parts?: Array<{ type: string; text?: string; data?: string; mimeType?: string; name?: string }>;
      },
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
        ...(args.parts && args.parts.length > 0 ? { parts: args.parts } : {}),
      });
    },
    submitSessionReview: async (
      _parent: unknown,
      args: {
        id: string;
        input: { fileReviews: Record<string, unknown>; comment?: string; status: 'approve' | 'reject' | 'comment' };
      },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionReviewService.submit(context.currentUser.id, args.id, {
          fileReviews: args.input.fileReviews,
          comment: args.input.comment,
          status: args.input.status,
        });
      } catch (err) {
        // wrap() 同口径：错误文案原样透传（Review not found or already resolved）
        throw new GraphQLError((err as Error).message);
      }
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
