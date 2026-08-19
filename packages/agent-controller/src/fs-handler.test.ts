import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

import { FsHandler } from './fs-handler.js';
import { mkdirSync, rmSync } from 'fs';

describe('FsHandler', () => {
  let handler: FsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new FsHandler();
  });

  describe('mkdir', () => {
    it('should successfully create a folder', async () => {
      const result = await handler.mkdir('/parent', 'new-folder');

      expect(result.success).toBe(true);
      expect(result.name).toBe('new-folder');
      expect(result.path).toBe('/parent/new-folder');
    });

    it('should handle creation failure', async () => {
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error('EEXIST: file already exists');
      });

      const result = await handler.mkdir('/parent', 'existing');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject system-critical paths', async () => {
      const result = await handler.mkdir('/etc', 'evil');

      expect(result.success).toBe(false);
      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('removeDir whitelist', () => {
    it('should reject the filesystem root', async () => {
      const result = await handler.removeDir('/');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject the user home directory', async () => {
      const result = await handler.removeDir('/home/testuser');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject ancestors of the home directory', async () => {
      const result = await handler.removeDir('/home');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject the current working directory and its ancestors', async () => {
      for (const target of [process.cwd(), '/']) {
        const result = await handler.removeDir(target);
        expect(result.success).toBe(false);
      }
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject Windows drive roots and system paths', async () => {
      for (const target of ['C:\\', 'C:\\Windows', 'c:\\Users', 'D:\\']) {
        const result = await handler.removeDir(target);
        expect(result.success).toBe(false);
      }
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject arbitrary unregistered directories under home', async () => {
      const result = await handler.removeDir('/home/testuser/Documents');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should allow a registered worktree path', async () => {
      handler.registerAllowedPath('/home/testuser/workspaces/wt-1');

      const result = await handler.removeDir('/home/testuser/workspaces/wt-1');

      expect(result.success).toBe(true);
      expect(rmSync).toHaveBeenCalledWith('/home/testuser/workspaces/wt-1', { recursive: true, force: true });
    });

    it('should allow subpaths of a registered worktree path', async () => {
      handler.registerAllowedPath('/home/testuser/workspaces/wt-1');

      const result = await handler.removeDir('/home/testuser/workspaces/wt-1/nested/dir');

      expect(result.success).toBe(true);
      expect(rmSync).toHaveBeenCalled();
    });

    it('should reject sibling paths that merely share a prefix', async () => {
      handler.registerAllowedPath('/home/testuser/workspaces/wt-1');

      const result = await handler.removeDir('/home/testuser/workspaces/wt-1-evil');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should reject a path after it is unregistered', async () => {
      handler.registerAllowedPath('/home/testuser/workspaces/wt-1');
      handler.unregisterAllowedPath('/home/testuser/workspaces/wt-1');

      const result = await handler.removeDir('/home/testuser/workspaces/wt-1');

      expect(result.success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should refuse to register explicitly denied paths as allowed roots', async () => {
      handler.registerAllowedPath('/');
      handler.registerAllowedPath('/home/testuser');

      expect((await handler.removeDir('/home/testuser/Documents')).success).toBe(false);
      expect((await handler.removeDir('/')).success).toBe(false);
      expect(rmSync).not.toHaveBeenCalled();
    });
  });
});
