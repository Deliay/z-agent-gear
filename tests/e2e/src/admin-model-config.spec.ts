import { test, expect, type Page } from '@playwright/test';
import mongoose from 'mongoose';
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

  test('should create a global provider without importing models and cascade delete (T-E21)', async ({ page }) => {
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

    // 供应商出现，但不再自动导入模型；toast 提示手动导入
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText('0 个模型').first()).toBeVisible();
    await expect(page.getByText('gpt-4o', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/请通过「导入模型」手动导入模型/)).toBeVisible();

    // 凭据脱敏展示
    await expect(page.getByText(/sk-\*\*\*\*/).first()).toBeVisible();

    // 删除（自绘二次确认对话框）
    await page.getByRole('button', { name: '操作菜单' }).first().click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: '删除供应商' })).toBeVisible();
    await confirm.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText(name)).toHaveCount(0, { timeout: 10000 });
  });

  test('should import models via the dialog and show a collapsed group (T-E22/T-E23/T-E24/T-E25)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}import-${Date.now()}`;
    await createProviderViaApi(page, token, name, `http://127.0.0.1:${mock.port}/v1`);

    await adminLoginViaUI(page);
    await expect(page.getByText(name).first()).toBeVisible();

    await page.getByRole('button', { name: '操作菜单' }).first().click();
    await page.getByRole('menuitem', { name: '导入模型' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('gpt-4o').first()).toBeVisible();

    await dialog.getByRole('checkbox', { name: '选择 gpt-4o' }).click();
    await dialog.getByRole('checkbox', { name: '选择 gpt-4o-mini' }).click();
    await dialog.getByRole('button', { name: /导入/ }).click();
    await expect(dialog.getByText(/成功导入 2 个模型/)).toBeVisible({ timeout: 15000 });
    await dialog.getByRole('button', { name: '关闭' }).click();

    // 分组默认折叠；展开后可见导入的模型
    const groupHeader = page.getByRole('button', { name: new RegExp(name) });
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
    await groupHeader.click();
    await expect(page.getByText('gpt-4o', { exact: true }).first()).toBeVisible();

    // 再次打开：已导入项禁选
    await page.getByRole('button', { name: '操作菜单' }).first().click();
    await page.getByRole('menuitem', { name: '导入模型' }).click();
    await expect(page.getByRole('dialog').getByText('已导入').first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();

    // 删除导入模型（含影响说明）
    await page.locator('div', { hasText: 'gpt-4o-mini' }).first().getByTitle('删除模型').click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/按该模型名调用将返回「模型不存在」/)).toBeVisible();
    await confirm.getByRole('button', { name: '删除' }).click();

    await cleanupProviders(page, token);
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

    // 展开供应商分组后可见自定义模型
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByText(customName).first()).toBeVisible();
    await expect(page.getByText('自定义').first()).toBeVisible();

    // 删除模型（自绘二次确认对话框）
    await page.locator('div', { hasText: customName }).getByTitle('删除模型').first().click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: '删除模型' })).toBeVisible();
    await confirm.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText(customName)).toHaveCount(0, { timeout: 10000 });

    await cleanupProviders(page, token);
  });

  test('should block duplicate custom model names (T-E26)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}dup-${Date.now()}`;
    const provider = await createProviderViaApi(page, token, name, `http://127.0.0.1:${mock.port}/v1`);

    const imported = await adminGqlRequest(page, `
      mutation($providerId: ID!, $names: [String!]!) {
        importGlobalModels(providerId: $providerId, names: $names) { id name }
      }
    `, { providerId: provider.id, names: ['gpt-4t'] }, token);
    expect((await imported.json()).errors).toBeUndefined();

    await adminLoginViaUI(page);
    await page.getByRole('button', { name: '自定义模型' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#custom-model-name').fill('gpt-4t');
    await expect(dialog.getByText('模型名已存在')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
    await dialog.getByRole('button', { name: '取消' }).click();

    await cleanupProviders(page, token);
  });

  test('T-E23: flags a model already imported by another provider as 已存在 and disables it', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const first = `${PROVIDER_PREFIX}dup-a-${Date.now()}`;
    const second = `${PROVIDER_PREFIX}dup-b-${Date.now()}`;
    const providerA = await createProviderViaApi(page, token, first, `http://127.0.0.1:${mock.port}/v1`);
    await page.waitForTimeout(50);
    await createProviderViaApi(page, token, second, `http://127.0.0.1:${mock.port}/v1`);

    const imported = await adminGqlRequest(page, `
      mutation($providerId: ID!, $names: [String!]!) {
        importGlobalModels(providerId: $providerId, names: $names) { id name }
      }
    `, { providerId: providerA.id, names: ['gpt-4o'] }, token);
    expect((await imported.json()).errors).toBeUndefined();

    await adminLoginViaUI(page);
    // 第二个供应商（列表按 createdAt desc，第一条是 second）
    await page.getByRole('button', { name: '操作菜单' }).first().click();
    await page.getByRole('menuitem', { name: '导入模型' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const row = dialog.locator('label', { hasText: 'gpt-4o' }).first();
    await expect(row.getByText('已存在')).toBeVisible();
    await expect(row.getByRole('checkbox', { name: '选择 gpt-4o' })).toHaveAttribute('aria-disabled', 'true');

    await dialog.getByRole('button', { name: '关闭' }).click();
    await cleanupProviders(page, token);
  });

  test('T-E27: shows the rename ledger rows and its empty state', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'requires MONGODB_URI for direct ledger setup');
    const uri = process.env.MONGODB_URI!;
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    const db = mongoose.connection.db!;

    const oldName = `e2e-old-${Date.now()}`;
    const newName = `e2e-new-${Date.now()}`;

    await adminLoginApi(page);
    await adminLoginViaUI(page);

    const before = await db.collection('model_rename_records').countDocuments({});
    if (before === 0) {
      // 空环境：展开后显示空态
      await page.getByRole('button', { name: /重名整理记录/ }).click();
      await expect(page.getByText('暂无重名整理记录')).toBeVisible();
      await page.getByRole('button', { name: /重名整理记录/ }).click();
    }

    await db.collection('model_rename_records').insertOne({
      modelId: new mongoose.Types.ObjectId(),
      providerId: new mongoose.Types.ObjectId(),
      providerName: 'E2E Provider',
      oldName,
      newName,
      batchId: '20261020-005',
      renamedAt: new Date('2026-10-20T08:00:00.000Z'),
    });

    try {
      await page.reload();
      await page.getByRole('button', { name: /重名整理记录/ }).click();
      await expect(page.getByText(oldName)).toBeVisible();
      await expect(page.getByText(newName)).toBeVisible();
      await expect(page.getByText('E2E Provider')).toBeVisible();
    } finally {
      await db.collection('model_rename_records').deleteMany({ oldName });
    }
  });
});
