import { describe, expect, it, vi } from 'vitest';
import {
  resolveInstanceUnavailableReason,
  resolveUnavailableReasonFromController,
} from './unavailable.js';

describe('resolveUnavailableReasonFromController', () => {
  it('T-UAR1a 控制器文档缺失 → CONTROLLER_DELETED', () => {
    expect(resolveUnavailableReasonFromController(null)).toBe('CONTROLLER_DELETED');
  });

  it('T-UAR1b online → null（可用）', () => {
    expect(resolveUnavailableReasonFromController({ status: 'online' })).toBeNull();
  });

  it('T-UAR1c offline/registering/unbound → CONTROLLER_OFFLINE', () => {
    for (const status of ['offline', 'registering', 'unbound']) {
      expect(resolveUnavailableReasonFromController({ status })).toBe('CONTROLLER_OFFLINE');
    }
  });
});

describe('resolveInstanceUnavailableReason', () => {
  it('T-UAR2 按 instance.controllerId 仅加载一次并判定', async () => {
    const loadController = vi.fn().mockResolvedValue({ status: 'offline' });
    const reason = await resolveInstanceUnavailableReason(
      { controllerId: { toString: () => 'ctrl-1' } },
      loadController,
    );
    expect(reason).toBe('CONTROLLER_OFFLINE');
    expect(loadController).toHaveBeenCalledTimes(1);
    expect(loadController).toHaveBeenCalledWith('ctrl-1');
  });

  it('T-UAR3 缺 controllerId → CONTROLLER_DELETED 且不加载', async () => {
    const loadController = vi.fn();
    expect(await resolveInstanceUnavailableReason({}, loadController)).toBe('CONTROLLER_DELETED');
    expect(loadController).not.toHaveBeenCalled();
  });
});
