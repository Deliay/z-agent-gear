import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  EXIT_FAILED,
  EXIT_NOT_BOUND,
  EXIT_NOT_PROJECT,
  EXIT_OK,
  EXIT_UNAUTHORIZED,
  MAX_TOKEN_LENGTH,
  normalizeGitHubRemote,
  requestProjectToken,
  resolveGitProject,
  runGithubTokenCommand,
} from './project-token.js';

const exec = promisify(execFile);

const ENV: NodeJS.ProcessEnv = {
  ZAG_AGENT_API_ENDPOINT: 'http://agent-api:8002/',
  ZAG_CONTROLLER_ID: 'controller-123',
  ZAG_HOST_KEY: 'zag_k_1_host_secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('normalizeGitHubRemote (T-GPT1)', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', 'Owner/Repo'],
    ['https://github.com/Owner/Repo', 'Owner/Repo'],
    ['http://github.com/Owner/Repo/', 'Owner/Repo'],
    ['git@github.com:Owner/Repo.git', 'Owner/Repo'],
    ['ssh://git@github.com/Owner/Repo.git', 'Owner/Repo'],
    ['git://github.com/Owner/Repo.git', 'Owner/Repo'],
    ['https://user:pass@github.com/owner/repo.git', 'owner/repo'],
    ['  https://GITHUB.com/owner/repo  ', 'owner/repo'],
    ['github.com:owner/repo', 'owner/repo'],
    ['https://github.com/owner/re.po-1_x', 'owner/re.po-1_x'],
  ])('%s → %s', (remote, expected) => {
    expect(normalizeGitHubRemote(remote)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'https://gitlab.com/owner/repo.git',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/own er/repo',
    'not-a-url',
  ])('rejects %s', (remote) => {
    expect(normalizeGitHubRemote(remote)).toBeNull();
  });
});

describe('resolveGitProject (T-GPT2)', () => {
  let dir = '';

  async function initRepo(remote?: string) {
    dir = await mkdtemp(join(tmpdir(), 'zag-project-token-'));
    await exec('git', ['init', '--quiet'], { cwd: dir });
    if (remote) await exec('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    return dir;
  }

  it('resolves owner/repo from the git origin', async () => {
    const repo = await initRepo('git@github.com:owner/repo.git');
    await expect(resolveGitProject(repo)).resolves.toEqual({
      kind: 'project',
      repoFullName: 'owner/repo',
    });
    await rm(repo, { recursive: true, force: true });
  });

  it('returns not-project outside a git repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'zag-plain-'));
    await expect(resolveGitProject(plain)).resolves.toEqual({ kind: 'not-project' });
    await rm(plain, { recursive: true, force: true });
  });

  it('returns not-project without an origin remote', async () => {
    const repo = await initRepo();
    await expect(resolveGitProject(repo)).resolves.toEqual({ kind: 'not-project' });
    await rm(repo, { recursive: true, force: true });
  });

  it('returns not-project for a non-github origin', async () => {
    const repo = await initRepo('https://gitlab.com/owner/repo.git');
    await expect(resolveGitProject(repo)).resolves.toEqual({ kind: 'not-project' });
    await rm(repo, { recursive: true, force: true });
  });

  it('returns not-project when git is unavailable', async () => {
    const resolution = await resolveGitProject('/tmp', {
      runGit: async () => null,
    });
    expect(resolution).toEqual({ kind: 'not-project' });
  });
});

describe('requestProjectToken (T-GPT3)', () => {
  it('posts the repo and returns the token', async () => {
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ token: 'ghs_project', repoFullName: 'owner/repo', expiresAt: '2026-01-01T00:00:00Z' }),
    );
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });

    expect(result).toEqual({ kind: 'token', token: 'ghs_project' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'http://agent-api:8002/internal/cloud-hosts/controller-123/github-credential',
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ repoFullName: 'owner/repo' }),
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer zag_k_1_host_secret',
    );
  });

  it('accepts a case-insensitive echo', async () => {
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ token: 't', repoFullName: 'OWNER/REPO' }),
    );
    await expect(
      requestProjectToken({ repoFullName: 'owner/repo', env: ENV, fetch: fetchFn }),
    ).resolves.toEqual({ kind: 'token', token: 't' });
  });

  it('rejects a mismatched echo', async () => {
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ token: 't', repoFullName: 'other/repo' }),
    );
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
  });

  it('rejects a missing echo (old server ignoring the body)', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ token: 't' }));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
  });

  it.each([['line1\nline2'], [''], ['has space'], ['x'.repeat(MAX_TOKEN_LENGTH + 1)]])(
    'rejects an invalid token %#',
    async (token) => {
      const fetchFn = fakeFetch(async () =>
        jsonResponse({ token, repoFullName: 'owner/repo' }),
      );
      const result = await requestProjectToken({
        repoFullName: 'owner/repo',
        env: ENV,
        fetch: fetchFn,
      });
      expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
    },
  );

  it('maps 404 PROJECT_NOT_BOUND to exit 4', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ error: 'PROJECT_NOT_BOUND' }, 404));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_NOT_BOUND });
  });

  it('maps a plain 404 to exit 4', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ error: 'NO_BINDING' }, 404));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_NOT_BOUND });
  });

  it('maps 403 REPO_NOT_AUTHORIZED to exit 5', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ error: 'REPO_NOT_AUTHORIZED' }, 403));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_UNAUTHORIZED });
  });

  it('maps 500 to exit 6 and never leaks the body', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ error: 'boom-secret' }, 500));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
    expect(result.kind === 'error' ? result.message : '').not.toContain('boom-secret');
  });

  it('maps invalid JSON on 200 to exit 6', async () => {
    const fetchFn = fakeFetch(async () => new Response('not-json', { status: 200 }));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
  });

  it('maps timeout to exit 6', async () => {
    const fetchFn = fakeFetch(
      async () =>
        new Promise<Response>((_resolve, reject) => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        }),
    );
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: ENV,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
    expect(result.kind === 'error' ? result.message : '').toContain('超时');
  });

  it('fails on missing env without calling fetch', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({}));
    const result = await requestProjectToken({
      repoFullName: 'owner/repo',
      env: {},
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ kind: 'error', code: EXIT_FAILED });
    expect(result.kind === 'error' ? result.message : '').toContain('ZAG_HOST_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('runGithubTokenCommand (T-GPTC1)', () => {
  it('writes only the token to stdout and exits 0', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGithubTokenCommand({
      resolveGitProject: async () => ({ kind: 'project', repoFullName: 'owner/repo' }),
      requestProjectToken: async () => ({ kind: 'token', token: 'ghs_x' }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(EXIT_OK);
    expect(stdout.join('')).toBe('ghs_x\n');
    expect(stderr).toEqual([]);
  });

  it('exits 3 silently for non-git directories', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGithubTokenCommand({
      resolveGitProject: async () => ({ kind: 'not-project' }),
      requestProjectToken: async () => ({ kind: 'token', token: 'unused' }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(EXIT_NOT_PROJECT);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it.each([
    [4 as const, EXIT_NOT_BOUND],
    [5 as const, EXIT_UNAUTHORIZED],
    [6 as const, EXIT_FAILED],
  ])('writes a single stderr line and returns %i', async (errorCode, expected) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runGithubTokenCommand({
      resolveGitProject: async () => ({ kind: 'project', repoFullName: 'owner/repo' }),
      requestProjectToken: async () => ({
        kind: 'error',
        code: errorCode,
        message: '可读原因',
      }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(expected);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['可读原因\n']);
  });
});
