import { describe, it, expect, vi } from 'vitest';
import { harnessTerminalStatus, retryHarnessCallback } from './index.js';

describe('harness lifecycle helpers', () => {
  it('maps exited/destroying to stopped and failed to failed', () => {
    expect(harnessTerminalStatus('exited')).toBe('stopped');
    expect(harnessTerminalStatus('destroying')).toBe('stopped');
    expect(harnessTerminalStatus('failed')).toBe('failed');
  });

  it('retries transient callback failures and succeeds', async () => {
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(undefined);
    const logger = { warn: vi.fn(), error: vi.fn() };

    await retryHarnessCallback('ready', task, logger, [0, 0]);

    expect(task).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and throws after all retries are exhausted', async () => {
    const task = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('down'));
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(retryHarnessCallback('terminal', task, logger, [0, 0, 0])).rejects.toThrow(
      'down',
    );
    expect(task).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });
});
