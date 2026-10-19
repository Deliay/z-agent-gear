import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { accountService } from './account-service.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('AccountService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('get-or-create 幂等，初始余额 0、账单序号从 0 起', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const first = await accountService.getOrCreate('front_user', ownerId, 'alice');
    const second = await accountService.getOrCreate('front_user', ownerId, 'alice');
    expect(second.id).toBe(first.id);
    expect(second.cashBalance).toBe(0);
    expect(second.invoiceSeq).toBe(0);
    expect(second.status).toBe('active');
    expect(await BillingAccount.countDocuments()).toBe(1);
  });

  it('list 支持 ownerType/keyword/分页', async () => {
    await accountService.getOrCreate('front_user', new mongoose.Types.ObjectId().toString(), 'alice');
    await accountService.getOrCreate('admin_user', new mongoose.Types.ObjectId().toString(), 'boss');
    const front = await accountService.list({ ownerType: 'front_user' });
    expect(front).toHaveLength(1);
    expect(front[0].ownerName).toBe('alice');

    const byKeyword = await accountService.list({ keyword: 'bos' });
    expect(byKeyword).toHaveLength(1);
    const page2 = await accountService.list({ page: 2, pageSize: 1 });
    expect(page2).toHaveLength(1);
  });

  it('授信/状态调整与非法值校验', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const account = await accountService.getOrCreate('admin_user', ownerId, 'boss');
    const limited = await accountService.setCreditLimit(account.id, 5000);
    expect(limited.creditLimit).toBe(5000);
    expect(limited.availableBalance).toBe(5000);
    await expect(accountService.setCreditLimit(account.id, -1)).rejects.toThrow();

    const frozen = await accountService.setStatus(account.id, 'frozen');
    expect(frozen.status).toBe('frozen');
    await expect(accountService.setStatus(account.id, 'bad')).rejects.toThrow();
    await expect(accountService.setStatus(new mongoose.Types.ObjectId().toString(), 'active')).rejects.toThrow();
  });

  it('欠费计时设置（不重置）与清零', async () => {
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'alice',
    );
    const at = new Date('2026-01-01T00:00:00Z');
    await accountService.markInsufficient(account.id, at);
    await accountService.markInsufficient(account.id, new Date('2026-01-02T00:00:00Z'));
    const marked = await accountService.getById(account.id);
    expect(marked?.insufficientSince?.toISOString()).toBe(at.toISOString());
    await accountService.clearInsufficient(account.id);
    expect((await accountService.getById(account.id))?.insufficientSince).toBeNull();
  });

  it('精确核算：无差异时不写 adjust；有差异以 ledger 为准', async () => {
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'alice',
    );
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'recharge',
      deltaBalance: 1000,
      idempotentKey: 'k1',
    });
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 1000 } });
    const clean = await accountService.reconcileAccount(account.id);
    expect(clean.error).toBeNull();

    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 1200 } });
    const drifted = await accountService.reconcileAccount(account.id);
    expect(drifted.error?.walletCash).toBe(1200);
    expect(drifted.account.cashBalance).toBe(1000);
    expect(await BillingLedger.countDocuments({ bizType: 'adjust' })).toBe(1);
  });

  it('前台账户显示名从 users 集合解析（username/email/name 回落）', async () => {
    const db = mongoose.connection.db!;
    const usernameUser = new mongoose.Types.ObjectId();
    const emailUser = new mongoose.Types.ObjectId();
    const nameUser = new mongoose.Types.ObjectId();
    const bareUser = new mongoose.Types.ObjectId();
    await db.collection('users').insertMany([
      { _id: usernameUser, username: 'bob' },
      { _id: emailUser, email: 'eve@example.com' },
      { _id: nameUser, name: 'Carol' },
      { _id: bareUser },
    ]);
    expect((await accountService.getOrCreate('front_user', String(usernameUser))).ownerName).toBe('bob');
    expect((await accountService.getOrCreate('front_user', String(emailUser))).ownerName).toBe(
      'eve@example.com',
    );
    expect((await accountService.getOrCreate('front_user', String(nameUser))).ownerName).toBe('Carol');
    expect((await accountService.getOrCreate('front_user', String(bareUser))).ownerName).toBe(
      String(bareUser),
    );
  });

  it('不存在/非法账户查询与核算', async () => {
    expect(await accountService.getById('invalid')).toBeNull();
    expect(await accountService.getById(new mongoose.Types.ObjectId().toHexString())).toBeNull();
    await expect(accountService.reconcileAccount('invalid')).rejects.toThrow();
    await expect(
      accountService.reconcileAccount(new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toThrow();
  });
});
