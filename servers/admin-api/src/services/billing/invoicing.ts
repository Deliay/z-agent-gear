import mongoose from 'mongoose';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import {
  BillingInvoice,
  type IBillingInvoice,
} from '../../models/billing-invoice.js';
import { rollupService, type RollupService } from './rollup-service.js';

export interface InvoiceItemInput {
  productId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  meteringRef?: string | null;
  segment?: string | null;
}

export interface CreateInvoiceInput {
  accountId: string;
  type: 'charge' | 'recharge' | 'adjust';
  category: 'container' | 'model' | 'manual';
  /** 金额（分）：充值为正、消费为负。 */
  amount: number;
  balanceAfter: number;
  refType?: string | null;
  refId?: string | null;
  description: string;
  items?: InvoiceItemInput[];
  receiptId?: string | null;
  periodFrom?: Date | null;
  periodTo?: Date | null;
  invoiceId?: string;
}

/** 出账：`$inc invoiceSeq` 原子分配 seq（从 0 连续），`{accountId,seq}` 唯一兜底重试。 */
export class InvoicingService {
  constructor(private readonly rollups: RollupService = rollupService) {}

  private async allocateSeq(accountId: string): Promise<number> {
    if (!mongoose.isValidObjectId(accountId)) throw new Error('账户不存在');
    const doc = await BillingAccount.findOneAndUpdate(
      { _id: accountId },
      { $inc: { invoiceSeq: 1 } },
      { new: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return Math.max(0, (doc.invoiceSeq ?? 1) - 1);
  }

  async createInvoice(input: CreateInvoiceInput): Promise<IBillingInvoice> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seq = await this.allocateSeq(input.accountId);
      try {
        const doc = await BillingInvoice.create({
          _id: input.invoiceId ? new mongoose.Types.ObjectId(input.invoiceId) : undefined,
          accountId: input.accountId,
          seq,
          type: input.type,
          category: input.category,
          amount: Math.round(input.amount),
          balanceAfter: Math.round(input.balanceAfter),
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          description: input.description,
          items: (input.items ?? []).map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: Math.round(item.unitPrice),
            amount: Math.round(item.amount),
            meteringRef: item.meteringRef ?? null,
            segment: item.segment ?? null,
          })),
          receiptId: input.receiptId ? new mongoose.Types.ObjectId(input.receiptId) : null,
          periodFrom: input.periodFrom ?? null,
          periodTo: input.periodTo ?? null,
          createdAt: new Date(),
        });
        await this.rollups.recordInvoice(input.accountId, doc);
        return doc;
      } catch (err) {
        lastError = err;
        if ((err as { code?: number }).code !== 11000) throw err;
        // seq 竞争：重试分配（唯一索引兜底）
      }
    }
    throw lastError instanceof Error ? lastError : new Error('invoice seq allocation failed');
  }
}

export const invoicingService = new InvoicingService();
