import { config } from '../../config/index.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingOutbox } from '../../models/billing-outbox.js';
import { BillingRollup } from '../../models/billing-rollup.js';
import { accountService, type AccountService } from './account-service.js';
import type { BillingService } from './billing-service.js';
import type { ReservationService } from './reservation.js';
import { documentId } from './id.js';

export interface ReconciliationReport {
  line: string;
  ranAt: string;
  checkedCount: number;
  errorCount: number;
  errors: Array<Record<string, unknown>>;
}

export interface ContainerLister {
  (): Promise<
    Array<{
      id: string;
      status: string;
      billingAccountId?: string | null;
      billingStartedAt?: string | null;
      exitedAt?: string | null;
    }>
  >;
}

/** 默认对账线（也可经 GraphQL `runReconciliation(line)` 单线执行）。 */
export const RECONCILIATION_LINES = ['funds', 'metering', 'resources', 'events', 'rollups'] as const;
export type ReconciliationLine = (typeof RECONCILIATION_LINES)[number];

export function isReconciliationLine(value: string): value is ReconciliationLine {
  return (RECONCILIATION_LINES as readonly string[]).includes(value);
}

export interface ReconciliationOptions {
  accounts?: AccountService;
  listContainers: ContainerLister;
  now?: () => number;
  logger?: { warn?: (...args: unknown[]) => void };
}

/** 三线对账：资金（wallet vs Σledger）、计量（事件 vs 计量）、资源（ACTIVE 预留 vs 存活容器）。 */
export class ReconciliationService {
  private readonly accounts: AccountService;
  private readonly now: () => number;
  private readonly logger: NonNullable<ReconciliationOptions['logger']>;
  private lastReports: ReconciliationReport[] = [];

  constructor(
    private readonly billing: BillingService,
    private readonly reservations: ReservationService,
    private readonly options: ReconciliationOptions,
  ) {
    this.accounts = options.accounts ?? accountService;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
  }

  async run(line?: 'funds' | 'metering' | 'resources' | string): Promise<ReconciliationReport[]> {
    if (line && !isReconciliationLine(line)) {
      throw new Error(`unknown reconciliation line: ${line}`);
    }
    const lines = line ? [line] : [...RECONCILIATION_LINES];
    const reports: ReconciliationReport[] = [];
    for (const item of lines) {
      if (item === 'funds') reports.push(await this.reconcileFunds());
      else if (item === 'metering') reports.push(await this.reconcileMetering());
      else if (item === 'resources') reports.push(await this.reconcileResources());
      else if (item === 'events') reports.push(await this.reconcileEvents());
      else if (item === 'rollups') reports.push(await this.reconcileRollups());
    }
    this.lastReports = reports;
    return reports;
  }

  latest(line?: string): ReconciliationReport[] {
    return line ? this.lastReports.filter((report) => report.line === line) : this.lastReports;
  }

  private async reconcileFunds(): Promise<ReconciliationReport> {
    const errors: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (let page = 1; page <= 1000; page += 1) {
      const accounts = await this.accounts.list({ page, pageSize: 200 });
      if (accounts.length === 0) break;
      for (const account of accounts) {
        const result = await this.accounts.reconcileAccount(account.id);
        if (result.error) errors.push(result.error);
        checked += 1;
      }
      if (accounts.length < 200) break;
    }
    return this.report('funds', checked, errors);
  }

  private async reconcileMetering(): Promise<ReconciliationReport> {
    const threshold = new Date(this.now() - Math.max(60_000, config.billingCycleSeconds * 1000));
    const unmetered = await BillingEvent.find({
      metered: false,
      receivedAt: { $lte: threshold },
    }).limit(500);
    return this.report(
      'metering',
      unmetered.length,
      unmetered.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        resourceId: event.resourceId,
      })),
    );
  }

  private async reconcileResources(): Promise<ReconciliationReport> {
    // A1：把 PENDING（start 中断可能残留）也纳入资源对账，避免僵尸预留长期占用资源与额度。
    const scanned = [
      ...(await this.reservations.list({ status: 'ACTIVE' })),
      ...(await this.reservations.list({ status: 'PENDING' })),
    ];
    const seen = new Set<string>();
    const active = scanned.filter((reservation) => {
      const id = documentId(reservation);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    let containers: Array<{ id: string; status: string }>;
    try {
      containers = await this.options.listContainers();
    } catch (err) {
      // 控制面抖动 ≠ 容器全部消失：资源对账线本次中止，绝不对 ACTIVE 预留批量结算/释放。
      this.logger.warn?.(
        `[billing-recon] listContainers failed, abort resources line: ${(err as Error).message}`,
      );
      return this.report('resources', 0, [
        { error: 'list_containers_failed', message: (err as Error).message },
      ]);
    }
    const byId = new Map(containers.map((container) => [container.id, container]));
    const errors: Array<Record<string, unknown>> = [];
    for (const reservation of active) {
      const container = byId.get(reservation.resourceId);
      const alive =
        !!container && ['creating', 'connecting', 'initializing', 'online', 'destroying'].includes(container.status);
      const staleByTimeout =
        !!reservation.expectedEndAt &&
        this.now() > reservation.expectedEndAt.getTime() + config.reservationStaleMs;
      if (alive) {
        // A-3：容器仍存活时绝不 finalize（否则活容器进入 SETTLED 后永久免费跑）。
        // stale 只作为对账信号上报，结算仍由周期扫描继续兜底。
        if (staleByTimeout) {
          errors.push({
            reservationId: documentId(reservation),
            resourceId: reservation.resourceId,
            reason: 'reservation_expired_but_container_alive',
          });
        }
        continue;
      }
      errors.push({
        reservationId: documentId(reservation),
        resourceId: reservation.resourceId,
        reason: 'container_missing',
      });
      try {
        await this.billing.handleContainerDestroyed({
          accountId: String(reservation.accountId),
          resourceId: reservation.resourceId,
          occurredAt: new Date(this.now()),
        });
      } catch (err) {
        this.logger.warn?.(
          `[billing-recon] finalize ${reservation.resourceId} failed: ${(err as Error).message}`,
        );
      }
    }
    return this.report('resources', active.length, errors);
  }

  /**
   * O-1：事件反向对账线。正向对账只能发现「已入事件但未计量」；本线扫描**已计费起点
   * 但事实事件缺失**的容器并补投（覆盖 fire-and-forget 丢事件、停机截断、Mongo 瞬时故障）：
   * - `billingStartedAt!=null` 且无 `container.ready:<id>` 事件/outbox → 补投 ready；
   * - 终态（exited/failed）且无 `container.destroyed:<id>` → 补投 destroyed。
   * 补投写入共享 `billingoutbox`（producer=admin-api），由 admin relay 发布；消费端按 eventId 去重。
   */
  private async reconcileEvents(): Promise<ReconciliationReport> {
    let containers: Array<{
      id: string;
      status: string;
      billingAccountId?: string | null;
      billingStartedAt?: string | null;
      exitedAt?: string | null;
    }>;
    try {
      containers = await this.options.listContainers();
    } catch (err) {
      return this.report('events', 0, [
        { error: 'list_containers_failed', message: (err as Error).message },
      ]);
    }
    const terminal = new Set(['exited', 'failed']);
    const errors: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (const container of containers) {
      if (!container.billingAccountId || !container.billingStartedAt) continue;
      checked += 1;
      const startedAt = container.billingStartedAt;
      const readyId = `container.ready:${container.id}`;
      const recordedReady = await this.eventRecorded(readyId);
      if (!recordedReady) {
        const repaired = await this.repairEvent({
          eventId: readyId,
          eventType: 'container.ready',
          occurredAt: startedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt },
        });
        errors.push({ resourceId: container.id, eventType: 'container.ready', repaired });
      }
      if (!terminal.has(container.status) || !container.exitedAt) continue;
      const destroyedId = `container.destroyed:${container.id}`;
      const recordedDestroyed = await this.eventRecorded(destroyedId);
      if (!recordedDestroyed) {
        const repaired = await this.repairEvent({
          eventId: destroyedId,
          eventType: 'container.destroyed',
          occurredAt: container.exitedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt, exitedAt: container.exitedAt },
        });
        errors.push({ resourceId: container.id, eventType: 'container.destroyed', repaired });
      }
    }
    return this.report('events', checked, errors);
  }

  /**
   * 汇总校准线（建议）：BillingRollup 是账单的派生缓存，写入失败仅告警会让费用汇总永久偏差。
   * 这里按最近 24h 的 hour 桶，把「rollup 累计」与「账单真值」逐账户比对，报告漂移（不自动改写，
   * 由调用方/运维决定是否重算；重算可重放 recordInvoice）。
   */
  private async reconcileRollups(): Promise<ReconciliationReport> {
    const to = new Date(this.now());
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const rollupRows = (await BillingRollup.aggregate([
      { $match: { granularity: 'hour', bucketStart: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$accountId',
          charge: { $sum: '$chargeTotal' },
          recharge: { $sum: '$rechargeTotal' },
          count: { $sum: '$chargeCount' },
        },
      },
    ])) as Array<{ _id: unknown; charge: number; recharge: number; count: number }>;
    const invoiceRows = (await BillingInvoice.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$accountId',
          charge: {
            $sum: { $cond: [{ $eq: ['$type', 'charge'] }, { $abs: '$amount' }, 0] },
          },
          recharge: { $sum: { $cond: [{ $eq: ['$type', 'recharge'] }, '$amount', 0] } },
          count: { $sum: { $cond: [{ $eq: ['$type', 'charge'] }, 1, 0] } },
        },
      },
    ])) as Array<{ _id: unknown; charge: number; recharge: number; count: number }>;

    const key = (value: unknown) => String(value);
    const invoiceMap = new Map(invoiceRows.map((row) => [key(row._id), row]));
    const rollupMap = new Map(rollupRows.map((row) => [key(row._id), row]));
    const accounts = new Set([...invoiceMap.keys(), ...rollupMap.keys()]);
    const errors: Array<Record<string, unknown>> = [];
    for (const accountId of accounts) {
      const rollup = rollupMap.get(accountId);
      const invoice = invoiceMap.get(accountId);
      const rollupCharge = Math.round(rollup?.charge ?? 0);
      const invoiceCharge = Math.round(invoice?.charge ?? 0);
      const rollupRecharge = Math.round(rollup?.recharge ?? 0);
      const invoiceRecharge = Math.round(invoice?.recharge ?? 0);
      if (rollupCharge !== invoiceCharge || rollupRecharge !== invoiceRecharge) {
        errors.push({
          accountId,
          rollupCharge,
          invoiceCharge,
          rollupRecharge,
          invoiceRecharge,
        });
      }
    }
    return this.report('rollups', accounts.size, errors);
  }

  private async eventRecorded(eventId: string): Promise<boolean> {
    const [event, outbox] = await Promise.all([
      BillingEvent.exists({ eventId }),
      BillingOutbox.exists({ eventId }),
    ]);
    return Boolean(event || outbox);
  }

  private async repairEvent(event: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    accountId: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      await BillingOutbox.create({
        eventId: event.eventId,
        producer: 'admin-api',
        eventType: event.eventType,
        routingKey: event.eventType,
        payload: event,
        published: false,
        attempts: 0,
      });
      this.logger.warn?.(`[billing-recon] repaired missing billing event ${event.eventId}`);
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      this.logger.warn?.(
        `[billing-recon] repair event ${event.eventId} failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private report(
    line: string,
    checkedCount: number,
    errors: Array<Record<string, unknown>>,
  ): ReconciliationReport {    return {
      line,
      ranAt: new Date(this.now()).toISOString(),
      checkedCount,
      errorCount: errors.length,
      errors,
    };
  }
}
