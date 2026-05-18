import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { acpSessionManager } from './acp-session-manager.js';

const SESSION_COMMAND_CHANNEL = 'session:command';

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

    subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== SESSION_COMMAND_CHANNEL) return;

      try {
        const command = JSON.parse(message) as {
          type: string;
          sessionId: string;
          controllerId: string;
          serverType: string;
          cwd?: string;
        };

        if (command.type === 'acp:start') {
          await this.handleAcpStart(command);
        }
      } catch (err) {
        console.error('Failed to process session command:', err);
      }
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
}

export const sessionCommandService = new SessionCommandService();
