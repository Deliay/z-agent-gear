import { config } from '../../config/index.js';
import { BillingReservation } from '../../models/billing-reservation.js';
import type { BillingService } from './billing-service.js';
import type { ReservationService } from './reservation.js';
import { documentId } from './id.js';

export interface SettlementTickOptions {
  cycleMs?: number;
  now?: () => number;
  logger?: { warn?: (...args: unknown[]) => void };
}

/**
 * 结算扫描兜底（裁决 7）：低频扫描 ACTIVE reservation，对已到期但未被延迟消息触发的周期补结算；
 * 同时处理超期预留（僵尸预留）自动最终结算。
 */
export class SettlementTickService {
  private readonly cycleMs: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<SettlementTickOptions['logger']>;

  constructor(
    private readonly billing: BillingService,
    private readonly reservations: ReservationService,
    options: SettlementTickOptions = {},
  ) {
    this.cycleMs = options.cycleMs ?? config.billingCycleSeconds * 1000;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
  }

  async tick(): Promise<number> {
    const active = await this.reservations.list({ status: 'ACTIVE' });
    let settled = 0;
    for (const reservation of active) {
      const now = this.now();
      const startedAt = reservation.startedAt.getTime();
      const dueSeq = Math.floor((now - startedAt) / this.cycleMs);
      const lastSeq = reservation.lastCycleSeq ?? 0;
      // 只补一期，避免同一 tick 内连续扣费；后续周期由下一 tick / 延迟消息推进。
      if (dueSeq > lastSeq) {
        try {
          const result = await this.billing.handleSettlementCycle(
            documentId(reservation),
            lastSeq + 1,
          );
          if (result.settled) settled += 1;
        } catch (err) {
          this.logger.warn?.(
            `[billing-settlement] cycle sweep failed for ${documentId(reservation)}: ${(err as Error).message}`,
          );
        }
      }

      // 超期预留：不依赖销毁事件，自动最终结算释放（PRD 资源对账线）。
      const expectedEnd = reservation.expectedEndAt?.getTime();
      if (expectedEnd && now > expectedEnd + config.reservationStaleMs) {
        try {
          await this.billing.handleContainerDestroyed({
            accountId: String(reservation.accountId),
            resourceId: reservation.resourceId,
            occurredAt: new Date(now),
          });
        } catch (err) {
          this.logger.warn?.(
            `[billing-settlement] stale reservation finalize failed for ${documentId(reservation)}: ${(err as Error).message}`,
          );
        }
      }
    }
    return settled;
  }

  /** 查询 ACTIVE 预留（结算器/对账共用）。 */
  async activeReservations() {
    return BillingReservation.find({ status: 'ACTIVE' });
  }
}
