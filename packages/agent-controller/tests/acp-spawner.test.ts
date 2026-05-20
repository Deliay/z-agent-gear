import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'node:stream';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/bin/opencode'),
}));

import { AcpSpawner } from '../../src/acp/spawner.js';
import { spawn } from 'child_process';

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
      expect(consoleErrorSpy).toHaveBeenCalledWith('ACP stderr: some warning\n');
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
});
