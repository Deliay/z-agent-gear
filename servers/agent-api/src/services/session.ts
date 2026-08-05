import mongoose from 'mongoose';
import path from 'path';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { McpServer } from '../models/mcp-server.js';
import { mcpEndpointService } from './mcp-endpoint.js';

export class SessionService {
  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    const sessions = await Session.find({ userId }).sort({ createdAt: -1 }).lean();
    return sessions.map(this.mapSession.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) return null;
    return this.mapSession(session);
  }

  async create(userId: string, input: {
    controllerId: string;
    acpServerType: string;
    workspaceId: string;
    enableWorktree?: boolean;
    worktreeBranchSuffix?: string;
    mcpServerIds?: string[];
  }): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: input.controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const workspace = await ControllerWorkspace.findOne({ _id: input.workspaceId, userId, controllerId: input.controllerId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    let cwd = workspace.path;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    const redis = getRedisClient();

    if (input.enableWorktree && input.worktreeBranchSuffix && workspace.name) {
      const worktreeDir = (controller as any).worktreeDir || '~/.zag/worktrees';
      const branch = `${workspace.name}/${input.worktreeBranchSuffix}`;
      const wtPath = path.join(worktreeDir, workspace.name, input.worktreeBranchSuffix);

      const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:worktree:add',
        requestId,
        controllerId: input.controllerId,
        repoPath: workspace.path,
        worktreePath: wtPath,
        branch,
      }));

      let added = false;
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:worktree:add:${requestId}`);
        if (result) {
          const parsed = JSON.parse(result);
          if (!parsed.success) {
            throw new Error(`WORKTREE_ADD_FAILED: ${parsed.error}`);
          }
          await redis.del(`git:worktree:add:${requestId}`);
          const resolvedPath = parsed.worktreePath || wtPath;
          cwd = resolvedPath;
          worktreePath = resolvedPath;
          worktreeBranch = branch;
          added = true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!added) {
        throw new Error('WORKTREE_ADD_FAILED: Timeout waiting for git worktree add');
      }
    }

    // Validate selected MCP servers up front so an invalid selection fails the
    // mutation instead of silently creating a session without MCP.
    if (input.mcpServerIds && input.mcpServerIds.length > 0) {
      const selectable = await McpServer.countDocuments({
        _id: { $in: input.mcpServerIds },
        userId,
        enabled: true,
      });
      if (selectable !== input.mcpServerIds.length) {
        throw new Error('MCP_SERVER_NOT_FOUND: some selected MCP servers are invalid or disabled');
      }
    }

    const session = await Session.create({
      userId,
      controllerId: input.controllerId,
      controllerName: controller.name,
      acpServerType: input.acpServerType as 'opencode',
      status: 'creating',
      cwd,
      worktreePath,
      worktreeBranch,
    });

    // Create MCP endpoint if mcpServerIds provided (user explicitly selected MCP servers)
    let mcpEndpoint: { url: string; token: string; serverNames: string[] } | undefined;
    if (input.mcpServerIds && input.mcpServerIds.length > 0) {
      try {
        mcpEndpoint = await mcpEndpointService.createEndpoint(
          session._id.toString(),
          userId,
          input.mcpServerIds,
        );
      } catch (err) {
        console.error('Failed to create MCP endpoint:', err instanceof Error ? err.message : err);
      }
    }

    // Notify controller-api to start ACP session via Redis Pub/Sub
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:start',
      sessionId: session._id.toString(),
      controllerId: input.controllerId,
      serverType: input.acpServerType,
      cwd,
      mcpEndpoint,
    }));

    return this.mapSession(session.toObject());
  }

  async updateStatus(id: string, userId: string, status: string, externalSessionId?: string): Promise<boolean> {
    const updateData: Record<string, unknown> = { status };
    if (externalSessionId) {
      updateData.externalSessionId = externalSessionId;
    }
    if (status === 'ended') {
      updateData.endedAt = new Date();
    }

    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      updateData,
      { new: true },
    );

    if (result) {
      // Update Redis cache
      const redis = getRedisClient();
      await redis.set(`session:${id}:status`, status);
      if (status === 'ended') {
        await redis.del(`session:${id}:status`);
      }
    }

    return !!result;
  }

  async setMode(sessionId: string, userId: string, modeId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-mode',
      sessionId,
      modeId,
    }));
    return true;
  }

  async setModel(sessionId: string, userId: string, modelId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-model',
      sessionId,
      modelId,
    }));
    return true;
  }

  async setConfigOption(sessionId: string, userId: string, configId: string, value: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;
    const configOptions = (session as Record<string, unknown>).configOptions as unknown[] | undefined;
    if (!configOptions || configOptions.length === 0) return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-config-option',
      sessionId,
      configId,
      value,
    }));
    return true;
  }

  async cancelGeneration(sessionId: string, userId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:cancel',
      sessionId,
    }));
    return true;
  }

  async resume(id: string, userId: string): Promise<{ success: boolean; status: string; error?: string }> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) {
      return { success: false, status: 'ended', error: 'Session not found' };
    }
    if (session.status !== 'ended') {
      return { success: false, status: session.status, error: 'Session is not ended' };
    }

    // Re-issue a fresh MCP endpoint (do not reuse the revoked token)
    let mcpEndpoint: { url: string; token: string; serverNames: string[] } | undefined;
    try {
      const reissued = await mcpEndpointService.reissueEndpoint(id, userId);
      if (reissued) mcpEndpoint = reissued;
    } catch (err) {
      console.error('Failed to reissue MCP endpoint on resume:', err instanceof Error ? err.message : err);
    }

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:resume',
      sessionId: id,
      controllerId: session.controllerId.toString(),
      externalSessionId: session.externalSessionId || '',
      cwd: session.cwd || '',
      mcpEndpoint,
    }));
    return { success: true, status: 'connecting' };
  }

  async close(id: string, userId: string): Promise<boolean> {
    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      { status: 'ended', endedAt: new Date() },
    );
    if (result) {
      const redis = getRedisClient();
      await redis.del(`session:${id}:status`);
      // Revoke MCP endpoint: session close invalidates token and access address immediately
      await mcpEndpointService.revokeEndpoint(id);
      // Notify controller-api to stop ACP session
      await redis.publish('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId: id,
        reason: 'user_close',
      }));
      return true;
    }
    return false;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const redis = getRedisClient();
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) return false;

    // Worktree cleanup if applicable
    if ((session as any).worktreePath && (session as any).worktreeBranch) {
      const workspace = await ControllerWorkspace.findOne({
        controllerId: session.controllerId,
        userId,
      }).lean();
      const repoPath = workspace?.path || session.cwd || '';

      // 1. git:status — detect if clean
      const statusReqId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:status',
        requestId: statusReqId,
        controllerId: session.controllerId.toString(),
        path: (session as any).worktreePath,
      }));

      let isClean = false;
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:status:${statusReqId}`);
        if (result) {
          const parsed = JSON.parse(result);
          isClean = parsed.isClean === true;
          await redis.del(`git:status:${statusReqId}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // 2. non-clean → git:commit
      if (!isClean) {
        const commitReqId = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await redis.publish('session:command', JSON.stringify({
          type: 'git:commit',
          requestId: commitReqId,
          controllerId: session.controllerId.toString(),
          path: (session as any).worktreePath,
          message: 'chore: workspace cleanup code stash',
        }));
        for (let i = 0; i < 30; i++) {
          const result = await redis.get(`git:commit:${commitReqId}`);
          if (result) {
            await redis.del(`git:commit:${commitReqId}`);
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // 3. git:worktree:remove
      const rmReqId = `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:worktree:remove',
        requestId: rmReqId,
        controllerId: session.controllerId.toString(),
        repoPath,
        worktreePath: (session as any).worktreePath,
      }));

      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:worktree:remove:${rmReqId}`);
        if (result) {
          const parsed = JSON.parse(result);
          await redis.del(`git:worktree:remove:${rmReqId}`);
          if (!parsed.success && !(parsed.error?.includes('is not a working tree'))) {
            throw new Error(`WORKTREE_REMOVE_FAILED: ${parsed.error}`);
          }
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Stop ACP session
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:stop',
      sessionId: id,
      reason: 'user_delete',
    }));

    // Revoke MCP endpoint
    await mcpEndpointService.revokeEndpoint(id);

    // Delete from DB
    const result = await Session.findOneAndDelete({ _id: id, userId });
    if (result) {
      await AcpMessage.deleteMany({ sessionId: id });
      await redis.del(`session:${id}:status`);
      return true;
    }
    return false;
  }

  async getMessages(sessionId: string, userId: string, options: { before?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      throw new Error('Session not found');
    }

    const { before, limit: rawLimit = 25 } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const filter: Record<string, unknown> = { sessionId };
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      filter._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    const messages = await AcpMessage.find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean();

    return messages.reverse().map(this.mapMessage.bind(this));
  }

  async addMessage(sessionId: string, message: { direction: string; type: string; content: unknown; metadata?: string }): Promise<Record<string, unknown>> {
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: message.direction as 'input' | 'output',
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: typeof message.content === 'string'
        ? (() => { try { return JSON.parse(message.content); } catch { return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.content } }; } })()
        : message.content,
      metadata: message.metadata,
    });

    // Set session title from first user message
    if (message.direction === 'input') {
      const messageCount = await AcpMessage.countDocuments({ sessionId, direction: 'input' });
      if (messageCount === 1) {
        // First user message - extract text content as title
        let title = message.content as string;
        let parsedContent: Record<string, unknown> | null = null;
        if (typeof message.content === 'string') {
          try {
            parsedContent = JSON.parse(message.content);
          } catch { /* use raw content */ }
        } else {
          parsedContent = message.content as Record<string, unknown>;
        }
        if (parsedContent?.sessionUpdate === 'user_message_chunk' && (parsedContent.content as Record<string, unknown>)?.text) {
          title = (parsedContent.content as Record<string, unknown>).text as string;
        }
        // Truncate to 50 chars
        if (title.length > 50) {
          title = title.slice(0, 50) + '...';
        }
        await Session.findByIdAndUpdate(sessionId, { title });
      }
    }

    const mappedMessage = this.mapMessage(acpMessage.toObject());

    // Publish to Redis for SSE
    const redis = getRedisClient();
    redis.publish('session:message', JSON.stringify({
      sessionId,
      message: mappedMessage,
    }));

    return mappedMessage;
  }

  async getAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    // Verify controller belongs to user
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Check Redis cache first
    const cached = await redis.get(`acp:capability:${controllerId}`);
    if (cached) {
      return this.parseCapabilitiesWithCheckedAt(cached);
    }

    // Trigger ACP capability detection via Redis Pub/Sub
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:check',
      requestId,
      controllerId,
    }));

    // Poll Redis cache for result (controller-api will cache it after detection)
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`acp:capability:${controllerId}`);
      if (result) {
        return this.parseCapabilitiesWithCheckedAt(result);
      }
    }

    // Timeout — return empty
    return [];
  }

  private parseCapabilitiesWithCheckedAt(cached: string): Record<string, unknown>[] {
    const parsed = JSON.parse(cached);
    return (parsed.servers as Record<string, unknown>[]).map((s) => ({
      ...s,
      checkedAt: parsed.checkedAt || null,
    }));
  }

  async refreshAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Delete Redis cache
    await redis.del(`acp:capability:${controllerId}`);

    // Notify controller-api to invalidate its in-memory cache
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:cache:invalidate',
      controllerId,
    }));

    // Trigger fresh detection and return result
    return this.getAcpCapabilities(controllerId, userId);
  }

  private mapSession(session: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (session._id as mongoose.Types.ObjectId).toString(),
      userId: (session.userId as mongoose.Types.ObjectId).toString(),
      controllerId: (session.controllerId as mongoose.Types.ObjectId).toString(),
      controllerName: session.controllerName,
      acpServerType: session.acpServerType,
      status: session.status,
      title: session.title || 'New Session',
      externalSessionId: session.externalSessionId || null,
      cwd: session.cwd || null,
      worktreePath: (session as any).worktreePath || null,
      worktreeBranch: (session as any).worktreeBranch || null,
      modes: session.modes || [],
      currentModeId: session.currentModeId || null,
      currentModel: session.currentModel || null,
      currentModelId: session.currentModelId || null,
      availableModels: session.availableModels || [],
      configOptions: (session as any).configOptions || [],
      promptCapabilities: (session as any).promptCapabilities || null,
      agentInfo: (session as any).agentInfo || null,
      authRequired: (session as any).authRequired || false,
      authMethods: this.mapAuthMethods((session as any).authMethods),
      supportsAdditionalDirectories: (session as any).supportsAdditionalDirectories || false,
      permissionTimeoutAction: (session as any).permissionTimeoutAction || null,
      createdAt: (session.createdAt as Date).toISOString(),
      updatedAt: (session.updatedAt as Date).toISOString(),
      endedAt: session.endedAt ? (session.endedAt as Date).toISOString() : null,
    };
  }

  private mapAuthMethods(authMethods: unknown): Record<string, unknown>[] {
    if (!Array.isArray(authMethods)) return [];
    const validKinds = new Set(['env_var', 'terminal', 'agent']);
    return authMethods.map((method) => {
      const m = method as Record<string, unknown>;
      return {
        ...m,
        kind: typeof m.kind === 'string' && validKinds.has(m.kind) ? m.kind : null,
      };
    });
  }

  private mapMessage(message: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (message._id as mongoose.Types.ObjectId).toString(),
      sessionId: (message.sessionId as mongoose.Types.ObjectId).toString(),
      direction: message.direction,
      type: message.type,
      content: message.content,
      metadata: message.metadata || null,
      messageId: (message as any).messageId || null,
      createdAt: (message.createdAt as Date).toISOString(),
    };
  }
}

export const sessionService = new SessionService();