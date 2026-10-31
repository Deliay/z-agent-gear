import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'node:stream';
import type { ChildProcess } from 'child_process';
import * as os from 'os';

vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
  hostname: vi.fn(() => 'test-host'),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/bin/opencode'),
  execFile: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn() };
});

import { AcpSpawner } from '../../src/acp/spawner.js';
import { spawn, execFileSync, execFile } from 'child_process';
import { existsSync } from 'fs';
import { createTestLogger, type TestLogger } from '../../src/observability/testing.js';

function createMockChildProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdinMock = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const stdoutMock = new Readable({ read() {} });

  Object.defineProperty(proc, 'stdin', { value: stdinMock, writable: true });
  Object.defineProperty(proc, 'stdout', { value: stdoutMock, writable: true });
  Object.defineProperty(proc, 'stderr', { value: new Readable({ read() {} }), writable: true });
  Object.defineProperty(proc, 'kill', { value: vi.fn().mockReturnValue(true), writable: true });
  Object.defineProperty(proc, 'pid', { value: 12345, writable: true });
  return proc;
}

describe('AcpSpawner', () => {
  let spawner: AcpSpawner;
  let mockProcess: ChildProcess & EventEmitter;
  let testLog: TestLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProcess = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as never);

    testLog = createTestLogger('acp-spawner');

    spawner = new AcpSpawner({ sessionId: 'sess-1', cwd: '/tmp/project', logger: testLog.logger });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should spawn opencode acp process with correct arguments', () => {
      spawner.start();
      expect(spawn).toHaveBeenCalledWith('/usr/bin/opencode', ['acp'], {
        cwd: '/tmp/project',
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('should log stderr output', () => {
      spawner.start();
      const stderr = mockProcess.stderr as Readable;
      stderr.emit('data', Buffer.from('some warning\n'));
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          component: 'acp-spawner',
          level: 'error',
          msg: 'acp server stderr',
          stderr: 'some warning\n',
        }),
      );
    });

    it('should log resolved command, args and cwd on start', () => {
      spawner.start();
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          component: 'acp-spawner',
          msg: 'starting ACP server',
          command: '/usr/bin/opencode',
          args: ['acp'],
          cwd: '/tmp/project',
        }),
      );
    });

    it('should log exit code, signal and spawn params on process exit', () => {
      spawner.start();
      mockProcess.emit('exit', 1, null);
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          component: 'acp-spawner',
          msg: 'acp process exited',
          exitCode: 1,
          signal: null,
          command: '/usr/bin/opencode',
          args: ['acp'],
        }),
      );
    });

    it('should log process error with session and command', () => {
      spawner.start();
      const error = new Error('spawn opencode ENOENT');
      mockProcess.emit('error', error);
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          component: 'acp-spawner',
          level: 'error',
          msg: 'acp process error',
          command: '/usr/bin/opencode',
          err: expect.objectContaining({ message: 'spawn opencode ENOENT' }),
        }),
      );
    });

    it('should resolve closed on process exit', async () => {
      spawner.start();
      mockProcess.emit('exit', 0, null);
      await expect(spawner.closed).resolves.toBeUndefined();
    });
  });

  describe('stdin', () => {
    it('should return a WritableStream when process is running', () => {
      spawner.start();
      const stream = spawner.stdin;
      expect(stream).toBeInstanceOf(WritableStream);
    });

    it('should throw when process not running', () => {
      expect(() => spawner.stdin).toThrow('ACP process not running');
    });
  });

  describe('stdout', () => {
    it('should return a ReadableStream when process is running', () => {
      spawner.start();
      const stream = spawner.stdout;
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should throw when process not running', () => {
      expect(() => spawner.stdout).toThrow('ACP process not running');
    });
  });

  describe('stop', () => {
    let processKillSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
    });

    afterEach(() => {
      processKillSpy.mockRestore();
    });

    it('should send SIGTERM to process group', () => {
      spawner.start();
      const pid = mockProcess.pid;
      spawner.stop();
      expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM');
    });

    it('should send SIGKILL after 5s if process has not exited', () => {
      spawner.start();
      const pid = mockProcess.pid;
      spawner.stop();
      expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM');
      vi.advanceTimersByTime(5000);
      expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGKILL');
    });

    it('should not send SIGKILL if process already exited', () => {
      spawner.start();
      const pid = mockProcess.pid;
      spawner.stop();
      mockProcess.emit('exit', 0, null);
      vi.advanceTimersByTime(5000);
      expect(processKillSpy).not.toHaveBeenCalledWith(-pid, 'SIGKILL');
    });

    it('should handle stop when no process', () => {
      expect(() => spawner.stop()).not.toThrow();
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      expect(spawner.isRunning()).toBe(false);
    });

    it('should return true after start', () => {
      spawner.start();
      expect(spawner.isRunning()).toBe(true);
    });

    it('should return false after exit', () => {
      spawner.start();
      mockProcess.emit('exit', 0, null);
      expect(spawner.isRunning()).toBe(false);
    });
  });

  describe('closed', () => {
    it('should resolve when process exits', async () => {
      spawner.start();
      let resolved = false;
      spawner.closed.then(() => { resolved = true; });
      expect(resolved).toBe(false);
      mockProcess.emit('exit', 0, null);
      await vi.waitFor(() => expect(resolved).toBe(true));
    });
  });

  describe('Windows platform', () => {
    beforeEach(() => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(execFileSync).mockReset();
      vi.mocked(existsSync).mockReset();
      vi.mocked(spawn).mockClear();
    });

    afterEach(() => {
      vi.mocked(os.platform).mockReturnValue('linux');
    });

    describe('resolveCommand', () => {
      it('should use `where` instead of `which`', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot', args: ['--acp', '--stdio'] });
        sp.start();
        expect(execFileSync).toHaveBeenCalledWith('where', ['copilot'], { encoding: 'utf8', timeout: 1000 });
      });

      it('should return full path from `where` and use shell for .cmd', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\Users\\ash\\AppData\\Roaming\\npm\\copilot.cmd\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot', args: ['--acp', '--stdio'] });
        sp.start();
        expect(spawn).toHaveBeenCalledWith(
          'C:\\Users\\ash\\AppData\\Roaming\\npm\\copilot.cmd',
          ['--acp', '--stdio'],
          expect.objectContaining({ cwd: 'C:\\project', stdio: ['pipe', 'pipe', 'pipe'], shell: true }),
        );
      });

      it('should fall back to PATHEXT check when `where` fails', () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
        vi.mocked(existsSync).mockImplementation((p: string) => p === 'copilot.cmd');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith('copilot.cmd', expect.any(Array), expect.objectContaining({ cwd: 'C:\\project' }));
      });

      it('should return bare command as last resort', () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
        vi.mocked(existsSync).mockReturnValue(false);
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith('copilot', expect.any(Array), expect.objectContaining({ cwd: 'C:\\project' }));
      });
    });

    describe('start', () => {
      it('should spawn .cmd with shell: true on Windows (Node EINVAL on shell-less .cmd)', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith(
          'C:\\npm\\copilot.cmd',
          expect.any(Array),
          expect.objectContaining({ cwd: 'C:\\project', shell: true }),
        );
      });

      it('should spawn .bat with shell: true on Windows', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\agent.bat\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'agent' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith(
          'C:\\npm\\agent.bat',
          expect.any(Array),
          expect.objectContaining({ cwd: 'C:\\project', shell: true }),
        );
      });

      it('should spawn a real .exe directly without shell on Windows', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\tools\\opencode.exe\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'opencode' });
        sp.start();
        const spawnOptions = vi.mocked(spawn).mock.calls[0][2];
        expect(spawn).toHaveBeenCalledWith('C:\\tools\\opencode.exe', expect.any(Array), expect.objectContaining({ cwd: 'C:\\project' }));
        expect(spawnOptions).not.toHaveProperty('shell');
      });
    });

    describe('stop', () => {
      it('should use taskkill on Windows instead of signal kill', () => {
        vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
          if (typeof cb === 'function') cb(null, '', '');
          return {} as any;
        });
        const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true as any);
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        sp.start();
        sp.stop();
        // On Windows, stop() should call taskkill, not POSIX signals
        expect(processKillSpy).not.toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
        expect(processKillSpy).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL');
        processKillSpy.mockRestore();
      });
    });
  });
});
