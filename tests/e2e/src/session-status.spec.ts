import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';

test.describe('Session Status Transitions', () => {
  test('should transition from creating to idling via SSE', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });
    });

    await loginViaUI(page, username);
    const ws1 = await createWorkspace(page, controllerId, '/tmp/e2e-status', token);
    const sessionId = await createSession(page, controllerId, token, ws1.id);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for initial status to appear (may be creating/connecting or already idling if SSE is fast)
    await expect(page.locator(statusBadge())).toBeVisible({ timeout: 5000 });
    const initialBadge = await page.locator(statusBadge()).first().textContent();
    // Allow for idling if session started quickly
    expect(['creating', 'connecting', 'idling']).toContain(initialBadge);

    // Input should be disabled only if still creating/connecting
    if (initialBadge !== 'idling') {
      await expect(page.locator('textarea')).toBeDisabled();
    }

    // Wait for status to become idling
    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

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
    const ws2 = await createWorkspace(page, controllerId, '/tmp/e2e-close', token);
    const sessionId = await createSession(page, controllerId, token, ws2.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 5000 });
    await expect(page.locator('textarea')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close' })).not.toBeVisible();

    disconnect();
  });
});

test.describe('Session Resume (Continue)', () => {
  test('should show Continue button on ended session', async ({ page }) => {
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
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-resume-show', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 5000 });

    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).not.toBeVisible();

    disconnect();
  });

  test('should resume session and transition to idling on success', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    // Handle acp:start immediately
    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_resume_${Date.now()}`,
      });
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-resume-ok', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

    // Close session
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 5000 });

    // Listen for acp:resume
    const resumePromise = new Promise<void>((resolve) => {
      socket.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
        setTimeout(() => {
          socket.emit('acp:resume:result', {
            requestId: data.requestId,
            sessionId: data.sessionId,
            success: true,
          });
          resolve();
        }, 300);
      });
    });

    // Click Continue
    await page.getByRole('button', { name: 'Continue' }).click();

    // Wait for button to show loading state
    await expect(page.getByRole('button', { name: 'Continuing...' })).toBeVisible({ timeout: 3000 });

    // Wait for acp:resume response and status update
    await resumePromise;

    // Should transition to idling
    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

    // Input should be enabled
    await expect(page.locator('textarea')).toBeEnabled();

    // Continue button should disappear, Close should reappear
    await expect(page.getByRole('button', { name: 'Continue' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

    disconnect();
  });

  test('should stay ended when resume fails', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_fail_${Date.now()}`,
      });
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-resume-fail', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('idling', { timeout: 10000 });

    // Close session
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 5000 });

    // Listen for acp:resume and respond with failure
    const resumePromise = new Promise<void>((resolve) => {
      socket.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
        setTimeout(() => {
          socket.emit('acp:resume:result', {
            requestId: data.requestId,
            sessionId: data.sessionId,
            success: false,
            error: 'ACP_SESSION_EXPIRED',
          });
          resolve();
        }, 300);
      });
    });

    await page.getByRole('button', { name: 'Continue' }).click();
    await resumePromise;

    // Should remain ended
    await expect(page.locator(statusBadge())).toHaveText('ended', { timeout: 10000 });

    // Continue button should still be visible
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).not.toBeVisible();

    disconnect();
  });
});
