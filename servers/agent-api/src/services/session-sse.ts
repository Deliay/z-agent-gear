import type { Response } from 'express';
import { getRedisClient } from '../middleware/redis.js';
import { sessionService } from './session.js';

interface SSEConnection {
  res: Response;
  sessionId: string;
  userId: string;
  heartbeat: NodeJS.Timeout;
}

const connections = new Map<string, SSEConnection>();
let globalStatusSubscriber: ReturnType<ReturnType<typeof getRedisClient>['duplicate']> | null = null;

export class SessionSSEService {
  async addConnection(sessionId: string, userId: string, res: Response): Promise<void> {
    // Verify session exists and belongs to user
    const session = await sessionService.findById(sessionId, userId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send history messages
    const history = await sessionService.getMessages(sessionId, userId, 0);
    res.write(`data: ${JSON.stringify({ type: 'history', data: history })}\n\n`);

    // Send current status
    const statusPayload: Record<string, unknown> = { sessionId, status: session.status };
    if (session.modes) statusPayload.modes = session.modes;
    if (session.currentModeId) statusPayload.currentModeId = session.currentModeId;
    if (session.currentModel) statusPayload.currentModel = session.currentModel;
    if (session.availableModels) statusPayload.availableModels = session.availableModels;
    if (session.currentModelId) statusPayload.currentModelId = session.currentModelId;
    res.write(`data: ${JSON.stringify({ type: 'status', data: statusPayload })}\n\n`);

    // Create connection
    const connectionId = `${sessionId}:${userId}`;
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }, 30000);

    connections.set(connectionId, {
      res,
      sessionId,
      userId,
      heartbeat,
    });

    // Subscribe to global message channel and filter by sessionId
    const redis = getRedisClient();
    const subscriber = redis.duplicate();
    await subscriber.subscribe('session:message');

    subscriber.on('message', (channel, message) => {
      if (channel === 'session:message') {
        try {
          const data = JSON.parse(message) as { sessionId: string; message: Record<string, unknown> };
          if (data.sessionId === sessionId) {
            res.write(`data: ${JSON.stringify({ type: 'message', data: data.message })}\n\n`);
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    // Ensure global status subscriber is running
    this.ensureGlobalStatusSubscriber();

    // Clean up on connection close
    res.on('close', () => {
      clearInterval(heartbeat);
      subscriber.unsubscribe();
      subscriber.quit();
      connections.delete(connectionId);
    });
  }

  private ensureGlobalStatusSubscriber(): void {
    if (globalStatusSubscriber) return;

    const redis = getRedisClient();
    globalStatusSubscriber = redis.duplicate();
    globalStatusSubscriber.subscribe('session:status');
    globalStatusSubscriber.on('message', (_channel, message) => {
      try {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        const { sessionId, status, error } = parsed as { sessionId: string; status: string; error?: string };
        if (status) {
          const extra: Record<string, unknown> = {};
          if (parsed.modes) extra.modes = parsed.modes;
          if (parsed.currentModeId) extra.currentModeId = parsed.currentModeId;
          if (parsed.currentModel) extra.currentModel = parsed.currentModel;
          if (parsed.availableModels) extra.availableModels = parsed.availableModels;
          if (parsed.currentModelId) extra.currentModelId = parsed.currentModelId;
          this.dispatchStatus(sessionId, status, error, Object.keys(extra).length ? extra : undefined);
        }
        this.broadcastModeChanged(sessionId, parsed);
        this.broadcastModelChanged(sessionId, parsed);
      } catch {
        // ignore parse errors
      }
    });
  }

  private dispatchStatus(sessionId: string, status: string, error?: string, extra?: Record<string, unknown>): void {
    if (status === 'removed') {
      this.removeConnections(sessionId);
      return;
    }
    this.broadcastStatus(sessionId, status, error, extra);
  }

  broadcastMessage(sessionId: string, message: Record<string, unknown>): void {
    const data = JSON.stringify({ type: 'message', data: message });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  broadcastStatus(sessionId: string, status: string, error?: string, extra?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { sessionId, status };
    if (error) payload.error = error;
    if (extra) {
      if (extra.modes) payload.modes = extra.modes;
      if (extra.currentModeId) payload.currentModeId = extra.currentModeId;
      if (extra.currentModel) payload.currentModel = extra.currentModel;
      if (extra.availableModels) payload.availableModels = extra.availableModels;
      if (extra.currentModelId) payload.currentModelId = extra.currentModelId;
    }
    const data = JSON.stringify({ type: 'status', data: payload });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  broadcastModeChanged(sessionId: string, payload: Record<string, unknown>): void {
    if (!payload.currentModeId) return;
    const data = JSON.stringify({ type: 'mode:changed', data: { sessionId, modeId: payload.currentModeId } });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  broadcastModelChanged(sessionId: string, payload: Record<string, unknown>): void {
    if (!payload.currentModelId) return;
    const data = JSON.stringify({ type: 'model:changed', data: { sessionId, modelId: payload.currentModelId } });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  removeConnections(sessionId: string): void {
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        clearInterval(connection.heartbeat);
        // Notify client before closing
        connection.res.write(`data: ${JSON.stringify({ type: 'status', data: { sessionId, status: 'removed' } })}\n\n`);
        connection.res.end();
        connections.delete(key);
      }
    }
  }
}

export const sessionSSEService = new SessionSSEService();