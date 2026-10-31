import { Session } from '../models/session.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

const SCAN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5 * 60_000;

export class DisconnectTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'disconnect-timer' })) {
    this.logger = logger;
  }

  start(): void {
    this.timer = setInterval(() => { void this.scan(); }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<void> {
    const threshold = new Date(Date.now() - TIMEOUT_MS);
    const expired = await Session.find(
      { status: 'disconnected', disconnectedAt: { $lt: threshold } },
      { _id: 1 },
    ).lean();

    if (expired.length === 0) return;

    const ids = expired.map((s) => s._id);
    await Session.updateMany(
      { _id: { $in: ids } },
      { status: 'ended', endedAt: new Date() },
    );

    for (const id of ids) {
      await publish('session:status', { sessionId: String(id), status: 'ended' });
    }

    this.logger.info({ count: ids.length }, 'sessions timed out → ended');
  }
}
