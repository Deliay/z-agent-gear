import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const REGISTRY_DIR = join(homedir(), '.zag');
const REGISTRY_FILE = join(REGISTRY_DIR, 'processes.json');

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
  tmpdir: vi.fn(() => '/tmp'),
}));

import { ProcessRegistry } from './process-registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';

function getMockFs() {
  return {
    existsSync: vi.mocked(existsSync),
    readFileSync: vi.mocked(readFileSync),
    writeFileSync: vi.mocked(writeFileSync),
    mkdirSync: vi.mocked(mkdirSync),
    renameSync: vi.mocked(renameSync),
  };
}

describe('ProcessRegistry', () => {
  let registry: ProcessRegistry;
  let fs: ReturnType<typeof getMockFs>;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fs = getMockFs();
    processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
    // Default: file doesn't exist
    fs.existsSync.mockReturnValue(false);
    registry = new ProcessRegistry();
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  describe('constructor / load', () => {
    it('should create empty registry when file does not exist', () => {
      expect(registry.list()).toEqual([]);
    });

    it('should create empty registry on malformed JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json{{{');
      const reg = new ProcessRegistry();
      expect(reg.list()).toEqual([]);
    });

    it('should create empty registry on invalid schema (missing version)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ processes: [] }));
      const reg = new ProcessRegistry();
      expect(reg.list()).toEqual([]);
    });

    it('should create empty registry on invalid schema (missing processes)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ version: 1 }));
      const reg = new ProcessRegistry();
      expect(reg.list()).toEqual([]);
    });

    it('should load alive processes from registry file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: 1,
        processes: [
          { sessionId: 's1', pid: process.pid, cwd: '/tmp', acpServerType: 'opencode', startedAt: '2026-01-01T00:00:00Z' },
        ],
      }));
      // process.kill(pid, 0) returns true for current process
      processKillSpy.mockImplementation((pid: number, _sig?: any) => {
        if (_sig === 0 && pid === process.pid) return true;
        throw new Error('ESRCH');
      });

      const reg = new ProcessRegistry();
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('s1')).toBeDefined();
    });

    it('should treat EPERM (process owned by another user) as alive', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: 1,
        processes: [
          { sessionId: 's1', pid: 4242, cwd: '/tmp', acpServerType: 'opencode', startedAt: '2026-01-01T00:00:00Z' },
        ],
      }));
      processKillSpy.mockImplementation(() => {
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

      const reg = new ProcessRegistry();
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('s1')).toBeDefined();
    });

    it('should prune dead processes on load and rewrite file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: 1,
        processes: [
          { sessionId: 's1', pid: 99999, cwd: '/tmp', acpServerType: 'opencode', startedAt: '2026-01-01T00:00:00Z' },
        ],
      }));
      // pid 99999 is dead
      processKillSpy.mockImplementation(() => { throw new Error('ESRCH'); });

      const reg = new ProcessRegistry();
      expect(reg.list()).toHaveLength(0);
      // Should have rewritten file with empty list
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('should register a process', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp/project', acpServerType: 'opencode' });
      const entry = registry.get('s1');
      expect(entry).toBeDefined();
      expect(entry!.pid).toBe(1234);
      expect(entry!.cwd).toBe('/tmp/project');
      expect(entry!.acpServerType).toBe('opencode');
    });

    it('should persist to file on register', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1] as string);
      expect(written.version).toBe(1);
      expect(written.processes).toHaveLength(1);
      expect(written.processes[0].sessionId).toBe('s1');
    });

    it('should write the temp file inside REGISTRY_DIR (same-filesystem atomic rename)', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      const tmpPath = fs.writeFileSync.mock.calls[0][0] as string;
      expect(tmpPath.startsWith(REGISTRY_DIR)).toBe(true);
      expect(tmpPath).not.toBe(REGISTRY_FILE);
      expect(fs.renameSync).toHaveBeenCalledWith(tmpPath, REGISTRY_FILE);
    });

    it('should not throw when flush fails (e.g. unwritable directory)', () => {
      fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS: read-only file system'); });
      expect(() => registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' })).not.toThrow();
      expect(registry.get('s1')).toBeDefined();
    });

    it('should use provided startedAt', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode', startedAt: '2026-01-01' });
      expect(registry.get('s1')!.startedAt).toBe('2026-01-01');
    });

    it('should auto-generate startedAt if not provided', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      expect(registry.get('s1')!.startedAt).toBeTruthy();
    });
  });

  describe('deregister', () => {
    it('should deregister an existing entry', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      const result = registry.deregister('s1');
      expect(result).toBe(true);
      expect(registry.get('s1')).toBeUndefined();
    });

    it('should return false for non-existent entry', () => {
      const result = registry.deregister('nonexistent');
      expect(result).toBe(false);
    });

    it('should persist to file on deregister', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      vi.mocked(writeFileSync).mockClear();
      registry.deregister('s1');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should not persist if entry did not exist', () => {
      vi.mocked(writeFileSync).mockClear();
      registry.deregister('nonexistent');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should return all entries without sessionId', () => {
      registry.register('s1', { pid: 111, cwd: '/a', acpServerType: 'opencode' });
      registry.register('s2', { pid: 222, cwd: '/b', acpServerType: 'claude_code' });
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list[0]).not.toHaveProperty('sessionId');
      expect(list[1]).not.toHaveProperty('sessionId');
    });
  });

  describe('listEntries', () => {
    it('should return all entries with sessionId', () => {
      registry.register('s1', { pid: 111, cwd: '/a', acpServerType: 'opencode' });
      const entries = registry.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].sessionId).toBe('s1');
    });
  });

  describe('get', () => {
    it('should return entry by sessionId without sessionId field', () => {
      registry.register('s1', { pid: 1234, cwd: '/tmp', acpServerType: 'opencode' });
      const entry = registry.get('s1');
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('sessionId');
      expect(entry!.pid).toBe(1234);
    });

    it('should return undefined for non-existent sessionId', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });
});
