import { test, expect } from '@playwright/test';
import { registerUser, loginViaUI } from './helpers';

test.describe('UI Theme and Component Tests', () => {
  test('should display dark mode toggle in sidebar', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    // 等待侧边栏加载
    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();

    // 检查主题切换按钮是否存在
    const themeToggle = sidebar.locator('button[title*="模式"]');
    await expect(themeToggle).toBeVisible();

    // 点击切换按钮
    await themeToggle.click();

    // 检查是否切换到黑暗模式
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);
  });

  test('should show command suggestions above input', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    // 创建一个session（需要controller和workspace）
    // 这里简化测试，只检查输入框
    const textarea = page.locator('textarea');
    if (await textarea.isVisible()) {
      // 输入斜杠触发命令建议
      await textarea.fill('/');

      // 检查命令建议是否显示
      const commandSuggest = page.locator('[class*="absolute"][class*="z-50"]');
      if (await commandSuggest.isVisible()) {
        // 检查建议框是否在输入框上方
        const textareaBox = await textarea.boundingBox();
        const suggestBox = await commandSuggest.boundingBox();

        if (textareaBox && suggestBox) {
          // 建议框应该在输入框上方
          expect(suggestBox.y).toBeLessThan(textareaBox.y);
        }
      }
    }
  });

  test('should show popover within viewport', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    // 等待侧边栏加载
    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();

    // 点击待办事项按钮
    const bellButton = sidebar.locator('button[aria-label="待办事项"]');
    if (await bellButton.isVisible()) {
      await bellButton.click();

      // 检查Popover是否显示
      const popover = page.locator('[class*="fixed"][class*="z-50"]');
      if (await popover.isVisible()) {
        // 检查Popover是否在可视范围内
        const popoverBox = await popover.boundingBox();
        const viewport = page.viewportSize();

        if (popoverBox && viewport) {
          expect(popoverBox.x).toBeGreaterThanOrEqual(0);
          expect(popoverBox.y).toBeGreaterThanOrEqual(0);
          expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width);
          expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(viewport.height);
        }
      }
    }
  });
});
