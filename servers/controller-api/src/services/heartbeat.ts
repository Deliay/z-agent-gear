import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

const SCAN_INTERVAL_MS = 15_000;
const TIMEOUT_THRESHOLD_MS = 60_000;

export class HeartbeatService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private io: SocketIOServer | null = null;

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
    try {
      const threshold = new Date(Date.now() - TIMEOUT_THRESHOLD_MS);

      const offlineControllers = await Controller.find({
        lastHeartbeatAt: { $lt: threshold },
        status: { $in: ['online', 'offline'] },
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
      console.error('Heartbeat scan error:', err);
    }
  }
}

export const heartbeatService = new HeartbeatService();
