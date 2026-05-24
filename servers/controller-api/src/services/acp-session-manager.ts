import mongoose from 'mongoose';
import type { Socket } from 'socket.io';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { getRedisClient } from '../middleware/redis.js';

const EXTERNAL_SESSION_CACHE_TTL = 86400; // 24h

interface ACPSession {
  controllerSocket: Socket;
  sessionId: string;
  controllerId: string;
  userId: string;
}

export class ACPSessionManager {
  private sessions = new Map<string, ACPSession>();
  private socketToSessions = new Map<string, Set<string>>();

  async startSession(
    controllerSocket: Socket,
    sessionId: string,
    controllerId: string,
    userId: string,
    serverType: string,
    cwd: string,
  ): Promise<{ success: boolean; error?: string; externalSessionId?: string }> {
    let statusAtStart = 'creating';
    try {
      const session = await Session.findById(sessionId).lean();
      statusAtStart = session?.status ?? 'creating';

      // Update session status to connecting
      await Session.findByIdAndUpdate(sessionId, { status: 'connecting' });
      await this.publishStatus(sessionId, 'connecting');

      // Send acp:start to controller
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
      console.log(`[ACP session] Starting session ${sessionId}: requestId=${requestId} controllerId=${controllerId} serverType=${serverType} cwd=${cwd}`);
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.log(`[ACP session] TIMEOUT after 30s for session ${sessionId} requestId=${requestId}`);
          this.cleanupFailedSession(sessionId, statusAtStart);
          resolve({ success: false, error: 'ACP start timeout' });
        }, 30000);

        controllerSocket.once('acp:start:result', async (payload: {
          requestId: string;
          sessionId: string;
          success: boolean;
          error?: string;
          externalSessionId?: string;
          modes?: Array<{ id: string; name: string; description?: string }>;
          currentModeId?: string;
          currentModel?: { id: string; name: string; provider?: string };
          availableModels?: Array<{ id: string; name: string; provider?: string }>;
          currentModelId?: string;
        }) => {
          clearTimeout(timeout);
          
          console.log(`[ACP session] Received acp:start:result for session ${sessionId}: requestId=${payload.requestId} success=${payload.success} error=${payload.error}`);
          
          if (payload.requestId !== requestId) {
            console.log(`[ACP session] requestId mismatch: expected=${requestId} got=${payload.requestId} (ignoring)`);
            return;
          }

          if (payload.success) {
            // Store session mapping
            this.sessions.set(sessionId, {
              controllerSocket,
              sessionId,
              controllerId,
              userId,
            });

            // Track socket to sessions mapping
            const socketSessions = this.socketToSessions.get(controllerSocket.id) || new Set();
            socketSessions.add(sessionId);
            this.socketToSessions.set(controllerSocket.id, socketSessions);

            // Update session status to idling
            const updateData: Record<string, unknown> = {
              status: 'idling',
              externalSessionId: payload.externalSessionId,
            };
            if (payload.modes) updateData.modes = payload.modes;
            if (payload.currentModeId) updateData.currentModeId = payload.currentModeId;
            if (payload.currentModel) updateData.currentModel = payload.currentModel;
            if (payload.availableModels) updateData.availableModels = payload.availableModels;
            if (payload.currentModelId) updateData.currentModelId = payload.currentModelId;
            await Session.findByIdAndUpdate(sessionId, updateData);
            await this.cacheModes(sessionId, payload.modes, payload.currentModeId, payload.currentModel, payload.availableModels, payload.currentModelId);
            const statusExtra: Record<string, unknown> = {};
            if (payload.modes) statusExtra.modes = payload.modes;
            if (payload.currentModeId) statusExtra.currentModeId = payload.currentModeId;
            if (payload.currentModel) statusExtra.currentModel = payload.currentModel;
            if (payload.availableModels) statusExtra.availableModels = payload.availableModels;
            if (payload.currentModelId) statusExtra.currentModelId = payload.currentModelId;
            await this.publishStatus(sessionId, 'idling', undefined, Object.keys(statusExtra).length ? statusExtra : undefined);

            // Cache externalSessionId in Redis for resume
            if (payload.externalSessionId) {
              const redis = getRedisClient();
              await redis.set(
                `session:${sessionId}:acpSessionId`,
                payload.externalSessionId,
                'EX',
                EXTERNAL_SESSION_CACHE_TTL,
              );
            }

            console.log(`[ACP session] Session ${sessionId} is now idling`);
            resolve({ success: true, externalSessionId: payload.externalSessionId });
          } else {
            // Controller explicitly reported failure — keep session with 'ended' status
            await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
            await this.publishStatus(sessionId, 'ended');
            console.log(`[ACP session] Session ${sessionId} ended by controller: ${payload.error}`);
            resolve({ success: false, error: payload.error });
          }
        });

        console.log(`[ACP session] Emitting acp:start to controller socket ${controllerSocket.id} for session ${sessionId}`);
        controllerSocket.emit('acp:start', {
          requestId,
          sessionId,
          serverType,
          cwd,
        });
      });
    } catch (error) {
      console.error(`[ACP session] Error starting session ${sessionId}:`, error);
      await this.cleanupFailedSession(sessionId, statusAtStart);
      return { success: false, error: (error as Error).message };
    }
  }

  private async cleanupFailedSession(sessionId: string, previousStatus: string): Promise<void> {
    // Only delete sessions that never successfully connected
    if (previousStatus === 'creating' || previousStatus === 'connecting') {
      console.log(`[ACP] Removing failed session ${sessionId} (was ${previousStatus})`);
      await AcpMessage.deleteMany({ sessionId });
      await Session.findByIdAndDelete(sessionId);
      await this.publishStatus(sessionId, 'removed');
    } else {
      await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
      await this.publishStatus(sessionId, 'ended');
    }
  }

  async sendMessage(sessionId: string, message: { type: string; content: string }): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const rawContent = {
      sessionUpdate: 'user_message_chunk' as const,
      content: { type: 'text' as const, text: message.content },
    };

    // Save input message to database
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'input' as const,
      type: 'text',
      content: rawContent,
    });

    const doc = acpMessage.toObject();
    // Publish message to Redis
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'input',
      type: 'text',
      content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
      metadata: null,
      createdAt: (doc.createdAt as Date).toISOString(),
    });

    // Forward message to controller
    session.controllerSocket.emit('acp:message', {
      sessionId,
      message,
    });

    return true;
  }

  async handleControllerMessage(sessionId: string, message: SessionUpdate): Promise<void> {
    // Handle config_option_update - parse config options to update session state
    if (message.sessionUpdate === 'config_option_update') {
      const update = message as Record<string, unknown>;
      const configOptions = update.configOptions as Array<Record<string, unknown>> | undefined;
      if (configOptions) {
        const updateData: Record<string, unknown> = {};
        const statusExtra: Record<string, unknown> = {};
        for (const opt of configOptions) {
          const value = (opt.value ?? opt.currentValue) as string | undefined;
          if (opt.id === 'mode' && value) {
            updateData.currentModeId = value;
            statusExtra.currentModeId = value;
          } else if (opt.id === 'model' && value) {
            updateData.currentModelId = value;
            statusExtra.currentModelId = value;
          }
        }
        if (Object.keys(updateData).length > 0) {
          await Session.findByIdAndUpdate(sessionId, updateData);
          await this.publishStatus(sessionId, 'idling', undefined, Object.keys(statusExtra).length ? statusExtra : undefined);
        }
      }
    }

    // Handle current_mode_update
    if (message.sessionUpdate === 'current_mode_update') {
      const update = message as Record<string, unknown>;
      const modeId = update.modeId as string | undefined;
      if (modeId) {
        await Session.findByIdAndUpdate(sessionId, { currentModeId: modeId });
        await this.publishStatus(sessionId, 'idling', undefined, { currentModeId: modeId });
      }
    }

    const rawContent = message;

    let type: string;
    switch (message.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
      case 'agent_thought_chunk':
        type = 'text';
        break;
      case 'tool_call':
        type = 'tool_call';
        break;
      case 'tool_call_update':
        type = 'tool_call';
        break;
      case 'plan':
        type = 'plan';
        break;
      case 'config_option_update':
      case 'current_mode_update':
        type = 'text';
        break;
      default:
        type = 'text';
        break;
    }

    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'output' as const,
      type: type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: rawContent,
    });

    const doc = acpMessage.toObject() as Record<string, unknown>;
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'output',
      type,
      content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
      metadata: null,
      createdAt: (doc.createdAt as Date).toISOString(),
    });
  }

  async stopSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Send acp:stop to controller
    session.controllerSocket.emit('acp:stop', { sessionId });

    // Clean up session mapping
    this.sessions.delete(sessionId);
    const socketSessions = this.socketToSessions.get(session.controllerSocket.id);
    if (socketSessions) {
      socketSessions.delete(sessionId);
      if (socketSessions.size === 0) {
        this.socketToSessions.delete(session.controllerSocket.id);
      }
    }

    // Update session status
    await Session.findByIdAndUpdate(sessionId, {
      status: 'ended',
      endedAt: new Date(),
    });
    await this.publishStatus(sessionId, 'ended');
  }

  async handleControllerStopped(sessionId: string, reason: string, exitCode?: number): Promise<void> {
    // Clean up session mapping
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      const socketSessions = this.socketToSessions.get(session.controllerSocket.id);
      if (socketSessions) {
        socketSessions.delete(sessionId);
        if (socketSessions.size === 0) {
          this.socketToSessions.delete(session.controllerSocket.id);
        }
      }
    }

    // Update session status
    await Session.findByIdAndUpdate(sessionId, {
      status: 'ended',
      endedAt: new Date(),
    });
    await this.publishStatus(sessionId, 'ended');
  }

  async handleSocketDisconnect(socketId: string): Promise<void> {
    const socketSessions = this.socketToSessions.get(socketId);
    if (socketSessions) {
      for (const sessionId of socketSessions) {
        await this.handleControllerStopped(sessionId, 'socket_disconnect');
      }
      this.socketToSessions.delete(socketId);
    }
  }

  async cancelGeneration(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:cancel', { sessionId });
    return true;
  }

  async resumeSession(
    controllerSocket: Socket,
    sessionId: string,
    externalSessionId: string,
    controllerId: string,
    userId: string,
    cwd: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await Session.findByIdAndUpdate(sessionId, { status: 'connecting' });
      await this.publishStatus(sessionId, 'connecting');

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.cleanupFailedSession(sessionId, 'connecting');
          this.publishStatus(sessionId, 'ended', 'RESUME_TIMEOUT');
          resolve({ success: false, error: 'ACP resume timeout' });
        }, 30000);

        controllerSocket.once('acp:resume:result', async (payload: {
          requestId: string;
          sessionId: string;
          success: boolean;
          error?: string;
          modes?: Array<{ id: string; name: string; description?: string }>;
          currentModeId?: string;
          currentModel?: { id: string; name: string; provider?: string };
          availableModels?: Array<{ id: string; name: string; provider?: string }>;
          currentModelId?: string;
        }) => {
          clearTimeout(timeout);
          if (payload.requestId !== requestId) return;

          if (payload.success) {
            this.sessions.set(sessionId, {
              controllerSocket,
              sessionId,
              controllerId,
              userId,
            });

            const socketSessions = this.socketToSessions.get(controllerSocket.id) || new Set();
            socketSessions.add(sessionId);
            this.socketToSessions.set(controllerSocket.id, socketSessions);

            const updateData: Record<string, unknown> = { status: 'idling' };
            if (payload.modes) updateData.modes = payload.modes;
            if (payload.currentModeId) updateData.currentModeId = payload.currentModeId;
            if (payload.currentModel) updateData.currentModel = payload.currentModel;
            if (payload.availableModels) updateData.availableModels = payload.availableModels;
            if (payload.currentModelId) updateData.currentModelId = payload.currentModelId;
            await Session.findByIdAndUpdate(sessionId, updateData);
            await this.refreshSessionCache(sessionId);
            const statusExtra: Record<string, unknown> = {};
            if (payload.modes) statusExtra.modes = payload.modes;
            if (payload.currentModeId) statusExtra.currentModeId = payload.currentModeId;
            if (payload.currentModel) statusExtra.currentModel = payload.currentModel;
            if (payload.availableModels) statusExtra.availableModels = payload.availableModels;
            if (payload.currentModelId) statusExtra.currentModelId = payload.currentModelId;
            await this.publishStatus(sessionId, 'idling', undefined, Object.keys(statusExtra).length ? statusExtra : undefined);

            resolve({ success: true });
          } else {
            await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
            await this.publishStatus(sessionId, 'ended', payload.error || 'ACP_RESUME_FAILED');
            resolve({ success: false, error: payload.error || 'ACP resume failed' });
          }
        });

        controllerSocket.emit('acp:resume', {
          requestId,
          sessionId,
          externalSessionId,
          controllerId,
          userId,
          cwd,
        });
      });
    } catch (error) {
      console.error(`[ACP session] Error resuming session ${sessionId}:`, error);
      await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
      await this.publishStatus(sessionId, 'ended', 'ACP_RESUME_FAILED');
      return { success: false, error: (error as Error).message };
    }
  }

  async getExternalSessionId(sessionId: string): Promise<string | null> {
    // Check Redis cache first
    const redis = getRedisClient();
    const cached = await redis.get(`session:${sessionId}:acpSessionId`);
    if (cached) return cached;

    // Fallback to MongoDB
    const session = await Session.findById(sessionId).lean();
    if (session?.externalSessionId) {
      // Re-cache for future use
      await redis.set(
        `session:${sessionId}:acpSessionId`,
        session.externalSessionId,
        'EX',
        EXTERNAL_SESSION_CACHE_TTL,
      );
      return session.externalSessionId;
    }

    return null;
  }

  forwardToController(sessionId: string, message: { type: string; content: string }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:message', {
      sessionId,
      message,
    });
    return true;
  }

  async setMode(sessionId: string, modeId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:set-mode', { sessionId, modeId });

    // Optimistic update
    await Session.findByIdAndUpdate(sessionId, { currentModeId: modeId });
    await this.publishStatus(sessionId, 'idling', undefined, { currentModeId: modeId });

    return true;
  }

  async setModel(sessionId: string, modelId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:set-model', { sessionId, modelId });

    // Optimistic update
    await Session.findByIdAndUpdate(sessionId, { currentModelId: modelId });
    await this.publishStatus(sessionId, 'idling', undefined, { currentModelId: modelId });

    return true;
  }

  private async refreshSessionCache(sessionId: string): Promise<void> {
    const redis = getRedisClient();
    const session = await Session.findById(sessionId).lean();
    if (!session) return;
    if (session.modes) {
      await redis.set(`session:${sessionId}:modes`, JSON.stringify(session.modes), 'EX', 86400);
    }
    if (session.currentModeId) {
      await redis.set(`session:${sessionId}:currentModeId`, session.currentModeId, 'EX', 86400);
    }
    if (session.currentModel) {
      await redis.set(`session:${sessionId}:currentModel`, JSON.stringify(session.currentModel), 'EX', 86400);
    }
    if (session.availableModels) {
      await redis.set(`session:${sessionId}:availableModels`, JSON.stringify(session.availableModels), 'EX', 86400);
    }
    if (session.currentModelId) {
      await redis.set(`session:${sessionId}:currentModelId`, session.currentModelId, 'EX', 86400);
    }
  }

  private async cacheModes(
    sessionId: string,
    modes?: Array<{ id: string; name: string; description?: string }>,
    currentModeId?: string,
    currentModel?: { id: string; name: string; provider?: string },
    availableModels?: Array<{ id: string; name: string; provider?: string }>,
    currentModelId?: string,
  ): Promise<void> {
    const redis = getRedisClient();
    if (modes) {
      await redis.set(`session:${sessionId}:modes`, JSON.stringify(modes), 'EX', 86400);
    }
    if (currentModeId) {
      await redis.set(`session:${sessionId}:currentModeId`, currentModeId, 'EX', 86400);
    }
    if (currentModel) {
      await redis.set(`session:${sessionId}:currentModel`, JSON.stringify(currentModel), 'EX', 86400);
    }
    if (availableModels) {
      await redis.set(`session:${sessionId}:availableModels`, JSON.stringify(availableModels), 'EX', 86400);
    }
    if (currentModelId) {
      await redis.set(`session:${sessionId}:currentModelId`, currentModelId, 'EX', 86400);
    }
  }

  private async publishMessage(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.publish('session:message', JSON.stringify({
      sessionId,
      message,
    }));
  }

  private async publishStatus(sessionId: string, status: string, error?: string, extra?: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    const payload: Record<string, unknown> = { sessionId, status };
    if (error) payload.error = error;
    if (extra) {
      if (extra.modes) payload.modes = extra.modes;
      if (extra.currentModeId) payload.currentModeId = extra.currentModeId;
      if (extra.currentModel) payload.currentModel = extra.currentModel;
      if (extra.availableModels) payload.availableModels = extra.availableModels;
      if (extra.currentModelId) payload.currentModelId = extra.currentModelId;
    }
    await redis.publish('session:status', JSON.stringify(payload));
  }
}

export const acpSessionManager = new ACPSessionManager();