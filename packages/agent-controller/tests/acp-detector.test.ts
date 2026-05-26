import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { AcpDetector } from '../../src/acp/detector.js';
import { exec } from 'child_process';

function mockExecSuccessOnce(stdout: string) {
  vi.mocked(exec).mockImplementationOnce((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as ((err: null, result: { stdout: string; stderr: string }) => void) | undefined;
    if (cb) cb(null, { stdout, stderr: '' });
    return {} as any;
  });
}

function mockExecFailureOnce() {
  vi.mocked(exec).mockImplementationOnce((...args: unknown[]) => {
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
    it('should detect opencode and github_copilot when both available', async () => {
      mockExecSuccessOnce('opencode v1.2.3\n');
      mockExecSuccessOnce('copilot 1.0.0\n');

      const result = await detector.detect();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'opencode', available: true, version: '1.2.3' });
      expect(result[1]).toEqual({ type: 'github_copilot', available: true, version: '1.0.0' });
    });

    it('should detect as unavailable when command fails', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'opencode', available: false });
      expect(result[1]).toEqual({ type: 'github_copilot', available: false });
    });

    it('should parse version with different formats', async () => {
      mockExecSuccessOnce('OpenCode version 2.0.1\n');
      mockExecSuccessOnce('copilot 3.0.0\n');

      const result = await detector.detect();

      expect(result[0].version).toBe('2.0.1');
      expect(result[1].version).toBe('3.0.0');
    });

    it('should return unknown version when format not recognized', async () => {
      mockExecSuccessOnce('some output without version\n');
      mockExecSuccessOnce('copilot output\n');

      const result = await detector.detect();

      expect(result[0].version).toBe('unknown');
      expect(result[1].version).toBe('unknown');
    });

    it('should detect only opencode when copilot fails', async () => {
      mockExecSuccessOnce('opencode v1.2.3\n');
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'opencode', available: true, version: '1.2.3' });
      expect(result[1]).toEqual({ type: 'github_copilot', available: false });
    });

    it('should detect only copilot when opencode fails', async () => {
      mockExecFailureOnce();
      mockExecSuccessOnce('copilot 1.0.0\n');

      const result = await detector.detect();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'opencode', available: false });
      expect(result[1]).toEqual({ type: 'github_copilot', available: true, version: '1.0.0' });
    });


  });

  describe('getSpawnerConfig', () => {
    it('should return opencode spawner config', () => {
      const config = detector.getSpawnerConfig('opencode');
      expect(config).toEqual({ command: 'opencode', args: ['acp'] });
    });

    it('should return github_copilot spawner config', () => {
      const config = detector.getSpawnerConfig('github_copilot');
      expect(config).toEqual({ command: 'copilot', args: ['--acp', '--stdio'] });
    });

    it('should return opencode as default for unknown serverType', () => {
      const config = detector.getSpawnerConfig('unknown_server');
      expect(config).toEqual({ command: 'opencode', args: ['acp'] });
    });
  });
});
