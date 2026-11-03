import { config } from '../../config/index.js';
import type { AdminOutboxPublisher } from './mq/publisher.js';
import type { ReconciliationService } from './reconciliation.js';
import type { SettlementTickService } from './settlement-tick.js';
import type { MqLogger } from './mq/connection.js';

export interface BillingSchedulerOptions {
  publisher: AdminOutboxPublisher;
  settlementTick: SettlementTickService;
  reconciliation: ReconciliationService;
  logger: MqLogger;
  /** 云存储整点结算 tick（可选，缺省不注册，兼容既有单测构造）。 */
  storageTick?: { tick(): Promise<unknown> };
}

/** 统一注册周期任务：outbox relay、reservation 兜底扫描、每日对账 cron。 */
export class BillingScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly logger: MqLogger;
  /** 上次**成功**执行每日对账的时间（R10-11：错过 cron 分钟后按间隔补跑）。 */
  private lastReconAt: number | null = null;
  private reconRunning = false;

  constructor(private readonly options: BillingSchedulerOptions) {
    this.logger = options.logger;
  }

  start(): void {
    this.options.publisher.start();

    // 结算兜底扫描：间隔 = 一个计费周期
    const scanTimer = setInterval(() => {
      void this.options.settlementTick.tick().catch((err) => {
        this.logger.warn({ err }, '[billing-scheduler] settlement sweep failed');
      });
    }, Math.max(5000, config.billingCycleSeconds * 1000));
    scanTimer.unref?.();
    this.timers.push(scanTimer);

    // R10-11：每日对账不再按「分钟精确匹配」，改为「距上次成功 ≥ 24h 即执行」。
    // 进程在 cron 分钟未运行、重启或短暂故障后会立即补跑，避免整日跳过。
    const reconTimer = setInterval(() => {
      if (this.reconRunning) return;
      const now = Date.now();
      if (this.lastReconAt !== null && now - this.lastReconAt < config.billingReconIntervalMs) {
        return;
      }
      this.reconRunning = true;
      void this.options.reconciliation
        .run()
        .then(() => {
          this.lastReconAt = Date.now();
        })
        .catch((err) => {
          // 失败不更新 lastReconAt：下一分钟继续补跑。
          this.logger.warn({ err }, '[billing-scheduler] reconciliation failed');
        })
        .finally(() => {
          this.reconRunning = false;
        });
    }, 60_000);
    reconTimer.unref?.();
    this.timers.push(reconTimer);

    // 云存储整点结算：默认 5 分钟扫描一次（STORAGE_BILLING_TICK_MS），失败不阻断后续 tick。
    if (this.options.storageTick) {
      const storageTimer = setInterval(() => {
        void this.options.storageTick!.tick().catch((err) => {
          this.logger.warn({ err }, '[billing-scheduler] storage billing tick failed');
        });
      }, Math.max(5000, config.storageBillingTickMs));
      storageTimer.unref?.();
      this.timers.push(storageTimer);
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await this.options.publisher.stop();
  }
}
