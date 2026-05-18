import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { AcpDetector } from '../../src/acp/detector.js';
import { exec } from 'child_process';

function mockExecSuccess(stdout: string) {
  vi.mocked(exec).mockImplementation((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((err: null, result: { stdout: string; stderr: string }) => void) | undefined;
    if (cb) cb(null, { stdout, stderr: '' });
    return {} as any;
  });
}

function mockExecFailure() {
  vi.mocked(exec).mockImplementation((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((err: Error) => void) | undefined;
    if (cb) cb(new Error('command not found'));
    return {} as any;
  });
}

describe('AcpDetector', () => {
  let detector: AcpDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new AcpDetector();
  });

  describe('detect', () => {
    it('should detect opencode when available', async () => {
      mockExecSuccess('opencode v1.2.3\n');

      const result = await detector.detect();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'opencode', available: true, version: '1.2.3' });
      expect(exec).toHaveBeenCalledWith('opencode -v', expect.any(Function));
    });

    it('should detect opencode as unavailable when command fails', async () => {
      mockExecFailure();

      const result = await detector.detect();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'opencode', available: false });
    });

    it('should parse version with different formats', async () => {
      mockExecSuccess('OpenCode version 2.0.1\n');

      const result = await detector.detect();

      expect(result[0].version).toBe('2.0.1');
    });

    it('should return unknown version when format not recognized', async () => {
      mockExecSuccess('some output without version\n');

      const result = await detector.detect();

      expect(result[0].version).toBe('unknown');
    });
  });
});
