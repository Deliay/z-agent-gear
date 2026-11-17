import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import {
  ADMIN_WEB_URL,
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  createFrontUser,
  loginViaUI,
  startMockLlmServer,
} from './helpers.js';

/**
 * #533 模型下发优化与云电脑配置实时下发 —— E2E-MCS1~3（计划 §6.3）。
 *
 * 覆盖面：
 * - 前台「可用模型」新增自定义模型携带最长上下文、上游同名模型去抖预填、编辑清空 → 未设置；
 * - 前台供应商保存成功 toast（单一文案来源），后台（admin-web）保存路径**无**该提醒；
 * - 非法上下文（0 / 负数 / 字母）行内错误 + 保存禁用 + 不落库。
 *
 * 造数：provider / model 一律按 `e2e-mcs-` 前缀自建自清（共享库里不触碰外部数据）；
 * 用户经后台开户（`helpers.createFrontUser`）。后台断言仅在 admin 侧（不跨 app 断言）。
 */

const GQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
/** 本套件创建数据的前缀（清理只按此前缀） */
const PROVIDER_PREFIX = 'e2e-mcs-';
/** `src/lib/model-config-notice.ts#MODEL_CONFIG_APPLIED_NOTICE` 的关键片段 */
const NOTICE_FRAGMENT = '部分 Harness 运行时不会重载模型配置';
/** ModelItem 行容器（与 settings-llm / admin-model-config 既有选择器一致） */
const MODEL_ROW = 'div.flex.items-center.gap-3.rounded-lg.border';
const CONTEXT_TESTID = 'model-context-length';
/** 上游清单带 context_length 的模型名（用于「同名模型预填」断言） */
const SYNCED_MODEL = 'e2e-mcs-synced-ctx';
const SYNCED_CONTEXT = 32000;

interface SimpleHttpServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * 上下文感知的 OpenAI 兼容 mock：`/v1/models` 返回带 `context_length` 的清单，
 * 使供应商同步模型与「新增自定义模型预填」两条链路都能拿到上游上下文。
 */
function startContextMockLlm(): Promise<SimpleHttpServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if ((url === '/v1/models' || url === '/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            {
              id: SYNCED_MODEL,
              object: 'model',
              created: 1715368187,
              owned_by: 'e2e',
              context_length: SYNCED_CONTEXT,
            },
          ],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function gqlRequest(
  page: Page,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return page.request.post(GQL_URL, { headers, data: { query, variables } });
}

async function createUserProvider(
  page: Page,
  token: string,
  name: string,
  endpoint: string,
): Promise<string> {
  const res = await gqlRequest(page, `
    mutation($input: ProviderInput!) {
      createProvider(input: $input) { id }
    }
  `, {
    input: {
      name,
      type: 'OpenAI',
      endpoint,
      credentialType: 'api_key',
      credentialValue: 'sk-e2e-fake-key',
    },
  }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.createProvider.id as string;
}

/** 只清理本套件前缀的前台（个人工作区）供应商；删除供应商连带其模型 */
async function cleanupUserProviders(page: Page, token: string, prefix: string) {
  const res = await gqlRequest(page, `query { providers { id name } }`, undefined, token);
  const body = await res.json();
  const ids: string[] = (body.data?.providers ?? [])
    .filter((provider: { id: string; name: string }) => provider.name.startsWith(prefix))
    .map((provider: { id: string }) => provider.id);
  for (const id of ids) {
    await gqlRequest(page, `mutation($id: ID!) { deleteProvider(id: $id) }`, { id }, token);
  }
}

/** 只清理本套件前缀的后台全局供应商（避免删除人工创建的全局配置） */
async function cleanupGlobalProviders(page: Page, token: string, prefix: string) {
  const res = await adminGqlRequest(page, `query { adminProviders { id name } }`, undefined, token);
  const body = await res.json();
  const ids: string[] = (body.data?.adminProviders ?? [])
    .filter((provider: { id: string; name: string }) => provider.name.startsWith(prefix))
    .map((provider: { id: string }) => provider.id);
  if (ids.length > 0) {
    await adminGqlRequest(page, `
      mutation($ids: [ID!]!) {
        batchDeleteGlobalProviders(ids: $ids) { successCount }
      }
    `, { ids }, token);
  }
}

async function openSettingsPage(page: Page, username: string) {
  await loginViaUI(page, username);
  await page.click('a[href="/settings"]');
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 10000 });
}

test.describe('模型下发与上下文编辑 E2E（E2E-MCS）', () => {
  test('E2E-MCS1: 新增自定义模型携带最长上下文，编辑清空后展示未设置', async ({ page }) => {
    test.setTimeout(60000);
    const providerName = `${PROVIDER_PREFIX}ctx-${Date.now()}`;
    const customName = `e2e-mcs-custom-${Date.now()}`;
    let mock: SimpleHttpServer | undefined;
    let token: string | undefined;

    try {
      mock = await startContextMockLlm();
      const user = await createFrontUser(page, { prefix: 'mcs' });
      token = user.token;

      // 供应商经 API 预置（同源 mock 提供上游上下文元数据），UI 只驱动模型侧关键路径
      await createUserProvider(page, token, providerName, `http://127.0.0.1:${mock.port}/v1`);

      await openSettingsPage(page, user.username);
      const modelSection = page.locator('#model-section');
      await modelSection.getByRole('button', { name: '自定义模型' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '自定义模型' })).toBeVisible();
      // 个人工作区仅有本套件供应商：默认选中即本供应商
      await expect(dialog.getByText(providerName)).toBeVisible();

      const nameInput = dialog.locator('#custom-model-name');
      const contextInput = dialog.locator('#custom-model-context-length');

      // 输入上游同名模型 → 400ms 去抖后按清单预填上下文
      await nameInput.fill(SYNCED_MODEL);
      await expect(contextInput).toHaveValue(String(SYNCED_CONTEXT), { timeout: 10000 });

      // 改为自定义模型名并手填上下文（用户输入优先，不再被预填覆盖）
      await nameInput.fill(customName);
      await contextInput.fill('128000');
      await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 15000 });

      // 保存成功统一提醒（部分 Harness 不会重载模型配置）
      await expect(page.getByText(NOTICE_FRAGMENT).first()).toBeVisible();

      // 展开供应商组：同步模型带上游上下文，自定义模型带手填上下文
      const groupHeader = modelSection.getByRole('button', { name: new RegExp(providerName) });
      await expect(groupHeader).toBeVisible({ timeout: 10000 });
      await groupHeader.click();
      await expect(modelSection.getByText(SYNCED_MODEL, { exact: true })).toBeVisible();

      const syncedRow = modelSection.locator(MODEL_ROW).filter({ hasText: SYNCED_MODEL });
      await expect(syncedRow.getByTestId(CONTEXT_TESTID)).toContainText('32,000 tokens');

      const customRow = modelSection.locator(MODEL_ROW).filter({ hasText: customName });
      await expect(customRow.getByTestId(CONTEXT_TESTID)).toContainText('128,000 tokens');

      // 编辑上下文：清空 → 未设置
      await customRow.getByRole('button', { name: '编辑上下文' }).click();
      const editDialog = page.getByRole('dialog');
      await expect(editDialog.getByRole('heading', { name: '编辑模型' })).toBeVisible();
      await expect(editDialog.locator('#custom-model-context-length')).toHaveValue('128000');
      await editDialog.locator('#custom-model-context-length').fill('');
      await editDialog.getByRole('button', { name: '保存' }).click();
      await expect(editDialog).not.toBeVisible({ timeout: 15000 });

      await expect(customRow.getByTestId(CONTEXT_TESTID)).toContainText('未设置');
    } finally {
      if (token) await cleanupUserProviders(page, token, PROVIDER_PREFIX);
      await mock?.close();
    }
  });

  test('E2E-MCS2: 供应商保存成功提示运行中云电脑的重载提醒', async ({ page }) => {
    const providerName = `${PROVIDER_PREFIX}ui-${Date.now()}`;
    let mock: SimpleHttpServer | undefined;
    let token: string | undefined;

    try {
      mock = await startMockLlmServer();
      const user = await createFrontUser(page, { prefix: 'mcs' });
      token = user.token;

      await openSettingsPage(page, user.username);
      const providerSection = page.locator('#provider-section');
      await providerSection.getByRole('button', { name: '添加供应商' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '添加供应商' })).toBeVisible();
      await dialog.getByPlaceholder('例如: My OpenAI').fill(providerName);
      await dialog.getByPlaceholder('https://api.openai.com/v1').fill(`http://127.0.0.1:${mock.port}/v1`);
      await dialog.getByPlaceholder('sk-...').fill('sk-e2e-fake-key');
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 20000 });

      // 保存成功 = 同一文案（与自定义模型保存共用常量）
      await expect(page.getByText(NOTICE_FRAGMENT).first()).toBeVisible();
      await expect(providerSection.getByText(providerName)).toBeVisible();
    } finally {
      if (token) await cleanupUserProviders(page, token, PROVIDER_PREFIX);
      await mock?.close();
    }
  });

  test('E2E-MCS2b: 后台供应商保存不出现前台重载提醒', async ({ page }) => {
    test.skip(
      !process.env.ADMIN_WEB_URL,
      `需要 ADMIN_WEB_URL 指向 admin-web（当前回落到 ${ADMIN_WEB_URL}）以断言后台保存路径`,
    );
    test.setTimeout(60000);
    const providerName = `${PROVIDER_PREFIX}admin-${Date.now()}`;
    let mock: SimpleHttpServer | undefined;
    let adminToken: string | undefined;

    try {
      mock = await startMockLlmServer();
      adminToken = await adminLoginApi(page);

      await adminLoginViaUI(page);
      await expect(page.getByText('供应商设置')).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: '添加供应商' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '添加供应商' })).toBeVisible();
      await dialog.locator('#provider-name').fill(providerName);
      await dialog.locator('#provider-endpoint').fill(`http://127.0.0.1:${mock.port}/v1`);
      await dialog.locator('#provider-credential').fill('sk-e2e-fake-key');
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 20000 });

      // 保存确实生效
      await expect(page.getByText(providerName).first()).toBeVisible({ timeout: 10000 });
      // 后台保存路径不出现前台重载提醒（只在 admin 侧断言，不跨 app）
      await expect(page.getByText(NOTICE_FRAGMENT)).toHaveCount(0);
    } finally {
      if (adminToken) await cleanupGlobalProviders(page, adminToken, PROVIDER_PREFIX);
      await mock?.close();
    }
  });

  test('E2E-MCS3: 非法上下文行内报错、保存禁用且不落库', async ({ page }) => {
    const providerName = `${PROVIDER_PREFIX}invalid-${Date.now()}`;
    const customName = `e2e-mcs-invalid-${Date.now()}`;
    let mock: SimpleHttpServer | undefined;
    let token: string | undefined;

    try {
      mock = await startMockLlmServer();
      const user = await createFrontUser(page, { prefix: 'mcs' });
      token = user.token;

      await createUserProvider(page, token, providerName, `http://127.0.0.1:${mock.port}/v1`);

      await openSettingsPage(page, user.username);
      const modelSection = page.locator('#model-section');
      await modelSection.getByRole('button', { name: '自定义模型' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '自定义模型' })).toBeVisible();
      await dialog.locator('#custom-model-name').fill(customName);

      const contextInput = dialog.locator('#custom-model-context-length');
      const saveButton = dialog.getByRole('button', { name: '保存' });
      const inlineError = dialog.getByText('请输入正整数');

      for (const invalid of ['0', '-5', 'abc']) {
        await contextInput.fill(invalid);
        await expect(inlineError).toBeVisible();
        await expect(saveButton).toBeDisabled();
      }

      // 合法值后恢复可保存（校验非死锁）
      await contextInput.fill('1024');
      await expect(inlineError).toHaveCount(0);
      await expect(saveButton).toBeEnabled();

      // 回到非法值 → 取消：列表与后端均无该模型
      await contextInput.fill('abc');
      await expect(saveButton).toBeDisabled();
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).not.toBeVisible();

      await expect(modelSection.getByText(customName, { exact: true })).toHaveCount(0);
      const res = await gqlRequest(page, `query { models { name } }`, undefined, token);
      const models = ((await res.json()).data?.models ?? []) as Array<{ name: string }>;
      expect(models.map((model) => model.name)).not.toContain(customName);
    } finally {
      if (token) await cleanupUserProviders(page, token, PROVIDER_PREFIX);
      await mock?.close();
    }
  });
});
