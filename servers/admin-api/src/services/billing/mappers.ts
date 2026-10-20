import type { IBillingInvoice } from '../../models/billing-invoice.js';
import type { IBillingReceipt } from '../../models/billing-receipt.js';
import type { IBillingReservation } from '../../models/billing-reservation.js';
import { centsToCredits } from './money.js';
import { documentId } from './id.js';

/** 计费域内部 DTO → 契约形态（金额分 → credits Float）。 */

export function toBillingInvoice(doc: IBillingInvoice & Record<string, unknown>) {  return {
    id: documentId(doc),
    accountId: String(doc.accountId),
    seq: doc.seq,
    type: doc.type,
    category: doc.category,
    amount: centsToCredits(doc.amount),
    balanceAfter: centsToCredits(doc.balanceAfter),
    refType: doc.refType ?? null,
    refId: doc.refId ?? null,
    description: doc.description ?? '',
    items: (doc.items ?? []).map((item: { productId: string; quantity: number; unitPrice: number; amount: number; meteringRef?: string | null; segment?: string | null }) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: centsToCredits(item.unitPrice),
      amount: centsToCredits(item.amount),
      meteringRef: item.meteringRef ?? null,
      segment: item.segment ?? null,
    })),
    receiptId: doc.receiptId ? String(doc.receiptId) : null,
    createdAt: new Date(doc.createdAt as Date).toISOString(),
  };
}

export function toBillingReceipt(doc: IBillingReceipt & Record<string, unknown>) {
  return {
    id: documentId(doc),
    receiptNo: doc.receiptNo,
    invoiceId: String(doc.invoiceId),
    accountId: String(doc.accountId),
    amount: centsToCredits(doc.amount),
    balanceAfter: centsToCredits(doc.balanceAfter),
    issuedAt: new Date(doc.issuedAt as Date).toISOString(),
  };
}

export function toBillingRollup(doc: Record<string, unknown>) {
  return {
    bucketStart: new Date(doc.bucketStart as Date).toISOString(),
    chargeTotal: centsToCredits(Number(doc.chargeTotal ?? 0)),
    rechargeTotal: centsToCredits(Number(doc.rechargeTotal ?? 0)),
    chargeCount: Number(doc.chargeCount ?? 0),
  };
}

export function toBillingApiCall(doc: Record<string, unknown>) {
  return {
    id: documentId(doc),
    requestId: String(doc.requestId ?? ''),
    accountId: String(doc.accountId ?? ''),
    modelId: String(doc.modelId ?? ''),
    modelName: String(doc.modelName ?? ''),
    inputTokens: Number(doc.inputTokens ?? 0),
    cachedInputTokens: Number(doc.cachedInputTokens ?? 0),
    outputTokens: Number(doc.outputTokens ?? 0),
    cost: centsToCredits(Number(doc.cost ?? 0)),
    status: String(doc.status ?? 'completed'),
    estimated: doc.estimated === true,
    invoiceSeq: doc.invoiceSeq === null || doc.invoiceSeq === undefined ? null : Number(doc.invoiceSeq),
    startedAt: new Date(doc.startedAt as Date).toISOString(),
    finishedAt: doc.finishedAt ? new Date(doc.finishedAt as Date).toISOString() : null,
  };
}

export function toBillingReservation(doc: IBillingReservation & Record<string, unknown>) {
  return {
    id: documentId(doc),
    accountId: String(doc.accountId),
    resourceId: doc.resourceId,
    status: doc.status,
    reservedTotal: centsToCredits(doc.reservedTotal ?? 0),
    settledTotal: centsToCredits(doc.settledTotal ?? 0),
    releasedTotal: centsToCredits(doc.releasedTotal ?? 0),
    startedAt: new Date(doc.startedAt as Date).toISOString(),
    lastSettleAt: doc.lastSettleAt ? new Date(doc.lastSettleAt as Date).toISOString() : null,
  };
}

/** AccountService DTO（整数分）→ 契约 wire 形态（金额换算为 credits，时间 ISO）。 */
export function toBillingAccountWire(dto: {
  id: string;
  ownerType: string;
  ownerId: string;
  ownerName: string;
  cashBalance: number;
  giftBalance: number;
  creditLimit: number;
  frozenAmount: number;
  availableBalance: number;
  status: string;
  insufficientSince: Date | null;
  invoiceSeq?: number;
  ledgerCount?: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: dto.id,
    ownerType: dto.ownerType,
    ownerId: dto.ownerId,
    ownerName: dto.ownerName,
    cashBalance: centsToCredits(dto.cashBalance),
    giftBalance: centsToCredits(dto.giftBalance),
    creditLimit: centsToCredits(dto.creditLimit),
    frozenAmount: centsToCredits(dto.frozenAmount),
    availableBalance: centsToCredits(dto.availableBalance),
    status: dto.status,
    insufficientSince: dto.insufficientSince ? dto.insufficientSince.toISOString() : null,
    invoiceSeq: dto.invoiceSeq ?? 0,
    ledgerCount: dto.ledgerCount ?? 0,
    createdAt: dto.createdAt.toISOString(),
    updatedAt: dto.updatedAt.toISOString(),
  };
}
