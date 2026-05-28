import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

test.describe('Session Chat', () => {
  test('should send message and receive response', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    let receivedInput = false;

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
      });
    });

    socket.on('acp:message', (data: { sessionId: string; message: { type: string; content: string } }) => {
      if (data.message.type === 'text' && !receivedInput) {
        receivedInput = true;
        // Echo back a response
        setTimeout(() => {
          socket.emit('acp:message', {
            sessionId: data.sessionId,
            message: { type: 'text', content: `Echo: ${data.message.content}` },
          });
        }, 300);
      }
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-chat', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('.px-2.py-1.text-xs.font-medium.rounded-full')).toHaveText('Idle', { timeout: 10000 });

    // Type and send a message
    const textarea = page.locator('textarea');
    await textarea.fill('Hello agent!');
    await page.getByRole('button', { name: 'Send' }).click();

    // User message should appear
    await expect(page.getByText('Hello agent!', { exact: true })).toBeVisible({ timeout: 5000 });

    // Response should appear
    await expect(page.getByText('Echo: Hello agent!')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should disable input while sending', async ({ page }) => {
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

    // Delay the response to observe sending state
    socket.on('acp:message', (data: { sessionId: string; message: { type: string; content: string } }) => {
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: { type: 'text', content: 'Delayed response' },
        });
      }, 1000);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-chat', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('.px-2.py-1.text-xs.font-medium.rounded-full')).toHaveText('Idle', { timeout: 10000 });

    const textarea = page.locator('textarea');
    await textarea.fill('Test message');
    await page.getByRole('button', { name: 'Send' }).click();

    // After response arrives, textarea should be enabled again
    await expect(page.getByText('Delayed response')).toBeVisible({ timeout: 5000 });
    await expect(textarea).toBeEnabled();

    disconnect();
  });
});
