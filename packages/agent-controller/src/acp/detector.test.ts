import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcess = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('child_process', () => childProcess);

import { AcpDetector } from './detector.js';

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

function mockExec(handler: (command: string, callback: ExecCallback) => void): void {
  childProcess.exec.mockImplementation(handler);
}

function mockOnlyDsh(stdout: string): void {
  mockExec((command: string, callback: ExecCallback) => {
    if (command === 'dsh --version') {
      callback(null, { stdout, stderr: '' });
      return;
    }
    callback(new Error('not available'));
  });
}

describe('AcpDetector deepseek_harness (T-DET*)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-DET1: dsh --version 成功时 deepseek_harness 可用', async () => {
    mockOnlyDsh('0.1.2-alpha.2\n');

    const result = await new AcpDetector().detect();
    expect(result.find((item) => item.type === 'deepseek_harness')).toEqual({
      type: 'deepseek_harness',
      available: true,
      version: '0.1.2-alpha.2',
    });
  });

  it('T-DET1b: 缺命令时 deepseek_harness 不可用（不抛错）', async () => {
    mockExec((_command: string, callback: ExecCallback) => callback(new Error('spawn dsh ENOENT')));

    const result = await new AcpDetector().detect();
    expect(result.find((item) => item.type === 'deepseek_harness')).toEqual({
      type: 'deepseek_harness',
      available: false,
    });
  });

  it('T-DET2: 预发布段保留', async () => {
    mockOnlyDsh('0.1.2-alpha.2\n');

    const result = await new AcpDetector().detect();
    expect(result.find((item) => item.type === 'deepseek_harness')?.version).toBe('0.1.2-alpha.2');
  });

  it('T-DET3: spawner 为 dsh --profile acp', () => {
    expect(new AcpDetector().getSpawnerConfig('deepseek_harness')).toEqual({
      command: 'dsh',
      args: ['--profile', 'acp'],
    });
  });
});
