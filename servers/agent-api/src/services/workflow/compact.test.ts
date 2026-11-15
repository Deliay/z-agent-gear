import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session.js', () => ({
  sessionService: {
    addMessage: vi.fn(),
  },
}));

vi.mock('../session-idle-waiter.js', () => ({
  armSessionIdleWaiter: vi.fn(),
}));

vi.mock('../harness-config.js', () => ({
  resolveCompactCommand: vi.fn(),
}));

vi.mock('./interrupt-retry.js', () => ({
  INTERRUPT_RETRY_IDLE_TIMEOUT_MS: 5 * 60_000,
}));

import { sessionService } from '../session.js';
import { armSessionIdleWaiter } from '../session-idle-waiter.js';
import { resolveCompactCommand } from '../harness-config.js';
import { isCompactInFlight, runCompactPipeline } from './compact.js';

describe('runCompactPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCompactCommand).mockResolvedValue('/compact');
    vi.mocked(sessionService.addMessage).mockResolvedValue(undefined as never);
  });

  it('T-CPCT1: 登记先于发送、布防先于发送、空闲后返回 true 且取消登记', async () => {
    let inFlightDuringSend = false;
    let armedBeforeSend = false;
    vi.mocked(armSessionIdleWaiter).mockImplementation(() => {
      armedBeforeSend = true;
      return { promise: Promise.resolve(true), cancel: vi.fn() };
    });
    vi.mocked(sessionService.addMessage).mockImplementation(async () => {
      inFlightDuringSend = isCompactInFlight('sess-1');
      expect(armedBeforeSend).toBe(true);
      return undefined as never;
    });

    const result = await runCompactPipeline('sess-1', 'opencode');

    expect(result).toBe(true);
    expect(inFlightDuringSend).toBe(true);
    expect(armSessionIdleWaiter).toHaveBeenCalledWith('sess-1', 5 * 60_000);
    expect(sessionService.addMessage).toHaveBeenCalledWith('sess-1', {
      direction: 'input',
      type: 'text',
      content: '/compact',
    });
    expect(isCompactInFlight('sess-1')).toBe(false);
  });

  it('T-CPCT1b: 使用已配置的压缩指令', async () => {
    vi.mocked(resolveCompactCommand).mockResolvedValue('/compact-context');
    vi.mocked(armSessionIdleWaiter).mockReturnValue({ promise: Promise.resolve(true), cancel: vi.fn() });

    await runCompactPipeline('sess-1', 'kimi_code');

    expect(resolveCompactCommand).toHaveBeenCalledWith('kimi_code');
    expect(sessionService.addMessage).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ content: '/compact-context' }),
    );
  });

  it('T-CPCT2: 等待器 false（超时）→ 返回 false 且无残留登记', async () => {
    const cancel = vi.fn();
    vi.mocked(armSessionIdleWaiter).mockReturnValue({ promise: Promise.resolve(false), cancel });

    const result = await runCompactPipeline('sess-2', 'opencode');

    expect(result).toBe(false);
    expect(cancel).toHaveBeenCalled();
    expect(isCompactInFlight('sess-2')).toBe(false);
  });

  it('T-CPCT2b: addMessage 抛错 → 返回 false 且无残留登记', async () => {
    const cancel = vi.fn();
    vi.mocked(armSessionIdleWaiter).mockReturnValue({
      promise: new Promise<boolean>(() => undefined),
      cancel,
    });
    vi.mocked(sessionService.addMessage).mockRejectedValue(new Error('boom'));

    const result = await runCompactPipeline('sess-3', 'opencode');

    expect(result).toBe(false);
    expect(cancel).toHaveBeenCalled();
    expect(isCompactInFlight('sess-3')).toBe(false);
  });

  it('T-CPCT2c: 自定义超时透传给等待器', async () => {
    vi.mocked(armSessionIdleWaiter).mockReturnValue({ promise: Promise.resolve(true), cancel: vi.fn() });

    await runCompactPipeline('sess-4', 'opencode', 1234);

    expect(armSessionIdleWaiter).toHaveBeenCalledWith('sess-4', 1234);
  });
});
