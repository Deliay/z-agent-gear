import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { actorFilter } from './workspace-context.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { sessionService } from './session.js';

// 非 ended 的会话可能仍有存活（或即将拉起）的 ACP 进程：
// 删除前必须委托 sessionService.delete 走 acp:stop + ack 生命周期，否则进程泄漏
const LIVE_SESSION_STATUSES = ['creating', 'connecting', 'idling', 'disconnected'];

export interface HistorySessionInfo {
  sessionId: string;
  title: string | null;
  cwd: string;
  updatedAt: string | null;
}

export interface ImportSessionResult {
  sessionId: string;
  acpSessionId: string;
  title: string | null;
  success: boolean;
  error: string | null;
  messageCount: number;
}

export interface DeleteHistorySessionResult {
  success: boolean;
  syncedToAgent: boolean;
  error: string | null;
}

interface HistoryMessage {
  direction: 'input' | 'output';
  type: string;
  content: string;
}

export class SessionImportService {
  async listHistorySessions(
    userId: string,
    controllerId: string,
    workspaceId: string,
    acpServerType: string = 'opencode',
  ): Promise<HistorySessionInfo[]> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const workspace = await ControllerWorkspace.findOne({ _id: workspaceId, userId, controllerId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const cwd = workspace.path;

    // Publish list-sessions command via Redis Pub/Sub
    const requestId = `list_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await publish('session:command', {
      type: 'acp:list-sessions',
      requestId,
      controllerId,
      serverType: acpServerType,
      cwd,
    });

    // Poll Redis cache for result
    const result = await this.pollRedisCache<{ success: boolean; sessions?: HistorySessionInfo[]; error?: string }>(
      `acp:list-sessions:${requestId}`,
      120,
      500,
    );

    if (!result || !result.success) {
      throw new Error(result?.error || 'Failed to list history sessions');
    }

    const rawSessions = result.sessions ?? [];

    // Filter out sessions that already exist in the system
    const existingIds: string[] = await Session.find({
      ...actorFilter(userId),
      externalSessionId: { $exists: true, $ne: null },
    }).distinct('externalSessionId');

    return rawSessions.filter((s) => !existingIds.includes(s.sessionId));
  }

  async deleteHistorySession(
    userId: string,
    sessionId: string,
    syncAgent: boolean = true,
  ): Promise<DeleteHistorySessionResult> {
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) });
    if (!session) {
      throw new Error('Session not found');
    }

    const sessionStatus = (session as unknown as { status?: string }).status;
    if (sessionStatus === 'running') {
      throw new Error(`Cannot delete session in 'running' status; stop the session before deleting`);
    }

    const record = session as unknown as {
      externalSessionId?: string | null;
      controllerId?: string;
      cwd?: string;
      acpServerType?: string;
    };

    if (sessionStatus && LIVE_SESSION_STATUSES.includes(sessionStatus)) {
      // 存活会话：委托 sessionService.delete（acp:stop + 等 ack + worktree 清理 +
      // MCP endpoint 撤销 + 删库删消息），否则 ACP 进程会被保留
      await sessionService.delete(sessionId, userId);
    } else {
      await Session.deleteOne({ _id: sessionId, ...actorFilter(userId) });
      await AcpMessage.deleteMany({ sessionId });
    }

    let syncedToAgent = false;
    let syncError: string | null = null;
    if (syncAgent && record.externalSessionId) {
      const requestId = `delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await publish('session:command', {
        type: 'acp:delete-history-session',
        requestId,
        controllerId: record.controllerId,
        sessionId,
        externalSessionId: record.externalSessionId,
        serverType: record.acpServerType ?? 'opencode',
        cwd: record.cwd,
      });

      const result = await this.pollRedisCache<{ success: boolean; supported?: boolean; error?: string }>(
        `acp:delete-session:${requestId}`,
        120,
        500,
      );

      syncedToAgent = Boolean(result && result.success && result.supported);
      if (result && !result.success && result.supported && result.error) {
        syncError = result.error;
      }
    }

    return { success: true, syncedToAgent, error: syncError };
  }

  async importSessions(
    userId: string,
    controllerId: string,
    controllerName: string,
    workspaceId: string,
    acpSessionIds: string[],
    acpServerType: string = 'opencode',
  ): Promise<ImportSessionResult[]> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const workspace = await ControllerWorkspace.findOne({ _id: workspaceId, userId, controllerId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const cwd = workspace.path;
    const results: ImportSessionResult[] = [];

    for (const acpSessionId of acpSessionIds) {
      try {
        const loadResult = await this.loadSessionFromController(controllerId, acpSessionId, cwd, acpServerType);

        const title = loadResult.title || `历史会话 - ${acpSessionId.slice(0, 8)}`;

        const session = await Session.create({
          userId,
          controllerId,
          controllerName,
          acpServerType: acpServerType as any,
          status: 'ended' as const,
          title,
          externalSessionId: acpSessionId,
          cwd,
          endedAt: new Date(),
        });

        const messages = (loadResult.messages ?? []).map((msg) => ({
          sessionId: (session as any)._id,
          direction: msg.direction,
          type: msg.type,
          content: msg.content,
        }));

        if (messages.length > 0) {
          await AcpMessage.insertMany(messages);
        }

        results.push({
          sessionId: (session as any)._id.toString(),
          acpSessionId,
          title,
          success: true,
          error: null,
          messageCount: messages.length,
        });
      } catch (error) {
        results.push({
          sessionId: '',
          acpSessionId,
          title: null,
          success: false,
          error: (error as Error).message,
          messageCount: 0,
        });
      }
    }

    return results;
  }

  private async loadSessionFromController(
    controllerId: string,
    acpSessionId: string,
    cwd: string,
    acpServerType: string = 'opencode',
  ): Promise<{ title?: string | null; messages: HistoryMessage[] }> {
    const requestId = `load_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await publish('session:command', {
      type: 'acp:load-session',
      requestId,
      controllerId,
      serverType: acpServerType,
      sessionId: acpSessionId,
      cwd,
    });

    const result = await this.pollRedisCache<{
      success: boolean;
      sessionId?: string;
      title?: string | null;
      messages?: HistoryMessage[];
      error?: string;
    }>(`acp:load-session:${requestId}`, 300, 1000);

    if (!result || !result.success) {
      throw new Error(result?.error || 'Failed to load session');
    }

    return {
      title: result.title,
      messages: result.messages ?? [],
    };
  }

  private async pollRedisCache<T>(
    key: string,
    maxSeconds: number,
    intervalMs: number,
  ): Promise<T | null> {
    const redis = getRedisClient();
    const maxAttempts = Math.ceil((maxSeconds * 1000) / intervalMs);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    }

    return null;
  }
}

export const sessionImportService = new SessionImportService();
