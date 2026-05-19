import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession } from './helpers';

test.describe('ACP Message Rendering', () => {
  test('should render text messages', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: { type: 'text', content: 'Hello from agent!' },
        });
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('span.rounded-full')).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Hello from agent!')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should render tool_call with tool name from metadata', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: { type: 'tool_call', content: 'Reading file...', metadata: { toolName: 'read_file' } },
        });
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('span.rounded-full')).toHaveText('running', { timeout: 10000 });

    // Should show "Tool Call: read_file"
    await expect(page.getByText('Tool Call: read_file')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should render error messages with error styling', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: { type: 'error', content: 'Something went wrong' },
        });
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('span.rounded-full')).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Error')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toBeVisible();
    disconnect();
  });

  test('should render markdown code blocks in agent messages', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);

    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: { type: 'text', content: 'Here is code:\n\n```typescript\nconst x = 1;\n```' },
        });
        socket.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator('span.rounded-full')).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Here is code:')).toBeVisible({ timeout: 5000 });
    // Code block should be rendered with syntax highlighting
    await expect(page.locator('pre, code').first()).toBeVisible();
    disconnect();
  });
});
