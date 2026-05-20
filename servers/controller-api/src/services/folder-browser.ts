import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class FolderBrowserService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async browse(requestId: string, controllerId: string, path?: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for browse: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller offline for browse: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for browse: ${controllerId}`);
      return;
    }

    socket.emit('fs:browse', { requestId, path: path || null });
  }

  async getHomeDirectory(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for getHomeDirectory: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller offline for getHomeDirectory: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for getHomeDirectory: ${controllerId}`);
      return;
    }

    socket.emit('fs:home', { requestId });
  }

  async handleBrowseResult(requestId: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:browse:${requestId}`, JSON.stringify({ entries }), 'EX', 30);
  }

  async handleHomeResult(requestId: string, path: string): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:home:${requestId}`, JSON.stringify({ path }), 'EX', 30);
  }
}

export const folderBrowserService = new FolderBrowserService();
