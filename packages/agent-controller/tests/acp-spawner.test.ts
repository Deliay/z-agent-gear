import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { AcpSpawner } from '../../src/acp/spawner.js';
import { spawn } from 'child_process';

function createMockChildProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperty(proc, 'stdin', {
    value: { write: vi.fn() },
    writable: true,
  });
  Object.defineProperty(proc, 'stdout', {
    value: new EventEmitter(),
    writable: true,
  });
  Object.defineProperty(proc, 'stderr', {
    value: new EventEmitter(),
    writable: true,
  });
  proc.kill = vi.fn().mockReturnValue(true);
  return proc;
}

describe('AcpSpawner', () => {
  let spawner: AcpSpawner;
  let mockProcess: ReturnType<typeof createMockChildProcess>;
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProcess = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess as never);

    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };

    spawner = new AcpSpawner({ sessionId: 'sess-1', cwd: '/tmp/project' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should spawn opencode acp process with correct arguments', () => {
      spawner.start();

      expect(spawn).toHaveBeenCalledWith('opencode', ['acp'], {
        cwd: '/tmp/project',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('should emit message events from stdout', () => {
      spawner.start();

      const handler = vi.fn();
      spawner.on('message', handler);

      const msg = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} });
      (mockProcess.stdout as EventEmitter).emit('data', Buffer.from(msg + '\n'));

      expect(handler).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'session/update', params: {} });
    });

    it('should handle multiple messages in one chunk', () => {
      spawner.start();

      const handler = vi.fn();
      spawner.on('message', handler);

      const msg1 = JSON.stringify({ id: 1 });
      const msg2 = JSON.stringify({ id: 2 });
      (mockProcess.stdout as EventEmitter).emit('data', Buffer.from(msg1 + '\n' + msg2 + '\n'));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should handle invalid JSON gracefully', () => {
      spawner.start();

      const handler = vi.fn();
      spawner.on('message', handler);

      (mockProcess.stdout as EventEmitter).emit('data', Buffer.from('not json\n'));
      (mockProcess.stdout as EventEmitter).emit('data', Buffer.from(JSON.stringify({ id: 1 }) + '\n'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should emit exit event when process exits', () => {
      spawner.start();

      const handler = vi.fn();
      spawner.on('exit', handler);

      mockProcess.emit('exit', 0, null);

      expect(handler).toHaveBeenCalledWith({ code: 0, signal: null });
    });

    it('should emit error event on process error', () => {
      spawner.start();

      const handler = vi.fn();
      spawner.on('error', handler);

      const error = new Error('spawn failed');
      mockProcess.emit('error', error);

      expect(handler).toHaveBeenCalledWith(error);
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should log stderr output', () => {
      spawner.start();

      (mockProcess.stderr as EventEmitter).emit('data', Buffer.from('some warning\n'));

      expect(consoleSpy.error).toHaveBeenCalledWith('ACP stderr: some warning\n');
    });
  });

  describe('send', () => {
    it('should write JSON-RPC message to stdin', () => {
      spawner.start();

      spawner.send({ jsonrpc: '2.0', id: 1, method: 'test' });

      expect(mockProcess.stdin.write).toHaveBeenCalledWith(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }) + '\n');
    });

    it('should throw when process not running', () => {
      expect(() => spawner.send({ method: 'test' })).toThrow('ACP process not running');
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

  describe('getSessionId', () => {
    it('should return the session id', () => {
      expect(spawner.getSessionId()).toBe('sess-1');
    });
  });
});
