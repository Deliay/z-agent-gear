import { BillingRollup } from '../../models/billing-rollup.js';
import type { BillingInvoice, IBillingInvoice } from '../../models/billing-invoice.js';

export type RollupGranularity = 'minute' | 'hour' | 'day';

export interface RollupBucket {
  bucketStart: Date;
  chargeTotal: number;
  rechargeTotal: number;
  chargeCount: number;
}

/** 时间桶统一 UTC：分钟/小时/天。 */
export function bucketStartOf(date: Date, granularity: RollupGranularity): Date {
  const d = new Date(date.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  if (granularity === 'day') d.setUTCHours(0);
  if (granularity === 'hour' || granularity === 'day') d.setUTCMinutes(0);
  return d;
}

/** 汇总缓存：按分钟/小时/天 reduce sum 累计。 */
export class RollupService {
  async recordInvoice(
    accountId: string,
    invoice: Pick<IBillingInvoice, 'type' | 'amount' | 'createdAt'>,
  ): Promise<void> {
    const at = invoice.createdAt ?? new Date();
    const charge = invoice.type === 'charge' ? Math.abs(invoice.amount) : 0;
    const recharge = invoice.type === 'recharge' ? Math.max(0, invoice.amount) : 0;
    const count = invoice.type === 'charge' ? 1 : 0;

    for (const granularity of ['minute', 'hour', 'day'] as const) {
      const bucket = bucketStartOf(at, granularity);
      await BillingRollup.updateOne(
        { accountId, granularity, bucketStart: bucket },
        {
          $inc: { chargeTotal: charge, rechargeTotal: recharge, chargeCount: count },
          $setOnInsert: { accountId, granularity, bucketStart: bucket },
        },
        { upsert: true },
      );
    }
  }

  async query(
    accountId: string,
    granularity: RollupGranularity,
    from: Date,
    to: Date,
  ): Promise<RollupBucket[]> {
    const docs = await BillingRollup.find({
      accountId,
      granularity,
      bucketStart: { $gte: from, $lte: to },
    })
      .sort({ bucketStart: 1 })
      .lean();
    return docs.map((doc) => ({
      bucketStart: doc.bucketStart,
      chargeTotal: doc.chargeTotal ?? 0,
      rechargeTotal: doc.rechargeTotal ?? 0,
      chargeCount: doc.chargeCount ?? 0,
    }));
  }
}

export const rollupService = new RollupService();

// 类型引用保持导出，便于上层统一 import
export type { BillingInvoice };
