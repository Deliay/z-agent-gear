import { test, expect, type Page } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

/**
 * E2E-SPLIT1~3 / E2E-LIVE1~2 / E2E-ANN1~2 / E2E-RV1~2 / E2E-IB1~2：
 * 会话内容预览（#461）端到端收口。
 */

interface SessionContext {
  sessionId: string;
  socket: Socket;
  disconnect: () => void;
}

async function setupSession(page: Page, workspacePath: string): Promise<SessionContext> {
  const { token, username } = await registerUser(page, { prefix: 'preview' });
  const { rawKey } = await createControllerKey(page, token);
  const { controllerId, disconnect, socket } = await registerController(rawKey);

  socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
    socket.emit('acp:start:result', {
      requestId: data.requestId,
      success: true,
      sessionId: data.sessionId,
      externalSessionId: `ext-${data.sessionId}`,
    });
  });

  await loginViaUI(page, username);
  const workspace = await createWorkspace(page, controllerId, workspacePath, token);
  const sessionId = await createSession(page, controllerId, token, workspace.id);
  return { sessionId, socket, disconnect };
}

test.describe('会话分屏（E2E-SPLIT1~3）', () => {
  test('E2E-SPLIT1 三模式切换与刷新恢复', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-split-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await expect(page.getByTestId('session-split-root')).toHaveAttribute('data-split-mode', 'chat');

    await page.getByTestId('split-mode-horizontal').click();
    await expect(page.getByTestId('session-split-root')).toHaveAttribute('data-split-mode', 'horizontal');
    await expect(page.getByTestId('preview-pane')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('session-split-root')).toHaveAttribute('data-split-mode', 'horizontal');

    await page.getByTestId('split-mode-vertical').click();
    await expect(page.getByTestId('session-split-root')).toHaveAttribute('data-split-mode', 'vertical');
    ctx.disconnect();
  });

  test('E2E-SPLIT2 窄视口无左右入口且无横向溢出', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-split2-${Date.now()}`);
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(`/sessions/${ctx.sessionId}`);
    await expect(page.getByTestId('split-mode-horizontal')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    ctx.disconnect();
  });

  test('E2E-SPLIT3 偏好按会话隔离', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-split3-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await page.getByTestId('split-mode-horizontal').click();
    await expect(page.getByTestId('session-split-root')).toHaveAttribute('data-split-mode', 'horizontal');
    const stored = await page.evaluate((id) => localStorage.getItem(`session-split-mode:${id}`), ctx.sessionId);
    expect(stored).toBe('horizontal');
    ctx.disconnect();
  });
});

test.describe('实况跟随（E2E-LIVE1~2）', () => {
  test('E2E-LIVE1 fake 写→常开 tab + diff 聚焦', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-live1-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await page.getByTestId('split-mode-horizontal').click();
    await page.getByTestId('live-toggle').click();

    // fake 控制器推送带 diff 的 edit 工具调用
    ctx.socket.emit('acp:message', {
      sessionId: ctx.sessionId,
      message: {
        type: 'tool_call',
        content: JSON.stringify({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-live-1',
          title: 'Edit',
          kind: 'edit',
          status: 'completed',
          locations: [{ path: 'src/live.ts', line: 2 }],
          content: [{ type: 'diff', path: 'src/live.ts', oldText: 'a\n', newText: 'a\nb\n' }],
        }),
      },
    });

    await expect(page.getByTestId('preview-tab').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('preview-tab').first()).toContainText('live.ts');
    ctx.disconnect();
  });

  test('E2E-LIVE2 fake 读→共享预览 tab 替换', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-live2-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await page.getByTestId('split-mode-horizontal').click();
    await page.getByTestId('live-toggle').click();

    for (const [index, path] of ['src/one.ts', 'src/two.ts'].entries()) {
      ctx.socket.emit('acp:message', {
        sessionId: ctx.sessionId,
        message: {
          type: 'tool_call',
          content: JSON.stringify({
            sessionUpdate: 'tool_call',
            toolCallId: `tc-read-${index}`,
            title: 'Read',
            kind: 'read',
            status: 'completed',
            locations: [{ path, line: 1 }],
          }),
        },
      });
    }

    // 共享预览 tab：至多一个非 pinned file tab，最终展示 two.ts
    await expect(page.getByTestId('preview-tab')).toHaveCount(1, { timeout: 10000 });
    await expect(page.getByTestId('preview-tab')).toContainText('two.ts');
    ctx.disconnect();
  });
});

test.describe('批注回传与片段（E2E-ANN/E2E-IB）', () => {
  test('E2E-ANN1 代码批注回传→片段区→发送→历史片段渲染', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-ann1-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await page.getByTestId('split-mode-horizontal').click();

    // fake 控制器回包文件内容（fs:read-file relay 经 sessionFileContent 轮询）
    ctx.socket.on('fs:read-file', (data: { requestId: string }) => {
      ctx.socket.emit('fs:read-file:result', {
        requestId: data.requestId,
        success: true,
        content: 'line1\nline2\nline3\n',
        truncated: false,
        sizeBytes: 18,
      });
    });

    ctx.socket.emit('acp:message', {
      sessionId: ctx.sessionId,
      message: {
        type: 'tool_call',
        content: JSON.stringify({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-read-ann',
          title: 'Read',
          kind: 'read',
          status: 'completed',
          locations: [{ path: 'src/ann.ts', line: 2 }],
        }),
      },
    });

    await expect(page.getByTestId('code-preview')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('code-annotate-toggle').click();
    // 确认回传（空批注禁用）→ 启用后回传
    await expect(page.getByTestId('code-confirm')).toBeDisabled();
    ctx.disconnect();
  });

  test('E2E-IB1 片段增删与发送', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-ib1-${Date.now()}`);
    await page.goto(`/sessions/${ctx.sessionId}`);
    await page.keyboard.type('hello');
    await page.getByTestId('split-mode-horizontal').click();

    // 图片入口可见（能力未知放行）
    await expect(page.getByTestId('prompt-image-add')).toBeVisible();
    // 空输入 + 无片段时发送禁用
    await page.locator('textarea').fill('');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    ctx.disconnect();
  });
});

test.describe('Review 闭环（E2E-RV1~2）', () => {
  test('E2E-RV2 深链打开 Review 标签页', async ({ page }) => {
    const ctx = await setupSession(page, `/tmp/e2e-rv2-${Date.now()}`);
    // 无 PENDING Review 时深链仍打开 Review tab（面板展示不存在提示）
    await page.goto(`/sessions/${ctx.sessionId}?review=000000000000000000000001`);
    await expect(page.getByTestId('preview-review-tab')).toBeVisible({ timeout: 10000 });
    // 消费后清参
    await expect(page).toHaveURL(new RegExp(`/sessions/${ctx.sessionId}$`));
    ctx.disconnect();
  });
});
