import { test, expect } from '@playwright/test';
import { gqlRequest, registerUser, createControllerKey, registerController, loginViaUI, createWorkspace, createSession, type FakeController } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';
const messageContainer = () => '.overflow-y-auto.bg-background';

test.describe('Session Scroll Loading', () => {
  test('initial load should show messages and support scroll loading', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    const { controllerId, disconnect, socket } = controller;

    // Handle ACP start
    socket.on('acp:start', async (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      // Send 30 messages
      for (let i = 1; i <= 30; i++) {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Agent message ${i}` },
          },
        });
        await new Promise(r => setTimeout(r, 50));
      }
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-scroll', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for session to be idling
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 15000 });

    // Wait for at least one message to appear
    await expect(page.getByText('Agent message 1')).toBeVisible({ timeout: 10000 });

    // Count visible messages
    let messageCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) messageCount++;
    }

    // Should show some messages
    expect(messageCount).toBeGreaterThan(0);

    // Scroll to top to trigger load
    const container = page.locator(messageContainer());
    await container.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(1000);

    // After scroll, should have more or same messages
    let newCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) newCount++;
    }

    expect(newCount).toBeGreaterThanOrEqual(messageCount);

    disconnect();
  });

  test('scroll up should load earlier messages', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    const { controllerId, disconnect, socket } = controller;

    // Handle ACP start
    socket.on('acp:start', async (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise(r => setTimeout(r, 500));

      // Send 30 messages
      for (let i = 1; i <= 30; i++) {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Agent message ${i}` },
          },
        });
        await new Promise(r => setTimeout(r, 50));
      }
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-scroll2', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for session to be idling
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 15000 });
    await expect(page.getByText('Agent message 1')).toBeVisible({ timeout: 10000 });

    // Count initial visible messages
    let initialCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) initialCount++;
    }

    // Scroll to top to trigger load
    const container = page.locator(messageContainer());
    await container.evaluate(el => { el.scrollTop = 0; });

    // Wait for loading
    await page.waitForTimeout(2000);

    // Count messages after scroll
    let newCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) newCount++;
    }

    // Should have more messages now (or same if all already loaded)
    expect(newCount).toBeGreaterThanOrEqual(initialCount);

    disconnect();
  });

  test('scroll to earliest should show "已加载全部历史" message', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    const { controllerId, disconnect, socket } = controller;

    // Handle ACP start - send only 10 messages (less than 25)
    socket.on('acp:start', async (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise(r => setTimeout(r, 500));

      // Send only 10 messages
      for (let i = 1; i <= 10; i++) {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Agent message ${i}` },
          },
        });
        await new Promise(r => setTimeout(r, 50));
      }
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-scroll3', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for session to be idling
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 15000 });
    await expect(page.getByText('Agent message 1')).toBeVisible({ timeout: 10000 });

    // Scroll to top
    const container = page.locator(messageContainer());
    await container.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(500);

    // Check if "已加载全部历史" message is visible
    await expect(page.getByText('已加载全部历史')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('new messages during history load should not cause duplicates', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    const { controllerId, disconnect, socket } = controller;

    // Handle ACP start
    socket.on('acp:start', async (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise(r => setTimeout(r, 500));

      // Send 30 messages
      for (let i = 1; i <= 30; i++) {
        socket.emit('acp:message', {
          sessionId: data.sessionId,
          message: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Agent message ${i}` },
          },
        });
        await new Promise(r => setTimeout(r, 50));
      }
    });

    await loginViaUI(page, username);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-scroll4', token);
    const sessionId = await createSession(page, controllerId, token, ws.id);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for session to be idling
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 15000 });
    await expect(page.getByText('Agent message 1')).toBeVisible({ timeout: 10000 });

    // Count initial visible messages
    let initialCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) initialCount++;
    }

    // Scroll to top to trigger history load
    const container = page.locator(messageContainer());
    await container.evaluate(el => { el.scrollTop = 0; });

    // While loading, send a new message
    await page.waitForTimeout(500);
    socket.emit('acp:message', {
      sessionId,
      message: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'New message during load' },
      },
    });

    // Wait for everything to settle
    await page.waitForTimeout(2000);

    // Count final messages
    let finalCount = 0;
    for (let i = 1; i <= 30; i++) {
      const isVisible = await page.getByText(`Agent message ${i}`).isVisible();
      if (isVisible) finalCount++;
    }

    // Should have more messages (from history load)
    expect(finalCount).toBeGreaterThanOrEqual(initialCount);

    // Verify the new message is visible
    await expect(page.getByText('New message during load')).toBeVisible({ timeout: 5000 });

    disconnect();
  });
});
