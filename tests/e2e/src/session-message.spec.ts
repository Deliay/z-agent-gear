import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';

test.describe('ACP Message Rendering', () => {
  test('should render text messages', async ({ page }) => {
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
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello from agent!' },
          },
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Hello from agent!')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should render tool_call with tool name from metadata', async ({ page }) => {
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
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'tool_call',
            title: 'read_file',
            toolCallId: `tc_${Date.now()}`,
          },
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Tool Call: read_file')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should render error messages with error styling', async ({ page }) => {
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
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Something went wrong' },
          },
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Something went wrong')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should render markdown code blocks in agent messages', async ({ page }) => {
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
      setTimeout(() => {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is code:\n\n```typescript\nconst x = 1;\n```' },
          },
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const sessionId = await createSession(page, controllerId, token);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('running', { timeout: 10000 });

    await expect(page.getByText('Here is code:')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('pre, code').first()).toBeVisible();
    disconnect();
  });
});
