import { test, expect } from '@playwright/test';
import { adminLoginViaUI } from './helpers.js';

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

  test('E2E-AUI-2: 主题三态（跟随系统/明亮/黑暗）即时生效并刷新持久化', async ({ page }) => {
    // 显式固定系统色板，避免依赖 Playwright 默认值
    await page.emulateMedia({ colorScheme: 'light' });
    await adminLoginViaUI(page);

    const html = page.locator('html');
    const toggle = page.getByRole('button', { name: /^切换主题（当前：/ });

    // 1) 缺省跟随系统（系统亮色）→ 非 dark
    await expect(toggle).toHaveAttribute('aria-label', '切换主题（当前：跟随系统）');
    await expect(html).not.toHaveClass(/dark/);

    // 2) system → light：显式明亮模式
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', '切换主题（当前：明亮模式）');
    await expect(html).not.toHaveClass(/dark/);

    // 3) light → dark：显式黑暗模式
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', '切换主题（当前：黑暗模式）');
    await expect(html).toHaveClass(/dark/);

    // 刷新后持久化保持 dark
    await page.reload();
    await expect(page.getByRole('button', { name: '切换主题（当前：黑暗模式）' })).toBeVisible();
    await expect(html).toHaveClass(/dark/);

    // 4) dark → system：系统暗色时跟随系统仍为 dark
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: '切换主题（当前：黑暗模式）' }).click();
    await expect(page.getByRole('button', { name: '切换主题（当前：跟随系统）' })).toBeVisible();
    await expect(html).toHaveClass(/dark/);

    // 5) 跟随系统时随系统色板实时切换
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveClass(/dark/);
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
