import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { deterministicObjectId } from './id.js';
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
  SpecPricingService,
  specPricingService,
  type SpecQuoteItem,
  type SpecRateQuote,
  type SpecResources,
} from './spec-pricing.js';

const logger = rootLogger.child({ component: 'billing-spec-charge' });

export const SPEC_BILLING_PERIOD_MINUTES = 60;

export interface SpecChargeInput {
  accountId: string;
  resourceId: string;
  hostId: string;
  hostName?: string | null;
  specId?: string | null;
  specName?: string | null;
  spec: SpecResources;
  /** 本次结算分钟数（整桶 60；尾段 ceil 后 1..60）。 */
  minutes: number;
  periodStart: Date;
  periodEnd: Date;
  idempotentKey: string;
  description?: string;
}

export interface SpecChargeResult {
  invoice: unknown;
  receipt: unknown;
  charged: true;
  amountCents: number;
}

/**
 * 按「分档明细 × 分钟 / 60」分摊到各档（最大余数法），保证明细合计 == 整单金额
 *（整单 = ceil(hourlyCents × minutes / 60)）。
 */
export function allocateSpecItemCents(
  items: readonly SpecQuoteItem[],
  minutes: number,
): number[] {
  const safe = items.map((item) => Math.max(0, Math.round(item.amount)) * minutes);
  const totalNumerator = safe.reduce((acc, value) => acc + value, 0);
  if (totalNumerator <= 0) return safe.map(() => 0);
  const totalCents = Math.ceil(totalNumerator / SPEC_BILLING_PERIOD_MINUTES);
  const bases = safe.map((value) => Math.floor(value / SPEC_BILLING_PERIOD_MINUTES));
  const remainders = safe.map((value) => value % SPEC_BILLING_PERIOD_MINUTES);
  let remaining = totalCents - bases.reduce((acc, value) => acc + value, 0);
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const result = [...bases];
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remaining -= 1;
  }
  return result;
}

/** 云电脑规格出账：七档明细 → 账单（category=container、refType=cloud_host）→ 扣费 → 计量记录。 */
export class SpecChargeService {
  constructor(
    private readonly payments: PaymentService = paymentService,
    private readonly checks: CreditCheckService = creditCheckService,
    private readonly prices: SpecPricingService = specPricingService,
    private readonly invoicings: InvoicingService = invoicingService,
    private readonly receipts: ReceiptService = receiptService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private invoiceKey(idempotentKey: string): string {
    return `invoice:${idempotentKey}`;
  }

  async chargePeriod(input: SpecChargeInput): Promise<SpecChargeResult> {
    if (!input.accountId || !input.resourceId || !input.hostId || !input.idempotentKey) {
      throw new InvalidChargeInputError('accountId/resourceId/hostId/idempotentKey are required');
    }
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SPEC_BILLING_PERIOD_MINUTES) {
      throw new InvalidChargeInputError('minutes must be an integer between 1 and 60');
    }
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new InvalidChargeInputError('periodStart/periodEnd must be valid dates');
    }
    if (periodEnd.getTime() - periodStart.getTime() !== minutes * 60_000) {
      throw new InvalidChargeInputError('periodStart/periodEnd must span exactly the billed minutes');
    }

    const existing = await BillingPayment.findOne({
      idempotentKey: input.idempotentKey,
    }).lean();
    if (existing) return this.existingChargeResult(input, Number(existing.amount ?? 0));

    return this.performCharge(input, minutes, periodStart, periodEnd);
  }

  private describe(input: SpecChargeInput, periodStart: Date, periodEnd: Date): string {
    if (input.description) return input.description;
    const name = input.hostName?.trim() || input.hostId;
    const specName = input.specName?.trim() || `${input.spec.cpu}C ${input.spec.memoryGi}G ${input.spec.ephemeralStorageGi}G`;
    const tail = input.minutes < SPEC_BILLING_PERIOD_MINUTES ? '（尾段折算）' : '';
    return `云电脑 ${name}（规格 ${specName}）${periodStart.toISOString()}-${periodEnd.toISOString()}${tail}`;
  }

  private async performCharge(
    input: SpecChargeInput,
    minutes: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SpecChargeResult> {
    const at = new Date(this.now());
    const quote = await this.prices.quote(input.spec, at);
    const itemCents = allocateSpecItemCents(quote.items, minutes);
    const amountCents = itemCents.reduce((acc, value) => acc + value, 0);
    const ref = { type: 'cloud_host' as const, id: input.hostId };

    if (amountCents <= 0) {
      // 0 费用规格（全零）不出账：仅返回占位（调用方据 charged 语义推进游标）。
      return { invoice: null, receipt: null, charged: true, amountCents: 0 };
    }

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
      minutes,
      periodStart,
      periodEnd,
      at,
      amountCents,
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
      quote,
      itemCents,
      amountCents,
      balanceAfter: payment.cashBalance,
      periodStart,
      periodEnd,
      meteringId: String(metering._id),
    });
  }

  private async ensureMetering(args: {
    input: SpecChargeInput;
    minutes: number;
    periodStart: Date;
    periodEnd: Date;
    at: Date;
    amountCents: number;
  }): Promise<{ _id: unknown }> {
    const { input, minutes, periodStart, periodEnd, at, amountCents } = args;
    const eventId = `metering:${input.idempotentKey}`;
    try {
      return await MeteringRecord.create({
        eventId,
        accountId: input.accountId,
        resourceType: 'container',
        resourceId: input.resourceId,
        productId: 'cloud_spec.hour',
        quantity: minutes,
        dims: {
          source: 'cloud_host.spec',
          kind: minutes >= SPEC_BILLING_PERIOD_MINUTES ? 'hour' : 'tail',
          specId: input.specId ?? null,
          specName: input.specName ?? null,
          cpu: input.spec.cpu,
          memoryGi: input.spec.memoryGi,
          ephemeralStorageGi: input.spec.ephemeralStorageGi,
          minutes,
          amountCents,
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
    input: SpecChargeInput,
    amountCents: number,
  ): Promise<SpecChargeResult> {
    const invoice = await BillingInvoice.findOne({
      idempotentKey: this.invoiceKey(input.idempotentKey),
    }).lean();
    const receipt = invoice
      ? await BillingReceipt.findOne({ invoiceId: invoice._id }).lean()
      : null;
    if (invoice && receipt) return { invoice, receipt, charged: true, amountCents };
    // 首次出账为 0 费用（未产生账单/扣费）时重放：直接返回 0 费用结果。
    if (!invoice && amountCents === 0) {
      return { invoice: null, receipt: null, charged: true, amountCents: 0 };
    }

    const account = await BillingAccount.findById(input.accountId).lean();
    const at = new Date(this.now());
    const quote = await this.prices.quote(input.spec, at);
    const itemCents = allocateSpecItemCents(quote.items, input.minutes);
    return this.finalizeCharge({
      input,
      quote,
      itemCents,
      amountCents: invoice ? Math.abs(Number(invoice.amount)) : amountCents,
      balanceAfter: Number(invoice?.balanceAfter ?? account?.cashBalance ?? 0),
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      meteringId: null,
    });
  }

  private async finalizeCharge(args: {
    input: SpecChargeInput;
    quote: SpecRateQuote;
    itemCents: number[];
    amountCents: number;
    balanceAfter: number;
    periodStart: Date;
    periodEnd: Date;
    meteringId?: string | null;
  }): Promise<SpecChargeResult> {
    const { input, quote, itemCents, amountCents, balanceAfter, periodStart, periodEnd } = args;
    if (amountCents <= 0) {
      return { invoice: null, receipt: null, charged: true, amountCents: 0 };
    }
    const invoiceId = deterministicObjectId(this.invoiceKey(input.idempotentKey));
    const receiptId = deterministicObjectId(`receipt:${input.idempotentKey}`);
    const invoice = await this.invoicings.createInvoice({
      invoiceId,
      idempotentKey: this.invoiceKey(input.idempotentKey),
      accountId: input.accountId,
      type: 'charge',
      category: 'container',
      amount: -Math.round(amountCents),
      balanceAfter: Math.round(balanceAfter),
      refType: 'cloud_host',
      refId: input.hostId,
      description: this.describe(input, periodStart, periodEnd),
      items: quote.items.map((item, index) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: itemCents[index] ?? 0,
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
        hostId: input.hostId,
        resourceId: input.resourceId,
        minutes: input.minutes,
        amountCents,
        cpu: input.spec.cpu,
        memoryGi: input.spec.memoryGi,
        ephemeralStorageGi: input.spec.ephemeralStorageGi,
        event: 'spec_charge',
      },
      '[billing] spec period charged',
    );
    return { invoice, receipt, charged: true, amountCents };
  }
}

export const specChargeService = new SpecChargeService();
