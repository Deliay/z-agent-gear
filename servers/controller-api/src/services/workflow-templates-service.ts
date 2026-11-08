import { getRedisClient } from '../middleware/redis.js';
import { withTraceMeta } from '../middleware/trace-meta.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

/** workflow-templates:scan 扫描结果缓存 TTL（对齐 fs:read-file 裁决：轮询窗口 15s，取 60s） */
export const WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS = 60;

export class WorkflowTemplatesService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'workflow-templates-service' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async handleScan(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'workflow-templates:scan' }, 'controller not found');
      return;
    }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'workflow-templates:scan' }, 'controller offline');
      return;
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, socketId, requestId, op: 'workflow-templates:scan' }, 'socket not found');
      return;
    }
    socket.emit('workflow-templates:scan', withTraceMeta({ requestId, path }));
  }

  async handleScanResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    // template 数组形态运行时校验：非数组按整体失败兜底落键，防异常报文撑爆轮询端解析
    const payload =
      Array.isArray(result.templates)
        ? result
        : { success: false, templates: [], truncated: false, error: 'not found' };
    const redis = getRedisClient();
    await redis.set(
      `workflow-templates:scan:${requestId}`,
      JSON.stringify(payload),
      'EX',
      WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS,
    );
  }
}

export const workflowTemplatesService = new WorkflowTemplatesService();
