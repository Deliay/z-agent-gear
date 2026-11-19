import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { writeGhAuth, type GhSpawn } from './gh-config.js';

const TOKEN = 'ghs_super_secret_token_value';

interface FakeChildOptions {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  emitError?: string;
}

/** 最小 ChildProcess 替身：stdin.end 后异步触发 close。 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { chunks: string[]; end: (chunk?: string) => void };

  constructor(private readonly options: FakeChildOptions = {}) {
    super();
    this.stdin = {
      chunks: [],
      end: (chunk?: string) => {
        if (chunk !== undefined) this.stdin.chunks.push(chunk);
        if (options.emitError) {
          queueMicrotask(() => this.emit('error', new Error(options.emitError)));
          return;
        }
        if (options.stdout) queueMicrotask(() => this.stdout.emit('data', options.stdout));
        if (options.stderr) queueMicrotask(() => this.stderr.emit('data', options.stderr));
        queueMicrotask(() => this.emit('close', options.exitCode ?? 0, null));
      },
    };
  }
}

function scriptedSpawn(children: FakeChild[]) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawnFn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = children.shift();
    if (!child) throw new Error('unexpected spawn');
    return child as unknown as ChildProcess;
  }) as unknown as GhSpawn;
  return { spawnFn, calls };
}

describe('writeGhAuth', () => {
  it('T-GC1: passes the token via stdin only and then runs gh auth setup-git', async () => {
    const login = new FakeChild();
    const setup = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn([login, setup]);

    await writeGhAuth(TOKEN, { spawn: spawnFn });

    expect(calls.map((call) => call.command)).toEqual(['gh', 'gh']);
    expect(calls[0].args).toEqual(['auth', 'login', '--with-token']);
    expect(calls[1].args).toEqual(['auth', 'setup-git']);
    expect(login.stdin.chunks).toEqual([TOKEN]);
    // token 绝不进入 argv
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
    }
    expect(calls[0].options).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('T-GC2: reports the login exit code without leaking the token', async () => {
    const login = new FakeChild({ exitCode: 1, stderr: `bad credentials: ${TOKEN}` });
    const { spawnFn } = scriptedSpawn([login]);

    let error: Error | undefined;
    try {
      await writeGhAuth(TOKEN, { spawn: spawnFn });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('退出码 1');
    expect(error!.message).toContain('auth login');
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.message).toContain('***');
  });

  it('T-GC3: setup-git failure is returned once without an infinite retry loop', async () => {
    const login = new FakeChild();
    const setup = new FakeChild({ exitCode: 2, stderr: 'helper failed' });
    const { spawnFn, calls } = scriptedSpawn([login, setup]);

    await expect(writeGhAuth(TOKEN, { spawn: spawnFn })).rejects.toThrow(/setup-git.*退出码 2/s);
    expect(calls).toHaveLength(2);
    expect(login.stdin.chunks).toEqual([TOKEN]);
    expect(setup.stdin.chunks).toEqual([]);
  });

  it('rejects an empty token before spawning anything', async () => {
    const { spawnFn, calls } = scriptedSpawn([]);
    await expect(writeGhAuth('', { spawn: spawnFn })).rejects.toThrow('Github token 为空');
    expect(calls).toHaveLength(0);
  });
});

describe('writeGhAuth wrapper bypass (T-GHC-SKIP)', () => {
  it('passes ZAG_GH_WRAPPER_SKIP_TOKEN=1 on both gh calls while keeping process.env', async () => {
    const login = new FakeChild();
    const setup = new FakeChild();
    const { spawnFn, calls } = scriptedSpawn([login, setup]);
    const previous = process.env.ZAG_TEST_MARKER;
    process.env.ZAG_TEST_MARKER = 'kept';

    try {
      await writeGhAuth(TOKEN, { spawn: spawnFn });
    } finally {
      if (previous === undefined) delete process.env.ZAG_TEST_MARKER;
      else process.env.ZAG_TEST_MARKER = previous;
    }

    for (const call of calls) {
      const env = (call.options as { env?: NodeJS.ProcessEnv }).env;
      expect(env?.ZAG_GH_WRAPPER_SKIP_TOKEN).toBe('1');
      expect(env?.ZAG_TEST_MARKER).toBe('kept');
      // token 不进入 env
      expect(JSON.stringify(env)).not.toContain(TOKEN);
    }
  });
});
