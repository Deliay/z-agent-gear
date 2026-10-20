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

/**
 * 仅清理本套件创建的供应商（e2e-global-* / e2e-system-*），
 * 避免在共享开发库中误删人工创建的全局配置。
 */
async function cleanupProviders(page: Page, token: string) {
  const res = await adminGqlRequest(page, `query { adminProviders { id name } }`, undefined, token);
  const body = await res.json();
  const ids: string[] = (body.data?.adminProviders ?? [])
    .filter((p: { name: string }) =>
      p.name.startsWith(PROVIDER_PREFIX) || p.name.startsWith('e2e-system-'),
    )
    .map((p: { id: string }) => p.id);
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

async function createCustomModelViaApi(page: Page, token: string, providerId: string, name: string) {
  const res = await adminGqlRequest(page, `
    mutation($input: CustomModelInput!) {
      createGlobalCustomModel(input: $input) { id name }
    }
  `, { input: { providerId, name } }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.createGlobalCustomModel as { id: string; name: string };
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

    // 共享开发库可能存在人工创建的全局供应商：仅在无外部数据时断言空态，
    // 避免为了跑用例而删除非本套件的数据。
    const providersRes = await adminGqlRequest(page, `query { adminProviders { name } }`, undefined, token);
    const providers = (await providersRes.json()).data?.adminProviders ?? [];
    const hasExternalProviders = providers.some(
      (p: { name: string }) =>
        !p.name.startsWith(PROVIDER_PREFIX) && !p.name.startsWith('e2e-system-'),
    );

    await adminLoginViaUI(page);
    await expect(page.getByText('供应商设置')).toBeVisible();
    await expect(page.getByRole('heading', { name: '可用模型' })).toBeVisible();
    if (!hasExternalProviders) {
      await expect(page.getByText(/暂无供应商/)).toBeVisible();
      await expect(page.getByText(/暂无可用模型/)).toBeVisible();
    }
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
    try {
      await adminLoginViaUI(page);
      const modelSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: '可用模型' }),
      });

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
      await expect(modelSection.getByText('gpt-4o', { exact: true })).toHaveCount(0);
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
    } finally {
      await cleanupProviders(page, token);
    }
  });

  test('should import models via the dialog and show a collapsed group (T-E22/T-E23/T-E24/T-E25)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}import-${Date.now()}`;
    try {
      await createProviderViaApi(page, token, name, `http://127.0.0.1:${mock.port}/v1`);

      await adminLoginViaUI(page);
      await expect(page.getByText(name).first()).toBeVisible();
      const modelSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: '可用模型' }),
      });

      await page.getByRole('button', { name: '操作菜单' }).first().click();
      await page.getByRole('menuitem', { name: '导入模型' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('gpt-4o').first()).toBeVisible();

      await dialog.getByRole('checkbox', { name: '选择 gpt-4o', exact: true }).click();
      await dialog.getByRole('checkbox', { name: '选择 gpt-4o-mini', exact: true }).click();
      await dialog.getByRole('button', { name: /导入/ }).click();
      await expect(dialog.getByText(/成功导入 2 个模型/)).toBeVisible({ timeout: 15000 });
      await dialog.getByRole('button', { name: '关闭' }).click();

      // 分组默认折叠；展开后可见导入的模型
      const groupHeader = modelSection.getByRole('button', { name: new RegExp(name) });
      await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
      await expect(groupHeader).toContainText('2');
      await groupHeader.click();
      await expect(modelSection.getByText('gpt-4o', { exact: true }).first()).toBeVisible();
      await expect(modelSection.getByText('gpt-4o-mini', { exact: true }).first()).toBeVisible();

      // 再次打开：已导入项禁选（T-E23）
      await page.getByRole('button', { name: '操作菜单' }).first().click();
      await page.getByRole('menuitem', { name: '导入模型' }).click();
      const importedDialog = page.getByRole('dialog');
      const importedRow = importedDialog.locator('label').filter({ hasText: /^gpt-4o(?!-)/ });
      await expect(importedRow.getByText('已导入')).toBeVisible();
      await expect(importedRow.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
      await importedDialog.getByRole('button', { name: '关闭' }).click();

      // 删除导入模型（含影响说明）→ 列表/组计数即时刷新（T-E25）
      const modelRow = modelSection
        .locator('div.flex.items-center.gap-3.rounded-lg.border')
        .filter({ hasText: 'gpt-4o-mini' });
      await modelRow.getByTitle('删除模型').click();
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByText(/按该模型名调用将返回「模型不存在」/)).toBeVisible();
      await confirm.getByRole('button', { name: '删除' }).click();

      await expect(modelSection.getByText('gpt-4o-mini', { exact: true })).toHaveCount(0, { timeout: 10000 });
      await expect(groupHeader).toContainText('1');

      // 同名可重新导入（T-E25）
      await page.getByRole('button', { name: '操作菜单' }).first().click();
      await page.getByRole('menuitem', { name: '导入模型' }).click();
      const reimportDialog = page.getByRole('dialog');
      const miniRow = reimportDialog.locator('label').filter({ hasText: /^gpt-4o-mini/ });
      await expect(miniRow.getByText('已导入')).toHaveCount(0);
      await expect(miniRow.getByRole('checkbox')).not.toHaveAttribute('aria-disabled', 'true');
      await miniRow.getByRole('checkbox').click();
      await reimportDialog.getByRole('button', { name: /导入/ }).click();
      await expect(reimportDialog.getByText(/成功导入 1 个模型/)).toBeVisible({ timeout: 15000 });
      await reimportDialog.getByRole('button', { name: '关闭' }).click();

      await expect(modelSection.getByText('gpt-4o-mini', { exact: true }).first()).toBeVisible();
      await expect(groupHeader).toContainText('2');
    } finally {
      await cleanupProviders(page, token);
    }
  });

  test('should group models by provider with counts and collapse by default (T-E24)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const stamp = Date.now();
    const firstName = `${PROVIDER_PREFIX}group-a-${stamp}`;
    const secondName = `${PROVIDER_PREFIX}group-b-${stamp}`;
    const firstModel = `e2e-group-a-model-${stamp}`;
    const secondModel = `e2e-group-b-model-${stamp}`;

    try {
      const first = await createProviderViaApi(page, token, firstName, `http://127.0.0.1:${mock.port}/v1`);
      const second = await createProviderViaApi(page, token, secondName, `http://127.0.0.1:${mock.port}/v1`);
      await createCustomModelViaApi(page, token, first.id, firstModel);
      await createCustomModelViaApi(page, token, second.id, secondModel);

      await adminLoginViaUI(page);
      const modelSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: '可用模型' }),
      });

      const firstHeader = modelSection.getByRole('button', { name: new RegExp(firstName) });
      const secondHeader = modelSection.getByRole('button', { name: new RegExp(secondName) });
      await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
      await expect(secondHeader).toHaveAttribute('aria-expanded', 'false');
      await expect(firstHeader).toContainText('1');
      await expect(secondHeader).toContainText('1');
      // 折叠时组内模型均不可见（计价表等页面其他区域不在断言范围内）
      await expect(modelSection.getByText(firstModel, { exact: true })).toHaveCount(0);
      await expect(modelSection.getByText(secondModel, { exact: true })).toHaveCount(0);

      await firstHeader.click();
      await expect(modelSection.getByText(firstModel, { exact: true })).toBeVisible();
      await expect(modelSection.getByText(secondModel, { exact: true })).toHaveCount(0);

      await secondHeader.click();
      await expect(modelSection.getByText(secondModel, { exact: true })).toBeVisible();
    } finally {
      await cleanupProviders(page, token);
    }
  });

  test('should add and delete a global custom model via the UI (T-W3)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}custom-${Date.now()}`;
    const customName = `custom-${Date.now()}`;
    try {
      await createProviderViaApi(page, token, name, `http://127.0.0.1:${mock.port}/v1`);

      await adminLoginViaUI(page);
      const modelSection = page.locator('section').filter({
        has: page.getByRole('heading', { name: '可用模型' }),
      });
      await page.getByRole('button', { name: '自定义模型' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('#custom-model-name').fill(customName);
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10000 });

      // 展开供应商分组后可见自定义模型
      await modelSection.getByRole('button', { name: new RegExp(name) }).click();
      await expect(modelSection.getByText(customName).first()).toBeVisible();
      await expect(modelSection.getByText('自定义').first()).toBeVisible();

      // 删除模型（自绘二次确认对话框）
      const modelRow = modelSection
        .locator('div.flex.items-center.gap-3.rounded-lg.border')
        .filter({ hasText: customName });
      await modelRow.getByTitle('删除模型').click();
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByRole('heading', { name: '删除模型' })).toBeVisible();
      await confirm.getByRole('button', { name: '删除' }).click();
      await expect(modelSection.getByText(customName)).toHaveCount(0, { timeout: 10000 });
    } finally {
      await cleanupProviders(page, token);
    }
  });

  test('should block duplicate custom model names (T-E26)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const name = `${PROVIDER_PREFIX}dup-${Date.now()}`;
    try {
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
    } finally {
      await cleanupProviders(page, token);
    }
  });

  test('T-E23: flags a model already imported by another provider as 已存在 and disables it', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupProviders(page, token);

    const first = `${PROVIDER_PREFIX}dup-a-${Date.now()}`;
    const second = `${PROVIDER_PREFIX}dup-b-${Date.now()}`;
    try {
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

      const row = dialog.locator('label').filter({ hasText: /^gpt-4o(?!-)/ });
      await expect(row.getByText('已存在')).toBeVisible();
      await expect(row.getByRole('checkbox', { name: '选择 gpt-4o', exact: true }))
        .toHaveAttribute('aria-disabled', 'true');

      await dialog.getByRole('button', { name: '关闭' }).click();
    } finally {
      await cleanupProviders(page, token);
    }
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
      await expect(page.getByRole('columnheader', { name: '整理时间' })).toBeVisible();
      await expect(page.getByText(/2026/)).toBeVisible();
    } finally {
      await db.collection('model_rename_records').deleteMany({ oldName });
    }
  });
});
