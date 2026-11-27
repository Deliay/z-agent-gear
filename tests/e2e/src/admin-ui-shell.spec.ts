import { test, expect } from '@playwright/test';
import { ADMIN_WEB_URL, adminLoginViaUI } from './helpers.js';

test.describe('Admin UI Shell E2E', () => {
  test('E2E-AUI-1: 四分组导航入口可达且当前页 aria-current 高亮', async ({ page }) => {
    await adminLoginViaUI(page);
    await expect(page).toHaveURL(/\/models/);

    for (const group of ['云资源管理', '模型与 Harness', '租户与计费', '系统安全']) {
      await expect(page.getByRole('heading', { name: group })).toBeVisible();
    }

    const entries: Array<[string, RegExp]> = [
      ['云端容器', /\/cloud-containers/],
      ['容器规格', /\/cloud-host-specs/],
      ['工作负载', /\/cloud-workloads/],
      ['基础镜像', /\/base-images/],
      ['模型配置', /\/models/],
      ['Harness 配置', /\/harness-configs/],
      ['租户管理', /\/tenants/],
      ['费用中心', /\/billing/],
      ['对账中心', /\/reconciliation/],
      ['登录认证', /\/auth-providers/],
      ['账号安全', /\/settings\/security/],
    ];

    for (const [name] of entries) {
      await expect(page.getByRole('link', { name })).toBeVisible();
    }

    await expect(page.getByRole('link', { name: '模型配置' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByRole('link', { name: '容器规格' }).click();
    await expect(page).toHaveURL(/\/cloud-host-specs/);
    await expect(page.getByRole('link', { name: '容器规格' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('E2E-AUI-2: 主题三态切换即时生效并刷新持久化', async ({ page }) => {
    await adminLoginViaUI(page);

    const toggle = page.getByRole('button', { name: /切换主题（当前：/ });
    await expect(toggle).toBeVisible();

    // 缺省 system（Playwright 默认亮色）→ light → dark
    await toggle.click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: '切换主题（当前：黑暗模式）' })).toBeVisible();

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: '切换主题（当前：黑暗模式）' })).toBeVisible();
  });

  test('E2E-AUI-3: 表格规范与危险操作二次确认（影响范围文案）', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.getByRole('link', { name: '容器规格' }).click();
    await expect(page).toHaveURL(/\/cloud-host-specs/);

    const table = page.locator('table').first();
    await expect(table).toBeVisible();
    const headRow = table.locator('thead tr').first();
    await expect(headRow).toHaveClass(/text-xs/);
    await expect(headRow).toHaveClass(/font-medium/);
    await expect(headRow).toHaveClass(/bg-muted\/40/);

    const firstCell = table.locator('tbody tr').first().locator('td').first();
    await expect(firstCell).toHaveClass(/py-2\.5/);
    await expect(firstCell).toHaveClass(/px-3/);

    await page.getByRole('button', { name: /^删除 / }).first().click();
    await expect(page.getByRole('heading', { name: '删除容器规格' })).toBeVisible();
    await expect(page.getByText(/此操作不可撤销/)).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('heading', { name: '删除容器规格' })).toHaveCount(0);
  });
});
