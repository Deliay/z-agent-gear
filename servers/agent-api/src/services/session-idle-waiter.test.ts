import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./session.js', () => ({
  sessionService: {
    onSessionStatus: vi.fn(),
    getSessionStatusRaw: vi.fn(),
  },
}));

import {
  armSessionIdleWaiter,
  clearAllSessionIdleWaiters,
  SESSION_IDLE_HEARTBEAT_MS,
} from './session-idle-waiter.js';
import { sessionService } from './session.js';

type Listener = (event: { sessionId: string; status: string; promptCompleted?: boolean; error?: string }) => void | Promise<void>;

let listener: Listener | null = null;
const unsubscribe = vi.fn(() => {
  listener = null;
});

function emit(event: Parameters<Listener>[0]): void {
  listener?.(event);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('armSessionIdleWaiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllSessionIdleWaiters();
    listener = null;
    vi.mocked(sessionService.onSessionStatus).mockImplementation(((cb: Listener) => {
      listener = cb;
      return unsubscribe;
    }) as never);
    vi.mocked(sessionService.getSessionStatusRaw).mockResolvedValue('idling');
  });

  afterEach(() => {
    clearAllSessionIdleWaiters();
    vi.useRealTimers();
  });

  it('T-IDLE1: 裸 idling（无 promptCompleted）→ true，且以 DB 状态复核', async () => {
    const waiter = armSessionIdleWaiter('sess-1', 60_000);
    emit({ sessionId: 'sess-1', status: 'idling' });
    await flush();

    await expect(waiter.promise).resolves.toBe(true);
    expect(sessionService.getSessionStatusRaw).toHaveBeenCalledWith('sess-1');
  });

  it('T-IDLE2: close 引起的 ended（无 error、未见过 connecting）→ 忽略，继续等待', async () => {
    const waiter = armSessionIdleWaiter('sess-1', 60_000);
    let settled = false;
    void waiter.promise.then(() => {
      settled = true;
    });

    emit({ sessionId: 'sess-1', status: 'ended' });
    await flush();
    expect(settled).toBe(false);

    emit({ sessionId: 'sess-1', status: 'idling' });
    await flush();
    expect(settled).toBe(true);
  });

  it('T-IDLE3: ended + error（CONTROLLER_OFFLINE）→ 立即 false', async () => {
    const waiter = armSessionIdleWaiter('sess-1', 60_000);
    emit({ sessionId: 'sess-1', status: 'ended', error: 'CONTROLLER_OFFLINE' });
    await expect(waiter.promise).resolves.toBe(false);
  });

  it('T-IDLE4: 见过 connecting 后 ended（无 error）→ false', async () => {
    const waiter = armSessionIdleWaiter('sess-1', 60_000);
    emit({ sessionId: 'sess-1', status: 'connecting' });
    emit({ sessionId: 'sess-1', status: 'ended' });
    await expect(waiter.promise).resolves.toBe(false);
  });

  it('T-IDLE5: removed → false；超时 → false', async () => {
    const removed = armSessionIdleWaiter('sess-1', 60_000);
    emit({ sessionId: 'sess-1', status: 'removed' });
    await expect(removed.promise).resolves.toBe(false);

    vi.useFakeTimers();
    const timedOut = armSessionIdleWaiter('sess-2', 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(timedOut.promise).resolves.toBe(false);
  });

  it('T-IDLE6: 事件丢失时 15s DB 心跳兜底（idling→true、ended→false）', async () => {
    vi.useFakeTimers();
    const ok = armSessionIdleWaiter('sess-1', 120_000);
    vi.mocked(sessionService.getSessionStatusRaw).mockResolvedValue('idling');
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_HEARTBEAT_MS);
    await expect(ok.promise).resolves.toBe(true);

    const failed = armSessionIdleWaiter('sess-2', 120_000);
    vi.mocked(sessionService.getSessionStatusRaw).mockResolvedValue('ended');
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_HEARTBEAT_MS);
    await expect(failed.promise).resolves.toBe(false);
  });

  it('T-IDLE7: cancel() 后不再 settle，监听器与定时器全部清理', async () => {
    vi.useFakeTimers();
    const waiter = armSessionIdleWaiter('sess-1', 60_000);
    let settled = false;
    void waiter.promise.then(() => {
      settled = true;
    });

    waiter.cancel();
    expect(unsubscribe).toHaveBeenCalled();
    expect(listener).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(settled).toBe(false);
  });
});
