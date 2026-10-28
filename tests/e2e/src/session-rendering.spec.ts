import { test, expect, type Page } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import { registerUser, createControllerKey, registerController, loginViaUI, createSession, createWorkspace } from './helpers';

const statusBadge = () => '.px-2.py-1.text-xs.font-medium.rounded-full';

interface ExportCaptureWindow {
  __exportedMarkdown: string | null;
}

/**
 * 页面侧拦截 URL.createObjectURL(Blob) 并记录 Blob 文本。
 * 避免依赖 chrome-headless-shell 的 download artifacts 落盘路径（N-2）。
 */
async function captureExportedMarkdown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as ExportCaptureWindow;
    target.__exportedMarkdown = null;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (typeof Blob !== 'undefined' && obj instanceof Blob) {
        void obj.text().then((text) => {
          target.__exportedMarkdown = text;
        });
      }
      return original(obj);
    };
  });
}

async function waitForExportedMarkdown(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ExportCaptureWindow).__exportedMarkdown), { timeout: 10000 })
    .not.toBeNull();
  return (await page.evaluate(() => (window as unknown as ExportCaptureWindow).__exportedMarkdown)) ?? '';
}

interface SessionContext {
  sessionId: string;
  socket: Socket;
  disconnect: () => void;
}

async function setupSession(page: Page, workspacePath: string): Promise<SessionContext> {
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
  const workspace = await createWorkspace(page, controllerId, workspacePath, token);
  const sessionId = await createSession(page, controllerId, token, workspace.id);
  await page.goto(`/sessions/${sessionId}`);
  await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });
  await page.waitForTimeout(300);

  return { sessionId, socket, disconnect };
}

function inject(socket: Socket, sessionId: string, message: Record<string, unknown>) {
  socket.emit('acp:message', { sessionId, message });
}

test.describe('Session Rendering', () => {
  test('E2E-CREN1 代码块工具栏：语言标签、复制与换行切换', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const session = await setupSession(page, '/tmp/e2e-cren1');

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '```typescript\nconst answer = 42;\n```' },
    });

    await expect(page.getByTestId('code-block')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('code-block-language')).toHaveText('typescript');

    await page.getByRole('button', { name: '复制代码' }).click();
    await expect(page.getByText('已复制')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '自动换行' }).click();
    await expect(page.getByRole('button', { name: '关闭自动换行' })).toBeVisible();

    session.disconnect();
  });

  test('E2E-CREN2 Mermaid 渲染与语法错误回退', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren2');

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren2-valid',
      content: { type: 'text', text: '```mermaid\ngraph TD;\n  A-->B;\n```' },
    });
    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren2-invalid',
      content: { type: 'text', text: '```mermaid\nthis is definitely not a diagram\n```' },
    });
    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren2-plain',
      content: { type: 'text', text: 'after-mermaid-marker' },
    });

    await expect(page.getByTestId('mermaid-diagram').locator('svg')).toBeVisible({ timeout: 15000 });
    const invalidBlock = page.getByTestId('code-block').filter({ hasText: 'this is definitely not a diagram' });
    await expect(invalidBlock).toBeVisible({ timeout: 5000 });
    await expect(invalidBlock).toContainText('this is definitely not a diagram');
    await expect(page.getByText('after-mermaid-marker')).toBeVisible({ timeout: 5000 });

    session.disconnect();
  });

  test('E2E-CREN3 差异渲染：行号与增删对齐', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren3');

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `tc_diff_${Date.now()}`,
      kind: 'edit',
      status: 'completed',
      title: 'Edit src/a.ts',
      content: [
        {
          type: 'diff',
          path: 'src/a.ts',
          oldText: 'line-one\nline-two',
          newText: 'line-one\ninserted-line\nline-two',
        },
      ],
    });

    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 });

    const oldNumbers = await page.locator('[data-testid="diff-old-line-number"]').allTextContents();
    const newNumbers = await page.locator('[data-testid="diff-new-line-number"]').allTextContents();
    expect(oldNumbers.map((n) => n.trim())).toEqual(['1', '', '2']);
    expect(newNumbers.map((n) => n.trim())).toEqual(['1', '2', '3']);
    await expect(page.getByText('inserted-line')).toBeVisible();

    session.disconnect();
  });

  test('E2E-CREN4 终端 ANSI 颜色渲染', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren4');

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `tc_ansi_${Date.now()}`,
      kind: 'execute',
      status: 'completed',
      title: 'Run build',
      rawInput: { command: 'npm run build' },
      rawOutput: { output: '\u001b[31merror:\u001b[0m failed\n\u001b[32mok\u001b[0m done\u001b[?25l\u001b[?2004h\u001b[200~pasted\u001b[201~\u001b[2@\u001b[10`\u001b[>4;2m\u001b[15~\u001bPtmux;xx\u001b\\' },
    });

    const terminal = page.getByTestId('terminal-output');
    await expect(terminal).toBeVisible({ timeout: 10000 });
    await expect(terminal.locator('span[style*="color"]')).not.toHaveCount(0);
    await expect(terminal).toContainText('error:');
    await expect(terminal).toContainText('pasted');
    // 私有模式/CSI 标记/DCS 不得残留为可见乱码
    await expect(terminal).not.toContainText('?25');
    await expect(terminal).not.toContainText('?2004');
    await expect(terminal).not.toContainText('~');
    await expect(terminal).not.toContainText('>4;2m');
    await expect(terminal).not.toContainText('tmux');

    session.disconnect();
  });

  test('E2E-CREN5 工具生命周期一致：稀疏完成后标题不退化', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren5');
    const toolCallId = `tc_lifecycle_${Date.now()}`;

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      kind: 'execute',
      status: 'in_progress',
      title: 'npm test',
      rawInput: { command: 'npm test -- --run', workDir: '/repo' },
    });
    inject(session.socket, session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      rawOutput: { output: 'all green' },
    });

    await expect(page.getByText('Tool Call: npm test')).toBeVisible({ timeout: 10000 });
    // 防退化断言可红：标题丢失时兜底会显示 "Tool Call: Command" 或通用 "Tool Call"（R-15）
    await expect(page.getByText(/Tool Call: (Command|Tool Call)/)).toHaveCount(0);
    await expect(page.getByText('Tool Call', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '查看原始输入' }).first().click();
    await expect(page.getByTestId('raw-section-输入').first()).toContainText('npm test -- --run');

    session.disconnect();
  });

  test('E2E-CREN6 滚动导航：上翻视口保持、回到底部并恢复跟随', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren6');

    for (let i = 0; i < 40; i++) {
      inject(session.socket, session.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: `cren6-history-${i}`,
        content: { type: 'text', text: `history-message-${i}-${'filler '.repeat(40)}` },
      });
    }
    await expect(page.getByText(/history-message-39/)).toBeVisible({ timeout: 10000 });

    const container = page.getByTestId('message-scroll-container');
    await container.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(500);

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren6-new',
      content: { type: 'text', text: 'brand-new-message' },
    });

    await expect(page.getByTestId('scroll-to-bottom')).toBeVisible({ timeout: 10000 });
    // 视口保持：上翻后新消息到达不得把用户拽回底部（R-17）
    await expect.poll(async () => container.evaluate((el) => el.scrollTop)).toBeLessThan(50);

    await page.getByRole('button', { name: '回到底部' }).click();
    await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0);
    // 点击后应真正滚到底部（R-17）
    await expect.poll(async () => container.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);

    // 恢复自动跟随：再注入一条消息后视口仍贴底（R-17）
    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren6-follow-up',
      content: { type: 'text', text: 'follow-up-message' },
    });
    await expect(page.getByText('follow-up-message')).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => container.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);

    session.disconnect();
  });

  test('E2E-CREN7 窄视口无横向溢出', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren7');
    await page.setViewportSize({ width: 375, height: 700 });

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: '```typescript\n' + `const veryLongValue = "${'x'.repeat(400)}";\n` + '```',
      },
    });
    inject(session.socket, session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `tc_narrow_${Date.now()}`,
      kind: 'edit',
      status: 'completed',
      title: 'Edit narrow',
      content: [
        {
          type: 'diff',
          path: `src/${'deep/'.repeat(20)}file.ts`,
          oldText: 'a',
          newText: `b${'z'.repeat(300)}`,
        },
      ],
    });

    await expect(page.getByTestId('code-block').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10000 });

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);

    session.disconnect();
  });

  test('E2E-CREN8 导出对话为 Markdown', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren8');

    inject(session.socket, session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'cren8-text',
      content: { type: 'text', text: 'export-me' },
    });
    await expect(page.getByText('export-me')).toBeVisible({ timeout: 10000 });

    await captureExportedMarkdown(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出对话' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^session-.*\.md$/);
    const content = await waitForExportedMarkdown(page);
    expect(content).toContain('export-me');

    session.disconnect();
  });

  test('E2E-CREN9 长会话导出拉全历史（R-1）', async ({ page }) => {
    const session = await setupSession(page, '/tmp/e2e-cren9');

    for (let i = 0; i < 30; i++) {
      inject(session.socket, session.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: `cren9-message-${i}`,
        content: { type: 'text', text: `export-history-${i}` },
      });
    }
    await expect(page.getByText('export-history-29', { exact: true })).toBeVisible({ timeout: 10000 });
    // 等待消息落库后重载：SSE 首帧只回 25 条，hasMore=true
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator(statusBadge())).toHaveText('空闲', { timeout: 10000 });
    await expect(page.getByText('export-history-29', { exact: true })).toBeVisible({ timeout: 10000 });
    // 更早消息未加载（只导出窗口外的历史必须由导出链路补齐）
    await expect(page.getByText('export-history-0', { exact: true })).toHaveCount(0);

    await captureExportedMarkdown(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出对话' }).click();
    await downloadPromise;
    const content = await waitForExportedMarkdown(page);

    for (let i = 0; i < 30; i++) {
      expect(content).toContain(`export-history-${i}`);
    }
    expect(content.match(/export-history-/g)).toHaveLength(30);

    session.disconnect();
  });
});
