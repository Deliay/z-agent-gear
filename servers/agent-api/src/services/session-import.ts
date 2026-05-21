import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';

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
  ): Promise<HistorySessionInfo[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
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
    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:list-sessions',
      requestId,
      controllerId,
      cwd,
    }));

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
      userId,
      externalSessionId: { $exists: true, $ne: null },
    }).distinct('externalSessionId');

    return rawSessions.filter((s) => !existingIds.includes(s.sessionId));
  }

  async importSessions(
    userId: string,
    controllerId: string,
    controllerName: string,
    workspaceId: string,
    acpSessionIds: string[],
  ): Promise<ImportSessionResult[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
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
        const loadResult = await this.loadSessionFromController(controllerId, acpSessionId, cwd);

        const title = loadResult.title || `历史会话 - ${acpSessionId.slice(0, 8)}`;

        const session = await Session.create({
          userId,
          controllerId,
          controllerName,
          acpServerType: 'opencode',
          status: 'ended',
          title,
          externalSessionId: acpSessionId,
          cwd,
          endedAt: new Date(),
        });

        const messages = (loadResult.messages ?? []).map((msg) => ({
          sessionId: session._id,
          direction: msg.direction,
          type: msg.type,
          content: msg.content,
        }));

        if (messages.length > 0) {
          await AcpMessage.insertMany(messages);
        }

        results.push({
          sessionId: session._id.toString(),
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
  ): Promise<{ title?: string | null; messages: HistoryMessage[] }> {
    const requestId = `load_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:load-session',
      requestId,
      controllerId,
      sessionId: acpSessionId,
      cwd,
    }));

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
