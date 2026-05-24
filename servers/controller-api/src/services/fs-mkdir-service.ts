import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class FsMkdirService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleMkdir(requestId: string, controllerId: string, parentPath: string, folderName: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found: ${socketId}`); return; }
    socket.emit('fs:mkdir', { requestId, parentPath, folderName });
  }

  async handleMkdirResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:mkdir:${requestId}`, JSON.stringify(result), 'EX', 30);
  }
}

export const fsMkdirService = new FsMkdirService();