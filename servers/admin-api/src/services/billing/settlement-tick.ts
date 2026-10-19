import { config } from '../../config/index.js';
import { BillingReservation } from '../../models/billing-reservation.js';
import type { BillingService } from './billing-service.js';
import type { ReservationService } from './reservation.js';
import { documentId } from './id.js';

export interface SettlementTickOptions {
  cycleMs?: number;
  now?: () => number;
  logger?: { warn?: (...args: unknown[]) => void };
  /**
   * A-3：控制面存活探测。stale 判定只能在「确认容器已不存在」时终结预留；
   * 容器仍存活时只补结算周期，绝不置 SETTLED（否则活容器进入免费运行状态）。
   * 未注入时保持历史行为（直接终结），但生产装配必须注入。
   */
  isAlive?: (resourceId: string) => Promise<boolean>;
}

/**
 * 结算扫描兜底（裁决 7）：低频扫描 ACTIVE reservation，对已到期但未被延迟消息触发的周期补结算；
 * 同时处理超期预留（僵尸预留）自动最终结算。
 */
export class SettlementTickService {
  private readonly cycleMs: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<SettlementTickOptions['logger']>;
  private readonly isAlive?: (resourceId: string) => Promise<boolean>;

  constructor(
    private readonly billing: BillingService,
    private readonly reservations: ReservationService,
    options: SettlementTickOptions = {},
  ) {
    this.cycleMs = options.cycleMs ?? config.billingCycleSeconds * 1000;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
    this.isAlive = options.isAlive;
  }

  async tick(): Promise<number> {
    const active = await this.reservations.list({ status: 'ACTIVE' });
    let settled = 0;
    for (const reservation of active) {
      const reservationId = documentId(reservation);
      // A-3：扫描开始时的列表是快照；同一次 tick 内补结算会推进 expectedEndAt。
      // stale 判定必须基于最新值，否则积压追赶场景会把刚续期的预留当场 finalize。
      let fresh = reservation;
      const now = this.now();
      const dueSeq = Math.floor((now - reservation.startedAt.getTime()) / this.cycleMs) - 1;
      const lastSeq = reservation.lastCycleSeq ?? -1;
      if (dueSeq > lastSeq) {
        try {
          const result = await this.billing.handleSettlementCycle(reservationId, lastSeq + 1);
          if (result.settled) settled += 1;
        } catch (err) {
          this.logger.warn?.(
            `[billing-settlement] cycle sweep failed for ${reservationId}: ${(err as Error).message}`,
          );
        }
        // 补结算后回读最新预留（expectedEndAt/lastSettleAt 已推进）。
        fresh = (await this.findByIdSafe(reservationId)) ?? reservation;
      }

      // 超期预留：不依赖销毁事件，自动最终结算释放（PRD 资源对账线）。
      const expectedEnd = fresh.expectedEndAt?.getTime();
      const tickNow = this.now();
      if (!expectedEnd || tickNow <= expectedEnd + config.reservationStaleMs) continue;

      // A-3：终结前复核控制面存活。容器仍存活时只保持周期补结算，绝不置 SETTLED。
      if (this.isAlive) {
        try {
          if (await this.isAlive(fresh.resourceId)) {
            this.logger.warn?.(
              `[billing-settlement] reservation ${reservationId} exceeded stale window but container is alive; skip finalize`,
            );
            continue;
          }
        } catch (err) {
          // 探测失败不等于容器消失：保守跳过，等待下一轮/资源对账。
          this.logger.warn?.(
            `[billing-settlement] liveness probe failed for ${reservationId}: ${(err as Error).message}`,
          );
          continue;
        }
      }
      try {
        await this.billing.handleContainerDestroyed({
          accountId: String(fresh.accountId),
          resourceId: fresh.resourceId,
          occurredAt: new Date(tickNow),
        });
      } catch (err) {
        this.logger.warn?.(
          `[billing-settlement] stale reservation finalize failed for ${reservationId}: ${(err as Error).message}`,
        );
      }
    }
    return settled;
  }

  private async findByIdSafe(reservationId: string) {
    try {
      return await this.reservations.findById(reservationId);
    } catch {
      return null;
    }
  }

  /** 查询 ACTIVE 预留（结算器/对账共用）。 */
  async activeReservations() {
    return BillingReservation.find({ status: 'ACTIVE' });
  }
}
