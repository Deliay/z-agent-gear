import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { deterministicObjectId } from './billing-service.js';
import { creditCheckService, type CreditCheckService } from './credit-check.js';
import { InvoicingService, invoicingService } from './invoicing.js';
import { centsToCredits } from './money.js';
import { PaymentService, paymentService } from './payment.js';
import { PricingService, pricingService, DEFAULT_CLOUD_HOST_CREATE_CENTS } from './pricing.js';
import { ReceiptService, receiptService } from './receipt.js';
import { logger as rootLogger } from '../../observability/logger.js';

const logger = rootLogger.child({ component: 'billing-one-time-charge' });

export const CLOUD_HOST_CREATE_PRODUCT_ID = 'cloud_host.create';
const DEFAULT_CONTAINER_MINUTE_CENTS = 100;
const FALLBACK_UNIT_PRICE_CENTS: Record<string, number> = {
  [CLOUD_HOST_CREATE_PRODUCT_ID]: DEFAULT_CLOUD_HOST_CREATE_CENTS,
  'container.minute': DEFAULT_CONTAINER_MINUTE_CENTS,
};

export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE';
  constructor(readonly available: number) {
    super('insufficient balance');
    this.name = 'InsufficientBalanceError';
  }
}

export class AccountFrozenError extends Error {
  readonly code = 'ACCOUNT_FROZEN';
  constructor() {
    super('account frozen');
    this.name = 'AccountFrozenError';
  }
}

export class AccountNotFoundError extends Error {
  readonly code = 'ACCOUNT_NOT_FOUND';
  constructor() {
    super('account not found');
    this.name = 'AccountNotFoundError';
  }
}

export class InvalidChargeInputError extends Error {
  readonly code = 'INVALID_BODY';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChargeInputError';
  }
}

export interface CreateOneTimeChargeInput {
  accountId: string;
  productId: string;
  quantity: number;
  idempotentKey: string;
  refType: string;
  refId: string;
  description: string;
}

export interface OneTimeChargeResult {
  invoice: unknown;
  receipt: unknown;
  charged: true;
}

export interface RefundChargeInput {
  idempotentKey: string;
  refundKey: string;
  reason: string;
}

export interface RefundChargeResult {
  invoice: unknown;
  receipt: unknown;
}

export interface PriceQuoteItem {
  productId: string;
  unitPrice: number;
  currency: 'credits';
}

/** 一次性扣费/退款（云电脑创建）；所有写入带幂等键，重放返回首个结果。 */
export class OneTimeChargeService {
  constructor(
    private readonly payments: PaymentService = paymentService,
    private readonly checks: CreditCheckService = creditCheckService,
    private readonly prices: PricingService = pricingService,
    private readonly invoicings: InvoicingService = invoicingService,
    private readonly receipts: ReceiptService = receiptService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async unitPriceCents(productId: string, at: Date): Promise<number> {
    const snapshot = await this.prices.getPrice(productId, at);
    if (snapshot) return snapshot.unitPrice;
    const fallback = FALLBACK_UNIT_PRICE_CENTS[productId];
    if (fallback === undefined) {
      logger.warn({ productId }, '[billing] price missing; charging 0');
      return 0;
    }
    logger.warn(
      { productId, fallbackCents: fallback },
      '[billing] price missing; using fallback price',
    );
    return fallback;
  }

  async getPriceQuote(productIds: string[], at: Date = new Date(this.now())): Promise<PriceQuoteItem[]> {
    const items: PriceQuoteItem[] = [];
    for (const productId of productIds) {
      const unitPrice = await this.unitPriceCents(productId, at);
      items.push({ productId, unitPrice: centsToCredits(unitPrice), currency: 'credits' });
    }
    return items;
  }

  private invoiceKey(idempotentKey: string): string {
    return `invoice:${idempotentKey}`;
  }

  async createOneTimeCharge(input: CreateOneTimeChargeInput): Promise<OneTimeChargeResult> {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InvalidChargeInputError('quantity must be a positive integer');
    }
    if (!input.accountId || !input.idempotentKey || !input.refId) {
      throw new InvalidChargeInputError('accountId/idempotentKey/refId are required');
    }
    const existing = await BillingPayment.findOne({
      idempotentKey: input.idempotentKey,
    }).lean();
    if (existing) return this.existingChargeResult(input, existing.amount);
    return this.performCharge(input, quantity);
  }

  private async performCharge(
    input: CreateOneTimeChargeInput,
    quantity: number,
  ): Promise<OneTimeChargeResult> {
    const at = new Date(this.now());
    const unitPriceCents = await this.unitPriceCents(input.productId, at);
    const amountCents = Math.round(unitPriceCents * quantity);
    const ref = { type: 'cloud_host' as const, id: input.refId };
    const check = await this.checks.check({
      accountId: input.accountId,
      estimatedCredits: amountCents,
      policy: 'reject-on-insufficient',
      ref,
    });
    if (!check.allowed) {
      if (check.reason === 'NOT_FOUND') throw new AccountNotFoundError();
      if (check.reason === 'ACCOUNT_FROZEN') throw new AccountFrozenError();
      throw new InsufficientBalanceError(centsToCredits(check.available));
    }
    return this.persistCharge({
      input,
      quantity,
      unitPriceCents,
      amountCents,
      preCheck: check.preCheck!,
      at,
    });
  }

  private async persistCharge(args: {
    input: CreateOneTimeChargeInput;
    quantity: number;
    unitPriceCents: number;
    amountCents: number;
    preCheck: Parameters<PaymentService['charge']>[0]['preCheck'];
    at: Date;
  }): Promise<OneTimeChargeResult> {
    const { input, quantity, unitPriceCents, amountCents, preCheck, at } = args;
    const metering = await this.ensureMetering({
      accountId: input.accountId,
      productId: input.productId,
      refId: input.refId,
      quantity,
      at,
    });
    const invoiceId = deterministicObjectId(this.invoiceKey(input.idempotentKey));
    const payment = await this.payments.charge({
      accountId: input.accountId,
      amountCents,
      idempotentKey: input.idempotentKey,
      bizId: invoiceId,
      invoiceId,
      preCheck,
      ref: { type: 'cloud_host', id: input.refId },
    });
    return this.finalizeCharge({
      accountId: input.accountId,
      idempotentKey: input.idempotentKey,
      amountCents,
      balanceAfter: payment.cashBalance,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      unitPriceCents,
      quantity,
      meteringId: String(metering._id),
    });
  }

  private async ensureMetering(input: {
    accountId: string;
    productId: string;
    refId: string;
    quantity: number;
    at: Date;
  }): Promise<{ _id: unknown }> {
    const eventId = `metering:cloud_host.create:${input.refId}`;
    try {
      return await MeteringRecord.create({
        eventId,
        accountId: input.accountId,
        resourceType: 'cloud_host',
        resourceId: input.refId,
        productId: input.productId,
        quantity: input.quantity,
        dims: { source: 'cloud_host.create' },
        windowFrom: input.at,
        windowTo: input.at,
        estimated: false,
        invoiced: true,
        createdAt: input.at,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await MeteringRecord.findOne({ eventId });
      if (!existing) throw err;
      return existing;
    }
  }

  private async existingChargeResult(
    input: CreateOneTimeChargeInput,
    amountCents: number,
  ): Promise<OneTimeChargeResult> {
    const invoice = await BillingInvoice.findOne({
      idempotentKey: this.invoiceKey(input.idempotentKey),
    }).lean();
    const receipt = invoice
      ? await BillingReceipt.findOne({ invoiceId: invoice._id }).lean()
      : null;
    if (invoice && receipt) return { invoice, receipt, charged: true };
    const account = await BillingAccount.findById(input.accountId).lean();
    return this.finalizeCharge({
      accountId: input.accountId,
      idempotentKey: input.idempotentKey,
      amountCents: invoice ? Math.abs(invoice.amount) : amountCents,
      balanceAfter: invoice?.balanceAfter ?? account?.cashBalance ?? 0,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      unitPriceCents: amountCents,
      quantity: input.quantity,
    });
  }

  private async finalizeCharge(input: {
    accountId: string;
    idempotentKey: string;
    amountCents: number;
    balanceAfter: number;
    refType: string;
    refId: string;
    description: string;
    unitPriceCents: number;
    quantity: number;
    meteringId?: string | null;
  }): Promise<OneTimeChargeResult> {
    const invoiceId = deterministicObjectId(this.invoiceKey(input.idempotentKey));
    const receiptId = deterministicObjectId(`receipt:${input.idempotentKey}`);
    const invoice = await this.invoicings.createInvoice({
      invoiceId,
      idempotentKey: this.invoiceKey(input.idempotentKey),
      accountId: input.accountId,
      type: 'charge',
      category: 'container',
      amount: -input.amountCents,
      balanceAfter: input.balanceAfter,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      items: [
        {
          productId: CLOUD_HOST_CREATE_PRODUCT_ID,
          quantity: input.quantity,
          unitPrice: input.unitPriceCents,
          amount: input.amountCents,
          meteringRef: input.meteringId ?? null,
        },
      ],
      receiptId,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId,
      invoiceId,
      accountId: input.accountId,
      amount: input.amountCents,
      balanceAfter: input.balanceAfter,
      seq: invoice.seq,
    });
    return { invoice, receipt, charged: true };
  }

  async refundCharge(input: RefundChargeInput): Promise<RefundChargeResult> {
    const existingInvoice = await BillingInvoice.findOne({
      idempotentKey: this.invoiceKey(input.refundKey),
    }).lean();
    if (existingInvoice) {
      const receipt = await BillingReceipt.findOne({ invoiceId: existingInvoice._id }).lean();
      return { invoice: existingInvoice, receipt };
    }
    const payment = await BillingPayment.findOne({
      idempotentKey: input.idempotentKey,
    }).lean();
    const originalInvoice = await BillingInvoice.findOne({
      idempotentKey: this.invoiceKey(input.idempotentKey),
    }).lean();
    if (!payment) {
      logger.warn(
        { idempotentKey: input.idempotentKey },
        '[billing] refund skipped: charge not found',
      );
      return { invoice: null, receipt: null };
    }
    const accountId = String(payment.accountId);
    const amount = Math.abs(Math.round(payment.amount));
    const refId = String(originalInvoice?.refId ?? input.idempotentKey.split(':').pop() ?? '');
    const invoiceId = deterministicObjectId(this.invoiceKey(input.refundKey));
    const receiptId = deterministicObjectId(`receipt:${input.refundKey}`);
    const wallet = await this.payments.refund({
      accountId,
      amountCents: amount,
      idempotentKey: input.refundKey,
      bizId: invoiceId,
      invoiceId,
    });
    const invoice = await this.invoicings.createInvoice({
      invoiceId,
      idempotentKey: this.invoiceKey(input.refundKey),
      accountId,
      type: 'adjust',
      category: 'container',
      amount,
      balanceAfter: wallet.cashBalance,
      refType: 'cloud_host',
      refId,
      description: `创建云电脑费用退回（${refId}）：${input.reason}`,
      items: [
        {
          productId: CLOUD_HOST_CREATE_PRODUCT_ID,
          quantity: 1,
          unitPrice: amount,
          amount,
        },
      ],
      receiptId,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId,
      invoiceId,
      accountId,
      amount,
      balanceAfter: wallet.cashBalance,
      seq: invoice.seq,
    });
    return { invoice, receipt };
  }
}

export const oneTimeChargeService = new OneTimeChargeService();

