import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';

test.describe('Session Mode Switch', () => {

  test('should show model switcher with current model when acp start result includes availableModels', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_model_${Date.now()}`,
          modes: [{ id: 'code', name: 'Code', description: 'Coding mode' }],
          currentModeId: 'code',
          availableModels: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
          currentModelId: 'gpt-4',
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-model-switcher', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    await expect(page.getByRole('button', { name: 'GPT-4' })).toBeVisible();

    disconnect();
  });

  test('should show mode switcher disabled while session is connecting', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      // Don't respond immediately — keep session in connecting state
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-connecting-switch', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    // Mode switcher should be visible but disabled (no modes yet while connecting)
    const modeBtn = page.locator('button[title="No modes available"]');
    await expect(modeBtn).toBeVisible({ timeout: 5000 });
    await expect(modeBtn).toBeDisabled();

    disconnect();
  });

  test('should show mode switcher enabled after resume to idling', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_idling_enabled_${Date.now()}`,
          modes: [{ id: 'code', name: 'Code', description: 'Coding mode' }],
          currentModeId: 'code',
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-idling-switch', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('Ended', { timeout: 5000 });

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

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Continuing...' })).toBeVisible({ timeout: 3000 });
    await resumePromise;
    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    const modeBtn = page.locator('button:has-text("Code")');
    await expect(modeBtn).toBeVisible();
    await expect(modeBtn).toBeEnabled();

    disconnect();
  });

  test('should open mode select dialog showing available modes', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_dialog_${Date.now()}`,
          modes: [
            { id: 'code', name: 'Code', description: 'Coding mode' },
            { id: 'architect', name: 'Architect', description: 'Architecture mode' },
          ],
          currentModeId: 'code',
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mode-dialog', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('Ended', { timeout: 5000 });

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

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Continuing...' })).toBeVisible({ timeout: 3000 });
    await resumePromise;
    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    const modeBtn = page.locator('button:has-text("Code")').first();
    await modeBtn.click();

    await expect(page.getByRole('heading', { name: 'Switch Mode' })).toBeVisible();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Architect', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Architecture mode')).toBeVisible();
    await expect(dialog.getByText('Code', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Coding mode')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByRole('heading', { name: 'Switch Mode' })).not.toBeVisible();

    disconnect();
  });

  test('should switch mode via dialog and close on selection', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_select_${Date.now()}`,
          modes: [
            { id: 'code', name: 'Code', description: 'Coding mode' },
            { id: 'architect', name: 'Architect', description: 'Architecture mode' },
          ],
          currentModeId: 'code',
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mode-select', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(statusBadge())).toHaveText('Ended', { timeout: 5000 });

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

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Continuing...' })).toBeVisible({ timeout: 3000 });
    await resumePromise;
    await expect(page.locator(statusBadge())).toHaveText('Idle', { timeout: 10000 });

    let setModeRequestId: string | null = null;
    const setModePromise = new Promise<void>((resolve) => {
      socket.on('acp:set-mode', (data: { requestId: string; sessionId: string; modeId: string }) => {
        setModeRequestId = data.requestId;
        socket.emit('acp:set-mode:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          modeId: data.modeId,
          success: true,
        });
        resolve();
      });
    });

    const modeBtn = page.locator('button:has-text("Code")').first();
    await modeBtn.click();

    await expect(page.getByRole('heading', { name: 'Switch Mode' })).toBeVisible();

    await page.getByText('Architect', { exact: true }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await setModePromise;

    await expect(page.getByRole('heading', { name: 'Switch Mode' })).not.toBeVisible({ timeout: 5000 });

    disconnect();
  });
});
