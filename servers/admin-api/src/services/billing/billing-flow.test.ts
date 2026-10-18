import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { BillingReservation } from '../../models/billing-reservation.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { ProductPrice } from '../../models/product-price.js';
import { BillingEvent } from '../../models/billing-event.js';
import { accountService } from './account-service.js';
import { BillingService } from './billing-service.js';
import { CreditCheckService } from './credit-check.js';
import { InvoicingService } from './invoicing.js';
import { PaymentService } from './payment.js';
import { PricingService, pricingService } from './pricing.js';
import { ReceiptService } from './receipt.js';
import { ReservationService } from './reservation.js';
import { MeteringService } from './metering.js';
import { eventIngestService } from './event-ingest.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const T0 = new Date('2026-10-01T00:00:00.000Z').getTime();

function setup(nowValue: { value: number }) {
  const checks = new CreditCheckService({ now: () => nowValue.value });
  const payments = new PaymentService(checks, () => nowValue.value);
  const reservations = new ReservationService(payments, pricingService, checks, accountService, {
    cycleMs: 60_000,
    now: () => nowValue.value,
  });
  const destroyContainer = vi.fn(async () => undefined);
  const billing = new BillingService({
    accounts: accountService,
    payments,
    checks,
    reservations,
    invoicings: new InvoicingService(),
    receipts: new ReceiptService(),
    meterings: new MeteringService(),
    now: () => nowValue.value,
    destroyContainer,
  });
  return { checks, payments, reservations, billing, destroyContainer };
}

async function createAccount(cashCredits = 100) {
  const ownerId = new mongoose.Types.ObjectId().toString();
  const account = await accountService.getOrCreate('front_user', ownerId, `user-${ownerId.slice(-4)}`);
  if (cashCredits > 0) {
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'recharge',
      deltaBalance: cashCredits * 100,
      deltaFrozen: 0,
      idempotentKey: `seed:${account.id}`,
    });
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: cashCredits * 100 } });
  }
  return account;
}

describe('计费域核心（真实 Mongo 集成）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await pricingService.ensureDefaultPrices();
  }, 60000);

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    await pricingService.ensureDefaultPrices();
  });

  it('T-B7/B31: 充值 → 账单/收据，ledger 累加恒等于钱包', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(0);
    const result = await billing.recharge({ accountId: account.id, amountCredits: 100, note: 'test' });
    expect(result.amount).toBe(10000);
    expect(result.seq).toBe(0);

    const updated = await accountService.getById(account.id);
    expect(updated?.cashBalance).toBe(10000);
    const ledgerSum = await BillingLedger.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(account.id) } },
      { $group: { _id: null, balance: { $sum: '$deltaBalance' }, frozen: { $sum: '$deltaFrozen' } } },
    ]);
    expect(ledgerSum[0].balance).toBe(updated?.cashBalance);
    expect(ledgerSum[0].frozen).toBe(updated?.frozenAmount);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(1);
    expect(await BillingReceipt.countDocuments({ accountId: account.id })).toBe(1);
  });

  it('回归 R1: ready→freeze 全链路不再出现 preCheck ref mismatch', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);

    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-1',
      occurredAt: new Date(T0),
    });
    expect(ready.insufficient).toBe(false);
    const reservation = await BillingReservation.findById(ready.reservationId);
    expect(reservation?.status).toBe('ACTIVE');
    // 保证金 5 credits + 首期预估 1 credit
    const updated = await accountService.getById(account.id);
    expect(updated?.frozenAmount).toBe(600);
    expect(await BillingLedger.countDocuments({ bizType: 'freeze' })).toBe(2);
  });

  it('T-B2/B13: 周期结算可重放（重复消息不重复扣费/开票），账单 seq 连续', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-2',
      occurredAt: new Date(T0),
    });

    nowValue.value = T0 + 60_000;
    const first = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(first.settled).toBe(true);
    expect(first.invoice?.amount).toBe(100);
    const invoiceCount = await BillingInvoice.countDocuments({ accountId: account.id });
    const chargeCount = await BillingLedger.countDocuments({ bizType: 'charge' });

    const replay = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(replay.settled).toBe(true);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(invoiceCount);
    expect(await BillingLedger.countDocuments({ bizType: 'charge' })).toBe(chargeCount);

    nowValue.value = T0 + 120_000;
    const second = await billing.handleSettlementCycle(ready.reservationId, 1);
    expect(second.settled).toBe(true);
    const invoices = await BillingInvoice.find({ accountId: account.id }).sort({ seq: 1 });
    expect(invoices.map((invoice) => invoice.seq)).toEqual([0, 1]);
  });

  it('T-B19: 销毁尾结释放全部冻结，余额不足也不阻塞释放', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(6); // 刚好够保证金+首期
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-3',
      occurredAt: new Date(T0),
    });
    // 模拟余额被其他消费耗尽（冻结仍保留），尾结不被余额阻塞
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 0 } });

    // 容器运行 2.5 分钟未收到周期消息 → 尾结 ceil 到 3 分钟
    nowValue.value = T0 + 150_000;
    const invoice = await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'container-3',
      occurredAt: new Date(nowValue.value),
    });
    expect(invoice?.amount).toBe(300);
    const reservation = await BillingReservation.findById(ready.reservationId);
    expect(reservation?.status).toBe('SETTLED');
    const updated = await accountService.getById(account.id);
    expect(updated?.frozenAmount).toBe(0);
    // 余额不足允许为负
    expect(updated!.cashBalance).toBeLessThan(0);

    // 重复销毁事件：不再开票/扣费
    const invoiceCount = await BillingInvoice.countDocuments({ accountId: account.id });
    await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'container-3',
      occurredAt: new Date(nowValue.value),
    });
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(invoiceCount);
  });

  it('T-B4: 并发出账 seq 不重不漏', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(0);
    await Promise.all([
      billing.recharge({ accountId: account.id, amountCredits: 10 }),
      billing.recharge({ accountId: account.id, amountCredits: 20 }),
      billing.recharge({ accountId: account.id, amountCredits: 30 }),
    ]);
    const invoices = await BillingInvoice.find({ accountId: account.id }).sort({ seq: 1 });
    expect(invoices.map((invoice) => invoice.seq)).toEqual([0, 1, 2]);
  });

  it('T-B6/B7: 拆池顺序 现金→赠送→授信，ledger 与钱包一致', async () => {
    const nowValue = { value: T0 };
    const { payments, checks } = setup(nowValue);
    const account = await createAccount(0);
    await BillingAccount.updateOne(
      { _id: account.id },
      { $set: { cashBalance: 100, giftBalance: 50, creditLimit: 100 } },
    );
    // 让 ledger 与钱包一致：先写等额流水（现金+赠送）
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'adjust',
      deltaBalance: 100,
      idempotentKey: 'seed-cash',
    });
    await BillingLedger.create({
      accountId: account.id,
      pool: 'gift',
      bizType: 'adjust',
      deltaBalance: 50,
      idempotentKey: 'seed-gift',
    });

    const check = await checks.check({
      accountId: account.id,
      estimatedCredits: 200,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'm1' },
    });
    const result = await payments.charge({
      accountId: account.id,
      amountCents: 200,
      idempotentKey: 'charge:pool-test',
      bizId: 'pool-test',
      preCheck: check.preCheck!,
    });
    expect(result.allocations).toEqual([
      { pool: 'cash', amount: 100 },
      { pool: 'gift', amount: 50 },
      { pool: 'credit', amount: 50 },
    ]);
    const updated = await accountService.getById(account.id);
    expect(updated?.cashBalance).toBe(-50);
    expect(updated?.giftBalance).toBe(0);
    const sums = await BillingLedger.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(account.id) } },
      { $group: { _id: null, balance: { $sum: '$deltaBalance' } } },
    ]);
    expect(sums[0].balance).toBe(updated?.cashBalance);
  });

  it('T-B10: ledger/invoice/receipt 追加式不可变', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(0);
    await billing.recharge({ accountId: account.id, amountCredits: 10 });
    await expect(BillingLedger.updateOne({}, { $set: { deltaBalance: 1 } })).rejects.toThrow();
    await expect(BillingInvoice.updateOne({}, { $set: { amount: 1 } })).rejects.toThrow();
    await expect(BillingReceipt.updateOne({}, { $set: { amount: 1 } })).rejects.toThrow();
  });

  it('T-B11: payment 必须携带匹配的预检凭证', async () => {
    const nowValue = { value: T0 };
    const { payments, checks } = setup(nowValue);
    const account = await createAccount(100);
    await expect(
      payments.charge({
        accountId: account.id,
        amountCents: 10,
        idempotentKey: 'no-precheck',
        bizId: 'x',
        preCheck: 'missing',
      }),
    ).rejects.toThrow(/preCheck/);

    const check = await checks.check({
      accountId: account.id,
      estimatedCredits: 10,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'a' },
    });
    await expect(
      payments.charge({
        accountId: account.id,
        amountCents: 10,
        idempotentKey: 'ref-mismatch',
        bizId: 'x',
        preCheck: check.preCheck!,
        ref: { type: 'model_call', id: 'b' },
      }),
    ).rejects.toThrow(/ref mismatch/);
  });

  it('T-B12: 精确核算以流水为准校准钱包并留 adjust 差错记录', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(0);
    await billing.recharge({ accountId: account.id, amountCredits: 10 });
    await BillingAccount.updateOne({ _id: account.id }, { $inc: { cashBalance: 500 } });

    const reconciled = await accountService.reconcileAccount(account.id);
    expect(reconciled.error).not.toBeNull();
    expect(reconciled.account.cashBalance).toBe(1000);
    expect(await BillingLedger.countDocuments({ bizType: 'adjust' })).toBe(1);
  });

  it('T-B5/冻结账户: accrue-and-track 下冻结账户仍可周期结算（不抛 preCheck required）', async () => {
    const nowValue = { value: T0 };
    const { billing, reservations } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-4',
      occurredAt: new Date(T0),
    });
    await BillingAccount.updateOne({ _id: account.id }, { $set: { status: 'frozen' } });

    nowValue.value = T0 + 60_000;
    const result = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(result.settled).toBe(true);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(1);
    expect(await reservations.findById(ready.reservationId)).not.toBeNull();
  });

  it('T-B17: 首期消息丢失时扫描兜底从 seq 0 补结算', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-5',
      occurredAt: new Date(T0),
    });
    expect((await BillingReservation.findById(ready.reservationId))?.lastCycleSeq).toBe(-1);

    nowValue.value = T0 + 61_000;
    // 直接模拟扫描器：lastCycleSeq=-1 → 应结算 seq 0
    const result = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(result.settled).toBe(true);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(1);
  });

  it('T-B18: 欠费 9\'59" 不拆、10\'00" 强拆并重置计时', async () => {
    const nowValue = { value: T0 };
    const { billing, destroyContainer } = setup(nowValue);
    const account = await createAccount(0); // 无余额
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-6',
      occurredAt: new Date(T0),
    });
    // 首期结算产生欠费并开始计时
    nowValue.value = T0 + 60_000;
    await billing.handleSettlementCycle(ready.reservationId, 0);
    const accountAfter = await accountService.getById(account.id);
    expect(accountAfter?.insufficientSince).not.toBeNull();

    // 9'59"
    nowValue.value = T0 + 599_000;
    await billing.handleSettlementCycle(ready.reservationId, 1);
    expect(destroyContainer).not.toHaveBeenCalled();

    // 10'00"（自 readiness 起算）
    nowValue.value = T0 + 601_000;
    await billing.handleSettlementCycle(ready.reservationId, 2);
    expect(destroyContainer).toHaveBeenCalledWith(
      'container-6',
      '余额不足超过 10 分钟，强制销毁',
    );
  });

  it('T-B14/T-B16: 模型调用事件重复投递只出账一次，中断标注 aborted', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    await ProductPrice.create({
      productId: 'model.m1.token',
      productName: 'm1',
      pricingModel: 'per_token',
      rates: { inputPerMillion: 100, cachedInputPerMillion: 50, outputPerMillion: 200 },
      isBillable: true,
      effectiveFrom: new Date(0),
    });
    await BillingApiCall.create({
      requestId: 'req-1',
      accountId: account.id,
      apiKeyId: new mongoose.Types.ObjectId(),
      modelId: 'm1',
      modelName: 'm1',
      startedAt: new Date(T0),
    });
    const event = {
      eventId: 'model_call.completed:req-1',
      eventType: 'model_call.completed',
      occurredAt: new Date(T0),
      accountId: account.id,
      resourceId: 'req-1',
      payload: {
        modelId: 'm1',
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 1000,
      },
    };
    await eventIngestService.ingest(event);
    const first = await billing.handleModelCallEvent(event);
    expect(first?.amount).toBeGreaterThan(0);
    const count = await BillingInvoice.countDocuments({ accountId: account.id });
    await billing.handleModelCallEvent(event);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(count);

    // 中断事件单独出账并标注
    await BillingApiCall.create({
      requestId: 'req-2',
      accountId: account.id,
      apiKeyId: new mongoose.Types.ObjectId(),
      modelId: 'm1',
      modelName: 'm1',
      startedAt: new Date(T0),
    });
    const aborted = {
      eventId: 'model_call.aborted:req-2',
      eventType: 'model_call.aborted',
      occurredAt: new Date(T0),
      accountId: account.id,
      resourceId: 'req-2',
      payload: { modelId: 'm1', inputTokens: 10, outputTokens: 10, estimated: false },
    };
    await eventIngestService.ingest(aborted);
    await billing.handleModelCallEvent(aborted);
    const call = await BillingApiCall.findOne({ requestId: 'req-2' });
    expect(call?.status).toBe('aborted');
  });

  it('T-B3: 调价后新消费取新档，历史账单单价快照不变', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-7',
      occurredAt: new Date(T0),
    });
    nowValue.value = T0 + 60_000;
    await billing.handleSettlementCycle(ready.reservationId, 0);
    const before = await BillingInvoice.findOne({ accountId: account.id }).sort({ seq: 1 });

    await ProductPrice.create({
      productId: 'container.minute',
      productName: '容器（调价）',
      pricingModel: 'per_unit',
      unitPrice: 200,
      rates: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
      isBillable: true,
      effectiveFrom: new Date(T0 + 30_000),
    });
    nowValue.value = T0 + 120_000;
    await billing.handleSettlementCycle(ready.reservationId, 1);
    const after = await BillingInvoice.findOne({ accountId: account.id }).sort({ seq: -1 });
    expect(before?.items[0].unitPrice).toBe(100);
    expect(after?.items[0].unitPrice).toBe(200);
    expect(after?.amount).toBe(-200);
  });

  it('T-B15: 死信留档字段完整（费用中心可查）', async () => {
    const { BillingDeadLetter } = await import('../../models/billing-dead-letter.js');
    await BillingDeadLetter.create({
      queue: 'billing.metering.q',
      routingKey: 'container.ready',
      eventId: 'evt-dlq',
      payload: { eventId: 'evt-dlq' },
      error: 'boom',
      attempts: 6,
    });
    const docs = await BillingDeadLetter.find();
    expect(docs).toHaveLength(1);
    expect(docs[0].eventId).toBe('evt-dlq');
  });

  it('T-B16: 未到期结算消息不提前扣费；已 SETTLED 后重复销毁不重复出账', async () => {
    const nowValue = { value: T0 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-early',
      occurredAt: new Date(T0),
    });
    nowValue.value = T0 + 30_000;
    const early = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(early.settled).toBe(false);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(0);

    nowValue.value = T0 + 150_000;
    await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'container-early',
      occurredAt: new Date(nowValue.value),
    });
    const count = await BillingInvoice.countDocuments({ accountId: account.id });
    await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'container-early',
      occurredAt: new Date(nowValue.value),
    });
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(count);
  });

  it('预留缺失时按事件时长兜底出账（legacy 路径）', async () => {
    const nowValue = { value: T0 + 150_000 };
    const { billing } = setup(nowValue);
    const account = await createAccount(100);
    const invoice = await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'legacy-1',
      occurredAt: new Date(nowValue.value),
      payload: { billingStartedAt: new Date(T0).toISOString() },
    });
    expect(invoice?.amount).toBe(300);
    // 重复事件幂等
    const count = await BillingInvoice.countDocuments({ accountId: account.id });
    await billing.handleContainerDestroyed({
      accountId: account.id,
      resourceId: 'legacy-1',
      occurredAt: new Date(nowValue.value),
      payload: { billingStartedAt: new Date(T0).toISOString() },
    });
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(count);
  });

  it('强拆控制面失败不阻断结算，返回 0', async () => {
    const nowValue = { value: T0 };
    const { billing, destroyContainer } = setup(nowValue);
    destroyContainer.mockRejectedValueOnce(new Error('control plane down'));
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-fail',
      occurredAt: new Date(T0),
    });
    nowValue.value = T0 + 120_000;
    const destroyed = await billing.forceDestroyAccountContainers(account.id);
    expect(destroyed).toBe(0);
    const reservation = await BillingReservation.findById(ready.reservationId);
    expect(reservation?.status).toBe('SETTLED');
  });

  it('T-B20: 超期预留被自动最终结算释放（expectedEndAt 有写入点）', async () => {
    const nowValue = { value: T0 };
    const { billing, reservations } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-8',
      occurredAt: new Date(T0),
    });
    const reservation = await BillingReservation.findById(ready.reservationId);
    expect(reservation?.expectedEndAt).toBeInstanceOf(Date);

    const { ReconciliationService } = await import('./reconciliation.js');
    const recon = new ReconciliationService(billing, reservations, {
      listContainers: async () => [],
      now: () => T0 + 120_000,
    });
    const reports = await recon.run('resources');
    expect(reports[0].errorCount).toBe(1);
    const settled = await BillingReservation.findById(ready.reservationId);
    expect(settled?.status).toBe('SETTLED');
  });

  it('T-B21: 资源列表失败时中止资源对账，不误释放预留', async () => {
    const nowValue = { value: T0 };
    const { billing, reservations } = setup(nowValue);
    const account = await createAccount(100);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-9',
      occurredAt: new Date(T0),
    });
    const { ReconciliationService } = await import('./reconciliation.js');
    const recon = new ReconciliationService(billing, reservations, {
      listContainers: async () => {
        throw new Error('control plane down');
      },
      now: () => T0 + 60_000,
    });
    const [report] = await recon.run('resources');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({ error: 'list_containers_failed' });
    const reservation = await BillingReservation.findById(ready.reservationId);
    expect(reservation?.status).toBe('ACTIVE');
  });
});
