import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommitIdentity,
  type GitRunResult,
  type GitRunner,
} from './commit-identity.js';

const execFileAsync = promisify(execFile);
const TMP_BASE = '/tmp/opencode';

const HUMAN = {
  name: 'Alice',
  email: '1001+alice@users.noreply.github.com',
};

const CO_AUTHOR = {
  name: 'Alice',
  email: '1001+alice@users.noreply.github.com',
  coAuthorName: 'zag-bot[bot]',
  coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
};

const CO_AUTHOR_TRAILER = 'Co-authored-by: zag-bot[bot] <123456+zag-bot[bot]@users.noreply.github.com>';

interface FakeGitState {
  include: string[];
  hooksPath: string | null;
}

/**
 * 内存 git 配置假实现：按真实 `git config` 的参数形态维护 include.path（多值）与 core.hooksPath。
 */
function fakeGit(initial: Partial<FakeGitState> = {}) {
  const state: FakeGitState = {
    include: [...(initial.include ?? [])],
    hooksPath: initial.hooksPath ?? null,
  };
  const calls: string[][] = [];

  const runGit = vi.fn(async (args: string[]): Promise<GitRunResult> => {
    calls.push(args);

    const indexOf = (flag: string): number => args.indexOf(flag);

    if (indexOf('--get-all') >= 0 && args[indexOf('--get-all') + 1] === 'include.path') {
      return state.include.length > 0
        ? { code: 0, stdout: `${state.include.join('\n')}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    }

    if (indexOf('--get') >= 0 && args[indexOf('--get') + 1] === 'core.hooksPath') {
      return state.hooksPath
        ? { code: 0, stdout: `${state.hooksPath}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    }

    if (indexOf('--add') >= 0) {
      const index = indexOf('--add');
      expect(args[index + 1]).toBe('include.path');
      state.include.push(args[index + 2]!);
      return { code: 0, stdout: '', stderr: '' };
    }

    if (indexOf('--unset-all') >= 0) {
      const index = indexOf('--unset-all');
      const key = args[index + 1];
      const pattern = args[args.length - 1]!;
      if (key === 'include.path') {
        state.include = state.include.filter((value) => value !== pattern);
      }
      return { code: 0, stdout: '', stderr: '' };
    }

    if (indexOf('--unset') >= 0) {
      const key = args[indexOf('--unset') + 1];
      if (key === 'core.hooksPath') {
        if (state.hooksPath === null) return { code: 5, stdout: '', stderr: '' };
        state.hooksPath = null;
      }
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[args.length - 2] === 'core.hooksPath') {
      state.hooksPath = args[args.length - 1]!;
      return { code: 0, stdout: '', stderr: '' };
    }

    return { code: 0, stdout: '', stderr: '' };
  });

  return { state, calls, runGit: runGit as unknown as GitRunner & typeof runGit, rawRun: runGit };
}

const dirs: string[] = [];

async function tempHome(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  const dir = await mkdtemp(join(TMP_BASE, 'commit-identity-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CommitIdentity', () => {
  it('T-CI1: apply writes the managed gitconfig (0600) and sets include.path exactly once', async () => {
    const home = await tempHome();
    const git = fakeGit();
    const applier = new CommitIdentity({ home, runGit: git.runGit });

    await applier.apply('human_only', HUMAN);

    const configPath = join(home, '.zag', 'commit-identity.gitconfig');
    const content = await readFile(configPath, 'utf8');
    expect(content).toBe(`[user]\n\tname = ${HUMAN.name}\n\temail = ${HUMAN.email}\n`);
    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(git.state.include).toEqual([configPath]);

    // 重复 apply 幂等：不追加第二个 include.path，文件内容不变
    await applier.apply('human_only', HUMAN);
    expect(git.state.include).toEqual([configPath]);
    expect(git.calls.filter((args) => args.includes('--add'))).toHaveLength(1);
    expect(await readFile(configPath, 'utf8')).toBe(content);
  });

  it('T-CI2: remove only touches values that exactly match the managed paths (zero residue)', async () => {
    const home = await tempHome();
    const userInclude = '/opt/user/gitconfig.inc';
    const userHooks = '/opt/user/git-hooks';
    const git = fakeGit({ include: [userInclude], hooksPath: userHooks });
    const applier = new CommitIdentity({ home, runGit: git.runGit });
    const configPath = join(home, '.zag', 'commit-identity.gitconfig');

    await applier.apply('human_only', HUMAN);
    expect(git.state.include).toEqual([userInclude, configPath]);

    await applier.remove();

    // 仅托管值被移除，用户既有值原样保留
    expect(git.state.include).toEqual([userInclude]);
    expect(git.state.hooksPath).toBe(userHooks);
    expect(git.calls.some((args) => args.includes('--unset'))).toBe(false);

    const unsetAll = git.calls.find((args) => args.includes('--unset-all'));
    expect(unsetAll).toBeDefined();
    expect(unsetAll).toContain('--fixed-value');
    expect(unsetAll).toContain(configPath);

    // 零残留：托管文件已删除
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(home, '.zag', 'git-hooks', 'prepare-commit-msg'))).toBe(false);

    // 用户把 hooksPath 改走后，remove 不得改动（exact-match）
    const second = fakeGit();
    const secondApplier = new CommitIdentity({ home, runGit: second.runGit });
    await secondApplier.apply('co_author', CO_AUTHOR);
    second.state.hooksPath = '/opt/user/other-hooks';
    await secondApplier.remove();
    expect(second.state.hooksPath).toBe('/opt/user/other-hooks');
    expect(second.calls.some((args) => args.includes('--unset'))).toBe(false);
  });

  it('T-CI3: co_author hook appends exactly one trailer (idempotent for repeat commits and --amend)', async () => {
    const home = await tempHome();
    const git = fakeGit();
    const applier = new CommitIdentity({ home, runGit: git.runGit });
    const hookPath = join(home, '.zag', 'git-hooks', 'prepare-commit-msg');

    await applier.apply('co_author', CO_AUTHOR);

    const hook = await readFile(hookPath, 'utf8');
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook).toContain('# zag-managed');
    expect(hook).toContain(`TRAILER='${CO_AUTHOR_TRAILER}'`);
    expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
    expect(git.state.hooksPath).toBe(join(home, '.zag', 'git-hooks'));

    const messageDir = join(home, 'messages');
    await mkdir(messageDir, { recursive: true });
    const messagePath = join(messageDir, 'COMMIT_EDITMSG');
    await writeFile(messagePath, 'feat: first commit\n', 'utf8');

    await execFileAsync('sh', [hookPath, messagePath]);
    await execFileAsync('sh', [hookPath, messagePath]);

    let message = await readFile(messagePath, 'utf8');
    expect(message.split(CO_AUTHOR_TRAILER)).toHaveLength(2);

    // --amend：消息里已有同一 trailer 时不得叠加（exact-trailer）
    const amendPath = join(messageDir, 'AMEND_EDITMSG');
    await writeFile(amendPath, `feat: amended\n\n${CO_AUTHOR_TRAILER}\n`, 'utf8');
    await execFileAsync('sh', [hookPath, amendPath]);
    message = await readFile(amendPath, 'utf8');
    expect(message.split(CO_AUTHOR_TRAILER)).toHaveLength(2);
  });

  it('T-CI4: switching co_author → human_only removes the hook but keeps user identity; unset removes everything', async () => {
    const home = await tempHome();
    const git = fakeGit();
    const applier = new CommitIdentity({ home, runGit: git.runGit });
    const configPath = join(home, '.zag', 'commit-identity.gitconfig');
    const hookPath = join(home, '.zag', 'git-hooks', 'prepare-commit-msg');

    await applier.apply('co_author', CO_AUTHOR);
    expect(existsSync(hookPath)).toBe(true);

    await applier.apply('human_only', { name: 'Bob', email: 'bob@example.com' });
    expect(existsSync(hookPath)).toBe(false);
    expect(git.state.hooksPath).toBeNull();
    expect(git.state.include).toEqual([configPath]);
    expect(await readFile(configPath, 'utf8')).toContain('name = Bob');

    await applier.apply('unset', { name: 'ignored', email: 'ignored@example.com' });
    expect(git.state.include).toEqual([]);
    expect(git.state.hooksPath).toBeNull();
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(hookPath)).toBe(false);
  });

  it('T-CI5: git spawn failures surface readable errors without leaking identity values', async () => {
    const home = await tempHome();
    const failing = new CommitIdentity({
      home,
      runGit: vi.fn(async (args: string[]): Promise<GitRunResult> => {
        if (args.includes('--get-all')) return { code: 1, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: 'fatal: could not lock config file' };
      }) as unknown as GitRunner,
    });

    await expect(failing.apply('human_only', HUMAN)).rejects.toThrow(/git config.*失败/);
    await expect(failing.apply('human_only', HUMAN)).rejects.toThrow(/could not lock config file/);

    const crashing = new CommitIdentity({
      home,
      runGit: vi.fn(async () => {
        throw new Error('spawn git ENOENT');
      }) as unknown as GitRunner,
    });
    let message = '';
    try {
      await crashing.apply('human_only', { name: 'Secret Person', email: 'secret@example.com' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('git');
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('secret@example.com');
    expect(message).not.toContain('Secret Person');
  });
});
