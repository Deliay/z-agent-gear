import { test, expect } from '@playwright/test';
import {
  adminLoginViaUI,
  createFrontUser,
  loginViaUI,
} from './helpers';

/**
 * 后台 team 租户管理 E2E（计划 Phase 10 / E2E-TT）。
 *
 * 覆盖：后台 UI 创建团队租户 → 租户详情添加成员并指定角色 → 成员前台登录即见团队空间
 * （切换器出现团队租户分组；admin 角色可见工作区/成员管理入口）。
 *
 * 需要 admin-web / admin-api / agent-api 就绪；开户 helper 依赖 INTERNAL_API_TOKEN 或 MONGODB_URI。
 */

const sidebar = () => 'nav[aria-label="Sidebar"]';

test.describe('Admin Team Tenant E2E（E2E-TT）', () => {
  test('E2E-TT1 后台创建 team 租户 + 加成员，成员登录见团队空间', async ({ page }) => {
    const member = await createFrontUser(page, { prefix: 'ttm' });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    const teamName = `e2e-team-${suffix}`.slice(0, 60);

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /租户管理/ }).click();
    await expect(page).toHaveURL(/\/tenants/);

    // 创建团队租户
    await page.getByRole('button', { name: '创建团队租户' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await createDialog.locator('#team-tenant-name').fill(teamName);
    await createDialog.getByRole('button', { name: '确认创建' }).click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // 列表检索命中，类型为团队
    await page.getByRole('textbox', { name: '租户名称检索' }).fill(teamName);
    const row = page.locator('tbody tr').filter({ hasText: teamName }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText('团队');
    await row.click();
    await expect(page).toHaveURL(/\/tenants\/[^/]+$/);

    // 详情：自动开通全局工作区（只读视图）
    await expect(page.getByRole('heading', { name: teamName })).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作区（只读）' })).toBeVisible();
    await expect(page.getByText('全局工作区').first()).toBeVisible();

    // 添加成员并指定管理员角色
    await page.getByRole('button', { name: '添加成员' }).click();
    const memberDialog = page.getByRole('dialog');
    await expect(memberDialog).toBeVisible();
    await memberDialog.locator('#tenant-member-username').fill(member.username);
    await memberDialog.locator('#tenant-member-role').selectOption('admin');
    await memberDialog.getByRole('button', { name: '确认添加' }).click();
    await expect(memberDialog).toBeHidden({ timeout: 15000 });

    const memberRow = page.locator('tbody tr').filter({ hasText: member.username }).first();
    await expect(memberRow).toBeVisible({ timeout: 15000 });
    await expect(memberRow).toContainText('管理员');

    // 成员前台登录：切换器出现团队租户；admin 角色可见管理入口
    await loginViaUI(page, member.username);
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    // 切换器按租户分组：optgroup label 含团队名与角色，组内为团队工作区
    const teamGroup = page.locator(`#workspace-switcher-select optgroup[label*="${teamName}"]`);
    await expect(teamGroup).toHaveCount(1);
    expect(await teamGroup.getAttribute('label')).toContain('管理员');
    const teamOptions = await teamGroup.locator('option').allTextContents();
    expect(teamOptions.some((text) => text.includes('（全局）'))).toBe(true);

    const value = await teamGroup.locator('option').first().getAttribute('value');
    expect(value).toBeTruthy();
    await page.locator('#workspace-switcher-select').selectOption(value!);

    await expect(page.getByRole('link', { name: '工作区管理' })).toBeVisible();
    await expect(page.getByRole('link', { name: '租户成员' })).toBeVisible();
  });
});
