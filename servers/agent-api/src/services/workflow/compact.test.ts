import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../session.js', () => ({
  sessionService: {
    addMessage: vi.fn(),
  },
}));

vi.mock('../harness-config.js', () => ({
  resolveCompactCommand: vi.fn(),
}));

vi.mock('./interrupt-retry.js', () => ({
  INTERRUPT_RETRY_IDLE_TIMEOUT_MS: 5 * 60_000,
}));

import { sessionService } from '../session.js';
import { resolveCompactCommand } from '../harness-config.js';
import {
  clearCompactInFlight,
  consumeCompactInFlight,
  isCompactInFlight,
  runCompactPipeline,
} from './compact.js';

describe('runCompactPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCompactInFlight();
    vi.mocked(resolveCompactCommand).mockResolvedValue('/compact');
    vi.mocked(sessionService.addMessage).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    clearCompactInFlight();
    vi.useRealTimers();
  });

  it('T-CPCT1: 登记先于发送、发送压缩指令后立即返回（不等待压缩回合空闲）', async () => {
    let inFlightDuringSend = false;
    vi.mocked(sessionService.addMessage).mockImplementation(async () => {
      inFlightDuringSend = isCompactInFlight('sess-1');
      return undefined as never;
    });

    const result = await runCompactPipeline('sess-1', 'opencode');

    expect(result).toBe(true);
    expect(inFlightDuringSend).toBe(true);
    expect(sessionService.addMessage).toHaveBeenCalledWith('sess-1', {
      direction: 'input',
      type: 'text',
      content: '/compact',
    });
    // 压缩回合尚未结束：抑制登记保留，由后续 idling 一次性消费
    expect(isCompactInFlight('sess-1')).toBe(true);
    expect(consumeCompactInFlight('sess-1')).toBe(true);
    expect(isCompactInFlight('sess-1')).toBe(false);
    // 二次消费不重复抑制（后续回合恢复正常停滞检测）
    expect(consumeCompactInFlight('sess-1')).toBe(false);
  });

  it('T-CPCT1b: 使用已配置的压缩指令', async () => {
    vi.mocked(resolveCompactCommand).mockResolvedValue('/compact-context');

    await runCompactPipeline('sess-1', 'kimi_code');

    expect(resolveCompactCommand).toHaveBeenCalledWith('kimi_code');
    expect(sessionService.addMessage).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ content: '/compact-context' }),
    );
  });

  it('T-CPCT2: 自定义超时兜底释放抑制（压缩回合始终不结束也不会永久抑制）', async () => {
    vi.useFakeTimers();

    await runCompactPipeline('sess-2', 'opencode', 1234);
    expect(isCompactInFlight('sess-2')).toBe(true);

    vi.advanceTimersByTime(1233);
    expect(isCompactInFlight('sess-2')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isCompactInFlight('sess-2')).toBe(false);
    expect(consumeCompactInFlight('sess-2')).toBe(false);
  });

  it('T-CPCT2b: addMessage 抛错 → 返回 false 且无残留登记', async () => {
    vi.mocked(sessionService.addMessage).mockRejectedValue(new Error('boom'));

    const result = await runCompactPipeline('sess-3', 'opencode');

    expect(result).toBe(false);
    expect(isCompactInFlight('sess-3')).toBe(false);
  });

  it('T-CPCT2c: 缺省超时为 5 分钟', async () => {
    vi.useFakeTimers();

    await runCompactPipeline('sess-4', 'opencode');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(isCompactInFlight('sess-4')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isCompactInFlight('sess-4')).toBe(false);
  });
});
