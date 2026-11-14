import { afterEach, describe, expect, it } from 'vitest';
import { startMockGitHubServer, type MockGitHubServer } from './mock-github-server.js';

/**
 * mock 与真实对端行为对齐守卫。
 *
 * GitHub 明确禁止应用把 `conclusion` 改为 `stale`（仅 GitHub 可设置，应用 PATCH 返回 422）。
 * 若 mock 无条件接受，会放过依赖该能力的实现（见 controller-api/AGENTS.md 跨服务协议教训）。
 */
describe('mock GitHub server 真实行为对齐', () => {
  let server: MockGitHubServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('POST/PATCH conclusion=stale 返回 422 且不落检查项', async () => {
    server = await startMockGitHubServer();

    const createStale = await fetch(`${server.url}/repos/o/r/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ZAG 工作流 · 代码实现',
        head_sha: 'sha-1',
        status: 'completed',
        conclusion: 'stale',
      }),
    });
    expect(createStale.status).toBe(422);
    expect(server.checkRuns).toHaveLength(0);

    const createOk = await fetch(`${server.url}/repos/o/r/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ZAG 工作流 · 代码实现',
        head_sha: 'sha-1',
        status: 'in_progress',
      }),
    });
    expect(createOk.status).toBe(201);
    const created = (await createOk.json()) as { id: number };
    expect(server.checkRuns).toHaveLength(1);

    const patchStale = await fetch(
      `${server.url}/repos/o/r/check-runs/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conclusion: 'stale' }),
      },
    );
    expect(patchStale.status).toBe(422);
    expect(server.checkRuns[0].conclusion).toBeNull();
  });

  it('GitHub OAuth authorize/token/user 链路与取消授权', async () => {
    server = await startMockGitHubServer();
    server.setOAuthUser({ id: 2002, login: 'octo-oauth', name: 'Octo OAuth' });

    const authorize = await fetch(
      `${server.url}/login/oauth/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://localhost:10001/api/auth/oauth/callback')}&state=s1`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get('location') ?? '');
    expect(callback.searchParams.get('state')).toBe('s1');
    const code = callback.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    const token = await fetch(`${server.url}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: 'test', client_secret: 'secret' }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string };
    expect(tokenBody.access_token).toContain('mock-github-access-');

    const user = await fetch(`${server.url}/user`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(user.status).toBe(200);
    expect(await user.json()).toMatchObject({ id: 2002, login: 'octo-oauth' });

    const replay = await fetch(`${server.url}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: 'test', client_secret: 'secret' }),
    });
    expect(replay.status).toBe(400);

    server.denyNextOAuth();
    const denied = await fetch(
      `${server.url}/login/oauth/authorize?client_id=test&redirect_uri=${encodeURIComponent('http://localhost:10001/api/auth/oauth/callback')}&state=s2`,
      { redirect: 'manual' },
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toContain('error=access_denied');
  });

  it('PATCH output 标记已过期可用（应用可写字段）', async () => {
    server = await startMockGitHubServer();
    const createOk = await fetch(`${server.url}/repos/o/r/check-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ZAG 工作流 · 代码实现',
        head_sha: 'sha-1',
        status: 'in_progress',
      }),
    });
    const created = (await createOk.json()) as { id: number };

    const patch = await fetch(`${server.url}/repos/o/r/check-runs/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        output: { title: '代码实现 · 已过期：PR 已有新提交', summary: 'PR 已有新提交' },
      }),
    });

    expect(patch.status).toBe(200);
    expect(server.checkRuns[0].output).toMatchObject({
      title: '代码实现 · 已过期：PR 已有新提交',
    });
  });
});
