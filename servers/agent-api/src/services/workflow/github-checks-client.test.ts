import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config/index.js', () => ({
  config: { githubApiBaseUrl: 'http://127.0.0.1:9911' },
}));

import {
  createCheckRun,
  updateCheckRun,
  getPullRequestHead,
  GitHubChecksError,
} from './github-checks-client.js';

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<unknown>,
): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as never;
  return calls;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('github-checks-client', () => {
  it('TC1: createCheckRun 使用配置 base、必要请求头与载荷', async () => {
    const calls = mockFetch(() => jsonResponse({ id: 1001, html_url: 'https://github.com/o/r/runs/1001' }));

    const result = await createCheckRun('ghs_token', 'o/r', {
      name: 'ZAG 工作流 · 代码实现',
      head_sha: 'abc123',
      external_id: 'inst-1:node-1',
      status: 'in_progress',
      started_at: '2026-10-25T00:00:00.000Z',
      output: { title: '代码实现 · 执行中', summary: '工作流：demo' },
    });

    expect(result).toEqual({ id: 1001, htmlUrl: 'https://github.com/o/r/runs/1001' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:9911/repos/o/r/check-runs');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghs_token');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2026-03-10');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      name: 'ZAG 工作流 · 代码实现',
      head_sha: 'abc123',
      external_id: 'inst-1:node-1',
      status: 'in_progress',
    });
  });

  it('TC2: updateCheckRun PATCH 指定 check-run', async () => {
    const calls = mockFetch(() => jsonResponse({ id: 1001, html_url: null }));

    await updateCheckRun('ghs_token', 'o/r', 1001, {
      status: 'completed',
      conclusion: 'stale',
    });

    expect(calls[0].url).toBe('http://127.0.0.1:9911/repos/o/r/check-runs/1001');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      status: 'completed',
      conclusion: 'stale',
    });
  });

  it('TC3: getPullRequestHead 取 head.sha / state / merged', async () => {
    mockFetch(() =>
      jsonResponse({ head: { sha: 'deadbeef' }, state: 'open', merged: false }),
    );

    const head = await getPullRequestHead('ghs_token', 'o/r', 285);

    expect(head).toEqual({ sha: 'deadbeef', state: 'open', merged: false });
  });

  it('TC4: getPullRequestHead 缺少 head.sha 时收敛为 UPSTREAM', async () => {
    mockFetch(() => jsonResponse({ state: 'open' }));

    await expect(getPullRequestHead('ghs_token', 'o/r', 285)).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [422, 'INVALID_PAYLOAD'],
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM'],
  ])('TC5: HTTP %s 收敛为 %s', async (status, code) => {
    mockFetch(() => jsonResponse({ message: 'upstream detail' }, false, status));

    const error = await createCheckRun('ghs_token', 'o/r', {
      name: 'n',
      head_sha: 'sha',
      status: 'queued',
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GitHubChecksError);
    expect((error as GitHubChecksError).code).toBe(code);
    // 不透出上游原文与 token
    expect((error as Error).message).not.toContain('upstream detail');
    expect((error as Error).message).not.toContain('ghs_token');
  });

  it('TC6: 网络错误收敛为 UPSTREAM，且不含上游原文', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED secret detail')));

    const error = await getPullRequestHead('ghs_token', 'o/r', 1).catch((err: unknown) => err);

    expect((error as GitHubChecksError).code).toBe('UPSTREAM');
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('TC7: 超时中止请求并收敛为 UPSTREAM', async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const promise = getPullRequestHead('ghs_token', 'o/r', 1).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_001);
    const error = await promise;
    vi.useRealTimers();

    expect((error as GitHubChecksError).code).toBe('UPSTREAM');
  });
});
