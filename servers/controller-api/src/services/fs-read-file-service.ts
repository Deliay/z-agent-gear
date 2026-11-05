import { getRedisClient } from '../middleware/redis.js';
import { withTraceMeta } from '../middleware/trace-meta.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

/** fs:read-file 读取结果缓存 TTL（裁决 4：读取体积更大、轮询窗口 15s，取 60s） */
export const FS_READ_FILE_RESULT_TTL_SECONDS = 60;

export class FsReadFileService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'fs-read-file-service' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleReadFile(requestId: string, controllerId: string, path: string, maxBytes?: number): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'fs:read-file' }, 'controller not found');
      return;
    }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'fs:read-file' }, 'controller offline');
      return;
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, socketId, requestId, op: 'fs:read-file' }, 'socket not found');
      return;
    }
    socket.emit('fs:read-file', withTraceMeta({ requestId, path, maxBytes }));
  }

  async handleReadFileResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(
      `fs:read-file:${requestId}`,
      JSON.stringify(result),
      'EX',
      FS_READ_FILE_RESULT_TTL_SECONDS,
    );
  }
}

export const fsReadFileService = new FsReadFileService();
