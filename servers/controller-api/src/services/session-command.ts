import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';

const SESSION_COMMAND_CHANNEL = 'session:command';
const SESSION_MESSAGE_CHANNEL = 'session:message';

export class SessionCommandService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribe();
  }

  private subscribe(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(SESSION_COMMAND_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to session command channel:', err);
        return;
      }
    });

    subscriber.subscribe(SESSION_MESSAGE_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to session message channel:', err);
        return;
      }
    });

    subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === SESSION_COMMAND_CHANNEL) {
          const command = JSON.parse(message) as {
            type: string;
            requestId?: string;
            sessionId?: string;
            controllerId?: string;
            serverType?: string;
            cwd?: string;
            reason?: string;
          };

          if (command.type === 'acp:start' && command.sessionId && command.controllerId && command.serverType) {
            await this.handleAcpStart(command as { sessionId: string; controllerId: string; serverType: string; cwd?: string });
          } else if (command.type === 'acp:check' && command.requestId && command.controllerId) {
            await this.handleAcpCheck(command.requestId, command.controllerId);
          } else if (command.type === 'acp:stop' && command.sessionId) {
            await this.handleAcpStop(command.sessionId, command.reason || 'user_request');
          }
        } else if (channel === SESSION_MESSAGE_CHANNEL) {
          const data = JSON.parse(message) as {
            sessionId: string;
            message: { id: string; direction: string; type: string; content: string };
          };

          if (data.message.direction === 'input') {
            await this.handleInputMessage(data.sessionId, data.message);
          }
        }
      } catch (err) {
        console.error('Failed to process session event:', err);
      }
    });
  }

  private async handleInputMessage(sessionId: string, message: { id: string; type: string; content: string }): Promise<void> {
    // Forward input message to the controller via WebSocket only (DB already saved by agent-api)
    acpSessionManager.forwardToController(sessionId, {
      type: message.type,
      content: message.content,
    });
  }

  private async handleAcpStart(command: {
    sessionId: string;
    controllerId: string;
    serverType: string;
    cwd?: string;
  }): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(command.controllerId).lean();
    if (!controller) {
      console.error(`Controller not found: ${command.controllerId}`);
      return;
    }

    // Get the socket ID from session service
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller not online: ${command.controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found: ${socketId}`);
      return;
    }

    // Get user ID from controller
    const userId = controller.userId.toString();

    // Start ACP session
    const result = await acpSessionManager.startSession(
      socket,
      command.sessionId,
      command.controllerId,
      userId,
      command.serverType,
      command.cwd || process.cwd(),
    );

    if (!result.success) {
      console.error(`ACP start failed: ${result.error}`);
    }
  }

  private async handleAcpCheck(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for ACP check: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller online for ACP check: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for ACP check: ${controllerId}`);
      return;
    }

    // Use the capability detector to send acp:check and wait for result
    const servers = await acpCapabilityDetector.detectCapabilities(socket, controllerId);
    console.log(`ACP capabilities detected for ${controllerId}:`, servers);
  }

  private async handleAcpStop(sessionId: string, reason: string): Promise<void> {
    console.log(`[SessionCommand] Stopping ACP session ${sessionId}: reason=${reason}`);
    await acpSessionManager.stopSession(sessionId, reason);
  }
}

export const sessionCommandService = new SessionCommandService();
