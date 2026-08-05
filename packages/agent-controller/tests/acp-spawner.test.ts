import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'node:stream';
import type { ChildProcess } from 'child_process';
import * as os from 'os';

vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/bin/opencode'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn() };
});

import { AcpSpawner } from '../../src/acp/spawner.js';
import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';

function createMockChildProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdinMock = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const stdoutMock = new Readable({ read() {} });

  Object.defineProperty(proc, 'stdin', { value: stdinMock, writable: true });
  Object.defineProperty(proc, 'stdout', { value: stdoutMock, writable: true });
  Object.defineProperty(proc, 'stderr', { value: new Readable({ read() {} }), writable: true });
  Object.defineProperty(proc, 'kill', { value: vi.fn().mockReturnValue(true), writable: true });
  return proc;
}

describe('AcpSpawner', () => {
  let spawner: AcpSpawner;
  let mockProcess: ChildProcess & EventEmitter;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProcess = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as never);

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    spawner = new AcpSpawner({ sessionId: 'sess-1', cwd: '/tmp/project' });
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
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('should log stderr output', () => {
      spawner.start();
      const stderr = mockProcess.stderr as Readable;
      stderr.emit('data', Buffer.from('some warning\n'));
      expect(consoleErrorSpy).toHaveBeenCalledWith('ACP stderr (session=sess-1): some warning\n');
    });

    it('should log resolved command, args and cwd on start', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      spawner.start();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Starting ACP server: session=sess-1 cmd=/usr/bin/opencode args=["acp"] cwd=/tmp/project',
      );
    });

    it('should log exit code, signal and spawn params on process exit', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      spawner.start();
      mockProcess.emit('exit', 1, null);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'ACP process exited: session=sess-1 code=1 signal=null cmd=/usr/bin/opencode args=["acp"]',
      );
    });

    it('should log process error with session and command', () => {
      spawner.start();
      const error = new Error('spawn opencode ENOENT');
      mockProcess.emit('error', error);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'ACP process error (session=sess-1, cmd=/usr/bin/opencode):',
        error,
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
    it('should send SIGTERM to process', () => {
      spawner.start();
      spawner.stop();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should send SIGKILL after 5s if process has not exited', () => {
      spawner.start();
      spawner.stop();
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      vi.advanceTimersByTime(5000);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should not send SIGKILL if process already exited', () => {
      spawner.start();
      spawner.stop();
      mockProcess.emit('exit', 0, null);
      vi.advanceTimersByTime(5000);
      expect(mockProcess.kill).toHaveBeenCalledTimes(1);
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

      it('should return full path from `where`', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\Users\\ash\\AppData\\Roaming\\npm\\copilot.cmd\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot', args: ['--acp', '--stdio'] });
        sp.start();
        expect(spawn).toHaveBeenCalledWith(
          'C:\\Users\\ash\\AppData\\Roaming\\npm\\copilot.cmd',
          ['--acp', '--stdio'],
          expect.objectContaining({ shell: true }),
        );
      });

      it('should fall back to PATHEXT check when `where` fails', () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
        vi.mocked(existsSync).mockImplementation((p: string) => p === 'copilot.cmd');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith('copilot.cmd', expect.any(Array), expect.objectContaining({ shell: true }));
      });

      it('should return bare command as last resort', () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });
        vi.mocked(existsSync).mockReturnValue(false);
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith('copilot', expect.any(Array), expect.objectContaining({ shell: true }));
      });
    });

    describe('start', () => {
      it('should spawn with shell: true', () => {
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        sp.start();
        expect(spawn).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Array),
          expect.objectContaining({ shell: true }),
        );
      });
    });

    describe('stop', () => {
      it('should call kill() without signal on Windows', () => {
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        sp.start();
        sp.stop();
        expect(mockProcess.kill).toHaveBeenCalledWith();
        expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGTERM');
      });

      it('should call kill() again after 5s on Windows', () => {
        const sp = new AcpSpawner({ sessionId: 's', cwd: 'C:\\project', command: 'copilot' });
        vi.mocked(execFileSync).mockReturnValue('C:\\npm\\copilot.cmd\r\n');
        sp.start();
        sp.stop();
        expect(mockProcess.kill).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(mockProcess.kill).toHaveBeenCalledTimes(2);
        expect(mockProcess.kill).not.toHaveBeenCalledWith('SIGKILL');
      });
    });
  });
});
