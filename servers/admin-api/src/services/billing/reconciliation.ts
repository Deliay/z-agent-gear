import { config } from '../../config/index.js';
import { BillingEvent } from '../../models/billing-event.js';
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
  (): Promise<Array<{ id: string; status: string }>>;
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
    const lines = line ? [line] : ['funds', 'metering', 'resources'];
    const reports: ReconciliationReport[] = [];
    for (const item of lines) {
      if (item === 'funds') reports.push(await this.reconcileFunds());
      else if (item === 'metering') reports.push(await this.reconcileMetering());
      else if (item === 'resources') reports.push(await this.reconcileResources());
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
      if (!alive || staleByTimeout) {
        errors.push({
          reservationId: documentId(reservation),
          resourceId: reservation.resourceId,
          reason: alive ? 'reservation_expired' : 'container_missing',
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
    }
    return this.report('resources', active.length, errors);
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
