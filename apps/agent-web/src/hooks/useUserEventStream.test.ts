import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUserEventStream } from './useUserEventStream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe('useUserEventStream（用户级 SSE）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    localStorage.setItem('auth_token', 'token-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('用 token 建立用户级连接', () => {
    renderHook(() => useUserEventStream({}));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain('/api/user/stream?token=token-1');
  });

  it('分发 required / resolved 事件，忽略 heartbeat', () => {
    const onRequired = vi.fn();
    const onResolved = vi.fn();
    renderHook(() => useUserEventStream({
      onHarnessLoginRequired: onRequired,
      onHarnessLoginResolved: onResolved,
    }));
    const source = MockEventSource.instances[0];

    source.emit({ type: 'heartbeat' });
    source.emit({
      type: 'harness_login_required',
      data: { requestId: 'hl-1', url: 'https://kimi.com', userCode: 'CODE' },
    });
    source.emit({
      type: 'harness_login_resolved',
      data: { requestId: 'hl-1', result: 'succeeded' },
    });

    expect(onRequired).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'hl-1', userCode: 'CODE' }),
    );
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'hl-1', result: 'succeeded' }),
    );
  });

  it('断线按 1s→30s 指数退避重连', () => {
    renderHook(() => useUserEventStream({}));
    const first = MockEventSource.instances[0];

    first.onerror?.(new Event('error'));
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    MockEventSource.instances[1].onerror?.(new Event('error'));
    vi.advanceTimersByTime(1999);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);

    // 封顶 30s
    for (let i = 0; i < 10; i += 1) {
      MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.(new Event('error'));
      vi.advanceTimersByTime(30000);
    }
    expect(MockEventSource.instances.length).toBeGreaterThan(3);
  });

  it('onopen 重置退避；卸载关闭连接并取消重连', () => {
    const { unmount } = renderHook(() => useUserEventStream({}));
    const source = MockEventSource.instances[0];
    source.onerror?.(new Event('error'));
    vi.advanceTimersByTime(1000);
    const second = MockEventSource.instances[1];
    second.onopen?.();
    second.onerror?.(new Event('error'));
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(3);

    unmount();
    expect(MockEventSource.instances[2].closed).toBe(true);
    MockEventSource.instances[2].onerror?.(new Event('error'));
    vi.advanceTimersByTime(30000);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('enabled=false 时不建连', () => {
    renderHook(() => useUserEventStream({ enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
