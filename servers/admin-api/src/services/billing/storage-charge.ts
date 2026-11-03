import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { deterministicObjectId } from './billing-service.js';
import { creditCheckService, type CreditCheckService } from './credit-check.js';
import { InvoicingService, invoicingService } from './invoicing.js';
import { centsToCredits } from './money.js';
import {
  AccountFrozenError,
  AccountNotFoundError,
  InsufficientBalanceError,
  InvalidChargeInputError,
} from './one-time-charge.js';
import { PaymentService, paymentService } from './payment.js';
import { ReceiptService, receiptService } from './receipt.js';
import {
  type StorageHourlyQuote,
  type StorageQuoteItem,
  StoragePricingService,
  storagePricingService,
} from './storage-pricing.js';

const logger = rootLogger.child({ component: 'billing-storage-charge' });

/** 存储结算单次只结算 1 个整点小时。 */
export const STORAGE_BILLING_PERIOD_MS = 60 * 60 * 1000;

export type StorageBillingRate = 'FULL' | 'HALF';

export interface StorageChargeInput {
  accountId: string;
  storageId: string;
  sizeGi: number;
  rate: StorageBillingRate;
  periodStart: Date;
  periodEnd: Date;
  idempotentKey: string;
  /** 可选描述；缺省按存储与账期生成，归档半价自动追加「（归档半价）」。 */
  description?: string;
  /** 可选存储展示名（仅用于生成默认描述）。 */
  storageName?: string;
}

export interface StorageChargeResult {
  invoice: unknown;
  receipt: unknown;
  charged: true;
}

/** 云存储小时出账：三档明细 → 账单（category=storage）→ 扣费 → 计量记录。 */
export class StorageChargeService {
  constructor(
    private readonly payments: PaymentService = paymentService,
    private readonly checks: CreditCheckService = creditCheckService,
    private readonly prices: StoragePricingService = storagePricingService,
    private readonly invoicings: InvoicingService = invoicingService,
    private readonly receipts: ReceiptService = receiptService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private invoiceKey(idempotentKey: string): string {
    return `invoice:${idempotentKey}`;
  }

  async chargeHour(input: StorageChargeInput): Promise<StorageChargeResult> {
    if (!input.accountId || !input.storageId || !input.idempotentKey) {
      throw new InvalidChargeInputError('accountId/storageId/idempotentKey are required');
    }
    if (input.rate !== 'FULL' && input.rate !== 'HALF') {
      throw new InvalidChargeInputError('rate must be FULL or HALF');
    }
    const sizeGi = Number(input.sizeGi);
    if (!Number.isInteger(sizeGi) || sizeGi < 1 || sizeGi > 30) {
      throw new InvalidChargeInputError('sizeGi must be an integer between 1 and 30');
    }
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new InvalidChargeInputError('periodStart/periodEnd must be valid dates');
    }
    if (periodEnd.getTime() - periodStart.getTime() !== STORAGE_BILLING_PERIOD_MS) {
      throw new InvalidChargeInputError('periodStart/periodEnd must span exactly one hour');
    }

    const existing = await BillingPayment.findOne({
      idempotentKey: input.idempotentKey,
    }).lean();
    if (existing) return this.existingChargeResult(input, Number(existing.amount ?? 0));

    return this.performCharge(input, sizeGi, periodStart, periodEnd);
  }

  /** 描述口径：默认「云存储 <name>（<size>Gi）<start>-<end>」；HALF 追加「（归档半价）」。 */
  private describe(input: StorageChargeInput, periodStart: Date, periodEnd: Date): string {
    const suffix = input.rate === 'HALF' ? '（归档半价）' : '';
    if (input.description) {
      return input.description.includes('（归档半价）')
        ? input.description
        : `${input.description}${suffix}`;
    }
    const name = input.storageName?.trim() || input.storageId;
    return `云存储 ${name}（${input.sizeGi}Gi）${periodStart.toISOString()}-${periodEnd.toISOString()}${suffix}`;
  }

  private itemsFor(quote: StorageHourlyQuote, rate: StorageBillingRate): StorageQuoteItem[] {
    return rate === 'HALF' ? quote.archived.items : quote.full.items;
  }

  private async performCharge(
    input: StorageChargeInput,
    sizeGi: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<StorageChargeResult> {
    const at = new Date(this.now());
    const quote = await this.prices.quote(sizeGi, at);
    const items = this.itemsFor(quote, input.rate);
    const amountCents = items.reduce((acc, item) => acc + item.amount, 0);
    const ref = { type: 'cloud_storage' as const, id: input.storageId };
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

    const metering = await this.ensureMetering({
      input,
      sizeGi,
      periodStart,
      periodEnd,
      at,
    });
    const invoiceId = deterministicObjectId(this.invoiceKey(input.idempotentKey));
    const payment = await this.payments.charge({
      accountId: input.accountId,
      amountCents,
      idempotentKey: input.idempotentKey,
      bizId: invoiceId,
      invoiceId,
      preCheck: check.preCheck!,
      ref,
    });
    return this.finalizeCharge({
      input,
      items,
      amountCents,
      balanceAfter: payment.cashBalance,
      periodStart,
      periodEnd,
      meteringId: String(metering._id),
    });
  }

  private async ensureMetering(args: {
    input: StorageChargeInput;
    sizeGi: number;
    periodStart: Date;
    periodEnd: Date;
    at: Date;
  }): Promise<{ _id: unknown }> {
    const { input, sizeGi, periodStart, periodEnd, at } = args;
    const eventId = `metering:${input.idempotentKey}`;
    try {
      return await MeteringRecord.create({
        eventId,
        accountId: input.accountId,
        resourceType: 'cloud_storage',
        resourceId: input.storageId,
        productId: 'cloud_storage.base.hour',
        quantity: 1,
        dims: {
          source: 'cloud_storage.hour',
          rate: input.rate,
          sizeGi,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
        windowFrom: periodStart,
        windowTo: periodEnd,
        estimated: false,
        invoiced: true,
        createdAt: at,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await MeteringRecord.findOne({ eventId });
      if (!existing) throw err;
      return existing;
    }
  }

  private async existingChargeResult(
    input: StorageChargeInput,
    amountCents: number,
  ): Promise<StorageChargeResult> {
    const invoice = await BillingInvoice.findOne({
      idempotentKey: this.invoiceKey(input.idempotentKey),
    }).lean();
    const receipt = invoice
      ? await BillingReceipt.findOne({ invoiceId: invoice._id }).lean()
      : null;
    if (invoice && receipt) return { invoice, receipt, charged: true };

    const account = await BillingAccount.findById(input.accountId).lean();
    const at = new Date(this.now());
    const quote = await this.prices.quote(Number(input.sizeGi), at);
    const items = this.itemsFor(quote, input.rate);
    return this.finalizeCharge({
      input,
      items,
      amountCents: invoice ? Math.abs(Number(invoice.amount)) : amountCents,
      balanceAfter: Number(invoice?.balanceAfter ?? account?.cashBalance ?? 0),
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      meteringId: null,
    });
  }

  private async finalizeCharge(args: {
    input: StorageChargeInput;
    items: StorageQuoteItem[];
    amountCents: number;
    balanceAfter: number;
    periodStart: Date;
    periodEnd: Date;
    meteringId?: string | null;
  }): Promise<StorageChargeResult> {
    const { input, items, amountCents, balanceAfter, periodStart, periodEnd } = args;
    const invoiceId = deterministicObjectId(this.invoiceKey(input.idempotentKey));
    const receiptId = deterministicObjectId(`receipt:${input.idempotentKey}`);
    const invoice = await this.invoicings.createInvoice({
      invoiceId,
      idempotentKey: this.invoiceKey(input.idempotentKey),
      accountId: input.accountId,
      type: 'charge',
      category: 'storage',
      amount: -Math.round(amountCents),
      balanceAfter: Math.round(balanceAfter),
      refType: 'cloud_storage',
      refId: input.storageId,
      description: this.describe(input, periodStart, periodEnd),
      items: items.map((item, index) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        meteringRef: index === 0 ? args.meteringId ?? null : null,
      })),
      periodFrom: periodStart,
      periodTo: periodEnd,
      receiptId,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId,
      invoiceId,
      accountId: input.accountId,
      amount: Math.round(amountCents),
      balanceAfter: Math.round(balanceAfter),
      seq: invoice.seq,
    });
    logger.info(
      {
        storageId: input.storageId,
        rate: input.rate,
        amountCents,
        sizeGi: input.sizeGi,
        event: 'storage_charge',
      },
      '[billing] storage hour charged',
    );
    return { invoice, receipt, charged: true };
  }
}

export const storageChargeService = new StorageChargeService();
