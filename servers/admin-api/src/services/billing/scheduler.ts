import { config } from '../../config/index.js';
import type { AdminOutboxPublisher } from './mq/publisher.js';
import type { ReconciliationService } from './reconciliation.js';
import type { SettlementTickService } from './settlement-tick.js';

export interface BillingSchedulerOptions {
  publisher: AdminOutboxPublisher;
  settlementTick: SettlementTickService;
  reconciliation: ReconciliationService;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

/** 统一注册周期任务：outbox relay、reservation 兜底扫描、每日对账 cron。 */
export class BillingScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly logger: NonNullable<BillingSchedulerOptions['logger']>;
  private lastReconKey: string | null = null;

  constructor(private readonly options: BillingSchedulerOptions) {
    this.logger = options.logger ?? console;
  }

  start(): void {
    this.options.publisher.start();

    // 结算兜底扫描：间隔 = 一个计费周期
    const scanTimer = setInterval(() => {
      void this.options.settlementTick.tick().catch((err) => {
        this.logger.warn?.('[billing-scheduler] settlement sweep failed', (err as Error).message);
      });
    }, Math.max(5000, config.billingCycleSeconds * 1000));
    scanTimer.unref?.();
    this.timers.push(scanTimer);

    // 每日对账 cron（HH:MM UTC）；分钟粒度检查，避免依赖外部 cron 库
    const reconTimer = setInterval(() => {
      const now = new Date();
      const key = `${now.toISOString().slice(0, 10)}T${config.billingReconCron}`;
      if (this.lastReconKey === key) return;
      if (now.toISOString().slice(11, 16) !== config.billingReconCron) return;
      this.lastReconKey = key;
      void this.options.reconciliation.run().catch((err) => {
        this.logger.warn?.('[billing-scheduler] reconciliation failed', (err as Error).message);
      });
    }, 60_000);
    reconTimer.unref?.();
    this.timers.push(reconTimer);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await this.options.publisher.stop();
  }
}
