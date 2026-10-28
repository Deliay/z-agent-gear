import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../models/billing-account.js';
import { BillingApiKey } from '../models/billing-api-key.js';
import {
  connectTestDb,
  clearTestDb,
  disconnectTestDb,
} from '../services/billing/testing/mongo.js';
import * as migration from './014-billing-owner-tenant';

async function seedAccount(
  ownerType: 'front_user' | 'admin_user' | 'tenant',
  overrides: Record<string, unknown> = {},
) {
  return BillingAccount.create({
    ownerType,
    ownerId: new mongoose.Types.ObjectId().toString(),
    ownerName: `${ownerType}-owner`,
    cashBalance: 12345,
    giftBalance: 678,
    creditLimit: 5000,
    frozenAmount: 321,
    appliedLedgerIds: ['ledger-1', 'ledger-2'],
    invoiceSeq: 7,
    status: 'active',
    ...overrides,
  });
}

async function seedApiKey(ownerType: 'front_user' | 'admin_user' | 'tenant', ownerId: string) {
  return BillingApiKey.create({
    accountId: new mongoose.Types.ObjectId(),
    ownerType,
    ownerId,
    name: 'k',
    keyPrefix: `zag_sk_${Math.random().toString(16).slice(2, 11)}`,
    keyHash: 'h',
  });
}

describe('migration 014-billing-owner-tenant', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('014-billing-owner-tenant');
  });

  it('T-MIG14a: 仅 front_user 行改写为 tenant，admin_user 行零改动', async () => {
    const frontAccount = await seedAccount('front_user');
    const adminAccount = await seedAccount('admin_user');
    const frontKey = await seedApiKey('front_user', frontAccount.ownerId);
    const adminKey = await seedApiKey('admin_user', adminAccount.ownerId);

    await migration.run();

    expect(await BillingAccount.countDocuments({ ownerType: 'front_user' })).toBe(0);
    expect(await BillingAccount.countDocuments({ ownerType: 'tenant' })).toBe(1);
    expect(await BillingAccount.countDocuments({ ownerType: 'admin_user' })).toBe(1);
    expect((await BillingAccount.findById(frontAccount._id))?.ownerId).toBe(
      frontAccount.ownerId,
    );
    expect((await BillingAccount.findById(adminAccount._id))?.ownerType).toBe('admin_user');

    expect((await BillingApiKey.findById(frontKey._id))?.ownerType).toBe('tenant');
    expect((await BillingApiKey.findById(adminKey._id))?.ownerType).toBe('admin_user');
  });

  it('T-MIG14b: 金额/流水引用/序号字段零变化（admin_user 与迁移后 tenant 行）', async () => {
    const frontAccount = await seedAccount('front_user');
    const adminAccount = await seedAccount('admin_user', { cashBalance: -999, invoiceSeq: 42 });

    await migration.run();

    const migrated = await BillingAccount.findById(frontAccount._id).lean();
    expect(migrated).toMatchObject({
      ownerId: frontAccount.ownerId,
      ownerName: frontAccount.ownerName,
      cashBalance: frontAccount.cashBalance,
      giftBalance: frontAccount.giftBalance,
      creditLimit: frontAccount.creditLimit,
      frozenAmount: frontAccount.frozenAmount,
      appliedLedgerIds: frontAccount.appliedLedgerIds,
      invoiceSeq: frontAccount.invoiceSeq,
      status: frontAccount.status,
    });

    const admin = await BillingAccount.findById(adminAccount._id).lean();
    expect(admin).toMatchObject({
      ownerType: 'admin_user',
      cashBalance: -999,
      giftBalance: adminAccount.giftBalance,
      frozenAmount: adminAccount.frozenAmount,
      appliedLedgerIds: adminAccount.appliedLedgerIds,
      invoiceSeq: 42,
    });
  });

  it('T-MIG14c: 幂等重跑零变更（不重复改写、不新增文档）', async () => {
    await seedAccount('front_user');
    await seedAccount('admin_user');
    await seedApiKey('front_user', new mongoose.Types.ObjectId().toString());

    await migration.run();
    const accountsAfterFirst = await BillingAccount.countDocuments();
    const keysAfterFirst = await BillingApiKey.countDocuments();

    await migration.run();

    expect(await BillingAccount.countDocuments()).toBe(accountsAfterFirst);
    expect(await BillingApiKey.countDocuments()).toBe(keysAfterFirst);
    expect(await BillingAccount.countDocuments({ ownerType: 'front_user' })).toBe(0);
    expect(await BillingAccount.countDocuments({ ownerType: 'tenant' })).toBe(1);
    expect(await BillingAccount.countDocuments({ ownerType: 'admin_user' })).toBe(1);
  });
});
