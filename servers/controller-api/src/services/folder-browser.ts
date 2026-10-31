import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

export class FolderBrowserService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'folder-browser' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async browse(requestId: string, controllerId: string, path?: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'fs:browse' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'fs:browse' }, 'controller offline');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, socketId, requestId, op: 'fs:browse' }, 'socket not found');
      return;
    }

    socket.emit('fs:browse', { requestId, path: path || null });
  }

  async getHomeDirectory(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'fs:home' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'fs:home' }, 'controller offline');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, socketId, requestId, op: 'fs:home' }, 'socket not found');
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
