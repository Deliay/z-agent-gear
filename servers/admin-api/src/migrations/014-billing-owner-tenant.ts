import { BillingAccount } from '../models/billing-account.js';
import { BillingApiKey } from '../models/billing-api-key.js';

/**
 * 014-billing-owner-tenant：前台计费归属 `ownerType: front_user → tenant`。
 *
 * 口径（提案 §4.1 / 计划 F5）：
 * - **仅**改写 `front_user` 行；`admin_user` 行完全不动（后台计费链路零改动）。
 * - `ownerId` 不变（一期 personal 租户 id == userId），余额 / 流水 / 冻结 / `appliedLedgerIds` /
 *   `invoiceSeq` 等资金字段一律不动——**余额零改动即完成迁移**。
 * - `billingaccounts` 与 `billingapikeys` 同口径改写。
 *
 * 幂等：`updateMany({ownerType:'front_user'})` 重跑只补缺失（第二次 modifiedCount=0）。
 */
export const name = '014-billing-owner-tenant';

export async function run(): Promise<void> {
  const adminAccountsBefore = await BillingAccount.countDocuments({ ownerType: 'admin_user' });
  const frontAccountsBefore = await BillingAccount.countDocuments({ ownerType: 'front_user' });

  const accounts = await BillingAccount.updateMany(
    { ownerType: 'front_user' },
    { $set: { ownerType: 'tenant' } },
  );
  const apiKeys = await BillingApiKey.updateMany(
    { ownerType: 'front_user' },
    { $set: { ownerType: 'tenant' } },
  );

  // 防御性断言：admin_user 行数必须零变化（迁移只允许触及前台行）。
  const adminAccountsAfter = await BillingAccount.countDocuments({ ownerType: 'admin_user' });
  if (adminAccountsAfter !== adminAccountsBefore) {
    throw new Error(
      `[Migration 014] admin_user account count changed: ${adminAccountsBefore} -> ${adminAccountsAfter}`,
    );
  }

  console.log(
    `[Migration 014] billing ownerType front_user -> tenant: accounts ${accounts.modifiedCount ?? 0}/${frontAccountsBefore}, ` +
      `apiKeys ${apiKeys.modifiedCount ?? 0} (admin_user untouched: ${adminAccountsAfter})`,
  );
}
