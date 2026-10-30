import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import { exec } from 'child_process';
import { WorktreeHandler } from './worktree-handler.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function getCallback(args: unknown[]): ExecCallback | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i] as ExecCallback;
  }
  return undefined;
}

function mockExecSuccess(stdout: string, stderr = '') {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
    const cb = getCallback(args);
    if (cb) cb(null, stdout, stderr);
    return { on: vi.fn() };
  });
}

function mockExecError(errorMsg: string) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
    const cb = getCallback(args);
    if (cb) cb(new Error(errorMsg), '', '');
    return { on: vi.fn() };
  });
}

/**
 * 记录所有 `exec` 命令串（按调用顺序），可选按命令内容制造失败。
 * committer 测试断言的是「命令序列 + 转义结果」，必须能看到每条命令原文。
 */
function mockExecRecorder(commands: string[], shouldFail?: (command: string) => boolean) {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
    const command = args[0] as string;
    commands.push(command);
    const cb = getCallback(args);
    if (cb) {
      if (shouldFail?.(command)) cb(new Error(`failed: ${command}`), '', '');
      else cb(null, '', '');
    }
    return { on: vi.fn() };
  });
}

describe('WorktreeHandler', () => {
  let handler: WorktreeHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new WorktreeHandler();
  });

  describe('add', () => {
    it('should successfully create a worktree', async () => {
      mockExecSuccess('Preparing worktree... done.\n');
      const result = await handler.add('/repo', '/worktrees/ws/feat-abc', 'ws/feat-abc');
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe('/worktrees/ws/feat-abc');
    });

    it('should handle git worktree add failure', async () => {
      mockExecError('fatal: destination /worktrees already exists');
      const result = await handler.add('/repo', '/worktrees', 'branch');
      expect(result.success).toBe(false);
      expect(result.error).toContain('fatal');
    });

    it('should work when stderr has done message', async () => {
      mockExecSuccess('', 'done.\n');
      const result = await handler.add('/repo', '/wt', 'branch');
      expect(result.success).toBe(true);
    });
  });

  describe('add with committer', () => {
    it('T-WTC1: committer 存在时在 worktree add 之后依次写三条 worktree 级身份命令', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands);

      const result = await handler.add('/repo', '/wt', 'feat/branch', {
        name: 'Deliay',
        email: 'admin@remiliascarlet.com',
      });

      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe('/wt');
      expect(commands).toEqual([
        'git -C "/repo" worktree add -b "feat/branch" "/wt"',
        "git -C '/wt' config extensions.worktreeConfig true",
        "git -C '/wt' config --worktree user.name 'Deliay'",
        "git -C '/wt' config --worktree user.email 'admin@remiliascarlet.com'",
      ]);
    });

    it('T-WTC2: committer 缺省时不写任何身份配置', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands);

      const result = await handler.add('/repo', '/wt', 'feat/branch');

      expect(result.success).toBe(true);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toBe('git -C "/repo" worktree add -b "feat/branch" "/wt"');
      expect(commands.join('\n')).not.toContain('user.name');
      expect(commands.join('\n')).not.toContain('worktreeConfig');
    });

    it('T-WTC2b: worktree add 失败时不尝试写身份', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands, () => true);

      const result = await handler.add('/repo', '/wt', 'feat/branch', {
        name: 'Deliay',
        email: 'admin@remiliascarlet.com',
      });

      expect(result.success).toBe(false);
      expect(commands).toHaveLength(1);
    });

    it('T-WTC2c: committer 形态非法（非字符串/空值）时按缺省处理，不写身份且不影响成功', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands);

      const result = await handler.add(
        '/repo',
        '/wt',
        'feat/branch',
        { name: 42, email: '' } as unknown as { name: string; email: string },
      );

      expect(result.success).toBe(true);
      expect(commands).toHaveLength(1);
    });

    it('T-WTC3: 含空格/单引号/双引号/$/分号的姓名被 shell 转义且不注入', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands);

      const name = `Deliay O'Brien "$HOME"; echo pwned`;
      const email = `o'brien@example.com`;

      const result = await handler.add('/repo', '/wt', 'feat/branch', { name, email });

      expect(result.success).toBe(true);
      expect(commands).toHaveLength(4);
      expect(commands[2]).toBe(
        `git -C '/wt' config --worktree user.name 'Deliay O'\\''Brien "$HOME"; echo pwned'`,
      );
      expect(commands[3]).toBe(
        `git -C '/wt' config --worktree user.email 'o'\\''brien@example.com'`,
      );
      // 注入防护：值被单引号整体包裹，分号/命令替换处于引号内而非命令分隔位置
      const nameArg = commands[2].slice(commands[2].indexOf(`config --worktree user.name `) + 'config --worktree user.name '.length);
      expect(nameArg.startsWith("'")).toBe(true);
      expect(nameArg.endsWith("'")).toBe(true);
      expect(nameArg).not.toContain('`');
      expect(nameArg).not.toContain('$(');
    });

    it('T-WTC4: 单条身份命令失败只告警，不阻断 worktree 创建结果', async () => {
      const commands: string[] = [];
      mockExecRecorder(commands, (command) => command.includes('user.name'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await handler.add('/repo', '/wt', 'feat/branch', {
        name: 'Deliay',
        email: 'admin@remiliascarlet.com',
      });

      expect(result.success).toBe(true);
      expect(result.worktreePath).toBe('/wt');
      expect(commands).toHaveLength(4);
      expect(commands[3]).toContain('user.email');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('remove', () => {
    it('should successfully remove a worktree', async () => {
      mockExecSuccess('');
      const result = await handler.remove('/repo', '/worktrees/ws/branch');
      expect(result.success).toBe(true);
    });

    it('should handle removal failure', async () => {
      mockExecError('fatal: worktree not found');
      const result = await handler.remove('/repo', '/fake/path');
      expect(result.success).toBe(false);
      expect(result.error).toContain('fatal');
    });
  });

  describe('status', () => {
    it('should detect clean worktree', async () => {
      mockExecSuccess('');
      const result = await handler.status('/worktrees/ws/branch');
      expect(result.isClean).toBe(true);
    });

    it('should detect dirty worktree', async () => {
      mockExecSuccess(' M modified-file\n');
      const result = await handler.status('/worktrees/ws/branch');
      expect(result.isClean).toBe(false);
    });

    it('should return clean on error (graceful degradation)', async () => {
      mockExecError('not a git repository');
      const result = await handler.status('/fake/path');
      expect(result.isClean).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe('commit', () => {
    it('should successfully commit with hash extraction', async () => {
      let callCount = 0;
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
        callCount++;
        const cb = getCallback(args);
        if (!cb) return { on: vi.fn() };
        if (callCount === 1) {
          cb(null, '', '');
        } else {
          cb(null, '[ws/branch abcdef1] feat: test\n', '');
        }
        return { on: vi.fn() };
      });

      const result = await handler.commit('/path', 'feat: test');
      expect(result.success).toBe(true);
      expect(result.commitHash).toBe('abcdef1');
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('should handle commit with no real changes', async () => {
      (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
        const cb = getCallback(args);
        if (cb) cb(null, 'nothing to commit, working tree clean', '');
        return { on: vi.fn() };
      });
      const result = await handler.commit('/path', 'test');
      expect(result.success).toBe(true);
    });

    it('should handle commit execution failure', async () => {
      mockExecError('user.name is not set');
      const result = await handler.commit('/path', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});