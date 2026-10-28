import { test, expect } from '@playwright/test';
import {
  FRONT_USER_PASSWORD,
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  createFrontUser,
} from './helpers';

/**
 * 多租户一期后台 E2E（计划 §6.3 E2E-MT2/MT3/MT5）。
 *
 * 前提：前台注册已硬关闭，前台账号只能由后台开户（admin-api `adminCreateFrontUser`
 * → agent-api `POST /internal/users`），登录后 `user { id name tenant }`。
 * 需要 admin-web / admin-api / agent-api 就绪（与既有 admin-*.spec.ts 同环境）。
 */
const FRONT_WEB_URL = process.env.BASE_URL || 'http://localhost:35273';

/** 页面内禁止出现的租户/用户写操作入口（租户为只读视图）。 */
const FORBIDDEN_ACTIONS = /^(编辑|删除|停用|禁用|新建租户|修改)$/;

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function createTenantViaAdminApi(page: import('@playwright/test').Page, prefix = 'mt'): Promise<string> {
  const token = await adminLoginApi(page);
  const username = `${prefix}${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await adminGqlRequest(page, `
    mutation AdminCreateFrontUser($username: String!, $password: String!) {
      adminCreateFrontUser(username: $username, password: $password) { id name username }
    }
  `, { username, password: FRONT_USER_PASSWORD }, token);
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  expect(body.data.adminCreateFrontUser.username).toBe(username);
  return username;
}

test.describe('Admin Tenant E2E', () => {

  // E2E-MT5：后台租户列表/详情只读（可见、无编辑/删除/停用入口）。
  test('E2E-MT5 tenant list and detail are read-only', async ({ page }) => {
    const username = await createTenantViaAdminApi(page);
    const token = await adminLoginApi(page);

    // 后台契约只读性：introspection 无租户写 mutation（开户是唯一写操作）
    const schemaRes = await adminGqlRequest(page, `
      query { __schema { mutationType { fields { name } } } }
    `, undefined, token);
    const schema = await schemaRes.json();
    const mutationNames: string[] | undefined = schema.data?.__schema?.mutationType?.fields?.map(
      (f: { name: string }) => f.name,
    );
    if (mutationNames) {
      expect(mutationNames).toContain('adminCreateFrontUser');
      expect(mutationNames.filter((name) => /Tenant/i.test(name))).toEqual([]);
    }

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /租户管理/ }).click();
    await expect(page).toHaveURL(/\/tenants/);

    // 列表：新开户租户可见，且列表页无任何写操作入口
    await page.getByRole('textbox', { name: '租户名称检索' }).fill(username);
    await expect(page.getByText(username).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: FORBIDDEN_ACTIONS })).toHaveCount(0);

    // 详情：成员用户列表（username 取自其 account），仍无编辑/删除/停用入口
    await page.getByText(username).first().click();
    await expect(page).toHaveURL(/\/tenants\/[^/]+/);
    await expect(page.getByText(username).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '成员', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: FORBIDDEN_ACTIONS })).toHaveCount(0);
    await expect(page.getByText(/删除租户|停用租户|编辑租户/)).toHaveCount(0);
  });

  // E2E-MT2：后台开户 → 新账户前台登录 → 侧边栏展示名（展示名 = user.name）。
  test('E2E-MT2 admin creates account then front user logs in', async ({ page }) => {
    const username = `mtu${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /租户管理/ }).click();
    await expect(page).toHaveURL(/\/tenants/);

    await page.getByRole('button', { name: /开户/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/用户名/).fill(username);
    await dialog.getByLabel(/密码/).fill(FRONT_USER_PASSWORD);
    await dialog.getByRole('button', { name: /确认开户|^开户$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15000 });

    // 开户后租户列表可见该同名个人专属租户
    await page.getByRole('textbox', { name: '租户名称检索' }).fill(username);
    await expect(page.getByText(username).first()).toBeVisible({ timeout: 10000 });

    // 前台登录：侧边栏展示名与同名租户上下文
    await page.goto(`${FRONT_WEB_URL}/login`);
    await page.fill('#username', username);
    await page.fill('#password', FRONT_USER_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 15000 });
    await expect(page.locator(sidebar()).getByText(username)).toBeVisible({ timeout: 10000 });
  });

  // E2E-MT3：后台按租户充值 → 前台「我的费用」余额可见（租户口径）。
  test('E2E-MT3 admin recharges tenant and front billing shows balance', async ({ page }) => {
    const username = await createTenantViaAdminApi(page, 'mtb');
    const token = await adminLoginApi(page);

    // 后台按租户检索计费账户（ownerType=tenant，ownerId=tenantId==userId）
    const accountsRes = await adminGqlRequest(page, `
      query TenantAccount($keyword: String!) {
        adminBillingAccounts(keyword: $keyword, ownerType: tenant) {
          id ownerType ownerId ownerName availableBalance
        }
      }
    `, { keyword: username }, token);
    const accounts = (await accountsRes.json()).data.adminBillingAccounts as Array<{
      id: string; ownerType: string; ownerId: string; ownerName: string; availableBalance: number;
    }>;
    const account = accounts.find((item) => item.ownerName === username);
    expect(account, `tenant billing account for ${username} not found`).toBeTruthy();
    expect(account!.ownerType).toBe('tenant');

    // 按租户充值（后台既有充值 mutation，绑定 tenant 计费账户）
    const amount = 12.34;
    const rechargeRes = await adminGqlRequest(page, `
      mutation Recharge($id: ID!, $amount: Float!) {
        rechargeBillingAccount(accountId: $id, amount: $amount, note: "e2e-mt3") { id seq type amount balanceAfter }
      }
    `, { id: account!.id, amount }, token);
    const rechargeBody = await rechargeRes.json();
    expect(rechargeBody.errors, JSON.stringify(rechargeBody.errors)).toBeUndefined();
    expect(rechargeBody.data.rechargeBillingAccount.type).toBe('recharge');
    expect(rechargeBody.data.rechargeBillingAccount.amount).toBe(amount);

    // 前台「我的费用」：可用余额与租户口径一致
    await page.goto(`${FRONT_WEB_URL}/login`);
    await page.fill('#username', username);
    await page.fill('#password', FRONT_USER_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 15000 });

    await page.goto(`${FRONT_WEB_URL}/billing`);
    await expect(page.getByRole('heading', { name: '我的费用' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('可用余额').first()).toBeVisible();
    await expect(page.getByText(amount.toFixed(2)).first()).toBeVisible({ timeout: 10000 });
    // 账单明细可见充值记录（租户口径）
    await expect(page.getByText('账单明细')).toBeVisible();
  });

  // E2E-MT4：跨租户隔离（A 建会话/工作区，B 登录不可见）。会话用 fake controller 前置成本较高，
  // 这里以「控制器 Key」的最小隔离面锚定：A 创建 controller key 后，B 的 `controllerKeys` 为空。
  test('E2E-MT4 tenant isolation for controller keys', async ({ page }) => {
    const userA = await createFrontUser(page);
    const userB = await createFrontUser(page);

    const created = await page.request.post(process.env.API_URL || 'http://localhost:10001/graphql', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userA.token}` },
      data: { query: 'mutation { createControllerKey(input: { name: "mt4-isolation", type: local }) { rawKey key { id } } }' },
    });
    const createdBody = await created.json();
    expect(createdBody.errors, JSON.stringify(createdBody.errors)).toBeUndefined();

    const listB = await page.request.post(process.env.API_URL || 'http://localhost:10001/graphql', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userB.token}` },
      data: { query: '{ controllerKeys { id name } }' },
    });
    const listBBody = await listB.json();
    expect(listBBody.errors, JSON.stringify(listBBody.errors)).toBeUndefined();
    expect(listBBody.data.controllerKeys).toEqual([]);
  });
});
