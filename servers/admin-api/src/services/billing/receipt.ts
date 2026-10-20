import crypto from 'node:crypto';
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

/** 收据出具：`R<YYYYMMDD><账户哈希 8 位><seq 6 位>`，唯一。 */
export class ReceiptService {
  async issueReceipt(input: IssueReceiptInput): Promise<{
    id: string;
    receiptNo: string;
  }> {
    const issuedAt = input.issuedAt ?? new Date();
    const datePart = issuedAt.toISOString().slice(0, 10).replace(/-/g, '');
    // 注（R8-1 展示级）：补建收据（崩溃恢复）的 `issuedAt` 取补建时点，故 `receiptNo` 的
    // `R<YYYYMMDD>` 段反映**补建日期**而非原始交易日期；`seq` 仍取自账单（账户内唯一），
    // 编号规则与主路径同口径。
    // A12：原「账户后 4 位 hex」在多账户间易碰撞；改用账户 ID 的哈希前缀，保证跨账户唯一。
    const accountHash = crypto
      .createHash('sha256')
      .update(input.accountId)
      .digest('hex')
      .slice(0, 8);
    const seqPart = String(input.seq ?? 0).padStart(6, '0');
    const receiptNo = `R${datePart}${accountHash}${seqPart}`;
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
