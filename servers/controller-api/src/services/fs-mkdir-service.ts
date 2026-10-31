import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

export class FsMkdirService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'fs-mkdir-service' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleMkdir(requestId: string, controllerId: string, parentPath: string, folderName: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { this.logger.error({ controllerId, requestId, op: 'fs:mkdir' }, 'controller not found'); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { this.logger.error({ controllerId, requestId, op: 'fs:mkdir' }, 'controller offline'); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { this.logger.error({ controllerId, socketId, requestId, op: 'fs:mkdir' }, 'socket not found'); return; }
    socket.emit('fs:mkdir', { requestId, parentPath, folderName });
  }

  async handleMkdirResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:mkdir:${requestId}`, JSON.stringify(result), 'EX', 30);
  }
}

export const fsMkdirService = new FsMkdirService();