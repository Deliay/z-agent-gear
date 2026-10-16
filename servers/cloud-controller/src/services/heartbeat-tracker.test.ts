import { describe, it, expect } from 'vitest';
import { HeartbeatTracker } from './heartbeat-tracker.js';

const T0 = 1_700_000_000_000;

describe('HeartbeatTracker', () => {
  it('records last-seen, reports staleness after maxMisses, and removes entries', () => {
    const tracker = new HeartbeatTracker(30000, 3);

    expect(tracker.interval).toBe(30000);
    expect(tracker.maxMissesAllowed).toBe(3);
    expect(tracker.has('c1')).toBe(false);
    expect(tracker.lastSeenAt('c1')).toBeUndefined();
    // 未知容器永不判定离线
    expect(tracker.isStale('c1', T0)).toBe(false);

    tracker.record('c1', T0);
    expect(tracker.has('c1')).toBe(true);
    expect(tracker.lastSeenAt('c1')).toBe(T0);

    expect(tracker.isStale('c1', T0 + 2 * 30000)).toBe(false);
    expect(tracker.isStale('c1', T0 + 3 * 30000)).toBe(true);
    expect(tracker.check(T0 + 3 * 30000)).toEqual(['c1']);

    // 新心跳刷新后再计时
    tracker.record('c1', T0 + 3 * 30000);
    expect(tracker.isStale('c1', T0 + 4 * 30000)).toBe(false);

    tracker.remove('c1');
    expect(tracker.has('c1')).toBe(false);
    expect(tracker.isStale('c1', T0 + 999999)).toBe(false);
    expect(tracker.check(T0 + 999999)).toEqual([]);
  });

  it('check returns only stale containers and tracks multiple ids independently', () => {
    const tracker = new HeartbeatTracker(10000, 2);
    tracker.record('fresh', T0 + 5 * 10000);
    tracker.record('stale', T0);

    expect(tracker.check(T0 + 5 * 10000)).toEqual(['stale']);
  });

  it('uses 30s x 3 defaults', () => {
    const tracker = new HeartbeatTracker();
    expect(tracker.interval).toBe(30000);
    expect(tracker.maxMissesAllowed).toBe(3);
  });
});
