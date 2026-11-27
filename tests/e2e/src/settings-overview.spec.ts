import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI } from './helpers';

const sidebarSel = 'nav[aria-label="Sidebar"]';

interface GraphqlCall {
  operation: string;
  query: string;
}

/** 记录 /graphql 请求（operationName 从 postData 里粗提取 query 名） */
async function recordGraphqlCalls(page: Page): Promise<() => GraphqlCall[]> {
  const calls: GraphqlCall[] = [];
  await page.route('**/graphql', async (route) => {
    const post = route.request().postData() ?? '';
    try {
      const body = JSON.parse(post) as { query?: string };
      const query = body.query ?? '';
      const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
      calls.push({ operation, query });
    } catch {
      // 非 JSON（如预检）忽略
    }
    await route.continue();
  });
  return () => calls;
}

test.describe('设置页聚合（E2E-SET1）', () => {
  test('设置页打开仅 1 次 SETTINGS_OVERVIEW，各区块无独立只读查询', async ({ page }) => {
    test.setTimeout(60000);
    const { username } = await registerUser(page, { prefix: 'set' });
    await loginViaUI(page, username);
    await page.locator(sidebarSel).waitFor({ timeout: 15000 });

    const getCalls = await recordGraphqlCalls(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible({
      timeout: 15000,
    });
    // 等待 SETTINGS_OVERVIEW 完成 + 区块渲染
    await expect(page.getByText('MCP 管理').first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);

    const calls = getCalls();
    const settingsCalls = calls.filter((call) => call.operation === 'SettingsOverview');
    expect(settingsCalls).toHaveLength(1);

    // 区块级只读查询已移除（工作区/模型/控制器/commit/第三方登录等）
    for (const operation of [
      'GetProviders',
      'GetModels',
      'GetControllers',
      'GetControllerKeys',
      'GetMcpServers',
      'GetValutEntries',
      'GetCustomMcpServers',
      'GetCustomTools',
      'GetGithubAccounts',
      'GetGithubAppUrl',
      'GetMyExternalLogins',
      'AuthProviders',
      'CloudStorageCapabilities',
      'CloudStorages',
      'GetCommitSettings',
    ]) {
      expect(
        calls.some((call) => call.operation === operation),
        `不应再发起 ${operation}`,
      ).toBe(false);
    }

    // 请求总量 ≤3（1 次聚合 + 少量按需）；排除首页 15s 轮询噪声
    const nonHomeCalls = calls.filter((call) => call.operation !== 'HomeOverview');
    expect(nonHomeCalls.length).toBeLessThanOrEqual(3);

    // 区块内容完整（空态也可）
    expect(page.locator('#provider-section')).toBeVisible();
    expect(page.locator('#model-section')).toBeVisible();
    expect(page.locator('#controller-section')).toBeVisible();
    expect(page.locator('#workflow-section')).toBeVisible();
  });
});
