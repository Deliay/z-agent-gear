import { test, expect } from '@playwright/test';
import { ADMIN_WEB_URL, adminLoginViaUI } from './helpers.js';

/**
 * 容器规格管理页 E2E（E2E-SP1）：
 * - 列表展示预制规格（含「预制」徽章与白名单状态）；
 * - 新建/编辑/删除自定义规格；
 * - 「0C 0G」新建时白名单默认勾选；不勾选时租户选择器隐藏；
 * - 非法组合前端拦截（保存按钮禁用 + 提示）。
 */
test.describe('容器规格管理（admin-web）', () => {
  test('E2E-SP1: 预制列表、白名单默认勾选与 CRUD', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.goto(`${ADMIN_WEB_URL}/cloud-host-specs`);

    await expect(page.getByRole('heading', { name: '容器规格' })).toBeVisible();
    await expect(page.getByText('8C 16G 20G')).toBeVisible();
    await expect(page.getByText('0C 0G 0G')).toBeVisible();
    await expect(page.getByText('预制').first()).toBeVisible();

    const name = `e2e-spec-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: '新建规格' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // 新建「0C 0G」时白名单默认勾选
    await dialog.locator('#spec-name').fill(name);
    await dialog.locator('#spec-cpu').fill('0');
    await dialog.locator('#spec-memory').fill('0');
    await dialog.locator('#spec-ephemeral').fill('0');
    await expect(dialog.getByLabel('开启白名单')).toBeChecked();

    // 不勾选白名单 → 租户选择器隐藏；重新勾选 → 出现
    await dialog.getByLabel('开启白名单').uncheck();
    await expect(dialog.getByLabel('搜索租户')).toHaveCount(0);
    await dialog.getByLabel('开启白名单').check();
    await expect(dialog.getByLabel('搜索租户')).toBeVisible();

    // 部分为 0 的非法组合被拦截
    await dialog.locator('#spec-cpu').fill('0');
    await dialog.locator('#spec-memory').fill('4');
    await dialog.locator('#spec-ephemeral').fill('10');
    await expect(dialog.getByText('除「全 0（不限制）」外，三项都必须大于 0')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

    // 合法的 0C 0G（白名单开启、空名单）保存
    await dialog.locator('#spec-cpu').fill('0');
    await dialog.locator('#spec-memory').fill('0');
    await dialog.locator('#spec-ephemeral').fill('0');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(name)).toBeVisible({ timeout: 15000 });

    // 编辑为普通规格
    await page.getByRole('button', { name: `编辑 ${name}` }).click();
    const editDialog = page.getByRole('dialog');
    await editDialog.locator('#spec-name').fill(`${name}-v2`);
    await editDialog.locator('#spec-cpu').fill('2');
    await editDialog.locator('#spec-memory').fill('4');
    await editDialog.locator('#spec-ephemeral').fill('10');
    await editDialog.getByLabel('开启白名单').uncheck();
    await editDialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(`${name}-v2`)).toBeVisible({ timeout: 15000 });

    // 删除
    await page.getByRole('button', { name: `删除 ${name}-v2` }).click();
    const deleteDialog = page.getByRole('dialog');
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: /删除/ }).click();
    await expect(page.getByText(`${name}-v2`)).toHaveCount(0, { timeout: 15000 });
  });
});
