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

  it('R10-11: 错过 cron 分钟后按「距上次成功 ≥ 24h」补跑', async () => {
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
    // 进程启动后的第一个 tick 立即补跑，而不是等待某个精确分钟。
    await vi.advanceTimersByTimeAsync(61_000);
    expect(reconciliation.run).toHaveBeenCalledTimes(1);

    // 不足 24h 不重复执行。
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    expect(reconciliation.run).toHaveBeenCalledTimes(1);

    // 超过 24h 后补跑。
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(reconciliation.run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
