import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { gqlRequest, registerUser, createControllerKey, registerController, loginViaUI, createWorkspace, createSession } from './helpers';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function sendMessages(page: import('@playwright/test').Page, sessionId: string, token: string, count: number) {
  for (let i = 0; i < count; i++) {
    await gqlRequest(page, `
      mutation SendMessage($sessionId: ID!, $content: String!, $type: AcpMessageType) {
        sendSessionMessage(sessionId: $sessionId, content: $content, type: $type) { id }
      }
    `, { sessionId, content: `Message ${i + 1}`, type: 'text' }, token);
  }
}

async function getSessionMessages(page: import('@playwright/test').Page, sessionId: string, token: string, before?: string) {
  const variables: Record<string, unknown> = { sessionId, limit: 25 };
  if (before) variables.before = before;

  const res = await gqlRequest(page, `
    query GetMessages($sessionId: ID!, $before: ID, $limit: Int) {
      sessionMessages(sessionId: $sessionId, before: $before, limit: $limit) {
        id content createdAt
      }
    }
  `, variables, token);
  const body = await res.json();
  return body.data.sessionMessages;
}

test.describe('Session Scroll Loading', () => {
  let token: string;
  let username: string;
  let controllerId: string;
  let workspaceId: string;
  let sessionId: string;
  let disconnect: () => void;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();

    // Register user
    const user = await registerUser(page);
    token = user.token;
    username = user.username;

    // Create controller key and register controller
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    controllerId = controller.controllerId;
    disconnect = controller.disconnect;

    // Create workspace
    const workspace = await createWorkspace(page, controllerId, '/tmp/e2e-workspace', token);
    workspaceId = workspace.id;

    // Create session
    sessionId = await createSession(page, controllerId, token, workspaceId);

    // Wait for session to be ready
    await page.waitForTimeout(1000);

    await page.close();
  });

  test.afterAll(async () => {
    disconnect?.();
  });

  test('initial load should show at most 25 messages', async ({ page }) => {
    // Login and navigate to session
    await loginViaUI(page, username);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for SSE connection and history
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 10000 });

    // Count messages
    const messageCount = await page.locator('[data-testid="message-item"]').count();

    // Should show at most 25 messages
    expect(messageCount).toBeLessThanOrEqual(25);
  });

  test('scroll up should load earlier messages without position jump', async ({ page }) => {
    // Login and navigate to session
    await loginViaUI(page, username);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for initial load
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Get initial scroll position
    const scrollContainer = page.locator('.overflow-y-auto');
    const initialScrollTop = await scrollContainer.evaluate(el => el.scrollTop);
    const initialScrollHeight = await scrollContainer.evaluate(el => el.scrollHeight);

    // Scroll to top to trigger load
    await scrollContainer.evaluate(el => { el.scrollTop = 0; });

    // Wait for loading to complete
    await page.waitForTimeout(1000);

    // Get new scroll position
    const newScrollTop = await scrollContainer.evaluate(el => el.scrollTop);
    const newScrollHeight = await scrollContainer.evaluate(el => el.scrollHeight);

    // Verify scroll position is preserved (not jumped to bottom)
    // The new scrollTop should compensate for the added height
    const expectedScrollTop = newScrollHeight - initialScrollHeight + initialScrollTop;
    expect(Math.abs(newScrollTop - expectedScrollTop)).toBeLessThan(10); // Allow small tolerance
  });

  test('scroll to earliest should show "已加载全部历史" message', async ({ page }) => {
    // Login and navigate to session
    await loginViaUI(page, username);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for initial load
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 10000 });

    // Keep scrolling up until no more messages
    const scrollContainer = page.locator('.overflow-y-auto');
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 10;

    while (hasMore && attempts < maxAttempts) {
      await scrollContainer.evaluate(el => { el.scrollTop = 0; });
      await page.waitForTimeout(500);

      // Check if "已加载全部历史" message appears
      const allHistoryMessage = page.locator('text=已加载全部历史');
      hasMore = !(await allHistoryMessage.isVisible());
      attempts++;
    }

    // Verify "已加载全部历史" message is shown
    await expect(page.locator('text=已加载全部历史')).toBeVisible();
  });

  test('new messages during history load should not cause duplicates', async ({ page }) => {
    // Login and navigate to session
    await loginViaUI(page, username);
    await page.goto(`/sessions/${sessionId}`);

    // Wait for initial load
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 10000 });

    // Get initial message count
    const initialCount = await page.locator('[data-testid="message-item"]').count();

    // Scroll up to trigger history load
    const scrollContainer = page.locator('.overflow-y-auto');
    await scrollContainer.evaluate(el => { el.scrollTop = 0; });

    // While loading, send a new message via API
    await sendMessages(page, sessionId, token, 1);

    // Wait for everything to settle
    await page.waitForTimeout(1500);

    // Count messages after load
    const finalCount = await page.locator('[data-testid="message-item"]').count();

    // Should have more messages than initial (from history load)
    // but no duplicates
    expect(finalCount).toBeGreaterThan(initialCount);

    // Verify no duplicate message content
    const messageTexts = await page.locator('[data-testid="message-item"]').allTextContents();
    const uniqueTexts = new Set(messageTexts);
    expect(uniqueTexts.size).toBe(messageTexts.length);
  });
});
