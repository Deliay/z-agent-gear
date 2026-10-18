import { test, expect } from '@playwright/test';
import { adminGqlRequest, adminLoginApi, adminLoginViaUI } from './helpers.js';

/**
 * 费用中心 E2E（后台）：账户/充值/账单/收据/汇总/模型定价。
 * 前台容器分钟计费与网关调用强依赖 K8s/供应商，放在独立环境跑（见 PR 说明）。
 */
test.describe('Admin Billing E2E', () => {
  test('费用中心可进入，充值后账单与收据可见', async ({ page }) => {
    const token = await adminLoginApi(page);
    // 建 Key 确保当前管理员账户存在
    await adminGqlRequest(
      page,
      `mutation { createBillingApiKey(name: "e2e-billing") { apiKey { id } secret } }`,
      undefined,
      token,
    );
    const accountsRes = await adminGqlRequest(
      page,
      `query { adminBillingAccounts(keyword: "admin") { id ownerName } }`,
      undefined,
      token,
    );
    const accountsBody = await accountsRes.json();
    const accountId: string = accountsBody.data.adminBillingAccounts[0].id;

    const amount = 1;
    const rechargeRes = await adminGqlRequest(
      page,
      `mutation($id: ID!, $amount: Float!) {
        rechargeBillingAccount(accountId: $id, amount: $amount, note: "e2e") { id seq type amount }
      }`,
      { id: accountId, amount },
      token,
    );
    const rechargeBody = await rechargeRes.json();
    expect(rechargeBody.data.rechargeBillingAccount.type).toBe('recharge');

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /费用中心/ }).click();
    await expect(page).toHaveURL(/\/billing/);
    await expect(page.getByRole('heading', { name: '费用中心' })).toBeVisible();
    await expect(page.getByText('账户', { exact: true }).first()).toBeVisible();

    // 选择账户后展示账单/收据/汇总
    await page.getByRole('row', { name: /admin/ }).first().click();
    await expect(page.getByText('账单明细')).toBeVisible();
    await expect(page.getByText(/后台充值/).first()).toBeVisible();
    await expect(page.getByText('汇总（近 7 天）')).toBeVisible();
  });

  test('对账中心可进入并手动运行', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /对账中心/ }).click();
    await expect(page.getByRole('heading', { name: '对账中心' })).toBeVisible();
    await page.getByRole('button', { name: '运行全部对账' }).click();
    await expect(page.getByText(/资金对账|计量对账|资源对账/).first()).toBeVisible();
  });
});
