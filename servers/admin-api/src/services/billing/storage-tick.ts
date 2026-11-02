import { logger as rootLogger } from '../../observability/logger.js';
import { CloudStorageMirror } from '../../models/cloud-storage.js';
import { StorageBillingCursor } from '../../models/storage-billing-cursor.js';
import {
  type StorageBillingRate,
  type StorageChargeInput,
  type StorageChargeResult,
  storageChargeService,
} from './storage-charge.js';

const logger = rootLogger.child({ component: 'billing-storage' });

export const STORAGE_BILLING_HOUR_MS = 60 * 60 * 1000;
/** 单次 tick 每个存储最多补结算 24 小时（防止长期停机后一次开出巨额账单）。 */
export const STORAGE_BILLING_MAX_HOURS_PER_TICK = 24;

/** 参与计费的存储状态（DESTROYED / CREATE_FAILED 不计费，销毁尾段单独扫描）。 */
export const STORAGE_BILLING_ACTIVE_STATUSES = [
  'IDLE',
  'ATTACHING',
  'ATTACHED',
  'ARCHIVING',
  'ARCHIVED',
] as const;

export interface StorageTickResult {
  scanned: number;
  chargedHours: number;
  closed: number;
}

interface StorageMirrorRow {
  _id: unknown;
  name?: string | null;
  sizeGi?: number | null;
  status?: string | null;
  billingRate?: string | null;
  billingStartedAt?: Date | null;
  destroyedAt?: Date | null;
  billingAccountId?: string | null;
  tenantId?: unknown;
}

export interface StorageTickOptions {
  now?: () => number;
  /** 已结算到第几小时由 admin-api 自持（可注入测试替身）。 */
  charge?: (input: StorageChargeInput) => Promise<StorageChargeResult>;
  maxHoursPerTick?: number;
}

/**
 * 整点结算 tick：
 * - 桶锚点 = `billingStartedAt`；第 n 桶 `[start + n·1h, start + (n+1)·1h)`；
 * - 活跃存储 `due = floor((now - start)/1h)`（只结算已完整结束的桶）；
 *   销毁尾段 `due = ceil((destroyedAt - start)/1h)`（不完整尾桶向上取整）；
 * - 逐桶按桶末（结算时刻）镜像 `billingRate` 出账，幂等键 `cloud_storage.hour:<storageId>:<bucketEndEpochHour>`；
 * - 单次最多补 24 小时，剩余下次继续；失败即停并记 `lastError`；
 * - 销毁尾段全部落账后写 `closedAt`，之后不再扫描。
 */
export class StorageTickService {
  private readonly now: () => number;
  private readonly charge: (input: StorageChargeInput) => Promise<StorageChargeResult>;
  private readonly maxHoursPerTick: number;

  constructor(options: StorageTickOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.charge = options.charge ?? ((input) => storageChargeService.chargeHour(input));
    this.maxHoursPerTick = options.maxHoursPerTick ?? STORAGE_BILLING_MAX_HOURS_PER_TICK;
  }

  async tick(): Promise<StorageTickResult> {
    const now = new Date(this.now());
    const rows = await this.loadCandidates(now);
    const result: StorageTickResult = { scanned: rows.length, chargedHours: 0, closed: 0 };
    for (const row of rows) {
      try {
        await this.tickStorage(row, now, result);
      } catch (err) {
        logger.error(
          { err, storageId: String(row._id) },
          '[billing] storage tick failed for storage',
        );
      }
    }
    return result;
  }

  private async loadCandidates(now: Date): Promise<StorageMirrorRow[]> {
    const active = await CloudStorageMirror.find({
      billingStartedAt: { $ne: null },
      status: { $in: [...STORAGE_BILLING_ACTIVE_STATUSES] },
    }).lean<StorageMirrorRow[]>();
    // 销毁尾段：destroyedAt 已写但游标尚未关账（CREATE_FAILED 无 billingStartedAt，不计费）
    const destroyed = await CloudStorageMirror.find({
      billingStartedAt: { $ne: null },
      destroyedAt: { $ne: null },
    }).lean<StorageMirrorRow[]>();

    const destroyedIds = destroyed.map((row) => row._id);
    const closedIds = new Set<string>();
    if (destroyedIds.length > 0) {
      const closed = await StorageBillingCursor.find({
        storageId: { $in: destroyedIds as never },
        closedAt: { $ne: null },
      })
        .select({ storageId: 1 })
        .lean<Array<{ storageId: unknown }>>();
      for (const row of closed) closedIds.add(String(row.storageId));
    }

    const seen = new Set<string>();
    const rows: StorageMirrorRow[] = [];
    for (const row of [...active, ...destroyed]) {
      const id = String(row._id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (row.destroyedAt && closedIds.has(id)) continue;
      if (row.destroyedAt && row.destroyedAt.getTime() <= now.getTime()) {
        rows.push(row);
      } else if (!row.destroyedAt) {
        rows.push(row);
      }
    }
    return rows;
  }

  private async tickStorage(
    row: StorageMirrorRow,
    now: Date,
    result: StorageTickResult,
  ): Promise<void> {
    const storageId = String(row._id);
    const start = row.billingStartedAt ? new Date(row.billingStartedAt) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    if (!row.billingAccountId) {
      logger.warn({ storageId }, '[billing] storage missing billingAccountId; skipped');
      return;
    }
    const sizeGi = Number(row.sizeGi);
    if (!Number.isInteger(sizeGi) || sizeGi < 1 || sizeGi > 30) {
      logger.warn({ storageId, sizeGi }, '[billing] storage size invalid; skipped');
      return;
    }

    const destroyedAt = row.destroyedAt ? new Date(row.destroyedAt) : null;
    const isDestroyed = !!destroyedAt && !Number.isNaN(destroyedAt.getTime());
    const end = isDestroyed ? destroyedAt! : now;
    // 活跃：只结算完整结束的桶；销毁：尾桶向上取整。
    const due = isDestroyed
      ? Math.max(0, Math.ceil((end.getTime() - start.getTime()) / STORAGE_BILLING_HOUR_MS))
      : Math.max(0, Math.floor((end.getTime() - start.getTime()) / STORAGE_BILLING_HOUR_MS));

    const cursor = await StorageBillingCursor.findOneAndUpdate(
      { storageId },
      {
        $setOnInsert: {
          storageId,
          accountId: row.billingAccountId,
          tenantId: row.tenantId ?? null,
          sizeGi,
          billingStartedAt: start,
          chargedHours: 0,
          lastRate: null,
          lastChargedAt: null,
          closedAt: null,
          lastError: null,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean<{
      chargedHours?: number;
      closedAt?: Date | null;
    } | null>();
    if (!cursor) return;
    if (cursor.closedAt) return;

    let chargedHours = cursor.chargedHours ?? 0;
    const pending = Math.max(0, due - chargedHours);
    const toCharge = Math.min(pending, this.maxHoursPerTick);

    for (let i = 0; i < toCharge; i += 1) {
      const bucketIndex = chargedHours;
      const bucketStart = new Date(start.getTime() + bucketIndex * STORAGE_BILLING_HOUR_MS);
      const bucketEnd = new Date(bucketStart.getTime() + STORAGE_BILLING_HOUR_MS);
      const bucketEndEpochHour = Math.floor(bucketEnd.getTime() / STORAGE_BILLING_HOUR_MS);
      const rate: StorageBillingRate = row.billingRate === 'HALF' ? 'HALF' : 'FULL';
      try {
        await this.charge({
          accountId: row.billingAccountId,
          storageId,
          sizeGi,
          rate,
          periodStart: bucketStart,
          periodEnd: bucketEnd,
          idempotentKey: `cloud_storage.hour:${storageId}:${bucketEndEpochHour}`,
          description: `云存储 ${row.name ?? storageId}（${sizeGi}Gi）${bucketStart.toISOString()}-${bucketEnd.toISOString()}`,
          storageName: row.name ?? undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await StorageBillingCursor.updateOne(
          { storageId },
          { $set: { lastError: message } },
        );
        logger.warn(
          { err, storageId, chargedHours, rate },
          '[billing] storage hour charge failed; stopping this tick',
        );
        return;
      }
      chargedHours = bucketIndex + 1;
      await StorageBillingCursor.updateOne(
        { storageId },
        {
          $set: {
            chargedHours,
            lastRate: rate,
            lastChargedAt: now,
            lastError: null,
          },
        },
      );
      result.chargedHours += 1;
    }

    if (isDestroyed && chargedHours >= due) {
      await StorageBillingCursor.updateOne(
        { storageId, closedAt: null },
        { $set: { closedAt: now } },
      );
      result.closed += 1;
      logger.info({ storageId, chargedHours }, '[billing] storage billing closed');
    }

    logger.debug(
      {
        storageId,
        rate: row.billingRate === 'HALF' ? 'HALF' : 'FULL',
        due,
        chargedHours,
      },
      '[billing] storage tick advanced',
    );
  }
}

export const storageTickService = new StorageTickService();
