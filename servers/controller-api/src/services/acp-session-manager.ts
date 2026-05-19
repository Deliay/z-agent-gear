import mongoose from 'mongoose';
import type { Socket } from 'socket.io';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { getRedisClient } from '../middleware/redis.js';

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

            // Update session status to running
            await Session.findByIdAndUpdate(sessionId, {
              status: 'running',
              externalSessionId: payload.externalSessionId,
            });
            await this.publishStatus(sessionId, 'running');

            console.log(`[ACP session] Session ${sessionId} is now running`);
            resolve({ success: true, externalSessionId: payload.externalSessionId });
          } else {
            await this.cleanupFailedSession(sessionId, statusAtStart);
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

    // Save input message to database
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'input' as const,
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: message.content,
    });

    const doc = acpMessage.toObject();
    // Publish message to Redis
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'input',
      type: message.type,
      content: message.content,
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

  async handleControllerMessage(sessionId: string, message: {
    type: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const content = message.content || (message.metadata ? JSON.stringify(message.metadata) : JSON.stringify(message));

    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'output' as const,
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
    });

    const doc = acpMessage.toObject();
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'output',
      type: message.type,
      content,
      metadata: typeof doc.metadata === 'string' ? doc.metadata : (doc.metadata ? JSON.stringify(doc.metadata) : null),
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

  forwardToController(sessionId: string, message: { type: string; content: string }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:message', {
      sessionId,
      message,
    });
    return true;
  }

  private async publishMessage(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.publish('session:message', JSON.stringify({
      sessionId,
      message,
    }));
  }

  private async publishStatus(sessionId: string, status: string): Promise<void> {
    const redis = getRedisClient();
    await redis.publish('session:status', JSON.stringify({
      sessionId,
      status,
    }));
  }
}

export const acpSessionManager = new ACPSessionManager();