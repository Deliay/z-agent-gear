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
  (exec as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
    const cb = getCallback(args);
    if (cb) cb(null, stdout, stderr);
    return { on: vi.fn() };
  });
}

function mockExecError(errorMsg: string) {
  (exec as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
    const cb = getCallback(args);
    if (cb) cb(new Error(errorMsg), '', '');
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

  describe('remove', () => {
    it('should successfully remove a worktree', async () => {
      mockExecSuccess('');
      const result = await handler.remove('/worktrees/ws/branch');
      expect(result.success).toBe(true);
    });

    it('should handle removal failure', async () => {
      mockExecError('fatal: worktree not found');
      const result = await handler.remove('/fake/path');
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
      (exec as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
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
      (exec as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
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