import { test, expect } from '@playwright/test';
import {
  ADMIN_WEB_URL,
  ADMIN_TEST_PASSWORD,
  DEFAULT_ADMIN_PASSWORD,
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  resetAdminToDefaultPassword,
} from './helpers.js';

test.describe('Admin Auth E2E', () => {
  test('should redirect unauthenticated visitors to /login (T-F3)', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/models`);
    await expect(page).toHaveURL(/\/login/);
  });

  test('should not offer any registration entry on the login page (T-F7)', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByText('注册')).toHaveCount(0);
  });

  test('T-E1: default-password login forces password change, then enters the console', async ({ page }) => {
    const supported = await resetAdminToDefaultPassword();
    test.skip(!supported, 'requires MONGODB_URI to reset the seeded admin');

    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.fill('#username', 'admin');
    await page.fill('#password', DEFAULT_ADMIN_PASSWORD);
    await page.click('button[type="submit"]');

    // 强制进入改密页，且改密页无侧边栏
    await expect(page).toHaveURL(/\/change-password/, { timeout: 10000 });
    await expect(page.getByText('修改密码')).toBeVisible();
    await expect(page.getByRole('link', { name: /模型配置/ })).toHaveCount(0);

    await page.fill('#old-password', DEFAULT_ADMIN_PASSWORD);
    await page.fill('#new-password', ADMIN_TEST_PASSWORD);
    await page.fill('#confirm-password', ADMIN_TEST_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/models/);
    await expect(page.getByRole('link', { name: /模型配置/ })).toBeVisible();
  });

  test('should login and land on model config', async ({ page }) => {
    await adminLoginViaUI(page);
    await expect(page).toHaveURL(/\/models/);
    await expect(page.getByRole('link', { name: /模型配置/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /基础镜像/ })).toBeVisible();
  });

  test('should force a must-change-password session to the change password page (T-F4/T-E2)', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.evaluate(() => {
      localStorage.setItem('admin_token', 'dummy-token');
      localStorage.setItem('admin_user', JSON.stringify({ id: 'admin', username: 'admin', mustChangePassword: true }));
    });
    await page.goto(`${ADMIN_WEB_URL}/base-images`);
    await expect(page).toHaveURL(/\/change-password/);
    await page.evaluate(() => localStorage.clear());
  });

  test('should validate the change password form (T-F5)', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('admin_token', 'test-token');
      localStorage.setItem('admin_user', JSON.stringify({ id: 'admin', username: 'admin', mustChangePassword: true }));
    });
    await page.goto(`${ADMIN_WEB_URL}/change-password`);
    await page.fill('#old-password', 'whatever');
    await page.fill('#new-password', 'short');
    await page.fill('#confirm-password', 'short');
    await page.click('button[type="submit"]');
    await expect(page.getByRole('alert')).toContainText('至少');

    await page.fill('#new-password', 'longenoughpass');
    await page.fill('#confirm-password', 'differentpass');
    await page.click('button[type="submit"]');
    await expect(page.getByRole('alert')).toContainText('不一致');
  });

  test('T-F2: server address panel sets an address and rejects an unreachable one', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.getByRole('button', { name: '服务器地址' }).click();

    const input = page.locator('#admin-endpoint');
    await expect(input).toBeVisible();

    await input.fill('http://127.0.0.1:1');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText(/无法连接/)).toBeVisible({ timeout: 8000 });

    const stored = await page.evaluate(() => localStorage.getItem('zag:admin-api-base'));
    expect(stored).toBeNull();
  });

  test('should navigate via the sidebar and highlight the active module (T-E6)', async ({ page }) => {
    await adminLoginViaUI(page);

    const baseImages = page.getByRole('link', { name: /基础镜像/ });
    await baseImages.click();
    await expect(page).toHaveURL(/\/base-images/);
    await expect(baseImages).toHaveAttribute('aria-current', 'page');

    const models = page.getByRole('link', { name: /模型配置/ });
    await models.click();
    await expect(page).toHaveURL(/\/models/);
    await expect(models).toHaveAttribute('aria-current', 'page');
  });

  test('should logout and return to the login page (T-F6)', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.getByText('退出登录').click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('should invalidate the old password after a change (T-E3)', async ({ page }) => {
    const token = await adminLoginApi(page); // 归一化到 admin / ADMIN_TEST_PASSWORD
    const temp = 'TempRotatedPass123';

    const change = await adminGqlRequest(page, `
      mutation ChangeAdminPassword($oldPassword: String!, $newPassword: String!) {
        changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
          token admin { mustChangePassword }
        }
      }
    `, { oldPassword: ADMIN_TEST_PASSWORD, newPassword: temp }, token);
    const changed = await change.json();
    expect(changed.errors).toBeUndefined();

    const oldLogin = await adminGqlRequest(page, `
      mutation($username: String!, $password: String!) {
        adminLogin(username: $username, password: $password) { token }
      }
    `, { username: 'admin', password: ADMIN_TEST_PASSWORD });
    expect((await oldLogin.json()).errors).toBeDefined();

    const newLogin = await adminGqlRequest(page, `
      mutation($username: String!, $password: String!) {
        adminLogin(username: $username, password: $password) { token }
      }
    `, { username: 'admin', password: temp });
    expect((await newLogin.json()).errors).toBeUndefined();

    // 还原，避免影响后续用例
    await adminGqlRequest(page, `
      mutation($oldPassword: String!, $newPassword: String!) {
        changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
          token admin { mustChangePassword }
        }
      }
    `, { oldPassword: temp, newPassword: ADMIN_TEST_PASSWORD }, changed.data.changeAdminPassword.token);
  });
});
