import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

const COMMAND_CHANNEL = 'controller:command';

export class CommandService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribe();
  }

  private subscribe(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(COMMAND_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to command channel:', err);
        return;
      }
    });

    subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== COMMAND_CHANNEL) return;

      try {
        const command = JSON.parse(message) as { type: string; keyId: string };
        if (command.type === 'shutdown') {
          await this.handleShutdown(command.keyId);
        }
      } catch (err) {
        console.error('Failed to process command:', err);
      }
    });
  }

  private async handleShutdown(keyId: string): Promise<void> {
    const socketId = await sessionService.getSocketId(keyId);
    if (socketId && this.io) {
      this.io.to(socketId).emit('shutdown', { reason: 'key_revoked' });
      this.io.sockets.sockets.get(socketId)?.disconnect(true);
    }

    // Check if controller is in 'unbound' status before deleting
    const controller = await Controller.findOne({ keyId });
    if (controller && controller.status !== 'unbound') {
      await Controller.deleteOne({ keyId });
      await ControllerKey.deleteOne({ _id: keyId });
      await sessionService.cleanupKey(keyId);
    } else if (controller) {
      // Just cleanup session data for unbound controllers
      await sessionService.cleanupKey(keyId);
    }
  }
}

export const commandService = new CommandService();
