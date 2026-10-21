import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { BillingApiKey } from '../../models/billing-api-key.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingOutbox } from '../../models/billing-outbox.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { BillingRollup } from '../../models/billing-rollup.js';
import { CloudHost } from '../../models/cloud-host.js';
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
  'containerInvoices',
  'cloud-host-keys',
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
      else if (item === 'containerInvoices')
        reports.push(await this.reconcileContainerInvoices());
      else if (item === 'cloud-host-keys') reports.push(await this.reconcileCloudHostKeys());
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
   * 但事实事件未生效**的容器并补投（覆盖 fire-and-forget 丢事件、停机截断、Mongo 瞬时故障）：
   * - ready：按「业务态」（已建预留 / legacy 全额计费键 / destroyed 已摄入）判是否已生效；
   * - destroyed：按「预留终态 / legacy 全额计费键 / 零计费窗口」判是否已生效。
   * 隔离行（`failed:true`）与已发布未生效行（DLQ/消费失败）都**不算已投递**，必须补投；
   * 补投写入共享 `billingoutbox`（producer=admin-api），由 admin relay 发布，且每个原始事件至多补投一次
   * （`repairOf` 护栏）避免无限放大。消费端按业务幂等键保证无重复计费。
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
      const recordedReady = await this.containerEventDelivered('container.ready', container.id, readyId, {
        startedAt,
        exitedAt: container.exitedAt ?? null,
      });
      if (!recordedReady) {
        const action = await this.repairEvent({
          eventId: readyId,
          eventType: 'container.ready',
          occurredAt: startedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt },
        });
        errors.push({ resourceId: container.id, eventType: 'container.ready', action });
      }
      if (!terminal.has(container.status) || !container.exitedAt) continue;
      const destroyedId = `container.destroyed:${container.id}`;
      const recordedDestroyed = await this.containerEventDelivered(
        'container.destroyed',
        container.id,
        destroyedId,
        { startedAt, exitedAt: container.exitedAt },
      );
      if (!recordedDestroyed) {
        const action = await this.repairEvent({
          eventId: destroyedId,
          eventType: 'container.destroyed',
          occurredAt: container.exitedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt, exitedAt: container.exitedAt },
        });
        errors.push({ resourceId: container.id, eventType: 'container.destroyed', action });
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
   * R2-4（A-4 子项三）+ R10-3/R10-4：模型调用对账线。
   *
   * 1. **发现即补投**：`cost>0` 但 `invoiceSeq=null` 的 completed/aborted 调用，直接复用
   *    `repairEvent` 补投 `model_call.*`（失败行复位、已发布未生效行走 `repairOf` 代偿护栏）；
   * 2. **隔离复位**：`model_call.*` 的 `failed:true` outbox 行自动复位（此前只有容器事件有复位线，
   *    模型调用隔离后无人补投）；
   * 3. **孤儿发现**：`started/failed` 且超过阈值仍未收口的调用纳入报告（UI 不再显示为「完成」）。
   */
  private async reconcileApiCalls(): Promise<ReconciliationReport> {
    const since = new Date(this.now() - 24 * 60 * 60 * 1000);
    const orphanBefore = new Date(this.now() - config.billingApiCallOrphanMs);
    const calls = await BillingApiCall.find({
      cost: { $gt: 0 },
      status: { $in: ['completed', 'aborted'] },
      invoiceSeq: null,
      finishedAt: { $gte: since },
    })
      .select({
        requestId: 1,
        accountId: 1,
        cost: 1,
        status: 1,
        modelId: 1,
        inputTokens: 1,
        cachedInputTokens: 1,
        outputTokens: 1,
        estimated: 1,
        finishedAt: 1,
        startedAt: 1,
      })
      .lean<
        Array<{
          requestId: string;
          accountId: unknown;
          cost: number;
          status: string;
          modelId: string;
          inputTokens?: number;
          cachedInputTokens?: number;
          outputTokens?: number;
          estimated?: boolean;
          finishedAt?: Date | null;
          startedAt?: Date | null;
        }>
      >();

    const errors: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const eventType =
        call.status === 'aborted' ? 'model_call.aborted' : 'model_call.completed';
      const action = await this.repairEvent({
        eventId: `${eventType}:${call.requestId}`,
        eventType,
        occurredAt: (call.finishedAt ?? call.startedAt ?? new Date(this.now())).toISOString(),
        accountId: String(call.accountId),
        resourceId: call.requestId,
        payload: {
          modelId: call.modelId,
          inputTokens: call.inputTokens ?? 0,
          cachedInputTokens: call.cachedInputTokens ?? 0,
          outputTokens: call.outputTokens ?? 0,
          estimated: call.estimated === true,
          estimatedInputTokens: call.inputTokens ?? 0,
          estimatedOutputTokens: call.outputTokens ?? 0,
          ...(call.status === 'aborted' ? { reason: 'reconciled_aborted' } : {}),
        },
      });
      errors.push({
        requestId: call.requestId,
        accountId: String(call.accountId),
        cost: call.cost,
        status: call.status,
        modelId: call.modelId,
        reason: 'cost_without_invoice',
        repair: action,
      });
    }

    // R10-3：模型调用 outbox 隔离行复位（与 events 线的容器事件复位同标准）。
    const quarantined = await BillingOutbox.find({
      producer: 'admin-api',
      failed: true,
      eventType: { $in: ['model_call.completed', 'model_call.aborted'] },
    })
      .select({ eventId: 1 })
      .limit(200)
      .lean<Array<{ eventId: string }>>();
    for (const row of quarantined) {
      await BillingOutbox.updateOne(
        { eventId: row.eventId },
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
      this.logger.warn?.(`[billing-recon] re-queued quarantined model call event ${row.eventId}`);
      errors.push({ eventId: row.eventId, reason: 'quarantined_event_requeued' });
    }

    // R10-4：started/failed 孤儿调用（finish 前崩溃或落库失败）必须可发现。
    const orphans = await BillingApiCall.find({
      status: { $in: ['started', 'failed'] },
      // 只看最近 24h 内、已超过孤儿阈值仍未收口的调用，避免历史失败记录每日重复报警。
      startedAt: { $gte: since, $lte: orphanBefore },
    })
      .select({ requestId: 1, accountId: 1, status: 1, modelId: 1, startedAt: 1, finishedAt: 1 })
      .limit(500)
      .lean<
        Array<{
          requestId: string;
          accountId: unknown;
          status: string;
          modelId: string;
          startedAt?: Date | null;
          finishedAt?: Date | null;
        }>
      >();
    for (const call of orphans) {
      errors.push({
        requestId: call.requestId,
        accountId: String(call.accountId),
        modelId: call.modelId,
        status: call.status,
        startedAt: call.startedAt?.toISOString() ?? null,
        finishedAt: call.finishedAt?.toISOString() ?? null,
        reason: 'orphan_api_call',
      });
    }

    return this.report('apiCalls', calls.length + quarantined.length + orphans.length, errors);
  }

  /**
   * R6-1（对齐 R2-4 `apiCalls` 线）：容器 **charge 流水 ↔ 账单 ↔ 收据** 存在性对账。
   *
   * 结算层「先扣费、后开票」非原子，进程在中间崩溃会留下「ledger 有扣费、账单缺失」的凭证空洞；
   * 开票内部「先建账单、后开收据」同样非原子（R7-1），会留下「账单在、收据缺」的子窗口。
   * 正常重放已能自愈（`BillingService.reconcileContainerInvoices` / `repairCycleInvoice`），但若事件
   * 不再重投（outbox 清理、对账兜底场景），需要一条独立的发现线。**仅报告，不自动改账**。
   *
   * 覆盖：
   * - `…:final:<from>:<to>` → 账单 `invoice:container-final:<rid>` 且 `[periodFrom,periodTo]` 覆盖窗口；
   * - `…:final-gap:<from>:<to>` → 账单 `invoice:container-final-gap:<rid>:<from>` 覆盖窗口；
   * - `…:cycle:<seq>` → 账单 `invoice:container-cycle:<rid>:<seq>`；
   * - 任一上述账单缺对应 `BillingReceipt`（按 `invoiceId`）→ `invoice_without_receipt`。
   * 零额流水（零价窗口）无需出账，跳过。
   */
  private async reconcileContainerInvoices(): Promise<ReconciliationReport> {
    const since = new Date(this.now() - 24 * 60 * 60 * 1000);
    const rows = await BillingLedger.find({
      bizType: 'charge',
      createdAt: { $gte: since },
      bizId: { $regex: '^reservation:[^:]+:(final|final-gap|cycle):' },
    })
      .select({ accountId: 1, deltaBalance: 1, bizId: 1 })
      .lean<Array<{ accountId: unknown; deltaBalance?: number; bizId?: string | null }>>();

    const errors: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (const row of rows) {
      const bizId = row.bizId ?? '';
      const match = /^reservation:([^:]+):(final|final-gap|cycle):(.+)$/.exec(bizId);
      if (!match) continue;
      const [, reservationId, kind, rest] = match;
      const amount = Math.abs(Math.round(row.deltaBalance ?? 0));
      if (amount <= 0) continue;
      checked += 1;

      const mainKey = `invoice:container-final:${reservationId}`;
      let invoiceKeys: string[];
      let window: { from: number; to: number } | null = null;
      if (kind === 'cycle') {
        invoiceKeys = [`invoice:container-cycle:${reservationId}:${rest}`];
      } else {
        const parsed = /^(\d+):(\d+)$/.exec(rest);
        if (!parsed) continue;
        window = { from: Number(parsed[1]), to: Number(parsed[2]) };
        // 主路径的一张主账单会覆盖 `final` + 当次 `final-gap`，故缺口行需同时看主账单。
        invoiceKeys =
          kind === 'final'
            ? [mainKey]
            : [`invoice:container-final-gap:${reservationId}:${window.from}`, mainKey];
      }

      const invoices = await BillingInvoice.find({ idempotentKey: { $in: invoiceKeys } })
        .select({ periodFrom: 1, periodTo: 1 })
        .lean<Array<{ periodFrom?: Date | null; periodTo?: Date | null }>>();
      const covered = invoices.some((invoice) =>
        window && invoice.periodFrom && invoice.periodTo
          ? new Date(invoice.periodFrom).getTime() <= window.from &&
            new Date(invoice.periodTo).getTime() >= window.to
          : true,
      );
      if (!covered) {
        errors.push({
          accountId: String(row.accountId),
          reservationId,
          kind,
          bizId,
          amount,
          invoiceKey: invoiceKeys[0],
          reason: 'charge_without_invoice',
        });
      }
    }
    // R7-1：invoice ↔ receipt 存在性。`createInvoice` 与 `issueReceipt` 是两次独立写，
    // 中间崩溃/瞬时失败会留下「账单在、收据缺」的凭证空洞（不属于 charge↔invoice 盲区）。
    const invoiceRows = await BillingInvoice.find({
      category: 'container',
      createdAt: { $gte: since },
      idempotentKey: { $regex: '^invoice:container-(final|final-gap|cycle):' },
    })
      .select({ _id: 1, idempotentKey: 1, amount: 1 })
      .lean<
        Array<{ _id: mongoose.Types.ObjectId; idempotentKey?: string | null; amount?: number }>
      >();
    const invoiceIds = invoiceRows.map((invoice) => invoice._id);
    const receiptRows = invoiceIds.length
      ? await BillingReceipt.find({ invoiceId: { $in: invoiceIds } })
          .select({ invoiceId: 1 })
          .lean<Array<{ invoiceId: unknown }>>()
      : [];
    const invoicedIds = new Set(receiptRows.map((row) => String(row.invoiceId)));
    for (const invoice of invoiceRows) {
      checked += 1;
      if (invoicedIds.has(String(invoice._id))) continue;
      errors.push({
        invoiceId: String(invoice._id),
        idempotentKey: invoice.idempotentKey ?? null,
        amount: Math.abs(Math.round(invoice.amount ?? 0)),
        reason: 'invoice_without_receipt',
      });
    }
    return this.report('containerInvoices', checked, errors);
  }

  /**
   * A16/B9 对账线：扫描 `scope=cloud_host,status=active` 的运行专用 Key，宿主不存在/已软删除/
   * **非合法中间态**（`STOPPING/STOPPED/FAILED`）或 Key 已过期时幂等撤销，并写入报告。
   * `STARTING` 属于创建窗口（Key 在 STARTING 期铸造、本期无重铸），必须放行——由网关实时校验
   * 拒绝非 `RUNNING` 调用；账号 Key 不在扫描范围，绝不误伤。
   *
   * 网关鉴权已做实时失效（双保险）；本线兜底「停止/删除编排未显式 revoke」「TTL 自然退出」等遗漏。
   */
  private async reconcileCloudHostKeys(): Promise<ReconciliationReport> {
    const now = this.now();
    const keys = await BillingApiKey.find({ scope: 'cloud_host', status: 'active' })
      .select({ keyPrefix: 1, cloudHostId: 1, expiresAt: 1 })
      .lean<
        Array<{
          _id: unknown;
          keyPrefix?: string;
          cloudHostId?: unknown;
          expiresAt?: Date | null;
        }>
      >();

    const hostIds = [
      ...new Set(
        keys
          .map((key) => (key.cloudHostId ? String(key.cloudHostId) : ''))
          .filter((id) => mongoose.isValidObjectId(id)),
      ),
    ].map((id) => new mongoose.Types.ObjectId(id));
    const hosts = hostIds.length
      ? await CloudHost.find({ _id: { $in: hostIds } })
          .select({ status: 1, deletedAt: 1 })
          .lean<Array<{ _id: unknown; status?: string; deletedAt?: Date | null }>>()
      : [];
    const byId = new Map(hosts.map((host) => [String(host._id), host]));

    const errors: Array<Record<string, unknown>> = [];
    for (const key of keys) {
      const cloudHostId = key.cloudHostId ? String(key.cloudHostId) : '';
      const host = cloudHostId ? byId.get(cloudHostId) : undefined;
      const expired = !!key.expiresAt && new Date(key.expiresAt).getTime() <= now;
      let reason: string | null = null;
      if (!cloudHostId) reason = 'missing_cloud_host';
      else if (!host) reason = 'cloud_host_missing';
      else if (host.deletedAt) reason = 'cloud_host_deleted';
      else if (host.status !== 'RUNNING' && host.status !== 'STARTING') {
        reason = 'cloud_host_not_running';
      } else if (!key.expiresAt) reason = 'missing_expiry';
      else if (expired) reason = 'expired';
      if (!reason) continue;

      const result = await BillingApiKey.updateOne(
        { _id: key._id, status: 'active' },
        { $set: { status: 'revoked' } },
      );
      errors.push({
        keyId: String(key._id),
        keyPrefix: key.keyPrefix ?? null,
        cloudHostId: cloudHostId || null,
        reason,
        action: (result.modifiedCount ?? 0) > 0 ? 'revoked' : 'already_revoked',
      });
    }
    return this.report('cloud-host-keys', keys.length, errors);
  }

  /**
   * R2-2/R3-2：容器事件是否**已投递并生效**——按「业务态 + 投递状态」判定，绝不把行存在当已投递。
   *
   * - outbox 被隔离（`failed:true`）→ 永不投递 → 未完成（补投）。
   * - outbox 已发布但消费失败进 DLQ（业务态未达成）→ 未完成（补投）。
   * - outbox 未发布（在途）→ 交由 relay，视为在途已完成（不补投）。
   * - 业务态优先：ready 命中已建预留/legacy 全额计费键/destroyed 事件（门控跳过）；destroyed 命中
   *   预留**终态**（SETTLED/SETTLING/RELEASE_PENDING/FAILED）或 legacy 全额计费键，**或计费窗口为零**
   *   （起止相同 → 无论补投多少次都不会产生费用，视为已收敛，避免无限补投）。
   */
  private async containerEventDelivered(
    eventType: 'container.ready' | 'container.destroyed',
    resourceId: string,
    eventId: string,
    window: { startedAt: string; exitedAt?: string | null },
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
      // R3-2：FAILED 为终态（冻结/建预留中途失败，`finalSettle` 的 CAS 只匹配 ACTIVE/PENDING，
      // 永不再收敛）。把它判为「已收敛」而非反复补投，避免每轮对账新增一条 `…:repair:` 无上限。
      return ['SETTLED', 'SETTLING', 'RELEASE_PENDING', 'FAILED'].includes(reservation.status);
    }
    if (legacyCharged) return true;
    if (this.isZeroBillingWindow(window)) return true;
    return this.deliveryInFlight(eventId);
  }

  /** 计费窗口为零（起止相同或更早）：补投也不会产生任何费用，视为已收敛。 */
  private isZeroBillingWindow(window: { startedAt: string; exitedAt?: string | null }): boolean {
    if (!window.exitedAt) return false;
    const from = new Date(window.startedAt).getTime();
    const to = new Date(window.exitedAt).getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) return false;
    return to <= from;
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
   * R2-2/R3-2：补投必须**可执行**且**有界**。撞 eventId 唯一索引时按行状态分派：
   * - 隔离行（`failed:true`）→ 重置为待发布（重新入列，保留原 eventId，消费端按业务幂等）；
   * - 已发布却未生效（DLQ/消费失败）→ 以 `…:repair:<ts>` 代偿 eventId 重新入列（`eventId` 只用于
   *   事实去重，资金正确性由业务幂等键保证），并写 `repairOf` 标记；**每个原始事件至多补投一次**。
   *
   * 返回补投动作（`injected`/`requeued`/`bounded`/`in-flight`/`failed`），供对账报告如实呈现。
   */
  private async repairEvent(event: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    accountId: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<'injected' | 'requeued' | 'bounded' | 'in-flight' | 'failed'> {
    const insert = async (eventId: string, repairOf: string | null) => {
      await BillingOutbox.create({
        eventId,
        producer: 'admin-api',
        eventType: event.eventType,
        routingKey: event.eventType,
        payload: { ...event, eventId },
        published: false,
        attempts: 0,
        repairOf,
      });
    };
    // 已补投过（同源事件存在代偿行）→ 不再补投（收敛护栏）。
    if (await BillingOutbox.exists({ repairOf: event.eventId })) return 'bounded';
    try {
      await insert(event.eventId, null);
      this.logger.warn?.(`[billing-recon] repaired missing billing event ${event.eventId}`);
      return 'injected';
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) {
        this.logger.warn?.(
          `[billing-recon] repair event ${event.eventId} failed: ${(err as Error).message}`,
        );
        return 'failed';
      }
    }
    const existing = await BillingOutbox.findOne({ eventId: event.eventId }).lean<{
      published?: boolean;
      failed?: boolean;
    } | null>();
    if (!existing) return 'failed';
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
      return 'requeued';
    }
    if (existing.published) {
      const repairedId = `${event.eventId}:repair:${this.now()}`;
      try {
        await insert(repairedId, event.eventId);
        this.logger.warn?.(
          `[billing-recon] re-injected published-but-incomplete event as ${repairedId}`,
        );
        return 'injected';
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return 'bounded';
        this.logger.warn?.(
          `[billing-recon] repair event ${repairedId} failed: ${(err as Error).message}`,
        );
        return 'failed';
      }
    }
    // 未发布的在途行：交由 relay（语义为「无动作」，不再谎报已补投）。
    return 'in-flight';
  }

  private report(
    line: string,
    checkedCount: number,
    errors: Array<Record<string, unknown>>,
  ): ReconciliationReport {
    return {
      line,
      ranAt: new Date(this.now()).toISOString(),
      checkedCount,
      errorCount: errors.length,
      errors,
    };
  }
}
