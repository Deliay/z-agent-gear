import { describe, it, expect, vi } from 'vitest';
import { SettlementTickService } from './settlement-tick.js';

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    accountId: '507f1f77bcf86cd799439012',
    resourceId: 'c1',
    status: 'ACTIVE',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    lastCycleSeq: -1,
    expectedEndAt: null,
    ...overrides,
  };
}

describe('SettlementTickService（扫描兜底）', () => {
  it('T-B17: 首期（seq 0）消息丢失时从 lastCycleSeq=-1 补结算', async () => {
    const billing = {
      handleSettlementCycle: vi.fn().mockResolvedValue({ settled: true }),
      handleContainerDestroyed: vi.fn(),
    };
    const reservations = { list: vi.fn().mockResolvedValue([reservation()]) };
    const tick = new SettlementTickService(billing as never, reservations as never, {
      cycleMs: 60_000,
      now: () => new Date('2026-10-01T00:01:01Z').getTime(),
    });
    expect(await tick.tick()).toBe(1);
    expect(billing.handleSettlementCycle).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 0);
  });

  it('未到期/已结算不重复触发；异常只告警', async () => {
    const billing = {
      handleSettlementCycle: vi.fn().mockRejectedValue(new Error('boom')),
      handleContainerDestroyed: vi.fn(),
    };
    const reservations = {
      list: vi
        .fn()
        .mockResolvedValue([
          reservation({ lastCycleSeq: 5 }),
          reservation({ _id: '507f1f77bcf86cd799439013', lastCycleSeq: -1 }),
        ]),
    };
    const warn = vi.fn();
    const tick = new SettlementTickService(billing as never, reservations as never, {
      cycleMs: 60_000,
      now: () => new Date('2026-10-01T00:01:01Z').getTime(),
      logger: { warn },
    });
    expect(await tick.tick()).toBe(0);
    // 仅第二条（lastCycleSeq=-1）触发，且异常被吞掉
    expect(billing.handleSettlementCycle).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('超期预留自动最终结算（不依赖销毁事件）', async () => {
    const billing = {
      handleSettlementCycle: vi.fn().mockResolvedValue({ settled: false }),
      handleContainerDestroyed: vi.fn().mockResolvedValue(null),
    };
    const reservations = {
      list: vi.fn().mockResolvedValue([
        reservation({
          lastCycleSeq: 10,
          expectedEndAt: new Date('2026-10-01T00:00:00Z'),
        }),
      ]),
    };
    const tick = new SettlementTickService(billing as never, reservations as never, {
      cycleMs: 60_000,
      now: () => new Date('2026-10-01T00:20:00Z').getTime(),
    });
    await tick.tick();
    expect(billing.handleContainerDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'c1' }),
    );
  });
});
