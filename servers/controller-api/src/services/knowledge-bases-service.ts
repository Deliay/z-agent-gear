import { getRedisClient } from '../middleware/redis.js';
import { withTraceMeta } from '../middleware/trace-meta.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

/** knowledge-bases:scan 扫描结果缓存 TTL（二期：下游轮询窗口 30s，取 60s） */
export const KNOWLEDGE_BASES_RESULT_TTL_SECONDS = 60;

export class KnowledgeBasesService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'knowledge-bases-service' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleScan(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'knowledge-bases:scan' }, 'controller not found');
      return;
    }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'knowledge-bases:scan' }, 'controller offline');
      return;
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, socketId, requestId, op: 'knowledge-bases:scan' }, 'socket not found');
      return;
    }
    socket.emit('knowledge-bases:scan', withTraceMeta({ requestId, path }));
  }

  async handleScanResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    // sources 数组形态运行时校验：非数组按整体失败兜底落键，防异常报文撑爆轮询端解析
    const payload =
      Array.isArray(result.sources)
        ? result
        : { success: false, sources: [], truncated: false, error: 'not found' };
    const redis = getRedisClient();
    await redis.set(
      `knowledge-bases:scan:${requestId}`,
      JSON.stringify(payload),
      'EX',
      KNOWLEDGE_BASES_RESULT_TTL_SECONDS,
    );
  }
}

export const knowledgeBasesService = new KnowledgeBasesService();
