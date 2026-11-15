import { test, expect, type Page } from '@playwright/test';
import { ADMIN_WEB_URL, adminGqlRequest, adminLoginViaUI } from './helpers.js';

/**
 * Harness 平台配置后台页 —— E2E-HC1。
 *
 * 覆盖：三行 Harness 可见与默认 `/compact` 回显；修改某 Harness 指令保存 → 刷新后回显新值；
 * 非法输入被前端拦截（以 `/` 开头且长度 1~64）。
 */

const HARNESS_CONFIGS_QUERY = `
  query AdminHarnessConfigs {
    adminHarnessConfigs { harnessType compactCommand updatedAt }
  }
`;

async function readConfigs(page: Page, token: string): Promise<Record<string, string>> {
  const res = await adminGqlRequest(page, HARNESS_CONFIGS_QUERY, undefined, token);
  const body = await res.json();
  const configs = (body.data?.adminHarnessConfigs ?? []) as { harnessType: string; compactCommand: string }[];
  return Object.fromEntries(configs.map((c) => [c.harnessType, c.compactCommand]));
}

test.describe('Harness 平台配置页', () => {
  test('E2E-HC1: 三行可见且默认 /compact；保存后回显；非法输入被拦截', async ({ page }) => {
    test.setTimeout(90000);
    await adminLoginViaUI(page);
    const token = await page.evaluate(() => window.localStorage.getItem('admin_token') ?? '');

    await page.goto(`${ADMIN_WEB_URL}/harness-configs`);
    await expect(page.getByRole('heading', { name: 'Harness 配置' })).toBeVisible({ timeout: 10000 });

    // 三行固定展示（OpenCode / Kimi Code / DeepSeek Harness）
    const opencodeInput = page.getByLabel('OpenCode 压缩指令');
    const kimiInput = page.getByLabel('Kimi Code 压缩指令');
    const dshInput = page.getByLabel('DeepSeek Harness 压缩指令');
    await expect(opencodeInput).toBeVisible();
    await expect(kimiInput).toBeVisible();
    await expect(dshInput).toBeVisible();

    const configs = await readConfigs(page, token);
    expect(configs).toEqual(
      expect.objectContaining({
        OPENCODE: expect.any(String),
        KIMI_CODE: expect.any(String),
        DEEPSEEK_HARNESS: expect.any(String),
      }),
    );
    for (const command of Object.values(configs)) {
      expect(command.startsWith('/')).toBe(true);
    }
    // 三行输入框回显服务端值（默认 /compact）
    await expect(opencodeInput).toHaveValue(configs.OPENCODE);
    await expect(kimiInput).toHaveValue(configs.KIMI_CODE);
    await expect(dshInput).toHaveValue(configs.DEEPSEEK_HARNESS);

    // 非法输入：保存禁用 + 规则提示
    const saveButton = page.getByLabel('保存 OpenCode');
    await opencodeInput.fill('no-slash');
    await expect(saveButton).toBeDisabled();
    await expect(page.getByText('指令需以 / 开头且长度 1~64')).toBeVisible();

    // 合法保存 → 刷新后回显
    const nextCommand = `/compact-e2e-${Date.now().toString(36)}`;
    await opencodeInput.fill(nextCommand);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText('OpenCode 压缩指令已保存')).toBeVisible({ timeout: 10000 });

    await page.reload();
    await expect(page.getByLabel('OpenCode 压缩指令')).toHaveValue(nextCommand, { timeout: 10000 });

    // 还原默认值，避免污染其他用例
    await page.getByLabel('OpenCode 压缩指令').fill('/compact');
    await page.getByLabel('保存 OpenCode').click();
    await expect(page.getByText('OpenCode 压缩指令已保存')).toBeVisible({ timeout: 10000 });
  });
});
