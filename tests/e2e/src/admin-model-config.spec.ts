import { test, expect, type Page } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  startMockLlmServer,
  type MockLlmServer,
} from './helpers.js';

const PROVIDER_PREFIX = 'e2e-global-';

async function cleanupProviders(page: Page, token: string) {
  const res = await adminGqlRequest(page, `query { adminProviders { id name } }`, undefined, token);
  const body = await res.json();
  const ids: string[] = (body.data?.adminProviders ?? []).map((p: { id: string }) => p.id);
  if (ids.length > 0) {
    await adminGqlRequest(page, `mutation($ids: [ID!]!) { batchDeleteGlobalProviders(ids: $ids) { successCount } }`, { ids }, token);
  }
}

async function createProviderViaApi(page: Page, token: string, name: string, endpoint: string) {
  const res = await adminGqlRequest(page, `
    mutation($input: ProviderInput!) {
      createGlobalProvider(input: $input) { id name scope }
    }
  `, {
    input: { name, type: 'OpenAI', endpoint, credentialType: 'api_key', credentialValue: 'sk-e2e-fake-key' },
  }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.createGlobalProvider as { id: string };
}

test.describe('Admin Model Config E2E', () => {
  let mock: MockLlmServer;

  test.beforeAll(async () => {
    mock = await startMockLlmServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test('should show provider and model sections with empty states (T-W5)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    await adminLoginViaUI(page);
    await expect(page.getByText('供应商设置')).toBeVisible();
    await expect(page.getByRole('heading', { name: '可用模型' })).toBeVisible();
    await expect(page.getByText(/暂无供应商/)).toBeVisible();
    await expect(page.getByText(/暂无可用模型/)).toBeVisible();
  });

  test('should disable save on an invalid provider form (T-W1)', async ({ page }) => {
    await adminLoginApi(page);
    await adminLoginViaUI(page);

    await page.getByRole('button', { name: '添加供应商' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should create a global provider via UI, sync models and cascade delete (T-E4/T-W1)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}ui-${Date.now()}`;
    await adminLoginViaUI(page);

    await page.getByRole('button', { name: '添加供应商' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#provider-name').fill(name);
    await dialog.locator('#provider-endpoint').fill(`http://127.0.0.1:${mock.port}/v1`);
    await dialog.locator('#provider-credential').fill('sk-e2e-fake-key');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15000 });

    // 供应商出现，且联动出现同步模型
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText('gpt-4o', { exact: true }).first()).toBeVisible();

    // 凭据脱敏展示
    await expect(page.getByText(/sk-\*\*\*\*/).first()).toBeVisible();

    // 删除（自绘二次确认对话框，见问题 39：统一 Dialog 替代 window.confirm）
    await page.getByRole('button', { name: '操作菜单' }).first().click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: '删除供应商' })).toBeVisible();
    await confirm.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText(name)).toHaveCount(0, { timeout: 10000 });
  });

  test('should add and delete a global custom model via the UI (T-W3)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}custom-${Date.now()}`;
    await createProviderViaApi(page, token, name, `http://127.0.0.1:${mock.port}/v1`);

    await adminLoginViaUI(page);
    await page.getByRole('button', { name: '自定义模型' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const customName = `custom-${Date.now()}`;
    await dialog.locator('#custom-model-name').fill(customName);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    await expect(page.getByText(customName).first()).toBeVisible();
    await expect(page.getByText('自定义').first()).toBeVisible();

    // 删除自定义模型（自绘二次确认对话框，见问题 39）
    await page.locator('div', { hasText: customName }).getByTitle('删除自定义模型').first().click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: '删除自定义模型' })).toBeVisible();
    await confirm.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText(customName)).toHaveCount(0, { timeout: 10000 });

    await cleanupProviders(page, token);
  });
});
