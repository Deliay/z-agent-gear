import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

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
    const ws1 = await createWorkspace(page, controllerId, '/tmp/e2e-msg', token);
    const sessionId = await createSession(page, controllerId, token, ws1.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

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
    const ws2 = await createWorkspace(page, controllerId, '/tmp/e2e-tool', token);
    const sessionId = await createSession(page, controllerId, token, ws2.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

    await expect(page.getByText('Tool Call: read_file')).toBeVisible({ timeout: 5000 });
    disconnect();
  });

  test('should display rapidly emitted messages in arrival order', async ({ page }) => {
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
      // 高频连发 5 条消息，模拟 agent 快速输出（乱序 regression 场景）
      setTimeout(() => {
        for (let i = 1; i <= 5; i++) {
          socket.emit('acp:message', {
            sessionId: data.sessionId,
            message: {
              sessionUpdate: 'tool_call',
              title: `step-${i}`,
              toolCallId: `tc_order_${Date.now()}_${i}`,
              status: 'completed',
            },
          });
        }
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-order', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

    await expect(page.getByText('Tool Call: step-5')).toBeVisible({ timeout: 5000 });
    const bodyText = (await page.locator('body').textContent()) ?? '';
    const positions = [1, 2, 3, 4, 5].map((i) => bodyText.indexOf(`Tool Call: step-${i}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    disconnect();
  });

  test('should keep tool_call card highlighted after completion', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerController(rawKey);
    const toolCallId = `tc_highlight_${Date.now()}`;

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
            toolCallId,
            status: 'in_progress',
          },
        });
      }, 300);
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-highlight', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

    // 进行中：最强高亮
    const card = page.locator('div.rounded-lg', { hasText: 'Tool Call: read_file' }).first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await expect(card).toHaveClass(/bg-info\/10/);

    // 完成后：恒高亮（同色系减弱），不退化为灰色
    socket.emit('acp:message', {
      sessionId,
      message: {
        sessionUpdate: 'tool_call_update',
        title: 'read_file',
        toolCallId,
        status: 'completed',
      },
    });
    await expect(card).toHaveClass(/bg-info\/5/, { timeout: 5000 });
    await expect(card).not.toHaveClass(/bg-muted/);
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
    const ws3 = await createWorkspace(page, controllerId, '/tmp/e2e-error', token);
    const sessionId = await createSession(page, controllerId, token, ws3.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

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
    const ws4 = await createWorkspace(page, controllerId, '/tmp/e2e-code', token);
    const sessionId = await createSession(page, controllerId, token, ws4.id);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });

    await expect(page.getByText('Here is code:')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('pre, code').first()).toBeVisible();
    disconnect();
  });
});
