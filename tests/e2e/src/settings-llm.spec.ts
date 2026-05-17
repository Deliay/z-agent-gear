import { test, expect } from '@playwright/test';

const TEST_USER = `llm_${Date.now()}`;
const TEST_PASS = 'testpass123';

test.describe('Settings LLM Provider & Model E2E', () => {

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/register');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should show model settings navigation and sections', async ({ page }) => {
    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByText('帐号')).toBeVisible();
    await expect(nav.getByText('模型设置')).toBeVisible();
    await expect(nav.getByText('供应商设置')).toBeVisible();
    await expect(nav.getByText('可用模型')).toBeVisible();

    await expect(page.locator('#provider-section')).toBeVisible();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should scroll to provider section when clicking nav item', async ({ page }) => {
    await page.locator('nav[aria-label="Settings navigation"]').getByText('供应商设置').click();
    await expect(page.locator('#provider-section')).toBeVisible();
  });

  test('should scroll to model section when clicking nav item', async ({ page }) => {
    await page.locator('nav[aria-label="Settings navigation"]').getByText('可用模型').click();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should show provider section with add button and empty state', async ({ page }) => {
    const section = page.locator('#provider-section');
    await expect(section.getByText('供应商设置')).toBeVisible();
    await expect(section.getByRole('button', { name: '添加供应商' })).toBeVisible();
    await expect(section.getByText(/暂无供应商/)).toBeVisible();
  });

  test('should open add provider dialog on button click', async ({ page }) => {
    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '添加供应商' })).toBeVisible();
    await expect(page.getByText('供应商名称')).toBeVisible();
    await expect(page.getByText('API 类型')).toBeVisible();
    await expect(page.getByText('接口地址')).toBeVisible();
    await expect(page.getByText('凭据类型')).toBeVisible();
    await expect(page.getByText('凭据值')).toBeVisible();
  });

  test('should show model section with custom model button and empty state', async ({ page }) => {
    const section = page.locator('#model-section');
    await expect(section.getByRole('heading', { name: '可用模型' })).toBeVisible();
    await expect(section.getByRole('button', { name: '自定义模型' })).toBeVisible();
    await expect(section.getByText(/暂无可用模型/)).toBeVisible();
  });

  test('should open custom model dialog on button click', async ({ page }) => {
    await page.locator('#model-section').getByRole('button', { name: '自定义模型' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '自定义模型' })).toBeVisible();
    await expect(page.getByText('请先添加供应商')).toBeVisible();
  });

  test('should show validation on empty provider form', async ({ page }) => {
    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    const saveBtn = page.getByRole('button', { name: '保存' });
    await expect(saveBtn).toBeDisabled();
  });

  test('should close add provider dialog on cancel', async ({ page }) => {
    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should close custom model dialog on cancel', async ({ page }) => {
    await page.locator('#model-section').getByText('自定义模型').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
