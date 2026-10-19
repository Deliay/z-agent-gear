import { config } from '../../config/index.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
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
export const RECONCILIATION_LINES = [
  'funds',
  'metering',
  'resources',
  'events',
  'rollups',
  'apiCalls',
] as const;
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
      else if (item === 'apiCalls') reports.push(await this.reconcileApiCalls());
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
        try {
          const result = await this.accounts.reconcileAccount(account.id);
          if (result.error) errors.push(result.error);
        } catch (err) {
          errors.push({ accountId: account.id, error: (err as Error).message });
        }
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
      const recordedReady = await this.containerEventDelivered('container.ready', container.id, readyId);
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
      const recordedDestroyed = await this.containerEventDelivered(
        'container.destroyed',
        container.id,
        destroyedId,
      );
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
    // R2-1/🟡1：小时桶起点必须与 rollup 的 UTC 桶对齐，否则 `floor_hour(from)` 桶被排除，
    // 每次运行最多误报 1 小时漂移。
    const bucketFrom = new Date(from.getTime());
    bucketFrom.setUTCMilliseconds(0);
    bucketFrom.setUTCSeconds(0);
    bucketFrom.setUTCMinutes(0);
    const rollupRows = (await BillingRollup.aggregate([
      { $match: { granularity: 'hour', bucketStart: { $gte: bucketFrom, $lte: to } } },
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
      { $match: { createdAt: { $gte: bucketFrom, $lte: to } } },
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
      const rollupCount = Math.round(rollup?.count ?? 0);
      const invoiceCount = Math.round(invoice?.count ?? 0);
      if (
        rollupCharge !== invoiceCharge ||
        rollupRecharge !== invoiceRecharge ||
        rollupCount !== invoiceCount
      ) {
        errors.push({
          accountId,
          rollupCharge,
          invoiceCharge,
          rollupRecharge,
          invoiceRecharge,
          rollupCount,
          invoiceCount,
        });
      }
    }
    return this.report('rollups', accounts.size, errors);
  }

  /**
   * R2-4（A-4 子项三）：模型调用费用 ↔ 账单存在性对账线。
   *
   * `BillingApiCall.cost>0`（已完成/中断且已定价）但 `invoiceSeq=null` 说明扣费/开票链路中断
   * （价源全 0 档、网关外事件、charge 失败等），是「静默免费」的残余发现机制。仅报告差异，
   * 由运维经补价/重放事件收口。
   */
  private async reconcileApiCalls(): Promise<ReconciliationReport> {
    const since = new Date(this.now() - 24 * 60 * 60 * 1000);
    const calls = await BillingApiCall.find({
      cost: { $gt: 0 },
      status: { $in: ['completed', 'aborted'] },
      invoiceSeq: null,
      finishedAt: { $gte: since },
    })
      .select({ requestId: 1, accountId: 1, cost: 1, status: 1, modelId: 1 })
      .lean<
        Array<{
          requestId: string;
          accountId: unknown;
          cost: number;
          status: string;
          modelId: string;
        }>
      >();
    const errors = calls.map((call) => ({
      requestId: call.requestId,
      accountId: String(call.accountId),
      cost: call.cost,
      status: call.status,
      modelId: call.modelId,
      reason: 'cost_without_invoice',
    }));
    return this.report('apiCalls', calls.length, errors);
  }

  /**
   * R2-2：容器事件是否**已投递并生效**——按「业务态 + 投递状态」判定，绝不把行存在当已投递。
   *
   * - outbox 被隔离（`failed:true`）→ 永不投递 → 未完成（补投）。
   * - outbox 已发布但消费失败进 DLQ（业务态未达成）→ 未完成（补投）。
   * - outbox 未发布（在途）→ 交由 relay，视为在途已完成（不补投）。
   * - 业务态优先：ready 命中已建预留/legacy 全额计费键/destroyed 事件（门控跳过）；destroyed 命中
   *   预留终态（SETTLED/SETTLING/RELEASE_PENDING）或 legacy 全额计费键。
   */
  private async containerEventDelivered(
    eventType: 'container.ready' | 'container.destroyed',
    resourceId: string,
    eventId: string,
  ): Promise<boolean> {
    const reservation = await this.reservations.findByResource(resourceId);
    const legacyCharged = await BillingLedger.exists({
      idempotentKey: `charge:container:${resourceId}:final`,
    });
    if (eventType === 'container.ready') {
      if (reservation || legacyCharged) return true;
      if (await BillingEvent.exists({ resourceId, eventType: 'container.destroyed' })) return true;
      return this.deliveryInFlight(eventId);
    }
    if (reservation) {
      return ['SETTLED', 'SETTLING', 'RELEASE_PENDING'].includes(reservation.status);
    }
    if (legacyCharged) return true;
    return this.deliveryInFlight(eventId);
  }

  /** 仅「未发布且未被隔离」的 outbox 行才算在途（隔离/已发布未生效都必须补投）。 */
  private async deliveryInFlight(eventId: string): Promise<boolean> {
    const outbox = await BillingOutbox.findOne({ eventId }).lean<{
      published?: boolean;
      failed?: boolean;
    } | null>();
    if (!outbox) return false;
    if (outbox.failed) return false;
    return !outbox.published;
  }

  /**
   * R2-2：补投必须**可执行**。撞 eventId 唯一索引时按行状态分派：
   * - 隔离行（`failed:true`）→ 重置为待发布（重新入列，保留原 eventId，消费端按业务幂等）；
   * - 已发布却未生效（DLQ/消费失败）→ 以 `…:repair:<ts>` 代偿 eventId 重新入列（`eventId` 只用于
   *   事实去重，资金正确性由业务幂等键保证）。
   */
  private async repairEvent(event: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    accountId: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const insert = async (eventId: string) => {
      await BillingOutbox.create({
        eventId,
        producer: 'admin-api',
        eventType: event.eventType,
        routingKey: event.eventType,
        payload: { ...event, eventId },
        published: false,
        attempts: 0,
      });
    };
    try {
      await insert(event.eventId);
      this.logger.warn?.(`[billing-recon] repaired missing billing event ${event.eventId}`);
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) {
        this.logger.warn?.(
          `[billing-recon] repair event ${event.eventId} failed: ${(err as Error).message}`,
        );
        return false;
      }
    }
    const existing = await BillingOutbox.findOne({ eventId: event.eventId }).lean<{
      published?: boolean;
      failed?: boolean;
    } | null>();
    if (!existing) return false;
    if (existing.failed) {
      await BillingOutbox.updateOne(
        { eventId: event.eventId },
        {
          $set: {
            failed: false,
            published: false,
            publishedAt: null,
            claimedAt: null,
            claimedBy: null,
            lastError: null,
            attempts: 0,
          },
        },
      );
      this.logger.warn?.(`[billing-recon] re-queued quarantined billing event ${event.eventId}`);
      return true;
    }
    if (existing.published) {
      const repairedId = `${event.eventId}:repair:${this.now()}`;
      try {
        await insert(repairedId);
        this.logger.warn?.(
          `[billing-recon] re-injected published-but-incomplete event as ${repairedId}`,
        );
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return true;
        this.logger.warn?.(
          `[billing-recon] repair event ${repairedId} failed: ${(err as Error).message}`,
        );
        return false;
      }
    }
    // 未发布的在途行：交由 relay。
    return true;
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
