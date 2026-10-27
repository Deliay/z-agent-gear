import { test, expect } from '@playwright/test';
import { adminGqlRequest, adminLoginApi, createFrontUser, startMockLlmServer } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const TEST_PASS = 'testpass123';

async function gqlRequest(
  page: import('@playwright/test').Page,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return page.request.post(API_URL, {
    headers,
    data: { query, variables },
  });
}

// 前台注册已硬关闭：造用户统一走后台开户 + login（helpers.createFrontUser）。
async function registerUserWithToken(
  page: import('@playwright/test').Page,
): Promise<{ username: string; token: string }> {
  const { username, token } = await createFrontUser(page, { prefix: 'll' });
  return { username, token };
}

async function registerUser(page: import('@playwright/test').Page): Promise<string> {
  const { username } = await registerUserWithToken(page);
  return username;
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', TEST_PASS);
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

test.describe('Settings LLM Provider & Model E2E', () => {

  test('should show model settings navigation and sections', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByRole('button', { name: '帐号' })).toBeVisible();
    await expect(nav.getByText('模型设置')).toBeVisible();
    await expect(nav.getByRole('button', { name: '供应商设置' })).toBeVisible();
    await expect(nav.getByRole('button', { name: '可用模型' })).toBeVisible();

    await expect(page.locator('#provider-section')).toBeVisible();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should scroll to provider section when clicking nav item', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '供应商设置' }).click();
    await expect(page.locator('#provider-section')).toBeVisible();
  });

  test('should scroll to model section when clicking nav item', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '可用模型' }).click();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should show provider section with add button and empty state', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const section = page.locator('#provider-section');
    await expect(section.getByText('供应商设置')).toBeVisible();
    await expect(section.getByRole('button', { name: '添加供应商' })).toBeVisible();
    await expect(section.getByText(/暂无供应商/)).toBeVisible();
  });

  test('should open add provider dialog on button click', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '添加供应商' })).toBeVisible();
    await expect(page.getByText('供应商名称')).toBeVisible();
    await expect(page.getByText('API 类型')).toBeVisible();
    await expect(page.getByText('接口地址')).toBeVisible();
    await expect(page.getByText('凭据类型')).toBeVisible();
    await expect(page.getByText('凭据值')).toBeVisible();
  });

  test('should show model section with custom model button and empty state', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const section = page.locator('#model-section');
    await expect(section.getByRole('heading', { name: '可用模型' })).toBeVisible();
    await expect(section.getByRole('button', { name: '自定义模型' })).toBeVisible();
    await expect(section.getByText(/暂无可用模型/)).toBeVisible();
  });

  test('should open custom model dialog on button click', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#model-section').getByRole('button', { name: '自定义模型' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '自定义模型' })).toBeVisible();
    await expect(page.getByText('请先添加供应商')).toBeVisible();
  });

  test('should show validation on empty provider form', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    const saveBtn = page.getByRole('button', { name: '保存' });
    await expect(saveBtn).toBeDisabled();
  });

  test('should close add provider dialog on cancel', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should close custom model dialog on cancel', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#model-section').getByText('自定义模型').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('T-E28: shows a read-only 系统内置 group and an expandable user group', async ({ page }) => {
    const mock = await startMockLlmServer();
    const adminToken = await adminLoginApi(page);
    const providerName = `e2e-system-${Date.now()}`;
    const modelName = `e2e-system-model-${Date.now()}`;

    const created = await adminGqlRequest(page, `
      mutation($input: ProviderInput!) {
        createGlobalProvider(input: $input) { id }
      }
    `, {
      input: {
        name: providerName,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-e2e-fake-key',
      },
    }, adminToken);
    const providerId = (await created.json()).data.createGlobalProvider.id as string;

    const imported = await adminGqlRequest(page, `
      mutation($providerId: ID!, $names: [String!]!) {
        importGlobalModels(providerId: $providerId, names: $names) { id name }
      }
    `, { providerId, names: [modelName] }, adminToken);
    expect((await imported.json()).errors).toBeUndefined();

    const { username, token: userToken } = await registerUserWithToken(page);
    const userProviderName = `e2e-user-${Date.now()}`;
    const customName = `e2e-user-custom-${Date.now()}`;
    let userProviderId = '';

    try {
      const userCreated = await gqlRequest(page, `
        mutation($input: ProviderInput!) {
          createProvider(input: $input) { id }
        }
      `, {
        input: {
          name: userProviderName,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-e2e-fake-key',
        },
      }, userToken);
      userProviderId = (await userCreated.json()).data.createProvider.id as string;

      const custom = await gqlRequest(page, `
        mutation($input: CustomModelInput!) {
          createCustomModel(input: $input) { id name }
        }
      `, { input: { providerId: userProviderId, name: customName } }, userToken);
      expect((await custom.json()).errors).toBeUndefined();

      await loginViaUI(page, username);
      await page.click('a[href="/settings"]');
      const section = page.locator('#model-section');

      const systemHeader = section.getByRole('button', { name: /系统内置/ });
      await expect(systemHeader).toBeVisible();
      // 系统内置组默认折叠
      await expect(systemHeader).toHaveAttribute('aria-expanded', 'false');

      // 组头排首位（第一个带 aria-expanded 的按钮）
      const firstHeader = section.locator('button[aria-expanded]').first();
      await expect(firstHeader).toContainText('系统内置');

      await systemHeader.click();
      await expect(section.getByText(modelName, { exact: true }).first()).toBeVisible();
      // 前台不泄露后台供应商名
      await expect(section.getByText(providerName)).toHaveCount(0);
      // 只读：开关禁用但如实显示启用状态、系统内置条目无删除入口、无拖拽手柄
      const systemSwitch = section.getByRole('switch', { name: `启用 ${modelName}` });
      await expect(systemSwitch).toHaveAttribute('aria-disabled', 'true');
      await expect(systemSwitch).toHaveAttribute('aria-checked', 'true');
      // 精确到系统内置模型行，避免全 section 的 count=0 因未展开用户组而恒真（C-9）
      const systemRow = section
        .locator('div.flex.items-center.gap-3.rounded-lg.border')
        .filter({ hasText: modelName });
      await expect(systemRow.getByTitle('删除自定义模型')).toHaveCount(0);
      await expect(systemRow.getByLabel('拖动排序')).toHaveCount(0);

      // 用户供应商组默认可展开，自定义模型可删除
      const userHeader = section.getByRole('button', { name: new RegExp(userProviderName) });
      await expect(userHeader).toHaveAttribute('aria-expanded', 'false');
      await userHeader.click();
      await expect(section.getByText(customName, { exact: true })).toBeVisible();

      const customRow = section
        .locator('div.flex.items-center.gap-3.rounded-lg.border')
        .filter({ hasText: customName });
      page.once('dialog', (dialog) => dialog.accept());
      await customRow.getByTitle('删除自定义模型').click();
      await expect(section.getByText(customName, { exact: true })).toHaveCount(0, { timeout: 10000 });
    } finally {
      if (userProviderId) {
        await gqlRequest(page, `mutation($id: ID!) { deleteProvider(id: $id) }`, { id: userProviderId }, userToken);
      }
      await adminGqlRequest(page, `mutation($id: ID!) { deleteGlobalProvider(id: $id) }`, { id: providerId }, adminToken);
      await mock.close();
    }
  });
});
