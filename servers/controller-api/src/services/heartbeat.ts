import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { withSpan } from '../observability/trace.js';

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

      const keyIds = offlineControllers.map((c) => c.keyId.toString());

      await Controller.updateMany(
        { _id: { $in: offlineControllers.map((c) => c._id) } },
        { status: 'offline' },
      );

      for (const keyId of keyIds) {
        const socketId = await sessionService.getSocketId(keyId);
        if (socketId && this.io) {
          this.io.to(socketId).emit('shutdown', { reason: 'heartbeat_timeout' });
          this.io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        await sessionService.cleanupKey(keyId);
      }
    } catch (err) {
      this.logger.error({ err }, 'heartbeat scan error');
    }
    });
  }
}

export const heartbeatService = new HeartbeatService();
