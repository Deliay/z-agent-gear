import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';

test.describe('Session Status Transitions', () => {
  test('should transition from creating to running via SSE', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_${Date.now()}`,
        });
      }, 500);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);

    // Initial state should be connecting or creating
    const initialBadge = await page.locator(statusBadge()).first().textContent();
    expect(['creating', 'connecting']).toContain(initialBadge);

    // Input should be disabled
    await expect(page.locator('textarea')).toBeDisabled();

    // Wait for status to become running
    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    // Input should be enabled
    await expect(page.locator('textarea')).toBeEnabled();

    disconnect();
  });

  test('should show ended status after closing session', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
      });
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 5000 });
    await expect(page.locator('textarea')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close' })).not.toBeVisible();

    disconnect();
  });
});
