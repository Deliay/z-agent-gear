import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI } from './helpers.js';

/**
 * 设置页「自定义工具」区块 E2E（需求 #449，计划矩阵 E2E-CT1/CT2 的 UI 侧）。
 *
 * 走真实后端（agent-api GraphQL + customtools 集合）：
 * - 区块结构（标题 + 「工作区」badge）、空态、新增/编辑/删除全链路；
 * - prompt：参数列表 + Fragment 编辑器（$ 引用参数）保存后原样回显（round-trip）；
 * - http：GET 类隐藏 body、POST 类默认 JSON、form file 禁用；
 * - MCP 动态目录与 tools/call 的 wire 级行为由 agent-api 单测覆盖（custom-tools-mcp / custom-tool-http）。
 */

async function openSettings(page: Page): Promise<void> {
  const { username } = await registerUser(page);
  await loginViaUI(page, username);
  await page.goto('/settings');
  await expect(page.locator('#custom-tool-section')).toBeVisible({ timeout: 20000 });
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

test.describe('Settings Custom Tool E2E', () => {
  test('E2E-CT1: 区块结构 + 新增 prompt 工具（参数 + $ 引用）→ 列表 → 删除', async ({ page }) => {
    await openSettings(page);
    const section = page.locator('#custom-tool-section');

    await expect(section.getByRole('heading', { name: '自定义工具' })).toBeVisible();
    await expect(section.getByText('工作区', { exact: true })).toBeVisible();
    await expect(section.getByText('暂无自定义工具')).toBeVisible();

    const nav = page.locator('nav[aria-label="设置导航"]');
    await expect(nav.getByText('自定义工具', { exact: true })).toBeVisible();

    const suffix = uniqueSuffix();
    const name = `e2e-tool-${suffix}`;

    await section.getByRole('button', { name: '新增自定义工具' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '新增自定义工具' })).toBeVisible();
    await expect(
      dialog.getByText('这个工具会要求 AI 输入参数列表中的参数，并将提示词的内容进行模板替换'),
    ).toBeVisible();

    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '添加参数' }).click();
    await dialog.getByLabel('参数标识 1').fill('city');
    await dialog.getByLabel('参数名称 1').fill('目标城市');

    // 提示词：plain 文本 + $ 补全插入参数 chip
    const prompt = dialog.getByRole('textbox', { name: '提示词模板' });
    await prompt.click();
    await prompt.fill('https://foo.bar/');
    await prompt.press('End');
    await prompt.type('$');
    await expect(dialog.getByRole('listbox', { name: '参数' })).toBeVisible();
    await dialog.getByRole('option', { name: /\$city/ }).click();
    await expect(prompt.locator('[data-fragment-type="Parameter"]')).toHaveCount(1);

    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('自定义工具已创建')).toBeVisible({ timeout: 15000 });

    const row = section.locator('li').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText('Prompt', { exact: true })).toBeVisible();

    // 编辑：参数与模板 round-trip 回显（chip 仍在，不求值）
    await section.getByRole('button', { name: `编辑 ${name}` }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByLabel('名称', { exact: true })).toHaveValue(name);
    await expect(editDialog.getByLabel('参数标识 1')).toHaveValue('city');
    await expect(editDialog.getByRole('textbox', { name: '提示词模板' })).toContainText('$city');
    await editDialog.getByRole('button', { name: '取消' }).click();

    // 删除二次确认
    await section.getByRole('button', { name: `删除 ${name}` }).click();
    await expect(page.getByText(`确定删除「${name}」吗`)).toBeVisible();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByText('自定义工具已删除')).toBeVisible({ timeout: 15000 });
    await expect(section.getByText('暂无自定义工具')).toBeVisible();
  });

  test('E2E-CT2: http 表单 —— GET 隐藏 body、POST 默认 JSON、form file 禁用', async ({ page }) => {
    await openSettings(page);
    const section = page.locator('#custom-tool-section');

    await section.getByRole('button', { name: '新增自定义工具' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill(`e2e-http-${uniqueSuffix()}`);
    await dialog.getByLabel('类型').selectOption('http');

    await expect(dialog.getByLabel('Method')).toBeVisible();
    await expect(dialog.getByLabel('Body')).toHaveCount(0);

    await dialog.getByLabel('Method').fill('POST');
    await expect(dialog.getByLabel('Body')).toHaveValue('json');

    await dialog.getByLabel('Body').selectOption('form');
    await dialog.getByRole('button', { name: '添加 Form 字段' }).click();
    const fileOption = dialog.getByLabel('Form 字段类型 1').locator('option[value="file"]');
    await expect(fileOption).toBeDisabled();
    await expect(fileOption).toContainText('本期不支持');

    await dialog.getByLabel('Method').fill('GET');
    await expect(dialog.getByLabel('Body')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
  });

  test('E2E-CT3: Valut 名单查询仅返回名称（无 value 出参与取值入口）', async ({ page, request }) => {
    const { token } = await registerUser(page);
    const baseURL = process.env.API_URL || 'http://localhost:10001/graphql';
    const res = await request.post(baseURL, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: {
        query: `query { valutManualOptions { key namespace namespaceDisplayName } }`,
      },
    });
    const payload = await res.json();
    expect(payload.errors).toBeUndefined();
    const options = payload.data.valutManualOptions as Array<Record<string, unknown>>;
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(['key', 'namespace', 'namespaceDisplayName']);
    }
    const text = JSON.stringify(payload);
    expect(text).not.toContain('valueEncrypted');
    expect(text).not.toMatch(/valut(Get|Value|Reveal)/i);
  });
});
