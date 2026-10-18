import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const TEST_PASS = 'testpass123';

async function gqlRequest(
  page: import('@playwright/test').Page,
  query: string,
  variables?: Record<string, unknown>,
) {
  return page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { query, variables },
  });
}

async function registerUser(page: import('@playwright/test').Page): Promise<string> {
  const username = `fb${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  await gqlRequest(
    page,
    `mutation Signup($u: String!, $p: String!) { signup(username: $u, password: $p) { token } }`,
    { u: username, p: TEST_PASS },
  );
  return username;
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', TEST_PASS);
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

/**
 * 前台「我的费用」E2E：余额/欠费提示、账单/收据/汇总、API Key 管理、无自助充值入口。
 * 充值由后台完成（admin-billing.spec.ts 覆盖）；容器分钟计费与网关调用需真实 K8s/供应商环境。
 */
test.describe('Frontend Billing E2E', () => {
  test('我的费用页可见账户与 API Key，且不存在自助充值入口', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.goto('/billing');

    await expect(page.getByRole('heading', { name: '我的费用' })).toBeVisible();
    await expect(page.getByText('仅支持后台充值')).toBeVisible();
    await expect(page.getByText('账单明细')).toBeVisible();
    await expect(page.getByText('消费汇总')).toBeVisible();
    await expect(page.getByRole('button', { name: '充值' })).toHaveCount(0);

    // 生成 API Key：完整 secret 仅显示一次
    await page.getByPlaceholder('Key 名称').fill(`e2e-key-${Date.now()}`);
    await page.getByRole('button', { name: '生成' }).click();
    await expect(page.getByText(/^zag_sk_/)).toBeVisible();
    await page.getByRole('button', { name: '我已保存' }).click();
    await expect(page.getByText(/^zag_sk_/)).toHaveCount(0);

    // 吊销需二次确认
    await page.getByRole('button', { name: '吊销' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '吊销' }).click();
    await expect(page.getByText('已吊销')).toBeVisible();
  });
});
