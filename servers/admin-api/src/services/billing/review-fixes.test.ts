import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingAppliedLedger } from '../../models/billing-applied-ledger.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingReservation } from '../../models/billing-reservation.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { accountService } from './account-service.js';
import { CreditCheckService } from './credit-check.js';
import { PaymentService } from './payment.js';
import { BillingService } from './billing-service.js';
import { InvoicingService } from './invoicing.js';
import { ReceiptService } from './receipt.js';
import { ReservationService } from './reservation.js';
import { PricingService, pricingService } from './pricing.js';
import { MeteringService } from './metering.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';
import type { PaymentService as PaymentServiceType } from './payment.js';

const T0 = new Date('2026-10-01T00:00:00.000Z').getTime();

function buildBilling(nowValue: { value: number }, payments?: PaymentServiceType) {
  const checks = new CreditCheckService({ now: () => nowValue.value });
  const resolvedPayments = payments ?? new PaymentService(checks, () => nowValue.value);
  const reservations = new ReservationService(
    resolvedPayments,
    pricingService,
    checks,
    accountService,
    { cycleMs: 60_000, now: () => nowValue.value },
  );
  const billing = new BillingService({
    accounts: accountService,
    payments: resolvedPayments,
    checks,
    reservations,
    invoicings: new InvoicingService(),
    receipts: new ReceiptService(),
    meterings: new MeteringService(),
    now: () => nowValue.value,
  });
  return { billing, checks, reservations, payments: resolvedPayments };
}

async function seedAccount(cashCents: number, giftCents = 0) {
  const account = await accountService.getOrCreate(
    'front_user',
    new mongoose.Types.ObjectId().toString(),
    'review-user',
  );
  if (cashCents > 0) {
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'recharge',
      deltaBalance: cashCents,
      deltaFrozen: 0,
      allocations: [{ pool: 'cash', amount: cashCents }],
      idempotentKey: `seed-cash:${account.id}`,
      walletApplied: true,
    });
  }
  if (giftCents > 0) {
    await BillingLedger.create({
      accountId: account.id,
      pool: 'gift',
      bizType: 'recharge',
      deltaBalance: giftCents,
      deltaFrozen: 0,
      allocations: [{ pool: 'gift', amount: giftCents }],
      idempotentKey: `seed-gift:${account.id}`,
      walletApplied: true,
    });
  }
  await BillingAccount.updateOne(
    { _id: account.id },
    { $set: { cashBalance: cashCents, giftBalance: giftCents } },
  );
  return account;
}

describe('Review 返工回归（阻断项 1/3/4 + A1/A3/A5）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await pricingService.ensureDefaultPrices();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('阻断项 1：含赠送余额的账户对账不得放大可用余额（gift 不被折叠进现金）', async () => {
    const account = await seedAccount(1000, 500);
    // 人为制造现金漂移（如崩溃遗留），对账应只校准现金，赠送达 500 不动。
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 1200 } });

    const before = await accountService.getById(account.id);
    const result = await accountService.reconcileAccount(account.id);
    const after = await accountService.getById(account.id);

    expect(result.error).not.toBeNull();
    expect(after?.giftBalance).toBe(500);
    expect(after?.cashBalance).toBe(1000);
    // 关键：可用余额不被放大（现金 1000 + 赠送 500 = 1500，而非 1200+500 或 1500+500）
    expect(after?.availableBalance).toBe(1500);
    expect(after!.availableBalance).toBeLessThanOrEqual(before!.availableBalance);

    // 一致时对账不再报错，且幂等
    const again = await accountService.reconcileAccount(account.id);
    expect(again.error).toBeNull();
    expect((await accountService.getById(account.id))?.availableBalance).toBe(1500);
  });

  it('阻断项 3：重复 cycle 消息被去重门挡下（settled=false，不再结算/投递下一期）', async () => {
    const nowValue = { value: T0 };
    const { billing } = buildBilling(nowValue);
    const account = await seedAccount(1000);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-reg-1',
      occurredAt: new Date(T0),
    });
    nowValue.value = T0 + 60_000;

    const first = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(first.settled).toBe(true);
    const chargeCount = await BillingLedger.countDocuments({ bizType: 'charge' });

    const replay = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(replay.settled).toBe(false);
    expect(await BillingLedger.countDocuments({ bizType: 'charge' })).toBe(chargeCount);
  });

  it('阻断项 3/A2：乱序旧 cycle 不回拨 expectedEndAt，已结算预留不被复活', async () => {
    const nowValue = { value: T0 };
    const { billing } = buildBilling(nowValue);
    const account = await seedAccount(1000);
    const ready = await billing.handleContainerReady({
      accountId: account.id,
      resourceId: 'container-reg-2',
      occurredAt: new Date(T0),
    });

    nowValue.value = T0 + 120_000;
    const first = await billing.handleSettlementCycle(ready.reservationId, 1);
    expect(first.settled).toBe(true);
    const afterCycle1 = await BillingReservation.findById(ready.reservationId);
    const endAfter1 = afterCycle1!.expectedEndAt!.getTime();

    // 重放同一 cycle：去重门返回未结算，且不改变 expectedEndAt
    const replay = await billing.handleSettlementCycle(ready.reservationId, 1);
    expect(replay.settled).toBe(false);
    const afterReplay = await BillingReservation.findById(ready.reservationId);
    expect(afterReplay!.expectedEndAt!.getTime()).toBe(endAfter1);

    // 乱序补结旧 cycle 0（首次结算）：expectedEndAt 用 $max 守卫，不得回拨
    const stale = await billing.handleSettlementCycle(ready.reservationId, 0);
    expect(stale.settled).toBe(true);
    const afterStale = await BillingReservation.findById(ready.reservationId);
    expect(afterStale!.expectedEndAt!.getTime()).toBeGreaterThanOrEqual(endAfter1);
    expect(afterStale!.status).toBe('ACTIVE');
  });

  it('A3：同账户并发 charge 不把赠送打成负数', async () => {
    const account = await seedAccount(0, 100);
    const checks = new CreditCheckService();
    const payments = new PaymentService(checks);
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 80,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r-conc' },
    })).preCheck!;

    const [a, b] = await Promise.all([
      payments.charge({
        accountId: account.id,
        amountCents: 80,
        idempotentKey: 'conc-a',
        bizId: 'conc-a',
        preCheck,
        ref: { type: 'model_call', id: 'r-conc' },
      }),
      payments.charge({
        accountId: account.id,
        amountCents: 80,
        idempotentKey: 'conc-b',
        bizId: 'conc-b',
        preCheck,
        ref: { type: 'model_call', id: 'r-conc' },
      }),
    ]);
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    const updated = await accountService.getById(account.id);
    expect(updated!.giftBalance).toBeGreaterThanOrEqual(0);
    // 两笔合计 160 = 赠送 100 + 授信 60（现金为 -60）
    expect(updated!.cashBalance).toBe(-60);
    expect(updated!.giftBalance).toBe(0);
  });

  it('A-1：start 回滚仅解冻「确实落账」的冻结额（freeze 未落账不得解冻）', async () => {
    const account = await seedAccount(1000);
    const checks = new CreditCheckService();
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: 'res-fail' },
    })).preCheck!;

    const unfreezeCalls: Array<{ amountCents: number; idempotentKey: string }> = [];
    let freezeCalls = 0;
    // 第一次 freeze 真实落账（模拟成功），第二次抛错且**未落账**。
    const failingPayments = {
      async freeze(input: { accountId: string; amountCents: number; bizId: string; idempotentKey: string }) {
        freezeCalls += 1;
        if (freezeCalls >= 2) throw new Error('freeze boom');
        await BillingLedger.create({
          accountId: input.accountId,
          pool: 'cash',
          bizType: 'freeze',
          deltaBalance: 0,
          deltaFrozen: input.amountCents,
          allocations: [],
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
        });
        return { applied: true, cashBalance: 0, frozenAmount: input.amountCents, ledgerId: null, allocations: [] };
      },
      async unfreeze(input: { amountCents: number; idempotentKey: string }) {
        unfreezeCalls.push({ amountCents: input.amountCents, idempotentKey: input.idempotentKey });
        return { applied: true, cashBalance: 0, frozenAmount: 0, ledgerId: null, allocations: [] };
      },
      async charge() {
        throw new Error('unused');
      },
      async recharge() {
        throw new Error('unused');
      },
    } as unknown as PaymentServiceType;

    const reservations = new ReservationService(
      failingPayments,
      pricingService,
      checks,
      accountService,
      { cycleMs: 60_000, now: () => T0 },
    );

    await expect(
      reservations.start({
        accountId: account.id,
        resourceId: 'res-fail',
        startedAt: new Date(T0),
        depositCents: 500,
        cycleEstimateCents: 100,
        preCheck,
      }),
    ).rejects.toThrow('freeze boom');

    // 仅解冻已落账的 deposit；未落账的 cycle（100）不得解冻（否则蚕食他人冻结额）。
    expect(unfreezeCalls).toHaveLength(1);
    expect(unfreezeCalls[0]!.idempotentKey.startsWith('unfreeze:deposit-rollback:')).toBe(true);
    expect(unfreezeCalls[0]!.amountCents).toBe(500);
    const reservation = await BillingReservation.findOne({ resourceId: 'res-fail' });
    expect(reservation?.status).toBe('FAILED');

    // 无任何 freeze 落账时，回滚不得产生 unfreeze 流水。
    unfreezeCalls.length = 0;
    freezeCalls = 100;
    await expect(
      reservations.start({
        accountId: account.id,
        resourceId: 'res-fail-2',
        startedAt: new Date(T0),
        depositCents: 500,
        cycleEstimateCents: 100,
        preCheck,
      }),
    ).rejects.toThrow('freeze boom');
    expect(unfreezeCalls).toHaveLength(0);
  });

  it('A-1：A 预留回滚不得蚕食同账户并存预留 B 的冻结额', async () => {
    const account = await seedAccount(5000);
    const checks = new CreditCheckService({ now: () => T0 });
    const payments = new PaymentService(checks, () => T0);
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 1000,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: 'res-B' },
    })).preCheck!;

    const reservations = new ReservationService(payments, pricingService, checks, accountService, {
      cycleMs: 60_000,
      now: () => T0,
    });

    // 预留 B 正常冻结 500。
    await reservations.start({
      accountId: account.id,
      resourceId: 'res-B',
      startedAt: new Date(T0),
      depositCents: 500,
      cycleEstimateCents: 0,
      preCheck,
    });
    const frozenAfterB = (await accountService.getById(account.id))!.frozenAmount;
    expect(frozenAfterB).toBe(500);

    // 预留 A：freeze 第一次成功、第二次抛错且未落账 → 只解冻 A 的 500，B 不受影响。
    let calls = 0;
    const preCheckA = (await checks.check({
      accountId: account.id,
      estimatedCredits: 600,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: 'res-A' },
    })).preCheck!;
    const flaky = {
      freeze: async (input: { accountId: string; amountCents: number; bizId: string; idempotentKey: string }) => {
        calls += 1;
        if (calls === 2) throw new Error('freeze boom');
        return payments.freeze({
          accountId: input.accountId,
          amountCents: input.amountCents,
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          preCheck: preCheckA,
          ref: { type: 'container_reservation', id: 'res-A' },
        });
      },
      unfreeze: (input: { accountId: string; amountCents: number; bizId: string; idempotentKey: string }) =>
        payments.unfreeze(input),
      charge: payments.charge.bind(payments),
      recharge: payments.recharge.bind(payments),
    } as unknown as PaymentServiceType;
    const flakyReservations = new ReservationService(
      flaky,
      pricingService,
      checks,
      accountService,
      { cycleMs: 60_000, now: () => T0 },
    );
    await expect(
      flakyReservations.start({
        accountId: account.id,
        resourceId: 'res-A',
        startedAt: new Date(T0),
        depositCents: 500,
        cycleEstimateCents: 100,
        preCheck,
      }),
    ).rejects.toThrow('freeze boom');

    // A 的回滚不得改变 B 的冻结额与账户 frozenAmount。
    expect((await accountService.getById(account.id))!.frozenAmount).toBe(frozenAfterB);
    const rollbackRows = await BillingLedger.countDocuments({
      idempotentKey: /^unfreeze:.*rollback/,
    });
    expect(rollbackRows).toBe(1); // 仅 A 的 deposit 回滚
  });

  it('A-2/R2-1：真实挤出水位后重放不二扣 + 崩溃残留（pending+租约过期）走自愈不二扣', async () => {
    const account = await seedAccount(100000);
    const checks = new CreditCheckService();
    const payments = new PaymentService(checks);
    const ref = { type: 'model_call' as const, id: 'r-watermark' };
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref,
    })).preCheck!;

    // 1) 正常扣费一条（写入不淘汰幂等标记）
    const first = await payments.charge({
      accountId: account.id,
      amountCents: 100,
      idempotentKey: 'wm-key',
      bizId: 'wm-biz',
      preCheck,
      ref,
    });
    expect(first.applied).toBe(true);

    // 2) 模拟「钱包已应用但同步标记写失败」（崩溃残留）：把 crash-key 的标记改成 pending + 租约过期。
    const second = await payments.charge({
      accountId: account.id,
      amountCents: 100,
      idempotentKey: 'crash-key',
      bizId: 'crash-biz',
      preCheck,
      ref,
    });
    expect(second.applied).toBe(true);
    const crashLedger = await BillingLedger.findOne({ idempotentKey: 'crash-key' }).lean();
    await BillingAppliedLedger.collection.updateOne(
      { accountId: new mongoose.Types.ObjectId(account.id), ledgerId: String(crashLedger!._id) },
      { $set: { walletApplied: false, claimedAt: new Date(Date.now() - 5 * 60_000) } },
    );
    // 自证：claimedAt 必须真实落库（schema 缺字段会让整条租约/自愈状态机变死代码）。
    const rawMarker = await BillingAppliedLedger.collection.findOne({
      accountId: new mongoose.Types.ObjectId(account.id),
      ledgerId: String(crashLedger!._id),
    });
    expect(rawMarker?.claimedAt).toBeInstanceOf(Date);

    // 3) 经 payments 真实灌 >1000 笔，把两条键挤出 `appliedLedgerIds` 水位（修复前的空转测试不触发该前置条件）。
    for (let i = 0; i < 1001; i += 1) {
      await payments.recharge({
        accountId: account.id,
        amountCents: 1,
        idempotentKey: `fill-${i}`,
        bizId: `fill-${i}`,
      });
    }
    const wmLedger = await BillingLedger.findOne({ idempotentKey: 'wm-key' }).lean();
    const accountAfterFill = (await BillingAccount.findById(account.id).lean()) as {
      appliedLedgerIds?: string[];
      cashBalance?: number;
    };
    expect((accountAfterFill.appliedLedgerIds ?? []).includes(String(wmLedger!._id))).toBe(false);
    expect((accountAfterFill.appliedLedgerIds ?? []).includes(String(crashLedger!._id))).toBe(false);

    // 4) 重放旧键（标记 applied）→ no-op，余额不变。
    const balanceBeforeReplay = (await accountService.getById(account.id))!.cashBalance;
    const replay = await payments.charge({
      accountId: account.id,
      amountCents: 100,
      idempotentKey: 'wm-key',
      bizId: 'wm-biz',
      preCheck,
      ref,
    });
    expect(replay.applied).toBe(false);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(balanceBeforeReplay);

    // 5) 重放崩溃残留键（pending + 租约过期）→ 走「按 ledger 真值绝对校准」自愈，**不重复 `$inc`**。
    //    修复前（claimedAt 未落库 → CAS 恒命中 → claimed）此处会再扣 100。
    const balanceBeforeCrashReplay = (await accountService.getById(account.id))!.cashBalance;
    const crashReplay = await payments.charge({
      accountId: account.id,
      amountCents: 100,
      idempotentKey: 'crash-key',
      bizId: 'crash-biz',
      preCheck,
      ref,
    });
    expect(crashReplay.applied).toBe(true);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(balanceBeforeCrashReplay);
    const healed = await BillingAppliedLedger.collection.findOne({
      accountId: new mongoose.Types.ObjectId(account.id),
      ledgerId: String(crashLedger!._id),
    });
    expect(healed?.walletApplied).toBe(true);
  });

  it('A-5: heldFrozen 过滤账户且转义正则（reservationId=.* 不跨预留求和）', async () => {
    const account = await seedAccount(1000);
    const other = await seedAccount(1000);
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'freeze',
      deltaBalance: 0,
      deltaFrozen: 300,
      bizId: 'reservation:res-1:deposit',
      idempotentKey: 'hf-1',
    });
    await BillingLedger.create({
      accountId: other.id,
      pool: 'cash',
      bizType: 'freeze',
      deltaBalance: 0,
      deltaFrozen: 700,
      bizId: 'reservation:res-2:deposit',
      idempotentKey: 'hf-2',
    });
    const checks = new CreditCheckService();
    const reservations = new ReservationService(
      new PaymentService(checks),
      pricingService,
      checks,
      accountService,
      { cycleMs: 60_000, now: () => T0 },
    );
    expect(await reservations.heldFrozen('res-1', account.id)).toBe(300);
    // 正则转义：'.*' 作为字面量前缀匹配不到任何预留（未转义时会跨预留求和 = 1000）。
    expect(await reservations.heldFrozen('.*', account.id)).toBe(0);
  });

  it('A-6：同幂等键但归属另一账户时拒绝应用（不跨账户造钱/销账）', async () => {
    const accountA = await seedAccount(1000);
    const accountB = await seedAccount(1000);
    await BillingLedger.create({
      accountId: accountA.id,
      pool: 'cash',
      bizType: 'charge',
      deltaBalance: -100,
      deltaFrozen: 0,
      allocations: [{ pool: 'cash', amount: 100 }],
      idempotentKey: 'cross-key',
    });
    const checks = new CreditCheckService();
    const payments = new PaymentService(checks);
    const preCheck = (await checks.check({
      accountId: accountB.id,
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r-cross' },
    })).preCheck!;

    await expect(
      payments.charge({
        accountId: accountB.id,
        amountCents: 100,
        idempotentKey: 'cross-key',
        bizId: 'cross-biz',
        preCheck,
        ref: { type: 'model_call', id: 'r-cross' },
      }),
    ).rejects.toThrow(/another account/);
    expect((await accountService.getById(accountB.id))!.cashBalance).toBe(1000);
  });

  it('A5：recharge 携带同一幂等键重复提交不重复加钱', async () => {
    const nowValue = { value: T0 };
    const { billing } = buildBilling(nowValue);
    const account = await seedAccount(0);

    const first = await billing.recharge({
      accountId: account.id,
      amountCredits: 10,
      idempotencyKey: 'op-123',
    });
    const balanceAfterFirst = (await accountService.getById(account.id))!.cashBalance;
    expect(balanceAfterFirst).toBe(1000);

    const second = await billing.recharge({
      accountId: account.id,
      amountCredits: 10,
      idempotencyKey: 'op-123',
    });
    expect(second.invoiceId).toBe(first.invoiceId);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(1000);
    expect(await BillingInvoice.countDocuments({ accountId: account.id })).toBe(1);
    expect(await BillingLedger.countDocuments({ bizType: 'recharge' })).toBe(1);
  });

  it('R1：ledger 已落账但钱包更新前崩溃 —— 重放补做且恰好一次', async () => {
    const account = await seedAccount(1000);
    const checks = new CreditCheckService();
    const payments = new PaymentService(checks);
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 300,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r-crash' },
    })).preCheck!;

    // 模拟崩溃窗口：charge 的 ledger 行已写入（幂等键 crash-key），但钱包 $inc 未执行。
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'charge',
      deltaBalance: -300,
      deltaFrozen: 0,
      allocations: [{ pool: 'cash', amount: 300 }],
      idempotentKey: 'crash-key',
      bizId: 'crash-biz',
    });
    expect((await accountService.getById(account.id))!.cashBalance).toBe(1000);

    // 重放：命中幂等键，但水位未记录 → 补做钱包更新（恰好一次）。
    const replay = await payments.charge({
      accountId: account.id,
      amountCents: 300,
      idempotentKey: 'crash-key',
      bizId: 'crash-biz',
      preCheck,
      ref: { type: 'model_call', id: 'r-crash' },
    });
    expect(replay.applied).toBe(true);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(700);

    // 再次重放：水位已记录 → 不重复扣。
    const again = await payments.charge({
      accountId: account.id,
      amountCents: 300,
      idempotentKey: 'crash-key',
      bizId: 'crash-biz',
      preCheck,
      ref: { type: 'model_call', id: 'r-crash' },
    });
    expect(again.applied).toBe(false);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(700);
  });

  it('R1：对账校准后，已计入的 ledger 行重放不会二次扣减', async () => {
    const account = await seedAccount(1000);
    // 造一个未登记水位的 charge 行 + 人为把钱包改成 ledger 真值（模拟对账已校准）。
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'charge',
      deltaBalance: -250,
      deltaFrozen: 0,
      allocations: [{ pool: 'cash', amount: 250 }],
      idempotentKey: 'recon-key',
      bizId: 'recon-biz',
    });
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 750 } });

    // 对账无漂移（750 == 1000-250），但仍应把最近 ledger 行登记进水位。
    await accountService.reconcileAccount(account.id);

    const checks = new CreditCheckService();
    const payments = new PaymentService(checks);
    const preCheck = (await checks.check({
      accountId: account.id,
      estimatedCredits: 250,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r-recon' },
    })).preCheck!;

    const replay = await payments.charge({
      accountId: account.id,
      amountCents: 250,
      idempotentKey: 'recon-key',
      bizId: 'recon-biz',
      preCheck,
      ref: { type: 'model_call', id: 'r-recon' },
    });
    expect(replay.applied).toBe(false);
    expect((await accountService.getById(account.id))!.cashBalance).toBe(750);
  });
});
