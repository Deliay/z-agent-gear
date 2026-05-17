import { test, expect } from '@playwright/test';

const TEST_USER = `ce2e${Date.now()}`.slice(0, 20);
const TEST_PASS = 'testpass123';

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('#username', TEST_USER);
  await page.fill('#password', TEST_PASS);
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

async function loginAndGoSettings(page: import('@playwright/test').Page) {
  await login(page);
  await page.click('a[href="/settings"]');
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
}

test.describe('Settings Controller E2E', () => {

  test('should register user and show controller section', async ({ page }) => {
    await page.goto('/register');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
  });

  test('should show controller management navigation', async ({ page }) => {
    await loginAndGoSettings(page);
    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByText('控制器', { exact: true })).toBeVisible();
    await expect(nav.getByRole('button', { name: '控制器管理' })).toBeVisible();
  });

  test('should show controller section with Key and Controller cards', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByRole('heading', { name: '控制器管理' })).toBeVisible();
    await expect(section.getByText('控制器 Key')).toBeVisible();
    await expect(section.getByText('控制器列表')).toBeVisible();
  });

  test('should show key card with generate button and empty state', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByRole('button', { name: '生成 Key' })).toBeVisible();
    await expect(section.getByText(/暂无 Key/)).toBeVisible();
  });

  test('should show controller card with empty state', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByText('暂无控制器连接')).toBeVisible();
  });

  test('should open generate key dialog', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '生成控制器 Key' })).toBeVisible();
    await expect(page.getByText('为你的控制器创建一个新的 Key')).toBeVisible();
  });

  test('should have disabled generate button when name is empty', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    const generateBtn = page.getByRole('dialog').getByRole('button', { name: '生成' });
    await expect(generateBtn).toBeDisabled();
  });

  test('should close generate key dialog on cancel', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should generate key and show raw key dialog', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await page.fill('#key-name', `tk${Date.now()}`);
    await page.getByRole('dialog').getByRole('button', { name: '生成' }).click();

    await expect(page.getByRole('heading', { name: 'Key 已生成' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('请立即复制保存')).toBeVisible();

    await page.getByRole('button', { name: '复制并关闭' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should show generated key in key list', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    const keyName = `lk${Date.now()}`;
    await page.fill('#key-name', keyName);
    await page.getByRole('dialog').getByRole('button', { name: '生成' }).click();

    await expect(page.getByRole('heading', { name: 'Key 已生成' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: '复制并关闭' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await expect(section.getByText(keyName)).toBeVisible({ timeout: 5000 });
    await expect(section.getByText('活跃').first()).toBeVisible();
    await expect(section.getByText('local').first()).toBeVisible();
  });

  test('should show revoke and rename buttons for active keys', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByText('活跃').first()).toBeVisible({ timeout: 5000 });
    await expect(section.getByRole('button', { name: '撤销' }).first()).toBeVisible();
    await expect(section.getByRole('button', { name: '重命名' }).first()).toBeVisible();
  });

  test('should scroll to controller section from navigation', async ({ page }) => {
    await loginAndGoSettings(page);

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '控制器管理' }).click();
    await expect(page.locator('#controller-section')).toBeVisible();
  });
});
