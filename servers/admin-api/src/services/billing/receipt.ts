import mongoose from 'mongoose';
import { BillingReceipt } from '../../models/billing-receipt.js';

export interface IssueReceiptInput {
  receiptId?: string;
  invoiceId: string;
  paymentId?: string | null;
  accountId: string;
  /** 金额（分，正数）。 */
  amount: number;
  balanceAfter: number;
  issuedAt?: Date;
  /** 账户内账单序号，用于收据号。 */
  seq?: number;
}

/** 收据出具：`R<YYYYMMDD><账户尾 4 位><seq 6 位>`，唯一。 */
export class ReceiptService {
  async issueReceipt(input: IssueReceiptInput): Promise<{
    id: string;
    receiptNo: string;
  }> {
    const issuedAt = input.issuedAt ?? new Date();
    const datePart = issuedAt.toISOString().slice(0, 10).replace(/-/g, '');
    const accountTail = input.accountId.slice(-4);
    const seqPart = String(input.seq ?? 0).padStart(6, '0');
    const receiptNo = `R${datePart}${accountTail}${seqPart}`;
    const _id = input.receiptId
      ? new mongoose.Types.ObjectId(input.receiptId)
      : new mongoose.Types.ObjectId();
    try {
      await BillingReceipt.create({
        _id,
        receiptNo,
        invoiceId: input.invoiceId,
        paymentId: input.paymentId ?? null,
        accountId: input.accountId,
        amount: Math.round(input.amount),
        balanceAfter: Math.round(input.balanceAfter),
        issuedAt,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    return { id: String(_id), receiptNo };
  }
}

export const receiptService = new ReceiptService();
