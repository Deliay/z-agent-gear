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
    // 默认按「命令不可用」兜底：个别用例未显式 mock 的探测不会挂起。
    vi.mocked(exec).mockImplementation(((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as ((err: Error) => void) | undefined;
      if (cb) cb(new Error('command not found'));
      return {} as any;
    }) as never);
    detector = new AcpDetector();
  });

  describe('detect', () => {
    it('should detect all 8 servers when all available', async () => {
      mockExecSuccessOnce('opencode v1.2.3\n');
      mockExecSuccessOnce('copilot 1.0.0\n');
      mockExecSuccessOnce('claude-agent-acp 0.1.0\n');
      mockExecSuccessOnce('gemini 2.0.0\n');
      mockExecSuccessOnce('codex-acp 0.5.0\n');
      mockExecSuccessOnce('mimo 0.1.0\n');
      mockExecSuccessOnce('kimi 1.0.0\n');
      mockExecSuccessOnce('0.1.2-alpha.2\n');

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[0]).toEqual({ type: 'opencode', available: true, version: '1.2.3' });
      expect(result[1]).toEqual({ type: 'github_copilot', available: true, version: '1.0.0' });
      expect(result[2]).toEqual({ type: 'claude_code', available: true, version: '0.1.0' });
      expect(result[3]).toEqual({ type: 'gemini_cli', available: true, version: '2.0.0' });
      expect(result[4]).toEqual({ type: 'codex', available: true, version: '0.5.0' });
      expect(result[5]).toEqual({ type: 'mimo_code', available: true, version: '0.1.0' });
      expect(result[6]).toEqual({ type: 'kimi_code', available: true, version: '1.0.0' });
      expect(result[7]).toEqual({
        type: 'deepseek_harness',
        available: true,
        version: '0.1.2-alpha.2',
      });
    });

    it('should detect as unavailable when command fails', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[0]).toEqual({ type: 'opencode', available: false });
      expect(result[1]).toEqual({ type: 'github_copilot', available: false });
      expect(result[2]).toEqual({ type: 'claude_code', available: false });
      expect(result[3]).toEqual({ type: 'gemini_cli', available: false });
      expect(result[4]).toEqual({ type: 'codex', available: false });
      expect(result[5]).toEqual({ type: 'mimo_code', available: false });
      expect(result[6]).toEqual({ type: 'kimi_code', available: false });
      expect(result[7]).toEqual({ type: 'deepseek_harness', available: false });
    });

    it('should detect claude_code only when other servers fail', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecSuccessOnce('claude-agent-acp 0.1.0\n');
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[0]).toEqual({ type: 'opencode', available: false });
      expect(result[1]).toEqual({ type: 'github_copilot', available: false });
      expect(result[2]).toEqual({ type: 'claude_code', available: true, version: '0.1.0' });
      expect(result[3]).toEqual({ type: 'gemini_cli', available: false });
      expect(result[4]).toEqual({ type: 'codex', available: false });
      expect(result[5]).toEqual({ type: 'mimo_code', available: false });
      expect(result[6]).toEqual({ type: 'kimi_code', available: false });
    });

    it('should detect gemini_cli only when other servers fail', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecSuccessOnce('gemini 2.0.0\n');
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[3]).toEqual({ type: 'gemini_cli', available: true, version: '2.0.0' });
    });

    it('should detect codex only when other servers fail', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecSuccessOnce('codex-acp 0.5.0\n');
      mockExecFailureOnce();
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[4]).toEqual({ type: 'codex', available: true, version: '0.5.0' });
    });

    it('should detect mimo_code only when other servers fail', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecSuccessOnce('mimo 0.1.0\n');
      mockExecFailureOnce();

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[5]).toEqual({ type: 'mimo_code', available: true, version: '0.1.0' });
    });

    it('should detect kimi_code only when other servers fail', async () => {
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecFailureOnce();
      mockExecSuccessOnce('kimi 2.0.0\n');

      const result = await detector.detect();

      expect(result).toHaveLength(8);
      expect(result[6]).toEqual({ type: 'kimi_code', available: true, version: '2.0.0' });
    });

    it('should parse version with different formats', async () => {
      mockExecSuccessOnce('OpenCode version 2.0.1\n');
      mockExecSuccessOnce('copilot 3.0.0\n');
      mockExecSuccessOnce('v0.1.0\n');
      mockExecSuccessOnce('Gemini 2.0.0\n');
      mockExecSuccessOnce('codex-acp version 0.5.0\n');
      mockExecSuccessOnce('MiMo CLI v1.0.0\n');
      mockExecSuccessOnce('kimi 2.0.0\n');
      mockExecSuccessOnce('0.1.2-alpha.2\n');

      const result = await detector.detect();

      expect(result[0].version).toBe('2.0.1');
      expect(result[1].version).toBe('3.0.0');
      expect(result[2].version).toBe('0.1.0');
      expect(result[3].version).toBe('2.0.0');
      expect(result[4].version).toBe('0.5.0');
      expect(result[5].version).toBe('1.0.0');
      expect(result[6].version).toBe('2.0.0');
      expect(result[7].version).toBe('0.1.2-alpha.2');
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

    it('should return claude_code spawner config', () => {
      const config = detector.getSpawnerConfig('claude_code');
      expect(config).toEqual({ command: 'claude-agent-acp', args: [] });
    });

    it('should return gemini_cli spawner config', () => {
      const config = detector.getSpawnerConfig('gemini_cli');
      expect(config).toEqual({ command: 'gemini', args: ['--acp'] });
    });

    it('should return codex spawner config', () => {
      const config = detector.getSpawnerConfig('codex');
      expect(config).toEqual({ command: 'codex-acp', args: [] });
    });

    it('should return mimo_code spawner config', () => {
      const config = detector.getSpawnerConfig('mimo_code');
      expect(config).toEqual({ command: 'mimo', args: ['acp'] });
    });

    it('should return kimi_code spawner config', () => {
      const config = detector.getSpawnerConfig('kimi_code');
      expect(config).toEqual({ command: 'kimi', args: ['acp'] });
    });

    it('should return deepseek_harness spawner config', () => {
      const config = detector.getSpawnerConfig('deepseek_harness');
      expect(config).toEqual({ command: 'dsh', args: ['--profile', 'acp'] });
    });

    it('should return opencode as default for unknown serverType', () => {
      const config = detector.getSpawnerConfig('unknown_server');
      expect(config).toEqual({ command: 'opencode', args: ['acp'] });
    });
  });
});
