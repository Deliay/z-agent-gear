import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { withSpan } from '../observability/trace.js';
import { withTraceMeta } from '../middleware/trace-meta.js';

const SCAN_INTERVAL_MS = 15_000;
const TIMEOUT_THRESHOLD_MS = 60_000;

export class HeartbeatService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'heartbeat' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
    this.intervalId = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async scan(): Promise<void> {
    // 心跳扫描每轮一个 span（不逐事件开 span，F11）。
    await withSpan('heartbeat.tick', { 'messaging.system': 'controller-api' }, async () => {
    try {
      const threshold = new Date(Date.now() - TIMEOUT_THRESHOLD_MS);

      const offlineControllers = await Controller.find({
        lastHeartbeatAt: { $lt: threshold },
        status: 'online',
      }).lean();

      if (offlineControllers.length === 0) return;

      for (const candidate of offlineControllers) {
        const keyId = candidate.keyId.toString();
        // 先捕获所有权：后续只认这个 socketId，不重新读取，避免接管后被误伤。
        const socketId = await sessionService.getSocketId(keyId);

        // 条件状态迁移（CAS）：新连接已刷新心跳时不会命中，直接跳过。
        const markedOffline = await Controller.findOneAndUpdate(
          {
            _id: candidate._id,
            status: 'online',
            lastHeartbeatAt: { $lt: threshold },
          },
          { status: 'offline' },
          { returnDocument: 'after' },
        );
        if (!markedOffline) continue;

        if (socketId && this.io) {
          this.io.to(socketId).emit('shutdown', withTraceMeta({ reason: 'heartbeat_timeout' }));
          this.io.sockets.sockets.get(socketId)?.disconnect(true);
        }

        if (!socketId) {
          // 无会话：只清理心跳/恢复凭据，避免误删并发写入的新 session。
          await sessionService.removeHeartbeat(keyId);
          await sessionService.removeResumeToken(keyId);
          continue;
        }

        const released = await sessionService.releaseSession(keyId, socketId);
        if (released) {
          await sessionService.removeHeartbeat(keyId);
          await sessionService.removeResumeToken(keyId);
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'heartbeat scan error');
    }
    });
  }
}

export const heartbeatService = new HeartbeatService();
