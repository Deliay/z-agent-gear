import { describe, it, expect, vi, afterEach } from 'vitest';
import { BillingScheduler } from './scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('BillingScheduler', () => {
  it('启动 outbox relay、结算扫描与每日对账；stop 清理定时器', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T02:59:30Z'));
    const publisher = { start: vi.fn(), stop: vi.fn(async () => undefined) };
    const settlementTick = { tick: vi.fn(async () => 1) };
    const reconciliation = { run: vi.fn(async () => []) };
    const scheduler = new BillingScheduler({
      publisher: publisher as never,
      settlementTick: settlementTick as never,
      reconciliation: reconciliation as never,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    scheduler.start();
    expect(publisher.start).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settlementTick.tick).toHaveBeenCalled();
    expect(reconciliation.run).toHaveBeenCalled();
    await scheduler.stop();
    expect(publisher.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settlementTick.tick).toHaveBeenCalledTimes(1);
  });
});
