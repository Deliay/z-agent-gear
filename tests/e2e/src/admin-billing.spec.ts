import { test, expect } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  createFrontUser,
} from './helpers.js';

/**
 * 费用中心 E2E（后台）：账户/充值/账单/收据/汇总/模型定价。
 * 前台容器分钟计费与网关调用强依赖 K8s/供应商，放在独立环境跑（见 PR 说明）。
 * 多租户一期：BillingOwnerType 增 `tenant`（前台租户计费），`admin_user` 链路保持原样。
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

    // 选择账户后展示账单/收据/汇总；先按关键字过滤，避免累积测试账户导致分页
    await page.getByRole('textbox', { name: '按账户名 / 账户 ID 检索' }).fill('admin');
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

  // 多租户一期：ownerType 检索扩展 tenant（admin_user 原样保留），按租户充值入口可用。
  test('ownerType 支持 tenant 检索且可按租户充值', async ({ page }) => {
    const token = await adminLoginApi(page);
    // 经后台开户建立租户（开户即创建零余额 tenant 计费账户）
    const user = await createFrontUser(page, { prefix: 'bt' });

    const tenantRes = await adminGqlRequest(page, `
      query TenantAccount($keyword: String!) {
        adminBillingAccounts(keyword: $keyword, ownerType: tenant) {
          id ownerType ownerId ownerName availableBalance
        }
      }
    `, { keyword: user.username }, token);
    const tenantAccounts = (await tenantRes.json()).data.adminBillingAccounts as Array<{
      id: string; ownerType: string; ownerId: string; ownerName: string;
    }>;
    const tenantAccount = tenantAccounts.find((item) => item.ownerName === user.username);
    expect(tenantAccount, `tenant account for ${user.username} not found`).toBeTruthy();
    expect(tenantAccount!.ownerType).toBe('tenant');
    // 一期 tenantId == userId
    expect(tenantAccount!.ownerId).toBe(user.userId);

    // admin_user（后台账户）检索链路零回归
    const adminRes = await adminGqlRequest(page, `
      query AdminAccount { adminBillingAccounts(keyword: "admin", ownerType: admin_user) { id ownerType ownerName } }
    `, undefined, token);
    const adminAccounts = (await adminRes.json()).data.adminBillingAccounts as Array<{ ownerType: string }>;
    expect(adminAccounts.length).toBeGreaterThan(0);
    expect(adminAccounts.every((item) => item.ownerType === 'admin_user')).toBe(true);

    // UI：类型下拉含「租户」→ 选中 → 按租户检索 → 行内「充值」入口可用
    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /费用中心/ }).click();
    await expect(page.getByRole('heading', { name: '费用中心' })).toBeVisible();

    const typeFilter = page.getByLabel('账户类型');
    await expect(typeFilter).toBeVisible();
    // admin_user 原样保留 + tenant 新增（双 owner 并存）
    await expect(typeFilter.locator('option[value="tenant"]')).toHaveText(/租户/);
    await expect(typeFilter.locator('option[value="admin_user"]')).toHaveText(/后台/);
    await typeFilter.selectOption('tenant');

    await page.getByRole('textbox', { name: '按账户名 / 账户 ID 检索' }).fill(user.username);
    const row = page.getByRole('row', { name: new RegExp(user.username) }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.getByText('租户')).toBeVisible();
    await row.getByRole('button', { name: '充值' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
