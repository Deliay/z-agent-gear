import { logger as rootLogger } from '../../observability/logger.js';
import { config } from '../../config/index.js';
import { BillingAccount } from '../../models/billing-account.js';
import { CloudBillingCursor } from '../../models/cloud-billing-cursor.js';
import { accountService, type AccountService } from './account-service.js';
import { CONTAINER_FORCE_DESTROY_REASON } from './constants.js';
import { InsufficientBalanceError } from './one-time-charge.js';
import {
  SpecChargeService,
  specChargeService,
  type SpecChargeInput,
} from './spec-charge.js';
import {
  quoteSpecHourly,
  SpecPricingService,
  specPricingService,
} from './spec-pricing.js';

const logger = rootLogger.child({ component: 'billing-spec-tick' });

export const SPEC_BILLING_HOUR_MS = 60 * 60 * 1000;
export const SPEC_BILLING_MINUTES_PER_HOUR = 60;
/** 单次 tick 每个容器最多补结算 24 小时（防止长期停机后一次开出巨额账单）。 */
export const SPEC_BILLING_MAX_HOURS_PER_TICK = 24;

export interface SpecTickResult {
  scanned: number;
  chargedHours: number;
  chargedTails: number;
  closed: number;
  /** 欠费宽限到期后下发强拆的容器数（本次 tick）。 */
  destroyed: number;
}

interface CursorRow {
  _id: unknown;
  resourceId: string;
  hostId?: string | null;
  hostName?: string | null;
  accountId: unknown;
  tenantId?: string | null;
  specId?: string | null;
  specName?: string | null;
  specCpu?: number | null;
  specMemoryGi?: number | null;
  specEphemeralStorageGi?: number | null;
  billingStartedAt?: Date | null;
  chargedMinutes?: number | null;
  destroyedAt?: Date | null;
  closedAt?: Date | null;
}

export interface SpecTickOptions {
  now?: () => number;
  charge?: (input: SpecChargeInput) => Promise<{ amountCents: number }>;
  prices?: Pick<SpecPricingService, 'unitPrices'>;
  accounts?: Pick<AccountService, 'markInsufficient'>;
  maxHoursPerTick?: number;
  /** 欠费强拆执行器（缺省不执行，由 index 注入 cloud-controller destroy）。 */
  destroy?: (resourceId: string, reason: string) => Promise<void>;
}

/**
 * 云电脑规格小时桶结算 tick：
 * - 桶锚点 = `billingStartedAt`；第 n 桶 `[start + n·1h, start + (n+1)·1h)`；
 * - 活跃容器只结算**已完整结束**的桶（`due = floor((now-start)/1h)`，单次最多 24 桶）；
 * - 逐桶按**桶末时刻**取价目（调价只影响生效后的桶），幂等键
 *   `cloud_host.spec.hour:<resourceId>:<bucketEndEpochHour>`；
 * - 收到销毁事件时写 `destroyedAt`，结算全部未结整桶 + 尾段分钟折算（不足 1 分钟按 1 分钟，
 *   幂等键 `cloud_host.spec.tail:<resourceId>`，至多出账一次）后置 `closedAt`；
 * - 失败即停：记 `lastError` + `markInsufficient`，下个 tick 重试（持久化的 `destroyedAt` 保证重启也可收敛）。
 */
export class SpecTickService {
  private readonly now: () => number;
  private readonly charge: (input: SpecChargeInput) => Promise<{ amountCents: number }>;
  private readonly prices: Pick<SpecPricingService, 'unitPrices'>;
  private readonly accounts: Pick<AccountService, 'markInsufficient'>;
  private readonly maxHoursPerTick: number;
  private destroy?: (resourceId: string, reason: string) => Promise<void>;

  constructor(options: SpecTickOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.charge = options.charge ?? ((input) => specChargeService.chargePeriod(input));
    this.prices = options.prices ?? specPricingService;
    this.accounts = options.accounts ?? accountService;
    this.maxHoursPerTick = options.maxHoursPerTick ?? SPEC_BILLING_MAX_HOURS_PER_TICK;
    this.destroy = options.destroy;
  }

  /** 生产入口注入强拆执行器（避免 spec-tick → instances → billing-service 的循环依赖）。 */
  setDestroyer(destroy: (resourceId: string, reason: string) => Promise<void>): void {
    this.destroy = destroy;
  }

  private resourceSpec(cursor: CursorRow): {
    cpu: number;
    memoryGi: number;
    ephemeralStorageGi: number;
  } {
    return {
      cpu: Number(cursor.specCpu ?? 0),
      memoryGi: Number(cursor.specMemoryGi ?? 0),
      ephemeralStorageGi: Number(cursor.specEphemeralStorageGi ?? 0),
    };
  }

  async tick(): Promise<SpecTickResult> {
    const now = new Date(this.now());
    const rows = await CloudBillingCursor.find({ closedAt: null }).lean<CursorRow[]>();
    const result: SpecTickResult = { scanned: rows.length, chargedHours: 0, chargedTails: 0, closed: 0, destroyed: 0 };
    for (const row of rows) {
      try {
        await this.tickCursor(row, now, result);
      } catch (err) {
        logger.error(
          { err, resourceId: row.resourceId },
          '[billing] spec tick failed for container',
        );
      }
    }
    await this.enforceArrears(now, result).catch((err) => {
      logger.warn({ err }, '[billing] spec arrears enforcement failed');
    });
    return result;
  }

  /**
   * P1-4：规格计费容器欠费宽限到期强拆。
   *
   * `markFailure` 只记录 `insufficientSince`；本方法对「存在出账失败游标 + 账户 insufficientSince
   * 已超 `BILLING_ARREARS_GRACE_MS`」的容器下发强拆（复用 cloud-controller destroy + 统一原因），
   * 与旧版预留链路的欠费处置口径一致；强拆成功写 `arrearsDestroyedAt` 幂等标记（失败下个 tick 重试）。
   * 强拆后由 `container.destroyed` 事件触发尾段结算收口。
   */
  private async enforceArrears(now: Date, result: SpecTickResult): Promise<void> {
    const rows = await CloudBillingCursor.find({
      closedAt: null,
      lastError: { $ne: null },
      arrearsDestroyedAt: null,
    }).lean<CursorRow[]>();
    if (rows.length === 0) return;

    const byAccount = new Map<string, CursorRow[]>();
    for (const row of rows) {
      const accountId = String(row.accountId);
      const bucket = byAccount.get(accountId) ?? [];
      bucket.push(row);
      byAccount.set(accountId, bucket);
    }

    for (const [accountId, cursors] of byAccount) {
      const account = await BillingAccount.findById(accountId)
        .select({ insufficientSince: 1 })
        .lean<{ insufficientSince?: Date | null } | null>();
      const insufficientSince = account?.insufficientSince;
      if (!insufficientSince) continue;
      if (now.getTime() - new Date(insufficientSince).getTime() < config.billingArrearsGraceMs) {
        continue;
      }
      for (const cursor of cursors) {
        try {
          if (this.destroy) {
            await this.destroy(cursor.resourceId, CONTAINER_FORCE_DESTROY_REASON);
          }
          await CloudBillingCursor.updateOne(
            { resourceId: cursor.resourceId, arrearsDestroyedAt: null },
            { $set: { arrearsDestroyedAt: now } },
          );
          if (this.destroy) {
            result.destroyed += 1;
            logger.info(
              { resourceId: cursor.resourceId, hostId: cursor.hostId, accountId },
              '[billing] spec container force destroyed for arrears',
            );
          }
        } catch (err) {
          logger.warn(
            { err, resourceId: cursor.resourceId, accountId },
            '[billing] spec arrears force destroy failed',
          );
        }
      }
    }
  }

  /**
   * 销毁事件立即收口：写入 `destroyedAt` 后结算全部未结整桶 + 尾段并关账。
   * 失败保留游标（`closedAt=null`），由后续 tick 按持久化的 `destroyedAt` 重试。
   */
  async settleTail(resourceId: string, exitedAt: Date): Promise<{ closed: boolean }> {
    const now = new Date(this.now());
    const row = await CloudBillingCursor.findOne({ resourceId }).lean<CursorRow | null>();
    if (!row || row.closedAt) return { closed: Boolean(row?.closedAt) };
    const destroyedAt = Number.isNaN(exitedAt.getTime()) ? now : exitedAt;
    await CloudBillingCursor.updateOne(
      { resourceId, closedAt: null },
      { $set: { destroyedAt } },
    );
    row.destroyedAt = destroyedAt;
    const result: SpecTickResult = { scanned: 1, chargedHours: 0, chargedTails: 0, closed: 0, destroyed: 0 };
    await this.tickCursor(row, now, result);
    const after = await CloudBillingCursor.findOne({ resourceId })
      .select({ closedAt: 1 })
      .lean<{ closedAt?: Date | null } | null>();
    return { closed: Boolean(after?.closedAt) };
  }

  private async advance(
    cursor: CursorRow,
    nextChargedMinutes: number,
    now: Date,
  ): Promise<void> {
    // `$max` 推进、绝不回退（并发/重放安全）。
    await CloudBillingCursor.updateOne(
      { resourceId: cursor.resourceId },
      {
        $max: { chargedMinutes: nextChargedMinutes },
        $set: { lastChargedAt: now, lastError: null },
      },
    );
    cursor.chargedMinutes = nextChargedMinutes;
  }

  private async markFailure(cursor: CursorRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await CloudBillingCursor.updateOne(
      { resourceId: cursor.resourceId },
      { $set: { lastError: message } },
    ).catch(() => undefined);
    if (err instanceof InsufficientBalanceError) {
      await this.accounts
        .markInsufficient(String(cursor.accountId), new Date(this.now()))
        .catch(() => undefined);
    }
    logger.warn(
      { err, resourceId: cursor.resourceId, hostId: cursor.hostId },
      '[billing] spec charge failed; stopping this tick',
    );
  }

  private async chargeBucket(
    cursor: CursorRow,
    bucketIndex: number,
    start: Date,
    now: Date,
  ): Promise<void> {
    const bucketStart = new Date(start.getTime() + bucketIndex * SPEC_BILLING_HOUR_MS);
    const bucketEnd = new Date(bucketStart.getTime() + SPEC_BILLING_HOUR_MS);
    const bucketEndEpochHour = Math.floor(bucketEnd.getTime() / SPEC_BILLING_HOUR_MS);
    // 逐桶按桶末时刻取价目（调价只影响生效后的桶）。
    const prices = await this.prices.unitPrices(bucketEnd);
    const quote = quoteSpecHourly(this.resourceSpec(cursor), prices);
    if (quote.hourlyCents > 0) {
      await this.charge({
        accountId: String(cursor.accountId),
        resourceId: cursor.resourceId,
        hostId: cursor.hostId ?? cursor.resourceId,
        hostName: cursor.hostName ?? null,
        specId: cursor.specId ?? null,
        specName: cursor.specName ?? null,
        spec: this.resourceSpec(cursor),
        minutes: SPEC_BILLING_MINUTES_PER_HOUR,
        unitPrices: prices,
        periodStart: bucketStart,
        periodEnd: bucketEnd,
        idempotentKey: `cloud_host.spec.hour:${cursor.resourceId}:${bucketEndEpochHour}`,
        description: undefined,
      });
    }
    await this.advance(cursor, (bucketIndex + 1) * SPEC_BILLING_MINUTES_PER_HOUR, now);
  }

  private async tickCursor(
    cursor: CursorRow,
    now: Date,
    result: SpecTickResult,
  ): Promise<void> {
    const start = cursor.billingStartedAt ? new Date(cursor.billingStartedAt) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    const destroyedAt = cursor.destroyedAt ? new Date(cursor.destroyedAt) : null;
    const isDestroyed = !!destroyedAt && !Number.isNaN(destroyedAt.getTime());
    const end = isDestroyed ? destroyedAt! : now;
    const totalMs = Math.max(0, end.getTime() - start.getTime());
    const dueWholeBuckets = Math.floor(totalMs / SPEC_BILLING_HOUR_MS);
    let chargedMinutes = cursor.chargedMinutes ?? 0;
    let chargedBuckets = Math.floor(chargedMinutes / SPEC_BILLING_MINUTES_PER_HOUR);
    const pendingBuckets = Math.max(0, dueWholeBuckets - chargedBuckets);
    const toCharge = isDestroyed
      ? pendingBuckets
      : Math.min(pendingBuckets, this.maxHoursPerTick);

    for (let i = 0; i < toCharge; i += 1) {
      const bucketIndex = chargedBuckets;
      try {
        await this.chargeBucket(cursor, bucketIndex, start, now);
      } catch (err) {
        await this.markFailure(cursor, err);
        return;
      }
      chargedBuckets = bucketIndex + 1;
      chargedMinutes = chargedBuckets * SPEC_BILLING_MINUTES_PER_HOUR;
      result.chargedHours += 1;
    }

    // 活跃容器：只结算完整桶，尾段由销毁事件触发。
    if (!isDestroyed) {
      logger.debug(
        { resourceId: cursor.resourceId, dueWholeBuckets, chargedMinutes },
        '[billing] spec tick advanced',
      );
      return;
    }

    // 尚有待结整桶（含单次 24 桶上限截断）：留待下个 tick，不提前关账。
    if (chargedBuckets < dueWholeBuckets) return;

    const remainderMs = totalMs - dueWholeBuckets * SPEC_BILLING_HOUR_MS;
    if (remainderMs > 0) {
      const tailMinutes = Math.min(
        SPEC_BILLING_MINUTES_PER_HOUR,
        Math.ceil(remainderMs / 60_000),
      );
      const tailStart = new Date(start.getTime() + dueWholeBuckets * SPEC_BILLING_HOUR_MS);
      const tailEnd = new Date(tailStart.getTime() + tailMinutes * 60_000);
      const tailPrices = await this.prices.unitPrices(tailEnd);
      const quote = quoteSpecHourly(this.resourceSpec(cursor), tailPrices);
      try {
        if (quote.hourlyCents > 0) {
          await this.charge({
            accountId: String(cursor.accountId),
            resourceId: cursor.resourceId,
            hostId: cursor.hostId ?? cursor.resourceId,
            hostName: cursor.hostName ?? null,
            specId: cursor.specId ?? null,
            specName: cursor.specName ?? null,
            spec: this.resourceSpec(cursor),
            minutes: tailMinutes,
            unitPrices: tailPrices,
            periodStart: tailStart,
            periodEnd: tailEnd,
            idempotentKey: `cloud_host.spec.tail:${cursor.resourceId}`,
            description: undefined,
          });
          result.chargedTails += 1;
        }
        chargedMinutes = dueWholeBuckets * SPEC_BILLING_MINUTES_PER_HOUR + tailMinutes;
        await this.advance(cursor, chargedMinutes, now);
      } catch (err) {
        await this.markFailure(cursor, err);
        return;
      }
    }

    await CloudBillingCursor.updateOne(
      { resourceId: cursor.resourceId, closedAt: null },
      { $set: { closedAt: now, lastError: null } },
    );
    result.closed += 1;
    logger.info(
      { resourceId: cursor.resourceId, hostId: cursor.hostId, chargedMinutes },
      '[billing] spec billing closed',
    );
  }
}

export const specTickService = new SpecTickService();
