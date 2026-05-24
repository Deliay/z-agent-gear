import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from 'child_process';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { GitHandler } from './git-handler.js';

function mockExecResolved(stdout: string) {
  return vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
    if (typeof cb === 'function') {
      cb(null, { stdout });
    }
  }) as never);
}

function mockExecRejected(errorMsg: string) {
  return vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: unknown) => void) => {
    if (typeof cb === 'function') {
      cb(new Error(errorMsg), null);
    }
  }) as never);
}

describe('GitHandler', () => {
  let handler: GitHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new GitHandler();
  });

  describe('check', () => {
    it('should detect a valid git repo with branches', async () => {
      let callCount = 0;
      vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
        callCount++;
        const outputs: Record<number, string> = {
          1: '.git\n',
          2: 'main\n',
          3: 'main\ndevelop\nfeature-x\n',
        };
        if (typeof cb === 'function') {
          cb(null, { stdout: outputs[callCount] || '' });
        }
      }) as never);

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(true);
      expect(result.currentBranch).toBe('main');
      expect(result.branches).toEqual(['main', 'develop', 'feature-x']);
      expect(result.defaultBranch).toBe('main');
    });

    it('should detect master as default if main does not exist', async () => {
      let callCount = 0;
      vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
        callCount++;
        const outputs: Record<number, string> = {
          1: '.git\n',
          2: 'master\n',
          3: 'develop\nmaster\n',
        };
        if (typeof cb === 'function') {
          cb(null, { stdout: outputs[callCount] || '' });
        }
      }) as never);

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(true);
      expect(result.defaultBranch).toBe('master');
    });

    it('should sort alphabetically if neither main nor master exists', async () => {
      let callCount = 0;
      vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
        callCount++;
        const outputs: Record<number, string> = {
          1: '.git\n',
          2: 'feature-x\n',
          3: 'develop\nfeature-x\n',
        };
        if (typeof cb === 'function') {
          cb(null, { stdout: outputs[callCount] || '' });
        }
      }) as never);

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(true);
      expect(result.defaultBranch).toBe('develop');
    });

    it('should return isGitRepo=false when not a git repo', async () => {
      mockExecRejected('fatal: not a git repository');

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(false);
      expect(result.currentBranch).toBeUndefined();
      expect(result.branches).toBeUndefined();
    });

    it('should handle git-dir check returning empty string', async () => {
      mockExecResolved('');

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(false);
    });

    it('should return error when branch listing fails on a valid repo', async () => {
      vi.mocked(exec).mockImplementationOnce(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
        if (typeof cb === 'function') cb(null, { stdout: '.git\n' });
      }) as never);
      vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: unknown) => void) => {
        if (typeof cb === 'function') cb(new Error('git command failed'), null);
      }) as never);

      const result = await handler.check('/fake/path');

      expect(result.isGitRepo).toBe(true);
      expect(result.error).toBe('git command failed');
    });
  });

  describe('init', () => {
    it('should initialize git repo and rename branch to main', async () => {
      vi.mocked(exec).mockImplementation(((_cmd: string, _opts: unknown, cb: (err: unknown, result: { stdout: string }) => void) => {
        if (typeof cb === 'function') cb(null, { stdout: '' });
      }) as never);

      const result = await handler.init('/fake/path');

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(vi.mocked(exec).mock.calls[0][0]).toBe('git init');
      expect(vi.mocked(exec).mock.calls[1][0]).toBe('git branch -m main');
    });

    it('should handle git init failure', async () => {
      mockExecRejected('permission denied');

      const result = await handler.init('/fake/path');

      expect(result.success).toBe(false);
      expect(result.error).toBe('permission denied');
    });
  });
});
